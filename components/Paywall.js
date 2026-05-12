import { useEffect, useState } from 'react';

import styles from './Paywall.module.css';
import TopupRow from './TopupRow';

// Cosmetic credit-display multiplier for image-credit surfaces.
// Internally 1 image = 1 credit (Stripe metadata, /api/glow-up,
// /api/interior-design); on image-feature paywalls we display the
// number multiplied by this so plans / packs feel more substantial.
// The info icon next to the inflated number always reveals the real
// image count.
const IMAGE_DISPLAY_MULTIPLIER = 10;

// Image-credit allowance per period. Keep in sync with
// CREDITS_PER_PERIOD in /api/glow-up.js and /api/interior-design.js.
const IMAGE_PERIOD_CAP = 30;

const SURFACE_COPY = {
  video: {
    monthlyName: 'Monthly',
    yearlyName: 'Yearly',
    pickHeader: 'Pick a plan',
    pickSubtitle: 'Pick a plan to get started. Cancel anytime.',
    monthlyFeats: [
      'Full access to AI Video generation',
      'Includes credits to start creating immediately',
      'Top up anytime for more credits',
      'Cancel anytime',
    ],
    yearlyFeats: [
      { strong: 'Save 50%', after: ' vs paying monthly ($60/yr)' },
      'Full access to AI Video generation',
      'Includes credits to start creating immediately',
      'One charge, cancel anytime',
    ],
    bonusLine: 'Access to AI Face Swap included',
    creditsKind: 'video',
  },
  'glow-up': {
    monthlyName: 'Glow Up Monthly Plan',
    yearlyName: 'Glow Up Yearly Plan',
    pickHeader: 'Pick a Glow Up plan',
    pickSubtitle: 'Premium AI portraits, every month. Cancel anytime.',
    monthlyFeats: [
      'Access to Glow Up AI portraits',
      { credits: true }, // injected with inflated count + info icon
      'All 4 styles: Professional, Casual, Glow Up, SOAR',
      'Customize each shot with your own prompt + edit any result',
      'Top up anytime',
      'Cancel anytime',
    ],
    yearlyFeats: [
      { strong: 'Save 50%', after: ' vs paying monthly ($60/yr)' },
      'Access to Glow Up AI portraits',
      { credits: true },
      'Customize each shot with your own prompt + edit any result',
      'One charge, cancel anytime',
    ],
    bonusLine: 'Access to every other Haelabs AI tool included',
    creditsKind: 'image',
    imageNoun: 'images',
  },
  'interior-design': {
    monthlyName: 'AI Interior Monthly Plan',
    yearlyName: 'AI Interior Yearly Plan',
    pickHeader: 'Pick an AI Interior plan',
    pickSubtitle:
      'Photorealistic room redesigns, every month. Cancel anytime.',
    monthlyFeats: [
      'Access to AI Interior Design',
      { credits: true },
      'All 8 styles (Modern Minimalist · Scandinavian · Industrial Loft · Bohemian · Mid-Century · Japandi · Coastal · Dark Moody)',
      'Customize each design',
      'Cancel anytime',
    ],
    yearlyFeats: [
      { strong: 'Save 50%', after: ' vs paying monthly ($60/yr)' },
      'Access to AI Interior Design',
      { credits: true },
      'Customize each design',
      'One charge, cancel anytime',
    ],
    bonusLine: 'Access to every other Haelabs AI tool included',
    creditsKind: 'image',
    imageNoun: 'redesigns',
  },
};

function CreditsLine({ multiplier, cap, noun, infoOpen, setInfoOpen }) {
  const inflated = cap * multiplier;
  return (
    <>
      <strong>{inflated.toLocaleString()} image credits</strong> per month
      {' '}
      <button
        type="button"
        className={styles.infoBtn}
        aria-label={`= ${cap} ${noun} per month`}
        onClick={() => setInfoOpen((v) => !v)}
      >
        ⓘ
      </button>
      {infoOpen && (
        <span className={styles.infoTip}>
          1 {noun.replace(/s$/, '')} = {multiplier} credits · {cap} {noun} included
        </span>
      )}
    </>
  );
}

function Feat({ entry, copy, infoOpen, setInfoOpen }) {
  if (typeof entry === 'string') return <li>{entry}</li>;
  if (entry && entry.strong) {
    return (
      <li>
        <strong>{entry.strong}</strong>
        {entry.after}
      </li>
    );
  }
  if (entry && entry.credits) {
    return (
      <li>
        <CreditsLine
          multiplier={IMAGE_DISPLAY_MULTIPLIER}
          cap={IMAGE_PERIOD_CAP}
          noun={copy.imageNoun || 'images'}
          infoOpen={infoOpen}
          setInfoOpen={setInfoOpen}
        />
      </li>
    );
  }
  return null;
}

