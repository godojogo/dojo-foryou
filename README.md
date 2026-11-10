# dojo-foryou-v3 — For You feed

The recommendation algorithm behind Dojo's **For You** feed. Same premise as v2 (the open-source
`godojogo/dojo-foryou`): **you steer it** — declared content filters with intensity sliders, an
opt-in behavioural engine — and **engagement is not satisfaction** (dwell is volume, not
direction). v3 keeps v2's stages and makes every one of them hold at scale.

Same request/response as v2: `{ user_profile_id, limit?, offset?, seed?, exclude_post_ids? }` →
`{ post_ids, total_found, filters_used, meta }`.

## A request

```
first page of a session (new seed)                    later pages (same seed)
──────────────────────────────────                    ───────────────────────
foryou_context_v3        one Postgres read            foryou_page_v3   one Postgres read:
  viewer · filters + vectors · toggles · hidden          the stored order, visibility gate
  Yomi's precomputed interest seeds                      re-applied, exclusions, one slice
  SQL sources: topic-named (full-text index),
  rising + exploration (pools), affinity,
  collaborative (precomputed neighbours)
          │
Pinecone                 one parallel wave
  per filter (topic floor 0.40) · per interest seed
  hidden authors excluded inside the index
          │
foryou_features_v3       one Postgres read
  live visibility rule (the authority) · counters
  last seen · in-network · avoid similarity
          │
gate → judge → selection  (in the function)
          │
foryou_store_v3          off the response path
```

Nothing at request time grows with the size of the network: every read is indexed and bounded,
vector search scales out in Pinecone, and everything expensive is precomputed —

| Precomputed | When | Where |
|---|---|---|
| Interest seeds, avoid vector, taste neighbours | each minute, for users who acted (and on first request) | `private.user_taste_vectors` |
| Rising, exploration pools | each minute, from bounded inputs | `private.foryou_pools` |
| Saves, negative actions per post | triggers | `private.post_feed_counters` |
| Author-written text, full-text indexed | generated column | `post_ai_analysis.author_tsv` |
| Ranked list per (viewer, seed), with scores | first page | `private.foryou_ranked_lists` (30 days) |

## Stages

`Query Hydration → Candidate Sources → Candidate Hydration → Pre-Scoring Filters → Scoring →
Selection → Post-Selection` — the stage names of X's open-source For You pipeline.

```
dojo-foryou-v3/
  index.ts              entry — session paging, store, HTTP
  sensei/  feedPipeline.ts   assembleFeed — runs the stages
           retrieval.ts      stages 1-3: context → Pinecone → features
  kata/    kata.ts           content filters: one query per filter, never averaged
  mushin/  blend.ts          discovery signals → one normalised score + exploration quota
  filters/                   the gate (visibility is enforced at the source, in Postgres)
  scoring/ engagement · negative · seenCooldown · authorDiversity
  selection/                 intensity → slot shares, weighted round-robin, seeded jitter
  lib/     clients (Postgres + Pinecone over fetch) · config · types
```

## Rules

- **A filter only gets posts about it**: similarity ≥ the topic floor, or the topic named in
  the author's own words — exactly what its topic tab shows.
- **One visibility rule** for every source and every page (`private.feed_visible_posts`):
  public, not dojo-only, not taken down, not an ad, dojo public. Blocks hide in both directions.
- **Intensity drives allocation, not score.** Filters get slots ∝ intensity.
- **Quality is Σ value × P(action)**, each P the post's own rate per impression smoothed toward a
  prior — so 10 likes from 20 views beats 30 from 3,000, and a new post starts at average.
- **The avoid penalty is relative**: a blend of everything rejected sits near the average post,
  so only candidates closer to it than most of the set lose score.
- **Seen is a decaying downrank, not a hard filter** — the feed never empties.
- **Degrade, don't fail**: a slow Pinecone query drops its source, not the feed.
- **Transparent scorers now, learned ranker later**: every served list keeps each candidate's
  score parts; drop a learned `Scorer` into `scoring/` when there is enough to train on.

## SQL

The Postgres side, in apply order:

- `sql/01_foundation.sql` — the visibility rule, hidden authors, Yomi's inputs, stored lists
- `sql/02_precompute_and_requests.sql` — counters, user model, pools, full-text index, and the
  `foryou_context_v3` / `foryou_features_v3` reads
- `sql/03_paging_and_topics.sql` — `foryou_page_v3`, `foryou_store_v3`, `foryou_topic_context_v3`

The function reads `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `PINECONE_API_KEY` and
`PINECONE_INDEX_HOST` from its environment; no keys live in this repository.
