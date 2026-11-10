// The two backends, over plain fetch (no SDK: less to load on a cold start).
//   Postgres — every RPC runs under the caller's own JWT, so the database decides who they are
//              (current_profile_id). No service key, no separate auth round trip.
//   Pinecone — nearest-neighbour search over public posts. Scales out on its own and keeps ANN
//              load off the primary. Postgres stays the authority on visibility.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const PUBLIC_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const PINECONE_API_KEY = Deno.env.get('PINECONE_API_KEY') ?? '';
const PINECONE_INDEX_HOST = Deno.env.get('PINECONE_INDEX_HOST') ?? '';

const PINECONE_TIMEOUT_MS = 1500;

/** Postgres refused: the caller asked for someone else's feed. */
export class ForbiddenError extends Error {}
/** The caller is over the ranking rate limit. */
export class RateLimitedError extends Error {}

export interface Db {
  rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
}

export function callerDb(accessToken: string): Db {
  const headers = {
    apikey: PUBLIC_KEY,
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  return {
    async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
      });
      const text = await res.text();
      if (!res.ok) {
        let body: { code?: string; message?: string } = {};
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        if (body.code === '42501' || res.status === 401 || res.status === 403) {
          throw new ForbiddenError(body.message ?? 'forbidden');
        }
        throw new Error(`${name} failed (${res.status}): ${body.message ?? text.slice(0, 200)}`);
      }
      return (text ? JSON.parse(text) : null) as T;
    },
  };
}

export interface PineconeMatch {
  id: string;
  score: number;
}

/**
 * Nearest public posts to `vector`, excluding `hiddenAuthors` inside the index (blocked either
 * way, and the viewer). A slow or failed query returns [] — the feed degrades to its other
 * sources rather than failing.
 */
export async function pineconeQuery(
  vector: number[],
  topK: number,
  hiddenAuthors: string[],
): Promise<PineconeMatch[]> {
  const filter: Record<string, unknown> = { is_public: true };
  if (hiddenAuthors.length > 0) filter.author_id = { $nin: hiddenAuthors };
  try {
    const res = await fetch(`${PINECONE_INDEX_HOST}/query`, {
      method: 'POST',
      headers: { 'Api-Key': PINECONE_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ vector, topK, includeMetadata: false, includeValues: false, filter }),
      signal: AbortSignal.timeout(PINECONE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('Pinecone query failed:', res.status, (await res.text()).slice(0, 200));
      return [];
    }
    const data = await res.json();
    return (data.matches ?? []).map((m: { id: string; score: number }) => ({ id: m.id, score: m.score }));
  } catch (e) {
    console.error('Pinecone query error:', (e as Error).message);
    return [];
  }
}

/** pgvector's binary form, base64 (private.vec_b64): int16 dim, int16 unused, float4 big-endian. */
export function decodeVector(b64: string): number[] {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const dim = view.getInt16(0);
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(4 + i * 4);
  return out;
}
