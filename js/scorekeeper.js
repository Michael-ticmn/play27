// ============================================================
// play27 — Scorekeeper host (the table display)
// Opens a table, shows the join QR, the current contract and the
// standings, and lets the host enter or fix anyone's score.
// ============================================================

import {
  call, watchTable, linkSuffix, $, esc, clampInt, store, fmtDate, listNames, toast, syncLabel,
  colorOf, cellv, totalsMap, ranked, missing, anyScores, dealerOf, firstOf,
  cTitle, cLong, cCode, cMin, rulesLine, meldsHTML, qrSVG, createScoreSheet, client, APP_VERSION,
  canSpeak, speak, unlockSpeech, speechFor, currentSession, signIn, signOut
} from './score-common.js?v=0.15.2';

const HOST_KEY = 'p27sk.host';     // { code, token } for the table this device hosts
const PREFS_KEY = 'p27sk.prefs';   // last contracts, rules, card values, notes and player names
const TABLES_KEY = 'p27sk.tables'; // table ids this device has hosted, for past games
const VIEW_KEY = 'p27sk.view';
const SPEAKER_KEY = 'p27sk.speaker'; // true when this device reads announcements aloud

let host = store(HOST_KEY);
let game = null, loaded = false, watcher = null, syncState = 'connecting';
let view = 'board', editHand = null, armed = null, armTimer = null, lastHeroHand = null;
let pastGames = [], landingNote = '', overlay = null, creating = false;
let wake = null, wantWake = false;
let speakerOn = canSpeak && store(SPEAKER_KEY) === true, lastSeq = null;
let session = undefined, authBusy = false, authError = '', authEmail = ''; // undefined = still checking

const sheet = createScoreSheet($('#modal-root'), {
  getGame: () => game,
  save: (pid, h, v) => setScore(pid, h, v),
  remove: (pid, h) => setScore(pid, h, null),
  next: (pid, h) => {
    const ps = game.players, start = Math.max(0, ps.findIndex(p => p.id === pid));
    for (let k = 1; k < ps.length; k++) {
      const q = ps[(start + k) % ps.length];
      if (q.id !== pid && cellv(game, h, q.id) === null) return q.id;
    }
    return null;
  },
  onClose: () => render()
});

/* ---------- table lifecycle ---------- */

function joinURL() { return new URL('scorecard.html?t=' + host.code + linkSuffix, location.href).href; }
function hostURL(token) { return new URL('scorekeeper.html?t=' + host.code + linkSuffix + '#host=' + token, location.href).href; }

function rememberTable(id) {
  const ids = (store(TABLES_KEY) || []).filter(x => x !== id);
  ids.unshift(id);
  store(TABLES_KEY, ids.slice(0, 30));
}

function startWatch() {
  if (watcher) watcher.stop();
  watcher = watchTable(host.code, g => {
    if (!g) { forgetTable('That table is closed. Start a new one when you are ready.'); return; }
    const first = !game || game.id !== g.id;
    game = g; loaded = true;
    if (first) { rememberTable(g.id); loadPast(); lastSeq = g.announce.seq; }
    else if (g.announce.seq > lastSeq) {
      lastSeq = g.announce.seq;
      // Skip announcements that arrive late (a phone waking from sleep shouldn't read old news).
      const age = g.announce.at ? Math.abs(Date.now() - Date.parse(g.announce.at)) : Infinity;
      if (speakerOn && age < 120000) speak(speechFor(g, g.announce.what));
    }
    savePrefs();
    render();
  }, s => { syncState = s; renderTop(); });
}

function forgetTable(note) {
  if (watcher) { watcher.stop(); watcher = null; }
  sheet.close();
  host = null; game = null; overlay = null; loaded = true; landingNote = note || '';
  store(HOST_KEY, null);
  render();
  currentSession().then(s => { session = s; render(); });
}

function savePrefs() {
  const prev = store(PREFS_KEY) || {};
  store(PREFS_KEY, {
    contracts: game.contracts, rules: game.rules, values: game.values, notes: game.notes,
    players: game.players.length ? game.players.map(p => p.name) : (prev.players || [])
  });
}

async function loadPast() {
  const ids = store(TABLES_KEY) || [];
  if (!ids.length) { pastGames = []; return; }
  const { data } = await client.from('score_history').select('code,game_no,hands,results,ended_at')
    .in('table_id', ids).order('ended_at', { ascending: false }).limit(10);
  pastGames = data || [];
  if (view === 'setup') render();
}

/* ---------- writes ---------- */

let chain = Promise.resolve();
function hostCall(fn, extra) {
  const run = () => call(fn, Object.assign({ p_code: host.code, p_token: host.token }, extra || {}))
    .then(r => { if (watcher) watcher.refresh(); return r; })
    .catch(err => {
      if (/closed or the code is wrong/.test(err.message)) forgetTable('That table is closed.');
      else { toast(err.message); if (watcher) watcher.resync(); }
      throw err;
    });
  const p = chain.then(run, run);
  chain = p.catch(() => { });
  return p;
}
const quiet = p => p.catch(() => { });

function setScore(pid, h, v) {
  const key = 'h' + h;
  game.scores[key] = Object.assign({}, game.scores[key]);
  if (v === null) delete game.scores[key][pid]; else game.scores[key][pid] = v;
  if (game.status === 'setup' && v !== null) game.status = 'playing';
  render();
  return hostCall('score_host_set_score', { p_player_id: pid, p_hand: h, p_score: v });
}
function update(patch) { return quiet(hostCall('score_host_update', { p_patch: patch })); }

async function createTable() {
  if (creating) return;
  creating = true; render();
  const prefs = store(PREFS_KEY) || {};
  const seatPrev = !!($('#seat-prev') && $('#seat-prev').checked);
  try {
    session = await currentSession();
    if (!session) { authError = 'Sign in again to start a table.'; return; }
    const r = await call('score_create_table', {
      p_contracts: prefs.contracts || null, p_rules: prefs.rules || null, p_card_values: prefs.values || null,
      p_notes: prefs.notes || '', p_players: seatPrev && prefs.players && prefs.players.length ? prefs.players : null
    }, session.access_token);
    host = { code: r.code, token: r.host_token };
    store(HOST_KEY, host);
    landingNote = ''; loaded = false; lastHeroHand = null; editHand = null;
    setView('board');
    startWatch();
  } catch (e) {
    if (e.status === 401 || /jwt|sign in/i.test(e.message)) {
      // Expired or missing play27 session: show the sign-in form again.
      await signOut(); session = null;
      authError = 'Your play27 sign-in has expired. Sign in again to start a table.';
    } else toast(e.message);
  } finally {
    creating = false; render();
  }
}

