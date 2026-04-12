# Play27 Contract Rummy — AI Tier Reference

Use this document to evaluate AI play quality against expected behavior per tier. When analyzing round exports, compare each AI decision against these rules to identify correct play, intentional mistakes, and bugs.

---

## Game Rules (Apply to All Players)

- **Contract**: Each round has a required combination of sets (3+ same value) and runs (3+ consecutive same suit). Players must fulfill their contract before they can lay off cards on other melds.
- **Draw**: Each turn starts by drawing one card from the deck or the discard pile.
- **Buy**: Out-of-turn players may "buy" the top discard (take it + a penalty card from deck). Limited buys per game.
- **Discard**: Each turn ends by discarding one card.
- **Lay-offs**: After fulfilling contract, a player may add cards to any meld on the table — but NOT on the same turn they fulfilled their contract.
- **Jokers**: Wild cards. Can substitute in any set or run. Can be laid off on any meld.
- **Winning**: First player to empty their hand wins the round. Remaining players score deadwood points (face value; face cards = 10; aces = 15; jokers = 50).

---

## AI Tier Profiles

### Easy

| Attribute | Value | What It Means |
|-----------|-------|---------------|
| Mistake rate | 50% | Half of all decisions are intentionally suboptimal |
| Lay-off detection | 15% | Notices only ~1 in 7 lay-off opportunities |
| Table awareness | None | Does NOT consider opponent melds when discarding — will freely feed cards |
| Speculative pickups | No | Only takes discard if it directly completes a set or run |
| Contract weakness bias | No | No strategic focus on weaker contract dimension |
| Post-contract speculation | No | After contract met, only draws from discard for immediate lay-offs |
| Drawn/bought card protection | Hard block | Cards drawn or bought this turn are ineligible for discard |
| Buy protection duration | 3 turns | Bought cards stay protected for 3 turns after purchase |
| Can miss contract | Yes (20%) | 20% chance of "not noticing" a completable contract |
| Urgent meld override | 150 pts | If total score >= 150, always melds when possible |

**Expected behavior**: Slow, error-prone. Frequently discards useful cards, misses lay-offs, sometimes holds contract when it could meld. Should lose to competent humans consistently.

**Timing**: 1.5–3s per action, 8–12s pre-draw pause, buys late in countdown window (70–95%).

---

### Normal

| Attribute | Value | What It Means |
|-----------|-------|---------------|
| Mistake rate | 30% | ~1 in 3 decisions are suboptimal |
| Lay-off detection | 70% | Catches most lay-off opportunities |
| Table awareness | Yes | Penalizes discards that opponents could lay off on visible melds (+40 score penalty) |
| Speculative pickups | Yes (strict) | Takes discard to build partials, but only when already holding 2-of-3 |
| Min speculative match | 2 | Must already hold 2 cards of same value (or 2 adjacent same-suit) before picking up a 3rd |
| Contract weakness bias | Yes | For mixed contracts, biases speculation toward the weaker dimension (fewer sets vs runs) |
| Post-contract speculation | No | After contract met, only draws from discard for immediate lay-offs |
| Drawn/bought card protection | Hard block | Cards drawn or bought this turn are ineligible for discard |
| Buy protection duration | 3 turns | Bought cards stay protected for 3 turns after purchase |
| Can miss contract | No | Always melds when contract is met |
| Urgent meld override | 150 pts | N/A (never misses) |

**Speculative pickup rules (Normal)**:
1. Only speculates on partials that are already 2-of-3 (one card away from completing the meld)
2. For sets: must already hold 2+ cards of that value — the discard completes the set
3. For runs: must already hold 2+ adjacent same-suit cards — the discard completes the run
4. Does NOT speculate on 0→1 or 1→2 pickups (too loose, grabs everything)
5. Weaker paths: only taken if they help the weaker contract dimension (contract weakness bias)

**Expected behavior**: Competent casual player. Makes some mistakes but generally plays sensibly. Avoids obvious blunders like feeding melds. Good challenge for average humans.

**Timing**: 1–2s per action, 6–10s pre-draw pause, buys in middle of countdown (25–75%).

---

### Hard

| Attribute | Value | What It Means |
|-----------|-------|---------------|
| Mistake rate | 10% | ~1 in 10 decisions are suboptimal |
| Lay-off detection | 100% | Catches every lay-off opportunity |
| Table awareness | Yes | Penalizes feeding opponent melds (+40 score penalty) |
| Speculative pickups | Yes (quality-gated) | Takes discard to build partials — 1+ matching card qualifies |
| Min speculative match | 1 | Only needs 1 card of same value (or 1 adjacent same-suit) to speculate |
| Contract weakness bias | Yes | Biases speculation toward weaker contract dimension |
| Post-contract speculation | Yes | After contract met, also picks from discard if card completes a set (2+ same value already in hand) |
| Drawn/bought card protection | Hard block | Cards drawn or bought this turn are ineligible for discard |
| Buy protection duration | 3 turns | Bought cards stay protected for 3 turns after purchase |
| Can miss contract | No | Always melds when contract is met |
| Urgent meld override | 150 pts | N/A (never misses) |

**Post-contract draw rules (Hard/Unfair)**:
- Draws from discard if card is an immediate lay-off on any visible meld, OR
- If card matches 2+ cards of the same value already in hand (set completion potential)
- Otherwise draws from deck

**Expected behavior**: Strong player. Rarely makes mistakes. Protects drawn cards, finds all lay-offs, makes smart speculative pickups. Difficult for average humans to beat consistently.

**Timing**: 0.7–1.5s per action, 4–7s pre-draw pause, buys early in countdown (5–50%).

