-- ============================================================
-- AI Player Migration — Additive, non-destructive
-- Run once against existing database to enable AI players.
-- ============================================================

-- ── Step 1: Remove FK from profiles.id → auth.users(id) ──
-- This allows AI profiles (no auth account) to exist in profiles.
-- The handle_new_user() trigger still auto-creates human profiles.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- The PK constraint name varies — try the common Supabase default too
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_pkey CASCADE;
ALTER TABLE profiles ADD PRIMARY KEY (id);

-- ── Step 2: Re-add child FKs that may have cascaded away ──
-- (safe: IF NOT EXISTS via DO blocks)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'games_created_by_fkey') THEN
    ALTER TABLE games ADD CONSTRAINT games_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_players_player_id_fkey') THEN
    ALTER TABLE game_players ADD CONSTRAINT game_players_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'player_round_state_player_id_fkey') THEN
    ALTER TABLE player_round_state ADD CONSTRAINT player_round_state_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'melds_player_id_fkey') THEN
    ALTER TABLE melds ADD CONSTRAINT melds_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'round_cards_player_id_fkey') THEN
    ALTER TABLE round_cards ADD CONSTRAINT round_cards_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'buy_requests_player_id_fkey') THEN
    ALTER TABLE buy_requests ADD CONSTRAINT buy_requests_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_actions_player_id_fkey') THEN
    ALTER TABLE game_actions ADD CONSTRAINT game_actions_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invite_codes_created_by_fkey') THEN
    ALTER TABLE invite_codes ADD CONSTRAINT invite_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'late_join_requests_player_id_fkey') THEN
    ALTER TABLE late_join_requests ADD CONSTRAINT late_join_requests_player_id_fkey FOREIGN KEY (player_id) REFERENCES profiles(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'late_join_requests_resolved_by_fkey') THEN
    ALTER TABLE late_join_requests ADD CONSTRAINT late_join_requests_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES profiles(id);
  END IF;
END $$;

-- ── Step 3: Add AI columns to profiles ──

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_ai boolean NOT NULL DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_name text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_tier text;

-- Constraints on AI columns
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_ai_name_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_ai_name_check
      CHECK (ai_name IS NULL OR ai_name IN ('LuVerne', 'Jeanne', 'Ron', 'Sue'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_ai_tier_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_ai_tier_check
      CHECK (ai_tier IS NULL OR ai_tier IN ('easy', 'normal', 'hard', 'unfair'));
  END IF;
END $$;

-- AI profiles must have both name and tier; humans must have neither
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_ai_fields_check') THEN
    ALTER TABLE profiles ADD CONSTRAINT profiles_ai_fields_check
      CHECK (
        (is_ai = false AND ai_name IS NULL AND ai_tier IS NULL)
        OR (is_ai = true AND ai_name IS NOT NULL AND ai_tier IS NOT NULL)
      );
  END IF;
END $$;

-- Unique AI identity: each name+tier combo is exactly one profile
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_ai_identity
  ON profiles (ai_name, ai_tier) WHERE is_ai = true;

-- ── Step 4: Seed 16 AI profiles ──
-- Deterministic UUIDs for easy reference. Format: 00000000-0000-4000-a000-00000000XXYY
-- XX = name (01=LuVerne, 02=Jeanne, 03=Ron, 04=Sue)
-- YY = tier (01=easy, 02=normal, 03=hard, 04=unfair)

INSERT INTO profiles (id, display_name, is_ai, ai_name, ai_tier) VALUES
  -- LuVerne
  ('00000000-0000-4000-a000-000000000101', 'LuVerne', true, 'LuVerne', 'easy'),
  ('00000000-0000-4000-a000-000000000102', 'LuVerne', true, 'LuVerne', 'normal'),
  ('00000000-0000-4000-a000-000000000103', 'LuVerne', true, 'LuVerne', 'hard'),
  ('00000000-0000-4000-a000-000000000104', 'LuVerne', true, 'LuVerne', 'unfair'),
  -- Jeanne
  ('00000000-0000-4000-a000-000000000201', 'Jeanne', true, 'Jeanne', 'easy'),
  ('00000000-0000-4000-a000-000000000202', 'Jeanne', true, 'Jeanne', 'normal'),
  ('00000000-0000-4000-a000-000000000203', 'Jeanne', true, 'Jeanne', 'hard'),
  ('00000000-0000-4000-a000-000000000204', 'Jeanne', true, 'Jeanne', 'unfair'),
  -- Ron
  ('00000000-0000-4000-a000-000000000301', 'Ron', true, 'Ron', 'easy'),
  ('00000000-0000-4000-a000-000000000302', 'Ron', true, 'Ron', 'normal'),
  ('00000000-0000-4000-a000-000000000303', 'Ron', true, 'Ron', 'hard'),
  ('00000000-0000-4000-a000-000000000304', 'Ron', true, 'Ron', 'unfair'),
  -- Sue
  ('00000000-0000-4000-a000-000000000401', 'Sue', true, 'Sue', 'easy'),
  ('00000000-0000-4000-a000-000000000402', 'Sue', true, 'Sue', 'normal'),
  ('00000000-0000-4000-a000-000000000403', 'Sue', true, 'Sue', 'hard'),
  ('00000000-0000-4000-a000-000000000404', 'Sue', true, 'Sue', 'unfair')
ON CONFLICT (id) DO NOTHING;

-- ── Step 5: Add AI tracking columns to games ──

ALTER TABLE games ADD COLUMN IF NOT EXISTS has_ai_players boolean NOT NULL DEFAULT false;
ALTER TABLE games ADD COLUMN IF NOT EXISTS is_modified boolean NOT NULL DEFAULT false;

-- ── Step 6: Add takeover tracking to game_players ──
-- When AI replaces a disconnected human, original_player_id stores the human's ID.

ALTER TABLE game_players ADD COLUMN IF NOT EXISTS original_player_id uuid;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_players_original_player_id_fkey') THEN
    ALTER TABLE game_players ADD CONSTRAINT game_players_original_player_id_fkey
      FOREIGN KEY (original_player_id) REFERENCES profiles(id);
  END IF;
END $$;

-- ── Step 7: RLS for AI profiles ──
-- AI profiles are readable by anyone (existing "Anyone can view profiles" policy covers this).
-- AI profiles cannot be updated or inserted by normal users (existing policies use auth.uid() = id).
-- Edge functions use service_role which bypasses RLS entirely.

-- Done! All existing functionality is preserved. AI profiles are now available.
