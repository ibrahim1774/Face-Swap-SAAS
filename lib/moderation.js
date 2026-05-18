import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';

import { getSupabaseAdmin } from './supabaseServer';

/*
 * Server-only NSFW + minor-safety pre-filter.
 *
 * Two surfaces:
 *   - screenText({ text })   → regex blocklist + Claude Haiku classifier
 *   - screenImage({ url })   → Claude Haiku 4.5 vision, result cached in
 *                              moderation_results table
 *
 * Each returns { ok: true } on pass, throws ModerationError with
 * code='BLOCKED_NSFW' and category='sexual'|'minor' on fail. Callers
 * catch and surface a 400 to the client without ever charging credits.
 */

export class ModerationError extends Error {
  constructor(category, reason) {
    super(
      "AI doesn't allow sexual content or anything involving minors. " +
        'Try a different prompt or image.'
    );
    this.code = 'BLOCKED_NSFW';
    this.category = category;
    this.reason = reason || '';
  }
}

// ── Layer 1: regex blocklists ────────────────────────────────────────
//
// Sexual / nudity terms. Word-boundary matched. Case-insensitive at the
// flag level so we don't need /i on every alt.
const SEXUAL_TERMS = [
  // nudity / state of undress
  'naked', 'nude', 'nudity', 'nudes', 'topless', 'bottomless',
  'undressed', 'undressing',
  'strip', 'stripping', 'stripper',
  // explicit content tags
  'sexual', 'sexually', 'porn', 'porno', 'pornographic', 'xxx',
  'nsfw', 'explicit', 'erotic', 'erotica',
  // genitalia + body parts
  'boobs', 'breasts', 'tits', 'titties', 'nipples', 'areola',
  'vagina', 'pussy', 'clit', 'clitoris',
  'penis', 'erection',
  // acts
  'cum', 'cumming', 'ejaculate', 'ejaculation', 'orgasm',
  'jerk off', 'jack off',
  'blowjob', 'handjob', 'footjob', 'deepthroat',
  'intercourse', 'fornicate', 'fornicating', 'fornication',
  // kinks / industry
  'fetish', 'bdsm', 'bondage',
  'escort', 'prostitute', 'prostitution', 'hooker', 'whore',
];

// Phrases (multi-word, word-boundary at both ends).
const SEXUAL_PHRASES = [
  'remove clothing', 'remove clothes', 'remove her clothes',
  'remove his clothes', 'take off clothes', 'take off her clothes',
  'take off his clothes', 'take off shirt', 'take off bra',
  'no clothes', 'without clothes', 'without clothing',
  'hard on', 'hard-on',
];

// Minor terms — only flag when ALSO paired with a sexual term in the
// same prompt. Solo mentions ("a kid playing in a park") pass through
// to Layer 2 for context.
const MINOR_TERMS = [
  'minor', 'minors', 'child', 'children', 'kid', 'kids',
  'baby', 'infant', 'toddler',
  'underage', 'under-age', 'under 18', 'under-18',
  'teenager', 'teen', 'teens', 'preteen', 'pre-teen',
  'schoolgirl', 'schoolboy', 'school girl', 'school boy',
  'loli', 'lolita', 'shota',
];

// Standalone CSAM-adjacent tokens that always block, even without a
// paired sexual term. Conservative — don't put ambiguous words here.
const MINOR_HARD_BLOCK = ['loli', 'lolita', 'shota'];

// `dick`, `cock`, `slut` — too many legit uses ("Dick Tracy", "rooster
// cock", "slut shaming discussion"). Punt to Layer 2.
//
// `sex` only at word boundary so "intersex"/"sexagenarian" pass.
const SEX_WORD_RE = /\bsex\b/i;

function buildAlternationRegex(terms) {
  // Escape regex metacharacters, sort longest-first so multi-word
  // entries match before their substrings.
  const escaped = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  // Word boundaries around the alternation. `gi` so we can also use
  // exec to find which term hit.
  return new RegExp(`\\b(?:${escaped.join('|')})\\b`, 'gi');
}

const SEXUAL_RE = buildAlternationRegex([...SEXUAL_TERMS, ...SEXUAL_PHRASES]);
const MINOR_RE = buildAlternationRegex(MINOR_TERMS);
const MINOR_HARD_RE = buildAlternationRegex(MINOR_HARD_BLOCK);

