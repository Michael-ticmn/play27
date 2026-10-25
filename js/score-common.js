// ============================================================
// play27 — Scorekeeper shared module
// No-account Supabase access, live table state, contract text,
// card rendering, the card-counting score keypad, and QR codes.
// Used by scorekeeper.js (host) and scorecard.js (player).
// ============================================================

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { sb, SUPABASE_URL, SUPABASE_ANON_KEY, APP_VERSION } from './supabase.js?v=0.15.12';

export { APP_VERSION };

// ?sb=local points the page at the local Supabase stack (default demo anon key) for testing.
const LOCAL = new URLSearchParams(location.search).get('sb') === 'local';
const API_URL = LOCAL ? 'http://127.0.0.1:54321' : SUPABASE_URL;
const API_KEY = LOCAL
  ? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
  : SUPABASE_ANON_KEY;

// Own client with no stored session, so it never picks up (or disturbs) a play27 login.
export const client = createClient(API_URL, API_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'p27-score' }
});

/** Extra query string to carry local test mode into links and QR codes. */
export const linkSuffix = LOCAL ? '&sb=local' : '';

/* ---------- host sign-in (play27 accounts) ---------- */

// Hosts sign in with their play27 account. On the live site this is play27's own client, so a
// play27 login on the same device carries over. Players never sign in.
const AUTH_STORAGE_KEY = LOCAL ? 'p27-score-local-auth' : 'sb-' + new URL(SUPABASE_URL).hostname.split('.')[0] + '-auth-token';
export const authClient = LOCAL
  ? createClient(API_URL, API_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: AUTH_STORAGE_KEY } })
  : sb;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

/** The signed-in host's session, or null. Falls back to the stored session if the client stalls. */
export async function currentSession() {
  try {
    const r = await withTimeout(authClient.auth.getSession(), 5000);
    return (r && r.data && r.data.session) || null;
  } catch (e) {
    try { const raw = localStorage.getItem(AUTH_STORAGE_KEY); const s = raw ? JSON.parse(raw) : null; return s && s.access_token ? s : null; }
    catch (e2) { return null; }
  }
}

export async function signIn(email, password) {
  let r;
  try { r = await withTimeout(authClient.auth.signInWithPassword({ email, password }), 15000); }
  catch (e) { throw new Error("Can't reach play27 to sign in. Check the connection and try again."); }
  if (r.error) throw new Error(/invalid login/i.test(r.error.message) ? "That email and password don't match a play27 account." : r.error.message);
  return r.data.session;
}

export async function signOut() {
  try { await withTimeout(authClient.auth.signOut(), 5000); } catch (e) { /* clear locally below */ }
  try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) { }
}

