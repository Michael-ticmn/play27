-- ============================================================
-- Contract Rummy — Game Logic Functions (Supabase / PL/pgSQL)
-- All functions are SECURITY DEFINER so they can access hidden
-- data (draw pile, other players' hands) without exposing it.
-- Re-runnable: uses CREATE OR REPLACE + drops removed functions.
-- ============================================================
--
-- CARD STORAGE: All cards live in `round_cards` table.
-- PK (round_id, card_id) guarantees every card exists in exactly
-- one location: 'deck', 'discard', 'hand', or 'meld'.
--
-- CARD ID ENCODING (4-character text string):
--   Format: DSVV
--   D  = deck number (0-2)
--   S  = suit (0=Spades, 1=Hearts, 2=Diamonds, 3=Clubs, 9=Joker)
--   VV = value (02-14: 2-10, 11=J, 12=Q, 13=K, 14=A)
--   Jokers: suit=9, value=01 or 02 (e.g. '0901', '0902', '1901')
--
-- Examples:
--   '0002' = deck 0, spades, 2
--   '0114' = deck 0, hearts, ace
--   '1213' = deck 1, diamonds, king
--   '0901' = deck 0, joker #1
-- ============================================================

-- ── LATE JOIN REQUESTS TABLE ──
-- Stores requests from players wanting to join an active game.
-- Created here (not schema.sql) so it can be deployed incrementally.
create table if not exists late_join_requests (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid not null references games(id) on delete cascade,
  player_id       uuid not null references profiles(id),
  status          text not null default 'pending'
                  check (status in ('pending','approved','spectating','kicked')),
  scoring_method  text check (scoring_method in ('average','max','max_plus_avg')),
  resolved_by     uuid references profiles(id),
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique(game_id, player_id)
);

create index if not exists idx_ljr_game on late_join_requests(game_id);

-- RLS: read access for involved players; mutations go through security definer functions
alter table late_join_requests enable row level security;
drop policy if exists "View late join requests" on late_join_requests;
create policy "View late join requests"
  on late_join_requests for select using (
    player_id = auth.uid()
    or game_id in (select game_id from game_players where player_id = auth.uid())
  );

-- Add to realtime publication (ignore error if already added)
do $$ begin
  alter publication supabase_realtime add table late_join_requests;
exception when duplicate_object then null;
end $$;

-- ── DROP REMOVED FUNCTIONS (from old array-based model) ──
drop function if exists build_deck(int, int);
drop function if exists remove_cards(text[], text[]);

-- ────────────────────────────────────────────────────────────
-- HELPER: Extract deck from card ID
-- ────────────────────────────────────────────────────────────
create or replace function card_deck(card text)
returns int language sql immutable as $$
  select substr(card, 1, 1)::int;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Extract suit from card ID (0-3, 9=joker)
-- ────────────────────────────────────────────────────────────
create or replace function card_suit(card text)
returns int language sql immutable as $$
  select substr(card, 2, 1)::int;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Extract value from card ID (02-14, jokers=01-02)
-- ────────────────────────────────────────────────────────────
create or replace function card_value(card text)
returns int language sql immutable as $$
  select substr(card, 3, 2)::int;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Is this card a joker?
-- ────────────────────────────────────────────────────────────
create or replace function is_joker(card text)
returns boolean language sql immutable as $$
  select substr(card, 2, 1) = '9';
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Score a hand (unmelded cards)
-- Joker=25, Ace=15, Face(J/Q/K)=10, Number=face value
-- ────────────────────────────────────────────────────────────
create or replace function score_cards(cards text[])
returns int language plpgsql as $$
declare
  total int := 0;
  card text;
  v int;
begin
  foreach card in array cards loop
    if is_joker(card) then
      total := total + 25;
    else
      v := card_value(card);
      if v = 14 then       -- Ace
        total := total + 15;
      elsif v >= 11 then    -- J, Q, K
        total := total + 10;
      else
        total := total + v; -- number cards
      end if;
    end if;
  end loop;
  return total;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Validate a set (3+ cards of same value)
-- Jokers can substitute. Must have at least 2 natural cards.
-- ────────────────────────────────────────────────────────────
create or replace function validate_set(cards text[])
returns boolean language plpgsql as $$
declare
  card text;
  base_val int := null;
  natural_count int := 0;
  joker_count int := 0;
begin
  if array_length(cards, 1) < 3 then return false; end if;

  foreach card in array cards loop
    if is_joker(card) then
      joker_count := joker_count + 1;
    else
      natural_count := natural_count + 1;
      if base_val is null then
        base_val := card_value(card);
      elsif card_value(card) != base_val then
        return false;
      end if;
    end if;
  end loop;

  -- Must have at least 2 natural cards
  if natural_count < 2 then return false; end if;

  return true;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Validate a run (consecutive cards, same suit)
-- Jokers fill gaps. Ace high or low but not wrapping.
-- ────────────────────────────────────────────────────────────
create or replace function validate_run(cards text[], p_min_length int default 3)
returns boolean language plpgsql as $$
declare
  card text;
  run_suit int := null;
  joker_count int := 0;
  vals int[] := '{}';
  v int;
  i int;
  gaps int := 0;
  sorted int[];
  vals_low int[] := '{}';
  try_low boolean := false;
begin
  if array_length(cards, 1) < p_min_length then return false; end if;

  foreach card in array cards loop
    if is_joker(card) then
      joker_count := joker_count + 1;
    else
      if run_suit is null then
        run_suit := card_suit(card);
      elsif card_suit(card) != run_suit then
        return false;  -- mixed suits
      end if;
      v := card_value(card);
      vals := array_append(vals, v);
      if v = 14 then try_low := true; end if;
    end if;
  end loop;

  if array_length(vals, 1) < 2 then return false; end if;

  -- Try ace-high first
  select array_agg(x order by x) into sorted from unnest(vals) as x;

  gaps := 0;
  for i in 2..array_length(sorted, 1) loop
    gaps := gaps + (sorted[i] - sorted[i-1] - 1);
  end loop;

  if gaps <= joker_count then return true; end if;

  -- Try ace-low (ace = 1)
  if try_low then
    vals_low := '{}';
    foreach v in array vals loop
      if v = 14 then
        vals_low := array_append(vals_low, 1);
      else
        vals_low := array_append(vals_low, v);
      end if;
    end loop;

    select array_agg(x order by x) into sorted from unnest(vals_low) as x;

    gaps := 0;
    for i in 2..array_length(sorted, 1) loop
      gaps := gaps + (sorted[i] - sorted[i-1] - 1);
    end loop;

    if gaps <= joker_count then return true; end if;
  end if;

  return false;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Check if a card can be laid off onto an existing meld
-- ────────────────────────────────────────────────────────────
create or replace function can_lay_off(p_meld_id uuid, p_card text)
returns boolean language plpgsql as $$
declare
  m record;
  meld_cards text[];
  test_cards text[];
begin
  select * into m from melds where id = p_meld_id;
  if not found then return false; end if;

  -- Get current meld cards from round_cards
  select array_agg(rc.card_id order by rc.position)
    into meld_cards
    from round_cards rc
    where rc.meld_id = p_meld_id and rc.location = 'meld';

  test_cards := array_append(coalesce(meld_cards, '{}'), p_card);

  if m.meld_type = 'set' then
    return validate_set(test_cards);
  else
    return validate_run(test_cards, 3);
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Count cards in a player's hand for a round
-- ────────────────────────────────────────────────────────────
create or replace function hand_count(p_round_id uuid, p_player_id uuid)
returns int language sql as $$
  select count(*)::int from round_cards
    where round_id = p_round_id and player_id = p_player_id and location = 'hand';
$$;

-- ────────────────────────────────────────────────────────────
-- HELPER: Get a player's hand as text array
-- ────────────────────────────────────────────────────────────
create or replace function get_hand(p_round_id uuid, p_player_id uuid)
returns text[] language sql as $$
  select coalesce(array_agg(card_id order by position), '{}')
    from round_cards
    where round_id = p_round_id and player_id = p_player_id and location = 'hand';
$$;

-- ════════════════════════════════════════════════════════════
-- GAME LIFECYCLE FUNCTIONS
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- REDEEM INVITE CODE
-- Called during signup to validate and claim an invite code.
-- Returns true if valid, raises exception if not.
-- ────────────────────────────────────────────────────────────
create or replace function redeem_invite_code(p_code text)
returns boolean
language plpgsql security definer as $$
declare
  v_code invite_codes%rowtype;
begin
  select * into v_code from invite_codes where code = upper(trim(p_code));

  if not found then
    raise exception 'Invalid invite code';
  end if;

  if v_code.expires_at < now() then
    raise exception 'Invite code has expired';
  end if;

  -- Check if this user already redeemed this code
  if exists (
    select 1 from invite_redemptions
    where code = v_code.code and used_by = auth.uid()
  ) then
    return true; -- idempotent
  end if;

  insert into invite_redemptions (code, used_by)
  values (v_code.code, auth.uid());

  return true;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- Auto-create profile on signup
-- ────────────────────────────────────────────────────────────
create or replace function handle_new_user()
returns trigger
language plpgsql security definer as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', 'Player'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ────────────────────────────────────────────────────────────
-- Generate a unique 6-character join code
-- ────────────────────────────────────────────────────────────
create or replace function generate_game_code()
returns text language plpgsql as $$
declare
  chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
  exists_already boolean;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    end loop;

    select exists(select 1 from games where games.code = v_code)
      into exists_already;

    if not exists_already then
      return v_code;
    end if;
  end loop;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- CREATE GAME
-- ────────────────────────────────────────────────────────────
create or replace function create_game(
  p_buy_countdown int default 10,
  p_max_buys int default null,
  p_num_decks int default 2,
  p_num_jokers int default 0
)
returns jsonb
language plpgsql security definer as $$
declare
  v_game_id uuid;
  v_code text;
  v_player_id uuid := auth.uid();
begin
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  v_code := generate_game_code();

  insert into games (code, created_by, buy_countdown_seconds, max_buys_per_round, num_decks, num_jokers)
  values (v_code, v_player_id, p_buy_countdown, p_max_buys, p_num_decks, p_num_jokers)
  returning id into v_game_id;

  insert into game_players (game_id, player_id, seat_position)
  values (v_game_id, v_player_id, 0);

  -- Auto-create invite code so the game code doubles as signup code
  insert into invite_codes (code, created_by)
  values (v_code, v_player_id);

  return jsonb_build_object('game_id', v_game_id, 'code', v_code);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- JOIN GAME
-- ────────────────────────────────────────────────────────────
create or replace function join_game(p_code text)
returns uuid
language plpgsql security definer as $$
declare
  v_game record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_existing uuid;
begin
  if v_player_id is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_game from games where code = upper(p_code);
  if not found then
    raise exception 'Game not found';
  end if;

  -- Existing player? Always allow rejoin regardless of game status
  select id into v_existing from game_players
    where game_id = v_game.id and player_id = v_player_id;
  if found then
    return v_game.id;
  end if;

  -- Game finished? Block new players
  if v_game.status = 'finished' then
    raise exception 'Game has ended';
  end if;

  -- Game active? Create a late-join request (spectator until host approves)
  if v_game.status = 'active' then
    insert into late_join_requests (game_id, player_id, status)
    values (v_game.id, v_player_id, 'pending')
    on conflict (game_id, player_id) do nothing;
    return v_game.id;
  end if;

  -- Game waiting: normal join
  select coalesce(max(seat_position), -1) + 1 into v_seat
    from game_players where game_id = v_game.id;

  if v_seat >= 7 then
    raise exception 'Game is full (max 7 players)';
  end if;

  insert into game_players (game_id, player_id, seat_position)
  values (v_game.id, v_player_id, v_seat);

  return v_game.id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- START GAME
-- ────────────────────────────────────────────────────────────
create or replace function start_game(p_game_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_game record;
  v_player_count int;
  v_num_decks int;
begin
  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'Game not found'; end if;
  if v_game.created_by != auth.uid() then raise exception 'Only host can start'; end if;
  if v_game.status != 'waiting' then raise exception 'Game already started'; end if;

  select count(*) into v_player_count from game_players where game_id = p_game_id;
  if v_player_count < 2 then raise exception 'Need at least 2 players'; end if;

  v_num_decks := case when v_player_count <= 4 then 2 else 3 end;

  update games set
    status = 'active',
    num_decks = v_num_decks,
    started_at = now()
  where id = p_game_id;

  insert into game_actions (game_id, player_id, action_type, details)
  values (p_game_id, auth.uid(), 'game_start',
    jsonb_build_object('player_count', v_player_count, 'num_decks', v_num_decks));

  perform deal_round(p_game_id, 1);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- DEAL ROUND
-- All cards inserted into round_cards with location + position.
-- ────────────────────────────────────────────────────────────
create or replace function deal_round(p_game_id uuid, p_round_num int)
returns void
language plpgsql security definer as $$
declare
  v_game record;
  v_contract record;
  v_round_id uuid;
  v_player record;
  v_player_count int;
  v_dealer_seat int;
  v_first_turn int;
  v_pos int;
  v_card_id text;
  d int;
  s int;
  v int;
  j int;
  jk_deck int;
begin
  select * into v_game from games where id = p_game_id;
  select * into v_contract from contracts where round_number = p_round_num;
  select count(*) into v_player_count from game_players where game_id = p_game_id;

  v_dealer_seat := (p_round_num - 1) % v_player_count;
  v_first_turn := (v_dealer_seat + 1) % v_player_count;

  insert into rounds (
    game_id, round_number, contract_sets, contract_runs,
    cards_dealt, dealer_seat, current_turn_seat, status
  ) values (
    p_game_id, p_round_num, v_contract.num_sets, v_contract.num_runs,
    v_contract.cards_dealt, v_dealer_seat, v_first_turn, 'dealing'
  ) returning id into v_round_id;

  -- Generate all cards directly into round_cards as 'deck' with random positions
  -- First: regular cards
  v_pos := 0;
  for d in 0 .. v_game.num_decks - 1 loop
    for s in 0..3 loop
      for v in 2..14 loop
        v_card_id := d::text || s::text || lpad(v::text, 2, '0');
        insert into round_cards (round_id, card_id, location, position)
        values (v_round_id, v_card_id, 'deck', v_pos);
        v_pos := v_pos + 1;
      end loop;
    end loop;
  end loop;

  -- Jokers
  for j in 1..v_game.num_jokers loop
    jk_deck := (j - 1) % v_game.num_decks;
    v_card_id := jk_deck::text || '9' || lpad(j::text, 2, '0');
    insert into round_cards (round_id, card_id, location, position)
    values (v_round_id, v_card_id, 'deck', v_pos);
    v_pos := v_pos + 1;
  end loop;

  -- Shuffle: assign random positions to all deck cards
  with shuffled as (
    select card_id, row_number() over (order by random()) as new_pos
    from round_cards
    where round_id = v_round_id and location = 'deck'
  )
  update round_cards rc set position = s.new_pos
  from shuffled s
  where rc.round_id = v_round_id and rc.card_id = s.card_id;

  -- Deal cards to each player (take lowest-position deck cards)
  for v_player in
    select * from game_players where game_id = p_game_id order by seat_position
  loop
    with to_deal as (
      select card_id from round_cards
      where round_id = v_round_id and location = 'deck'
      order by position
      limit v_contract.cards_dealt
    )
    update round_cards set
      location = 'hand',
      player_id = v_player.player_id,
      position = 0  -- hand position not critical (client sorts)
    where round_id = v_round_id and card_id in (select card_id from to_deal);
  end loop;

  -- Create player_round_state rows
  for v_player in
    select * from game_players where game_id = p_game_id order by seat_position
  loop
    insert into player_round_state (round_id, player_id)
    values (v_round_id, v_player.player_id);
  end loop;

  -- Flip top deck card to discard
  update round_cards set
    location = 'discard',
    position = 1
  where round_id = v_round_id and card_id = (
    select card_id from round_cards
    where round_id = v_round_id and location = 'deck'
    order by position
    limit 1
  );

  update rounds set status = 'active' where id = v_round_id;

  insert into game_actions (game_id, round_id, action_type, details)
  values (p_game_id, v_round_id, 'round_start',
    jsonb_build_object('round', p_round_num, 'contract', v_contract.description,
      'cards_dealt', v_contract.cards_dealt));
end;
$$;

-- ════════════════════════════════════════════════════════════
-- TURN ACTION FUNCTIONS
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- DRAW FROM DECK
-- ────────────────────────────────────────────────────────────
create or replace function draw_from_deck(p_round_id uuid)
returns text
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_card text;
  v_prs record;
  v_deck_count int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'draw' then raise exception 'Not draw phase'; end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;
  if v_seat != v_round.current_turn_seat then raise exception 'Not your turn'; end if;

  select * into v_prs from player_round_state
    where round_id = p_round_id and player_id = v_player_id;
  if v_prs.has_drawn then raise exception 'Already drew this turn'; end if;

  select count(*) into v_deck_count from round_cards
    where round_id = p_round_id and location = 'deck';
  if v_deck_count = 0 then
    perform reshuffle_discard(p_round_id);
  end if;

  -- Take top card from deck (lowest position)
  select card_id into v_card from round_cards
    where round_id = p_round_id and location = 'deck'
    order by position
    limit 1;

  update round_cards set
    location = 'hand',
    player_id = v_player_id,
    position = 0
  where round_id = p_round_id and card_id = v_card;

  update rounds set turn_phase = 'action' where id = p_round_id;

  update player_round_state set has_drawn = true
    where round_id = p_round_id and player_id = v_player_id;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'draw_deck', '{}'::jsonb);

  return v_card;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- DRAW FROM DISCARD (active player — free, no penalty)
-- ────────────────────────────────────────────────────────────
create or replace function draw_from_discard(p_round_id uuid)
returns text
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_card text;
  v_discard_count int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'draw' then raise exception 'Not draw phase'; end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;
  if v_seat != v_round.current_turn_seat then raise exception 'Not your turn'; end if;

  if v_round.discard_bought then
    raise exception 'Discard was bought this turn — draw from deck';
  end if;

  select count(*) into v_discard_count from round_cards
    where round_id = p_round_id and location = 'discard';
  if v_discard_count = 0 then
    raise exception 'Discard pile is empty';
  end if;

  -- Take top discard (highest position)
  select card_id into v_card from round_cards
    where round_id = p_round_id and location = 'discard'
    order by position desc
    limit 1;

  update round_cards set
    location = 'hand',
    player_id = v_player_id,
    position = 0
  where round_id = p_round_id and card_id = v_card;

  update rounds set turn_phase = 'action' where id = p_round_id;

  update player_round_state set has_drawn = true
    where round_id = p_round_id and player_id = v_player_id;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'draw_discard',
    jsonb_build_object('card', v_card));

  return v_card;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- RESHUFFLE DISCARD into draw pile (when deck runs out)
