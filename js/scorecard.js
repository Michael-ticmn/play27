// ============================================================
// play27 — Scorekeeper player card (phone)
// Scan the table's QR, enter a name (or tap a seat the host added),
// then enter your own score after each hand.
// ============================================================

import {
  call, watchTable, $, esc, store, listNames, toast, syncLabel, colorOf, cellv, totalsMap, ranked,
  missing, wentOut, anyScores, dealerOf, firstOf, cTitle, cLong, cMin, rulesLine, meldsHTML, createScoreSheet, APP_VERSION
} from './score-common.js?v=0.15.12';

const code = (new URLSearchParams(location.search).get('t') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
const ME_KEY = 'p27sc.' + code;

let me = code ? store(ME_KEY) : null; // { playerId, token }
let game = null, loaded = false, closed = false, syncState = 'connecting';
let editHand = null, renaming = false, armed = null, armTimer = null, busy = false, notice = '';
let checking = false;

const sheet = createScoreSheet($('#modal-root'), {
  getGame: () => game,
  save: (pid, h, v) => submit(h, v),
  remove: (pid, h) => submit(h, null),
  next: () => null,
  self: true,
  onClose: () => render()
});

/* ---------- data ---------- */

function myPlayer() { return me && game ? game.players.find(p => p.id === me.playerId) : null; }

async function verifySeat() {
  if (!me || checking) return;
  checking = true;
  try {
    const who = await call('score_whoami', { p_code: code, p_token: me.token });
    if (who.role !== 'player' || who.player_id !== me.playerId) {
      me = null; store(ME_KEY, null); sheet.close();
      notice = 'The host freed your seat. Tap your name or join again.';
      render();
    }
  } catch (e) { /* offline: keep the seat and try again on the next update */ }
  checking = false;
}

function submit(h, v) {
  const key = 'h' + h;
  return call('score_submit', { p_code: code, p_token: me.token, p_hand: h, p_score: v }).then(() => {
    game.scores[key] = Object.assign({}, game.scores[key]);
    if (v === null) delete game.scores[key][me.playerId]; else game.scores[key][me.playerId] = v;
    render();
    if (watcher) watcher.refresh();
  }).catch(err => {
    if (/seat was freed/.test(err.message)) verifySeat();
    throw err;
  });
}

async function join(name) {
  if (busy) return;
  busy = true; render();
  try {
    const r = await call('score_join', { p_code: code, p_name: name });
    me = { playerId: r.player_id, token: r.token }; store(ME_KEY, me);
    notice = ''; editHand = null;
    if (watcher) watcher.refresh();
  } catch (e) { toast(e.message); }
  busy = false; render();
}

async function claim(pid) {
  if (busy) return;
  busy = true; render();
  try {
    const r = await call('score_claim', { p_code: code, p_player_id: pid });
    me = { playerId: r.player_id, token: r.token }; store(ME_KEY, me);
    notice = ''; editHand = null;
    if (watcher) watcher.refresh();
  } catch (e) { toast(e.message); if (watcher) watcher.refresh(); }
  busy = false; render();
}

/* ---------- rendering ---------- */

function render() {
  const sync = $('#sync');
  sync.hidden = !code;
  syncLabel(sync, syncState);
  const main = $('#main');
  const a = document.activeElement;
  let keep = null;
  if (a && a.id && main.contains(a) && a.tagName === 'INPUT') keep = { id: a.id, value: a.value };
  main.innerHTML = !code ? noCodeHTML() : closed ? closedHTML() : !loaded ? '<section class="empty"><p class="eyebrow">Finding the table</p></section>'
    : myPlayer() ? seatedHTML() : joinHTML();
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) { el.value = keep.value; try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
  }
}

function noCodeHTML() {
  return '<section class="empty"><h1>Scan the code on the table</h1><p>Open your phone camera and point it at the QR code on the host\'s screen to join the game.</p></section>';
}
function closedHTML() {
  return '<section class="empty"><h1>This table is closed</h1><p>The host closed it, or the code is wrong. Scan the code on the host\'s screen again.</p></section>';
}

function contractPanel(h, mine) {
  const g = game, c = g.contracts[h], r = g.rules;
  const d = dealerOf(g, h), f = firstOf(g, h);
  const youDeal = mine && d && d.id === mine.id, youFirst = mine && f && f.id === mine.id;
  return '<section class="mini" aria-labelledby="mt"><div><p class="eyebrow">Hand <b>' + (h + 1) + '</b> of ' + g.contracts.length +
    (h === g.hand && g.status === 'playing' ? ' &middot; now playing' : '') + '</p>' +
    '<h1 class="mtitle" id="mt">' + esc(cTitle(c)) + '</h1>' +
    '<p class="csub">' + esc(cLong(c, r)) + ', at least ' + cMin(c, r) + ' cards' + (c.all ? '. Meld every card except the final discard.' : '.') + '</p>' +
    '<p class="csub">' + c.deal + ' cards &middot; ' + (youDeal ? '<span class="youdeal">You deal</span>' : esc(d ? d.name : '') + ' deals') + ' &middot; ' +
    (youFirst ? '<span class="youdeal">You play first</span>' : esc(f ? f.name : '') + ' plays first') + '</p></div>' +
    meldsHTML(c, r, 'mini-melds') +
    '<p class="hint">' + rulesLine(r) + '</p>' + (g.notes ? '<p class="notes">' + esc(g.notes) + '</p>' : '') + '</section>';
}

