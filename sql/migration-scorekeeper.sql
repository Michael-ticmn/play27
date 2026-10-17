-- ============================================================
-- Scorekeeper: scores and a table display for in-person
-- Contract Rummy played with physical cards.
--
-- No accounts. A table has a short join code; every device that
-- joins gets a secret key (stored on that device). The host device
-- holds a host key. Clients only ever SELECT these tables; every
-- write goes through the SECURITY DEFINER score_* functions below,
-- which check the key. Keys are stored hashed in score_secrets,
-- which no client role can read.
--
-- Reads are open to the anon key (names and scores are not
-- sensitive) so phones get live updates without signing in.
-- Tables idle for 24 hours are removed when the next table is
-- created; finished games stay in score_history.
-- ============================================================

-- ── TABLES ──

create table if not exists public.score_tables (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  status        text not null default 'setup' check (status in ('setup', 'playing', 'done')),
  game_no       int  not null default 1,
  hand          int  not null default 0,
  first_dealer  int  not null default 0,
  contracts     jsonb not null,
  rules         jsonb not null,
  card_values   jsonb not null,
  notes         text not null default '',
  announce      text check (announce in ('standings', 'hand', 'both')),
  announce_seq  int  not null default 0,
  announce_at   timestamptz,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create table if not exists public.score_players (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid not null references public.score_tables(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 24),
  seat        int  not null,
  color       int  not null default 0,
  has_device  boolean not null default false,
  removed     boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists score_players_table_idx on public.score_players(table_id);

-- One row per player per hand per game. A null score means "not entered".
-- Rows are never deleted during play so realtime filters keep working.
create table if not exists public.score_entries (
  table_id    uuid not null references public.score_tables(id) on delete cascade,
  player_id   uuid not null references public.score_players(id) on delete cascade,
  game_no     int  not null,
  hand        int  not null check (hand between 0 and 29),
  score       int  check (score between -999 and 9999),
  entered_by  text not null default 'player' check (entered_by in ('player', 'host')),
  updated_at  timestamptz not null default now(),
  primary key (player_id, game_no, hand)
);
create index if not exists score_entries_table_idx on public.score_entries(table_id, game_no);

-- Finished games. No foreign key, so history outlives the table.
create table if not exists public.score_history (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid not null,
  code        text not null,
  game_no     int  not null,
  hands       int  not null,
  results     jsonb not null,
  ended_at    timestamptz not null default now(),
  unique (table_id, game_no)
);

create table if not exists public.score_secrets (
  token_hash  text primary key,
  table_id    uuid not null references public.score_tables(id) on delete cascade,
  player_id   uuid references public.score_players(id) on delete cascade,
  role        text not null check (role in ('host', 'player')),
  created_at  timestamptz not null default now()
);
create index if not exists score_secrets_table_idx on public.score_secrets(table_id);

-- Added after the first release: keeps a re-run working on databases created before these columns.
alter table public.score_tables add column if not exists created_by uuid;

-- ── ROW LEVEL SECURITY ──

alter table public.score_tables  enable row level security;
alter table public.score_players enable row level security;
alter table public.score_entries enable row level security;
alter table public.score_history enable row level security;
alter table public.score_secrets enable row level security;

drop policy if exists "Anyone can read score tables"  on public.score_tables;
drop policy if exists "Anyone can read score players" on public.score_players;
drop policy if exists "Anyone can read score entries" on public.score_entries;
drop policy if exists "Anyone can read score history" on public.score_history;

create policy "Anyone can read score tables"  on public.score_tables  for select to anon, authenticated using (true);
create policy "Anyone can read score players" on public.score_players for select to anon, authenticated using (true);
create policy "Anyone can read score entries" on public.score_entries for select to anon, authenticated using (true);
create policy "Anyone can read score history" on public.score_history for select to anon, authenticated using (true);
-- score_secrets: no policies, so no client role can read or write it.

revoke insert, update, delete, truncate on public.score_tables, public.score_players,
  public.score_entries, public.score_history from anon, authenticated;
revoke all on public.score_secrets from anon, authenticated;

-- ── REALTIME ──

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'score_tables') then
      alter publication supabase_realtime add table public.score_tables;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'score_players') then
      alter publication supabase_realtime add table public.score_players;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'score_entries') then
      alter publication supabase_realtime add table public.score_entries;
    end if;
  end if;
