// ============================================================
// Training Harness — Buy Evaluator
// Pure buy score logic extracted from ai-buy/index.ts (lines 122-162)
// Same decision, no HTTP overhead, no delays.
// Round-aware via round-profiles.ts
// ============================================================

import { CardId, cardValue, isJoker } from '../_shared/types.ts';
import { groupByValue, groupBySuit, evaluateRound7Buy } from '../ai-turn/hand-analyzer.ts';
import { getRoundProfile } from '../ai-turn/round-profiles.ts';
import { type CardMemory, availableCount } from '../ai-turn/card-memory.ts';

const BUY_THRESHOLDS: Record<string, number> = {
  easy: 70,     // only obvious completions
  normal: 50,   // pair match alone won't trigger (need pair + run neighbor)
  hard: 55,     // needs pair + run neighbor or near-completion
  unfair: 55,   // same selectivity as hard — wins through smarter play, not more buys
};

function standardBuyScore(hand: CardId[], topDiscard: CardId): number {
  let score = 0;
  const dv = cardValue(topDiscard);
  const byValue = groupByValue(hand);
  const bySuit = groupBySuit(hand);

  const sameValue = byValue.get(dv) || [];
  if (sameValue.length >= 2) score += 80;
  else if (sameValue.length >= 1) score += 30;

  if (!isJoker(topDiscard)) {
    const ds = parseInt(topDiscard[1]);
    const sameSuit = (bySuit.get(ds) || []).map(c => cardValue(c));
    for (const v of sameSuit) {
      if (Math.abs(v - dv) <= 2) score += 20;
    }
  }

  if (isJoker(topDiscard)) score += 90;

  score -= 15;
  return score;
}

export function evaluateBuy(
  hand: CardId[],
  topDiscard: CardId,
  roundNumber: number,
  tier: string,
  memory?: CardMemory,
  totalPerValue = 8   // cards per value in full deck (numDecks * 4)
): { shouldBuy: boolean; score: number } {
  // Card memory: skip buying if not enough of this value remain to complete a set
  if (memory && !isJoker(topDiscard)) {
    const dv = cardValue(topDiscard);
    const inHand = hand.filter(c => !isJoker(c) && cardValue(c) === dv).length;
    const needed = Math.max(0, 2 - inHand); // need 3 for set, already have inHand + buying 1
    const available = availableCount(memory, dv, totalPerValue) - inHand - 1; // exclude hand + this card
    if (needed > 0 && available <= 0) {
      return { shouldBuy: false, score: -1 };
    }
  }

  let buyScore: number;
  const rp = getRoundProfile(roundNumber);

  if (roundNumber === 7) {
    buyScore = evaluateRound7Buy(hand, topDiscard);
  } else if (rp.useGapFillDraw) {
    buyScore = Math.max(evaluateRound7Buy(hand, topDiscard), standardBuyScore(hand, topDiscard));
  } else {
    buyScore = standardBuyScore(hand, topDiscard);
  }

  const threshold = (BUY_THRESHOLDS[tier] ?? 40) + rp.buyThresholdAdjust;
  return { shouldBuy: buyScore >= threshold, score: buyScore };
}
