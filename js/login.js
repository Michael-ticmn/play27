import { sb, rpc, ensureProfile, getTokenFromStorage, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js?v=0.11.23';
import { initTheme } from './theme.js?v=0.11.23';

// ─────────────────────────────────────────────
// AUTH STATE
// ─────────────────────────────────────────────
let currentUser = null;
const urlParams = new URLSearchParams(window.location.search);
const gameCodeFromUrl = urlParams.get('game');

sb.auth.onAuthStateChange(async (event, session) => {
  if (session) {
    currentUser = session.user;
    await showLobby();
  } else {
    currentUser = null;
    showAuth();
    // Pre-fill invite code and switch to signup if game code in URL
    if (gameCodeFromUrl) {
      document.getElementById('signupInvite').value = gameCodeFromUrl.toUpperCase();
      switchTab('signup');
    }
  }
});

// ─────────────────────────────────────────────
// AUTH HANDLERS
// ─────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const errEl = document.getElementById('loginError');

  errEl.classList.remove('show');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Signing in...';

  const { error } = await sb.auth.signInWithPassword({ email, password });

  btn.disabled = false;
  btn.textContent = 'Sign In';

  if (error) {
    errEl.textContent = error.message;
    errEl.classList.add('show');
    return;
  }

  // Auto-join game if code was in URL
  if (gameCodeFromUrl) {
    const { error: joinErr } = await rpc('join_game', { p_code: gameCodeFromUrl });
    if (!joinErr) {
      window.location.href = `contract-rummy.html?game=${gameCodeFromUrl}`;
      return;
    }
  }
};

async function handleSignup(e) {
  e.preventDefault();
  const inviteCode = document.getElementById('signupInvite').value.trim();
  const name = document.getElementById('signupName').value.trim();
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const btn = document.getElementById('signupBtn');
  const errEl = document.getElementById('signupError');
  const successEl = document.getElementById('signupSuccess');

  errEl.classList.remove('show');
  successEl.classList.remove('show');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating account...';

  // Create the account first
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: name } }
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Create Account';
    errEl.textContent = error.message;
    errEl.classList.add('show');
    return;
  }

  // Redeem invite code (requires auth, so do after signup)
  if (data.session) {
    const { error: inviteErr } = await rpc('redeem_invite_code', { p_code: inviteCode });
    if (inviteErr) {
      // Invite failed — delete the account we just created
      await sb.auth.signOut();
      btn.disabled = false;
      btn.textContent = 'Create Account';
      errEl.textContent = inviteErr.message;
      errEl.classList.add('show');
      return;
    }
  }

  // Create profile row
  if (data.user) {
    await sb.from('profiles').upsert({
      id: data.user.id,
      display_name: name
    });
  }

  btn.disabled = false;
  btn.textContent = 'Create Account';

  // If email confirmation is required
  if (data.user && !data.session) {
    successEl.textContent = 'Check your email to confirm your account!';
    successEl.classList.add('show');
    return;
  }

  // Auto-join game using invite code (which is the game code)
  const joinCode = gameCodeFromUrl || inviteCode;
  if (joinCode && data.session) {
    const { error: joinErr } = await rpc('join_game', { p_code: joinCode });
    if (!joinErr) {
      window.location.href = `contract-rummy.html?game=${joinCode}`;
      return;
    }
  }
};

// ─────────────────────────────────────────────
// UI SWITCHING
// ─────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));

  if (tab === 'login') {
    document.querySelectorAll('.tab')[0].classList.add('active');
    document.getElementById('loginPanel').classList.add('active');
  } else {
    document.querySelectorAll('.tab')[1].classList.add('active');
    document.getElementById('signupPanel').classList.add('active');
  }
};

function showAuth() {
  document.getElementById('authSection').style.display = '';
  document.getElementById('lobbyPanel').classList.remove('active');
}