end $$;

-- ============================================================
-- INTERNAL HELPERS (not callable by clients)
-- ============================================================

create or replace function public.score_hash(p_token text)
returns text language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

create or replace function public.score_new_token()
returns text language sql volatile set search_path = public as $$
  select replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
$$;

create or replace function public.score_clean_name(p_name text)
returns text language plpgsql immutable set search_path = public as $$
declare v text := left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 24);
begin
  if v = '' then raise exception 'Enter a name'; end if;
  return v;
end $$;

-- Defaults come from the online game's contracts table, so both stay on the same rules.
create or replace function public.score_default_contracts()
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'sets', num_sets, 'runs', num_runs, 'deal', cards_dealt, 'all', must_go_out)
           order by round_number), '[]'::jsonb)
  from public.contracts;
$$;

create or replace function public.score_clean_contracts(p jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
declare v_out jsonb := '[]'::jsonb; e jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) not between 1 and 20 then
    raise exception 'Contracts must list 1 to 20 hands';
  end if;
  for e in select value from jsonb_array_elements(p) loop
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'sets', least(greatest(coalesce((e->>'sets')::int, 0), 0), 6),
      'runs', least(greatest(coalesce((e->>'runs')::int, 0), 0), 6),
      'deal', least(greatest(coalesce((e->>'deal')::int, 10), 1), 30),
      'all',  coalesce((e->>'all')::boolean, false)));
  end loop;
  return v_out;
end $$;

create or replace function public.score_clean_rules(p jsonb)
returns jsonb language plpgsql stable set search_path = public as $$
declare v_run int := coalesce((select max(min_run_length) from public.contracts), 3);
begin
  p := coalesce(p, '{}'::jsonb);
  return jsonb_build_object(
    'setSize', least(greatest(coalesce((p->>'setSize')::int, 3), 2), 8),
    'runLen',  least(greatest(coalesce((p->>'runLen')::int, v_run), 2), 13),
    'buys',    case when p->>'buys' is null then null
                    else least(greatest((p->>'buys')::int, 1), 10) end);
end $$;

-- Mirrors score_cards(): Joker 25, Ace 15, J/Q/K 10, other cards at face value.
create or replace function public.score_clean_values(p jsonb)
returns jsonb language plpgsql immutable set search_path = public as $$
begin
  p := coalesce(p, '{}'::jsonb);
  return jsonb_build_object(
    'numbers', case when p->>'numbers' = 'flat5' then 'flat5' else 'face' end,
    'face',  least(greatest(coalesce((p->>'face')::int, 10), 0), 500),
    'ace',   least(greatest(coalesce((p->>'ace')::int, 15), 0), 500),
    'joker', least(greatest(coalesce((p->>'joker')::int, 25), 0), 500));
end $$;

-- Find a table by code and lock it for this transaction.
create or replace function public.score_table_by_code(p_code text)
returns public.score_tables language plpgsql set search_path = public as $$
declare t public.score_tables;
begin
  select * into t from public.score_tables where code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found then raise exception 'This table is closed or the code is wrong'; end if;
  return t;
end $$;

create or replace function public.score_auth_host(p_code text, p_token text)
returns public.score_tables language plpgsql set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_table_by_code(p_code);
  if not exists (select 1 from public.score_secrets
                 where token_hash = public.score_hash(p_token) and table_id = t.id and role = 'host') then
    raise exception 'Only the host can do that';
  end if;
  return t;
end $$;

