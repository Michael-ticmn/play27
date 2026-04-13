import { CardId, cardSuit, cardValue, isJoker, cardPoints } from '../_shared/types.ts';
import { type CardMemory, deadCount, availableCount, isValueDead, opponentWantsValue, opponentWantsSuitRun } from './card-memory.ts';
import { type TableModel, feedLayOffBonus } from './opponent-model.ts';

// ── Group cards by value (for sets) ──
export function groupByValue(cards: CardId[]): Map<number, CardId[]> {
  const groups = new Map<number, CardId[]>();
  for (const c of cards) {
    if (isJoker(c)) continue; // jokers handled separately
    const v = cardValue(c);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v)!.push(c);
  }
  return groups;
}

// ── Group cards by suit (for runs) ──
export function groupBySuit(cards: CardId[]): Map<number, CardId[]> {
  const groups = new Map<number, CardId[]>();
  for (const c of cards) {
    if (isJoker(c)) continue;
    const s = cardSuit(c);
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(c);
  }
  return groups;
}

// ── Find all possible sets from a hand (3+ cards same value) ──
export function findPossibleSets(hand: CardId[]): { cards: CardId[]; value: number }[] {
  const jokers = hand.filter(c => isJoker(c));
  const byValue = groupByValue(hand);
  const results: { cards: CardId[]; value: number }[] = [];

  for (const [value, cards] of byValue) {
    // Enumerate all C(n,3) combinations so the backtracker can try each allocation
    if (cards.length >= 3) {
      for (let a = 0; a < cards.length - 2; a++)
        for (let b = a + 1; b < cards.length - 1; b++)
          for (let c = b + 1; c < cards.length; c++)
            results.push({ cards: [cards[a], cards[b], cards[c]], value });
    }
    // 2 natural + 1 joker: enumerate all C(n,2) pairs
    if (cards.length >= 2 && jokers.length >= 1) {
      for (let a = 0; a < cards.length - 1; a++)
        for (let b = a + 1; b < cards.length; b++)
          results.push({ cards: [cards[a], cards[b], jokers[0]], value });
    }
    // 1 natural + 2 jokers
    if (cards.length >= 1 && jokers.length >= 2) {
      for (const c of cards)
        results.push({ cards: [c, jokers[0], jokers[1]], value });
    }
  }
  return results;
}

// ── Find all possible runs from a hand (3+ consecutive same-suit) ──
export function findPossibleRuns(hand: CardId[], minLength = 3): { cards: CardId[]; suit: number }[] {
  const jokers = hand.filter(c => isJoker(c));
  const bySuit = groupBySuit(hand);
  const results: { cards: CardId[]; suit: number }[] = [];

  for (const [suit, suitCards] of bySuit) {
    // Sort by value
    const sorted = suitCards.sort((a, b) => cardValue(a) - cardValue(b));
    const values = sorted.map(c => cardValue(c));

    // Try each starting position and extend
    for (let i = 0; i < sorted.length; i++) {
      const run: CardId[] = [sorted[i]];
      let lastVal = values[i];
      let jokersUsed = 0;
      const availableJokers = [...jokers];

      for (let j = i + 1; j < sorted.length || availableJokers.length > 0; ) {
        const nextVal = lastVal + 1;
        if (nextVal > 14) break; // Can't go past Ace

        if (j < sorted.length && values[j] === nextVal) {
          run.push(sorted[j]);
          lastVal = nextVal;
          j++;
        } else if (availableJokers.length > 0) {
          run.push(availableJokers.shift()!);
          lastVal = nextVal;
          jokersUsed++;
        } else {
          break;
        }
      }

      if (run.length >= minLength) {
        results.push({ cards: [...run], suit });
      }

      // Also try ace-low runs (A-2-3)
      if (values[i] === 2) {
        const aceCard = suitCards.find(c => cardValue(c) === 14);
        if (aceCard) {
          const aceLowRun: CardId[] = [aceCard, sorted[i]];
          let lv = 2;
          const aj = [...jokers];
          for (let j = i + 1; j < sorted.length || aj.length > 0; ) {
            const nv = lv + 1;
            if (j < sorted.length && values[j] === nv) {
              aceLowRun.push(sorted[j]);
              lv = nv;
              j++;
            } else if (aj.length > 0) {
              aceLowRun.push(aj.shift()!);
              lv = nv;
            } else break;
          }
          if (aceLowRun.length >= minLength) {
            results.push({ cards: [...aceLowRun], suit });
          }
        }
      }
    }
  }

  return results;
}

// ── Contract solver: find valid combinations of sets+runs ──
export interface MeldCandidate {
  meld_type: 'set' | 'run';
  cards: CardId[];
}

