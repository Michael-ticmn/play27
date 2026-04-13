// ============================================================
// AI Opponent Hand Model (Unfair tier)
// Tracks a live model of each opponent's hand based on
// visible game actions. Cards are known or unknown.
// ============================================================

import { CardId, cardValue, cardSuit, isJoker } from '../_shared/types.ts';
import { type GameAction } from './card-memory.ts';

// ── Per-opponent hand model ──
export interface OpponentHand {
  playerId: string;
  totalCards: number;       // current hand size
  knownCards: KnownCard[];  // cards we've seen enter and haven't seen leave
}

// ── A card we know an opponent holds, with when we learned it ──
export interface KnownCard {
  card: CardId;
  seenAtAction: number;    // action index when this card entered their hand
}

// ── Full table model from Unfair's perspective ──
export interface TableModel {
  gameId: string;
  roundId: string;
  myPlayerId: string;
  opponents: Map<string, OpponentHand>;
  /** Cards currently on the table in melds (available for lay-offs) */
  tableMeldCards: CardId[];
  /** Cards currently in the discard pile (dead) */
  discardPile: Set<CardId>;
}

// ── Build opponent models from full action history ──
// memoryDecay: how many actions ago before a known card is "forgotten"
//   Infinity = perfect memory (Unfair), 20 = recent only (Hard)
export function buildTableModel(
  actions: GameAction[],
  gameId: string,
  roundId: string,
  myPlayerId: string,
  cardsDealt: number = 10,
  memoryDecay: number = Infinity
): TableModel {
  const opponents = new Map<string, OpponentHand>();
  const tableMeldCards: CardId[] = [];
  const discardPile = new Set<CardId>();

  // Track all known player IDs from actions
  const playerIds = new Set<string>();
  for (const a of actions) {
    if (a.player_id && a.player_id !== myPlayerId) {
      playerIds.add(a.player_id);
    }
    // Also catch winner_id from buy_awarded
    if (a.action_type === 'buy_awarded') {
      const wid = a.details.winner_id as string;
      if (wid && wid !== myPlayerId) playerIds.add(wid);
    }
  }

  // Initialize each opponent with dealt hand (all unknown)
  for (const pid of playerIds) {
    opponents.set(pid, {
      playerId: pid,
      totalCards: cardsDealt,
      knownCards: [],
    });
  }

  // Helper: remove a card from opponent's known list
  function removeKnown(opp: OpponentHand, card: CardId) {
    const idx = opp.knownCards.findIndex(kc => kc.card === card);
    if (idx >= 0) opp.knownCards.splice(idx, 1);
  }

  const totalActions = actions.length;

  for (let ai = 0; ai < totalActions; ai++) {
    const action = actions[ai];
    const pid = action.player_id;
    const d = action.details;

    switch (action.action_type) {
      case 'draw_deck': {
        if (pid && pid !== myPlayerId) {
          const opp = opponents.get(pid);
          if (opp) opp.totalCards++;
        }
        break;
      }

      case 'draw_discard': {
        const card = d.card as CardId;
        if (!card) break;
        discardPile.delete(card);
        if (pid && pid !== myPlayerId) {
          const opp = opponents.get(pid);
          if (opp) {
            opp.totalCards++;
            opp.knownCards.push({ card, seenAtAction: ai });
          }
        }
        break;
      }

      case 'buy_awarded': {
        const discardCard = d.discard_card as CardId;
        const penaltyCard = d.penalty_card as CardId;
        const winnerId = d.winner_id as string;
        if (discardCard) discardPile.delete(discardCard);
        if (winnerId && winnerId !== myPlayerId) {
          const opp = opponents.get(winnerId);
          if (opp) {
            if (discardCard) {
              opp.totalCards++;
              opp.knownCards.push({ card: discardCard, seenAtAction: ai });
            }
            if (penaltyCard) {
              opp.totalCards++;
              opp.knownCards.push({ card: penaltyCard, seenAtAction: ai });
            }
          }
        }
        break;
      }

      case 'discard': {
        const card = d.card as CardId;
        if (!card) break;
        discardPile.add(card);
        if (pid && pid !== myPlayerId) {
          const opp = opponents.get(pid);
          if (opp) {
            opp.totalCards--;
            removeKnown(opp, card);
          }
        }
        break;
      }

      case 'contract_met': {
        const melds = d.melds as { cards: CardId[]; meld_type: string }[];
        if (melds && pid && pid !== myPlayerId) {
          const opp = opponents.get(pid);
          if (opp) {
            for (const meld of melds) {
              for (const card of meld.cards) {
                opp.totalCards--;
                removeKnown(opp, card);
                tableMeldCards.push(card);
              }
            }
          }
        } else if (melds) {
          for (const meld of melds) {
            for (const card of meld.cards) {
              tableMeldCards.push(card);
            }
          }
        }
        break;
      }

      case 'lay_off': {
        const card = d.card as CardId;
        if (!card) break;
        tableMeldCards.push(card);
        if (pid && pid !== myPlayerId) {
          const opp = opponents.get(pid);
          if (opp) {
            opp.totalCards--;
            removeKnown(opp, card);
          }
        }
        break;
      }

      case 'lay_meld': {
        const cards = d.cards as CardId[];
        if (cards) {
          for (const card of cards) {
            tableMeldCards.push(card);
            if (pid && pid !== myPlayerId) {
              const opp = opponents.get(pid);
              if (opp) {
                opp.totalCards--;
                removeKnown(opp, card);
              }
            }
          }
        }
        break;
      }
    }
  }

  // Apply memory decay: forget cards seen too long ago
  if (Number.isFinite(memoryDecay)) {
    const cutoff = totalActions - memoryDecay;
    for (const [, opp] of opponents) {
      opp.knownCards = opp.knownCards.filter(kc => kc.seenAtAction >= cutoff);
    }
  }

  return { gameId, roundId, myPlayerId, opponents, tableMeldCards, discardPile };
}

