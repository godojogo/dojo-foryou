# Dojo — For You

The recommendation algorithm behind Dojo's **For You** feed, open-sourced.

Most feeds optimize for *attention*. This one is built on a different premise:
**you should be in control, and engagement is not the same as satisfaction.**

- **You steer it.** The feed is driven by **content filters** with intensity
  sliders — interests you *declare*, not ones inferred by watching you. The
  behavioral recommendation engine is **opt-in**.
- **Engagement ≠ satisfaction.** Staring at a post can mean you love it — or that
  it made you uncomfortable, or you were morbidly curious. So **dwell is treated
  as volume, not direction.**

This repo is published in that spirit: here is exactly how the feed works.

## How a feed is assembled

```
                      request  { profile_id, limit, seed }
                                      │
                                      ▼
                          ┌───────────────────────┐
                          │  SENSEI  orchestrator  │
                          └───────────┬───────────┘
                                      ▼
              ① QUERY HYDRATION   (read-through context cache)
                 filters · intensity · follows · blocks · toggle
                                      │
            ┌─────────────────────────┴─────────────────────────┐
            ▼                                                     ▼
   ② KATA  型  content filters                  ② MUSHIN  無心  recommendations (opt-in)
      one vector query PER filter                  ┌ YOMI  reads you →
      (no averaging — interests                    │   multi-interest vectors + an "avoid" vector
       stay sharp)                                 │
            │                                       ├ signals: tasteMatch · collaborative
            │                                       │          rising · exploration · affinity
            │                                       │
            │                                       └ blend  − negatives  + exploration quota
            └─────────────────────────┬─────────────────────────┘
                                      ▼
              ③ CANDIDATE HYDRATION   (one Postgres pass)
                 engagement · recency · eligibility · last-seen
                                      ▼
              ④ FILTERS  the gate
                 drop private · blocked · ads · duplicates
                                      ▼
              ⑤ SCORING  the judge
                 similarity + velocity + recency
                 − seen-cooldown (decays)  − author-repeat
                                      ▼
              ⑥ SELECTION
                 slots ∝ intensity  (Kata vs Mushin mix)
                 + seeded exploration
                                      ▼
                          ┌───────────────────────┐
                          │  { post_ids: ranked }  │
                          └───────────────────────┘
```

Composition is decided by intensity:
- filters only → 100% **Kata**, split by intensity
- filters + recommendations on → recommendations take a share, filters the rest
- **no filters + recommendations on → 100% Mushin** (a pure discovery feed)

Retrieval runs against a vector index (pgvector embeddings mirrored to Pinecone);
ranking, eligibility and the engagement/recency layers run in Postgres.

## The trust hierarchy — the heart of it

How "happy to see more" is told apart from a one-off glance or discomfort.
Implemented in [`sql/02_profiles.sql`](sql/02_profiles.sql):

```
   save / comment / like ............... trustworthy endorsement → builds interest
   dwell WITH an action; durable; sought  corroboration / strength
   dwell ALONE ......................... ambiguous → IGNORED
   fast-skip / not-interested /
   open-then-bounce .................... rejection → NEGATIVE profile (steer away)
```

`Yomi` builds the user model from these: several **interest vectors** (someone
into fitness *and* finance keeps both, sharp) plus a **negative "avoid" vector**
that pushes the feed away from what disturbed them.

## Layout

The repo *is* the edge function (Deno / TypeScript), with the Postgres functions
alongside in `sql/`.

```
index.ts       HTTP entry — { user_profile_id, limit?, offset?, seed? } → { post_ids[] }
kata/          content-filter side
mushin/        recommendation engine (yomi · signals/ · blend · engine)
sensei/        orchestrator + hydration
scoring/       the scorer stack
filters/       eligibility chain
selection/     intensity allocation + selection
lib/           clients · config · shared types
sql/           the Postgres functions
  01_hydration.sql   read-through context cache + candidate features
  02_profiles.sql    taste + negative profiles (the trust hierarchy)
  03_signals.sql     collaborative · rising · exploration · affinity
```

## Running it

Targets **Supabase** (Postgres + pgvector, edge functions) and a vector index.

1. Apply the `sql/` files (expects tables: `posts` with a `post_embedding`
   vector, `content_filters`, `likes`, `comments`, `saved_posts`,
   `post_interactions`, `follows`, `dojo_members`, `blocked_users`, `dojos`,
   `user_foryou_context_cache`).
2. Deploy this repo as a Supabase edge function (entry `index.ts`) with env:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `PINECONE_API_KEY`,
   `PINECONE_INDEX_HOST`.
3. Call it: `{ user_profile_id, limit?, offset?, seed? }` → `{ post_ids[] }`.

Tunables (weights, windows, source mix) live in [`lib/config.ts`](lib/config.ts).

## License

[Apache License 2.0](LICENSE). Copyright 2026 Dojo.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
