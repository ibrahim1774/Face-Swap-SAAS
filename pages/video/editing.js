import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

import styles from '../../styles/Editor.module.css';
import UploadZone from '../../components/UploadZone';
import AIChatPanel from '../../components/editor/AIChatPanel';
import Paywall from '../../components/Paywall';
import { uploadTempFile } from '../../lib/uploader';
import { getBrowserSupabase } from '../../lib/supabase';
import { bumpEntitlement } from '../../lib/entitlementBus';
import { saveJob, loadJob, clearJob } from '../../lib/jobPersist';
import { emptyPlan, effectiveDuration } from '../../lib/editPlan';

const PENDING_KEY = 've_pending_edit';

function hasEditorAccess(entitlement) {
  if (!entitlement) return false;
  if (entitlement.isAdmin) return true;
  if (
    entitlement.tier === 'monthly' ||
    entitlement.tier === 'pro' ||
    entitlement.tier === 'yearly' ||
    entitlement.status === 'trialing'
  )
    return true;
  if ((entitlement.videoEditorCreditsRemaining || 0) > 0) return true;
  return false;
}

const FEATURE = 'video-editor';

function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      const meta = {
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
      };
      URL.revokeObjectURL(url);
      resolve(meta);
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not read video metadata.'));
    };
    v.src = url;
  });
}