// ── Query: how many known cards of this value does an opponent hold? ──
export function opponentKnownValueCount(
  model: TableModel,
  opponentId: string,
  value: number
): number {
  const opp = model.opponents.get(opponentId);
  if (!opp) return 0;
  return opp.knownCards.filter(kc => !isJoker(kc.card) && cardValue(kc.card) === value).length;
}

// ── Query: how many known cards of this suit does an opponent hold? ──
export function opponentKnownSuitCount(
  model: TableModel,
  opponentId: string,
  suit: number
): number {
  const opp = model.opponents.get(opponentId);
  if (!opp) return 0;
  return opp.knownCards.filter(kc => !isJoker(kc.card) && cardSuit(kc.card) === suit).length;
}

// ── Query: get all known cards of a value held by any opponent ──
export function allOpponentKnownOfValue(
  model: TableModel,
  myPlayerId: string,
  value: number
): { playerId: string; count: number }[] {
  const results: { playerId: string; count: number }[] = [];
  for (const [pid, opp] of model.opponents) {
    if (pid === myPlayerId) continue;
    const count = opp.knownCards.filter(kc => !isJoker(kc.card) && cardValue(kc.card) === value).length;
    if (count > 0) results.push({ playerId: pid, count });
  }
  return results;
}

// ── Query: get known cards of a suit near a value for any opponent ──
export function opponentKnownSuitRun(
  model: TableModel,
  myPlayerId: string,
  suit: number,
  value: number,
  range = 2
): { playerId: string; cards: CardId[] }[] {
  const results: { playerId: string; cards: CardId[] }[] = [];
  for (const [pid, opp] of model.opponents) {
    if (pid === myPlayerId) continue;
    const matching = opp.knownCards
      .filter(kc => !isJoker(kc.card) && cardSuit(kc.card) === suit && Math.abs(cardValue(kc.card) - value) <= range)
      .map(kc => kc.card);
    if (matching.length > 0) results.push({ playerId: pid, cards: matching });
  }
  return results;
}

// ── Strategy: evaluate "feed to create lay-off" opportunity ──
// Returns bonus score for discarding this card (higher = prefer discarding it)
// Only applies post-contract when Unfair holds duplicates of a value
// that an opponent is also collecting.
export function feedLayOffBonus(
  card: CardId,
  myHand: CardId[],
  model: TableModel,
  myPlayerId: string
): number {
  if (isJoker(card)) return 0;

  const cv = cardValue(card);

  // How many more of this value do I hold (excluding the card I'd discard)?
  const myOtherSameValue = myHand.filter(
    c => c !== card && !isJoker(c) && cardValue(c) === cv
  ).length;

  // Not worth it if I don't hold extras to lay off
  if (myOtherSameValue === 0) return 0;

  // Check if any opponent has known cards of this value
  const oppHolders = allOpponentKnownOfValue(model, myPlayerId, cv);
  if (oppHolders.length === 0) return 0;

  // Best case: opponent has 2 of this value → feeding 1 completes their set of 3
  // Then I can lay off my remaining cards of this value onto that meld
  const bestOpp = oppHolders.reduce((a, b) => a.count > b.count ? a : b);

  if (bestOpp.count >= 2) {
    // Opponent completes set → I lay off myOtherSameValue cards next turn
    // Bonus scales with how many cards I'd shed
    return 30 + (myOtherSameValue * 20); // e.g., lay off 2 = 70 bonus
  }

  if (bestOpp.count >= 1) {
    // Opponent has 1 — might build toward set but needs one more from elsewhere
    // Small bonus — speculative
    return 10 + (myOtherSameValue * 10); // e.g., lay off 2 = 30 bonus
  }

  return 0;
}
