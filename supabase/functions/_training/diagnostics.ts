// ============================================================
// Training Harness — Diagnostics
// Per-player counters and feed payoff tracking for measuring
// whether smart features (memory, opponent model, feed strategy)
// actually change outcomes.
// ============================================================

import { CardId, cardValue, cardSuit, isJoker } from '../_shared/types.ts';
import {
  evaluateDiscardDraw,
  rankDiscards,
  findLayOffs,
} from '../ai-turn/hand-analyzer.ts';
import { type CardMemory } from '../ai-turn/card-memory.ts';
import { type TableModel, feedLayOffBonus } from '../ai-turn/opponent-model.ts';

// ── Per-player diagnostic counters (reset each game) ──
export interface PlayerDiagnostics {
  seat: number;
  tier: string;

  // Decision divergence
  decisions_total: number;
  decisions_diverged: number;

  // Speculative pickups
  speculative_pickups: number;
  speculative_pickups_used: number; // tracked at lay-off/meld time

  // Post-contract speculation
  post_contract_pickups: number;
  post_contract_pickups_used: number;

  // Feed strategy
  feed_attempts: number;
  feed_payoffs: number;

  // Table awareness cost
  table_awareness_holds: number;
  table_awareness_deadwood_cost: number;

  // Lay-off detection
  layoff_opportunities_total: number;
  layoff_opportunities_taken: number;
  layoff_opportunities_missed: number;

  // Contract timing
  turns_to_contract: number;
  turns_post_contract: number;

  // Hand bloat
  max_hand_size: number;
  hand_size_at_round_end: number;
  hand_size_at_contract: number;
}

// ── Feed discard entry (for tracking payoffs) ──
interface FeedEntry {
  card: CardId;
  cardValue: number;
  turnNumber: number;
}

// ── Speculative pickup entry (for tracking if used) ──
interface SpecPickup {
  card: CardId;
  turnNumber: number;
  postContract: boolean;
}

// ── Game-level diagnostics state ──
export interface GameDiagnostics {
  players: Map<number, PlayerDiagnostics>;
  feedLog: Map<number, FeedEntry[]>;       // seat → pending feeds
  specLog: Map<number, SpecPickup[]>;      // seat → speculative pickups
}

// ── Initialize diagnostics for a game ──
export function initGameDiagnostics(
  seats: { seat: number; tier: string }[]
): GameDiagnostics {
  const players = new Map<number, PlayerDiagnostics>();
  const feedLog = new Map<number, FeedEntry[]>();
  const specLog = new Map<number, SpecPickup[]>();

  for (const s of seats) {
    players.set(s.seat, {
      seat: s.seat,
      tier: s.tier,
      decisions_total: 0,
      decisions_diverged: 0,
      speculative_pickups: 0,
      speculative_pickups_used: 0,
      post_contract_pickups: 0,
      post_contract_pickups_used: 0,
      feed_attempts: 0,
      feed_payoffs: 0,
      table_awareness_holds: 0,
      table_awareness_deadwood_cost: 0,
      layoff_opportunities_total: 0,
      layoff_opportunities_taken: 0,
      layoff_opportunities_missed: 0,
      turns_to_contract: 0,
      turns_post_contract: 0,
      max_hand_size: 0,
      hand_size_at_round_end: 0,
      hand_size_at_contract: 0,
    });
    feedLog.set(s.seat, []);
    specLog.set(s.seat, []);
  }

  return { players, feedLog, specLog };
}

// ── Baseline draw decision (no memory/opponent model) ──
export function baselineDrawDecision(
  hand: CardId[],
  topDiscard: CardId,
  contractSets: number,
  contractRuns: number,
  totalPerValue: number,
): 'deck' | 'discard' {
  // Re-run evaluation WITHOUT card memory — pure heuristic
  const eval_ = evaluateDiscardDraw(
    hand, topDiscard, contractSets, contractRuns, undefined, totalPerValue
  );
  if (eval_.takeDiscard &&
      (eval_.reason === 'enables_contract' || eval_.reason === 'completes_set' ||
       eval_.reason === 'completes_run' || eval_.reason === 'joker')) {
    return 'discard';
  }
  return 'deck';
}

// ── Baseline discard decision (no table awareness, no feed bonus) ──
export function baselineDiscardDecision(
  hand: CardId[],
  contractSets: number,
  contractRuns: number,
  hasMetContract: boolean,
  totalPerValue: number,
): CardId {
  // rankDiscards with no tableMelds, no memory, no tableModel
  const ranked = rankDiscards(
    hand, contractSets, contractRuns,
    [], // no table melds
    [], // no protected
    hasMetContract,
    undefined, // no round weights (use defaults)
    undefined, // no card memory
    undefined, // no table model
    totalPerValue
  );
  return ranked[0] || hand[0];
}

