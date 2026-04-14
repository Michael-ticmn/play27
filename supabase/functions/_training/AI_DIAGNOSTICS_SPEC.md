# AI Diagnostics Spec

## Purpose

Measure whether "smart" AI features (card memory, opponent modeling, feed strategy, table awareness) actually improve outcomes. Without diagnostics, tuning is guesswork. With diagnostics, every training run answers: which features changed which decisions, and did those changes help?

## Implementation

All diagnostics live in `supabase/functions/_training/diagnostics.ts`. Enabled via `--diagnostics` CLI flag. Gated so zero overhead when disabled.

## Per-Player Counters (reset each game)

### Decision Divergence
- `decisions_total` — total decisions where smart features could influence outcome
- `decisions_diverged` — decisions where actual != baseline (no-memory, no-model)
- **Divergence rate** = diverged / total. Headline metric.

### Speculative Pickups
- `speculative_pickups` — draws that don't immediately complete a meld
- `speculative_pickups_used` — specs that were eventually melded or laid off
- **Hit rate** = used / total. Below 30% = speculation is net negative.

### Post-Contract Speculation
- `post_contract_pickups` — speculative draws after meeting contract
- `post_contract_pickups_used` — post-contract specs that paid off
- Should be 0 when `disablePostContractSpec: true` in round profile.

### Feed Strategy
- `feed_attempts` — deliberate discards intended to create lay-off opportunities
- `feed_payoffs` — feeds where the AI later laid off onto the created meld
- **Payoff rate** = payoffs / attempts. Above 10% = viable feature.

### Table Awareness
- `table_awareness_holds` — cards kept due to table meld awareness (not discarded)
- `table_awareness_deadwood_cost` — point value of those held cards
- Measured by comparing discard ranking with vs without table melds.

### Lay-Off Detection
- `layoff_opportunities_total` — lay-off chances available on table melds
- `layoff_opportunities_taken` — lay-offs the AI actually performed
- `layoff_opportunities_missed` — lay-offs available but not taken (detection failure)

### Contract Timing
- `turns_to_contract` — turn number when contract was met (0 if never met)
- `turns_post_contract` — computed at game end: totalTurns - turns_to_contract
- `hand_size_at_contract` — hand size after melding contract cards

### Hand Bloat
- `max_hand_size` — peak hand size during the round
- `hand_size_at_round_end` — hand size when round ended (updated each turn)

### Shedding Rate (computed at summary time)
- `cards_shed_post_contract` = hand_size_at_contract - hand_size_at_round_end
- `post_contract_shed_rate` = cards_shed / turns_post_contract (null if turns_post_contract == 0)

## Baseline Comparison Functions

### `baselineDrawDecision(hand, topDiscard, contractSets, contractRuns, totalPerValue)`
Re-runs `evaluateDiscardDraw` WITHOUT card memory. Returns 'deck' or 'discard'.
Used to detect whether memory changed the draw decision.

### `baselineDiscardDecision(hand, contractSets, contractRuns, hasMetContract, totalPerValue)`
Re-runs `rankDiscards` with no table melds, no memory, no table model.
Used to detect whether awareness features changed the discard decision.

### `measureTableAwarenessCost(hand, ...melds, ...memory, totalPerValue)`
Compares discard ranking with and without table melds. Returns:
- `holds` — number of cards kept due to table awareness
- `deadwoodCost` — point value of those cards

## Game-Level State

### `GameDiagnostics`
- `players: Map<seat, PlayerDiagnostics>` — per-player counters
- `feedLog: Map<seat, FeedEntry[]>` — pending feed discards awaiting payoff
- `specLog: Map<seat, SpecPickup[]>` — speculative pickups awaiting use

### Tracking Functions
- `trackSpecPickup(diag, seat, card, turnNumber, postContract)` — log a speculative pickup
- `trackFeedAttempt(diag, seat, card, turnNumber)` — log a feed discard
- `checkFeedPayoff(diag, seat, layoffCard, meldCards)` — check if lay-off matches pending feed
- `checkSpecUsed(diag, seat, usedCards)` — mark specs as used when melded/laid off
- `trackHandSize(diag, seat, handSize)` — update max and current hand size

## Run-Level Summary (in `computeSummary`)

Per tier, aggregated across all games:
- `winRate`, `avgScore`, `stdDev`, `minScore`, `maxScore`
- `contractMetRate` — from existing `met_contract` in player_seats
- `divergenceRate` — decisions_diverged / decisions_total
- `specHitRate` — speculative_pickups_used / speculative_pickups
- `feedPayoffRate` — feed_payoffs / feed_attempts
- `avgTableAwarenessCost` — total cost / num games
- `avgTurnsToContract`, `avgTurnsPostContract`
- `avgMaxHandSize`
- `layoffDetectionRate` — taken / total opportunities
- `avgShedRate` — mean of non-null per-game shed rates

## Profile Snapshot

Each training run captures the resolved `EffectiveProfile` per tier in the `config` jsonb field. This records the exact knob values that produced the results, enabling reproducibility even after round-profiles.ts changes.

## Console Output Format

```
Tier        Wins   Win%    Avg   StdD  Min   Max   Contract%
─────────── ────── ──────  ────  ────  ────  ────  ─────────

── Diagnostics ──
Tier        Diverg%  Spec   SpecHit%  Feed  FeedHit%  TblCost  AvgTTC  AvgTPC  ShedRate  MaxHand  LayOff%
─────────── ──────── ─────  ────────  ────  ────────  ───────  ──────  ──────  ────────  ───────  ───────
```

## Diagnostic Questions (check before tuning)

1. Divergence rate < 5%? → Features aren't influencing play
2. Divergence rate > 50%? → Features are dominant — are they helping?
3. Spec hit rate < 30%? → Speculation is net negative
4. Smart tier's AvgTTC > simpler tier? → Speculation costs tempo
5. Table awareness cost > 20% of avg score? → Defense too expensive
6. Max hand size 2+ cards above Normal? → Feature bloat
7. Shedding rate low but contract speed fast? → Not the bottleneck
