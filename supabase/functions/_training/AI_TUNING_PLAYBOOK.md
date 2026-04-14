# AI Tuning Playbook — Lessons from Contract Rummy

## What This Document Is

A reusable reference for tuning rule-based AI difficulty tiers using statistical testing and diagnostic instrumentation. Written during the play27 Contract Rummy project but designed to apply to any game AI that uses tiered difficulty with tunable knobs instead of machine learning.

The core insight: **don't guess, measure. Instrument your decisions, run statistically meaningful samples, and let the data tell you which knobs matter.**

---

## Part 1: The Architecture That Makes Tuning Possible

### Two-Layer Profile System

Separate what stays constant across contexts from what varies:

**Base tier profiles** — define the identity of each difficulty level. These don't change per round/level/scenario.

| Attribute | Purpose | Example Values |
|-----------|---------|----------------|
| `mistakeRate` | % of decisions that are intentionally suboptimal | Easy: 50%, Normal: 30%, Hard: 10%, Unfair: 0% |
| `detectionRate` | % of opportunities the AI "notices" | Easy: 15%, Hard: 100% |
| `memoryDepth` | How much past state the AI remembers | Easy: 0, Normal: 5, Hard: 20, Unfair: ∞ |
| `speculativePickups` | Whether AI takes risky actions for future payoff | Easy: no, Normal: yes (strict), Hard: yes (loose) |

**Context profiles** — per-round/per-level/per-scenario modifiers layered on top of base tiers.

| Attribute | Purpose | Example |
|-----------|---------|---------|
| `speculativeThresholdAdjust` | Tighten/loosen speculation per context | Runs: looser, Sets: tighter |
| `disablePostContractSpec` | Kill a feature in contexts where it backfires | true for run-heavy rounds |
| `disableDeckProbabilityGate` | Remove a quality filter that's too restrictive | true for run-heavy rounds |
| `minSpeculativeRunMatch` | Selectivity gate for run speculation | 2 for run-heavy rounds |
| `relevanceWeights` | Shift strategic focus per context | R1: sets 1.0 / runs 0.0 |

**Resolver** merges tier + context into an `EffectiveProfile` for each decision. This is the single point where all configuration converges.

### Why This Matters for Tuning

You can change a tier knob and see its effect across ALL contexts, or change a context knob and see its effect across ALL tiers. Never both at once — that's the cardinal rule.

---

## Part 2: Statistical Methodology

### Sample Sizes and Confidence

| Games | Win Rate CI (±) | Good For |
|-------|----------------|----------|
| 50 | ±12-14 pts | Sanity check (does it crash, are tiers roughly ordered) |
| 100 | ±8-10 pts | Spotting big swings (10+ point changes between runs) |
| 200 | ±6-7 pts | Primary tuning runs. Can distinguish 30% from 40% |
| 500 | ±4-5 pts | Separating tiers that are 5-8 points apart |
| 1000 | ±3 pts | Final validation only. Expensive, save for end |

**Rule of thumb:** Use 200-game runs for active tuning. Use 50-game runs for sanity checks on rounds you're not actively tuning. Save 500+ for validation.

### What to Measure

Win rates alone are insufficient. A tier can have a good win rate for bad reasons (lucky deals) or a bad win rate despite correct play (variance). Track these per tier per game:

| Metric | What It Tells You |
|--------|-------------------|
| Win rate | Obvious, but noisy at small samples |
| Average score | More stable than win rate — a tier's floor matters as much as its ceiling |
| Turns to contract | How fast the AI builds toward its goal |
| Turns post-contract | How fast it sheds afterward — often the real differentiator |
| Max hand size | Detects bloat from over-speculation |
| Hand size at round end | What you're holding when someone else wins |

### Change One Thing at a Time

Every tuning run should change exactly ONE variable from the previous run. If you change two things and results improve, you don't know which one helped. If results get worse, you don't know which one hurt.

---

## Part 3: Diagnostic Instrumentation

### The Problem Diagnostics Solve

