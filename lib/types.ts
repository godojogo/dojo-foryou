// Shared types that flow through the feed pipeline.

export interface FeedRequest {
  user_profile_id: string;
  limit?: number;
  offset?: number;
  /** Fixes the order for one feed session: same seed, same list, so pages never overlap. */
  seed?: number;
  /** Post ids the caller already has and does not want again (refresh). */
  exclude_post_ids?: string[];
  /** A topic tab: the viewer's content filter of this name, ranked on its own. */
  topic?: string;
}

export interface FilterContext {
  id: string;
  intensity: number;
}

/**
 * Which card in the client's feed-source carousel a signal belongs to. Each card is its own
 * switch: Trending runs `rising`, Recommended runs the rest.
 */
export type FeedSourceKind = 'trending' | 'recommended';

export interface UserContext {
  profileId: string;
  filters: FilterContext[];
  trendingOn: boolean;
  recommendOn: boolean;
  /** How many distinct interests Yomi found in the user's endorsements. */
  interestSeeds: number;
}

/** True when either discovery source is enabled — i.e. Mushin has anything to do. */
export const anySourceOn = (ctx: UserContext): boolean => ctx.trendingOn || ctx.recommendOn;

/** Mushin's discovery signals, as foryou_candidates_v3 names them. */
export type SignalName = 'tasteMatch' | 'collaborative' | 'rising' | 'exploration' | 'affinity';

/** One row from retrieval: a post, the source that found it, and that source's raw score. */
export interface RawCandidate {
  postId: string;
  source: 'filter' | SignalName;
  filterId: string | null;
  intensity: number;
  score: number;
}

/** A candidate as Selection sees it: from one filter (Kata) or from discovery (Mushin). */
export interface Candidate {
  postId: string;
  source: 'filter' | 'discovery';
  filterId?: string; // which filter retrieved it (for allocation)
  intensity: number; // intensity of the owning source
  similarity: number; // cosine to the filter, or Mushin's blended 0..1 score
}

export interface CandidateFeatures {
  postId: string;
  authorId: string;
  createdAt: string;
  likesCount: number;
  commentsCount: number;
  viewCount: number;
  savesCount: number;
  /** not interested / hide / report, from anyone. */
  negativeCount: number;
  lastSeenAt: string | null;
  /** The viewer follows the author. */
  inNetwork: boolean;
  /** Cosine to the viewer's "avoid" vector; null when they have rejected nothing. */
  negativeSimilarity: number | null;
  /** Learned topic (k-means over post embeddings, private.post_topics); null until assigned. */
  topic: number | null;
  /**
   * 0..1, how much the post divides people rather than pleases them (private.post_contention):
   * replies out of proportion to approval, and regret (not interested / hide / report) per view.
   */
  contention: number;
}

export interface ScoredCandidate extends Candidate {
  features: CandidateFeatures;
  score: number;
  /** Each scorer's contribution, kept with the served list as training data. */
  parts: Record<string, number>;
  /**
   * The raw signals behind the parts, before any weight (similarity, quality, recency, inNetwork,
   * avoid, seen; each 0..1). Stored with the served list: what a learned ranker fits weights to
   * (private.fit_foryou_weights), since parts carry whatever weights an experiment ranked with.
   */
  signals: Record<string, number>;
}
