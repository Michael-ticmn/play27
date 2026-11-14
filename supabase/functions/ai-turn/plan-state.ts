// ============================================================
// AI Planning Layer — Persistent Set Targeting
// Maintains target tracking across turns within a round.
// Phase 1: Sets only (R4 as test round).
// ============================================================

import { CardId, cardValue, isJoker } from '../_shared/types.ts';
import { groupByValue } from './hand-analyzer.ts';
import { type CardMemory } from './card-memory.ts';
import { type TierProfile } from './tiers.ts';

// ── Types ──

export interface PlanTarget {
  value: number;           // card value (2-14)
  held: number;            // cards of this value currently in hand
  needed: number;          // cards still needed (3 - held, minimum 0)
  remaining: number;       // cards of this value unseen (not in hand, not visible)
  status: 'active' | 'complete' | 'abandoned';
}

export interface PivotEntry {
  turn: number;
  abandonedValue: number;
  reason: 'dead' | 'early_panic' | 'late_stubbornness';
  replacementValue: number;
}

export interface PlanState {
  targets: PlanTarget[];   // exactly requiredSets targets
  lastUpdated: number;     // turn number of last update
  pivotCount: number;
  pivotLog: PivotEntry[];
}

// ── Helpers ──

/** Count how many of a given value are unseen (not in hand, not visible). */
function unseenCount(
  value: number,
  heldCount: number,
  memory: CardMemory | null,
  totalPerValue: number
): number {
  if (!memory) {
    // No memory: assume all non-held cards are available
    return totalPerValue - heldCount;
  }
  // Count visible cards of this value (discard pile, melds, etc.)
  let visibleOfValue = 0;
  for (const card of memory.visibleCards) {
    if (!isJoker(card) && cardValue(card) === value) {
      visibleOfValue++;
    }
  }
  // Remaining = total - held - visible (but don't double-count held cards that are also visible)
  // visibleCards does NOT include our hand, so no overlap
  return Math.max(0, totalPerValue - heldCount - visibleOfValue);
}

/** Rank candidate values for set targets, best first. */
function rankCandidateValues(
  hand: CardId[],
  memory: CardMemory | null,
  totalPerValue: number,
  excludeValues: Set<number>
): { value: number; held: number; remaining: number }[] {
  const byValue = groupByValue(hand);
  const candidates: { value: number; held: number; remaining: number }[] = [];

  for (const [value, cards] of byValue) {
    if (excludeValues.has(value)) continue;
    const held = cards.length;
    const remaining = unseenCount(value, held, memory, totalPerValue);
    candidates.push({ value, held, remaining });
  }

  // Sort: held count descending (primary), remaining descending (secondary)
  candidates.sort((a, b) => {
    if (b.held !== a.held) return b.held - a.held;
    return b.remaining - a.remaining;
  });

  return candidates;
}

// ── Initialization ──

/** Create initial plan after cards are dealt. */
export function initializePlan(
  hand: CardId[],
  requiredSets: number,
  memory: CardMemory | null,
  totalPerValue: number
): PlanState {
  const candidates = rankCandidateValues(hand, memory, totalPerValue, new Set());
  const targets: PlanTarget[] = [];

  for (let i = 0; i < requiredSets && i < candidates.length; i++) {
    const c = candidates[i];
    const needed = Math.max(0, 3 - c.held);
    targets.push({
      value: c.value,
      held: c.held,
      needed,
      remaining: c.remaining,
      status: needed === 0 ? 'complete' : 'active',
    });
  }

  // If hand has fewer distinct values than requiredSets, fill with best unseen
  // This shouldn't happen in normal play but handle gracefully
  if (targets.length < requiredSets) {
    const usedValues = new Set(targets.map(t => t.value));
    // Look at ALL values 2-14, not just those in hand
    for (let v = 2; v <= 14 && targets.length < requiredSets; v++) {
      if (usedValues.has(v)) continue;
      const remaining = unseenCount(v, 0, memory, totalPerValue);
      if (remaining >= 3) {
        targets.push({
          value: v,
          held: 0,
          needed: 3,
          remaining,
          status: 'active',
        });
        usedValues.add(v);
      }
    }
  }

  return {
    targets,
    lastUpdated: 0,
    pivotCount: 0,
    pivotLog: [],
  };
}

// ── Update ──

