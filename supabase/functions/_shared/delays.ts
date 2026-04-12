// Shared delay utilities
// AI turn timing constants live in ai-turn/tiers.ts
// Buy timing stays here since ai-buy uses it independently

export const BUY_TIMING: Record<string, { earliest: number; latest: number }> = {
  easy:   { earliest: 0.7, latest: 0.95 },
  normal: { earliest: 0.25, latest: 0.75 },
  hard:   { earliest: 0.05, latest: 0.5 },
  unfair: { earliest: 0.05, latest: 0.3 },
};

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
