// Stages 1-3 — Query Hydration, Candidate Sources, Candidate Hydration — in three bounded steps:
//
//   1. foryou_context_v3 (one Postgres read): the viewer's filters + intensity and their vectors,
//      the two discovery toggles, hidden authors (blocked either way, and themself), Yomi's
//      precomputed interest seeds, and every candidate that needs no vector search — Kata's
//      topic-named posts (full-text index), rising + exploration (precomputed pools), affinity
//      (follows + dojos), collaborative (precomputed taste neighbours).
//   2. Pinecone, one parallel wave: per filter (never an averaged vector) and per interest seed.
//      A filter keeps only posts about it (the topic floor); hidden authors are excluded inside
//      the index.
//   3. foryou_features_v4 (one Postgres read): features for the merged set, under the live
//      visibility rule — the authoritative gate over Pinecone's copy.

import { cfg } from '../lib/config.ts';
import { CandidateFeatures, RawCandidate, UserContext } from '../lib/types.ts';
import { Db, decodeVector, pineconeQuery, RateLimitedError } from '../lib/clients.ts';
import { Steering } from '../lib/steering.ts';

export interface Retrieved {
  ctx: UserContext;
  candidates: RawCandidate[];
  features: Map<string, CandidateFeatures>;
  /** The viewer's dials and formats (For You only; a topic tab is one filter, unsteered). */
  steering?: Steering;
}

type Row = Record<string, unknown>;

interface ContextRow {
  error?: string;
  trending_on: boolean;
  recommend_on: boolean;
  hidden_authors: string[];
  filters: { id: string; intensity: number; vector: string }[];
  interest_seeds: { share: number; vector: string }[];
  candidates: Row[];
  steering?: Steering;
  expired_filter_ids?: string[];
  mutes?: { id: string; label: string; strength: number }[];
}

export async function retrieve(db: Db, profileId: string): Promise<Retrieved> {
  // 1. The viewer, and the candidates Postgres can produce from indexes and precomputed pools.
  const context = await db.rpc<ContextRow>('foryou_context_v4', { p_profile_id: profileId });
  if (context?.error === 'rate_limited') throw new RateLimitedError('rate_limited');

  // A temporary topic past its expiry is out, with its candidates (it is deleted within the hour).
  const expired = new Set((context.expired_filter_ids ?? []).map(String));
  context.filters = (context.filters ?? []).filter((f) => !expired.has(String(f.id)));
  context.candidates = (context.candidates ?? []).filter((c) => !expired.has(String(c.filter_id)));

  const ctx: UserContext = {
    profileId,
    filters: (context.filters ?? []).map((f) => ({ id: String(f.id), intensity: Number(f.intensity) || 0 })),
    trendingOn: Boolean(context.trending_on),
    recommendOn: Boolean(context.recommend_on),
    interestSeeds: (context.interest_seeds ?? []).length,
  };
  const hidden = (context.hidden_authors ?? []).map(String);

  const candidates: RawCandidate[] = (context.candidates ?? []).map((c) => ({
    postId: String(c.post_id),
    source: c.source as RawCandidate['source'],
    filterId: (c.filter_id as string) ?? null,
    intensity: Number(c.intensity) || 0,
    score: c.score == null ? NaN : Number(c.score), // NaN: a named match, similarity filled below
  }));

  // 2. Vector search, every query in one parallel wave.
  const filterQueries = (context.filters ?? []).map(async (f) => {
    const matches = await pineconeQuery(decodeVector(f.vector), cfg().retrieval.perFilterTopK, hidden);
    return { f, matches };
  });
  const seedQueries = (context.interest_seeds ?? []).map(async (s) => {
    const matches = await pineconeQuery(decodeVector(s.vector), cfg().retrieval.perSeedTopK, hidden);
    return { share: Number(s.share) || 0, matches };
  });
  const [filterResults, seedResults] = await Promise.all([Promise.all(filterQueries), Promise.all(seedQueries)]);

  // Kata: a filter's candidates are what its topic tab shows — close to it (>= the topic floor),
  // or naming it in the author's own words. Named matches take their similarity from the query
  // when it saw them; otherwise they rank at the floor.
  const simByFilter = new Map<string, Map<string, number>>();
  for (const { f, matches } of filterResults) {
    const sims = new Map<string, number>();
    for (const m of matches) {
      sims.set(m.id, m.score);
      if (m.score >= cfg().retrieval.topicFloor) {
        candidates.push({ postId: m.id, source: 'filter', filterId: String(f.id), intensity: Number(f.intensity) || 0, score: m.score });
      }
    }
    simByFilter.set(String(f.id), sims);
  }
  for (const c of candidates) {
    if (c.source === 'filter' && Number.isNaN(c.score)) {
      c.score = simByFilter.get(c.filterId!)?.get(c.postId) ?? cfg().retrieval.topicFloor;
    }
  }

  // tasteMatch: nearest posts to each interest, weighted by that interest's endorsement share.
  const taste = new Map<string, number>();
  for (const { share, matches } of seedResults) {
    for (const m of matches) taste.set(m.id, Math.max(taste.get(m.id) ?? 0, m.score * share));
  }
  for (const [postId, score] of taste) {
    candidates.push({ postId, source: 'tasteMatch', filterId: null, intensity: 1, score });
  }

  // 3. Features for every distinct candidate, under the live visibility rule.
  const muteStrength = new Map((context.mutes ?? []).map((m) => [String(m.id), Number(m.strength) || 0]));
  const features = await hydrateFeatures(db, profileId, candidates, muteStrength);

  return { ctx, candidates, features, steering: context.steering };
}

