import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

import styles from '../styles/InteriorDesign.module.css';
import Paywall from '../components/Paywall';
import PricingBanner from '../components/PricingBanner';
import AuthModal from '../components/AuthModal';
import { uploadTempFile } from '../lib/uploader';
import { getBrowserSupabase } from '../lib/supabase';
import { bumpEntitlement } from '../lib/entitlementBus';
import { maybeCompressImage } from '../lib/imageCompress';

const STYLES = [
  { key: 'modern-minimalist', name: 'Modern Minimalist' },
  { key: 'scandinavian', name: 'Scandinavian' },
  { key: 'industrial-loft', name: 'Industrial Loft' },
  { key: 'bohemian', name: 'Bohemian' },
  { key: 'mid-century-modern', name: 'Mid-Century Modern' },
  { key: 'japandi', name: 'Japandi' },
  { key: 'coastal', name: 'Coastal' },
  { key: 'dark-moody', name: 'Dark Moody' },
];

// Fallback / instant-render copy of the server's STYLE_PRODUCTS map.
// The API response's `products` is the source of truth and overrides
// this — we only show this if the API somehow doesn't return it.
const STYLE_PRODUCTS_FALLBACK = {
  'modern-minimalist': [
    'platform bed frame',
    'linen sofa',
    'arc floor lamp',
    'floating wall shelf',
    'concrete planter',
    'glass dining table',
    'bar stool set',
    'abstract wall art',
  ],
  scandinavian: [
    'light oak coffee table',
    'sheepskin throw',
    'pendant rattan lamp',
    'linen curtains',
    'storage bench',
    'ceramic vase set',
    'wool area rug',
    'wooden wall clock',
  ],
  'industrial-loft': [
    'metal bookshelf',
    'leather sofa',
    'Edison pendant light',
    'pipe clothing rack',
    'metal bar stool',
    'distressed wood dining table',
    'concrete lamp',
    'vintage wall map',
  ],
  bohemian: [
    'macrame wall hanging',
    'rattan chair',
    'floor pouf ottoman',
    'indoor hanging planter',
    'kilim rug',
    'velvet throw pillow set',
    'moroccan lantern',
    'cane side table',
  ],
  'mid-century-modern': [
    'walnut credenza',
    'tulip dining table',
    'egg chair',
    'sunburst mirror',
    'tapered leg sofa',
    'retro floor lamp',
    'teak side table',
    'geometric area rug',
  ],
  japandi: [
    'low platform bed',
    'bamboo floor lamp',
    'linen storage basket',
    'ceramic tea set',
    'neutral wool rug',
    'shoji screen divider',
    'solid wood bench',
    'simple white duvet',
  ],
  coastal: [
    'rattan pendant light',
    'blue stripe throw pillow',
    'whitewashed dresser',
    'jute area rug',
    'sea glass candle set',
    'rope mirror',
    'linen sofa slipcover',
    'driftwood wall art',
  ],
  'dark-moody': [
    'velvet sofa',
    'brass floor lamp',
    'dark linen curtains',
    'antique mirror',
    'forest green accent chair',
    'marble side table',
    'gallery wall frame set',
    'emerald throw blanket',
  ],
};

// Map the input photo's natural width/height to the closest aspect
// ratio kie.ai's Flux Kontext accepts. Sending a ratio that matches
// the input is what stops the model from rotating / re-framing the
// view — feeding it a 4:3 target when the input is 3:4 (phone vertical)
// is what was producing sideways results.
function pickAspectRatio(w, h) {
  if (!w || !h) return '4:3';
  const r = w / h;
  if (r >= 1.55) return '16:9';
  if (r >= 1.2) return '4:3';
  if (r >= 0.85) return '1:1';
  if (r >= 0.65) return '3:4';
  return '9:16';
}

// Read an image file's natural pixel dimensions.
function readImageDimensions(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      try { URL.revokeObjectURL(url); } catch {}
      resolve(dims);
    };
    img.onerror = () => {
      try { URL.revokeObjectURL(url); } catch {}
      resolve({ w: 0, h: 0 });
    };
    img.src = url;
  });
}

function triggerDownload(href, filename) {
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.rel = 'noopener';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {}
}

