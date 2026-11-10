// dojo-foryou-v3 — For You feed, built as a staged pipeline (one module per stage).
// Same request/response as dojo-foryou-v2, so the client cutover is a function-name change.
//
//   in:  { user_profile_id, limit?, offset?, seed?, exclude_post_ids?, topic? }
//   out: { post_ids: string[], total_found, filters_used, meta }
//
// Rank once per (viewer, seed), page from the stored order. The first page runs the pipeline:
// one Postgres read, one parallel wave of Pinecone queries, one Postgres read, ranking here.
// Every later page is one indexed read that re-applies the visibility gate. A client keeps one
// seed per feed session and picks a new one to refresh. See README.md for the stages.

import { callerDb, ForbiddenError, RateLimitedError } from './lib/clients.ts';
import { FeedRequest } from './lib/types.ts';
import { assembleFeed, assembleTopicFeed } from './sensei/feedPipeline.ts';

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-region',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

// UUIDs compare as text here; Postgres renders them lowercase, Swift's uuidString UPPERCASE.
const normId = (value: unknown) => String(value ?? '').trim().toLowerCase();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Any number the client sends → a stable unsigned 32-bit key. The selector's jitter uses 32 bits,
// and an Int64 from Swift would lose precision as a JS number, so fold it first.
const seedKey = (seed: unknown): number => {
  const n = Number(seed);
  return Number.isFinite(n) && n !== 0 ? Math.abs(Math.trunc(n)) % 4294967296 : Date.now() % 4294967296;
};

interface StoredPage {
  post_ids: string[];
  total_found: number;
  meta: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // The gateway has verified this token (verify_jwt); PostgREST verifies it again per call.
    const accessToken = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return json({ error: 'unauthorized' }, 401);

    const body = (await req.json()) as FeedRequest;
    const profileId = normId(body.user_profile_id);
    if (!UUID.test(profileId)) return json({ error: 'user_profile_id is required' }, 400);

    const limit = Math.min(Math.max(Math.trunc(Number(body.limit) || 30), 1), 50);
    const offset = Math.max(Math.trunc(Number(body.offset) || 0), 0);
    const seed = seedKey(body.seed);
    const exclude = (body.exclude_post_ids ?? []).map(normId).filter((id) => UUID.test(id));
    // For You, or one topic tab; each keeps its own stored session.
    const topic = typeof body.topic === 'string' && body.topic.trim() ? body.topic.trim().slice(0, 100) : null;
    const feed = topic ? `topic:${topic.toLowerCase()}` : 'foryou';

    const db = callerDb(accessToken);

    // A list already ranked for this session: one read.
    const stored = await db.rpc<StoredPage | null>('foryou_page_v3', {
      p_profile_id: profileId, p_feed: feed, p_seed: seed, p_offset: offset, p_limit: limit, p_exclude: exclude,
    });
    if (stored) {
      return json({
        post_ids: stored.post_ids,
        total_found: stored.total_found,
        filters_used: Number(stored.meta?.filters) || 0,
        meta: { ...(stored.meta ?? {}), cached: true },
      });
    }

    const { postIds, scored, meta } = topic
      ? await assembleTopicFeed(db, profileId, topic, seed)
      : await assembleFeed(db, profileId, seed);

    // Store the order, with what produced it (training data for a learned ranker), for the
    // session's later pages — off the response path; a failed store only means a re-rank.
    const byId = new Map(scored.map((s) => [s.postId, s]));
    const store = db.rpc('foryou_store_v3', {
      p_profile_id: profileId,
      p_feed: feed,
      p_seed: seed,
      p_post_ids: postIds,
      p_scores: postIds.map((id) => {
        const s = byId.get(id)!;
        return { id, source: s.source, filter: s.filterId ?? null, score: s.score, parts: s.parts };
      }),
      p_meta: meta,
    }).catch((e) => console.warn('foryou_store_v3 failed:', (e as Error).message));
    if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(store);
    else await store;

    const excluded = new Set(exclude);
    const visible = excluded.size > 0 ? postIds.filter((id) => !excluded.has(normId(id))) : postIds;

    return json({
      post_ids: visible.slice(offset, offset + limit),
      total_found: visible.length,
      filters_used: meta.filters,
      meta: { ...meta, cached: false },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return json({ error: 'forbidden' }, 403);
    if (error instanceof RateLimitedError) return json({ error: 'rate_limited' }, 429);
    console.error('dojo-foryou-v3 error:', error);
    return json({ error: 'feed_unavailable' }, 500);
  }
});
