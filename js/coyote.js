// ============================================================
// play27 — Lanterns Out, files still named coyote (phase 3 preview: one human vs AI seats)
// Rules engine: coyote-engine.js. AI: coyote-ai.js. Spec: COYOTE.md.
// ============================================================

import { initTheme } from './theme.js?v=0.15.24';
import { CoyoteGame, CARD_TYPES, CHARACTERS, ROLE_INFO, ROLE_TABLE, DEFAULTS, cardName } from './coyote-engine.js?v=0.15.24-p9';
import { CoyoteAI, TIERS } from './coyote-ai.js?v=0.15.24-p9';
import { ClueTracker, leanTag, leanClass } from './coyote-clues.js?v=0.15.24-p9';

const HUMAN = 0;
// Helper levels: coach tips + reads, reads only, or off (just the facts).
const HELP_LEVELS = ['tips', 'reads', 'off'];
const READ_HELP = {
  coyote: 'Their moves are what a coyote would do.',
  sus: 'Some coyote-like moves, but not proof yet.',
  none: 'Nothing telling yet, or their moves point both ways.',
  flockish: 'Mostly flock-like moves.',
  flock: 'Their moves are what the flock would do. Coyotes sometimes help to look innocent, so it is a strong lean, not proof.',
};
const $ = id => document.getElementById(id);
const SPEEDS = { fast: 0.35, normal: 1, slow: 1.8 };
const ROLE_CLASS = { shepherd: 'r-shepherd', sheepdog: 'r-sheepdog', hunter: 'r-hunter', coyote: 'r-coyote', fox: 'r-fox' };
const TIER_HINTS = {
  easy: 'Easy: computer players make mistakes and read the night poorly.',
  normal: 'Normal: the computer players the game is balanced around.',
  hard: 'Hard: a sharper flock that sometimes peeks at face-down Dark cards. Toughest when you are a Coyote or the Fox.',
  unfair: 'Unfair: the flock sees every face-down Dark card. Brutal when you are a Coyote or the Fox.',
};
const GROUP_CLASS = { Fighting: 'g-fight', Care: 'g-care', Tricks: 'g-tricks', Finding: 'g-find', Kit: 'g-kit' };
const TYPE_ORDER = Object.keys(CARD_TYPES);
const MODAL_KINDS = new Set(['snap', 'howl', 'crow', 'charge', 'woolly']);
const FEED_CLASS = {
  turn: 'f-turn', snap: 'f-fight', hurt: 'f-fight', bristle: 'f-fight', howl: 'f-fight', charge: 'f-fight',
  knockout: 'f-ko', runoff: 'f-ko', reveal: 'f-reveal', over: 'f-reveal', night: 'f-night',
  heal: 'f-care', roundup: 'f-care', woolly: 'f-care', bounty: 'f-care', longshot: 'f-fight', lastshot: 'f-fight',
};
const ICON_SVG = {
  moon: '<svg class="ico ico-moon" viewBox="0 0 24 24" role="img" aria-label="moon"><path fill="currentColor" d="M14.5 2.5a9.5 9.5 0 1 0 7 15.9A8 8 0 0 1 14.5 2.5z"/></svg>',
  lantern: '<svg class="ico ico-lantern" viewBox="0 0 24 24" role="img" aria-label="lantern"><path fill="currentColor" fill-rule="evenodd" d="M10 2h4v2h2l1 3v11l-1 3H8l-1-3V7l1-3h2zM12 9.5c-1.2 1.4-2 2.6-2 3.7a2 2 0 0 0 4 0c0-1.1-.8-2.3-2-3.7z"/></svg>',
  sheep: '<svg class="ico" viewBox="0 0 24 24" role="img" aria-label="sheep"><g fill="currentColor"><ellipse cx="10.5" cy="12.5" rx="7.5" ry="5.2"/><ellipse cx="18.6" cy="10" rx="3" ry="2.4"/><rect x="6.2" y="16.5" width="1.7" height="4.2" rx=".8"/><rect x="12.4" y="16.5" width="1.7" height="4.2" rx=".8"/></g></svg>',
  blank: '<svg class="ico ico-blank" viewBox="0 0 24 24" role="img" aria-label="blank"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
};

