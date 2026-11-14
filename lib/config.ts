// All tunables in one place: ranking behaviour is legible and adjustable here, not buried in
// logic. The SQL sources' sizes and windows live in foryou_context_v3 and the pool refresh.
//
// These are the defaults. A request ranks with `cfg()`: the defaults with the viewer's experiment
// variants applied (lib/experiments.ts), scoped to that request.

import { AsyncLocalStorage } from 'node:async_hooks';

export const CONFIG = {
  // ── Vector retrieval (Pinecone) ──────────────────────────────────────
  retrieval: {
    perFilterTopK: 60,
    perSeedTopK: 40,
    // A topic tab is one filter on its own, so it retrieves deeper.
    topicTopK: 300,
    // A filter's candidate must be about the filter: the same floor its topic tab uses
    // (get_topic_feed_v2), calibrated on the v2 analyses (on-topic 0.41-0.51).
    topicFloor: 0.40,
  },

  // ── Relevance calibration (experiment: relevance_calibration) ───────
  // A filter's matches sit in a narrow cosine band (5th-95th percentile 0.31-0.47 on served
  // lists), so raw similarity moved a score by ~0.1 while quality moved it by 0.35 and the seen
  // penalty by 1.2: the best match and a borderline one ranked alike. Calibrated, a filter post's
  // relevance is its cosine mapped from [low, high] onto 0..1, the scale discovery's blended
  // score is already on. Off by default; the raw cosine is still recorded as the signal.
  relevance: {
    calibrate: false,
    low: 0.30,
    high: 0.50,
  },

  // ── Source mix ───────────────────────────────────────────────────────
  // When either discovery card is ON, discovery claims this share of the feed; the rest is
  // split across content filters by intensity.
  discoveryShare: 0.30,

  // ── Base score ───────────────────────────────────────────────────────
  weights: {
    similarity: 1.0, // dominant — keeps the feed on-filter
    quality: 0.35,   // Σ value × P(action), see engagement below
    recency: 0.25,   // freshness
    inNetwork: 0.1,  // the viewer follows the author
  },

  // Expected value of showing a post: each action's probability per impression, estimated
  // from the post's own counts with a prior (so 1 like from 1 view is not "perfect" and a post
  // nobody has seen yet is "average", not "worthless"). Value weights say what an action is
  // worth relative to a like; a negative action subtracts.
  engagement: {
    priorImpressions: 20,
    actions: {
      like:     { value: 1.0, prior: 0.05 },
      comment:  { value: 3.0, prior: 0.01 },
      save:     { value: 4.0, prior: 0.01 },
      negative: { value: -12.0, prior: 0.002 },
    },
  },

  recencyTauHours: 72,

  // ── Contention (valued interactions, not reactions) ──────────────────
  // A post that divides people (replies out of proportion to approval, regret per view) loses
  // `weight` x contention, and its comments count toward quality only in proportion to how calm
  // it is: replies are what divisive posts generate most, so counting them at face value is the
  // "meaningful social interactions" mistake. The weekly fit proposes its own weight.
  contention: {
    weight: 0.3,
  },

  // ── Avoid vector (the "I looked but it made me uncomfortable" defence) ──
  // Relative, not absolute: a blend of everything rejected sits close to the average post, so
  // only candidates nearer to it than most of the others are pushed down.
  negative: {
    weight: 0.5,
  },

  // ── Seen cooldown (decaying downrank, NOT a hard filter) ─────────────
  // On top of the downrank, posts seen in the last `freshHours` are taken out of the running
  // order: dropped when at least `excludeWhenUnseen` (a page) of unseen posts remain, otherwise
  // placed after every unseen post ("you're all caught up"), so a seen post can't take one of a
  // filter's top slots. Past `freshHours` only the decaying downrank applies, so good posts resurface.
  seen: {
    weight: 1.2,
    tauDays: 4,
    windowDays: 10,
    freshHours: 24,
    excludeWhenUnseen: 30,
  },

  authorDiversityDecay: 0.5,
  // A repeat's diversity penalty is measured against at least this score (about a weak post's),
  // so posts at or below zero still move down, by a bounded amount (scoring/types.ts repeatPenalty).
  diversityFloor: 0.25,
  // Each further post on a topic already ranked above keeps this share of its score: gentler
  // than authors, since a viewer's filter is itself a topic and should still fill its slots.
  topicDiversityDecay: 0.8,

  // ── Mushin blend ─────────────────────────────────────────────────────
  mushin: {
    // reserve part of Mushin's output for genuine discovery so the feed never becomes a hall
    // of mirrors.
    explorationQuota: 0.15,
    outputSize: 150,
    signalWeights: {
      tasteMatch: 1.0,
      collaborative: 0.8,
      rising: 0.5,
      exploration: 0.4,
      affinity: 0.6,
    },
  },

  // How far (in slots) a source may run ahead of or behind its share so the better post can go
  // first. 0 is a strict quota rotation; larger trades the slider mix for quality.
  shareSlack: 1,
  // Posts scoring below this (similar to what the viewer rejected, weak and unengaged) follow
  // every post at or above it, whatever their filter's share.
  qualityFloor: 0,

  // ── Steering (lib/steering.ts, scoring/steeringScorer.ts) ─────────────
  // Per-format multipliers the viewer set (0 = none, 1 = as is, 2 = twice as much).
  formats: { video: 1, photo: 1, text: 1, link: 1, poll: 1, canvas: 1, other: 1 },
  steering: {
    formatWeight: 0.4,     // score change = formatWeight x ln(multiplier)
    muteWeight: 1.5,       // full penalty of a mute at strength 1 on a post squarely about it
    // Calibrated on a muted "Art" against real candidates: art posts 0.37-0.48, unrelated music
    // and dance posts 0.30-0.33. Full at the filters' own topic floor (0.40), so "never" removes
    // exactly what a filter for that topic would have brought in.
    muteNear: 0.33,        // cosine where a mute starts to apply ...
    muteFar: 0.40,         // ... and where it applies fully
    hardMuteStrength: 0.95, // a mute this strong is "never": posts squarely about it are dropped
  },

  // Seeded jitter so a new session reorders near-ties without overturning clear winners.
  jitter: 0.04,
} as const;

export type Config = typeof CONFIG;

const scope = new AsyncLocalStorage<Config>();

/** The config this request ranks with. */
export const cfg = (): Config => scope.getStore() ?? CONFIG;

/** Run `fn` (and everything it awaits) with `config`. */
export const withConfig = <T>(config: Config, fn: () => T): T => scope.run(config, fn);

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * `base` with `overrides` merged in: objects key by key, anything else replaced. Only keys `base`
 * already has are taken, with the same kind of value, so a typo in an experiment can't add a
 * setting or turn a number into a string.
 */
export function mergeConfig(base: Config, overrides: Plain): Config {
  const merge = (b: Plain, o: Plain): Plain => {
    const out: Plain = { ...b };
    for (const [k, v] of Object.entries(o)) {
      if (!(k in b)) continue;
      if (isPlain(b[k]) && isPlain(v)) out[k] = merge(b[k] as Plain, v);
      else if (typeof v === typeof b[k]) out[k] = v;
    }
    return out;
  };
  return merge(base as unknown as Plain, overrides) as unknown as Config;
}
