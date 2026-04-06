-- ============================================================
-- Contract Rummy — Database Schema (Supabase / PostgreSQL)
-- Re-runnable: drops old objects before creating new ones.
-- ============================================================

-- ── DROP OLD VIEWS (depend on columns we're removing) ──
drop view if exists rounds_safe cascade;
drop view if exists player_round_state_public cascade;

-- ── DROP OLD TABLES (reverse dependency order) ──
drop table if exists game_actions cascade;
drop table if exists buy_requests cascade;
drop table if exists round_cards cascade;
drop table if exists melds cascade;
drop table if exists player_round_state cascade;
drop table if exists rounds cascade;
drop table if exists game_players cascade;
drop table if exists games cascade;
drop table if exists invite_redemptions cascade;
drop table if exists invite_codes cascade;
drop table if exists contracts cascade;
drop table if exists profiles cascade;

-- ── DROP OLD TYPES ──
drop type if exists action_type cascade;
drop type if exists card_location cascade;
drop type if exists meld_type cascade;
drop type if exists turn_phase cascade;
drop type if exists round_status cascade;
drop type if exists game_status cascade;

-- ============================================================
-- TYPES
-- ============================================================

create type game_status as enum ('waiting', 'active', 'finished');
create type round_status as enum ('dealing', 'active', 'finished');
create type turn_phase as enum ('draw', 'action', 'discard', 'buy_window');
create type meld_type as enum ('set', 'run');
create type card_location as enum ('deck', 'discard', 'hand', 'meld');
create type action_type as enum (
  'draw_deck', 'draw_discard', 'buy_request', 'buy_awarded',
  'contract_met', 'lay_meld', 'lay_off', 'discard', 'round_start', 'round_end',
  'game_start', 'game_end', 'chat'
);

-- ============================================================
-- TABLES
-- ============================================================

-- ── PROFILES ──
-- Extends Supabase auth.users with display name + avatar

create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

-- ── GAMES ──
-- A game session (7 rounds of contract rummy)

create table games (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,  -- 6-char join code
  status      game_status not null default 'waiting',
  created_by  uuid not null references profiles(id),
  num_decks   int not null default 2,
  num_jokers  int not null default 0,
  buy_countdown_seconds int not null default 10,
  max_buys_per_round    int,  -- null = unlimited
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);

create index idx_games_code on games(code);
create index idx_games_status on games(status);

-- ── GAME PLAYERS ──
-- Players seated in a game

create table game_players (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references games(id) on delete cascade,
  player_id     uuid not null references profiles(id),
  seat_position int not null,  -- 0-based turn order
  is_connected  boolean not null default true,
  joined_at     timestamptz not null default now(),
  unique(game_id, player_id),
  unique(game_id, seat_position)
);

create index idx_game_players_game on game_players(game_id);

-- ── ROUNDS ──
-- Each game has 7 rounds with escalating contracts

create table rounds (
  id                uuid primary key default gen_random_uuid(),
  game_id           uuid not null references games(id) on delete cascade,
  round_number      int not null check (round_number between 1 and 7),
  contract_sets     int not null,
  contract_runs     int not null,
  cards_dealt       int not null,  -- 10 for rounds 1-4, 12 for rounds 5-7
  dealer_seat       int not null,
  current_turn_seat int not null,
  turn_phase        turn_phase not null default 'draw',
  discard_bought    boolean not null default false,  -- true if a buy occurred this turn
  status            round_status not null default 'dealing',
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  unique(game_id, round_number)
);

create index idx_rounds_game on rounds(game_id);

-- ── PLAYER ROUND STATE ──
-- Per-player state within a round (contract status, score)

create table player_round_state (
  id               uuid primary key default gen_random_uuid(),
  round_id         uuid not null references rounds(id) on delete cascade,
  player_id        uuid not null references profiles(id),
  has_met_contract boolean not null default false,
  has_drawn        boolean not null default false,  -- reset each turn
  buys_used        int not null default 0,
  score            int,  -- set at round end (points from unmelded cards)
  unique(round_id, player_id)
);

create index idx_prs_round on player_round_state(round_id);
create index idx_prs_player on player_round_state(player_id);

-- ── MELDS ──
-- Laid-down sets and runs (cards tracked in round_cards)

create table melds (
  id         uuid primary key default gen_random_uuid(),
  round_id   uuid not null references rounds(id) on delete cascade,
  player_id  uuid not null references profiles(id),
  meld_type  meld_type not null,
  run_suit   text,  -- for runs: S, H, D, C
  created_at timestamptz not null default now()
);

create index idx_melds_round on melds(round_id);

-- ── ROUND CARDS ──
-- Single source of truth for every card's location in a round.
-- PK (round_id, card_id) guarantees a card can only exist in one place.

create table round_cards (
  round_id   uuid not null references rounds(id) on delete cascade,
  card_id    text not null,          -- DSVV format (e.g. '0314')
  location   card_location not null, -- deck, discard, hand, meld
  player_id  uuid references profiles(id),  -- set for hand + meld
  meld_id    uuid references melds(id) on delete set null,  -- set for meld only
  position   int not null default 0, -- ordering within location group
  primary key (round_id, card_id)
);

-- Partial indexes for fast lookups by location type
create index idx_rc_deck on round_cards(round_id, position)
  where location = 'deck';
create index idx_rc_discard on round_cards(round_id, position)
  where location = 'discard';
create index idx_rc_hand on round_cards(round_id, player_id)
  where location = 'hand';
create index idx_rc_meld on round_cards(round_id, meld_id, position)
  where location = 'meld';

-- ── BUY REQUESTS ──
-- Queue of players requesting to buy during the buy window

create table buy_requests (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references rounds(id) on delete cascade,
  player_id     uuid not null references profiles(id),
  seat_position int not null,
  requested_at  timestamptz not null default now(),
  unique(round_id, player_id)
);

-- ── GAME ACTIONS ──
-- Full action log for replay, game log display, and history

create table game_actions (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references games(id) on delete cascade,
  round_id    uuid references rounds(id) on delete cascade,
  player_id   uuid references profiles(id),
  action_type action_type not null,
  details     jsonb not null default '{}',
  created_at  timestamptz not null default now()
);

create index idx_actions_game on game_actions(game_id);
create index idx_actions_round on game_actions(round_id);
create index idx_actions_created on game_actions(created_at);

-- ── INVITE CODES ──
-- Gate signup behind invite codes you distribute manually

create table invite_codes (
  code        text primary key,
  created_by  uuid references profiles(id),
  expires_at  timestamptz not null default (now() + interval '4 hours'),
  created_at  timestamptz not null default now()
);

-- Track who used each code (many-to-one)
create table invite_redemptions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null references invite_codes(code),
  used_by     uuid not null references auth.users(id),
  redeemed_at timestamptz not null default now(),
  unique(code, used_by)
);