const ART = 'assets/coyote/';
const ART_V = '?v=0.15.24-p3';
const charImg = (p, cls = 'pt') => `<img class="${cls}" src="${ART}char-${p.character.id}.svg${ART_V}" alt="${p.character.name}">`;
const roleImg = (role, cls = 'pt-role') => `<img class="${cls}" src="${ART}role-${role}.svg${ART_V}" alt="${ROLE_INFO[role].name}">`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const icon = (name, cls = 'ii') => `<span class="${cls}">${ICON_SVG[name]}</span>`;
const delay = ms => new Promise(r => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const livesWord = n => (n === 1 ? '1 life' : `${n} lives`);
const sheepWord = n => `${n} sheep`;

let game = null;
let clues = null;
let feed = [];
let speed = loadSpeed();
let help = loadHelp();
let ui = freshUI();
let gateWaiters = [];

function freshUI(keep = {}) {
  return {
    pending: null, selected: [], mendPicks: [], kitChoice: null, overlay: null, rulesOpen: false,
    logOpen: !!keep.logOpen, sheet: null, coach: [], tipsShown: new Set(),
  };
}

function loadSpeed() {
  try { return SPEEDS[localStorage.getItem('coyote-speed')] ? localStorage.getItem('coyote-speed') : 'normal'; }
  catch { return 'normal'; }
}

function loadHelp() {
  try { const h = localStorage.getItem('coyote-help'); return HELP_LEVELS.includes(h) ? h : 'tips'; }
  catch { return 'tips'; }
}

// The game waits while you read the rules or a player sheet.
const reading = () => ui.sheet != null || ui.rulesOpen;
async function pauseWhileReading() {
  while (reading()) await new Promise(r => gateWaiters.push(r));
}
function releaseGate() {
  const w = gateWaiters;
  gateWaiters = [];
  w.forEach(r => r());
}

// ── Human controller: every engine decision becomes a prompt ──
class HumanController {
  constructor() { this.bootsPick = null; }
  chooseAction() { return ask({ kind: 'day' }); }
  async bootsCount(g, me) {
    const pick = await ask({ kind: 'dark', boots: true, count: Math.min(2, me.hand.length), forced: g.isForcedFaceUp(me), canFaceUp: false });
    this.bootsPick = pick.cardIds.length ? pick : null;
    return pick.cardIds.length;
  }
  chooseDark(g, me, o) {
    if (this.bootsPick && !o.forage) { const p = this.bootsPick; this.bootsPick = null; return p; }
    return ask({ kind: 'dark', ...o });
  }
  respondSnap(g, me, attacker, o) { return ask({ kind: 'snap', attacker: attacker.seat, ...o }); }
  joinHowl(g, me, target) { return ask({ kind: 'howl', target: target.seat }); }
  chooseDiscard(g, me, n) { return ask({ kind: 'discard', n }); }
  crowChoice(g, me, card) { return ask({ kind: 'crow', card }); }
  tinyCharge(g, me, attacker) { return ask({ kind: 'charge', attacker: attacker.seat }); }
  woollySave(g, me, lost) { return ask({ kind: 'woolly', lost }); }
  dukePick() { return ask({ kind: 'duke' }); }
  lastShot() { return ask({ kind: 'lastshot' }); }
}

function ask(p) {
  return new Promise(resolve => {
    ui.pending = { ...p, resolve };
    ui.selected = [];
    ui.mendPicks = [];
    ui.kitChoice = null;
    coachOnAsk(p);
    render();
  });
}

function answer(v) {
  const p = ui.pending;
  if (!p) return;
  ui.pending = null;
  ui.selected = [];
  ui.mendPicks = [];
  ui.kitChoice = null;
  render();
  p.resolve(v);
}

function overlay(kind, data) {
  return new Promise(resolve => {
    ui.overlay = { kind, data, resolve };
    renderAny();
  });
}

// ── Engine events ──
async function handleEvent(g, ev) {
  if (g !== game) return new Promise(() => {}); // abandoned game: freeze it
  if (ev.visibleTo && !ev.visibleTo.includes(HUMAN)) return;
  const clue = clues.observe(ev);
  if (!(ev.type === 'draw' && ev.by === HUMAN) && ev.type !== 'start') {
    feed.push({ text: feedText(g, ev), cls: ev.visibleTo ? 'f-private' : (FEED_CLASS[ev.type] || ''), tag: clue && leanTag(clue.lean) });
    if (feed.length > 400) feed.shift();
  }
  coachOnEvent(g, ev, clue);
  render();
  await pauseWhileReading();
  if (g !== game) return new Promise(() => {});
  switch (ev.type) {
    case 'night': toast(`Night ${ev.night} of ${g.opt.nights}`, 'night'); break;
    case 'snap': if (ev.target === HUMAN) toast(`${g.players[ev.by].name} snaps at you!`, 'warn'); break;
    case 'knockout': toast(ev.text, 'warn'); break;
    case 'longshot': toast(ev.text, 'warn'); break;
    case 'bounty': toast(ev.text); break;
    case 'reveal': await overlay('reveal', ev); return;
    case 'over': await delay(500); await overlay('over', ev); return;
  }
  await delay(pace(ev));
}

// Name the Shepherd in feed lines aimed at them, so "snaps at Old Blue"
// reads as the attack on the Shepherd that it is.
const AT_TARGET = new Set(['snap', 'howl', 'howl-hold', 'heal', 'bell', 'spook', 'swipe', 'sniff', 'longshot', 'lastshot', 'duke']);
function feedText(g, ev) {
  const s = g.shepherdSeat;
  if (!AT_TARGET.has(ev.type) || ev.target !== s || s === HUMAN || ev.by === s) return ev.text;
  const name = g.players[s].name;
  const i = ev.text.indexOf(name, ev.by != null ? g.players[ev.by].name.length : 0);
  return i < 0 ? ev.text : `${ev.text.slice(0, i + name.length)} (Shepherd)${ev.text.slice(i + name.length)}`;
}

function pace(ev) {
  const base = { night: 900, turn: 350, snap: 750, knockout: 1300, howl: 800, 'howl-hold': 450, dark: 380, hurt: 450, dodge: 500, duke: 900 }[ev.type] ?? 420;
  const mine = ev.by === HUMAN && ev.type !== 'night';
  return (mine ? Math.min(base, 180) : base) * SPEEDS[speed];
}

// ── Rendering ──
function renderAny() {
  if (game) render();
  else renderModal();
}

function render() {
  if (!game) return;
  $('topRight').textContent = `Night ${Math.max(1, game.night)}/${game.opt.nights}`;
  renderYard();
  renderSeats();
  renderFeed();
  renderYou();
  renderCoach();
  renderPrompt();
  renderHand();
  renderModal();
}

function livesHTML(p) {
  return `<span class="lives" title="${p.lives} of ${p.maxLives} lives">${'♥'.repeat(Math.max(0, p.lives))}<span class="empty">${'♥'.repeat(Math.max(0, p.maxLives - p.lives))}</span></span>`;
}

function renderYard() {
  const g = game;
  const nights = Array.from({ length: g.opt.nights }, (_, i) => {
    const n = i + 1;
    const cls = n < g.night ? 'past' : n === g.night ? 'now' : 'future';
    return `<span class="moon-slot ${cls}" title="Night ${n}">${ICON_SVG.moon}</span>`;
  }).join('');
  const sheep = Array.from({ length: g.denTarget }, (_, i) =>
    `<span class="sheep ${i < g.den ? 'taken' : ''}">${ICON_SVG.sheep}</span>`).join('');
  const down = g.dark.filter(d => !d.faceUp).length;
  const backs = Array.from({ length: Math.min(down, 10) }, () => `<img class="back" src="${ART}card-back.svg${ART_V}" alt="">`).join('');
  const ups = g.dark.filter(d => d.faceUp).map(d =>
    `<span class="faceup" title="Put in face up by ${esc(g.players[d.by].name)}"><span class="fu-icon">${ICON_SVG[d.card.icon]}</span><span class="fu-name">${esc(cardName(d.card))}</span><span class="fu-by">${esc(g.players[d.by].name)}</span></span>`).join('');
  const flash = ui.flash ? `<div class="yard-flash ${ui.flash.cls}">${esc(ui.flash.text)}</div>` : '<div class="yard-flash"></div>';
  $('yard').innerHTML = `${flash}
    <div class="yard-block"><div class="yard-label">Night ${Math.max(1, g.night)} of ${g.opt.nights}</div><div class="moons">${nights}</div></div>
    <div class="yard-block"><div class="yard-label">Den ${g.den} of ${g.denTarget}</div><div class="den">${sheep}</div></div>
    <div class="yard-block"><div class="yard-label">Dark pile ${g.dark.length ? `(${g.dark.length})` : ''}</div>
      <div class="dark-pile">${backs || (ups ? '' : '<span class="dark-empty">empty</span>')}${ups}</div></div>`;
}

function currentTargets() {
  const pd = ui.pending;
  if (!pd || !game) return [];
  const me = game.players[HUMAN];
  if (pd.kind === 'duke' || pd.kind === 'lastshot') return game.alive().filter(q => q !== me).map(q => q.seat);
  if (pd.kind === 'day' && ui.selected.length === 1 && !ui.kitChoice) {
    const card = me.hand.find(c => c.id === ui.selected[0]);
    if (!card) return [];
    const o = game.playOptions(me, card);
    return o.ok && o.targets ? o.targets : [];
  }
  return [];
}

function renderSeats() {
  const g = game;
  const me = g.players[HUMAN];
  const targets = currentTargets();
  const order = Array.from({ length: g.n - 1 }, (_, i) => (HUMAN + 1 + i) % g.n);
  $('seats').innerHTML = order.map(s => {
    const p = g.players[s];
    const read = clues.read(s);
    const known = read.key === 'known' ? read.role : null;
    const cls = ['seat'];
    if (p.crow) cls.push('crow');
    if (g.turnSeat === s) cls.push('active');
    if (targets.includes(s)) cls.push('target');
    if (ui.mendPicks.includes(s)) cls.push('picked');
    const tags = [];
    if (known) tags.push(`<span class="tag role ${ROLE_CLASS[known]}"${read.deduced ? ' title="Worked out: no other role is left"' : ''}>${ROLE_INFO[known].name}</span>`);
    else if (read.key === 'flockteam') tags.push('<span class="tag role r-sheepdog" title="Worked out: only flock roles are left">Flock</span>');
    else if (help !== 'off' && read.key !== 'none' && !p.crow) tags.push(`<span class="tag read read-${read.key}" title="Tap for why">${esc(read.label)}</span>`);
    if (!p.crow && !me.crow) tags.push(`<span class="tag ${g.inRange(me, p) ? 'inrange' : ''}" title="Seats between you, the short way round">dist ${g.distance(me, p)}</span>`);
    if (targets.includes(s) && ui.pending?.kind === 'day' && !me.crow && !g.inRange(me, p) && me.hand.find(c => c.id === ui.selected[0])?.type === 'snap') {
      tags.push('<span class="tag long" title="Uses your long gun and reveals you as the Hunter">long shot</span>');
    }
    for (const k of p.kits) tags.push(`<span class="tag kit" title="${esc(k.type === 'crook' ? 'Shepherd\'s Crook: +1 range' : CARD_TYPES[k.type].text)}">${esc(cardName(k))}</span>`);
    if (p.bell) tags.push('<span class="tag bell" title="Their next Dark card goes in face up">Bell</span>');
    if (g.dukeTarget === s) tags.push('<span class="tag woken" title="Their Dark cards tonight go in face up">Woken</span>');
    if (!p.crow) tags.push(`<span class="tag">${plural(p.hand.length, 'card')}</span>`);
    return `<div class="${cls.join(' ')}" data-seat="${s}">
      <div class="seat-head">
        <span class="pt-wrap">${charImg(p)}${known ? roleImg(known) : ''}</span>
        <div class="seat-id">
          <div class="seat-top"><span class="seat-name">${esc(p.name)}</span>${p.crow ? '<span class="tag">Crow</span>' : livesHTML(p)}</div>
          <div class="seat-sub" title="${esc(p.character.text)}">${esc(p.character.animal)} · ${esc(p.character.ability)}</div>
        </div>
      </div>
      <div class="seat-row">${tags.join('')}</div>
    </div>`;
  }).join('');
}

function renderFeed() {
  const el = $('feed');
  const items = ui.logOpen ? feed : feed.slice(-3);
  el.innerHTML = items.map(f => `<div class="${f.cls}">${esc(f.text)}${f.tag && help !== 'off' ? ` <span class="f-tag ${f.tag.cls}">${f.tag.text}</span>` : ''}</div>`).join('') || '<div>The sun is setting…</div>';
  el.classList.toggle('open', ui.logOpen);
  if (ui.logOpen) el.scrollTop = el.scrollHeight;
}

function renderYou() {
  const g = game;
  const me = g.players[HUMAN];
  const info = ROLE_INFO[me.role];
  const pack = me.role === 'coyote' && g.opt.coyotesKnow
    ? g.players.filter(p => p !== me && p.role === 'coyote').map(p => esc(p.name)).join(', ')
    : '';
  const tags = [];
  for (const k of me.kits) tags.push(`<span class="tag kit">${esc(cardName(k))}</span>`);
  if (!me.crow) tags.push(`<span class="tag">range ${g.range(me)}</span>`);
  if (me.bell) tags.push('<span class="tag bell">Bell</span>');
  if (g.dukeTarget === HUMAN) tags.push('<span class="tag woken">Woken</span>');
  $('youPanel').className = `you${g.turnSeat === HUMAN ? ' active' : ''}${me.crow ? ' crow' : ''}`;
  $('youPanel').innerHTML = `
    <span class="pt-wrap">${charImg(me)}${roleImg(me.role)}</span>
    <span class="you-role ${ROLE_CLASS[me.role]}" title="${esc(info.goal)}"><span class="you-k">Role</span>${info.name}</span>
    <span class="you-char"><span class="you-k">Character</span><b>${esc(me.character.name)}</b> the ${esc(me.character.animal)} · ${esc(me.character.ability)}: ${esc(me.character.text)}${pack ? ` · Pack: <b>${pack}</b>` : ''}</span>
    <span class="spacer"></span>
    ${tags.join('')}
    ${me.crow ? '<span class="tag">Crow</span>' : livesHTML(me)}`;
}

function renderPrompt() {
  const g = game;
  const me = g.players[HUMAN];
  const pd = ui.pending;
  let html;
  if (pd?.kind === 'day') {
    const sel = me.hand.find(c => c.id === ui.selected[0]);
    const snaps = me.snapsLeft > 0 ? `${plural(me.snapsLeft, 'Snap!')} left` : 'no Snap! left';
    if (!sel) {
      html = `<div class="prompt-text">Your day. Tap a card to play it, then end your day. <span class="muted">(${snaps})</span></div>
        <div class="btns"><button class="btn primary" data-act="end-day">End day</button></div>`;
    } else {
      const def = CARD_TYPES[sel.type];
      const o = g.playOptions(me, sel);
      let line = `<div class="prompt-card"><b>${esc(def.name)}</b> ${icon(sel.icon)} ${esc(def.text)}</div>`;
      let btns = '';
      if (!o.ok) {
        line += `<div class="prompt-note">${esc(o.reason)}</div>`;
      } else if (!o.targets) {
        btns += `<button class="btn good" data-act="play">Play ${esc(def.name)}</button>`;
      } else {
        const clem = sel.type === 'mend' && me.character.id === 'clementine';
        const longGun = sel.type === 'snap' && g.hasLongGun(me);
        const note = clem
          ? (ui.mendPicks.length ? 'Warm milk: tap where the second life goes, or mend now (both lives to your first pick).' : 'Warm milk: tap who gets the first life.')
          : longGun ? `Tap a highlighted player. A long shot (out of range) ${me.revealed ? 'uses your long gun for tonight' : 'reveals you as the Hunter'}.` : 'Tap a highlighted player.';
        line += `<div class="prompt-note">${note}</div>`;
        if (o.targets.includes(HUMAN)) btns += `<button class="btn good" data-act="self">${clem ? 'You' : 'On yourself'}</button>`;
        if (clem && ui.mendPicks.length) btns += '<button class="btn good" data-act="mend-now">Mend now</button>';
      }
      btns += '<button class="btn" data-act="deselect">Back</button><button class="btn primary" data-act="end-day">End day</button>';
      html = `${line}<div class="btns">${btns}</div>`;
    }
  } else if (pd?.kind === 'dark') {
    const n = ui.selected.length;
    const title = pd.forage ? 'Forage: put 1 card from your hand in the Dark pile.'
      : pd.boots ? 'Prowler: put 0, 1, or 2 cards in the Dark pile. Tap to choose.'
      : 'Night work: tap a card to put in the Dark pile.';
    const ready = n === pd.count ? '' : 'disabled';
    let btns;
    if (pd.boots) btns = `<button class="btn primary" data-act="dark-down">${n ? `Put in ${n}` : 'Put in nothing'}</button>`;
    else if (pd.canFaceUp && !pd.forced) btns = `<button class="btn primary" data-act="dark-down" ${ready}>Face down</button><button class="btn good" data-act="dark-up" ${ready}>Face up, draw 1</button>`;
    else btns = `<button class="btn primary" data-act="dark-down" ${ready}>Put in the Dark</button>`;
    html = `<div class="prompt-text">${title}</div>
      ${pd.forced ? '<div class="prompt-note">You are belled or woken: it goes in face up for everyone to see.</div>' : ''}
      <div class="prompt-card">${icon('moon')} takes a sheep · ${plural(g.opt.lanternsPerMoon, 'lantern')} ${icon('lantern')} cancel a moon · ${icon('blank')} does nothing</div>
      <div class="btns">${btns}</div>`;
  } else if (pd?.kind === 'discard') {
    html = `<div class="prompt-text">Rest: discard ${pd.n} to get down to ${g.opt.handLimit}. Tap ${pd.n === 1 ? 'a card' : 'cards'}.</div>
      <div class="btns"><button class="btn primary" data-act="discard" ${ui.selected.length === pd.n ? '' : 'disabled'}>Discard</button></div>`;
  } else if (pd?.kind === 'lastshot') {
    html = `<div class="prompt-text">Last shot: you're knocked out, but you get one free Snap! at anyone. Tap a player.</div>
      <div class="btns"><button class="btn" data-act="duke-skip">Hold fire</button></div>`;
  } else if (pd?.kind === 'duke') {
    html = `<div class="prompt-text">Wake-up call: tap a player. Their Dark cards tonight go in face up.</div>
      <div class="btns"><button class="btn" data-act="duke-skip">Skip</button></div>`;
  } else if (pd) {
    html = '<div class="prompt-text muted">Decide…</div>';
  } else if (g.over) {
    html = '<div class="prompt-text muted">Game over.</div>';
  } else if (me.crow) {
    html = '<div class="prompt-text">You are a crow. You still win or lose with your team, and each night you may drop a card into the dark.</div>';
  } else if (g.turnSeat != null && g.turnSeat !== HUMAN) {
    html = `<div class="prompt-text muted">${esc(g.players[g.turnSeat].name)} is taking their turn…</div>`;
  } else {
    html = '<div class="prompt-text muted">…</div>';
  }
  $('prompt').innerHTML = html;
}

function renderHand() {
  const me = game.players[HUMAN];
  const pd = ui.pending;
  if (!me.hand.length) {
    $('hand').innerHTML = `<div class="empty-hand">${me.crow ? 'No hand: you are a crow.' : 'No cards in hand.'}</div>`;
    return;
  }
  const cards = [...me.hand].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.id - b.id);
  $('hand').innerHTML = cards.map(c => {
    const def = CARD_TYPES[c.type];
    const cls = ['card', GROUP_CLASS[def.group]];
    if (ui.selected.includes(c.id)) cls.push('sel');
    if (pd?.kind === 'day' && !game.playOptions(me, c).ok) cls.push('dim');
    return `<div class="${cls.join(' ')}" data-card="${c.id}" title="${esc(def.text)}">
      <div class="cname">${esc(def.name)}</div>
      <div class="cgroup">${esc(def.group)}</div>
      <div class="ctext">${esc(def.text)}</div>
      <div class="cicon">${ICON_SVG[c.icon]}</div>
    </div>`;
  }).join('');
}

