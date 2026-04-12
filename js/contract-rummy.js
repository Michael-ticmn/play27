import { sb, rpc, getTokenFromStorage, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js?v=0.12.0';
import { initTheme } from './theme.js?v=0.12.0';

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
let lastRoundId = null;
let recentMeldCards = new Set(); // cards added to melds this turn, gold highlight
let meldedThisTurn = false;     // true after fulfilling contract — blocks lay-offs until next turn
let isSpectator = false;
let isHost = false;
let lateJoinStatus = null;      // 'pending' | 'approved' | 'spectating' | 'kicked'
let activeJoinRequestId = null;  // for host modal dedup
let lastTurnSeat = null;         // track turn transitions for ding
let dingOnTurn = true;           // default on

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

  // Always call join_game first — it's security definer so bypasses RLS.
  // This handles: new join (waiting), rejoin (active), and late-join request (active).
  const { data: joinData, error: joinErr } = await rpc('join_game', { p_code: gameCode });
  if (joinErr) {
    alert(joinErr.message);
    return;
  }

  // Now we're in game_players (or have a late-join request), so RLS allows the SELECT
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
    await enterGame();
  } else {
    $loading.style.display = 'none';
    showToast('Game Over', 'This game has finished');
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
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
    document.getElementById('aiPicker').style.display = '';
    document.getElementById('aiMatrixToggle').style.display = '';
    setupAiPicker();
    setupAiMatrix();
  }

  await refreshPlayerList();
  setupWaitingSubscriptions(game);
}

async function refreshPlayerList() {
  let { data: players, error } = await sb.from('game_players')
    .select('player_id, seat_position, profiles!game_players_player_id_fkey(display_name, is_ai, ai_name, ai_tier)')
    .eq('game_id', gameId)
    .order('seat_position');

  // Fallback if PostgREST schema cache hasn't picked up new columns yet
  if (error) {
    console.warn('refreshPlayerList fallback:', error.message);
    ({ data: players } = await sb.from('game_players')
      .select('player_id, seat_position, profiles!game_players_player_id_fkey(display_name)')
      .eq('game_id', gameId)
      .order('seat_position'));
  }

  console.log('[refreshPlayerList]', { players, error, gameId });

  const list = document.getElementById('playerList');
  list.innerHTML = '';
  if (!players || players.length === 0) return;

  const { data: game } = await sb.from('games').select('created_by').eq('id', gameId).single();

  const aiNamesInGame = new Set();
  for (const p of players) {
    const li = document.createElement('li');
    const prof = p.profiles || {};
    const name = prof.display_name || 'Player';
    const isHostPlayer = game && p.player_id === game.created_by;
    const isAi = prof.is_ai;

    let html = `<span class="seat-num">#${p.seat_position + 1}</span> ${name}`;
    if (isHostPlayer) html += '<span class="host-tag">Host</span>';
    if (isAi) {
      const tier = prof.ai_tier || 'normal';
      const tierLabel = tier === 'easy' ? 'Easy' : tier === 'normal' ? 'Normal' : tier === 'hard' ? 'Hard' : 'Unfair';
      html += `<span class="ai-badge tier-${tier}">${tierLabel}</span>`;
      aiNamesInGame.add(prof.ai_name);
      if (isHost) {
        html += `<button class="ai-remove" data-ai-id="${p.player_id}" title="Remove AI">&times;</button>`;
      }
    }
    li.innerHTML = html;
    list.appendChild(li);
  }

  // Attach remove handlers
  if (isHost) {
    list.querySelectorAll('.ai-remove').forEach(btn => {
      btn.addEventListener('click', async () => {
        const aiId = btn.dataset.aiId;
        const { error } = await rpc('remove_ai_from_game', { p_game_id: gameId, p_ai_profile_id: aiId });
        if (error) showToast('Error', error.message);
      });
    });
  }

  // Grey out AI names already in game
  const nameSelect = document.getElementById('aiNameSelect');
  if (nameSelect) {
    for (const opt of nameSelect.options) {
      if (opt.value) opt.disabled = aiNamesInGame.has(opt.value);
    }
  }
}

function setupAiMatrix() {
  const btn = document.getElementById('btnAiMatrix');
  const matrix = document.getElementById('aiMatrix');
  if (!btn || !matrix) return;
  btn.addEventListener('click', () => {
    const showing = matrix.style.display !== 'none';
    matrix.style.display = showing ? 'none' : '';
    btn.textContent = showing ? '\u2139 How AI Players Think' : '\u2715 Hide AI Matrix';
  });
}

let aiPickerInitialized = false;
function setupAiPicker() {
  if (aiPickerInitialized) return;
  aiPickerInitialized = true;

  let selectedTier = null;
  const tierBtns = document.querySelectorAll('#aiTierBtns .ai-tier-btn');
  const nameSelect = document.getElementById('aiNameSelect');

  tierBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const tier = btn.dataset.tier;
      const name = nameSelect.value;
      if (!name) { showToast('Select AI', 'Pick a name first'); return; }

      // Visual feedback
      tierBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      const { data, error } = await rpc('add_ai_to_game', {
        p_game_id: gameId,
        p_ai_name: name,
        p_ai_tier: tier
      });
      if (error) {
        showToast('Error', error.message);
      } else {
        showToast('AI Added', `${name} (${tier}) joined`);
        nameSelect.value = '';
      }
      // Deselect tier button after adding
      setTimeout(() => tierBtns.forEach(b => b.classList.remove('selected')), 300);
    });
  });
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
  document.documentElement.classList.add('game-active');

  // Mark connected
  setConnected(true);
  window.addEventListener('beforeunload', () => setConnected(false));
  document.addEventListener('visibilitychange', () => {
    setConnected(!document.hidden);
  });

  await fetchAndRender();
  setupGameSubscriptions();
}