export function solveContract(
  hand: CardId[],
  requiredSets: number,
  requiredRuns: number,
  minRunLength = 3,
  mustMeldAll = false
): MeldCandidate[][] {
  const solutions: MeldCandidate[][] = [];

  function backtrack(
    remaining: CardId[],
    setsFound: MeldCandidate[],
    runsFound: MeldCandidate[],
    depth: number
  ) {
    if (setsFound.length >= requiredSets && runsFound.length >= requiredRuns) {
      if (mustMeldAll) {
        // Only accept if exactly 0 or 1 cards remain (1 = the discard)
        if (remaining.length > 1) return;
      }
      solutions.push([...setsFound, ...runsFound]);
      return;
    }
    if (depth > 20) return; // safety limit

    // Try to find sets
    if (setsFound.length < requiredSets) {
      const sets = findPossibleSets(remaining);
      for (const set of sets) {
        if (set.cards.length < 3) continue;
        // Only use 3 cards per set for contract (save extras for lay-offs)
        const trimmed = set.cards.slice(0, 3);
        const newRemaining = remaining.filter(c => !trimmed.includes(c));
        backtrack(
          newRemaining,
          [...setsFound, { meld_type: 'set', cards: trimmed }],
          runsFound,
          depth + 1
        );
      }
    }

    // Try to find runs
    if (runsFound.length < requiredRuns) {
      const runs = findPossibleRuns(remaining, minRunLength);
      for (const run of runs) {
        if (run.cards.length < minRunLength) continue;

        // For must-meld-all: try all valid lengths from min to full
        const maxLen = mustMeldAll ? run.cards.length : minRunLength;
        for (let len = minRunLength; len <= maxLen; len++) {
          const trimmed = run.cards.slice(0, len);
          const newRemaining = remaining.filter(c => !trimmed.includes(c));
          backtrack(
            newRemaining,
            setsFound,
            [...runsFound, { meld_type: 'run', cards: trimmed }],
            depth + 1
          );
        }
      }
    }
  }

  backtrack(hand, [], [], 0);
  return solutions;
}

// ── Score remaining hand after removing meld cards ──
export function deadwoodScore(hand: CardId[], meldCards: CardId[]): number {
  const used = new Set(meldCards);
  return hand.filter(c => !used.has(c)).reduce((sum, c) => sum + cardPoints(c), 0);
}

// ── Pick the best contract solution (least deadwood) ──
export function bestContractSolution(
  hand: CardId[],
  requiredSets: number,
  requiredRuns: number,
  minRunLength = 3,
  mustMeldAll = false
): MeldCandidate[] | null {
  const solutions = solveContract(hand, requiredSets, requiredRuns, minRunLength, mustMeldAll);
  if (solutions.length === 0) return null;

  let best = solutions[0];
  let bestDead = Infinity;
  for (const sol of solutions) {
    const usedCards = sol.flatMap(m => m.cards);
    const dead = deadwoodScore(hand, usedCards);
    if (dead < bestDead) {
      bestDead = dead;
      best = sol;
    }
  }
  return best;
}

// ── Contract-aware card relevance scoring ──
// Score how much a card contributes to the needed contract type.
// Higher score = more valuable to keep.
function cardContractRelevance(
  card: CardId,
  hand: CardId[],
  requiredSets: number,
  requiredRuns: number,
  setWeight = 1.0,
  runWeight = 1.0,
  memory?: CardMemory,
  totalPerValue = 8   // cards per value in the full deck (numDecks * 4)
): number {
  if (isJoker(card)) return 50; // jokers always valuable

  let score = 0;
  const cv = cardValue(card);
  const cs = cardSuit(card);

  // ── Set relevance (only if contract needs sets) ──
  if (requiredSets > 0) {
    const sameValue = hand.filter(c => !isJoker(c) && cardValue(c) === cv && c !== card);
    // Card memory: scale penalty by how many of this value are still available
    // With 2 decks, 8 per value. Need 2 more for set of 3 (or 1 more if holding pair).
    let setDeadPenalty = 1.0;
    if (memory && sameValue.length < 2) {
      const needed = 2 - sameValue.length; // how many more we need for a set
      const available = availableCount(memory, cv, totalPerValue) - sameValue.length - 1; // exclude cards in our hand
      if (available <= 0) setDeadPenalty = 0.1;        // impossible — no cards left
      else if (available < needed) setDeadPenalty = 0.2; // not enough to complete
      else setDeadPenalty = Math.min(1.0, available / totalPerValue); // proportional
    }
    if (sameValue.length >= 2) score += 30 * setWeight; // completes a set (no penalty — already have it)
    else if (sameValue.length === 1) score += 15 * setWeight * setDeadPenalty; // building a pair
    else score += 5 * setWeight * setDeadPenalty; // singleton — penalize if dead
  }

  // ── Run relevance (only if contract needs runs) ──
  if (requiredRuns > 0) {
    const sameSuit = hand.filter(c => !isJoker(c) && cardSuit(c) === cs && c !== card)
      .map(c => cardValue(c));

    // Count adjacent cards in this suit (sequential connectivity)
    let adjCount = 0;
    for (const v of sameSuit) {
      if (Math.abs(v - cv) === 1) adjCount++;
      else if (Math.abs(v - cv) === 2) adjCount += 0.3; // gap-1, joker could fill
    }
    // Ace-low: check if ace connects to 2 or 3
    if (cv === 14) {
      if (sameSuit.includes(2)) adjCount++;
      if (sameSuit.includes(3)) adjCount += 0.3;
    } else if (cv === 2 && sameSuit.includes(14)) {
      adjCount++;
    } else if (cv === 3 && sameSuit.includes(14)) {
      adjCount += 0.3;
    }

    if (adjCount >= 2) score += 30 * runWeight; // part of a 3+ card sequence
    else if (adjCount >= 1) score += 15 * runWeight; // connected pair in suit
  }

  return score;
}

