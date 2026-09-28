-- Grok Bot check-in wall — schema for a shared Supabase project.
--
-- Safe to run alongside other apps' tables (categories, posts, tags, …):
--   • every object is prefixed `grokbot_wall_`
--   • CREATE … IF NOT EXISTS / CREATE OR REPLACE only — no DROP of other objects
--   • RLS enabled with no policies → anon/authenticated cannot read or write;
--     the wall server uses the service_role key, which bypasses RLS
--
-- Run once in the Supabase SQL editor (or `psql -f supabase/schema.sql`). Idempotent.
-- After deploying this schema, run:  node scripts/migrate-to-normalized.mjs
-- to copy the legacy JSON blob into these tables (blob row is left untouched).

-- ---------------------------------------------------------------------------
-- Legacy blob table (kept as backup; new deploys may never write to it)
-- ---------------------------------------------------------------------------
create table if not exists public.grokbot_wall_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.grokbot_wall_state is
  'Legacy JSON snapshot (pre-normalized). Kept as backup after migrate-to-normalized.mjs.';
alter table public.grokbot_wall_state enable row level security;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------
create table if not exists public.grokbot_wall_events (
  id text primary key,                          -- Luma evt-…
  name text not null default '',
  start_at timestamptz,
  end_at timestamptz,
  is_current boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.grokbot_wall_events is
  'Luma events the wall has seen. is_current marks the active meetup.';
alter table public.grokbot_wall_events enable row level security;

create unique index if not exists grokbot_wall_events_one_current
  on public.grokbot_wall_events (is_current) where is_current;

-- ---------------------------------------------------------------------------
-- Settings (key/value config: poolMode, pollMs, labels, …)
-- ---------------------------------------------------------------------------
create table if not exists public.grokbot_wall_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
comment on table public.grokbot_wall_settings is
  'Wall config (poolMode, poll intervals, forceFastPoll, labels, schema_version, …).';
alter table public.grokbot_wall_settings enable row level security;

-- ---------------------------------------------------------------------------
-- Allocations (one row per guest per event)
-- ---------------------------------------------------------------------------
create table if not exists public.grokbot_wall_allocations (
  id uuid primary key default gen_random_uuid(),
  event_id text not null references public.grokbot_wall_events(id) on delete cascade,
  guest_key text not null,                      -- lowercased email / manual key
  email text not null default '',
  name text not null default '',
  luma_guest_id text,
  source text not null default 'luma' check (source in ('luma', 'manual')),
  checked_in_at timestamptz,
  allocated_at timestamptz not null default now(),
  mail_status text,                             -- sent|dry|queued|failed|skipped
  mail_to text,
  mail_at timestamptz,
  mail_tries int not null default 0,
  mail_error text,
  mail_reason text,
  mail_provider_id text,                        -- Resend/Mailgun/SMTP message id
  unique (event_id, guest_key)
);
comment on table public.grokbot_wall_allocations is
  'Check-ins / credit allocations. Browseable by event + guest email in the table editor.';
alter table public.grokbot_wall_allocations enable row level security;

create index if not exists grokbot_wall_allocations_event_idx
  on public.grokbot_wall_allocations (event_id);
create index if not exists grokbot_wall_allocations_mail_idx
  on public.grokbot_wall_allocations (mail_status);

-- ---------------------------------------------------------------------------
-- Codes (shared pool across events; assignment is unique)
-- ---------------------------------------------------------------------------
create table if not exists public.grokbot_wall_codes (
  code text primary key,
  pool text not null check (pool in ('A', 'B')),
  url text not null,
  position int not null,                        -- 1-based order within pool (display #)
  allocation_id uuid references public.grokbot_wall_allocations(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.grokbot_wall_codes is
  'Shared referral-code inventory. allocation_id set ⇒ used; never reassigned while set.';
alter table public.grokbot_wall_codes enable row level security;

create index if not exists grokbot_wall_codes_available_idx
  on public.grokbot_wall_codes (pool, position) where allocation_id is null;
create index if not exists grokbot_wall_codes_pool_position_idx
  on public.grokbot_wall_codes (pool, position);

-- A code may be linked to at most one allocation (enforced by PK on code + single allocation_id).
-- Partial unique: when assigned, allocation_id appears at most once per… wait, many codes per alloc.
-- Unique on code is enough to prevent double-assign of the same code string.

-- ---------------------------------------------------------------------------
-- Helpers + atomic allocate (safe under concurrent webhook + poll)
-- ---------------------------------------------------------------------------
create or replace function public.grokbot_wall_allocation_json(p_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', a.id,
    'key', a.guest_key,
    'eventId', a.event_id,
    'name', a.name,
    'email', a.email,
    'checkedInAt', a.checked_in_at,
    'source', a.source,
    'at', a.allocated_at,
    'lumaGuestId', a.luma_guest_id,
    'codes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'pool', c.pool, 'code', c.code, 'url', c.url, 'n', c.position
      ) order by c.pool, c.position)
      from public.grokbot_wall_codes c where c.allocation_id = a.id
    ), '[]'::jsonb),
    'mail', case when a.mail_status is null then null else jsonb_strip_nulls(jsonb_build_object(
      'status', a.mail_status,
      'to', a.mail_to,
      'at', a.mail_at,
      'tries', a.mail_tries,
      'error', a.mail_error,
      'reason', a.mail_reason,
      'id', a.mail_provider_id
    )) end
  )
  from public.grokbot_wall_allocations a
  where a.id = p_id;
