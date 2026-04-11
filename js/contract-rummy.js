import { sb, rpc } from './supabase.js?v=0.11.0';
import { initTheme } from './theme.js?v=0.11.0';

// ── Constants ──
const CIRCUMFERENCE = 2 * Math.PI * 20;
const CONTRACT_DESCRIPTIONS = {
  1: '2 Sets of 3',
  2: '1 Set + 1 Run',
  3: '2 Runs',
  4: '3 Sets',
  5: '2 Sets + 1 Run',
  6: '1 Set + 2 Runs',
  7: '3 Runs (must meld all)'
};
const CONTRACT_EXAMPLES = {
  1: '7♠7♥7♦ + Q♣Q♠Q♥',
  2: '5♠5♥5♦ + 8♣9♣10♣',
  3: '3♥4♥5♥ + J♠Q♠K♠',
  4: '4♠4♥4♦ + 9♣9♠9♥ + K♦K♣K♠',
  5: '6♠6♥6♦ + A♣A♠A♥ + 3♦4♦5♦',
  6: '10♠10♥10♦ + 4♣5♣6♣ + 7♥8♥9♥',
  7: '2♠3♠4♠ + 6♥7♥8♥ + J♦Q♦K♦'
};

// Card ID encoding: DSVV (D=deck, S=suit, VV=value)
const SUIT_INFO = [
  { symbol: '\u2660', name: 'S', red: false }, // 0 = Spades
  { symbol: '\u2665', name: 'H', red: true },  // 1 = Hearts
  { symbol: '\u2666', name: 'D', red: true },  // 2 = Diamonds
  { symbol: '\u2663', name: 'C', red: false }, // 3 = Clubs
];
const VALUE_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };

// ── State ──
let gameId = null;
let gameCode = null;
let gameState = null;
let myUserId = null;
let myPlayerInfo = null;
let countdownActive = false;
let countdownVal = 0;
let countdownDuration = 5;
let countdownInterval = null;
let buyRequestSent = false;
let selectedCards = new Set();
let layOffMode = false;
let handSortMode = 'custom'; // 'custom' | 'set' | 'run'
let customHandOrder = [];    // user-defined card order
let subscriptions = [];
let stagedMelds = [];
let stagingOpen = false;
let logOpen = false;
let animatingDraw = false;
let recentMeldCards = new Set(); // cards added to melds this turn, gold highlight
let isSpectator = false;
let isHost = false;
let lateJoinStatus = null;      // 'pending' | 'approved' | 'spectating' | 'kicked'
let activeJoinRequestId = null;  // for host modal dedup

// ── DOM refs ──
const $loading = document.getElementById('loadingScreen');
const $waiting = document.getElementById('waitingRoom');
const $board = document.getElementById('gameBoard');

// ── Init ──
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }
  myUserId = session.user.id;

  const params = new URLSearchParams(window.location.search);
  gameCode = params.get('game');
  if (!gameCode) {
    alert('No game code provided. Add ?game=CODE to URL.');
    return;
  }

  const { data: game, error: gameErr } = await sb.from('games')
    .select('id, status, created_by, buy_countdown_seconds')
    .eq('code', gameCode)
    .single();

  if (gameErr || !game) {
    alert('Game not found: ' + gameCode);
    return;
  }

  gameId = game.id;
  countdownDuration = game.buy_countdown_seconds || 5;

  if (game.status === 'waiting') {
    showWaitingRoom(game);
  } else if (game.status === 'active') {
    // join_game handles both rejoin (existing player) and late-join request (new player)
    const { error: joinErr } = await rpc('join_game', { p_code: gameCode });
    if (joinErr) {
      showToast('Error', joinErr.message);
      return;
    }
    await enterGame();
  } else {
    alert('This game has finished.');
  }
}

// ── Waiting Room ──
async function showWaitingRoom(game) {
  $loading.style.display = 'none';
  $waiting.style.display = 'flex';
  $board.style.display = 'none';

  document.getElementById('gameCodeDisplay').textContent = gameCode;

  const btnStart = document.getElementById('btnStartGame');
  const waitSub = document.getElementById('waitingSub');
  isHost = game.created_by === myUserId;
  if (isHost) {
    btnStart.style.display = '';
    waitSub.style.display = 'none';
  }

  await refreshPlayerList();
  setupWaitingSubscriptions(game);
}

async function refreshPlayerList() {
  const { data: players } = await sb.from('game_players')
    .select('player_id, seat_position, profiles(display_name)')
    .eq('game_id', gameId)
    .order('seat_position');

  const list = document.getElementById('playerList');
  list.innerHTML = '';
  if (!players) return;

  const { data: game } = await sb.from('games').select('created_by').eq('id', gameId).single();

  for (const p of players) {
    const li = document.createElement('li');
    const name = p.profiles?.display_name || 'Player';
    const isHost = game && p.player_id === game.created_by;
    li.innerHTML = `<span class="seat-num">#${p.seat_position + 1}</span> ${name}${isHost ? '<span class="host-tag">Host</span>' : ''}`;
    list.appendChild(li);
  }
}

function setupWaitingSubscriptions(game) {
  const sub = sb.channel('waiting-' + gameId)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'game_players',
      filter: `game_id=eq.${gameId}`
    }, () => refreshPlayerList())
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'games',
      filter: `id=eq.${gameId}`
    }, async (payload) => {
      if (payload.eventType === 'DELETE') {
        sub.unsubscribe();
        showToast('Game Cancelled', 'The host cancelled this game.');
        setTimeout(() => { window.location.href = 'login.html'; }, 1500);
        return;
      }
      if (payload.new.status === 'active') {
        sub.unsubscribe();
        await enterGame();
      }
    })
    .subscribe();
}

async function enterGame() {
  $loading.style.display = 'none';
  $waiting.style.display = 'none';
  $board.style.display = 'grid';

  await fetchAndRender();
  setupGameSubscriptions();
}

async function fetchAndRender() {
  const { data, error } = await rpc('get_game_state', { p_game_id: gameId });
  if (error) {
    console.error('get_game_state error:', error);
    return;
  }
  gameState = data;
  countdownDuration = gameState.buy_countdown_seconds || 5;
  isSpectator = gameState.is_spectator || false;
  lateJoinStatus = gameState.my_late_join_status || null;
  myPlayerInfo = gameState.players?.find(p => p.is_you);

  if (isSpectator) {
    updateSpectatorUI();
  } else {
    // If we were a spectator and now we're not, clean up spectator UI
    const banner = document.getElementById('spectatorBanner');
    if (banner) banner.style.display = 'none';
    const yourSection = document.querySelector('.your-section');
    const actionsPanel = document.querySelector('.actions-panel');
    if (yourSection) yourSection.classList.remove('spectator-hidden');
    if (actionsPanel) actionsPanel.classList.remove('spectator-hidden');
  }

  // Host: show late-join request modal if any pending
  if (gameState.pending_join_requests?.length > 0) {
    showLateJoinRequestModal(gameState.pending_join_requests[0]);
  }

  render();
}

// ── Subscriptions ──
function setupGameSubscriptions() {
  subscriptions.forEach(s => s.unsubscribe());
  subscriptions = [];

  const channel = sb.channel('game-' + gameId)
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'rounds'
    }, () => { if (!animatingDraw) fetchAndRender(); })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'round_cards'
    }, () => { if (!animatingDraw) fetchAndRender(); })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'melds'
    }, () => { if (!animatingDraw) fetchAndRender(); })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'buy_requests'
    }, () => { if (!animatingDraw) fetchAndRender(); })
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'late_join_requests',
      filter: `game_id=eq.${gameId}`
    }, () => { fetchAndRender(); })
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'game_actions',
      filter: `game_id=eq.${gameId}`
    }, async (payload) => {
      const action = payload.new;
      // Track cards added to melds this turn
      if (action.action_type === 'lay_off' && action.details?.card) {
        recentMeldCards.add(action.details.card);
      } else if (action.action_type === 'contract_met' && action.details?.cards) {
        action.details.cards.forEach(c => recentMeldCards.add(c));
      } else if (action.action_type === 'discard') {
        // Turn ended — clear highlights
        recentMeldCards.clear();
      }
      // Animate buy cards flying to hand when I win a buy
      if (action.action_type === 'buy_awarded'
          && action.player_id === myPlayerInfo?.player_id) {
        const d = action.details;
        lastDrawnCard = d.discard_card;
        lastPenaltyCard = d.penalty_card;
        const discardEl = document.getElementById('discardFace');
        const deckEl = document.querySelector('#deckWrap .deck-card-vis:last-child');
        const discardRect = discardEl ? discardEl.getBoundingClientRect() : null;
        const deckRect = deckEl ? deckEl.getBoundingClientRect() : null;
        animatingDraw = true;
        if (discardRect) await flyCardToHand(discardRect, d.discard_card, false, false);
        if (deckRect) await flyCardToHand(deckRect, d.penalty_card, true, true);
        animatingDraw = false;
        await fetchAndRender();
        return;
      }
      await fetchAndRender();
    })
    .subscribe();

  subscriptions.push(channel);
}

// ── Card Helpers ──
function parseCard(code) {
  if (!code || code.length < 4) return { rank: '?', suit: '?', symbol: '?', red: false, id: code };
  const suitDigit = parseInt(code[1]);
  const value = parseInt(code.substring(2));
  if (suitDigit === 9) {
    return { rank: 'JK', suit: 9, symbol: '\u2605', red: value === 1, id: code };
  }
  const info = SUIT_INFO[suitDigit] || { symbol: '?', red: false };
  const rank = VALUE_NAMES[value] || value.toString();
  return { rank, suit: suitDigit, symbol: info.symbol, red: info.red, id: code };
}

function cardSuit(code) { return parseInt(code[1]); }
function cardValue(code) { return parseInt(code.substring(2)); }
function isJoker(code) { return code[1] === '9'; }

