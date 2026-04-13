// ============================================================
// AI Card Memory System
// Tracks visible cards from game_actions history.
// Tier-gated: Easy=none, Normal=last discard per player,
// Hard=last 20 actions, Unfair=full round history.
// ============================================================

import { CardId, cardValue, cardSuit, isJoker } from '../_shared/types.ts';

// ── Raw action from game_actions table ──
export interface GameAction {
  action_type: string;
  player_id: string | null;
  details: Record<string, unknown>;
}

// ── Card memory built from visible history ──
export interface CardMemory {
  /** Game and round this memory belongs to */
  gameId?: string;
  roundId?: string;

  /** All card IDs known visible (discard pile + melds + bought cards) */
  visibleCards: Set<CardId>;

  /** Per card value: count currently sitting in discard pile (not picked back up) */
  deadByValue: Map<number, number>;

  /** Cards each opponent picked up from discard (reveals what they want) */
  opponentPickups: Map<string, CardId[]>;

  /** Cards each opponent bought (reveals what they want) */
  opponentBuys: Map<string, CardId[]>;

  /** Each player's most recent discard (for Normal's minimal recall) */
  lastDiscardByPlayer: Map<string, CardId>;
}

// ── Build card memory from action history ──
export function buildCardMemory(
  actions: GameAction[],
  myPlayerId: string,
  memoryDepth: number,
  tracksOpponentPickups: boolean
): CardMemory {
  const memory: CardMemory = {
    visibleCards: new Set(),
    deadByValue: new Map(),
    opponentPickups: new Map(),
    opponentBuys: new Map(),
    lastDiscardByPlayer: new Map(),
  };

  if (memoryDepth <= 0) return memory;

  // Apply memory depth window: slice to last N actions
  // memoryDepth = Infinity means full history
  const window = Number.isFinite(memoryDepth)
    ? actions.slice(-memoryDepth)
    : actions;

  // Track discard pile state: cards enter on 'discard', leave on 'draw_discard' or 'buy_awarded'
  // For deadByValue we need full history (not windowed) to track pile state correctly
  // But the window limits what the AI "remembers"
  const discardPile = new Set<CardId>();

  for (const action of window) {
    const d = action.details;
    const pid = action.player_id;

    switch (action.action_type) {
      case 'discard': {
        const card = d.card as CardId;
        if (!card) break;
        memory.visibleCards.add(card);
        discardPile.add(card);
        if (pid) {
          memory.lastDiscardByPlayer.set(pid, card);
        }
        break;
      }

      case 'draw_discard': {
        const card = d.card as CardId;
        if (!card) break;
        memory.visibleCards.add(card);
        discardPile.delete(card); // removed from pile
        // Track opponent pickups (not our own)
        if (tracksOpponentPickups && pid && pid !== myPlayerId) {
          const picks = memory.opponentPickups.get(pid) || [];
          picks.push(card);
          memory.opponentPickups.set(pid, picks);
        }
        break;
      }

      case 'buy_awarded': {
        const discardCard = d.discard_card as CardId;
        const penaltyCard = d.penalty_card as CardId;
        const winnerId = d.winner_id as string;
        if (discardCard) {
          memory.visibleCards.add(discardCard);
          discardPile.delete(discardCard); // removed from pile
        }
        if (penaltyCard) {
          memory.visibleCards.add(penaltyCard);
        }
        // Track opponent buys
        if (tracksOpponentPickups && winnerId && winnerId !== myPlayerId) {
          const buys = memory.opponentBuys.get(winnerId) || [];
          if (discardCard) buys.push(discardCard);
          memory.opponentBuys.set(winnerId, buys);
        }
        break;
      }

      case 'contract_met': {
        const melds = d.melds as { cards: CardId[] }[];
        if (melds) {
          for (const meld of melds) {
            for (const card of meld.cards) {
              memory.visibleCards.add(card);
              // Melded cards are not in discard pile
            }
          }
        }
        break;
      }

      case 'lay_off': {
        const card = d.card as CardId;
        if (card) memory.visibleCards.add(card);
        break;
      }

      case 'lay_meld': {
        const cards = d.cards as CardId[];
        if (cards) {
          for (const card of cards) {
            memory.visibleCards.add(card);
          }
        }
        break;
      }
    }
  }

  // Build deadByValue from current discard pile state
  for (const card of discardPile) {
    if (!isJoker(card)) {
      const v = cardValue(card);
      memory.deadByValue.set(v, (memory.deadByValue.get(v) || 0) + 1);
    }
  }

  return memory;
}

// ── Helper: how many of this value are dead (in discard pile)? ──
export function deadCount(memory: CardMemory, value: number): number {
  return memory.deadByValue.get(value) || 0;
}

// ── Helper: how many of this value are still potentially available? ──
// totalPerValue = cards per value in the deck (typically 4 for single deck, 8 for double)
export function availableCount(
  memory: CardMemory,
  value: number,
  totalPerValue = 4
): number {
  return Math.max(0, totalPerValue - deadCount(memory, value));
}

// ── Helper: is this value mostly dead (not worth chasing for a set)? ──
export function isValueDead(
  memory: CardMemory,
  value: number,
  needed: number,
  totalPerValue = 4
): boolean {
  return availableCount(memory, value, totalPerValue) < needed;
}

// ── Helper: did an opponent pick up or buy cards of this value? ──
export function opponentWantsValue(
  memory: CardMemory,
  myPlayerId: string,
  value: number
): boolean {
  for (const [pid, cards] of memory.opponentPickups) {
    if (pid === myPlayerId) continue;
    if (cards.some(c => !isJoker(c) && cardValue(c) === value)) return true;
  }
  for (const [pid, cards] of memory.opponentBuys) {
    if (pid === myPlayerId) continue;
    if (cards.some(c => !isJoker(c) && cardValue(c) === value)) return true;
  }
  return false;
}

// ── Helper: did an opponent pick up or buy cards of this suit near this value? ──
export function opponentWantsSuitRun(
  memory: CardMemory,
  myPlayerId: string,
  suit: number,
  value: number,
  range = 2
): boolean {
  for (const [pid, cards] of memory.opponentPickups) {
    if (pid === myPlayerId) continue;
    if (cards.some(c => !isJoker(c) && cardSuit(c) === suit && Math.abs(cardValue(c) - value) <= range)) return true;
  }
  for (const [pid, cards] of memory.opponentBuys) {
    if (pid === myPlayerId) continue;
    if (cards.some(c => !isJoker(c) && cardSuit(c) === suit && Math.abs(cardValue(c) - value) <= range)) return true;
  }
  return false;
}

// ── Empty memory singleton (for tiers with no memory) ──
export const EMPTY_MEMORY: CardMemory = {
  visibleCards: new Set(),
  deadByValue: new Map(),
  opponentPickups: new Map(),
  opponentBuys: new Map(),
  lastDiscardByPlayer: new Map(),
};