// ── Coach (tips for a first game) ──
function tip(key, html) {
  if (help !== 'tips' || ui.tipsShown.has(key)) return;
  ui.tipsShown.add(key);
  ui.coach.push(html);
  // Keep the tip on screen plus the 2 newest; older ones are stale.
  while (ui.coach.length > 3) ui.coach.splice(1, 1);
}

function renderCoach() {
  const el = $('coach');
  const t = help === 'tips' ? ui.coach[0] : null;
  el.style.display = t ? '' : 'none';
  if (!t) return;
  const more = ui.coach.length - 1;
  el.innerHTML = `<span class="coach-label">Coach</span><span class="coach-text">${t}</span>
    <button class="btn coach-ok" data-act="coach-ok">${more ? `Next (${more})` : 'Got it'}</button>`;
}

const nameB = seat => `<b>${esc(game.players[seat].name)}</b>`;
const myTeam = () => ROLE_INFO[game.players[HUMAN].role].team;

function planTip(g) {
  const me = g.players[HUMAN];
  const nights = `dawn (after night ${g.opt.nights})`;
  const pack = g.players.filter(p => p !== me && p.role === 'coyote').map(p => esc(p.name)).join(' and ');
  switch (me.role) {
    case 'shepherd':
      return `Everyone knows you're the Shepherd, so the coyotes are coming for you. You win by lasting to ${nights}. Mend when you're hurt, keep a Dodge! for emergencies, and put lanterns in the dark. Seats marked <b>Likely coyote</b> are who to Snap!.`;
    case 'sheepdog':
      return `You're on the flock's side, but nobody knows it, and you don't know who the coyotes are. Watch who attacks the Shepherd: their seat turns <b>Likely coyote</b>. Snap! them, mend the Shepherd, and put lanterns in the dark.`;
    case 'hunter':
      return `You're the flock's hidden Hunter. Watch who attacks the Shepherd: their seat turns <b>Likely coyote</b>. Your long gun reaches anyone once a night, but using it tells everyone what you are, so save it for a sure target.`;
    case 'coyote':
      return `You and ${pack} are the pack. Win by knocking out the Shepherd or getting ${sheepWord(g.denTarget)} into the den. Put moons in the dark face down: nobody can tell who did it. Attacking the Shepherd early gives you away, so wait until the pack can finish the job.`;
    case 'fox':
      return `You're on nobody's side. You win if you're alive at the end with at least ${plural(g.opt.foxKills, 'knockout')}. Pick on someone low on lives, and don't look too much like a coyote or the flock will hunt you.`;
  }
  return '';
}

