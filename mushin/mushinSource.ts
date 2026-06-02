// ─── MUSHIN ──────────────────────────────────────────────────────────────────
// mushin (無心, "no-mind") — the instinctive, behavioral recommendation engine.
// It learns from what the user genuinely endorses (not just what they stared at)
// and flows them toward more of it, plus real discovery.
//
// This file is the SOURCE wrapper — it exposes Mushin to the pipeline as a
// CandidateSource. The intelligence lives in:
//   yomi.ts            — the user model (multi-interest + negative profile)
//   signals/           — taste-match, collaborative, rising, exploration, affinity
//   blend.ts           — weighted blend − negatives + exploration quota
//   engine.ts          — orchestrates the above

import { CandidateSource } from '../lib/source.ts';
import { runMushin } from './engine.ts';

export const mushinSource: CandidateSource = {
  name: 'mushin',
  enabled: (ctx) => ctx.trendingOn,
  retrieve: (ctx, { supabase }) => runMushin(ctx, supabase),
};