// Stage 3 for any candidate set: features under the live visibility rule (the authoritative gate
// over Pinecone's copy) — a candidate missing from the result is no longer visible.
async function hydrateFeatures(
  db: Db, profileId: string, candidates: RawCandidate[], muteStrength = new Map<string, number>(),
): Promise<Map<string, CandidateFeatures>> {
  const ids = [...new Set(candidates.map((c) => c.postId))];
  const features = new Map<string, CandidateFeatures>();
  if (ids.length === 0) return features;
  const rows = await db.rpc<Row[]>('foryou_features_v6', { p_profile_id: profileId, p_post_ids: ids });
  for (const r of rows ?? []) {
    const postId = String(r.post_id);
    features.set(postId, {
      postId,
      authorId: String(r.author_id),
      createdAt: String(r.created_at),
      likesCount: Number(r.likes_count) || 0,
      commentsCount: Number(r.comments_count) || 0,
      viewCount: Number(r.view_count) || 0,
      savesCount: Number(r.saves_count) || 0,
      negativeCount: Number(r.negative_count) || 0,
      lastSeenAt: (r.last_seen_at as string) ?? null,
      inNetwork: Boolean(r.in_network),
      negativeSimilarity: r.negative_similarity == null ? null : Number(r.negative_similarity),
      topic: r.topic == null ? null : Number(r.topic),
      contention: Number(r.contention) || 0,
      postType: String(r.post_type ?? ''),
      muteHits: ((r.mute_hits as { id: string; sim: number }[] | null) ?? [])
        .map((h) => ({ id: String(h.id), sim: Number(h.sim) || 0, strength: muteStrength.get(String(h.id)) ?? 0 }))
        .filter((h) => h.strength > 0),
    });
  }
  return features;
}

interface TopicContextRow {
  error?: string;
  filter_id: string | null;
  vector: string | null;
  hidden_authors: string[];
  named: string[];
}

/**
 * A topic tab: one filter on its own. Its candidates are posts close to the filter (>= the topic
 * floor) or naming it in the author's own words — the rule get_topic_feed_v2 applies — from one
 * context read, one Pinecone query and the shared features read.
 */
export async function retrieveTopic(db: Db, profileId: string, topic: string): Promise<Retrieved> {
  const context = await db.rpc<TopicContextRow>('foryou_topic_context_v3', {
    p_profile_id: profileId, p_topic: topic, p_limit: cfg().retrieval.topicTopK,
  });
  if (context?.error === 'rate_limited') throw new RateLimitedError('rate_limited');

  const filterId = context.filter_id ?? `topic:${topic.trim().toLowerCase()}`;
  const ctx: UserContext = {
    profileId,
    filters: [{ id: filterId, intensity: 1 }],
    trendingOn: false,
    recommendOn: false,
    interestSeeds: 0,
  };

  const sims = new Map<string, number>();
  if (context.vector) {
    const matches = await pineconeQuery(
      decodeVector(context.vector), cfg().retrieval.topicTopK, (context.hidden_authors ?? []).map(String));
    for (const m of matches) sims.set(m.id, m.score);
  }

  const candidates: RawCandidate[] = [];
  for (const [postId, score] of sims) {
    if (score >= cfg().retrieval.topicFloor) {
      candidates.push({ postId, source: 'filter', filterId, intensity: 1, score });
    }
  }
  for (const id of context.named ?? []) {
    const postId = String(id);
    candidates.push({ postId, source: 'filter', filterId, intensity: 1, score: sims.get(postId) ?? cfg().retrieval.topicFloor });
  }

  const features = await hydrateFeatures(db, profileId, candidates);
  return { ctx, candidates, features };
}
