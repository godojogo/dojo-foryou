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
foryou_context_v3        one Postgres read            foryou_page_v4   one Postgres read:
  viewer · filters + vectors · toggles · hidden          the stored order, visibility gate
  Yomi's precomputed interest seeds                      re-applied, exclusions, one slice,
                                                         minus what was marked not interested
                                                         this session (+ its author, look-alikes)
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

## Experiments

A/B tests change the ranking's config for a share of viewers, with no deploy: a row in
`private.foryou_experiments` lists variants, each a set of overrides on `lib/config.ts` (e.g.
`{"weights": {"quality": 0.6}}`). A viewer's variant is a hash of the experiment key and their
profile, so it's stable. Each request ranks in its own config scope (`cfg()`), and the stored
list records the variants. `foryou_experiment_results_v1(key)` (admin; the dashboard's Feed
Experiments panel) compares them on what viewers did with what they were served: views, dwell,
likes / comments / saves / not-interested per 100 views, with a 95% interval on the like rate.

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
- **Intensity drives allocation, not score.** Filters get slots ∝ intensity, within
  `shareSlack` slots: each slot goes to the best next post among the filters near their share.
- **Tiers before shares**: unseen posts scoring ≥ `qualityFloor`, then weaker unseen ones, then
  posts seen in the last day (dropped while a page of unseen posts remains). `meta.unseen` says
  how many lead.
- **Quality is Σ value × P(action)**, each P the post's own rate per impression smoothed toward a
  prior — so 10 likes from 20 views beats 30 from 3,000, and a new post starts at average.
- **Valued, not reacted to.** The learner's target is endorsement (like, save, share, follow; a
  comment only on a calm post) against regret (not interested, hide, report, block), never
  attention. Dwell is read in context: relative to how long the post takes and to the viewer's
  usual, a long look counts (weakly) only on a calm post and is left out on a contentious one
  (`private.foryou_training_examples_v2`). A post that divides people loses
  `contention.weight` x contention and its comments add quality only in proportion to how calm
  it is: replies are what divisive posts generate most.
- **The avoid penalty is relative**: a blend of everything rejected sits near the average post,
  so only candidates closer to it than most of the set lose score.
- **Seen fades**: past the last day, a seen post is downranked (decaying over `seen.windowDays`),
  not removed, so the feed never empties and good posts resurface.
- **Repeat penalties are bounded**: an author's or topic's n-th post loses (1 - decay^n) of its
  score, measured against at least `diversityFloor`, whatever the score's sign.
- **Degrade, don't fail**: a slow Pinecone query drops its source, not the feed.
- **Transparent scorers now, learned ranker later**: every served list keeps each candidate's
  score parts; drop a learned `Scorer` into `scoring/` when there is enough to train on.