export default function VideoEditingPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  // 'upload' | 'paywall' | 'editing' | 'rendering' | 'done'
  const [step, setStep] = useState('upload');

  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUploading, setSourceUploading] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [chatHistory, setChatHistory] = useState([]);
  const [editDescription, setEditDescription] = useState('');
  const [entitlement, setEntitlement] = useState(null);
  const [pendingResume, setPendingResume] = useState(null);

  const [renderId, setRenderId] = useState(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderResult, setRenderResult] = useState(null);
  const [renderError, setRenderError] = useState('');

  const pollRef = useRef(null);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setAuthLoaded(true);
      return undefined;
    }
    supabase.auth.getUser().then(({ data }) => {
      setAuthUser(data?.user || null);
      setAuthLoaded(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      setAuthUser(session?.user || null);
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  // Restore any pending edit-description from before sign-up. The CTA
  // saves edit intent to sessionStorage before redirecting to /sign-up
  // so the description survives the auth round-trip.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved.editDescription === 'string') {
        setEditDescription(saved.editDescription);
      }
      if (saved && saved.fileName) {
        setPendingResume({ fileName: saved.fileName });
      }
    } catch {
      // ignore parse failures
    }
  }, []);

  // Fetch the user's entitlement once authed so the page can decide
  // whether to land them on the paywall or the editor.
  useEffect(() => {
    if (!authUser) {
      setEntitlement(null);
      return;
    }
    fetch('/api/entitlement')
      .then((r) => r.json().catch(() => null))
      .then((d) => setEntitlement(d || null))
      .catch(() => setEntitlement(null));
  }, [authUser, step]);

  // Post-payment landing: ?paid=1 means Stripe just redirected back
  // here after a successful subscription. Clear the query, clear any
  // paywall state, and bump entitlement so the editor unlocks.
  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.paid === '1') {
      bumpEntitlement();
      // Strip the query without a page reload.
      const cleanUrl = router.pathname;
      window.history.replaceState({}, '', cleanUrl);
      setStep('upload');
    }
  }, [router.isReady, router.query.paid, router.pathname]);

  // Resume in-flight render across page refresh.
  useEffect(() => {
    if (!authLoaded || !authUser) return;
    const saved = loadJob(FEATURE);
    if (saved && saved.predictionId && saved.editPlan) {
      setRenderId(saved.predictionId);
      setEditPlan(saved.editPlan);
      setChatHistory(saved.chatHistory || []);
      setStep('rendering');
    }
  }, [authLoaded, authUser]);

  // Poll render status.
  useEffect(() => {
    if (step !== 'rendering' || !renderId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/video/render-status?renderId=${encodeURIComponent(renderId)}`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok) throw new Error(d.error || 'Status check failed.');
        setRenderProgress(d.progress || 0);
        if (d.status === 'completed' && d.outputUrl) {
          setRenderResult({ outputUrl: d.outputUrl });
          setStep('done');
          clearJob(FEATURE);
          bumpEntitlement();
        } else if (d.status === 'failed') {
          setRenderError(d.errorMessage || 'Render failed.');
          setStep('editing');
          clearJob(FEATURE);
          bumpEntitlement(); // refunded server-side
        }
      } catch (err) {
        if (!cancelled) {
          setRenderError(err.message);
          setStep('editing');
          clearJob(FEATURE);
        }
      }
    };
    tick();
    pollRef.current = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [step, renderId]);

  // File pick: just stash the File locally. We don't upload until the
  // user clicks "Edit My Video" — that way anon users don't burn an
  // upload before we know whether they'll sign up.
  const handleFilePicked = (file) => {
    setSourceFile(file);
    setRenderError('');
    setPendingResume(null);
  };

  // "Edit My Video" CTA. Routes by auth + entitlement state:
  //   anon                 → save intent to sessionStorage, go to /sign-up
  //   authed, no plan      → show paywall
  //   authed, has plan     → upload + transition to editor
  const handleEditMyVideo = async () => {
    if (!sourceFile) {
      setRenderError('Pick a video first.');
      return;
    }

    if (authLoaded && !authUser) {
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({
            editDescription,
            fileName: sourceFile.name,
          })
        );
      } catch {
        // sessionStorage may be unavailable in private mode; the user
        // will just lose the description across the round-trip.
      }
      const returnTo = encodeURIComponent('/video/editing');
      router.push(`/sign-up?returnTo=${returnTo}`);
      return;
    }

    if (authUser && !hasEditorAccess(entitlement)) {
      setStep('paywall');
      return;
    }

    // Authed + has plan: do the real upload now.
    setRenderError('');
    setSourceUploading(true);
    try {
      const meta = await probeVideo(sourceFile);
      const url = await uploadTempFile(sourceFile);
      const plan = emptyPlan({
        sourceUrl: url,
        duration: meta.duration,
        width: meta.width || 1080,
        height: meta.height || 1920,
      });
      if (editDescription && editDescription.trim()) {
        plan.userPrompt = editDescription.trim();
      }
      setEditPlan(plan);
      setChatHistory([]);
      setStep('editing');
      // Clear the pending sessionStorage now that the upload succeeded.
      try { sessionStorage.removeItem(PENDING_KEY); } catch {}
    } catch (err) {
      setRenderError(err.message || 'Upload failed.');
      setSourceFile(null);
    } finally {
      setSourceUploading(false);
    }
  };

  const handleRender = useCallback(async () => {
    if (!editPlan) return;
    setRenderError('');
    setRenderProgress(0);
    try {
      const r = await fetch('/api/video/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editPlan }),
      });
      const d = await r.json();
      if (r.status === 402) {
        setRenderError(d.code === 'NO_PLAN' ? 'No active plan — visit /dashboard.' : 'Out of credits.');
        return;
      }
      if (!r.ok) throw new Error(d.error || 'Render failed to start.');
      saveJob(FEATURE, {
        predictionId: d.renderId,
        kind: 'video-edit',
        editPlan,
        chatHistory,
      });
      setRenderId(d.renderId);
      setStep('rendering');
      bumpEntitlement(); // credit was just deducted
    } catch (err) {
      setRenderError(err.message);
    }
  }, [editPlan, chatHistory]);

  const handleStartOver = () => {
    clearJob(FEATURE);
    setSourceFile(null);
    setEditPlan(null);
    setChatHistory([]);
    setRenderId(null);
    setRenderResult(null);
    setRenderProgress(0);
    setRenderError('');
    setStep('upload');
  };

  if (!authLoaded) {
    return (
      <main className={styles.page}>
        <div className={styles.uploadPrompt}>Loading…</div>
      </main>
    );
  }

  const outDuration = editPlan ? effectiveDuration(editPlan) : 0;
  const showAnonIntro = !authUser;

  return (
    <>
      <Head>
        <title>Video Editor — Haelabs</title>
      </Head>
      <main className={styles.page}>
        <header className={styles.header}>
          <div>
            <div className={styles.eyebrow}>◆ Video Editor</div>
            <h1 className={styles.title}>Edit your video with AI</h1>
          </div>
          {step !== 'upload' && (
            <button type="button" onClick={handleStartOver} className={styles.downloadBtn}>
              Start over
            </button>
          )}
        </header>

        {step === 'upload' && (
          <div className={styles.canvas}>
            {showAnonIntro && (
              <div
                style={{
                  maxWidth: 640,
                  margin: '0 auto 18px',
                  padding: '16px 20px',
                  borderRadius: 12,
                  border: '1px solid rgba(224, 196, 136, 0.25)',
                  background: 'rgba(224, 196, 136, 0.05)',
                  color: '#e6e6e6',
                  textAlign: 'center',
                  lineHeight: 1.5,
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 11,
                    letterSpacing: '0.22em',
                    textTransform: 'uppercase',
                    color: 'var(--gold, #e0c488)',
                    marginBottom: 6,
                  }}
                >
                  ◆ AI auto-editor
                </div>
                <div style={{ fontSize: 14 }}>
                  Upload your video, tell us what you want, and we&rsquo;ll remove
                  fillers, polish the audio, and burn in captions. No login
                  required to start — sign up only when you&rsquo;re ready to render.
                </div>
              </div>
            )}

            {pendingResume && (
              <div
                style={{
                  maxWidth: 640,
                  margin: '0 auto 14px',
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.12)',
                  background: 'rgba(255,255,255,0.02)',
                  color: '#bbb',
                  fontSize: 13,
                  textAlign: 'center',
                  lineHeight: 1.5,
                }}
              >
                Welcome back — re-select <strong style={{ color: '#ededed' }}>{pendingResume.fileName}</strong> to continue where you left off.
              </div>
            )}

            <UploadZone
              label="Upload a video to edit"
              sublabel="MP4 / MOV · up to 1 GB"
              icon="🎬"
              accept="video/mp4,video/quicktime,video/*"
              file={sourceFile}
              onFileSelected={handleFilePicked}
              onRemove={() => setSourceFile(null)}
              maxSizeMB={1024}
            />

            {sourceFile && (
              <div style={{ marginTop: 18, maxWidth: 640, marginInline: 'auto' }}>
                <label
                  htmlFor="ve-edit-description"
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 11,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: '#9b978f',
                    marginBottom: 8,
                  }}
                >
                  What kind of edits do you want? <span style={{ color: '#6b6b6b' }}>(optional)</span>
                </label>
                <textarea
                  id="ve-edit-description"
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value.slice(0, 600))}
                  maxLength={600}
                  placeholder="e.g. Remove ums and long pauses, add bold captions, cut to under 5 minutes"
                  style={{
                    width: '100%',
                    padding: '12px 14px',
                    borderRadius: 10,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: '#0f0f11',
                    color: '#ededed',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    lineHeight: 1.5,
                    resize: 'vertical',
                  }}
                />
                <button
                  type="button"
                  onClick={handleEditMyVideo}
                  disabled={sourceUploading || !sourceFile}
                  style={{
                    marginTop: 14,
                    width: '100%',
                    padding: '14px 18px',
                    borderRadius: 12,
                    border: 'none',
                    background: '#ededed',
                    color: '#0b0b0c',
                    fontFamily: 'inherit',
                    fontSize: 15,
                    fontWeight: 600,
                    cursor: sourceUploading ? 'not-allowed' : 'pointer',
                    opacity: sourceUploading ? 0.6 : 1,
                    transition: 'opacity 120ms ease',
                  }}
                >
                  {sourceUploading ? 'Uploading…' : 'Edit My Video →'}
                </button>
                {!authUser && (
                  <p style={{ marginTop: 10, fontSize: 12, color: '#9b978f', textAlign: 'center' }}>
                    You&rsquo;ll sign up on the next step. Your video and edit
                    description stay on this page until then.
                  </p>
                )}
              </div>
            )}

            {sourceUploading && <div className={styles.canvasMeta}>Uploading…</div>}
            {renderError && <div className={styles.msgError}>{renderError}</div>}
          </div>
        )}

        {step === 'paywall' && (
          <div className={styles.canvas}>
            <Paywall
              entitlement={entitlement}
              surface="video-editor"
              returnTo="/video/editing"
              onError={(msg) => setRenderError(msg)}
              onTrialStarted={() => setStep('upload')}
            />
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setStep('upload')}
                className={styles.downloadBtn}
              >
                ← Back to upload
              </button>
            </div>
            {renderError && <div className={styles.msgError}>{renderError}</div>}
          </div>
        )}

        {(step === 'editing' || step === 'rendering' || step === 'done') && editPlan && (
          <div className={styles.shell}>
            <div className={styles.canvas}>
              {step === 'done' && renderResult ? (
                <>
                  <video src={renderResult.outputUrl} controls className={styles.video} />
                  <div className={styles.canvasFooter}>
                    <span className={styles.canvasMeta}>Render complete</span>
                    <a
                      href={renderResult.outputUrl}
                      download="haelabs-edit.mp4"
                      className={styles.downloadBtn}
                    >
                      ↓ Download
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <video src={editPlan.sourceUrl} controls className={styles.video} />
                  <div className={styles.canvasFooter}>
                    <span className={styles.canvasMeta}>
                      {editPlan.width}×{editPlan.height} · {outDuration.toFixed(1)}s output
                    </span>
                    {step === 'editing' && (
                      <button
                        type="button"
                        className={styles.renderBtn}
                        onClick={handleRender}
                        disabled={editPlan.operations.length === 0}
                      >
                        Render Final Video · 1 credit
                      </button>
                    )}
                  </div>
                  {step === 'rendering' && (
                    <div className={styles.progressWrap}>
                      <div className={styles.progressLabel}>
                        Rendering · {Math.round(renderProgress * 100)}%
                      </div>
                      <div className={styles.progressBar}>
                        <div
                          className={styles.progressFill}
                          style={{ width: `${Math.max(4, renderProgress * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {renderError && <div className={styles.msgError}>{renderError}</div>}
                </>
              )}
            </div>

            <AIChatPanel
              editPlan={editPlan}
              setEditPlan={setEditPlan}
              chatHistory={chatHistory}
              setChatHistory={setChatHistory}
            />
          </div>
        )}
      </main>
    </>
  );
}
