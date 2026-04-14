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

Record each run in a comparison table:

```
| Tier   | Baseline | Change 1      | Change 2       | Target |
|--------|----------|---------------|----------------|--------|
| Easy   | 0% / 40 | 0% / 37       | 0.5% / 42      | Bottom |
| Normal | 39% / 15| 46% / 13      | 41% / 14       | 3rd    |
| Hard   | 28% / 16| 24% / 18      | 29.5% / 22     | 2nd    |
| Unfair | 33% / 19| 30% / 14      | 28.5% / 17     | 1st    |
```

This format makes regressions immediately visible.

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

**Key lesson learned:** We expected 5-15% divergence for Hard/Unfair. Actual was 44-63%. Memory was changing nearly half of all decisions. This completely reframed the tuning strategy — from "memory isn't doing enough" to "memory is doing too much, is it helping?"

### Feature-Specific Diagnostics

#### Speculation Tracking

For every speculative pickup (drawing a card that doesn't immediately complete a meld):

| Field | Purpose |
|-------|---------|
| `spec_matching_cards` | How many cards in hand supported this speculation |
| `spec_contract_dimension` | Set or run — which goal does this advance |
| `spec_is_weak_dimension` | Is this the lagging dimension (for mixed contracts) |

At game end, aggregate into:

| Metric | Purpose |
|--------|---------|
| `speculative_pickups` | Total speculative draws |
| `speculative_pickups_used` | How many were eventually melded or laid off |
| Hit rate (used / total) | **The key metric.** Below 30% = speculation is net negative |

**Key lesson learned:** Normal speculated 285 times with 38% hit rate. Unfair speculated 12 times with 17% hit rate. A probability gate was effectively disabling speculation for the "smartest" tier. The "dumb" tier was playing better because it speculated more freely.

#### Feed Strategy Tracking

For every deliberate discard intended to create a lay-off opportunity:

| Field | Purpose |
|-------|---------|
| `feed_target_opponent` | Who is being fed |
| `feed_card_value` | What's being discarded to trigger their meld |
| `feed_layoff_card_held` | What the AI plans to lay off afterward |

At game end: `feed_attempts` vs `feed_payoffs` and hit rate.

**Key lesson learned:** Feed strategy had 36% payoff rate in run-heavy rounds over 266 attempts — far above the 10% viability threshold. The feature works. But it couldn't compensate for the speculation gate killing pre-contract play.

#### Defensive Play Tracking

For every card held specifically to avoid feeding an opponent:

| Field | Purpose |
|-------|---------|
| `table_awareness_cards_held` | Cards kept because of defensive penalty |
| `table_awareness_deadwood_cost` | Point value of those cards |

**Key lesson learned:** All tiers were paying 20-30 points per game for defensive play. A flat +40 penalty was too expensive in run rounds where the lay-off surface is narrow. The defense was costing more than the offense it prevented.

#### Post-Contract Shedding

| Field | Purpose |
|-------|---------|
| `turns_post_contract` | Turns between meeting contract and round end |
| `post_contract_pickups` | Speculative draws after contract (should be 0 if disabled) |
| `max_hand_size` | Peak hand size during round — detects bloat |

**Key lesson learned:** Post-contract speculation (drawing extra cards hoping for lay-offs) caused hand bloat. Disabling it for run-heavy rounds was confirmed working by `post_contract_pickups: 0` in diagnostics.

---

## Part 4: Lessons Learned (Contract Rummy Specific, Generalizable Patterns)

### 1. Conservative Play Can Beat Smart Play

**The finding:** Normal (30% mistake rate, no advanced features) consistently beat Hard and Unfair in run-building rounds. Its "stupidity" — drawing from deck instead of speculating, maintaining steady 1-for-1 hand reduction — was accidentally optimal.

**The general principle:** More features ≠ better play. Every "smart" feature has a cost (hand bloat, defensive deadwood, speculation misses). If the cost exceeds the benefit in a given context, the feature should be disabled for that context via the profile system.

**How to detect this:** If a lower-difficulty tier consistently beats a higher one in specific contexts, the higher tier's extra features are backfiring. Don't nerf the lower tier — fix the higher tier's feature gating.

### 2. Features Need Context-Specific Kill Switches

**The finding:** Post-contract speculation helps in set-heavy rounds (high hit rate on same-value pickups) but hurts in run-heavy rounds (low hit rate, hand bloat). The same feature is good in one context and bad in another.

**The general principle:** Every AI feature should have a round/context profile toggle. `disablePostContractSpec`, `disableDeckProbabilityGate`, `minSpeculativeRunMatch` — these let you keep features where they help and kill them where they hurt.

**Implementation pattern:**
```
EffectiveProfile = merge(baseTierProfile, contextProfile)
if (effectiveProfile.disableFeatureX) skip featureX
```

### 3. Probability Gates Can Kill Features Silently

**The finding:** Unfair's deck probability gate (requiring P(helpful card) > 25% before speculating) was reasonable math but terrible in practice. In a 2-deck game with many helpful adjacent cards, the threshold was rarely met because the calculation was too conservative. Unfair speculated 12 times vs Normal's 285.

**The general principle:** Any quality gate that reduces a feature's activation by >80% compared to a tier without the gate is effectively a kill switch. Monitor activation rates, not just outcomes.

**How to detect this:** Log how often each feature activates per game. If a "smarter" tier activates a feature less often than a "dumber" tier, the quality gate is too tight.

### 4. Measure the Cost of Defense

**The finding:** Table awareness (+40 penalty for cards that could feed opponent melds) cost all tiers 20-30 points of deadwood per game. In run rounds, where lay-off opportunities are narrow (specific suit + adjacent value), the AI was holding expensive cards to prevent lay-offs that rarely would have happened.

**The general principle:** Every defensive feature has a deadwood cost. Track it explicitly. If the cost exceeds 15-20% of the tier's average final score, the defense is too expensive.

**Tuning approach:** Make defensive penalties proportional to context. Flat penalties (+40 always) are lazy. Proportional penalties (scaled by how likely the opponent is to actually benefit) are accurate. In run rounds, the lay-off probability is lower, so the penalty should be lower.

### 5. Group Contexts by Type, Don't Tune Each Individually

**The finding:** Rounds fall into three categories: set-heavy (R1, R4), run-heavy (R3, R6, R7), and mixed (R2, R5, R6). Once you tune one representative from each category, the others inherit the profile with a 50-game sanity check.

**The general principle:** If your game has 20 levels, don't tune all 20 individually. Identify 3-4 archetype categories, tune one per category deeply, and apply the profile to the rest. Save thousands of test games.

**Efficient run budget:**
```
1 deeply-tuned representative per category:  200 games
Sanity checks on remaining contexts:          50 games each
Full end-to-end validation:                  100-200 games
```

### 6. Contract Speed Beats Shedding Speed

**The finding:** After fixing Unfair's speculation rate (0.06/game → 2.5/game, then 1.47/game at 31% hit rate), Unfair had the best shedding rate (0.29 cards/turn vs Normal's 0.25) but still lost because it met contract 2.5 turns slower than Normal (23.3 vs 20.8). Speculation with a 31% hit rate means 69% of pickups are dead cards that cost a turn each to discard.