// ── Discard evaluator: which card hurts least to discard? ──
// tableMelds: pass melds on the table so AI avoids feeding opponents.
// protectedCards: cards that cannot be discarded this turn (drawn/bought this turn).
// protectionPenalty: score penalty for protected cards (from TierProfile.drawnCardProtection).
export function rankDiscards(
  hand: CardId[],
  requiredSets: number,
  requiredRuns: number,
  tableMelds: { id: string; meld_type: string; cards: CardId[] }[] = [],
  protectedCards: CardId[] = [],
  hasMetContract: boolean = false,
  roundWeights?: { setWeight: number; runWeight: number; isolationPenalty: number },
  memory?: CardMemory,
  tableModel?: TableModel,
  totalPerValue = 8   // cards per value in full deck (numDecks * 4)
): CardId[] {
  const protectedSet = new Set(protectedCards);
  const sw = roundWeights?.setWeight ?? 1.0;
  const rw = roundWeights?.runWeight ?? 1.0;
  const isolation = roundWeights?.isolationPenalty ?? 0;

  // Hard-filter: protected cards (drawn/bought this turn) are ineligible
  let candidates = hand.filter(c => !protectedSet.has(c));
  // If ALL cards are protected, fall back to full hand (must discard something)
  if (candidates.length === 0) candidates = [...hand];

  // Post-contract: also hard-filter cards playable as lay-offs on visible melds
  if (hasMetContract && tableMelds.length > 0) {
    const nonLayoffCandidates = candidates.filter(c =>
      !tableMelds.some(m => canLayOff(c, m))
    );
    // Only apply if it leaves at least one candidate
    if (nonLayoffCandidates.length > 0) candidates = nonLayoffCandidates;
  }

  // ── Suit concentration: identify top N suits by run potential ──
  // Cards in non-focused suits should be discarded more readily
  let topSuits: Set<number> | undefined;
  if (requiredRuns > 0 && !hasMetContract) {
    const bySuit = groupBySuit(hand);
    const suitScores: { suit: number; score: number }[] = [];
    for (const [suit, cards] of bySuit) {
      // Score = longest consecutive chain in this suit
      const vals = cards.map(c => cardValue(c)).sort((a, b) => a - b);
      let maxChain = 1, chain = 1;
      for (let i = 1; i < vals.length; i++) {
        if (vals[i] === vals[i - 1] + 1) { chain++; maxChain = Math.max(maxChain, chain); }
        else if (vals[i] === vals[i - 1] + 2) { chain++; maxChain = Math.max(maxChain, chain); } // gap-1 (joker fillable)
        else { chain = 1; }
      }
      suitScores.push({ suit, score: maxChain * 10 + cards.length });
    }
    suitScores.sort((a, b) => b.score - a.score);
    topSuits = new Set(suitScores.slice(0, requiredRuns).map(s => s.suit));
  }

  // ── Post-contract: simplified scoring — dump highest points, keep near-layable ──
  if (hasMetContract) {
    const scored = candidates.map(card => {
      const pts = cardPoints(card);

      // Bonus: card is 1 away from extending a table meld (near-layable)
      let nearLayable = 0;
      if (!isJoker(card)) {
        const cv = cardValue(card);
        const cs = cardSuit(card);
        for (const meld of tableMelds) {
          if (meld.meld_type === 'run') {
            const nonJokers = meld.cards.filter(c => !isJoker(c));
            if (nonJokers.length === 0) continue;
            const suit = cardSuit(nonJokers[0]);
            if (cs !== suit) continue;
            const nonJokerValues = nonJokers.map(c => cardValue(c));
            const minVal = Math.min(...nonJokerValues);
            const maxVal = Math.max(...nonJokerValues);
            // 1-away from either end (would become layable if someone else extends first)
            if (cv === minVal - 2 || cv === maxVal + 2) nearLayable += 10;
            // 2-away
            if (cv === minVal - 3 || cv === maxVal + 3) nearLayable += 3;
          } else if (meld.meld_type === 'set') {
            const existingValue = meld.cards.find(c => !isJoker(c));
            if (existingValue && cardValue(card) === cardValue(existingValue)) {
              nearLayable += 15; // same value as a set — might get laid off
            }
          }
        }
      }

      // Feed strategy bonus (Hard/Unfair)
      let feedBonus = 0;
      if (tableModel && tableModel.myPlayerId) {
        feedBonus = feedLayOffBonus(card, hand, tableModel, tableModel.myPlayerId);
      }

      // Score: lower = better to discard
      // Dump high-point cards, keep near-layable cards, apply feed strategy
      return { card, score: nearLayable - pts - feedBonus };
    });

    scored.sort((a, b) => a.score - b.score);
    return scored.map(s => s.card);
  }

  const scored = candidates.map(card => {
    // Check if removing this card breaks an existing contract solution
    const without = hand.filter(c => c !== card);
    const canStillMeet = solveContract(without, requiredSets, requiredRuns).length > 0;

    // Contract-aware relevance (how much does this card help the needed contract?)
    const relevance = cardContractRelevance(card, hand, requiredSets, requiredRuns, sw, rw, memory, totalPerValue);

    // Higher deadwood points = better to discard (if equally irrelevant)
    const pts = cardPoints(card);

    // Penalty for feeding opponent melds — card is playable on a visible meld
    let feedsPenalty = 0;
    for (const meld of tableMelds) {
      if (canLayOff(card, meld)) {
        feedsPenalty = 40; // deterrent: avoid giving opponents free lay-offs
        break;
      }
    }

    // Card memory: extra penalty if an opponent wants this value/suit
    let opponentFeedPenalty = 0;
    if (memory && !isJoker(card)) {
      const cv = cardValue(card);
      const cs = cardSuit(card);
      if (opponentWantsValue(memory, '', cv)) {
        opponentFeedPenalty += 25; // opponent picked up/bought this value
      }
      if (opponentWantsSuitRun(memory, '', cs, cv)) {
        opponentFeedPenalty += 15; // opponent collecting nearby suit cards
      }
    }

    // Isolation penalty: lone high cards with no run neighbors (run-heavy rounds)
    let isolationScore = 0;
    if (isolation < 0 && !isJoker(card) && cardValue(card) >= 11) {
      if (!hasRunNeighbors(card, hand)) {
        isolationScore = isolation; // negative = easier to discard
      }
    }

    // Suit concentration: penalize cards not in the top N suits for runs
    let suitConcentration = 0;
    if (topSuits && !isJoker(card)) {
      if (!topSuits.has(cardSuit(card))) {
        suitConcentration = -20 * rw; // wrong suit — easier to discard
      }
    }

    // Score: lower = better to discard
    // Cards that break contract: strongly keep (1000)
    // Cards that feed opponent melds: penalize (+40 meld, +25/15 memory)
    // Then by contract relevance (0-50)
    // Suit concentration: cards in non-focus suits penalized (-20)
    // Isolation penalty for lone high cards (negative in run-heavy rounds)
    // Then prefer discarding high-point cards (subtract pts)
    return {
      card,
      score: (canStillMeet ? 0 : 1000) + feedsPenalty + opponentFeedPenalty + relevance + suitConcentration + isolationScore - pts
    };
  });

  // Sort ascending: lowest score = best discard candidate
  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.card);
}

