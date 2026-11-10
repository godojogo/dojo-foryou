// Allocator — turns intensity into feed composition. Each content filter gets a
// share of slots ∝ its intensity; discovery (when either source card is on) claims
// CONFIG.discoveryShare and filters split the rest. This is where the sliders literally
// shape the feed.

import { CONFIG } from '../lib/config.ts';
import { UserContext, anySourceOn } from '../lib/types.ts';

export const DISCOVERY_KEY = '__discovery__';
export const filterKey = (filterId?: string) => `f:${filterId}`;

// Target share per bucket key that actually has candidates present.
//
// Composition rules:
//   - filters only            -> 100% split across filters by intensity
//   - filters + discovery on  -> discovery takes CONFIG.discoveryShare,
//                                filters split the remainder by intensity
//   - NO filters + discovery on -> 100% discovery (pure discovery feed)
//
// "Discovery" is either feed-source card being on; which signals actually ran is decided
// upstream in the Mushin engine.
export function computeShares(ctx: UserContext, presentKeys: Set<string>): Map<string, number> {
  const shares = new Map<string, number>();
  const hasFilters = ctx.filters.some((f) => presentKeys.has(filterKey(f.id)));
  const discoveryOn = anySourceOn(ctx);

  // With no content filters, discovery owns the whole feed.
  const recommendShare = !hasFilters ? 1 : CONFIG.discoveryShare;
  const filterTotal = discoveryOn ? 1 - recommendShare : 1;
  const intensitySum = ctx.filters.reduce((s, f) => s + f.intensity, 0) || 1;

  for (const f of ctx.filters) {
    const k = filterKey(f.id);
    if (presentKeys.has(k)) shares.set(k, filterTotal * (f.intensity / intensitySum));
  }
  if (discoveryOn && presentKeys.has(DISCOVERY_KEY)) {
    shares.set(DISCOVERY_KEY, recommendShare);
  }
  return shares;
}
