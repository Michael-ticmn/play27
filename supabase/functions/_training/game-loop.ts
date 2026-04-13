// ============================================================
// Training Harness — Game Loop
// Creates a real game via RPCs, runs AI turns in a tight loop.
// Mirrors ai-turn/index.ts flow without delays.
// ============================================================

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { CardId, cardValue, cardSuit, isJoker } from '../_shared/types.ts';
import { planTurn } from '../ai-turn/strategy.ts';
import {
  bestContractSolution,
  rankDiscards,
  rankDiscardsRound7,
  findLayOffs,
  evaluatePostContractDraw,
} from '../ai-turn/hand-analyzer.ts';
import { getTier, shouldMakeMistake, filterLayOffs } from '../ai-turn/tiers.ts';
import type { TrainingConfig, SeatConfig } from './config.ts';
import {
  getCurrentRound,
  getPlayers,
  getHand,
  getTopDiscard,
  getMelds,
  getPlayerRoundState,
  getTotalScore,
  getLastDiscard,
  getProtectedCards,
  readDeckOrder,
  readFinalScores,
  buildTurnContext,
  type RoundState,
  type PlayerInfo,
} from './state-reader.ts';
import { evaluateBuy } from './buy-evaluator.ts';
import { logGame, logDecision, type GameResult } from './logger.ts';
import { buildCardMemory, type CardMemory, type GameAction } from '../ai-turn/card-memory.ts';
import { type TableModel } from '../ai-turn/opponent-model.ts';

const MAX_TURNS = 500;

interface LoopClients {
  /** Authenticated as trainer user — for RPCs that need auth.uid() */
  host: SupabaseClient;
  /** Service-role — for direct table reads and p_acting_as RPCs */
  service: SupabaseClient;
}

// ── RPC helper for host client ──
async function hostRpc(
  client: SupabaseClient,
  fn: string,
  params: Record<string, unknown> = {}
) {
  const { data, error } = await client.rpc(fn, params);
  if (error) throw new Error(`RPC ${fn} failed: ${error.message}`);
  return data;
}

// ── RPC helper for service client with p_acting_as ──
async function aiRpc(
  client: SupabaseClient,
  fn: string,
  playerId: string,
  params: Record<string, unknown> = {}
) {
  const { data, error } = await client.rpc(fn, {
    ...params,
    p_acting_as: playerId,
  });
  if (error) throw new Error(`RPC ${fn} (as ${playerId}) failed: ${error.message}`);
  return data;
}

