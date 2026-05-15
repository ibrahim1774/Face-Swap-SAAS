import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';

import styles from '../styles/Home.module.css';
import UploadZone from '../components/UploadZone';
import PricingBanner from '../components/PricingBanner';
import Processing from '../components/Processing';
import Result from '../components/Result';
import Paywall from '../components/Paywall';
import HybridPreview from '../components/HybridPreview';
import AuthModal from '../components/AuthModal';
import { uploadTempFile } from '../lib/uploader';
import { extractFirstFrame } from '../lib/frameExtract';
import { log } from '../lib/debugLog';
import { getBrowserSupabase } from '../lib/supabase';
import { bumpEntitlement } from '../lib/entitlementBus';
import { saveJob, loadJob, clearJob } from '../lib/jobPersist';
import { maybeCompressImage } from '../lib/imageCompress';

const FEATURE = 'face-swap';

// Demo clips shown below the Create face swap button. Same set as
// the previous home anonymous landing.
const HOME_CAROUSEL_VIDEOS = [
  { id: 'vh0vtubvpo', aspect: 0.5625 },
  { id: 'jn4yy7w312', aspect: 0.5625 },
  { id: 'uvc4cuqtjk', aspect: 0.5625 },
  { id: '9n1azg2tfa', aspect: 0.5625 },
];

