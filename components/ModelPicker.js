/*
 * Model selector for the UGC creator + Image-to-Video tabs.
 *
 * Two pills:
 *   - Standard (default) → Seedance 1.5 Pro
 *   - Studio Pro → Kling 3.0, ~4× the credit cost
 *
 * Only rendered when isSubscriber is true. Non-subscribers always run
 * on Standard (the cheaper model) so trial usage doesn't burn the
 * premium pool.
 */

import { useState } from 'react';

const OPTIONS = [
  { key: 'standard', label: 'Standard' },
  { key: 'studio-pro', label: 'Studio Pro' },
];

export default function ModelPicker({
  value = 'standard',
  onChange,
  disabled = false,
}) {
  const [openTip, setOpenTip] = useState(null);
  return (
    <div style={wrapStyle}>
      <div style={labelRowStyle}>
        <span style={labelStyle}>Model</span>
        <button
          type="button"
          style={infoBtnStyle}
          aria-label="Model rate details"
          onClick={() => setOpenTip((v) => (v ? null : 'rates'))}
        >
          ⓘ
        </button>
      </div>
      {openTip === 'rates' && (
        <div style={tipStyle}>
          Standard charges 10/15/20/30/40/50 credits per second across
          (480p · 720p · 1080p) × (silent · with audio). Studio Pro
          charges 40/50/60/75/80/100 credits per second across the same
          matrix.
        </div>
      )}
      <div style={rowStyle}>
        {OPTIONS.map((opt) => {
          const active = value === opt.key;
          return (
            <button
              key={opt.key}
              type="button"
              disabled={disabled}
              onClick={() => onChange && onChange(opt.key)}
              style={{
                ...pillStyle,
                ...(active ? pillActiveStyle : null),
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.55 : 1,
              }}
              aria-pressed={active}
            >
              <span style={pillTitleStyle}>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const wrapStyle = { marginBottom: 10 };
const labelRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 4,
};
const labelStyle = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: '#b8b6b1',
};
const infoBtnStyle = {
  width: 18,
  height: 18,
  borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.35)',
  background: 'rgba(255,255,255,0.06)',
  color: '#ededed',
  fontSize: 11,
  cursor: 'pointer',
  padding: 0,
  lineHeight: '16px',
};
const tipStyle = {
  margin: '4px 0 8px',
  padding: '8px 10px',
  borderRadius: 8,
  background: 'rgba(28,23,15,0.85)',
  color: '#ffe7a3',
  fontSize: 12,
  lineHeight: 1.5,
};
const rowStyle = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: 8,
};
const pillStyle = {
  padding: '8px 10px',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 10,
  background: 'rgba(255,255,255,0.04)',
  color: '#ededed',
  fontFamily: 'inherit',
  textAlign: 'center',
};
const pillActiveStyle = {
  borderColor: 'rgba(224, 196, 136, 0.6)',
  background: 'rgba(224, 196, 136, 0.12)',
};
const pillTitleStyle = {
  fontSize: 14,
  fontWeight: 600,
};