/** Update plan with current hand state. Returns true if any pivot occurred. */
export function updatePlan(
  plan: PlanState,
  hand: CardId[],
  memory: CardMemory | null,
  totalPerValue: number,
  turn: number,
  tier: TierProfile,
  requiredSets: number
): boolean {
  const byValue = groupByValue(hand);
  let pivoted = false;

  for (let i = 0; i < plan.targets.length; i++) {
    const target = plan.targets[i];
    if (target.status === 'abandoned') continue;

    // Recalculate held and remaining
    const heldCards = byValue.get(target.value) || [];
    target.held = heldCards.length;
    target.remaining = unseenCount(target.value, target.held, memory, totalPerValue);
    target.needed = Math.max(0, 3 - target.held);

    // Mark complete
    if (target.held >= 3) {
      target.status = 'complete';
      continue;
    }

    // Check pivot
    const pivotDecision = shouldPivot(target, tier, memory, turn, plan);
    if (pivotDecision === 'pivot') {
      // Find replacement
      const usedValues = new Set(plan.targets.map(t => t.value));
      const candidates = rankCandidateValues(hand, memory, totalPerValue, usedValues);
      const replacement = candidates[0];

      if (replacement) {
        const reason = target.remaining <= 0 ? 'dead' as const : 'early_panic' as const;
        plan.pivotLog.push({
          turn,
          abandonedValue: target.value,
          reason,
          replacementValue: replacement.value,
        });

        // Replace target in-place
        plan.targets[i] = {
          value: replacement.value,
          held: replacement.held,
          needed: Math.max(0, 3 - replacement.held),
          remaining: replacement.remaining,
          status: replacement.held >= 3 ? 'complete' : 'active',
        };
        plan.pivotCount++;
        pivoted = true;
      }
    }
  }

  plan.lastUpdated = turn;
  return pivoted;
}

// ── Pivot Logic (tier-dependent) ──

function shouldPivot(
  target: PlanTarget,
  tier: TierProfile,
  _memory: CardMemory | null,
  _turn: number,
  _plan: PlanState
): 'hold' | 'pivot' {
  // Easy: no plan, no pivots (shouldn't reach here but guard)
  if (tier.cardMemoryDepth === 0) return 'hold';

  // Unfair: perfect memory, instant pivot
  if (tier.cardMemoryDepth === Infinity) {
    return shouldPivotUnfair(target);
  }

  // Hard: correct pivot, may be 1 turn late due to memory decay
  if (tier.cardMemoryDepth >= 20) {
    return shouldPivotHard(target);
  }

  // Normal: emotional pivot timing
  return shouldPivotNormal(target);
}

function shouldPivotUnfair(target: PlanTarget): 'hold' | 'pivot' {
  if (target.remaining <= 0) return 'pivot';
  // Proactive: remaining = 1 but need 2+ more → very low odds
  if (target.needed >= 2 && target.remaining <= 1) return 'pivot';
  return 'hold';
}

function shouldPivotHard(target: PlanTarget): 'hold' | 'pivot' {
  if (target.remaining <= 0) {
    // Hard's memory may be stale — 30% chance of missing the death for 1 turn
    if (Math.random() < 0.30) return 'hold'; // delayed awareness
    return 'pivot';
  }
  return 'hold';
}

function shouldPivotNormal(target: PlanTarget): 'hold' | 'pivot' {
  if (target.remaining <= 0) {
    // Path is dead, but Normal may stubbornly hold
    if (Math.random() < 0.30) return 'hold'; // 30% stubbornness
    return 'pivot';
  }

  // Path is weak but not dead
  if (target.remaining <= 2 && target.held < 2) {
    if (Math.random() < 0.40) return 'pivot'; // 40% panic
    return 'hold';
  }

  return 'hold';
}

// ── Query Helpers ──

/** Check if a card value matches an active plan target. */
export function isInPlan(plan: PlanState, value: number): boolean {
  return plan.targets.some(t => t.status === 'active' && t.value === value);
}

/** Get the active target for a card value, if any. */
export function getPlanTarget(plan: PlanState, value: number): PlanTarget | undefined {
  return plan.targets.find(t => t.status === 'active' && t.value === value);
}

/** Count how many targets are complete. */
export function completedTargets(plan: PlanState): number {
  return plan.targets.filter(t => t.status === 'complete').length;
}

/** Get diagnostic summary for this plan. */
export function getPlanDiagnostics(plan: PlanState): Record<string, unknown> {
  return {
    plan_targets_initial: plan.targets.length,
    plan_pivots: plan.pivotCount,
    plan_pivot_log: plan.pivotLog,
    plan_target_completion: plan.targets.filter(t => t.status === 'complete').length,
    plan_targets_status: plan.targets.map(t => ({
      value: t.value,
      held: t.held,
      needed: t.needed,
      remaining: t.remaining,
      status: t.status,
    })),
  };
}