function coachOnAsk(p) {
  if (!game) return;
  const team = myTeam();
  if (p.kind === 'day') {
    tip('day', 'Your day: tap a card to read it and see who it can reach (dim cards can\'t be played now). Play as many as you like, but only one Snap! a turn, then tap <b>End day</b>. Tap any player to see what they\'ve been up to.');
  } else if (p.kind === 'dark') {
    if (team === 'flock') tip('dark', `Night work: only the card's icon counts here. ${icon('lantern')} Lanterns help (every ${game.opt.lanternsPerMoon} cancel a moon), ${icon('moon')} moons take sheep. Face down, nobody sees what you put in, so put in your best lantern.`);
    else if (team === 'coyote') tip('dark', `Night work: each ${icon('moon')} moon that isn't cancelled takes a sheep to the den. Face down, nobody knows it was you. If you're belled or woken, it goes in face up, so use a blank then.`);
    else tip('dark', 'Night work: the Fox doesn\'t care about sheep. Put in a blank and keep your useful cards.');
  } else if (p.kind === 'discard') {
    tip('rest', `You can only keep ${game.opt.handLimit} cards overnight. Snap! and Dodge! are usually worth keeping.`);
  }
}

function coachOnEvent(g, ev, clue) {
  if (help !== 'tips') return;
  const team = myTeam();
  const me = g.players[HUMAN];
  if (clue && ev.by != null && ev.by !== HUMAN) {
    const r = clues.read(ev.by);
    const what = clue.text.charAt(0).toLowerCase() + clue.text.slice(1);
    if (r.key === 'known' && r.role === 'coyote' && team === 'coyote' && clue.lean >= 2) {
      tip('pack-move', `Your packmate ${nameB(ev.by)} ${what}. The flock will suspect them now. Piling on finishes the Shepherd faster, but exposes you too.`);
    } else if (r.key !== 'known' && clue.lean >= 1.5) {
      tip('coyote-move', `${nameB(ev.by)} ${what}. That's a coyote move, so their seat now reads <b>${esc(r.label)}</b>. Tap any player to see everything they've done.`);
    } else if (r.key !== 'known' && clue.lean <= -1.2) {
      tip('flock-move', `${nameB(ev.by)} ${what}. That's a flock move, so their seat leans flock. Coyotes sometimes do this to look innocent, so it's a lean, not proof.`);
    }
  }
  switch (ev.type) {
    case 'reveal': {
      tip('reveal', `The reveal: each moon takes a sheep unless ${game.opt.lanternsPerMoon} lanterns cancel it. Moons nobody showed came from face-down cards, so everyone who went face down tonight takes a share of the suspicion.`);
      if (g.den === g.denTarget - 1 && !g.over) {
        tip('den-1', team === 'coyote' ? 'One more sheep wins it for your pack. Get a moon in tonight.'
          : team === 'flock' ? 'The coyotes need just one more sheep. Tonight, lanterns in the dark matter more than anything.'
          : 'The coyotes are one sheep from winning.');
      }
      break;
    }
    case 'knockout':
      if (ev.target === HUMAN) tip('crow', 'You\'re a crow now. You still win or lose with your side. Each night you draw a card and may drop it into the dark: a lantern helps the flock, a moon helps the coyotes.');
      else tip('ko', `${nameB(ev.target)} was ${ev.role === 'shepherd' || ev.role === 'hunter' || ev.role === 'fox' ? 'the' : 'a'} ${ROLE_INFO[ev.role].name}. Knocked-out players become crows: they can't be attacked, but they still drop cards in the dark for their side.${ev.role === 'coyote' ? ' Knocking out a coyote brings a sheep home.' : ''}`);
      break;
    case 'hurt': {
      const s = g.shepherdSeat;
      const shep = g.players[s];
      if (ev.target !== s || shep.lives > 2 || shep.crow) break;
      if (s === HUMAN) tip('shep-low', `You're down to ${livesWord(shep.lives)}. Mend if you can, keep a Dodge! in hand, and Snap! whoever keeps coming at you.`);
      else if (team === 'flock') tip('shep-low', `The Shepherd is down to ${livesWord(shep.lives)}. Mend them, and Snap! whoever keeps attacking.`);
      else if (team === 'coyote') tip('shep-low', `The Shepherd is down to ${livesWord(shep.lives)}. A Pack Howl or a couple of Snap!s could end it now.`);
      break;
    }
  }
  void me;
}

