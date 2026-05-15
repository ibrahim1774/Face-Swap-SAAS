/*
 * Haelabs namespace shim — mirrors the surface of ariyalab's
 * lib/metaKeys.js so files ported over from ariyalab compile
 * unchanged. Haelabs uses LEGACY unnamespaced Stripe metadata field
 * names (creditsRemaining, periodStart, etc.) and raw event IDs for
 * Meta CAPI deduplication, so KEY just maps to the legacy strings
 * and nsEventId is a no-op passthrough.
 */
export const META_NS = 'haelabs';

export const KEY = {
  credits:           'creditsRemaining',
  imageCredits:      'imageCreditsRemaining',
  imagePeriodStart:  'imagePeriodStart',
  lastSeededCap:     'lastSeededCap',
  pendingJobs:       'pendingJobs',
  periodStart:       'periodStart',
  videosUsedThisPeriod: 'videosUsedThisPeriod',
  plan:              'plan',
  trialCreditsUsed:  'trialCreditsUsed',
  trialUsed:         'trialUsed',
  lastReportedPeriodStart: 'lastReportedPeriodStart',
  processedSessions: 'processedSessions',
  shared: {
    supabaseUserId:      'supabase_user_id',
    pendingSupabaseLink: 'pending_supabase_link',
  },
};

export function nsEventId(rawId) {
  return rawId;
}
