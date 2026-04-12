import { CardId, cardValue, cardSuit, isJoker } from '../_shared/types.ts';
import {
  bestContractSolution,
  rankDiscards,
  evaluateDiscardDraw,
  findLayOffs,
  helpsWeakerContract,
  MeldCandidate
} from './hand-analyzer.ts';
import { TierProfile, getTier, shouldMakeMistake, filterLayOffs } from './tiers.ts';

export interface TurnDecision {
  drawFrom: 'deck' | 'discard';
  melds: MeldCandidate[] | null; // contract fulfillment
  layOffs: { card: CardId; meld_id: string }[];
  extraMelds: MeldCandidate[];
  discardCard: CardId;
}

export interface TurnContext {
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

// ── DRAW DECISION ──
export function decideDrawSource(ctx: TurnContext): 'deck' | 'discard' {
  if (ctx.discardBought || !ctx.topDiscard) return 'deck';

  const profile = getTier(ctx.tier);
  const eval_ = evaluateDiscardDraw(
    ctx.hand, ctx.topDiscard, ctx.contractSets, ctx.contractRuns
  );

  // Non-speculative tiers: only take definitive helps, with mistake chance
  if (!profile.speculativePickups) {
    if (eval_.reason === 'enables_contract' || eval_.reason === 'completes_set' || eval_.reason === 'completes_run') {
      return shouldMakeMistake(profile) ? 'deck' : 'discard';
    }
    return 'deck';
  }

  // Speculative tiers: use the full evaluation
  if (eval_.takeDiscard) {
    // Enforce minimum match threshold for speculative pickups
    if (profile.minSpeculativeMatch > 1 && ctx.topDiscard) {
      const dv = cardValue(ctx.topDiscard);
      const ds = cardSuit(ctx.topDiscard);
      if (eval_.reason === 'builds_pair') {
        const sameVal = ctx.hand.filter(c => !isJoker(c) && cardValue(c) === dv).length;
        if (sameVal < profile.minSpeculativeMatch) return 'deck';
      }
      if (eval_.reason === 'extends_run') {
        const sameSuitAdj = ctx.hand.filter(c =>
          !isJoker(c) && cardSuit(c) === ds && Math.abs(cardValue(c) - dv) <= 1
        ).length;
        if (sameSuitAdj < profile.minSpeculativeMatch) return 'deck';
      }
    }
    return 'discard';
  }

  // Speculative pickups for weaker paths (builds_pair / extends_run that failed quality gate)
  if (eval_.reason === 'weaker_pair_path' || eval_.reason === 'weaker_run_path') {
    // Contract-weakness aware: only speculate if it helps the weaker dimension
    if (profile.contractWeaknessAware && ctx.topDiscard) {
      if (!helpsWeakerContract(ctx.hand, ctx.topDiscard, ctx.contractSets, ctx.contractRuns)) {
        return 'deck';
      }
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

  const profile = getTier(ctx.tier);
  if (profile.canMissContract && Math.random() < profile.missContractRate && ctx.roundNumber < 6) {
    return null; // "Didn't notice" they could meet contract
  }

  return solution;
}

// ── LAY OFF DECISION ──
export function decideLayOffs(ctx: TurnContext): { card: CardId; meld_id: string }[] {
  if (!ctx.hasMetContract) return [];

  const opportunities = findLayOffs(ctx.hand, ctx.melds);
  if (opportunities.length === 0) return [];

  return filterLayOffs(getTier(ctx.tier), opportunities);
}

// ── DISCARD DECISION ──
export function decideDiscard(ctx: TurnContext): CardId {
  const profile = getTier(ctx.tier);
  const tableMelds = profile.checksTableMelds ? ctx.melds : [];
  const ranked = rankDiscards(ctx.hand, ctx.contractSets, ctx.contractRuns, tableMelds);

  if (ranked.length === 0) return ctx.hand[0]; // fallback

  // Mistake: pick suboptimal discard
  if (shouldMakeMistake(profile)) {
    if (profile.mistakeRate >= 0.4) {
      // High mistake rate (Easy): random from top half
      const topHalf = ranked.slice(0, Math.ceil(ranked.length / 2));
      return topHalf[Math.floor(Math.random() * topHalf.length)];
    }
    if (ranked.length > 1) {
      return ranked[1]; // second-best choice
    }
  }

  return ranked[0];
}

// ── Full turn orchestration ──
export function planTurn(ctx: TurnContext): TurnDecision {
  const drawFrom = decideDrawSource(ctx);

  let handAfterDraw = [...ctx.hand];
  if (drawFrom === 'discard' && ctx.topDiscard) {
    handAfterDraw.push(ctx.topDiscard);
  }

  const melds = ctx.hasMetContract ? null : decideMelds({ ...ctx, hand: handAfterDraw });

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

  let handAfterLayOffs = [...handAfterMeld];
  for (const lo of layOffs) {
    handAfterLayOffs = handAfterLayOffs.filter(c => c !== lo.card);
  }

  const discardCard = handAfterLayOffs.length > 0
    ? decideDiscard({ ...ctx, hand: handAfterLayOffs })
    : handAfterLayOffs[0];

  return { drawFrom, melds, layOffs, extraMelds: [], discardCard };
}
