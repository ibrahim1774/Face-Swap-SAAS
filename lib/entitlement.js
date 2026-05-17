import { stripe, CAPS, TRIAL_CREDITS, PLANS, planFromPrice } from './stripe';
import { sendCapiEvent } from './meta';

// Read how many trial credits the user has consumed so far. Backwards-
// compatible with the legacy binary `trialUsed='1'` flag — old trial
// users who already used their 1-shot trial are treated as having
// consumed 1 credit.
function readTrialUsed(md) {
  const explicit = parseInt(md?.trialCreditsUsed || '', 10);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (md?.trialUsed === '1') return 1;
  return 0;
}

/*
 * Admin-email allowlist. These accounts bypass the credit system
 * entirely: getEntitlement returns an "admin" tier with effectively
 * unlimited credits, and reserveCredits/refundCredits no-op.
 *
 * Override at runtime with the ADMIN_EMAILS env var (comma-separated).
 */
const DEFAULT_ADMIN_EMAILS = ['ibrahim3709@gmail.com'];
function adminEmails() {
  const raw = process.env.ADMIN_EMAILS;
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return DEFAULT_ADMIN_EMAILS.map((s) => s.toLowerCase());
}
export function isAdminEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return adminEmails().includes(email.toLowerCase());
}
function adminEntitlement() {
  return {
    tier: 'admin',
    status: 'admin',
    creditsRemaining: 9999,
    videoCap: 9999,
    videosUsed: 0,
    canSwap: true,
    isAdmin: true,
  };
}

/*
 * Supabase-backed entitlement. Identity = Supabase user.id. We look
 * up their `stripe_customer_id` in the profiles table, then read the
 * Stripe subscription + customer metadata as before.
 *
 * All previous cookie-based logic is gone.
 */

async function getStripeCustomerIdForUser(supabase, userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[entitlement] profile lookup error', error.message);
    return null;
  }
  return data?.stripe_customer_id || null;
}