// ── Modal ──
let lastModal = '';
function renderModal() {
  let html = '';
  let cls = 'panel';
  if (ui.rulesOpen) { html = rulesHTML(); cls += ' rules'; }
  else if (ui.sheet != null && game) { html = ui.sheet === 'who' ? whoHTML() : sheetHTML(ui.sheet); cls += ' sheet'; }
  else if (ui.overlay) html = overlayHTML(ui.overlay);
  else if (ui.kitChoice) html = kitChoiceHTML();
  else if (ui.pending && MODAL_KINDS.has(ui.pending.kind)) html = decisionHTML(ui.pending);
  $('modal').classList.toggle('show', !!html);
  $('modalBox').className = cls;
  // Only rewrite when something changed, so an open sheet keeps its scroll.
  if (html && html !== lastModal) $('modalBox').innerHTML = html;
  lastModal = html;
}

function sideLines(g) {
  const c = g.roleCounts;
  const flock = [`Shepherd (${esc(g.players[g.shepherdSeat].name)})`];
  if (c.sheepdog) flock.push(plural(c.sheepdog, 'Sheepdog'));
  if (c.hunter) flock.push(plural(c.hunter, 'Hunter'));
  const lines = [
    `<div class="side"><b class="r-shepherd">Flock</b> ${flock.join(', ')}. Only the Shepherd is known. They win if the Shepherd lasts to dawn (after night ${g.opt.nights}) or every coyote is knocked out.</div>`,
    `<div class="side"><b class="r-coyote">Coyotes</b> ${c.coyote}, hidden, and they know each other. They win by knocking out the Shepherd or getting ${sheepWord(g.denTarget)} into the den (${g.den} so far).</div>`,
  ];
  if (c.fox) lines.push(`<div class="side"><b class="r-fox">Fox</b> 1, hidden, on nobody's side. Wins alongside whoever wins if alive at the end with ${plural(g.opt.foxKills, 'knockout')}.</div>`);
  return lines.join('');
}

// How you know a known role, for the sheet.
function knownHow(g, p, read) {
  if (p.seat === g.shepherdSeat) return 'Everyone knows the Shepherd.';
  if (p.crow) return 'Knocked out, so their role is showing.';
  if (read.deduced) return 'Worked out: every other role in the game is already accounted for.';
  if (p.revealed && p.role === 'hunter') return 'They used the long gun, which shows everyone they are the Hunter.';
  if (p.revealed) return 'Their role has been revealed.';
  if (p.role === 'coyote') return 'Your packmate: coyotes know each other.';
  return '';
}

function selfSheetHTML(g) {
  const plan = help !== 'off' ? `<p class="coach-inline">${planTip(g)}</p>` : '';
  return `${introBody(g)}${plan}<div class="btns"><button class="btn primary" data-act="sheet-close">Close</button><button class="btn" data-act="who">Who's who</button></div>`;
}

function sheetHTML(seat) {
  const g = game;
  if (seat === HUMAN) return selfSheetHTML(g);
  const p = g.players[seat];
  const read = clues.read(seat);
  const items = [...clues.clues(seat)].reverse();
  const shading = help !== 'off';
  let readLine = '';
  if (read.key === 'known') readLine = `<div class="sheet-read ${ROLE_CLASS[read.role]}">${ROLE_INFO[read.role].name}</div><p>${knownHow(g, p, read)}</p>`;
  else if (read.key === 'flockteam') readLine = '<div class="sheet-read r-sheepdog">Flock</div><p>Worked out: only flock roles are left among the players you don\'t know.</p>';
  else if (shading && (read.key !== 'none' || items.length)) {
    const foxNote = (read.key === 'coyote' || read.key === 'sus') && g.roleCounts.fox && clues.rolesLeft().coyote ? ' The Fox attacks for knockouts too, so it could be the Fox.' : '';
    readLine = `<div class="sheet-read read-${read.key}">${esc(read.label)}</div><p>${READ_HELP[read.key]}${foxNote}</p>`;
  }
  const list = items.length
    ? `<ul class="clue-list">${items.map(it => {
      const lc = shading ? leanClass(it.lean) : 'lean-n';
      const word = !shading ? '' : lc === 'lean-c' ? 'coyote-like' : lc === 'lean-f' ? 'flock-like' : '';
      return `<li class="${lc}"><span class="cl-night">N${it.night}</span><span class="cl-text">${esc(it.text)}</span>${word ? `<span class="cl-lean">${word}</span>` : ''}</li>`;
    }).join('')}</ul>`
    : '<p class="muted">Nothing telling yet. Watch who they attack, who they help, and what they put in the dark face up.</p>';
  return `<div class="sheet-head">
      <span class="pt-wrap">${charImg(p, 'sheet-pt')}${read.key === 'known' ? roleImg(read.role) : ''}</span>
      <div class="sheet-id"><h3>${esc(p.name)}</h3><div class="sheet-sub">${esc(p.character.animal)} · <b>${esc(p.character.ability)}:</b> ${esc(p.character.text)}</div>
      <div class="sheet-sub">${p.crow ? 'Crow' : `${livesWord(p.lives)} of ${p.maxLives}`} · ${plural(p.kills, 'knockout')}</div></div>
    </div>
    ${readLine}
    <h4>What you've seen them do</h4>
    ${list}
    <div class="btns"><button class="btn primary" data-act="sheet-close">Close</button><button class="btn" data-act="who">Who's who</button></div>`;
}

function whoHTML() {
  const g = game;
  const rows = g.turnOrder().map(s => {
    const p = g.players[s];
    const read = clues.read(s);
    let chip;
    if (read.key === 'known') chip = `<span class="tag role ${ROLE_CLASS[read.role]}">${ROLE_INFO[read.role].name}</span>`;
    else if (read.key === 'flockteam') chip = '<span class="tag role r-sheepdog">Flock</span>';
    else if (help !== 'off') chip = `<span class="tag read read-${read.key}">${esc(read.label)}</span>`;
    else chip = '<span class="tag">Unknown</span>';
    const items = clues.clues(s);
    let line;
    if (s === HUMAN) line = esc(ROLE_INFO[p.role].goal);
    else if (!items.length) line = 'Nothing telling yet.';
    else {
      const top = items.reduce((a, b) => (Math.abs(b.lean) > Math.abs(a.lean) || (Math.abs(b.lean) === Math.abs(a.lean) && b.night >= a.night) ? b : a));
      line = `${esc(top.text)}${items.length > 1 ? ` <span class="muted">(+${items.length - 1} more)</span>` : ''}`;
    }
    return `<button class="who-row${p.crow ? ' crow' : ''}" data-act="sheet:${s}">
      <span class="pt-wrap">${charImg(p, 'who-pt')}</span>
      <span class="who-main"><span class="who-name">${esc(p.name)}${p.crow ? ' · crow' : ''}</span>${chip}<span class="who-line">${line}</span></span>
    </button>`;
  }).join('');
  return `<h3>Who's who</h3>
    <div class="sides">${sideLines(g)}</div>
    <div class="who-list">${rows}</div>
    <p class="who-note">${help === 'off' ? 'Reads are off (Settings, Helper).' : 'Reads come only from what you have seen, the same way a Normal computer player reads the table.'} Tap a player for the full list.</p>
    <div class="btns"><button class="btn primary" data-act="sheet-close">Close</button></div>`;
}

