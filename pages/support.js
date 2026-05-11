import Head from 'next/head';

import styles from '../styles/Home.module.css';

const SUPPORT_EMAIL = 'support@davoxa.com';

export default function SupportPage() {
  return (
    <>
      <Head>
        <title>Support — Contact us</title>
      </Head>
      <main className={styles.page} style={{ paddingTop: 40, paddingBottom: 60 }}>
        <div className={styles.hero} style={{ marginBottom: 18 }}>
          <span className={styles.eyebrow}>◆ Support</span>
          <h1
            className={styles.headline}
            style={{ fontSize: 'clamp(28px, 4.4vw, 44px)', margin: '14px 0 10px', lineHeight: 1.15 }}
          >
            Contact us — membership questions, concerns, or anything else
          </h1>
          <p className={styles.subtitle} style={{ fontSize: 15, lineHeight: 1.55 }}>
            Email us anytime. We usually reply within one business day.
          </p>
        </div>

        <section
          aria-label="Support contact"
          style={{
            maxWidth: 520,
            width: '100%',
            margin: '0 auto',
            padding: '22px 24px',
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(255,255,255,0.02)',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              fontSize: 11,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'rgba(255,255,255,0.5)',
              marginBottom: 10,
            }}
          >
            Reach the team
          </div>
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            style={{
              display: 'inline-block',
              color: '#ededed',
              fontSize: 18,
              fontWeight: 600,
              textDecoration: 'none',
              borderBottom: '1px solid rgba(224, 196, 136, 0.5)',
              padding: '2px 4px',
            }}
          >
            {SUPPORT_EMAIL}
          </a>
          <div
            style={{
              marginTop: 14,
              fontSize: 13,
              color: 'rgba(255,255,255,0.6)',
              lineHeight: 1.55,
            }}
          >
            Billing, refund requests, plan changes, technical issues — all go to
            the same inbox. Include your account email so we can find you fast.
          </div>
        </section>
      </main>
    </>
  );
}