-- Keep the top discard card, shuffle the rest into deck.
-- ────────────────────────────────────────────────────────────
create or replace function reshuffle_discard(p_round_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_discard_count int;
  v_top_card text;
begin
  select count(*) into v_discard_count from round_cards
    where round_id = p_round_id and location = 'discard';

  if v_discard_count <= 1 then
    raise exception 'Not enough cards to reshuffle';
  end if;

  -- Find the top discard card (highest position) — it stays
  select card_id into v_top_card from round_cards
    where round_id = p_round_id and location = 'discard'
    order by position desc
    limit 1;

  -- Move all other discard cards to deck with random positions
  with to_shuffle as (
    select card_id, row_number() over (order by random()) as new_pos
    from round_cards
    where round_id = p_round_id and location = 'discard' and card_id != v_top_card
  )
  update round_cards rc set
    location = 'deck',
    player_id = null,
    meld_id = null,
    position = s.new_pos
  from to_shuffle s
  where rc.round_id = p_round_id and rc.card_id = s.card_id;

  -- Reset the remaining discard card position to 1
  update round_cards set position = 1
    where round_id = p_round_id and card_id = v_top_card;
end;
$$;

-- ════════════════════════════════════════════════════════════
-- BUY MECHANIC
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- REQUEST BUY
-- ────────────────────────────────────────────────────────────
create or replace function request_buy(p_round_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_game record;
  v_prs record;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;

  if v_round.turn_phase not in ('draw', 'buy_window') then
    raise exception 'Cannot buy right now';
  end if;

  if v_round.discard_bought then
    raise exception 'Discard already bought this turn';
  end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;

  if v_seat = v_round.current_turn_seat then
    raise exception 'Active player takes discard free — no buy needed';
  end if;

  select * into v_game from games where id = v_round.game_id;
  select * into v_prs from player_round_state
    where round_id = p_round_id and player_id = v_player_id;

  if v_game.max_buys_per_round is not null
     and v_prs.buys_used >= v_game.max_buys_per_round then
    raise exception 'Buy limit reached for this round';
  end if;

  if exists (select 1 from buy_requests where round_id = p_round_id and player_id = v_player_id) then
    raise exception 'Already in buy queue';
  end if;

  insert into buy_requests (round_id, player_id, seat_position)
  values (p_round_id, v_player_id, v_seat);

  if v_round.turn_phase = 'draw' then
    update rounds set turn_phase = 'buy_window' where id = p_round_id;
  end if;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'buy_request',
    jsonb_build_object('seat', v_seat));
end;
$$;

-- ────────────────────────────────────────────────────────────
-- CANCEL BUY
-- ────────────────────────────────────────────────────────────
create or replace function cancel_buy(p_round_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_player_id uuid := auth.uid();
  v_remaining int;
begin
  delete from buy_requests
    where round_id = p_round_id and player_id = v_player_id;

  -- If no buyers left, close the buy window
  select count(*) into v_remaining from buy_requests where round_id = p_round_id;
  if v_remaining = 0 then
    update rounds set turn_phase = 'draw'
      where id = p_round_id and turn_phase = 'buy_window';
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- RESOLVE BUY
-- Winner gets the top discard + a penalty card from deck.
-- ────────────────────────────────────────────────────────────
create or replace function resolve_buy(p_round_id uuid)
returns jsonb
language plpgsql security definer as $$
declare
  v_round record;
  v_player_count int;
  v_winner record;
  v_discard_card text;
  v_penalty_card text;
  v_result jsonb;
  v_deck_count int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.turn_phase != 'buy_window' then raise exception 'No buy window active'; end if;

  select count(*) into v_player_count from game_players where game_id = v_round.game_id;

  if not exists (select 1 from buy_requests where round_id = p_round_id) then
    update rounds set turn_phase = 'draw' where id = p_round_id;
    return jsonb_build_object('winner', null);
  end if;

  select br.* into v_winner
  from buy_requests br
  where br.round_id = p_round_id
  order by
    (br.seat_position - v_round.current_turn_seat + v_player_count) % v_player_count
  limit 1;

  -- Get top discard card
  select card_id into v_discard_card from round_cards
    where round_id = p_round_id and location = 'discard'
    order by position desc
    limit 1;

  -- Ensure deck has cards (reshuffle if needed)
  select count(*) into v_deck_count from round_cards
    where round_id = p_round_id and location = 'deck';
  if v_deck_count = 0 then
    perform reshuffle_discard(p_round_id);
  end if;

  -- Get top deck card (penalty card)
  select card_id into v_penalty_card from round_cards
    where round_id = p_round_id and location = 'deck'
    order by position
    limit 1;

  -- Move both cards to winner's hand
  update round_cards set
    location = 'hand',
    player_id = v_winner.player_id,
    position = 0
  where round_id = p_round_id and card_id in (v_discard_card, v_penalty_card);

  update rounds set
    turn_phase = 'draw',
    discard_bought = true
  where id = p_round_id;

  update player_round_state set
    buys_used = buys_used + 1
  where round_id = p_round_id and player_id = v_winner.player_id;

  delete from buy_requests where round_id = p_round_id;

  v_result := jsonb_build_object(
    'winner_id', v_winner.player_id,
    'winner_seat', v_winner.seat_position,
    'discard_card', v_discard_card,
    'penalty_card', v_penalty_card
  );

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_winner.player_id, 'buy_awarded', v_result);

  return v_result;
end;
$$;

-- ════════════════════════════════════════════════════════════
-- MELD & LAY OFF
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- FULFILL CONTRACT
-- Player must submit ALL required melds at once.
-- p_melds is a jsonb array: [{"cards":["0102","0202","0302"],"meld_type":"set"}, ...]
-- ────────────────────────────────────────────────────────────
create or replace function fulfill_contract(
  p_round_id uuid,
  p_melds jsonb
)
returns jsonb
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_prs record;
  v_contract record;
  v_meld jsonb;
  v_cards text[];
  v_mtype text;
  v_valid boolean;
  v_min_run int;
  v_set_count int := 0;
  v_run_count int := 0;
  v_all_cards text[] := '{}';
  v_card text;
  v_run_suit text;
  v_meld_id uuid;
  v_meld_ids jsonb := '[]'::jsonb;
  i int;
  v_pos int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'action' then raise exception 'Not action phase'; end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;
  if v_seat != v_round.current_turn_seat then raise exception 'Not your turn'; end if;

  select * into v_prs from player_round_state
    where round_id = p_round_id and player_id = v_player_id;
  if not v_prs.has_drawn then raise exception 'Must draw first'; end if;
  if v_prs.has_met_contract then raise exception 'Contract already fulfilled — use lay_down_meld for extra melds'; end if;

  select * into v_contract from contracts c
    where c.round_number = v_round.round_number;
  v_min_run := coalesce(v_contract.min_run_length, 3);

  -- Count and validate each meld
  for i in 0 .. jsonb_array_length(p_melds) - 1 loop
    v_meld := p_melds -> i;
    v_mtype := v_meld ->> 'meld_type';
    v_cards := array(select jsonb_array_elements_text(v_meld -> 'cards'));

    if v_mtype not in ('set', 'run') then
      raise exception 'Invalid meld_type: %', v_mtype;
    end if;

    if v_mtype = 'set' then
      v_valid := validate_set(v_cards);
      v_set_count := v_set_count + 1;
    else
      v_valid := validate_run(v_cards, v_min_run);
      v_run_count := v_run_count + 1;
    end if;

    if not v_valid then
      raise exception 'Meld % is not a valid %', i + 1, v_mtype;
    end if;

    v_all_cards := v_all_cards || v_cards;
  end loop;

  if v_set_count < v_contract.num_sets then
    raise exception 'Contract requires % set(s), you submitted %', v_contract.num_sets, v_set_count;
  end if;
  if v_run_count < v_contract.num_runs then
    raise exception 'Contract requires % run(s), you submitted %', v_contract.num_runs, v_run_count;
  end if;

  -- Verify player has ALL cards in hand (via round_cards)
  foreach v_card in array v_all_cards loop
    if not exists (
      select 1 from round_cards
      where round_id = p_round_id and card_id = v_card
        and location = 'hand' and player_id = v_player_id
    ) then
      raise exception 'Card % not in your hand (or used in another meld)', v_card;
    end if;
  end loop;

  -- Check for duplicate cards across melds
  if array_length(v_all_cards, 1) != (
    select count(distinct c) from unnest(v_all_cards) as c
  ) then
    raise exception 'Duplicate card used across melds';
  end if;

  -- Create all melds atomically
  for i in 0 .. jsonb_array_length(p_melds) - 1 loop
    v_meld := p_melds -> i;
    v_mtype := v_meld ->> 'meld_type';
    v_cards := array(select jsonb_array_elements_text(v_meld -> 'cards'));
    v_run_suit := null;

    if v_mtype = 'run' then
      foreach v_card in array v_cards loop
        if not is_joker(v_card) then
          v_run_suit := card_suit(v_card)::text;
          exit;
        end if;
      end loop;
    end if;

    insert into melds (round_id, player_id, meld_type, run_suit)
    values (p_round_id, v_player_id, v_mtype::meld_type, v_run_suit)
    returning id into v_meld_id;

    -- Move cards from hand to meld
    v_pos := 0;
    foreach v_card in array v_cards loop
      update round_cards set
        location = 'meld',
        meld_id = v_meld_id,
        position = v_pos
      where round_id = p_round_id and card_id = v_card;
      v_pos := v_pos + 1;
    end loop;

    v_meld_ids := v_meld_ids || to_jsonb(v_meld_id);
  end loop;

  update player_round_state set has_met_contract = true
    where round_id = p_round_id and player_id = v_player_id;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'contract_met',
    jsonb_build_object('melds', p_melds));

  -- Check for round win (empty hand)
  if hand_count(p_round_id, v_player_id) = 0 then
    perform end_round(p_round_id, v_player_id);
  end if;

  return jsonb_build_object('meld_ids', v_meld_ids);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- LAY DOWN MELD (post-contract only)