// ── Measure table awareness cost ──
// Compare discard ranking with and without table melds to find cards
// being held purely because of table awareness.
export function measureTableAwarenessCost(
  hand: CardId[],
  contractSets: number,
  contractRuns: number,
  tableMelds: { id: string; meld_type: string; cards: CardId[] }[],
  hasMetContract: boolean,
  cardMemory: CardMemory | undefined,
  tableModel: TableModel | undefined,
  roundWeights: { setWeight: number; runWeight: number; isolationPenalty: number } | undefined,
  totalPerValue: number,
): { holds: number; deadwoodCost: number } {
  if (tableMelds.length === 0) return { holds: 0, deadwoodCost: 0 };

  // Rank with full awareness
  const withAwareness = rankDiscards(
    hand, contractSets, contractRuns, tableMelds, [],
    hasMetContract, roundWeights, cardMemory, tableModel, totalPerValue
  );
  // Rank without table melds
  const withoutAwareness = rankDiscards(
    hand, contractSets, contractRuns, [], [],
    hasMetContract, roundWeights, cardMemory, tableModel, totalPerValue
  );

  // The "best discard" changed — cards held due to awareness
  if (withAwareness[0] === withoutAwareness[0]) return { holds: 0, deadwoodCost: 0 };

  // Count how many cards shifted position due to table awareness
  let holds = 0;
  let deadwoodCost = 0;
  const topWithout = new Set(withoutAwareness.slice(0, 3));
  const topWith = new Set(withAwareness.slice(0, 3));

  for (const card of topWithout) {
    if (!topWith.has(card)) {
      // This card would have been discarded but is being held
      holds++;
      deadwoodCost += isJoker(card) ? 25 : (cardValue(card) >= 11 ? 10 : cardValue(card));
    }
  }

  return { holds, deadwoodCost };
}

// ── Track a speculative pickup ──
export function trackSpecPickup(
  diag: GameDiagnostics,
  seat: number,
  card: CardId,
  turnNumber: number,
  postContract: boolean,
): void {
  const p = diag.players.get(seat);
  if (!p) return;
  if (postContract) {
    p.post_contract_pickups++;
  } else {
    p.speculative_pickups++;
  }
  diag.specLog.get(seat)?.push({ card, turnNumber, postContract });
}

// ── Track a feed attempt ──
export function trackFeedAttempt(
  diag: GameDiagnostics,
  seat: number,
  card: CardId,
  turnNumber: number,
): void {
  const p = diag.players.get(seat);
  if (!p) return;
  p.feed_attempts++;
  diag.feedLog.get(seat)?.push({ card, cardValue: cardValue(card), turnNumber });
}

// ── Check lay-offs against feed log (feed payoff?) ──
export function checkFeedPayoff(
  diag: GameDiagnostics,
  seat: number,
  layoffCard: CardId,
  meldCards: CardId[],
): boolean {
  const feeds = diag.feedLog.get(seat);
  const p = diag.players.get(seat);
  if (!feeds || !p || feeds.length === 0) return false;

  const lv = cardValue(layoffCard);
  // Check if any pending feed matches this lay-off
  const idx = feeds.findIndex(f => f.cardValue === lv);
  if (idx >= 0) {
    p.feed_payoffs++;
    feeds.splice(idx, 1); // consumed
    return true;
  }
  return false;
}

// ── Check melds/lay-offs against spec pickup log ──
export function checkSpecUsed(
  diag: GameDiagnostics,
  seat: number,
  usedCards: Set<CardId>,
): void {
  const specs = diag.specLog.get(seat);
  const p = diag.players.get(seat);
  if (!specs || !p) return;

  for (let i = specs.length - 1; i >= 0; i--) {
    if (usedCards.has(specs[i].card)) {
      if (specs[i].postContract) {
        p.post_contract_pickups_used++;
      } else {
        p.speculative_pickups_used++;
      }
      specs.splice(i, 1);
    }
  }
}

// ── Update hand size tracking ──
export function trackHandSize(
  diag: GameDiagnostics,
  seat: number,
  handSize: number,
): void {
  const p = diag.players.get(seat);
  if (!p) return;
  if (handSize > p.max_hand_size) p.max_hand_size = handSize;
  p.hand_size_at_round_end = handSize;  // last value written = final hand size
}

// ── Export aggregate counters for player_seats jsonb ──
export function getDiagnosticsSummary(
  diag: GameDiagnostics,
  seat: number,
): Record<string, unknown> | null {
  const p = diag.players.get(seat);
  if (!p) return null;
  return {
    decisions_total: p.decisions_total,
    decisions_diverged: p.decisions_diverged,
    speculative_pickups: p.speculative_pickups,
    speculative_pickups_used: p.speculative_pickups_used,
    post_contract_pickups: p.post_contract_pickups,
    post_contract_pickups_used: p.post_contract_pickups_used,
    feed_attempts: p.feed_attempts,
    feed_payoffs: p.feed_payoffs,
    table_awareness_holds: p.table_awareness_holds,
    table_awareness_deadwood_cost: p.table_awareness_deadwood_cost,
    layoff_opportunities_total: p.layoff_opportunities_total,
    layoff_opportunities_taken: p.layoff_opportunities_taken,
    layoff_opportunities_missed: p.layoff_opportunities_missed,
    turns_to_contract: p.turns_to_contract,
    turns_post_contract: p.turns_post_contract,
    max_hand_size: p.max_hand_size,
    hand_size_at_round_end: p.hand_size_at_round_end,
    hand_size_at_contract: p.hand_size_at_contract,
    cards_shed_post_contract: p.hand_size_at_contract > 0
      ? p.hand_size_at_contract - p.hand_size_at_round_end
      : 0,
    post_contract_shed_rate: p.turns_post_contract > 0 && p.hand_size_at_contract > 0
      ? parseFloat(((p.hand_size_at_contract - p.hand_size_at_round_end) / p.turns_post_contract).toFixed(2))
      : null,  // went out immediately or never met contract — exclude from averages
  };
}
