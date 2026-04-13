// ── Centralized AI Tier Profiles ──
// Single source of truth for all tier-specific behavior.
// To tune AI behavior, edit ONLY this file.

export interface TierProfile {
  // ── Timing (milliseconds) ──
  actionDelay: { min: number; max: number };
  preDrawDelay: { min: number; max: number };
  buyWindow: { earliest: number; latest: number };

  // ── Decision quality ──
  mistakeRate: number;       // 0.0–1.0: chance of suboptimal choice per decision
  layOffDetection: number;   // 0.0–1.0: fraction of lay-off opportunities noticed

  // ── Table awareness ──
  checksTableMelds: boolean; // considers opponent melds when discarding

  // ── Draw behavior ──
  speculativePickups: boolean;      // takes discard to build partials (not just completions)
  minSpeculativeMatch: number;      // minimum same-value cards in hand before speculating (2 = need pair already)
  contractWeaknessAware: boolean;   // biases speculation toward weaker contract dimension
  postContractSpeculation: boolean; // speculates on discard after contract is met (not just lay-offs)

  // ── Contract detection ──
  canMissContract: boolean;   // can "not notice" a completable contract
  missContractRate: number;   // probability of missing (only if canMissContract)
  urgentMeldThreshold: number; // total score at which urgency kicks in
  urgentMistakeRate: number;  // reduced mistake rate when score >= urgentMeldThreshold

  // ── Card memory ──
  cardMemoryDepth: number;          // 0=none, 1=last discard per player, 20=recent, Infinity=full
  tracksOpponentPickups: boolean;   // track what opponents draw from discard / buy
}

export const TIERS: Record<string, TierProfile> = {
  easy: {
    actionDelay:      { min: 1500, max: 3000 },
    preDrawDelay:     { min: 8000, max: 12000 },
    buyWindow:        { earliest: 0.7, latest: 0.95 },

    mistakeRate:             0.5,
    layOffDetection:         0.15,

    checksTableMelds:        false,

    speculativePickups:      false,
    minSpeculativeMatch:     0,
    contractWeaknessAware:   false,
    postContractSpeculation: false,

    canMissContract:         true,
    missContractRate:        0.2,
    urgentMeldThreshold:     150,
    urgentMistakeRate:       0.5,   // Easy stays Easy even when urgent

    cardMemoryDepth:         0,
    tracksOpponentPickups:   false,
  },

  normal: {
    actionDelay:      { min: 1000, max: 2000 },
    preDrawDelay:     { min: 6000, max: 10000 },
    buyWindow:        { earliest: 0.25, latest: 0.75 },

    mistakeRate:             0.3,
    layOffDetection:         0.7,

    checksTableMelds:        true,

    speculativePickups:      true,
    minSpeculativeMatch:     2,
    contractWeaknessAware:   true,
    postContractSpeculation: false,

    canMissContract:         false,
    missContractRate:        0,
    urgentMeldThreshold:     200,
    urgentMistakeRate:       0.15,  // drops from 30% → 15% when score >= 200

    cardMemoryDepth:         10,    // remembers last 10 actions — recent pickups/buys
    tracksOpponentPickups:   true,  // tracks what opponents grab from discard
  },

  hard: {
    actionDelay:      { min: 700, max: 1500 },
    preDrawDelay:     { min: 4000, max: 7000 },
    buyWindow:        { earliest: 0.05, latest: 0.5 },

    mistakeRate:             0.05,
    layOffDetection:         1.0,

    checksTableMelds:        true,

    speculativePickups:      true,
    minSpeculativeMatch:     1,
    contractWeaknessAware:   true,
    postContractSpeculation: true,

    canMissContract:         false,
    missContractRate:        0,
    urgentMeldThreshold:     150,
    urgentMistakeRate:       0.05,  // drops from 10% → 5% when urgent

    cardMemoryDepth:         20,    // last 20 actions — recent context
    tracksOpponentPickups:   true,
  },

  unfair: {
    actionDelay:      { min: 400, max: 1000 },
    preDrawDelay:     { min: 3000, max: 5000 },
    buyWindow:        { earliest: 0.05, latest: 0.3 },

    mistakeRate:             0.0,
    layOffDetection:         1.0,

    checksTableMelds:        true,

    speculativePickups:      true,
    minSpeculativeMatch:     1,
    contractWeaknessAware:   true,
    postContractSpeculation: true,

    canMissContract:         false,
    missContractRate:        0,
    urgentMeldThreshold:     150,
    urgentMistakeRate:       0.0,   // already perfect

    cardMemoryDepth:         Infinity,  // full round history — sees everything
    tracksOpponentPickups:   true,
  },
};

// ── Helper: get profile with fallback to normal ──
export function getTier(tier: string): TierProfile {
  return TIERS[tier] || TIERS.normal;
}

// ── Helper: roll a mistake check (uses reduced rate when score is urgent) ──
export function shouldMakeMistake(profile: TierProfile, totalScore = 0): boolean {
  const rate = totalScore >= profile.urgentMeldThreshold
    ? profile.urgentMistakeRate
    : profile.mistakeRate;
  return Math.random() < rate;
}

// ── Helper: random delay from tier range ──
export function randomDelay(profile: TierProfile): number {
  const { min, max } = profile.actionDelay;
  return min + Math.random() * (max - min);
}

// ── Helper: pre-draw delay from tier range ──
export function preDrawDelay(profile: TierProfile): number {
  const { min, max } = profile.preDrawDelay;
  return min + Math.random() * (max - min);
}

// ── Helper: filter lay-offs by detection rate ──
export function filterLayOffs<T>(profile: TierProfile, layoffs: T[]): T[] {
  if (profile.layOffDetection >= 1.0) return layoffs;
  return layoffs.filter(() => Math.random() < profile.layOffDetection);
}