function setConnected(connected) {
  if (!gameId || !myUserId) return;
  console.log('[setConnected]', connected, gameId, myUserId);
  // Use sendBeacon for disconnect (beforeunload can't wait for fetch)
  if (!connected) {
    const url = `${SUPABASE_URL}/rest/v1/game_players?game_id=eq.${gameId}&player_id=eq.${myUserId}`;
    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${getTokenFromStorage()}`,
      'Prefer': 'return=minimal'
    };
    // sendBeacon only supports POST, so use fetch with keepalive
    fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_connected: false }),
      keepalive: true
    }).catch(() => {});
    return;
  }
  sb.from('game_players')
    .update({ is_connected: connected })
    .eq('game_id', gameId)
    .eq('player_id', myUserId)
    .then(({ error }) => { if (error) console.error('[setConnected] error:', error); });
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
  isHost = gameState.created_by === myUserId;
  lateJoinStatus = gameState.my_late_join_status || null;
  myPlayerInfo = gameState.players?.find(p => p.is_you);

  if (isSpectator) {
    console.log('[spectator]', { lateJoinStatus, round: !!gameState.round, players: gameState.players?.length });
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

  // Round changed — reset staging, selections, and sort state
  const curRoundId = gameState.round?.id || null;
  if (lastRoundId && curRoundId && curRoundId !== lastRoundId) {
    if (stagingOpen) closeMeldStaging();
    selectedCards.clear();
    recentMeldCards.clear();
    meldedThisTurn = false;
  }
  lastRoundId = curRoundId;

  // Ding when it becomes the player's turn
  const curSeat = gameState.round?.current_turn_seat ?? null;
  const isMyTurnNow = myPlayerInfo && curSeat === myPlayerInfo.seat_position
    && gameState.round?.turn_phase !== 'ready_check';
  const wasMyTurn = myPlayerInfo && lastTurnSeat === myPlayerInfo.seat_position;
  if (isMyTurnNow && !wasMyTurn && lastTurnSeat !== null && dingOnTurn) {
    playTurnDing();
  }
  lastTurnSeat = curSeat;

  if (showAiHands) fetchAiHands().then(() => render());
  render();
  checkAndTriggerAI();
}

// ── AI Turn Triggering (host client only) ──
let aiTriggerInFlight = false;
let aiPaused = false;
let showAiHands = false;
let aiHandsCache = {}; // { player_id: [card_id, ...] }

window.toggleAiPause = function() {
  aiPaused = !aiPaused;
  const btn = document.getElementById('aiPauseBtn');
  if (btn) btn.textContent = aiPaused ? '▶ Start' : '⏸ Pause';
  // Also update pause button on round-end overlay
  const reBtn = document.getElementById('rePauseBtn');
  if (reBtn) reBtn.textContent = aiPaused ? '▶ Resume AI' : '⏸ Pause AI';
  aiDebug(aiPaused ? 'AI PAUSED' : 'AI RESUMED', aiPaused ? 'err' : 'ok');
  if (aiPaused && aiDealTimer) {
    clearTimeout(aiDealTimer);
    aiDealTimer = null;
    aiDebug('Deal timer cancelled');
  }
  if (!aiPaused) fetchAndRender();
};

window.toggleShowAiHands = async function() {
  showAiHands = !showAiHands;
  const btn = document.getElementById('aiShowHandsBtn');
  if (btn) btn.textContent = showAiHands ? '🂠 Hide' : '👁 Hands';
  if (showAiHands) {
    await fetchAiHands();
  } else {
    aiHandsCache = {};
  }
  render();
};

async function fetchAiHands() {
  if (!gameState?.round) return;
  try {
    const { data, error } = await sb.rpc('peek_ai_hands', { p_round_id: gameState.round.id });
    if (error) { console.error('peek_ai_hands error:', error); return; }
    aiHandsCache = {};
    for (const ai of (data || [])) {
      aiHandsCache[ai.player_id] = ai.hand || [];
    }
  } catch (e) {
    console.error('fetchAiHands failed:', e);
  }
}

function aiDebug(msg, type = '') {
  const log = document.getElementById('aiDebugLog');
  if (!log) return;
  const cls = type === 'ok' ? 'ai-ok' : type === 'err' ? 'ai-err' : 'ai-act';
  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  log.innerHTML = `<span class="${cls}">[${time}] ${msg}</span>`;
  console.log(`[AI Debug] ${msg}`);
}

async function checkAndTriggerAI() {
  if (!isHost) { console.log('[AI] skip: not host'); return; }
  if (!gameState?.round) { console.log('[AI] skip: no round'); return; }
  if (gameState.round.status !== 'active') { console.log('[AI] skip: round status', gameState.round.status); return; }
  if (aiTriggerInFlight) { console.log('[AI] skip: in flight'); return; }
  if (aiPaused) { console.log('[AI] skip: paused'); return; }

  const round = gameState.round;
  const players = gameState.players || [];

  // Check if current turn player is AI (trigger ai-turn)
  const currentPlayer = players.find(p => p.seat_position === round.current_turn_seat);
  console.log('[AI] seat:', round.current_turn_seat, 'phase:', round.turn_phase, 'is_ai:', currentPlayer?.is_ai, 'player:', currentPlayer?.display_name);
  if (currentPlayer?.is_ai && round.turn_phase === 'draw') {
    aiTriggerInFlight = true;
    const name = currentPlayer.display_name;
    aiDebug(`${name} thinking... (seat=${currentPlayer.seat_position} id=…${currentPlayer.player_id.slice(-4)})`);
    const startTime = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const resp = await fetch(`${SUPABASE_URL}/functions/v1/ai-turn`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          round_id: round.id,
          ai_player_id: currentPlayer.player_id
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const result = await resp.json();
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      if (result.error) {
        const detail = result.current_seat !== undefined ? ` [ai_seat=${result.ai_seat} current=${result.current_seat} phase=${result.phase}]` : '';
        aiDebug(`${name} ERROR: ${result.error}${detail} (${elapsed}s)`, 'err');
        aiTriggerInFlight = false;
        // Don't re-fetch on "not this AI's turn" — wait for next realtime event
        return;
      } else {
        aiDebug(`${name} ${result.action || result.status} (${elapsed}s)`, 'ok');
      }
    } catch (e) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      aiDebug(`${name} FAILED: ${e.name === 'AbortError' ? 'TIMEOUT 30s' : e.message} (${elapsed}s)`, 'err');
    }
    aiTriggerInFlight = false;
    // Re-fetch after successful AI turn — picks up advanced turn and re-triggers next AI
    await fetchAndRender();
    return;
  }

  // Check for AI players who should evaluate buy during buy_window only
  if (round.turn_phase === 'buy_window') {
    const aiNonActive = players.filter(
      p => p.is_ai && p.seat_position !== round.current_turn_seat
    );
    for (const ai of aiNonActive) {
      aiDebug(`${ai.display_name} evaluating buy...`);
      fetch(`${SUPABASE_URL}/functions/v1/ai-buy`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          round_id: round.id,
          ai_player_id: ai.player_id,
          countdown_seconds: gameState.buy_countdown_seconds
        })
      }).then(r => r.json()).then(result => {
        if (result.error) aiDebug(`${ai.display_name} buy error: ${result.error}`, 'err');
        else aiDebug(`${ai.display_name} buy: ${result.status}`, result.status === 'buy_requested' ? 'ok' : '');
      }).catch(e => aiDebug(`${ai.display_name} buy failed: ${e.message}`, 'err'));
    }
  }
}

// Also trigger AI for deal_next_round when dealer is AI
let aiDealTimer = null;

async function checkAiDealer() {
  if (!isHost || !gameState?.round || gameState.round.status !== 'finished') return;
  if (gameState.round.round_number >= 7) return; // game over
  if (aiPaused) { aiDebug('AI paused — deal on hold'); return; }
  if (aiDealTimer) return; // already scheduled

  const nextRound = gameState.round.round_number + 1;
  const playerCount = (gameState.players || []).length;
  const dealerSeat = (nextRound - 1) % playerCount;
  const dealer = (gameState.players || []).find(p => p.seat_position === dealerSeat);

  if (dealer?.is_ai) {
    // AI dealer — wait 10s so humans can review the round results
    aiDebug(`${dealer.display_name} dealing next round in 10s...`);
    aiDealTimer = setTimeout(async () => {
      aiDealTimer = null;
      if (aiPaused) { aiDebug('AI paused — deal cancelled'); return; }
      try {
        await rpc('deal_next_round', { p_game_id: gameId, p_acting_as: dealer.player_id });
        aiDebug(`${dealer.display_name} dealt round ${nextRound}`, 'ok');
      } catch (e) {
        console.error('[AI deal error]', e);
      }
    }, 10000);
  }
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
      event: 'UPDATE', schema: 'public', table: 'game_players'
    }, () => { if (!animatingDraw) fetchAndRender(); })
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'player_round_state'
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
        // Turn ended — clear highlights and same-turn flags
        recentMeldCards.clear();
        meldedThisTurn = false;
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
    const round = gameState.round;
    // Natural finish (round 7 complete) — show scoreboard with lobby button
    if (round && round.round_number >= 7 && round.status === 'finished') {
      showRoundEnd();
      return;
    }
    // Host ended game early — redirect to lobby
    showToast('Game Over', 'The host ended the game');
    setTimeout(() => { window.location.href = 'login.html'; }, 2000);
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

  // Spectator: show board in read-only mode (all players shown as opponents)
  if (isSpectator) {
    try {
      renderSeats(round);
      renderDeckDiscard(round);
    } catch (e) {
      console.error('[spectator render]', e);
    }
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
  // Assign ranks with ties (same total score = same rank)
  const ranks = [];
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0) {
      const tied = (sorted[i].total_score || 0) === (sorted[i - 1].total_score || 0);
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
// Positions opponents at the angular center of their equal slice of the 270°
// arc (matching the table-line dividers). User owns 90° (1/4) at the bottom.
function getSeatPositions(count) {
  if (count === 1) return [{ left: 50, top: 5 }];
  const positions = [];
  const rightBound = 135; // user zone edge: 90° + 45°
  const sliceSize = 270 / count;
  const cx = 50, cy = 38; // center of the opponent arc (% coords)
  const rx = 44, ry = 34; // ellipse radii
  for (let i = 0; i < count; i++) {
    const angleDeg = rightBound + sliceSize * (i + 0.5); // center of slice
    const angleRad = (angleDeg * Math.PI) / 180;
    const left = Math.round(cx + rx * Math.cos(angleRad));
    const top  = Math.round(cy + ry * Math.sin(angleRad));
    positions.push({ left: Math.max(4, Math.min(96, left)), top: Math.max(1, top) });
  }
  return positions;
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

  // Center box around draw/discard — size to actual table-center element
  const tcEl = document.querySelector('.table-center');
  const tcRect = tcEl ? tcEl.getBoundingClientRect() : null;
  const tableRect = table.getBoundingClientRect();
  const boxW = tcRect ? Math.min(tcRect.width + 16, w * 0.85) : Math.min(w * 0.4, 340);
  const boxH = tcRect ? Math.min(tcRect.height + 12, h * 0.5) : Math.min(h * 0.35, 160);
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
    // 3+ players: user keeps 90° (1/4) at the bottom, opponents split the remaining 270°
    // Screen coords: Y increases downward, so 90° = bottom, 270° = top
    const userCenter = 90;
    const leftBound = 45;    // userCenter - 45
    const rightBound = 135;  // userCenter + 45

    // User's two boundary lines
    for (const angleDeg of [leftBound, rightBound]) {
      const angleRad = (angleDeg * Math.PI) / 180;
      const cos = Math.cos(angleRad);
      const sin = Math.sin(angleRad);
      const startX = cx + (boxW / 2 + 4) * cos;
      const startY = cy + (boxH / 2 + 4) * sin;
      const reach = Math.max(w, h);
      addLine(startX, startY, Math.max(0, Math.min(w, cx + reach * cos)), Math.max(0, Math.min(h, cy + reach * sin)));
    }

    // Opponents split the remaining 270°
    if (oppCount > 1) {
      for (let i = 1; i < oppCount; i++) {
        const angleDeg = (rightBound + i * (270 / oppCount)) % 360;
        const angleRad = (angleDeg * Math.PI) / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        const startX = cx + (boxW / 2 + 4) * cos;
        const startY = cy + (boxH / 2 + 4) * sin;
        const reach = Math.max(w, h);
        addLine(startX, startY, Math.max(0, Math.min(w, cx + reach * cos)), Math.max(0, Math.min(h, cy + reach * sin)));
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
  const totalPlayers = isSpectator ? opponents.length : opponents.length + 1;
  const positions = getSeatPositions(opponents.length);

  // Draw table divider lines
  renderTableLines(totalPlayers);

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

    // Card backs or revealed hand
    const isAiPeek = opp.is_ai && showAiHands && aiHandsCache[opp.player_id];
    let cardBacks = '';
    if (isAiPeek) {
      const hand = sortCards(aiHandsCache[opp.player_id]);
      cardBacks = hand.map(c => renderMiniCard(c)).join('');
    } else {
      for (let j = 0; j < Math.min(cardsInHand, 14); j++) {
        cardBacks += '<div class="opp-card-back"><img src="assets/card-back.svg?v=0.10.1"></div>';
      }
    }

    // Melds HTML
    let meldsHtml = '';
    for (const meld of oppMelds) {
      const interClass = iMetContract ? 'interactive' : 'locked';
      const sorted = meld.meld_type === 'run' ? sortMeldCards(meld.cards || []) : sortCards(meld.cards || []);
      const cards = sorted.map(c => renderMiniCard(c)).join('');
      meldsHtml += `<div class="meld-row ${interClass}" data-meld-id="${meld.id}" title="Add to this ${meld.meld_type}">${cards}</div>`;
    }
    if (oppMelds.length === 0) {
      meldsHtml = '<div class="meld-row empty"><span>no melds</span></div>';
    }

    const isDealer = opp.seat_position === gameState.dealer_seat;
    const isOffline = !opp.is_connected;
    const isAi = opp.is_ai;
    const aiTier = opp.ai_tier || '';
    const isThinking = isAi && round && round.current_turn_seat === opp.seat_position;
    const oppReady = oppDetail.is_ready || false;
    const inReadyCheck = round.turn_phase === 'ready_check';
    if (isOffline && !isAi) seat.className += ' offline';
    let metaText = `${cardsInHand} cards${hasMetContract ? ' \u2714' : ''}`;
    if (inReadyCheck) {
      metaText = oppReady ? '\u2714 ready' : 'sorting...';
    }
    seat.innerHTML = `
      <div class="seat-turn-label">\u25B6 Playing</div>
      <div class="seat-name-row">
        ${isDealer ? '<span class="dealer-btn">D</span>' : ''}${isAi ? `<span class="ai-tier-dot tier-${aiTier}"></span>` : ''}<span class="seat-name">${opp.display_name}</span>${isAi ? '' : (isOffline ? '<span class="offline-tag">away</span>' : '')}${isThinking ? '<span class="ai-thinking"></span>' : ''}
        <span class="seat-score">${opp.total_score || 0}</span>
      </div>
      <div class="seat-meta">
        <span>${metaText}</span>
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
      const sorted = meld.meld_type === 'run' ? sortMeldCards(meld.cards || []) : sortCards(meld.cards || []);
      const cards = sorted.map(c => renderMiniCard(c)).join('');
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
  log.scrollTop = 0;
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

  let statusStr;
  if (round.turn_phase === 'ready_check') {
    const rc = round.ready_count || 0;
    const tp = round.total_players || 0;
    statusStr = `Sort your hand \u00B7 ${rc}/${tp} ready`;
  } else {
    statusStr = `${turnName} turn \u00B7 ${connectedCount} online`;
  }
  const spectators = gameState.spectators || [];
  if (spectators.length > 0) {
    const joining = spectators.filter(s => s.status === 'approved');
    const watching = spectators.filter(s => s.status !== 'approved');
    if (joining.length) statusStr += ` \u00B7 ${joining.map(s => s.display_name).join(', ')} joining`;
    if (watching.length) statusStr += ` \u00B7 ${watching.map(s => s.display_name).join(', ')} watching`;
  }
  document.getElementById('statusText').textContent = statusStr;

  // Green glow on deck when it's your draw phase
  const deckWrap = document.getElementById('deckWrap');
  deckWrap.classList.toggle('draw-active', isMyTurn && round.turn_phase === 'draw');

  const buyBtnWrap = document.getElementById('buyBtnWrap');
  const discardTag = document.getElementById('discardTag');

  // Spectators see the board but no interactive buy/draw controls
  if (isSpectator) {
    discardWrap.className = 'discard-wrap';
    discardTag.textContent = '';
    buyBtnWrap.style.display = 'none';
    return;
  }

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
        return (SUIT_SORT[cardSuit(a)] - SUIT_SORT[cardSuit(b)]) * dir;
      });
    } else {
      cards.sort((a, b) => {
        const sa = SUIT_SORT[cardSuit(a)], sb = SUIT_SORT[cardSuit(b)];
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
    ? '<span class="contract-met">\u2714 Contract Met</span>'
    : '<span class="contract-not">\u2718 Not Met</span>';

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
      el.style.zIndex = '';
    } else {
      selectedCards.add(card);
      el.classList.add('sel');
      el.style.zIndex = '999';
    }
    // Re-apply z-index to all cards: selected cards on top, others reset
    el.parentElement?.querySelectorAll('.hc').forEach(c => {
      if (!c.classList.contains('sel')) c.style.zIndex = '';
    });
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

  // ── Compute projected penalty scores for approved spectators ──
  const spectators = (gameState.spectators || []).filter(s => s.status === 'approved' && s.scoring_method);
  function calcPenalty(method, scores) {
    if (!scores || scores.length === 0) return 0;
    const vals = scores.map(s => s.score).filter(v => v != null);
    if (vals.length === 0) return 0;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const max = Math.max(...vals);
    if (method === 'max') return max;
    if (method === 'max_plus_avg') return Math.round((max + avg) / 2);
    return Math.round(avg); // 'average' or default
  }
  const specProjections = spectators.map(sp => {
    const perRound = roundScores.map(r => ({
      round_number: r.round_number,
      score: calcPenalty(sp.scoring_method, r.scores)
    }));
    const total = perRound.reduce((sum, r) => sum + r.score, 0);
    const methodLabel = sp.scoring_method === 'max' ? 'worst' : sp.scoring_method === 'max_plus_avg' ? 'mid' : 'avg';
    return { display_name: sp.display_name, scoring_method: sp.scoring_method, methodLabel, perRound, total };
  });

  // View 1: Round scores
  const roundView = document.getElementById('reViewRound');
  if (currentRoundScores) {
    const sortedScores = [...currentRoundScores.scores].sort((a, b) => a.score - b.score);
    const rows = sortedScores.map(s => {
      const p = players.find(pl => pl.player_id === s.player_id);
      const name = p ? (p.is_you ? 'You' : p.display_name) : 'Player';
      const isWinner = s.score === 0;
      const cls = p?.is_you ? ' class="is-you"' : '';
      return `<tr${cls}><td class="name-cell">${name}</td><td class="${isWinner ? 'winner-cell' : ''}">${s.score === 0 ? '\u2605 0' : s.score}</td></tr>`;
    });
    // Add spectator projected scores for this round
    specProjections.forEach(sp => {
      const rScore = sp.perRound.find(r => r.round_number === round.round_number);
      rows.push(`<tr class="spectator-row"><td class="name-cell">${sp.display_name} <span class="joining-tag">joining · ${sp.methodLabel}</span></td><td>${rScore ? rScore.score : '-'}</td></tr>`);
    });
    roundView.innerHTML = `<table class="re-scores"><thead><tr><th>Player</th><th>Points</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  // View 2: Total standings
  const standingsView = document.getElementById('reViewStandings');
  const allForStandings = [
    ...players.map(p => ({ name: p.is_you ? 'You' : p.display_name, total: p.total_score || 0, isYou: p.is_you, isSpec: false })),
    ...specProjections.map(sp => ({ name: sp.display_name, total: sp.total, isYou: false, isSpec: true, methodLabel: sp.methodLabel }))
  ].sort((a, b) => a.total - b.total);
  const standingsRows = allForStandings.map((p, i) => {
    const cls = p.isYou ? ' class="is-you"' : p.isSpec ? ' class="spectator-row"' : '';
    const tag = p.isSpec ? ` <span class="joining-tag">joining · ${p.methodLabel}</span>` : '';
    return `<tr${cls}><td class="name-cell">${i + 1}. ${p.name}${tag}</td><td class="total-cell">${p.total}</td></tr>`;
  });
  standingsView.innerHTML = `<table class="re-scores"><thead><tr><th>Rank</th><th>Total</th></tr></thead><tbody>${standingsRows.join('')}</tbody></table>`;

  // View 3: Full scoreboard
  const scoreboardView = document.getElementById('reViewScoreboard');
  const roundHeaders = roundScores.map(r => `<th>R${r.round_number}</th>`).join('');
  const sortedPlayers = [...players].sort((a, b) => (a.total_score || 0) - (b.total_score || 0));
  const sbRows = sortedPlayers.map(p => {
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
  // Add spectator rows to scoreboard
  specProjections.forEach(sp => {
    const cells = sp.perRound.map(r => `<td>${r.score}</td>`).join('');
    sbRows.push(`<tr class="spectator-row"><td class="name-cell">${sp.display_name} <span class="joining-tag">joining · ${sp.methodLabel}</span></td>${cells}<td class="total-cell">${sp.total}</td></tr>`);
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
  const pauseBtn = document.getElementById('rePauseBtn');

  // Show pause button on score view when AI bar is visible
  const aiBarVisible = document.getElementById('aiDebugBar')?.offsetParent !== null;
  const hasAi = (gameState.players || []).some(p => p.is_ai);
  if (pauseBtn) {
    pauseBtn.style.display = (aiBarVisible && hasAi && round.round_number < 7) ? '' : 'none';
    pauseBtn.textContent = aiPaused ? '▶ Resume AI' : '⏸ Pause AI';
  }

  if (round.round_number >= 7) {
    // Game over — show lobby button
    dealBtn.style.display = 'none';
    if (pauseBtn) pauseBtn.style.display = 'none';
    waitMsg.style.display = 'block';
    waitMsg.innerHTML = 'Game complete!<br><a href="login.html" class="re-lobby-btn">Back to Lobby</a>';
    return;
  }

  const nextDealerSeat = gameState.next_dealer_seat;
  const isDealer = myPlayerInfo && myPlayerInfo.seat_position === nextDealerSeat;
  const dealerPlayer = gameState.players.find(p => p.seat_position === nextDealerSeat);
  const dealerName = dealerPlayer ? dealerPlayer.display_name : 'Player';

  if (isDealer) {
    dealBtn.style.display = '';
    waitMsg.style.display = 'none';
  } else if (dealerPlayer?.is_ai) {
    dealBtn.style.display = 'none';
    waitMsg.style.display = 'block';
    waitMsg.textContent = `${dealerName} is dealing...`;
    checkAiDealer();
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

// ── Round data export for play analysis ──
window.exportRoundData = async function() {
  if (!gameState?.round) return;
  const round = gameState.round;
  const roundId = round.id;
  const players = gameState.players || [];

  const exportBtn = document.getElementById('reExportBtn');
  const origText = exportBtn.textContent;
  exportBtn.textContent = '⏳ Loading...';
  exportBtn.disabled = true;

  try {
    // Fetch all cards for this round (hands + melds + discard pile)
    const { data: allCards } = await sb.from('round_cards')
      .select('card_id, location, player_id, meld_id, position')
      .eq('round_id', roundId)
      .order('position');

    // Fetch all melds for this round
    const { data: allMelds } = await sb.from('melds')
      .select('id, player_id, meld_type')
      .eq('round_id', roundId);

    // Fetch all actions for this round (play history)
    const { data: actions } = await sb.from('game_actions')
      .select('action_type, player_id, details, created_at')
      .eq('round_id', roundId)
      .order('created_at', { ascending: true });

    // Build player map
    const playerMap = {};
    for (const p of players) {
      playerMap[p.player_id] = {
        name: p.display_name,
        is_ai: p.is_ai || false,
        ai_tier: p.ai_tier || null,
        seat: p.seat_position,
        total_score: p.total_score || 0,
      };
    }

    // Build per-player end state
    const playerStates = {};
    for (const p of players) {
      const pid = p.player_id;
      const hand = (allCards || [])
        .filter(c => c.player_id === pid && c.location === 'hand')
        .sort((a, b) => a.position - b.position)
        .map(c => formatCard(c.card_id));

      const playerMelds = (allMelds || [])
        .filter(m => m.player_id === pid)
        .map(m => {
          const cards = (allCards || [])
            .filter(c => c.meld_id === m.id && c.location === 'meld')
            .sort((a, b) => a.position - b.position)
            .map(c => formatCard(c.card_id));
          return { type: m.meld_type, cards };
        });

      playerStates[p.display_name] = {
        is_ai: p.is_ai || false,
        ai_tier: p.ai_tier || null,
        seat: p.seat_position,
        hand_remaining: hand,
        hand_count: hand.length,
        melds: playerMelds,
      };
    }

    // Round scores
    const roundScores = gameState.round_scores || [];
    const thisRoundScores = roundScores.find(r => r.round_number === round.round_number);
    const scores = {};
    if (thisRoundScores) {
      for (const s of thisRoundScores.scores) {
        const pInfo = playerMap[s.player_id];
        if (pInfo) scores[pInfo.name] = s.score;
      }
    }

    // Format play history
    const history = (actions || []).map(a => {
      const pInfo = playerMap[a.player_id];
      const name = pInfo ? pInfo.name : 'Unknown';
      const d = a.details || {};
      let desc;
      switch (a.action_type) {
        case 'round_start': desc = `Round ${d.round}: ${d.contract}`; break;
        case 'draw_deck': desc = `${name} drew from deck`; break;
        case 'draw_discard': desc = `${name} picked up ${formatCard(d.card)}`; break;
        case 'discard': desc = `${name} discarded ${formatCard(d.card)}`; break;
        case 'contract_met': desc = `${name} fulfilled contract`; break;
        case 'lay_off': desc = `${name} laid off ${formatCard(d.card)}`; break;
        case 'buy_request': desc = `${name} requested buy`; break;
        case 'buy_awarded': desc = `${name} bought ${formatCard(d.discard_card)}${d.penalty_card ? ' (+penalty ' + formatCard(d.penalty_card) + ')' : ''}`; break;
        case 'round_end': desc = `Round ended`; break;
        default: desc = `${name}: ${a.action_type}`;
      }
      return desc;
    });

    // Build LLM-optimized text export
    const lines = [];
    lines.push(`# Contract Rummy — Round ${round.round_number} of 7`);
    lines.push(`Game: ${gameState.game_code || gameId}`);
    lines.push(`Contract: ${round.contract_sets || 0} sets of 3 + ${round.contract_runs || 0} runs of 4`);
    lines.push('');

    // Player roster
    lines.push('## Players');
    for (const p of players) {
      const info = playerMap[p.player_id];
      const tier = info.is_ai ? ` (AI ${info.ai_tier})` : ' (human)';
      lines.push(`- Seat ${info.seat}: ${info.name}${tier} — total score entering round: ${info.total_score}`);
    }
    lines.push('');

    // Play-by-play
    lines.push('## Play-by-Play');
    let turnNum = 0;
    for (const line of history) {
      if (line.startsWith('Round ') && line.includes(':')) {
        lines.push(line);
      } else if (line.includes('drew from deck') || line.includes('picked up')) {
        turnNum++;
        lines.push(`\n### Turn ${turnNum}`);
        lines.push(line);
      } else if (line === 'Round ended') {
        lines.push('\n' + line);
      } else {
        lines.push(line);
      }
    }
    lines.push('');

    // End state per player
    lines.push('## End State');
    const sortedPlayers = Object.entries(playerStates).sort((a, b) => (scores[a[0]] || 0) - (scores[b[0]] || 0));
    for (const [name, state] of sortedPlayers) {
      const score = scores[name] ?? '?';
      const winner = score === 0 ? ' ★ WINNER' : '';
      lines.push(`\n### ${name}${state.is_ai ? ` (AI ${state.ai_tier})` : ' (human)'}${winner}`);
      lines.push(`Round score: ${score} points`);
      if (state.melds.length > 0) {
        lines.push('Melds:');
        for (const m of state.melds) {
          lines.push(`  ${m.type}: ${m.cards.join(' ')}`);
        }
      } else {
        lines.push('Melds: none (did not fulfill contract)');
      }
      if (state.hand_remaining.length > 0) {
        lines.push(`Cards left in hand (${state.hand_count}): ${state.hand_remaining.join(' ')}`);
      } else {
        lines.push('Cards left in hand: 0 (went out)');
      }
    }
    lines.push('');

    // Analysis prompt
    lines.push('## Analysis Request');
    lines.push('Evaluate each player\'s decisions this round:');
    lines.push('1. Draw decisions: Did they pick up from discard when they should have drawn from deck, or vice versa?');
    lines.push('2. Discard decisions: Did they discard cards that helped opponents (feeding melds)?');
    lines.push('3. Contract timing: Did they fulfill their contract at the right time or hold too long?');
    lines.push('4. Buy decisions: Were buy requests strategically sound?');
    lines.push('5. Lay-off decisions: Did they miss opportunities to lay off cards on existing melds?');
    lines.push('6. Overall strategy: Rate each player\'s play quality for this round (1-10).');

    const text = lines.join('\n');
    await navigator.clipboard.writeText(text);
    exportBtn.textContent = '✓ Copied';
    showToast('Exported', 'Round data copied to clipboard');
    setTimeout(() => { exportBtn.textContent = origText; exportBtn.disabled = false; }, 2000);
  } catch (e) {
    console.error('[Export error]', e);
    showToast('Export Failed', e.message || 'Could not export round data');
    exportBtn.textContent = origText;
    exportBtn.disabled = false;
  }
};

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

  // Ready check phase — show ready bar, hide action buttons
  const readyBar = document.getElementById('readyCheckBar');
  const actionsPanel = document.getElementById('actionsPanel');
  if (phase === 'ready_check') {
    readyBar.style.display = '';
    actionsPanel.style.display = 'none';
    const myReady = gameState.my_is_ready || false;
    const readyBtn = document.getElementById('btnReady');
    readyBtn.disabled = myReady;
    readyBtn.textContent = myReady ? 'Waiting...' : 'Ready';
    const rc = round.ready_count || 0;
    const tp = round.total_players || 0;
    document.getElementById('readyStatus').textContent = `${rc}/${tp} ready`;
    return;
  }
  readyBar.style.display = 'none';
  actionsPanel.style.display = '';

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
    // Cannot lay off on the same turn you fulfilled your contract
    btnLayMeld.style.display = 'none';
    btnLayOff.style.display = '';
    btnLayOff.disabled = meldedThisTurn || !(isMyTurn && (phase === 'action' || phase === 'discard'));
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

async function handleReady() {
  if (!gameState?.round) return;
  const btn = document.getElementById('btnReady');
  btn.disabled = true;
  btn.textContent = 'Waiting...';
  const { error } = await rpc('player_ready', { p_round_id: gameState.round.id });
  if (error) {
    showToast('Error', error.message || 'Could not mark ready');
    btn.disabled = false;
    btn.textContent = 'Ready';
    return;
  }
  await fetchAndRender();
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
  // Immediately hide the discard face so it doesn't ghost after draw
  if (discardEl) discardEl.style.visibility = 'hidden';
  if (sourceRect) {
    animatingDraw = true;
    await flyCardToHand(sourceRect, data, false, false);
  }
  if (discardEl) discardEl.style.visibility = '';
  await fetchAndRender();
  animatingDraw = false;
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

  // Build placeholder slots based on contract (type auto-detected from cards)
  const totalSlots = (round.contract_sets || 0) + (round.contract_runs || 0);
  stagedMelds = [];
  for (let i = 0; i < totalSlots; i++) {
    stagedMelds.push({ cards: [], meld_type: 'auto' });
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

// Suit sort order: alternate black/red — S(0), H(1), C(3), D(2)
const SUIT_SORT = [0, 1, 3, 2]; // maps suit index → sort position
function sortCards(cards) {
  const dir = getSortDir() === 'desc' ? -1 : 1;
  return [...cards].sort((a, b) => {
    const sa = SUIT_SORT[cardSuit(a)], sb = SUIT_SORT[cardSuit(b)];
    if (sa !== sb) return (sa - sb) * dir;
    return (cardValue(a) - cardValue(b)) * dir;
  });
}

function isAceLowRun(cards) {
  const nonJokers = cards.filter(c => !isJoker(c));
  if (nonJokers.length < 2) return false;
  const vals = nonJokers.map(c => cardValue(c));
  if (!vals.includes(14)) return false;
  // Check if ace-low interpretation makes a valid run
  const lowVals = vals.map(v => v === 14 ? 1 : v).sort((a, b) => a - b);
  const highVals = [...vals].sort((a, b) => a - b);
  // Ace-low if low range is tighter than high range
  const lowRange = lowVals[lowVals.length - 1] - lowVals[0];
  const highRange = highVals[highVals.length - 1] - highVals[0];
  return lowRange < highRange;
}

function sortMeldCards(cards) {
  const dir = getSortDir() === 'desc' ? -1 : 1;
  const aceLow = isAceLowRun(cards);
  return [...cards].sort((a, b) => {
    let va = isJoker(a) ? -100 : cardValue(a);
    let vb = isJoker(b) ? -100 : cardValue(b);
    if (aceLow) {
      if (va === 14) va = 1;
      if (vb === 14) vb = 1;
    }
    // Place jokers by gap position (simple: sort by value)
    if (isJoker(a) || isJoker(b)) {
      // Just put jokers at the end for now
      if (isJoker(a) && isJoker(b)) return 0;
      return isJoker(a) ? 1 * dir : -1 * dir;
    }
    return (va - vb) * dir;
  });
}

function sortSlotCards(index) {
  const slot = stagedMelds[index];
  const type = detectMeldType(slot.cards);
  if (type === 'run') {
    slot.cards = sortMeldCards(slot.cards);
  } else {
    slot.cards = sortCards(slot.cards);
  }
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

function isValidSet(cards) {
  const values = cards.filter(c => !isJoker(c)).map(c => cardValue(c));
  const uniqueVals = new Set(values);
  return uniqueVals.size <= 1;
}

function isValidRun(cards) {
  const nonJokers = cards.filter(c => !isJoker(c));
  const suits = nonJokers.map(c => cardSuit(c));
  if (new Set(suits).size > 1) return false;
  const vals = nonJokers.map(c => cardValue(c)).sort((a, b) => a - b);
  const jokerCount = cards.length - nonJokers.length;

  // Try ace-high
  let gaps = 0;
  for (let i = 1; i < vals.length; i++) {
    const diff = vals[i] - vals[i - 1];
    if (diff === 0) return false;
    if (diff > 1) gaps += diff - 1;
  }
  if (gaps <= jokerCount) return true;

  // Try ace-low
  if (vals.includes(14)) {
    const lowVals = vals.map(v => v === 14 ? 1 : v).sort((a, b) => a - b);
    gaps = 0;
    for (let i = 1; i < lowVals.length; i++) {
      const diff = lowVals[i] - lowVals[i - 1];
      if (diff === 0) return false;
      if (diff > 1) gaps += diff - 1;
    }
    if (gaps <= jokerCount) return true;
  }
  return false;
}

function detectMeldType(cards) {
  if (cards.length === 0) return 'auto';
  const set = isValidSet(cards);
  const run = isValidRun(cards);
  if (set && !run) return 'set';
  if (run && !set) return 'run';
  if (set && run) return 'set'; // ambiguous (e.g. 3 jokers) — default to set
  return 'invalid';
}

function validateSlot(slot) {
  const isRound7 = gameState?.round?.round_number === 7;
  const maxCards = isRound7 ? 13 : 3; // round 7: runs can be longer to meld all cards
  if (slot.cards.length < 3) return { valid: false, msg: slot.cards.length === 0 ? '' : `need ${3 - slot.cards.length} more`, type: 'auto' };
  if (slot.cards.length > maxCards) return { valid: false, msg: `too many (${slot.cards.length}/${maxCards})`, type: 'auto' };
  const type = detectMeldType(slot.cards);
  if (type === 'invalid') {
    // Give a helpful hint
    const nonJokers = slot.cards.filter(c => !isJoker(c));
    const vals = nonJokers.map(c => cardValue(c));
    const suits = nonJokers.map(c => cardSuit(c));
    if (new Set(vals).size > 1 && new Set(suits).size > 1) return { valid: false, msg: 'not a set or run', type };
    if (new Set(vals).size > 1) return { valid: false, msg: 'not in sequence', type };
    return { valid: false, msg: 'not valid', type };
  }
  return { valid: true, msg: 'valid', type };
}

function renderStagedMelds() {
  const container = document.getElementById('stagedMelds');
  const req = getContractRequirements();

  // Auto-sort all slots before rendering
  stagedMelds.forEach((s, idx) => { if (s.cards.length > 0) sortSlotCards(idx); });

  let meldNum = 0;
  container.innerHTML = stagedMelds.map((slot, i) => {
    meldNum++;
    const hasCards = slot.cards.length > 0;
    const { valid, msg, type } = hasCards ? validateSlot(slot) : { valid: false, msg: '', type: 'auto' };
    const detectedType = (type && type !== 'auto' && type !== 'invalid') ? type : slot.meld_type;
    const label = detectedType === 'set' ? `Set ${meldNum}` : detectedType === 'run' ? `Run ${meldNum}` : `Meld ${meldNum}`;
    const statusHtml = msg ? `<span class="status ${valid ? 'ok' : 'bad'}">${msg}</span>` : '';
    const validClass = !hasCards ? '' : (valid ? ' valid' : ' invalid');

    const renderedCards = slot.cards.map(c => {
      const p = parseCard(c);
      return `<div class="mc${p.red ? ' r' : ''} removable" data-slot="${i}" data-card="${c}" title="Click to remove"><span class="s">${p.rank}</span><span>${p.symbol}</span></div>`;
    }).join('');
    const remaining = Math.max(0, 3 - slot.cards.length);
    const placeholders = Array(remaining).fill('<div class="staged-meld-placeholder"></div>').join('');
    const cardsHtml = renderedCards + placeholders;

    const clearBtn = hasCards ? `<div class="staged-meld-clear" data-idx="${i}">&times;</div>` : '';

    return `<div class="staged-meld${hasCards ? ' has-cards' : ''}${validClass}" data-slot="${i}">
      <div class="staged-meld-label">
        <span class="type">${label}</span>
        ${statusHtml}
      </div>
      <div class="staged-meld-cards">${cardsHtml}</div>
      ${remaining > 0 || (gameState?.round?.round_number === 7) ? `<div class="staged-meld-add" data-slot="${i}">+ Add Selected</div>` : ''}
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

  // Verify detected types match contract requirements
  const detectedSets = stagedMelds.filter(s => s.cards.length >= 3 && detectMeldType(s.cards) === 'set').length;
  const detectedRuns = stagedMelds.filter(s => s.cards.length >= 3 && detectMeldType(s.cards) === 'run').length;
  const contractMet = detectedSets >= req.sets && detectedRuns >= req.runs;

  // Round 7: must meld all cards except 1 discard
  const isRound7 = gameState.round.round_number === 7;
  const meldedCardCount = stagedMelds.reduce((sum, s) => sum + s.cards.length, 0);
  const handSize = gameState.my_hand?.length || 0;
  const remaining = handSize - meldedCardCount;
  const round7Valid = !isRound7 || remaining === 1;

  if (allValid && filledSlots.length === stagedMelds.length && contractMet && !round7Valid) {
    hint.textContent = `Must meld all cards — ${remaining} left, need exactly 1 for discard`;
    hint.style.color = '#d45f5f';
    submitBtn.disabled = true;
  } else if (allValid && filledSlots.length === stagedMelds.length && contractMet && round7Valid) {
    if (canSubmitNow) {
      hint.textContent = isRound7 ? 'All cards melded! Hit Submit.' : 'Contract ready! Hit Submit.';
      hint.style.color = '#3cb96a';
      submitBtn.disabled = false;
    } else {
      hint.textContent = isRound7 ? 'All cards melded — submit on your turn' : 'Contract ready — submit on your turn';
      hint.style.color = 'var(--amber)';
      submitBtn.disabled = true;
    }
  } else if (allValid && filledSlots.length === stagedMelds.length && !contractMet) {
    hint.textContent = `Need ${req.sets} set${req.sets !== 1 ? 's' : ''} and ${req.runs} run${req.runs !== 1 ? 's' : ''} — got ${detectedSets} set${detectedSets !== 1 ? 's' : ''}, ${detectedRuns} run${detectedRuns !== 1 ? 's' : ''}`;
    hint.style.color = '#d45f5f';
    submitBtn.disabled = true;
  } else {
    const emptySlots = stagedMelds.filter(s => s.cards.length === 0).length;
    const invalidDetails = [];
    stagedMelds.forEach((s, idx) => {
      if (s.cards.length > 0) {
        const res = validateSlot(s);
        const lbl = `Meld ${idx + 1}`;
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
    meld_type: detectMeldType(m.cards)
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
  meldedThisTurn = true;
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
document.getElementById('btnReady').addEventListener('click', handleReady);
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
function toggleFullscreen() {
  document.getElementById('settingsDropdown')?.classList.remove('open');
  const el = document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) req.call(el).catch(() => showToast('Fullscreen', 'Not supported in this browser'));
    else showToast('Fullscreen', 'Not supported in this browser');
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
  }
}
document.getElementById('btnFullscreen').addEventListener('click', toggleFullscreen);
document.getElementById('btnFullscreenWaiting').addEventListener('click', toggleFullscreen);
function onFullscreenChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const label = isFs ? 'Exit Fullscreen' : 'Fullscreen';
  document.getElementById('btnFullscreen').textContent = label;
  document.getElementById('btnFullscreenWaiting').textContent = label;
}
document.addEventListener('fullscreenchange', onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);

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

// Apply saved card view settings (default to compact on mobile)
const mobileDefault = window.innerWidth <= 600 ? 'compact' : 'default';
setCardView('handView', localStorage.getItem('play27-handView') || mobileDefault);
setCardView('meldView', localStorage.getItem('play27-meldView') || mobileDefault);
setCardView('sortDir', localStorage.getItem('play27-sortDir') || 'asc');

// Ding on turn setting
dingOnTurn = localStorage.getItem('play27-dingOnTurn') !== 'off';
document.getElementById(dingOnTurn ? 'dingOn' : 'dingOff').classList.add('active');
document.getElementById(dingOnTurn ? 'dingOff' : 'dingOn').classList.remove('active');
document.querySelectorAll('[data-setting="dingOnTurn"]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dingOnTurn = btn.dataset.val === 'on';
    localStorage.setItem('play27-dingOnTurn', dingOnTurn ? 'on' : 'off');
    document.getElementById('dingOn').classList.toggle('active', dingOnTurn);
    document.getElementById('dingOff').classList.toggle('active', !dingOnTurn);
  });
});

// Turn ding via Web Audio API
function playTurnDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1175, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.25);
  } catch (e) { /* audio not available */ }
}

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
