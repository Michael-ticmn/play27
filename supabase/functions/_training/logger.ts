// ============================================================
// Training Harness — Logger
// Writes to training_runs, training_games, training_decisions
// ============================================================

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { TrainingConfig, SeatConfig } from './config.ts';

// ── Create a training run ──
export async function createRun(
  sb: SupabaseClient,
  config: TrainingConfig
): Promise<string> {
  const { data, error } = await sb
    .from('training_runs')
    .insert({
      label: config.label,
      config: config as unknown as Record<string, unknown>,
      total_games: config.numGames,
      completed_games: 0,
      status: 'running',
    })
    .select('id')
    .single();

  if (error || !data) throw new Error(`Failed to create run: ${error?.message}`);
  return data.id;
}

// ── Update run progress ──
export async function updateRunProgress(
  sb: SupabaseClient,
  runId: string,
  completedGames: number
): Promise<void> {
  await sb
    .from('training_runs')
    .update({ completed_games: completedGames })
    .eq('id', runId);
}

// ── Complete a run ──
export async function completeRun(
  sb: SupabaseClient,
  runId: string,
  summary: Record<string, unknown>
): Promise<void> {
  await sb
    .from('training_runs')
    .update({
      status: 'completed',
      finished_at: new Date().toISOString(),
      summary,
    })
    .eq('id', runId);
}

// ── Fail a run ──
export async function failRun(
  sb: SupabaseClient,
  runId: string,
  reason: string
): Promise<void> {
  await sb
    .from('training_runs')
    .update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      summary: { error: reason },
    })
    .eq('id', runId);
}

// ── Log a completed game ──
export interface GameResult {
  gameId: string;
  gameNumber: number;
  roundNumber: number;
  winnerSeat: number | null;
  winnerTier: string | null;
  durationMs: number;
  totalTurns: number;
  deckOrder: string[];
  playerSeats: {
    seat: number;
    ai_name: string;
    ai_tier: string;
    final_score: number;
    met_contract: boolean;
  }[];
}

export async function logGame(
  sb: SupabaseClient,
  runId: string,
  result: GameResult
): Promise<void> {
  const { error } = await sb
    .from('training_games')
    .insert({
      run_id: runId,
      game_id: result.gameId,
      game_number: result.gameNumber,
      round_number: result.roundNumber,
      winner_seat: result.winnerSeat,
      winner_tier: result.winnerTier,
      duration_ms: result.durationMs,
      total_turns: result.totalTurns,
      deck_order: result.deckOrder,
      player_seats: result.playerSeats,
    });

  if (error) console.error(`Failed to log game: ${error.message}`);
}

// ── Log a decision ──
export async function logDecision(
  sb: SupabaseClient,
  gameId: string,
  roundId: string,
  turnNumber: number,
  seat: number,
  aiTier: string,
  phase: string,
  decision: Record<string, unknown>
): Promise<void> {
  const { error } = await sb
    .from('training_decisions')
    .insert({
      game_id: gameId,
      round_id: roundId,
      turn_number: turnNumber,
      seat,
      ai_tier: aiTier,
      phase,
      decision,
    });

  if (error) {
    console.error(`[logDecision] Failed: ${error.message} | game=${gameId} round=${roundId} turn=${turnNumber} seat=${seat} tier=${aiTier} phase=${phase}`);
  }
}

// ── Compute run summary from training_games ──
export async function computeSummary(
  sb: SupabaseClient,
  runId: string
): Promise<Record<string, unknown>> {
  const { data: games } = await sb
    .from('training_games')
    .select('*')
    .eq('run_id', runId);

  if (!games || games.length === 0) {
    return { error: 'No completed games' };
  }

  // Win rates by tier
  const winsByTier: Record<string, number> = {};
  const gamesByTier: Record<string, number> = {};
  const scoresByTier: Record<string, number[]> = {};
  let totalTurns = 0;

  for (const game of games) {
    totalTurns += game.total_turns || 0;

    if (game.winner_tier) {
      winsByTier[game.winner_tier] = (winsByTier[game.winner_tier] || 0) + 1;
    }

    for (const seat of (game.player_seats as any[])) {
      const tier = seat.ai_tier;
      gamesByTier[tier] = (gamesByTier[tier] || 0) + 1;
      if (!scoresByTier[tier]) scoresByTier[tier] = [];
      scoresByTier[tier].push(seat.final_score);
    }
  }

  const tierStats: Record<string, unknown> = {};
  for (const tier of Object.keys(gamesByTier)) {
    const scores = scoresByTier[tier] || [];
    const avgScore = scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;
    const contractRate = scores.length > 0
      ? 0  // Would need decision data for this
      : 0;

    tierStats[tier] = {
      wins: winsByTier[tier] || 0,
      games: gamesByTier[tier] || 0,
      winRate: gamesByTier[tier] ? ((winsByTier[tier] || 0) / games.length).toFixed(3) : '0',
      avgScore,
    };
  }

  return {
    totalGames: games.length,
    avgTurns: Math.round(totalTurns / games.length),
    tierStats,
  };
}