// ── Post-contract draw evaluator ──
// After contract is met, only pick from discard if the card is immediately
// playable as a lay-off on an existing meld.
export function evaluatePostContractDraw(
  discardCard: CardId,
  melds: { id: string; meld_type: string; cards: CardId[] }[]
): boolean {
  if (isJoker(discardCard)) return true;
  return melds.some(m => canLayOff(discardCard, m));
}

// ── Pickup quality gates ──
// Is this pair among the best paths to completing needed sets?
// Ranks all value groups by size; only returns true if this value's group
// is in the top N (where N = requiredSets still needed).
function isBestPairPath(hand: CardId[], targetValue: number, requiredSets: number): boolean {
  const byValue = groupByValue(hand);
  // Score each value group by size (bigger = closer to a set)
  const groups: { value: number; count: number }[] = [];
  for (const [value, cards] of byValue) {
    groups.push({ value, count: cards.length });
  }
  // Sort descending by count — best paths first
  groups.sort((a, b) => b.count - a.count);
  // The target value's current count (before adding the discard card)
  const targetGroup = groups.find(g => g.value === targetValue);
  const targetCount = targetGroup?.count || 0;
  // Check if this value is in the top requiredSets groups
  // (i.e., it's one of the best paths to completing the contract)
  const topGroups = groups.slice(0, requiredSets);
  // Include if it's already in the top paths, OR if it ties with the weakest top path
  const weakestTopCount = topGroups.length > 0 ? topGroups[topGroups.length - 1].count : 0;
  return targetCount >= weakestTopCount && targetCount >= 1;
}

