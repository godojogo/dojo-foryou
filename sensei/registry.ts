// Source registry — the two sides Sensei pulls candidates from: Kata (filters)
// and Mushin (recommendations). Add a side/source here and the rest of the
// pipeline is untouched.

import { Candidate, UserContext } from '../lib/types.ts';
import { CONFIG } from '../lib/config.ts';
import { CandidateSource, SourceDeps } from '../lib/source.ts';
import { kataSource } from '../kata/kataSource.ts';
import { mushinSource } from '../mushin/mushinSource.ts';

export const SOURCES: CandidateSource[] = [kataSource, mushinSource];

// Run every enabled source in parallel and merge, de-duplicating by post. A post
// can be retrieved by several filters; keep the strongest (similarity·intensity)
// provenance so the allocator assigns it to the source that "wanted" it most.
export async function gatherCandidates(ctx: UserContext, deps: SourceDeps): Promise<Candidate[]> {
  const lists = await Promise.all(
    SOURCES.filter((s) => s.enabled(ctx)).map((s) => s.retrieve(ctx, deps)),
  );

  const best = new Map<string, Candidate>();
  for (const c of lists.flat()) {
    const cur = best.get(c.postId);
    if (!cur || c.similarity * c.intensity > cur.similarity * cur.intensity) {
      best.set(c.postId, c);
    }
  }
  return [...best.values()].slice(0, CONFIG.maxCandidates);
}