function renderMiniCard(code) {
  const c = parseCard(code);
  const glow = recentMeldCards.has(code) ? ' mc-glow' : '';
  return `<div class="mc${c.red ? ' r' : ''}${glow}"><span class="s">${c.rank}</span><span>${c.symbol}</span></div>`;
}

function renderHandCard(code, stagedCards) {
  const c = parseCard(code);
  const isStaged = stagedCards && stagedCards.has(code);
  const selClass = selectedCards.has(code) ? ' sel' : '';
  const dimStyle = isStaged ? ' style="opacity:0.3;pointer-events:none;"' : '';
  const drag = isStaged ? '' : ' draggable="true"';
  return `<div class="hc${c.red ? ' r' : ''}${selClass}" data-card="${code}"${dimStyle}${drag}><span class="rnk">${c.rank}</span><span class="sct">${c.symbol}</span><span class="rnkb">${c.rank}</span></div>`;
}

// ── Main Render ──
function render() {
  if (!gameState) return;

  if (gameState.status === 'finished') {
    document.getElementById('statusText').textContent = 'Game finished!';
    return;
  }

  if (gameState.status === 'waiting') {
    showWaitingRoom({ id: gameId, created_by: null, buy_countdown_seconds: countdownDuration });
    return;
  }

  const round = gameState.round;
  if (!round) return;

  // Show round-end overlay if round is finished
  if (round.status === 'finished') {
    showRoundEnd();
    return;
  }

  hideRoundEnd();
  renderTopBar(round);

  // Spectator: show board in read-only mode
  if (isSpectator) {
    renderSeats(round);
    renderDeckDiscard(round);
    // Hide interactive elements
    const yourSection = document.querySelector('.your-section');
    const actionsPanel = document.querySelector('.actions-panel');
    if (yourSection) yourSection.classList.add('spectator-hidden');
    if (actionsPanel) actionsPanel.classList.add('spectator-hidden');
    return;
  }

  renderStandings();
  renderSeats(round);
  renderDeckDiscard(round);
  renderMyMelds(round);
  renderHand(round);
  renderActionButtons(round);
  if (stagingOpen) renderStagedMelds();
  loadGameLog();
}

function renderStandings() {
  const panel = document.getElementById('standingsPanel');
  if (!gameState?.players) { panel.innerHTML = ''; return; }
  const sorted = [...gameState.players].sort((a, b) => {
    // 1. Lowest total score
    const s = (a.total_score || 0) - (b.total_score || 0);
    if (s !== 0) return s;
    // 2. Most rounds won (higher is better)
    const r = (b.rounds_won || 0) - (a.rounds_won || 0);
    if (r !== 0) return r;
    // 3. Least buys
    const bu = (a.total_buys || 0) - (b.total_buys || 0);
    if (bu !== 0) return bu;
    // 4. Least jokers used
    const j = (a.jokers_used || 0) - (b.jokers_used || 0);
    if (j !== 0) return j;
    // 5. Lowest final round score
    return (a.final_round_score || 0) - (b.final_round_score || 0);
  });
  // Assign ranks with ties (all tiebreakers equal = same rank)
  const ranks = [];
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const a = sorted[i], b = sorted[i - 1];
      const tied = (a.total_score || 0) === (b.total_score || 0)
        && (a.rounds_won || 0) === (b.rounds_won || 0)
        && (a.total_buys || 0) === (b.total_buys || 0)
        && (a.jokers_used || 0) === (b.jokers_used || 0)
        && (a.final_round_score || 0) === (b.final_round_score || 0);
      if (!tied) rank = i + 1;
    }
    ranks.push(rank);
  }
  const maxVisible = 3;
  const myIdx = sorted.findIndex(p => p.is_you);
  const rows = [];
  const showTop = Math.min(maxVisible, sorted.length);
  for (let i = 0; i < showTop; i++) {
    const p = sorted[i];
    const cls = p.is_you ? ' is-you' : '';
    const name = p.is_you ? 'You' : (p.display_name || 'Player');
    rows.push(`<div class="standings-row${cls}"><span class="st-rank">${ranks[i]}</span><span class="st-name">${name}</span><span class="st-score">${p.total_score || 0}</span></div>`);
  }
  if (myIdx >= maxVisible) {
    rows.push(`<div class="standings-ellipsis">···</div>`);
    const p = sorted[myIdx];
    rows.push(`<div class="standings-row is-you"><span class="st-rank">${ranks[myIdx]}</span><span class="st-name">You</span><span class="st-score">${p.total_score || 0}</span></div>`);
  }
  panel.innerHTML = '<div class="standings-title">Standings</div>' + rows.join('');
}

function renderTopBar(round) {
  const rn = round.round_number || 1;
  const desc = CONTRACT_DESCRIPTIONS[rn] || `${round.contract_sets || 0} Sets + ${round.contract_runs || 0} Runs`;

  document.getElementById('contractLabel').textContent = `Round ${rn} Contract ▾`;
  document.getElementById('contractVal').textContent = desc;
  document.getElementById('roundInfoText').textContent = `Round ${rn} of 7`;

  const pips = document.getElementById('roundPips');
  pips.innerHTML = '';
  for (let i = 1; i <= 7; i++) {
    const pip = document.createElement('div');
    pip.className = 'pip' + (i < rn ? ' done' : i === rn ? ' active' : '');
    pips.appendChild(pip);
  }

  // Build rounds dropdown
  const dd = document.getElementById('roundsDropdown');
  dd.innerHTML = '<div class="rounds-dropdown-title">All Rounds</div>' +
    [1,2,3,4,5,6,7].map(i => {
      const cls = i < rn ? 'completed' : i === rn ? 'current' : '';
      return `<div class="round-item ${cls}">
        <span class="ri-num">${i}</span>
        <span class="ri-desc">${CONTRACT_DESCRIPTIONS[i]}</span>
        <span class="ri-cards">${CONTRACT_EXAMPLES[i]}</span>
      </div>`;
    }).join('');
}

// ── Seat Positions ──
// Positions opponents around the top half of the table like a real card table.
// Returns [{left%, top%}] for each opponent based on total count.
function getSeatPositions(count) {
  // Distribute seats in an arc across the top of the table
  // Single opponent goes top-center, multiple spread in an arc
  if (count === 1) return [{ left: 50, top: 5 }];
  if (count === 2) return [{ left: 30, top: 5 }, { left: 70, top: 5 }];
  if (count === 3) return [{ left: 15, top: 20 }, { left: 50, top: 3 }, { left: 85, top: 20 }];
  if (count === 4) return [{ left: 10, top: 28 }, { left: 33, top: 5 }, { left: 67, top: 5 }, { left: 90, top: 28 }];
  if (count === 5) return [{ left: 8, top: 32 }, { left: 27, top: 8 }, { left: 50, top: 2 }, { left: 73, top: 8 }, { left: 92, top: 32 }];
  if (count === 6) return [{ left: 6, top: 36 }, { left: 22, top: 12 }, { left: 40, top: 2 }, { left: 60, top: 2 }, { left: 78, top: 12 }, { left: 94, top: 36 }];
  // 7 opponents (8 players)
  return [
    { left: 5, top: 40 }, { left: 18, top: 18 }, { left: 33, top: 4 }, { left: 50, top: 1 },
    { left: 67, top: 4 }, { left: 82, top: 18 }, { left: 95, top: 40 }
  ];
}

function renderTableLines(playerCount) {
  const svg = document.getElementById('tableLines');
  const table = document.getElementById('tableArea');
  const w = table.offsetWidth;
  const h = table.offsetHeight;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.innerHTML = '';

  const cx = w / 2;
  const cy = h / 2;

  // Center box around draw/discard
  const boxW = Math.min(w * 0.4, 340);
  const boxH = Math.min(h * 0.35, 160);
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', cx - boxW / 2);
  rect.setAttribute('y', cy - boxH / 2);
  rect.setAttribute('width', boxW);
  rect.setAttribute('height', boxH);
  svg.appendChild(rect);

  function addLine(x1, y1, x2, y2) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1);
    line.setAttribute('y1', y1);
    line.setAttribute('x2', x2);
    line.setAttribute('y2', y2);
    svg.appendChild(line);
  }

  const oppCount = playerCount - 1;

  if (oppCount === 1) {
    // 2 players: horizontal line through center
    addLine(0, cy, cx - boxW / 2, cy);
    addLine(cx + boxW / 2, cy, w, cy);
  } else {
    // 3+ players: you get the bottom quarter (triangle from center to bottom-left and bottom-right corners)
    // Two diagonal lines define your zone: center to bottom-left corner, center to bottom-right corner
    // That's 225° (bottom-left) and 315° (bottom-right)
    const yourAngles = [225, 315];
    for (const angleDeg of yourAngles) {
      const angleRad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const startX = cx + (boxW / 2 + 4) * cos;
      const startY = cy + (boxH / 2 + 4) * sin;
      const reach = Math.max(w, h);
      const endX = Math.max(0, Math.min(w, cx + reach * cos));
      const endY = Math.max(0, Math.min(h, cy + reach * sin));
      addLine(startX, startY, endX, endY);
    }

    // Remaining 270° (from 315° clockwise to 225°) split evenly among opponents
    // That arc goes: 315° -> 360°/0° -> ... -> 225° (i.e. 270° of arc)
    // Dividing lines between opponent zones: N-1 opponents need N-2 lines
    if (oppCount > 1) {
      for (let i = 1; i < oppCount; i++) {
        const angleDeg = 315 + i * (270 / oppCount);
        const angleRad = ((angleDeg % 360) * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        const startX = cx + (boxW / 2 + 4) * cos;
        const startY = cy + (boxH / 2 + 4) * sin;
        const reach = Math.max(w, h);
        const endX = Math.max(0, Math.min(w, cx + reach * cos));
        const endY = Math.max(0, Math.min(h, cy + reach * sin));
        addLine(startX, startY, endX, endY);
      }
    }
  }
}

