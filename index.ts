// dojo-foryou — For You feed, built as a staged pipeline (one module per
// stage). Drop-in replacement for generate-foryou-feed: same request/response
// shape, so the client cutover is a one-line function-name change.
//
//   in:  { user_profile_id, limit?, offset?, seed? }
//   out: { post_ids: string[], total_found, meta }
//
// See README.md for the stage-by-stage architecture.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { getSupabase } from './lib/clients.ts';
import { FeedRequest } from './lib/types.ts';
import { assembleFeed } from './sensei/feedPipeline.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });

  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    const authorization = req.headers.get('authorization') ?? '';
    const accessToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!accessToken) return json({ error: 'unauthorized' }, 401);

    const supabase = getSupabase();
    const { data: authData, error: authError } = await supabase.auth.getUser(accessToken);
    if (authError || !authData.user) return json({ error: 'unauthorized' }, 401);

    const { user_profile_id, limit = 30, offset = 0, seed = Date.now() } =
      (await req.json()) as FeedRequest;

    if (!user_profile_id) return json({ error: 'user_profile_id is required' }, 400);

    const { data: callerProfile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', authData.user.id)
      .maybeSingle();
    if (profileError || !callerProfile) return json({ error: 'profile_not_found' }, 403);
    if (callerProfile.id !== user_profile_id) return json({ error: 'forbidden' }, 403);

    const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 30), 1), 50);
    // Bound page size, not pagination depth. Clients may keep requesting pages
    // for as long as this feed (and future larger candidate sets) has content.
    const safeOffset = Math.max(Math.trunc(Number(offset) || 0), 0);
    const bucketBytes = new TextEncoder().encode(`dojo-foryou-v2:${authData.user.id}`);
    const bucketDigest = await crypto.subtle.digest('SHA-256', bucketBytes);
    const bucketKey = Array.from(new Uint8Array(bucketDigest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
    const { data: withinLimit, error: rateLimitError } = await supabase.rpc(
      'consume_auth_rate_limit_v1',
      { p_bucket_key: bucketKey, p_limit: 120, p_window_seconds: 300 },
    );
    if (rateLimitError) return json({ error: 'temporarily_unavailable' }, 503);
    if (withinLimit !== true) return json({ error: 'rate_limited' }, 429);

    const { postIds, meta } = await assembleFeed(supabase, user_profile_id, seed);

    // Pagination is a slice of the deterministically-ordered (seeded) list.
    const page = postIds.slice(safeOffset, safeOffset + safeLimit);

    return json({ post_ids: page, total_found: postIds.length, meta });
  } catch (error) {
    console.error('dojo-foryou error:', error);
    return json({ error: (error as Error).message }, 500);
  }
});