**The general principle:** In race-style games, the bottleneck is reaching the goal state, not what happens after. Optimizing post-goal performance is wasted effort if another player reaches the goal first. Measure time-to-goal separately from post-goal efficiency.

**The diagnostic that caught it:** `AvgTTC` (average turns to contract) was never a headline metric in early tuning — we focused on win rates, speculation hit rates, and shedding speed. Once we added it to the enriched summary, the 2.5-turn gap was immediately visible and explained why Unfair was losing despite better post-contract play.

**The fix pattern:** Don't increase speculation volume. Increase speculation *selectivity*. A perfect player should take fewer risks than a good player, not more — it should know which risks aren't worth taking. `minSpeculativeMatch: 2` makes Unfair only speculate with strong evidence (2+ matching cards), which reduced dead pickups and closed the contract speed gap.

**General lesson:** More features and looser gates don't make a tier stronger. The strongest play is often the most selective — knowing which opportunities to ignore is as important as knowing which to take.

### 7. The Real Test Is End-to-End

**The finding:** Individual round win rates don't predict game-level dominance. A tier that wins 35% of individual rounds can win 60% of full games through consistency — never having a catastrophic round.

**The general principle:** Per-context testing is for tuning. End-to-end testing is for validation. Don't skip the full-game run at the end. Average score across all contexts matters more than any single context's win rate.

