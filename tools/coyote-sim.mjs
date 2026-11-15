// ============================================================
// play27 — Coyote simulator
// Plays all-AI games headless and reports how they end.
//
//   node tools/coyote-sim.mjs                 500 games at each of 4-7 players
//   node tools/coyote-sim.mjs --games 2000 --players 5
//   node tools/coyote-sim.mjs --den 5 --nights 7 --no-know
//   node tools/coyote-sim.mjs --seed 42 --debug   (card conservation checks)
// ============================================================

import { CoyoteGame, mulberry32 } from '../js/coyote-engine.js';
import { CoyoteAI } from '../js/coyote-ai.js';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const flag = name => args.includes(`--${name}`);

const games = Number(arg('games', 500));
const counts = arg('players', 'all') === 'all' ? [4, 5, 6, 7] : [Number(arg('players'))];
const seed0 = Number(arg('seed', 1));
const options = { debug: flag('debug') };
if (arg('den')) options.denTarget = Number(arg('den'));
if (arg('nights')) options.nights = Number(arg('nights'));
if (flag('no-know')) options.coyotesKnow = false;
if (arg('fox-kills')) options.foxKills = Number(arg('fox-kills'));
if (arg('life-delta')) options.lifeDelta = Number(arg('life-delta'));
if (arg('bounty')) options.bounty = Number(arg('bounty'));
if (arg('shep-bonus')) options.shepherdBonus = Number(arg('shep-bonus'));
// --roles "5:1,1,1,2,0,3;6:..."  shepherd,sheepdog,hunter,coyote,fox,den per player count
if (arg('roles')) {
  options.roleTable = {};
  for (const part of arg('roles').split(';')) {
    const [n, list] = part.split(':');
    const [shepherd, sheepdog, hunter, coyote, fox, den] = list.split(',').map(Number);
    options.roleTable[n] = { shepherd, sheepdog, hunter, coyote, fox, den };
  }
}
const tierAll = arg('tier', 'normal');
const tierFlock = arg('tier-flock', tierAll);
const tierCoyote = arg('tier-coyote', tierAll);
if (arg('roles7')) { const [d, c, f, den] = arg('roles7').split(',').map(Number); options.roleTable = { 7: { shepherd: 1, sheepdog: d, coyote: c, fox: f, den } }; }
if (arg('lpm')) options.lanternsPerMoon = Number(arg('lpm'));
if (arg('dens')) options.denTargets = Object.fromEntries(arg('dens').split(',').map((v, i) => [i + 4, Number(v)]));

const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-').padStart(5);
const avg = (a, b) => (b ? (a / b).toFixed(1) : '-').padStart(5);

console.log(`Coyote sim: ${games} games per player count, seed ${seed0}, tiers flock=${tierFlock} coyote=${tierCoyote}${Object.keys(options).length > 1 ? `, options ${JSON.stringify(options)}` : ''}`);
console.log('');
console.log('Plyrs | Flock win (dawn / all out) | Coyote win (shepherd / den) | Fox win | Night ends | Den | KOs | Snaps | Errors');
console.log('------|----------------------------|-----------------------------|---------|------------|-----|-----|-------|-------');

let failures = 0;
for (const n of counts) {
  const t = { flock: 0, dawn: 0, coyotes: 0, coyote: 0, shepherd: 0, den: 0, fox: 0, foxGames: 0, night: 0, denSum: 0, ko: 0, snaps: 0, invalid: 0, errors: 0 };
  for (let g = 0; g < games; g++) {
    const seed = seed0 * 100003 + n * 10007 + g;
    const rng = mulberry32(seed);
    const controllers = Array.from({ length: n }, (_, i) => new CoyoteAI({ rng: mulberry32(seed * 31 + i) }));
    const game = new CoyoteGame({ numPlayers: n, controllers, rng, options });
    game.players.forEach((p, i) => controllers[i].setTier(p.role === 'coyote' ? tierCoyote : p.role === 'fox' ? tierAll : tierFlock));
    let r;
    try {
      r = await game.run();
    } catch (e) {
      t.errors++;
      failures++;
      if (failures <= 5) console.error(`\n[seed ${seed}, ${n} players] ${e.stack}\n`);
      continue;
    }
    if (r.winner === 'flock') { t.flock++; t[r.reason]++; }
    else { t.coyote++; t[r.reason]++; }
    if (game.players.some(p => p.role === 'fox')) { t.foxGames++; if (r.foxWin) t.fox++; }
    t.night += r.night;
    t.denSum += r.den;
    t.ko += game.stats.knockouts;
    t.snaps += game.stats.snaps;
    t.invalid += game.stats.invalid;
  }
  const done = games - t.errors;
  console.log(
    `  ${n}   | ${pct(t.flock, done)}  (${pct(t.dawn, done)} / ${pct(t.coyotes, done)})     ` +
    `| ${pct(t.coyote, done)}  (${pct(t.shepherd, done)} / ${pct(t.den, done)})       ` +
    `| ${t.foxGames ? pct(t.fox, t.foxGames) : '    -'}   | ${avg(t.night, done)}      | ${avg(t.denSum, done)}` +
    `| ${avg(t.ko, done)}| ${avg(t.snaps, done)} | ${t.errors}${t.invalid ? ` (+${t.invalid} rejected AI moves)` : ''}`
  );
}
if (failures) process.exitCode = 1;