/**
 * Run the regex blocklist + the sex-word check. Returns null on pass,
 * `{ category, reason }` on hit. No external calls.
 */
function regexCheck(text) {
  const t = String(text || '');
  if (!t) return null;
  if (MINOR_HARD_RE.test(t)) {
    return { category: 'minor', reason: `Matched hard-block term (${t.match(MINOR_HARD_RE)?.[0]}).` };
  }
  const sexualHit = SEXUAL_RE.test(t) || SEX_WORD_RE.test(t);
  const minorHit = MINOR_RE.test(t);
  if (sexualHit && minorHit) {
    return { category: 'minor', reason: 'Sexual + minor terms in same prompt.' };
  }
  if (sexualHit) {
    return { category: 'sexual', reason: `Matched sexual term.` };
  }
  // Solo minor mentions are NOT blocked at Layer 1 — false positives
  // on "young entrepreneur" etc. Layer 2 evaluates context.
  return null;
}

// ── Layer 2: Claude Haiku text classifier ────────────────────────────

const TEXT_SYSTEM_PROMPT = `You are a strict content-safety classifier for a video generation app.

Classify the user-submitted prompt for two specific categories:
1. **sexual** — Does the prompt describe or ask for: nudity, sexual acts, removal of clothing, sexual body parts in a non-medical context, pornographic content, or any erotic intent? Bikinis, lingerie, and "sexy" clothing alone are NOT sexual unless paired with intent to undress or perform sexual acts. Profanity alone is NOT sexual.
2. **minor** — Does the prompt describe or imply anyone under 18 in a sexual or romantic context? A child or teen mentioned in a non-sexual, non-romantic, non-suggestive context (e.g., "a kid playing in a park", "a young entrepreneur giving a speech") is NOT a minor violation.

Be conservative on false positives. Legitimate use cases include: business promos, comedy/roast videos, dance, fashion, fitness, talking-head educational content, and most marketing footage.

Return ONLY a JSON object on a single line, no markdown, no prose:
{"sexual": <bool>, "minor": <bool>, "reason": "<one short sentence>"}`;

async function llmTextCheck(text) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fail-open on missing key — Layer 1 still ran. Log so this is
    // visible in Vercel logs without blocking the user.
    console.warn('[moderation] ANTHROPIC_API_KEY missing; skipping LLM text check');
    return null;
  }
  const client = new Anthropic({ apiKey });
  try {
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [
        {
          type: 'text',
          text: TEXT_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        { role: 'user', content: `Prompt to classify:\n"""\n${text.slice(0, 4000)}\n"""` },
      ],
    });
    const block = result.content.find((b) => b.type === 'text');
    if (!block) return null;
    const cleaned = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed.sexual || parsed.minor) {
      return {
        category: parsed.minor ? 'minor' : 'sexual',
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
      };
    }
    return null;
  } catch (err) {
    console.warn('[moderation] LLM text check failed', err.message);
    // Fail-open: Layer 1 already filtered the obvious cases. Letting
    // an LLM-only flag through is a known acceptable risk for v1.
    return null;
  }
}

/**
 * Screen a user-submitted text prompt. Throws ModerationError on block.
 * `texts` may also be an array of strings (e.g. storyboard scenes); the
 * function joins them with newlines for a single LLM call.
 */
export async function screenText(textOrArray) {
  const text = Array.isArray(textOrArray)
    ? textOrArray.filter((s) => typeof s === 'string').join('\n')
    : String(textOrArray || '');
  if (!text.trim()) return { ok: true };

  const layer1 = regexCheck(text);
  if (layer1) {
    throw new ModerationError(layer1.category, `Layer 1: ${layer1.reason}`);
  }
  const layer2 = await llmTextCheck(text);
  if (layer2) {
    throw new ModerationError(layer2.category, `Layer 2: ${layer2.reason}`);
  }
  return { ok: true };
}

// ── Image moderation: Claude Haiku 4.5 vision + cache ────────────────