// Is this run extension among the best paths to completing needed runs?
// Ranks all suit sequences by length; only returns true if this suit's sequence
// is in the top N (where N = requiredRuns still needed).
function isBestRunPath(hand: CardId[], targetSuit: number, requiredRuns: number): boolean {
  const bySuit = groupBySuit(hand);
  // For each suit, find the longest consecutive sequence
  const suitBest: { suit: number; maxConsec: number }[] = [];
  for (const [suit, cards] of bySuit) {
    const vals = cards.map(c => cardValue(c)).sort((a, b) => a - b);
    let maxC = 1, curC = 1;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i - 1] + 1) { curC++; maxC = Math.max(maxC, curC); }
      else if (vals[i] !== vals[i - 1]) curC = 1;
    }
    // Ace-low check
    if (vals.includes(14) && vals.includes(2)) {
      const lowVals = vals.map(v => v === 14 ? 1 : v).sort((a, b) => a - b);
      let lc = 1;
      for (let i = 1; i < lowVals.length; i++) {
        if (lowVals[i] === lowVals[i - 1] + 1) { lc++; maxC = Math.max(maxC, lc); }
        else if (lowVals[i] !== lowVals[i - 1]) lc = 1;
      }
    }
    suitBest.push({ suit, maxConsec: maxC });
  }
  suitBest.sort((a, b) => b.maxConsec - a.maxConsec);
  const targetSeq = suitBest.find(s => s.suit === targetSuit);
  const targetLen = targetSeq?.maxConsec || 0;
  const topSuits = suitBest.slice(0, requiredRuns);
  const weakestTopLen = topSuits.length > 0 ? topSuits[topSuits.length - 1].maxConsec : 0;
  return targetLen >= weakestTopLen && targetLen >= 1;
}

// ── Contract weakness check ──
// For mixed contracts, check which dimension is weaker and bias speculation toward it.
// Tracks progress toward ALL required melds (e.g., 2S+1R tracks top-2 value groups).
// Returns true if the pickup helps the weaker contract dimension.
export function helpsWeakerContract(
  hand: CardId[],
  discardCard: CardId,
  requiredSets: number,
  requiredRuns: number
): boolean {
  if (requiredSets === 0 || requiredRuns === 0) return true; // pure contract, always relevant

  const dv = cardValue(discardCard);
  const ds = cardSuit(discardCard);

  // Set progress: average of top N value groups (where N = requiredSets)
  const byValue = groupByValue(hand);
  const setSizes: number[] = [];
  for (const [, cards] of byValue) setSizes.push(cards.length);
  setSizes.sort((a, b) => b - a);
  const topSets = setSizes.slice(0, requiredSets);
  while (topSets.length < requiredSets) topSets.push(0);
  const setProgress = topSets.reduce((s, n) => s + n / 3, 0) / requiredSets;

  // Run progress: average of top N suit sequences (where N = requiredRuns)
  const bySuit = groupBySuit(hand);
  const runLens: number[] = [];
  for (const [, cards] of bySuit) {
    const vals = cards.map(c => cardValue(c)).sort((a, b) => a - b);
    let maxC = 1, curC = 1;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i - 1] + 1) { curC++; maxC = Math.max(maxC, curC); }
      else if (vals[i] !== vals[i - 1]) curC = 1;
    }
    // Ace-low check
    if (vals.includes(14) && vals.includes(2)) {
      const lowVals = vals.map(v => v === 14 ? 1 : v).sort((a, b) => a - b);
      let lc = 1;
      for (let i = 1; i < lowVals.length; i++) {
        if (lowVals[i] === lowVals[i - 1] + 1) { lc++; maxC = Math.max(maxC, lc); }
        else if (lowVals[i] !== lowVals[i - 1]) lc = 1;
      }
    }
    runLens.push(maxC);
  }
  runLens.sort((a, b) => b - a);
  const topRuns = runLens.slice(0, requiredRuns);
  while (topRuns.length < requiredRuns) topRuns.push(0);
  const runProgress = topRuns.reduce((s, n) => s + n / 3, 0) / requiredRuns;

  // Does the pickup help sets or runs?
  const helpsSet = hand.some(c => !isJoker(c) && cardValue(c) === dv);
  const helpsSuit = hand.filter(c => !isJoker(c) && cardSuit(c) === ds)
    .some(c => Math.abs(cardValue(c) - dv) <= 2);

  // If sets are weaker, prefer pickups that help sets
  if (setProgress < runProgress) return helpsSet;
  // If runs are weaker, prefer pickups that help runs
  if (runProgress < setProgress) return helpsSuit;
  // Equal progress — either is fine
  return true;
}