async function showLobby() {
  document.getElementById('authSection').style.display = 'none';
  document.getElementById('lobbyPanel').classList.add('active');

  // Ensure profile exists (direct fetch, no Supabase client dependency)
  const displayName = currentUser.user_metadata?.display_name || currentUser.email || 'Player';
  await ensureProfile(currentUser.id, displayName);

  document.getElementById('userName').textContent = displayName;

  await Promise.all([loadHistory(), checkActiveGame()]);
}

async function checkActiveGame() {
  const { data, error } = await rpc('get_active_game');
  console.log('[checkActiveGame]', data, error);
  const card = document.getElementById('rejoinCard');

  if (error || !data) {
    console.log('[checkActiveGame] no active game');
    card.style.display = 'none';
    return;
  }

  // Show rejoin card immediately
  console.log('[checkActiveGame] found active game:', data.code, data.status);
  const status = data.status === 'active'
    ? `Round ${data.current_round || '?'} \u00B7 ${data.player_count} players`
    : `Waiting \u00B7 ${data.player_count} players`;
  document.getElementById('rejoinInfo').textContent = status;
  card.style.display = 'block';
  card.onclick = () => {
    window.location.href = `contract-rummy.html?game=${data.code}`;
  };

  // Mark disconnected (fire-and-forget, don't block UI)
  fetch(`${SUPABASE_URL}/rest/v1/game_players?game_id=eq.${data.game_id}&player_id=eq.${currentUser.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${getTokenFromStorage()}`,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ is_connected: false })
  }).catch(() => {});
}

// ─────────────────────────────────────────────
// GAME ACTIONS
// ─────────────────────────────────────────────

// ── SETUP MODAL ──
const setupOptions = {
  numJokers: 0,
  buyCountdown: 10,
  maxBuys: null  // null = unlimited
};

function showSetupModal() {
  const btn = document.getElementById('setupCreateBtn');
  btn.disabled = false;
  btn.textContent = 'Create Game';
  document.getElementById('setupModal').classList.add('show');
  document.getElementById('setupError').classList.remove('show');
}

function hideSetupModal() {
  document.getElementById('setupModal').classList.remove('show');
}

// Toggle buttons in setup modal
document.querySelectorAll('.setup-options').forEach(group => {
  const option = group.dataset.option;
  group.querySelectorAll('.setup-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('.setup-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const raw = btn.dataset.val;
      setupOptions[option] = raw === '' ? null : parseInt(raw, 10);
    });
  });
});

async function handleCreateGame() {
  const btn = document.getElementById('setupCreateBtn');
  const errEl = document.getElementById('setupError');
  errEl.classList.remove('show');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating...';

  const params = {
    p_buy_countdown: setupOptions.buyCountdown,
    p_num_decks: 2,
    p_num_jokers: setupOptions.numJokers
  };
  if (setupOptions.maxBuys !== null) {
    params.p_max_buys = setupOptions.maxBuys;
  }

  try {
    const { data, error } = await rpc('create_game', params);

    if (error) {
      errEl.textContent = error.message;
      errEl.classList.add('show');
      return;
    }

    const code = data?.code || (typeof data === 'string' ? data : null);
    if (code) {
      window.location.href = `contract-rummy.html?game=${code}`;
    } else {
      errEl.textContent = 'Response: ' + JSON.stringify(data);
      errEl.classList.add('show');
    }
  } catch (err) {
    errEl.textContent = 'Caught: ' + (err.message || 'Failed to create game');
    errEl.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Game';
  }
};

function showJoinModal() {
  document.getElementById('joinModal').classList.add('show');
  document.getElementById('joinCode').value = '';
  document.getElementById('joinCode').focus();
  document.getElementById('joinError').classList.remove('show');
};

function hideJoinModal() {
  document.getElementById('joinModal').classList.remove('show');
};

async function handleJoinGame() {
  const code = document.getElementById('joinCode').value.trim();
  const errEl = document.getElementById('joinError');

  if (code.length !== 6) {
    errEl.textContent = 'Code must be 6 characters';
    errEl.classList.add('show');
    return;
  }

  errEl.classList.remove('show');

  const { data, error } = await rpc('join_game', { p_code: code });
  if (error) {
    errEl.textContent = error.message;
    errEl.classList.add('show');
    return;
  }

  window.location.href = `contract-rummy.html?game=${code}`;
};

