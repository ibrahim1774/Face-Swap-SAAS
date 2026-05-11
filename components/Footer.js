/*
 * Global page footer with a support-contact link.
 * Rendered by pages/_app.js after every <Component />.
 */

export default function Footer() {
  return (
    <footer
      style={{
        position: 'relative',
        zIndex: 2,
        marginTop: 'auto',
        padding: '18px 16px 22px',
        textAlign: 'center',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(0,0,0,0.18)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, monospace)',
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.5)',
          marginBottom: 4,
        }}
      >
        Need help?
      </div>
      <a
        href="mailto:support@davoxa.com"
        style={{
          color: '#ededed',
          fontSize: 13,
          fontWeight: 500,
          textDecoration: 'none',
          borderBottom: '1px solid rgba(224, 196, 136, 0.35)',
        }}
      >
        support@davoxa.com
      </a>
    </footer>
  );
}