function decisionHTML(pd) {
  const g = game;
  const me = g.players[HUMAN];
  switch (pd.kind) {
    case 'snap': {
      const a = g.players[pd.attacker];
      const notes = [];
      if (g.hasKit(me, 'hayloft') && me.hand.some(c => c.type === 'dodge')) notes.push('You are up in the Hayloft, so you cannot Dodge!.');
      if (g.hasKit(me, 'thicket')) notes.push('If you take it, your Thicket absorbs the hit.');
      let coach = '';
      if (help === 'tips') {
        if (me.lives === 1 && !g.hasKit(me, 'thicket')) coach = 'This hit would knock you out. Use a Dodge! or Bristle if you have one.';
        else if (pd.canDodge || pd.canBristle) coach = 'Dodge! cancels the hit; Bristle cancels it and hurts the attacker. With lives to spare, some players take the hit and save the card.';
      }
      return `<h3>Snap!</h3>
        <p><b>${esc(a.name)}</b> snaps at you. You have ${livesWord(me.lives)}.</p>
        ${notes.length ? `<p>${notes.join(' ')}</p>` : ''}
        ${coach ? `<p class="coach-inline">${coach}</p>` : ''}
        <div class="btns">
          ${pd.canDodge ? '<button class="btn good" data-act="r-dodge">Dodge!</button>' : ''}
          ${pd.canBristle ? '<button class="btn good" data-act="r-bristle">Bristle</button>' : ''}
          <button class="btn bad" data-act="r-none">Take the hit</button>
        </div>`;
    }
    case 'howl': {
      const t = g.players[pd.target];
      return `<h3>Pack Howl</h3>
        <p>The pack howls at <b>${esc(t.name)}</b>. Join in with a Snap! (ignores range)? Everyone sees who joins and who holds back.</p>
        ${help === 'tips' && pd.target === g.shepherdSeat ? `<p class="coach-inline">${myTeam() === 'coyote' ? 'Joining helps the pack, but everyone will read it as a coyote move.' : 'Joining an attack on the Shepherd marks you as a coyote. Hold back.'}</p>` : ''}
        <div class="btns"><button class="btn bad" data-act="howl-yes">Snap them</button><button class="btn" data-act="howl-no">Hold back</button></div>`;
    }
    case 'crow':
      return `<h3>Crow</h3>
        <p>You drew <b>${esc(cardName(pd.card))}</b> ${icon(pd.card.icon)}. Drop it into the Dark pile, or let it go?</p>
        <div class="btns"><button class="btn primary" data-act="crow-drop">Drop it in</button><button class="btn" data-act="crow-pass">Let it go</button></div>`;
    case 'charge': {
      const a = g.players[pd.attacker];
      return `<h3>Charge</h3>
        <p>Snap! <b>${esc(a.name)}</b> right back, ignoring range? It uses a Snap! card but not your one-per-turn Snap!.</p>
        <div class="btns"><button class="btn bad" data-act="charge-yes">Charge</button><button class="btn" data-act="charge-no">Not now</button></div>`;
    }
    case 'woolly':
      return `<h3>Hold the gate</h3>
        <p>The reveal would cost <b>${sheepWord(pd.lost)}</b>. Lose 1 life to save one? You have ${livesWord(me.lives)}.</p>
        <div class="btns"><button class="btn good" data-act="woolly-yes">Save a sheep</button><button class="btn" data-act="woolly-no">No</button></div>`;
  }
  return '';
}

function kitChoiceHTML() {
  const t = game.players[ui.kitChoice.target];
  const kits = game.ownKits(t);
  return `<h3>Spook</h3>
    <p>Which of <b>${esc(t.name)}</b>'s kit cards goes?</p>
    <div class="btns">${kits.map(k => `<button class="btn primary" data-act="kit:${k.id}">${esc(cardName(k))}</button>`).join('')}<button class="btn" data-act="kit-back">Back</button></div>`;
}

function introBody(g) {
  const me = g.players[HUMAN];
  const info = ROLE_INFO[me.role];
  const pack = me.role === 'coyote' && g.opt.coyotesKnow
    ? `<p>Your pack: <b>${g.players.filter(p => p !== me && p.role === 'coyote').map(p => esc(p.name)).join(', ')}</b>. They know you too.</p>`
    : '';
  const shep = me.role === 'shepherd' ? '' : `<p>The Shepherd is <b>${esc(g.players[g.shepherdSeat].name)}</b>.</p>`;
  // Role (your secret side) and character (the animal you play) are
  // different things; keep them visibly separate so a goose who is a
  // Sheepdog doesn't read as a contradiction.
  return `<div class="intro-art"><span class="pt-wrap">${charImg(me, 'intro-pt')}${roleImg(me.role, 'intro-badge')}</span></div>
    <div class="intro-kicker">Your secret role</div>
    <h3 class="${ROLE_CLASS[me.role]}">${info.name}</h3>
    <p>${esc(info.goal)}</p>${pack}${shep}
    <div class="intro-kicker">Your character</div>
    <p><b>${esc(me.character.name)} the ${esc(me.character.animal)}.</b> <b>${esc(me.character.ability)}:</b> ${esc(me.character.text)}</p>
    ${CHAR_TIPS[me.character.id] ? `<p class="intro-tip">${esc(CHAR_TIPS[me.character.id])}</p>` : ''}
    <p class="intro-note">Your role is your side, and it stays secret. Your character is just the animal you play, with one special ability. Any animal can have any role.</p>
    <p>${g.n} players · ${g.opt.nights} nights · coyotes need ${sheepWord(g.denTarget)} in the den · ${TIERS[g.tier]?.label ?? 'Normal'} opponents.</p>`;
}

function overlayHTML(o) {
  const g = game;
  if (o.kind === 'intro') {
    return `${introBody(g)}
      ${help !== 'off' ? '<p class="coach-inline">Tap any player during the game to see what they\'ve done and which side it points to. <b>Who\'s who</b> (top right) sums up the table.</p>' : ''}
      <div class="btns"><button class="btn primary" data-act="overlay-ok">Begin</button></div>`;
  }
  if (o.kind === 'reveal') {
    const ev = o.data;
    const lanterns = ev.icons.lantern + ev.kitLanterns;
    const cancelled = Math.min(ev.icons.moon, Math.floor(lanterns / g.opt.lanternsPerMoon));
    return `<h3>Night ${ev.night} reveal</h3>
      <div class="reveal-counts">
        <div class="rc">${ICON_SVG.moon}<b>${ev.icons.moon}</b><span>moon</span></div>
        <div class="rc">${ICON_SVG.lantern}<b>${ev.icons.lantern}${ev.kitLanterns ? `+${ev.kitLanterns}` : ''}</b><span>lantern${ev.kitLanterns ? ' +kit' : ''}</span></div>
        <div class="rc">${ICON_SVG.blank}<b>${ev.icons.blank}</b><span>blank</span></div>
      </div>
      <p>${plural(lanterns, 'lantern')} cancel ${plural(cancelled, 'moon')}.${ev.saved ? ' Woolly held the gate and saved one sheep.' : ''}</p>
      <div class="reveal-result ${ev.lost ? 'bad' : 'good'}">${ev.lost ? `${ev.lost} sheep lost` : 'No sheep lost'} · den ${ev.den}/${g.denTarget}</div>
      <div class="btns"><button class="btn primary" data-act="overlay-ok">${ev.night >= g.opt.nights ? 'Dawn…' : 'Next night'}</button></div>`;
  }
  if (o.kind === 'over') {
    const r = g.result;
    const me = g.players[HUMAN];
    const won = ROLE_INFO[me.role].team === r.winner || (me.role === 'fox' && r.foxWin);
    const rows = g.turnOrder().map(s => {
      const p = g.players[s];
      return `<tr><td>${charImg(p, 'rt-pt')}<b>${esc(p.name)}</b></td><td class="${ROLE_CLASS[p.role]}">${ROLE_INFO[p.role].name}</td><td>${p.crow ? 'crow' : livesWord(p.lives)} · ${p.kills} KO</td></tr>`;
    }).join('');
    return `<h3>${r.winner === 'flock' ? 'The flock wins' : 'The coyotes win'}</h3>
      <div class="big-result ${won ? 'win' : 'lose'}">${won ? 'You win' : 'You lose'}</div>
      <p>${esc(o.data.text)}</p>
      <table class="results-table">${rows}</table>
      <div class="btns"><button class="btn primary" data-act="play-again">Play again</button><button class="btn" data-act="new-game">New game</button></div>`;
  }
  return '';
}

