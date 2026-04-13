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
