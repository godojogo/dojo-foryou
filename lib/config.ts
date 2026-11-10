// All tunables in one place: ranking behaviour is legible and adjustable here, not buried in
// logic. The SQL sources' sizes and windows live in foryou_context_v3 and the pool refresh.

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

  // ── Avoid vector (the "I looked but it made me uncomfortable" defence) ──
  // Relative, not absolute: a blend of everything rejected sits close to the average post, so
  // only candidates nearer to it than most of the others are pushed down.
  negative: {
    weight: 0.5,
  },

  // ── Seen cooldown (decaying downrank, NOT a hard filter) ─────────────
  seen: {
    weight: 1.2,
    tauDays: 4,
    windowDays: 10,
  },

  authorDiversityDecay: 0.5,

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

  // Seeded jitter so a new session reorders near-ties without overturning clear winners.
  jitter: 0.04,
} as const;
