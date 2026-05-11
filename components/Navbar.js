import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

import styles from './Navbar.module.css';
import { getBrowserSupabase } from '../lib/supabase';
import { subscribeEntitlement } from '../lib/entitlementBus';

const SUPPORT_EMAIL = 'support@davoxa.com';

const FEATURE_TABS = [
  { href: '/', label: 'Face Swap' },
  { href: '/ugc', label: 'UGC Creator' },
  { href: '/glow-up', label: 'Glow Up' },
  { href: '/interior-design', label: 'Interior Design' },
  { href: '/video/editing', label: 'Video Editor' },
  { href: '/history', label: 'History' },
  { href: `mailto:${SUPPORT_EMAIL}`, label: 'Support', external: true },
];

export default function Navbar() {
  const [user, setUser] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [entitlement, setEntitlement] = useState(null);
  const router = useRouter();

  const fetchEntitlement = useCallback(async () => {
    try {
      const r = await fetch('/api/entitlement');
      if (!r.ok) return;
      const d = await r.json();
      setEntitlement(d);
    } catch {}
  }, []);

  useEffect(() => {
    if (!user) {
      setEntitlement(null);
      return undefined;
    }
    fetchEntitlement();
    const unsub = subscribeEntitlement(fetchEntitlement);
    return unsub;
  }, [user, router.pathname, fetchEntitlement]);

  const creditLabel = (() => {
    if (!entitlement) return null;
    if (entitlement.isAdmin) return 'Admin · Unlimited';
    if (entitlement.status === 'trialing') {
      return `Free trial · ${entitlement.creditsRemaining || 0} credit`;
    }
    const n = entitlement.creditsRemaining ?? 0;
    return `${n} credit${n === 1 ? '' : 's'}`;
  })();

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const supabase = getBrowserSupabase();
    if (!supabase) return undefined;

    supabase.auth.getUser().then(({ data }) => setUser(data?.user || null));

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });
    return () => listener?.subscription?.unsubscribe?.();
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
  }, [router.pathname]);

  const handleSignOut = async () => {
    setMenuOpen(false);
    setDrawerOpen(false);
    const supabase = getBrowserSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    router.push('/');
  };

  const showTabs = Boolean(user);
  const activePath = router.pathname;

  return (
    <nav className={styles.nav}>
      <div className={styles.inner}>
        {showTabs && (
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawerOpen((v) => !v)}
            className={styles.hamburger}
          >
            <span />
            <span />
            <span />
          </button>
        )}

        <Link href="/" className={styles.brand}>
          <div className={styles.mark} aria-hidden="true">H</div>
          <span className={styles.wordmark}>Haelabs</span>
        </Link>

        {showTabs && (
          <div className={styles.tabs} role="tablist">
            {FEATURE_TABS.map((tab) =>
              tab.external ? (
                <a
                  key={tab.href}
                  href={tab.href}
                  role="tab"
                  className={styles.tab}
                >
                  {tab.label}
                </a>
              ) : (
                <Link
                  key={tab.href}
                  href={tab.href}
                  role="tab"
                  aria-selected={activePath === tab.href}
                  className={`${styles.tab} ${activePath === tab.href ? styles.tabActive : ''}`}
                >
                  {tab.label}
                </Link>
              )
            )}
          </div>
        )}

        <div className={styles.status}>
          {user && creditLabel && (
            <Link
              href="/dashboard"
              className={styles.desktopOnly}
              style={{
                fontSize: 12,
                fontFamily: 'inherit',
                color: '#ededed',
                background: 'rgba(224, 196, 136, 0.08)',
                border: '1px solid rgba(224, 196, 136, 0.3)',
                padding: '5px 12px',
                borderRadius: 999,
                whiteSpace: 'nowrap',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
              aria-label="Credits remaining — click to manage"
              title="Manage credits"
            >
              ◆ {creditLabel}
            </Link>
          )}
          {user ? (
            <div style={{ position: 'relative' }} className={styles.desktopOnly}>
              <button
                type="button"
                onClick={() => setMenuOpen((v) => !v)}
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#ddd',
                  padding: '6px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontSize: 12,
                  fontFamily: 'inherit',
                }}
              >
                {user.email?.split('@')[0] || 'Account'} ▾
              </button>
              {menuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    top: '110%',
                    right: 0,
                    background: '#0f0f11',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 8,
                    padding: 6,
                    minWidth: 180,
                    boxShadow: '0 10px 30px rgba(0,0,0,0.6)',
                    zIndex: 9000,
                  }}
                  onMouseLeave={() => setMenuOpen(false)}
                >
                  <Link
                    href="/dashboard"
                    style={{
                      display: 'block',
                      padding: '8px 10px',
                      color: '#ddd',
                      textDecoration: 'none',
                      fontSize: 13,
                      borderRadius: 4,
                    }}
                    onClick={() => setMenuOpen(false)}
                  >
                    Dashboard
                  </Link>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '8px 10px',
                      color: '#ddd',
                      background: 'transparent',
                      border: 'none',
                      fontSize: 13,
                      cursor: 'pointer',
                      borderRadius: 4,
                      fontFamily: 'inherit',
                    }}
                  >
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              href="/sign-in"
              style={{
                color: '#ededed',
                fontSize: 12,
                textDecoration: 'none',
                letterSpacing: '0.04em',
                border: '1px solid rgba(224, 196, 136, 0.4)',
                padding: '6px 12px',
                borderRadius: 6,
              }}
            >
              Sign in
            </Link>
          )}
        </div>
      </div>

      {drawerOpen && showTabs && (
        <div className={styles.drawer}>
          {creditLabel && (
            <div
              style={{
                padding: '8px 14px',
                fontSize: 13,
                color: '#ededed',
                borderBottom: '1px solid rgba(255,255,255,0.08)',
                marginBottom: 4,
              }}
            >
              ◆ {creditLabel}
            </div>
          )}
          {FEATURE_TABS.map((tab) =>
            tab.external ? (
              <a
                key={tab.href}
                href={tab.href}
                className={styles.drawerItem}
                onClick={() => setDrawerOpen(false)}
              >
                {tab.label}
              </a>
            ) : (
              <Link
                key={tab.href}
                href={tab.href}
                className={`${styles.drawerItem} ${activePath === tab.href ? styles.drawerItemActive : ''}`}
                onClick={() => setDrawerOpen(false)}
              >
                {tab.label}
              </Link>
            )
          )}
          <div className={styles.drawerDivider} />
          <Link
            href="/dashboard"
            className={styles.drawerItem}
            onClick={() => setDrawerOpen(false)}
          >
            Dashboard
          </Link>
          <button type="button" onClick={handleSignOut} className={styles.drawerItem}>
            Sign out
          </button>
        </div>
      )}
    </nav>
  );
}
