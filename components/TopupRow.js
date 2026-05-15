import { useEffect, useState } from 'react';

import paywallStyles from './Paywall.module.css';

/*
 * Top-up packs (one-time credit purchases). Two clearly-labeled groups:
 *   - Video credits — for face-swap / UGC / image-to-video
 *   - Image credits — for Glow Up and any future image features
 *
 * The two pools never mix; pricing/credit-counts are configured in
 * lib/stripe.js (TOPUPS map, with `kind: 'video' | 'image'`).
 *
 * Used by:
 *   - components/Paywall.js — when a subscriber's credits hit zero
 *   - pages/dashboard — for active subscribers who want to pre-load more
 *
 * Image-credit display inflation: when the host paywall is an image-
 * feature surface ('glow-up' or 'interior-design'), the image-pack
 * credit counts render multiplied by IMAGE_DISPLAY_MULTIPLIER and a
 * "(= N images)" sub-line shows the literal allowance. Internal Stripe
 * accounting is unchanged — purchases still grant the literal counts.
 */

const IMAGE_DISPLAY_MULTIPLIER = 10;

const VIDEO_PACKS = [
  { pack: 's', label: '$15', credits: 2280 },
  { pack: 'm', label: '$50', credits: 7600 },
  { pack: 'l', label: '$100', credits: 15200 },
];

const IMAGE_PACKS = [
  { pack: 'image-s', label: '$5', credits: 50 },
  { pack: 'image-m', label: '$15', credits: 200 },
  { pack: 'image-l', label: '$30', credits: 500 },
];

const IMAGE_NOUNS = {
  'glow-up': 'images',
  'interior-design': 'redesigns',
};

function firePixel(meta, content) {
  if (!meta?.eventId) return;
  if (typeof window === 'undefined') return;
  const name = meta.eventName || 'InitiateCheckout';
  const baseParams = { value: meta.value, currency: meta.currency || 'USD' };
  const id = content?.content_id || 'topup';
  const displayName = content?.content_name || id;
  const ttParams = {
    ...baseParams,
    contents: [
      { content_id: id, content_type: 'product', content_name: displayName },
    ],
    content_type: 'product',
  };
  if (typeof window.fbq === 'function') {
    try {
      window.fbq('track', name, baseParams, { eventID: meta.eventId });
    } catch {}
  }
  if (window.ttq && typeof window.ttq.track === 'function') {
    try {
      // TikTok funnel: AddToCart precedes InitiateCheckout. Fire both
      // here at click-time with the same eventId — TikTok dedupes
      // per (event_name, event_id) so distinct names with the same
      // id co-exist.
      window.ttq.track('AddToCart', ttParams, { event_id: meta.eventId });
      window.ttq.track(name, ttParams, { event_id: meta.eventId });
    } catch {}
  }
}

export default function TopupRow({
  returnTo = '/dashboard',
  onError,
  onLocalError,
  surface = 'video',
}) {
  const inflateImage = surface === 'glow-up' || surface === 'interior-design';
  const imageNoun = IMAGE_NOUNS[surface] || 'images';
  const [busy, setBusy] = useState(null);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPageShow = (e) => {
      if (e.persisted) {
        setBusy(null);
        setLocalError('');
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const startTopup = async (pack) => {
    if (busy) return;
    setBusy(pack);
    setLocalError('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'topup', pack, returnTo }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Could not start checkout.');
      }
      firePixel(data.meta, {
        content_id: `topup-${pack}`,
        content_name: `topup ${pack}`,
      });
      window.location.href = data.url;
    } catch (err) {
      setLocalError(err.message);
      onError && onError(err.message);
      onLocalError && onLocalError(err.message);
      setBusy(null);
    }
  };

  const renderRow = (heading, packs, creditLabel, inflate, subNoun) => (
    <>
      <div className={paywallStyles.topupGroupHead}>
        <span className={paywallStyles.topupGroupTitle}>{heading}</span>
      </div>
      <div className={paywallStyles.topupRow}>
        {packs.map((t) => {
          const display = inflate ? t.credits * IMAGE_DISPLAY_MULTIPLIER : t.credits;
          return (
            <button
              key={t.pack}
              type="button"
              className={paywallStyles.topupBtn}
              onClick={() => startTopup(t.pack)}
              disabled={busy !== null}
            >
              <span className={paywallStyles.topupPrice}>{t.label}</span>
              <span className={paywallStyles.topupCredits}>
                {busy === t.pack
                  ? 'Redirecting…'
                  : `${display.toLocaleString()} ${creditLabel}`}
              </span>
              {inflate && (
                <span
                  className={paywallStyles.topupCredits}
                  style={{ opacity: 0.7, marginTop: 2 }}
                >
                  = {t.credits} {subNoun}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );

  return (
    <>
      {renderRow('Video credits', VIDEO_PACKS, 'video credits', false)}
      {renderRow('Image credits', IMAGE_PACKS, 'image credits', inflateImage, imageNoun)}
      {localError && (
        <div className={paywallStyles.error} style={{ marginTop: 12 }}>
          {localError}
        </div>
      )}
    </>
  );
}