$$;

create or replace function public.grokbot_wall_allocate(
  p_event_id text,
  p_guest_key text,
  p_name text default '',
  p_email text default '',
  p_checked_in_at timestamptz default null,
  p_source text default 'luma',
  p_luma_guest_id text default null,
  p_pool_mode text default 'A-then-B',
  p_event_name text default ''
) returns jsonb
language plpgsql
as $$
declare
  v_key text := lower(trim(p_guest_key));
  v_alloc public.grokbot_wall_allocations%rowtype;
  v_mode text := coalesce(nullif(trim(p_pool_mode), ''), 'A-then-B');
  v_pools text[];
  v_pool text;
  v_code public.grokbot_wall_codes%rowtype;
  v_codes jsonb := '[]'::jsonb;
begin
  if v_key is null or v_key = '' then
    raise exception 'guest_key required';
  end if;
  if p_event_id is null or trim(p_event_id) = '' then
    raise exception 'event_id required';
  end if;

  insert into public.grokbot_wall_events (id, name)
  values (p_event_id, coalesce(p_event_name, ''))
  on conflict (id) do update
    set name = case when excluded.name <> '' then excluded.name else grokbot_wall_events.name end,
        updated_at = now();

  select * into v_alloc
  from public.grokbot_wall_allocations
  where event_id = p_event_id and guest_key = v_key;
  if found then
    return public.grokbot_wall_allocation_json(v_alloc.id);
  end if;

  begin
    insert into public.grokbot_wall_allocations (
      event_id, guest_key, email, name, luma_guest_id, source, checked_in_at
    ) values (
      p_event_id, v_key,
      coalesce(p_email, ''), coalesce(p_name, ''),
      p_luma_guest_id,
      case when p_source = 'manual' then 'manual' else 'luma' end,
      p_checked_in_at
    )
    returning * into v_alloc;
  exception when unique_violation then
    select * into v_alloc
    from public.grokbot_wall_allocations
    where event_id = p_event_id and guest_key = v_key;
    return public.grokbot_wall_allocation_json(v_alloc.id);
  end;

  if v_mode = 'both' then
    v_pools := array['A', 'B'];
  elsif v_mode = 'B-then-A' then
    v_pools := array['B', 'A'];
  else
    v_pools := array['A', 'B'];
  end if;

  foreach v_pool in array v_pools loop
    select * into v_code
    from public.grokbot_wall_codes
    where pool = v_pool and allocation_id is null
    order by position
    for update skip locked
    limit 1;

    if found then
      update public.grokbot_wall_codes
      set allocation_id = v_alloc.id, used_at = now()
      where code = v_code.code
        and allocation_id is null
      returning * into v_code;

      if found then
        v_codes := v_codes || jsonb_build_array(jsonb_build_object(
          'pool', v_code.pool,
          'code', v_code.code,
          'url', v_code.url,
          'n', v_code.position
        ));
        if v_mode <> 'both' then
          exit;
        end if;
      end if;
    end if;
  end loop;

  return public.grokbot_wall_allocation_json(v_alloc.id);
end;
$$;

create or replace function public.grokbot_wall_release(
  p_event_id text,
  p_guest_key text
) returns jsonb
language plpgsql
as $$
declare
  v_alloc public.grokbot_wall_allocations%rowtype;
  v_json jsonb;
begin
  select * into v_alloc
  from public.grokbot_wall_allocations
  where event_id = p_event_id and guest_key = lower(trim(p_guest_key));
  if not found then
    return null;
  end if;
  v_json := public.grokbot_wall_allocation_json(v_alloc.id);
  update public.grokbot_wall_codes
  set allocation_id = null, used_at = null
  where allocation_id = v_alloc.id;
  delete from public.grokbot_wall_allocations where id = v_alloc.id;
  return v_json;
end;
$$;

-- Intentionally no CREATE POLICY on any of these tables.
-- Without policies, anon/authenticated are denied; service_role bypasses RLS.

-- PostgREST exposes EXECUTE on public functions to anon/authenticated by default.
-- Lock the RPCs down to service_role only (idempotent; safe if already applied).
revoke execute on function public.grokbot_wall_allocation_json(uuid) from public, anon, authenticated;
revoke execute on function public.grokbot_wall_allocate(text, text, text, text, timestamptz, text, text, text, text) from public, anon, authenticated;
revoke execute on function public.grokbot_wall_release(text, text) from public, anon, authenticated;
grant execute on function public.grokbot_wall_allocation_json(uuid) to service_role;
grant execute on function public.grokbot_wall_allocate(text, text, text, text, timestamptz, text, text, text, text) to service_role;
grant execute on function public.grokbot_wall_release(text, text) to service_role;
