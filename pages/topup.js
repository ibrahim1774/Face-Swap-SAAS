import { useCallback, useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';

import paywallStyles from '../components/Paywall.module.css';
import TopupRow from '../components/TopupRow';
import Paywall from '../components/Paywall';
import { getBrowserSupabase } from '../lib/supabase';
import { subscribeEntitlement } from '../lib/entitlementBus';

/*
 * Dedicated top-up page.
 *
 *   - Anon → redirect to /sign-in (middleware) or 'Sign in to buy'
 *   - Authed without active sub → show top-up packs (preview) PLUS
 *     a "subscribe first" notice and the full Paywall below.
 *     Clicking a top-up button without a sub hits /api/checkout and
 *     gets a 401; the TopupRow surfaces that as an inline error.
 *   - Authed with active sub → balances at top, top-up packs, no
 *     Paywall.
 *
 * The TopupRow component is reused from /dashboard and the inline
 * Paywall, so pack pricing and Stripe wiring stay in one place.
 */
export default function TopupPage() {
  const [user, setUser] = useState(null);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [entitlement, setEntitlement] = useState(null);
  const [imageBalance, setImageBalance] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setAuthLoaded(true);
      return undefined;
    }
    supabase.auth.getUser().then(({ data }) => {
      setUser(data?.user || null);
      setAuthLoaded(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user || null);
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  const fetchEntitlement = useCallback(async () => {
    try {
      const r = await fetch('/api/entitlement');
      if (!r.ok) return;
      const d = await r.json();
      setEntitlement(d);
    } catch (err) {
      setError(err.message || 'Could not load credit balance.');
    }
  }, []);

  const fetchImageBalance = useCallback(async () => {
    try {
      const r = await fetch('/api/glow-up');
      if (!r.ok) return;
      const d = await r.json();
      if (d && typeof d.imageCreditsRemaining === 'number') setImageBalance(d);
    } catch {}
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    fetchEntitlement();
    fetchImageBalance();
    const unsub = subscribeEntitlement(() => {
      fetchEntitlement();
      fetchImageBalance();
    });
    return unsub;
  }, [user, fetchEntitlement, fetchImageBalance]);

  if (!authLoaded) {
    return (
      <main style={pageStyle}>
        <p style={subtitleStyle}>Loading…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <>
        <Head><title>Top up credits — Haelabs</title></Head>
        <main style={pageStyle}>
          <div style={heroStyle}>
            <span style={eyebrowStyle}>◆ Top up</span>
            <h1 style={titleStyle}>Sign in to buy credits</h1>
            <p style={subtitleStyle}>
              You need an account before you can purchase credits.
            </p>
            <Link href="/sign-in" style={linkBtnStyle}>Sign in →</Link>
          </div>
        </main>
      </>
    );
  }

  const isSubscriber =
    entitlement &&
    (entitlement.tier === 'monthly' ||
      entitlement.tier === 'pro' ||
      entitlement.tier === 'yearly' ||
      entitlement.tier === 'admin');

  const videoCreditsRemaining = entitlement?.creditsRemaining ?? 0;
  const imageCreditsRemainingInternal = imageBalance?.imageCreditsRemaining ?? 0;
  const imageCreditsDisplay = imageCreditsRemainingInternal * 10;

  return (
    <>
      <Head><title>Top up credits — Haelabs</title></Head>
      <main style={pageStyle}>
        <div style={heroStyle}>
          <span style={eyebrowStyle}>◆ Top up</span>
          <h1 style={titleStyle}>
            {isSubscriber ? 'Buy more credits' : 'Top-up credit packs'}
          </h1>
          <p style={subtitleStyle}>
            {isSubscriber
              ? 'Credits never expire and stack on your plan’s monthly allowance.'
              : 'Preview the top-up packs below. Top-ups stack on an active subscription — start a plan further down to enable them.'}
          </p>
        </div>

        <section className={paywallStyles.card} style={cardOverride}>
          {isSubscriber && (
            <div style={balancesStyle}>
              <div style={balanceItemStyle}>
                <span style={balanceLabelStyle}>Video credits</span>
                <span style={balanceValueStyle}>{videoCreditsRemaining}</span>
                <span style={balanceSubStyle}>
                  Face Swap · UGC · Image-to-Video
                </span>
              </div>
              <div style={balanceItemStyle}>
                <span style={balanceLabelStyle}>Image credits</span>
                <span style={balanceValueStyle}>
                  {imageCreditsDisplay.toLocaleString()}
                </span>
                <span style={balanceSubStyle}>
                  = {imageCreditsRemainingInternal} images · Glow Up · AI Interior
                </span>
              </div>
            </div>
          )}

          {!isSubscriber && (
            <div style={subscribeNoticeStyle}>
              ◆ Top-up purchases require an active subscription. Start a plan
              below first, then come back any time to add more credits.
            </div>
          )}

          <TopupRow returnTo="/topup" onError={(msg) => setError(msg)} />

          {error && <div className={paywallStyles.error}>{error}</div>}

          {isSubscriber && (
            <footer style={footerStyle}>
              <Link href="/dashboard" style={smallLinkStyle}>← Back to dashboard</Link>
            </footer>
          )}
        </section>

        {!isSubscriber && (
          <div style={{ marginTop: 32 }}>
            <Paywall
              entitlement={entitlement}
              returnTo="/topup"
              onError={(msg) => setError(msg)}
              onTrialStarted={() => fetchEntitlement()}
            />
          </div>
        )}
      </main>
    </>
  );
}

const pageStyle = {
  maxWidth: 980,
  margin: '0 auto',
  padding: '32px 20px 80px',
  color: 'var(--text, #ededed)',
};

const heroStyle = {
  textAlign: 'center',
  marginBottom: 24,
};

const eyebrowStyle = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  letterSpacing: '0.18em',
  textTransform: 'uppercase',
  color: 'var(--text-dim, #b8b6b1)',
};

const titleStyle = {
  margin: '6px 0 6px',
  fontFamily: 'var(--font-display, Georgia, serif)',
  fontSize: 'clamp(24px, 3.6vw, 32px)',
  letterSpacing: '-0.01em',
  fontWeight: 600,
  lineHeight: 1.15,
};

const subtitleStyle = {
  margin: '0 auto',
  maxWidth: 600,
  color: 'var(--text-dim, #b8b6b1)',
  fontSize: 14,
  lineHeight: 1.5,
};

const cardOverride = {
  background: '#f7f1e8',
  color: '#2a241b',
};

const balancesStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 12,
  marginBottom: 18,
};