export default function Home() {
  const [step, setStep] = useState('upload');
  const [videoFile, setVideoFile] = useState(null);
  const [faceFile, setFaceFile] = useState(null);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeJob, setActiveJob] = useState(null);
  const [frameJob, setFrameJob] = useState(null); // { predictionId, startedAt } for stage 1
  const [entitlement, setEntitlement] = useState(null);
  const [paidBanner, setPaidBanner] = useState(false);
  const [mode, setMode] = useState('std');
  const [swapMode, setSwapMode] = useState(null); // 'face' | 'body' — no default
  const [previewBusy, setPreviewBusy] = useState(null); // 'regen' | 'proceed' | null
  // URLs persist across upload -> preview -> processing transitions.
  const [uploadedUrls, setUploadedUrls] = useState({
    sourceVideoUrl: null,
    sourceFrameUrl: null,
    referenceImageUrl: null,
    hybridFrameUrl: null,
    swapMode: null,
  });
  const pendingSwapRef = useRef(false);
  const paRetryRef = useRef(false);
  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
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
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthUser(session?.user || null);
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  const canSubmit = Boolean(videoFile && faceFile && consent && swapMode && !submitting);

  const fetchEntitlement = useCallback(async () => {
    try {
      const res = await fetch('/api/entitlement');
      const data = await res.json();
      setEntitlement(data);
      log('info', 'entitlement', data);
      return data;
    } catch (err) {
      log('error', 'entitlement fetch failed', { message: err.message });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!authLoaded || !authUser) return;
    fetchEntitlement();
  }, [authLoaded, authUser, fetchEntitlement]);

  // Resume an in-flight job from localStorage. Two kinds:
  //   character-frame → Processing(image) → preview when complete
  //   swap            → Processing(video) → result   when complete
  useEffect(() => {
    if (!authLoaded || !authUser) return;
    const saved = loadJob(FEATURE);
    if (!saved || !saved.predictionId) return;
    if (saved.kind === 'character-frame') {
      setUploadedUrls({
        sourceVideoUrl: saved.sourceVideoUrl || null,
        sourceFrameUrl: saved.sourceFrameUrl || null,
        referenceImageUrl: saved.referenceImageUrl || null,
        hybridFrameUrl: null,
        swapMode: saved.swapMode || null,
      });
      setSwapMode(saved.swapMode || null);
      setFrameJob({
        predictionId: saved.predictionId,
        startedAt: saved.startedAt,
      });
      setStep('gen-frame');
    } else if (saved.kind === 'swap') {
      setUploadedUrls((prev) => ({
        ...prev,
        sourceVideoUrl: saved.sourceVideoUrl || prev.sourceVideoUrl,
        hybridFrameUrl: saved.hybridFrameUrl || prev.hybridFrameUrl,
      }));
      setActiveJob({
        predictionId: saved.predictionId,
        videoFileName: saved.videoFileName,
        faceFileName: saved.faceFileName,
        startedAt: saved.startedAt,
      });
      setStep('processing');
    }
  }, [authLoaded, authUser]);

  const reset = useCallback(() => {
    clearJob(FEATURE);
    setStep('upload');
    setVideoFile(null);
    setFaceFile(null);
    setConsent(false);
    setError('');
    setSubmitting(false);
    setActiveJob(null);
    setFrameJob(null);
    setSwapMode(null);
    setUploadedUrls({
      sourceVideoUrl: null,
      sourceFrameUrl: null,
      referenceImageUrl: null,
      hybridFrameUrl: null,
      swapMode: null,
    });
  }, []);

  // Stage 1: extract first frame, upload everything, kick off the
  // character-frame prediction (async). Returns true if the prediction
  // was successfully created — caller transitions to 'gen-frame' which
  // polls until the hybrid frame is ready.
  const runCharacterFrame = useCallback(async () => {
    if (!videoFile || !faceFile) return false;
    setError('');
    setSubmitting(true);
    try {
      log('info', 'extracting first frame (browser)', { name: videoFile.name });
      let frameFile = null;
      let needsServerFallback = false;
      try {
        frameFile = await extractFirstFrame(videoFile);
        log('info', 'frame extracted (browser)', { size: frameFile.size });
      } catch (err) {
        if (err && err.code === 'BROWSER_DECODE_FAILED') {
          log('warn', 'browser decode failed — will use server ffmpeg', {
            message: err.message,
          });
          needsServerFallback = true;
        } else {
          throw err;
        }
      }

      // Always upload the source video and reference image. The frame
      // is either uploaded from the browser (fast path) or generated
      // server-side from the source URL (codec fallback).
      const compressedFace = await maybeCompressImage(faceFile);
      const uploadPromises = [uploadTempFile(videoFile), uploadTempFile(compressedFace)];
      if (frameFile) uploadPromises.push(uploadTempFile(frameFile));
      const uploaded = await Promise.all(uploadPromises);
      const sourceVideoUrl = uploaded[0];
      const referenceImageUrl = uploaded[1];
      let sourceFrameUrl = uploaded[2] || null;

      if (needsServerFallback) {
        log('info', 'extract-frame request', { sourceVideoUrl });
        const fr = await fetch('/api/extract-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoUrl: sourceVideoUrl }),
        });
        const fdata = await fr.json().catch(() => ({}));
        log(fr.ok ? 'info' : 'error', 'extract-frame response', {
          httpStatus: fr.status,
          body: fdata,
        });
        if (!fr.ok || !fdata.frameUrl) {
          throw new Error(
            fdata.error ||
              'Server could not extract a first frame from this video.'
          );
        }
        sourceFrameUrl = fdata.frameUrl;
      }

      log('info', 'character frame request', { sourceFrameUrl, referenceImageUrl, swapMode });
      const res = await fetch('/api/character-frame', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstFrameUrl: sourceFrameUrl, referenceImageUrl, swapMode }),
      });
      const rawText = await res.text();
      let data = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        log('error', 'character frame response not JSON', {
          httpStatus: res.status,
          bodyPreview: rawText.slice(0, 300),
        });
        throw new Error(`Server returned non-JSON (${res.status})`);
      }
      log(res.ok ? 'info' : 'warn', 'character frame response', { httpStatus: res.status, body: data });

      if (res.status === 402) {
        await fetchEntitlement();
        setStep('paywall');
        return false;
      }
      if (!res.ok || !data.predictionId) {
        throw new Error(data.error || 'Hybrid frame generation failed.');
      }

      setUploadedUrls({
        sourceVideoUrl,
        sourceFrameUrl,
        referenceImageUrl,
        hybridFrameUrl: null,
        swapMode,
      });

      const startedAt = Date.now();
      saveJob(FEATURE, {
        kind: 'character-frame',
        predictionId: data.predictionId,
        startedAt,
        sourceVideoUrl,
        sourceFrameUrl,
        referenceImageUrl,
        swapMode,
      });
      setFrameJob({ predictionId: data.predictionId, startedAt });

      // First-stage call just consumed a credit — refresh the counter.
      fetchEntitlement();
      bumpEntitlement();
      setStep('gen-frame');
      return true;
    } catch (err) {
      log('error', 'character frame failed', { message: err.message });
      setError(err.message || 'Something went wrong while generating the preview.');
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [videoFile, faceFile, swapMode, fetchEntitlement]);

  // Stage 2: kick off the motion-transfer model using the approved frame + source video.
  const proceedWithSwap = useCallback(async () => {
    const { sourceVideoUrl, hybridFrameUrl } = uploadedUrls;
    if (!sourceVideoUrl || !hybridFrameUrl) return;
    setPreviewBusy('proceed');
    setError('');
    try {
      log('info', 'swap request', { videoUrl: sourceVideoUrl, imageUrl: hybridFrameUrl, mode });
      const res = await fetch('/api/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoUrl: sourceVideoUrl,
          imageUrl: hybridFrameUrl,
          mode,
          videoFileName: videoFile?.name || 'source.mp4',
          faceFileName: faceFile?.name || 'character.jpg',
        }),
      });
      const data = await res.json().catch(() => ({}));
      log(res.ok ? 'info' : 'warn', 'swap response', { httpStatus: res.status, body: data });

      if (res.status === 402) {
        await fetchEntitlement();
        setStep('paywall');
        return;
      }
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start the swap.');
      }

      const startedAt = Date.now();
      setActiveJob({
        jobId: data.jobId,
        predictionId: data.predictionId,
        status: data.status,
        videoFileName: videoFile?.name,
        faceFileName: faceFile?.name,
        startedAt,
      });
      saveJob(FEATURE, {
        kind: 'swap',
        predictionId: data.predictionId,
        startedAt,
        sourceVideoUrl,
        hybridFrameUrl,
        videoFileName: videoFile?.name,
        faceFileName: faceFile?.name,
      });
      setStep('processing');
      paRetryRef.current = false;
      fetchEntitlement();
    } catch (err) {
      log('error', 'swap failed', { message: err.message });
      setError(err.message || 'Something went wrong.');
    } finally {
      setPreviewBusy(null);
    }
  }, [uploadedUrls, mode, videoFile, faceFile, fetchEntitlement]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    log('info', 'submit click', {
      videoName: videoFile?.name,
      videoSize: videoFile?.size,
      faceName: faceFile?.name,
      faceSize: faceFile?.size,
      authed: Boolean(authUser),
    });

    // Anonymous: open the signup modal first. After they create an
    // account they'll be redirected to /dashboard which renders the
    // paywall for users without credits.
    if (!authUser) {
      pendingSwapRef.current = true;
      setAuthModalOpen(true);
      return;
    }

    const ent = entitlement || (await fetchEntitlement());
    if (!ent || !ent.canSwap) {
      // Signed-in but no credits — show inline paywall; files stay in state.
      pendingSwapRef.current = true;
      setStep('paywall');
      return;
    }
    await runCharacterFrame();
  };

  const handleTrialStarted = useCallback(async () => {
    setPaidBanner(false);
    const ent = await fetchEntitlement();
    if (ent && ent.canSwap && pendingSwapRef.current) {
      pendingSwapRef.current = false;
      setStep('upload');
      setTimeout(() => runCharacterFrame(), 0);
    } else {
      setStep('upload');
    }
  }, [fetchEntitlement, runCharacterFrame]);

  const handleComplete = useCallback((job) => {
    clearJob(FEATURE);
    setActiveJob((prev) => ({ ...(prev || {}), ...job }));
    setStep('result');
  }, []);

  const handleError = useCallback(
    (message) => {
      const isPa =
        typeof message === 'string' && /\bPA\b|prediction interrupted/i.test(message);
      if (isPa && !paRetryRef.current) {
        paRetryRef.current = true;
        log('warn', 'PA error — auto-retrying once', { message });
        setError('');
        setTimeout(() => proceedWithSwap(), 0);
        return;
      }
      paRetryRef.current = false;
      clearJob(FEATURE);
      setError(message);
      setStep('preview'); // back to preview so user can retry without re-uploading
    },
    [proceedWithSwap]
  );

  // Stage 1 (character-frame) completion handler. Different from
  // handleComplete because this kind of job lands the user on the
  // preview screen, not the result screen.
  const handleFrameComplete = useCallback((data) => {
    clearJob(FEATURE);
    setFrameJob(null);
    if (!data.resultUrl) {
      setError('Hybrid frame generation returned no result.');
      setStep('upload');
      return;
    }
    setUploadedUrls((prev) => ({ ...prev, hybridFrameUrl: data.resultUrl }));
    setStep('preview');
  }, []);

  const handleFrameError = useCallback((message) => {
    clearJob(FEATURE);
    setFrameJob(null);
    setError(message);
    setStep('upload');
  }, []);

  if (step === 'preview') {
    return (
      <main className={styles.page}>
        {error && <div className={styles.error}>{error}</div>}
        <HybridPreview
          hybridFrameUrl={uploadedUrls.hybridFrameUrl}
          sourceFrameUrl={uploadedUrls.sourceFrameUrl}
          referenceImageUrl={uploadedUrls.referenceImageUrl}
          busy={previewBusy}
          onProceed={proceedWithSwap}
          onCancel={reset}
        />
      </main>
    );
  }

  if (step === 'gen-frame' && frameJob) {
    return (
      <main className={styles.page}>
        <Processing
          predictionId={frameJob.predictionId}
          startedAt={frameJob.startedAt}
          kind="image"
          onComplete={handleFrameComplete}
          onError={handleFrameError}
        />
      </main>
    );
  }

  if (step === 'processing' && activeJob) {
    return (
      <main className={styles.page}>
        <Processing
          predictionId={activeJob.predictionId}
          startedAt={activeJob.startedAt}
          kind="video"
          historyKind="face-swap"
          onComplete={handleComplete}
          onError={handleError}
        />
      </main>
    );
  }

  if (step === 'paywall') {
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Pick a plan</span>
          <h1 className={styles.headline}>
            One step to <span className={styles.accent}>finish your swap</span>
          </h1>
          <p className={styles.subtitle}>
            Your files are ready. Choose a plan and we’ll run the swap right after.
          </p>
        </div>
        {error && <div className={styles.error}>{error}</div>}
        <Paywall
          entitlement={entitlement}
          returnTo="/"
          onError={(msg) => setError(msg)}
          onTrialStarted={handleTrialStarted}
        />
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            type="button"
            onClick={() => setStep('upload')}
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
            ← Back to upload
          </button>
        </div>
      </main>
    );
  }

  if (step === 'result' && activeJob) {
    return (
      <main className={styles.page}>
        <Result
          job={activeJob}
          onNewSwap={reset}
        />
      </main>
    );
  }

  // Anonymous visitors fall through to the creator UI below —
  // they land directly on the face-swap form, upload files, and
  // clicking "Create face swap" routes through handleSubmit which
  // sets step='paywall' (hits the branch above) for any user
  // without credits.

  return (
    <main className={styles.page} style={{ paddingTop: 24 }}>
      <div className={styles.hero} style={{ marginBottom: 12 }}>
        <span className={styles.eyebrow}>◆ AI Face Swap</span>
        <h1 className={styles.headline} style={{ fontSize: 'clamp(32px, 5vw, 52px)', margin: '12px 0 8px' }}>
          Swap any face into <span className={styles.accent}>any video</span>
        </h1>
        <p className={styles.subtitle} style={{ fontSize: 14 }}>
          Upload a 3&ndash;10 second video and a clear front-facing photo. Each swap takes
          2&ndash;4 minutes and downloads automatically.
        </p>
      </div>

      {paidBanner && (
        <div className={styles.banner}>
          ◆ You're subscribed. Upload your files to start swapping.
        </div>
      )}

      {entitlement &&
        (entitlement.tier === 'monthly' ||
          entitlement.tier === 'pro' ||
          entitlement.tier === 'yearly' ||
          entitlement.tier === 'admin') && (
          <PricingBanner
            lines={[{ label: 'Face Swap', cost: '100 credits per swap' }]}
          />
        )}

      <form className={styles.shell} onSubmit={handleSubmit}>
        <div className={styles.uploads} style={{ gap: 10, marginBottom: 12 }}>
          <UploadZone
            label="Source video"
            sublabel="MP4 / MOV · 3–10s"
            icon="🎬"
            accept="video/mp4,video/quicktime"
            file={videoFile}
            onFileSelected={setVideoFile}
            onRemove={() => setVideoFile(null)}
            maxSizeMB={1024}
            compact
          />
          <UploadZone
            label="Reference face"
            sublabel="JPG / PNG · Front-facing"
            icon="👤"
            accept="image/*"
            file={faceFile}
            onFileSelected={setFaceFile}
            onRemove={() => setFaceFile(null)}
            maxSizeMB={1024}
            compact
          />
        </div>

        <div className={styles.modeRow} role="radiogroup" aria-label="Output quality">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'std'}
            className={`${styles.modeBtn} ${mode === 'std' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('std')}
          >
            <span className={styles.modeName}>Standard</span>
            <span className={styles.modeDetail}>720p · faster</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'pro'}
            className={`${styles.modeBtn} ${mode === 'pro' ? styles.modeBtnActive : ''}`}
            onClick={() => setMode('pro')}
          >
            <span className={styles.modeName}>Pro</span>
            <span className={styles.modeDetail}>1080p · sharper</span>
          </button>
        </div>

        <div className={styles.swapModeLabel}>
          Swap mode <span className={styles.required}>(required)</span>
        </div>
        <div className={styles.modeRow} role="radiogroup" aria-label="Swap mode">
          <button
            type="button"
            role="radio"
            aria-checked={swapMode === 'face'}
            className={`${styles.modeBtn} ${swapMode === 'face' ? styles.modeBtnActive : ''}`}
            onClick={() => setSwapMode('face')}
          >
            <span className={styles.modeName}>Face swap</span>
            <span className={styles.modeDetail}>Keep source body + scene, swap only the face</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={swapMode === 'body'}
            className={`${styles.modeBtn} ${swapMode === 'body' ? styles.modeBtnActive : ''}`}
            onClick={() => setSwapMode('body')}
          >
            <span className={styles.modeName}>Full body swap</span>
            <span className={styles.modeDetail}>Replace whole character, keep source pose + scene</span>
          </button>
        </div>

        <label
          className={`${styles.consent} ${consent ? styles.consentActive : ''}`}
          style={{ padding: '8px 12px', marginTop: 8 }}
        >
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
          />
          <span
            className={`${styles.checkbox} ${consent ? styles.checkboxOn : ''}`}
            aria-hidden="true"
          >
            ✓
          </span>
          <span className={styles.consentText} style={{ fontSize: 12 }}>
            I have consent to use this likeness.
          </span>
        </label>

        {error && <div className={styles.error}>{error}</div>}

        <button
          type="submit"
          className={`${styles.submit} ${canSubmit ? styles.submitReady : ''} ${
            submitting ? styles.submitLoading : ''
          }`}
          disabled={!canSubmit}
        >
          {submitting && <span className={styles.spinner} aria-hidden="true" />}
          {submitting ? 'Generating preview…' : 'Create face swap'}
        </button>

        {entitlement && entitlement.canSwap && (
          <div className={styles.usage}>
            {entitlement.status === 'trialing'
              ? `Free trial — ${entitlement.creditsRemaining} credit${entitlement.creditsRemaining === 1 ? '' : 's'} remaining`
              : `${entitlement.tier === 'monthly' ? 'Monthly' : 'Yearly'} plan — ${entitlement.creditsRemaining} credits remaining`}
          </div>
        )}

        {/* Footer trust pills removed for compaction. Legal/security
            info now lives in the dashboard support section + privacy
            page. */}
      </form>

      <Script src="https://fast.wistia.com/player.js" strategy="afterInteractive" async />
      {HOME_CAROUSEL_VIDEOS.map((v) => (
        <Script
          key={v.id}
          src={`https://fast.wistia.com/embed/${v.id}.js`}
          strategy="afterInteractive"
          type="module"
          async
        />
      ))}

      <div className="home-creator-carousel-wrap">
        <div className="home-creator-carousel" role="region" aria-label="Demo swaps">
          {HOME_CAROUSEL_VIDEOS.map((v) => (
            <div key={v.id} className="home-creator-carousel-card">
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
        .home-creator-carousel-wrap {
          max-width: 100%;
          margin: 28px auto 8px;
          padding: 0;
        }
        .home-creator-carousel {
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
        .home-creator-carousel::-webkit-scrollbar {
          display: none;
        }
        .home-creator-carousel-card {
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
        .home-creator-carousel-card wistia-player {
          display: block;
          width: 100%;
          max-width: 100%;
        }
        @media (min-width: 720px) {
          .home-creator-carousel {
            justify-content: center;
            scroll-padding: 0;
            padding: 4px 24px 10px;
          }
          .home-creator-carousel-card {
            width: 180px;
          }
        }
      `}</style>

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        initialMode="signup"
        redirectTo="/dashboard"
      />
    </main>
  );
}
