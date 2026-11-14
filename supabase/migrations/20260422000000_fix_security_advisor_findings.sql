-- Resolves four findings from the Supabase security advisor (2026-04-19):
--   1-3. rls_disabled_in_public on training_runs, training_games, training_decisions
--   4.   security_definer_view on player_round_state_public

-- ---------------------------------------------------------------------------
-- 1-3. Enable RLS on training_* tables.
-- These are written only by the _training edge function via the service_role
-- key, which bypasses RLS, so no policies are needed — anon/authenticated get
-- no access, which is what we want.
-- ---------------------------------------------------------------------------
alter table "public"."training_runs"      enable row level security;
alter table "public"."training_games"     enable row level security;
alter table "public"."training_decisions" enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Make player_round_state_public run with the caller's RLS, not the
-- view-owner's (Postgres views default to SECURITY DEFINER semantics, which
-- the advisor flags because they bypass the querying user's RLS).
--
-- Flipping to security_invoker means the view now respects RLS on the
-- underlying player_round_state table. The existing policy only lets a
-- player see their OWN row, which would break the intended use of this view
-- (showing opponents' public round state: card count, score, has_met_contract,
-- buys_used). So we add a broader SELECT policy allowing any player to read
-- rows for co-players in a game they are also in.
--
-- This opens the base table to the same visibility as the view. That is safe
-- because every column in player_round_state is already non-sensitive public
-- game state — hidden hand contents live in round_cards, which has its own
-- stricter policies.
-- ---------------------------------------------------------------------------
alter view "public"."player_round_state_public" set (security_invoker = true);

create policy "Players can see co-players' round state"
  on "public"."player_round_state"
  for select
  using (
    exists (
      select 1
      from "public"."rounds" r
      join "public"."game_players" gp_self  on gp_self.game_id  = r.game_id
      join "public"."game_players" gp_other on gp_other.game_id = r.game_id
      where r.id = player_round_state.round_id
        and gp_self.player_id  = auth.uid()
        and gp_other.player_id = player_round_state.player_id
    )
  );