function renderSeats(round) {
  const container = document.getElementById('seatsContainer');
  container.innerHTML = '';

  const opponents = gameState.players.filter(p => !p.is_you);
  const oppData = gameState.opponents || [];
  const iMetContract = myPlayerInfo ? checkMetContract() : false;
  const positions = getSeatPositions(opponents.length);

  // Draw table divider lines (total players = opponents + you)
  renderTableLines(opponents.length + 1);

  opponents.forEach((opp, i) => {
    const oppDetail = oppData.find(o => o.player_id === opp.player_id) || {};
    const isActiveTurn = round.current_turn_seat === opp.seat_position;
    const cardsInHand = oppDetail.cards_in_hand || 0;
    const hasMetContract = oppDetail.has_met_contract || false;
    const pos = positions[i] || { left: 50, top: 10 };

    // Find melds for this opponent
    const oppMelds = (gameState.melds || []).filter(m => m.player_id === opp.player_id);

    const seat = document.createElement('div');
    seat.className = 'seat' + (isActiveTurn ? ' active-turn' : '');
    seat.style.left = pos.left + '%';
    seat.style.top = pos.top + '%';

    // Card backs
    let cardBacks = '';
    for (let j = 0; j < Math.min(cardsInHand, 14); j++) {
      cardBacks += '<div class="opp-card-back"><img src="assets/card-back.svg?v=0.10.1"></div>';
    }

    // Melds HTML
    let meldsHtml = '';
    for (const meld of oppMelds) {
      const interClass = iMetContract ? 'interactive' : 'locked';
      const cards = sortCards(meld.cards || []).map(c => renderMiniCard(c)).join('');
      meldsHtml += `<div class="meld-row ${interClass}" data-meld-id="${meld.id}" title="Add to this ${meld.meld_type}">${cards}</div>`;
    }
    if (oppMelds.length === 0) {
      meldsHtml = '<div class="meld-row empty"><span>no melds</span></div>';
    }

    const isDealer = opp.seat_position === gameState.dealer_seat;
    seat.innerHTML = `
      <div class="seat-turn-label">\u25B6 Playing</div>
      <div class="seat-name-row">
        ${isDealer ? '<span class="dealer-btn">D</span>' : ''}<span class="seat-name">${opp.display_name}</span>
        <span class="seat-score">${opp.total_score || 0}</span>
      </div>
      <div class="seat-meta">
        <span>${cardsInHand} cards${hasMetContract ? ' \u2714' : ''}</span>
      </div>
      <div class="seat-hand">${cardBacks}</div>
      <div class="seat-melds">${meldsHtml}</div>
      <div class="buy-queue-badge" id="badge-${opp.player_id}"><span class="pos"></span> in buy queue</div>
    `;

    container.appendChild(seat);
  });

  // Wire up meld click + drag-drop
  container.querySelectorAll('.meld-row.interactive').forEach(row => {
    row.addEventListener('click', () => handleMeldClick(row.dataset.meldId));
  });
  wireMeldDropTargets(container);
}

function checkMetContract() {
  return gameState?.my_has_met_contract || false;
}

// ── Render My Melds (above hand, on the table) ──
function renderMyMelds(round) {
  const myMeldsArea = document.getElementById('myMeldsArea');
  const myMeldsBar = document.getElementById('myMeldsBar');
  const iMetContract = checkMetContract();
  const myMelds = (gameState.melds || []).filter(m => m.player_id === myUserId);

  if (myMelds.length > 0) {
    myMeldsBar.style.display = '';
    const interClass = iMetContract ? 'interactive' : 'locked';
    myMeldsArea.innerHTML = myMelds.map(meld => {
      const cards = sortCards(meld.cards || []).map(c => renderMiniCard(c)).join('');
      return `<div class="meld-row ${interClass}" data-meld-id="${meld.id}" title="Add to this ${meld.meld_type}">${cards}</div>`;
    }).join('');

    myMeldsArea.querySelectorAll('.meld-row.interactive').forEach(row => {
      row.addEventListener('click', () => handleMeldClick(row.dataset.meldId));
    });
    wireMeldDropTargets(myMeldsArea);
  } else {
    myMeldsBar.style.display = 'none';
  }
}

// ── Game Log ──
function formatCard(code) {
  if (!code) return '?';
  const p = parseCard(code);
  if (p.rank === 'JK') return p.red ? '\uD83C\uDCCF R' : '\uD83C\uDCCF B';
  return p.rank + p.symbol;
}

function formatActionDescription(a, playerMap) {
  const name = playerMap[a.player_id] || 'Someone';
  const d = a.details || {};
  switch (a.action_type) {
    case 'game_start':
      return `Game started (${d.player_count || '?'} players)`;
    case 'round_start':
      return `\u2500\u2500 Round ${d.round || '?'}: ${d.contract || ''} \u2500\u2500`;
    case 'draw_deck':
      return `${name} drew from deck`;
    case 'draw_discard':
      return `${name} picked up ${formatCard(d.card)}`;
    case 'discard':
      return `${name} discarded ${formatCard(d.card)}`;
    case 'contract_met':
      return `\u2605 ${name} fulfilled their contract!`;
    case 'lay_meld':
      return `${name} melded a ${d.meld_type || 'meld'}`;
    case 'lay_off':
      return `${name} added ${formatCard(d.card)} to a meld`;
    case 'buy_request':
      return `${name} wants to buy`;
    case 'buy_awarded': {
      const buyer = playerMap[a.player_id] || 'Someone';
      return `${buyer} bought ${formatCard(d.discard_card)}` + (d.penalty_card ? ' (+penalty)' : '');
    }
    case 'round_end':
      return `\u2500\u2500 Round ${d.round || '?'} ended \u2500\u2500`;
    case 'game_end':
      return 'Game over!';
    default:
      return `${name}: ${a.action_type}`;
  }
}

