import { useEffect, useMemo, useRef, useState } from 'react';

/*
 * Transcript preview with the auto-cut decisions visualized.
 *
 * Layout: video on the left, scrollable transcript on the right.
 * Every word AssemblyAI flagged as a filler ("um", "uh", etc.) and
 * every leading-silence gap > 0.5s renders pre-crossed-out in red.
 *
 * The user can click any crossed-out token to UN-cross it (keep that
 * word / silence in the final cut), and any normal word to ADD a
 * manual strikethrough. The set of overrides is held in state on the
 * parent so it can be passed into the render plan.
 *
 * Props:
 *   videoUrl            : public URL of the source video
 *   preview             : { words: [{ text, start, end, isFiller, leadingSilenceMs, ... }] }
 *   overrides           : { wordIdx: 'keep' | 'cut' }
 *   onOverridesChange   : (next) => void
 *   onWordClick         : (wordIdx, startMs) => void   // optional: jumps video to time
 */

const SILENCE_MIN_MS = 500;

export default function TranscriptPreview({
  videoUrl,
  preview,
  overrides = {},
  onOverridesChange,
  onWordClick,
  cutFillers = true,
  cutSilences = true,
}) {
  const videoRef = useRef(null);
  const [currentMs, setCurrentMs] = useState(0);

  // Track video playback time so we can highlight the live word.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return undefined;
    const onTime = () => setCurrentMs(Math.round(v.currentTime * 1000));
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, []);

  const words = preview?.words || [];

  // Compute the effective "is this getting cut?" state for every word
  // (auto-detection + manual overrides). Memoize so click-toggling
  // doesn't re-iterate the whole list every render.
  const isWordCut = useMemo(() => {
    return words.map((w, idx) => {
      const auto = cutFillers && w.isFiller;
      const override = overrides[idx];
      if (override === 'keep') return false;
      if (override === 'cut') return true;
      return auto;
    });
  }, [words, overrides, cutFillers]);

  // Per-word silence-cut decision. Mirrors deriveKeepIntervals so the
  // preview's "estimated output" matches what actually gets rendered.
  const isSilenceCut = useMemo(() => {
    return words.map((w, idx) => {
      if (w.leadingSilenceMs < SILENCE_MIN_MS) return false;
      const o = overrides[`silence-${idx}`];
      if (o === 'cut') return true;
      if (o === 'keep') return false;
      return cutSilences;
    });
  }, [words, overrides, cutSilences]);

  const cutCount = isWordCut.filter(Boolean).length;
  const effectiveSilenceCuts = isSilenceCut.filter(Boolean).length;

  const totalDurationMs = words.length ? words[words.length - 1].end : 0;
  const cutDurationMs = words.reduce((acc, w, idx) => {
    if (isWordCut[idx]) acc += Math.max(0, (w.end || 0) - (w.start || 0));
    if (isSilenceCut[idx]) acc += w.leadingSilenceMs;
    return acc;
  }, 0);
  const keptDurationMs = Math.max(0, totalDurationMs - cutDurationMs);

  const toggleWord = (idx) => {
    if (!onOverridesChange) return;
    const next = { ...overrides };
    const current = isWordCut[idx];
    next[idx] = current ? 'keep' : 'cut';
    onOverridesChange(next);
  };

  const toggleSilence = (idx) => {
    if (!onOverridesChange) return;
    const next = { ...overrides };
    const key = `silence-${idx}`;
    next[key] = isSilenceCut[idx] ? 'keep' : 'cut';
    onOverridesChange(next);
  };

  const seekTo = (startMs, wordIdx) => {
    const v = videoRef.current;
    if (v) {
      try { v.currentTime = (startMs || 0) / 1000; } catch {}
    }
    if (onWordClick) onWordClick(wordIdx, startMs);
  };

  return (
    <div style={wrapStyle}>
      <div style={videoColStyle}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          playsInline
          style={videoStyle}
        />
        <div style={statsStyle}>
          <Stat label="Source length" value={fmtDuration(totalDurationMs)} />
          <Stat label="Estimated output" value={fmtDuration(keptDurationMs)} />
          <Stat label="Words cut" value={`${cutCount}`} />
          <Stat label="Silences cut" value={`${effectiveSilenceCuts}`} />
        </div>
        <div style={legendStyle}>
          <span style={legendItem}>
            <span style={dotBlue} /> Live word
          </span>
          <span style={legendItem}>
            <span style={dotRed} /> Auto-cut filler/silence
          </span>
          <span style={legendItem}>
            <span style={dotGold} /> You marked to cut
          </span>
          <span style={{ ...legendItem, color: '#9b978f' }}>
            click any token to toggle
          </span>
        </div>
      </div>

      <div style={transcriptColStyle}>
        <div style={transcriptHeader}>
          <span style={transcriptHeaderTitle}>Transcript</span>
          <span style={transcriptHeaderSub}>
            {words.length.toLocaleString()} words
          </span>
        </div>
        <div style={transcriptScroll}>
          {words.map((w, idx) => {
            const isCut = isWordCut[idx];
            const isAuto = w.isFiller;
            const isManual = overrides[idx] === 'cut';
            const hasSilence = w.leadingSilenceMs >= SILENCE_MIN_MS;
            const showSilence = hasSilence && isSilenceCut[idx];
            const showSilenceKept = hasSilence && !isSilenceCut[idx];
            const isLive = currentMs >= w.start && currentMs <= w.end;

            const wordStyle = {
              ...tokenStyle,
              ...(isCut ? tokenCutStyle : {}),
              ...(isManual ? tokenManualStyle : {}),
              ...(isLive && !isCut ? tokenLiveStyle : {}),
            };

            return (
              <span key={`w-${idx}`}>
                {showSilence && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSilence(idx)}
                    style={silenceCutStyle}
                    title={`Auto-cut silence — ${(w.leadingSilenceMs / 1000).toFixed(1)}s. Click to keep.`}
                  >
                    ⟪ {(w.leadingSilenceMs / 1000).toFixed(1)}s pause ⟫
                  </span>
                )}
                {showSilenceKept && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleSilence(idx)}
                    style={silenceKeptStyle}
                    title="You kept this pause. Click to cut again."
                  >
                    · {(w.leadingSilenceMs / 1000).toFixed(1)}s ·
                  </span>
                )}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    seekTo(w.start, idx);
                    toggleWord(idx);
                  }}
                  style={wordStyle}
                  title={
                    isCut
                      ? `Cut — click to keep "${w.text}"`
                      : isAuto
                      ? 'Filler word'
                      : `Click to cut "${w.text}"`
                  }
                >
                  {w.text}
                </span>{' '}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
    </div>
  );
}

