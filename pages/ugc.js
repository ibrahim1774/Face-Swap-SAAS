import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Script from 'next/script';
import { useRouter } from 'next/router';

import styles from '../styles/Home.module.css';
import UploadZone from '../components/UploadZone';
import Processing from '../components/Processing';
import Paywall from '../components/Paywall';
import AuthModal from '../components/AuthModal';
import DurationSlider, {
  costForDuration,
  snapToStandardPreset,
  STANDARD_DURATION_PRESETS,
} from '../components/DurationSlider';
import ModelPicker from '../components/ModelPicker';
import ResolutionPicker from '../components/ResolutionPicker';
import { uploadTempFile } from '../lib/uploader';
import { getBrowserSupabase } from '../lib/supabase';
import { bumpEntitlement } from '../lib/entitlementBus';
import { saveJob, loadJob, clearJob } from '../lib/jobPersist';
import {
  loadStory,
  saveStory,
  clearStory,
  appendScene,
  popScene,
  setCombinedUrl,
} from '../lib/storyPersist';
import { maybeCompressImage } from '../lib/imageCompress';

const FEATURE = 'ugc';
const MAX_SCENES = 5;

// Wistia media IDs and aspect ratios for the four marketing demos
// shown to anonymous visitors on /ugc. All are vertical (9:16-ish).
const LANDING_VIDEOS = [
  { id: '85rijpwaq2', aspect: 0.5625 },
  { id: 'lnndmek1c5', aspect: 0.5598755832037325 },
  { id: 'lsno8w6lt4', aspect: 0.5598755832037325 },
  { id: 'nx8bxwnoiw', aspect: 0.5581395348837209 },
  { id: 'clq4ug7ln2', aspect: 0.5642633228840125 },
  { id: 'p68dfq0341', aspect: 0.5642633228840125 },
];

function triggerDownload(url, filename) {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'video.mp4';
    a.rel = 'noopener';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {}
}

