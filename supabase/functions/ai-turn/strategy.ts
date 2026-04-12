import { CardId, cardPoints, isJoker } from '../_shared/types.ts';
import {
  bestContractSolution,
  rankDiscards,
  evaluateDiscardDraw,
  findLayOffs,
  MeldCandidate
} from './hand-analyzer.ts';

export interface TurnDecision {
  drawFrom: 'deck' | 'discard';
  melds: MeldCandidate[] | null; // contract fulfillment
  layOffs: { card: CardId; meld_id: string }[];
  extraMelds: MeldCandidate[];
  discardCard: CardId;
}

interface TurnContext {
  hand: CardId[];
  topDiscard: CardId | null;
  discardBought: boolean;
  contractSets: number;
  contractRuns: number;
  hasMetContract: boolean;
  hasDrawn: boolean;
  melds: { id: string; meld_type: string; cards: CardId[] }[];
  tier: string;
  roundNumber: number;
}

// ── Tier noise: probability of making a suboptimal choice ──
const MISTAKE_RATE: Record<string, number> = {
  easy: 0.5,    // 50% chance of suboptimal
  normal: 0.3,  // 30%
  hard: 0.1,    // 10%
  unfair: 0.0,  // never
};

function shouldMakeMistake(tier: string): boolean {
  return Math.random() < (MISTAKE_RATE[tier] ?? 0.3);
}

// ── DRAW DECISION ──
export function decideDrawSource(ctx: TurnContext): 'deck' | 'discard' {
  if (ctx.discardBought || !ctx.topDiscard) return 'deck';

  const eval_ = evaluateDiscardDraw(
    ctx.hand,
    ctx.topDiscard,
    ctx.contractSets,
    ctx.contractRuns
  );

  // Easy tier: mostly draws from deck regardless
  if (ctx.tier === 'easy') {
    if (eval_.reason === 'enables_contract' || eval_.reason === 'completes_set' || eval_.reason === 'completes_run') {
      return shouldMakeMistake(ctx.tier) ? 'deck' : 'discard';
    }
    return 'deck'; // Easy rarely takes discard
  }

  // Normal+ tiers use the evaluation
  if (eval_.takeDiscard) {
    // Normal might miss less obvious opportunities (partial melds)
    if (ctx.tier === 'normal' && (eval_.reason === 'builds_pair' || eval_.reason === 'extends_run')) {
      return shouldMakeMistake(ctx.tier) ? 'deck' : 'discard';
    }
    return 'discard';
  }

  return 'deck';
}

// ── MELD DECISION ──
export function decideMelds(ctx: TurnContext): MeldCandidate[] | null {
  if (ctx.hasMetContract) return null;

  const solution = bestContractSolution(ctx.hand, ctx.contractSets, ctx.contractRuns);
  if (!solution) return null;

  // Easy tier: might hold contract an extra turn by accident
  if (ctx.tier === 'easy' && Math.random() < 0.2 && ctx.roundNumber < 6) {
    return null; // "Didn't notice" they could meet contract
  }

  return solution;
}

// ── LAY OFF DECISION ──
export function decideLayOffs(ctx: TurnContext): { card: CardId; meld_id: string }[] {
  if (!ctx.hasMetContract) return [];

  const opportunities = findLayOffs(ctx.hand, ctx.melds);
  if (opportunities.length === 0) return [];

  // Easy: misses most lay-offs
  if (ctx.tier === 'easy') {
    return opportunities.filter(() => Math.random() < 0.15);
  }

  // Normal: catches ~70%
  if (ctx.tier === 'normal') {
    return opportunities.filter(() => Math.random() < 0.7);
  }

  // Hard/Unfair: catches all
  return opportunities;
}

// ── DISCARD DECISION ──
export function decideDiscard(ctx: TurnContext): CardId {
  const ranked = rankDiscards(ctx.hand, ctx.contractSets, ctx.contractRuns);

  if (ranked.length === 0) return ctx.hand[0]; // fallback

  // Easy: sometimes discards from own partial melds (accident)
  if (ctx.tier === 'easy' && shouldMakeMistake(ctx.tier)) {
    // Pick a random card from the top half (higher points = more likely to discard)
    const topHalf = ranked.slice(0, Math.ceil(ranked.length / 2));
    return topHalf[Math.floor(Math.random() * topHalf.length)];
  }

  // Normal: usually picks best, sometimes second-best
  if (ctx.tier === 'normal' && shouldMakeMistake(ctx.tier) && ranked.length > 1) {
    return ranked[1]; // second-best choice
  }

  // Hard/Unfair: always best
  return ranked[0];
}

// ── Full turn orchestration ──
export function planTurn(ctx: TurnContext): TurnDecision {
  const drawFrom = decideDrawSource(ctx);

  // Simulate adding the drawn card (we won't know which until we actually draw,
  // but for discard draw we know the card)
  let handAfterDraw = [...ctx.hand];
  if (drawFrom === 'discard' && ctx.topDiscard) {
    handAfterDraw.push(ctx.topDiscard);
  }
  // For deck draw, we won't know the card until after the RPC call

  const melds = ctx.hasMetContract ? null : decideMelds({ ...ctx, hand: handAfterDraw });

  // After melding, calculate remaining hand
  let handAfterMeld = [...handAfterDraw];
  if (melds) {
    const usedCards = new Set(melds.flatMap(m => m.cards));
    handAfterMeld = handAfterMeld.filter(c => !usedCards.has(c));
  }

  const layOffs = decideLayOffs({
    ...ctx,
    hand: handAfterMeld,
    hasMetContract: ctx.hasMetContract || melds !== null
  });

  // After lay-offs
  let handAfterLayOffs = [...handAfterMeld];
  for (const lo of layOffs) {
    handAfterLayOffs = handAfterLayOffs.filter(c => c !== lo.card);
  }

  // Pick discard from remaining hand
  const discardCard = handAfterLayOffs.length > 0
    ? decideDiscard({ ...ctx, hand: handAfterLayOffs })
    : handAfterLayOffs[0]; // shouldn't happen

  return { drawFrom, melds, layOffs, extraMelds: [], discardCard };
}