function fmtDuration(ms) {
  const totalSec = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── styles ──────────────────────────────────────────────────────────

const wrapStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  gap: 16,
  alignItems: 'start',
};

const videoColStyle = { display: 'flex', flexDirection: 'column', gap: 12 };
const videoStyle = {
  width: '100%',
  borderRadius: 12,
  background: '#000',
  aspectRatio: '16 / 9',
  objectFit: 'contain',
};

const statsStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 10,
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.02)',
};
const statLabelStyle = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 10,
  letterSpacing: '0.16em',
  textTransform: 'uppercase',
  color: '#9b978f',
};
const statValueStyle = {
  fontSize: 15,
  fontWeight: 600,
  color: '#ededed',
  marginTop: 2,
};

const legendStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px 18px',
  fontSize: 12,
  color: '#bbb',
};
const legendItem = { display: 'inline-flex', alignItems: 'center', gap: 6 };
const dotBase = { display: 'inline-block', width: 10, height: 10, borderRadius: 99 };
const dotBlue = { ...dotBase, background: '#4dabf7' };
const dotRed = { ...dotBase, background: '#ff6b6b' };
const dotGold = { ...dotBase, background: 'var(--gold, #e0c488)' };

const transcriptColStyle = {
  display: 'flex',
  flexDirection: 'column',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.02)',
  maxHeight: 'min(72vh, 640px)',
  overflow: 'hidden',
};
const transcriptHeader = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  padding: '12px 16px',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
};
const transcriptHeaderTitle = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  letterSpacing: '0.22em',
  textTransform: 'uppercase',
  color: 'var(--gold, #e0c488)',
};
const transcriptHeaderSub = { fontSize: 12, color: '#9b978f' };
const transcriptScroll = {
  overflowY: 'auto',
  padding: '16px 18px 20px',
  lineHeight: 1.85,
  fontSize: 15,
  color: '#ededed',
};
const tokenStyle = {
  display: 'inline',
  cursor: 'pointer',
  padding: '2px 1px',
  borderRadius: 3,
  transition: 'background 80ms ease, color 80ms ease',
};
const tokenCutStyle = {
  color: '#ff6b6b',
  textDecoration: 'line-through',
  textDecorationThickness: '2px',
  opacity: 0.85,
};
const tokenManualStyle = {
  color: 'var(--gold, #e0c488)',
  textDecoration: 'line-through',
  textDecorationThickness: '2px',
};
const tokenLiveStyle = {
  background: 'rgba(77, 171, 247, 0.18)',
  color: '#cfe6ff',
};
const silenceCutStyle = {
  display: 'inline',
  color: '#ff6b6b',
  background: 'rgba(255, 107, 107, 0.08)',
  border: '1px dashed rgba(255, 107, 107, 0.45)',
  borderRadius: 4,
  padding: '0 6px',
  margin: '0 4px',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  cursor: 'pointer',
  letterSpacing: '0.06em',
  textTransform: 'lowercase',
};
const silenceKeptStyle = {
  display: 'inline',
  color: '#9b978f',
  background: 'rgba(255, 255, 255, 0.04)',
  border: '1px dotted rgba(255, 255, 255, 0.18)',
  borderRadius: 4,
  padding: '0 6px',
  margin: '0 4px',
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 11,
  cursor: 'pointer',
};