export default function Paywall({
  entitlement,
  onTrialStarted,
  onError,
  returnTo,
  surface = 'video',
}) {
  const [busy, setBusy] = useState(null); // 'monthly' | 'yearly' | 's' | 'm' | 'l'
  const [localError, setLocalError] = useState('');
  const [trialBlocked, setTrialBlocked] = useState(false);
  const [infoOpenMonthly, setInfoOpenMonthly] = useState(false);
  const [infoOpenYearly, setInfoOpenYearly] = useState(false);

  const copy = SURFACE_COPY[surface] || SURFACE_COPY.video;

  // After redirecting to Stripe, the user may hit Back to return here.
  // Modern browsers restore the page from BFCache without re-running
  // useEffect or remounting, so the `busy` state stays set and the
  // button keeps saying "Redirecting…". The pageshow event fires on
  // BFCache restore (event.persisted === true) — we use it to reset
  // the transient state to its initial values.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onPageShow = (e) => {
      if (e.persisted) {
        setBusy(null);
        setTrialBlocked(false);
        setLocalError('');
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  // Fire the browser pixel for InitiateCheckout if the API returned
  // matching meta. Same eventID as the server CAPI call dedupes them.
  // `content` lets the caller pass a TikTok content_id + content_name
  // so TikTok's "Content ID is missing" diagnostic stays clear.
  const firePixel = (meta, content) => {
    if (!meta?.eventId) return;
    if (typeof window === 'undefined') return;
    const name = meta.eventName || 'InitiateCheckout';
    const baseParams = { value: meta.value, currency: meta.currency || 'USD' };
    const id = content?.content_id || 'subscription';
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
  };

  const startCheckout = async (plan) => {
    if (busy) return;
    setBusy(plan);
    setLocalError('');
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan, returnTo, surface }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Could not start checkout.');
      }
      firePixel(data.meta, {
        content_id: `plan-${plan}`,
        content_name: `${plan} subscription`,
      });
      if (data.trialBlocked) {
        setTrialBlocked(true);
        // Delay the redirect so the user sees the note before Stripe loads.
        setTimeout(() => { window.location.href = data.url; }, 1500);
        return;
      }
      window.location.href = data.url;
    } catch (err) {
      setLocalError(err.message);
      onError && onError(err.message);
      setBusy(null);
    }
  };

  const isSubscriber =
    entitlement && (entitlement.tier === 'monthly' || entitlement.tier === 'yearly');
  const isTrialing = entitlement && entitlement.status === 'trialing';
  const showTopups = isSubscriber;
  const showPlans = !isSubscriber || isTrialing;

  return (
    <section className={styles.wrap}>
      <div className={styles.card}>
        <header className={styles.header}>
          <span className={styles.kicker}>◆ Pricing</span>
          <h2 className={styles.title}>
            {isTrialing
              ? 'Add more credits or upgrade'
              : showTopups
                ? 'Need more credits?'
                : copy.pickHeader}
          </h2>
          <p className={styles.subtitle}>
            {isTrialing
              ? 'Buy a top-up pack to keep going during your trial, or convert to a monthly/yearly plan below.'
              : showTopups
                ? 'Buy a top-up pack. Credits never expire and stack on your plan.'
                : copy.pickSubtitle}
          </p>
        </header>

        {trialBlocked && (
          <div
            style={{
              margin: '12px 0',
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid rgba(255, 255, 255,0.35)',
              background: 'rgba(255, 255, 255,0.08)',
              color: '#e6e6e6',
              fontSize: 13,
              lineHeight: 1.5,
              textAlign: 'center',
            }}
          >
            Looks like someone on this network already used the free trial.
            Your plan will start charging immediately — redirecting to
            checkout&hellip;
          </div>
        )}

        {showPlans && (
          <div className={styles.tiersTwo}>
            <article className={styles.tier}>
              <div className={styles.tierHead}>
                <h3 className={styles.tierName}>{copy.monthlyName}</h3>
                <div className={styles.price}>
                  <span className={styles.amount}>$5</span>
                  <span className={styles.period}>/ month</span>
                </div>
              </div>
              <ul className={styles.feats}>
                {copy.monthlyFeats.map((entry, i) => (
                  <Feat
                    key={i}
                    entry={entry}
                    copy={copy}
                    infoOpen={infoOpenMonthly}
                    setInfoOpen={setInfoOpenMonthly}
                  />
                ))}
                {copy.bonusLine && (
                  <li className={styles.featBonus}>
                    <span className={styles.bonusTag}>Bonus</span>
                    {copy.bonusLine}
                  </li>
                )}
              </ul>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => startCheckout('monthly')}
                disabled={busy !== null}
              >
                {busy === 'monthly'
                  ? 'Redirecting…'
                  : isTrialing
                    ? 'Convert to monthly → $5/mo'
                    : 'Subscribe → $5/mo'}
              </button>
            </article>

            <article className={`${styles.tier} ${styles.tierFeatured}`}>
              <div className={styles.tierBadge}>
                Save 50% &middot; Best value
              </div>
              <div className={styles.tierHead}>
                <h3 className={styles.tierName}>{copy.yearlyName}</h3>
                <div className={styles.price}>
                  <span className={styles.amount}>$29</span>
                  <span className={styles.period}>/ year</span>
                </div>
              </div>
              <ul className={styles.feats}>
                {copy.yearlyFeats.map((entry, i) => (
                  <Feat
                    key={i}
                    entry={entry}
                    copy={copy}
                    infoOpen={infoOpenYearly}
                    setInfoOpen={setInfoOpenYearly}
                  />
                ))}
                {copy.bonusLine && (
                  <li className={styles.featBonus}>
                    <span className={styles.bonusTag}>Bonus</span>
                    {copy.bonusLine}
                  </li>
                )}
              </ul>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnAccent}`}
                onClick={() => startCheckout('yearly')}
                disabled={busy !== null}
              >
                {busy === 'yearly'
                  ? 'Redirecting…'
                  : 'Subscribe → $29/yr'}
              </button>
            </article>
          </div>
        )}

        {showTopups && (
          <TopupRow
            returnTo={returnTo}
            onError={onError}
            onLocalError={setLocalError}
            surface={surface}
          />
        )}

        {localError && <div className={styles.error}>{localError}</div>}

        <footer className={styles.footer}>
          <span>◆ Card required</span>
          <span>◆ Powered by Stripe</span>
          <span>
            ◆ {showTopups ? 'Top-up credits never expire' : 'Cancel anytime'}
          </span>
        </footer>
      </div>
    </section>
  );
}
