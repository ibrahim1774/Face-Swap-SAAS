import Stripe from 'stripe';

/*
 * Direct refund of video-editor credits from the worker.
 *
 * Mirrors lib/videoEditorCredits.js#refundVideoEditorCredits but runs
 * in worker-side Node without depending on Next/lib. We can't import
 * the Next.js lib directly because worker/ has its own package.json
 * and lives at deploy-time on Fly, not on Vercel.
 *
 * Adds `amount` credits back to the customer's
 * `videoEditorCreditsRemaining` metadata field.
 */

let cached = null;
function stripe() {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set on the worker.');
  cached = new Stripe(key, { apiVersion: '2024-06-20' });
  return cached;
}

function readInt(value) {
  if (value === undefined || value === null || value === '') return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export async function refundVideoEditorCredits({ customerId, amount }) {
  if (!customerId) return;
  const add = Math.max(1, Math.ceil(Number(amount) || 0));
  const customer = await stripe().customers.retrieve(customerId);
  if (!customer || customer.deleted) return;
  const md = customer.metadata || {};
  const current = readInt(md.videoEditorCreditsRemaining);
  await stripe().customers.update(customerId, {
    metadata: { ...md, videoEditorCreditsRemaining: String(current + add) },
  });
}