// ── Round 7 draw evaluator: "fits adjacent to an existing run" ──
export function evaluateRound7Draw(
  hand: CardId[],
  discardCard: CardId
): { takeDiscard: boolean; reason: string } {
  if (isJoker(discardCard)) return { takeDiscard: true, reason: 'joker' };

  // Check if adding this card enables a must-meld-all solution
  const withDiscard = [...hand, discardCard];
  const solsWith = solveContract(withDiscard, 0, 3, 3, true);
  const solsWithout = solveContract(hand, 0, 3, 3, true);
  if (solsWith.length > 0 && solsWithout.length === 0) {
    return { takeDiscard: true, reason: 'enables_contract' };
  }

  const ds = cardSuit(discardCard);
  const dv = cardValue(discardCard);

  // "Speculative" for round 7 = fits adjacent to any same-suit card in hand
  const sameSuit = hand.filter(c => !isJoker(c) && cardSuit(c) === ds);
  const adjacent = sameSuit.some(c => {
    const diff = Math.abs(cardValue(c) - dv);
    if (diff === 1) return true;
    // Ace-low adjacency: A(14) adjacent to 2
    if (dv === 14 && cardValue(c) === 2) return true;
    if (dv === 2 && cardValue(c) === 14) return true;
    return false;
  });

  if (adjacent) {
    // Verify adding this card doesn't wreck overall solvability direction
    // (only reject if hand+card has strictly fewer potential runs than hand alone)
    const currentRunPotential = countRunPotential(hand);
    const newRunPotential = countRunPotential(withDiscard);
    if (newRunPotential >= currentRunPotential) {
      return { takeDiscard: true, reason: 'run_adjacent' };
    }
    // Adjacent but hurts overall shape — still take if it extends a 2+ card sequence
    if (sameSuit.filter(c => Math.abs(cardValue(c) - dv) === 1).length >= 2) {
      return { takeDiscard: true, reason: 'run_gap_fill' };
    }
  }

  // Gap of 2 (joker could fill) — still useful
  const nearGap = sameSuit.some(c => {
    const diff = Math.abs(cardValue(c) - dv);
    return diff === 2;
  });
  if (nearGap && hand.some(c => isJoker(c))) {
    return { takeDiscard: true, reason: 'run_gap_fill' };
  }

  return { takeDiscard: false, reason: 'not_adjacent' };
}

// ── Round 7 helper: count how many 3+ card same-suit sequences exist in hand ──
// Higher = hand is better shaped for runs
function countRunPotential(hand: CardId[]): number {
  const bySuit = groupBySuit(hand);
  let total = 0;
  for (const [, cards] of bySuit) {
    const vals = cards.map(c => cardValue(c)).sort((a, b) => a - b);
    let consec = 1;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] === vals[i - 1] + 1) {
        consec++;
        if (consec >= 3) total++;
      } else if (vals[i] !== vals[i - 1]) {
        consec = 1;
      }
    }
    // Ace-low check
    if (vals.includes(14) && vals.includes(2)) {
      const lowVals = vals.map(v => v === 14 ? 1 : v).sort((a, b) => a - b);
      let lc = 1;
      for (let i = 1; i < lowVals.length; i++) {
        if (lowVals[i] === lowVals[i - 1] + 1) { lc++; if (lc >= 3) total++; }
        else if (lowVals[i] !== lowVals[i - 1]) lc = 1;
      }
    }
  }
  return total;
}

// ── Round 7 helper: check if a card has same-suit neighbors in hand ──
function hasRunNeighbors(card: CardId, hand: CardId[]): boolean {
  if (isJoker(card)) return true;
  const cs = cardSuit(card);
  const cv = cardValue(card);
  return hand.some(c => c !== card && !isJoker(c) && cardSuit(c) === cs &&
    (Math.abs(cardValue(c) - cv) === 1 ||
     (cv === 14 && cardValue(c) === 2) ||
     (cv === 2 && cardValue(c) === 14)));
}