-- ────────────────────────────────────────────────────────────
create or replace function lay_down_meld(
  p_round_id uuid,
  p_cards text[],
  p_meld_type meld_type
)
returns uuid
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_prs record;
  v_meld_id uuid;
  v_valid boolean;
  v_run_suit text;
  v_card text;
  v_pos int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'action' then raise exception 'Not action phase'; end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;
  if v_seat != v_round.current_turn_seat then raise exception 'Not your turn'; end if;

  select * into v_prs from player_round_state
    where round_id = p_round_id and player_id = v_player_id;
  if not v_prs.has_drawn then raise exception 'Must draw first'; end if;
  if not v_prs.has_met_contract then raise exception 'Must fulfill contract first (use fulfill_contract)'; end if;

  if p_meld_type = 'set' then
    v_valid := validate_set(p_cards);
  else
    declare
      v_min_run int;
    begin
      select c.min_run_length into v_min_run
        from contracts c
        join rounds r on r.round_number = c.round_number
        where r.id = p_round_id;
      v_valid := validate_run(p_cards, coalesce(v_min_run, 3));
    end;
  end if;

  if not v_valid then
    raise exception 'Invalid meld';
  end if;

  -- Verify player has all cards in hand
  foreach v_card in array p_cards loop
    if not exists (
      select 1 from round_cards
      where round_id = p_round_id and card_id = v_card
        and location = 'hand' and player_id = v_player_id
    ) then
      raise exception 'Card % not in your hand', v_card;
    end if;
  end loop;

  -- Determine run suit
  if p_meld_type = 'run' then
    foreach v_card in array p_cards loop
      if not is_joker(v_card) then
        v_run_suit := card_suit(v_card)::text;
        exit;
      end if;
    end loop;
  end if;

  insert into melds (round_id, player_id, meld_type, run_suit)
  values (p_round_id, v_player_id, p_meld_type, v_run_suit)
  returning id into v_meld_id;

  -- Move cards from hand to meld
  v_pos := 0;
  foreach v_card in array p_cards loop
    update round_cards set
      location = 'meld',
      meld_id = v_meld_id,
      position = v_pos
    where round_id = p_round_id and card_id = v_card;
    v_pos := v_pos + 1;
  end loop;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'lay_meld',
    jsonb_build_object('meld_type', p_meld_type::text, 'cards', to_jsonb(p_cards)));

  -- Check for round win
  if hand_count(p_round_id, v_player_id) = 0 then
    perform end_round(p_round_id, v_player_id);
  end if;

  return v_meld_id;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- LAY OFF CARD onto an existing meld