function rulesHTML() {
  const lpm = game?.opt.lanternsPerMoon ?? DEFAULTS.lanternsPerMoon;
  return `<h3>How to play Lanterns Out</h3>
    <h4>Role and character</h4>
    <p>Everyone gets two things. A <b>role</b> is your side: it's secret (except the Shepherd's) and decides how you win. A <b>character</b> is the farm animal you play, with one special ability. Any animal can have any role: Mabel the goose might be a Sheepdog in one game and a Coyote in the next.</p>
    <p><button class="btn-link rules-jump" data-act="rules-chars">Jump to the characters</button></p>
    <h4>The roles</h4>
    <ul>
      <li>${roleImg('shepherd', 'rb')}<b class="r-shepherd">Shepherd</b> (everyone knows who): survive to dawn, or knock out every Coyote.</li>
      <li>${roleImg('sheepdog', 'rb')}<b class="r-sheepdog">Sheepdogs</b> (hidden): win with the Shepherd, even after being knocked out.</li>
      <li>${roleImg('hunter', 'rb')}<b class="r-hunter">Hunter</b> (hidden, 5+ players, flock side): once a night may Snap! at any distance, which reveals them. When knocked out, gets one free last shot.</li>
      <li>${roleImg('coyote', 'rb')}<b class="r-coyote">Coyotes</b> (hidden, know each other): knock out the Shepherd, or get enough sheep into the den.</li>
      <li>${roleImg('fox', 'rb')}<b class="r-fox">Fox</b> (hidden, 6+ players): be alive at the end with at least one knockout. Wins alongside whoever wins.</li>
    </ul>
    <h4>Your turn</h4>
    <ul class="steps">
      <li><b>Draw</b> 2 cards.</li>
      <li><b>Day:</b> play cards. Only one Snap! per turn.</li>
      <li><b>Dark:</b> put 1 card face down in the Dark pile.</li>
      <li><b>Rest:</b> discard down to 5.</li>
    </ul>
    <h4>The reveal</h4>
    <p>When every player has had a turn, the Dark pile is shuffled and counted. Each ${icon('moon')} moon takes a sheep to the den. Every ${lpm} ${icon('lantern')} lanterns cancel a moon (Lantern kits count). Nobody sees who put in what, but you know your own card.</p>
    <h4>Range</h4>
    <p>Distance is the number of seats between you, the short way round. Your Snap! reaches your range: 1, plus 1 for the Shepherd's Crook, plus 1 for a Hayloft.</p>
    <h4>Knockouts</h4>
    <p>At 0 lives you become a crow and your role is revealed. You stay on your team, and each night you draw a card and may drop it into the dark. Knocking out a Coyote brings a sheep home from the den. If the Shepherd knocks out one of the flock, a sheep runs off to the den.</p>
    ${charactersHTML()}
    <div class="btns"><button class="btn primary" data-act="rules-close">Got it</button></div>`;
}

// What each character's ability is for, in plain words. Kept next to the
// engine's one-line ability text; check both when an ability changes.
const CHAR_TIPS = {
  oldblue: "The card is picked at random from the other players' cards. A moon is close to proof; a lantern clears them. What you see is added to that player's list.",
  mabel: "Hold on to Dodge! cards: they protect you and strip your attackers' hands.",
  woolly: 'Everyone sees you do it, so it reads as a flock move. Careful at 1 life: it can knock you out.',
  clementine: "That's double a normal Mend. Sitting next to the Shepherd makes you their best protector.",
  tiny: "You need a Snap! card in hand. It doesn't use up your one Snap! for the turn, so attackers think twice.",
  duke: 'Everyone sees those cards. Pick your top suspect: a face-up moon is hard to explain. Only 2 lives.',
  hazel: "A face-up lantern shows everyone which side you're helping, and the extra card keeps your hand full. Only 2 lives.",
  boots: 'Two lanterns cancel a whole moon; two moons can take two sheep. Putting in none keeps your hand full. Only 2 lives.',
};

function charactersHTML() {
  const delta = game?.opt.lifeDelta ?? DEFAULTS.lifeDelta;
  const rows = CHARACTERS.map(c => {
    const lives = Math.max(1, c.lives + delta);
    return `<div class="char-row">
      <img class="char-pt" src="${ART}char-${c.id}.svg${ART_V}" alt="${esc(c.name)} the ${esc(c.animal)}">
      <div class="char-info">
        <div class="char-name"><b>${esc(c.name)}</b> the ${esc(c.animal)} <span class="lives" title="${livesWord(lives)}">${'♥'.repeat(lives)}</span></div>
        <div class="char-ability"><b>${esc(c.ability)}:</b> ${esc(c.text)}</div>
        <div class="char-tip">${esc(CHAR_TIPS[c.id] || '')}</div>
      </div>
    </div>`;
  }).join('');
  return `<h4 id="rulesChars">The characters</h4>
    <p>Characters are dealt at random, and everyone can see who has which. Hearts show starting lives; the Shepherd gets 1 more. Duke, Hazel, and Boots have strong abilities but only 2 lives.</p>
    <div class="char-list">${rows}</div>`;
}

// ── Input ──
function onCard(id) {
  const pd = ui.pending;
  if (!pd) return;
  if (pd.kind === 'day') {
    ui.selected = ui.selected[0] === id ? [] : [id];
    ui.mendPicks = [];
    return render();
  }
  if (pd.kind === 'dark' || pd.kind === 'discard') {
    const max = pd.kind === 'dark' ? pd.count : pd.n;
    if (ui.selected.includes(id)) ui.selected = ui.selected.filter(x => x !== id);
    else if (max === 1) ui.selected = [id];
    else if (ui.selected.length < max) ui.selected.push(id);
    return render();
  }
}

