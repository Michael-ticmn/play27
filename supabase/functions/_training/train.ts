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
import { resolveProfile } from '../ai-turn/round-profiles.ts';
import { getTier } from '../ai-turn/tiers.ts';

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
console.log(`  Logging:  ${config.logDecisions ? 'decisions + games' : 'games only'}${config.diagnostics ? ' + diagnostics' : ''}`);
console.log('');

// ── Snapshot resolved profiles into config for reproducibility ──
const profiles: Record<string, unknown> = {};
for (const seat of config.seats) {
  if (!profiles[seat.aiTier]) {
    profiles[seat.aiTier] = resolveProfile(getTier(seat.aiTier), config.roundNumber);
  }
}
(config as any).profiles = profiles;

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
console.log('  Tier        Wins   Win%    Avg   StdD  Min   Max   Contract%');
console.log('  ─────────── ────── ──────  ────  ────  ────  ────  ─────────');
for (const tier of ['easy', 'normal', 'hard', 'unfair']) {
  const s = tierStats[tier];
  if (!s) continue;
  const winPct = (parseFloat(s.winRate) * 100).toFixed(1);
  const contractPct = s.contractMetRate !== null
    ? (s.contractMetRate * 100).toFixed(0) + '%'
    : '?';
  console.log(
    `  ${tier.padEnd(12)} ${String(s.wins).padStart(4)}   ${winPct.padStart(5)}%  ` +
    `${String(s.avgScore).padStart(4)}  ${String(s.stdDev ?? '?').padStart(4)}  ` +
    `${String(s.minScore ?? '?').padStart(4)}  ${String(s.maxScore ?? '?').padStart(4)}  ` +
    `${contractPct.padStart(7)}`
  );
}

// Print diagnostic aggregates if available
const firstTierStats = tierStats[Object.keys(tierStats)[0]];
if (firstTierStats?.divergenceRate !== undefined) {
  console.log('');
  console.log('  ── Diagnostics ──');
  console.log('  Tier        Diverg%  Spec   SpecHit%  Feed  FeedHit%  TblCost  AvgTTC  AvgTPC  ShedRate  MaxHand  LayOff%');
  console.log('  ─────────── ──────── ─────  ────────  ────  ────────  ───────  ──────  ──────  ────────  ───────  ───────');
  for (const tier of ['easy', 'normal', 'hard', 'unfair']) {
    const s = tierStats[tier];
    if (!s || s.divergenceRate === undefined) continue;
    const pct = (v: number | null) => v !== null && v !== undefined ? (v * 100).toFixed(1) + '%' : '—';
    const num = (v: number | null) => v !== null && v !== undefined ? String(v) : '—';
    console.log(
      `  ${tier.padEnd(12)} ${pct(s.divergenceRate).padStart(7)}  ` +
      `${String(s.specPickups ?? 0).padStart(5)}  ${pct(s.specHitRate).padStart(8)}  ` +
      `${String(s.feedAttempts ?? 0).padStart(4)}  ${pct(s.feedPayoffRate).padStart(8)}  ` +
      `${num(s.avgTableAwarenessCost).padStart(7)}  ` +
      `${num(s.avgTurnsToContract).padStart(6)}  ${num(s.avgTurnsPostContract).padStart(6)}  ` +
      `${num(s.avgShedRate).padStart(8)}  ` +
      `${num(s.avgMaxHandSize).padStart(7)}  ` +
      `${pct(s.layoffDetectionRate).padStart(7)}`
    );
  }
}

console.log('');
console.log(`  Run ID: ${runId}`);
console.log('  Query: SELECT * FROM training_games WHERE run_id = \'...\' ORDER BY game_number;');
console.log('');

// ── Discord webhook notification ──
const webhookUrl = Deno.env.get('DISCORD_WEBHOOK_URL');
if (webhookUrl) {
  const mins = Math.floor(parseFloat(totalElapsed) / 60);
  const secs = Math.round(parseFloat(totalElapsed) % 60);
  const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

  let tierLines = '';
  for (const tier of ['easy', 'normal', 'hard', 'unfair']) {
    const s = tierStats[tier];
    if (!s) continue;
    const winPct = (parseFloat(s.winRate) * 100).toFixed(1);
    tierLines += `  ${tier.padEnd(8)} ${String(s.wins).padStart(4)} wins  ${winPct.padStart(5)}%  avg ${s.avgScore}\n`;
  }

  const msg = [
    `**play27 Training Complete**`,
    ``,
    `**${config.label}** — Round ${config.roundNumber}`,
    `Games: ${completed}/${config.numGames}  |  Failed: ${failed}  |  Time: ${timeStr}`,
    `Avg turns: ${(summary as any).avgTurns || '?'}`,
    `\`\`\``,
    `${tierLines.trimEnd()}`,
    `\`\`\``,
    `Run ID: \`${runId}\``,
  ].join('\n');

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    });
    console.log('  Discord notification sent');
  } catch (e) {
    console.error(`  Discord notification failed: ${(e as Error).message}`);
  }
}

// Sign out trainer
await hostClient.auth.signOut();
Deno.exit(0);