export default function UgcPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  // 'choose' | 'gen-image' | 'animate' | 'processing'
  // | 'result' | 'extending' | 'combining' | 'final' | 'paywall'
  const [step, setStep] = useState('choose');
  const [imageUrl, setImageUrl] = useState(null);
  const [imageBusy, setImageBusy] = useState(null);
  const [imagePrompt, setImagePrompt] = useState('');
  const [uploadFile, setUploadFile] = useState(null);
  const [imageJob, setImageJob] = useState(null);

  const [script, setScript] = useState('');
  const [duration, setDuration] = useState(4);
  const [model, setModel] = useState('standard');
  const [resolution, setResolution] = useState('480p');
  const [audio, setAudio] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [entitlement, setEntitlement] = useState(null);

  // Chain state. `story` is the persisted list of completed scenes.
  // `nextSceneType` tells handleAnimate how to build the saved-scene
  // metadata (initial / extend / new). `pendingStartImage` is the
  // image URL to use for the NEXT animation (an extracted last frame
  // or a freshly uploaded image for a New scene).
  const [story, setStory] = useState(null);
  const [nextSceneType, setNextSceneType] = useState('initial');
  const [pendingStartImage, setPendingStartImage] = useState(null);

  // Sign-up modal for the anonymous landing CTA.
  const [authModalOpen, setAuthModalOpen] = useState(false);

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

  // /ugc is now a public landing for anon visitors. No redirect.

  // Resume in-flight jobs + rehydrate the story on mount.
  useEffect(() => {
    if (!authLoaded || !authUser) return;
    const savedStory = loadStory(FEATURE);
    if (savedStory && savedStory.scenes.length > 0) {
      setStory(savedStory);
      // If no active job mid-flight, land the user on the result/final
      // screen of the stored story.
      setImageUrl(savedStory.startingImageUrl || null);
    }
    const saved = loadJob(FEATURE);
    if (!saved || !saved.predictionId) {
      if (savedStory && savedStory.scenes.length > 0) {
        setStep(savedStory.combinedUrl ? 'final' : 'result');
      }
      return;
    }
    if (saved.kind === 'ugc-image') {
      setImageJob({ predictionId: saved.predictionId, startedAt: saved.startedAt });
      setStep('gen-image');
    } else if (saved.kind === 'ugc-animate') {
      setJob({
        predictionId: saved.predictionId,
        downloadName: saved.downloadName || 'ugc.mp4',
        startedAt: saved.startedAt,
        vendor: saved.vendor || 'kie',
        sceneMeta: saved.sceneMeta || null,
      });
      if (saved.imageUrl) setImageUrl(saved.imageUrl);
      setStep('processing');
    }
  }, [authLoaded, authUser]);

  const fetchEntitlement = useCallback(async () => {
    try {
      const r = await fetch('/api/entitlement');
      const d = await r.json();
      setEntitlement(d);
      return d;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (authUser) fetchEntitlement();
  }, [authUser, fetchEntitlement]);

  const cost = costForDuration(duration, model, resolution, audio);
  const storyScenes = story?.scenes || [];
  const latestScene = storyScenes[storyScenes.length - 1] || null;
  const atSceneCap = storyScenes.length >= MAX_SCENES;

  const handleUpload = async (file) => {
    setUploadFile(file);
    setError('');
    setImageBusy('upload');
    try {
      const compressed = await maybeCompressImage(file);
      const url = await uploadTempFile(compressed);
      setImageUrl(url);
      // If this upload is a "New scene" image, use it as the start
      // image for the next animation instead of replacing the story's
      // anchor character.
      if (nextSceneType === 'new') {
        setPendingStartImage(url);
      }
      // Stay on the choose view — the script + knobs + Generate button
      // live inline below the upload zone now.
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setImageBusy(null);
    }
  };

  const handleGenerateImage = async () => {
    if (!imagePrompt.trim()) return;
    if (!authUser) {
      setAuthModalOpen(true);
      return;
    }
    setError('');
    setImageBusy('generate');
    try {
      const r = await fetch('/api/ugc-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: imagePrompt }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 402) {
        await fetchEntitlement();
        setStep('paywall');
        return;
      }
      if (!r.ok || !data.predictionId) throw new Error(data.error || 'Image generation failed.');
      const startedAt = Date.now();
      saveJob(FEATURE, {
        kind: 'ugc-image',
        predictionId: data.predictionId,
        startedAt,
      });
      setImageJob({ predictionId: data.predictionId, startedAt });
      bumpEntitlement();
      setStep('gen-image');
    } catch (err) {
      setError(err.message || 'Image generation failed.');
    } finally {
      setImageBusy(null);
    }
  };

  // The image to use as the starting frame for the next animate call.
  // pendingStartImage > imageUrl. After success we clear pendingStartImage.
  const effectiveStartImage = pendingStartImage || imageUrl;

  const handleAnimate = async (e) => {
    e.preventDefault();
    if (!effectiveStartImage || submitting) return;
    if (!authUser) {
      setAuthModalOpen(true);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const r = await fetch('/api/ugc-animate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: effectiveStartImage,
          script,
          duration,
          model,
          resolution,
          audio,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 402) {
        await fetchEntitlement();
        setStep('paywall');
        return;
      }
      if (!r.ok) throw new Error(data.error || 'Failed to start.');
      const startedAt = Date.now();
      const sceneMeta = {
        startImageUrl: effectiveStartImage,
        prompt: script,
        duration,
        model,
        resolution,
        audio,
        type: nextSceneType,
      };
      const newJob = {
        predictionId: data.predictionId,
        downloadName: 'ugc.mp4',
        startedAt,
        vendor: 'kie',
        sceneMeta,
      };
      saveJob(FEATURE, {
        kind: 'ugc-animate',
        ...newJob,
        imageUrl: effectiveStartImage,
      });
      setJob(newJob);
      bumpEntitlement();
      setStep('processing');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  const onSceneComplete = useCallback(
    (resultUrl) => {
      clearJob(FEATURE);
      const meta = job?.sceneMeta || {
        startImageUrl: effectiveStartImage,
        prompt: script,
        duration,
        model,
        resolution,
        audio,
        type: nextSceneType,
      };
      const scene = {
        id: `scene_${Date.now()}`,
        predictionId: job?.predictionId,
        videoUrl: resultUrl,
        ...meta,
        startedAt: job?.startedAt || Date.now(),
      };
      const next = appendScene(FEATURE, scene, story?.startingImageUrl || imageUrl);
      setStory(next);
      setJob(null);
      // Reset per-scene state so the next Extend/New opens a clean form.
      setScript('');
      setPendingStartImage(null);
      setNextSceneType('initial');
      setStep('result');
    },
    [job, effectiveStartImage, script, duration, model, resolution, audio, nextSceneType, story, imageUrl]
  );

  const onSceneError = useCallback((msg) => {
    clearJob(FEATURE);
    setError(msg);
    setJob(null);
    // If we already have at least one scene, return the user to the
    // result panel so they can retry; otherwise back to the animate
    // form.
    setStep(storyScenes.length > 0 ? 'result' : 'animate');
  }, [storyScenes.length]);

  const handleExtend = async () => {
    if (!latestScene?.videoUrl || atSceneCap) return;
    setError('');
    setStep('extending');
    try {
      const r = await fetch('/api/extract-last-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: latestScene.videoUrl }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.frameUrl) {
        throw new Error(data.error || 'Could not read the last frame of the previous scene.');
      }
      setPendingStartImage(data.frameUrl);
      setNextSceneType('extend');
      setScript('');
      setStep('animate');
    } catch (err) {
      setError(err.message || 'Extend failed.');
      setStep('result');
    }
  };

  const handleNewScene = () => {
    if (atSceneCap) return;
    setError('');
    setPendingStartImage(null);
    setNextSceneType('new');
    setUploadFile(null);
    setImagePrompt('');
    setStep('choose');
  };

  const handleCombine = async () => {
    if (storyScenes.length < 2) return;
    setError('');
    setStep('combining');
    try {
      const r = await fetch('/api/concat-videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrls: storyScenes.map((s) => s.videoUrl).filter(Boolean),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.combinedUrl) {
        throw new Error(data.error || 'Could not combine scenes.');
      }
      const next = setCombinedUrl(FEATURE, data.combinedUrl);
      if (next) setStory(next);
      setStep('final');
    } catch (err) {
      setError(err.message || 'Combine failed.');
      setStep('result');
    }
  };

  const handleUndo = () => {
    const next = popScene(FEATURE);
    setStory(next || null);
    if (!next || next.scenes.length === 0) {
      resetStory();
    } else {
      setStep('result');
    }
  };

  const resetStory = () => {
    clearJob(FEATURE);
    clearStory(FEATURE);
    setStory(null);
    setStep('choose');
    setImageUrl(null);
    setImagePrompt('');
    setUploadFile(null);
    setScript('');
    setJob(null);
    setImageJob(null);
    setAudio(true);
    setModel('standard');
    setResolution('480p');
    setDuration(4);
    setPendingStartImage(null);
    setNextSceneType('initial');
    setError('');
  };

  if (!authLoaded) {
    return (
      <main className={styles.page}>
        <div className={styles.hero}><p className={styles.subtitle}>Loading…</p></div>
      </main>
    );
  }

  // Anonymous landing: 4 vertical Wistia demos in a 2x2 grid + signup CTA.
  // After signup, auth state changes and this branch falls through to
  // the paywall gate (or creator if the user already has a plan).

  // No pre-creator paywall gate. Authed users without credits can
  // still enter the creator, pick an image, write a script, and click
  // Generate. The /api/ugc-image and /api/ugc-animate endpoints will
  // return 402 paywall and the existing handlers will surface the
  // Paywall step at that point — same flow as face-swap.

  if (step === 'gen-image' && imageJob) {
    return (
      <main className={styles.page}>
        <Processing
          predictionId={imageJob.predictionId}
          startedAt={imageJob.startedAt}
          kind="image"
          onComplete={(data) => {
            clearJob(FEATURE);
            if (!data.resultUrl) {
              setError('Image generation returned no result.');
              setStep('choose');
              return;
            }
            setImageUrl(data.resultUrl);
            if (nextSceneType === 'new') setPendingStartImage(data.resultUrl);
            setImageJob(null);
            fetchEntitlement();
            setStep('animate');
          }}
          onError={(msg) => {
            clearJob(FEATURE);
            setImageJob(null);
            setError(msg);
            setStep('choose');
          }}
        />
      </main>
    );
  }

  if (step === 'processing' && job) {
    return (
      <main className={styles.page}>
        <Processing
          predictionId={job.predictionId}
          startedAt={job.startedAt}
          vendor={job.vendor || 'kie'}
          kind="video"
          historyKind="ugc"
          onComplete={(d) => onSceneComplete(d.resultUrl)}
          onError={onSceneError}
        />
      </main>
    );
  }

  if (step === 'extending') {
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Extending</span>
          <h1 className={styles.headline}>
            Reading the <span className={styles.accent}>last frame</span>
          </h1>
          <p className={styles.subtitle}>
            Grabbing the final frame from your last scene so the next one starts
            exactly where that one ended. Usually under 15 seconds.
          </p>
        </div>
      </main>
    );
  }

  if (step === 'combining') {
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Combining</span>
          <h1 className={styles.headline}>
            Stitching your <span className={styles.accent}>scenes together</span>
          </h1>
          <p className={styles.subtitle}>
            Concatenating {storyScenes.length} clips into one MP4. Usually under
            30 seconds.
          </p>
        </div>
      </main>
    );
  }

  if (step === 'final' && story?.combinedUrl) {
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Done</span>
          <h1 className={styles.headline}>
            Your story is <span className={styles.accent}>ready</span>
          </h1>
          <p className={styles.subtitle}>
            {storyScenes.length} scenes combined into one video.
          </p>
        </div>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 16px' }}>
          <video
            src={story.combinedUrl}
            controls
            style={{ width: '100%', borderRadius: 12, background: '#000' }}
          />
          <div style={{ display: 'flex', gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={() => triggerDownload(story.combinedUrl, 'haelabs-story.mp4')}
              className={`${styles.submit} ${styles.submitReady}`}
              style={{ flex: 1, minWidth: 200 }}
            >
              ↓ Download combined
            </button>
            <button
              type="button"
              onClick={() => setStep('result')}
              style={{
                flex: 1, minWidth: 160,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#ddd',
                padding: '10px 16px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              ← Back to scenes
            </button>
            <button
              type="button"
              onClick={resetStory}
              style={{
                flex: 1, minWidth: 160,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#ddd',
                padding: '10px 16px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              + New story
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (step === 'result' && storyScenes.length > 0) {
    const featured = latestScene;
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>
            ◆ Scene {storyScenes.length} of {MAX_SCENES} &middot; saved
          </span>
          <h1 className={styles.headline}>
            Your scene is <span className={styles.accent}>ready</span>
          </h1>
        </div>

        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 16px' }}>
          {/* Latest scene video */}
          <video
            key={featured?.id}
            src={featured?.videoUrl}
            controls
            style={{ width: '100%', borderRadius: 12, background: '#000' }}
          />

          {/* Story rail */}
          {storyScenes.length > 1 && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                marginTop: 16,
                overflowX: 'auto',
                padding: '4px 0',
              }}
            >
              {storyScenes.map((s, i) => (
                <div
                  key={s.id}
                  style={{
                    flex: '0 0 auto',
                    width: 120,
                    border: `1px solid ${s.id === featured.id ? 'rgba(255, 255, 255,0.6)' : 'rgba(255,255,255,0.12)'}`,
                    borderRadius: 8,
                    overflow: 'hidden',
                    background: '#0f0f11',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.startImageUrl}
                    alt={`Scene ${i + 1}`}
                    style={{ width: '100%', height: 80, objectFit: 'cover', display: 'block' }}
                  />
                  <div style={{ padding: '6px 8px', fontSize: 11, color: '#bbb' }}>
                    Scene {i + 1} · {s.duration}s {s.type === 'extend' ? '↪' : s.type === 'new' ? '+' : ''}
                  </div>
                </div>
              ))}
            </div>
          )}

          {error && <div className={styles.error} style={{ marginTop: 16 }}>{error}</div>}

          <div
            style={{
              marginTop: 10,
              padding: '10px 14px',
              background: 'rgba(224, 196, 136, 0.06)',
              border: '1px solid rgba(224, 196, 136, 0.25)',
              borderRadius: 8,
              fontSize: 12,
              color: '#e6e6e6',
              lineHeight: 1.5,
            }}
          >
            Each scene generates its own audio track. Voice and ambient sound
            will change at the scene seam.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 16 }}>
            <button
              type="button"
              onClick={handleExtend}
              disabled={atSceneCap}
              className={`${styles.submit} ${styles.submitReady}`}
              style={atSceneCap ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
            >
              ↪ Extend scene
            </button>
            <button
              type="button"
              onClick={handleNewScene}
              disabled={atSceneCap}
              style={{
                background: 'transparent',
                border: '1px solid rgba(224, 196, 136, 0.4)',
                color: '#ededed',
                padding: '12px 16px',
                borderRadius: 6,
                cursor: atSceneCap ? 'not-allowed' : 'pointer',
                opacity: atSceneCap ? 0.4 : 1,
                fontSize: 14,
                fontFamily: 'inherit',
                fontWeight: 500,
              }}
            >
              + New scene
            </button>
          </div>

          {atSceneCap && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#888', textAlign: 'center' }}>
              5-scene cap reached. Combine or start a new story.
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            {storyScenes.length >= 2 && (
              <button
                type="button"
                onClick={handleCombine}
                style={{
                  flex: 1, minWidth: 180,
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.18)',
                  color: '#ddd',
                  padding: '10px 14px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              >
                ↓ Combine &amp; download ({storyScenes.length} scenes)
              </button>
            )}
            <button
              type="button"
              onClick={() => triggerDownload(featured.videoUrl, `scene-${storyScenes.length}.mp4`)}
              style={{
                flex: 1, minWidth: 140,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#ddd',
                padding: '10px 14px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              ↓ Scene {storyScenes.length}
            </button>
            {storyScenes.length > 0 && (
              <button
                type="button"
                onClick={handleUndo}
                style={{
                  flex: 1, minWidth: 120,
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#bbb',
                  padding: '10px 14px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontFamily: 'inherit',
                }}
              >
                ⌫ Undo last
              </button>
            )}
            <button
              type="button"
              onClick={resetStory}
              style={{
                flex: 1, minWidth: 120,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#bbb',
                padding: '10px 14px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              + New story
            </button>
          </div>

          {entitlement && entitlement.canSwap && (
            <div className={styles.usage} style={{ marginTop: 16 }}>
              {entitlement.creditsRemaining} credit
              {entitlement.creditsRemaining === 1 ? '' : 's'} remaining
            </div>
          )}
        </div>
      </main>
    );
  }

  if (step === 'paywall') {
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Out of credits</span>
          <h1 className={styles.headline}>Pick a plan to keep going</h1>
        </div>
        <Paywall
          entitlement={entitlement}
          returnTo="/ugc"
          onError={(msg) => setError(msg)}
          onTrialStarted={() => { fetchEntitlement(); setStep(storyScenes.length > 0 ? 'result' : 'choose'); }}
        />
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setStep(storyScenes.length > 0 ? 'result' : (imageUrl ? 'animate' : 'choose'))}
            style={{
              background: 'transparent',
              border: '1px solid rgba(255,255,255,0.15)',
              color: '#ddd',
              padding: '8px 16px',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: 'inherit',
            }}
          >
            ← Back
          </button>
        </div>
      </main>
    );
  }

  const calloutStyle = {
    maxWidth: 720,
    margin: '12px auto 20px',
    padding: '12px 16px',
    border: '1px solid rgba(224, 196, 136, 0.35)',
    borderRadius: 10,
    background: 'rgba(224, 196, 136, 0.06)',
    color: '#e6e6e6',
    fontSize: 13,
    lineHeight: 1.5,
    textAlign: 'center',
  };

  if (step === 'animate' && effectiveStartImage) {
    const eyebrow =
      nextSceneType === 'extend'
        ? `◆ Scene ${storyScenes.length + 1} of ${MAX_SCENES} — continuing from last frame`
        : nextSceneType === 'new'
          ? `◆ Scene ${storyScenes.length + 1} of ${MAX_SCENES} — new image`
          : '◆ Tell your character what to do';

    return (
      <>
        <Head><title>UGC Creator — Haelabs</title></Head>
        <main className={styles.page}>
          <div className={styles.hero}>
            <span className={styles.eyebrow}>{eyebrow}</span>
            <h1 className={styles.headline}>
              Tell your character what to <span className={styles.accent}>do and say</span>
            </h1>
          </div>

          <div style={calloutStyle}>
            ◆ Powered by Kling 3.0 — <strong>3&ndash;15 seconds</strong> per scene with
            optional native audio. <strong>1 credit per second</strong> of video.
            Generation takes 2&ndash;4 minutes.
          </div>

          <form className={styles.shell} onSubmit={handleAnimate}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={effectiveStartImage}
                alt="Starting frame"
                style={{ maxWidth: 320, maxHeight: 320, borderRadius: 12, border: '1px solid rgba(255,255,255,0.12)' }}
              />
            </div>

            <label className={styles.field} style={{ display: 'block' }}>
              <span className={styles.swapModeLabel}>Script / direction</span>
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value)}
                rows={4}
                placeholder='e.g. Smiles and waves at the camera, then says: "Hey everyone, today I am reviewing my favorite coffee."'
                style={{
                  width: '100%',
                  padding: 12,
                  borderRadius: 8,
                  background: '#0f0f11',
                  color: '#eee',
                  border: '1px solid rgba(255,255,255,0.12)',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  resize: 'vertical',
                }}
              />
              <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
                Tip: put dialogue in &ldquo;quotes&rdquo; so the model lip-syncs it.
              </div>
            </label>

            <ModelPicker
              value={model}
              onChange={(next) => {
                setModel(next);
                if (next === 'standard') setDuration((d) => snapToStandardPreset(d));
              }}
            />
            <ResolutionPicker
              model={model}
              resolution={resolution}
              audio={audio}
              onChange={(next) => {
                setResolution(next.resolution);
                setAudio(next.audio);
              }}
            />
            <DurationSlider
              value={duration}
              onChange={setDuration}
              model={model}
              resolution={resolution}
              audio={audio}
            />

            {error && <div className={styles.error}>{error}</div>}

            <button
              type="submit"
              className={`${styles.submit} ${styles.submitReady} ${submitting ? styles.submitLoading : ''}`}
              disabled={submitting}
            >
              {submitting && <span className={styles.spinner} aria-hidden="true" />}
              {submitting ? 'Starting…' : `Generate (${cost} credit${cost === 1 ? '' : 's'})`}
            </button>

            <button
              type="button"
              onClick={() => {
                if (storyScenes.length > 0) {
                  // Back to story instead of losing state.
                  setPendingStartImage(null);
                  setNextSceneType('initial');
                  setStep('result');
                } else {
                  setImageUrl(null);
                  setStep('choose');
                }
              }}
              style={{
                marginTop: 12,
                background: 'transparent',
                border: '1px solid rgba(255,255,255,0.15)',
                color: '#ddd',
                padding: '8px 16px',
                borderRadius: 6,
                cursor: 'pointer',
                fontSize: 13,
                fontFamily: 'inherit',
                width: '100%',
              }}
            >
              ← {storyScenes.length > 0 ? 'Back to scenes' : 'Use a different image'}
            </button>

            {entitlement && entitlement.canSwap && (
              <div className={styles.usage}>
                {entitlement.creditsRemaining} credit
                {entitlement.creditsRemaining === 1 ? '' : 's'} remaining
              </div>
            )}
          </form>
        </main>

        <AuthModal
          open={authModalOpen}
          onClose={() => setAuthModalOpen(false)}
          initialMode="signup"
          redirectTo="/dashboard"
        />
      </>
    );
  }

  // step === 'choose'
  // Prompt-to-character generator costs 1 credit, so it only makes
  // sense to surface for users on a paid plan (or trialing). Anon
  // and free users see the upload box only.
  const canUsePromptGenerator =
    entitlement?.tier === 'monthly' ||
    entitlement?.tier === 'pro' ||
    entitlement?.tier === 'yearly' ||
    entitlement?.status === 'trialing';
  return (
    <>
      <Head><title>From a Single Image to a Full Video — Haelabs</title></Head>
      <main className={styles.page} style={{ paddingTop: 8 }}>
        <div className={styles.hero} style={{ marginBottom: 6 }}>
          <h1
            className={styles.headline}
            style={{ fontSize: 'clamp(18px, 2.6vw, 26px)', margin: '4px 0', lineHeight: 1.2 }}
          >
            Turn Your Image Into a Talking, Moving Video
          </h1>
        </div>

        <form onSubmit={handleAnimate} className={styles.ugcCard}>
          {/* 1. Add your character */}
          <section className={styles.ugcSection}>
            <h3 className={styles.ugcSectionTitle}>1. Add your character</h3>
            <UploadZone
              label="Upload image"
              sublabel="JPG or PNG · clear face/body"
              icon="📤"
              accept="image/*"
              file={uploadFile}
              onFileSelected={handleUpload}
              onRemove={() => { setUploadFile(null); setImageUrl(null); }}
              maxSizeMB={1024}
              compact
            />
            {imageBusy === 'upload' && (
              <div className={styles.usage} style={{ marginTop: 8 }}>Uploading…</div>
            )}

            {canUsePromptGenerator && (
              <>
                <div className={styles.ugcOr}>
                  <span className={styles.ugcOrLine} />
                  <span className={styles.ugcOrText}>OR</span>
                  <span className={styles.ugcOrLine} />
                </div>
                <details className={styles.ugcDisclosure}>
                  <summary className={styles.ugcDisclosureSummary}>
                    <span className={styles.ugcDisclosureIcon} aria-hidden="true">✦</span>
                    <span className={styles.ugcDisclosureLabel}>
                      <span className={styles.ugcDisclosureTitle}>Describe your character</span>
                      <span className={styles.ugcDisclosureHint}>e.g. a woman in a white shirt, sitting in a cafe</span>
                    </span>
                    <span className={styles.ugcDisclosureChevron} aria-hidden="true">⌄</span>
                  </summary>
                  <div className={styles.ugcDisclosureBody}>
                    <textarea
                      value={imagePrompt}
                      onChange={(e) => setImagePrompt(e.target.value)}
                      rows={3}
                      placeholder="e.g. A 25-year-old woman with brown hair smiling at the camera, soft studio lighting."
                      className={styles.ugcTextarea}
                    />
                    <button
                      type="button"
                      onClick={handleGenerateImage}
                      disabled={!imagePrompt.trim() || imageBusy !== null}
                      className={`${styles.submit} ${imagePrompt.trim() && imageBusy === null ? styles.submitReady : ''} ${imageBusy === 'generate' ? styles.submitLoading : ''}`}
                      style={{ marginTop: 12 }}
                    >
                      {imageBusy === 'generate' && <span className={styles.spinner} aria-hidden="true" />}
                      {imageBusy === 'generate' ? 'Starting…' : 'Generate image (1 credit)'}
                    </button>
                  </div>
                </details>
              </>
            )}
          </section>

          {/* 2. Script */}
          <section className={styles.ugcSection}>
            <h3 className={styles.ugcSectionTitle}>2. What should they say &amp; do?</h3>
            <div className={styles.ugcTextareaWrap}>
              <textarea
                value={script}
                onChange={(e) => setScript(e.target.value.slice(0, 500))}
                rows={3}
                maxLength={500}
                placeholder='e.g. Smiles and waves, then says: "Hey everyone, today I am reviewing my favorite coffee."'
                className={styles.ugcTextarea}
              />
              <span className={styles.ugcCharCount}>{script.length} / 500</span>
            </div>
          </section>

          {/* 3. Video length */}
          <section className={styles.ugcSection}>
            <h3 className={styles.ugcSectionTitle}>3. Video length</h3>
            {model === 'standard' ? (
              <div
                role="radiogroup"
                aria-label="Video length"
                style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
              >
                {STANDARD_DURATION_PRESETS.map((sec) => {
                  const selected = duration === sec;
                  return (
                    <button
                      key={sec}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setDuration(sec)}
                      style={{
                        flex: '1 1 0',
                        padding: '14px 12px',
                        borderRadius: 12,
                        border: selected
                          ? '1px solid rgba(255,255,255,0.55)'
                          : '1px solid rgba(255,255,255,0.12)',
                        background: selected ? '#ededed' : '#0f0f11',
                        color: selected ? '#0b0b0c' : '#ededed',
                        fontFamily: 'inherit',
                        fontSize: 15,
                        fontWeight: selected ? 600 : 500,
                        cursor: 'pointer',
                        transition: 'background 120ms ease, color 120ms ease',
                      }}
                    >
                      {sec}s
                    </button>
                  );
                })}
              </div>
            ) : (
              <>
                <input
                  type="range"
                  min={3}
                  max={15}
                  step={1}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className={styles.ugcSlider}
                  aria-label="Video length"
                />
                <div className={styles.ugcSliderLabels}>
                  <div className={styles.ugcSliderTick}>
                    <span className={styles.ugcSliderTickValue}>3s</span>
                    <span className={styles.ugcSliderTickLabel}>Short</span>
                  </div>
                  <div className={styles.ugcSliderTick} style={{ textAlign: 'center' }}>
                    <span className={styles.ugcSliderTickValue}>{duration}s</span>
                    <span className={styles.ugcSliderTickLabel}>
                      {duration <= 5 ? 'Short' : duration <= 9 ? 'Medium' : 'Long'}
                    </span>
                  </div>
                  <div className={styles.ugcSliderTick} style={{ textAlign: 'right' }}>
                    <span className={styles.ugcSliderTickValue}>15s</span>
                    <span className={styles.ugcSliderTickLabel}>Long</span>
                  </div>
                </div>
              </>
            )}
          </section>

          <ModelPicker
              value={model}
              onChange={(next) => {
                setModel(next);
                if (next === 'standard') setDuration((d) => snapToStandardPreset(d));
              }}
            />
          <ResolutionPicker
            model={model}
            resolution={resolution}
            audio={audio}
            onChange={(next) => {
              setResolution(next.resolution);
              setAudio(next.audio);
            }}
          />

          {error && <div className={styles.error}>{error}</div>}

          <button
            type="submit"
            className={`${styles.ugcCta} ${(!effectiveStartImage || submitting) ? styles.ugcCtaDisabled : ''}`}
            disabled={!effectiveStartImage || submitting}
          >
            {submitting && <span className={styles.spinner} aria-hidden="true" />}
            <span className={styles.ugcCtaIcon} aria-hidden="true">✦</span>
            <span className={styles.ugcCtaContent}>
              <span className={styles.ugcCtaTitle}>
                {submitting
                  ? 'Starting…'
                  : effectiveStartImage
                    ? 'Generate video'
                    : 'Upload an image to continue'}
              </span>
              {effectiveStartImage && !submitting && (
                <span className={styles.ugcCtaSub}>Uses {cost} credit{cost === 1 ? '' : 's'}</span>
              )}
            </span>
          </button>

          {nextSceneType === 'new' && storyScenes.length > 0 && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setStep('result')}
                className={styles.ugcSecondaryLink}
              >
                ← Back to scenes
              </button>
            </div>
          )}

          <div className={styles.ugcFootNote}>
            <span aria-hidden="true">🔒</span>
            <span>Your videos are private and secure</span>
          </div>

          {entitlement && entitlement.canSwap && (
            <div className={styles.usage} style={{ marginTop: 8 }}>
              {entitlement.creditsRemaining} credit
              {entitlement.creditsRemaining === 1 ? '' : 's'} remaining
            </div>
          )}
        </form>

        <Script src="https://fast.wistia.com/player.js" strategy="afterInteractive" async />
        {LANDING_VIDEOS.slice(0, 4).map((v) => (
          <Script
            key={v.id}
            src={`https://fast.wistia.com/embed/${v.id}.js`}
            strategy="afterInteractive"
            type="module"
            async
          />
        ))}

        <div className="ugc-creator-carousel-wrap">
          <div className="ugc-creator-carousel" role="region" aria-label="UGC examples">
            {LANDING_VIDEOS.slice(0, 4).map((v) => (
              <div key={v.id} className="ugc-creator-carousel-card">
                <wistia-player
                  media-id={v.id}
                  aspect={String(v.aspect)}
                  autoplay="true"
                  muted="true"
                  silentautoplay="true"
                  playsinline="true"
                  controls-visible-on-load="false"
                  playbar="false"
                  playbutton="false"
                  volume-control="false"
                  fullscreen-button="false"
                  settings-control="false"
                  endvideobehavior="loop"
                />
              </div>
            ))}
          </div>
        </div>

        <style jsx global>{`
          .ugc-creator-carousel-wrap {
            max-width: 100%;
            margin: 28px auto 8px;
            padding: 0;
          }
          .ugc-creator-carousel {
            display: flex;
            gap: 10px;
            overflow-x: auto;
            overflow-y: hidden;
            scroll-snap-type: x mandatory;
            -webkit-overflow-scrolling: touch;
            scroll-padding: 0 16px;
            padding: 4px 16px 10px;
            scrollbar-width: none;
          }
          .ugc-creator-carousel::-webkit-scrollbar { display: none; }
          .ugc-creator-carousel-card {
            flex: 0 0 auto;
            width: clamp(160px, 60vw, 200px);
            border-radius: 12px;
            overflow: hidden;
            border: 1px solid rgba(224, 196, 136, 0.18);
            background: #0c0c0e;
            box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
            scroll-snap-align: center;
            min-width: 0;
          }
          .ugc-creator-carousel-card wistia-player {
            display: block;
            width: 100%;
            max-width: 100%;
          }
          @media (min-width: 720px) {
            .ugc-creator-carousel {
              justify-content: center;
              scroll-padding: 0;
              padding: 4px 24px 10px;
            }
            .ugc-creator-carousel-card { width: 180px; }
          }
        `}</style>
      </main>

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        initialMode="signup"
        redirectTo="/dashboard"
      />
    </>
  );
}