-- ────────────────────────────────────────────────────────────
create or replace function lay_off_card(
  p_round_id uuid,
  p_meld_id uuid,
  p_card text
)
returns void
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_prs record;
  v_max_pos int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'action' then raise exception 'Not action phase'; end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;
  if v_seat != v_round.current_turn_seat then raise exception 'Not your turn'; end if;

  select * into v_prs from player_round_state
    where round_id = p_round_id and player_id = v_player_id;
  if not v_prs.has_drawn then raise exception 'Must draw first'; end if;
  if not v_prs.has_met_contract then raise exception 'Must meet contract before laying off'; end if;

  -- Verify card is in player's hand
  if not exists (
    select 1 from round_cards
    where round_id = p_round_id and card_id = p_card
      and location = 'hand' and player_id = v_player_id
  ) then
    raise exception 'Card not in your hand';
  end if;

  if not can_lay_off(p_meld_id, p_card) then
    raise exception 'Card does not fit this meld';
  end if;

  -- Move card from hand to meld
  select coalesce(max(position), 0) + 1 into v_max_pos
    from round_cards where round_id = p_round_id and meld_id = p_meld_id;

  update round_cards set
    location = 'meld',
    meld_id = p_meld_id,
    position = v_max_pos
  where round_id = p_round_id and card_id = p_card;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'lay_off',
    jsonb_build_object('card', p_card, 'meld_id', p_meld_id));

  -- Check for round win
  if hand_count(p_round_id, v_player_id) = 0 then
    perform end_round(p_round_id, v_player_id);
  end if;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- DISCARD
