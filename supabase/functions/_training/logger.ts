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

// ── Helper: standard deviation ──
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sq = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.round(Math.sqrt(sq) * 10) / 10;
}

// ── Helper: safe ratio (returns null if denominator is 0) ──
function safeRate(num: number, den: number): number | null {
  return den > 0 ? parseFloat((num / den).toFixed(3)) : null;
}

// ── Per-tier diagnostic accumulator ──
interface TierAccum {
  scores: number[];
  contractsMet: number;
  // Diagnostic sums (only populated when diagnostics are enabled)
  decisions_total: number;
  decisions_diverged: number;
  speculative_pickups: number;
  speculative_pickups_used: number;
  post_contract_pickups: number;
  post_contract_pickups_used: number;
  feed_attempts: number;
  feed_payoffs: number;
  table_awareness_deadwood_cost: number;
  turns_to_contract: number[];
  turns_post_contract: number[];
  max_hand_sizes: number[];
  layoff_opportunities_total: number;
  layoff_opportunities_taken: number;
  shed_rates: number[];  // non-null values only
}

function emptyAccum(): TierAccum {
  return {
    scores: [], contractsMet: 0,
    decisions_total: 0, decisions_diverged: 0,
    speculative_pickups: 0, speculative_pickups_used: 0,
    post_contract_pickups: 0, post_contract_pickups_used: 0,
    feed_attempts: 0, feed_payoffs: 0,
    table_awareness_deadwood_cost: 0,
    turns_to_contract: [], turns_post_contract: [],
    max_hand_sizes: [],
    layoff_opportunities_total: 0, layoff_opportunities_taken: 0,
    shed_rates: [],
  };
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

  const winsByTier: Record<string, number> = {};
  const accum: Record<string, TierAccum> = {};
  let totalTurns = 0;

  for (const game of games) {
    totalTurns += game.total_turns || 0;

    if (game.winner_tier) {
      winsByTier[game.winner_tier] = (winsByTier[game.winner_tier] || 0) + 1;
    }

    for (const seat of (game.player_seats as any[])) {
      const tier = seat.ai_tier;
      if (!accum[tier]) accum[tier] = emptyAccum();
      const a = accum[tier];

      a.scores.push(seat.final_score);
      if (seat.met_contract) a.contractsMet++;

      // Aggregate diagnostic counters (present when --diagnostics is enabled)
      if (seat.decisions_total !== undefined) {
        a.decisions_total += seat.decisions_total || 0;
        a.decisions_diverged += seat.decisions_diverged || 0;
        a.speculative_pickups += seat.speculative_pickups || 0;
        a.speculative_pickups_used += seat.speculative_pickups_used || 0;
        a.post_contract_pickups += seat.post_contract_pickups || 0;
        a.post_contract_pickups_used += seat.post_contract_pickups_used || 0;
        a.feed_attempts += seat.feed_attempts || 0;
        a.feed_payoffs += seat.feed_payoffs || 0;
        a.table_awareness_deadwood_cost += seat.table_awareness_deadwood_cost || 0;
        a.layoff_opportunities_total += seat.layoff_opportunities_total || 0;
        a.layoff_opportunities_taken += seat.layoff_opportunities_taken || 0;
        if (seat.turns_to_contract > 0) a.turns_to_contract.push(seat.turns_to_contract);
        if (seat.turns_post_contract > 0) a.turns_post_contract.push(seat.turns_post_contract);
        if (seat.max_hand_size > 0) a.max_hand_sizes.push(seat.max_hand_size);
        if (seat.post_contract_shed_rate !== null && seat.post_contract_shed_rate !== undefined) {
          a.shed_rates.push(seat.post_contract_shed_rate);
        }
      }
    }
  }

  const tierStats: Record<string, unknown> = {};
  for (const tier of Object.keys(accum)) {
    const a = accum[tier];
    const scores = a.scores;
    const n = scores.length;
    const avgScore = n > 0 ? Math.round(scores.reduce((x, y) => x + y, 0) / n) : 0;
    const avg = (arr: number[]) => arr.length > 0
      ? parseFloat((arr.reduce((x, y) => x + y, 0) / arr.length).toFixed(1))
      : null;

    const stat: Record<string, unknown> = {
      wins: winsByTier[tier] || 0,
      games: n,
      winRate: n ? ((winsByTier[tier] || 0) / games.length).toFixed(3) : '0',
      avgScore,
      stdDev: stdDev(scores),
      minScore: n > 0 ? Math.min(...scores) : 0,
      maxScore: n > 0 ? Math.max(...scores) : 0,
      contractMetRate: safeRate(a.contractsMet, n),
    };

    // Add diagnostic aggregates if available
    if (a.decisions_total > 0) {
      stat.divergenceRate = safeRate(a.decisions_diverged, a.decisions_total);
      stat.specPickups = a.speculative_pickups;
      stat.specHitRate = safeRate(a.speculative_pickups_used, a.speculative_pickups);
      stat.feedAttempts = a.feed_attempts;
      stat.feedPayoffRate = safeRate(a.feed_payoffs, a.feed_attempts);
      stat.avgTableAwarenessCost = n > 0
        ? parseFloat((a.table_awareness_deadwood_cost / n).toFixed(1))
        : 0;
      stat.avgTurnsToContract = avg(a.turns_to_contract);
      stat.avgTurnsPostContract = avg(a.turns_post_contract);
      stat.avgMaxHandSize = avg(a.max_hand_sizes);
      stat.layoffDetectionRate = safeRate(a.layoff_opportunities_taken, a.layoff_opportunities_total);
      stat.avgShedRate = a.shed_rates.length > 0
        ? parseFloat((a.shed_rates.reduce((x, y) => x + y, 0) / a.shed_rates.length).toFixed(2))
        : null;
    }

    tierStats[tier] = stat;
  }

  return {
    totalGames: games.length,
    avgTurns: Math.round(totalTurns / games.length),
    tierStats,
  };
}