// ── Run a single training game ──
export async function runGame(
  clients: LoopClients,
  config: TrainingConfig,
  runId: string,
  gameNumber: number
): Promise<GameResult> {
  const startTime = Date.now();

  // ── 1. CREATE GAME ──
  const gameData = await hostRpc(clients.host, 'create_game', {
    p_buy_countdown: config.gameSettings.buyCountdown,
    p_num_decks: config.gameSettings.numDecks,
    p_num_jokers: config.gameSettings.numJokers,
    ...(config.gameSettings.maxBuys !== null ? { p_max_buys: config.gameSettings.maxBuys } : {}),
  });

  const gameId = gameData.game_id;
  if (!gameId) throw new Error(`create_game returned no game_id: ${JSON.stringify(gameData)}`);

  // ── 2. ADD AI PLAYERS (seats 1+) ──
  for (let i = 1; i < config.seats.length; i++) {
    const seat = config.seats[i];
    await hostRpc(clients.host, 'add_ai_to_game', {
      p_game_id: gameId,
      p_ai_name: seat.aiName,
      p_ai_tier: seat.aiTier,
    });
  }

  // ── 3. START GAME ──
  await hostRpc(clients.host, 'start_game', {
    p_game_id: gameId,
    p_start_round: config.roundNumber,
  });

  // ── 4. READY CHECK ──
  let roundState = await getCurrentRound(clients.service, gameId);
  if (roundState.turnPhase === 'ready_check') {
    await hostRpc(clients.host, 'player_ready', { p_round_id: roundState.roundId });
    // Re-read state — should now be 'draw'
    roundState = await getCurrentRound(clients.service, gameId);
  }

  // ── 5. RECORD DECK ORDER ──
  const deckOrder = await readDeckOrder(clients.service, roundState.roundId);

  // ── 6. GET PLAYER MAP ──
  const players = await getPlayers(clients.service, gameId);
  // Seat 0 uses the first config entry's tier
  const seat0Tier = config.seats[0].aiTier;

  function getTierForSeat(seat: number): string {
    if (seat === 0) return seat0Tier;
    const player = players.find(p => p.seat === seat);
    return player?.tier || 'normal';
  }

  function getPlayerIdForSeat(seat: number): string {
    const player = players.find(p => p.seat === seat);
    if (!player) throw new Error(`No player at seat ${seat}`);
    return player.playerId;
  }

  function isSeat0(seat: number): boolean {
    return seat === 0;
  }

  // Helper: call RPC as appropriate client
  async function callRpc(
    fn: string,
    seat: number,
    params: Record<string, unknown> = {}
  ) {
    const playerId = getPlayerIdForSeat(seat);
    if (isSeat0(seat)) {
      return hostRpc(clients.host, fn, params);
    } else {
      return aiRpc(clients.service, fn, playerId, params);
    }
  }

  // ── 7. TURN LOOP ──
  let turnCount = 0;

  while (turnCount < MAX_TURNS) {
    roundState = await getCurrentRound(clients.service, gameId);

    if (roundState.status !== 'active') break;

    // Handle unexpected phases
    if (roundState.turnPhase === 'buy_window') {
      // Resolve immediately if we ended up in buy_window
      await hostRpc(clients.host, 'resolve_buy', { p_round_id: roundState.roundId });
      continue;
    }

    if (roundState.turnPhase !== 'draw') {
      // Might be 'action' (mid-turn recovery) or 'ready_check'
      if (roundState.turnPhase === 'ready_check') {
        await hostRpc(clients.host, 'player_ready', { p_round_id: roundState.roundId });
        continue;
      }
      // For 'action' phase, we need to handle it like a resumed turn
      // Fall through to the turn logic below
    }

    turnCount++;
    const currentSeat = roundState.currentTurnSeat;
    const currentTier = getTierForSeat(currentSeat);
    const currentPlayerId = getPlayerIdForSeat(currentSeat);
    const tp = getTier(currentTier);

    // ── BUY EVALUATION (before active player draws) ──
    if (roundState.turnPhase === 'draw' && !roundState.discardBought) {
      const topDiscard = await getTopDiscard(clients.service, roundState.roundId);
      if (topDiscard) {
        let anyBuyRequested = false;

        // Build shared card memory for buy decisions (dead-value check is global)
        let buyMemory: CardMemory | undefined;
        if (tp.cardMemoryDepth > 0) {
          const { data: actionLog } = await clients.service
            .from('game_actions')
            .select('action_type, player_id, details')
            .eq('round_id', roundState.roundId)
            .order('created_at');
          if (actionLog && actionLog.length > 0) {
            buyMemory = buildCardMemory(
              actionLog as GameAction[],
              currentPlayerId,
              Infinity, // full history for dead-value accuracy
              false     // don't need opponent tracking for buys
            );
          }
        }

        for (const player of players) {
          if (player.seat === currentSeat) continue; // active player can't buy

          // Skip buying if player has already met their contract
          const buyerState = await getPlayerRoundState(clients.service, roundState.roundId, player.playerId);
          if (buyerState.hasMetContract) continue;

          const buyHand = await getHand(clients.service, roundState.roundId, player.playerId);
          const buyTier = getTierForSeat(player.seat);
          // Only pass memory if this tier has card memory
          const buyerTp = getTier(buyTier);
          const mem = buyerTp.cardMemoryDepth > 0 ? buyMemory : undefined;
          const { shouldBuy, score } = evaluateBuy(buyHand, topDiscard, roundState.roundNumber, buyTier, mem, config.gameSettings.numDecks * 4);

          if (shouldBuy) {
            try {
              if (isSeat0(player.seat)) {
                await hostRpc(clients.host, 'request_buy', { p_round_id: roundState.roundId });
              } else {
                await aiRpc(clients.service, 'request_buy', player.playerId, {
                  p_round_id: roundState.roundId,
                });
              }
              anyBuyRequested = true;

              if (config.logDecisions) {
                await logDecision(
                  clients.service, gameId, roundState.roundId,
                  turnCount, player.seat, buyTier, 'buy',
                  { action: 'request_buy', score, card: topDiscard, hand_size: buyHand.length }
                );
              }
            } catch {
              // Buy may fail (already in queue, max buys, etc.)
            }
          }
        }

        if (anyBuyRequested) {
          // Resolve buy immediately — no countdown
          try {
            await hostRpc(clients.host, 'resolve_buy', { p_round_id: roundState.roundId });
          } catch {
            // May fail if no buy window opened
          }
          // Re-read state after buy resolution
          roundState = await getCurrentRound(clients.service, gameId);
          if (roundState.status !== 'active') break;
        }
      }
    }

    // ── BUILD TURN CONTEXT ──
    const { ctx, protectedCards, myLastDiscard } =
      await buildTurnContext(clients.service, roundState, currentPlayerId, currentTier, config.gameSettings);

    // ── DRAW PHASE ──
    if (roundState.turnPhase === 'draw') {
      // Block picking up own last discard
      const discardBlocked = ctx.topDiscard && myLastDiscard && ctx.topDiscard === myLastDiscard;

      // Post-contract draw restriction (mirrors ai-turn/index.ts:231-249)
      let postContractBlock = false;
      let postContractForceDiscard = false;
      if (ctx.hasMetContract && ctx.topDiscard && !isJoker(ctx.topDiscard)) {
        const melds = await getMelds(clients.service, roundState.roundId);
        const isLayOff = evaluatePostContractDraw(ctx.topDiscard, melds);
        if (tp.postContractSpeculation) {
          const dv = cardValue(ctx.topDiscard);
          const sameValCount = ctx.hand.filter(c => !isJoker(c) && cardValue(c) === dv).length;
          postContractBlock = !isLayOff && sameValCount < 2;
          postContractForceDiscard = isLayOff || sameValCount >= 2;
        } else {
          postContractBlock = !isLayOff;
          postContractForceDiscard = isLayOff;
        }
      }
      if (ctx.hasMetContract && ctx.topDiscard && isJoker(ctx.topDiscard)) {
        postContractForceDiscard = true;
      }

      // Plan turn with adjusted context
      const adjustedCtx = {
        ...ctx,
        topDiscard: (discardBlocked || postContractBlock) ? null : ctx.topDiscard,
        discardBought: roundState.discardBought || !!discardBlocked || postContractBlock,
      };
      const plan = planTurn(adjustedCtx);

      const shouldDrawDiscard = postContractForceDiscard
        ? true
        : plan.drawFrom === 'discard';

      let drawnCard: CardId;
      if (shouldDrawDiscard && ctx.topDiscard && !roundState.discardBought && !discardBlocked && !postContractBlock) {
        drawnCard = await callRpc('draw_from_discard', currentSeat, {
          p_round_id: roundState.roundId,
        }) as string;
      } else {
        drawnCard = await callRpc('draw_from_deck', currentSeat, {
          p_round_id: roundState.roundId,
        }) as string;
      }

      if (config.logDecisions) {
        await logDecision(
          clients.service, gameId, roundState.roundId,
          turnCount, currentSeat, currentTier, 'draw',
          {
            action: shouldDrawDiscard ? 'discard' : 'deck',
            card: drawnCard,
            hand_size: ctx.hand.length,
            discard_blocked: !!discardBlocked,
            post_contract_block: postContractBlock,
          }
        );
      }

      // Update hand after draw
      const currentHand = [...ctx.hand, drawnCard];
      const allProtected = [...protectedCards, drawnCard];

      // ── ACTION PHASE ──
      await executeActionPhase(
        clients, config, gameId, roundState, currentSeat, currentTier,
        currentPlayerId, currentHand, allProtected, ctx.hasMetContract, turnCount, tp,
        ctx.cardMemory, ctx.tableModel, config.gameSettings.numDecks * 4
      );
    } else if (roundState.turnPhase === 'action') {
      // Resuming from mid-turn — hand already has drawn card
      await executeActionPhase(
        clients, config, gameId, roundState, currentSeat, currentTier,
        currentPlayerId, ctx.hand, protectedCards, ctx.hasMetContract, turnCount, tp,
        ctx.cardMemory, ctx.tableModel, config.gameSettings.numDecks * 4
      );
    }
  }

  // ── 8. RECORD RESULTS ──
  const finalRound = await getCurrentRound(clients.service, gameId);
  const finalScores = await readFinalScores(clients.service, finalRound.roundId);
  const durationMs = Date.now() - startTime;

  const winner = finalScores.find(s => s.score === 0);
  const winnerSeat = winner ? players.find(p => p.playerId === winner.playerId)?.seat ?? null : null;
  const winnerTier = winnerSeat !== null ? getTierForSeat(winnerSeat) : null;

  const playerSeats = players.map(p => {
    const score = finalScores.find(s => s.playerId === p.playerId);
    return {
      seat: p.seat,
      ai_name: p.seat === 0 ? config.seats[0].aiName : p.aiName,
      ai_tier: getTierForSeat(p.seat),
      final_score: score?.score ?? -1,
      met_contract: score?.hasMetContract ?? false,
    };
  });

  const result: GameResult = {
    gameId,
    gameNumber,
    roundNumber: config.roundNumber,
    winnerSeat,
    winnerTier,
    durationMs,
    totalTurns: turnCount,
    deckOrder,
    playerSeats,
  };

  await logGame(clients.service, runId, result);
  return result;
}