function timeAgo(dateStr) {
  const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (secs < 5) return 'now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

async function loadGameLog() {
  const { data: actions } = await sb.from('game_actions')
    .select('action_type, player_id, details, created_at')
    .eq('game_id', gameId)
    .order('created_at', { ascending: false })
    .limit(100);

  const log = document.getElementById('gameLog');
  if (!log || !actions) return;

  const playerMap = {};
  if (gameState?.players) {
    for (const p of gameState.players) {
      playerMap[p.player_id] = p.is_you ? 'You' : p.display_name;
    }
  }

  log.innerHTML = '';
  for (const a of actions) {
    const entry = document.createElement('div');
    entry.style.display = 'flex';
    entry.style.justifyContent = 'space-between';
    entry.style.gap = '0.5em';
    const isSpecial = ['meld', 'contract_met', 'buy', 'round_start', 'round_end', 'game_end'].some(t => (a.action_type || '').includes(t));
    if (isSpecial) entry.style.color = '#d4a027';
    if (a.action_type === 'round_start' || a.action_type === 'round_end') entry.style.justifyContent = 'center';

    const text = document.createElement('span');
    text.textContent = formatActionDescription(a, playerMap);
    entry.appendChild(text);

    if (a.action_type !== 'round_start' && a.action_type !== 'round_end') {
      const time = document.createElement('span');
      time.textContent = timeAgo(a.created_at);
      time.style.whiteSpace = 'nowrap';
      time.style.opacity = '0.5';
      time.style.flexShrink = '0';
      entry.appendChild(time);
    }

    log.appendChild(entry);
  }
  log.scrollTop = log.scrollHeight;
}

function toggleGameLog() {
  logOpen = !logOpen;
  document.getElementById('gameLogTray').classList.toggle('open', logOpen);
}

// ── Render Deck / Discard ──
function renderDeckDiscard(round) {
  document.getElementById('deckCount').textContent = `${round.draw_pile_count || 0} left`;

  const discardWrap = document.getElementById('discardWrap');
  const topDiscard = round.top_discard;

  if (topDiscard) {
    const c = parseCard(topDiscard);
    const color = c.red ? 'var(--red)' : '#111';
    document.getElementById('discardTopRank').textContent = c.rank;
    document.getElementById('discardTopRank').style.color = color;
    document.getElementById('discardTopSuit').textContent = c.symbol;
    document.getElementById('discardTopSuit').style.color = color;
    document.getElementById('discardBotRank').textContent = c.rank;
    document.getElementById('discardBotRank').style.color = color;
    document.getElementById('discardFace').style.color = color;
  } else {
    document.getElementById('discardTopRank').textContent = '-';
    document.getElementById('discardTopSuit').textContent = '';
    document.getElementById('discardBotRank').textContent = '-';
  }

  const isMyTurn = myPlayerInfo && round.current_turn_seat === myPlayerInfo.seat_position;
  const turnPlayer = gameState.players.find(p => p.seat_position === round.current_turn_seat);
  const turnName = turnPlayer ? (turnPlayer.is_you ? 'Your' : turnPlayer.display_name + "'s") : '???';
  const connectedCount = gameState.players.filter(p => p.is_connected).length;

  document.getElementById('statusText').textContent = `${turnName} turn \u00B7 ${connectedCount} online`;

  // Green glow on deck when it's your draw phase
  const deckWrap = document.getElementById('deckWrap');
  deckWrap.classList.toggle('draw-active', isMyTurn && round.turn_phase === 'draw');

  const buyBtnWrap = document.getElementById('buyBtnWrap');
  const discardTag = document.getElementById('discardTag');

  if (round.turn_phase === 'buy_window') {
    discardWrap.className = 'discard-wrap countdown-active';
    discardTag.className = 'discard-tag tag-hot';
    discardTag.textContent = 'Buy Window!';
    if (buyRequestSent) {
      buyBtnWrap.style.display = 'flex';
      const buyBtn = document.getElementById('buyBtn');
      buyBtn.classList.add('already-in');
      buyBtn.textContent = 'Cancel Buy';
    } else {
      buyBtnWrap.style.display = 'none';
    }
    renderBuyQueue();
    if (!countdownActive) startBuyCountdown();
  } else if (!isMyTurn && round.turn_phase === 'draw' && topDiscard && !round.discard_bought) {
    if (countdownActive) resetBuyState();
    discardWrap.className = 'discard-wrap buyable';
    discardTag.className = 'discard-tag tag-buy';
    discardTag.textContent = 'Tap to Buy';
    buyBtnWrap.style.display = 'flex';
    const buyBtn = document.getElementById('buyBtn');
    if (buyRequestSent) {
      buyBtn.classList.add('already-in');
      buyBtn.textContent = 'Cancel Buy';
    } else {
      buyBtn.classList.remove('already-in');
      buyBtn.textContent = 'Buy!';
    }
  } else if (isMyTurn && round.turn_phase === 'draw') {
    if (countdownActive) resetBuyState();
    if (round.discard_bought) {
      discardWrap.className = 'discard-wrap';
      discardTag.className = 'discard-tag';
      discardTag.textContent = 'Bought';
    } else {
      discardWrap.className = 'discard-wrap free';
      discardTag.className = 'discard-tag tag-free';
      discardTag.textContent = 'Free Draw';
    }
    buyBtnWrap.style.display = 'none';
  } else {
    discardWrap.className = 'discard-wrap';
    discardTag.textContent = '';
    buyBtnWrap.style.display = 'none';
    if (countdownActive) resetBuyState();
  }
}

// ── Render Hand ──
function sortHand(hand) {
  const cards = [...hand];
  // Always use custom order (new cards land on the right)
  // Set/Run buttons re-sort and update customHandOrder
  const orderMap = new Map(customHandOrder.map((c, i) => [c, i]));
  cards.sort((a, b) => {
    const ia = orderMap.has(a) ? orderMap.get(a) : 9999;
    const ib = orderMap.has(b) ? orderMap.get(b) : 9999;
    return ia - ib;
  });
  return cards;
}

function updateCustomOrder(hand) {
  // keep custom order in sync: preserve existing order, append new cards
  const existing = new Set(hand);
  customHandOrder = customHandOrder.filter(c => existing.has(c));
  const ordered = new Set(customHandOrder);
  for (const c of hand) {
    if (!ordered.has(c)) customHandOrder.push(c);
  }
}

function setHandSort(mode) {
  handSortMode = mode;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(mode === 'set' ? 'sortSet' : mode === 'run' ? 'sortRun' : 'sortCustom').classList.add('active');

  // Set/Run: re-sort customHandOrder, new cards will land at the right after this
  if (mode !== 'custom' && gameState?.my_hand) {
    const cards = [...gameState.my_hand];
    const dir = getSortDir() === 'desc' ? -1 : 1;
    if (mode === 'set') {
      cards.sort((a, b) => {
        const va = cardValue(a), vb = cardValue(b);
        if (va !== vb) return (va - vb) * dir;
        return (cardSuit(a) - cardSuit(b)) * dir;
      });
    } else {
      cards.sort((a, b) => {
        const sa = cardSuit(a), sb = cardSuit(b);
        if (sa !== sb) return (sa - sb) * dir;
        return (cardValue(a) - cardValue(b)) * dir;
      });
    }
    customHandOrder = cards;
  }

  if (gameState?.round) renderHand(gameState.round);
}

function renderHand(round) {
  if (!myPlayerInfo) return;

  const rawHand = gameState.my_hand || [];
  updateCustomOrder(rawHand);
  const hand = sortHand(rawHand);

  const amDealer = gameState.dealer_seat !== undefined && myPlayerInfo.seat_position === gameState.dealer_seat;
  document.getElementById('youName').innerHTML = (amDealer ? '<span class="dealer-btn">D</span> ' : '') + (myPlayerInfo.display_name || 'You');

  const iMetContract = checkMetContract();
  const contractStr = iMetContract
    ? 'Contract: <span class="contract-met">\u2714 Met</span>'
    : 'Contract: <span class="contract-not">\u2718 Not met</span>';

  document.getElementById('youStatus').innerHTML = contractStr;

  document.getElementById('handLabel').textContent = `Your Hand \u00B7 ${hand.length} Cards`;

  const handContainer = document.getElementById('handCards');

  for (const c of [...selectedCards]) {
    if (!hand.includes(c)) selectedCards.delete(c);
  }

  const stagedCards = stagingOpen ? getStagedCardSet() : null;

  // DOM-patch: only add/remove/reorder cards that changed (no innerHTML rebuild)
  const existingEls = new Map();
  handContainer.querySelectorAll('.hc').forEach(el => existingEls.set(el.dataset.card, el));

  const handSet = new Set(hand);

  // Remove cards no longer in hand
  for (const [code, el] of existingEls) {
    if (!handSet.has(code)) { el.remove(); existingEls.delete(code); }
  }

  // Add/reorder cards
  let prevEl = null;
  for (const code of hand) {
    let el = existingEls.get(code);
    if (!el) {
      // Create new card element
      const tmp = document.createElement('div');
      tmp.innerHTML = renderHandCard(code, stagedCards);
      el = tmp.firstChild;
      wireHandCard(el);
    }

    // Update selection and staging state on existing cards
    const isStaged = stagedCards && stagedCards.has(code);
    if (selectedCards.has(code)) { el.classList.add('sel'); } else { el.classList.remove('sel'); }
    el.style.opacity = isStaged ? '0.3' : '';
    el.style.pointerEvents = isStaged ? 'none' : '';

    // Insert in correct position
    const nextSibling = prevEl ? prevEl.nextSibling : handContainer.firstChild;
    if (el !== nextSibling) {
      handContainer.insertBefore(el, nextSibling);
    }
    prevEl = el;
  }
}

function wireHandCard(el) {
  el.addEventListener('click', () => {
    if (el.style.opacity === '0.3') return;
    const card = el.dataset.card;
    if (selectedCards.has(card)) {
      selectedCards.delete(card);
      el.classList.remove('sel');
    } else {
      selectedCards.add(card);
      el.classList.add('sel');
    }
  });

  el.addEventListener('dragstart', (e) => {
    if (el.style.opacity === '0.3') { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', el.dataset.card);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
    document.querySelectorAll('.meld-row.interactive').forEach(r => r.classList.add('drop-target'));
  });

  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const draggedCard = e.dataTransfer.getData('text/plain');
    const targetCard = el.dataset.card;
    if (!draggedCard || draggedCard === targetCard) return;
    if (handSortMode !== 'custom') {
      handSortMode = 'custom';
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('sortCustom').classList.add('active');
    }
    const fromIdx = customHandOrder.indexOf(draggedCard);
    const toIdx = customHandOrder.indexOf(targetCard);
    if (fromIdx === -1 || toIdx === -1) return;
    customHandOrder.splice(fromIdx, 1);
    customHandOrder.splice(toIdx, 0, draggedCard);
    if (gameState?.round) renderHand(gameState.round);
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    document.querySelectorAll('.meld-row').forEach(r => r.classList.remove('drop-target', 'drag-over'));
  });
}

// ── Round End Overlay ──
let roundEndShown = false;
let reRotateInterval = null;