Without instrumentation, tuning is: change knob → run 200 games → look at win rates → guess why. With instrumentation, tuning is: change knob → run 200 games → see exactly which decisions changed → know why.

### The Baseline Test

For every decision where "smart" features (memory, opponent modeling, speculation) could influence the outcome, compute two scores:

1. **Actual decision** — with all features active
2. **Baseline decision** — with memory, opponent model, table awareness, and feed strategy disabled

Log whether they diverge. The **divergence rate** is your headline diagnostic number.

| Divergence Rate | Interpretation |
|-----------------|----------------|
| < 5% | Feature is decoration. Not influencing play. |
| 5-20% | Feature is a secondary factor. May or may not justify its complexity. |
| 20-50% | Feature is a primary driver. Worth optimizing carefully. |
| > 50% | Feature is dominant. If results are bad, THIS is probably why. |

### Feature-Specific Diagnostics

#### Speculation Tracking
- `speculative_pickups` / `speculative_pickups_used` → hit rate
- Below 30% = speculation is net negative
- Key finding: tightening from 294 → 41 pickups raised hit rate from 31% → 56%

#### Feed Strategy Tracking
- `feed_attempts` / `feed_payoffs` → payoff rate
- 34-41% payoff in run rounds — viable but not dominant

#### Defensive Play Tracking
- `table_awareness_deadwood_cost` — 20-34 pts/game across tiers
- Significant cost, not yet the lever to pull

#### Post-Contract Shedding
- `turns_post_contract`, `post_contract_pickups`, `max_hand_size`
- `cards_shed_post_contract`, `post_contract_shed_rate`

---

## Part 4: Lessons Learned

### 1. Conservative Play Can Beat Smart Play
More features ≠ better play. Normal (30% mistake rate, no advanced features) consistently beat Unfair in run-building rounds because it avoided speculation costs entirely.

### 2. Features Need Context-Specific Kill Switches
Post-contract speculation helps in set-heavy rounds but hurts in run-heavy rounds. Every feature needs a round profile toggle.

### 3. Probability Gates Can Kill Features Silently
Any quality gate that reduces a feature's activation by >80% vs a tier without the gate is effectively a kill switch. Monitor activation rates.

### 4. Measure the Cost of Defense
Table awareness cost 20-30 pts/game. Track defensive deadwood explicitly. If cost exceeds 15-20% of avg score, defense is too expensive.

### 5. Group Contexts by Type, Don't Tune Each Individually
Set-heavy (R1, R4), run-heavy (R3, R6, R7), mixed (R2, R5). Tune one per category, transfer to rest.

### 6. Contract Speed Beats Shedding Speed
In race-style games, the bottleneck is reaching the goal state, not what happens after. Unfair had best shedding rate but met contract 2.5 turns slower — that's what determined winners.

### 7. The Real Test Is End-to-End
Individual round win rates don't predict game-level dominance. Per-context testing is for tuning. End-to-end testing is for validation.

### 8. Randomness Can Be Strategically Optimal
After fixing every mechanical problem, Unfair had best avg score (16), best consistency (stdDev 21.2), best hit rate (56%), and matched Normal's contract speed. But Normal still won 42.5% vs Unfair's 26.5%. Normal's 30% mistake rate creates unpredictable discard patterns that opponents can't exploit, while Unfair's perfect play is consistent enough to be predictable.

