-- Allow start_game to begin at any round (for training harness).
-- Default is 1, so production behavior is unchanged.

-- Drop the old 1-param overload so PostgREST doesn't get confused
DROP FUNCTION IF EXISTS "public"."start_game"("uuid");

CREATE OR REPLACE FUNCTION "public"."start_game"(
  "p_game_id" "uuid",
  "p_start_round" integer DEFAULT 1
) RETURNS "void"
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

  perform deal_round(p_game_id, p_start_round);
end;
$$;