async function readPaidEntitlement(customerId) {
  const [active, trialing] = await Promise.all([
    stripe().subscriptions.list({
      customer: customerId,
      status: 'active',
      limit: 1,
      expand: ['data.items.data.price'],
    }),
    stripe().subscriptions.list({
      customer: customerId,
      status: 'trialing',
      limit: 1,
      expand: ['data.items.data.price'],
    }),
  ]);
  const sub = active.data[0] || trialing.data[0];
  if (!sub) return null;
  const price = sub.items?.data?.[0]?.price;
  const plan = planFromPrice(price);
  if (!plan) return null;

  const customer = await stripe().customers.retrieve(customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};

  const planCap = CAPS[plan];
  const periodStartMs = (sub.current_period_start || 0) * 1000;
  const storedPeriodStart = parseInt(md.periodStart || '0', 10);

  let creditsRemaining;
  if (md.creditsRemaining !== undefined && md.creditsRemaining !== '') {
    creditsRemaining = Math.max(0, parseInt(md.creditsRemaining, 10) || 0);
  } else if (md.videosUsedThisPeriod !== undefined) {
    const used = parseInt(md.videosUsedThisPeriod, 10) || 0;
    creditsRemaining = Math.max(0, planCap - used);
  } else {
    creditsRemaining = planCap;
  }

  let didRollover = false;
  if (periodStartMs > storedPeriodStart) {
    creditsRemaining += planCap;
    didRollover = true;
  }

  // Cap-bump backfill: when the included credit allowance is bumped
  // platform-wide (e.g. monthly went from 4 → 15), top up any active
  // subscriber whose mid-period balance sits below the new cap so
  // they don't have to wait until renewal. Tagged via lastSeededCap
  // so it runs once per cap value per customer — never inflates a
  // user who's already at or above the cap (e.g. heavy top-ups).
  let didCapBackfill = false;
  if (
    md.lastSeededCap !== String(planCap) &&
    creditsRemaining < planCap
  ) {
    creditsRemaining = planCap;
    didCapBackfill = true;
  }

  // Lazy Purchase reporting: if the period just rolled over to an
  // active billing cycle and we haven't reported a Purchase for this
  // period yet, fire CAPI now. Catches both the trial→active
  // conversion (yearly trial ends → first $49 charge) and every
  // subsequent renewal cycle. Idempotency via lastReportedPeriodStart
  // in customer metadata, so multiple page loads in the same period
  // don't double-fire.
  const lastReportedPeriodStart = parseInt(md.lastReportedPeriodStart || '0', 10);
  const shouldReportPurchase =
    didRollover &&
    sub.status === 'active' &&
    storedPeriodStart > 0 && // skip first-ever signup (already reported by /confirm)
    periodStartMs > lastReportedPeriodStart;

  const needsUpdate =
    md.creditsRemaining === undefined ||
    md.videosUsedThisPeriod !== undefined ||
    didRollover ||
    didCapBackfill ||
    md.lastSeededCap !== String(planCap) ||
    md.plan !== plan ||
    storedPeriodStart !== periodStartMs ||
    shouldReportPurchase;

  if (needsUpdate) {
    const nextMd = {
      ...md,
      plan,
      periodStart: String(periodStartMs),
      creditsRemaining: String(creditsRemaining),
      // Always stamp the seed flag with the current cap so the
      // backfill fires once per cap change per customer.
      lastSeededCap: String(planCap),
    };
    if (md.videosUsedThisPeriod !== undefined) nextMd.videosUsedThisPeriod = '';
    if (shouldReportPurchase) nextMd.lastReportedPeriodStart = String(periodStartMs);
    await stripe().customers.update(customerId, { metadata: nextMd });
  }

  if (shouldReportPurchase) {
    const customerEmail = customer && !customer.deleted ? customer.email : undefined;
    const value = PLANS[plan].amountCents / 100;
    sendCapiEvent({
      eventName: 'Purchase',
      eventId: `pur-period-${customerId}-${periodStartMs}`,
      value,
      currency: 'USD',
      email: customerEmail,
      customData: {
        kind: 'subscription',
        plan,
        supabase_user_id: md.supabase_user_id,
        period_start: String(periodStartMs),
      },
    }).catch((err) => {
      console.warn('[entitlement] lazy Purchase CAPI failed', err.message);
    });
  }

  if (sub.status === 'trialing') {
    const used = readTrialUsed(md);
    const remaining = Math.max(0, TRIAL_CREDITS - used);
    // Layer trial credits on top of any top-up credits the user bought
    // mid-trial so they can keep generating after the included 2 are gone.
    const topupCredits = parseInt(md.creditsRemaining || '0', 10) || 0;
    return {
      tier: plan,
      status: 'trialing',
      creditsRemaining: remaining + topupCredits,
      videoCap: TRIAL_CREDITS + topupCredits,
      videosUsed: used,
      canSwap: remaining + topupCredits > 0,
      customerId,
      trialEnd: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    };
  }

  return {
    tier: plan,
    status: sub.status,
    creditsRemaining,
    videoCap: planCap,
    videosUsed: Math.max(0, planCap - creditsRemaining),
    canSwap: creditsRemaining > 0,
    customerId,
  };
}

/**
 * Main entitlement lookup. Pass the Supabase server client + user id.
 * Optionally pass `email` (or the full `user` object) to short-circuit
 * the admin check before touching Stripe.
 */
export async function getEntitlement({ supabase, userId, email, user }) {
  const e = email || user?.email;
  if (isAdminEmail(e)) return adminEntitlement();
  if (!userId) {
    return { tier: 'none', videosUsed: 0, videoCap: 0, creditsRemaining: 0, canSwap: false };
  }
  const customerId = await getStripeCustomerIdForUser(supabase, userId);
  if (!customerId) {
    return { tier: 'none', videosUsed: 0, videoCap: 0, creditsRemaining: 0, canSwap: false };
  }
  try {
    const paid = await readPaidEntitlement(customerId);
    if (paid) return paid;
  } catch (err) {
    console.warn('[entitlement] Stripe lookup failed', err.message);
  }
  return { tier: 'none', videosUsed: 0, videoCap: 0, creditsRemaining: 0, canSwap: false };
}

/**
 * Consume credits on successful generation. For trialing subs, flip
 * the one-shot trialUsed flag instead of decrementing.
 */