// ── ACTION PHASE: meld, lay-off, discard ──
// Mirrors ai-turn/index.ts lines 291-397
async function executeActionPhase(
  clients: LoopClients,
  config: TrainingConfig,
  gameId: string,
  roundState: RoundState,
  currentSeat: number,
  currentTier: string,
  currentPlayerId: string,
  currentHand: CardId[],
  protectedCards: CardId[],
  hasMetContract: boolean,
  turnCount: number,
  tp: ReturnType<typeof getTier>,
  cardMemory?: CardMemory,
  tableModel?: TableModel,
  totalPerValue = 8
): Promise<void> {
  const melds = await getMelds(clients.service, roundState.roundId);
  const tableMelds = tp.checksTableMelds ? melds : [];

  async function callAction(fn: string, params: Record<string, unknown> = {}) {
    if (currentSeat === 0) {
      return hostRpc(clients.host, fn, params);
    } else {
      return aiRpc(clients.service, fn, currentPlayerId, params);
    }
  }

  const totalScore = await getTotalScore(clients.service, gameId, currentPlayerId);

  // ── TRY TO MEET CONTRACT ──
  if (!hasMetContract) {
    const solution = bestContractSolution(
      currentHand,
      roundState.contractSets,
      roundState.contractRuns,
      3,
      roundState.mustMeldAll
    );

    const urgent = totalScore >= tp.urgentMeldThreshold;
    let shouldMeld = !!solution;
    if (solution && tp.canMissContract && !urgent) {
      shouldMeld = Math.random() > tp.missContractRate;
    }

    if (shouldMeld && solution) {
      await callAction('fulfill_contract', {
        p_round_id: roundState.roundId,
        p_melds: solution,
      });

      if (config.logDecisions) {
        await logDecision(
          clients.service, gameId, roundState.roundId,
          turnCount, currentSeat, currentTier, 'meld',
          { action: 'fulfill_contract', melds: solution.length, hand_size: currentHand.length }
        );
      }

      const usedCards = new Set(solution.flatMap(m => m.cards));
      const handAfterMeld = currentHand.filter(c => !usedCards.has(c));

      if (handAfterMeld.length === 0) return; // Won!

      // No lay-offs same turn as contract — just discard
      const discard = (roundState.mustMeldAll
        ? rankDiscardsRound7(handAfterMeld, tableMelds, protectedCards)
        : rankDiscards(handAfterMeld, roundState.contractSets, roundState.contractRuns, tableMelds, protectedCards, true, undefined, cardMemory, tableModel, totalPerValue)
      )[0] || handAfterMeld[0];

      await callAction('discard_card', {
        p_round_id: roundState.roundId,
        p_card: discard,
      });

      if (config.logDecisions) {
        await logDecision(
          clients.service, gameId, roundState.roundId,
          turnCount, currentSeat, currentTier, 'discard',
          { action: 'discard', card: discard, hand_size: handAfterMeld.length, after_meld: true }
        );
      }
      return;
    }

    // No contract solution — just discard
    const discard = (roundState.mustMeldAll
      ? rankDiscardsRound7(currentHand, tableMelds, protectedCards)
      : rankDiscards(currentHand, roundState.contractSets, roundState.contractRuns, tableMelds, protectedCards, hasMetContract, undefined, cardMemory, tableModel, totalPerValue)
    )[0] || currentHand[0];

    await callAction('discard_card', {
      p_round_id: roundState.roundId,
      p_card: discard,
    });

    if (config.logDecisions) {
      await logDecision(
        clients.service, gameId, roundState.roundId,
        turnCount, currentSeat, currentTier, 'discard',
        { action: 'discard', card: discard, hand_size: currentHand.length, no_contract: true }
      );
    }
    return;
  }

  // ── CONTRACT ALREADY MET — CHAIN LAY-OFFS THEN DISCARD ──
  // Re-read melds after each lay-off so chain extensions are found
  // (e.g., run 5-6-7 → lay off 4 → now 3 fits too)
  let handAfterLayoffs = [...currentHand];
  let currentMelds = melds;
  let madeProgress = true;
  while (madeProgress && handAfterLayoffs.length > 0) {
    madeProgress = false;
    const layoffs = findLayOffs(handAfterLayoffs, currentMelds);
    const filteredLayoffs = filterLayOffs(tp, layoffs);

    for (const lo of filteredLayoffs) {
      if (!handAfterLayoffs.includes(lo.card)) continue;
      try {
        await callAction('lay_off_card', {
          p_round_id: roundState.roundId,
          p_meld_id: lo.meld_id,
          p_card: lo.card,
        });
        handAfterLayoffs = handAfterLayoffs.filter(c => c !== lo.card);
        madeProgress = true;

        if (config.logDecisions) {
          await logDecision(
            clients.service, gameId, roundState.roundId,
            turnCount, currentSeat, currentTier, 'lay_off',
            { action: 'lay_off', card: lo.card, meld_id: lo.meld_id, hand_size: handAfterLayoffs.length }
          );
        }
      } catch {
        // Lay-off may fail
      }

      if (handAfterLayoffs.length === 0) return; // Won!
    }

    // Re-read melds if we laid anything off (runs may have extended)
    if (madeProgress && handAfterLayoffs.length > 0) {
      currentMelds = await getMelds(clients.service, roundState.roundId);
    }
  }

  // Discard
  const discard = (roundState.mustMeldAll
    ? rankDiscardsRound7(handAfterLayoffs, tableMelds, protectedCards)
    : rankDiscards(handAfterLayoffs, roundState.contractSets, roundState.contractRuns, tableMelds, protectedCards, hasMetContract, undefined, cardMemory, tableModel, totalPerValue)
  )[0] || handAfterLayoffs[0];

  await callAction('discard_card', {
    p_round_id: roundState.roundId,
    p_card: discard,
  });

  if (config.logDecisions) {
    await logDecision(
      clients.service, gameId, roundState.roundId,
      turnCount, currentSeat, currentTier, 'discard',
      { action: 'discard', card: discard, hand_size: handAfterLayoffs.length, after_layoffs: filteredLayoffs.length }
    );
  }
}