function showRoundEnd() {
  const overlay = document.getElementById('roundEndOverlay');
  if (roundEndShown && overlay.classList.contains('active')) {
    // Already showing — just update deal button state
    updateDealButton();
    return;
  }
  roundEndShown = true;
  overlay.classList.add('active');

  const round = gameState.round;
  const players = gameState.players || [];
  const roundScores = gameState.round_scores || [];
  const currentRoundScores = roundScores.find(r => r.round_number === round.round_number);

  // Find round winner (score = 0)
  let winnerName = 'Unknown';
  if (currentRoundScores) {
    const winnerScore = currentRoundScores.scores.find(s => s.score === 0);
    if (winnerScore) {
      const wp = players.find(p => p.player_id === winnerScore.player_id);
      winnerName = wp ? (wp.is_you ? 'You' : wp.display_name) : 'Unknown';
    }
  }

  document.getElementById('reConfetti').textContent = '\uD83C\uDF89';
  document.getElementById('reTitle').textContent = `Round ${round.round_number} Complete`;
  document.getElementById('reWinner').textContent = winnerName === 'You' ? 'You win!' : `${winnerName} wins!`;
  document.getElementById('reSubtitle').textContent = round.round_number >= 7
    ? 'Final round — game over!' : `Round ${round.round_number} of 7`;

  // View 1: Round scores
  const roundView = document.getElementById('reViewRound');
  if (currentRoundScores) {
    const rows = currentRoundScores.scores.map(s => {
      const p = players.find(pl => pl.player_id === s.player_id);
      const name = p ? (p.is_you ? 'You' : p.display_name) : 'Player';
      const isWinner = s.score === 0;
      const cls = p?.is_you ? ' class="is-you"' : '';
      return `<tr${cls}><td class="name-cell">${name}</td><td class="${isWinner ? 'winner-cell' : ''}">${s.score === 0 ? '\u2605 0' : s.score}</td></tr>`;
    });
    roundView.innerHTML = `<table class="re-scores"><thead><tr><th>Player</th><th>Points</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  // View 2: Total standings
  const standingsView = document.getElementById('reViewStandings');
  const sorted = [...players].sort((a, b) => (a.total_score || 0) - (b.total_score || 0));
  const standingsRows = sorted.map((p, i) => {
    const cls = p.is_you ? ' class="is-you"' : '';
    return `<tr${cls}><td class="name-cell">${i + 1}. ${p.is_you ? 'You' : p.display_name}</td><td class="total-cell">${p.total_score || 0}</td></tr>`;
  });
  standingsView.innerHTML = `<table class="re-scores"><thead><tr><th>Rank</th><th>Total</th></tr></thead><tbody>${standingsRows.join('')}</tbody></table>`;

  // View 3: Full scoreboard
  const scoreboardView = document.getElementById('reViewScoreboard');
  const roundHeaders = roundScores.map(r => `<th>R${r.round_number}</th>`).join('');
  const sbRows = players.map(p => {
    const cls = p.is_you ? ' class="is-you"' : '';
    const name = p.is_you ? 'You' : p.display_name;
    const cells = roundScores.map(r => {
      const ps = r.scores.find(s => s.player_id === p.player_id);
      const score = ps ? ps.score : '-';
      const cellCls = score === 0 ? 'winner-cell' : '';
      return `<td class="${cellCls}">${score === 0 ? '\u2605' : score}</td>`;
    }).join('');
    return `<tr${cls}><td class="name-cell">${name}</td>${cells}<td class="total-cell">${p.total_score || 0}</td></tr>`;
  });
  scoreboardView.innerHTML = `<table class="re-scores"><thead><tr><th></th>${roundHeaders}<th>Total</th></tr></thead><tbody>${sbRows.join('')}</tbody></table>`;

  updateDealButton();

  // Auto-rotate views
  if (reRotateInterval) clearInterval(reRotateInterval);
  const tabs = ['round', 'standings', 'scoreboard'];
  let currentTab = 0;
  reRotateInterval = setInterval(() => {
    currentTab = (currentTab + 1) % tabs.length;
    switchReView(tabs[currentTab]);
  }, 6000);
}

function updateDealButton() {
  const round = gameState.round;
  const dealBtn = document.getElementById('reDealBtn');
  const waitMsg = document.getElementById('reWaitMsg');

  if (round.round_number >= 7) {
    // Game over
    dealBtn.style.display = 'none';
    waitMsg.style.display = 'block';
    waitMsg.textContent = 'Game complete!';
    return;
  }

  const nextDealerSeat = gameState.next_dealer_seat;
  const isDealer = myPlayerInfo && myPlayerInfo.seat_position === nextDealerSeat;
  const dealerPlayer = gameState.players.find(p => p.seat_position === nextDealerSeat);
  const dealerName = dealerPlayer ? dealerPlayer.display_name : 'Player';

  if (isDealer) {
    dealBtn.style.display = '';
    waitMsg.style.display = 'none';
  } else {
    dealBtn.style.display = 'none';
    waitMsg.style.display = 'block';
    waitMsg.textContent = `Waiting for ${dealerName} to deal...`;
  }

  // Show note about approved late joiners
  const joinCount = gameState.approved_join_count || 0;
  let joinNote = document.getElementById('reJoinNote');
  if (joinCount > 0) {
    if (!joinNote) {
      joinNote = document.createElement('div');
      joinNote.id = 'reJoinNote';
      joinNote.style.cssText = 'color:var(--amber);font-size:0.75rem;text-align:center;margin-top:6px;letter-spacing:0.04em;';
      waitMsg.parentElement.appendChild(joinNote);
    }
    joinNote.textContent = `${joinCount} player${joinCount > 1 ? 's' : ''} joining next round`;
    joinNote.style.display = '';
  } else if (joinNote) {
    joinNote.style.display = 'none';
  }
}

function hideRoundEnd() {
  roundEndShown = false;
  document.getElementById('roundEndOverlay').classList.remove('active');
  if (reRotateInterval) { clearInterval(reRotateInterval); reRotateInterval = null; }
}

function switchReView(viewName) {
  document.querySelectorAll('.re-tab').forEach(t => t.classList.toggle('active', t.dataset.reView === viewName));
  document.querySelectorAll('.re-view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('reView' + viewName.charAt(0).toUpperCase() + viewName.slice(1));
  if (target) target.classList.add('active');
}

function renderActionButtons(round) {
  const isMyTurn = myPlayerInfo && round.current_turn_seat === myPlayerInfo.seat_position;
  const phase = round.turn_phase;
  const iMetContract = checkMetContract();

  const drawDeckBtn = document.getElementById('btnDrawDeck');
  const drawDiscardBtn = document.getElementById('btnDrawDiscard');
  const canDrawDeck = isMyTurn && phase === 'draw';
  const canDrawDiscard = isMyTurn && phase === 'draw' && !round.discard_bought;
  drawDeckBtn.disabled = !canDrawDeck;
  drawDiscardBtn.disabled = !canDrawDiscard;
  drawDeckBtn.classList.toggle('draw-ready', canDrawDeck);
  drawDiscardBtn.classList.toggle('draw-ready', canDrawDiscard);
  const btnLayMeld = document.getElementById('btnLayMeld');
  const btnLayOff = document.getElementById('btnLayOff');

  if (iMetContract) {
    // Contract met: hide Meld Contract, show Add to Meld (on your turn only)
    btnLayMeld.style.display = 'none';
    btnLayOff.style.display = '';
    btnLayOff.disabled = !(isMyTurn && (phase === 'action' || phase === 'discard'));
  } else {
    // Contract not met: show Meld Contract (always enabled for staging), hide Add to Meld
    btnLayMeld.style.display = '';
    btnLayMeld.disabled = false;
    btnLayMeld.textContent = 'Meld Contract';
    btnLayOff.style.display = 'none';
  }
  document.getElementById('btnDiscard').disabled = !(isMyTurn && (phase === 'action' || phase === 'discard'));
}

// ── Action Handlers ──
let lastDrawnCard = null;
let lastPenaltyCard = null;

function flyCardToHand(sourceRect, cardCode, isFaceDown, isPenalty) {
  return new Promise(resolve => {
    const handEl = document.getElementById('handCards');
    const hr = handEl.getBoundingClientRect();
    // Get hand card size for target dimensions
    const lastHandCard = handEl.querySelector('.hc:last-child');
    const cardW = lastHandCard ? lastHandCard.getBoundingClientRect().width : sourceRect.width;
    const cardH = lastHandCard ? lastHandCard.getBoundingClientRect().height : sourceRect.height;
    // Fly to right edge of hand, overlapping the buttons panel
    const targetX = hr.right - cardW / 2;
    const targetY = hr.top + hr.height / 2 - cardH / 2;

    const flyEl = document.createElement('div');
    flyEl.className = 'fly-card';
    flyEl.style.width = sourceRect.width + 'px';
    flyEl.style.height = sourceRect.height + 'px';
    flyEl.style.left = sourceRect.left + 'px';
    flyEl.style.top = sourceRect.top + 'px';

    // Start face-down for deck draws, face-up for discard draws
    if (isFaceDown) {
      flyEl.innerHTML = '<img src="assets/card-back.svg?v=0.10.1" style="width:100%;height:100%;border-radius:6px;">';
    } else if (cardCode) {
      const c = parseCard(cardCode);
      const color = c.red ? 'var(--red)' : '#111';
      flyEl.style.background = 'white';
      flyEl.style.display = 'flex';
      flyEl.style.flexDirection = 'column';
      flyEl.style.alignItems = 'center';
      flyEl.style.justifyContent = 'center';
      flyEl.style.color = color;
      flyEl.style.fontWeight = '700';
      flyEl.style.fontSize = '1.2rem';
      flyEl.innerHTML = `<span>${c.rank}</span><span style="font-size:1.5rem;">${c.symbol}</span>`;
    }

    document.body.appendChild(flyEl);

    // Phase 1: fly to right edge of hand, scale to hand card size
    requestAnimationFrame(() => {
      flyEl.style.left = targetX + 'px';
      flyEl.style.top = targetY + 'px';
      flyEl.style.width = cardW + 'px';
      flyEl.style.height = cardH + 'px';
    });

    // After fly completes (1.2s), immediately reveal card face
    setTimeout(() => {
      if (cardCode) {
        const c = parseCard(cardCode);
        const color = c.red ? 'var(--red)' : '#111';
        if (isPenalty) {
          flyEl.style.background = 'linear-gradient(to bottom, rgba(212,80,80,0.15), rgba(212,80,80,0.05)), white';
          flyEl.style.border = '2px solid rgba(212,80,80,0.35)';
        } else {
          flyEl.style.background = 'linear-gradient(to bottom, rgba(212,160,39,0.18), rgba(212,160,39,0.06)), white';
          flyEl.style.border = '2px solid rgba(212,160,39,0.4)';
        }
        flyEl.style.display = 'flex';
        flyEl.style.flexDirection = 'column';
        flyEl.style.alignItems = 'center';
        flyEl.style.justifyContent = 'center';
        flyEl.style.color = color;
        flyEl.style.fontWeight = '700';
        flyEl.style.fontSize = '1.2rem';
        flyEl.innerHTML = `<span>${c.rank}</span><span style="font-size:1.5rem;">${c.symbol}</span>`;
      }

      // Hold the revealed card for 3s, then fade out
      setTimeout(() => {
        flyEl.style.transition = 'opacity 0.5s ease';
        flyEl.style.opacity = '0';
        setTimeout(() => { flyEl.remove(); resolve(); }, 500);
      }, 3000);
    }, 1250);

    // Fallback
    setTimeout(() => { flyEl.remove(); resolve(); }, 5500);
  });
}

function flyCardToMeld(cardCode, targetEl) {
  return new Promise(resolve => {
    // Find the card in hand
    const handCards = document.querySelectorAll('#handCards .hc');
    let sourceEl = null;
    for (const hc of handCards) {
      if (hc.dataset.card === cardCode) { sourceEl = hc; break; }
    }
    if (!sourceEl || !targetEl) { resolve(); return; }

    const sourceRect = sourceEl.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    const c = parseCard(cardCode);
    const color = c.red ? 'var(--red)' : '#111';

    const flyEl = document.createElement('div');
    flyEl.className = 'fly-card';
    flyEl.style.width = sourceRect.width + 'px';
    flyEl.style.height = sourceRect.height + 'px';
    flyEl.style.left = sourceRect.left + 'px';
    flyEl.style.top = sourceRect.top + 'px';
    flyEl.style.background = 'white';
    flyEl.style.display = 'flex';
    flyEl.style.flexDirection = 'column';
    flyEl.style.alignItems = 'center';
    flyEl.style.justifyContent = 'center';
    flyEl.style.color = color;
    flyEl.style.fontWeight = '700';
    flyEl.style.fontSize = '1.2rem';
    flyEl.style.border = '2px solid var(--amber)';
    flyEl.style.boxShadow = '0 0 16px rgba(196,164,105,0.6)';
    flyEl.innerHTML = `<span>${c.rank}</span><span style="font-size:1.5rem;">${c.symbol}</span>`;

    document.body.appendChild(flyEl);

    const targetX = targetRect.left + targetRect.width / 2 - sourceRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2 - sourceRect.height / 2;

    requestAnimationFrame(() => {
      flyEl.style.left = targetX + 'px';
      flyEl.style.top = targetY + 'px';
      flyEl.style.transform = 'scale(0.5)';
      flyEl.style.opacity = '0.7';
    });

    flyEl.addEventListener('transitionend', () => {
      // Gold flash on target meld
      targetEl.style.transition = 'box-shadow 0.3s';
      targetEl.style.boxShadow = '0 0 24px rgba(196,164,105,0.9)';
      setTimeout(() => { targetEl.style.boxShadow = ''; }, 800);
      flyEl.remove();
      resolve();
    }, { once: true });

    setTimeout(() => { flyEl.remove(); resolve(); }, 1400);
  });
}

async function handleDrawDeck() {
  if (!gameState?.round) return;
  const deckEl = document.querySelector('#deckWrap .deck-card-vis:last-child');
  const sourceRect = deckEl ? deckEl.getBoundingClientRect() : null;
  const { data, error } = await rpc('draw_from_deck', { p_round_id: gameState.round.id });
  if (error) {
    showToast('Error', error.message || 'Could not draw from deck');
    return;
  }
  lastDrawnCard = data;
  lastPenaltyCard = null;
  if (sourceRect) {
    animatingDraw = true;
    await flyCardToHand(sourceRect, data, true, false);
    animatingDraw = false;
  }
  await fetchAndRender();
}

async function handleDrawDiscard() {
  if (!gameState?.round) return;
  const discardEl = document.getElementById('discardFace');
  const sourceRect = discardEl ? discardEl.getBoundingClientRect() : null;
  const { data, error } = await rpc('draw_from_discard', { p_round_id: gameState.round.id });
  if (error) {
    showToast('Error', error.message || 'Could not draw from discard');
    return;
  }
  lastDrawnCard = data;
  lastPenaltyCard = null;
  if (sourceRect) {
    animatingDraw = true;
    await flyCardToHand(sourceRect, data, false, false);
    animatingDraw = false;
  }
  await fetchAndRender();
}

function handleLayMeld() {
  if (!gameState?.round) return;
  openMeldStaging();
}

function openMeldStaging() {
  stagingOpen = true;
  selectedCards.clear();

  const round = gameState.round;
  const rn = round.round_number || 1;
  document.getElementById('stagingContract').textContent = `Need: ${CONTRACT_DESCRIPTIONS[rn] || ''}`;

  // Build placeholder slots based on contract
  stagedMelds = [];
  for (let i = 0; i < (round.contract_sets || 0); i++) {
    stagedMelds.push({ cards: [], meld_type: 'set' });
  }
  for (let i = 0; i < (round.contract_runs || 0); i++) {
    stagedMelds.push({ cards: [], meld_type: 'run' });
  }

  document.getElementById('meldStaging').classList.add('active');
  document.getElementById('gameBoard').classList.add('staging-open');
  renderStagedMelds();
  render();
}

function closeMeldStaging() {
  stagingOpen = false;
  stagedMelds = [];
  document.getElementById('meldStaging').classList.remove('active');
  document.getElementById('gameBoard').classList.remove('staging-open');
  selectedCards.clear();
  render();
}

function getStagedCardSet() {
  const used = new Set();
  for (const m of stagedMelds) {
    for (const c of m.cards) used.add(c);
  }
  return used;
}

function getContractRequirements() {
  const round = gameState.round;
  return { sets: round.contract_sets || 0, runs: round.contract_runs || 0 };
}

function addCardsToSlot(slotIndex) {
  const cards = [...selectedCards];
  if (cards.length === 0) {
    showToast('Select Cards', 'Select cards from your hand first');
    return;
  }

  const used = getStagedCardSet();
  for (const c of cards) {
    if (used.has(c)) {
      showToast('Already Staged', 'Card is already in another meld');
      return;
    }
  }

  stagedMelds[slotIndex].cards = stagedMelds[slotIndex].cards.concat(cards);
  sortSlotCards(slotIndex);
  selectedCards.clear();
  renderStagedMelds();
  render();
}

function getSortDir() {
  return localStorage.getItem('play27-sortDir') || 'asc';
}

function sortCards(cards) {
  const dir = getSortDir() === 'desc' ? -1 : 1;
  return [...cards].sort((a, b) => {
    const sa = cardSuit(a), sb = cardSuit(b);
    if (sa !== sb) return (sa - sb) * dir;
    return (cardValue(a) - cardValue(b)) * dir;
  });
}

function sortSlotCards(index) {
  stagedMelds[index].cards = sortCards(stagedMelds[index].cards);
}

function removeCardFromSlot(slotIndex, cardCode) {
  const idx = stagedMelds[slotIndex].cards.indexOf(cardCode);
  if (idx !== -1) stagedMelds[slotIndex].cards.splice(idx, 1);
  renderStagedMelds();
  render();
}

function clearSlot(index) {
  stagedMelds[index].cards = [];
  renderStagedMelds();
  render();
}

function validateSlot(slot) {
  if (slot.cards.length < 3) return { valid: false, msg: slot.cards.length === 0 ? '' : `need ${3 - slot.cards.length} more` };
  if (slot.cards.length > 3) return { valid: false, msg: `too many (${slot.cards.length}/3)` };
  if (slot.meld_type === 'set') {
    const values = slot.cards.filter(c => !isJoker(c)).map(c => cardValue(c));
    const uniqueVals = new Set(values);
    if (uniqueVals.size > 1) return { valid: false, msg: 'mixed values' };
    return { valid: true, msg: 'valid' };
  } else {
    const nonJokers = slot.cards.filter(c => !isJoker(c));
    const suits = nonJokers.map(c => cardSuit(c));
    const uniqueSuits = new Set(suits);
    if (uniqueSuits.size > 1) return { valid: false, msg: 'mixed suits' };
    // Check consecutive sequence (jokers fill gaps)
    const vals = nonJokers.map(c => cardValue(c)).sort((a, b) => a - b);
    const jokerCount = slot.cards.length - nonJokers.length;
    let gaps = 0;
    for (let i = 1; i < vals.length; i++) {
      const diff = vals[i] - vals[i - 1];
      if (diff === 0) return { valid: false, msg: 'duplicate values' };
      if (diff > 1) gaps += diff - 1;
    }
    if (gaps > jokerCount) return { valid: false, msg: 'not in sequence' };
    return { valid: true, msg: 'valid' };
  }
}

function renderStagedMelds() {
  const container = document.getElementById('stagedMelds');
  const req = getContractRequirements();

  // Auto-sort all slots before rendering
  stagedMelds.forEach((s, idx) => { if (s.cards.length > 0) sortSlotCards(idx); });

  let setNum = 0, runNum = 0;
  container.innerHTML = stagedMelds.map((slot, i) => {
    const label = slot.meld_type === 'set' ? `Set ${++setNum}` : `Run ${++runNum}`;
    const hasCards = slot.cards.length > 0;
    const { valid, msg } = hasCards ? validateSlot(slot) : { valid: false, msg: '' };
    const statusHtml = msg ? `<span class="status ${valid ? 'ok' : 'bad'}">${msg}</span>` : '';
    const validClass = !hasCards ? '' : (valid ? ' valid' : ' invalid');

    const minCards = 3;
    const renderedCards = slot.cards.map(c => {
      const p = parseCard(c);
      return `<div class="mc${p.red ? ' r' : ''} removable" data-slot="${i}" data-card="${c}" title="Click to remove"><span class="s">${p.rank}</span><span>${p.symbol}</span></div>`;
    }).join('');
    const remaining = Math.max(0, minCards - slot.cards.length);
    const placeholders = Array(remaining).fill('<div class="staged-meld-placeholder"></div>').join('');
    const cardsHtml = renderedCards + placeholders;

    const clearBtn = hasCards ? `<div class="staged-meld-clear" data-idx="${i}">&times;</div>` : '';

    return `<div class="staged-meld${hasCards ? ' has-cards' : ''}${validClass}" data-slot="${i}">
      <div class="staged-meld-label">
        <span class="type">${label}</span>
        ${statusHtml}
      </div>
      <div class="staged-meld-cards">${cardsHtml}</div>
      ${remaining > 0 ? `<div class="staged-meld-add" data-slot="${i}">+ Add Selected</div>` : ''}
      ${clearBtn}
    </div>`;
  }).join('');

  // Wire up "Add Selected" buttons
  container.querySelectorAll('.staged-meld-add').forEach(btn => {
    btn.addEventListener('click', () => addCardsToSlot(parseInt(btn.dataset.slot)));
  });

  // Wire up clear buttons
  container.querySelectorAll('.staged-meld-clear').forEach(btn => {
    btn.addEventListener('click', () => clearSlot(parseInt(btn.dataset.idx)));
  });

  // Wire up click-to-remove on individual cards
  container.querySelectorAll('.mc.removable').forEach(card => {
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      removeCardFromSlot(parseInt(card.dataset.slot), card.dataset.card);
    });
  });

  // Wire up drag-and-drop on slots
  container.querySelectorAll('.staged-meld').forEach(el => {
    const slotIdx = parseInt(el.dataset.slot);
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const cardId = e.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const used = getStagedCardSet();
      if (used.has(cardId)) {
        showToast('Already Staged', 'Card is already in another meld');
        return;
      }
      stagedMelds[slotIdx].cards.push(cardId);
      selectedCards.delete(cardId);
      renderStagedMelds();
      render();
    });
  });

  // Update hint and submit button
  const filledSlots = stagedMelds.filter(s => s.cards.length >= 3);
  const allValid = filledSlots.length === stagedMelds.length && stagedMelds.every(s => validateSlot(s).valid);
  const hint = document.getElementById('stagingHint');
  const submitBtn = document.getElementById('btnSubmitContract');

  // Check if it's actually your turn in action phase
  const canSubmitNow = gameState?.round
    && myPlayerInfo
    && gameState.round.current_turn_seat === myPlayerInfo.seat_position
    && gameState.round.turn_phase === 'action';

  if (allValid && filledSlots.length === stagedMelds.length) {
    if (canSubmitNow) {
      hint.textContent = 'Contract ready! Hit Submit.';
      hint.style.color = '#3cb96a';
      submitBtn.disabled = false;
    } else {
      hint.textContent = 'Contract ready — submit on your turn';
      hint.style.color = 'var(--amber)';
      submitBtn.disabled = true;
    }
  } else {
    const emptySlots = stagedMelds.filter(s => s.cards.length === 0).length;
    const invalidDetails = [];
    let setNum2 = 0, runNum2 = 0;
    stagedMelds.forEach(s => {
      const lbl = s.meld_type === 'set' ? `Set ${++setNum2}` : `Run ${++runNum2}`;
      if (s.cards.length > 0) {
        const res = validateSlot(s);
        if (!res.valid && res.msg) invalidDetails.push(`${lbl}: ${res.msg}`);
      }
    });
    if (invalidDetails.length > 0) {
      hint.textContent = invalidDetails.join(' · ');
      hint.style.color = '#d45f5f';
    } else if (emptySlots > 0) {
      hint.textContent = `Fill ${emptySlots} more slot${emptySlots > 1 ? 's' : ''} — select cards then tap + Add`;
      hint.style.color = 'rgba(245,240,232,0.4)';
    } else {
      const needMore = stagedMelds.filter(s => s.cards.length > 0 && s.cards.length < 3);
      hint.textContent = `Need ${needMore.length} slot${needMore.length > 1 ? 's' : ''} with more cards`;
      hint.style.color = 'rgba(245,240,232,0.4)';
    }
    submitBtn.disabled = true;
  }
}

async function handleSubmitContract() {
  if (!gameState?.round || stagedMelds.length === 0) return;

  const meldsPayload = stagedMelds.map(m => ({
    cards: m.cards,
    meld_type: m.meld_type
  }));

  const { error } = await rpc('fulfill_contract', {
    p_round_id: gameState.round.id,
    p_melds: meldsPayload
  });

  if (error) {
    showToast('Error', error.message || 'Could not fulfill contract');
    return;
  }

  // Animate staged cards flying to meld area
  const myMeldsEl = document.getElementById('myMeldsArea');
  if (myMeldsEl) {
    const allCards = stagedMelds.flatMap(s => s.cards);
    allCards.forEach(c => recentMeldCards.add(c));
    const stagedEls = document.querySelectorAll('.staged-meld');
    const animations = [];
    for (const slotEl of stagedEls) {
      for (const card of allCards) {
        animations.push(flyCardToMeld(card, myMeldsEl));
        break; // one animation per slot to avoid overload
      }
    }
    await Promise.all(animations);
  }

  showToast('Contract Met!', 'Your meld has been laid down');
  closeMeldStaging();
  await fetchAndRender();
}

async function handleLayOff() {
  const cards = [...selectedCards];
  if (cards.length !== 1) {
    showToast('Select One Card', 'Select exactly 1 card to add');
    return;
  }
  layOffMode = true;
  showToast('Add to Meld', 'Now tap a meld to add your card to');
}

function wireMeldDropTargets(container) {
  container.querySelectorAll('.meld-row.interactive').forEach(row => {
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });

    row.addEventListener('dragleave', () => {
      row.classList.remove('drag-over');
    });

    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const card = e.dataTransfer.getData('text/plain');
      if (!card || !gameState?.round) return;

      const { error } = await rpc('lay_off_card', {
        p_round_id: gameState.round.id,
        p_meld_id: row.dataset.meldId,
        p_card: card
      });

      if (error) {
        showToast('Invalid', error.message || 'Card does not fit this meld');
        return;
      }

      recentMeldCards.add(card);
      await flyCardToMeld(card, row);
      selectedCards.delete(card);
      layOffMode = false;
      await fetchAndRender();
    });
  });
}

async function handleMeldClick(meldId) {
  if (!layOffMode) {
    if (selectedCards.size === 1) {
      showToast('Add to Meld', 'Press "Add to Meld" first, then tap the meld');
    } else if (selectedCards.size === 0) {
      showToast('Add to Meld', 'Select a card first, then press "Add to Meld"');
    } else {
      showToast('Add to Meld', 'Select exactly 1 card, then press "Add to Meld"');
    }
    return;
  }

  if (selectedCards.size !== 1) {
    showToast('Select One Card', 'Select exactly 1 card to add');
    layOffMode = false;
    return;
  }

  const card = [...selectedCards][0];
  const meldEl = document.querySelector(`.meld-row[data-meld-id="${meldId}"]`);

  const { error } = await rpc('lay_off_card', {
    p_round_id: gameState.round.id,
    p_meld_id: meldId,
    p_card: card
  });

  layOffMode = false;
  if (error) {
    showToast('Invalid', error.message || 'Card does not fit this meld');
    return;
  }

  recentMeldCards.add(card);
  if (meldEl) await flyCardToMeld(card, meldEl);
  selectedCards.clear();
  await fetchAndRender();
}

async function handleDiscard() {
  lastDrawnCard = null;
  lastPenaltyCard = null;
  recentMeldCards.clear();
  if (!gameState?.round) return;
  const cards = [...selectedCards];
  if (cards.length !== 1) {
    showToast('Select One Card', 'Select exactly 1 card to discard');
    return;
  }

  const { error } = await rpc('discard_card', {
    p_round_id: gameState.round.id,
    p_card: cards[0]
  });

  if (error) {
    showToast('Error', error.message || 'Could not discard');
    return;
  }

  selectedCards.clear();
  buyRequestSent = false;
  await fetchAndRender();
}

async function handleBuy() {
  if (!gameState?.round) return;
  const buyBtn = document.getElementById('buyBtn');

  if (buyRequestSent) {
    // Cancel the buy request
    const { error } = await rpc('cancel_buy', { p_round_id: gameState.round.id });
    if (error) {
      showToast('Error', error.message || 'Could not cancel buy');
      return;
    }
    buyRequestSent = false;
    buyBtn.classList.remove('already-in');
    buyBtn.textContent = 'Buy!';
    return;
  }

  buyRequestSent = true;
  buyBtn.classList.add('already-in');
  buyBtn.textContent = 'Cancel Buy';

  const { error } = await rpc('request_buy', { p_round_id: gameState.round.id });
  if (error) {
    buyRequestSent = false;
    buyBtn.classList.remove('already-in');
    buyBtn.textContent = 'Buy!';
    showToast('Error', error.message || 'Could not request buy');
  }
}

async function handleStartGame() {
  const { error } = await rpc('start_game', { p_game_id: gameId });
  if (error) {
    showToast('Error', error.message || 'Could not start game');
  }
}

// ── Buy Countdown ──
function startBuyCountdown() {
  countdownActive = true;
  countdownVal = countdownDuration;
  document.getElementById('buyCountdown').classList.add('active');
  document.getElementById('statusLine').style.display = 'none';
  updateTimer();

  countdownInterval = setInterval(() => {
    countdownVal -= 0.25;
    if (countdownVal <= 0) {
      countdownVal = 0;
      clearInterval(countdownInterval);
      resolveBuyCountdown();
    }
    updateTimer();
  }, 250);
}

function updateTimer() {
  const display = Math.ceil(countdownVal);
  const el = document.getElementById('bcdTime');
  el.textContent = display;
  const pct = countdownVal / countdownDuration;
  el.style.color = pct > 0.5 ? 'var(--buy-color)' : 'var(--buy-hot)';
  const ring = document.getElementById('ringFill');
  const offset = CIRCUMFERENCE * (1 - (countdownVal / countdownDuration));
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = pct > 0.5 ? 'var(--buy-color)' : 'var(--buy-hot)';
}

async function resolveBuyCountdown() {
  try {
    await rpc('resolve_buy', { p_round_id: gameState.round.id });
  } catch (e) {
    console.error('resolve_buy error:', e);
  }
  resetBuyState();
  await fetchAndRender();
}

async function renderBuyQueue() {
  const queueEl = document.getElementById('bcdQueueList');
  if (!gameState?.round) { queueEl.innerHTML = ''; return; }

  const { data: requests } = await sb.from('buy_requests')
    .select('player_id, seat_position')
    .eq('round_id', gameState.round.id);

  if (!requests || requests.length === 0) {
    queueEl.innerHTML = '<div style="font-size:0.55rem;color:var(--muted);opacity:0.4;text-align:center;padding:2px;">No buyers yet</div>';
    return;
  }

  const currentSeat = gameState.round.current_turn_seat;
  const playerCount = gameState.players.length;

  // Sort by proximity to current turn seat (closest wins)
  const sorted = [...requests].sort((a, b) => {
    const distA = (a.seat_position - currentSeat + playerCount) % playerCount;
    const distB = (b.seat_position - currentSeat + playerCount) % playerCount;
    return distA - distB;
  });

  queueEl.innerHTML = sorted.map((req, i) => {
    const player = gameState.players.find(p => p.player_id === req.player_id);
    const name = player ? (player.is_you ? 'You' : player.display_name) : 'Player';
    const isWinner = i === 0;
    const cls = isWinner ? 'bcd-queue-row winner' : 'bcd-queue-row';
    const badge = isWinner ? '<span style="color:var(--amber);">&#9733;</span> ' : `${i + 1}. `;
    return `<div class="${cls}">${badge}${name}</div>`;
  }).join('');
}

function resetBuyState() {
  countdownActive = false;
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = null;
  buyRequestSent = false;
  document.getElementById('buyCountdown').classList.remove('active');
  document.getElementById('statusLine').style.display = '';
  const buyBtn = document.getElementById('buyBtn');
  buyBtn.classList.remove('already-in');
  buyBtn.textContent = 'Buy!';
  document.querySelectorAll('.buy-queue-badge').forEach(b => b.classList.remove('visible'));
  document.getElementById('bcdQueueList').innerHTML = '';
}

// ── Toast ──
function showToast(title, sub) {
  const toast = document.getElementById('toast');
  document.getElementById('toastTitle').textContent = title;
  document.getElementById('toastSub').textContent = sub || '';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// ── Spectator Mode ──
function updateSpectatorUI() {
  const banner = document.getElementById('spectatorBanner');
  if (!banner) return;

  if (lateJoinStatus === 'kicked') {
    showToast('Removed', 'The host has removed you from this game.');
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
    return;
  }

  if (lateJoinStatus === 'pending') {
    banner.textContent = 'Waiting for host to approve your request to join\u2026';
  } else if (lateJoinStatus === 'approved') {
    banner.textContent = 'Approved! You will be dealt in at the start of the next round.';
  } else if (lateJoinStatus === 'spectating') {
    banner.textContent = 'You are watching this game as a spectator.';
  } else {
    banner.textContent = 'Spectating';
  }
  banner.style.display = '';
}

// ── Late Join Request Modal (host) ──
function showLateJoinRequestModal(request) {
  if (activeJoinRequestId === request.id) return;
  activeJoinRequestId = request.id;

  document.getElementById('ljPlayerName').textContent = request.display_name;
  document.getElementById('ljScoringOptions').style.display = 'none';
  document.getElementById('lateJoinModal').classList.add('show');
}

async function resolveLateJoin(decision, scoringMethod) {
  const { error } = await rpc('resolve_late_join_request', {
    p_request_id: activeJoinRequestId,
    p_decision: decision,
    p_scoring_method: scoringMethod || null
  });
  if (error) {
    showToast('Error', error.message || 'Could not resolve request');
    return;
  }
  document.getElementById('lateJoinModal').classList.remove('show');
  activeJoinRequestId = null;
}

// ── Wire up event listeners ──
document.getElementById('btnDrawDeck').addEventListener('click', handleDrawDeck);
document.getElementById('btnDrawDiscard').addEventListener('click', handleDrawDiscard);
document.getElementById('btnLayMeld').addEventListener('click', handleLayMeld);
document.getElementById('btnLayOff').addEventListener('click', handleLayOff);
document.getElementById('btnDiscard').addEventListener('click', handleDiscard);
document.getElementById('buyBtn').addEventListener('click', handleBuy);
document.getElementById('btnStartGame').addEventListener('click', handleStartGame);
document.getElementById('btnLeaveGame').addEventListener('click', async () => {
  // Host cancels the waiting game; non-host just leaves
  if (gameId && isHost) {
    await rpc('cancel_game', { p_game_id: gameId });
  }
  window.location.href = 'login.html';
});

// Fullscreen
document.getElementById('btnFullscreen').addEventListener('click', () => {
  document.getElementById('settingsDropdown').classList.remove('open');
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
});
document.addEventListener('fullscreenchange', () => {
  document.getElementById('btnFullscreen').textContent =
    document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
});

// End game
document.getElementById('btnEndGame').addEventListener('click', () => {
  document.getElementById('settingsDropdown').classList.remove('open');
  document.getElementById('endGameModal').classList.add('show');
});
document.getElementById('endGameCancel').addEventListener('click', () => {
  document.getElementById('endGameModal').classList.remove('show');
});
document.getElementById('endGameModal').addEventListener('click', function(e) {
  if (e.target === this) this.classList.remove('show');
});
document.getElementById('endGameConfirm').addEventListener('click', async () => {
  const btn = document.getElementById('endGameConfirm');
  btn.disabled = true;
  btn.textContent = 'Ending...';
  const { error } = await rpc('end_game_request', { p_game_id: gameId });
  if (error) {
    showToast('Error', error.message || 'Could not end game');
    btn.disabled = false;
    btn.textContent = 'End Game';
    document.getElementById('endGameModal').classList.remove('show');
  } else {
    window.location.href = 'login.html';
  }
});

// Late join modal
document.getElementById('ljApproveBtn').addEventListener('click', () => {
  document.getElementById('ljScoringOptions').style.display = '';
});
document.getElementById('ljScoreAvg').addEventListener('click', () => resolveLateJoin('approved', 'average'));
document.getElementById('ljScoreMax').addEventListener('click', () => resolveLateJoin('approved', 'max'));
document.getElementById('ljScoreMaxAvg').addEventListener('click', () => resolveLateJoin('approved', 'max_plus_avg'));
document.getElementById('ljSpectateBtn').addEventListener('click', () => resolveLateJoin('spectating', null));
document.getElementById('ljKickBtn').addEventListener('click', () => resolveLateJoin('kicked', null));
document.getElementById('lateJoinModal').addEventListener('click', function(e) {
  if (e.target === this) {
    this.classList.remove('show');
    activeJoinRequestId = null;
  }
});

// Hand sort
document.getElementById('sortCustom').addEventListener('click', () => setHandSort('custom'));
document.getElementById('sortSet').addEventListener('click', () => setHandSort('set'));
document.getElementById('sortRun').addEventListener('click', () => setHandSort('run'));

// Meld staging
// Slot-based staging — add/clear wired in renderStagedMelds()

// Round-end tabs
document.querySelectorAll('.re-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (reRotateInterval) { clearInterval(reRotateInterval); reRotateInterval = null; }
    switchReView(tab.dataset.reView);
  });
});

// Deal next round button
document.getElementById('reDealBtn').addEventListener('click', async () => {
  const btn = document.getElementById('reDealBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Dealing...';
  const { error } = await rpc('deal_next_round', { p_game_id: gameId });
  btn.disabled = false;
  btn.textContent = 'Deal Next Round';
  if (error) {
    showToast('Error', error.message || 'Could not deal');
  }
});
document.getElementById('btnCancelStaging').addEventListener('click', closeMeldStaging);
document.getElementById('btnSubmitContract').addEventListener('click', handleSubmitContract);

// Settings dropdown (logo click)
document.getElementById('logoWrap').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('settingsDropdown').classList.toggle('open');
  document.getElementById('roundsDropdown')?.classList.remove('open');
});

// Theme
initTheme('light');

// Card view settings (hand & meld compact modes, sort direction)
function setCardView(setting, value) {
  if (setting === 'sortDir') {
    localStorage.setItem('play27-sortDir', value);
    document.querySelectorAll(`[data-setting="sortDir"]`).forEach(b => b.classList.remove('active'));
    document.querySelector(`[data-setting="sortDir"][data-val="${value}"]`)?.classList.add('active');
    if (typeof render === 'function') render();
    return;
  }
  const cls = setting === 'handView' ? 'compact-hand' : 'compact-melds';
  const target = setting === 'handView'
    ? document.getElementById('handCards')
    : document.querySelector('.table-area');
  if (value === 'compact') {
    target.classList.add(cls);
  } else {
    target.classList.remove(cls);
  }
  document.querySelectorAll(`[data-setting="${setting}"]`).forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-setting="${setting}"][data-val="${value}"]`).classList.add('active');
  localStorage.setItem('play27-' + setting, value);
}

