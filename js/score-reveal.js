// ============================================================
// play27 — Scorekeeper hand reveal (the table display)
// Once every score for a hand is in: the hand's scores low to high,
// the next deal, then the standings high to low. Each one shows large
// in the middle, then flies to its stack. A countdown hold follows.
// No imports: it renders whatever snapshot scorekeeper.js hands it.
// ============================================================

// Step lengths in ms. Every host device works out the same total for the same hand, and that
// total sets when the next hand deals, so no step may depend on a device setting.
const STEP = { intro: 1400, out: 2600, score: 4000, next: 3800, standings: 1300, total: 2600, settle: 900 };
const FLY = 650, LAND = 150;
export const HOLD_MS = 120000;

/** How long the reveal runs for a snapshot, before the hold. */
export function revealDuration(s) {
  const outs = s.hand.filter(r => r.score === 0).length;
  return STEP.intro + outs * STEP.out + (s.hand.length - outs) * STEP.score +
    (s.next ? STEP.next : 0) + STEP.standings + s.totals.length * STEP.total + STEP.settle;
}

const QUIPS = {
  neg: ['Below zero. Show-off.', 'Negative points. Sure, why not.'],
  low: ['Barely a scratch.', 'So close to going out.', 'One more turn and that was a zero.', 'Practically clean.'],
  mid: ['Not great, not terrible.', 'A tidy little pile.', 'The cards were mostly kind.', 'Respectable. Mostly.'],
  high: ['That one stung.', 'Holding a few souvenirs.', 'The deck had other plans.', 'Caught holding the bag.'],
  big: ['Ouch.', "That's a lot of cardboard.", "Bold strategy. It didn't work.", 'Saving them for later?'],
  huge: ['Call the paramedics.', "That's not a hand, that's a collection.", 'Somewhere a joker is laughing.', 'Bring a wheelbarrow.'],
  worst: ['Biggest pile of the hand.', 'Top of the pile. Wrong pile.', 'Hand of the night, for the wrong reasons.']
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// Same snapshot, same line on every device.
function quip(s, r, i) {
  const v = r.score, n = s.hand.length;
  const list = v < 0 ? QUIPS.neg
    : i === n - 1 && n > 2 && v >= 40 && v > s.hand[i - 1].score ? QUIPS.worst
    : v <= 15 ? QUIPS.low : v <= 35 ? QUIPS.mid : v <= 60 ? QUIPS.high : v <= 100 ? QUIPS.big : QUIPS.huge;
  return list[hash(s.key + ':' + r.id) % list.length];
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
const dot = c => '<span class="pdot" style="--pc:' + esc(c) + '"></span>';

/* ---------- pieces ---------- */

function handRow(r, hidden) {
  const out = r.score === 0;
  return '<li class="rv-row' + (out ? ' out' : '') + (hidden ? ' ph' : '') + '">' + dot(r.color) + '<span class="pn">' + esc(r.name) + '</span>' +
    (out ? '<span class="tag">Out</span>' : '') + '<span class="sc">' + r.score + '</span></li>';
}
function totRow(r, hidden) {
  return '<li class="rv-row' + (r.rank === 1 ? ' lead' : '') + (hidden ? ' ph' : '') + '"><span class="rk">' + r.rank + '</span>' + dot(r.color) +
    '<span class="pn">' + esc(r.name) + '</span><span class="sc">' + r.total + '</span></li>';
}
function nextCard(n, hidden) {
  return '<div class="rv-nextcard' + (hidden ? ' ph' : '') + '"><p class="eyebrow">Next &middot; hand <b>' + n.handNo + '</b> of ' + n.hands + '</p>' +
    '<p class="rv-ntitle">' + esc(n.title) + '</p>' +
    '<p class="rv-nsub"><b>' + esc(n.dealer) + '</b> deals ' + n.deal + ' cards &middot; ' + esc(n.first) + ' plays first' +
    (n.all ? ' &middot; meld all but the discard' : '') + '</p></div>';
}
function bigTitle(eyebrow, title, sub) {
  return '<div class="rv-big plain"><p class="eyebrow">' + eyebrow + '</p><p class="rv-title">' + title + '</p>' +
    (sub ? '<p class="rv-quip">' + sub + '</p>' : '') + '</div>';
}
function bigScore(s, r, i, remarks) {
  const out = r.score === 0;
  return '<div class="rv-big"><p class="eyebrow">Hand ' + s.handNo + (out ? ' &middot; went out' : '') + '</p>' +
    '<p class="rv-name">' + dot(r.color) + esc(r.name) + '</p>' +
    '<p class="rv-num' + (out ? ' out' : '') + '" data-to="' + r.score + '">0</p>' +
    (!out && remarks ? '<p class="rv-quip">' + esc(quip(s, r, i)) + '</p>' : '') + '</div>';
}
function bigNext(n) {
  return '<div class="rv-big"><p class="eyebrow">Next up &middot; hand <b>' + n.handNo + '</b> of ' + n.hands + '</p>' +
    '<p class="rv-title">' + esc(n.title) + '</p>' +
    '<div class="deal"><div><span class="k">Deal</span><span class="v">' + n.deal + ' cards</span></div>' +
    '<div><span class="k">Dealer</span><span class="v">' + esc(n.dealer) + '</span></div>' +
    '<div><span class="k">Plays first</span><span class="v">' + esc(n.first) + '</span></div></div>' +
    (n.all ? '<p class="rv-quip">Meld every card except the final discard.</p>' : '') + '</div>';
}
function bigTotal(s, r) {
  const tied = s.totals.filter(x => x.rank === r.rank).length > 1;
  const lead = r.rank === 1;
  const eb = lead ? (s.final ? (tied ? 'Tied for the win' : 'Wins the game') : (tied ? 'Tied for the lead' : 'In the lead'))
    : (tied ? 'Tied for ' + ordinal(r.rank) : ordinal(r.rank) + ' place');
  const sub = lead ? 'Low score ' + (s.final ? 'wins.' : 'leads.') : r.gap + ' behind the lead';
  return '<div class="rv-big"><p class="eyebrow">' + eb + '</p><p class="rv-name">' + dot(r.color) + esc(r.name) + '</p>' +
    '<p class="rv-num' + (lead ? ' lead' : '') + '" data-to="' + r.total + '">0</p><p class="rv-quip">' + sub + '</p></div>';
}

/* ---------- player ---------- */

/**
 * opts.remarks() → true to show the funny lines; opts.onDeal(), opts.onFinish(), opts.onBoard()
 * run from the hold's buttons. play() runs the full show; hold() opens straight on the final layout.
 */
export function createReveal(root, opts) {
  let el = null, phase = null, run = 0, shown = null, latest = null, deadline = null, ticker = null;
  const q = sel => el.querySelector(sel);
  const reduce = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const sig = s => JSON.stringify(s);
  const wait = ms => new Promise(res => setTimeout(res, ms));

  function frame(s) {
    root.innerHTML = '<div class="rv" role="dialog" aria-modal="true" aria-label="Hand ' + s.handNo + ' results"><div class="rv-grid">' +
      '<section class="rv-col rv-hand"><p class="eyebrow rv-head" data-head="hand">Hand <b>' + s.handNo + '</b> &middot; ' + esc(s.title) + '</p>' +
      '<ol class="rv-list" data-list="hand">' + s.hand.map(r => handRow(r, true)).join('') + '</ol></section>' +
      '<div class="rv-center"><div class="rv-holdtop" data-slot="holdtop">' + holdTop(s) + '</div>' +
      '<div class="rv-next" data-slot="next">' + (s.next ? nextCard(s.next, true) : '') + '</div>' +
      '<div class="rv-holdbtns" data-slot="holdbtns">' + holdBtns(s) + '</div></div>' +
      '<section class="rv-col rv-tot"><p class="eyebrow rv-head" data-head="tot">' + (s.final ? 'Final standings' : 'Standings after hand ' + s.handNo) + '</p>' +
      '<ol class="rv-list" data-list="tot">' + s.totals.map(r => totRow(r, true)).join('') + '</ol></section></div>' +
      '<div class="rv-stage" data-slot="stage" aria-live="polite"></div>' +
      '<button type="button" class="tool rv-skip" data-rv="skip">Skip</button></div>';
    el = root.firstElementChild;
    document.body.classList.add('rv-on');
  }

  function countUp(node, to) {
    if (reduce() || to <= 0) { node.textContent = to; return; }
    const my = run, t0 = performance.now(), dur = Math.min(900, 300 + to * 6);
    (function step(t) {
      if (my !== run || !node.isConnected) return;
      const k = Math.min(1, (t - t0) / dur);
      node.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }
  function show(html) {
    const st = q('[data-slot="stage"]');
    st.innerHTML = html;
    st.classList.add('dim');
    const num = st.querySelector('[data-to]');
    if (num) countUp(num, +num.dataset.to);
    return st.firstElementChild;
  }
  function clearStage() {
    const st = q('[data-slot="stage"]');
    st.innerHTML = '';
    st.classList.remove('dim');
  }
  function headOn(which) { q('[data-head="' + which + '"]').classList.add('on'); }

  // Shrink the big card into its slot, and fade the slot in as it lands.
  function fly(big, slot) {
    q('[data-slot="stage"]').classList.remove('dim');
    if (!big || !slot || typeof big.animate !== 'function') { clearStage(); if (slot) slot.classList.remove('ph'); return; }
    const ms = reduce() ? 1 : FLY;
    const a = big.getBoundingClientRect(), b = slot.getBoundingClientRect();
    const k = Math.max(0.08, Math.min(b.width / a.width, b.height / a.height));
    slot.classList.remove('ph');
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    big.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + k + ')', opacity: 0 }],
      { duration: ms, easing: 'cubic-bezier(.55,0,.3,1)', fill: 'forwards' });
    slot.animate([{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'none' }],
      { duration: reduce() ? 1 : 280, delay: ms * 0.62, easing: 'ease-out', fill: 'backwards' });
  }
  function handSlot(i) { return q('[data-list="hand"]').children[i]; }
  // Standings fill from the bottom up: each new row lands on top of the one before it.
  function totSlot(i) { return q('[data-list="tot"]').children[i]; }
  function nextSlot() { return q('[data-slot="next"]').firstElementChild; }

  async function sequence(my) {
    const s = shown;
    const alive = () => my === run && phase === 'reveal';
    let big;
    show(bigTitle('All scores are in', 'Hand ' + s.handNo, esc(s.title)));
    await wait(STEP.intro - 300); if (!alive()) return;
    clearStage(); headOn('hand');
    await wait(300); if (!alive()) return;
    for (let i = 0; i < s.hand.length; i++) {
      const r = s.hand[i];
      big = show(bigScore(s, r, i, opts.remarks()));
      await wait((r.score === 0 ? STEP.out : STEP.score) - FLY - LAND); if (!alive()) return;
      fly(big, handSlot(i));
      await wait(FLY + LAND); if (!alive()) return;
    }
    if (s.next) {
      big = show(bigNext(s.next));
      await wait(STEP.next - FLY - LAND); if (!alive()) return;
      fly(big, nextSlot());
      await wait(FLY + LAND); if (!alive()) return;
    }
    show(bigTitle(s.final ? 'After ' + s.hands + ' hands' : 'After hand ' + s.handNo, s.final ? 'Final standings' : 'Standings'));
    await wait(STEP.standings - 300); if (!alive()) return;
    clearStage(); headOn('tot');
    await wait(300); if (!alive()) return;
    for (let i = s.totals.length - 1; i >= 0; i--) {
      const r = s.totals[i];
      big = show(bigTotal(s, r));
      await wait(STEP.total - FLY - LAND); if (!alive()) return;
      fly(big, totSlot(i));
      await wait(FLY + LAND); if (!alive()) return;
    }
    await wait(STEP.settle); if (!alive()) return;
    toHold();
  }

  function renderStatic(s) {
    shown = s;
    clearStage();
    headOn('hand'); headOn('tot');
    q('[data-list="hand"]').innerHTML = s.hand.map(r => handRow(r)).join('');
    q('[data-slot="next"]').innerHTML = s.next ? nextCard(s.next) : '';
    q('[data-list="tot"]').innerHTML = s.totals.map(r => totRow(r)).join('');
    q('[data-slot="holdtop"]').innerHTML = holdTop(s);
    q('[data-slot="holdbtns"]').innerHTML = holdBtns(s);
  }

  function holdTop(s) {
    return '<p class="eyebrow">' + (s.next ? 'Hand <b>' + s.next.handNo + '</b> is being dealt' : 'Every hand is scored') + '</p>' +
      (deadline ? '<p class="rv-cd" data-rv-cd>' + clock(deadline - Date.now()) + '</p>' +
        '<p class="hint">' + (s.next ? 'The board moves to hand ' + s.next.handNo + ' when this runs out.' : 'Back to the board when this runs out.') + '</p>' : '');
  }
  function holdBtns(s) {
    return '<div class="btn-row">' + (s.next
      ? '<button type="button" class="btn primary" data-rv="deal">Deal hand ' + s.next.handNo + ' now</button>'
      : '<button type="button" class="btn primary" data-rv="finish">Finish game</button>') +
      '<button type="button" class="btn" data-rv="board">Back to the board</button></div>';
  }
  function toHold() {
    phase = 'hold';
    el.classList.add('held');
    if (sig(latest) !== sig(shown)) renderStatic(latest);
    q('[data-rv="skip"]').hidden = true;
  }

  function open(s, o, straightToHold) {
    run++;
    shown = latest = s;
    deadline = (o && o.deadline) || null;
    frame(s);
    clearInterval(ticker);
    ticker = setInterval(() => {
      const n = el && el.querySelector('[data-rv-cd]');
      if (n && deadline) n.textContent = clock(deadline - Date.now());
    }, 500);
    if (straightToHold) { renderStatic(s); toHold(); }
    else { phase = 'reveal'; sequence(run); }
  }

  function close() {
    if (!phase) return;
    run++; phase = null; shown = latest = null;
    clearInterval(ticker); ticker = null;
    document.body.classList.remove('rv-on');
    const node = el; el = null;
    if (!node) return;
    node.classList.add('closing');
    setTimeout(() => { if (root.firstElementChild === node) root.innerHTML = ''; }, 320);
  }

  root.addEventListener('click', e => {
    const t = e.target.closest('[data-rv]');
    if (!t || !phase) return;
    const a = t.dataset.rv;
    if (a === 'skip') { if (phase === 'reveal') { run++; renderStatic(latest); toHold(); } }
    else if (a === 'deal') { if (opts.onDeal) opts.onDeal(); }
    else if (a === 'finish') { if (opts.onFinish) opts.onFinish(); }
    else if (a === 'board') { if (opts.onBoard) opts.onBoard(); }
  });

  return {
    play(s, o) { open(s, o, false); },
    hold(s, o) { open(s, o, true); },
    /** New data for the open hand (a fixed score): the hold redraws, a running show picks it up at the end. */
    update(s) {
      if (!phase) return;
      latest = s;
      if (phase === 'hold' && sig(s) !== sig(shown)) renderStatic(s);
    },
    close,
    get isOpen() { return !!phase; },
    get key() { return shown ? shown.key : null; }
  };
}
