// Tier-based delay ranges (milliseconds per action)
export const TIER_DELAYS: Record<string, { min: number; max: number }> = {
  easy:   { min: 3000, max: 6000 },
  normal: { min: 2000, max: 4000 },
  hard:   { min: 1500, max: 3000 },
  unfair: { min: 1000, max: 2500 },
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

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
