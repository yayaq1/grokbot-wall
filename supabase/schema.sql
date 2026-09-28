-- Grok Bot check-in wall — schema for a shared Supabase project.
--
-- Safe to run alongside other apps' tables (categories, posts, tags, …):
--   • every object is prefixed `grokbot_wall_`
--   • CREATE … IF NOT EXISTS only — no DROP, ALTER of foreign objects, or grants
--     beyond what is required for this table
--   • RLS enabled with no policies → anon/authenticated cannot read or write;
--     the wall server uses the service_role key, which bypasses RLS
--
-- Run once in the Supabase SQL editor (or `psql`). Idempotent.

create table if not exists public.grokbot_wall_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.grokbot_wall_state is
  'Grok Bot check-in wall: per-row JSON snapshot (allocations, shared code pool, current event). One row per deployment (e.g. id=default, id=dev).';

alter table public.grokbot_wall_state enable row level security;

-- Intentionally no CREATE POLICY. Without policies, the anon and authenticated
-- roles are denied. service_role (used only by serve.mjs) bypasses RLS.