const balanceItemStyle = {
  background: '#fffaf1',
  border: '1px solid rgba(139, 115, 64, 0.22)',
  borderRadius: 10,
  padding: '14px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const balanceLabelStyle = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: '#6b6052',
};

const balanceValueStyle = {
  fontFamily: 'var(--font-display, Georgia, serif)',
  fontSize: 28,
  fontWeight: 700,
  color: '#1c170f',
  letterSpacing: '-0.01em',
};

const balanceSubStyle = {
  fontSize: 12,
  color: '#5e554a',
};

const subscribeNoticeStyle = {
  padding: '12px 14px',
  marginBottom: 16,
  borderRadius: 10,
  border: '1px solid rgba(139, 115, 64, 0.32)',
  background: 'rgba(224, 196, 136, 0.18)',
  color: '#3a2c0f',
  fontSize: 13,
  lineHeight: 1.5,
  textAlign: 'center',
};

const footerStyle = {
  marginTop: 16,
  textAlign: 'center',
};

const smallLinkStyle = {
  fontSize: 13,
  color: '#5e554a',
  textDecoration: 'none',
  borderBottom: '1px solid rgba(94, 85, 74, 0.4)',
};

const linkBtnStyle = {
  display: 'inline-block',
  marginTop: 14,
  padding: '10px 18px',
  background: 'var(--gold-grad, linear-gradient(180deg, #d4b87a, #c9a96e))',
  color: '#111116',
  borderRadius: 8,
  fontFamily: 'var(--font-display, Georgia, serif)',
  fontWeight: 600,
  fontSize: 14,
  textDecoration: 'none',
};