// Extract a still frame from a video File (client-side). Resolves to
// a { blob, previewUrl } pair. Caller is responsible for revoking
// previewUrl when done.
function extractVideoFrame(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = objectUrl;

    let settled = false;
    const cleanup = () => {
      try { video.removeAttribute('src'); video.load(); } catch {}
      URL.revokeObjectURL(objectUrl);
    };
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    };

    video.addEventListener('error', () => fail('Could not decode video.'));
    video.addEventListener('loadedmetadata', () => {
      // Seek a bit into the clip; for very short videos seek to the
      // middle so we don't try to seek past the end.
      const target = Math.min(1, Math.max(0.05, (video.duration || 1) / 2));
      video.currentTime = target;
    });
    video.addEventListener(
      'seeked',
      () => {
        if (settled) return;
        try {
          const w0 = video.videoWidth || 1280;
          const h0 = video.videoHeight || 720;
          const maxSide = 1280;
          const scale = Math.min(1, maxSide / Math.max(w0, h0));
          const w = Math.round(w0 * scale);
          const h = Math.round(h0 * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, w, h);
          canvas.toBlob(
            (blob) => {
              if (!blob) {
                fail('Could not capture frame.');
                return;
              }
              settled = true;
              cleanup();
              resolve({
                blob,
                previewUrl: URL.createObjectURL(blob),
                width: w,
                height: h,
              });
            },
            'image/png'
          );
        } catch (err) {
          fail(err.message || 'Could not capture frame.');
        }
      },
      { once: true }
    );
  });
}

// Composite the before + after URLs into a 1080x1920 PNG. Both URLs
// must be on the same origin (or CORS-permissive) for canvas readback.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

function drawCover(ctx, img, x, y, w, h) {
  const ir = img.width / img.height;
  const tr = w / h;
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;
  if (ir > tr) {
    // image wider than target — crop sides
    sw = img.height * tr;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / tr;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

async function buildSharePng(beforeUrl, afterUrl) {
  const W = 1080;
  const H = 1920;
  const half = H / 2;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0a0a0c';
  ctx.fillRect(0, 0, W, H);
  const [beforeImg, afterImg] = await Promise.all([
    loadImage(beforeUrl),
    loadImage(afterUrl),
  ]);
  drawCover(ctx, beforeImg, 0, 0, W, half);
  drawCover(ctx, afterImg, 0, half, W, half);
  // Hairline divider so the two halves read as deliberate split.
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, half - 1, W, 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/png'
    );
  });
}

