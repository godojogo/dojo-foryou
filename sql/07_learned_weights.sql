-- The learned ranker's first step: fit the For You scoring weights to what viewers did.
--
-- Every ranked list stores each served post's raw signals (similarity, quality, recency,
-- inNetwork, avoid, seen; dojo-foryou-v3 ScoredCandidate.signals). This joins them to outcomes
-- and fits a logistic regression of "liked, saved or commented, given it was viewed" on those
-- signals. The coefficients become ranking weights (scaled so similarity stays 1, never flipping
-- a signal's sign) and are proposed as an A/B experiment — `learned_weights`, control vs learned —
-- only when they rank a held-out 20% better than what the feed actually served (AUC), with
-- enough data. It is never switched on automatically: start it from the dashboard's experiment
-- table (set active), read the results, then promote by editing lib/config.ts.
--
--   private.foryou_training_examples   one row per served post that was viewed, with outcomes
--   private.fit_foryou_weights()       the fit; weekly by cron, or run by hand
--   private.foryou_weight_fits         every fit: examples, AUCs, coefficients, proposal

set local lock_timeout = '5s';

create or replace view private.foryou_training_examples as
select
  l.profile_id,
  l.feed,
  l.created_at as ranked_at,
  l.meta -> 'experiments' as experiments,
  s.ord::integer as position,
  (s.e ->> 'id')::uuid as post_id,
  (s.e ->> 'score')::float8 as served_score,
  coalesce((s.e -> 'signals' ->> 'similarity')::float8, 0) as similarity,
  coalesce((s.e -> 'signals' ->> 'quality')::float8, 0) as quality,
  coalesce((s.e -> 'signals' ->> 'recency')::float8, 0) as recency,
  coalesce((s.e -> 'signals' ->> 'inNetwork')::float8, 0) as in_network,
  coalesce((s.e -> 'signals' ->> 'avoid')::float8, 0) as avoid,
  coalesce((s.e -> 'signals' ->> 'seen')::float8, 0) as seen,
  o.dwell,
  o.liked,
  o.saved,
  o.commented,
  o.dismissed
from private.foryou_ranked_lists l
cross join lateral jsonb_array_elements(l.scores) with ordinality s(e, ord)
cross join lateral (
  select
    v.dwell_time_seconds as dwell,
    exists (select 1 from public.likes k where k.user_id = l.profile_id and k.post_id = v.post_id
              and k.created_at >= l.created_at and k.created_at < l.created_at + interval '3 hours') as liked,
    exists (select 1 from public.saved_posts sp where sp.profile_id = l.profile_id and sp.post_id = v.post_id
              and sp.created_at >= l.created_at and sp.created_at < l.created_at + interval '3 hours') as saved,
    exists (select 1 from public.comments c where c.user_id = l.profile_id and c.post_id = v.post_id
              and c.created_at >= l.created_at and c.created_at < l.created_at + interval '3 hours') as commented,
    exists (select 1 from public.post_interactions d where d.user_id = l.profile_id and d.post_id = v.post_id
              and d.interaction_type = 'not_interested'
              and coalesce(d.updated_at, d.created_at) >= l.created_at
              and coalesce(d.updated_at, d.created_at) < l.created_at + interval '3 hours') as dismissed
  from public.post_interactions v
  where v.user_id = l.profile_id
    and v.post_id = (s.e ->> 'id')::uuid
    and v.interaction_type = 'view'
    and coalesce(v.updated_at, v.created_at) >= l.created_at
    and coalesce(v.updated_at, v.created_at) < l.created_at + interval '3 hours'
) o
where s.e ? 'signals';

create table if not exists private.foryou_weight_fits (
  id bigserial primary key,
  fitted_at timestamptz not null default now(),
  examples integer not null,
  positives integer not null,
  holdout_auc_learned numeric,
  holdout_auc_served numeric,
  coefficients jsonb,
  proposed_config jsonb,
  proposed boolean not null default false,
  note text
);
alter table private.foryou_weight_fits enable row level security;

create or replace function private.fit_foryou_weights(
  p_days integer default 30,
  p_min_examples integer default 2000,
  p_min_positives integer default 50,
  p_iters integer default 400,
  p_rate float8 default 1.0,
  p_l2 float8 default 0.001
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  n integer; pos integer;
  b0 float8 := 0; b_sim float8 := 0; b_q float8 := 0; b_r float8 := 0; b_in float8 := 0; b_av float8 := 0; b_seen float8 := 0;
  g record;
  auc_learned numeric; auc_served numeric;
  proposal jsonb; note text; proposed boolean := false;
  scale float8;
begin
  drop table if exists pg_temp._fy_ex;
  create temp table _fy_ex as
    select e.similarity x1, e.quality x2, e.recency x3, e.in_network x4, e.avoid x5, e.seen x6,
           e.served_score,
           ((e.liked or e.saved or e.commented) and not e.dismissed)::int::float8 as y,
           -- Stable 20% holdout by viewer and post.
           (abs(hashtext(e.profile_id::text || e.post_id::text)) % 5 = 0) as holdout
    from private.foryou_training_examples e
    where e.ranked_at > now() - make_interval(days => p_days)
      and e.feed = 'foryou';

  select count(*), coalesce(sum(y), 0) into n, pos from pg_temp._fy_ex where not holdout;

  if n < p_min_examples or pos < p_min_positives then
    note := format('not enough data yet: %s examples (need %s), %s positives (need %s)', n, p_min_examples, pos, p_min_positives);
    insert into private.foryou_weight_fits (examples, positives, note) values (n, pos, note);
    return jsonb_build_object('fitted', false, 'examples', n, 'positives', pos, 'note', note);
  end if;

  -- Logistic regression by batch gradient descent (signals are 0..1, so no scaling needed).
  for i in 1..p_iters loop
    select
      avg(err) as g0, avg(err * x1) + p_l2 * b_sim as g1, avg(err * x2) + p_l2 * b_q as g2,
      avg(err * x3) + p_l2 * b_r as g3, avg(err * x4) + p_l2 * b_in as g4,
      avg(err * x5) + p_l2 * b_av as g5, avg(err * x6) + p_l2 * b_seen as g6
    into g
    from (
      select x1, x2, x3, x4, x5, x6,
             1 / (1 + exp(-least(50, greatest(-50, b0 + b_sim * x1 + b_q * x2 + b_r * x3 + b_in * x4 + b_av * x5 + b_seen * x6)))) - y as err
      from pg_temp._fy_ex where not holdout
    ) t;
    b0 := b0 - p_rate * g.g0;     b_sim := b_sim - p_rate * g.g1; b_q := b_q - p_rate * g.g2;
    b_r := b_r - p_rate * g.g3;   b_in := b_in - p_rate * g.g4;   b_av := b_av - p_rate * g.g5;
    b_seen := b_seen - p_rate * g.g6;
  end loop;

  -- Holdout AUC (Mann-Whitney): the learned score against the score the feed actually served.
  with h as (
    select y, b_sim * x1 + b_q * x2 + b_r * x3 + b_in * x4 + b_av * x5 + b_seen * x6 as learned, served_score
    from pg_temp._fy_ex where holdout
  ),
  r as (
    select y, rank() over (order by learned) as rl, rank() over (order by served_score) as rs from h
  ),
  c as (select count(*) filter (where y = 1) p, count(*) filter (where y = 0) q,
               sum(rl) filter (where y = 1) srl, sum(rs) filter (where y = 1) srs from r)
  select case when p > 0 and q > 0 then round(((srl - p * (p + 1) / 2.0) / (p * q))::numeric, 4) end,
         case when p > 0 and q > 0 then round(((srs - p * (p + 1) / 2.0) / (p * q))::numeric, 4) end
  into auc_learned, auc_served
  from c;

  -- As ranking weights: similarity stays 1; a signal never changes direction (clamped to 0..3).
  if b_sim > 0 then
    scale := 1 / b_sim;
    proposal := jsonb_build_object(
      'weights', jsonb_build_object(
        'similarity', 1,
        'quality', round(greatest(0, least(3, b_q * scale))::numeric, 3),
        'recency', round(greatest(0, least(3, b_r * scale))::numeric, 3),
        'inNetwork', round(greatest(0, least(3, b_in * scale))::numeric, 3)),
      'negative', jsonb_build_object('weight', round(greatest(0, least(3, -b_av * scale))::numeric, 3)),
      'seen', jsonb_build_object('weight', round(greatest(0, least(3, -b_seen * scale))::numeric, 3)));
  end if;

  if proposal is null then
    note := 'similarity did not predict engagement (non-positive coefficient): nothing proposed';
  elsif auc_learned is null or auc_served is null then
    note := 'holdout has no positives or no negatives: nothing proposed';
  elsif auc_learned <= auc_served then
    note := format('learned weights rank the holdout no better than the served ranking (AUC %s vs %s): nothing proposed', auc_learned, auc_served);
  else
    proposed := true;
    note := format('learned weights rank the holdout better (AUC %s vs %s): proposed as experiment learned_weights (inactive)', auc_learned, auc_served);
    insert into private.foryou_experiments (key, description, variants, active)
    values ('learned_weights',
            format('Weights fitted %s on %s examples (holdout AUC %s vs served %s). Start by setting active.', now()::date, n, auc_learned, auc_served),
            jsonb_build_array(
              jsonb_build_object('name', 'control', 'weight', 50, 'config', '{}'::jsonb),
              jsonb_build_object('name', 'learned', 'weight', 50, 'config', proposal)),
            false)
    on conflict (key) do update
      set description = excluded.description, variants = excluded.variants
      where not private.foryou_experiments.active;  -- never rewrite a running experiment
  end if;

  insert into private.foryou_weight_fits (examples, positives, holdout_auc_learned, holdout_auc_served, coefficients, proposed_config, proposed, note)
  values (n, pos, auc_learned, auc_served,
          jsonb_build_object('intercept', b0, 'similarity', b_sim, 'quality', b_q, 'recency', b_r, 'inNetwork', b_in, 'avoid', b_av, 'seen', b_seen),
          proposal, proposed, note);

  drop table if exists pg_temp._fy_ex;
  return jsonb_build_object('fitted', true, 'examples', n, 'positives', pos, 'auc_learned', auc_learned,
                            'auc_served', auc_served, 'proposed', proposed, 'config', proposal, 'note', note);
end;
$$;
revoke all on function private.fit_foryou_weights(integer, integer, integer, integer, float8, float8) from public, anon, authenticated;

-- Weekly, Monday 05:00 UTC.
select cron.schedule('foryou-fit-weights-weekly', '0 5 * * 1', $$select private.fit_foryou_weights()$$);