-- ────────────────────────────────────────────────────────────
create or replace function discard_card(p_round_id uuid, p_card text)
returns void
language plpgsql security definer as $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_seat int;
  v_prs record;
  v_player_count int;
  v_next_seat int;
  v_max_discard_pos int;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'action' then raise exception 'Not action phase'; end if;

  select seat_position into v_seat from game_players
    where game_id = v_round.game_id and player_id = v_player_id;
  if v_seat != v_round.current_turn_seat then raise exception 'Not your turn'; end if;

  select * into v_prs from player_round_state
    where round_id = p_round_id and player_id = v_player_id;
  if not v_prs.has_drawn then raise exception 'Must draw first'; end if;

  -- Verify card is in player's hand
  if not exists (
    select 1 from round_cards
    where round_id = p_round_id and card_id = p_card
      and location = 'hand' and player_id = v_player_id
  ) then
    raise exception 'Card not in your hand';
  end if;

  -- Move card to discard pile (top = highest position)
  select coalesce(max(position), 0) + 1 into v_max_discard_pos
    from round_cards where round_id = p_round_id and location = 'discard';

  update round_cards set
    location = 'discard',
    player_id = null,
    meld_id = null,
    position = v_max_discard_pos
  where round_id = p_round_id and card_id = p_card;

  update player_round_state set has_drawn = false
    where round_id = p_round_id and player_id = v_player_id;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'discard',
    jsonb_build_object('card', p_card));

  -- Check if player went out
  if hand_count(p_round_id, v_player_id) = 0 then
    perform end_round(p_round_id, v_player_id);
    return;
  end if;

  -- Advance turn
  select count(*) into v_player_count from game_players where game_id = v_round.game_id;
  v_next_seat := (v_round.current_turn_seat + 1) % v_player_count;

  update rounds set
    current_turn_seat = v_next_seat,
    turn_phase = 'draw',
    discard_bought = false
  where id = p_round_id;

  update player_round_state set has_drawn = false
  where round_id = p_round_id
    and player_id = (
      select player_id from game_players
      where game_id = v_round.game_id and seat_position = v_next_seat
    );