export default function InteriorDesignPage() {
  const fileInputRef = useRef(null);

  const [authUser, setAuthUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);

  const [dragOver, setDragOver] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadedUrl, setUploadedUrl] = useState(null);   // Vercel Blob URL (sent to API)
  const [previewUrl, setPreviewUrl] = useState(null);     // local object URL or http URL for thumbnail
  const [previewName, setPreviewName] = useState('');     // filename label
  const [previewKind, setPreviewKind] = useState(null);   // 'photo' | 'video-frame'

  const [styleKey, setStyleKey] = useState('modern-minimalist');
  const [userPrompt, setUserPrompt] = useState('');
  const [keepFurniture, setKeepFurniture] = useState('blend');
  const [budgetFeel, setBudgetFeel] = useState('mid-range');
  const [aspectRatio, setAspectRatio] = useState('4:3'); // auto-detected on upload

  // step: 'idle' | 'paywall' | 'processing' | 'done'
  const [step, setStep] = useState('idle');
  const [renderedImageUrl, setRenderedImageUrl] = useState(null);
  const [products, setProducts] = useState([]);
  const [credits, setCredits] = useState(null);
  const [error, setError] = useState('');
  const [shareBusy, setShareBusy] = useState(false);

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

  // Fetch image-credit balance once the user is known. Reuses the
  // /api/glow-up GET endpoint since it already exposes the right
  // pool — Interior Design draws from the same imageCreditsRemaining.
  useEffect(() => {
    if (!authUser) {
      setCredits(null);
      return;
    }
    fetch('/api/glow-up')
      .then((r) => r.json().catch(() => null))
      .then((d) => {
        if (d && typeof d.imageCreditsRemaining === 'number') setCredits(d);
      })
      .catch(() => {});
  }, [authUser, step]);

  const clearPreview = () => {
    setUploadedUrl(null);
    setPreviewName('');
    setPreviewKind(null);
    if (previewUrl && previewUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(previewUrl); } catch {}
    }
    setPreviewUrl(null);
  };

  // Revoke local preview URL on unmount.
  useEffect(() => {
    return () => {
      if (previewUrl && previewUrl.startsWith('blob:')) {
        try { URL.revokeObjectURL(previewUrl); } catch {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptFile = async (file) => {
    if (!file) return;
    setError('');
    const isImage = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    if (!isImage && !isVideo) {
      setError('Please upload a photo or video file.');
      return;
    }
    clearPreview();
    setUploadBusy(true);
    try {
      if (isImage) {
        const compressed = await maybeCompressImage(file);
        const dims = await readImageDimensions(compressed);
        const localUrl = URL.createObjectURL(compressed);
        const url = await uploadTempFile(compressed);
        setUploadedUrl(url);
        setPreviewUrl(localUrl);
        setPreviewName(file.name);
        setPreviewKind('photo');
        setAspectRatio(pickAspectRatio(dims.w, dims.h));
      } else {
        const { blob, previewUrl: framePreview, width, height } = await extractVideoFrame(file);
        // Wrap blob in a File so uploader names it sensibly.
        const baseName = (file.name || 'video').replace(/\.[^.]+$/, '');
        const frameFile = new File([blob], `${baseName}-frame.png`, {
          type: 'image/png',
          lastModified: Date.now(),
        });
        const url = await uploadTempFile(frameFile);
        setUploadedUrl(url);
        setPreviewUrl(framePreview);
        setPreviewName(`${file.name} · frame @ 1s`);
        setPreviewKind('video-frame');
        setAspectRatio(pickAspectRatio(width, height));
      }
    } catch (err) {
      setError(err.message || 'Upload failed.');
    } finally {
      setUploadBusy(false);
    }
  };

  const onPick = (e) => {
    const f = e.target.files && e.target.files[0];
    acceptFile(f);
    e.target.value = '';
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    acceptFile(f);
  };

  const handleGenerate = async () => {
    setError('');
    if (!uploadedUrl) {
      setError('Upload a photo or video first.');
      return;
    }
    if (!authUser) {
      setAuthModalOpen(true);
      return;
    }
    if (credits && credits.tier === 'none') {
      setStep('paywall');
      return;
    }
    setStep('processing');
    try {
      const r = await fetch('/api/interior-design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: uploadedUrl,
          style: styleKey,
          userPrompt: userPrompt.trim() || undefined,
          keepFurniture,
          budgetFeel,
          aspectRatio,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status === 402) {
        setStep('paywall');
        return;
      }
      if (!r.ok) throw new Error(data.error || 'Generation failed.');
      if (!data.renderedImageUrl) throw new Error('No image returned.');
      bumpEntitlement();
      setRenderedImageUrl(data.renderedImageUrl);
      setProducts(
        Array.isArray(data.products) && data.products.length > 0
          ? data.products
          : STYLE_PRODUCTS_FALLBACK[styleKey] || []
      );
      setStep('done');
    } catch (err) {
      setError(err.message || 'Something went wrong.');
      setStep('idle');
    }
  };

  const handleShare = async () => {
    if (!previewUrl || !renderedImageUrl) return;
    setShareBusy(true);
    setError('');
    try {
      const blob = await buildSharePng(previewUrl, renderedImageUrl);
      const url = URL.createObjectURL(blob);
      triggerDownload(url, `interior-share-${Date.now()}.png`);
      // Revoke shortly after — give the browser time to start the download.
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch {}
      }, 4000);
    } catch (err) {
      setError(err.message || 'Could not build share image.');
    } finally {
      setShareBusy(false);
    }
  };

  const startOver = () => {
    setRenderedImageUrl(null);
    setProducts([]);
    setStep('idle');
    setError('');
  };

  const canGenerate = !!uploadedUrl && step !== 'processing';

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
      <Head><title>AI Interior Design — Haelabs</title></Head>
      <main className={styles.page}>
        <div className={styles.hero}>
          <span className={styles.eyebrow}>◆ Interior Design</span>
          <h1 className={styles.title}>
            Re-design any room with <span className={styles.titleAccent}>AI</span>
          </h1>
          <p className={styles.subtitle}>
            Upload a photo or video of your room, pick a style, get a photorealistic redesign.
          </p>
        </div>

        {step === 'paywall' ? (
          <>
            <Paywall
              entitlement={credits || null}
              returnTo="/interior-design"
              surface="interior-design"
              onError={(msg) => setError(msg)}
              onTrialStarted={() => setStep('idle')}
            />
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                type="button"
                className={styles.resultBtn}
                onClick={() => setStep('idle')}
              >
                ← Back
              </button>
            </div>
          </>
        ) : step === 'processing' ? (
          <div className={styles.processing}>
            <div className={styles.spinner} aria-hidden="true" />
            <span className={styles.processingLabel}>
              Re-designing your room…
            </span>
            <p className={styles.subtitle} style={{ fontSize: 13 }}>
              Usually 20–60 seconds. Don&apos;t close this tab.
            </p>
          </div>
        ) : step === 'done' && renderedImageUrl ? (
          <>
            <div className={styles.compare}>
              <div className={styles.compareSlot}>
                <span className={styles.compareLabel}>Before</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={previewUrl} alt="Original room" className={styles.compareImg} />
              </div>
              <div className={styles.compareSlot}>
                <span className={styles.compareLabel}>After</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={renderedImageUrl}
                  alt="AI redesigned room"
                  className={styles.compareImg}
                />
              </div>
            </div>

            <div className={styles.resultRow}>
              <a
                href={renderedImageUrl}
                download={`interior-${styleKey}-${Date.now()}.png`}
                target="_blank"
                rel="noopener noreferrer"
                className={`${styles.resultBtn} ${styles.resultBtnPrimary}`}
              >
                ↓ Download
              </a>
              <button
                type="button"
                className={styles.resultBtn}
                onClick={handleShare}
                disabled={shareBusy}
              >
                {shareBusy ? 'Building share image…' : '↗ Share (9:16 PNG)'}
              </button>
              <button type="button" className={styles.resultBtn} onClick={startOver}>
                + New design
              </button>
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.productsHead}>
              <h3 className={styles.productsTitle}>Shop the look</h3>
              <p className={styles.productsSub}>
                Hand-picked pieces that match the {STYLES.find((s) => s.key === styleKey)?.name}{' '}
                aesthetic.
              </p>
            </div>
            <div className={styles.productGrid}>
              {products.map((p) => {
                const q = encodeURIComponent(p);
                const amazonTag = process.env.NEXT_PUBLIC_AMAZON_AFFILIATE_TAG;
                const amazonHref = amazonTag
                  ? `https://www.amazon.com/s?k=${q}&tag=${encodeURIComponent(amazonTag)}`
                  : `https://www.amazon.com/s?k=${q}`;
                return (
                  <div key={p} className={styles.productCard}>
                    <span className={styles.productName}>{p}</span>
                    <div className={styles.productLinks}>
                      <a
                        href={amazonHref}
                        target="_blank"
                        rel="noopener sponsored"
                        className={`${styles.productLink} ${styles.productLinkAmazon}`}
                      >
                        Amazon
                      </a>
                      <a
                        href={`https://www.ikea.com/us/en/search/?q=${q}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${styles.productLink} ${styles.productLinkIkea}`}
                      >
                        IKEA
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
            {process.env.NEXT_PUBLIC_AMAZON_AFFILIATE_TAG && (
              <p
                style={{
                  marginTop: 10,
                  fontSize: 11,
                  color: 'rgba(255,255,255,0.5)',
                  textAlign: 'center',
                  lineHeight: 1.5,
                }}
              >
                As an Amazon Associate we earn from qualifying purchases.
              </p>
            )}

            {credits && typeof credits.imageCreditsRemaining === 'number' && (
              <div className={styles.usage}>
                {(credits.imageCreditsRemaining * 10).toLocaleString()} image credit
                {credits.imageCreditsRemaining === 1 ? '' : 's'} left ·{' '}
                = {credits.imageCreditsRemaining} redesign
                {credits.imageCreditsRemaining === 1 ? '' : 's'}
              </div>
            )}
          </>
        ) : (
          <>
          {credits &&
            (credits.tier === 'monthly' ||
              credits.tier === 'yearly' ||
              credits.tier === 'admin') && (
              <PricingBanner
                lines={[{ label: 'AI Interior redesign', cost: '10 image credits per redesign' }]}
              />
            )}
          <div className={styles.card}>
            {/* 1. Upload */}
            <section className={styles.section}>
              <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>1. Upload a photo or video of your room</h3>
              </div>

              {!previewUrl ? (
                <div
                  className={`${styles.dropZone} ${dragOver ? styles.dropZoneOver : ''}`}
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  onDrop={onDrop}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(true);
                  }}
                  onDragLeave={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDragOver(false);
                  }}
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
                    accept="image/*,video/*"
                    className={styles.dropZoneInput}
                    onChange={onPick}
                  />
                  <div className={styles.dropZoneIcon} aria-hidden="true">📷 / 🎬</div>
                  <div className={styles.dropZoneLabel}>
                    Drag a photo or video here, or click to upload
                  </div>
                  <div className={styles.dropZoneSub}>
                    {uploadBusy ? 'Uploading…' : 'JPG · PNG · WEBP · MP4 · MOV'}
                  </div>
                </div>
              ) : (
                <div className={styles.preview}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrl} alt="Preview" className={styles.previewThumb} />
                  <div className={styles.previewMeta}>
                    <span className={styles.previewName}>{previewName}</span>
                    <span className={styles.previewSub}>
                      {previewKind === 'video-frame' ? 'Frame extracted' : 'Photo'}
                      {uploadBusy ? ' · uploading…' : ' · ready'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className={styles.previewRemove}
                    aria-label="Remove file"
                    onClick={clearPreview}
                  >
                    ×
                  </button>
                </div>
              )}
            </section>

            {/* 2. Style picker */}
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
                    </button>
                  );
                })}
              </div>
            </section>

            {/* 3. Customize (optional) */}
            <details className={styles.customize}>
              <summary>
                <span>Customize</span>
                <span className={styles.customizeChevron} aria-hidden="true">▾</span>
              </summary>
              <div className={styles.customizeBody}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel} htmlFor="userPrompt">
                    Describe what you want (optional)
                  </label>
                  <textarea
                    id="userPrompt"
                    value={userPrompt}
                    onChange={(e) => setUserPrompt(e.target.value.slice(0, 400))}
                    rows={2}
                    maxLength={400}
                    placeholder='e.g. add tall bookshelves on the left wall · keep the window unchanged'
                    className={styles.textarea}
                  />
                </div>
                <div className={styles.selectRow}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="keepFurniture">
                      Keep existing furniture?
                    </label>
                    <select
                      id="keepFurniture"
                      className={styles.select}
                      value={keepFurniture}
                      onChange={(e) => setKeepFurniture(e.target.value)}
                    >
                      <option value="blend">Yes, blend it in</option>
                      <option value="redesign">No, full redesign</option>
                    </select>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor="budgetFeel">
                      Budget feel?
                    </label>
                    <select
                      id="budgetFeel"
                      className={styles.select}
                      value={budgetFeel}
                      onChange={(e) => setBudgetFeel(e.target.value)}
                    >
                      <option value="luxury">Luxury high-end</option>
                      <option value="mid-range">Mid-range</option>
                      <option value="budget-friendly">Budget-friendly</option>
                    </select>
                  </div>
                </div>
              </div>
            </details>

            {error && <div className={styles.error}>{error}</div>}

            <button
              type="button"
              className={styles.cta}
              onClick={handleGenerate}
              disabled={!canGenerate}
            >
              Generate Interior
              <span className={styles.ctaSub}>
                {!uploadedUrl
                  ? 'Upload a photo or video to continue'
                  : `Uses 10 image credits · ${STYLES.find((s) => s.key === styleKey)?.name}`}
              </span>
            </button>

            {credits && typeof credits.imageCreditsRemaining === 'number' && (
              <div className={styles.usage}>
                {(credits.imageCreditsRemaining * 10).toLocaleString()} image credit
                {credits.imageCreditsRemaining === 1 ? '' : 's'} left ·{' '}
                = {credits.imageCreditsRemaining} redesign
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
        redirectTo="/interior-design"
      />
    </>
  );
}
