-- ============================================================
-- Buying: whoever's turn it is keeps first claim on the discard
--
-- A buy request opens a countdown (turn_phase = 'buy_window'). Until now the
-- player whose turn it is could not draw during it, so a buyer always got the
-- card. With this change that player can still take the discard during the
-- countdown, which cancels the pending buy requests. If they let the countdown
-- run out, the buy resolves as before.
--
-- Both functions now lock the round row, so a claim and the countdown ending
-- at the same moment can't both move the same card.
--
-- Apply in the Supabase SQL editor. Function bodies are the deployed versions
-- (supabase/migrations/20260412000000_full_schema.sql) with only the marked
-- lines changed. Grants carry over with CREATE OR REPLACE.
-- ============================================================

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

  select * into v_round from rounds where id = p_round_id for update;  -- changed: lock against resolve_buy
  if v_round.status != 'active' then raise exception 'Round not active'; end if;
  -- changed: the player whose turn it is may also take the discard during a buy countdown (first claim)
  if v_round.turn_phase not in ('draw', 'buy_window') then raise exception 'Not draw phase'; end if;

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

  -- changed: claiming during a buy countdown cancels the pending buy requests
  if v_round.turn_phase = 'buy_window' then
    delete from buy_requests where round_id = p_round_id;
  end if;

  update rounds set turn_phase = 'action' where id = p_round_id;

  update player_round_state set has_drawn = true
    where round_id = p_round_id and player_id = v_player_id;

  insert into game_actions (game_id, round_id, player_id, action_type, details)
  values (v_round.game_id, p_round_id, v_player_id, 'draw_discard',
    jsonb_build_object('card', v_card));

  return v_card;
end;
$$;


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
  select * into v_round from rounds where id = p_round_id for update;  -- changed: lock against a first-claim draw
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
