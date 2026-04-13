-- ============================================================
-- Local dev seed: contracts, AI profiles, trainer account
-- Runs automatically after migrations on `supabase db reset`
-- NOTE: Trainer auth user must be created via admin API after reset
--       (see _training/README or run the setup script)
-- ============================================================

-- ── Contract definitions (required for game engine) ──
INSERT INTO contracts (round_number, num_sets, num_runs, cards_dealt, min_run_length, must_go_out, description) VALUES
  (1, 2, 0, 10, 3, false, '2 Sets of 3'),
  (2, 1, 1, 10, 3, false, '1 Set of 3 + 1 Run of 3'),
  (3, 0, 2, 10, 3, false, '2 Runs of 3'),
  (4, 3, 0, 10, 3, false, '3 Sets of 3'),
  (5, 2, 1, 12, 3, false, '2 Sets of 3 + 1 Run of 3'),
  (6, 1, 2, 12, 3, false, '1 Set of 3 + 2 Runs of 3'),
  (7, 0, 3, 12, 3, true,  '3 Runs of 3 (must meld all)')
ON CONFLICT (round_number) DO NOTHING;

-- ── AI profiles (16 = 4 names × 4 tiers) ──
INSERT INTO profiles (id, display_name, is_ai, ai_name, ai_tier) VALUES
  ('00000000-0000-4000-a000-000000000101', 'LuVerne', true, 'LuVerne', 'easy'),
  ('00000000-0000-4000-a000-000000000102', 'LuVerne', true, 'LuVerne', 'normal'),
  ('00000000-0000-4000-a000-000000000103', 'LuVerne', true, 'LuVerne', 'hard'),
  ('00000000-0000-4000-a000-000000000104', 'LuVerne', true, 'LuVerne', 'unfair'),
  ('00000000-0000-4000-a000-000000000201', 'Jeanne', true, 'Jeanne', 'easy'),
  ('00000000-0000-4000-a000-000000000202', 'Jeanne', true, 'Jeanne', 'normal'),
  ('00000000-0000-4000-a000-000000000203', 'Jeanne', true, 'Jeanne', 'hard'),
  ('00000000-0000-4000-a000-000000000204', 'Jeanne', true, 'Jeanne', 'unfair'),
  ('00000000-0000-4000-a000-000000000301', 'Ron', true, 'Ron', 'easy'),
  ('00000000-0000-4000-a000-000000000302', 'Ron', true, 'Ron', 'normal'),
  ('00000000-0000-4000-a000-000000000303', 'Ron', true, 'Ron', 'hard'),
  ('00000000-0000-4000-a000-000000000304', 'Ron', true, 'Ron', 'unfair'),
  ('00000000-0000-4000-a000-000000000401', 'Sue', true, 'Sue', 'easy'),
  ('00000000-0000-4000-a000-000000000402', 'Sue', true, 'Sue', 'normal'),
  ('00000000-0000-4000-a000-000000000403', 'Sue', true, 'Sue', 'hard'),
  ('00000000-0000-4000-a000-000000000404', 'Sue', true, 'Sue', 'unfair')
ON CONFLICT (id) DO NOTHING;