-- ── CONTRACT DEFINITIONS ──
-- Reference table: what each round requires

create table contracts (
  round_number  int primary key check (round_number between 1 and 7),
  num_sets      int not null,
  num_runs      int not null,
  cards_dealt   int not null,
  min_run_length int not null default 3,  -- 3 for most rounds
  must_go_out   boolean not null default false,  -- round 7: must meld entire hand
  description   text not null
);

insert into contracts (round_number, num_sets, num_runs, cards_dealt, min_run_length, must_go_out, description) values
  (1, 2, 0, 10, 3, false, '2 Sets of 3'),
  (2, 1, 1, 10, 3, false, '1 Set of 3 + 1 Run of 3'),
  (3, 0, 2, 10, 3, false, '2 Runs of 3'),
  (4, 3, 0, 10, 3, false, '3 Sets of 3'),
  (5, 2, 1, 12, 3, false, '2 Sets of 3 + 1 Run of 3'),
  (6, 1, 2, 12, 3, false, '1 Set of 3 + 2 Runs of 3'),
  (7, 0, 3, 12, 3, true,  '3 Runs of 3 (must meld all)');

-- ── REALTIME ──
-- Enable Supabase Realtime on tables players need to subscribe to

alter publication supabase_realtime add table games;
alter publication supabase_realtime add table game_players;
alter publication supabase_realtime add table rounds;
alter publication supabase_realtime add table player_round_state;
alter publication supabase_realtime add table melds;
alter publication supabase_realtime add table round_cards;
alter publication supabase_realtime add table buy_requests;
alter publication supabase_realtime add table game_actions;
