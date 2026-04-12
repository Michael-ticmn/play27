// Tier-based delay ranges (milliseconds per action)
export const TIER_DELAYS: Record<string, { min: number; max: number }> = {
  easy:   { min: 1500, max: 3000 },
  normal: { min: 1000, max: 2000 },
  hard:   { min: 700, max: 1500 },
  unfair: { min: 400, max: 1000 },
};

// Pre-draw delay — time to "look at" the discard before drawing (ms)
// Gives humans time to see what was discarded before AI acts
export const PRE_DRAW_DELAY: Record<string, { min: number; max: number }> = {
  easy:   { min: 8000, max: 12000 },
  normal: { min: 6000, max: 10000 },
  hard:   { min: 4000, max: 7000 },
  unfair: { min: 3000, max: 5000 },
};

// Buy window timing — fraction of countdown to target
export const BUY_TIMING: Record<string, { earliest: number; latest: number }> = {
  easy:   { earliest: 0.7, latest: 0.95 }, // last 30%
  normal: { earliest: 0.25, latest: 0.75 }, // middle 50%
  hard:   { earliest: 0.05, latest: 0.5 },  // first 50%
  unfair: { earliest: 0.05, latest: 0.3 },  // first 30%
};

export function randomDelay(tier: string): number {
  const range = TIER_DELAYS[tier] || TIER_DELAYS.normal;
  return range.min + Math.random() * (range.max - range.min);
}

export function preDrawDelay(tier: string): number {
  const range = PRE_DRAW_DELAY[tier] || PRE_DRAW_DELAY.normal;
  return range.min + Math.random() * (range.max - range.min);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
