SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."action_type" AS ENUM (
    'draw_deck',
    'draw_discard',
    'buy_request',
    'buy_awarded',
    'contract_met',
    'lay_meld',
    'lay_off',
    'discard',
    'round_start',
    'round_end',
    'game_start',
    'game_end',
    'chat',
    'ready'
);


ALTER TYPE "public"."action_type" OWNER TO "postgres";


CREATE TYPE "public"."card_location" AS ENUM (
    'deck',
    'discard',
    'hand',
    'meld'
);


ALTER TYPE "public"."card_location" OWNER TO "postgres";


CREATE TYPE "public"."game_status" AS ENUM (
    'waiting',
    'active',
    'finished'
);


ALTER TYPE "public"."game_status" OWNER TO "postgres";


CREATE TYPE "public"."meld_type" AS ENUM (
    'set',
    'run'
);


ALTER TYPE "public"."meld_type" OWNER TO "postgres";


CREATE TYPE "public"."round_status" AS ENUM (
    'dealing',
    'active',
    'finished'
);


ALTER TYPE "public"."round_status" OWNER TO "postgres";


CREATE TYPE "public"."turn_phase" AS ENUM (
    'ready_check',
    'draw',
    'action',
    'discard',
    'buy_window'
);


ALTER TYPE "public"."turn_phase" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."add_ai_to_game"("p_game_id" "uuid", "p_ai_name" "text", "p_ai_tier" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_game record;
  v_caller uuid := auth.uid();
  v_ai_profile_id uuid;
  v_next_seat int;
  v_player_count int;
begin
  -- Validate game and host
  select * into v_game from games where id = p_game_id;
  if v_game is null then raise exception 'Game not found'; end if;
  if v_game.status != 'waiting' then raise exception 'Can only add AI to a waiting game'; end if;
  if v_game.created_by != v_caller then raise exception 'Only the host can add AI players'; end if;

  -- Check player count limit
  select count(*) into v_player_count from game_players where game_id = p_game_id;
  if v_player_count >= 6 then raise exception 'Game is full (max 6 players)'; end if;

  -- Look up AI profile
  select id into v_ai_profile_id from profiles
    where is_ai = true and ai_name = p_ai_name and ai_tier = p_ai_tier;
  if v_ai_profile_id is null then
    raise exception 'AI profile not found: % %', p_ai_name, p_ai_tier;
  end if;

  -- Max 1 of each name per game (regardless of tier)
  if exists (
    select 1 from game_players gp
    join profiles p on p.id = gp.player_id
    where gp.game_id = p_game_id and p.is_ai = true and p.ai_name = p_ai_name
  ) then
    raise exception '% is already in this game', p_ai_name;
  end if;

  -- Seat at next position
  select coalesce(max(seat_position), -1) + 1 into v_next_seat
    from game_players where game_id = p_game_id;

  insert into game_players (game_id, player_id, seat_position, is_connected)
  values (p_game_id, v_ai_profile_id, v_next_seat, true);

  -- Mark game as having AI players
  update games set has_ai_players = true where id = p_game_id;

  return jsonb_build_object(
    'ai_profile_id', v_ai_profile_id,
    'seat_position', v_next_seat,
    'ai_name', p_ai_name,
    'ai_tier', p_ai_tier
  );
end;
$$;


ALTER FUNCTION "public"."add_ai_to_game"("p_game_id" "uuid", "p_ai_name" "text", "p_ai_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_ai_takeover"("p_game_id" "uuid", "p_seat_position" integer, "p_ai_name" "text", "p_ai_tier" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_game record;
  v_caller uuid := auth.uid();
  v_ai_profile_id uuid;
  v_current_gp record;
  v_current_round record;
begin
  select * into v_game from games where id = p_game_id;
  if v_game is null then raise exception 'Game not found'; end if;
  if v_game.status != 'active' then raise exception 'Game must be active for takeover'; end if;
  if v_game.created_by != v_caller then raise exception 'Only the host can assign AI takeover'; end if;

  -- Get current occupant of the seat
  select * into v_current_gp from game_players
    where game_id = p_game_id and seat_position = p_seat_position;
  if v_current_gp is null then raise exception 'No player at seat %', p_seat_position; end if;

  -- Don't replace an AI with another AI
  if exists (select 1 from profiles where id = v_current_gp.player_id and is_ai = true) then
    raise exception 'Seat is already an AI player';
  end if;

  -- Look up AI profile
  select id into v_ai_profile_id from profiles
    where is_ai = true and ai_name = p_ai_name and ai_tier = p_ai_tier;
  if v_ai_profile_id is null then
    raise exception 'AI profile not found: % %', p_ai_name, p_ai_tier;
  end if;

  -- Max 1 of each name per game
  if exists (
    select 1 from game_players gp
    join profiles p on p.id = gp.player_id
    where gp.game_id = p_game_id and p.is_ai = true and p.ai_name = p_ai_name
  ) then
    raise exception '% is already in this game', p_ai_name;
  end if;

  -- Swap the seat: store original human, replace with AI
  update game_players set
    original_player_id = player_id,
    player_id = v_ai_profile_id,
    is_connected = true
  where game_id = p_game_id and seat_position = p_seat_position;

  -- Update round-level ownership: player_round_state
  select * into v_current_round from rounds
    where game_id = p_game_id and status = 'active';

  if v_current_round is not null then
    update player_round_state set player_id = v_ai_profile_id
      where round_id = v_current_round.id and player_id = v_current_gp.player_id;

    -- Update card ownership in current round
    update round_cards set player_id = v_ai_profile_id
      where round_id = v_current_round.id and player_id = v_current_gp.player_id;

    -- Update meld ownership in current round
    update melds set player_id = v_ai_profile_id
      where round_id = v_current_round.id and player_id = v_current_gp.player_id;
  end if;

  -- Flag game as modified (affects stats for all players)
  update games set is_modified = true, has_ai_players = true where id = p_game_id;

  return jsonb_build_object(
    'ai_profile_id', v_ai_profile_id,
    'replaced_player_id', v_current_gp.player_id,
    'seat_position', p_seat_position,
    'ai_name', p_ai_name,
    'ai_tier', p_ai_tier
  );
end;
$$;


ALTER FUNCTION "public"."assign_ai_takeover"("p_game_id" "uuid", "p_seat_position" integer, "p_ai_name" "text", "p_ai_tier" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."can_lay_off"("p_meld_id" "uuid", "p_card" "text") RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."can_lay_off"("p_meld_id" "uuid", "p_card" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_buy"("p_round_id" "uuid", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_remaining int;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."cancel_buy"("p_round_id" "uuid", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cancel_game"("p_game_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_game record;
begin
  select * into v_game from games where id = p_game_id;
  if not found then raise exception 'Game not found'; end if;
  if v_game.created_by != auth.uid() then raise exception 'Only the host can cancel'; end if;
  if v_game.status != 'waiting' then raise exception 'Can only cancel a waiting game'; end if;

  delete from game_players where game_id = p_game_id;
  delete from games where id = p_game_id;
end;
$$;


ALTER FUNCTION "public"."cancel_game"("p_game_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_deck"("card" "text") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select substr(card, 1, 1)::int;
$$;


ALTER FUNCTION "public"."card_deck"("card" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_suit"("card" "text") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select substr(card, 2, 1)::int;
$$;


ALTER FUNCTION "public"."card_suit"("card" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_value"("card" "text") RETURNS integer
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select substr(card, 3, 2)::int;
$$;


ALTER FUNCTION "public"."card_value"("card" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_game"("p_buy_countdown" integer DEFAULT 10, "p_max_buys" integer DEFAULT NULL::integer, "p_num_decks" integer DEFAULT 2, "p_num_jokers" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."create_game"("p_buy_countdown" integer, "p_max_buys" integer, "p_num_decks" integer, "p_num_jokers" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_next_round"("p_game_id" "uuid", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_game record;
  v_last_round record;
  v_player_count int;
  v_next_round int;
  v_dealer_seat int;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_req record;
  v_next_seat int;
  v_new_num_decks int;
  v_completed_round record;
  v_avg_score numeric;
  v_max_score int;
  v_penalty int;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."deal_next_round"("p_game_id" "uuid", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_round"("p_game_id" "uuid", "p_round_num" integer) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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

  -- Start in ready_check phase — players must confirm before play begins
  update rounds set status = 'active', turn_phase = 'ready_check' where id = v_round_id;

  -- Auto-ready all AI players
  update player_round_state prs
  set is_ready = true
  from profiles p
  where prs.round_id = v_round_id
    and prs.player_id = p.id
    and p.is_ai = true;

  -- If all players are AI (or solo human already ready), advance immediately
  if not exists (
    select 1 from player_round_state
    where round_id = v_round_id and is_ready = false
  ) then
    update rounds set turn_phase = 'draw' where id = v_round_id;
  end if;

  insert into game_actions (game_id, round_id, action_type, details)
  values (p_game_id, v_round_id, 'round_start',
    jsonb_build_object('round', p_round_num, 'contract', v_contract.description,
      'cards_dealt', v_contract.cards_dealt));
end;
$$;


ALTER FUNCTION "public"."deal_round"("p_game_id" "uuid", "p_round_num" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."discard_card"("p_round_id" "uuid", "p_card" "text", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_seat int;
  v_prs record;
  v_player_count int;
  v_next_seat int;
  v_max_discard_pos int;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."discard_card"("p_round_id" "uuid", "p_card" "text", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_from_deck"("p_round_id" "uuid", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_seat int;
  v_card text;
  v_prs record;
  v_deck_count int;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."draw_from_deck"("p_round_id" "uuid", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."draw_from_discard"("p_round_id" "uuid", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_seat int;
  v_card text;
  v_discard_count int;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."draw_from_discard"("p_round_id" "uuid", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."end_game"("p_game_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
begin
  update games set status = 'finished', finished_at = now()
    where id = p_game_id;

  insert into game_actions (game_id, action_type, details)
  values (p_game_id, 'game_end', '{}'::jsonb);
end;
$$;


ALTER FUNCTION "public"."end_game"("p_game_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."end_game_request"("p_game_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."end_game_request"("p_game_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."end_round"("p_round_id" "uuid", "p_winner_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."end_round"("p_round_id" "uuid", "p_winner_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fulfill_contract"("p_round_id" "uuid", "p_melds" "jsonb", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
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
  perform validate_acting_as(p_acting_as);

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

  -- Round 7: must meld all cards except 1 (the discard)
  if v_contract.must_go_out then
    if hand_count(p_round_id, v_player_id) - array_length(v_all_cards, 1) > 1 then
      raise exception 'Must meld all cards except 1 discard (you have % cards left)',
        hand_count(p_round_id, v_player_id) - array_length(v_all_cards, 1);
    end if;
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


ALTER FUNCTION "public"."fulfill_contract"("p_round_id" "uuid", "p_melds" "jsonb", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_game_code"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."generate_game_code"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_active_game"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'game_id', g.id,
    'code', g.code,
    'status', g.status,
    'player_count', (select count(*) from game_players where game_id = g.id),
    'current_round', coalesce((
      select max(r.round_number) from rounds r where r.game_id = g.id
    ), 0)
  )
  into v_result
  from games g
  join game_players gp on gp.game_id = g.id
  where gp.player_id = auth.uid()
    and g.status in ('waiting', 'active')
  order by g.created_at desc
  limit 1;

  return v_result;  -- null if no active game
end;
$$;


ALTER FUNCTION "public"."get_active_game"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_game_history"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."get_game_history"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_game_state"("p_game_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
    'is_ai', p.is_ai,
    'ai_name', p.ai_name,
    'ai_tier', p.ai_tier,
    'total_score', coalesce((
      select sum(prs.score)
      from player_round_state prs
      join rounds r on r.id = prs.round_id
      where r.game_id = p_game_id and prs.player_id = gp.player_id
        and r.status = 'finished'
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
    'buy_countdown_seconds', v_game.buy_countdown_seconds,
    'has_ai_players', coalesce(v_game.has_ai_players, false),
    'is_modified', coalesce(v_game.is_modified, false),
    'created_by', v_game.created_by
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
        'my_has_drawn', coalesce(v_my_prs.has_drawn, false),
        'my_is_ready', coalesce(v_my_prs.is_ready, false)
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
      'is_ready', prs.is_ready,
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
        'status', v_round.status,
        'ready_count', (select count(*) from player_round_state where round_id = v_round.id and is_ready = true),
        'total_players', (select count(*) from player_round_state where round_id = v_round.id)
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

    -- Spectators list (visible to all players)
    v_result := v_result || jsonb_build_object('spectators', coalesce((
      select jsonb_agg(jsonb_build_object(
        'display_name', p.display_name,
        'status', ljr.status,
        'scoring_method', ljr.scoring_method
      ) order by ljr.created_at)
      from late_join_requests ljr
      join profiles p on p.id = ljr.player_id
      where ljr.game_id = p_game_id and ljr.status in ('pending', 'approved', 'spectating')
    ), '[]'::jsonb));
  end;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."get_game_state"("p_game_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_hand"("p_round_id" "uuid", "p_player_id" "uuid") RETURNS "text"[]
    LANGUAGE "sql"
    AS $$
  select coalesce(array_agg(card_id order by position), '{}')
    from round_cards
    where round_id = p_round_id and player_id = p_player_id and location = 'hand';
$$;


ALTER FUNCTION "public"."get_hand"("p_round_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_open_games"() RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."get_open_games"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."hand_count"("p_round_id" "uuid", "p_player_id" "uuid") RETURNS integer
    LANGUAGE "sql"
    AS $$
  select count(*)::int from round_cards
    where round_id = p_round_id and player_id = p_player_id and location = 'hand';
$$;


ALTER FUNCTION "public"."hand_count"("p_round_id" "uuid", "p_player_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name)
  VALUES (new.id, coalesce(new.raw_user_meta_data->>'display_name', 'Player'))
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_joker"("card" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select substr(card, 2, 1) = '9';
$$;


ALTER FUNCTION "public"."is_joker"("card" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."join_game"("p_code" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."join_game"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lay_down_meld"("p_round_id" "uuid", "p_cards" "text"[], "p_meld_type" "public"."meld_type", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_seat int;
  v_prs record;
  v_meld_id uuid;
  v_valid boolean;
  v_run_suit text;
  v_card text;
  v_pos int;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."lay_down_meld"("p_round_id" "uuid", "p_cards" "text"[], "p_meld_type" "public"."meld_type", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."lay_off_card"("p_round_id" "uuid", "p_meld_id" "uuid", "p_card" "text", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_seat int;
  v_prs record;
  v_max_pos int;
begin
  perform validate_acting_as(p_acting_as);

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

  -- Cannot lay off on the same turn you fulfilled your contract
  if exists (
    select 1 from game_actions
    where round_id = p_round_id
      and player_id = v_player_id
      and action_type = 'contract_met'
      and created_at > (
        select max(created_at) from game_actions
        where round_id = p_round_id
          and player_id = v_player_id
          and action_type in ('draw_deck', 'draw_discard')
      )
  ) then
    raise exception 'Cannot lay off on the same turn you fulfilled your contract';
  end if;

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


ALTER FUNCTION "public"."lay_off_card"("p_round_id" "uuid", "p_meld_id" "uuid", "p_card" "text", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."peek_ai_hands"("p_round_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round   record;
  v_game    record;
  v_result  jsonb := '[]'::jsonb;
  v_ai      record;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round is null then raise exception 'Round not found'; end if;

  select * into v_game from games where id = v_round.game_id;
  if v_game.created_by != auth.uid() then
    raise exception 'Only the host can peek at AI hands';
  end if;

  for v_ai in
    select gp.player_id, p.ai_name, p.ai_tier
    from game_players gp
    join profiles p on p.id = gp.player_id
    where gp.game_id = v_game.id and p.is_ai = true
  loop
    v_result := v_result || jsonb_build_object(
      'player_id', v_ai.player_id,
      'ai_name', v_ai.ai_name,
      'ai_tier', v_ai.ai_tier,
      'hand', (
        select coalesce(jsonb_agg(rc.card_id order by rc.position), '[]'::jsonb)
        from round_cards rc
        where rc.round_id = p_round_id
          and rc.player_id = v_ai.player_id
          and rc.location = 'hand'
      )
    );
  end loop;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."peek_ai_hands"("p_round_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."player_ready"("p_round_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := auth.uid();
  v_all_ready boolean;
begin
  select * into v_round from rounds where id = p_round_id;
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  if v_round.turn_phase != 'ready_check' then raise exception 'Not in ready check phase'; end if;

  if not exists (
    select 1 from player_round_state
    where round_id = p_round_id and player_id = v_player_id
  ) then
    raise exception 'Player not in this round';
  end if;

  -- Mark ready (idempotent)
  update player_round_state
  set is_ready = true
  where round_id = p_round_id and player_id = v_player_id;

  -- Check if all players are now ready
  select not exists (
    select 1 from player_round_state
    where round_id = p_round_id and is_ready = false
  ) into v_all_ready;

  if v_all_ready then
    update rounds set turn_phase = 'draw' where id = p_round_id;
  end if;

  -- Log action
  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'ready',
    jsonb_build_object('all_ready', v_all_ready));

  return jsonb_build_object('ready', true, 'all_ready', v_all_ready);
end;
$$;


ALTER FUNCTION "public"."player_ready"("p_round_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_invite_code"("p_code" "text") RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."redeem_invite_code"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_ai_from_game"("p_game_id" "uuid", "p_ai_profile_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_game record;
  v_caller uuid := auth.uid();
  v_removed_seat int;
  v_has_ai boolean;
begin
  select * into v_game from games where id = p_game_id;
  if v_game is null then raise exception 'Game not found'; end if;
  if v_game.status != 'waiting' then raise exception 'Can only remove AI from a waiting game'; end if;
  if v_game.created_by != v_caller then raise exception 'Only the host can remove AI players'; end if;

  -- Verify it's an AI profile
  if not exists (select 1 from profiles where id = p_ai_profile_id and is_ai = true) then
    raise exception 'Not an AI player';
  end if;

  -- Get the seat being removed
  select seat_position into v_removed_seat from game_players
    where game_id = p_game_id and player_id = p_ai_profile_id;
  if v_removed_seat is null then raise exception 'AI player not in this game'; end if;

  -- Remove the AI player
  delete from game_players where game_id = p_game_id and player_id = p_ai_profile_id;

  -- Compact seat positions (close the gap)
  update game_players set seat_position = seat_position - 1
    where game_id = p_game_id and seat_position > v_removed_seat;

  -- Update has_ai_players flag
  select exists (
    select 1 from game_players gp
    join profiles p on p.id = gp.player_id
    where gp.game_id = p_game_id and p.is_ai = true
  ) into v_has_ai;
  update games set has_ai_players = v_has_ai where id = p_game_id;
end;
$$;


ALTER FUNCTION "public"."remove_ai_from_game"("p_game_id" "uuid", "p_ai_profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."request_buy"("p_round_id" "uuid", "p_acting_as" "uuid" DEFAULT NULL::"uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
  v_round record;
  v_player_id uuid := coalesce(p_acting_as, auth.uid());
  v_seat int;
  v_game record;
  v_prs record;
begin
  perform validate_acting_as(p_acting_as);

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


ALTER FUNCTION "public"."request_buy"("p_round_id" "uuid", "p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reshuffle_discard"("p_round_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."reshuffle_discard"("p_round_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_buy"("p_round_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."resolve_buy"("p_round_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_late_join_request"("p_request_id" "uuid", "p_decision" "text", "p_scoring_method" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."resolve_late_join_request"("p_request_id" "uuid", "p_decision" "text", "p_scoring_method" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."score_cards"("cards" "text"[]) RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."score_cards"("cards" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_game"("p_game_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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


ALTER FUNCTION "public"."start_game"("p_game_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_acting_as"("p_acting_as" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  if p_acting_as is not null then
    if not exists (select 1 from profiles where id = p_acting_as and is_ai = true) then
      raise exception 'Cannot impersonate non-AI player';
    end if;
  end if;
end;
$$;


ALTER FUNCTION "public"."validate_acting_as"("p_acting_as" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_run"("cards" "text"[], "p_min_length" integer DEFAULT 3) RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."validate_run"("cards" "text"[], "p_min_length" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."validate_set"("cards" "text"[]) RETURNS boolean
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."validate_set"("cards" "text"[]) OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."buy_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "round_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "seat_position" integer NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."buy_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."contracts" (
    "round_number" integer NOT NULL,
    "num_sets" integer NOT NULL,
    "num_runs" integer NOT NULL,
    "cards_dealt" integer NOT NULL,
    "min_run_length" integer DEFAULT 3 NOT NULL,
    "must_go_out" boolean DEFAULT false NOT NULL,
    "description" "text" NOT NULL,
    CONSTRAINT "contracts_round_number_check" CHECK ((("round_number" >= 1) AND ("round_number" <= 7)))
);


ALTER TABLE "public"."contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "game_id" "uuid" NOT NULL,
    "round_id" "uuid",
    "player_id" "uuid",
    "action_type" "public"."action_type" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."game_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."game_players" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "game_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "seat_position" integer NOT NULL,
    "is_connected" boolean DEFAULT true NOT NULL,
    "joined_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "original_player_id" "uuid"
);


ALTER TABLE "public"."game_players" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."games" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "status" "public"."game_status" DEFAULT 'waiting'::"public"."game_status" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "num_decks" integer DEFAULT 2 NOT NULL,
    "num_jokers" integer DEFAULT 0 NOT NULL,
    "buy_countdown_seconds" integer DEFAULT 10 NOT NULL,
    "max_buys_per_round" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "has_ai_players" boolean DEFAULT false NOT NULL,
    "is_modified" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."games" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invite_codes" (
    "code" "text" NOT NULL,
    "created_by" "uuid",
    "expires_at" timestamp with time zone DEFAULT ("now"() + '04:00:00'::interval) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invite_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."invite_redemptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "used_by" "uuid" NOT NULL,
    "redeemed_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."invite_redemptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."late_join_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "game_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "scoring_method" "text",
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "late_join_requests_scoring_method_check" CHECK (("scoring_method" = ANY (ARRAY['average'::"text", 'max'::"text", 'max_plus_avg'::"text"]))),
    CONSTRAINT "late_join_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'spectating'::"text", 'kicked'::"text"])))
);


ALTER TABLE "public"."late_join_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."melds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "round_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "meld_type" "public"."meld_type" NOT NULL,
    "run_suit" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."melds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."player_round_state" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "round_id" "uuid" NOT NULL,
    "player_id" "uuid" NOT NULL,
    "has_met_contract" boolean DEFAULT false NOT NULL,
    "has_drawn" boolean DEFAULT false NOT NULL,
    "buys_used" integer DEFAULT 0 NOT NULL,
    "score" integer,
    "is_ready" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."player_round_state" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."round_cards" (
    "round_id" "uuid" NOT NULL,
    "card_id" "text" NOT NULL,
    "location" "public"."card_location" NOT NULL,
    "player_id" "uuid",
    "meld_id" "uuid",
    "position" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."round_cards" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."player_round_state_public" AS
 SELECT "id",
    "round_id",
    "player_id",
    (( SELECT "count"(*) AS "count"
           FROM "public"."round_cards" "rc"
          WHERE (("rc"."round_id" = "prs"."round_id") AND ("rc"."player_id" = "prs"."player_id") AND ("rc"."location" = 'hand'::"public"."card_location"))))::integer AS "cards_in_hand",
    "has_met_contract",
    "buys_used",
    "score"
   FROM "public"."player_round_state" "prs";


ALTER VIEW "public"."player_round_state_public" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_ai" boolean DEFAULT false NOT NULL,
    "ai_name" "text",
    "ai_tier" "text",
    CONSTRAINT "profiles_ai_fields_check" CHECK (((("is_ai" = false) AND ("ai_name" IS NULL) AND ("ai_tier" IS NULL)) OR (("is_ai" = true) AND ("ai_name" IS NOT NULL) AND ("ai_tier" IS NOT NULL)))),
    CONSTRAINT "profiles_ai_name_check" CHECK ((("ai_name" IS NULL) OR ("ai_name" = ANY (ARRAY['LuVerne'::"text", 'Jeanne'::"text", 'Ron'::"text", 'Sue'::"text"])))),
    CONSTRAINT "profiles_ai_tier_check" CHECK ((("ai_tier" IS NULL) OR ("ai_tier" = ANY (ARRAY['easy'::"text", 'normal'::"text", 'hard'::"text", 'unfair'::"text"]))))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rounds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "game_id" "uuid" NOT NULL,
    "round_number" integer NOT NULL,
    "contract_sets" integer NOT NULL,
    "contract_runs" integer NOT NULL,
    "cards_dealt" integer NOT NULL,
    "dealer_seat" integer NOT NULL,
    "current_turn_seat" integer NOT NULL,
    "turn_phase" "public"."turn_phase" DEFAULT 'draw'::"public"."turn_phase" NOT NULL,
    "discard_bought" boolean DEFAULT false NOT NULL,
    "status" "public"."round_status" DEFAULT 'dealing'::"public"."round_status" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    CONSTRAINT "rounds_round_number_check" CHECK ((("round_number" >= 1) AND ("round_number" <= 7)))
);


ALTER TABLE "public"."rounds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."training_decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "game_id" "uuid" NOT NULL,
    "round_id" "uuid" NOT NULL,
    "turn_number" integer NOT NULL,
    "seat" integer NOT NULL,
    "ai_tier" "text" NOT NULL,
    "phase" "text" NOT NULL,
    "decision" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."training_decisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."training_games" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "game_id" "uuid" NOT NULL,
    "game_number" integer NOT NULL,
    "round_number" integer DEFAULT 1 NOT NULL,
    "winner_seat" integer,
    "winner_tier" "text",
    "duration_ms" integer,
    "total_turns" integer,
    "deck_order" "text"[],
    "player_seats" "jsonb" NOT NULL,
    "finished_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."training_games" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."training_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "label" "text",
    "config" "jsonb" NOT NULL,
    "total_games" integer DEFAULT 0 NOT NULL,
    "completed_games" integer DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "finished_at" timestamp with time zone,
    "summary" "jsonb",
    CONSTRAINT "training_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."training_runs" OWNER TO "postgres";


ALTER TABLE ONLY "public"."buy_requests"
    ADD CONSTRAINT "buy_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."buy_requests"
    ADD CONSTRAINT "buy_requests_round_id_player_id_key" UNIQUE ("round_id", "player_id");



ALTER TABLE ONLY "public"."contracts"
    ADD CONSTRAINT "contracts_pkey" PRIMARY KEY ("round_number");



ALTER TABLE ONLY "public"."game_actions"
    ADD CONSTRAINT "game_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_game_id_player_id_key" UNIQUE ("game_id", "player_id");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_game_id_seat_position_key" UNIQUE ("game_id", "seat_position");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_pkey" PRIMARY KEY ("code");



ALTER TABLE ONLY "public"."invite_redemptions"
    ADD CONSTRAINT "invite_redemptions_code_used_by_key" UNIQUE ("code", "used_by");



ALTER TABLE ONLY "public"."invite_redemptions"
    ADD CONSTRAINT "invite_redemptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."late_join_requests"
    ADD CONSTRAINT "late_join_requests_game_id_player_id_key" UNIQUE ("game_id", "player_id");



ALTER TABLE ONLY "public"."late_join_requests"
    ADD CONSTRAINT "late_join_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."melds"
    ADD CONSTRAINT "melds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."player_round_state"
    ADD CONSTRAINT "player_round_state_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."player_round_state"
    ADD CONSTRAINT "player_round_state_round_id_player_id_key" UNIQUE ("round_id", "player_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."round_cards"
    ADD CONSTRAINT "round_cards_pkey" PRIMARY KEY ("round_id", "card_id");



ALTER TABLE ONLY "public"."rounds"
    ADD CONSTRAINT "rounds_game_id_round_number_key" UNIQUE ("game_id", "round_number");



ALTER TABLE ONLY "public"."rounds"
    ADD CONSTRAINT "rounds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_decisions"
    ADD CONSTRAINT "training_decisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_games"
    ADD CONSTRAINT "training_games_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."training_runs"
    ADD CONSTRAINT "training_runs_pkey" PRIMARY KEY ("id");



CREATE INDEX "idx_actions_created" ON "public"."game_actions" USING "btree" ("created_at");



CREATE INDEX "idx_actions_game" ON "public"."game_actions" USING "btree" ("game_id");



CREATE INDEX "idx_actions_round" ON "public"."game_actions" USING "btree" ("round_id");



CREATE INDEX "idx_game_players_game" ON "public"."game_players" USING "btree" ("game_id");



CREATE INDEX "idx_games_code" ON "public"."games" USING "btree" ("code");



CREATE INDEX "idx_games_status" ON "public"."games" USING "btree" ("status");



CREATE INDEX "idx_ljr_game" ON "public"."late_join_requests" USING "btree" ("game_id");



CREATE INDEX "idx_melds_round" ON "public"."melds" USING "btree" ("round_id");



CREATE UNIQUE INDEX "idx_profiles_ai_identity" ON "public"."profiles" USING "btree" ("ai_name", "ai_tier") WHERE ("is_ai" = true);



CREATE INDEX "idx_prs_player" ON "public"."player_round_state" USING "btree" ("player_id");



CREATE INDEX "idx_prs_round" ON "public"."player_round_state" USING "btree" ("round_id");



CREATE INDEX "idx_rc_deck" ON "public"."round_cards" USING "btree" ("round_id", "position") WHERE ("location" = 'deck'::"public"."card_location");



CREATE INDEX "idx_rc_discard" ON "public"."round_cards" USING "btree" ("round_id", "position") WHERE ("location" = 'discard'::"public"."card_location");



CREATE INDEX "idx_rc_hand" ON "public"."round_cards" USING "btree" ("round_id", "player_id") WHERE ("location" = 'hand'::"public"."card_location");



CREATE INDEX "idx_rc_meld" ON "public"."round_cards" USING "btree" ("round_id", "meld_id", "position") WHERE ("location" = 'meld'::"public"."card_location");



CREATE INDEX "idx_rounds_game" ON "public"."rounds" USING "btree" ("game_id");



CREATE INDEX "idx_td_game" ON "public"."training_decisions" USING "btree" ("game_id");



CREATE INDEX "idx_td_tier" ON "public"."training_decisions" USING "btree" ("ai_tier");



CREATE INDEX "idx_tg_run" ON "public"."training_games" USING "btree" ("run_id");



ALTER TABLE ONLY "public"."buy_requests"
    ADD CONSTRAINT "buy_requests_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."buy_requests"
    ADD CONSTRAINT "buy_requests_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_actions"
    ADD CONSTRAINT "game_actions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_actions"
    ADD CONSTRAINT "game_actions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."game_actions"
    ADD CONSTRAINT "game_actions_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_original_player_id_fkey" FOREIGN KEY ("original_player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."game_players"
    ADD CONSTRAINT "game_players_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."games"
    ADD CONSTRAINT "games_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."invite_codes"
    ADD CONSTRAINT "invite_codes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."invite_redemptions"
    ADD CONSTRAINT "invite_redemptions_code_fkey" FOREIGN KEY ("code") REFERENCES "public"."invite_codes"("code");



ALTER TABLE ONLY "public"."invite_redemptions"
    ADD CONSTRAINT "invite_redemptions_used_by_fkey" FOREIGN KEY ("used_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."late_join_requests"
    ADD CONSTRAINT "late_join_requests_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."late_join_requests"
    ADD CONSTRAINT "late_join_requests_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."late_join_requests"
    ADD CONSTRAINT "late_join_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."melds"
    ADD CONSTRAINT "melds_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."melds"
    ADD CONSTRAINT "melds_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."player_round_state"
    ADD CONSTRAINT "player_round_state_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."player_round_state"
    ADD CONSTRAINT "player_round_state_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."round_cards"
    ADD CONSTRAINT "round_cards_meld_id_fkey" FOREIGN KEY ("meld_id") REFERENCES "public"."melds"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."round_cards"
    ADD CONSTRAINT "round_cards_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."round_cards"
    ADD CONSTRAINT "round_cards_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "public"."rounds"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rounds"
    ADD CONSTRAINT "rounds_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."training_decisions"
    ADD CONSTRAINT "training_decisions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."training_games"
    ADD CONSTRAINT "training_games_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id");



ALTER TABLE ONLY "public"."training_games"
    ADD CONSTRAINT "training_games_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."training_runs"("id") ON DELETE CASCADE;



CREATE POLICY "Anyone can read contracts" ON "public"."contracts" FOR SELECT USING (true);



CREATE POLICY "Anyone can view profiles" ON "public"."profiles" FOR SELECT USING (true);



CREATE POLICY "Authenticated users can create games" ON "public"."games" FOR INSERT WITH CHECK (("auth"."uid"() = "created_by"));



CREATE POLICY "Authenticated users can view game_players" ON "public"."game_players" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



CREATE POLICY "Game creator can update game" ON "public"."games" FOR UPDATE USING (("auth"."uid"() = "created_by"));



CREATE POLICY "No direct access to invite codes" ON "public"."invite_codes" FOR SELECT USING (false);



CREATE POLICY "No direct access to invite redemptions" ON "public"."invite_redemptions" FOR SELECT USING (false);



CREATE POLICY "Players can see discard pile" ON "public"."round_cards" FOR SELECT USING ((("location" = 'discard'::"public"."card_location") AND ((EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."game_players" "gp" ON (("gp"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "round_cards"."round_id") AND ("gp"."player_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."late_join_requests" "ljr" ON (("ljr"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "round_cards"."round_id") AND ("ljr"."player_id" = "auth"."uid"())))))));



CREATE POLICY "Players can see meld cards" ON "public"."round_cards" FOR SELECT USING ((("location" = 'meld'::"public"."card_location") AND ((EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."game_players" "gp" ON (("gp"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "round_cards"."round_id") AND ("gp"."player_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."late_join_requests" "ljr" ON (("ljr"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "round_cards"."round_id") AND ("ljr"."player_id" = "auth"."uid"())))))));



CREATE POLICY "Players can see own full state" ON "public"."player_round_state" FOR SELECT USING (("auth"."uid"() = "player_id"));



CREATE POLICY "Players can see own hand cards" ON "public"."round_cards" FOR SELECT USING ((("location" = 'hand'::"public"."card_location") AND ("player_id" = "auth"."uid"())));



CREATE POLICY "Players can view games they are in" ON "public"."games" FOR SELECT USING ((("status" = 'waiting'::"public"."game_status") OR ("created_by" = "auth"."uid"()) OR ("id" IN ( SELECT "game_players"."game_id"
   FROM "public"."game_players"
  WHERE ("game_players"."player_id" = "auth"."uid"()))) OR ("id" IN ( SELECT "late_join_requests"."game_id"
   FROM "public"."late_join_requests"
  WHERE ("late_join_requests"."player_id" = "auth"."uid"())))));



CREATE POLICY "Players in game can view actions" ON "public"."game_actions" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."game_players"
  WHERE (("game_players"."game_id" = "game_actions"."game_id") AND ("game_players"."player_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."late_join_requests"
  WHERE (("late_join_requests"."game_id" = "game_actions"."game_id") AND ("late_join_requests"."player_id" = "auth"."uid"()))))));



CREATE POLICY "Players in game can view buy requests" ON "public"."buy_requests" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."game_players" "gp" ON (("gp"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "buy_requests"."round_id") AND ("gp"."player_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."late_join_requests" "ljr" ON (("ljr"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "buy_requests"."round_id") AND ("ljr"."player_id" = "auth"."uid"()))))));



CREATE POLICY "Players in game can view melds" ON "public"."melds" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."game_players" "gp" ON (("gp"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "melds"."round_id") AND ("gp"."player_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM ("public"."rounds" "r"
     JOIN "public"."late_join_requests" "ljr" ON (("ljr"."game_id" = "r"."game_id")))
  WHERE (("r"."id" = "melds"."round_id") AND ("ljr"."player_id" = "auth"."uid"()))))));



CREATE POLICY "Players in game can view rounds" ON "public"."rounds" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."game_players"
  WHERE (("game_players"."game_id" = "rounds"."game_id") AND ("game_players"."player_id" = "auth"."uid"())))) OR (EXISTS ( SELECT 1
   FROM "public"."late_join_requests"
  WHERE (("late_join_requests"."game_id" = "rounds"."game_id") AND ("late_join_requests"."player_id" = "auth"."uid"()))))));



CREATE POLICY "Users can insert own profile" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "id"));



CREATE POLICY "Users can join games" ON "public"."game_players" FOR INSERT WITH CHECK (("auth"."uid"() = "player_id"));



CREATE POLICY "Users can update own connection status" ON "public"."game_players" FOR UPDATE USING (("auth"."uid"() = "player_id"));



CREATE POLICY "Users can update own profile" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "id"));



CREATE POLICY "View late join requests" ON "public"."late_join_requests" FOR SELECT USING ((("player_id" = "auth"."uid"()) OR ("game_id" IN ( SELECT "game_players"."game_id"
   FROM "public"."game_players"
  WHERE ("game_players"."player_id" = "auth"."uid"())))));



ALTER TABLE "public"."buy_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."contracts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."game_players" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."games" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invite_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."invite_redemptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."late_join_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."melds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."player_round_state" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."round_cards" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rounds" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."buy_requests";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."game_actions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."game_players";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."games";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."late_join_requests";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."melds";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."player_round_state";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."round_cards";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."rounds";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";

























































































































































GRANT ALL ON FUNCTION "public"."add_ai_to_game"("p_game_id" "uuid", "p_ai_name" "text", "p_ai_tier" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."add_ai_to_game"("p_game_id" "uuid", "p_ai_name" "text", "p_ai_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."add_ai_to_game"("p_game_id" "uuid", "p_ai_name" "text", "p_ai_tier" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."assign_ai_takeover"("p_game_id" "uuid", "p_seat_position" integer, "p_ai_name" "text", "p_ai_tier" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."assign_ai_takeover"("p_game_id" "uuid", "p_seat_position" integer, "p_ai_name" "text", "p_ai_tier" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_ai_takeover"("p_game_id" "uuid", "p_seat_position" integer, "p_ai_name" "text", "p_ai_tier" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."can_lay_off"("p_meld_id" "uuid", "p_card" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."can_lay_off"("p_meld_id" "uuid", "p_card" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."can_lay_off"("p_meld_id" "uuid", "p_card" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cancel_buy"("p_round_id" "uuid", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_buy"("p_round_id" "uuid", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_buy"("p_round_id" "uuid", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."cancel_game"("p_game_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."cancel_game"("p_game_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cancel_game"("p_game_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_deck"("card" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."card_deck"("card" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_deck"("card" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_suit"("card" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."card_suit"("card" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_suit"("card" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_value"("card" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."card_value"("card" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_value"("card" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."create_game"("p_buy_countdown" integer, "p_max_buys" integer, "p_num_decks" integer, "p_num_jokers" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."create_game"("p_buy_countdown" integer, "p_max_buys" integer, "p_num_decks" integer, "p_num_jokers" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_game"("p_buy_countdown" integer, "p_max_buys" integer, "p_num_decks" integer, "p_num_jokers" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_next_round"("p_game_id" "uuid", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deal_next_round"("p_game_id" "uuid", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_next_round"("p_game_id" "uuid", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deal_round"("p_game_id" "uuid", "p_round_num" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."deal_round"("p_game_id" "uuid", "p_round_num" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."deal_round"("p_game_id" "uuid", "p_round_num" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."discard_card"("p_round_id" "uuid", "p_card" "text", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."discard_card"("p_round_id" "uuid", "p_card" "text", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."discard_card"("p_round_id" "uuid", "p_card" "text", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."draw_from_deck"("p_round_id" "uuid", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."draw_from_deck"("p_round_id" "uuid", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_from_deck"("p_round_id" "uuid", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."draw_from_discard"("p_round_id" "uuid", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."draw_from_discard"("p_round_id" "uuid", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."draw_from_discard"("p_round_id" "uuid", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."end_game"("p_game_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."end_game"("p_game_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."end_game"("p_game_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."end_game_request"("p_game_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."end_game_request"("p_game_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."end_game_request"("p_game_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."end_round"("p_round_id" "uuid", "p_winner_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."end_round"("p_round_id" "uuid", "p_winner_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."end_round"("p_round_id" "uuid", "p_winner_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."fulfill_contract"("p_round_id" "uuid", "p_melds" "jsonb", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."fulfill_contract"("p_round_id" "uuid", "p_melds" "jsonb", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."fulfill_contract"("p_round_id" "uuid", "p_melds" "jsonb", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_game_code"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_game_code"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_game_code"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_active_game"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_active_game"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_active_game"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_game_history"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_game_history"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_game_history"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_game_state"("p_game_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_game_state"("p_game_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_game_state"("p_game_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_hand"("p_round_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_hand"("p_round_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_hand"("p_round_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_open_games"() TO "anon";
GRANT ALL ON FUNCTION "public"."get_open_games"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_open_games"() TO "service_role";



GRANT ALL ON FUNCTION "public"."hand_count"("p_round_id" "uuid", "p_player_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."hand_count"("p_round_id" "uuid", "p_player_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."hand_count"("p_round_id" "uuid", "p_player_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_joker"("card" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."is_joker"("card" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_joker"("card" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."join_game"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."join_game"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."join_game"("p_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."lay_down_meld"("p_round_id" "uuid", "p_cards" "text"[], "p_meld_type" "public"."meld_type", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lay_down_meld"("p_round_id" "uuid", "p_cards" "text"[], "p_meld_type" "public"."meld_type", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lay_down_meld"("p_round_id" "uuid", "p_cards" "text"[], "p_meld_type" "public"."meld_type", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."lay_off_card"("p_round_id" "uuid", "p_meld_id" "uuid", "p_card" "text", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."lay_off_card"("p_round_id" "uuid", "p_meld_id" "uuid", "p_card" "text", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."lay_off_card"("p_round_id" "uuid", "p_meld_id" "uuid", "p_card" "text", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."peek_ai_hands"("p_round_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."peek_ai_hands"("p_round_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."peek_ai_hands"("p_round_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."player_ready"("p_round_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."player_ready"("p_round_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."player_ready"("p_round_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."redeem_invite_code"("p_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."remove_ai_from_game"("p_game_id" "uuid", "p_ai_profile_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."remove_ai_from_game"("p_game_id" "uuid", "p_ai_profile_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_ai_from_game"("p_game_id" "uuid", "p_ai_profile_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."request_buy"("p_round_id" "uuid", "p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."request_buy"("p_round_id" "uuid", "p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."request_buy"("p_round_id" "uuid", "p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."reshuffle_discard"("p_round_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."reshuffle_discard"("p_round_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."reshuffle_discard"("p_round_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_buy"("p_round_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_buy"("p_round_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_buy"("p_round_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_late_join_request"("p_request_id" "uuid", "p_decision" "text", "p_scoring_method" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_late_join_request"("p_request_id" "uuid", "p_decision" "text", "p_scoring_method" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_late_join_request"("p_request_id" "uuid", "p_decision" "text", "p_scoring_method" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."score_cards"("cards" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."score_cards"("cards" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."score_cards"("cards" "text"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."start_game"("p_game_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."start_game"("p_game_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."start_game"("p_game_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_acting_as"("p_acting_as" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."validate_acting_as"("p_acting_as" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_acting_as"("p_acting_as" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_run"("cards" "text"[], "p_min_length" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_run"("cards" "text"[], "p_min_length" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_run"("cards" "text"[], "p_min_length" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."validate_set"("cards" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."validate_set"("cards" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."validate_set"("cards" "text"[]) TO "service_role";


















GRANT ALL ON TABLE "public"."buy_requests" TO "anon";
GRANT ALL ON TABLE "public"."buy_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."buy_requests" TO "service_role";



GRANT ALL ON TABLE "public"."contracts" TO "anon";
GRANT ALL ON TABLE "public"."contracts" TO "authenticated";
GRANT ALL ON TABLE "public"."contracts" TO "service_role";



GRANT ALL ON TABLE "public"."game_actions" TO "anon";
GRANT ALL ON TABLE "public"."game_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."game_actions" TO "service_role";



GRANT ALL ON TABLE "public"."game_players" TO "anon";
GRANT ALL ON TABLE "public"."game_players" TO "authenticated";
GRANT ALL ON TABLE "public"."game_players" TO "service_role";



GRANT ALL ON TABLE "public"."games" TO "anon";
GRANT ALL ON TABLE "public"."games" TO "authenticated";
GRANT ALL ON TABLE "public"."games" TO "service_role";



GRANT ALL ON TABLE "public"."invite_codes" TO "anon";
GRANT ALL ON TABLE "public"."invite_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."invite_codes" TO "service_role";



GRANT ALL ON TABLE "public"."invite_redemptions" TO "anon";
GRANT ALL ON TABLE "public"."invite_redemptions" TO "authenticated";
GRANT ALL ON TABLE "public"."invite_redemptions" TO "service_role";



GRANT ALL ON TABLE "public"."late_join_requests" TO "anon";
GRANT ALL ON TABLE "public"."late_join_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."late_join_requests" TO "service_role";



GRANT ALL ON TABLE "public"."melds" TO "anon";
GRANT ALL ON TABLE "public"."melds" TO "authenticated";
GRANT ALL ON TABLE "public"."melds" TO "service_role";



GRANT ALL ON TABLE "public"."player_round_state" TO "anon";
GRANT ALL ON TABLE "public"."player_round_state" TO "authenticated";
GRANT ALL ON TABLE "public"."player_round_state" TO "service_role";



GRANT ALL ON TABLE "public"."round_cards" TO "anon";
GRANT ALL ON TABLE "public"."round_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."round_cards" TO "service_role";



GRANT ALL ON TABLE "public"."player_round_state_public" TO "anon";
GRANT ALL ON TABLE "public"."player_round_state_public" TO "authenticated";
GRANT ALL ON TABLE "public"."player_round_state_public" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."rounds" TO "anon";
GRANT ALL ON TABLE "public"."rounds" TO "authenticated";
GRANT ALL ON TABLE "public"."rounds" TO "service_role";



GRANT ALL ON TABLE "public"."training_decisions" TO "anon";
GRANT ALL ON TABLE "public"."training_decisions" TO "authenticated";
GRANT ALL ON TABLE "public"."training_decisions" TO "service_role";



GRANT ALL ON TABLE "public"."training_games" TO "anon";
GRANT ALL ON TABLE "public"."training_games" TO "authenticated";
GRANT ALL ON TABLE "public"."training_games" TO "service_role";



GRANT ALL ON TABLE "public"."training_runs" TO "anon";
GRANT ALL ON TABLE "public"."training_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."training_runs" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































SET search_path TO public, extensions;

-- ============================================================
-- play27 — AI Training Tables
-- Stores training run configs, game results, and per-decision logs
-- ============================================================

-- Batch of training games with shared config
create table if not exists training_runs (
  id              uuid primary key default gen_random_uuid(),
  label           text,
  config          jsonb not null,
  total_games     int not null default 0,
  completed_games int not null default 0,
  status          text not null default 'running'
                  check (status in ('running', 'completed', 'failed')),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  summary         jsonb
);

-- Individual game result within a training run
create table if not exists training_games (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references training_runs(id) on delete cascade,
  game_id         uuid not null references games(id),
  game_number     int not null,
  round_number    int not null default 1,
  winner_seat     int,
  winner_tier     text,
  duration_ms     int,
  total_turns     int,
  deck_order      text[],
  player_seats    jsonb not null,   -- [{seat, ai_name, ai_tier, final_score, met_contract}]
  finished_at     timestamptz not null default now()
);

create index if not exists idx_tg_run on training_games(run_id);

-- Per-decision log for analysis
create table if not exists training_decisions (
  id              uuid primary key default gen_random_uuid(),
  game_id         uuid not null references games(id) on delete cascade,
  round_id        uuid not null,
  turn_number     int not null,
  seat            int not null,
  ai_tier         text not null,
  phase           text not null,    -- draw | meld | lay_off | discard | buy
  decision        jsonb not null,   -- {action, reason, hand_size, alternatives, ...}
  created_at      timestamptz not null default now()
);

create index if not exists idx_td_game on training_decisions(game_id);
create index if not exists idx_td_tier on training_decisions(ai_tier);
