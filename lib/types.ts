// Shared types that flow through the feed pipeline.

export interface FeedRequest {
  user_profile_id: string;
  limit?: number;
  offset?: number;
  seed?: number;
}

export interface FilterContext {
  id: string;
  intensity: number;
  embedding: number[]; // 1536-dim
}

export interface UserContext {
  profileId: string;
  filters: FilterContext[];
  following: string[];
  blocked: string[];
  trendingOn: boolean;
  isPro: boolean;
}

export interface Candidate {
  postId: string;
  source: 'filter' | 'trending';
  filterId?: string; // which filter retrieved it (for allocation)
  intensity: number; // intensity of the owning source
  similarity: number; // raw cosine from Pinecone
}

export interface CandidateFeatures {
  postId: string;
  authorId: string;
  dojoId: string | null;
  eligible: boolean;
  isAd: boolean;
  likesCount: number;
  commentsCount: number;
  viewCount: number;
  createdAt: string;
  lastSeenAt: string | null;
  authorBlocked: boolean;
}

export interface ScoredCandidate extends Candidate {
  features: CandidateFeatures;
  score: number;
}