async function doSignIn() {
  const email = ($('#si-email') || {}).value || '', password = ($('#si-pass') || {}).value || '';
  if (!email.trim() || !password) { authError = 'Enter your play27 email and password.'; render(); return; }
  authEmail = email.trim();
  authBusy = true; authError = ''; render();
  try { session = await signIn(authEmail, password); }
  catch (e) { authError = e.message; }
  authBusy = false; render();
}

function hostName() {
  const u = session && session.user;
  if (!u) return '';
  return (u.user_metadata && u.user_metadata.display_name) || u.email || 'your play27 account';
}

/* ---------- rendering ---------- */

function render() {
  renderTop();
  const main = $('#main');
  const a = document.activeElement;
  let keep = null;
  if (a && a.id && main.contains(a)) {
    keep = { id: a.id };
    if ((a.tagName === 'INPUT' && a.type !== 'checkbox') || a.tagName === 'TEXTAREA') {
      keep.value = a.value;
      try { keep.s = a.selectionStart; keep.e = a.selectionEnd; } catch (e) { }
    }
  }
  main.innerHTML = !host ? landingHTML() : !loaded || !game ? connectingHTML()
    : view === 'board' ? boardHTML() : view === 'scores' ? scoresHTML() : setupHTML();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      if (keep.value !== undefined) el.value = keep.value;
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch (e) { }
    }
  }
  renderOverlay();
}