document.querySelectorAll('[data-setting]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCardView(btn.dataset.setting, btn.dataset.val);
  });
});

// Apply saved card view settings
setCardView('handView', localStorage.getItem('play27-handView') || 'default');
setCardView('meldView', localStorage.getItem('play27-meldView') || 'default');
setCardView('sortDir', localStorage.getItem('play27-sortDir') || 'asc');

// Contract pill → rounds dropdown
document.getElementById('contractPill').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('roundsDropdown').classList.toggle('open');
  document.getElementById('settingsDropdown')?.classList.remove('open');
});

// Close dropdowns on outside click
document.addEventListener('click', () => {
  document.getElementById('roundsDropdown')?.classList.remove('open');
  document.getElementById('settingsDropdown')?.classList.remove('open');
});

// Game log toggle
document.getElementById('btnLogToggle').addEventListener('click', toggleGameLog);
document.getElementById('btnLogClose').addEventListener('click', toggleGameLog);

// Click on discard = draw or buy
document.getElementById('discardFace').addEventListener('click', () => {
  if (!gameState?.round) return;
  const isMyTurn = myPlayerInfo && gameState.round.current_turn_seat === myPlayerInfo.seat_position;
  if (isMyTurn && gameState.round.turn_phase === 'draw' && !gameState.round.discard_bought) handleDrawDiscard();
  else if (!isMyTurn && gameState.round.turn_phase === 'draw' && !gameState.round.discard_bought) handleBuy();
});

