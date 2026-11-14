// Steering — a person's feed recipe (public.feed_preferences, feed_mutes, content_filters; read by
// foryou_context_v4) compiled into the ranker's own settings.
//
// Every dial runs 0..1 with 0.5 meaning "as the defaults rank". Only dials moved off the middle
// override anything, so a viewer who hasn't steered still ranks with their experiment variants.
// The mapping keeps 0.5 exactly at today's defaults (lib/config.ts):
//
//   following    weights.inNetwork                 0.2 x d          (0.5 -> 0.1)
//   communities  mushin.signalWeights.affinity     1.2 x d          (0.5 -> 0.6)
//   discovery    discoveryShare                    0.1 + 0.4 x d    (0.5 -> 0.3; 0 = off, in SQL)
//   trending     mushin.signalWeights.rising       1.0 x d          (0.5 -> 0.5; 0 = off, in SQL)
//   calm         contention.weight                 0.6 x d          (0.5 -> 0.3)
//   novelty      seen.weight                       0.6 + 1.2 x d    (0.5 -> 1.2)
//                authorDiversityDecay              0.7 - 0.4 x d    (0.5 -> 0.5)
//                mushin.explorationQuota           0.3 x d          (0.5 -> 0.15)
//   freshness    weights.recency                   0.5 x d          (0.5 -> 0.25)
//                recencyTauHours                   24 + 96 x (1-d)  (0.5 -> 72)
//
// Formats (0..2, 1 = as is) and mutes are applied per post by scoring/steeringScorer.ts and the
// gate (filters/chain.ts): a format at 0 and a "never" mute leave the feed entirely.

export interface Steering {
  dials: Record<string, number>;
  formats: Record<string, number>;
}

type Plain = Record<string, unknown>;

const moved = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v - 0.5) > 0.005;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Config overrides for the dials that were moved, plus the formats; merge over the request's config. */
export function compileSteering(steering: Steering | null | undefined): Plain {
  const out: Plain = {};
  if (!steering) return out;
  const d = steering.dials ?? {};
  const weights: Plain = {};
  const mushinWeights: Plain = {};
  const mushin: Plain = {};

  if (moved(d.following)) weights.inNetwork = 0.2 * clamp01(d.following);
  if (moved(d.communities)) mushinWeights.affinity = 1.2 * clamp01(d.communities);
  if (moved(d.discovery) && d.discovery > 0) out.discoveryShare = 0.1 + 0.4 * clamp01(d.discovery);
  if (moved(d.trending) && d.trending > 0) mushinWeights.rising = 1.0 * clamp01(d.trending);
  if (moved(d.calm)) out.contention = { weight: 0.6 * clamp01(d.calm) };
  if (moved(d.novelty)) {
    const n = clamp01(d.novelty);
    out.seen = { weight: 0.6 + 1.2 * n };
    out.authorDiversityDecay = 0.7 - 0.4 * n;
    mushin.explorationQuota = 0.3 * n;
  }
  if (moved(d.freshness)) {
    const f = clamp01(d.freshness);
    weights.recency = 0.5 * f;
    out.recencyTauHours = 24 + 96 * (1 - f);
  }

  const formats: Plain = {};
  for (const [k, v] of Object.entries(steering.formats ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - 1) > 0.005) formats[k] = Math.min(2, Math.max(0, v));
  }

  if (Object.keys(weights).length) out.weights = weights;
  if (Object.keys(mushinWeights).length) mushin.signalWeights = mushinWeights;
  if (Object.keys(mushin).length) out.mushin = mushin;
  if (Object.keys(formats).length) out.formats = formats;
  return out;
}

/** The format group a post_type steers as. */
export function formatOf(postType: string | null | undefined): string {
  const t = String(postType ?? '').toLowerCase();
  if (t.includes('video')) return 'video';
  if (t === 'photo' || t === 'image' || t === 'gallery') return 'photo';
  if (t === 'text' || t === 'thread') return 'text';
  if (t === 'link' || t === 'newsarticle') return 'link';
  if (t === 'poll') return 'poll';
  if (t === 'canvas') return 'canvas';
  return 'other';
}