export async function decrementCredits(entitlement, amount = 1) {
  if (entitlement?.isAdmin) return;
  if (!entitlement.customerId) return;

  if (entitlement.status === 'trialing') {
    // Spend trial credits first, then top-up credits.
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    let toSpend = Math.max(1, amount);
    let used = readTrialUsed(md);
    let topup = parseInt(md.creditsRemaining || '0', 10) || 0;

    const trialAvail = Math.max(0, TRIAL_CREDITS - used);
    const fromTrial = Math.min(trialAvail, toSpend);
    used += fromTrial;
    toSpend -= fromTrial;

    if (toSpend > 0) {
      const fromTopup = Math.min(topup, toSpend);
      topup -= fromTopup;
      toSpend -= fromTopup;
    }

    await stripe().customers.update(entitlement.customerId, {
      metadata: {
        ...md,
        trialCreditsUsed: String(used),
        trialUsed: '', // clear legacy flag
        creditsRemaining: String(topup),
      },
    });
    return;
  }

  if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const current = parseInt(md.creditsRemaining || '0', 10) || 0;
    const next = Math.max(0, current - Math.max(1, amount));
    await stripe().customers.update(entitlement.customerId, {
      metadata: { ...md, creditsRemaining: String(next) },
    });
  }
}

/**
 * Strict reservation: re-reads the current creditsRemaining from
 * Stripe, ensures it covers the requested amount, then writes the
 * decremented value back. Throws { code: 'INSUFFICIENT', remaining }
 * if the user doesn't have enough credits at the moment of the call.
 *
 * Trial users keep their boolean trialUsed flag (no race possible).
 */
export async function reserveCredits(entitlement, amount = 1) {
  if (entitlement?.isAdmin) return; // unlimited; nothing to reserve
  if (!entitlement.customerId) {
    // Treat "never had a Stripe customer" the same as "has a Stripe
    // customer but no active plan" — both mean the user needs to pay
    // before generating. The API layer maps NO_PLAN to a 402 paywall
    // response; NO_CUSTOMER would have fallen through to a 500.
    const err = new Error('No active plan.');
    err.code = 'NO_PLAN';
    throw err;
  }

  if (entitlement.status === 'trialing') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    let used = readTrialUsed(md);
    let topup = parseInt(md.creditsRemaining || '0', 10) || 0;
    const trialAvail = Math.max(0, TRIAL_CREDITS - used);
    const total = trialAvail + topup;
    if (total < amount) {
      const err = new Error('Insufficient credits.');
      err.code = 'INSUFFICIENT';
      err.remaining = total;
      throw err;
    }
    let toSpend = amount;
    const fromTrial = Math.min(trialAvail, toSpend);
    used += fromTrial;
    toSpend -= fromTrial;
    if (toSpend > 0) {
      topup -= toSpend;
      toSpend = 0;
    }
    await stripe().customers.update(entitlement.customerId, {
      metadata: {
        ...md,
        trialCreditsUsed: String(used),
        trialUsed: '', // clear legacy flag
        creditsRemaining: String(topup),
      },
    });
    return;
  }

  if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const current = parseInt(md.creditsRemaining || '0', 10) || 0;
    if (current < amount) {
      const err = new Error('Insufficient credits.');
      err.code = 'INSUFFICIENT';
      err.remaining = current;
      throw err;
    }
    const next = current - amount;
    await stripe().customers.update(entitlement.customerId, {
      metadata: { ...md, creditsRemaining: String(next) },
    });
    return;
  }

  const err = new Error('No active plan.');
  err.code = 'NO_PLAN';
  throw err;
}

// Track async (vendor-queued) jobs so /api/status can refund credits
// idempotently when the vendor reports failure (e.g. Kling content
// moderation rejecting a queued job after we've already reserved
// credits). Stored in Stripe customer metadata as
// `pendingJobs = "predId1:cost1,predId2:cost2,..."` (capped, FIFO).
const MAX_PENDING_JOBS = 16;

function parsePendingJobs(md) {
  return (md.pendingJobs || '')
    .split(',')
    .filter(Boolean)
    .map((entry) => {
      const [id, cost] = entry.split(':');
      return { id, cost: parseInt(cost, 10) || 0 };
    });
}

function serializePendingJobs(list) {
  return list.slice(0, MAX_PENDING_JOBS).map((j) => `${j.id}:${j.cost}`).join(',');
}