---

### Unfair

| Attribute | Value | What It Means |
|-----------|-------|---------------|
| Mistake rate | 0% | Every decision is optimal given available information |
| Lay-off detection | 100% | Catches every lay-off opportunity |
| Table awareness | Yes | Penalizes feeding opponent melds (+40 score penalty) |
| Speculative pickups | Yes (quality-gated) | Full quality-gated speculation — same as Hard |
| Min speculative match | 1 | Only needs 1 card of same value (or 1 adjacent same-suit) to speculate |
| Contract weakness bias | Yes | Biases speculation toward weaker contract dimension |
| Post-contract speculation | Yes | Same as Hard — picks completions and lay-offs |
| Drawn/bought card protection | Hard block | Cards drawn or bought this turn are ineligible for discard |
| Buy protection duration | 3 turns | Bought cards stay protected for 3 turns after purchase |
| Can miss contract | No | Always melds when contract is met |
| Urgent meld override | 150 pts | N/A (never misses) |

**Expected behavior**: Perfect execution within the bounds of visible information. Same strategy as Hard but with zero mistakes. Meant to be a ceiling-level opponent.

**Timing**: 0.4–1s per action, 3–5s pre-draw pause, buys very early in countdown (5–30%).

---

## Decision Logic Details

### Draw Decision (all tiers)

1. If discard pile was already bought this turn, or no discard available → draw from deck
2. If AI discarded this same card last turn → draw from deck (prevents pickup loops)
3. If AI has met contract:
   - Easy/Normal: only take discard if it's an immediate lay-off on a visible meld
   - Hard/Unfair: take if lay-off OR if 2+ same-value cards in hand
4. If card is a joker → always take it
5. If adding the card enables meeting the full contract → take it
6. If card completes a set (2+ same value in hand) → take it (with mistake chance for Easy/Normal)
7. If card completes a run (3+ consecutive same suit) → take it (with mistake chance for Easy/Normal)
8. **Speculative tiers only** (Normal/Hard/Unfair):
   - If card builds a pair or extends a run AND that partial is a top-ranked path → take it
   - If it's a weaker path but helps the weaker contract dimension → take it (contract weakness bias)
9. Otherwise → draw from deck

### Discard Decision (all tiers)

Each card in hand is scored (lower = better to discard):

| Factor | Score Impact |
|--------|-------------|
| Removing card breaks contract solution | +1000 (keep) |
| Card feeds an opponent's visible meld | +40 (keep) — only if table-aware |
| Contract relevance (completes set/run = 30, builds pair/extends = 15, joker = 50) | +relevance (keep) |
| High deadwood points | -points (discard) |
| Card was drawn/bought this turn | EXCLUDED from candidates (hard block) |
| Card was bought within last 3 turns | EXCLUDED from candidates (hard block) |

**Post-contract discard**: Cards playable as lay-offs on visible melds are also excluded from discard candidates (the AI should lay them off instead).

Mistakes modify the choice (among eligible candidates):
- Easy (50% mistake rate): picks random card from top half of ranked list
- Normal (30%): picks second-best card
- Hard (10%): picks second-best card
- Unfair (0%): always picks best card

### Contract Fulfillment

- Backtracking solver finds all valid set+run combinations meeting the round's contract
- Best solution = least remaining deadwood (point value of unused cards)
- Easy tier: 20% chance of "not noticing" they can meld (overridden if score >= 150)
- On the turn contract is fulfilled, no lay-offs are allowed (game rule, server-enforced)

### Lay-Off Decision

- Only available after contract is met AND not on the same turn as fulfillment
- Checks each hand card against every meld on the table:
  - Sets: card matches the value of the set
  - Runs: card is same suit and extends either end of the sequence
  - Jokers: can be added to any meld
- Lay-offs are sorted by point value (highest first — shed expensive cards)
- Easy tier: only 15% of opportunities are "noticed"
- Normal tier: 70% of opportunities are noticed
- Hard/Unfair: 100% noticed

### Buy Decision (ai-buy edge function)

- Evaluates discard card value vs penalty cost
- Tier determines timing within the buy countdown window
- Easy buys late (less competitive), Hard/Unfair buy early (aggressive)

---

## Evaluating Play Quality

When reviewing a round export, check each AI action against these questions:

**Draw phase**:
- Did the AI take a discard that helps its contract? (Good)
- Did the AI take a discard that doesn't help? (Bug or mistake — check tier)
- Did the AI pass on a helpful discard? (Expected for Easy at 50%, suspicious for Hard)
- Did the AI pick up its own last discard? (Bug — should never happen)

**Action phase**:
- Did the AI meld when it could? (Expected unless Easy missed at 20%)
- Did the AI lay off on the same turn as fulfilling contract? (Bug — server should block)
- Did the AI miss a lay-off? (Expected for Easy/Normal, bug for Hard/Unfair)

**Discard phase**:
- Did the AI discard a card that opponents can lay off on a visible meld? (Bug for Normal+, expected for Easy)
- Did the AI discard a card it just drew or recently bought? (Bug — hard-blocked for all tiers)
- Did the AI discard a card that breaks its own contract progress? (Mistake — check tier)
- Did the AI hold high-point deadwood when safer options existed? (Mistake — check tier)

**Overall**:
- Is the AI's mistake rate roughly matching its tier? (Easy ~50%, Normal ~30%, Hard ~10%, Unfair ~0%)
- Is the AI playing faster/slower than expected for its tier?
- Are speculative pickups quality-gated? (Normal+ should only speculate on top-ranked partials)
