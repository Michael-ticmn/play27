import { CardId, cardValue, cardSuit, isJoker } from '../_shared/types.ts';
import {
  bestContractSolution,
  rankDiscards,
  rankDiscardsRound7,
  evaluateDiscardDraw,
  evaluateRound7Draw,
  r7SolverDraw,
  deckDrawProbability,
  findLayOffs,
  helpsWeakerContract,
  MeldCandidate
} from './hand-analyzer.ts';
import { TierProfile, getTier, shouldMakeMistake, filterLayOffs } from './tiers.ts';
import { resolveProfile, type EffectiveProfile } from './round-profiles.ts';
import { type CardMemory, opponentWantsValue } from './card-memory.ts';
import { type TableModel } from './opponent-model.ts';
import { type PlanState, isInPlan, getPlanTarget } from './plan-state.ts';

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
  totalScore: number;
  mustMeldAll: boolean;
  cardMemory?: CardMemory;
  tableModel?: TableModel;
  playerId?: string;
  gameSettings?: { numDecks: number; numJokers: number; maxBuys: number | null };
  plan?: PlanState;
}

// ── DRAW DECISION ──
export function decideDrawSource(ctx: TurnContext): 'deck' | 'discard' {
  if (ctx.discardBought || !ctx.topDiscard) return 'deck';

  const profile = resolveProfile(getTier(ctx.tier), ctx.roundNumber);

  // Plan-aware draw: if discard matches an active plan target with evidence, take it
  if (ctx.plan && ctx.topDiscard && !isJoker(ctx.topDiscard)) {
    const dv = cardValue(ctx.topDiscard);
    const target = getPlanTarget(ctx.plan, dv);
    if (target && target.held >= 1) {
      return shouldMakeMistake(profile, ctx.totalScore) ? 'deck' : 'discard';
    }
  }

  // Round 7: solver-based draw — checks if taking the discard creates or improves
  // a path to must-meld-all solution
  if (ctx.mustMeldAll) {
    const r7 = r7SolverDraw(ctx.hand, ctx.topDiscard);
    if (r7.takeDiscard) {
      return shouldMakeMistake(profile, ctx.totalScore) ? 'deck' : 'discard';
    }
    return 'deck';
  }

  const totalPerValue = (ctx.gameSettings?.numDecks ?? 2) * 4;
  const eval_ = evaluateDiscardDraw(
    ctx.hand, ctx.topDiscard, ctx.contractSets, ctx.contractRuns, ctx.cardMemory, totalPerValue
  );

  // Non-speculative tiers: only take definitive helps, with mistake chance
  if (!profile.speculativePickups) {
    if (eval_.reason === 'enables_contract' || eval_.reason === 'completes_set' || eval_.reason === 'completes_run') {
      return shouldMakeMistake(profile, ctx.totalScore) ? 'deck' : 'discard';
    }
    return 'deck';
  }

  // Speculative tiers: use the full evaluation
  if (eval_.takeDiscard) {
    // Enforce minimum match threshold for speculative pickups
    // When urgent (high score), loosen to 1 so Normal plays like Hard
    const urgent = ctx.totalScore >= profile.urgentMeldThreshold;
    const minMatch = urgent ? Math.min(profile.minSpeculativeMatch, 1) : profile.minSpeculativeMatch;
    if (minMatch > 1 && ctx.topDiscard) {
      const dv = cardValue(ctx.topDiscard);
      const ds = cardSuit(ctx.topDiscard);
      if (eval_.reason === 'builds_pair') {
        const sameVal = ctx.hand.filter(c => !isJoker(c) && cardValue(c) === dv).length;
        if (sameVal < minMatch) return 'deck';
      }
      if (eval_.reason === 'extends_run') {
        const sameSuitAdj = ctx.hand.filter(c =>
          !isJoker(c) && cardSuit(c) === ds && Math.abs(cardValue(c) - dv) <= 1
        ).length;
        if (sameSuitAdj < minMatch) return 'deck';
      }
    }

    // Run-specific speculation gate: require N adjacent same-suit cards for run pickups
    // Prevents tempo-losing speculative pickups in run-heavy rounds
    if (profile.minSpeculativeRunMatch > 0 && eval_.reason === 'extends_run' && ctx.topDiscard) {
      const ds = cardSuit(ctx.topDiscard);
      const dv = cardValue(ctx.topDiscard);
      const sameSuitAdj = ctx.hand.filter(c =>
        !isJoker(c) && cardSuit(c) === ds && Math.abs(cardValue(c) - dv) <= 1
      ).length;
      if (sameSuitAdj < profile.minSpeculativeRunMatch) return 'deck';
    }

    // Contract weakness gate: for mixed contracts, reject speculative pickups
    // that advance the stronger dimension while the weaker one is lagging
    if (profile.contractWeaknessAware && ctx.topDiscard &&
        (eval_.reason === 'builds_pair' || eval_.reason === 'extends_run')) {
      if (!helpsWeakerContract(ctx.hand, ctx.topDiscard, ctx.contractSets, ctx.contractRuns)) {
        return 'deck';
      }
    }

    // Deck probability gate (Unfair): if the deck is rich with helpful cards,
    // skip marginal speculative pickups and draw from deck instead.
    // Disabled for run-heavy rounds where P(helpful) is naturally high with 2-deck runs.
    if (!profile.disableDeckProbabilityGate &&
        profile.cardMemoryDepth === Infinity && ctx.cardMemory &&
        (eval_.reason === 'builds_pair' || eval_.reason === 'extends_run')) {
      const numDecks = ctx.gameSettings?.numDecks ?? 2;
      const pDeck = deckDrawProbability(
        ctx.hand, ctx.contractSets, ctx.contractRuns,
        ctx.cardMemory.visibleCards, numDecks
      );
      // >25% of unseen cards help → deck is very rich, skip marginal pickup
      if (pDeck > 0.25) return 'deck';
    }

    return 'discard';
  }

  // Speculative pickups for weaker paths (builds_pair / extends_run that failed quality gate)
  if (eval_.reason === 'weaker_pair_path' || eval_.reason === 'weaker_run_path') {
    // Run-specific gate for weaker paths too
    if (profile.minSpeculativeRunMatch > 0 && eval_.reason === 'weaker_run_path' && ctx.topDiscard) {
      const ds = cardSuit(ctx.topDiscard);
      const dv = cardValue(ctx.topDiscard);
      const sameSuitAdj = ctx.hand.filter(c =>
        !isJoker(c) && cardSuit(c) === ds && Math.abs(cardValue(c) - dv) <= 1
      ).length;
      if (sameSuitAdj < profile.minSpeculativeRunMatch) return 'deck';
    }
    // Contract-weakness aware: only speculate if it helps the weaker dimension
    if (profile.contractWeaknessAware && ctx.topDiscard) {
      if (!helpsWeakerContract(ctx.hand, ctx.topDiscard, ctx.contractSets, ctx.contractRuns)) {
        return 'deck';
      }
    }
    // Deck probability gate (Unfair): weaker paths need even less deck richness to skip
    if (!profile.disableDeckProbabilityGate &&
        profile.cardMemoryDepth === Infinity && ctx.cardMemory) {
      const numDecks = ctx.gameSettings?.numDecks ?? 2;
      const pDeck = deckDrawProbability(
        ctx.hand, ctx.contractSets, ctx.contractRuns,
        ctx.cardMemory.visibleCards, numDecks
      );
      if (pDeck > 0.18) return 'deck';
    }
    return 'discard';
  }

  // Run-heavy round fallback: use R7-style gap-fill draw logic for R3/R6
  if (profile.useGapFillDraw && ctx.topDiscard) {
    const r7 = evaluateRound7Draw(ctx.hand, ctx.topDiscard);
    if (r7.takeDiscard) {
      return shouldMakeMistake(profile, ctx.totalScore) ? 'deck' : 'discard';
    }
  }

  return 'deck';
}

