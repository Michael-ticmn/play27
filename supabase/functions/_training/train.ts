#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read
// ============================================================
// play27 — AI Training Harness
// Entry point: parse config, authenticate, run batch, print summary
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { parseArgs, type TrainingConfig } from './config.ts';
import { runGame } from './game-loop.ts';
import {
  createRun,
  updateRunProgress,
  completeRun,
  failRun,
  computeSummary,
} from './logger.ts';

// ── Load env ──
const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const TRAINER_EMAIL = Deno.env.get('TRAINER_EMAIL');
const TRAINER_PASSWORD = Deno.env.get('TRAINER_PASSWORD');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !TRAINER_EMAIL || !TRAINER_PASSWORD) {
  console.error('Missing required env vars: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, TRAINER_EMAIL, TRAINER_PASSWORD');
  Deno.exit(1);
}

// ── Parse config ──
let config: TrainingConfig;
try {
  config = parseArgs(Deno.args);
} catch (e) {
  console.error(`Config error: ${(e as Error).message}`);
  Deno.exit(1);
}

// ── Create clients ──
const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Host client uses anon key so auth.uid() works correctly in RPCs
const hostClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
// Authenticate as trainer user to get auth.uid() for game creation RPCs
const { error: authError } = await hostClient.auth.signInWithPassword({
  email: TRAINER_EMAIL,
  password: TRAINER_PASSWORD,
});

if (authError) {
  console.error(`Auth failed: ${authError.message}`);
  console.error('Create a trainer account first: trainer@play27.local');
  Deno.exit(1);
}

// ── Print config ──
console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║   play27 AI Training Harness         ║');
console.log('╚══════════════════════════════════════╝');
console.log('');
console.log(`  Label:    ${config.label}`);
console.log(`  Games:    ${config.numGames}`);
console.log(`  Round:    ${config.roundNumber}`);
console.log(`  Seats:    ${config.seats.map(s => `${s.aiName}:${s.aiTier}`).join(', ')}`);
console.log(`  Jokers:   ${config.gameSettings.numJokers}`);
console.log(`  Max Buys: ${config.gameSettings.maxBuys ?? 'unlimited'}`);
console.log(`  Logging:  ${config.logDecisions ? 'decisions + games' : 'games only'}`);
console.log('');

// ── Create training run ──
const runId = await createRun(serviceClient, config);
console.log(`  Run ID:   ${runId}`);
console.log('');

// ── Run games ──
let completed = 0;
let failed = 0;
const startTime = Date.now();

for (let i = 1; i <= config.numGames; i++) {
  try {
    const result = await runGame(
      { host: hostClient, service: serviceClient },
      config,
      runId,
      i
    );

    completed++;
    await updateRunProgress(serviceClient, runId, completed);

    // Progress output every 10 games or on first/last
    if (i === 1 || i === config.numGames || i % 10 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const winTier = result.winnerTier || '???';
      const turns = result.totalTurns;
      console.log(
        `  [${String(i).padStart(4)}/${config.numGames}] ` +
        `Winner: ${winTier.padEnd(7)} | ${turns} turns | ${result.durationMs}ms | ` +
        `elapsed: ${elapsed}s`
      );
    }
  } catch (e) {
    failed++;
    const msg = (e as Error).message || 'Unknown error';
    console.error(`  [${String(i).padStart(4)}/${config.numGames}] ERROR: ${msg}`);
  }
}

// ── Compute & store summary ──
const summary = await computeSummary(serviceClient, runId);
await completeRun(serviceClient, runId, summary);

// ── Print summary ──
const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log('');
console.log('════════════════════════════════════════');
console.log('  RESULTS');
console.log('════════════════════════════════════════');
console.log(`  Completed: ${completed}  |  Failed: ${failed}  |  Time: ${totalElapsed}s`);
console.log(`  Avg turns: ${(summary as any).avgTurns || '?'}`);
console.log('');

const tierStats = (summary as any).tierStats || {};
console.log('  Tier        Wins   Win%    Avg Score');
console.log('  ─────────── ────── ──────  ─────────');
for (const tier of ['easy', 'normal', 'hard', 'unfair']) {
  const s = tierStats[tier];
  if (!s) continue;
  const winPct = (parseFloat(s.winRate) * 100).toFixed(1);
  console.log(
    `  ${tier.padEnd(12)} ${String(s.wins).padStart(4)}   ${winPct.padStart(5)}%  ${String(s.avgScore).padStart(7)}`
  );
}

console.log('');
console.log(`  Run ID: ${runId}`);
console.log('  Query: SELECT * FROM training_games WHERE run_id = \'...\' ORDER BY game_number;');
console.log('');

// Sign out trainer
await hostClient.auth.signOut();
Deno.exit(0);