function standingsPanel(mine) {
  const rows = ranked(game), started = anyScores(game);
  return '<section class="panel" aria-labelledby="sp"><h2 class="panel-title" id="sp">Standings</h2><ol class="mini-stand">' +
    rows.map(r => '<li class="' + (started && r.rank === 1 ? 'lead' : '') + (mine && r.p.id === mine.id ? ' me' : '') + '"><span class="rk">' + r.rank + '</span>' +
      '<span class="pdot" style="--pc:' + colorOf(r.p) + '"></span><span class="pn">' + esc(r.p.name) + (mine && r.p.id === mine.id ? '<span class="tag you">You</span>' : '') + '</span>' +
      '<span class="tot">' + r.total + '</span><span class="gap">' + (r.gap ? '+' + r.gap : '&ndash;') + '</span></li>').join('') +
    '</ol><p class="hint">Low score wins.</p></section>';
}

function joinHTML() {
  const g = game, free = g.players.filter(p => !p.hasDevice);
  return '<div class="card-page">' +
    '<section class="panel" aria-labelledby="jt"><p class="eyebrow">Table ' + esc(g.code) + ' &middot; Contract Rummy</p>' +
    '<h1 class="mtitle" id="jt">Join the table</h1>' +
    (notice ? '<p class="note">' + esc(notice) + '</p>' : '') +
    (g.status === 'playing' ? '<p class="hint">The game is on hand ' + (g.hand + 1) + '. Ask the host to fill in any earlier hands you played.</p>' : '') +
    (g.status === 'done' ? '<p class="hint">This game is finished. You can still join for the next one.</p>' : '') +
    (free.length ? '<p class="hint">Already seated by the host? Tap your name.</p><ul class="claim-list">' + free.map(p =>
      '<li><button type="button" class="prow" data-act="claim" data-arg="' + esc(p.id) + '"' + (busy ? ' disabled' : '') + '><span class="pdot" style="--pc:' + colorOf(p) + '"></span>' +
      '<span class="pmeta"><span class="pn">' + esc(p.name) + '</span><span class="psub">Tap if this is you</span></span></button></li>').join('') + '</ul>' : '') +
    '<form class="join-form" data-form="join"><label class="eyebrow" for="join-name">' + (free.length ? 'Or join with a new name' : 'Your name') + '</label>' +
    '<input class="txt" id="join-name" maxlength="24" autocomplete="given-name" autocapitalize="words" enterkeyhint="go" placeholder="Your name">' +
    '<button class="btn primary big" type="submit"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Joining' : 'Join') + '</button></form></section>' +
    (g.players.length ? standingsPanel(null) : '') +
    '<p class="version">play27 Scorekeeper v' + esc(APP_VERSION) + '</p></div>';
}

