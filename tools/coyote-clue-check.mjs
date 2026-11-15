// ============================================================
// play27 — Coyote clue check
// Plays all-AI games, runs the in-game helper (js/coyote-clues.js)
// from every seat's point of view, and at each night's reveal
// compares each read ("Likely coyote", "Seems flock", ...) to the
// player's real role. A read is only worth showing if it beats
// the base rate by a clear margin.
//
//   node tools/coyote-clue-check.mjs                300 games at 4-7 players
//   node tools/coyote-clue-check.mjs --games 1000 --players 5 --tier easy
// ============================================================

import { CoyoteGame, mulberry32 } from '../js/coyote-engine.js';
import { CoyoteAI } from '../js/coyote-ai.js';
import { ClueTracker, READS } from '../js/coyote-clues.js';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const games = Number(arg('games', 300));
const counts = arg('players', 'all') === 'all' ? [4, 5, 6, 7] : [Number(arg('players'))];
const tier = arg('tier', 'normal');
const TEAM = { shepherd: 'flock', sheepdog: 'flock', hunter: 'flock', coyote: 'coyote', fox: 'fox' };

// tally[viewerTeam][readKey] = { n, coyote, fox, flock }; key 'all' = base rate
const tally = {};
const bump = (vt, key, truth) => {
  const row = ((tally[vt] ||= {})[key] ||= { n: 0, coyote: 0, fox: 0, flock: 0 });
  row.n++;
  row[truth]++;
};
let samples = 0;
let errors = 0;
let deductions = 0;
let badDeductions = 0;

for (const n of counts) {
  for (let g = 0; g < games; g++) {
    const seed = 7_000_003 + n * 10007 + g;
    const controllers = Array.from({ length: n }, (_, i) => new CoyoteAI({ rng: mulberry32(seed * 31 + i), tier }));
    let trackers = [];
    const sample = () => {
      for (const t of trackers) {
        const vt = TEAM[t.me.role];
        for (const q of game.players) {
          if (q.seat === t.viewer || q.crow) continue;
          const r = t.read(q.seat);
          if (r.deduced) {
            deductions++;
            const ok = r.role ? q.role === r.role : TEAM[q.role] === r.team;
            if (!ok) { badDeductions++; if (badDeductions <= 3) console.error(`Wrong deduction: seat ${q.seat} read ${r.label}, really ${q.role}`); }
            continue;
          }
          if (r.key === 'known') continue;
          const truth = TEAM[q.role];
          bump(vt, 'all', truth);
          bump(vt, r.key, truth);
          samples++;
        }
      }
    };
    const game = new CoyoteGame({
      numPlayers: n,
      controllers,
      rng: mulberry32(seed),
      onEvent: ev => {
        for (const t of trackers) if (!ev.visibleTo || ev.visibleTo.includes(t.viewer)) t.observe(ev);
        if (ev.type === 'reveal') sample();
      },
    });
    trackers = game.players.map(p => new ClueTracker(game, p.seat));
    try { await game.run(); } catch (e) { errors++; if (errors <= 3) console.error(e.stack); }
  }
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-').padStart(5);
console.log(`Clue check: ${games} games at ${counts.join(', ')} players, ${tier} AI, ${samples} reads sampled at nightly reveals, ${errors} errors`);
console.log(`Roles worked out by elimination: ${deductions}, wrong: ${badDeductions}\n`);
for (const vt of ['flock', 'coyote', 'fox']) {
  if (!tally[vt]) continue;
  console.log(`Viewer on the ${vt} side: how often each read is right`);
  console.log('  Read           |  share | really coyote | really fox | really flock');
  const all = tally[vt].all;
  for (const key of ['all', ...READS.map(r => r.key)]) {
    const row = tally[vt][key];
    if (!row) continue;
    const label = key === 'all' ? '(everyone)' : READS.find(r => r.key === key).label;
    console.log(`  ${label.padEnd(14)} | ${pct(row.n, all.n)} |     ${pct(row.coyote, row.n)}     |   ${pct(row.fox, row.n)}    |    ${pct(row.flock, row.n)}`);
  }
  console.log('');
}
if (errors || badDeductions) process.exitCode = 1;