const IMAGE_SYSTEM_PROMPT = `You are a strict content-safety classifier for image inputs to a video generation app.

Classify the image for two categories:
1. **sexual** — Visible nudity (exposed breasts, genitals, buttocks), partial undress that exposes intimate areas, sexual acts, or explicit erotic posing. Bikinis, swimwear, lingerie, and form-fitting clothing are NOT sexual on their own. Medical/anatomical diagrams are NOT sexual.
2. **minor** — Anyone in the image who appears to be under 18, evaluated by face/body proportions, clothing context, and setting. A child or teen in a non-sexual, fully-clothed context is acceptable. Flag minors only if they are present AND any sexualization is apparent OR if the image is being used in a context suggesting age-inappropriate content.

Return ONLY a JSON object on a single line:
{"sexual": <bool>, "minor": <bool>, "reason": "<one short sentence>"}`;

function urlHash(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

async function readCachedImageResult(url) {
  try {
    const admin = getSupabaseAdmin();
    const { data } = await admin
      .from('moderation_results')
      .select('sexual, minor, reason')
      .eq('url_hash', urlHash(url))
      .maybeSingle();
    return data || null;
  } catch (err) {
    console.warn('[moderation] cache read failed', err.message);
    return null;
  }
}

async function writeCachedImageResult(url, { sexual, minor, reason }) {
  try {
    const admin = getSupabaseAdmin();
    await admin
      .from('moderation_results')
      .upsert(
        {
          url_hash: urlHash(url),
          url: String(url).slice(0, 1000),
          sexual: !!sexual,
          minor: !!minor,
          reason: String(reason || '').slice(0, 300),
        },
        { onConflict: 'url_hash' }
      );
  } catch (err) {
    console.warn('[moderation] cache write failed', err.message);
  }
}

async function fetchImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  // Anthropic's vision input cap is 5 MB per image. Reject larger
  // inputs rather than try to compress — they're outside our normal
  // upload range anyway.
  if (buf.length > 5 * 1024 * 1024) {
    throw new Error('Image exceeds 5 MB classifier limit.');
  }
  return { data: buf.toString('base64'), mediaType: contentType };
}

async function llmImageCheck(url) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[moderation] ANTHROPIC_API_KEY missing; skipping image check');
    return null;
  }
  const client = new Anthropic({ apiKey });
  let img;
  try {
    img = await fetchImageAsBase64(url);
  } catch (err) {
    console.warn('[moderation] image fetch failed', err.message);
    return null; // fail-open on transient fetch issues
  }
  try {
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [
        {
          type: 'text',
          text: IMAGE_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data },
            },
            { type: 'text', text: 'Classify this image.' },
          ],
        },
      ],
    });
    const block = result.content.find((b) => b.type === 'text');
    if (!block) return null;
    const cleaned = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[moderation] LLM image check failed', err.message);
    return null;
  }
}

/**
 * Screen a user-supplied image URL. Throws ModerationError on block.
 * Result cached by URL hash so re-uses (storyboard scenes pointing at
 * the same upload, retries, etc.) skip the Anthropic round-trip.
 */
export async function screenImage(url) {
  if (typeof url !== 'string' || !url) return { ok: true };

  const cached = await readCachedImageResult(url);
  if (cached) {
    if (cached.sexual || cached.minor) {
      throw new ModerationError(
        cached.minor ? 'minor' : 'sexual',
        `Cached: ${cached.reason || ''}`
      );
    }
    return { ok: true };
  }

  const result = await llmImageCheck(url);
  if (!result) {
    // Fail-open on classifier errors. Log so we can audit later.
    return { ok: true };
  }
  await writeCachedImageResult(url, result);
  if (result.sexual || result.minor) {
    throw new ModerationError(
      result.minor ? 'minor' : 'sexual',
      result.reason || ''
    );
  }
  return { ok: true };
}

/**
 * Helper: turn a thrown ModerationError into a Next.js 400 response.
 * Centralizes the JSON shape so every API route emits the same payload.
 */
export function moderationErrorResponse(res, err) {
  return res.status(400).json({
    error: err.message,
    code: 'BLOCKED_NSFW',
    category: err.category || 'sexual',
  });
}

// Re-exports so the post-failure regex in lib/kie.js can be replaced
// with a single source of truth.
export const NSFW_REGEX = SEXUAL_RE;
export const MINOR_REGEX = MINOR_RE;