// ─────────────────────────────────────────────
// GAME HISTORY
// ─────────────────────────────────────────────
async function loadHistory() {
  const { data, error } = await rpc('get_game_history');

  const container = document.getElementById('historyList');

  if (error || !data || data.length === 0) {
    container.innerHTML = '<div class="history-empty">No games played yet. Start one!</div>';
    return;
  }

  // Compute stats (exclude incomplete games)
  const games = data;
  const completed = games.filter(g => g.rounds_played >= 7);
  const wins = completed.filter(g => g.your_rank === 1).length;
  const totalScore = completed.reduce((s, g) => s + g.your_total_score, 0);
  const avgScore = completed.length ? Math.round(totalScore / completed.length) : 0;

  document.getElementById('statGames').textContent = completed.length;
  document.getElementById('statWins').textContent = wins;
  document.getElementById('statAvg').textContent = avgScore;

  // Render history
  container.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'history-list';

  games.forEach(game => {
    const isComplete = game.rounds_played >= 7;
    const isWin = isComplete && game.your_rank === 1;
    const date = new Date(game.finished_at);
    const dateStr = date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric'
    });

    const players = game.players.map(p => p.name).join(', ');

    const ordinal = n => {
      const s = ['th','st','nd','rd'];
      const v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    const item = document.createElement('div');
    item.className = 'history-item' + (isWin ? ' win' : '') + (!isComplete ? ' incomplete' : '');

    if (isComplete) {
      item.innerHTML = `
        <div class="hi-info">
          <h4>${isWin ? '&#127942; ' : ''}${game.winner} won${isWin ? ' (You!)' : ''}</h4>
          <p>${dateStr} &middot; ${game.player_count} players &middot; ${players}</p>
        </div>
        <div class="hi-rank">
          ${ordinal(game.your_rank)}
          <small>place</small>
        </div>
        <div class="hi-score">
          <span class="pts">${game.your_total_score}</span>
          <small>total pts</small>
        </div>
      `;
    } else {
      item.innerHTML = `
        <div class="hi-info">
          <h4>Game ended early</h4>
          <p>${dateStr} &middot; ${game.player_count} players &middot; ${players} &middot; Round ${game.rounds_played}/7</p>
        </div>
        <div class="hi-rank incomplete-tag">
          DNF
        </div>
        <div class="hi-score">
          <span class="pts">${game.your_total_score}</span>
          <small>total pts</small>
        </div>
      `;
    }
    list.appendChild(item);
  });

  container.appendChild(list);
}

// ─────────────────────────────────────────────
// WIRE UP EVENT LISTENERS
// ─────────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await sb.auth.signOut();
});

document.getElementById('loginForm').addEventListener('submit', handleLogin);
document.getElementById('signupForm').addEventListener('submit', handleSignup);

document.getElementById('tabLogin').addEventListener('click', () => switchTab('login'));
document.getElementById('tabSignup').addEventListener('click', () => switchTab('signup'));

const newGameEl = document.getElementById('newGameCard');
const joinGameEl = document.getElementById('joinGameCard');
newGameEl.addEventListener('click', () => showSetupModal());
joinGameEl.addEventListener('click', () => showJoinModal());

// Setup modal
document.getElementById('setupCancelBtn').addEventListener('click', hideSetupModal);
document.getElementById('setupCreateBtn').addEventListener('click', handleCreateGame);
document.getElementById('setupModal').addEventListener('click', function(e) {
  if (e.target === this) hideSetupModal();
});

// Join modal
document.getElementById('joinCancelBtn').addEventListener('click', hideJoinModal);
document.getElementById('joinSubmitBtn').addEventListener('click', handleJoinGame);
document.getElementById('joinModal').addEventListener('click', function(e) {
  if (e.target === this) hideJoinModal();
});
document.getElementById('joinCode').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') handleJoinGame();
});

// ─────────────────────────────────────────────
// THEME
// Theme
initTheme();
