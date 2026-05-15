import { stripe } from '../../../lib/stripe';
import { getUserFromRequest } from '../../../lib/supabaseServer';

/*
 * One-time credit migration when Haelabs switched from the old
 * "1 credit = 1 generation" credit math to the new Seedance-priced
 * scale (4s 480p silent = 28 credits). Multiplies every customer's
 * `creditsRemaining` by SCALE (28) so the number of generations they
 * can still do stays the same.
 *
 * Idempotent — sets `migratedScale28` = 'true' on the customer's
 * metadata so re-running is safe (already-migrated customers are
 * skipped).
 *
 * Admin-only (ADMIN_EMAILS env). Run via:
 *   curl -X POST https://haelabs.live/api/admin/migrate-credits \
 *     -H 'cookie: <admin-session-cookie>'
 *
 * Optional body: { dryRun: true } to count what would change without
 * writing.
 *
 * Only video credits are scaled. Image credits (Glow Up / Interior)
 * are unchanged — that pool is still 1 image = 1 credit on both old
 * and new systems.
 */

const SCALE = 28;
const FLAG_FIELD = 'migratedScale28';

const DEFAULT_ADMIN_EMAILS = ['ibrahim3709@gmail.com'];
function adminEmails() {
  const raw = process.env.ADMIN_EMAILS;
  if (raw && raw.trim()) {
    return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return DEFAULT_ADMIN_EMAILS.map((s) => s.toLowerCase());
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });
  const callerEmail = (session.user.email || '').toLowerCase();
  if (!adminEmails().includes(callerEmail)) {
    return res.status(403).json({ error: 'Admin only.', code: 'NOT_ADMIN' });
  }

  const { dryRun = false } = req.body || {};
  const s = stripe();

  const report = {
    scanned: 0,
    migrated: 0,
    skippedAlreadyMigrated: 0,
    skippedNoBalance: 0,
    failures: [],
    sample: [],
  };

  // Paginate the whole Stripe customers list.
  let startingAfter = null;
  // Safety bound — if we ever have more than 10,000 customers, the
  // migration should be re-thought anyway.
  for (let page = 0; page < 100; page += 1) {
    const params = { limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    const list = await s.customers.list(params);
    if (!list.data || list.data.length === 0) break;
    for (const c of list.data) {
      report.scanned += 1;
      const md = c.metadata || {};
      if (md[FLAG_FIELD] === 'true') {
        report.skippedAlreadyMigrated += 1;
        continue;
      }
      const cur = parseInt(md.creditsRemaining || '0', 10) || 0;
      if (cur <= 0) {
        // Nothing to scale. Still mark as migrated so the flag is set
        // and we don't keep re-scanning empty customers.
        if (!dryRun) {
          try {
            await s.customers.update(c.id, {
              metadata: { ...md, [FLAG_FIELD]: 'true' },
            });
          } catch (err) {
            report.failures.push({ id: c.id, email: c.email, error: err.message });
            continue;
          }
        }
        report.skippedNoBalance += 1;
        continue;
      }
      const next = cur * SCALE;
      if (!dryRun) {
        try {
          await s.customers.update(c.id, {
            metadata: { ...md, creditsRemaining: String(next), [FLAG_FIELD]: 'true' },
          });
        } catch (err) {
          report.failures.push({ id: c.id, email: c.email, error: err.message });
          continue;
        }
      }
      report.migrated += 1;
      if (report.sample.length < 25) {
        report.sample.push({ id: c.id, email: c.email, before: cur, after: next });
      }
    }
    if (!list.has_more) break;
    startingAfter = list.data[list.data.length - 1].id;
  }

  return res.status(200).json({
    ok: true,
    dryRun,
    scale: SCALE,
    flagField: FLAG_FIELD,
    ...report,
  });
}