export async function trackPendingJob(entitlement, predictionId, cost) {
  if (entitlement?.isAdmin) return;
  if (!entitlement?.customerId || !predictionId || !cost) return;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const list = parsePendingJobs(md).filter((j) => j.id !== predictionId);
  list.unshift({ id: predictionId, cost });
  await stripe().customers.update(entitlement.customerId, {
    metadata: { ...md, pendingJobs: serializePendingJobs(list) },
  });
}

// Settle a tracked pending job. If `refund` is true and the job is
// still tracked, refund its cost back to the user. Idempotent: a
// second call for the same predictionId is a no-op (the entry is
// already gone). Returns the credit count refunded (0 if none).
export async function settlePendingJob(entitlement, predictionId, { refund }) {
  if (entitlement?.isAdmin) return 0;
  if (!entitlement?.customerId || !predictionId) return 0;
  const customer = await stripe().customers.retrieve(entitlement.customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const list = parsePendingJobs(md);
  const idx = list.findIndex((j) => j.id === predictionId);
  if (idx === -1) return 0;
  const { cost } = list[idx];
  list.splice(idx, 1);
  const updates = { ...md, pendingJobs: serializePendingJobs(list) };

  if (refund && cost > 0) {
    if (entitlement.status === 'trialing') {
      const used = readTrialUsed(md);
      if (used > 0) {
        updates.trialCreditsUsed = String(Math.max(0, used - cost));
        updates.trialUsed = '';
      } else {
        const topup = parseInt(md.creditsRemaining || '0', 10) || 0;
        updates.creditsRemaining = String(topup + cost);
      }
    } else if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
      const current = parseInt(md.creditsRemaining || '0', 10) || 0;
      updates.creditsRemaining = String(current + cost);
    }
  }
  await stripe().customers.update(entitlement.customerId, { metadata: updates });
  return refund ? cost : 0;
}

/**
 * Refund a reservation. Use only when reservation succeeded but the
 * downstream work failed.
 */
export async function refundCredits(entitlement, amount = 1) {
  if (entitlement?.isAdmin) return;
  if (!entitlement.customerId) return;

  if (entitlement.status === 'trialing') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const used = readTrialUsed(md);
    // Refund to trial pool first if anything was used; otherwise top-ups.
    if (used > 0) {
      const next = Math.max(0, used - Math.max(1, amount));
      await stripe().customers.update(entitlement.customerId, {
        metadata: { ...md, trialCreditsUsed: String(next), trialUsed: '' },
      });
    } else {
      const topup = parseInt(md.creditsRemaining || '0', 10) || 0;
      await stripe().customers.update(entitlement.customerId, {
        metadata: { ...md, creditsRemaining: String(topup + Math.max(1, amount)) },
      });
    }
    return;
  }

  if (entitlement.tier === 'monthly' || entitlement.tier === 'pro' || entitlement.tier === 'yearly') {
    const customer = await stripe().customers.retrieve(entitlement.customerId);
    const md = customer && !customer.deleted ? customer.metadata || {} : {};
    const current = parseInt(md.creditsRemaining || '0', 10) || 0;
    const next = current + Math.max(1, amount);
    await stripe().customers.update(entitlement.customerId, {
      metadata: { ...md, creditsRemaining: String(next) },
    });
  }
}

export async function addCredits(customerId, credits) {
  if (!customerId || !credits || credits <= 0) return;
  const customer = await stripe().customers.retrieve(customerId);
  const md = customer && !customer.deleted ? customer.metadata || {} : {};
  const current = parseInt(md.creditsRemaining || '0', 10) || 0;
  const next = current + credits;
  await stripe().customers.update(customerId, {
    metadata: { ...md, creditsRemaining: String(next) },
  });
}

/**
 * Link a Stripe customer to a Supabase user's profile row.
 * Called from /api/checkout/confirm after a successful subscription purchase.
 */
export async function linkStripeCustomerToProfile(supabase, userId, stripeCustomerId) {
  const { error } = await supabase
    .from('profiles')
    .upsert({ id: userId, stripe_customer_id: stripeCustomerId }, { onConflict: 'id' });
  if (error) {
    console.error('[entitlement] failed to link profile', error.message);
    throw new Error(`Could not link Stripe customer: ${error.message}`);
  }
}
