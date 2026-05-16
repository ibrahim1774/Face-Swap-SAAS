import { useEffect, useState } from 'react';

import styles from './Paywall.module.css';
import TopupRow from './TopupRow';

// Cosmetic credit-display multiplier for image-credit surfaces.
const IMAGE_DISPLAY_MULTIPLIER = 10;
const IMAGE_PERIOD_CAP = 30;

// Video credit caps mirror lib/stripe.js PLANS.{plan}.cap. Base-quality
// short video = 4s × 10cr/s = 40cr (480p silent at the Standard rate).
const PLAN_VIDEO_CAPS = {
  monthly: 760,
  pro: 2280,
  yearly: 3840,
};
const CREDITS_PER_BASE_VIDEO = 40;

// Video-editor pool caps mirror lib/stripe.js PLANS.{plan}.videoEditorCap.
// 30 credits per minute of source video editing.
const PLAN_EDITOR_CAPS = {
  monthly: 1500,
  pro: 4500,
  yearly: 7500,
};
const EDITOR_CREDITS_PER_MIN = 30;

const SURFACE_COPY = {
  video: {
    monthlyName: 'Monthly',
    proName: 'Pro',
    yearlyName: 'Yearly',
    pickHeader: 'Pick a plan',
    pickSubtitle: 'Pick a plan to get started. Cancel anytime.',
    monthlyFeats: [
      'Full access to AI Video generation',
      { videoCredits: true, plan: 'monthly' },
      'Top up anytime for more credits',
      'Cancel anytime',
    ],
    proFeats: [
      { strong: '3× the credits', after: ' of monthly' },
      'Full access to AI Video generation',
      { videoCredits: true, plan: 'pro' },
      'Top up anytime',
      'Cancel anytime',
    ],
    yearlyFeats: [
      { strong: 'Best value', after: ' — biggest credit pool' },
      'Full access to AI Video generation',
      { videoCredits: true, plan: 'yearly' },
      'Top up anytime for more credits',
      'One charge, cancel anytime',
    ],
    bonusLine: 'Access to AI Face Swap included',
    creditsKind: 'video',
  },
  'glow-up': {
    monthlyName: 'Glow Up Monthly Plan',
    proName: 'Glow Up Pro Plan',
    yearlyName: 'Glow Up Yearly Plan',
    pickHeader: 'Pick a Glow Up plan',
    pickSubtitle: 'Premium AI portraits, every month. Cancel anytime.',
    monthlyFeats: [
      'Access to Glow Up AI portraits',
      { credits: true },
      'All 4 styles: Professional, Casual, Glow Up, SOAR',
      'Customize each shot with your own prompt + edit any result',
      'Top up anytime',
      'Cancel anytime',
    ],
    proFeats: [
      { strong: '3× the credits', after: ' of monthly' },
      'Access to Glow Up AI portraits',
      { credits: true },
      'Customize each shot with your own prompt + edit any result',
      'Top up anytime',
    ],
    yearlyFeats: [
      { strong: 'Best value', after: ' — biggest credit pool' },
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
    proName: 'AI Interior Pro Plan',
    yearlyName: 'AI Interior Yearly Plan',
    pickHeader: 'Pick an AI Interior plan',
    pickSubtitle: 'Photorealistic room redesigns, every month. Cancel anytime.',
    monthlyFeats: [
      'Access to AI Interior Design',
      { credits: true },
      'All 8 styles (Modern Minimalist · Scandinavian · Industrial Loft · Bohemian · Mid-Century · Japandi · Coastal · Dark Moody)',
      'Customize each design',
      'Cancel anytime',
    ],
    proFeats: [
      { strong: '3× the credits', after: ' of monthly' },
      'Access to AI Interior Design',
      { credits: true },
      'Customize each design',
    ],
    yearlyFeats: [
      { strong: 'Best value', after: ' — biggest credit pool' },
      'Access to AI Interior Design',
      { credits: true },
      'Customize each design',
      'One charge, cancel anytime',
    ],
    bonusLine: 'Access to every other Haelabs AI tool included',
    creditsKind: 'image',
    imageNoun: 'redesigns',
  },
  'video-editor': {
    monthlyName: 'Video Editor Monthly',
    proName: 'Video Editor Pro',
    yearlyName: 'Video Editor Yearly',
    pickHeader: 'Pick a plan to edit your video',
    pickSubtitle: 'AI auto-editor: filler-removal, silence trim, more coming soon. Cancel anytime.',
    monthlyFeats: [
      { editorCredits: true, plan: 'monthly' },
      'Auto-removes filler words ("um", "uh", "er", "ah")',
      'Trims long silences (0.5s+ pauses)',
      'Single-pass FFmpeg render — no quality loss',
      'Top up anytime for more editor credits',
      'Cancel anytime',
    ],
    proFeats: [
      { editorCredits: true, plan: 'pro' },
      'Everything in Monthly',
      'Auto-removes filler words ("um", "uh", "er", "ah")',
      'Trims long silences (0.5s+ pauses)',
      'Top up anytime for more editor credits',
      'Cancel anytime',
    ],
    yearlyFeats: [
      { editorCredits: true, plan: 'yearly' },
      'Auto-removes filler words ("um", "uh", "er", "ah")',
      'Trims long silences (0.5s+ pauses)',
      'Single-pass FFmpeg render — no quality loss',
      'Top up anytime for more editor credits',
      'One charge, cancel anytime',
    ],
    creditsKind: 'video-editor',
  },
};

function ImageCreditsLine({ multiplier, cap, noun, infoOpen, setInfoOpen }) {
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

function VideoCreditsLine({ plan, infoOpen, setInfoOpen }) {
  const cap = PLAN_VIDEO_CAPS[plan] || 0;
  const videosAtBase = Math.floor(cap / CREDITS_PER_BASE_VIDEO);
  return (
    <>
      <strong>{cap.toLocaleString()} video credits</strong> per period
      {' '}
      <button
        type="button"
        className={styles.infoBtn}
        aria-label={`approximately ${videosAtBase} short videos at the base level`}
        onClick={() => setInfoOpen((v) => !v)}
      >
        ⓘ
      </button>
      {infoOpen && (
        <span className={styles.infoTip}>
          <strong>~{videosAtBase} short videos</strong> at the base level. Higher quality (longer, HD, with audio) costs more credits.
        </span>
      )}
    </>
  );
}

function EditorMinutesLine({ plan, infoOpen, setInfoOpen }) {
  const cap = PLAN_EDITOR_CAPS[plan] || 0;
  const minutes = Math.floor(cap / EDITOR_CREDITS_PER_MIN);
  const period = plan === 'yearly' ? 'per year' : 'per month';
  return (
    <>
      <strong>
        {minutes.toLocaleString()} min of AI auto-editing
      </strong>{' '}
      {period}
      {' '}
      <button
        type="button"
        className={styles.infoBtn}
        aria-label={`${cap.toLocaleString()} editor credits — 30 cr per minute of source video`}
        onClick={() => setInfoOpen((v) => !v)}
      >
        ⓘ
      </button>
      {infoOpen && (
        <span className={styles.infoTip}>
          <strong>{cap.toLocaleString()} editor credits</strong> {period} · 30 credits = 1 minute of source video.
        </span>
      )}
    </>
  );
}

function EditorCreditsLine({ plan, infoOpen, setInfoOpen }) {
  const cap = PLAN_EDITOR_CAPS[plan] || 0;
  const minutes = Math.floor(cap / EDITOR_CREDITS_PER_MIN);
  const period = plan === 'yearly' ? 'per year' : 'per month';
  return (
    <>
      <strong>{cap.toLocaleString()} editor credits</strong> {period}
      {' '}
      <button
        type="button"
        className={styles.infoBtn}
        aria-label={`approximately ${minutes} minutes of source video — 30 credits per minute`}
        onClick={() => setInfoOpen((v) => !v)}
      >
        ⓘ
      </button>
      {infoOpen && (
        <span className={styles.infoTip}>
          <strong>30 credits = 1 minute</strong> of source video. {cap.toLocaleString()} credits ≈ {minutes.toLocaleString()} minutes of footage you can auto-edit {period}.
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
        <ImageCreditsLine
          multiplier={IMAGE_DISPLAY_MULTIPLIER}
          cap={IMAGE_PERIOD_CAP}
          noun={copy.imageNoun || 'images'}
          infoOpen={infoOpen}
          setInfoOpen={setInfoOpen}
        />
      </li>
    );
  }
  if (entry && entry.videoCredits) {
    return (
      <li>
        <VideoCreditsLine
          plan={entry.plan}
          infoOpen={infoOpen}
          setInfoOpen={setInfoOpen}
        />
      </li>
    );
  }
  if (entry && entry.editorMinutes) {
    return (
      <li>
        <EditorMinutesLine
          plan={entry.plan}
          infoOpen={infoOpen}
          setInfoOpen={setInfoOpen}
        />
      </li>
    );
  }
  if (entry && entry.editorCredits) {
    return (
      <li>
        <EditorCreditsLine
          plan={entry.plan}
          infoOpen={infoOpen}
          setInfoOpen={setInfoOpen}
        />
      </li>
    );
  }
  return null;
}

function PlanCard({
  planKey,
  name,
  price,
  period,
  feats,
  bonusLine,
  bonusHighlight,
  copy,
  infoOpen,
  setInfoOpen,
  busy,
  onSubscribe,
  isTrialing,
  featured,
  badge,
  btnClass,
  ctaPrefix,
}) {
  return (
    <article className={`${styles.tier} ${featured ? styles.tierFeatured : ''}`}>
      {badge && <div className={styles.tierBadge}>{badge}</div>}
      <div className={styles.tierHead}>
        <h3 className={styles.tierName}>{name}</h3>
        <div className={styles.price}>
          <span className={styles.amount}>${price}</span>
          <span className={styles.period}>/ {period}</span>
        </div>
      </div>
      {bonusHighlight && (
        <div className={styles.bonusBanner}>
          <div className={styles.bonusBannerHeadline}>
            +{bonusHighlight.extra.toLocaleString()} bonus credits
          </div>
          <div className={styles.bonusBannerSub}>{bonusHighlight.sub}</div>
        </div>
      )}
      <ul className={styles.feats}>
        {feats.map((entry, i) => (
          <Feat
            key={i}
            entry={entry}
            copy={copy}
            infoOpen={infoOpen}
            setInfoOpen={setInfoOpen}
          />
        ))}
        {bonusLine && (
          <li className={styles.featBonus}>
            <span className={styles.bonusTag}>Bonus</span>
            {bonusLine}
          </li>
        )}
      </ul>
      <button
        type="button"
        className={`${styles.btn} ${btnClass}`}
        onClick={() => onSubscribe(planKey)}
        disabled={busy !== null}
      >
        {busy === planKey
          ? 'Redirecting…'
          : `${ctaPrefix} → $${price}/${period === 'year' ? 'yr' : 'mo'}`}
      </button>
    </article>
  );
}

export default function Paywall({
  entitlement,
  onTrialStarted,
  onError,
  returnTo,
  surface = 'video',
}) {
  const [busy, setBusy] = useState(null);
  const [localError, setLocalError] = useState('');
  const [trialBlocked, setTrialBlocked] = useState(false);
  const [infoOpenMonthly, setInfoOpenMonthly] = useState(false);
  const [infoOpenPro, setInfoOpenPro] = useState(false);
  const [infoOpenYearly, setInfoOpenYearly] = useState(false);

  const copy = SURFACE_COPY[surface] || SURFACE_COPY.video;

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

  // `content` lets the caller pass a TikTok content_id + content_name
  // so TikTok's "Content ID is missing" diagnostic stays clear.
  const firePixel = (meta, content) => {
    if (!meta?.eventId) return;
    if (typeof window === 'undefined') return;
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
        window.fbq(
          'track',
          meta.eventName || 'InitiateCheckout',
          baseParams,
          { eventID: meta.eventId }
        );
      } catch {}
    }
    if (window.ttq && typeof window.ttq.track === 'function') {
      try {
        // TikTok funnel: AddToCart precedes InitiateCheckout. Fire both
        // here at click-time with the same eventId — TikTok dedupes
        // per (event_name, event_id) so distinct names with the same
        // id co-exist.
        window.ttq.track('AddToCart', ttParams, { event_id: meta.eventId });
        window.ttq.track(
          meta.eventName || 'InitiateCheckout',
          ttParams,
          { event_id: meta.eventId }
        );
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
    entitlement &&
    (entitlement.tier === 'monthly' ||
      entitlement.tier === 'pro' ||
      entitlement.tier === 'yearly');
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
              ? 'Buy a top-up pack to keep going during your trial, or convert to a monthly/pro/yearly plan below.'
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
            Your plan will start charging immediately — redirecting to checkout&hellip;
          </div>
        )}

        {showPlans && (
          <div className={styles.tiersThree}>
            <PlanCard
              planKey="monthly"
              name={copy.monthlyName}
              price={5}
              period="month"
              feats={copy.monthlyFeats}
              bonusLine={copy.bonusLine}
              copy={copy}
              infoOpen={infoOpenMonthly}
              setInfoOpen={setInfoOpenMonthly}
              busy={busy}
              onSubscribe={startCheckout}
              isTrialing={isTrialing}
              btnClass={styles.btnPrimary}
              ctaPrefix={isTrialing ? 'Convert to monthly' : 'Subscribe'}
            />
            <PlanCard
              planKey="pro"
              name={copy.proName}
              price={9}
              period="month"
              feats={copy.proFeats}
              bonusLine={copy.bonusLine}
              bonusHighlight={
                copy.creditsKind === 'video'
                  ? {
                      extra: PLAN_VIDEO_CAPS.pro - PLAN_VIDEO_CAPS.monthly,
                      sub: '3× the credits of Monthly — just $4 more',
                    }
                  : copy.creditsKind === 'video-editor'
                  ? {
                      extra: PLAN_EDITOR_CAPS.pro - PLAN_EDITOR_CAPS.monthly,
                      sub: '3× the credits of Monthly — just $4 more',
                    }
                  : null
              }
              copy={copy}
              infoOpen={infoOpenPro}
              setInfoOpen={setInfoOpenPro}
              busy={busy}
              onSubscribe={startCheckout}
              isTrialing={isTrialing}
              featured
              btnClass={styles.btnAccent}
              ctaPrefix={isTrialing ? 'Convert to Pro' : 'Subscribe'}
            />
            <PlanCard
              planKey="yearly"
              name={copy.yearlyName}
              price={29}
              period="year"
              feats={copy.yearlyFeats}
              bonusLine={copy.bonusLine}
              bonusHighlight={
                copy.creditsKind === 'video'
                  ? {
                      extra: PLAN_VIDEO_CAPS.yearly - PLAN_VIDEO_CAPS.monthly,
                      sub: '5× the credits of Monthly — best annual value',
                    }
                  : copy.creditsKind === 'video-editor'
                  ? {
                      extra: PLAN_EDITOR_CAPS.yearly - PLAN_EDITOR_CAPS.monthly,
                      sub: '5× the credits of Monthly — best annual value',
                    }
                  : null
              }
              copy={copy}
              infoOpen={infoOpenYearly}
              setInfoOpen={setInfoOpenYearly}
              busy={busy}
              onSubscribe={startCheckout}
              isTrialing={isTrialing}
              btnClass={styles.btnPrimary}
              ctaPrefix="Subscribe"
            />
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