// ── Round 7 discard evaluator: score by solvability ──
// For each candidate, count how many valid 3-run must-meld-all solutions exist
// with vs without the card. The card whose removal keeps the most solutions is best discard.
export function rankDiscardsRound7(
  hand: CardId[],
  tableMelds: { id: string; meld_type: string; cards: CardId[] }[] = [],
  protectedCards: CardId[] = []
): CardId[] {
  const protectedSet = new Set(protectedCards);
  let candidates = hand.filter(c => !protectedSet.has(c));
  if (candidates.length === 0) candidates = [...hand];

  const scored = candidates.map(card => {
    const without = hand.filter(c => c !== card);
    // Count solutions with must-meld-all (remaining must be 0 after removing 1 card)
    const solutions = solveContract(without, 0, 3, 3, true).length;

    // Feed penalty for table-aware tiers
    let feedsPenalty = 0;
    for (const meld of tableMelds) {
      if (canLayOff(card, meld)) { feedsPenalty = -20; break; }
    }

    const pts = cardPoints(card);

    // Isolation penalty: unsupported face cards (J/Q/K/A without same-suit neighbors)
    // are deadweight — high points, hard to fit into runs
    let isolationPenalty = 0;
    if (!isJoker(card) && cardValue(card) >= 11 && !hasRunNeighbors(card, hand)) {
      isolationPenalty = -50; // strongly favor discarding isolated face cards
    }

    // Higher solutions = better to discard this card (hand stays solvable without it)
    // Isolation penalty makes lone face cards top discard priority
    // Tiebreak: prefer discarding high-point cards
    return {
      card,
      score: -(solutions * 100) + feedsPenalty + isolationPenalty - pts
    };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.map(s => s.card);
}

// ── Round 7 buy evaluator: is the discard a run connector? ──
export function evaluateRound7Buy(
  hand: CardId[],
  discardCard: CardId
): number {
  if (isJoker(discardCard)) return 100;

  const ds = cardSuit(discardCard);
  const dv = cardValue(discardCard);
  let score = 0;

  const sameSuit = hand.filter(c => !isJoker(c) && cardSuit(c) === ds);
  const vals = sameSuit.map(c => cardValue(c));

  // Direct adjacency — extends or connects a run
  const adjCount = vals.filter(v => Math.abs(v - dv) === 1 ||
    (dv === 14 && v === 2) || (dv === 2 && v === 14)).length;
  if (adjCount >= 2) score += 90;  // fills a gap between two cards
  else if (adjCount >= 1) score += 60;  // extends one end

  // Gap of 2 with joker available
  const gapCount = vals.filter(v => Math.abs(v - dv) === 2).length;
  if (gapCount > 0 && hand.some(c => isJoker(c))) score += 40;

  return score;
}

// ── Draw evaluator: should AI take discard or draw from deck? ──
// Contract-first: only pick up cards that help the needed contract type.
export function evaluateDiscardDraw(
  hand: CardId[],
  discardCard: CardId,
  requiredSets: number,
  requiredRuns: number,
  memory?: CardMemory,
  totalPerValue = 8   // cards per value in full deck (numDecks * 4)
): { takeDiscard: boolean; reason: string } {
  if (isJoker(discardCard)) {
    return { takeDiscard: true, reason: 'joker' };
  }

  // Test: can we meet contract with the discard card?
  const withDiscard = [...hand, discardCard];
  const solutionsWith = solveContract(withDiscard, requiredSets, requiredRuns);
  const solutionsWithout = solveContract(hand, requiredSets, requiredRuns);

  // If adding discard card enables contract, definitely take it
  if (solutionsWith.length > 0 && solutionsWithout.length === 0) {
    return { takeDiscard: true, reason: 'enables_contract' };
  }

  const dv = cardValue(discardCard);
  const ds = cardSuit(discardCard);

  // ── Pure run contract: only pick up cards that extend suited sequences ──
  if (requiredSets === 0 && requiredRuns > 0) {
    const sameSuit = hand.filter(c => !isJoker(c) && cardSuit(c) === ds)
      .map(c => cardValue(c)).sort((a, b) => a - b);

    // Check if card extends or fills a run in this suit
    const allVals = [...sameSuit, dv].sort((a, b) => a - b);
    // Also check ace-low: treat 14 as 1 if relevant
    let maxConsec = 1, cur = 1;
    for (let i = 1; i < allVals.length; i++) {
      if (allVals[i] === allVals[i - 1] + 1) { cur++; maxConsec = Math.max(maxConsec, cur); }
      else if (allVals[i] !== allVals[i - 1]) cur = 1;
    }
    // Ace-low check
    if (allVals.includes(14) && allVals.includes(2)) {
      const lowVals = allVals.map(v => v === 14 ? 1 : v).sort((a, b) => a - b);
      let lc = 1;
      for (let i = 1; i < lowVals.length; i++) {
        if (lowVals[i] === lowVals[i - 1] + 1) { lc++; maxConsec = Math.max(maxConsec, lc); }
        else if (lowVals[i] !== lowVals[i - 1]) lc = 1;
      }
    }

    if (maxConsec >= 3) return { takeDiscard: true, reason: 'completes_run' };
    if (maxConsec >= 2 && sameSuit.length >= 1) {
      if (isBestRunPath(hand, ds, requiredRuns)) {
        return { takeDiscard: true, reason: 'extends_run' };
      }
      return { takeDiscard: false, reason: 'weaker_run_path' };
    }
    return { takeDiscard: false, reason: 'not_useful_for_runs' };
  }

  // ── Pure set contract: only pick up cards that match by rank ──
  if (requiredSets > 0 && requiredRuns === 0) {
    const sameValue = hand.filter(c => !isJoker(c) && cardValue(c) === dv);
    if (sameValue.length >= 2) return { takeDiscard: true, reason: 'completes_set' };
    if (sameValue.length >= 1) {
      // Card memory: reject if not enough cards of this value remain to complete the set
      // Need 1 more (have pair + discard = 3). Available = total - dead - in_hand - this_card
      if (memory) {
        const available = availableCount(memory, dv, totalPerValue) - sameValue.length - 1;
        if (available <= 0) return { takeDiscard: false, reason: 'dead_set_path' };
      }
      if (isBestPairPath(hand, dv, requiredSets)) {
        return { takeDiscard: true, reason: 'builds_pair' };
      }
      return { takeDiscard: false, reason: 'weaker_pair_path' };
    }
    return { takeDiscard: false, reason: 'not_useful_for_sets' };
  }

  // ── Mixed contract: evaluate both dimensions ──
  const sameValue = hand.filter(c => !isJoker(c) && cardValue(c) === dv);
  if (sameValue.length >= 2) return { takeDiscard: true, reason: 'completes_set' };
  // Card memory: reject dead set paths in mixed contracts too
  if (memory && sameValue.length >= 1) {
    const available = availableCount(memory, dv, totalPerValue) - sameValue.length - 1;
    if (available <= 0) {
      // Don't chase this set — but might still help a run, so continue checking
    }
  }

  const sameSuit = hand.filter(c => !isJoker(c) && cardSuit(c) === ds)
    .map(c => cardValue(c)).sort((a, b) => a - b);
  const allVals = [...sameSuit, dv].sort((a, b) => a - b);
  let maxConsec = 1, cur = 1;
  for (let i = 1; i < allVals.length; i++) {
    if (allVals[i] === allVals[i - 1] + 1) { cur++; maxConsec = Math.max(maxConsec, cur); }
    else if (allVals[i] !== allVals[i - 1]) cur = 1;
  }
  if (maxConsec >= 3) return { takeDiscard: true, reason: 'completes_run' };

  if (sameValue.length >= 1) {
    if (isBestPairPath(hand, dv, requiredSets)) {
      return { takeDiscard: true, reason: 'builds_pair' };
    }
    return { takeDiscard: false, reason: 'weaker_pair_path' };
  }
  if (maxConsec >= 2 && sameSuit.length >= 1) {
    if (isBestRunPath(hand, ds, requiredRuns)) {
      return { takeDiscard: true, reason: 'extends_run' };
    }
    return { takeDiscard: false, reason: 'weaker_run_path' };
  }

  return { takeDiscard: false, reason: 'not_useful' };
}

// ── Find lay-off opportunities ──
export function findLayOffs(
  hand: CardId[],
  melds: { id: string; meld_type: string; cards: CardId[] }[]
): { card: CardId; meld_id: string }[] {
  const layoffs: { card: CardId; meld_id: string }[] = [];

  for (const meld of melds) {
    for (const card of hand) {
      if (canLayOff(card, meld)) {
        layoffs.push({ card, meld_id: meld.id });
      }
    }
  }

  // Sort by card points (highest first — get rid of expensive cards)
  layoffs.sort((a, b) => cardPoints(b.card) - cardPoints(a.card));
  return layoffs;
}

function canLayOff(card: CardId, meld: { meld_type: string; cards: CardId[] }): boolean {
  if (isJoker(card)) return true; // Jokers can be added to any meld

  if (meld.meld_type === 'set') {
    // Same value as existing set cards
    const existingValue = meld.cards.find(c => !isJoker(c));
    if (!existingValue) return true;
    return cardValue(card) === cardValue(existingValue);
  }

  if (meld.meld_type === 'run') {
    // Same suit, extends the sequence
    const nonJokers = meld.cards.filter(c => !isJoker(c));
    if (nonJokers.length === 0) return true;
    const suit = cardSuit(nonJokers[0]);
    if (cardSuit(card) !== suit) return false;

    // Compute actual min/max values from non-joker cards
    // (can't trust card order — lay-offs append with max position, not sorted by value)
    const nonJokerValues = nonJokers.map(c => cardValue(c));
    const minVal = Math.min(...nonJokerValues);
    const maxVal = Math.max(...nonJokerValues);

    const jokerCount = meld.cards.length - nonJokers.length;
    if (jokerCount === 0) {
      // No jokers: run is simply minVal..maxVal
      const cv = cardValue(card);
      return cv === minVal - 1 || cv === maxVal + 1;
    }

    // With jokers: they fill gaps first, then extend ends
    const naturalSpan = maxVal - minVal + 1;
    const gapJokers = naturalSpan - nonJokers.length;
    const endJokers = Math.max(0, jokerCount - gapJokers);
    const startVal = minVal - Math.floor(endJokers / 2);
    const endVal = maxVal + Math.ceil(endJokers / 2);

    const cv = cardValue(card);
    return cv === startVal - 1 || cv === endVal + 1;
  }

  return false;
}