// Click deck = draw from deck
document.getElementById('deckWrap').addEventListener('click', () => {
  if (!gameState?.round) return;
  const isMyTurn = myPlayerInfo && gameState.round.current_turn_seat === myPlayerInfo.seat_position;
  if (isMyTurn && gameState.round.turn_phase === 'draw') handleDrawDeck();
});

// Drag-drop onto discard
const discardDropTarget = document.getElementById('discardWrap');
discardDropTarget.addEventListener('dragover', (e) => {
  if (!gameState?.round) return;
  const isMyTurn = myPlayerInfo && gameState.round.current_turn_seat === myPlayerInfo.seat_position;
  if (isMyTurn && gameState.round.turn_phase === 'action') {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    discardDropTarget.classList.add('drag-over');
  }
});

discardDropTarget.addEventListener('dragleave', () => {
  discardDropTarget.classList.remove('drag-over');
});

discardDropTarget.addEventListener('drop', async (e) => {
  e.preventDefault();
  discardDropTarget.classList.remove('drag-over');
  const card = e.dataTransfer.getData('text/plain');
  if (!card || !gameState?.round) return;

  const { error } = await rpc('discard_card', {
    p_round_id: gameState.round.id,
    p_card: card
  });

  if (error) {
    showToast('Error', error.message || 'Could not discard');
    return;
  }

  selectedCards.clear();
  buyRequestSent = false;
  await fetchAndRender();
});

// ── Start ──
init();
