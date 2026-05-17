import {
  stripe,
  getOrCreatePrice,
  getOrCreateTopupPrice,
  PLANS,
  TOPUPS,
} from '../../lib/stripe';
import { getUserFromRequest, getSupabaseAdmin } from '../../lib/supabaseServer';
import { sendCapiEvent } from '../../lib/meta';
import { linkStripeCustomerToProfile } from '../../lib/entitlement';

/*
 * Find an existing Stripe customer for this Supabase user. Returns
 * the customer id, or null if none found. Never creates.
 *
 * Three lookups, in order:
 *   1. profiles.stripe_customer_id (authoritative link). If the
 *      stored ID exists in Stripe and isn't deleted, reuse it.
 *   2. Stripe Customer Search by metadata.supabase_user_id.
 *   3. Stripe customers.list by email — adopt the best-fit match
 *      (prefer one whose metadata already names this user).
 *
 * Customer creation is deferred entirely to Stripe Checkout's
 * payment-completion flow. We never call customers.create on click.
 *
 * If a match is found, we idempotently stamp supabase_user_id on
 * its metadata and upsert profile.stripe_customer_id so subsequent
 * calls converge on the same customer.
 */
async function findStripeCustomerForUser({ admin, userId, email }) {
  let customerId = null;

  // 1) Profile lookup + Stripe existence check
  try {
    const { data } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', userId)
      .maybeSingle();
    if (data?.stripe_customer_id) {
      try {
        const c = await stripe().customers.retrieve(data.stripe_customer_id);
        if (c && !c.deleted) customerId = c.id;
      } catch (retrieveErr) {
        console.warn(
          '[customer-find] linked customer not in Stripe, will re-resolve',
          retrieveErr.message
        );
      }
    }
  } catch (lookupErr) {
    console.warn('[customer-find] profile lookup failed', lookupErr.message);
  }

  // 2) Stripe Customer Search by metadata.supabase_user_id
  if (!customerId) {
    try {
      const search = await stripe().customers.search({
        query: `metadata['supabase_user_id']:'${userId}'`,
        limit: 1,
      });
      if (search.data.length > 0) customerId = search.data[0].id;
    } catch (searchErr) {
      console.warn('[customer-find] metadata search failed', searchErr.message);
    }
  }

  // 3) Email match — adopt the best-fit existing customer
  if (!customerId && email) {
    try {
      const list = await stripe().customers.list({ email, limit: 100 });
      if (list.data.length > 0) {
        const exactMatch = list.data.find(
          (c) => c.metadata?.supabase_user_id === userId
        );
        const unowned = list.data.find((c) => !c.metadata?.supabase_user_id);
        const chosen = exactMatch || unowned || list.data[0];
        customerId = chosen.id;
      }
    } catch (listErr) {
      console.warn('[customer-find] email list failed', listErr.message);
    }
  }

  if (!customerId) return null;

  // Idempotently stamp supabase_user_id on the customer's metadata.
  try {
    const customerNow = await stripe().customers.retrieve(customerId);
    const md = customerNow && !customerNow.deleted ? customerNow.metadata || {} : {};
    if (md.supabase_user_id !== userId) {
      await stripe().customers.update(customerId, {
        metadata: { ...md, supabase_user_id: userId },
      });
    }
  } catch (mdErr) {
    console.warn('[customer-find] metadata sync failed', mdErr.message);
  }

  // Authoritative link in our profiles table.
  try {
    await linkStripeCustomerToProfile(admin, userId, customerId);
  } catch (linkErr) {
    console.warn(
      '[customer-find] profile link failed — search/email fallback will still find this customer next time',
      linkErr.message
    );
  }

  return customerId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Subscription path supports anonymous users (pay first, sign up
  // after). Top-up requires auth because credits attach to an
  // existing account.
  const session = await getUserFromRequest(req, res);
  const isAnon = !session;
  const email = session?.user?.email;

  const { plan, mode, pack, returnTo, surface } = req.body || {};

  if (mode === 'topup' && isAnon) {
    return res.status(401).json({ error: 'Sign in required to buy a top-up.' });
  }

  const origin =
    process.env.APP_URL ||
    (req.headers.origin && req.headers.origin.replace(/\/$/, '')) ||
    `https://${req.headers.host}`;

  // Optional: where to send the user after dashboard finishes
  // confirming the Stripe session. Validated to be a same-origin
  // path so the redirect can never escape to an external URL.
  const safeReturnTo =
    typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//')
      ? returnTo
      : '';
  const returnQuery = safeReturnTo ? `&returnTo=${encodeURIComponent(safeReturnTo)}` : '';

  try {
    if (mode === 'topup') {
      if (!TOPUPS[pack]) {
        return res.status(400).json({ error: 'Invalid top-up pack.' });
      }
      const price = await getOrCreateTopupPrice(pack);

      // Find an existing Stripe customer (never create on click).
      // If none exists, Stripe Checkout creates one at payment
      // completion via customer_creation: 'always' — we need a
      // customer attached so the credit ledger (stored in customer
      // metadata) has somewhere to land.
      const admin = getSupabaseAdmin();
      const customerId = await findStripeCustomerForUser({
        admin,
        userId: session.user.id,
        email,
      });

      const checkout = await stripe().checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [{ price: price.id, quantity: 1 }],
        ...(customerId
          ? { customer: customerId }
          : { customer_creation: 'always' }),
        success_url: `${origin}/dashboard?paid=1&session_id={CHECKOUT_SESSION_ID}${returnQuery}`,
        cancel_url: `${origin}/dashboard?paid=0`,
        allow_promotion_codes: true,
        billing_address_collection: 'auto',
        metadata: { supabase_user_id: session.user.id },
      });
      const value = TOPUPS[pack].amountCents / 100;
      const eventId = `ic-${checkout.id}`;
      sendCapiEvent({
        eventName: 'InitiateCheckout',
        eventId,
        value,
        currency: 'USD',
        email,
        req,
        customData: {
          kind: 'topup',
          pack,
          supabase_user_id: session.user.id,
        },
      }).catch(() => {});
      return res.status(200).json({
        url: checkout.url,
        meta: { eventName: 'InitiateCheckout', eventId, value, currency: 'USD' },
      });
    }

    if (plan !== 'monthly' && plan !== 'pro' && plan !== 'yearly') {
      return res.status(400).json({
        error: "Expected { plan: 'monthly'|'pro'|'yearly' } or { mode: 'topup', pack: 's'|'m'|'l' }.",
      });
    }

    // Anonymous subscription: route success_url through the claim-
    // and-create-account flow on /sign-up. The user signs up with
    // the same email Stripe collected; backend then links the
    // Stripe customer to the new Supabase user.
    const successPath = isAnon
      ? `/sign-up?session_id={CHECKOUT_SESSION_ID}${returnQuery}`
      : `/dashboard?paid=1&session_id={CHECKOUT_SESSION_ID}${returnQuery}`;

    const subMetadata = isAnon
      ? { pending_supabase_link: 'true' }
      : { supabase_user_id: session.user.id };

    // Subscription flow: charge the plan price immediately. No trial,
    // no deposit — just a clean recurring sub. Monthly $5/mo, yearly
    // $29/yr. Stripe Checkout displays the renewal terms natively.
    // Surface picks the per-surface Product variant so the checkout
    // page header shows the right name ("Glow Up Yearly Plan",
    // "AI Interior Yearly Plan", etc). Same price, same entitlement.
    const ALLOWED_SURFACES = new Set(['default', 'glow-up', 'interior-design', 'video-editor']);
    const safeSurface = ALLOWED_SURFACES.has(surface) ? surface : 'default';
    const price = await getOrCreatePrice(plan, safeSurface);

    // For authed users, look up (never create) an existing Stripe
    // customer. If one is found we pass `customer: customerId` so
    // Stripe reuses it. If not, we omit both `customer` and
    // `customer_email` — Stripe Checkout collects the email on its
    // own page and creates the Customer only at payment completion.
    // Anonymous flow does the same (no Supabase user yet to look
    // up). Trade-off: first-time subscribers type their email at
    // Stripe's page instead of having it prefilled, in exchange
    // for not littering Stripe with customers from abandoned
    // checkouts.
    let subCustomerId = null;
    if (!isAnon) {
      const admin = getSupabaseAdmin();
      subCustomerId = await findStripeCustomerForUser({
        admin,
        userId: session.user.id,
        email,
      });
    }

    const checkout = await stripe().checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: price.id, quantity: 1 }],
      ...(subCustomerId ? { customer: subCustomerId } : {}),
      success_url: `${origin}${successPath}`,
      cancel_url: `${origin}${isAnon ? '/' : '/dashboard?paid=0'}`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      subscription_data: {
        metadata: subMetadata,
      },
      metadata: subMetadata,
    });

    // Pixel value: actual cents charged today.
    const value = PLANS[plan].amountCents / 100;
    const eventId = `ic-${checkout.id}`;
    sendCapiEvent({
      eventName: 'InitiateCheckout',
      eventId,
      value,
      currency: 'USD',
      email,
      req,
      customData: {
        kind: 'subscription',
        plan,
        ...(session?.user?.id ? { supabase_user_id: session.user.id } : { anonymous: 1 }),
      },
    }).catch(() => {});
    return res.status(200).json({
      url: checkout.url,
      meta: { eventName: 'InitiateCheckout', eventId, value, currency: 'USD' },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
