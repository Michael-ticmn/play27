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
  evaluateDiscardDraw,
} from '../ai-turn/hand-analyzer.ts';
import { getTier, shouldMakeMistake, filterLayOffs } from '../ai-turn/tiers.ts';
import { resolveProfile } from '../ai-turn/round-profiles.ts';
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
import { type TableModel, feedLayOffBonus } from '../ai-turn/opponent-model.ts';
import {
  initGameDiagnostics,
  baselineDrawDecision,
  baselineDiscardDecision,
  measureTableAwarenessCost,
  trackSpecPickup,
  trackFeedAttempt,
  trackHandSize,
  checkFeedPayoff,
  checkSpecUsed,
  getDiagnosticsSummary,
  type GameDiagnostics,
} from './diagnostics.ts';
import {
  type PlanState,
  initializePlan,
  updatePlan,
  isInPlan,
  getPlanDiagnostics,
} from '../ai-turn/plan-state.ts';

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

// ── Run a single training game (single or multi-round) ──
export async function runGame(
  clients: LoopClients,
  config: TrainingConfig,
  runId: string,
  gameNumber: number
): Promise<GameResult> {
  const startTime = Date.now();
  const isFullGame = config.roundNumber === 0;
  const startRound = isFullGame ? (config.startRound || 1) : config.roundNumber;
  const endRound = isFullGame ? 7 : config.roundNumber;

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
    p_start_round: startRound,
  });

  // ── 4. GET PLAYER MAP (shared across rounds) ──
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

  // ── ROUND LOOP (single round or full 7-round game) ──
  let totalTurnCount = 0;
  let deckOrder: string[] = [];
  const roundResults: import('./logger.ts').RoundResult[] = [];

  for (let currentRoundNum = startRound; currentRoundNum <= endRound; currentRoundNum++) {
    // ── READY CHECK ──
    let roundState = await getCurrentRound(clients.service, gameId);
    if (roundState.turnPhase === 'ready_check') {
      await hostRpc(clients.host, 'player_ready', { p_round_id: roundState.roundId });
      roundState = await getCurrentRound(clients.service, gameId);
    }

    // Record deck order from first round only
    if (currentRoundNum === startRound) {
      deckOrder = await readDeckOrder(clients.service, roundState.roundId);
    }

    // ── DIAGNOSTICS INIT (per-round) ──
    const diag = config.diagnostics
      ? initGameDiagnostics(players.map(p => ({
          seat: p.seat,
          tier: p.seat === 0 ? seat0Tier : (p.tier || 'normal'),
        })))
      : null;

    // ── PLAN STATE INIT (per-round) ──
    const plans = new Map<number, PlanState>();
    if (roundState.contractSets > 0) {
      const tpv = config.gameSettings.numDecks * 4;
      for (const player of players) {
        const tier = getTierForSeat(player.seat);
        const tierProfile = getTier(tier);
        if (tier === 'easy' || tier === 'unfair') continue;

        const hand = await getHand(clients.service, roundState.roundId, player.playerId);
        let planMemory: CardMemory | null = null;
        if (tierProfile.cardMemoryDepth > 0) {
          const { data: actionLog } = await clients.service
            .from('game_actions')
            .select('action_type, player_id, details')
            .eq('round_id', roundState.roundId)
            .order('created_at');
          if (actionLog && actionLog.length > 0) {
            planMemory = buildCardMemory(
              actionLog as GameAction[],
              player.playerId,
              tierProfile.cardMemoryDepth,
              tierProfile.tracksOpponentPickups
            );
          }
        }
        const plan = initializePlan(hand, roundState.contractSets, planMemory, tpv);
        plans.set(player.seat, plan);
      }
    }

    // ── TURN LOOP ──
    let turnCount = 0;

    while (turnCount < MAX_TURNS) {
      roundState = await getCurrentRound(clients.service, gameId);

      if (roundState.status !== 'active') break;

      // Handle unexpected phases
      if (roundState.turnPhase === 'buy_window') {
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

    // ── UPDATE PLAN STATE (before any decisions this turn) ──
    const currentPlan = plans.get(currentSeat);
    if (currentPlan && tp.cardMemoryDepth > 0) {
      const hand = await getHand(clients.service, roundState.roundId, currentPlayerId);
      let turnMemory: CardMemory | null = null;
      if (tp.cardMemoryDepth > 0) {
        const { data: actionLog } = await clients.service
          .from('game_actions')
          .select('action_type, player_id, details')
          .eq('round_id', roundState.roundId)
          .order('created_at');
        if (actionLog && actionLog.length > 0) {
          turnMemory = buildCardMemory(
            actionLog as GameAction[],
            currentPlayerId,
            tp.cardMemoryDepth,
            tp.tracksOpponentPickups
          );
        }
      }
      updatePlan(
        currentPlan, hand, turnMemory,
        config.gameSettings.numDecks * 4,
        turnCount, tp, roundState.contractSets
      );
    }

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

        // Two-pass buy: Pass 1 = non-Easy tiers. Pass 2 = Easy only if someone else requested.
        // Easy needs a "social cue" — only buys after seeing another player request.
        const buyPlayers = players.filter(p => p.seat !== currentSeat);

        for (const player of buyPlayers) {
          const buyTier = getTierForSeat(player.seat);
          if (buyTier === 'easy') continue; // defer Easy to pass 2

          const buyerState = await getPlayerRoundState(clients.service, roundState.roundId, player.playerId);
          if (buyerState.hasMetContract) continue;

          const buyHand = await getHand(clients.service, roundState.roundId, player.playerId);
          const buyerTp = getTier(buyTier);
          const mem = buyerTp.cardMemoryDepth > 0 ? buyMemory : undefined;
          const buyerPlan = plans.get(player.seat);
          const { shouldBuy, score } = evaluateBuy(buyHand, topDiscard, roundState.roundNumber, buyTier, mem, config.gameSettings.numDecks * 4, buyerPlan);

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

        // Pass 2: Easy only buys if another player already requested (social cue)
        if (anyBuyRequested) {
          for (const player of buyPlayers) {
            const buyTier = getTierForSeat(player.seat);
            if (buyTier !== 'easy') continue;

            const buyerState = await getPlayerRoundState(clients.service, roundState.roundId, player.playerId);
            if (buyerState.hasMetContract) continue;

            const buyHand = await getHand(clients.service, roundState.roundId, player.playerId);
            const buyerTp = getTier(buyTier);
            const buyerPlan = plans.get(player.seat);
            const { shouldBuy, score } = evaluateBuy(buyHand, topDiscard, roundState.roundNumber, buyTier, undefined, config.gameSettings.numDecks * 4, buyerPlan);

            if (shouldBuy) {
              try {
                if (isSeat0(player.seat)) {
                  await hostRpc(clients.host, 'request_buy', { p_round_id: roundState.roundId });
                } else {
                  await aiRpc(clients.service, 'request_buy', player.playerId, {
                    p_round_id: roundState.roundId,
                  });
                }

                if (config.logDecisions) {
                  await logDecision(
                    clients.service, gameId, roundState.roundId,
                    turnCount, player.seat, buyTier, 'buy',
                    { action: 'request_buy', score, card: topDiscard, hand_size: buyHand.length, social_cue: true }
                  );
                }
              } catch {
                // Buy may fail
              }
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

    // Attach plan state to context (if player has one)
    if (currentPlan) ctx.plan = currentPlan;

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
        const ep = resolveProfile(tp, ctx.roundNumber);
        if (ep.postContractSpeculation) {
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
      try {
        if (shouldDrawDiscard && ctx.topDiscard && !roundState.discardBought && !discardBlocked && !postContractBlock) {
          drawnCard = await callRpc('draw_from_discard', currentSeat, {
            p_round_id: roundState.roundId,
          }) as string;
        } else {
          drawnCard = await callRpc('draw_from_deck', currentSeat, {
            p_round_id: roundState.roundId,
          }) as string;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Not enough cards') || msg.includes('reshuffle')) {
          // Deck exhausted — end the game (all cards are in hands/melds)
          break;
        }
        throw e;
      }

      // ── DIAGNOSTICS: draw phase ──
      if (diag && ctx.topDiscard && !discardBlocked && !postContractBlock) {
        const dp = diag.players.get(currentSeat);
        if (dp) {
          dp.decisions_total++;
          trackHandSize(diag, currentSeat, ctx.hand.length);

          // Baseline: what would have happened without memory?
          if (tp.cardMemoryDepth > 0 && !ctx.hasMetContract) {
            const tpv = (ctx.gameSettings?.numDecks ?? 2) * 4;
            const baseline = baselineDrawDecision(
              ctx.hand, ctx.topDiscard, roundState.contractSets, roundState.contractRuns, tpv
            );
            const actual = shouldDrawDiscard ? 'discard' : 'deck';
            if (baseline !== actual) dp.decisions_diverged++;
          }

          // Track speculative pickups
          if (shouldDrawDiscard && plan.drawFrom === 'discard') {
            const reason = plan.drawFrom; // simplified — we track any discard pickup
            if (ctx.hasMetContract) {
              trackSpecPickup(diag, currentSeat, ctx.topDiscard, turnCount, true);
            } else {
              // Check if this was speculative (not a contract completion)
              const eval_ = evaluateDiscardDraw(
                ctx.hand, ctx.topDiscard, roundState.contractSets, roundState.contractRuns,
                ctx.cardMemory, (ctx.gameSettings?.numDecks ?? 2) * 4
              );
              if (eval_.reason === 'builds_pair' || eval_.reason === 'extends_run' ||
                  eval_.reason === 'weaker_pair_path' || eval_.reason === 'weaker_run_path') {
                trackSpecPickup(diag, currentSeat, ctx.topDiscard, turnCount, false);
              }
            }
          }
        }
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
        ctx.cardMemory, ctx.tableModel, config.gameSettings.numDecks * 4, diag
      );
    } else if (roundState.turnPhase === 'action') {
      // Resuming from mid-turn — hand already has drawn card
      await executeActionPhase(
        clients, config, gameId, roundState, currentSeat, currentTier,
        currentPlayerId, ctx.hand, protectedCards, ctx.hasMetContract, turnCount, tp,
        ctx.cardMemory, ctx.tableModel, config.gameSettings.numDecks * 4, diag
      );
    }
  }

    // ── ROUND RESULTS ──
    totalTurnCount += turnCount;
    const roundEnd = await getCurrentRound(clients.service, gameId);
    const roundScores = await readFinalScores(clients.service, roundEnd.roundId);

    const roundWinner = roundScores.find(s => s.score === 0);
    const roundWinnerSeat = roundWinner ? players.find(p => p.playerId === roundWinner.playerId)?.seat ?? null : null;
    const roundWinnerTier = roundWinnerSeat !== null ? getTierForSeat(roundWinnerSeat) : null;

    const roundPlayerSeats = players.map(p => {
      const score = roundScores.find(s => s.playerId === p.playerId);
      const base = {
        seat: p.seat,
        ai_name: p.seat === 0 ? config.seats[0].aiName : p.aiName,
        ai_tier: getTierForSeat(p.seat),
        final_score: score?.score ?? -1,
        met_contract: score?.hasMetContract ?? false,
      };
      if (diag) {
        const dp = diag.players.get(p.seat);
        if (dp) {
          if (dp.turns_to_contract > 0) {
            dp.turns_post_contract = Math.max(0, turnCount - dp.turns_to_contract);
          }
        }
        const planDiag = plans.get(p.seat) ? getPlanDiagnostics(plans.get(p.seat)!) : null;
        return { ...base, ...getDiagnosticsSummary(diag, p.seat), ...(planDiag ?? {}) };
      }
      return base;
    });

    roundResults.push({
      roundNumber: currentRoundNum,
      winnerSeat: roundWinnerSeat,
      winnerTier: roundWinnerTier,
      totalTurns: turnCount,
      playerSeats: roundPlayerSeats,
    });

    // ── ADVANCE TO NEXT ROUND (full-game mode) ──
    if (isFullGame && currentRoundNum < endRound) {
      try {
        // Dealer for next round = (nextRound - 1) % playerCount
        const nextDealerSeat = currentRoundNum % players.length;
        await callRpc('deal_next_round', nextDealerSeat, {
          p_game_id: gameId,
        });
        // Ready check for new round
        const newRound = await getCurrentRound(clients.service, gameId);
        if (newRound.turnPhase === 'ready_check') {
          await hostRpc(clients.host, 'player_ready', { p_round_id: newRound.roundId });
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('not active') || msg.includes('Game is not active') || msg.includes('All rounds completed')) break;
        throw e;
      }
    }
  } // end round loop

  // ── FINAL GAME RESULTS ──
  const durationMs = Date.now() - startTime;

  // For full games: determine overall winner by lowest total score
  // For single rounds: use round winner
  let overallWinnerSeat: number | null = null;
  let overallWinnerTier: string | null = null;
  let finalPlayerSeats: Record<string, unknown>[];

  if (isFullGame) {
    // Get cumulative scores across all rounds
    const cumulativeScores = await Promise.all(
      players.map(async p => ({
        seat: p.seat,
        playerId: p.playerId,
        totalScore: await getTotalScore(clients.service, gameId, p.playerId),
      }))
    );
    const lowestScore = Math.min(...cumulativeScores.map(s => s.totalScore));
    const winner = cumulativeScores.find(s => s.totalScore === lowestScore);
    overallWinnerSeat = winner?.seat ?? null;
    overallWinnerTier = overallWinnerSeat !== null ? getTierForSeat(overallWinnerSeat) : null;

    finalPlayerSeats = players.map(p => {
      const cumScore = cumulativeScores.find(s => s.seat === p.seat);
      return {
        seat: p.seat,
        ai_name: p.seat === 0 ? config.seats[0].aiName : p.aiName,
        ai_tier: getTierForSeat(p.seat),
        final_score: cumScore?.totalScore ?? -1,
        rounds_played: roundResults.length,
      };
    });
  } else {
    // Single round: use the round result directly
    const rr = roundResults[0];
    overallWinnerSeat = rr?.winnerSeat ?? null;
    overallWinnerTier = rr?.winnerTier ?? null;
    finalPlayerSeats = rr?.playerSeats ?? [];
  }

  const result: GameResult = {
    gameId,
    gameNumber,
    roundNumber: config.roundNumber,
    winnerSeat: overallWinnerSeat,
    winnerTier: overallWinnerTier,
    durationMs,
    totalTurns: totalTurnCount,
    deckOrder,
    playerSeats: finalPlayerSeats,
    ...(isFullGame ? { roundResults } : {}),
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
  totalPerValue = 8,
  diag?: GameDiagnostics | null,
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

      // Diagnostics: contract timing + mark spec pickups used
      if (diag) {
        const dp = diag.players.get(currentSeat);
        if (dp) {
          dp.turns_to_contract = turnCount;
          dp.hand_size_at_contract = handAfterMeld.length;
        }
        checkSpecUsed(diag, currentSeat, usedCards);
      }

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

    // Diagnostics: pre-contract discard
    if (diag) {
      const dp = diag.players.get(currentSeat);
      if (dp) {
        dp.decisions_total++;
        trackHandSize(diag, currentSeat, currentHand.length - 1); // -1: pending discard

        if (tp.cardMemoryDepth > 0) {
          const baselineCard = baselineDiscardDecision(
            currentHand, roundState.contractSets, roundState.contractRuns, false, totalPerValue
          );
          if (baselineCard !== discard) dp.decisions_diverged++;
        }

        if (tp.checksTableMelds && tableMelds.length > 0) {
          const ep = resolveProfile(tp, roundState.roundNumber);
          const cost = measureTableAwarenessCost(
            currentHand, roundState.contractSets, roundState.contractRuns,
            tableMelds, false, cardMemory, tableModel,
            { setWeight: ep.setRelevanceWeight, runWeight: ep.runRelevanceWeight, isolationPenalty: ep.isolationPenalty },
            totalPerValue
          );
          dp.table_awareness_holds += cost.holds;
          dp.table_awareness_deadwood_cost += cost.deadwoodCost;
        }
      }
    }

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
  let handAfterLayoffs = [...currentHand];
  let currentMelds = melds;
  let madeProgress = true;

  // Diagnostics: track hand size post-contract
  if (diag) trackHandSize(diag, currentSeat, currentHand.length);

  while (madeProgress && handAfterLayoffs.length > 0) {
    madeProgress = false;
    const allLayoffs = findLayOffs(handAfterLayoffs, currentMelds);
    const filteredLayoffs = filterLayOffs(tp, allLayoffs);

    // Diagnostics: lay-off detection tracking
    if (diag) {
      const dp = diag.players.get(currentSeat);
      if (dp) {
        dp.layoff_opportunities_total += allLayoffs.length;
        dp.layoff_opportunities_taken += filteredLayoffs.length;
        dp.layoff_opportunities_missed += (allLayoffs.length - filteredLayoffs.length);
      }
    }

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

        // Diagnostics: check if this lay-off was a feed payoff + mark spec used
        if (diag) {
          checkFeedPayoff(diag, currentSeat, lo.card, currentMelds.find(m => m.id === lo.meld_id)?.cards || []);
          checkSpecUsed(diag, currentSeat, new Set([lo.card]));
        }

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

  // Diagnostics: discard phase (post-contract)
  if (diag && hasMetContract) {
    const dp = diag.players.get(currentSeat);
    if (dp) {
      dp.decisions_total++;
      trackHandSize(diag, currentSeat, handAfterLayoffs.length - 1); // -1: pending discard

      const ep = resolveProfile(tp, roundState.roundNumber);

      // Baseline comparison
      if (tp.cardMemoryDepth > 0) {
        const baselineCard = baselineDiscardDecision(
          handAfterLayoffs, roundState.contractSets, roundState.contractRuns, true, totalPerValue
        );
        if (baselineCard !== discard) dp.decisions_diverged++;
      }

      // Table awareness cost
      if (tp.checksTableMelds && tableMelds.length > 0) {
        const cost = measureTableAwarenessCost(
          handAfterLayoffs, roundState.contractSets, roundState.contractRuns,
          tableMelds, true, cardMemory, tableModel,
          { setWeight: ep.setRelevanceWeight, runWeight: ep.runRelevanceWeight, isolationPenalty: ep.isolationPenalty },
          totalPerValue
        );
        dp.table_awareness_holds += cost.holds;
        dp.table_awareness_deadwood_cost += cost.deadwoodCost;
      }

      // Feed tracking: check if this discard has a feed bonus (skip if feed suppressed)
      if (!ep.disableFeedStrategy && tableModel && tableModel.myPlayerId && !isJoker(discard)) {
        const bonus = feedLayOffBonus(discard, handAfterLayoffs, tableModel, tableModel.myPlayerId);
        if (bonus > 0) {
          trackFeedAttempt(diag, currentSeat, discard, turnCount);
        }
      }
    }
  }

  await callAction('discard_card', {
    p_round_id: roundState.roundId,
    p_card: discard,
  });

  if (config.logDecisions) {
    await logDecision(
      clients.service, gameId, roundState.roundId,
      turnCount, currentSeat, currentTier, 'discard',
      { action: 'discard', card: discard, hand_size: handAfterLayoffs.length }
    );
  }
}
