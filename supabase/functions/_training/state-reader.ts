// ============================================================
// Training Harness — State Reader
// Reads game state from tables via service-role client.
// Builds TurnContext matching what ai-turn/index.ts constructs.
// ============================================================

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CardId } from '../_shared/types.ts';
import type { TurnContext } from '../ai-turn/strategy.ts';
import { buildCardMemory, type CardMemory, type GameAction, EMPTY_MEMORY } from '../ai-turn/card-memory.ts';
import { buildTableModel, type TableModel } from '../ai-turn/opponent-model.ts';
import { getTier } from '../ai-turn/tiers.ts';

export interface RoundState {
  roundId: string;
  gameId: string;
  roundNumber: number;
  currentTurnSeat: number;
  turnPhase: string;
  discardBought: boolean;
  status: string;
  contractSets: number;
  contractRuns: number;
  mustMeldAll: boolean;
  cardsDeal: number;
}

export interface PlayerInfo {
  playerId: string;
  seat: number;
  tier: string;
  aiName: string;
}

// ── Read the current round for a game ──
export async function getCurrentRound(
  sb: SupabaseClient,
  gameId: string
): Promise<RoundState> {
  const { data: round, error } = await sb
    .from('rounds')
    .select('id, game_id, round_number, current_turn_seat, turn_phase, discard_bought, status')
    .eq('game_id', gameId)
    .order('round_number', { ascending: false })
    .limit(1)
    .single();

  if (error || !round) throw new Error(`Failed to get round: ${error?.message}`);

  const { data: contract } = await sb
    .from('contracts')
    .select('num_sets, num_runs, must_go_out, cards_dealt')
    .eq('round_number', round.round_number)
    .single();

  return {
    roundId: round.id,
    gameId: round.game_id,
    roundNumber: round.round_number,
    currentTurnSeat: round.current_turn_seat,
    turnPhase: round.turn_phase,
    discardBought: round.discard_bought,
    status: round.status,
    contractSets: contract?.num_sets || 0,
    contractRuns: contract?.num_runs || 0,
    mustMeldAll: contract?.must_go_out || false,
    cardsDeal: contract?.cards_dealt || 10,
  };
}

// ── Get all players in a game ──
export async function getPlayers(
  sb: SupabaseClient,
  gameId: string
): Promise<PlayerInfo[]> {
  // Specify FK explicitly — game_players has multiple FKs to profiles
  // (player_id and original_player_id from AI takeover)
  const { data, error } = await sb
    .from('game_players')
    .select('player_id, seat_position, profiles!game_players_player_id_fkey(ai_tier, ai_name, display_name)')
    .eq('game_id', gameId)
    .order('seat_position');

  if (error || !data) throw new Error(`Failed to get players: ${error?.message}`);

  return data.map((p: any) => ({
    playerId: p.player_id,
    seat: p.seat_position,
    tier: p.profiles?.ai_tier || 'normal',
    aiName: p.profiles?.ai_name || p.profiles?.display_name || 'Trainer',
  }));
}

// ── Get a player's hand ──
export async function getHand(
  sb: SupabaseClient,
  roundId: string,
  playerId: string
): Promise<CardId[]> {
  const { data } = await sb
    .from('round_cards')
    .select('card_id')
    .eq('round_id', roundId)
    .eq('player_id', playerId)
    .eq('location', 'hand');

  return (data || []).map(c => c.card_id);
}

// ── Get top discard card ──
export async function getTopDiscard(
  sb: SupabaseClient,
  roundId: string
): Promise<CardId | null> {
  const { data } = await sb
    .from('round_cards')
    .select('card_id')
    .eq('round_id', roundId)
    .eq('location', 'discard')
    .order('position', { ascending: false })
    .limit(1)
    .single();

  return data?.card_id || null;
}

// ── Get all melds on the table ──
export async function getMelds(
  sb: SupabaseClient,
  roundId: string
): Promise<{ id: string; meld_type: string; cards: CardId[] }[]> {
  const { data: meldsData } = await sb
    .from('melds')
    .select('id, player_id, meld_type')
    .eq('round_id', roundId);

  const melds: { id: string; meld_type: string; cards: CardId[] }[] = [];
  for (const m of (meldsData || [])) {
    const { data: meldCards } = await sb
      .from('round_cards')
      .select('card_id')
      .eq('round_id', roundId)
      .eq('meld_id', m.id)
      .order('position');

    melds.push({
      id: m.id,
      meld_type: m.meld_type,
      cards: (meldCards || []).map(c => c.card_id),
    });
  }
  return melds;
}

// ── Get player round state ──
export async function getPlayerRoundState(
  sb: SupabaseClient,
  roundId: string,
  playerId: string
): Promise<{ hasMetContract: boolean; hasDrawn: boolean; buysUsed: number }> {
  const { data } = await sb
    .from('player_round_state')
    .select('has_met_contract, has_drawn, buys_used')
    .eq('round_id', roundId)
    .eq('player_id', playerId)
    .single();

  return {
    hasMetContract: data?.has_met_contract || false,
    hasDrawn: data?.has_drawn || false,
    buysUsed: data?.buys_used || 0,
  };
}

// ── Get total score across all finished rounds ──
export async function getTotalScore(
  sb: SupabaseClient,
  gameId: string,
  playerId: string
): Promise<number> {
  const { data } = await sb
    .from('player_round_state')
    .select('score, round_id!inner(game_id, status)')
    .eq('player_id', playerId)
    .eq('round_id.game_id', gameId)
    .eq('round_id.status', 'finished');

  return (data || []).reduce((sum: number, r: any) => sum + (r.score || 0), 0);
}

