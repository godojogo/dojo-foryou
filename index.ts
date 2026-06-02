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

  try {
    const { user_profile_id, limit = 30, offset = 0, seed = Date.now() } =
      (await req.json()) as FeedRequest;

    if (!user_profile_id) return json({ error: 'user_profile_id is required' }, 400);

    const supabase = getSupabase();
    const { postIds, meta } = await assembleFeed(supabase, user_profile_id, seed);

    // Pagination is a slice of the deterministically-ordered (seeded) list.
    const page = postIds.slice(offset, offset + limit);

    return json({ post_ids: page, total_found: postIds.length, meta });
  } catch (error) {
    console.error('dojo-foryou error:', error);
    return json({ error: (error as Error).message }, 500);
  }
});