In games with opponent interaction, perfect deterministic play can be *exploitable*. Some controlled randomness (game theory's "mixed strategies") can outperform optimal play. The tier ordering may need to come from consistency across rounds (full-game advantage) rather than single-round dominance.

**When to stop tuning a single context:** When all mechanical problems are fixed, all features verified working, and the tier still doesn't separate — the remaining gap may be structural. Move to end-to-end testing.

---

## Part 5: Tuning Workflow (Reusable)

### Phase 1: Baseline — 200 games with --diagnostics
### Phase 2: Diagnose — check divergence, speculation hit rate, contract speed, defense cost, bloat, shedding rate
### Phase 3: Targeted Tuning — ONE knob per run, 200 games, compare tracking table
### Phase 4: Context Transfer — apply to same-category rounds, 50-game sanity check
### Phase 5: End-to-End Validation — 100-200 full games, game-level win rates

---

## Part 6: Knob Reference (Ranked by Impact)

| Rank | Knob | Impact | Applicability |
|------|------|--------|---------------|
| 1 | `mistakeRate` | Biggest single lever on win rate | Universal |
| 2 | `speculativePickups` + gates | Controls risk-taking quality | Incomplete info games |
| 3 | `disableFeatureX` per context | Prevents features from backfiring | Universal |
| 4 | `minSpeculativeRunMatch` | Selectivity gate — prevents tempo loss | Context-dependent risk |
| 5 | `detectionRate` | Controls how many opportunities are "seen" | Optional action games |
| 6 | `memoryDepth` | How much history influences decisions | Hidden info games |
| 7 | `defensivePenalty` | Cost of preventing opponent benefit | Competitive games |
| 8 | `urgentMistakeRate` | Comeback mechanic when behind | Scored games |
| 9 | `feedStrategy` | Manufacturing opportunities via opponent | Shared play surfaces |
| 10 | `contextRelevanceWeights` | Strategic focus per context | Varying objectives |
| 11 | `deckProbabilityGate` | Mathematical quality filter — disable per context rather than tune | Card/resource games |

---

## Part 7: Anti-Patterns

- **Tuning without diagnostics.** Always instrument before tuning.
- **Nerfing the wrong tier.** Don't weaken lower tiers — strengthen higher tiers.
- **Changing multiple knobs per run.** Can't attribute improvement or regression.
- **100-game runs for close tiers.** Use 200 minimum for active tuning.
- **Assuming features help because they're smart.** Measure cost explicitly.
- **Tuning every context individually.** Group by category, tune one, transfer.
- **Optimizing post-goal instead of goal speed.** Check time-to-goal first.
- **Loosening gates when tightening is the answer.** More activation ≠ more value. Selectivity > volume.
- **Confusing feature activation with feature value.** Trace activation through to outcome metrics.
- **Over-tuning past mechanical fixes.** When all metrics are correct but win rate doesn't move, the gap is structural. Move to end-to-end testing.

---

## Part 8: Tuning History (Data Reference)

### R1 Results (locked in)
Easy 1%/32, Normal 54%/8, Hard 18%/15, Unfair 26%/19. Normal dominates sets-only.

### R3 Tuning Progression

| Tier | Baseline (100g) | Step 1 (100g) | Step 2 (200g) | Step 3 (200g) | Step 4 (200g) | Target |
|------|-----------------|---------------|---------------|---------------|---------------|--------|
| Easy | 0% / 40 | 0% / 37 | 0.5% / 42 | 1.0% / 38 | 0.0% / 41 | Bottom |
| Normal | 39% / 15 | 46% / 13 | 41% / 14 | 44.5% / 14 | 42.5% / 14 | 3rd |
| Hard | 28% / 16 | 24% / 18 | 29.5% / 22 | 25.0% / 19 | 31.0% / 17 | 2nd |
| Unfair | 33% / 19 | 30% / 14 | 28.5% / 17 | 29.0% / 18 | 26.5% / 16 | 1st |

### R3 Step 4 Key Metrics
- Spec hit rates: Normal 39%, Hard 50%, Unfair 56% (all viable)
- Contract speed: all tiers ~20.5 turns (equalized)
- Unfair stdDev 21.2 (lowest = most consistent)
- Feed payoff: 34% over 208 attempts (viable)
- All mechanical problems solved. Remaining gap is structural.

### R3 Decision Point
1. Accept R3 ordering, trust full-game consistency to separate Unfair
2. Reduce Normal's advantage (lower layOffDetection or raise mistakeRate for R3)
3. Give Unfair deliberate discard randomness (anti-exploitation noise)