// ── Get player's last discard (to avoid picking it back up) ──
export async function getLastDiscard(
  sb: SupabaseClient,
  roundId: string,
  playerId: string
): Promise<CardId | null> {
  const { data } = await sb
    .from('game_actions')
    .select('details')
    .eq('round_id', roundId)
    .eq('player_id', playerId)
    .eq('action_type', 'discard')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.details?.card || null;
}

// ── Get protected cards from recent buys ──
export async function getProtectedCards(
  sb: SupabaseClient,
  roundId: string,
  playerId: string,
  hand: CardId[]
): Promise<CardId[]> {
  const { data: recentBuys } = await sb
    .from('game_actions')
    .select('details, created_at')
    .eq('round_id', roundId)
    .eq('player_id', playerId)
    .eq('action_type', 'buy_awarded')
    .order('created_at', { ascending: false })
    .limit(3);

  if (!recentBuys || recentBuys.length === 0) return [];

  const { data: myDiscards } = await sb
    .from('game_actions')
    .select('created_at')
    .eq('round_id', roundId)
    .eq('player_id', playerId)
    .eq('action_type', 'discard')
    .order('created_at', { ascending: false });

  return recentBuys.flatMap(b => {
    const turnsSinceBuy = (myDiscards || []).filter(d => d.created_at > b.created_at).length;
    if (turnsSinceBuy >= 3) return [];
    const cards: CardId[] = [];
    if (b.details?.discard_card) cards.push(b.details.discard_card);
    if (b.details?.penalty_card) cards.push(b.details.penalty_card);
    return cards;
  }).filter(c => hand.includes(c));
}

// ── Build full TurnContext for a player ──
export async function buildTurnContext(
  sb: SupabaseClient,
  roundState: RoundState,
  playerId: string,
  tier: string,
  gameSettings?: { numDecks: number; numJokers: number; maxBuys: number | null }
): Promise<{ ctx: TurnContext; protectedCards: CardId[]; myLastDiscard: CardId | null }> {
  const [hand, topDiscard, melds, prs, totalScore, myLastDiscard, protectedCards] =
    await Promise.all([
      getHand(sb, roundState.roundId, playerId),
      getTopDiscard(sb, roundState.roundId),
      getMelds(sb, roundState.roundId),
      getPlayerRoundState(sb, roundState.roundId, playerId),
      getTotalScore(sb, roundState.gameId, playerId),
      getLastDiscard(sb, roundState.roundId, playerId),
      // Protected cards needs hand — fetch hand first then pass it
      // We'll compute this after the parallel fetch
      Promise.resolve([] as CardId[]),
    ]);

  // Fetch protected cards now that we have the hand
  const protCards = await getProtectedCards(sb, roundState.roundId, playerId, hand);

  // Build card memory + opponent model (tier-gated)
  const tp = getTier(tier);
  let cardMemory: CardMemory = EMPTY_MEMORY;
  let tableModel: TableModel | undefined;
  if (tp.cardMemoryDepth > 0) {
    const { data: actionLog } = await sb
      .from('game_actions')
      .select('action_type, player_id, details')
      .eq('round_id', roundState.roundId)
      .order('created_at');
    if (actionLog && actionLog.length > 0) {
      const actions = actionLog as GameAction[];
      cardMemory = buildCardMemory(
        actions,
        playerId,
        tp.cardMemoryDepth,
        tp.tracksOpponentPickups
      );
      // Build opponent hand model for Hard/Unfair (memoryDepth >= 20)
      if (tp.cardMemoryDepth >= 20) {
        tableModel = buildTableModel(
          actions,
          roundState.gameId,
          roundState.roundId,
          playerId,
          roundState.cardsDeal || 10,
          tp.cardMemoryDepth
        );
      }
    }
  }

  const ctx: TurnContext = {
    hand,
    topDiscard,
    discardBought: roundState.discardBought,
    contractSets: roundState.contractSets,
    contractRuns: roundState.contractRuns,
    hasMetContract: prs.hasMetContract,
    hasDrawn: prs.hasDrawn,
    melds,
    tier,
    roundNumber: roundState.roundNumber,
    totalScore,
    mustMeldAll: roundState.mustMeldAll,
    cardMemory,
    tableModel,
    playerId,
    gameSettings,
  };

  return { ctx, protectedCards: protCards, myLastDiscard };
}

// ── Record deck order after deal (for replay) ──
export async function readDeckOrder(
  sb: SupabaseClient,
  roundId: string
): Promise<CardId[]> {
  const { data } = await sb
    .from('round_cards')
    .select('card_id')
    .eq('round_id', roundId)
    .eq('location', 'deck')
    .order('position');

  return (data || []).map(c => c.card_id);
}

// ── Read final scores for all players ──
export async function readFinalScores(
  sb: SupabaseClient,
  roundId: string
): Promise<{ playerId: string; score: number; hasMetContract: boolean }[]> {
  const { data } = await sb
    .from('player_round_state')
    .select('player_id, score, has_met_contract')
    .eq('round_id', roundId);

  return (data || []).map(r => ({
    playerId: r.player_id,
    score: r.score ?? -1,
    hasMetContract: r.has_met_contract,
  }));
}
