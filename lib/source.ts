// A candidate source is a named, self-describing retriever. The two sides of the
// feed — Kata (content filters) and Mushin (recommendations) — each implement
// this. New sources plug in by implementing it and registering in
// sensei/registry.ts; nothing else in the pipeline changes.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { Candidate, UserContext } from './types.ts';

export interface SourceDeps {
  supabase: SupabaseClient;
}

export interface CandidateSource {
  name: string;
  enabled(ctx: UserContext): boolean;
  retrieve(ctx: UserContext, deps: SourceDeps): Promise<Candidate[]>;
}