create or replace function public.score_auth_player(p_code text, p_token text)
returns public.score_players language plpgsql set search_path = public as $$
declare t public.score_tables; p public.score_players;
begin
  t := public.score_table_by_code(p_code);
  select pl.* into p from public.score_secrets s
    join public.score_players pl on pl.id = s.player_id
    where s.token_hash = public.score_hash(p_token) and s.table_id = t.id and s.role = 'player' and not pl.removed;
  if not found then raise exception 'Your seat was freed. Join the table again.'; end if;
  return p;
end $$;

create or replace function public.score_touch(p_table uuid)
returns void language sql set search_path = public as $$
  update public.score_tables set updated_at = now() where id = p_table;
$$;

create or replace function public.score_check_hand(t public.score_tables, p_hand int)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_hand is null or p_hand < 0 or p_hand >= jsonb_array_length(t.contracts) then
    raise exception 'That hand is not part of this game';
  end if;
end $$;

create or replace function public.score_put(t public.score_tables, p_player uuid, p_hand int, p_score int, p_by text)
returns void language plpgsql set search_path = public as $$
begin
  perform public.score_check_hand(t, p_hand);
  if p_score is not null and p_score not between -999 and 9999 then raise exception 'Points must be a whole number up to 9999'; end if;
  insert into public.score_entries (table_id, player_id, game_no, hand, score, entered_by, updated_at)
  values (t.id, p_player, t.game_no, p_hand, p_score, p_by, now())
  on conflict (player_id, game_no, hand)
  do update set score = excluded.score, entered_by = excluded.entered_by, updated_at = now();
  if t.status = 'setup' and p_score is not null then
    update public.score_tables set status = 'playing' where id = t.id;
  end if;
  perform public.score_touch(t.id);
end $$;

create or replace function public.score_seat_player(t public.score_tables, p_name text, p_has_device boolean)
returns public.score_players language plpgsql set search_path = public as $$
declare p public.score_players; v_seat int; v_color int;
begin
  if (select count(*) from public.score_players where table_id = t.id and not removed) >= 12 then
    raise exception 'This table is full (12 players)';
  end if;
  select coalesce(max(seat) + 1, 0) into v_seat from public.score_players where table_id = t.id and not removed;
  select min(c) into v_color from generate_series(0, 7) c
    where c not in (select color from public.score_players where table_id = t.id and not removed);
  insert into public.score_players (table_id, name, seat, color, has_device)
  values (t.id, public.score_clean_name(p_name), v_seat, coalesce(v_color, v_seat % 8), p_has_device)
  returning * into p;
  return p;
end $$;

create or replace function public.score_issue(t public.score_tables, p_player uuid, p_role text)
returns text language plpgsql set search_path = public as $$
declare v_token text := public.score_new_token();
begin
  insert into public.score_secrets (token_hash, table_id, player_id, role)
  values (public.score_hash(v_token), t.id, p_player, p_role);
  return v_token;
end $$;

-- ============================================================
-- CLIENT FUNCTIONS
-- ============================================================

-- Host: open a new table. Needs a signed-in play27 account (same bar as creating an online
-- game); players never need one. Returns the join code and the host key.
create or replace function public.score_create_table(
  p_contracts jsonb default null, p_rules jsonb default null,
  p_card_values jsonb default null, p_notes text default '', p_players text[] default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t public.score_tables;
  v_code text;
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_name text;
  v_token text;
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Sign in with your play27 account to start a table';
  end if;

  delete from public.score_tables where updated_at < now() - interval '24 hours';

  loop
    v_code := '';
    for i in 1..5 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.score_tables where code = v_code);
  end loop;

  insert into public.score_tables (code, created_by, contracts, rules, card_values, notes)
  values (v_code, v_user,
          public.score_clean_contracts(coalesce(p_contracts, public.score_default_contracts())),
          public.score_clean_rules(p_rules),
          public.score_clean_values(p_card_values),
          left(coalesce(p_notes, ''), 400))
  returning * into t;

  if p_players is not null then
    foreach v_name in array p_players[1:12] loop
      if btrim(coalesce(v_name, '')) <> '' then
        perform public.score_seat_player(t, v_name, false);
      end if;
    end loop;
  end if;

  v_token := public.score_issue(t, null, 'host');
  return jsonb_build_object('code', t.code, 'table_id', t.id, 'host_token', v_token);