end;
$$;

-- ════════════════════════════════════════════════════════════
-- END ROUND / END GAME
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- END ROUND
-- ────────────────────────────────────────────────────────────
create or replace function end_round(p_round_id uuid, p_winner_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_round record;
  v_prs record;
  v_score int;
  v_hand text[];
begin
  select * into v_round from rounds where id = p_round_id;

  for v_prs in
    select * from player_round_state where round_id = p_round_id
  loop
    if v_prs.player_id = p_winner_id then
      v_score := 0;
    else
      v_hand := get_hand(p_round_id, v_prs.player_id);
      v_score := score_cards(v_hand);
    end if;

    update player_round_state set score = v_score
      where id = v_prs.id;
  end loop;

  update rounds set status = 'finished', finished_at = now()
    where id = p_round_id;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, p_winner_id, 'round_end',
    jsonb_build_object('round', v_round.round_number, 'winner', p_winner_id));

  if v_round.round_number >= 7 then
    perform end_game(v_round.game_id);
  end if;
  -- Next round is dealt by the dealer calling deal_next_round()
end;
$$;

-- ────────────────────────────────────────────────────────────
-- DEAL NEXT ROUND (called by the dealer)
-- ────────────────────────────────────────────────────────────
create or replace function deal_next_round(p_game_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_game record;
  v_last_round record;
  v_player_count int;
  v_next_round int;
  v_dealer_seat int;
  v_player_id uuid := auth.uid();
  v_req record;
  v_next_seat int;
  v_new_num_decks int;
  v_completed_round record;
  v_avg_score numeric;
  v_max_score int;
  v_penalty int;
begin
  select * into v_game from games where id = p_game_id;
  if v_game.status != 'active' then raise exception 'Game not active'; end if;

  select * into v_last_round from rounds
    where game_id = p_game_id order by round_number desc limit 1;
  if v_last_round.status != 'finished' then raise exception 'Current round not finished'; end if;

  v_next_round := v_last_round.round_number + 1;
  if v_next_round > 7 then raise exception 'All rounds completed'; end if;

  -- Dealer check uses CURRENT player count (before late joiners)
  select count(*) into v_player_count from game_players where game_id = p_game_id;
  v_dealer_seat := (v_next_round - 1) % v_player_count;

  if not exists (
    select 1 from game_players
    where game_id = p_game_id and player_id = v_player_id and seat_position = v_dealer_seat
  ) then
    raise exception 'Only the dealer can deal the next round';
  end if;

  -- ── Process approved late joiners ──
  select coalesce(max(seat_position), -1) into v_next_seat
    from game_players where game_id = p_game_id;

  for v_req in
    select * from late_join_requests
    where game_id = p_game_id and status = 'approved'
    order by created_at
  loop
    v_next_seat := v_next_seat + 1;

    -- Seat the player
    insert into game_players (game_id, player_id, seat_position)
    values (p_game_id, v_req.player_id, v_next_seat);

    -- Create penalty scores for all completed rounds
    for v_completed_round in
      select r.id as round_id, r.round_number
      from rounds r where r.game_id = p_game_id and r.status = 'finished'
      order by r.round_number
    loop
      select avg(prs.score)::numeric, max(prs.score)
        into v_avg_score, v_max_score
        from player_round_state prs
        where prs.round_id = v_completed_round.round_id
          and prs.score is not null;

      if v_req.scoring_method = 'average' then
        v_penalty := round(v_avg_score)::int;
      elsif v_req.scoring_method = 'max' then
        v_penalty := v_max_score;
      elsif v_req.scoring_method = 'max_plus_avg' then
        v_penalty := round((v_max_score + v_avg_score) / 2.0)::int;
      else
        v_penalty := round(v_avg_score)::int;
      end if;

      insert into player_round_state (round_id, player_id, has_met_contract, score)
      values (v_completed_round.round_id, v_req.player_id, true, v_penalty);
    end loop;

    -- Remove the fulfilled request
    delete from late_join_requests where id = v_req.id;
  end loop;

  -- ── Recalculate deck count with new player total ──
  select count(*) into v_player_count from game_players where game_id = p_game_id;
  v_new_num_decks := case when v_player_count <= 4 then 2 else 3 end;
  if v_new_num_decks != v_game.num_decks then
    update games set num_decks = v_new_num_decks where id = p_game_id;
  end if;

  perform deal_round(p_game_id, v_next_round);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- END GAME (internal)
-- ────────────────────────────────────────────────────────────
create or replace function end_game(p_game_id uuid)
returns void
language plpgsql security definer as $$
begin
  update games set status = 'finished', finished_at = now()
    where id = p_game_id;

  insert into game_actions (game_id, action_type, details)
  values (p_game_id, 'game_end', '{}'::jsonb);
end;
$$;

-- END GAME REQUEST (callable RPC — any player in the game can end it)
-- ────────────────────────────────────────────────────────────
create or replace function end_game_request(p_game_id uuid)
returns void
language plpgsql security definer as $$
declare
  v_player_id uuid := auth.uid();
begin
  -- Verify caller is in this game
  if not exists (
    select 1 from game_players where game_id = p_game_id and player_id = v_player_id
  ) then
    raise exception 'You are not in this game';
  end if;

  -- End the game
  perform end_game(p_game_id);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- RESOLVE LATE JOIN REQUEST (host only)
-- ────────────────────────────────────────────────────────────
create or replace function resolve_late_join_request(
  p_request_id uuid,
  p_decision text,
  p_scoring_method text default null
)
returns void
language plpgsql security definer as $$
declare
  v_req record;
  v_game record;
  v_host uuid := auth.uid();
  v_current_players int;
  v_pending_approved int;
begin
  select * into v_req from late_join_requests where id = p_request_id;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status != 'pending' then raise exception 'Request already resolved'; end if;

  select * into v_game from games where id = v_req.game_id;
  if v_game.created_by != v_host then raise exception 'Only the host can resolve join requests'; end if;

  if p_decision not in ('approved', 'spectating', 'kicked') then
    raise exception 'Invalid decision';
  end if;

  if p_decision = 'approved' then
    if p_scoring_method is null or p_scoring_method not in ('average', 'max', 'max_plus_avg') then
      raise exception 'Must specify scoring method when approving';
    end if;
    -- Check player cap (current + already-approved + this one <= 7)
    select count(*) into v_current_players from game_players where game_id = v_req.game_id;
    select count(*) into v_pending_approved from late_join_requests
      where game_id = v_req.game_id and status = 'approved';
    if v_current_players + v_pending_approved + 1 > 7 then
      raise exception 'Game would exceed 7 players';
    end if;
  end if;

  update late_join_requests set
    status = p_decision,
    scoring_method = p_scoring_method,
    resolved_by = v_host,
    resolved_at = now()
  where id = p_request_id;
end;
$$;

-- ════════════════════════════════════════════════════════════
-- QUERY HELPERS
-- ════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────
-- GET GAME STATE
-- Returns everything the calling player is allowed to see
-- ────────────────────────────────────────────────────────────
create or replace function get_game_state(p_game_id uuid)
returns jsonb
language plpgsql security definer as $$
declare
  v_player_id uuid := auth.uid();
  v_game record;
  v_round record;
  v_result jsonb;
  v_players jsonb;
  v_my_hand jsonb;
  v_melds jsonb;
  v_opponents jsonb;
  v_top_discard text;
  v_draw_count int;
  v_discard_count int;
begin
  select * into v_game from games where id = p_game_id;

  select jsonb_agg(jsonb_build_object(
    'player_id', gp.player_id,
    'display_name', p.display_name,
    'seat_position', gp.seat_position,
    'is_connected', gp.is_connected,
    'is_you', gp.player_id = v_player_id,
    'total_score', coalesce((
      select sum(prs.score)
      from player_round_state prs
      join rounds r on r.id = prs.round_id
      where r.game_id = p_game_id and prs.player_id = gp.player_id
    ), 0),
    'rounds_won', coalesce((
      select count(*)
      from player_round_state prs
      join rounds r on r.id = prs.round_id
      where r.game_id = p_game_id and prs.player_id = gp.player_id
        and prs.score = 0 and r.status = 'finished'
    ), 0),
    'total_buys', coalesce((
      select sum(prs.buys_used)
      from player_round_state prs
      join rounds r on r.id = prs.round_id
      where r.game_id = p_game_id and prs.player_id = gp.player_id
    ), 0),
    'jokers_used', coalesce((
      select count(*)
      from round_cards rc
      join rounds r on r.id = rc.round_id
      where r.game_id = p_game_id and rc.player_id = gp.player_id
        and rc.location = 'meld' and is_joker(rc.card_id)
    ), 0),
    'final_round_score', coalesce((
      select prs.score
      from player_round_state prs
      join rounds r on r.id = prs.round_id
      where r.game_id = p_game_id and prs.player_id = gp.player_id
      order by r.round_number desc limit 1
    ), 0)
  ) order by gp.seat_position)
  into v_players
  from game_players gp
  join profiles p on p.id = gp.player_id
  where gp.game_id = p_game_id;

  v_result := jsonb_build_object(
    'game_id', v_game.id,
    'code', v_game.code,
    'status', v_game.status,
    'players', v_players,
    'buy_countdown_seconds', v_game.buy_countdown_seconds
  );

  if v_game.status in ('active', 'finished') then
    select * into v_round from rounds
      where game_id = p_game_id
      order by round_number desc limit 1;

    -- My hand and contract status
    declare
      v_my_prs record;
    begin
      select * into v_my_prs from player_round_state
        where round_id = v_round.id and player_id = v_player_id;

      -- Get my hand from round_cards
      select to_jsonb(coalesce(array_agg(rc.card_id order by rc.position), '{}'))
        into v_my_hand
        from round_cards rc
        where rc.round_id = v_round.id and rc.player_id = v_player_id and rc.location = 'hand';

      v_result := v_result || jsonb_build_object(
        'my_has_met_contract', coalesce(v_my_prs.has_met_contract, false),
        'my_has_drawn', coalesce(v_my_prs.has_drawn, false)
      );
    end;

    -- All melds this round (cards from round_cards)
    select jsonb_agg(jsonb_build_object(
      'id', m.id,
      'player_id', m.player_id,
      'meld_type', m.meld_type,
      'cards', coalesce((
        select array_agg(rc.card_id order by rc.position)
        from round_cards rc
        where rc.meld_id = m.id and rc.location = 'meld'
      ), '{}')
    )) into v_melds
    from melds m where m.round_id = v_round.id;

    -- Opponent card counts + status
    select jsonb_agg(jsonb_build_object(
      'player_id', prs.player_id,
      'cards_in_hand', (
        select count(*) from round_cards rc
        where rc.round_id = v_round.id and rc.player_id = prs.player_id and rc.location = 'hand'
      ),
      'has_met_contract', prs.has_met_contract,
      'buys_used', prs.buys_used,
      'score', prs.score
    )) into v_opponents
    from player_round_state prs
    where prs.round_id = v_round.id and prs.player_id != v_player_id;

    -- Deck and discard counts
    select count(*) into v_draw_count from round_cards
      where round_id = v_round.id and location = 'deck';
    select count(*) into v_discard_count from round_cards
      where round_id = v_round.id and location = 'discard';

    -- Top discard card
    select card_id into v_top_discard from round_cards
      where round_id = v_round.id and location = 'discard'
      order by position desc limit 1;

    v_result := v_result || jsonb_build_object(
      'round', jsonb_build_object(
        'id', v_round.id,
        'round_number', v_round.round_number,
        'contract_sets', v_round.contract_sets,
        'contract_runs', v_round.contract_runs,
        'cards_dealt', v_round.cards_dealt,
        'current_turn_seat', v_round.current_turn_seat,
        'turn_phase', v_round.turn_phase,
        'draw_pile_count', v_draw_count,
        'top_discard', v_top_discard,
        'discard_count', v_discard_count,
        'discard_bought', v_round.discard_bought,
        'status', v_round.status
      ),
      'my_hand', v_my_hand,
      'melds', coalesce(v_melds, '[]'::jsonb),
      'opponents', coalesce(v_opponents, '[]'::jsonb)
    );

    -- Round scoreboard (all completed rounds)
    declare
      v_scoreboard jsonb;
      v_next_dealer int;
      v_player_count_sb int;
    begin
      select jsonb_agg(jsonb_build_object(
        'round_number', r.round_number,
        'scores', (
          select jsonb_agg(jsonb_build_object(
            'player_id', prs.player_id,
            'score', prs.score
          ) order by gp2.seat_position)
          from player_round_state prs
          join game_players gp2 on gp2.game_id = r.game_id and gp2.player_id = prs.player_id
          where prs.round_id = r.id
        )
      ) order by r.round_number)
      into v_scoreboard
      from rounds r
      where r.game_id = p_game_id and r.status = 'finished';

      select count(*) into v_player_count_sb from game_players where game_id = p_game_id;
      v_next_dealer := v_round.round_number % v_player_count_sb;

      v_result := v_result || jsonb_build_object(
        'round_scores', coalesce(v_scoreboard, '[]'::jsonb),
        'dealer_seat', v_round.dealer_seat,
        'next_dealer_seat', v_next_dealer
      );
    end;
  end if;

  -- ── Late-join / spectator info ──
  declare
    v_ljr record;
    v_is_spectator boolean := false;
    v_pending_requests jsonb := '[]'::jsonb;
    v_approved_count int := 0;
  begin
    -- Am I a spectator (not in game_players)?
    if not exists (select 1 from game_players where game_id = p_game_id and player_id = v_player_id) then
      select * into v_ljr from late_join_requests
        where game_id = p_game_id and player_id = v_player_id;
      if found then
        v_is_spectator := true;
        v_result := v_result || jsonb_build_object(
          'is_spectator', true,
          'my_late_join_status', v_ljr.status,
          'my_late_join_scoring', v_ljr.scoring_method
        );
      else
        v_result := v_result || jsonb_build_object('is_spectator', true);
      end if;
    else
      v_result := v_result || jsonb_build_object('is_spectator', false);
    end if;

    -- If host, include pending requests with display names
    if v_game.created_by = v_player_id then
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', ljr.id,
        'player_id', ljr.player_id,
        'display_name', p.display_name,
        'status', ljr.status,
        'created_at', ljr.created_at
      ) order by ljr.created_at), '[]'::jsonb)
      into v_pending_requests
      from late_join_requests ljr
      join profiles p on p.id = ljr.player_id
      where ljr.game_id = p_game_id and ljr.status = 'pending';

      v_result := v_result || jsonb_build_object('pending_join_requests', v_pending_requests);
    end if;

    -- Count approved joiners waiting (visible to all players)
    select count(*) into v_approved_count
      from late_join_requests where game_id = p_game_id and status = 'approved';
    v_result := v_result || jsonb_build_object('approved_join_count', v_approved_count);
  end;

  return v_result;