// ── MELD DECISION ──
export function decideMelds(ctx: TurnContext): MeldCandidate[] | null {
  if (ctx.hasMetContract) return null;

  const solution = bestContractSolution(ctx.hand, ctx.contractSets, ctx.contractRuns, 3, ctx.mustMeldAll);
  if (!solution) return null;

  const profile = resolveProfile(getTier(ctx.tier), ctx.roundNumber);
  // missContractRate is already scaled by round (missContractMultiplier in resolveProfile)
  if (profile.canMissContract && Math.random() < profile.missContractRate) {
    return null; // "Didn't notice" they could meet contract
  }

  return solution;
}

// ── LAY OFF DECISION ──
export function decideLayOffs(ctx: TurnContext): { card: CardId; meld_id: string }[] {
  if (!ctx.hasMetContract) return [];

  const opportunities = findLayOffs(ctx.hand, ctx.melds);
  if (opportunities.length === 0) return [];

  const profile = resolveProfile(getTier(ctx.tier), ctx.roundNumber);
  return filterLayOffs(profile, opportunities);
}

// ── DISCARD DECISION ──
export function decideDiscard(ctx: TurnContext): CardId {
  const profile = resolveProfile(getTier(ctx.tier), ctx.roundNumber);
  const tableMelds = profile.checksTableMelds ? ctx.melds : [];
  const roundWeights = {
    setWeight: profile.setRelevanceWeight,
    runWeight: profile.runRelevanceWeight,
    isolationPenalty: profile.isolationPenalty,
  };
  const tpv = (ctx.gameSettings?.numDecks ?? 2) * 4;
  const tableModel = profile.disableFeedStrategy ? undefined : ctx.tableModel;
  let ranked = rankDiscards(ctx.hand, ctx.contractSets, ctx.contractRuns, tableMelds, [], ctx.hasMetContract, roundWeights, ctx.cardMemory, tableModel, tpv);

  if (ranked.length === 0) return ctx.hand[0]; // fallback

  // Plan-aware reranking: tier-scaled influence on discard order
  // Normal: gentle nudge. Hard: moderate guide. Unfair: strong directive.
  // Plan influence by tier: Normal = gentle nudge, Hard = moderate guide
  // Easy/Unfair have no plan (skipped in game-loop), but zero entries for safety
  const planKeepBonus: Record<string, number> = { easy: 0, normal: 30, hard: 60, unfair: 0 };
  const planShedBonus: Record<string, number> = { easy: 0, normal: 5, hard: 15, unfair: 0 };
  const keepBonus = planKeepBonus[ctx.tier] ?? 0;
  const shedBonus = planShedBonus[ctx.tier] ?? 0;

  if (ctx.plan && !ctx.hasMetContract && ranked.length > 1 && (keepBonus > 0 || shedBonus > 0)) {
    // Score each card: higher = better to discard (ranked[0] is best discard)
    // Base position score: first card = 0 (best discard), last = N-1 (worst discard)
    // Plan confidence scales with evidence in hand
    // Pairs = strong commitment, singletons = tentative, empty = no commitment
    const planConfidence = (t: { held: number }) =>
      t.held >= 2 ? 1.0 : t.held === 1 ? 0.3 : 0.0;

    const scored = ranked.map((card, i) => {
      let score = i; // base: preserve rankDiscards ordering
      if (!isJoker(card)) {
        const target = getPlanTarget(ctx.plan!, cardValue(card));
        if (target) {
          score += keepBonus * planConfidence(target);
        } else {
          // Off-plan card: shed bonus scaled by average confidence of active targets
          const activeTargets = ctx.plan!.targets.filter(t => t.status === 'active');
          const avgConf = activeTargets.length > 0
            ? activeTargets.reduce((sum, t) => sum + planConfidence(t), 0) / activeTargets.length
            : 0;
          score -= shedBonus * avgConf;
        }
      }
      return { card, score };
    });
    scored.sort((a, b) => a.score - b.score);
    ranked = scored.map(s => s.card);
  }

  // Mistake: pick suboptimal discard
  if (shouldMakeMistake(profile, ctx.totalScore)) {
    if (profile.mistakeRate >= 0.2) {
      // Moderate+ mistake rate (Easy + Normal): random from top half
      const topHalf = ranked.slice(0, Math.ceil(ranked.length / 2));
      return topHalf[Math.floor(Math.random() * topHalf.length)];
    }
    if (ranked.length > 1) {
      return ranked[1]; // second-best choice (Hard only — 5% rate)
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
