// ============================================================
// Training Harness — Buy Evaluator
// Pure buy score logic extracted from ai-buy/index.ts (lines 122-162)
// Same decision, no HTTP overhead, no delays.
// Round-aware via round-profiles.ts
// ============================================================

import { CardId, cardValue, isJoker } from '../_shared/types.ts';
import { groupByValue, groupBySuit, evaluateRound7Buy } from '../ai-turn/hand-analyzer.ts';
import { getRoundProfile } from '../ai-turn/round-profiles.ts';

const BUY_THRESHOLDS: Record<string, number> = {
  easy: 70,     // only obvious completions
  normal: 40,   // reasonable threshold
  hard: 25,     // more aggressive
  unfair: 10,   // buys almost anything useful
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
  tier: string
): { shouldBuy: boolean; score: number } {
  let buyScore: number;
  const rp = getRoundProfile(roundNumber);

  if (roundNumber === 7) {
    buyScore = evaluateRound7Buy(hand, topDiscard);
  } else if (rp.useGapFillDraw) {
    // Run-heavy rounds (3, 6): use best of R7-style and standard scoring
    buyScore = Math.max(evaluateRound7Buy(hand, topDiscard), standardBuyScore(hand, topDiscard));
  } else {
    buyScore = standardBuyScore(hand, topDiscard);
  }

  // Apply round-specific threshold adjustment (negative = more aggressive)
  const threshold = (BUY_THRESHOLDS[tier] ?? 40) + rp.buyThresholdAdjust;
  return { shouldBuy: buyScore >= threshold, score: buyScore };
}
