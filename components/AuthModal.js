import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';

import styles from './AuthModal.module.css';
import { getBrowserSupabase } from '../lib/supabase';

// Fire the same event to both Meta Pixel and TikTok Pixel, deduping
// against server-side CAPI/Events-API via the shared eventId.
function firePixels({ eventName, params, eventId }) {
  if (!eventId || typeof window === 'undefined') return;
  if (typeof window.fbq === 'function') {
    try {
      window.fbq('track', eventName, params, { eventID: eventId });
    } catch {}
  }
  if (window.ttq && typeof window.ttq.track === 'function') {
    try {
      window.ttq.track(eventName, params, { event_id: eventId });
    } catch {}
  }
}

export default function AuthModal({
  open,
  onClose,
  initialMode = 'signup',
  redirectTo = '/',
  lockedEmail = null,
  claimSessionId = null,
}) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState(lockedEmail || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(null); // 'google' | 'email' | null
  const [error, setError] = useState('');
  const router = useRouter();
  const googleBtnRef = useRef(null);

  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const isClaimFlow = Boolean(claimSessionId && lockedEmail);

  // If the locked email arrives after first render (async fetch on
  // /sign-up), keep the email field in sync with it.
  useEffect(() => {
    if (lockedEmail) setEmail(lockedEmail);
  }, [lockedEmail]);

  useEffect(() => {
    if (!open || !googleClientId) return undefined;

    let cancelled = false;
    let pollId;

    const handleCredential = async (response) => {
      if (!response?.credential) return;
      setBusy('google');
      setError('');
      try {
        const supabase = getBrowserSupabase();
        if (!supabase) throw new Error('Auth not configured. Contact support.');
        const { data: signInData, error: err } = await supabase.auth.signInWithIdToken({
          provider: 'google',
          token: response.credential,
        });
        if (err) throw err;

        // Claim-after-pay: Google returned an email — it MUST match
        // the email on the Stripe session. Check before calling the
        // server, so we can sign the user back out cleanly with a
        // helpful message if they used the wrong Google account.
        if (isClaimFlow) {
          const googleEmail = (signInData?.user?.email || '').toLowerCase();
          const expected = (lockedEmail || '').toLowerCase();
          if (googleEmail && expected && googleEmail !== expected) {
            await supabase.auth.signOut().catch(() => {});
            setError(
              `That Google account uses ${signInData.user.email}, but you paid with ${lockedEmail}. Sign in with the matching Google account, or use email + password below.`
            );
            setBusy(null);
            return;
          }
          try {
            const r = await fetch(
              `/api/checkout/claim?session_id=${encodeURIComponent(claimSessionId)}`,
              { method: 'POST' }
            );
            const claimData = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(claimData.error || 'Could not link your subscription.');
            const m = claimData.meta;
            firePixels({
              eventName: m?.eventName || 'Purchase',
              params: { value: m?.value, currency: m?.currency || 'USD' },
              eventId: m?.eventId,
            });
          } catch (claimErr) {
            setError(
              `Signed in, but linking subscription failed: ${claimErr.message}. Email support@davoxa.com if this persists.`
            );
            setBusy(null);
            return;
          }
        }

        // Record signup IP and fire CompleteRegistration via the
        // matching browser pixels (the API returns a meta payload with
        // the event id for dedup).
        fetch('/api/signup-ip', { method: 'POST' })
          .then((r) => r.json().catch(() => ({})))
          .then((data) => {
            const m = data?.meta;
            firePixels({
              eventName: m?.eventName || 'CompleteRegistration',
              params: { method: 'google' },
              eventId: m?.eventId,
            });
          })
          .catch(() => {});
        if (typeof onClose === 'function') onClose();
        router.push(redirectTo);
      } catch (err) {
        if (!cancelled) {
          setError(err.message || 'Google sign-in failed.');
          setBusy(null);
        }
      }
    };

    const tryInit = () => {
      const google = typeof window !== 'undefined' ? window.google : null;
      const container = googleBtnRef.current;
      if (!google?.accounts?.id || !container) return false;
      google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleCredential,
        ux_mode: 'popup',
      });
      container.textContent = '';
      google.accounts.id.renderButton(container, {
        type: 'standard',
        theme: 'filled_black',
        size: 'large',
        text: mode === 'signup' ? 'signup_with' : 'signin_with',
        shape: 'pill',
        width: 320,
      });
      return true;
    };

    if (!tryInit()) {
      pollId = setInterval(() => {
        if (tryInit()) clearInterval(pollId);
      }, 200);
    }

    return () => {
      cancelled = true;
      if (pollId) clearInterval(pollId);
    };
  }, [open, mode, googleClientId, router, onClose, redirectTo, isClaimFlow, lockedEmail, claimSessionId]);

  if (!open) return null;

  const emailCallbackUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/auth/callback?next=${encodeURIComponent(redirectTo)}`
      : undefined;

  const handleEmail = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy('email');
    setError('');
    try {
      const supabase = getBrowserSupabase();
      if (!supabase) throw new Error('Auth not configured. Contact support.');
      if (mode === 'signup') {
        // For claim-after-pay we'd rather have the user signed in
        // immediately so the claim API call below has a session. Skip
        // the email-confirmation deep link in that case — the email
        // is already verified by Stripe (it's the address they
        // received their receipt at).
        const signupOpts = isClaimFlow ? {} : { emailRedirectTo: emailCallbackUrl };
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: signupOpts,
        });
        if (err) throw err;
        // Make sure we have an active session before calling the
        // claim endpoint — Supabase signUp returns a session unless
        // email confirmation is required.
        if (isClaimFlow) {
          await supabase.auth.signInWithPassword({ email, password }).catch(() => {});
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }

      // Claim the Stripe session: links the customer to this new
      // Supabase user and grants credits.
      if (isClaimFlow) {
        try {
          const r = await fetch(
            `/api/checkout/claim?session_id=${encodeURIComponent(claimSessionId)}`,
            { method: 'POST' }
          );
          const claimData = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(claimData.error || 'Could not link your subscription.');
          // Fire Purchase pixel with the same eventId as CAPI for dedup.
          const m = claimData.meta;
          firePixels({
            eventName: m?.eventName || 'Purchase',
            params: { value: m?.value, currency: m?.currency || 'USD' },
            eventId: m?.eventId,
          });
        } catch (claimErr) {
          // Account was created; surface the link error so the user
          // can retry or contact support without losing their account.
          setError(`Account created, but linking subscription failed: ${claimErr.message}`);
          setBusy(null);
          return;
        }
      }
      fetch('/api/signup-ip', { method: 'POST' })
        .then((r) => r.json().catch(() => ({})))
        .then((data) => {
          const m = data?.meta;
          firePixels({
            eventName: m?.eventName || 'CompleteRegistration',
            params: { method: mode === 'signup' ? 'email' : 'email-signin' },
            eventId: m?.eventId,
          });
        })
        .catch(() => {});
      if (typeof onClose === 'function') onClose();
      router.push(redirectTo);
    } catch (err) {
      setError(err.message || 'Authentication failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.backdrop} onClick={onClose} role="presentation">
      <div
        className={styles.card}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        <button
          type="button"
          className={styles.closeBtn}
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <header className={styles.header}>
          <span className={styles.kicker}>
            ◆ {isClaimFlow ? 'Finish setup' : mode === 'signup' ? 'Create account' : 'Welcome back'}
          </span>
          <h2 id="auth-modal-title" className={styles.title}>
            {isClaimFlow
              ? 'Set a password to finish'
              : mode === 'signup'
                ? 'Sign up to continue'
                : 'Sign in to continue'}
          </h2>
          <p className={styles.subtitle}>
            {isClaimFlow
              ? 'Payment confirmed. Pick a password and your subscription will be linked to your account.'
              : mode === 'signup'
                ? 'Takes 15 seconds. Your uploaded files stay loaded on this page.'
                : 'Welcome back. Sign in and pick up where you left off.'}
          </p>
        </header>

        {isClaimFlow && lockedEmail && (
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 8,
              border: '1px solid rgba(224, 196, 136, 0.25)',
              background: 'rgba(224, 196, 136, 0.06)',
              color: '#e6e6e6',
              fontSize: 12,
              lineHeight: 1.5,
              textAlign: 'center',
              marginBottom: 12,
            }}
          >
            Sign in with the Google account for <strong>{lockedEmail}</strong>, or
            set a password below for the same email.
          </div>
        )}

        {googleClientId ? (
          <div
            ref={googleBtnRef}
            style={{ display: 'flex', justifyContent: 'center', minHeight: 44 }}
          />
        ) : (
          <div className={styles.error}>
            Google sign-in unavailable — NEXT_PUBLIC_GOOGLE_CLIENT_ID not set.
          </div>
        )}

        <div className={styles.divider}>
          <span>or</span>
        </div>

        <form className={styles.form} onSubmit={handleEmail}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              readOnly={isClaimFlow}
              className={styles.input}
              style={isClaimFlow ? { opacity: 0.7, cursor: 'not-allowed' } : undefined}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Password</span>
            <input
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'signup' ? 8 : undefined}
              className={styles.input}
            />
          </label>
          {error && <div className={styles.error}>{error}</div>}
          <button type="submit" className={styles.submitBtn} disabled={busy !== null}>
            {busy === 'email'
              ? 'Working…'
              : mode === 'signup'
              ? 'Create account'
              : 'Sign in'}
          </button>
        </form>

        {!isClaimFlow && (
          <footer className={styles.footer}>
            {mode === 'signup' ? (
              <>
                Already have an account?{' '}
                <button type="button" className={styles.link} onClick={() => setMode('signin')}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                New here?{' '}
                <button type="button" className={styles.link} onClick={() => setMode('signup')}>
                  Create an account
                </button>
              </>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