/** Call a score_* database function. Uses the public key unless a signed-in access token is given. Throws Error(message). */
export async function call(fn, params = {}, accessToken) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(`${API_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: API_KEY, Authorization: `Bearer ${accessToken || API_KEY}` },
      body: JSON.stringify(params),
      signal: ctrl.signal
    });
    const text = await resp.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = text; } }
    if (!resp.ok) {
      const err = new Error((data && data.message) || 'Something went wrong. Try again.');
      err.status = resp.status;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('The connection timed out. Try again.');
    if (err instanceof TypeError) throw new Error("Can't reach the server. Check the connection and try again.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- live table state ---------- */

function normalize(t, players, entries) {
  const contracts = Array.isArray(t.contracts) && t.contracts.length ? t.contracts : [{ sets: 2, runs: 0, deal: 10, all: false }];
  const scores = {}, times = {};
  entries.forEach(e => {
    if (typeof e.score !== 'number') return;
    (scores['h' + e.hand] = scores['h' + e.hand] || {})[e.player_id] = e.score;
    (times['h' + e.hand] = times['h' + e.hand] || {})[e.player_id] = Date.parse(e.updated_at) || 0;
  });
  return {
    id: t.id, code: t.code, status: t.status, gameNo: t.game_no,
    hand: Math.max(0, Math.min(contracts.length - 1, t.hand || 0)),
    firstDealer: t.first_dealer || 0,
    contracts,
    rules: Object.assign({ setSize: 3, runLen: 3, buys: null }, t.rules || {}),
    values: Object.assign({ numbers: 'face', face: 10, ace: 15, joker: 25 }, t.card_values || {}),
    notes: t.notes || '',
    endedAt: t.ended_at, createdAt: t.created_at,
    announce: { what: t.announce, seq: t.announce_seq || 0, at: t.announce_at },
    players: players.filter(p => !p.removed)
      .sort((a, b) => (a.seat - b.seat) || String(a.created_at).localeCompare(String(b.created_at)))
      .map(p => ({ id: p.id, name: p.name, c: p.color, hasDevice: p.has_device })),
    scores, times
  };
}

/**
 * Keep a table's state fresh: realtime changes trigger a refetch, with polling as a backstop
 * (phones drop websockets in the background). onState(game|null) — null means the table closed.
 * onStatus('live' | 'polling' | 'offline' | 'connecting').
 */
export function watchTable(code, onState, onStatus) {
  let tableId = null, channel = null, debounce = null, gen = 0, stopped = false, last = '';

  async function load() {
    const my = ++gen;
    const { data: t, error } = await client.from('score_tables').select('*').eq('code', code).maybeSingle();
    if (stopped || my !== gen) return;
    if (error) { onStatus('offline'); return; }
    if (!t) { last = ''; onState(null); return; }
    if (t.id !== tableId) { tableId = t.id; subscribe(); }
    const [pl, en] = await Promise.all([
      client.from('score_players').select('id,name,seat,color,has_device,removed,created_at').eq('table_id', t.id),
      client.from('score_entries').select('player_id,hand,score,updated_at').eq('table_id', t.id).eq('game_no', t.game_no)
    ]);
    if (stopped || my !== gen) return;
    if (pl.error || en.error) { onStatus('offline'); return; }
    const g = normalize(t, pl.data, en.data);
    // Skip identical refreshes (polling, echoes of our own writes) so the page is not rebuilt under a tap.
    const sig = JSON.stringify(Object.assign({}, g, { updatedAt: undefined }));
    if (sig === last && !force) return;
    last = sig; force = false;
    onState(g);
  }
  let force = false;
  function schedule() { clearTimeout(debounce); debounce = setTimeout(load, 120); }
  function subscribe() {
    if (channel) client.removeChannel(channel);
    channel = client.channel('score-' + tableId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'score_tables', filter: 'id=eq.' + tableId }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'score_players', filter: 'table_id=eq.' + tableId }, schedule)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'score_entries', filter: 'table_id=eq.' + tableId }, schedule)
      // "SUBSCRIBED" can arrive before the database feed is flowing; catch up again once it is.
      .on('system', {}, payload => { if (payload && payload.extension === 'postgres_changes') schedule(); })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') { onStatus('live'); schedule(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') onStatus('polling');
      });
  }
  const poll = setInterval(load, 10000);
  const onVis = () => { if (document.visibilityState === 'visible') load(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', load);
  onStatus('connecting');
  load();
  return {
    refresh: load,
    // Deliver the next state even if unchanged (after an optimistic local edit that the server rejected).
    resync() { force = true; return load(); },
    stop() {
      stopped = true; clearInterval(poll); clearTimeout(debounce);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', load);
      if (channel) client.removeChannel(channel);
    }
  };
}

/* ---------- small utilities ---------- */

export const $ = s => document.querySelector(s);
export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function clampInt(v, lo, hi, d) { v = parseInt(v, 10); if (!isFinite(v)) return d; return Math.max(lo, Math.min(hi, v)); }
export function store(key, val) {
  try {
    if (val === undefined) { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; }
    if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val));
  } catch (e) { /* storage blocked */ }
  return null;
}
export function fmtDate(v) {
  try { return new Date(v).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; }
}
export function listNames(ps) {
  const n = ps.map(p => esc(p.name));
  if (n.length <= 1) return n.join('');
  return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}
let toastTimer = null;
export function toast(msg) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
}
export function syncLabel(el, status) {
  if (!el) return;
  el.className = 'sync ' + status;
  el.querySelector('.sync-t').textContent =
    status === 'live' ? 'Live' : status === 'polling' ? 'Updating every few seconds' : status === 'offline' ? 'Offline, retrying' : 'Connecting';
}

/* ---------- game math ---------- */

export const COLORS = ['#e3b965', '#ee8a6a', '#86c0e3', '#bba2ea', '#93d6ad', '#ee9cbc', '#d6c39d', '#6fcfc9'];
export function colorOf(p) { return COLORS[((p && p.c) || 0) % COLORS.length]; }
export function cellv(g, h, id) { const row = g.scores['h' + h]; const v = row ? row[id] : null; return typeof v === 'number' ? v : null; }
export function totalsMap(g) {
  const t = {};
  g.players.forEach(p => {
    let s = 0;
    for (let h = 0; h < g.contracts.length; h++) { const v = cellv(g, h, p.id); if (v !== null) s += v; }
    t[p.id] = s;
  });
  return t;
}
export function ranked(g) {
  const t = totalsMap(g);
  const rows = g.players.map((p, i) => ({ p, i, total: t[p.id] }));
  rows.sort((a, b) => (a.total - b.total) || (a.i - b.i));
  let prev = null, rank = 0;
  rows.forEach((r, k) => { if (prev === null || r.total !== prev) { rank = k + 1; prev = r.total; } r.rank = rank; });
  const lead = rows.length ? rows[0].total : 0;
  rows.forEach(r => { r.gap = r.total - lead; });
  return rows;
}
export function missing(g, h) { return g.players.filter(p => cellv(g, h, p.id) === null); }
/** Players with 0 (went out) for hand h. Only one player can go out, so more than one means the hand is contested. */
export function wentOut(g, h) { return g.players.filter(p => cellv(g, h, p.id) === 0); }
/** When the last score for hand h was saved (ms, server clock), or null if none are in. */
export function allInAt(g, h) {
  const row = g.times['h' + h] || {};
  let t = null;
  g.players.forEach(p => { const v = row[p.id]; if (v && (t === null || v > t)) t = v; });
  return t;
}
export function anyScores(g) { return Object.keys(g.scores).some(k => Object.keys(g.scores[k]).length); }
function seatAt(g, h, off) { const n = g.players.length; return n ? g.players[(g.firstDealer + h + off) % n] : null; }
export function dealerOf(g, h) { return seatAt(g, h, 0); }
export function firstOf(g, h) { return seatAt(g, h, 1); }
export function rankValue(g, k) {
  const v = g.values;
  if (k === 'JK') return Number(v.joker);
  if (k === 'A') return Number(v.ace);
  if (k === '10' || k === 'J' || k === 'Q' || k === 'K') return Number(v.face);
  return v.numbers === 'flat5' ? 5 : parseInt(k, 10);
}

/* ---------- contract text ---------- */

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const word = n => WORDS[n] || String(n);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => (n === 1 ? one : many);
export function cTitle(c) {
  const a = [];
  if (c.sets) a.push(cap(word(c.sets)) + ' ' + plural(c.sets, 'Set', 'Sets'));
  if (c.runs) a.push(cap(word(c.runs)) + ' ' + plural(c.runs, 'Run', 'Runs'));
  return a.join(' + ') || 'Open hand';
}
export function cLong(c, r) {
  const a = [];
  if (c.sets) a.push(word(c.sets) + ' ' + plural(c.sets, 'set', 'sets') + ' of ' + word(r.setSize));
  if (c.runs) a.push(word(c.runs) + ' ' + plural(c.runs, 'run', 'runs') + ' of ' + word(r.runLen));
  return a.length ? cap(a.join(' and ')) : 'No meld required';
}
export function cCode(c) { return ('S'.repeat(c.sets) + 'R'.repeat(c.runs)) || '-'; }
export function cMin(c, r) { return c.sets * r.setSize + c.runs * r.runLen; }
export function rulesLine(r) {
  return '<strong>Set:</strong> ' + r.setSize + ' or more of one rank. <strong>Run:</strong> ' + r.runLen +
    ' or more in a row, same suit. Aces play high or low, no wrapping. <strong>Buy:</strong> take the discard plus one card from the deck' +
    (r.buys ? ', ' + r.buys + ' per hand' : '') + '.';
}

/* ---------- read aloud (browser speech, no network) ---------- */

export const canSpeak = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function';
let voice = null;
function pickVoice() {
  const vs = window.speechSynthesis.getVoices() || [];
  voice = vs.find(v => v.lang === 'en-US' && v.localService) || vs.find(v => /^en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
}
if (canSpeak) {
  pickVoice();
  if (window.speechSynthesis.addEventListener) window.speechSynthesis.addEventListener('voiceschanged', pickVoice);
}

export function speak(text) {
  if (!canSpeak || !text) return;
  window.speechSynthesis.cancel();
  const u = new window.SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'en-US';
  u.rate = 0.95;
  window.speechSynthesis.speak(u);
}

/** iOS only lets a page talk after a tap; call this from a tap to allow later announcements. */
export function unlockSpeech() {
  if (!canSpeak) return;
  const u = new window.SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

function joinWords(names) {
  return names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export function handSpeech(g) {
  if (g.status === 'done') return 'The game is over.';
  const C = g.contracts, h = g.hand, c = C[h];
  const d = dealerOf(g, h), f = firstOf(g, h);
  let s = 'Hand ' + (h + 1) + ' of ' + C.length + ': ' + cLong(g.contracts[h], g.rules).toLowerCase() + '. Deal ' + c.deal + ' cards.';
  if (d) s += ' ' + d.name + ' deals' + (f && f.id !== d.id ? ', and ' + f.name + ' plays first.' : '.');
  if (c.all) s += ' Meld every card except your final discard.';
  return s;
}

export function standingsSpeech(g) {
  if (!g.players.length) return 'Nobody is at the table yet.';
  if (!anyScores(g)) return 'No scores yet.';
  const done = g.status === 'done';
  let scored = 0;
  for (let h = 0; h < g.contracts.length; h++) if (!missing(g, h).length) scored = h + 1;
  const groups = [];
  ranked(g).forEach(r => {
    const last = groups[groups.length - 1];
    if (last && last.rank === r.rank) last.names.push(r.p.name);
    else groups.push({ rank: r.rank, total: r.total, names: [r.p.name] });
  });
  let s = done ? 'Final standings.' : scored ? 'Standings after hand ' + scored + '.' : 'Standings so far.';
  groups.forEach((gr, i) => {
    const who = joinWords(gr.names), tie = gr.names.length > 1;
    if (i === 0) s += ' ' + who + (tie ? (done ? ' tie for the win with ' : ' are tied for the lead with ') : (done ? ' wins with ' : ' leads with ')) + gr.total + '.';
    else s += ' ' + who + (tie ? ', tied at ' : ', ') + gr.total + '.';
  });
  return s;
}

/** Words for an announcement: 'standings', 'hand', or 'both' (standings first, then the hand being dealt). */
export function speechFor(g, what) {
  if (what === 'hand') return handSpeech(g);
  if (what === 'standings') return standingsSpeech(g);
  return standingsSpeech(g) + ' ' + handSpeech(g);
}

/* ---------- example melds ---------- */

const VS = '︎';
const SUIT = { s: '♠' + VS, h: '♥' + VS, d: '♦' + VS, c: '♣' + VS };
const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const RED = { h: true, d: true };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const RANK_NAME = { A: 'ace', J: 'jack', Q: 'queen', K: 'king', JK: 'joker' };
const SET_EX = [['K', 'shd'], ['7', 'cdh'], ['4', 'hsc'], ['Q', 'dcs'], ['9', 'sch']];
const RUN_EX = [['h', 5], ['c', 9], ['s', 2], ['d', 6], ['h', 10]];

function setCards(i, size) {
  const ex = SET_EX[i % SET_EX.length];
  let suits = ex[1];
  'shdc'.split('').forEach(s => { if (suits.indexOf(s) < 0) suits += s; });
  return Array.from({ length: size }, (_, k) => ({ r: ex[0], s: suits[k % 4] }));
}
function runCards(i, len) {
  const ex = RUN_EX[i % RUN_EX.length];
  len = Math.min(len, 13);
  let st = ex[1] - 1;
  if (st + len > 13) st = Math.max(0, 13 - len);
  return Array.from({ length: len }, (_, k) => ({ r: RANKS[st + k], s: ex[0] }));
}
const cardName = c => (RANK_NAME[c.r] || c.r) + ' of ' + SUIT_NAME[c.s];
function cardHTML(c, k, n, fan, idx) {
  const rot = fan ? (k - (n - 1) / 2) * 6 : 0;
  return '<span class="pc' + (RED[c.s] ? ' red' : '') + '" style="--rot:' + rot + 'deg;--i:' + idx + '">' +
    '<span class="ix">' + c.r + '<span class="ixs">' + SUIT[c.s] + '</span></span><span class="pip">' + SUIT[c.s] + '</span></span>';
}
export function meldsHTML(c, r, extraClass) {
  let html = '', idx = 0;
  const meld = (kind, label, cards) => {
    const aria = (kind === 'set' ? 'Example set: ' : 'Example run: ') + cards.map(cardName).join(', ');
    const inner = cards.map((cd, k) => cardHTML(cd, k, cards.length, kind === 'set', idx++)).join('');
    return '<figure class="meld ' + kind + '" role="img" aria-label="' + esc(aria) + '"><div class="meld-cards">' + inner +
      '</div><figcaption class="meld-label">' + label + '</figcaption></figure>';
  };
  for (let i = 0; i < c.sets; i++) html += meld('set', 'Set of ' + r.setSize, setCards(i, r.setSize));
  for (let j = 0; j < c.runs; j++) html += meld('run', 'Run of ' + r.runLen, runCards(j, r.runLen));
  // width of all melds in card widths (overlap .44, set fan padding .34) so landscape can size cards to one row
  const units = c.sets * (1 + (r.setSize - 1) * 0.56 + 0.34) + c.runs * (1 + (Math.min(r.runLen, 13) - 1) * 0.56);
  return '<div class="melds ' + (extraClass || '') + '" style="--units:' + (units || 1).toFixed(2) + ';--mn:' + Math.max(c.sets + c.runs, 1) + '">' + html + '</div>';
}

/* ---------- QR code (qrcode-generator global, loaded by the host page) ---------- */

export function qrSVG(text, label) {
  if (typeof window.qrcode !== 'function') return '';
  const qr = window.qrcode(0, 'M');
  qr.addData(text); qr.make();
  const n = qr.getModuleCount(), m = 3, size = n + m * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
  return '<svg class="qr" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' + esc(label || 'QR code') + '">' +
    '<rect width="' + size + '" height="' + size + '"/><path d="' + d + '" shape-rendering="crispEdges"/></svg>';
}

/* ---------- score keypad modal ---------- */

const KEYS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', 'JK'];
const keyLabel = k => (k === 'JK' ? 'Jkr' : k);

/**
 * The card-counting score entry sheet.
 * opts.getGame() → current game; opts.save(pid, hand, value) → Promise; opts.remove(pid, hand) → Promise;
 * opts.next(pid, hand) → next player id to open after saving, or null to close.
 * opts.self → true on a player's phone, where the sheet is always "me".
 */
export function createScoreSheet(root, opts) {
  let s = null;

  function total() {
    const g = opts.getGame();
    const add = s.chips.reduce((a, k) => a + rankValue(g, k), 0);
    if (s.base === null && !s.chips.length) return null;
    return (s.base || 0) + add;
  }
  function chipsHTML() {
    const g = opts.getGame();
    if (!s.chips.length) return '<span class="hint">Tap the cards left in the hand, or type the total.</span>';
    return (s.base !== null ? '<span class="chip base">' + s.base + '</span>' : '') +
      s.chips.map(k => '<span class="chip">' + keyLabel(k) + ' ' + rankValue(g, k) + '</span>').join('');
  }
  function refresh() {
    const t = total();
    const input = root.querySelector('#sheet-total'); if (input) input.value = t === null ? '' : t;
    root.querySelector('#sheet-chips').innerHTML = chipsHTML();
    root.querySelector('#sheet-undo').disabled = !s.chips.length;
    root.querySelector('#sheet-err').textContent = s.err || '';
  }
  function open(pid, h) {
    const g = opts.getGame();
    const p = g && g.players.find(x => x.id === pid);
    const c = g && g.contracts[h];
    if (!p || !c) return;
    const v = cellv(g, h, pid);
    // Someone else already went out: a 0 here would make two winners, so it takes a deliberate "dispute" tap.
    const others = wentOut(g, h).filter(x => x.id !== pid);
    s = { pid, h, base: v, chips: [], had: v !== null, err: '', busy: false, others, dispute: false };
    const outBtn = others.length
      ? '<button type="button" class="btn" data-sk="out" disabled>' + listNames(others) + ' went out</button>'
      : '<button type="button" class="btn" data-sk="out">Went out (0)</button>';
    const dispute = others.length
      ? '<p class="hint">Not right? <button type="button" class="link" data-sk="dispute">' + (opts.self ? 'I' : esc(p.name)) +
        ' went out, not ' + listNames(others) + '</button>' + (opts.self ? '. The host settles who really went out.' : ', then pick who really went out.') + '</p>'
      : '';
    const keys = KEYS.map(k => '<button type="button" class="key' + (k === 'JK' ? ' jk' : '') + '" data-sk="key" data-k="' + k +
      '" aria-label="' + (RANK_NAME[k] || k) + ', ' + rankValue(g, k) + ' points"><span class="kr">' + keyLabel(k) + '</span><small>+' + rankValue(g, k) + '</small></button>').join('');
    root.innerHTML = '<div class="modal-back" data-sk="bg">' +
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="sheet-title" tabindex="-1">' +
      '<div class="modal-head"><div><p class="eyebrow">Hand ' + (h + 1) + ' &middot; ' + esc(cTitle(c)) + '</p>' +
      '<h2 class="modal-title" id="sheet-title"><span class="pdot" style="--pc:' + colorOf(p) + '"></span>' + esc(p.name) + '</h2></div>' +
      '<button type="button" class="icon-btn" data-sk="close" aria-label="Close without saving">&#x2715;</button></div>' +
      '<div class="total-row"><label class="sr" for="sheet-total">Points for ' + esc(p.name) + '</label>' +
      '<input class="total-in" id="sheet-total" type="text" inputmode="numeric" autocomplete="off" placeholder="0" value="' + (v === null ? '' : v) + '">' +
      '<span class="pts">points</span></div>' +
      '<div class="chips" id="sheet-chips"></div>' +
      '<div class="keypad" role="group" aria-label="Add a card left in hand">' + keys + '</div>' +
      '<div class="modal-row">' + outBtn +
      '<button type="button" class="btn" id="sheet-undo" data-sk="undo" disabled>Undo card</button>' +
      '<button type="button" class="btn" data-sk="clear">Clear</button></div>' + dispute +
      '<p class="err" id="sheet-err" role="alert"></p>' +
      '<div class="modal-row end">' + (s.had ? '<button type="button" class="btn danger" data-sk="remove">Remove score</button>' : '') +
      '<button type="button" class="btn primary" data-sk="save">Save</button></div></div></div>';
    refresh();
    const m = root.querySelector('.modal'); if (m) m.focus({ preventScroll: true });
  }
  function close() {
    if (!s) return;
    s = null; root.innerHTML = '';
    if (opts.onClose) opts.onClose();
  }
  async function save(force) {
    if (!s || s.busy) return;
    let v;
    if (force !== undefined) v = force;
    else {
      const raw = String(root.querySelector('#sheet-total').value || '').trim();
      if (raw === '') { s.err = 'Enter the points, or tap Went out.'; refresh(); return; }
      if (!/^-?\d{1,4}$/.test(raw)) { s.err = 'Points must be a whole number.'; refresh(); return; }
      v = parseInt(raw, 10);
    }
    if (v === 0 && s.others.length && !s.dispute) {
      s.err = joinWords(s.others.map(p => p.name)) + ' already went out on this hand. Only one player can go out.';
      refresh(); return;
    }
    const { pid, h } = s;
    s.busy = true;
    try { await opts.save(pid, h, v); }
    catch (e) { if (s) { s.busy = false; s.err = e.message; refresh(); } return; }
    const nxt = opts.next ? opts.next(pid, h) : null;
    if (nxt) open(nxt, h); else close();
  }

  root.addEventListener('click', async e => {
    const t = e.target.closest('[data-sk]'); if (!t || !s) return;
    const a = t.dataset.sk;
    if (a === 'bg') { if (e.target === t) close(); return; }
    if (a === 'close') close();
    else if (a === 'key') { s.chips.push(t.dataset.k); s.err = ''; refresh(); }
    else if (a === 'undo') { s.chips.pop(); refresh(); }
    else if (a === 'clear') { s.chips = []; s.base = null; s.err = ''; refresh(); }
    else if (a === 'out') save(0);
    else if (a === 'dispute') { s.dispute = true; save(0); }
    else if (a === 'save') save();
    else if (a === 'remove') {
      const { pid, h } = s;
      try { await opts.remove(pid, h); close(); } catch (err) { s.err = err.message; refresh(); }
    }
  });
  root.addEventListener('input', e => {
    if (e.target.id !== 'sheet-total' || !s) return;
    const raw = e.target.value.trim();
    s.chips = []; s.err = '';
    s.base = /^-?\d{1,4}$/.test(raw) ? parseInt(raw, 10) : null;
    root.querySelector('#sheet-chips').innerHTML = chipsHTML();
    root.querySelector('#sheet-undo').disabled = true;
  });
  root.addEventListener('keydown', e => {
    if (!s) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.target.id === 'sheet-total') { e.preventDefault(); save(); }
  });

  return { open, close, get isOpen() { return !!s; }, get playerId() { return s ? s.pid : null; } };
}