function seatedHTML() {
  const g = game, mine = myPlayer(), C = g.contracts;
  const h = editHand === null || editHand >= C.length ? g.hand : editHand;
  const v = cellv(g, h, mine.id), t = totalsMap(g);
  let html = '<div class="card-page">';

  html += '<div class="me-bar"><span class="me-name"><span class="pdot" style="--pc:' + colorOf(mine) + '"></span>' + esc(mine.name) + '</span>' +
    '<span class="note">Total <b>' + t[mine.id] + '</b></span></div>';
  if (renaming) {
    html += '<form class="addrow" data-form="rename"><label class="sr" for="rename">Your name</label><input class="txt" id="rename" maxlength="24" value="' + esc(mine.name) + '" autocomplete="off">' +
      '<button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-act="rename-cancel">Cancel</button></form>';
  }

  if (g.status === 'done') {
    const rows = ranked(g), winners = rows.filter(r => r.rank === 1), mineRow = rows.find(r => r.p.id === mine.id);
    html += '<section class="myscore"><p class="eyebrow">Game over</p><h1 class="mtitle">' + listNames(winners.map(r => r.p)) + (winners.length > 1 ? ' tie' : ' wins') + '</h1>' +
      '<p class="note">You finished ' + (mineRow ? ordinal(mineRow.rank) : '') + ' with ' + t[mine.id] + ' points. Waiting for the host to start the next game.</p></section>';
    html += standingsPanel(mine);
  } else if (g.status === 'setup') {
    html += '<section class="myscore"><p class="eyebrow">You\'re in</p><p class="note">Waiting for the host to start the game. ' +
      g.players.length + (g.players.length === 1 ? ' player' : ' players') + ' at the table.</p></section>';
    html += contractPanel(0, mine) + standingsPanel(mine);
  } else {
    const miss = missing(g, h), n = g.players.length, outs = wentOut(g, h);
    const outNote = outs.length === 1 && outs[0].id !== mine.id ? ' ' + esc(outs[0].name) + ' went out.' : '';
    let status;
    if (h !== g.hand) status = 'You are changing hand ' + (h + 1) + '. Play is on hand ' + (g.hand + 1) + '. <button type="button" class="link" data-act="pick-hand" data-arg="' + g.hand + '">Back to hand ' + (g.hand + 1) + '</button>';
    else if (outs.length > 1) status = '<span class="contested">Winner contested:</span> ' + listNames(outs) + (outs.length > 2 ? ' all' : ' both') + ' entered 0. The host will settle who went out.';
    else if (miss.length) status = 'Scores in: ' + (n - miss.length) + ' of ' + n + '.' + outNote + ' Waiting on ' + listNames(miss) + '.';
    else if (h < C.length - 1) {
      const nd = dealerOf(g, h + 1);
      status = 'All scores are in. Next is hand ' + (h + 2) + ': ' + (nd && nd.id === mine.id ? '<span class="youdeal">you deal</span>' : esc(nd ? nd.name : '') + ' deals') + ' ' + C[h + 1].deal + ' cards.';
    } else status = 'All scores are in. Waiting for the host to finish the game.';
    html += '<section class="myscore" aria-labelledby="ms"><p class="eyebrow" id="ms">Your score for hand ' + (h + 1) + '</p>' +
      '<div class="row"><span class="mynum">' + (v === null ? '&ndash;' : v) + '</span>' +
      '<button type="button" class="btn primary big" data-act="enter">' + (v === null ? 'Enter my score' : 'Change') + '</button></div>' +
      '<p class="note">' + status + '</p></section>';
    html += '<nav class="handpick" aria-label="Choose a hand">' + C.map((cc, i) =>
      '<button type="button" class="hp' + (i === g.hand ? ' now' : '') + (cellv(g, i, mine.id) !== null ? ' full' : '') + '" data-act="pick-hand" data-arg="' + i + '" aria-pressed="' + (i === h) + '"' +
      (i > g.hand ? ' disabled' : '') + ' aria-label="Hand ' + (i + 1) + '">' + (i + 1) + '</button>').join('') + '</nav>';
    html += contractPanel(h, mine) + standingsPanel(mine);
  }

  const leaveOn = armed === 'leave';
  html += '<div class="btn-row"><button type="button" class="btn small" data-act="rename">Change my name</button>' +
    '<button type="button" class="btn small' + (leaveOn ? ' armed' : '') + '" data-act="leave">' + (leaveOn ? 'Tap again to leave this seat' : 'Not you? Leave this seat') + '</button></div>' +
    '<p class="version">play27 Scorekeeper v' + esc(APP_VERSION) + '</p></div>';
  return html;
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/* ---------- events ---------- */

const ACT = {
  claim: a => claim(a),
  enter: () => {
    const h = editHand === null ? game.hand : editHand;
    sheet.open(me.playerId, h);
  },
  'pick-hand': a => { const i = parseInt(a, 10); editHand = i === game.hand ? null : i; render(); },
  rename: () => { renaming = true; render(); const el = $('#rename'); if (el) el.focus(); },
  'rename-cancel': () => { renaming = false; render(); },
  leave: async () => {
    if (armed !== 'leave') {
      armed = 'leave'; clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = null; render(); }, 4000);
      render(); return;
    }
    armed = null;
    try { await call('score_leave', { p_code: code, p_token: me.token }); } catch (e) { /* seat already gone */ }
    me = null; store(ME_KEY, null); notice = 'You left your seat. Your scores stay with it.';
    if (watcher) watcher.refresh();
    render();
  }
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.disabled || !game) return;
  const fn = ACT[t.dataset.act]; if (fn) fn(t.dataset.arg, t, e);
});
document.addEventListener('submit', e => {
  const f = e.target.closest('[data-form]'); if (!f) return;
  e.preventDefault();
  if (f.dataset.form === 'join') {
    const name = $('#join-name').value.trim();
    if (!name) { $('#join-name').focus(); return; }
    join(name);
  } else if (f.dataset.form === 'rename') {
    const name = $('#rename').value.trim();
    if (!name) return;
    call('score_rename_self', { p_code: code, p_token: me.token, p_name: name })
      .then(() => { renaming = false; if (watcher) watcher.refresh(); render(); })
      .catch(err => toast(err.message));
  }
});

/* ---------- boot ---------- */

let watcher = null;
render();
if (code) {
  watcher = watchTable(code, g => {
    if (!g) { closed = true; loaded = true; sheet.close(); render(); return; }
    closed = false; game = g; loaded = true;
    if (me) {
      const p = g.players.find(x => x.id === me.playerId);
      if (!p || !p.hasDevice) verifySeat();
    }
    if (sheet.isOpen) return; // don't rebuild the page under the open keypad
    render();
  }, s => { syncState = s; syncLabel($('#sync'), s); });
}
