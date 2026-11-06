-- ============================================================
-- Scorekeeper: any seated player can say who went out
--
-- The phone asks "Who went out?" before the score keypad. Answering puts a 0 on
-- that player for the current hand, so the winner doesn't have to enter it and
-- a player without a phone is covered too.
--
-- It only fills an empty score: it refuses once anyone has a 0 for the hand, or
-- if that player already has a score. score_auth_player locks the table row, so
-- two phones can't both answer. The marked player can still change their score
-- with score_submit, and two 0s entered that way go to the contested screen.
--
-- Applied to the live database 2026-11-05.
-- ============================================================

create or replace function public.score_mark_out(p_code text, p_token text, p_player_id uuid, p_hand int)
returns void language plpgsql security definer set search_path = public as $$
declare me public.score_players; t public.score_tables; target public.score_players; v_out text;
begin
  me := public.score_auth_player(p_code, p_token);
  select * into t from public.score_tables where id = me.table_id;
  if t.status <> 'playing' then raise exception 'The game is not being played right now'; end if;
  if p_hand is distinct from t.hand then raise exception 'Play has moved to another hand'; end if;
  select * into target from public.score_players where id = p_player_id and table_id = t.id and not removed;
  if not found then raise exception 'That player is not at this table'; end if;
  select pl.name into v_out from public.score_entries e
    join public.score_players pl on pl.id = e.player_id and not pl.removed
    where e.table_id = t.id and e.game_no = t.game_no and e.hand = p_hand and e.score = 0
    limit 1;
  if found then raise exception '% already went out', v_out; end if;
  if exists (select 1 from public.score_entries e
             where e.player_id = target.id and e.game_no = t.game_no and e.hand = p_hand and e.score is not null) then
    raise exception '% already has a score for this hand', target.name;
  end if;
  perform public.score_put(t, target.id, p_hand, 0, 'player');
end $$;

revoke all on function public.score_mark_out(text, text, uuid, int) from public, anon, authenticated;
grant execute on function public.score_mark_out(text, text, uuid, int) to anon, authenticated;
