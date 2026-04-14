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

```
supabase/functions/ai-turn/
  card-memory.ts    — Tier-gated visible card tracking from game_actions
  opponent-model.ts — Per-opponent hand model with memory decay (Hard/Unfair)
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
| `speculativePickups` + gates | tiers.ts | Controls risk-taking quality |
| `disablePostContractSpec` | round-profiles.ts | Stops post-contract speculative pickups — prevents hand bloat |
| `disableDeckProbabilityGate` | round-profiles.ts | Removes P(helpful) check for speculation — prevents silent feature kill |
| `minSpeculativeRunMatch` | round-profiles.ts | Separate selectivity gate for run vs set speculation |
| `urgentMistakeRate` | tiers.ts | Comeback ability when behind |
| `layOffDetection` | tiers.ts | How fast they shed cards after contract |
| `setRelevanceWeight` | round-profiles.ts | Set vs run focus per round |
| `runRelevanceWeight` | round-profiles.ts | Set vs run focus per round |
| `isolationPenalty` | round-profiles.ts | Lone high card discard priority |
| `buyThresholdAdjust` | round-profiles.ts | Buy aggressiveness per round |
| `missContractMultiplier` | round-profiles.ts | Contract awareness scaling |
| `cardMemoryDepth` | tiers.ts | How many actions the AI remembers (0/5/20/∞) |
| `tracksOpponentPickups` | tiers.ts | Whether AI tracks what opponents grab |
| `minSpeculativeMatch` | tiers.ts | Min same-value cards needed before speculative pickup (1 or 2) |
| `feedLayOffBonus` | opponent-model.ts | Post-contract: feed cards to create lay-off opportunities |
| `buyThreshold` | buy-evaluator.ts | Per-tier buy score threshold (Easy 70, Normal 50, Hard 55, Unfair 55) |
| `gameSettings` | strategy.ts | Deck count awareness — totalPerValue = numDecks × 4 |

### Round 1 results (locked in)
- Easy 1% / avg 32, Normal 54% / avg 8, Hard 18% / avg 15, Unfair 26% / avg 19
- Normal dominates Round 1 (sets only) — low mistakes + tight hand = fast wins
- Feed strategy has narrow impact in sets-only rounds (lay-off surface is 1 value per meld)
- Expect Unfair to separate more in run-heavy rounds where lay-off surface is wider

### Round 3 tuning progression

**Baseline (100 games)**
- Easy 0% / avg 40, Normal 39% / avg 15, Hard 28% / avg 16, Unfair 33% / avg 19
- Critical bugs fixed: canLayOff ordering, chain lay-offs, --round N flag, post-contract discard

**Step 1 — revert spec threshold (100 games)**
- Easy 0% / 37, Normal 46% / 13, Hard 24% / 18, Unfair 30% / 14
- Mixed: Hard regressed, Normal pulled away

**Step 2 — disable postContractSpec + add diagnostics (200 games)**
- Easy 0.5% / 42, Normal 41% / 14, Hard 29.5% / 22, Unfair 28.5% / 17
- Confirmed post-contract speculation was causing bloat (post_contract_pickups: 0)
- Divergence rates 44-53% — memory changing ~half of all decisions
- Table awareness costing 20-30 pts/game across all tiers

**Step 3 — disableDeckProbabilityGate (200 games)**
- Easy 1% / 38, Normal 44.5% / 14, Hard 25% / 19, Unfair 29% / 18
- Unfair speculation recovered: 12 → 294 pickups, 31% hit rate
- Feed strategy: 38% payoff rate over 266 attempts (viable)
- But Unfair meets contract slowest (23.3 turns vs Normal's 20.8)
- Diagnosis: speculation costs tempo — 69% dead pickups = wasted turns

**Step 4 — minSpeculativeRunMatch: 2 (200 games)**
- Easy 0% / 41, Normal 42.5% / 14, Hard 31% / 17, Unfair 26.5% / 16
- Spec hit rates soared: Unfair 31→56%, Hard 31→50%, Normal 29→39%
- Contract speed fixed: Unfair AvgTTC 23.3→20.6 (matches Normal's 20.5)
- Unfair lowest stdDev (21.2) — most consistent player
- But Normal still dominates at 42.5%. Gate tightened all tiers equally.

**Current order: Normal (42.5) > Hard (31) > Unfair (26.5) > Easy (0)**
**Target order: Unfair > Hard > Normal > Easy**

### R3 key findings (cumulative)

1. Conservative play beats clever play in runs — Normal wins by not overthinking
2. Post-contract speculation causes hand bloat — disabled via `disablePostContractSpec`
3. Deck probability gate silently killed Unfair speculation — disabled via `disableDeckProbabilityGate`
4. Speculation volume without selectivity costs tempo — Unfair speculates most but meets contract slowest
5. Feed strategy works at 36-41% payoff rate — viable feature, not the bottleneck
6. Table awareness costs 22-34 pts/game — significant but not the current lever
7. Contract speed, not shedding speed, determines winners in run rounds
8. `minSpeculativeRunMatch: 2` fixed contract speed but tightened all tiers equally — need tier-specific approach

### R3 next step

Normal's 30% mistake rate may be accidentally optimal for run building. Explore tier-specific speculation gates or investigate whether Normal's discard diversity (from mistakes) creates an advantage that can't be matched by perfect play.

### Tuning recipe (revised with diagnostic workflow)
1. Baseline 200 games with --diagnostics, all 4 tiers
2. Check diagnostic questions BEFORE changing knobs:
   - Divergence rate per tier (< 5% = features aren't influencing, > 50% = dominant)
   - Speculation hit rate (< 30% = net negative)
   - Contract speed (AvgTTC) — if smart tier is slower, speculation costs tempo
   - Table awareness cost (> 20% of avg score = defense too expensive)
   - Shedding rate (higher = better, but meaningless if contract speed is slow)
3. Change ONE knob based on diagnostic findings
4. Run 200 games with --diagnostics
5. Compare in tracking table (win rate + avg score + diagnostic metrics)
6. Verify the intended metric moved, check for regressions
7. When round category is tuned, transfer profile to same-category rounds with 50-game sanity check
8. Final validation: 100-200 full 7-round games
