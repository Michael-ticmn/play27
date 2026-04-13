// ============================================================
// Round-Specific AI Strategy Profiles
// Modifiers applied on top of base TierProfile per round.
// To tune round behavior, edit the ROUND_PROFILES table below.
// ============================================================

import { TierProfile } from './tiers.ts';

// ── Round modifier interface ──
export interface RoundProfile {
  round: number;
  label: string;

  // Discard scoring weights (multipliers on set/run relevance in cardContractRelevance)
  setRelevanceWeight: number;       // 1.0 = normal, 1.3 = boost sets, 0.3 = suppress
  runRelevanceWeight: number;       // 1.0 = normal, 1.3 = boost runs, 0.3 = suppress

  // Isolation penalty for lone high cards with no run neighbors (discard scoring)
  isolationPenalty: number;         // 0 = off, -25 = strong penalty (added to discard score)

  // Draw source tuning
  speculativeThresholdAdjust: number;  // added to tier's minSpeculativeMatch (-1 = more aggressive)
  runGapFillBonus: number;             // bonus for gap-fill pickups in evaluateDiscardDraw

  // Contract miss rate scaling
  missContractMultiplier: number;   // multiplier on base missContractRate (0 = never miss, 1.5 = miss more)

  // Buy threshold adjustment
  buyThresholdAdjust: number;       // added to tier buy threshold (negative = more aggressive buying)

  // Lay-off detection boost
  layOffDetectionBoost: number;     // added to tier's layOffDetection (clamped 0-1)

  // Urgent meld threshold scaling
  urgentMeldScale: number;          // multiplier on urgentMeldThreshold (< 1.0 = urgency sooner)

  // Use R7-style gap-fill draw logic for run-heavy rounds
  useGapFillDraw: boolean;          // when true, applies evaluateRound7Draw-style adjacency for draw
}

// ── Effective profile: tier + round merged ──
export interface EffectiveProfile extends TierProfile {
  setRelevanceWeight: number;
  runRelevanceWeight: number;
  isolationPenalty: number;
  runGapFillBonus: number;
  buyThresholdAdjust: number;
  useGapFillDraw: boolean;
}

// ── Round profiles ──
// Starting values — tune these via training harness results

export const ROUND_PROFILES: Record<number, RoundProfile> = {
  1: {
    round: 1, label: '2 Sets (pure set hunting)',
    setRelevanceWeight: 1.3,
    runRelevanceWeight: 0.3,
    isolationPenalty: 0,
    speculativeThresholdAdjust: 0,
    runGapFillBonus: 0,
    missContractMultiplier: 1.5,
    buyThresholdAdjust: 0,
    layOffDetectionBoost: 0,
    urgentMeldScale: 1.0,
    useGapFillDraw: false,
  },

  2: {
    round: 2, label: '1 Set + 1 Run (mixed)',
    setRelevanceWeight: 1.0,
    runRelevanceWeight: 1.0,
    isolationPenalty: -10,
    speculativeThresholdAdjust: 0,
    runGapFillBonus: 10,
    missContractMultiplier: 1.2,
    buyThresholdAdjust: 0,
    layOffDetectionBoost: 0,
    urgentMeldScale: 1.0,
    useGapFillDraw: false,
  },

  3: {
    round: 3, label: '2 Runs (pure run building)',
    setRelevanceWeight: 0.3,
    runRelevanceWeight: 1.3,
    isolationPenalty: -25,
    speculativeThresholdAdjust: -1,
    runGapFillBonus: 20,
    missContractMultiplier: 1.0,
    buyThresholdAdjust: -10,
    layOffDetectionBoost: 0.05,
    urgentMeldScale: 0.95,
    useGapFillDraw: true,
  },

  4: {
    round: 4, label: '3 Sets (tight — 9 of 10 cards in sets)',
    setRelevanceWeight: 1.5,
    runRelevanceWeight: 0.1,
    isolationPenalty: 0,
    speculativeThresholdAdjust: -1,
    runGapFillBonus: 0,
    missContractMultiplier: 0.5,
    buyThresholdAdjust: -5,
    layOffDetectionBoost: 0.1,
    urgentMeldScale: 0.9,
    useGapFillDraw: false,
  },

  5: {
    round: 5, label: '2 Sets + 1 Run (mixed, 12 cards)',
    setRelevanceWeight: 1.1,
    runRelevanceWeight: 0.9,
    isolationPenalty: -10,
    speculativeThresholdAdjust: 0,
    runGapFillBonus: 10,
    missContractMultiplier: 0.5,
    buyThresholdAdjust: -5,
    layOffDetectionBoost: 0.15,
    urgentMeldScale: 0.85,
    useGapFillDraw: false,
  },

  6: {
    round: 6, label: '1 Set + 2 Runs (run-heavy, 12 cards)',
    setRelevanceWeight: 0.8,
    runRelevanceWeight: 1.2,
    isolationPenalty: -20,
    speculativeThresholdAdjust: -1,
    runGapFillBonus: 20,
    missContractMultiplier: 0.3,
    buyThresholdAdjust: -12,
    layOffDetectionBoost: 0.2,
    urgentMeldScale: 0.8,
    useGapFillDraw: true,
  },

  7: {
    round: 7, label: '3 Runs must-meld-all',
    setRelevanceWeight: 0.0,
    runRelevanceWeight: 1.5,
    isolationPenalty: -50,
    speculativeThresholdAdjust: -1,
    runGapFillBonus: 30,
    missContractMultiplier: 0.0,
    buyThresholdAdjust: -15,
    layOffDetectionBoost: 0.3,
    urgentMeldScale: 0.75,
    useGapFillDraw: true,
  },
};

// ── Resolver: merge TierProfile + RoundProfile → EffectiveProfile ──
export function resolveProfile(tier: TierProfile, roundNumber: number): EffectiveProfile {
  const rp = ROUND_PROFILES[roundNumber];

  // Backward-compat: no round profile → neutral defaults
  if (!rp) {
    return {
      ...tier,
      setRelevanceWeight: 1.0,
      runRelevanceWeight: 1.0,
      isolationPenalty: 0,
      runGapFillBonus: 0,
      buyThresholdAdjust: 0,
      useGapFillDraw: false,
    };
  }

  return {
    ...tier,

    // Scale minSpeculativeMatch (clamp to 0)
    minSpeculativeMatch: Math.max(0,
      tier.minSpeculativeMatch + rp.speculativeThresholdAdjust
    ),

    // Scale missContractRate
    missContractRate: Math.min(1.0, tier.missContractRate * rp.missContractMultiplier),

    // Boost layOffDetection (clamp 0-1)
    layOffDetection: Math.min(1.0, tier.layOffDetection + rp.layOffDetectionBoost),

    // Scale urgentMeldThreshold
    urgentMeldThreshold: Math.round(tier.urgentMeldThreshold * rp.urgentMeldScale),

    // Round-specific pass-through values
    setRelevanceWeight: rp.setRelevanceWeight,
    runRelevanceWeight: rp.runRelevanceWeight,
    isolationPenalty: rp.isolationPenalty,
    runGapFillBonus: rp.runGapFillBonus,
    buyThresholdAdjust: rp.buyThresholdAdjust,
    useGapFillDraw: rp.useGapFillDraw,
  };
}

// ── Convenience: get round profile directly ──
export function getRoundProfile(roundNumber: number): RoundProfile {
  return ROUND_PROFILES[roundNumber] ?? ROUND_PROFILES[1];
}
