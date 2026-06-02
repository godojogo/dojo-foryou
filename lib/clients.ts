// Thin clients for the two backends the mixer talks to: Supabase (service role,
// for hydration RPCs) and Pinecone (vector retrieval).

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PINECONE_API_KEY = Deno.env.get('PINECONE_API_KEY')!;
const PINECONE_INDEX_HOST =
  Deno.env.get('PINECONE_INDEX_HOST') ??
  '';

export function getSupabase(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );
}

export interface PineconeMatch {
  id: string;
  score: number;
}

// Query the index for the nearest public posts to `vector`.
export async function pineconeQuery(vector: number[], topK: number): Promise<PineconeMatch[]> {
  const res = await fetch(`${PINECONE_INDEX_HOST}/query`, {
    method: 'POST',
    headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ vector, topK, includeMetadata: false, filter: { is_public: true } }),
  });
  if (!res.ok) {
    console.error('Pinecone query failed:', await res.text());
    return [];
  }
  const data = await res.json();
  return (data.matches ?? []).map((m: { id: string; score: number }) => ({ id: m.id, score: m.score }));
}
