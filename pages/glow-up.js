import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

import styles from '../styles/GlowUp.module.css';
import Paywall from '../components/Paywall';
import PricingBanner from '../components/PricingBanner';
import AuthModal from '../components/AuthModal';
import { uploadTempFile } from '../lib/uploader';
import { getBrowserSupabase } from '../lib/supabase';
import { bumpEntitlement } from '../lib/entitlementBus';
import { maybeCompressImage } from '../lib/imageCompress';

const STYLES = [
  {
    key: 'professional',
    name: 'Professional',
    desc: 'Corporate headshot, studio lighting, LinkedIn-ready.',
  },
  {
    key: 'casual',
    name: 'Casual',
    desc: 'Natural light, lifestyle portrait, social-ready.',
  },
  {
    key: 'glow-up',
    name: 'Glow Up',
    desc: 'Beauty lighting, radiant skin, your most confident self.',
  },
  {
    key: 'soar',
    name: 'SOAR',
    desc: 'Cinematic, editorial, magazine cover energy.',
  },
];

const MAX_PHOTOS = 4;
const MIN_PHOTOS = 1;

export default function GlowUpPage() {
  const fileInputRef = useRef(null);

  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  // local file state — uploads happen on Generate, not on pick
  const [photos, setPhotos] = useState([]); // [{ id, file, previewUrl }]
  const [dragOver, setDragOver] = useState(false);

  const [styleKey, setStyleKey] = useState('professional');
  const [extraPrompt, setExtraPrompt] = useState('');

  // step: 'idle' | 'paywall' | 'processing' | 'done'
  const [step, setStep] = useState('idle');
  const [resultUrl, setResultUrl] = useState(null);
  const [originalImageUrls, setOriginalImageUrls] = useState([]); // uploaded refs, for re-edits
  const [editPrompt, setEditPrompt] = useState('');
  const [error, setError] = useState('');
  const [credits, setCredits] = useState(null);

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

  // Fetch the image credit balance once we know who the user is.
  useEffect(() => {
    if (!authUser) {
      setCredits(null);
      return;
    }
    fetch('/api/glow-up')
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        if (d && typeof d.imageCreditsRemaining === 'number') {
          setCredits(d);
        }
      })
      .catch(() => {});
  }, [authUser, step]);

  // Revoke object URLs on unmount or when photos change to avoid leaks.
  useEffect(() => {
    return () => {
      photos.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptFiles = (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setError('');
    const incoming = Array.from(fileList).filter((f) =>
      f && f.type && f.type.startsWith('image/')
    );
    if (incoming.length === 0) {
      setError('Only image files are supported (JPG, PNG, WEBP).');
      return;
    }
    const room = MAX_PHOTOS - photos.length;
    const toAdd = incoming.slice(0, room).map((f) => ({
      id: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
      file: f,
      previewUrl: URL.createObjectURL(f),
    }));
    setPhotos((prev) => [...prev, ...toAdd]);
    if (incoming.length > room) {
      setError(`You can upload up to ${MAX_PHOTOS} photos. Extras were ignored.`);
    }
  };

  const removePhoto = (id) => {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  };

  const onPick = (e) => acceptFiles(e.target.files);

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    acceptFiles(e.dataTransfer.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const handleGenerate = async () => {
    setError('');
    if (photos.length < MIN_PHOTOS) {
      setError('Upload at least one photo of yourself.');
      return;
    }
    if (!authUser) {
      setAuthModalOpen(true);
      return;
    }
    // Quick client-side entitlement read; the API is the real gate.
    if (credits && credits.tier === 'none') {
      setStep('paywall');
      return;
    }

    setStep('processing');
    try {
      // 1. Upload each picked file to Vercel Blob (existing pattern).
      const uploaded = [];
      for (const p of photos) {
        const compressed = await maybeCompressImage(p.file);
        const url = await uploadTempFile(compressed);
        uploaded.push(url);
      }

      // 2. Call /api/glow-up with the urls + chosen style + optional extra direction.
      const r = await fetch('/api/glow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrls: uploaded,
          style: styleKey,
          extraPrompt: extraPrompt.trim() || undefined,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 402) {
        setStep('paywall');
        return;
      }
      if (!r.ok) throw new Error(data.error || 'Generation failed.');
      if (!data.imageUrl) throw new Error('No image returned.');

      bumpEntitlement();
      setOriginalImageUrls(uploaded);
      setResultUrl(data.imageUrl);
      setEditPrompt('');
      setStep('done');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      setStep('idle');
    }
  };

  const handleRegenerate = async () => {
    setError('');
    if (!resultUrl) return;
    if (!editPrompt.trim()) {
      setError('Tell us what to change.');
      return;
    }
    setStep('processing');
    try {
      const r = await fetch('/api/glow-up', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'edit',
          imageUrls: [resultUrl, ...originalImageUrls].slice(0, 5),
          editPrompt: editPrompt.trim(),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 402) {
        setStep('paywall');
        return;
      }
      if (!r.ok) throw new Error(data.error || 'Regeneration failed.');
      if (!data.imageUrl) throw new Error('No image returned.');

      bumpEntitlement();
      setResultUrl(data.imageUrl);
      setEditPrompt('');
      setStep('done');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      setStep('done');
    }
  };

  const downloadResult = () => {
    if (!resultUrl) return;
    try {
      const a = document.createElement('a');
      a.href = resultUrl;
      a.download = `glow-up-${styleKey}-${Date.now()}.png`;
      a.rel = 'noopener';
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch {}
  };

  const startOver = () => {
    setResultUrl(null);
    setOriginalImageUrls([]);
    setEditPrompt('');
    setStep('idle');
    setError('');
  };

  const canGenerate = photos.length >= MIN_PHOTOS && step !== 'processing';

  if (!authLoaded) {
    return (
      <main className={styles.page}>
        <div className={styles.processing}>
          <div className={styles.spinner} aria-hidden="true" />
          <span className={styles.processingLabel}>Loading…</span>
        </div>
      </main>
    );
  }

  return (
    <>
      <Head><title>Glow Up — Premium AI Portraits</title></Head>
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Glow Up</span>
          <h1 className={styles.title}>
            Your most polished <span className={styles.titleAccent}>self</span>
          </h1>
          <p className={styles.subtitle}>
            Upload 1–4 photos · pick a style · keeps your real face.
          </p>
        </div>

        {step === 'paywall' ? (
          <>
            <Paywall
              entitlement={credits || null}
              returnTo="/glow-up"
              surface="glow-up"
              onError={(msg) => setError(msg)}
              onTrialStarted={() => {
                setStep('idle');
              }}
            />
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setStep('idle')}
                className={styles.resultBtn}
              >
                ← Back
              </button>
            </div>
          </>
        ) : step === 'processing' ? (
          <div className={styles.processing}>
            <div className={styles.spinner} aria-hidden="true" />
            <span className={styles.processingLabel}>
              Generating your {STYLES.find((s) => s.key === styleKey)?.name || 'portrait'}…
            </span>
            <p className={styles.subtitle} style={{ fontSize: 13 }}>
              Usually 15–45 seconds. Don&apos;t close this tab.
            </p>
          </div>
        ) : step === 'done' && resultUrl ? (
          <div className={styles.result}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={resultUrl} alt="Glow Up result" className={styles.resultImg} />
            <div className={styles.resultRow}>
              <button
                type="button"
                className={`${styles.resultBtn} ${styles.resultBtnPrimary}`}
                onClick={downloadResult}
              >
                ↓ Download
              </button>
              <button type="button" className={styles.resultBtn} onClick={startOver}>
                + New Glow Up
              </button>
            </div>

            <div className={styles.editPanel}>
              <h3 className={styles.editPanelTitle}>Edit this image</h3>
              <p className={styles.editPanelHint}>
                Describe a tweak — we&apos;ll regenerate from this portrait while
                keeping your face. Uses 10 image credits (1 image).
              </p>
              <textarea
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value.slice(0, 400))}
                rows={3}
                maxLength={400}
                placeholder='e.g. add subtle glasses · change to a darker background · warmer lighting · slight smile'
                className={styles.textarea}
              />
              <div className={styles.textareaHint}>{editPrompt.length} / 400</div>
              {error && <div className={styles.error}>{error}</div>}
              <button
                type="button"
                className={styles.cta}
                onClick={handleRegenerate}
                disabled={!editPrompt.trim()}
              >
                Regenerate with edit
                <span className={styles.ctaSub}>Uses 10 image credits (1 generation)</span>
              </button>
            </div>

            {credits && typeof credits.imageCreditsRemaining === 'number' && (
              <div className={styles.usage}>
                {(credits.imageCreditsRemaining * 10).toLocaleString()} image credit
                {credits.imageCreditsRemaining === 1 ? '' : 's'} left ·{' '}
                = {credits.imageCreditsRemaining} image
                {credits.imageCreditsRemaining === 1 ? '' : 's'}
              </div>
            )}
          </div>
        ) : (
          <>
          {credits &&
            (credits.tier === 'monthly' ||
              credits.tier === 'pro' ||
              credits.tier === 'yearly' ||
              credits.tier === 'admin') && (
              <PricingBanner
                lines={[{ label: 'Glow Up portrait', cost: '10 image credits per image' }]}
              />
            )}
          <div className={styles.card}>
            {/* 1. Upload */}
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>1. Upload your photos</h3>
                <span className={styles.sectionMeta}>
                  {photos.length} / {MAX_PHOTOS}
                </span>
              </div>

              {photos.length < MAX_PHOTOS && (
                <div
                  className={`${styles.dropZone} ${dragOver ? styles.dropZoneOver : ''}`}
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current && fileInputRef.current.click();
                    }
                  }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className={styles.dropZoneInput}
                    onChange={(e) => {
                      onPick(e);
                      e.target.value = '';
                    }}
                  />
                  <div className={styles.dropZoneIcon} aria-hidden="true">📤</div>
                  <div className={styles.dropZoneLabel}>
                    Drag photos here or click to upload
                  </div>
                  <div className={styles.dropZoneSub}>
                    JPG · PNG · WEBP · up to {MAX_PHOTOS} photos
                  </div>
                </div>
              )}

              {photos.length > 0 && (
                <div className={styles.thumbs}>
                  {photos.map((p) => (
                    <div key={p.id} className={styles.thumb}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={p.previewUrl} alt="Upload preview" className={styles.thumbImg} />
                      <button
                        type="button"
                        className={styles.thumbRemove}
                        aria-label="Remove photo"
                        onClick={(e) => {
                          e.stopPropagation();
                          removePhoto(p.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 2. Style */}
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>2. Pick a style</h3>
              </div>
              <div className={styles.styleGrid}>
                {STYLES.map((s) => {
                  const active = styleKey === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setStyleKey(s.key)}
                      className={`${styles.styleCard} ${active ? styles.styleCardActive : ''}`}
                      aria-pressed={active}
                    >
                      {active && (
                        <span className={styles.styleCardCheck} aria-hidden="true">✓</span>
                      )}
                      <span className={styles.styleCardName}>{s.name}</span>
                      <span className={styles.styleCardDesc}>{s.desc}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 3. Optional extra direction */}
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>
                  3. Extra direction <span style={{ color: 'var(--text-faint)', fontWeight: 400, fontSize: 13 }}>(optional)</span>
                </h3>
              </div>
              <textarea
                value={extraPrompt}
                onChange={(e) => setExtraPrompt(e.target.value.slice(0, 400))}
                rows={2}
                maxLength={400}
                placeholder='e.g. wearing a navy suit · close-up · outdoor cafe background'
                className={styles.textarea}
              />
              <div className={styles.textareaHint}>
                {extraPrompt.length} / 400 · We&apos;ll blend this with the {STYLES.find((s) => s.key === styleKey)?.name} style.
              </div>
            </section>

            {error && <div className={styles.error}>{error}</div>}

            <button
              type="button"
              className={styles.cta}
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              Generate Glow Up
              <span className={styles.ctaSub}>
                {photos.length === 0
                  ? 'Upload at least 1 photo'
                  : `Uses 10 image credits · ${STYLES.find((s) => s.key === styleKey)?.name}`}
              </span>
            </button>

            {credits && typeof credits.imageCreditsRemaining === 'number' && (
              <div className={styles.usage}>
                {(credits.imageCreditsRemaining * 10).toLocaleString()} image credit
                {credits.imageCreditsRemaining === 1 ? '' : 's'} left ·{' '}
                = {credits.imageCreditsRemaining} image
                {credits.imageCreditsRemaining === 1 ? '' : 's'}
              </div>
            )}
          </div>
          </>
        )}
      </main>

      <AuthModal
        open={authModalOpen}
        onClose={() => setAuthModalOpen(false)}
        initialMode="signup"
        redirectTo="/glow-up"
      />
    </>
  );
}