### 8. Randomness Can Be Strategically Optimal

**The finding:** After fixing every identified mechanical problem (speculation rate, contract speed, hit rate, shedding), Unfair had the best avg score (16), best consistency (stdDev 21.2), best hit rate (56%), and matched Normal's contract speed (20.5 turns). But Normal still won 42.5% vs Unfair's 26.5%. Normal's 30% mistake rate creates unpredictable discard patterns that opponents can't exploit, while Unfair's perfect play is consistent enough to be predictable.

**The general principle:** In games with opponent interaction, perfect deterministic play can be *exploitable* because opponents can infer your strategy. Some controlled randomness (game theory's "mixed strategies") can outperform optimal play. This is well-established in poker, rock-paper-scissors, and competitive game theory — the Nash equilibrium often involves deliberate randomization.

**What this means for tiered AI:** There may be a ceiling on how much a zero-mistake-rate tier can dominate in games with opponent interaction. The tier ordering you want (Unfair > Hard > Normal > Easy) may need to come from advantages other than pure decision quality — advantages like consistency across rounds, which only manifests in full-game testing. Alternatively, Unfair might need a deliberate "noise injection" feature that occasionally makes suboptimal-but-unpredictable plays.

**When to stop tuning a single context:** When you've fixed all mechanical problems, verified through diagnostics that every feature is working correctly, and the tier still doesn't separate — the remaining gap may be structural. Move to end-to-end testing to see if consistency compounds into game-level dominance before investing more single-context tuning.

### 9. Uniform Constraints Help Weaker Tiers More

**The finding:** Applying `minSpeculativeRunMatch: 2` to all tiers equally caused Hard to jump from 25% → 31% (biggest gainer) while Unfair dropped from 29% → 26.5%. The tighter gate reduced total speculation for everyone, but Hard benefited because with fewer speculative decisions to make, its 10% mistake rate had fewer chances to cause damage. The gate effectively diluted Hard's weaknesses.

**The general principle:** When you apply a constraint that reduces the number of decisions an AI makes, the tier with the highest error rate on those decisions benefits most — there are fewer opportunities to fail. Conversely, the tier with 0% error rate gains nothing from having fewer decisions since it wasn't failing anyway.

**Implication for tier-specific tuning:** If a gate or constraint is meant to help the strongest tier, consider applying it ONLY to that tier via the profile system rather than across the board. Uniform constraints flatten the tier curve. Targeted constraints preserve or widen it.

**Validation pattern:** When your worst tier fails in exactly the way its profile predicts (Easy's negative shed rate from 50% mistakes + 15% lay-off detection = gaining cards post-contract), that's confirmation the system is working as designed. Log these as positive validation, not bugs.

---

## Part 5: Tuning Workflow (Reusable)

### Phase 1: Baseline (per context category)

1. Run 200 games with all tiers, diagnostics active
2. Record: win rates, avg scores, diagnostic aggregates
3. Verify tier ordering matches intent
4. If tiers don't separate → check `mistakeRate` first (biggest lever)

### Phase 2: Diagnose Before Tuning

Before changing any knobs, answer these questions from diagnostic data:

```
□ What is the divergence rate per tier?
  → If < 5%: smart features aren't influencing play
  → If > 50%: smart features are dominant — are they helping?

□ What is the speculation hit rate per tier?
  → If < 30%: speculation is net negative, tighten or disable

□ What is the contract speed (AvgTTC) per tier?
  → If a "smarter" tier meets contract SLOWER than a simpler tier,
    speculation is costing tempo. Tighten selectivity, don't increase volume.

□ What is the defensive deadwood cost per tier?
  → If > 20% of avg score: defense is too expensive

□ What is the post-action bloat (max hand size vs Normal)?
  → If 2+ cards higher: features are causing bloat

□ What is the shedding rate post-contract?
  → Higher is better, but meaningless if contract speed is slow

□ Which feature has the highest payoff rate?
  → Double down on what works, kill what doesn't
```

### Phase 3: Targeted Tuning

1. Change ONE knob based on diagnostic findings
2. Run 200 games with diagnostics
3. Compare to previous run in the tracking table
4. Verify the intended metric moved (not just win rates)
5. Check for regressions in other metrics
6. Repeat until tier ordering matches target

### Phase 4: Context Transfer

1. Apply tuned profiles to related contexts (same category)
2. Run 50-game sanity check per context
3. If tier ordering holds → move on
4. If a context breaks ordering → it may need its own profile (rare)

### Phase 5: End-to-End Validation

1. Run 100-200 full games (all contexts in sequence)
2. Measure game-level win rates and total scores
3. Verify consistency advantage shows up (smart tiers should have lower score variance)
4. This is the final gate before shipping

---

## Part 6: Knob Reference (Ranked by Impact)

Ordered by observed impact during Contract Rummy tuning. Applicability column indicates whether the knob is game-specific or generalizable.

| Rank | Knob | Impact | Applicability |
|------|------|--------|---------------|
| 1 | `mistakeRate` | Biggest single lever on win rate | Universal — any tiered AI |
| 2 | `speculativePickups` + gates | Controls risk-taking quality | Any game with incomplete info |
| 3 | `disableFeatureX` per context | Prevents features from backfiring | Universal |
| 4 | `minSpeculativeRunMatch` | Selectivity gate per context type — prevents tempo loss from low-hit-rate speculation | Any game with context-dependent risk profiles |
| 5 | `detectionRate` | Controls how many opportunities are "seen" | Any game with optional actions |
| 6 | `memoryDepth` | How much history influences decisions | Any game with hidden info |
| 7 | `defensivePenalty` | Cost of preventing opponent benefit | Any competitive game |
| 8 | `urgentMistakeRate` | Comeback mechanic when behind | Any scored game |
| 9 | `feedStrategy` | Manufacturing opportunities via opponent — 36-38% payoff in run rounds, viable but not dominant | Games with shared play surfaces |
| 10 | `contextRelevanceWeights` | Strategic focus per context | Any game with varying objectives |
| 11 | `deckProbabilityGate` | Mathematical quality filter — confirmed to silently kill features when too restrictive, disable per context rather than tune | Card/resource games |

---

## Part 7: Anti-Patterns

Things that wasted time or produced misleading results:

**Tuning without diagnostics.** Three tuning runs on Round 3 moved knobs based on win rates alone. Two of them made things worse. The diagnostic run immediately identified the actual problem (probability gate killing speculation). Always instrument before tuning.

**Nerfing the wrong tier.** When Normal beat Unfair, the instinct was to raise Normal's mistake rate in run rounds. The real fix was making Unfair's features work properly. Don't weaken lower tiers to create separation — strengthen higher tiers.

**Changing multiple knobs per run.** Early runs changed thresholds AND added features simultaneously. When results were mixed, it was impossible to attribute improvement or regression to either change.

**100-game runs for close tiers.** At ±8-10 points confidence interval, 100 games can't distinguish a 28% tier from a 33% tier. Use 200 minimum for active tuning.

**Assuming features help because they're smart.** Card memory, opponent modeling, feed strategy — these sound like they should help. But every feature has a cost. Measure the cost explicitly (deadwood held, hand bloat, speculation misses) and compare it to the benefit.

**Tuning every context individually.** Seven rounds × multiple tuning runs × 200 games each = thousands of games and dozens of hours. Group by category, tune one, transfer to the rest.

**Optimizing post-goal performance instead of goal speed.** Three tuning rounds focused on shedding speed and post-contract play. Unfair achieved the best shed rate (0.29 cards/turn) but still lost because it met contract 2.5 turns slower than Normal. The bottleneck was contract speed, not shedding. Always check time-to-goal before optimizing anything downstream of it.

**Loosening gates when tightening is the answer.** The instinct when a smart tier underperforms is to give it more freedom — disable gates, lower thresholds, let it speculate more. But the `disableDeckProbabilityGate` fix increased speculation from 12 to 294 pickups and Unfair *still* didn't win because 69% of those pickups were dead cards. The correct fix was increasing *selectivity* (minSpec: 2), not volume. A perfect player should take fewer risks than a good player, not more.

**Confusing feature activation with feature value.** After disabling the probability gate, Unfair's speculation jumped 40x. That looked like success. But the metric that mattered wasn't how often Unfair speculated — it was how speculation affected contract speed. More activation ≠ more value. Always trace activation through to the outcome metric that matters.

**Over-tuning a single context past the point of mechanical fixes.** Four tuning runs on R3 fixed every measurable problem: speculation rate, contract speed, hit rate, shedding. Unfair had the best avg score and consistency. But Normal still won on win rate. The remaining gap was structural (randomness as strategy), not a knob to turn. The right move was to stop R3 tuning and move to full-game testing where Unfair's consistency advantage compounds across 7 rounds. Every additional R3 tuning run after the mechanical fixes were confirmed would have been wasted time.

---

## Part 8: Tuning History (Data Reference)

### R1 Results (locked in)

| Tier | Win% | Avg Score |
|------|------|-----------|
| Easy | 1% | 32 |
| Normal | 54% | 8 |
| Hard | 18% | 15 |
| Unfair | 26% | 19 |

Normal dominates sets-only rounds. Feed strategy has narrow impact (lay-off surface is 1 value per meld). Order: Normal > Unfair > Hard > Easy.

### R3 Tuning Progression

| Tier | Baseline (100g) | Step 1: revert threshold (100g) | Step 2: +diag, noPostSpec (200g) | Step 3: noDeckGate (200g) | Step 4: minRunSpec:2 (200g) | Target |
|------|-----------------|--------------------------------|----------------------------------|--------------------------|---------------------------|--------|
| Easy | 0% / 40 | 0% / 37 | 0.5% / 42 | 1.0% / 38 | 0.0% / 41 | Bottom |
| Normal | 39% / 15 | 46% / 13 | 41% / 14 | 44.5% / 14 | 42.5% / 14 | 3rd |
| Hard | 28% / 16 | 24% / 18 | 29.5% / 22 | 25.0% / 19 | 31.0% / 17 | 2nd |
| Unfair | 33% / 19 | 30% / 14 | 28.5% / 17 | 29.0% / 18 | 26.5% / 16 | 1st |

Current order: Normal (42.5) > Hard (31) > Unfair (26.5) > Easy (0). Target not yet met.
Hard overtook Unfair — the `minSpecRunMatch: 2` gate affected all tiers but Hard benefited most.

### R3 Step 4 Diagnostic Detail (200 games, `minSpeculativeRunMatch: 2`)

**Speculation — selectivity worked, hit rates soared:**
| Tier | Pickups (Step 3 → 4) | Hit Rate (Step 3 → 4) |
|------|---------------------|----------------------|
| Normal | 245 → 36 | 29% → 39% |
| Hard | 262 → 28 | 31% → 50% |
| Unfair | 294 → 41 | 31% → 56% |

Tighter gate drastically improved quality. Unfair hit rate nearly doubled.

**Contract speed — fixed:**
| Tier | AvgTTC (Step 3 → 4) |
|------|---------------------|
| Normal | 20.8 → 20.5 |
| Hard | 22.1 → 21.1 |
| Unfair | 23.3 → 20.6 |

Unfair's contract speed now matches Normal. The tempo problem is solved.

**Consistency — Unfair is most consistent:**
| Tier | StdDev (Step 3 → 4) | Avg Score (Step 3 → 4) |
|------|---------------------|----------------------|
| Normal | 24.6 → 24.6 | 14 → 14 |
| Hard | 24.6 → 24.7 | 19 → 17 |
| Unfair | 24.9 → 21.2 | 18 → 16 |

Unfair has lowest score variance AND best average score of the smart tiers.

**Feed strategy — still viable:**
| Tier | Attempts | Payoffs | Hit Rate |
|------|----------|---------|----------|
| Unfair | 208 | 71 | 34.1% |

### R3 Key Findings (cumulative, updated)

1. Conservative play beats clever play in runs — Normal wins by not overthinking
2. Post-contract speculation causes hand bloat — disabled via `disablePostContractSpec`
3. Deck probability gate silently killed Unfair speculation — disabled via `disableDeckProbabilityGate`
4. Speculation volume without selectivity costs tempo — fixed via `minSpeculativeRunMatch: 2`
5. Feed strategy works at 34-41% payoff rate — viable feature, not the bottleneck
6. Table awareness costs 22-34 pts/game — significant but not the current lever
7. Contract speed fixed — Unfair now matches Normal at ~20.5 turns
8. **Hit rate correlates with quality, not volume** — tightening speculation from 294 → 41 pickups raised hit rate from 31% → 56%
9. **Unfair has best consistency (stdDev 21.2) and best avg score (16)** — the game-level advantage predicted by the playbook
10. **Normal's 30% mistake rate may be structurally beneficial in runs** — unpredictable discard patterns make it harder for opponents to exploit. This is not a bug to fix — it may be a fundamental property of the game

### R3 Current State

All mechanical problems are solved:
- ✅ Speculation rate — recovered from near-zero to viable
- ✅ Contract speed — Unfair matches Normal
- ✅ Speculation quality — 56% hit rate, best of all tiers
- ✅ Score consistency — lowest stdDev
- ✅ Average score — best of smart tiers

But Normal still wins at 42.5%. The remaining gap appears structural, not tunable:
- Normal's 30% mistake rate creates discard diversity that other players can't predict or exploit
- Unfair's perfect play is *exploitable* — opponents can infer its strategy from its consistent patterns
- This may be an inherent property of card games: some randomness in play is strategically optimal (mixed strategies in game theory)

### R3 Decision Point

Options:
1. **Accept current R3 ordering** — Normal > Hard > Unfair > Easy. Move to other rounds and trust that full-game consistency (stdDev 21.2) will make Unfair the game-level winner
2. **Reduce Normal's advantage** — lower Normal's layOffDetection from 70% (less shedding ability) or raise its mistake rate for R3
3. **Give Unfair a structural advantage** — explore whether Unfair should deliberately introduce discard randomness (anti-exploitation noise) in run-heavy rounds

### Tier Cascade Strategy

Once Unfair is dialed in as the ceiling, Hard and Normal are just degraded versions:
- Hard = Unfair + 10% mistakes + memory decay + no feed strategy override
- Normal = Unfair + 30% mistakes + strict speculation + shallow memory
- Easy = barely trying

Tune Unfair first. Then verify degradation produces correct tier separation. Don't tune each tier independently.