end $$;

-- Who does this key belong to at this table? Never raises for a bad key.
create or replace function public.score_whoami(p_code text, p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.score_tables; s public.score_secrets;
begin
  select * into t from public.score_tables where code = upper(btrim(coalesce(p_code, '')));
  if not found then return jsonb_build_object('table', false); end if;
  select * into s from public.score_secrets where token_hash = public.score_hash(p_token) and table_id = t.id;
  if not found then return jsonb_build_object('table', true, 'table_id', t.id, 'role', null); end if;
  if s.role = 'player' and exists (select 1 from public.score_players where id = s.player_id and removed) then
    return jsonb_build_object('table', true, 'table_id', t.id, 'role', null);
  end if;
  return jsonb_build_object('table', true, 'table_id', t.id, 'role', s.role, 'player_id', s.player_id);
end $$;

-- Player: join with a new name.
create or replace function public.score_join(p_code text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.score_tables; p public.score_players;
begin
  t := public.score_table_by_code(p_code);
  if exists (select 1 from public.score_players where table_id = t.id and not removed
             and lower(name) = lower(public.score_clean_name(p_name))) then
    raise exception 'Someone at this table already has that name. If it is you, tap your name instead.';
  end if;
  p := public.score_seat_player(t, p_name, true);
  perform public.score_touch(t.id);
  return jsonb_build_object('player_id', p.id, 'token', public.score_issue(t, p.id, 'player'));
end $$;

-- Player: take a seat the host added (a seat with no phone yet).
create or replace function public.score_claim(p_code text, p_player_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.score_tables; p public.score_players;
begin
  t := public.score_table_by_code(p_code);
  select * into p from public.score_players where id = p_player_id and table_id = t.id and not removed for update;
  if not found then raise exception 'That seat is no longer at this table'; end if;
  if p.has_device then raise exception 'That seat is already on another phone. Ask the host to free it.'; end if;
  update public.score_players set has_device = true where id = p.id;
  perform public.score_touch(t.id);
  return jsonb_build_object('player_id', p.id, 'token', public.score_issue(t, p.id, 'player'));
end $$;

-- Player: enter or clear their own score for a hand.
create or replace function public.score_submit(p_code text, p_token text, p_hand int, p_score int)
returns void language plpgsql security definer set search_path = public as $$
declare p public.score_players; t public.score_tables;
begin
  p := public.score_auth_player(p_code, p_token);
  select * into t from public.score_tables where id = p.table_id;
  if t.status = 'done' then raise exception 'This game is finished. Ask the host to reopen it.'; end if;
  perform public.score_put(t, p.id, p_hand, p_score, 'player');
end $$;

create or replace function public.score_rename_self(p_code text, p_token text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.score_players;
begin
  p := public.score_auth_player(p_code, p_token);
  update public.score_players set name = public.score_clean_name(p_name) where id = p.id;
  perform public.score_touch(p.table_id);
end $$;

-- Player: give up this phone's hold on the seat (the seat and its scores stay).
create or replace function public.score_leave(p_code text, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.score_players;
begin
  p := public.score_auth_player(p_code, p_token);
  delete from public.score_secrets where player_id = p.id;
  update public.score_players set has_device = false where id = p.id;
  perform public.score_touch(p.table_id);
end $$;

-- Host: set or clear anyone's score.
create or replace function public.score_host_set_score(p_code text, p_token text, p_player_id uuid, p_hand int, p_score int)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  if t.status = 'done' then raise exception 'This game is finished. Reopen it to change scores.'; end if;
  if not exists (select 1 from public.score_players where id = p_player_id and table_id = t.id and not removed) then
    raise exception 'That player is not at this table';
  end if;
  perform public.score_put(t, p_player_id, p_hand, p_score, 'host');
end $$;

-- Host: change table settings. Accepts any of: status (setup/playing), hand,
-- first_dealer, contracts, rules, card_values, notes.
create or replace function public.score_host_update(p_code text, p_token text, p_patch jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables; v_contracts jsonb; v_players int;
begin
  t := public.score_auth_host(p_code, p_token);
  p_patch := coalesce(p_patch, '{}'::jsonb);
  v_contracts := case when p_patch ? 'contracts' then public.score_clean_contracts(p_patch->'contracts') else t.contracts end;
  select count(*) into v_players from public.score_players where table_id = t.id and not removed;

  update public.score_tables set
    contracts    = v_contracts,
    rules        = case when p_patch ? 'rules' then public.score_clean_rules(t.rules || (p_patch->'rules')) else rules end,
    card_values  = case when p_patch ? 'card_values' then public.score_clean_values(t.card_values || (p_patch->'card_values')) else card_values end,
    notes        = case when p_patch ? 'notes' then left(coalesce(p_patch->>'notes', ''), 400) else notes end,
    status       = case when p_patch->>'status' in ('setup', 'playing') then p_patch->>'status' else status end,
    hand         = least(greatest(coalesce((p_patch->>'hand')::int, hand), 0), jsonb_array_length(v_contracts) - 1),
    first_dealer = least(greatest(coalesce((p_patch->>'first_dealer')::int, first_dealer), 0), greatest(v_players - 1, 0)),
    updated_at   = now()
  where id = t.id;
end $$;

-- Host: add a player who has no phone.
create or replace function public.score_host_add_player(p_code text, p_token text, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare t public.score_tables; p public.score_players;
begin
  t := public.score_auth_host(p_code, p_token);
  p := public.score_seat_player(t, p_name, false);
  perform public.score_touch(t.id);
  return p.id;
end $$;

create or replace function public.score_host_rename_player(p_code text, p_token text, p_player_id uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  update public.score_players set name = public.score_clean_name(p_name)
  where id = p_player_id and table_id = t.id and not removed;
  perform public.score_touch(t.id);
end $$;

-- Host: take a player off the table. Their phone loses access; past scores are kept.
create or replace function public.score_host_remove_player(p_code text, p_token text, p_player_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  update public.score_players set removed = true, has_device = false where id = p_player_id and table_id = t.id;
  delete from public.score_secrets where player_id = p_player_id;
  perform public.score_touch(t.id);
end $$;

-- Host: free a seat so the player can claim it from a different phone.
create or replace function public.score_host_release_player(p_code text, p_token text, p_player_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  update public.score_players set has_device = false where id = p_player_id and table_id = t.id;
  delete from public.score_secrets where player_id = p_player_id;
  perform public.score_touch(t.id);
end $$;

-- Host: set seat order (player ids in seat order) and who deals hand 1.
create or replace function public.score_host_set_seats(p_code text, p_token text, p_order uuid[], p_first_dealer int)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables; i int;
begin
  t := public.score_auth_host(p_code, p_token);
  for i in 1..coalesce(array_length(p_order, 1), 0) loop
    update public.score_players set seat = i - 1 where id = p_order[i] and table_id = t.id and not removed;
  end loop;
  update public.score_tables
    set first_dealer = least(greatest(coalesce(p_first_dealer, 0), 0), greatest(coalesce(array_length(p_order, 1), 1) - 1, 0)),
        updated_at = now()
  where id = t.id;
end $$;

-- Host: end the game and save it to history.
create or replace function public.score_host_finish(p_code text, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables; v_results jsonb;
begin
  t := public.score_auth_host(p_code, p_token);
  select coalesce(jsonb_agg(jsonb_build_object('name', name, 'total', total, 'rank', rnk) order by total, seat), '[]'::jsonb)
    into v_results
  from (
    select p.name, p.seat, coalesce(sum(e.score), 0)::int as total,
           rank() over (order by coalesce(sum(e.score), 0)) as rnk
    from public.score_players p
    left join public.score_entries e on e.player_id = p.id and e.game_no = t.game_no
    where p.table_id = t.id and not p.removed
    group by p.id, p.name, p.seat
  ) r;
  insert into public.score_history (table_id, code, game_no, hands, results)
  values (t.id, t.code, t.game_no, jsonb_array_length(t.contracts), v_results)
  on conflict (table_id, game_no) do update set results = excluded.results, hands = excluded.hands, ended_at = now();
  update public.score_tables set status = 'done', ended_at = now(), updated_at = now() where id = t.id;
end $$;

-- Host: undo a finish (back to the last hand).
create or replace function public.score_host_reopen(p_code text, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  delete from public.score_history where table_id = t.id and game_no = t.game_no;
  update public.score_tables
    set status = 'playing', ended_at = null, hand = jsonb_array_length(contracts) - 1, updated_at = now()
  where id = t.id;
end $$;

-- Host: start a new game with the same seats. Earlier scores stay under the old game number.
create or replace function public.score_host_new_game(p_code text, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  update public.score_tables
    set game_no = game_no + 1, hand = 0, status = 'playing', ended_at = null, updated_at = now()
  where id = t.id;
end $$;

-- Host: issue another host key (for a second host device).
create or replace function public.score_host_add_host(p_code text, p_token text)
returns text language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  return public.score_issue(t, null, 'host');
end $$;

-- Host: have every host device with its speaker on read the standings and/or the current hand aloud.
-- Devices compose the words from their own copy of the table; this only says what to read.
create or replace function public.score_host_announce(p_code text, p_token text, p_what text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  if p_what is null or p_what not in ('standings', 'hand', 'both') then
    raise exception 'Choose standings, hand, or both';
  end if;
  update public.score_tables
    set announce = p_what, announce_seq = announce_seq + 1, announce_at = now(), updated_at = now()
  where id = t.id;
end $$;

-- Host: close the table for everyone. History is kept.
create or replace function public.score_host_close(p_code text, p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare t public.score_tables;
begin
  t := public.score_auth_host(p_code, p_token);
  delete from public.score_tables where id = t.id;
end $$;

-- ── FUNCTION GRANTS ──
-- Named explicitly: the online game's score_cards() shares the prefix and must not be touched.
-- Helpers are internal only; opening a table needs a signed-in account; everything else is
-- open to anon and authenticated (the per-device keys do the checking).

do $$
declare
  f record;
  v_helpers text[] := array['score_hash', 'score_new_token', 'score_clean_name', 'score_default_contracts',
    'score_clean_contracts', 'score_clean_rules', 'score_clean_values', 'score_table_by_code',
    'score_auth_host', 'score_auth_player', 'score_touch', 'score_check_hand', 'score_put',
    'score_seat_player', 'score_issue'];
  v_signed_in text[] := array['score_create_table'];
  v_client text[] := array['score_whoami', 'score_join', 'score_claim', 'score_submit',
    'score_rename_self', 'score_leave', 'score_host_set_score', 'score_host_update',
    'score_host_add_player', 'score_host_rename_player', 'score_host_remove_player',
    'score_host_release_player', 'score_host_set_seats', 'score_host_finish',
    'score_host_reopen', 'score_host_new_game', 'score_host_add_host', 'score_host_announce', 'score_host_close'];
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any (v_helpers || v_signed_in || v_client)
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    if f.proname = any (v_client) then
      execute format('grant execute on function %s to anon, authenticated', f.sig);
    elsif f.proname = any (v_signed_in) then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
