# AI Training Harness

## What It Does
Runs headless Contract Rummy games using the same game engine and AI strategy as production. Creates real games via SQL RPCs, plays AI turns in a tight loop with no timing delays, logs results to training tables. Used to tune AI tier behavior without manually playing every game.

## Prerequisites
- Docker Desktop (for local Supabase)
- Deno runtime
- Supabase CLI (`npx supabase`)

## Local Setup

```bash
# 1. Start local Supabase (first time pulls images ~2 min)
supabase start

# 2. Apply schema + seed data
supabase db reset

# 3. Create trainer account
bash supabase/functions/_training/setup-local.sh

# 4. Run a test game
cd supabase/functions/_training
export $(grep -v '^#' .env.local | xargs)
deno run --allow-net --allow-env --allow-read train.ts --games 1 --seats "LuVerne:easy,Jeanne:hard"
```

After a `supabase db reset`, always re-run `setup-local.sh` to recreate the trainer account.

## CLI Usage

```bash
deno run --allow-net --allow-env --allow-read train.ts [options]

Options:
  --label <name>       Run label (default: training_<timestamp>)
  --games <n>          Number of games (default: 10)
  --round <1-7>        Which round to play (default: 1)
  --seats <config>     "Name:tier,Name:tier,..." (default: all 4 tiers)
  --jokers <n>         Jokers per deck (default: 0)
  --max-buys <n|none>  Max buys per round (default: 3)
  --log-decisions      Log every decision (verbose)
  --help               Show help
```

### Examples
```bash
# Quick 2-player test
--games 1 --seats "LuVerne:easy,Jeanne:hard"

# 100-game baseline, all 4 tiers
--games 100 --label "baseline_r1" --seats "LuVerne:easy,Jeanne:normal,Ron:hard,Sue:unfair"

# Test easy vs unfair head-to-head
--games 200 --label "easy_vs_unfair" --seats "LuVerne:easy,Sue:unfair"

# Run round 3 (pure runs)
--games 100 --round 3 --label "round3_baseline"
```

## Performance
- **Local Supabase**: ~8-10s per game (2 players), ~30s per game (4 players)
- **Hosted Supabase**: ~200s per game (network latency)
- 100-game run (4 players): ~50 min local, ~5.5 hours hosted

## Architecture

```
supabase/functions/_training/
  train.ts          — Entry point, CLI parsing, batch orchestration
  game-loop.ts      — Single game: create → seat AI → deal → turn loop → results
  state-reader.ts   — Reads game state from tables, builds TurnContext
  buy-evaluator.ts  — Synchronous buy scoring (no delays)
  logger.ts         — Writes to training_runs/games/decisions tables
  config.ts         — Types, defaults, CLI arg parsing
  setup-local.sh    — Creates trainer account after db reset
  .env.example      — Environment variable template
  .env.local        — Local Supabase keys (gitignored)
  .env              — Hosted Supabase keys (gitignored)
```

**Key design rule:** Zero new game logic. The harness uses the same RPCs as the real game client. If it's not in the existing SQL functions, it doesn't exist in training.

## Training Tables

- `training_runs` — batch config, status, summary stats
- `training_games` — per-game results (winner, scores, turns, deck order for replay)
- `training_decisions` — per-action log (draw/meld/layoff/discard/buy with context)

Query results:
```sql
-- Win rates by tier
SELECT winner_tier, count(*) as wins
FROM training_games WHERE run_id = '<run-id>'
GROUP BY winner_tier ORDER BY wins DESC;

-- Average scores
SELECT seat->>'ai_tier' as tier, avg((seat->>'final_score')::int) as avg_score
FROM training_games, jsonb_array_elements(player_seats) as seat
WHERE run_id = '<run-id>'
GROUP BY tier;
```

## Tuning Workflow

### Two layers of tuning

1. **Tier profiles** (`tiers.ts`) — base behavior per difficulty level
   - `mistakeRate`, `layOffDetection`, `speculativePickups`, etc.
   - Same across all rounds

2. **Round profiles** (`round-profiles.ts`) — per-round modifiers on top of tiers
   - `setRelevanceWeight`, `runRelevanceWeight`, `isolationPenalty`
   - `speculativeThresholdAdjust`, `buyThresholdAdjust`, `missContractMultiplier`
   - Applied via `resolveProfile(tier, roundNumber)` → `EffectiveProfile`

### Run cadence

| Phase | Games | Purpose |
|-------|-------|---------|
| Baseline | 100 | Verify tiers separate (unfair > hard > normal > easy) |
| Tuning | 200-500 | Adjust 1-2 knobs → re-run → compare |
| Validation | 1000 | Confirm separation holds at scale |

### What to check
- Win rates separate? unfair > hard > normal > easy
- Score gaps reasonable? Easy shouldn't be too terrible
- Specific behaviors working? Easy missing contracts, hard catching lay-offs

### Knobs ranked by impact

| Knob | File | Effect |
|------|------|--------|
| `mistakeRate` | tiers.ts | Biggest lever on win rate |
| `urgentMistakeRate` | tiers.ts | Comeback ability when behind |
| `layOffDetection` | tiers.ts | How fast they shed cards after contract |
| `speculativePickups` | tiers.ts | Draw quality |
| `setRelevanceWeight` | round-profiles.ts | Set vs run focus per round |
| `runRelevanceWeight` | round-profiles.ts | Set vs run focus per round |
| `isolationPenalty` | round-profiles.ts | Lone high card discard priority |
| `buyThresholdAdjust` | round-profiles.ts | Buy aggressiveness per round |
| `missContractMultiplier` | round-profiles.ts | Contract awareness scaling |

### Tuning recipe
1. Baseline 100 games, all 4 tiers, round 1
2. If tiers don't separate: check `mistakeRate` first
3. If Easy wins too much: raise `mistakeRate` or enable `canMissContract`
4. If Hard ≈ Unfair: lower Hard's `layOffDetection`
5. After each tweak: 200-game run to verify
6. Repeat for rounds 2-7 adjusting round profiles
7. Final validation: 1000-game run per round
