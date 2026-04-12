-- ============================================================
-- Contract Rummy — Row Level Security Policies (Supabase)
-- Re-runnable: drops old policies/views before creating new ones.
-- ============================================================

-- ── DROP OLD VIEWS ──
drop view if exists player_round_state_public cascade;
drop view if exists rounds_safe cascade;

-- ── ENABLE RLS ──

alter table profiles enable row level security;
alter table games enable row level security;
alter table game_players enable row level security;
alter table rounds enable row level security;
alter table player_round_state enable row level security;
alter table melds enable row level security;
alter table round_cards enable row level security;
alter table buy_requests enable row level security;
alter table game_actions enable row level security;
alter table contracts enable row level security;
alter table invite_codes enable row level security;
alter table invite_redemptions enable row level security;

-- ── DROP OLD POLICIES (safe: no error if they don't exist) ──

drop policy if exists "Anyone can view profiles" on profiles;
drop policy if exists "Users can update own profile" on profiles;
drop policy if exists "Users can insert own profile" on profiles;
drop policy if exists "Anyone can read contracts" on contracts;
drop policy if exists "No direct access to invite codes" on invite_codes;
drop policy if exists "No direct access to invite redemptions" on invite_redemptions;
drop policy if exists "Players can view games they are in" on games;
drop policy if exists "Authenticated users can create games" on games;
drop policy if exists "Game creator can update game" on games;
drop policy if exists "Authenticated users can view game_players" on game_players;
drop policy if exists "Users can join games" on game_players;
drop policy if exists "Users can update own connection status" on game_players;
drop policy if exists "Players in game can view rounds" on rounds;
drop policy if exists "Players can see own full state" on player_round_state;
drop policy if exists "Players in game can view melds" on melds;
drop policy if exists "Players can see own hand cards" on round_cards;
drop policy if exists "Players can see discard pile" on round_cards;
drop policy if exists "Players can see meld cards" on round_cards;
drop policy if exists "Players in game can view buy requests" on buy_requests;
drop policy if exists "Players in game can view actions" on game_actions;

-- ============================================================
-- POLICIES
-- ============================================================

-- ── PROFILES ──

create policy "Anyone can view profiles"
  on profiles for select using (true);

create policy "Users can update own profile"
  on profiles for update using (auth.uid() = id);

create policy "Users can insert own profile"
  on profiles for insert with check (auth.uid() = id);

-- ── CONTRACTS (reference data) ──

create policy "Anyone can read contracts"
  on contracts for select using (true);

-- ── INVITE CODES ──
-- No direct access — all operations go through SECURITY DEFINER functions

create policy "No direct access to invite codes"
  on invite_codes for select using (false);

create policy "No direct access to invite redemptions"
  on invite_redemptions for select using (false);

-- ── GAMES ──

create policy "Players can view games they are in"
  on games for select using (
    status = 'waiting'
    or created_by = auth.uid()
    or id in (select game_id from game_players where player_id = auth.uid())
    or id in (select game_id from late_join_requests where player_id = auth.uid())
  );

create policy "Authenticated users can create games"
  on games for insert with check (auth.uid() = created_by);

create policy "Game creator can update game"
  on games for update using (auth.uid() = created_by);

-- ── GAME PLAYERS ──

create policy "Authenticated users can view game_players"
  on game_players for select using (auth.uid() is not null);

create policy "Users can join games"
  on game_players for insert with check (auth.uid() = player_id);

create policy "Users can update own connection status"
  on game_players for update using (auth.uid() = player_id);

-- ── ROUNDS ──

create policy "Players in game can view rounds"
  on rounds for select using (
    exists (
      select 1 from game_players
      where game_players.game_id = rounds.game_id
        and game_players.player_id = auth.uid()
    )
  );

-- ── PLAYER ROUND STATE ──

create policy "Players can see own full state"
  on player_round_state for select using (
    auth.uid() = player_id
  );

-- View for opponent info (card count from round_cards)
create view player_round_state_public as
  select
    prs.id, prs.round_id, prs.player_id,
    (select count(*) from round_cards rc
     where rc.round_id = prs.round_id and rc.player_id = prs.player_id
       and rc.location = 'hand')::int as cards_in_hand,
    prs.has_met_contract, prs.buys_used, prs.score
  from player_round_state prs;

-- ── MELDS ──

create policy "Players in game can view melds"
  on melds for select using (
    exists (
      select 1 from rounds r
      join game_players gp on gp.game_id = r.game_id
      where r.id = melds.round_id
        and gp.player_id = auth.uid()
    )
  );

-- ── ROUND CARDS ──
-- Players can see: own hand, discard pile, meld cards.
-- Deck cards and other players' hands are hidden.
-- All card operations go through SECURITY DEFINER functions.

create policy "Players can see own hand cards"
  on round_cards for select using (
    location = 'hand' and player_id = auth.uid()
  );

create policy "Players can see discard pile"
  on round_cards for select using (
    location = 'discard'
    and exists (
      select 1 from rounds r
      join game_players gp on gp.game_id = r.game_id
      where r.id = round_cards.round_id
        and gp.player_id = auth.uid()
    )
  );

create policy "Players can see meld cards"
  on round_cards for select using (
    location = 'meld'
    and exists (
      select 1 from rounds r
      join game_players gp on gp.game_id = r.game_id
      where r.id = round_cards.round_id
        and gp.player_id = auth.uid()
    )
  );

-- NOTE: No policy for location='deck' — deck cards are hidden from all players.
-- NOTE: No policy for other players' hand cards — only your own hand is visible.
-- Bot players with SECURITY DEFINER access can see everything.

-- ── BUY REQUESTS ──

create policy "Players in game can view buy requests"
  on buy_requests for select using (
    exists (
      select 1 from rounds r
      join game_players gp on gp.game_id = r.game_id
      where r.id = buy_requests.round_id
        and gp.player_id = auth.uid()
    )
  );

-- ── GAME ACTIONS ──

create policy "Players in game can view actions"
  on game_actions for select using (
    exists (
      select 1 from game_players
      where game_players.game_id = game_actions.game_id
        and game_players.player_id = auth.uid()
    )
  );

-- All inserts/updates to rounds, player_round_state, melds, round_cards,
-- buy_requests, and game_actions go through SECURITY DEFINER functions.
-- No direct insert/update policies needed for players on those tables.
