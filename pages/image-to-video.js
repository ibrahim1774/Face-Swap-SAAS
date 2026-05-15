import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

import styles from '../styles/Home.module.css';
import UploadZone from '../components/UploadZone';
import Processing from '../components/Processing';
import Result from '../components/Result';
import Paywall from '../components/Paywall';
import DurationSlider, { costForDuration } from '../components/DurationSlider';
import { uploadTempFile } from '../lib/uploader';
import { getBrowserSupabase } from '../lib/supabase';
import { bumpEntitlement } from '../lib/entitlementBus';
import { saveJob, loadJob, clearJob } from '../lib/jobPersist';
import { maybeCompressImage } from '../lib/imageCompress';

const FEATURE = 'image-to-video';

export default function ImageToVideoPage() {
  const router = useRouter();
  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);

  const [step, setStep] = useState('upload'); // 'upload' | 'paywall' | 'processing' | 'result'
  const [imageFile, setImageFile] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState('std');
  const [duration, setDuration] = useState(5);
  const [audio, setAudio] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [job, setJob] = useState(null);
  const [entitlement, setEntitlement] = useState(null);

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

  useEffect(() => {
    if (authLoaded && !authUser) router.replace('/sign-in');
  }, [authLoaded, authUser, router]);

  // Resume any in-flight job from localStorage so the user can leave
  // the page mid-generation and come back to the same state.
  useEffect(() => {
    if (!authLoaded || !authUser) return;
    const saved = loadJob(FEATURE);
    if (saved && saved.predictionId) {
      setJob({
        predictionId: saved.predictionId,
        downloadName: saved.downloadName || 'image-to-video.mp4',
        startedAt: saved.startedAt,
        vendor: saved.vendor || 'replicate',
      });
      setStep('processing');
    }
  }, [authLoaded, authUser]);

  const fetchEntitlement = useCallback(async () => {
    try {
      const res = await fetch('/api/entitlement');
      const data = await res.json();
      setEntitlement(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    if (authUser) fetchEntitlement();
  }, [authUser, fetchEntitlement]);

  const canSubmit = Boolean(imageFile && !submitting);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const compressed = await maybeCompressImage(imageFile);
      const imageUrl = await uploadTempFile(compressed);
      const res = await fetch('/api/image-to-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl, prompt, mode, duration, audio }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 402) {
        await fetchEntitlement();
        setStep('paywall');
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to start.');
      const startedAt = Date.now();
      const newJob = {
        predictionId: data.predictionId,
        downloadName: 'image-to-video.mp4',
        startedAt,
        vendor: 'kie',
      };
      saveJob(FEATURE, { ...newJob, kind: 'image-to-video' });
      setJob(newJob);
      bumpEntitlement();
      setStep('processing');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    clearJob(FEATURE);
    setStep('upload');
    setImageFile(null);
    setPrompt('');
    setJob(null);
    setError('');
  };

  if (!authLoaded || !authUser) {
    return (
      <main className={styles.page}>
        <div className={styles.hero}>
          <p className={styles.subtitle}>Loading…</p>
        </div>
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
          historyKind="image-to-video"
          onComplete={(data) => {
            clearJob(FEATURE);
            setJob((prev) => ({ ...prev, resultUrl: data.resultUrl }));
            setStep('result');
          }}
          onError={(msg) => {
            clearJob(FEATURE);
            setError(msg);
            setStep('upload');
          }}
        />
      </main>
    );
  }

  if (step === 'result' && job) {
    return (
      <main className={styles.page}>
        <Result job={{ ...job, videoFileName: imageFile?.name }} onNewSwap={reset} />
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
          returnTo="/image-to-video"
          onError={(msg) => setError(msg)}
          onTrialStarted={() => {
            fetchEntitlement();
            setStep('upload');
          }}
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
            ← Back
          </button>
        </div>
      </main>
    );
  }

  return (
    <>
      <Head>
        <title>Image to Video — Haelabs</title>
      </Head>
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Image to Video</span>
          <h1 className={styles.headline}>
            Turn a photo into a <span className={styles.accent}>moving clip</span>
          </h1>
          <p className={styles.subtitle}>
            Upload one image and tell us the motion you want. Our top-rated
            video model paints it to life &mdash; <strong>from 30 credits per generation</strong>.
          </p>
        </div>

        <div
          style={{
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
          }}
        >
          ◆ Powered by Kling 3.0 — pick any length from <strong>3 to 15 seconds</strong>.
          Optional native audio (dialogue, lip-sync, sound effects). Cost varies
          by length / resolution / audio. Generation takes <strong>2&ndash;4 minutes</strong>.
        </div>

        <form className={styles.shell} onSubmit={handleSubmit}>
          <div className={styles.uploads} style={{ gridTemplateColumns: '1fr' }}>
            <UploadZone
              label="Starting image"
              sublabel="JPG or PNG · clear subject, good lighting"
              icon="🖼️"
              accept="image/jpeg,image/png"
              file={imageFile}
              onFileSelected={setImageFile}
              onRemove={() => setImageFile(null)}
              maxSizeMB={1024}
            />
          </div>

          <label className={styles.field} style={{ display: 'block', marginTop: 16 }}>
            <span className={styles.swapModeLabel}>Describe the motion</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder='e.g. The woman smiles and turns to the camera. She says: "Hi, welcome back to my channel."'
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
          </label>

          <DurationSlider
            value={duration}
            onChange={setDuration}
            model="studio-pro"
            resolution={mode === 'pro' ? '1080p' : '480p'}
            audio={audio}
          />

          <div className={styles.swapModeLabel} style={{ marginTop: 16 }}>Audio</div>
          <div className={styles.modeRow} role="radiogroup" aria-label="Audio">
            <button
              type="button"
              role="radio"
              aria-checked={audio === true}
              className={`${styles.modeBtn} ${audio === true ? styles.modeBtnActive : ''}`}
              onClick={() => setAudio(true)}
            >
              <span className={styles.modeName}>With audio</span>
              <span className={styles.modeDetail}>Dialogue, lip-sync, ambient SFX</span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={audio === false}
              className={`${styles.modeBtn} ${audio === false ? styles.modeBtnActive : ''}`}
              onClick={() => setAudio(false)}
            >
              <span className={styles.modeName}>Silent</span>
              <span className={styles.modeDetail}>Video only &middot; cheaper output</span>
            </button>
          </div>

          <div className={styles.swapModeLabel} style={{ marginTop: 16 }}>Quality</div>
          <div className={styles.modeRow} role="radiogroup" aria-label="Quality">
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

          {error && <div className={styles.error}>{error}</div>}

          <button
            type="submit"
            className={`${styles.submit} ${canSubmit ? styles.submitReady : ''} ${submitting ? styles.submitLoading : ''}`}
            disabled={!canSubmit}
          >
            {submitting && <span className={styles.spinner} aria-hidden="true" />}
            {submitting
              ? 'Starting…'
              : (() => {
                const c = costForDuration(duration, mode, audio);
                return `Generate (${c} credit${c === 1 ? '' : 's'})`;
              })()}
          </button>

          {entitlement && entitlement.canSwap && (
            <div className={styles.usage}>
              {entitlement.creditsRemaining} credit
              {entitlement.creditsRemaining === 1 ? '' : 's'} remaining
            </div>
          )}
        </form>
      </main>
    </>
  );
}