function scrollToChars() {
  document.getElementById('rulesChars')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function openSheet(which) {
  if (!game) return;
  ui.sheet = which;
  closeDropdown();
  renderModal();
}

function onSeat(s) {
  const pd = ui.pending;
  // Not a target right now: show what this player has been doing.
  if (!pd || !currentTargets().includes(s)) return openSheet(s);
  if (pd.kind === 'duke' || pd.kind === 'lastshot') return answer(s);
  if (pd.kind !== 'day') return;
  const me = game.players[HUMAN];
  const card = me.hand.find(c => c.id === ui.selected[0]);
  if (!card) return;
  if (card.type === 'mend' && me.character.id === 'clementine') {
    ui.mendPicks.push(s);
    if (ui.mendPicks.length >= 2) return answer({ cardId: card.id, targets: ui.mendPicks.slice(0, 2) });
    return render();
  }
  if (card.type === 'spook') {
    const kits = game.ownKits(game.players[s]);
    if (kits.length > 1) {
      ui.kitChoice = { cardId: card.id, target: s };
      return render();
    }
    return answer({ cardId: card.id, target: s, kitId: kits[0]?.id });
  }
  return answer({ cardId: card.id, target: s });
}

function onAct(act) {
  const me = game?.players[HUMAN];
  const snapId = () => me?.hand.find(c => c.type === 'snap')?.id ?? null;
  switch (act) {
    case 'rules': ui.rulesOpen = true; closeDropdown(); return renderAny();
    case 'rules-close': ui.rulesOpen = false; releaseGate(); return renderAny();
    case 'chars': ui.rulesOpen = true; closeDropdown(); renderAny(); return scrollToChars();
    case 'rules-chars': return scrollToChars();
    case 'who': return openSheet('who');
    case 'sheet-close': ui.sheet = null; releaseGate(); return render();
    case 'coach-ok': ui.coach.shift(); return render();
    case 'learn': return startLearn();
    case 'new-game': closeDropdown(); return backToSetup();
    case 'play-again': return startGame();
    case 'overlay-ok': {
      const o = ui.overlay;
      ui.overlay = null;
      renderAny();
      return o?.resolve();
    }
    case 'end-day': return answer({ type: 'end' });
    case 'deselect': ui.selected = []; ui.mendPicks = []; return render();
    case 'play': return answer({ cardId: ui.selected[0] });
    case 'self': return onSeat(HUMAN);
    case 'mend-now': return answer({ cardId: ui.selected[0], targets: [...ui.mendPicks] });
    case 'dark-down': return answer({ cardIds: [...ui.selected], faceUp: false });
    case 'dark-up': return answer({ cardIds: [...ui.selected], faceUp: true });
    case 'discard': return answer([...ui.selected]);
    case 'duke-skip': return answer(null);
    case 'r-dodge': return answer('dodge');
    case 'r-bristle': return answer('bristle');
    case 'r-none': return answer('none');
    case 'howl-yes': return answer(snapId());
    case 'howl-no': return answer(null);
    case 'crow-drop': return answer('drop');
    case 'crow-pass': return answer('discard');
    case 'charge-yes': return answer(snapId());
    case 'charge-no': return answer(null);
    case 'woolly-yes': return answer(true);
    case 'woolly-no': return answer(false);
    case 'kit-back': ui.kitChoice = null; return render();
  }
  if (act.startsWith('sheet:')) return openSheet(Number(act.slice(6)));
  if (act.startsWith('help:')) return setHelp(act.slice(5));
  if (act.startsWith('kit:') && ui.kitChoice) {
    const kc = ui.kitChoice;
    ui.kitChoice = null;
    return answer({ cardId: kc.cardId, target: kc.target, kitId: Number(act.slice(4)) });
  }
}

// ── Game lifecycle ──
async function startGame() {
  ui.overlay?.resolve();
  const n = Number($('selPlayers').value);
  const tier = $('selTier').value;
  let role = $('selRole').value;
  if (role !== 'random' && !ROLE_TABLE[n][role]) {
    toast(`There is no ${ROLE_INFO[role].name} at ${n} players. Your role is random.`);
    role = 'random';
  }
  const ctrls = [new HumanController(), ...Array.from({ length: n - 1 }, () => new CoyoteAI())];
  const g = new CoyoteGame({
    numPlayers: n,
    controllers: ctrls,
    onEvent: ev => handleEvent(g, ev),
    forceRole: role === 'random' ? null : role,
  });
  g.players[HUMAN].name = `${g.players[HUMAN].character.name} (you)`;
  // Difficulty applies to your opponents; computer teammates stay Normal.
  const myTeam = ROLE_INFO[g.players[HUMAN].role].team;
  g.players.forEach((p, i) => {
    if (i === HUMAN) return;
    const team = ROLE_INFO[p.role].team;
    ctrls[i].setTier(team === myTeam && team !== 'fox' ? 'normal' : tier);
  });
  g.tier = tier;
  game = g;
  clues = new ClueTracker(g, HUMAN);
  feed = [];
  gateWaiters = []; // a paused old game stays frozen
  ui = freshUI(ui);
  $('setupScreen').style.display = 'none';
  $('gameBoard').style.display = 'flex';
  render();
  await overlay('intro');
  if (g !== game) return;
  tip('plan', planTip(g));
  render();
  await g.run();
}

// "Learn to play": the friendliest first game. A Sheepdog does the core
// job (find the coyotes), 5 players includes the Hunter, Easy opponents
// forgive mistakes, and the coach is on.
function startLearn() {
  $('selPlayers').value = '5';
  $('selRole').value = 'sheepdog';
  $('selTier').value = 'easy';
  showTierHint();
  setHelp('tips');
  return startGame();
}

function backToSetup() {
  ui.overlay?.resolve();
  game = null;
  gateWaiters = [];
  ui = freshUI(ui);
  $('gameBoard').style.display = 'none';
  $('setupScreen').style.display = 'flex';
  renderModal();
}

let toastTimer = null;
// In a game, messages show as a line in the yard (never over a dialog).
// On the setup screen they use the floating toast.
function toast(msg, cls = '') {
  clearTimeout(toastTimer);
  if (game) {
    ui.flash = { text: msg, cls };
    renderYard();
    toastTimer = setTimeout(() => { ui.flash = null; if (game) renderYard(); }, 2600);
    return;
  }
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show ${cls}`;
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function closeDropdown() { $('settingsDropdown').classList.remove('open'); }

function setSpeed(s) {
  speed = SPEEDS[s] ? s : 'normal';
  try { localStorage.setItem('coyote-speed', speed); } catch { /* private mode */ }
  document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('active', b.dataset.speed === speed));
}

function setHelp(h) {
  help = HELP_LEVELS.includes(h) ? h : 'tips';
  try { localStorage.setItem('coyote-help', help); } catch { /* private mode */ }
  document.querySelectorAll('[data-act^="help:"]').forEach(b => b.classList.toggle('active', b.dataset.act === `help:${help}`));
  $('selHelp').value = help;
  if (help !== 'tips') ui.coach = [];
  if (game) render();
}

// ── Wiring ──
initTheme();
setSpeed(speed);
setHelp(help);
$('btnStart').addEventListener('click', startGame);
function showTierHint() { $('tierHint').textContent = TIER_HINTS[$('selTier').value] || ''; }
$('selTier').addEventListener('change', showTierHint);
$('selHelp').addEventListener('change', () => setHelp($('selHelp').value));
showTierHint();
$('youPanel').addEventListener('click', e => { if (!e.target.closest('[data-act]')) openSheet(HUMAN); });
$('logoWrap').addEventListener('click', e => {
  if (e.target.closest('.settings-dropdown')) return;
  e.stopPropagation();
  $('settingsDropdown').classList.toggle('open');
});
document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation();
  setSpeed(b.dataset.speed);
}));
document.addEventListener('click', e => {
  if (!e.target.closest('#logoWrap')) closeDropdown();
  const actEl = e.target.closest('[data-act]');
  if (actEl) {
    if (!actEl.disabled) onAct(actEl.dataset.act);
    return;
  }
  const card = e.target.closest('[data-card]');
  if (card) return onCard(Number(card.dataset.card));
  const seat = e.target.closest('[data-seat]');
  if (seat) return onSeat(Number(seat.dataset.seat));
  if (e.target.closest('#feed')) {
    ui.logOpen = !ui.logOpen;
    renderFeed();
  }
});
