// All tunables in one place. The whole point of v2 over the single-file v12 is
// that ranking behaviour is legible and adjustable here, not buried in logic.

export const CONFIG = {
  vectorDim: 1536,

  // ── Candidate retrieval ──────────────────────────────────────────────
  perFilterTopK: 60,
  trendingTopK: 80,
  maxCandidates: 400,

  // ── Source mix ───────────────────────────────────────────────────────
  // When the trending toggle is ON it claims this share of the feed; the rest
  // is split across content filters by intensity. (Future: per-user slider.)
  trendingShare: 0.30,

  // ── Scorer weights (the "Weighted Scorer") ───────────────────────────
  weights: {
    similarity: 1.0, // dominant — keeps the feed on-filter
    velocity: 0.35,  // engagement velocity (quality)
    recency: 0.25,   // freshness
  },

  velocity: {
    like: 3.0,
    comment: 5.0,
    view: 0.2,
  },

  recencyTauHours: 72,

  // ── Seen cooldown (decaying downrank, NOT a hard filter) ─────────────
  seen: {
    weight: 1.2,
    tauDays: 4,
    windowDays: 10,
  },

  authorDiversityDecay: 0.5,

  contextTtlSeconds: 300,

  // ── Mushin (recommendation engine) ───────────────────────────────────
  mushin: {
    // yomi (user model): how many distinct interest seeds to derive, and how
    // dissimilar two seeds must be to count as separate interests.
    interestSeeds: 4,
    diversityThreshold: 0.72,
    perSeedTopK: 40,

    // negative profile -> a penalty on candidates similar to what you disliked.
    negativeTopK: 80,
    negativeWeight: 0.85,

    // reserve part of Mushin's output for genuine discovery so the feed never
    // becomes a hall of mirrors.
    explorationQuota: 0.15,
    outputSize: 150,

    // blend weights across the signals.
    signalWeights: {
      tasteMatch: 1.0,
      collaborative: 0.8,
      rising: 0.5,
      exploration: 0.4,
      affinity: 0.6,
    },
  },
} as const;
