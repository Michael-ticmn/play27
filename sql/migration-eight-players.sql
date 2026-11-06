-- ============================================================
-- Contract Rummy: up to 8 players at a table
--
-- join_game and late joins allowed 7, and adding AI players stopped at 6 seated.
-- All three now allow 8. Nothing else depends on the number: 5 or more players
-- already play with 3 decks, which covers 8 players at 12 cards each.
--
-- Applied to the live database 2026-11-05. Function bodies are the deployed versions
-- with only the marked lines changed. Grants carry over with CREATE OR REPLACE.
-- ============================================================

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

  if v_seat >= 8 then  -- changed: was 7
    raise exception 'Game is full (max 8 players)';
  end if;

  insert into game_players (game_id, player_id, seat_position)
  values (v_game.id, v_player_id, v_seat);

  return v_game.id;
end;
$$;


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
  if v_player_count >= 8 then raise exception 'Game is full (max 8 players)'; end if;  -- changed: was 6

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
    -- Check player cap (current + already-approved + this one <= 8)
    select count(*) into v_current_players from game_players where game_id = v_req.game_id;
    select count(*) into v_pending_approved from late_join_requests
      where game_id = v_req.game_id and status = 'approved';
    if v_current_players + v_pending_approved + 1 > 8 then  -- changed: was 7
      raise exception 'Game would exceed 8 players';
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
