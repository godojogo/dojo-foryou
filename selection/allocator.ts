// Allocator — turns intensity into feed composition. Each content filter gets a
// share of slots ∝ its intensity; trending (when on) claims CONFIG.trendingShare
// and filters split the rest. This is where the sliders literally shape the feed.

import { CONFIG } from '../lib/config.ts';
import { UserContext } from '../lib/types.ts';

export const TRENDING_KEY = '__trending__';
export const filterKey = (filterId?: string) => `f:${filterId}`;

// Target share per bucket key that actually has candidates present.
//
// Composition rules:
//   - filters only            -> 100% split across filters by intensity
//   - filters + recommend on  -> recommendations take CONFIG.trendingShare,
//                                filters split the remainder by intensity
//   - NO filters + recommend on -> 100% recommendations (pure discovery feed)
export function computeShares(ctx: UserContext, presentKeys: Set<string>): Map<string, number> {
  const shares = new Map<string, number>();
  const hasFilters = ctx.filters.some((f) => presentKeys.has(filterKey(f.id)));

  // With no content filters, recommendations own the whole feed.
  const recommendShare = !hasFilters ? 1 : CONFIG.trendingShare;
  const filterTotal = ctx.trendingOn ? 1 - recommendShare : 1;
  const intensitySum = ctx.filters.reduce((s, f) => s + f.intensity, 0) || 1;

  for (const f of ctx.filters) {
    const k = filterKey(f.id);
    if (presentKeys.has(k)) shares.set(k, filterTotal * (f.intensity / intensitySum));
  }
  if (ctx.trendingOn && presentKeys.has(TRENDING_KEY)) {
    shares.set(TRENDING_KEY, recommendShare);
  }
  return shares;
}