function renderTop() {
  ['board', 'scores', 'setup'].forEach(v => document.body.classList.toggle('v-' + v, !!host && v === view));
  const tabs = $('#tabs');
  tabs.hidden = !host;
  tabs.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.arg === view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  const sync = $('#sync');
  sync.hidden = !host;
  syncLabel(sync, syncState);
  const jc = $('#join-chip');
  jc.hidden = !host;
  if (host) jc.textContent = host.code;
  const rb = $('#read-btn');
  rb.hidden = !host;
  rb.setAttribute('aria-pressed', speakerOn ? 'true' : 'false');
  rb.title = speakerOn ? 'Read aloud (this device is a speaker)' : 'Read aloud';
  const wb = $('#wake-btn');
  wb.hidden = !host || !('wakeLock' in navigator);
  wb.setAttribute('aria-pressed', wantWake && wake ? 'true' : 'false');
  wb.textContent = wantWake && wake ? 'Screen stays on' : 'Keep screen on';
  const fb = $('#fs-btn');
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  fb.hidden = !host || !(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  fb.textContent = isFs ? 'Exit full screen' : 'Full screen';
  document.body.classList.toggle('fs', isFs);
}

function connectingHTML() {
  return '<section class="empty"><p class="eyebrow">Opening the table</p></section>';
}

function landingHTML() {
  const prefs = store(PREFS_KEY) || {};
  const prev = (prefs.players || []).slice(0, 12);
  return '<section class="empty">' +
    '<div class="backs" aria-hidden="true"><span class="back" style="--rot:-9deg"></span><span class="back"></span><span class="back" style="--rot:9deg"></span></div>' +
    '<h1>Contract Rummy scorekeeper</h1>' +
    '<p>Play with real cards. This screen shows each hand\'s contract and the standings. Players scan a code with their phone to join and enter their own scores.</p>' +
    (landingNote ? '<p class="note">' + esc(landingNote) + '</p>' : '') +
    (session === undefined ? '<p class="eyebrow">Checking your sign-in</p>' : session ? signedInHTML(prev) : signInHTML()) +
    '<p class="version">v' + esc(APP_VERSION) + '</p></section>';
}

function signedInHTML(prev) {
  return '<p class="note">Hosting as <b>' + esc(hostName()) + '</b> &middot; <button type="button" class="link" data-act="signout">Sign out</button></p>' +
    (authError ? '<p class="err" role="alert">' + esc(authError) + '</p>' : '') +
    (prev.length ? '<label class="check" for="seat-prev"><input type="checkbox" id="seat-prev" checked><span>Seat last game\'s players: ' + listNames(prev.map(n => ({ name: n }))) + '. They tap their name after scanning.</span></label>' : '') +
    '<button class="btn primary big" type="button" data-act="create"' + (creating ? ' disabled' : '') + '>' + (creating ? 'Opening the table' : 'Start a table') + '</button>';
}

function signInHTML() {
  return '<form class="join-form signin" data-form="signin" aria-labelledby="si-t">' +
    '<p class="eyebrow" id="si-t">Sign in with your play27 account to host</p>' +
    '<label class="sr" for="si-email">Email</label><input class="txt" id="si-email" type="email" autocomplete="username" placeholder="Email" value="' + esc(authEmail) + '" required>' +
    '<label class="sr" for="si-pass">Password</label><input class="txt" id="si-pass" type="password" autocomplete="current-password" placeholder="Password" required>' +
    (authError ? '<p class="err" role="alert">' + esc(authError) + '</p>' : '') +
    '<button class="btn primary big" type="submit"' + (authBusy ? ' disabled' : '') + '>' + (authBusy ? 'Signing in' : 'Sign in') + '</button>' +
    '<p class="hint">New to play27? <a class="link" href="login.html">Sign up with an invite code</a>. Players don\'t need an account; they just scan the code on the table.</p></form>';
}

function joinPanel(big) {
  const seated = game.players.length
    ? '<ul class="seated" aria-label="At the table">' + game.players.map(p =>
      '<li><span class="pdot" style="--pc:' + colorOf(p) + '"></span>' + esc(p.name) +
      (p.hasDevice ? '<span class="phone" title="On a phone"></span>' : '') + '</li>').join('') + '</ul>'
    : '<p class="hint">Nobody has joined yet.</p>';
  return '<section class="panel join" aria-labelledby="jt">' +
    '<div class="panel-head"><h2 class="panel-title" id="jt">Scan to join</h2>' +
    (big ? '<p class="hint">Point a phone camera at the code and enter a name. ' +
      (view === 'setup' ? 'Add anyone without a phone under Players below.' : 'Add anyone without a phone in Setup.') + '</p>' : '') + '</div>' +
    '<div class="join-top"><div class="join-qr">' + qrSVG(joinURL(), 'QR code to join table ' + host.code) + '</div>' +
    '<div class="join-text"><span class="eyebrow">Table code</span><span class="join-code">' + esc(host.code) + '</span>' +
    '<span class="join-url">' + esc(joinURL().replace(/^https?:\/\//, '')) + '</span></div></div>' +
    seated + '</section>';
}

function joinMini() {
  return '<button type="button" class="join-mini" data-act="show-join">' + qrSVG(joinURL(), '') +
    '<span class="jm-text"><span class="jm-code">' + esc(host.code) + '</span>Tap to show the join code</span></button>';
}

function advanceHTML(where) {
  const g = game, h = g.hand, C = g.contracts, last = C.length - 1, n = g.players.length;
  if (g.status === 'done') return '';
  const miss = missing(g, h);
  let msg, btn = '';
  if (g.status === 'setup') {
    if (n < 2) msg = 'Waiting for players. Start once at least two have joined.';
    else msg = esc(dealerOf(g, 0).name) + ' deals ' + C[0].deal + ' cards for hand 1.';
    btn = '<button class="btn primary" type="button" data-act="start"' + (n < 2 ? ' disabled' : '') + '>Start game</button>';
  } else if (!n) {
    msg = 'Nobody is at the table. Add players in Setup.';
  } else if (miss.length) {
    msg = 'Scores in: ' + (n - miss.length) + ' of ' + n + '. Waiting on ' + listNames(miss) + '.';
    if (where === 'board') btn = '<button class="btn primary" type="button" data-act="view" data-arg="scores">Enter scores</button>';
  } else if (h < last) {
    const d = dealerOf(g, h + 1);
    msg = 'Hand ' + (h + 1) + ' is scored. Next: ' + esc(cTitle(C[h + 1])) + ', ' + esc(d ? d.name : '') + ' deals.';
    btn = '<button class="btn primary" type="button" data-act="next">Deal hand ' + (h + 2) + '</button>';
  } else {
    msg = 'Every hand is scored.';
    btn = '<button class="btn primary" type="button" data-act="finish">Finish game</button>';
  }
  return '<div class="advance"><p>' + msg + '</p>' + btn + '</div>';
}

function boardHTML() {
  const side = game.status === 'setup'
    ? joinPanel(true) + (game.players.length ? standingsBig() : '')
    : standingsBig() + scoreSheetHTML() + joinMini();
  return '<div class="board">' + (game.status === 'done' ? finalHero() : contractHero()) +
    '<aside class="side" aria-label="Scores">' + side + '</aside></div>';
}

function contractHero() {
  const g = game, C = g.contracts, h = g.hand, c = C[h], r = g.rules;
  const d = dealerOf(g, h), f = firstOf(g, h);
  const dealIn = lastHeroHand !== null && lastHeroHand !== h;
  lastHeroHand = h;
  const track = C.map((cc, i) => {
    const cls = i < h ? ' past' : i === h ? ' now' : '';
    return '<li class="tk' + cls + '"' + (i === h ? ' aria-current="step"' : '') + ' title="' + esc(cTitle(cc)) + '"><span class="n">' + (i + 1) + '</span><span class="code">' + cCode(cc) + '</span></li>';
  }).join('');
  return '<section class="hero" aria-labelledby="ct">' +
    '<div class="hero-head"><div class="hero-top"><p class="eyebrow hand-eb">Hand <b>' + (h + 1) + '</b> of ' + C.length + (g.status === 'setup' ? ' &middot; not started' : '') + '</p></div>' +
    '<h1 class="ctitle' + (cTitle(c).length > 12 ? ' long' : '') + '" id="ct">' + esc(cTitle(c)) + '</h1>' +
    '<p class="csub">' + esc(cLong(c, r)) + ', at least ' + cMin(c, r) + ' cards' + (c.all ? '. Meld every card in your hand except the final discard.' : '.') + '</p></div>' +
    meldsHTML(c, r, dealIn ? 'deal-in' : '') +
    '<div class="hero-foot"><div class="deal">' +
    '<div><span class="k">Deal</span><span class="v">' + c.deal + ' cards</span></div>' +
    '<div><span class="k">Dealer</span><span class="v">' + esc(d ? d.name : '-') + '</span></div>' +
    '<div><span class="k">Plays first</span><span class="v">' + esc(f ? f.name : '-') + '</span></div></div>' +
    '<p class="rules-line">' + rulesLine(r) + '</p>' +
    (g.notes ? '<p class="notes">' + esc(g.notes) + '</p>' : '') +
    '<ol class="track" style="--n:' + C.length + '" aria-label="Contracts">' + track + '</ol>' +
    advanceHTML('board') + '</div></section>';
}

function finalHero() {
  const rows = ranked(game), winners = rows.filter(r => r.rank === 1);
  lastHeroHand = null;
  return '<section class="hero final" aria-labelledby="ct">' +
    '<p class="eyebrow">Game over &middot; ' + game.contracts.length + ' hands' + (game.endedAt ? ' &middot; ' + esc(fmtDate(game.endedAt)) : '') + '</p>' +
    '<h1 class="ctitle" id="ct">' + listNames(winners.map(r => r.p)) + '</h1>' +
    '<p class="csub">' + (winners.length > 1 ? 'Tie for the win' : 'Wins') + ' with ' + (winners[0] ? winners[0].total : 0) + ' points. Low score takes it.</p>' +
    '<div class="final-actions">' +
    '<button class="btn primary" type="button" data-act="rematch">New game, same seats</button>' +
    '<button class="btn" type="button" data-act="reopen">Reopen the last hand</button></div></section>';
}

function standingsBig() {
  const rows = ranked(game), started = anyScores(game), done = game.status === 'done';
  const d = dealerOf(game, game.hand), f = firstOf(game, game.hand);
  return '<section class="stand" aria-labelledby="sth"><div class="sheet-head"><h2 class="sheet-title" id="sth">Standings</h2><span class="legend">Low score wins</span></div><ol class="stand-list">' +
    rows.map(r => {
      const p = r.p;
      let tags = '';
      if (!done && d && d.id === p.id) tags += '<span class="tag">Deals</span>';
      if (!done && f && f.id === p.id) tags += '<span class="tag t2">First</span>';
      return '<li class="' + (started && r.rank === 1 ? 'lead' : '') + '"><span class="rk">' + r.rank + '</span>' +
        '<span class="who"><span class="pdot" style="--pc:' + colorOf(p) + '"></span><span class="pn">' + esc(p.name) + '</span>' + tags + '</span>' +
        '<span class="tot">' + r.total + '</span><span class="gap">' + (r.gap ? '+' + r.gap : '&ndash;') + '</span></li>';
    }).join('') + '</ol></section>';
}

function scoreSheetHTML() {
  const C = game.contracts, cur = game.hand, done = game.status === 'done';
  const t = totalsMap(game), started = anyScores(game);
  const low = Math.min.apply(null, game.players.map(p => t[p.id]));
  const head = '<tr><th class="name" scope="col">Player</th>' +
    C.map((c, i) => '<th scope="col" class="' + (i === cur && !done ? 'now' : '') + '" title="' + esc(cTitle(c)) + '"><span class="hn">' + (i + 1) + '</span><span class="hc">' + cCode(c) + '</span></th>').join('') +
    '<th class="tot" scope="col">Total</th></tr>';
  const body = game.players.map(p => {
    const cells = C.map((c, i) => {
      const v = cellv(game, i, p.id);
      let cls = 'hcell' + (i === cur && !done ? ' now' : ''), txt;
      if (v === null) { if (i > cur) { cls += ' future'; txt = ''; } else txt = '<span class="miss">&middot;</span>'; }
      else if (v === 0) txt = '<span class="out" title="Went out">0</span>';
      else txt = String(v);
      return '<td class="' + cls + '">' + txt + '</td>';
    }).join('');
    return '<tr class="' + (started && t[p.id] === low ? 'lead' : '') + '"><td class="name"><span class="name-in"><span class="pdot" style="--pc:' + colorOf(p) + '"></span><span class="pn">' + esc(p.name) + '</span></span></td>' +
      cells + '<td class="tot">' + t[p.id] + '</td></tr>';
  }).join('');
  return '<section class="sheet" aria-labelledby="st"><div class="sheet-head"><h2 class="sheet-title" id="st">Score sheet</h2><span class="legend">Seat order &middot; S = set, R = run &middot; 0 = went out</span></div>' +
    '<div class="tbl-wrap"><table class="scores"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div></section>';
}

function shownHand() { return editHand === null || editHand >= game.contracts.length ? game.hand : editHand; }

function scoresHTML() {
  const g = game;
  if (!g.players.length) {
    return '<section class="empty"><h1>Nobody at the table yet</h1><p>Players join by scanning the code on the Board. Add anyone without a phone in Setup.</p>' +
      '<button class="btn primary" type="button" data-act="view" data-arg="setup">Open Setup</button></section>';
  }
  const C = g.contracts, h = shownHand(), c = C[h], r = g.rules;
  const d = dealerOf(g, h), f = firstOf(g, h), t = totalsMap(g);
  const pick = C.map((cc, i) => {
    const cls = 'hp' + (i === g.hand && g.status !== 'done' ? ' now' : '') + (missing(g, i).length === 0 ? ' full' : '');
    return '<button type="button" class="' + cls + '" data-act="pick-hand" data-arg="' + i + '" aria-pressed="' + (i === h) + '" aria-label="Hand ' + (i + 1) + (i === g.hand ? ', current' : '') + '">' + (i + 1) + '</button>';
  }).join('');
  const rows = g.players.map(p => {
    const v = cellv(g, h, p.id);
    const sub = [];
    if (d && d.id === p.id) sub.push('Dealer');
    if (f && f.id === p.id) sub.push('Plays first');
    sub.push('Total ' + t[p.id]);
    const pv = v === null ? '<span class="pv none">Tap to score</span>'
      : v === 0 ? '<span class="pv"><span class="outl">Out</span>0</span>' : '<span class="pv">' + v + '</span>';
    return '<li><button type="button" class="prow" data-act="open-sheet" data-arg="' + esc(p.id) + '"' + (g.status === 'done' ? ' disabled' : '') + '>' +
      '<span class="pdot" style="--pc:' + colorOf(p) + '"></span>' +
      '<span class="pmeta"><span class="pn">' + esc(p.name) + (p.hasDevice ? '<span class="phone" title="Enters scores on their phone"></span>' : '') + '</span>' +
      '<span class="psub">' + sub.join(' &middot; ') + '</span></span>' + pv + '</button></li>';
  }).join('');
  let tail;
  if (g.status === 'done') tail = '<p class="note">This game is finished. <button type="button" class="link" data-act="reopen">Reopen it</button> to change scores.</p>';
  else if (h === g.hand) tail = advanceHTML('scores');
  else tail = '<p class="note">You are editing hand ' + (h + 1) + '. Play is on hand ' + (g.hand + 1) + '. <button type="button" class="link" data-act="pick-hand" data-arg="' + g.hand + '">Back to hand ' + (g.hand + 1) + '</button></p>';
  return '<div class="entry"><div class="entry-a">' +
    '<nav class="handpick" aria-label="Choose a hand">' + pick + '</nav>' +
    '<section class="mini" aria-labelledby="mt"><div><p class="eyebrow">Hand <b>' + (h + 1) + '</b> of ' + C.length + (h === g.hand && g.status !== 'done' ? ' &middot; now playing' : '') + '</p>' +
    '<h1 class="mtitle" id="mt">' + esc(cTitle(c)) + '</h1>' +
    '<p class="csub">' + c.deal + ' cards &middot; ' + esc(d ? d.name : '') + ' deals &middot; ' + esc(f ? f.name : '') + ' plays first' + (c.all ? ' &middot; meld all but the discard' : '') + '</p></div>' +
    meldsHTML(c, r, 'mini-melds') + '</section>' + standingsPanel() + '</div>' +
    '<div class="entry-b"><ul class="plist" aria-label="Scores for hand ' + (h + 1) + '">' + rows + '</ul>' + tail + '</div></div>';
}

function standingsPanel() {
  const rows = ranked(game), started = anyScores(game);
  return '<section class="panel" aria-labelledby="sp"><h2 class="panel-title" id="sp">Standings</h2><ol class="mini-stand">' +
    rows.map(r => '<li class="' + (started && r.rank === 1 ? 'lead' : '') + '"><span class="rk">' + r.rank + '</span><span class="pdot" style="--pc:' + colorOf(r.p) + '"></span>' +
      '<span class="pn">' + esc(r.p.name) + '</span><span class="tot">' + r.total + '</span><span class="gap">' + (r.gap ? '+' + r.gap : '&ndash;') + '</span></li>').join('') +
    '</ol></section>';
}

function armBtn(key, label, armedLabel, cls) {
  const on = armed === key, parts = key.split(':');
  return '<button type="button" class="btn ' + (cls || '') + (on ? ' armed' : '') + '" data-act="' + parts[0] + '" data-arg="' + esc(parts[1] || '') + '">' + (on ? armedLabel : label) + '</button>';
}

function setupHTML() {
  const g = game, players = g.players, n = players.length;
  const seats = players.map((p, i) => {
    const rmOn = armed === 'remove-player:' + p.id, relOn = armed === 'release-player:' + p.id;
    return '<li class="seat"><span class="seat-n">' + (i + 1) + '</span><span class="pdot" style="--pc:' + colorOf(p) + '"></span>' +
      '<label class="sr" for="pn-' + esc(p.id) + '">Name in seat ' + (i + 1) + '</label>' +
      '<input class="txt" id="pn-' + esc(p.id) + '" value="' + esc(p.name) + '" maxlength="24" autocomplete="off" data-field="player-name" data-arg="' + esc(p.id) + '">' +
      '<button type="button" class="icon-btn" id="up-' + esc(p.id) + '" data-act="move" data-arg="' + esc(p.id) + ':-1" aria-label="Move ' + esc(p.name) + ' up"' + (i === 0 ? ' disabled' : '') + '>&uarr;</button>' +
      '<button type="button" class="icon-btn" id="dn-' + esc(p.id) + '" data-act="move" data-arg="' + esc(p.id) + ':1" aria-label="Move ' + esc(p.name) + ' down"' + (i === n - 1 ? ' disabled' : '') + '>&darr;</button>' +
      '<button type="button" class="icon-btn danger' + (rmOn ? ' armed' : '') + '" data-act="remove-player" data-arg="' + esc(p.id) + '" aria-label="Remove ' + esc(p.name) + '">' + (rmOn ? 'Remove?' : '&#x2715;') + '</button>' +
      (p.hasDevice
        ? '<span class="seat-dev"><span class="phone"></span>On a phone <button type="button" class="link" data-act="release-player" data-arg="' + esc(p.id) + '">' + (relOn ? 'Tap again to free the seat' : 'Free seat') + '</button></span>'
        : '<span class="seat-dev">No phone yet</span>') +
      '</li>';
  }).join('');

  let html = '<div class="setup">' + joinPanel(true);

  html += '<section class="panel" aria-labelledby="h-players"><div class="panel-head"><h2 class="panel-title" id="h-players">Players</h2>' +
    '<p class="hint">Seat order: the deal and the first play pass down this list, one seat per hand. "Free seat" lets a player join again from a different phone.</p></div>' +
    (n ? '<ol class="seats">' + seats + '</ol>' : '<p class="hint">Nobody has joined yet.</p>') +
    '<form class="addrow" data-form="add-player"><label class="sr" for="new-player">Name of a player without a phone</label>' +
    '<input class="txt" id="new-player" maxlength="24" autocomplete="off" placeholder="Add a player without a phone" enterkeyhint="done">' +
    '<button class="btn primary" type="submit">Add</button></form>';
  if (n > 1) {
    html += '<div class="field-row"><label for="first-dealer">Deals hand 1</label><select class="sel" id="first-dealer" data-field="first-dealer">' +
      players.map((p, i) => '<option value="' + i + '"' + (i === g.firstDealer % n ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></div>';
  }
  html += '</section>';

  const status = g.status === 'done' ? 'Finished' : g.status === 'playing' ? 'In play, hand ' + (g.hand + 1) + ' of ' + g.contracts.length : 'Not started';
  html += '<section class="panel" aria-labelledby="h-game"><div class="panel-head"><h2 class="panel-title" id="h-game">Game</h2></div>' +
    '<p class="status-pill"><span class="dot" style="background:' + (g.status === 'playing' ? 'var(--good)' : 'var(--ink-dim)') + '"></span>' + status + '</p>';
  if (g.status === 'setup') html += '<div class="btn-row"><button type="button" class="btn primary" data-act="start"' + (n < 2 ? ' disabled' : '') + '>Start game</button></div>';
  if (g.status === 'playing') {
    html += '<div class="field-row"><label for="current-hand">Current hand</label><select class="sel" id="current-hand" data-field="current-hand">' +
      g.contracts.map((c, i) => '<option value="' + i + '"' + (i === g.hand ? ' selected' : '') + '>Hand ' + (i + 1) + ': ' + esc(cTitle(c)) + '</option>').join('') +
      '</select></div><p class="hint">Only for fixing a hand that was dealt by mistake. Scores are kept.</p>';
  }
  html += '<div class="btn-row">' + armBtn('rematch:', 'New game, same seats', 'Tap again to start over', '') +
    armBtn('close-table:', 'Close the table', 'Tap again to close it for everyone', 'danger') + '</div>' +
    '<p class="hint">Closing ends the table for every phone. Finished games stay in Past games.</p></section>';

  html += '<section class="panel" aria-labelledby="h-host"><div class="panel-head"><h2 class="panel-title" id="h-host">Run it from another device</h2>' +
    '<p class="hint">Shows a code that makes another phone or tablet a host too, with full control of this table. Only show it to someone you trust.</p></div>' +
    '<div class="btn-row"><button type="button" class="btn" data-act="show-host">Show host code</button></div></section>';

  const C = g.contracts;
  const crow = C.map((c, i) => {
    const stepper = (field, v) => {
      const base = 'cs-' + i + '-' + field;
      return '<span class="stepper"><button type="button" id="' + base + '-m" data-act="cstep" data-arg="' + i + ':' + field + ':-1" aria-label="Fewer ' + field + ' in hand ' + (i + 1) + '"' + (v <= 0 ? ' disabled' : '') + '>&minus;</button>' +
        '<span>' + v + '</span><button type="button" id="' + base + '-p" data-act="cstep" data-arg="' + i + ':' + field + ':1" aria-label="More ' + field + ' in hand ' + (i + 1) + '"' + (v >= 6 ? ' disabled' : '') + '>+</button></span>';
    };
    return '<tr><th scope="row"><span class="cn">' + (i + 1) + '</span><span class="ct">' + esc(cTitle(c)) + '</span></th>' +
      '<td>' + stepper('sets', c.sets) + '</td><td>' + stepper('runs', c.runs) + '</td>' +
      '<td><input class="num" type="number" inputmode="numeric" min="1" max="30" id="deal-' + i + '" value="' + c.deal + '" data-field="contract-deal" data-arg="' + i + '" aria-label="Cards dealt in hand ' + (i + 1) + '"></td>' +
      '<td><input class="chk" type="checkbox" id="all-' + i + '"' + (c.all ? ' checked' : '') + ' data-field="contract-all" data-arg="' + i + '" aria-label="Hand ' + (i + 1) + ' must meld every card except the discard"></td></tr>';
  }).join('');
  html += '<section class="panel" aria-labelledby="h-contracts"><div class="panel-head"><h2 class="panel-title" id="h-contracts">Contracts</h2>' +
    '<p class="hint">Starts from the play27 rules: seven hands, 10 cards for hands 1 to 4 and 12 after that, sets and runs of 3. "Meld all" means every card but the final discard.</p></div>' +
    '<div class="ctable-wrap"><table class="ctable"><thead><tr><th scope="col" style="text-align:left">Hand</th><th scope="col">Sets</th><th scope="col">Runs</th><th scope="col">Deal</th><th scope="col">Meld all</th></tr></thead><tbody>' + crow + '</tbody></table></div>' +
    '<div class="btn-row"><button type="button" class="btn small" data-act="contract-add">Add a hand</button>' +
    '<button type="button" class="btn small" data-act="contract-remove"' + (C.length <= 1 ? ' disabled' : '') + '>Remove last hand</button></div></section>';

  const v = g.values, r = g.rules;
  html += '<section class="panel" aria-labelledby="h-values"><div class="panel-head"><h2 class="panel-title" id="h-values">Card values</h2>' +
    '<p class="hint">Used by the card counter when entering scores. play27 values: number cards at face value, 10 and face cards 10, aces 15, jokers 25.</p></div>' +
    '<div class="fields">' +
    '<label for="v-numbers">2 through 9<select class="sel" id="v-numbers" data-field="v-numbers"><option value="face"' + (v.numbers !== 'flat5' ? ' selected' : '') + '>Face value</option><option value="flat5"' + (v.numbers === 'flat5' ? ' selected' : '') + '>5 points each</option></select></label>' +
    '<label for="v-face">10, J, Q, K<input class="num" type="number" inputmode="numeric" id="v-face" min="0" max="500" value="' + esc(v.face) + '" data-field="v-face"></label>' +
    '<label for="v-ace">Ace<input class="num" type="number" inputmode="numeric" id="v-ace" min="0" max="500" value="' + esc(v.ace) + '" data-field="v-ace"></label>' +
    '<label for="v-joker">Joker<input class="num" type="number" inputmode="numeric" id="v-joker" min="0" max="500" value="' + esc(v.joker) + '" data-field="v-joker"></label>' +
    '<label for="r-set">Cards in a set<input class="num" type="number" inputmode="numeric" id="r-set" min="2" max="8" value="' + esc(r.setSize) + '" data-field="r-set"></label>' +
    '<label for="r-run">Cards in a run<input class="num" type="number" inputmode="numeric" id="r-run" min="2" max="13" value="' + esc(r.runLen) + '" data-field="r-run"></label>' +
    '<label for="r-buys">Buys per hand<select class="sel" id="r-buys" data-field="r-buys"><option value=""' + (r.buys ? '' : ' selected') + '>Unlimited</option>' +
    [1, 2, 3, 4, 5].map(b => '<option value="' + b + '"' + (r.buys === b ? ' selected' : '') + '>' + b + '</option>').join('') + '</select></label>' +
    '</div></section>';

  html += '<section class="panel" aria-labelledby="h-notes"><div class="panel-head"><h2 class="panel-title" id="h-notes">House notes</h2>' +
    '<p class="hint">Shown on the board under the contract.</p></div>' +
    '<label class="sr" for="notes">House notes</label><textarea class="area" id="notes" maxlength="400" data-field="notes" placeholder="Example: jokers are wild, no buying in hand 7.">' + esc(g.notes) + '</textarea></section>';

  html += '<section class="panel" aria-labelledby="h-past"><div class="panel-head"><h2 class="panel-title" id="h-past">Past games</h2></div>';
  if (!pastGames.length) html += '<p class="hint">Games finished on tables this device hosted show up here.</p>';
  else html += '<ol class="past">' + pastGames.map(pg => {
    const res = Array.isArray(pg.results) ? pg.results : [];
    const win = res.filter(x => x.rank === 1).map(x => esc(x.name)).join(' and ');
    return '<li><span class="pw">' + (win || 'Unknown') + ' won</span><span class="pd">' + esc(fmtDate(pg.ended_at)) + ' &middot; ' + esc(pg.hands) + ' hands &middot; table ' + esc(pg.code) + '</span>' +
      '<span class="pr">' + res.map(x => esc(x.name) + ' ' + esc(x.total)).join(' &middot; ') + '</span></li>';
  }).join('') + '</ol>';
  html += '</section><p class="version">play27 Scorekeeper v' + esc(APP_VERSION) + '</p></div>';
  return html;
}

function renderOverlay() {
  const root = $('#overlay-root');
  if (!overlay || !host) { root.innerHTML = ''; return; }
  if (overlay.kind === 'read') { root.innerHTML = readHTML(); return; }
  const isHost = overlay.kind === 'host';
  const url = isHost ? hostURL(overlay.token) : joinURL();
  root.innerHTML = '<div class="qr-overlay" data-act="overlay-bg"><div class="qr-card" role="dialog" aria-modal="true" aria-labelledby="ov-t">' +
    '<h2 class="panel-title" id="ov-t">' + (isHost ? 'Host this table' : 'Scan to join') + '</h2>' +
    qrSVG(url, isHost ? 'QR code that makes a device a host' : 'QR code to join table ' + host.code) +
    (isHost ? '<p class="hint">Scanning this gives full control of the table. Close it once the other device has opened the page.</p>'
      : '<span class="join-code">' + esc(host.code) + '</span><span class="join-url">' + esc(url.replace(/^https?:\/\//, '')) + '</span>') +
    '<button type="button" class="btn primary" data-act="overlay-close">Close</button></div></div>';
}

function readHTML() {
  const busy = overlay.busy;
  return '<div class="qr-overlay" data-act="overlay-bg"><div class="qr-card read-card" role="dialog" aria-modal="true" aria-labelledby="ov-t">' +
    '<h2 class="panel-title" id="ov-t">Read aloud</h2>' +
    '<p class="hint">Plays on every host device with Speaker turned on, usually the tablet on the table.</p>' +
    '<div class="read-btns">' +
    '<button type="button" class="btn primary big" data-act="announce" data-arg="standings"' + (busy ? ' disabled' : '') + '>Standings</button>' +
    '<button type="button" class="btn primary big" data-act="announce" data-arg="hand"' + (busy ? ' disabled' : '') + '>This hand</button>' +
    '<button type="button" class="btn big" data-act="announce" data-arg="both"' + (busy ? ' disabled' : '') + '>Both</button></div>' +
    (canSpeak
      ? '<label class="check" for="speaker-on"><input type="checkbox" id="speaker-on" data-field="speaker"' + (speakerOn ? ' checked' : '') + '>' +
        '<span><strong>Speaker on this device.</strong> Turn it on for the device that should talk.</span></label>'
      : '<p class="hint">This browser can\'t speak, but it can still send announcements to a device that can.</p>') +
    '<button type="button" class="btn" data-act="overlay-close">Close</button></div></div>';
}

function setSpeaker(on) {
  speakerOn = !!on && canSpeak;
  store(SPEAKER_KEY, speakerOn);
  if (speakerOn) speak('Speaker on.'); // spoken from the tap, which also lets iOS talk later
  renderTop();
}

/* ---------- actions ---------- */

function arm(key) {
  if (armed === key) { armed = null; clearTimeout(armTimer); return true; }
  armed = key; clearTimeout(armTimer);
  armTimer = setTimeout(() => { armed = null; render(); }, 4000);
  render();
  return false;
}
function setView(v) {
  if (v !== 'board' && v !== 'scores' && v !== 'setup') return;
  view = v; store(VIEW_KEY, v);
  sheet.close();
  if (v === 'setup') loadPast();
  render();
  window.scrollTo(0, 0);
}
function seatOrder(ps, dealerId) {
  const fd = Math.max(0, ps.findIndex(p => p.id === dealerId));
  return hostCall('score_host_set_seats', { p_order: ps.map(p => p.id), p_first_dealer: fd });
}

const ACT = {
  view: a => setView(a),
  create: () => createTable(),
  start: () => {
    if (game.players.length < 2) { toast('At least two players need to join first.'); return; }
    editHand = null; update({ status: 'playing', hand: 0 });
  },
  next: () => {
    const h = game.hand;
    if (missing(game, h).length) { toast('Enter every score for this hand first.'); return; }
    if (h >= game.contracts.length - 1) return;
    editHand = null; game.hand = h + 1;
    update({ hand: h + 1 });
    setView('board');
  },
  finish: () => {
    if (missing(game, game.contracts.length - 1).length) { toast('Enter every score for the last hand first.'); return; }
    hostCall('score_host_finish').then(() => loadPast()).catch(() => { });
    setView('board');
  },
  reopen: () => { quiet(hostCall('score_host_reopen')); },
  rematch: () => {
    if (game.status !== 'done' && anyScores(game) && !arm('rematch:')) return;
    armed = null; editHand = null; lastHeroHand = null;
    quiet(hostCall('score_host_new_game'));
    toast('New game started with the same seats.');
  },
  'close-table': () => {
    if (!arm('close-table:')) return;
    hostCall('score_host_close').then(() => forgetTable('Table closed.')).catch(() => { });
  },
  'pick-hand': a => { const i = parseInt(a, 10); editHand = i === game.hand ? null : i; render(); },
  'open-sheet': a => sheet.open(a, shownHand()),
  'show-join': () => { overlay = { kind: 'join' }; renderOverlay(); },
  'show-host': () => {
    hostCall('score_host_add_host').then(token => { overlay = { kind: 'host', token }; renderOverlay(); }).catch(() => { });
  },
  'show-read': () => { overlay = { kind: 'read' }; renderOverlay(); },
  announce: a => {
    if (overlay) { overlay.busy = true; renderOverlay(); }
    hostCall('score_host_announce', { p_what: a })
      .then(() => { overlay = null; renderOverlay(); if (!speakerOn) toast('Sent to the devices with Speaker on.'); })
      .catch(() => { if (overlay) { overlay.busy = false; renderOverlay(); } });
  },
  'overlay-bg': (a, t, e) => { if (e.target === t) { overlay = null; renderOverlay(); } },
  'overlay-close': () => { overlay = null; renderOverlay(); },
  move: a => {
    const [id, dir] = a.split(':');
    const ps = game.players.slice(), i = ps.findIndex(p => p.id === id), j = i + parseInt(dir, 10);
    if (i < 0 || j < 0 || j >= ps.length) return;
    const dealerId = ps[game.firstDealer % ps.length].id;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    quiet(seatOrder(ps, dealerId));
  },
  'remove-player': a => {
    if (!arm('remove-player:' + a)) return;
    const dealer = game.players[game.firstDealer % game.players.length];
    const rest = game.players.filter(p => p.id !== a);
    hostCall('score_host_remove_player', { p_player_id: a })
      .then(() => rest.length ? seatOrder(rest, dealer && dealer.id !== a ? dealer.id : rest[0].id) : null).catch(() => { });
  },
  'release-player': a => {
    if (!arm('release-player:' + a)) return;
    hostCall('score_host_release_player', { p_player_id: a }).then(() => toast('Seat freed. They can scan and tap their name.')).catch(() => { });
  },
  cstep: a => {
    const [i, f, d] = a.split(':');
    const C = JSON.parse(JSON.stringify(game.contracts));
    C[+i][f] = Math.max(0, Math.min(6, C[+i][f] + parseInt(d, 10)));
    update({ contracts: C });
  },
  'contract-add': () => {
    const C = JSON.parse(JSON.stringify(game.contracts)), last = C[C.length - 1];
    C.push({ sets: last.sets, runs: last.runs, deal: last.deal, all: false });
    update({ contracts: C });
  },
  'contract-remove': () => {
    if (game.contracts.length <= 1) return;
    const C = JSON.parse(JSON.stringify(game.contracts)); C.pop();
    update({ contracts: C });
  },
  wake: () => toggleWake(),
  fullscreen: () => toggleFullscreen()
};

const FIELD = {
  'player-name': el => {
    const p = game.players.find(x => x.id === el.dataset.arg), name = el.value.trim();
    if (!p) return;
    if (!name) { el.value = p.name; return; }
    if (name !== p.name) quiet(hostCall('score_host_rename_player', { p_player_id: p.id, p_name: name }));
  },
  'first-dealer': el => update({ first_dealer: clampInt(el.value, 0, game.players.length - 1, 0) }),
  'current-hand': el => { editHand = null; update({ hand: clampInt(el.value, 0, game.contracts.length - 1, game.hand), status: 'playing' }); },
  'contract-deal': el => {
    const i = +el.dataset.arg, C = JSON.parse(JSON.stringify(game.contracts));
    C[i].deal = clampInt(el.value, 1, 30, C[i].deal); el.value = C[i].deal;
    update({ contracts: C });
  },
  'contract-all': el => {
    const i = +el.dataset.arg, C = JSON.parse(JSON.stringify(game.contracts));
    C[i].all = !!el.checked;
    update({ contracts: C });
  },
  'v-numbers': el => update({ card_values: { numbers: el.value === 'flat5' ? 'flat5' : 'face' } }),
  'v-face': el => update({ card_values: { face: clampInt(el.value, 0, 500, game.values.face) } }),
  'v-ace': el => update({ card_values: { ace: clampInt(el.value, 0, 500, game.values.ace) } }),
  'v-joker': el => update({ card_values: { joker: clampInt(el.value, 0, 500, game.values.joker) } }),
  'r-set': el => update({ rules: { setSize: clampInt(el.value, 2, 8, game.rules.setSize) } }),
  'r-run': el => update({ rules: { runLen: clampInt(el.value, 2, 13, game.rules.runLen) } }),
  'r-buys': el => update({ rules: { buys: el.value === '' ? null : clampInt(el.value, 1, 10, null) } }),
  notes: el => { if (el.value !== game.notes) update({ notes: el.value.slice(0, 400) }); },
  speaker: el => setSpeaker(el.checked)
};

/* ---------- device helpers ---------- */

function acquireWake() {
  return navigator.wakeLock.request('screen').then(lock => {
    wake = lock;
    lock.addEventListener('release', () => { wake = null; renderTop(); });
    renderTop();
  }).catch(() => {
    wantWake = false; wake = null; renderTop();
    toast("This screen can't be held on. Turn off auto-lock in the device settings instead.");
  });
}
function toggleWake() {
  if (!('wakeLock' in navigator)) return;
  if (wantWake) { wantWake = false; if (wake) wake.release().catch(() => { }); wake = null; renderTop(); return; }
  wantWake = true; acquireWake();
}
function toggleFullscreen() {
  try {
    const on = document.fullscreenElement || document.webkitFullscreenElement;
    let p;
    if (on) p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else { const el = document.documentElement; p = (el.requestFullscreen || el.webkitRequestFullscreen).call(el); }
    if (p && p.catch) p.catch(() => toast('Full screen is not available here.'));
  } catch (e) { toast('Full screen is not available here.'); }
}

/* ---------- events ---------- */

document.addEventListener('visibilitychange', () => { if (wantWake && !wake && document.visibilityState === 'visible') acquireWake(); });
// After a reload, iOS needs one tap before the page may talk again.
document.addEventListener('pointerdown', () => { if (speakerOn) unlockSpeech(); }, { once: true });
document.addEventListener('fullscreenchange', renderTop);
document.addEventListener('webkitfullscreenchange', renderTop);
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  const fn = ACT[t.dataset.act]; if (!fn) return;
  if (t.dataset.act === 'signout') {
    signOut().then(() => { session = null; authError = ''; render(); });
    return;
  }
  if (!game && ['create', 'wake', 'fullscreen'].indexOf(t.dataset.act) < 0) return;
  fn(t.dataset.arg, t, e);
});
document.addEventListener('change', e => {
  const t = e.target.closest('[data-field]'); if (!t || !game) return;
  const fn = FIELD[t.dataset.field]; if (fn) fn(t);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  if (f.dataset.form === 'signin') { doSignIn(); return; }
  if (f.dataset.form === 'add-player' && game) {
    const input = $('#new-player'), name = input.value.trim();
    if (!name) { input.focus(); return; }
    input.value = '';
    quiet(hostCall('score_host_add_player', { p_name: name }));
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && overlay) { overlay = null; renderOverlay(); }
});

/* ---------- boot ---------- */

(async function boot() {
  // A host link from another host device: scorekeeper.html?t=CODE#host=KEY
  const params = new URLSearchParams(location.search);
  const m = /(?:^|[#&])host=([0-9a-f]{32,128})/.exec(location.hash);
  if (params.get('t') && m) {
    host = { code: params.get('t').toUpperCase(), token: m[1] };
    store(HOST_KEY, host);
    history.replaceState(null, '', location.pathname + (linkSuffix ? '?sb=local' : ''));
  }
  const saved = store(VIEW_KEY);
  view = saved === 'board' || saved === 'scores' || saved === 'setup' ? saved
    : window.matchMedia('(min-width: 900px)').matches ? 'board' : 'scores';
  if (!host) {
    loaded = true; render();
    session = await currentSession();
    render();
    return;
  }
  render();
  try {
    const who = await call('score_whoami', { p_code: host.code, p_token: host.token });
    if (!who.table) { forgetTable('Your last table closed after a day without play.'); return; }
    if (who.role !== 'host') { forgetTable('This device is no longer a host of that table.'); return; }
  } catch (e) {
    toast(e.message);
  }
  startWatch();
})();
