import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * ASS subtitle generator.
 *
 * Takes the AssemblyAI word list + the keepIntervals applied to the
 * source, remaps word timings into the rendered-output timeline, groups
 * them into readable chunks, and emits an ASS file FFmpeg can burn in
 * via the `ass=` filter.
 *
 * Style presets are designed to work with system-bundled fonts
 * (DejaVu Sans / Liberation Sans / Arial fallback via fontconfig) so
 * the docker image needs no extra font payload to ship V1.
 */

const STYLE_PRESETS = {
  clean: {
    name: 'Clean',
    fontName: 'DejaVu Sans',
    fontSize: 56,
    primary: '&H00FFFFFF', // white
    outline: '&H00000000', // black
    back: '&H80000000', // 50% black box (unused at borderStyle=1)
    borderStyle: 1, // outline only
    outlineWidth: 2,
    shadow: 1,
    bold: 0,
    alignment: 2, // bottom-center
    marginV: 90,
    wordsPerCue: 6,
    maxCueMs: 2500,
  },
  bold: {
    name: 'Bold',
    fontName: 'DejaVu Sans',
    fontSize: 72,
    primary: '&H0000FFFF', // bright yellow (ASS is BGR)
    outline: '&H00000000', // black
    back: '&H00000000',
    borderStyle: 1,
    outlineWidth: 4,
    shadow: 2,
    bold: 1,
    alignment: 2,
    marginV: 110,
    wordsPerCue: 4,
    maxCueMs: 1800,
  },
  block: {
    name: 'Block',
    fontName: 'DejaVu Sans',
    fontSize: 54,
    primary: '&H00FFFFFF',
    outline: '&H00000000',
    back: '&HCC000000', // 80% black box
    borderStyle: 3, // opaque box behind text
    outlineWidth: 6,
    shadow: 0,
    bold: 1,
    alignment: 2,
    marginV: 70,
    wordsPerCue: 7,
    maxCueMs: 3000,
  },
};

export function getStylePreset(name) {
  return STYLE_PRESETS[name] || null;
}

/**
 * Build a mapping that translates a source-time (ms) to output-time (s)
 * after the keepIntervals cuts are applied. Returns null for source
 * timestamps that fall inside a removed segment.
 */
function buildTimeMapper(keepIntervalsSec) {
  const intervals = (keepIntervalsSec || [])
    .map((iv) => ({ start: iv.start * 1000, end: iv.end * 1000 }))
    .sort((a, b) => a.start - b.start);
  let cumulative = 0;
  const mapped = intervals.map((iv) => {
    const out = { srcStart: iv.start, srcEnd: iv.end, outStart: cumulative };
    cumulative += iv.end - iv.start;
    return out;
  });
  return (srcMs) => {
    for (const iv of mapped) {
      if (srcMs >= iv.srcStart && srcMs <= iv.srcEnd) {
        return (iv.outStart + (srcMs - iv.srcStart)) / 1000;
      }
    }
    return null;
  };
}

/**
 * Group words into readable cue chunks. Each chunk respects the style's
 * wordsPerCue ceiling AND a max display duration so long pauses don't
 * leave a single word frozen on screen.
 *
 * Words that map to a removed segment (mapper returns null) are dropped.
 */
function groupWordsIntoCues(words, keepIntervalsSec, style) {
  const mapper = buildTimeMapper(keepIntervalsSec);
  const cues = [];
  let current = null;

  for (const w of words) {
    const startOut = mapper(w.start);
    const endOut = mapper(w.end);
    if (startOut == null || endOut == null) {
      // Word falls in a removed interval — flush current cue, skip word.
      if (current) {
        cues.push(current);
        current = null;
      }
      continue;
    }

    if (!current) {
      current = {
        start: startOut,
        end: endOut,
        words: [w.text],
      };
      continue;
    }

    const wouldGrow = current.words.length + 1;
    const wouldDuration = (endOut - current.start) * 1000;
    if (wouldGrow > style.wordsPerCue || wouldDuration > style.maxCueMs) {
      cues.push(current);
      current = { start: startOut, end: endOut, words: [w.text] };
    } else {
      current.end = endOut;
      current.words.push(w.text);
    }
  }
  if (current) cues.push(current);

  return cues.filter((c) => c.end > c.start && c.words.length > 0);
}

function fmtAssTime(sec) {
  const total = Math.max(0, sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total - Math.floor(total)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assEscape(text) {
  // ASS uses { } for inline overrides; escape stray braces. Also strip
  // newlines (we render single-line cues).
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .trim();
}

export function buildAssDocument({ words, keepIntervalsSec, style, videoWidth, videoHeight }) {
  const w = videoWidth || 1080;
  const h = videoHeight || 1920;
  const cues = groupWordsIntoCues(words || [], keepIntervalsSec || [], style);

  // ASS header. PlayResX/Y mirror the video frame so fontSize maps to
  // pixels 1:1.
  const header = [
    '[Script Info]',
    'Title: Haelabs caption track',
    'ScriptType: v4.00+',
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${w}`,
    `PlayResY: ${h}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Default',
      style.fontName,
      style.fontSize,
      style.primary,
      style.primary,
      style.outline,
      style.back,
      style.bold ? -1 : 0,
      0, 0, 0,
      100, 100, 0, 0,
      style.borderStyle,
      style.outlineWidth,
      style.shadow,
      style.alignment,
      60, 60,
      style.marginV,
      1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n');

  const events = cues
    .map((cue) => {
      const text = assEscape(cue.words.join(' '));
      return `Dialogue: 0,${fmtAssTime(cue.start)},${fmtAssTime(cue.end)},Default,,0,0,0,,${text}`;
    })
    .join('\n');

  return `${header}\n${events}\n`;
}

/**
 * Write the ASS subtitle file to /tmp and return its absolute path.
 */
export async function writeAssFile({ words, keepIntervalsSec, style, videoWidth, videoHeight, jobId }) {
  const content = buildAssDocument({ words, keepIntervalsSec, style, videoWidth, videoHeight });
  const dir = join(tmpdir(), 'haelabs-render');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `job-${jobId || Date.now()}-subs.ass`);
  await writeFile(path, content, 'utf8');
  return path;
}
