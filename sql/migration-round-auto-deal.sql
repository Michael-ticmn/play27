-- ============================================================
-- Contract Rummy: the next round deals itself after the round-end countdown
--
-- games.auto_deal_minutes is how long the scoreboard stays up after the round
-- reveal: 0 is off, the default is 1. The host sets it with set_auto_deal.
--
-- get_game_state now also returns auto_deal_minutes, the round's finished_at and
-- the server's clock, so every device counts down to the same moment.
--
-- deal_next_round still lets the dealer deal at any time. Once the minutes have
-- passed since the round finished, any seated player's device can deal too, so
-- an absent dealer can't stall the table. The games row is locked, so when
-- several devices deal at once only the first succeeds; the others get
-- 'Current round not finished', and the page ignores that.
--
-- Applied to the live database 2026-11-05. Function bodies are the deployed versions
-- with only the marked lines changed. Grants carry over with CREATE OR REPLACE.
-- ============================================================

alter table public.games add column if not exists auto_deal_minutes int not null default 1
  check (auto_deal_minutes between 0 and 10);

create or replace function public.set_auto_deal(p_game_id uuid, p_minutes int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_minutes is null or p_minutes not between 0 and 10 then
    raise exception 'Auto-deal must be 0 to 10 minutes';
  end if;
  update public.games set auto_deal_minutes = p_minutes where id = p_game_id and created_by = auth.uid();
  if not found then raise exception 'Only the host can change the auto-deal'; end if;
end $$;

revoke all on function public.set_auto_deal(uuid, int) from public, anon, authenticated;
grant execute on function public.set_auto_deal(uuid, int) to authenticated;


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
    'auto_deal_minutes', v_game.auto_deal_minutes,  -- changed: for the round-end countdown
    'server_now', now(),  -- changed: lets each device line up with the server clock
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
        'finished_at', v_round.finished_at,  -- changed: when the round-end countdown started
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

  -- changed: devices dealing at the same moment take turns, and the later ones find the round already dealt
  select * into v_game from games where id = p_game_id for no key update;
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
  ) and not (  -- changed: once the automatic deal is due, any seated player's device can deal
    v_game.auto_deal_minutes > 0
    and now() >= v_last_round.finished_at + make_interval(mins => v_game.auto_deal_minutes)
    and exists (select 1 from game_players where game_id = p_game_id and player_id = v_player_id)
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
