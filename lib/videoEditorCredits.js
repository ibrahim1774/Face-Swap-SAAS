import { stripe, PLANS, VIDEO_EDITOR_CR_PER_MIN, VIDEO_EDITOR_CR_PER_SEC } from './stripe';

/*
 * Video-editor credit pool.
 *
 * Separate from `creditsRemaining` (video gen) and `imageCreditsRemaining`
 * (Glow Up / Interior Design). Stored on Stripe customer metadata as
 * `videoEditorCreditsRemaining` (string-encoded integer). Period rollover
 * uses `videoEditorPeriodStart` (string-encoded ms timestamp), same
 * pattern the image pool uses in /api/glow-up.
 *
 * Plan grant table (PLANS.{plan}.videoEditorCap):
 *   monthly   1,500 cr/mo   → 50 min of source / mo
 *   pro       4,500 cr/mo   → 150 min of source / mo
 *   yearly    7,500 cr/yr   → 250 min of source / yr
 *
 * Topup packs (TOPUPS.{ve-s,ve-m,ve-l,ve-xl}) add to the same pool with
 * no expiry. Source minutes priced at VIDEO_EDITOR_CR_PER_MIN = 30 cr/min.
 *
 * This module is server-only (uses the Stripe secret key). Callers:
 *   - /api/video/render  (reserve at job-enqueue time)
 *   - worker             (refund on failure path via the same admin SDK)
 *   - /api/entitlement   (read-only balance for the UI)
 */

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

function readInt(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function planCapFor(plan) {
  const cfg = PLANS[plan];
  if (!cfg || typeof cfg.videoEditorCap !== 'number') return 0;
  return cfg.videoEditorCap;
}

/**
 * Compute the credit cost for a video-editor render given the source
 * video's duration (seconds). Rounded UP to the next whole credit so
 * the 90% margin floor holds even on sub-minute clips.
 */
export function costForEditorJob({ sourceSeconds }) {
  const s = Math.max(1, Math.ceil(Number(sourceSeconds) || 0));
  return Math.max(1, Math.ceil(s * VIDEO_EDITOR_CR_PER_SEC));
}

/**
 * Read the customer's current video-editor balance. Applies the
 * monthly period rollover lazily (writes the new period + reseeded
 * balance back to metadata on read) so the UI always reflects the
 * latest grant without needing a webhook to fire.
 *
 * Yearly plans use the same 30-day rollover window as monthly; the
 * difference is that yearly's `videoEditorCap` is the FULL annual
 * grant — it does NOT re-grant every 30 days. (yearly subs that hit
 * zero pre-anniversary are expected to top up.) Implemented by only
 * reseeding when `plan !== 'yearly'`.
 */
export async function resolveVideoEditorEntitlement({ customerId, plan }) {
  const empty = {
    videoEditorCreditsRemaining: 0,
    videoEditorPeriodStart: Date.now(),
    cap: planCapFor(plan),
  };
  if (!customerId) return empty;

  let customer;
  try {
    customer = await stripe().customers.retrieve(customerId);
  } catch {
    return empty;
  }
  if (!customer || customer.deleted) return empty;
  const md = customer.metadata || {};

  let remaining = readInt(md.videoEditorCreditsRemaining);
  let periodStart = readInt(md.videoEditorPeriodStart);
  const now = Date.now();
  const cap = planCapFor(plan);
  let dirty = false;

  // Monthly + pro plans get a fresh grant every 30 days. Yearly grants
  // once per year (we let the annual Stripe renewal webhook reseed for
  // them).
  const isPeriodicPlan = plan === 'monthly' || plan === 'pro';
  if (isPeriodicPlan && cap > 0) {
    if (!periodStart || now - periodStart >= PERIOD_MS) {
      remaining = Math.max(remaining, cap);
      periodStart = now;
      dirty = true;
    }
  } else if (plan === 'yearly' && cap > 0 && !periodStart) {
    // First-touch seed for yearly: stamp the period and grant the cap.
    remaining = Math.max(remaining, cap);
    periodStart = now;
    dirty = true;
  }

  if (dirty) {
    try {
      await stripe().customers.update(customerId, {
        metadata: {
          ...md,
          videoEditorCreditsRemaining: String(remaining),
          videoEditorPeriodStart: String(periodStart),
        },
      });
    } catch {
      // Best-effort. Next read will retry.
    }
  }

  return {
    videoEditorCreditsRemaining: remaining,
    videoEditorPeriodStart: periodStart,
    cap,
  };
}

/**
 * Reserve `cost` credits from the editor pool. Throws with
 * code = 'INSUFFICIENT' (carrying remaining) or 'NO_CUSTOMER' on
 * failure paths. The caller is responsible for refunding on render
 * failure via refundVideoEditorCredits.
 */
export async function reserveVideoEditorCredits({ customerId, plan, cost }) {
  if (!customerId) {
    const err = new Error('No Stripe customer linked.');
    err.code = 'NO_CUSTOMER';
    throw err;
  }
  const need = Math.max(1, Math.ceil(Number(cost) || 0));
  const customer = await stripe().customers.retrieve(customerId);
  if (!customer || customer.deleted) {
    const err = new Error('Customer not found.');
    err.code = 'NO_CUSTOMER';
    throw err;
  }
  const md = customer.metadata || {};
  const current = readInt(md.videoEditorCreditsRemaining);
  if (current < need) {
    const err = new Error('Insufficient video-editor credits.');
    err.code = 'INSUFFICIENT';
    err.remaining = current;
    err.cost = need;
    throw err;
  }
  const next = current - need;
  await stripe().customers.update(customerId, {
    metadata: { ...md, videoEditorCreditsRemaining: String(next) },
  });
  return { previous: current, remaining: next, reserved: need };
}

/**
 * Refund N credits back to the editor pool. Idempotent in the sense
 * that double-calling will over-refund — callers must track whether
 * they've already refunded a given job (e.g. via the render_jobs row).
 */
export async function refundVideoEditorCredits({ customerId, amount }) {
  if (!customerId) return;
  const add = Math.max(1, Math.ceil(Number(amount) || 0));
  try {
    const customer = await stripe().customers.retrieve(customerId);
    if (!customer || customer.deleted) return;
    const md = customer.metadata || {};
    const current = readInt(md.videoEditorCreditsRemaining);
    await stripe().customers.update(customerId, {
      metadata: { ...md, videoEditorCreditsRemaining: String(current + add) },
    });
  } catch (err) {
    console.warn('[video-editor] refund failed', err.message);
  }
}

/**
 * Grant credits from a topup pack. Called by the Stripe checkout
 * webhook when a `ve-*` SKU is purchased.
 */
export async function grantVideoEditorCreditsFromTopup({ customerId, credits }) {
  if (!customerId || !credits) return;
  const add = Math.max(0, Math.floor(Number(credits) || 0));
  if (!add) return;
  const customer = await stripe().customers.retrieve(customerId);
  if (!customer || customer.deleted) return;
  const md = customer.metadata || {};
  const current = readInt(md.videoEditorCreditsRemaining);
  await stripe().customers.update(customerId, {
    metadata: { ...md, videoEditorCreditsRemaining: String(current + add) },
  });
}

export { VIDEO_EDITOR_CR_PER_MIN, VIDEO_EDITOR_CR_PER_SEC };
