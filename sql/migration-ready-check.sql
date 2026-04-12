-- Ready Check System: pause after deal so players can review their hand before play begins

-- 1. Add 'ready_check' to turn_phase enum
alter type turn_phase add value if not exists 'ready_check' before 'draw';

-- 2. Add 'ready' to action_type enum
alter type action_type add value if not exists 'ready';

-- 3. Add is_ready column to player_round_state
alter table player_round_state add column if not exists is_ready boolean not null default false;

-- 3. Player ready RPC
create or replace function player_ready(p_round_id uuid)
returns jsonb
language plpgsql security definer as $$
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
