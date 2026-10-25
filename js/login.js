import { sb, rpc, ensureProfile, getTokenFromStorage, SUPABASE_URL, SUPABASE_ANON_KEY, dbg } from './supabase.js?v=0.15.5';
import { initTheme } from './theme.js?v=0.15.5';

// ─────────────────────────────────────────────
// AUTH STATE
// ─────────────────────────────────────────────
let currentUser = null;
const urlParams = new URLSearchParams(window.location.search);
const gameCodeFromUrl = urlParams.get('game');

// Password reset: the emailed link comes back here with a recovery session (or an error) in the
// URL hash. Read it now, before the Supabase client clears the hash.
const hashParams = new URLSearchParams(location.hash.slice(1));
let recovering = hashParams.get('type') === 'recovery';
let recoveryToken = hashParams.get('access_token');
const resetLinkFailed = !!hashParams.get('error_code');
const resetFrom = urlParams.get('reset'); // 'scorekeeper' when Scorekeeper's sign-in sent the user here
const RESET_RETURN_KEY = 'p27-reset-return';

sb.auth.onAuthStateChange(async (event, session) => {
  if (event === 'PASSWORD_RECOVERY') recovering = true;
  if (session && recovering) {
    currentUser = session.user;
    recoveryToken = session.access_token;
    showNewPassword();
    return;
  }
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

  const fail = (msg) => {
    btn.disabled = false;
    btn.textContent = 'Create Account';
    errEl.textContent = msg;
    errEl.classList.add('show');
  };

  if (!inviteCode) { fail('Enter your invite code.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating account...';

  // Check the invite code before creating anything (no sign-in needed)
  const inviteCheck = await checkInviteCode(inviteCode);
  if (inviteCheck) { fail(inviteCheck); return; }

  // The code travels with the sign-up so the database can verify it and record the redemption
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: name, invite_code: inviteCode.toUpperCase() } }
  });

  if (error) {
    fail(/database error saving new user/i.test(error.message)
      ? 'That invite code is no longer valid. Ask for a new one.'
      : error.message);
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

// Direct fetch, like rpc(): the client's own auth calls can hang on a stale stored token.
async function handleReset(e) {
  e.preventDefault();
  const email = document.getElementById('resetEmail').value.trim();
  const btn = document.getElementById('resetBtn');
  const errEl = document.getElementById('resetError');
  const okEl = document.getElementById('resetSuccess');

  errEl.classList.remove('show');
  okEl.classList.remove('show');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending...';

  if (resetFrom === 'scorekeeper') localStorage.setItem(RESET_RETURN_KEY, 'scorekeeper.html');
  else localStorage.removeItem(RESET_RETURN_KEY);

  const back = new URL('login.html', location.href).href;
  let resp = null, body = null;
  try {
    resp = await fetch(`${SUPABASE_URL}/auth/v1/recover?redirect_to=${encodeURIComponent(back)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ email })
    });
    body = await resp.json().catch(() => null);
  } catch (err) { /* reported below */ }

  btn.disabled = false;
  btn.textContent = 'Email Me a Reset Link';

  if (!resp || !resp.ok) {
    errEl.textContent = !resp ? 'Could not reach the server. Try again.'
      : resp.status === 429 ? 'Too many reset emails were sent. Wait a few minutes, then try again.'
      : (body && (body.msg || body.message)) || 'Could not send the reset email. Try again.';
    errEl.classList.add('show');
    return;
  }
  okEl.textContent = 'If a play27 account uses that email, a reset link is on its way. Open it on the device you want to sign in on.';
  okEl.classList.add('show');
}

async function handleNewPassword(e) {
  e.preventDefault();
  const pw = document.getElementById('newPassword').value;
  const pw2 = document.getElementById('newPassword2').value;
  const btn = document.getElementById('newPassBtn');
  const errEl = document.getElementById('newPassError');

  errEl.classList.remove('show');
  const fail = (msg) => {
    btn.disabled = false;
    btn.textContent = 'Save New Password';
    errEl.textContent = msg;
    errEl.classList.add('show');
  };

  if (pw !== pw2) { fail("The two passwords don't match."); return; }
  const token = recoveryToken || getTokenFromStorage();
  if (!token) { fail('This reset link has run out. Send yourself a new one.'); return; }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving...';

  let resp = null, body = null;
  try {
    resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ password: pw })
    });
    body = await resp.json().catch(() => null);
  } catch (err) { fail('Could not reach the server. Try again.'); return; }

  if (!resp.ok) {
    const code = body && (body.error_code || body.code);
    fail(code === 'same_password' ? 'That is already your password. Sign in with it, or choose a different one.'
      : (body && (body.msg || body.message)) || 'Could not save the new password. Try again.');
    return;
  }

  recovering = false;
  history.replaceState(null, '', location.pathname);
  document.getElementById('authSection').dataset.mode = '';
  const next = localStorage.getItem(RESET_RETURN_KEY);
  localStorage.removeItem(RESET_RETURN_KEY);
  if (next) { window.location.href = next; return; }
  switchTab('login');
  await showLobby();
}

/** Returns null when the invite code is valid, otherwise the message to show. */
async function checkInviteCode(code) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/check_invite_code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ p_code: code })
    });
    if (resp.ok) return null;
    const body = await resp.json().catch(() => null);
    return (body && body.message) || 'Could not check the invite code. Try again.';
  } catch (e) {
    return 'Could not reach the server to check the invite code. Try again.';
  }
}

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

function showReset(message) {
  switchTab('login');
  document.getElementById('loginPanel').classList.remove('active');
  document.getElementById('resetPanel').classList.add('active');
  const emailEl = document.getElementById('resetEmail');
  if (!emailEl.value) emailEl.value = document.getElementById('loginEmail').value.trim();
  const errEl = document.getElementById('resetError');
  errEl.textContent = message || '';
  errEl.classList.toggle('show', !!message);
  document.getElementById('resetSuccess').classList.remove('show');
}

function showNewPassword() {
  const section = document.getElementById('authSection');
  section.style.display = '';
  section.dataset.mode = 'newpass';
  document.getElementById('lobbyPanel').classList.remove('active');
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('newPassPanel').classList.add('active');
  document.getElementById('newPassUser').value = (currentUser && currentUser.email) || '';
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
  dbg('[checkActiveGame]', data, error);
  const card = document.getElementById('rejoinCard');

  if (error || !data) {
    dbg('[checkActiveGame] no active game');
    card.style.display = 'none';
    return;
  }

  // Show rejoin card immediately
  dbg('[checkActiveGame] found active game:', data.code, data.status);
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

// Password reset
document.getElementById('forgotLink').addEventListener('click', () => showReset());
document.getElementById('resetBack').addEventListener('click', () => switchTab('login'));
document.getElementById('resetForm').addEventListener('submit', handleReset);
document.getElementById('newPassForm').addEventListener('submit', handleNewPassword);
if (resetLinkFailed) {
  history.replaceState(null, '', location.pathname);
  showReset('That reset link has expired or was already used. Send yourself a new one.');
} else if (resetFrom && !recovering) {
  showReset();
}

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