end;
$$;

-- ────────────────────────────────────────────────────────────
-- GET PLAYER GAME HISTORY
-- ────────────────────────────────────────────────────────────
create or replace function get_game_history()
returns jsonb
language plpgsql security definer as $$
declare
  v_player_id uuid := auth.uid();
  v_result jsonb;
begin
  select jsonb_agg(game_row order by game_row->>'finished_at' desc)
  into v_result
  from (
    select jsonb_build_object(
      'game_id', g.id,
      'code', g.code,
      'finished_at', g.finished_at,
      'player_count', (select count(*) from game_players where game_id = g.id),
      'your_total_score', coalesce((
        select sum(prs.score)
        from player_round_state prs
        join rounds r on r.id = prs.round_id
        where r.game_id = g.id and prs.player_id = v_player_id
      ), 0),
      'your_rank', (
        select rank_pos from (
          select gp2.player_id,
            rank() over (order by coalesce(sum(prs2.score), 0)) as rank_pos
          from game_players gp2
          left join rounds r2 on r2.game_id = g.id
          left join player_round_state prs2 on prs2.round_id = r2.id and prs2.player_id = gp2.player_id
          where gp2.game_id = g.id
          group by gp2.player_id
        ) ranked where ranked.player_id = v_player_id
      ),
      'winner', (
        select p.display_name
        from game_players gp3
        join profiles p on p.id = gp3.player_id
        left join rounds r3 on r3.game_id = g.id
        left join player_round_state prs3 on prs3.round_id = r3.id and prs3.player_id = gp3.player_id
        where gp3.game_id = g.id
        group by gp3.player_id, p.display_name
        order by coalesce(sum(prs3.score), 0)
        limit 1
      ),
      'rounds_played', (select count(*) from rounds where game_id = g.id and status = 'finished'),
      'players', (
        select jsonb_agg(jsonb_build_object(
          'name', p2.display_name,
          'total_score', coalesce((
            select sum(prs4.score)
            from player_round_state prs4
            join rounds r4 on r4.id = prs4.round_id
            where r4.game_id = g.id and prs4.player_id = gp4.player_id
          ), 0)
        ) order by coalesce((
            select sum(prs5.score)
            from player_round_state prs5
            join rounds r5 on r5.id = prs5.round_id
            where r5.game_id = g.id and prs5.player_id = gp4.player_id
          ), 0))
        from game_players gp4
        join profiles p2 on p2.id = gp4.player_id
        where gp4.game_id = g.id
      )
    ) as game_row
    from games g
    join game_players gp on gp.game_id = g.id and gp.player_id = v_player_id
    where g.status = 'finished'
  ) sub;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

-- ────────────────────────────────────────────────────────────
-- GET OPEN GAMES
-- ────────────────────────────────────────────────────────────
create or replace function get_open_games()
returns jsonb
language plpgsql security definer as $$
declare
  v_result jsonb;
begin
  select jsonb_agg(jsonb_build_object(
    'game_id', g.id,
    'code', g.code,
    'host', p.display_name,
    'player_count', (select count(*) from game_players where game_id = g.id),
    'created_at', g.created_at
  ) order by g.created_at desc)
  into v_result
  from games g
  join profiles p on p.id = g.created_by
  where g.status = 'waiting';

  return coalesce(v_result, '[]'::jsonb);
end;
$$;
