import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

import styles from '../../styles/Editor.module.css';
import UploadZone from '../../components/UploadZone';
import AIChatPanel from '../../components/editor/AIChatPanel';
import Paywall from '../../components/Paywall';
import TranscriptPreview from '../../components/editor/TranscriptPreview';
import { uploadTempFile } from '../../lib/uploader';
import { getBrowserSupabase } from '../../lib/supabase';
import { bumpEntitlement } from '../../lib/entitlementBus';
import { saveJob, loadJob, clearJob } from '../../lib/jobPersist';
import { emptyPlan, effectiveDuration } from '../../lib/editPlan';
import { deriveKeepIntervals, totalKeptSeconds } from '../../lib/cutPlan';

const PENDING_KEY = 've_pending_edit';

const DEFAULT_TOGGLES = {
  removeFillers: true,
  removeSilences: true,
  cleanAudio: true,
};

const FEATURE_LIST = [
  { key: 'removeFillers',  label: 'Remove filler words', sublabel: 'Cut "um", "uh", "er", "ah"' },
  { key: 'removeSilences', label: 'Trim long silences',  sublabel: 'Tighten pauses over 0.5s' },
  { key: 'cleanAudio',     label: 'Clean & level audio', sublabel: 'EBU R128 loudness norm' },
];

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

function ToggleChip({ label, sublabel, checked, onChange, soon }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 9,
        border: `1px solid ${checked ? 'rgba(224, 196, 136, 0.4)' : 'rgba(255,255,255,0.10)'}`,
        background: checked ? 'rgba(224, 196, 136, 0.06)' : 'rgba(255,255,255,0.02)',
        cursor: 'pointer',
        transition: 'background 120ms ease, border-color 120ms ease',
        position: 'relative',
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          flexShrink: 0,
          marginTop: 1,
          border: `1.5px solid ${checked ? 'var(--gold, #e0c488)' : 'rgba(255,255,255,0.25)'}`,
          background: checked ? 'var(--gold, #e0c488)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#0b0b0c',
          fontSize: 11,
          fontWeight: 800,
          lineHeight: 1,
        }}
      >
        {checked ? '✓' : ''}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            fontWeight: 600,
            color: '#ededed',
            lineHeight: 1.3,
            wordBreak: 'break-word',
          }}
        >
          {label}
        </span>
        {sublabel && (
          <span
            style={{
              display: 'block',
              fontSize: 11,
              color: soon ? 'var(--gold, #e0c488)' : '#9b978f',
              marginTop: 3,
              lineHeight: 1.35,
              wordBreak: 'break-word',
              opacity: soon ? 0.85 : 1,
            }}
          >
            {sublabel}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
      />
    </label>
  );
}

