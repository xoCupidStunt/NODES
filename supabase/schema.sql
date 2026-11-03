-- N.O.D.E.S cloud saves and shared worlds.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste this file → Run.
-- Safe to run again: it only creates what is missing and replaces the functions and policies.

create extension if not exists pgcrypto;

-- A world is one set of plans (progress, factories, synced save). Each player gets their own on first
-- sign-in; sharing its invite code lets others join it.
create table if not exists public.worlds (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My world',
  owner uuid not null references auth.users on delete cascade,
  invite_code text not null unique default encode(gen_random_bytes(6), 'hex'),
  created_at timestamptz not null default now()
);

create table if not exists public.world_members (
  world_id uuid not null references public.worlds on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  display_name text,
  joined_at timestamptz not null default now(),
  primary key (world_id, user_id)
);

-- One row per piece of a world: 'progress', 'game', 'foundNames', 'groupRules', 'factory:<id>'.
-- Deleted factories keep their row with data = null, so other players hear about the delete.
create table if not exists public.world_docs (
  world_id uuid not null references public.worlds on delete cascade,
  key text not null,
  data jsonb,
  client text,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (world_id, key)
);

create or replace function public.is_member(w uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from world_members where world_id = w and user_id = auth.uid());
$$;

create or replace function public.is_owner(w uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from worlds where id = w and owner = auth.uid());
$$;

-- Who changed a doc, and when, is set by the database, not the browser.
create or replace function public.stamp_doc() returns trigger
language plpgsql as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists stamp_doc on public.world_docs;
create trigger stamp_doc before insert or update on public.world_docs for each row execute function public.stamp_doc();

alter table public.worlds enable row level security;
alter table public.world_members enable row level security;
alter table public.world_docs enable row level security;

drop policy if exists "members read worlds" on public.worlds;
create policy "members read worlds" on public.worlds for select using (public.is_member(id));
drop policy if exists "owner renames world" on public.worlds;
create policy "owner renames world" on public.worlds for update using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists "owner deletes world" on public.worlds;
create policy "owner deletes world" on public.worlds for delete using (owner = auth.uid());

drop policy if exists "members read members" on public.world_members;
create policy "members read members" on public.world_members for select using (public.is_member(world_id));
-- Members can leave (the owner deletes the world instead); the owner can remove anyone else.
drop policy if exists "leave or remove" on public.world_members;
create policy "leave or remove" on public.world_members for delete
  using ((user_id = auth.uid() and role <> 'owner') or (public.is_owner(world_id) and user_id <> auth.uid()));
drop policy if exists "rename yourself" on public.world_members;
create policy "rename yourself" on public.world_members for update using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Only the display name can be changed by players (not the role).
revoke update on public.world_members from authenticated;
grant update (display_name) on public.world_members to authenticated;

drop policy if exists "members read docs" on public.world_docs;
create policy "members read docs" on public.world_docs for select using (public.is_member(world_id));
drop policy if exists "members add docs" on public.world_docs;
create policy "members add docs" on public.world_docs for insert with check (public.is_member(world_id));
drop policy if exists "members change docs" on public.world_docs;
create policy "members change docs" on public.world_docs for update using (public.is_member(world_id)) with check (public.is_member(world_id));

-- New world, owned by the caller.
create or replace function public.create_world(p_name text, p_display text) returns uuid
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into worlds (name, owner) values (coalesce(nullif(trim(p_name), ''), 'My world'), auth.uid()) returning id into w;
  insert into world_members (world_id, user_id, role, display_name) values (w, auth.uid(), 'owner', p_display);
  return w;
end $$;

-- Join a world with its invite code. Returns the world id.
create or replace function public.join_world(p_code text, p_display text) returns uuid
language plpgsql security definer set search_path = public as $$
declare w uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select id into w from worlds where invite_code = lower(trim(p_code));
  if w is null then raise exception 'That invite code isn''t valid (it may have been changed by the owner)'; end if;
  insert into world_members (world_id, user_id, display_name) values (w, auth.uid(), p_display) on conflict do nothing;
  return w;
end $$;

-- Owner only: make a new invite code so old links stop working.
create or replace function public.new_invite_code(w uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c text := encode(gen_random_bytes(6), 'hex');
begin
  update worlds set invite_code = c where id = w and owner = auth.uid();
  if not found then raise exception 'Only the owner can change the invite code'; end if;
  return c;
end $$;

grant execute on function public.create_world(text, text), public.join_world(text, text), public.new_invite_code(uuid) to authenticated;

-- Live updates for shared worlds.
do $$ begin
  alter publication supabase_realtime add table public.world_docs;
exception when duplicate_object then null; end $$;
