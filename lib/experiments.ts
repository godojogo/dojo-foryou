// A/B tests on the ranking. An experiment splits viewers between variants, each a set of config
// overrides (lib/config.ts mergeConfig); a viewer's variant is a hash of their profile and the
// experiment's key, so it's stable across sessions and devices with nothing stored. The variants
// a list was ranked with are recorded in its meta (foryou_store_v3), which is what the metrics
// (public.foryou_experiment_results_v1) group by.
//
// Experiments live in private.foryou_experiments and are read through foryou_experiments_v1,
// once a minute per instance: starting, changing or stopping one needs no deploy.

import { Db } from './clients.ts';
import { cfg, Config, mergeConfig } from './config.ts';

interface Variant {
  name: string;
  /** Share of viewers, relative to the other variants' weights. */
  weight: number;
  config: Record<string, unknown>;
}

interface Experiment {
  key: string;
  variants: Variant[];
}

const REFRESH_MS = 60_000;
let cached: { at: number; experiments: Experiment[] } | null = null;

async function activeExperiments(db: Db): Promise<Experiment[]> {
  if (cached && Date.now() - cached.at < REFRESH_MS) return cached.experiments;
  try {
    const rows = await db.rpc<Experiment[] | null>('foryou_experiments_v1', {});
    cached = { at: Date.now(), experiments: rows ?? [] };
  } catch (e) {
    // Rank with the defaults (or the last known set) rather than fail the feed.
    console.warn('foryou_experiments_v1 failed:', (e as Error).message);
    cached = { at: Date.now(), experiments: cached?.experiments ?? [] };
  }
  return cached.experiments;
}

/** FNV-1a, 32 bits: the viewer's position in an experiment, 0..1. */
function bucket(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

export interface Assignment {
  config: Config;
  /** Experiment key → variant name. */
  arms: Record<string, string>;
}

/** The config this viewer ranks with, and the variant they're in for each running experiment. */
export async function assign(db: Db, profileId: string): Promise<Assignment> {
  let config = cfg();
  const arms: Record<string, string> = {};
  for (const exp of await activeExperiments(db)) {
    const variants = (exp.variants ?? []).filter((v) => v.weight > 0);
    const total = variants.reduce((sum, v) => sum + v.weight, 0);
    if (total <= 0) continue;
    let point = bucket(`${exp.key}:${profileId}`) * total;
    const variant = variants.find((v) => (point -= v.weight) < 0) ?? variants[variants.length - 1];
    arms[exp.key] = variant.name;
    if (variant.config && Object.keys(variant.config).length > 0) config = mergeConfig(config, variant.config);
  }
  return { config, arms };
}