export default function VideoEditingPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  // 'upload' | 'paywall' | 'transcribing' | 'preview' | 'editing' | 'rendering' | 'done'
  const [step, setStep] = useState('upload');

  const [sourceFile, setSourceFile] = useState(null);
  const [sourceUploading, setSourceUploading] = useState(false);
  const [editPlan, setEditPlan] = useState(null);
  const [chatHistory, setChatHistory] = useState([]);
  const [editDescription, setEditDescription] = useState('');
  const [toggles, setToggles] = useState(DEFAULT_TOGGLES);
  const [entitlement, setEntitlement] = useState(null);
  const [pendingResume, setPendingResume] = useState(null);
  const autoAdvancedRef = useRef(false);

  // Stage 1: AssemblyAI transcript + auto-cut preview state.
  const [transcriptId, setTranscriptId] = useState(null);
  const [transcriptStatus, setTranscriptStatus] = useState('idle'); // idle|queued|processing|completed|error
  const [transcript, setTranscript] = useState(null); // { preview, durationSec, chapters, ... }
  const [transcriptOverrides, setTranscriptOverrides] = useState({});
  const [transcriptError, setTranscriptError] = useState('');

  const [renderId, setRenderId] = useState(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderResult, setRenderResult] = useState(null);
  const [renderError, setRenderError] = useState('');

  const pollRef = useRef(null);
  const transcriptPollRef = useRef(null);

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

  // Restore pending state from before sign-up or paywall. The CTA
  // saves edit intent to sessionStorage before redirecting so it
  // survives auth + checkout round-trips. Three shapes possible:
  //   - { editDescription, fileName, toggles }                 (anon path)
  //   - { ..., sourceUrl, sourceDurationSec, w, h }            (authed upload path)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved.editDescription === 'string') {
        setEditDescription(saved.editDescription);
      }
      if (saved && saved.toggles && typeof saved.toggles === 'object') {
        setToggles({ ...DEFAULT_TOGGLES, ...saved.toggles });
      }
      if (saved && saved.fileName) {
        setPendingResume({
          fileName: saved.fileName,
          sourceUrl: saved.sourceUrl || null,
          sourceDurationSec: saved.sourceDurationSec || null,
          sourceWidth: saved.sourceWidth || null,
          sourceHeight: saved.sourceHeight || null,
        });
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
          // Re-base the edit plan onto the rendered output so subsequent
          // chat turns ("trim the last second") operate on the *new*
          // shorter video, not the original 12s source. Clears applied
          // intervals/ops since they're now baked into outputUrl.
          setEditPlan((prev) => {
            if (!prev) return prev;
            const appliedIntervals = Array.isArray(prev.keepIntervals) ? prev.keepIntervals : [];
            const newDuration =
              appliedIntervals.length > 0
                ? totalKeptSeconds(appliedIntervals)
                : effectiveDuration(prev) || prev.duration || 0;
            return {
              ...prev,
              sourceUrl: d.outputUrl,
              duration: newDuration,
              sourceDurationSec: newDuration,
              keepIntervals: [],
              operations: [],
            };
          });
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

  // Kick off transcription against an already-uploaded source URL.
  // Used both by the post-upload flow and by post-paywall auto-resume.
  const startTranscription = useCallback(async ({ sourceUrl, duration, width, height }) => {
    const plan = emptyPlan({
      sourceUrl,
      duration,
      width: width || 1080,
      height: height || 1920,
    });
    if (editDescription && editDescription.trim()) {
      plan.userPrompt = editDescription.trim();
    }
    plan.toggles = toggles;
    setEditPlan(plan);
    setChatHistory([]);

    setTranscriptId(null);
    setTranscript(null);
    setTranscriptOverrides({});
    setTranscriptError('');
    setTranscriptStatus('queued');
    setStep('transcribing');
    try {
      const tr = await fetch('/api/video/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceUrl }),
      });
      const td = await tr.json();
      if (!tr.ok) throw new Error(td.error || 'Transcription failed to start.');
      setTranscriptId(td.transcriptId);
      setTranscriptStatus(td.status === 'completed' ? 'completed' : td.status || 'queued');
    } catch (err) {
      setTranscriptError(err.message || 'Transcription failed.');
      setTranscriptStatus('error');
    }

    try { sessionStorage.removeItem(PENDING_KEY); } catch {}
  }, [editDescription, toggles]);

  // "Edit My Video" CTA. Single flow regardless of auth state:
  //   1. Upload to Blob (so the file persists across navigation)
  //   2. Persist URL + meta + toggles to sessionStorage
  //   3. Route:
  //        anon            → /sign-up?returnTo=/video/editing
  //        authed, no plan → paywall (auto-resume handles post-pay)
  //        authed, has plan → straight into transcription
  const handleEditMyVideo = async () => {
    if (!sourceFile) {
      setRenderError('Pick a video first.');
      return;
    }

    setRenderError('');
    setSourceUploading(true);
    try {
      const meta = await probeVideo(sourceFile);
      const url = await uploadTempFile(sourceFile);

      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({
            editDescription,
            fileName: sourceFile.name,
            toggles,
            sourceUrl: url,
            sourceDurationSec: meta.duration,
            sourceWidth: meta.width || 1080,
            sourceHeight: meta.height || 1920,
          })
        );
      } catch {
        // sessionStorage may be unavailable in private mode
      }

      // Anon: continue the flow on the sign-up page. After auth, the
      // user lands back here and the auto-resume effect picks up the
      // Blob URL from sessionStorage.
      if (authLoaded && !authUser) {
        autoAdvancedRef.current = true;
        const returnTo = encodeURIComponent('/video/editing');
        router.push(`/sign-up?returnTo=${returnTo}`);
        return;
      }

      // Authed but no plan: jump straight to paywall.
      if (authUser && !hasEditorAccess(entitlement)) {
        autoAdvancedRef.current = true;
        setStep('paywall');
        setSourceUploading(false);
        return;
      }

      // Authed + plan: go straight to transcribe.
      await startTranscription({
        sourceUrl: url,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
      });
    } catch (err) {
      setRenderError(err.message || 'Upload failed.');
      setSourceFile(null);
    } finally {
      setSourceUploading(false);
    }
  };

  // After-sign-up + after-payment auto-resume. Single effect that
  // routes the user based on what state they came back in:
  //   - authed + plan + sourceUrl saved → kick off transcription
  //   - authed + no plan + sourceUrl saved → show paywall
  //   - everything else → stay on upload step
  useEffect(() => {
    if (autoAdvancedRef.current) return;
    if (!authUser || !entitlement) return;
    if (step !== 'upload') return;
    if (!pendingResume?.sourceUrl) return;

    if (hasEditorAccess(entitlement)) {
      autoAdvancedRef.current = true;
      startTranscription({
        sourceUrl: pendingResume.sourceUrl,
        duration: pendingResume.sourceDurationSec || 0,
        width: pendingResume.sourceWidth,
        height: pendingResume.sourceHeight,
      });
    } else {
      autoAdvancedRef.current = true;
      setStep('paywall');
    }
  }, [authUser, entitlement, pendingResume, step, startTranscription]);

  // Poll transcript-status while a job is in flight. Completes the
  // transition to 'preview' the moment AssemblyAI returns done.
  useEffect(() => {
    if (step !== 'transcribing' || !transcriptId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(
          `/api/video/transcript-status?transcriptId=${encodeURIComponent(transcriptId)}`
        );
        const d = await r.json();
        if (cancelled) return;
        if (d.status === 'completed') {
          setTranscript(d);
          setTranscriptStatus('completed');
          setStep('preview');
        } else if (d.status === 'error') {
          setTranscriptStatus('error');
          setTranscriptError(d.errorMessage || 'Transcription failed.');
        } else {
          setTranscriptStatus(d.status || 'processing');
        }
      } catch (err) {
        if (!cancelled) {
          setTranscriptStatus('error');
          setTranscriptError(err.message || 'Status check failed.');
        }
      }
    };
    tick();
    transcriptPollRef.current = setInterval(tick, 4000);
    return () => {
      cancelled = true;
      if (transcriptPollRef.current) clearInterval(transcriptPollRef.current);
    };
  }, [step, transcriptId]);

  const handleContinueFromPreview = () => {
    setStep('editing');
  };

  // Render the auto-cut transcript decisions directly (skip the manual
  // editor step). Derives keep-intervals from transcript + overrides
  // and POSTs to the new render queue.
  const handleRenderFromPreview = async () => {
    if (!editPlan || !transcript) return;
    const intervals = deriveKeepIntervals({
      preview: transcript.preview,
      overrides: transcriptOverrides,
      sourceDurationSec: transcript.durationSec || editPlan.duration,
      cutFillers: toggles.removeFillers,
      cutSilences: toggles.removeSilences,
    });
    if (intervals.length === 0) {
      setRenderError('Edit plan would produce an empty video. Keep at least one segment.');
      return;
    }
    const submitPlan = {
      ...editPlan,
      sourceDurationSec: transcript.durationSec || editPlan.duration || 0,
      keepIntervals: intervals,
    };
    setRenderError('');
    setRenderProgress(0);
    try {
      const r = await fetch('/api/video/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ editPlan: submitPlan }),
      });
      const d = await r.json();
      if (r.status === 402) {
        setRenderError(
          d.code === 'NO_PLAN'
            ? 'No active plan — pick one to render.'
            : `Out of editor credits (need ${d.cost}, you have ${d.remaining}). Top up to continue.`
        );
        if (d.code === 'NO_PLAN' || d.code === 'INSUFFICIENT') {
          setStep('paywall');
        }
        return;
      }
      if (!r.ok) throw new Error(d.error || 'Render failed to start.');
      saveJob(FEATURE, {
        predictionId: d.renderId,
        kind: 'video-edit',
        editPlan: submitPlan,
        chatHistory: [],
      });
      setEditPlan(submitPlan);
      setRenderId(d.renderId);
      setStep('rendering');
      bumpEntitlement();
    } catch (err) {
      setRenderError(err.message || 'Render failed.');
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
    setTranscriptId(null);
    setTranscript(null);
    setTranscriptOverrides({});
    setTranscriptError('');
    setTranscriptStatus('idle');
    setEditDescription('');
    setToggles(DEFAULT_TOGGLES);
    setPendingResume(null);
    autoAdvancedRef.current = true; // suppress auto-resume after a manual reset
    try { sessionStorage.removeItem(PENDING_KEY); } catch {}
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
        {step !== 'upload' && (
          <header className={styles.header}>
            <div>
              <div className={styles.eyebrow}>◆ Video Editor</div>
              <h1 className={styles.title}>Edit your video with AI</h1>
            </div>
            <button type="button" onClick={handleStartOver} className={styles.downloadBtn}>
              Start over
            </button>
          </header>
        )}

        {step === 'upload' && (
          <div className={styles.canvas}>
            <div
              style={{
                maxWidth: 780,
                margin: '0 auto',
                padding: '22px 24px',
                borderRadius: 14,
                border: '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.015)',
              }}
            >
              <div style={{ textAlign: 'center', marginBottom: 14 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 10,
                    letterSpacing: '0.22em',
                    textTransform: 'uppercase',
                    color: 'var(--gold, #e0c488)',
                    marginBottom: 6,
                  }}
                >
                  ◆ AI Auto-Editor
                </div>
                <h2
                  style={{
                    margin: 0,
                    fontSize: 'clamp(22px, 3vw, 30px)',
                    lineHeight: 1.15,
                    fontWeight: 700,
                    letterSpacing: '-0.01em',
                    color: '#ededed',
                  }}
                >
                  Stop wasting hours editing video.
                </h2>
                <p
                  style={{
                    margin: '8px auto 0',
                    maxWidth: 560,
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: '#b8b6b1',
                  }}
                >
                  Drop a raw recording. AI strips the ums, dead silences, and
                  bad takes — you get a tight, publish-ready cut in minutes.
                </p>
              </div>

              {pendingResume && !pendingResume.sourceUrl && (
                <div
                  style={{
                    margin: '0 0 12px',
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.10)',
                    background: 'rgba(255,255,255,0.02)',
                    color: '#bbb',
                    fontSize: 12,
                    textAlign: 'center',
                    lineHeight: 1.4,
                  }}
                >
                  Welcome back — re-select <strong style={{ color: '#ededed' }}>{pendingResume.fileName}</strong> to continue.
                </div>
              )}

              {pendingResume?.sourceUrl && (
                <div
                  style={{
                    margin: '0 0 12px',
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid rgba(224, 196, 136, 0.3)',
                    background: 'rgba(224, 196, 136, 0.06)',
                    color: '#ededed',
                    fontSize: 12,
                    textAlign: 'center',
                    lineHeight: 1.4,
                  }}
                >
                  Welcome back — <strong>{pendingResume.fileName}</strong> uploaded. Starting analysis…
                </div>
              )}

              <UploadZone
                label="Drop a video to edit"
                sublabel="MP4 / MOV · up to 1 GB"
                icon="🎬"
                accept="video/mp4,video/quicktime,video/*"
                file={sourceFile}
                onFileSelected={handleFilePicked}
                onRemove={() => setSourceFile(null)}
                maxSizeMB={1024}
                zoneStyle={{ padding: '22px 20px' }}
              />

              <div style={{ marginTop: 14 }}>
                <div
                  style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 10,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: '#9b978f',
                    marginBottom: 8,
                  }}
                >
                  What to do with your video
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: 8,
                  }}
                >
                  {FEATURE_LIST.map((f) => (
                    <ToggleChip
                      key={f.key}
                      label={f.label}
                      sublabel={f.sublabel}
                      soon={f.soon}
                      checked={!!toggles[f.key]}
                      onChange={(v) => setToggles((t) => ({ ...t, [f.key]: v }))}
                    />
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <label
                  htmlFor="ve-edit-description"
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    fontSize: 10,
                    letterSpacing: '0.18em',
                    textTransform: 'uppercase',
                    color: '#9b978f',
                    marginBottom: 6,
                  }}
                >
                  Anything else? <span style={{ color: '#6b6b6b' }}>(optional)</span>
                </label>
                <textarea
                  id="ve-edit-description"
                  rows={2}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value.slice(0, 600))}
                  maxLength={600}
                  placeholder="e.g. Cut to under 5 minutes, keep the punchline at 4:30, intro tight"
                  style={{
                    width: '100%',
                    padding: '9px 11px',
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: '#0f0f11',
                    color: '#ededed',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    lineHeight: 1.45,
                    resize: 'vertical',
                  }}
                />
              </div>

              <button
                type="button"
                onClick={handleEditMyVideo}
                disabled={sourceUploading || !sourceFile}
                style={{
                  marginTop: 14,
                  width: '100%',
                  padding: '12px 16px',
                  borderRadius: 10,
                  border: 'none',
                  background: !sourceFile ? 'rgba(237,237,237,0.18)' : '#ededed',
                  color: !sourceFile ? 'rgba(11,11,12,0.5)' : '#0b0b0c',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: sourceUploading || !sourceFile ? 'not-allowed' : 'pointer',
                  opacity: sourceUploading ? 0.6 : 1,
                  transition: 'opacity 120ms ease, background 120ms ease',
                  letterSpacing: '0.01em',
                }}
              >
                {sourceUploading
                  ? 'Uploading…'
                  : sourceFile
                    ? 'Edit My Video Now →'
                    : 'Drop a video to continue'}
              </button>

              {!authUser && sourceFile && (
                <p style={{ marginTop: 8, fontSize: 11, color: '#9b978f', textAlign: 'center', lineHeight: 1.4 }}>
                  Sign up on the next step — your edit choices stay saved.
                </p>
              )}

              {renderError && <div className={styles.msgError} style={{ marginTop: 10 }}>{renderError}</div>}
            </div>
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

        {step === 'transcribing' && (
          <div className={styles.canvas}>
            <div
              style={{
                maxWidth: 560,
                margin: '24px auto',
                padding: '24px 28px',
                borderRadius: 14,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'rgba(255,255,255,0.02)',
                textAlign: 'center',
                color: '#ededed',
              }}
            >
              <div
                style={{
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  fontSize: 11,
                  letterSpacing: '0.22em',
                  textTransform: 'uppercase',
                  color: 'var(--gold, #e0c488)',
                  marginBottom: 10,
                }}
              >
                ◆ Analyzing your video
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>
                {transcriptStatus === 'error'
                  ? 'Transcription failed'
                  : transcriptStatus === 'completed'
                  ? 'Transcript ready'
                  : transcriptStatus === 'processing'
                  ? 'Reading the audio…'
                  : 'Submitting to AssemblyAI…'}
              </div>
              <div style={{ fontSize: 13, color: '#9b978f', lineHeight: 1.5 }}>
                Usually 30–90 seconds. We&rsquo;re finding filler words, silences,
                chapter breaks, and emphasis peaks so the editor can suggest
                smart cuts on the next screen.
              </div>
              {transcriptError && (
                <div className={styles.msgError} style={{ marginTop: 14 }}>
                  {transcriptError}
                </div>
              )}
              <div style={{ marginTop: 18 }}>
                <button
                  type="button"
                  onClick={() => setStep('upload')}
                  className={styles.downloadBtn}
                >
                  ← Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {step === 'preview' && editPlan && transcript && (
          <div className={styles.canvas}>
            <TranscriptPreview
              videoUrl={editPlan.sourceUrl}
              preview={transcript.preview}
              overrides={transcriptOverrides}
              onOverridesChange={setTranscriptOverrides}
              cutFillers={toggles.removeFillers}
              cutSilences={toggles.removeSilences}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
                marginTop: 18,
                flexWrap: 'wrap',
              }}
            >
              <button
                type="button"
                onClick={() => setStep('upload')}
                className={styles.downloadBtn}
              >
                ← Start over
              </button>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={handleContinueFromPreview}
                  className={styles.downloadBtn}
                  title="Open the manual editor to tweak before rendering"
                >
                  Tweak in editor →
                </button>
                <button
                  type="button"
                  onClick={handleRenderFromPreview}
                  className={styles.renderBtn}
                >
                  {transcript?.durationSec
                    ? `Render Final Video · ${Math.max(1, Math.ceil((transcript.durationSec / 60) * 30))} credits`
                    : 'Render Final Video'}
                </button>
              </div>
            </div>
            {renderError && <div className={styles.msgError} style={{ marginTop: 10 }}>{renderError}</div>}
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
