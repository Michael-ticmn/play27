import { initTheme } from './theme.js?v=0.11.31';

// ── Constants ──
const SUIT_INFO = [
  { symbol: '\u2660', name: 'S', red: false },
  { symbol: '\u2665', name: 'H', red: true },
  { symbol: '\u2666', name: 'D', red: true },
  { symbol: '\u2663', name: 'C', red: false },
];
const VALUE_NAMES = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' };
const BOT_NAMES = ['Ace','Duke','Maverick','Blaze','Shadow','Lucky'];
const STARTING_CHIPS = 1000;

// ── State ──
let config = { numBots: 3, numDecks: 6 };
let shoe = [];
let players = []; // index 0 = human, 1..N = bots
let dealer = { hands: [{ cards: [], stood: false, busted: false }] };
let currentPlayerIndex = 0;
let currentHandIndex = 0;
let gamePhase = 'setup'; // setup | betting | dealing | playing | dealer-turn | results
let selectedBet = 50;
let roundNum = 0;

// ── Deck Management ──
function createShoe(numDecks) {
  const cards = [];
  for (let d = 0; d < numDecks; d++) {
    for (let s = 0; s < 4; s++) {
      for (let v = 2; v <= 14; v++) {
        cards.push(d.toString() + s.toString() + v.toString().padStart(2, '0'));
      }
    }
  }
  return cards;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawCard() {
  if (shoe.length < Math.max(20, config.numDecks * 52 * 0.25)) {
    shoe = shuffle(createShoe(config.numDecks));
    showToast('Reshuffling shoe...');
  }
  return shoe.pop();
}

// ── Card Helpers ──
function parseCard(code) {
  if (!code || code.length < 4) return { rank: '?', suit: '?', symbol: '?', red: false, id: code };
  const suitDigit = parseInt(code[1]);
  const value = parseInt(code.substring(2));
  const info = SUIT_INFO[suitDigit] || { symbol: '?', red: false };
  const rank = VALUE_NAMES[value] || value.toString();
  return { rank, suit: suitDigit, symbol: info.symbol, red: info.red, id: code };
}

function bjValue(code) {
  const v = parseInt(code.substring(2));
  if (v === 14) return 11; // Ace
  if (v >= 11) return 10;  // J, Q, K
  return v;
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    const v = bjValue(c);
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 };
}

function isBusted(hand) { return handValue(hand.cards).total > 21; }
function isBlackjack(hand) { return hand.cards.length === 2 && handValue(hand.cards).total === 21; }

function canSplit(hand, chips, bet) {
  if (hand.cards.length !== 2 || hand.split) return false;
  if (chips < bet) return false;
  return bjValue(hand.cards[0]) === bjValue(hand.cards[1]);
}

function canDouble(hand, chips, bet) {
  return hand.cards.length === 2 && !isBusted(hand) && chips >= bet;
}

// ── Rendering ──
function renderMiniCard(code) {
  const c = parseCard(code);
  return `<div class="mc${c.red ? ' r' : ''} deal-anim"><span class="s">${c.rank}</span><span>${c.symbol}</span></div>`;
}

function renderHandCard(code) {
  const c = parseCard(code);
  return `<div class="hc${c.red ? ' r' : ''} deal-anim"><span class="rnk">${c.rank}</span><span class="sct">${c.symbol}</span></div>`;
}

function renderCardBack(size) {
  return `<div class="card-back ${size}"><img src="assets/card-back.svg?v=0.10.1" alt=""></div>`;
}

function formatValue(cards, hideHole) {
  if (!cards.length) return '';
  if (hideHole) {
    const shown = [cards[0]];
    const v = handValue(shown);
    return v.total + ' + ?';
  }
  const v = handValue(cards);
  let s = v.total.toString();
  if (v.soft && v.total <= 21) s = v.total + '';
  return s;
}

function render() {
  const hideDealer = gamePhase === 'playing' || gamePhase === 'dealing';

  // Dealer
  let dealerHTML = '';
  dealer.hands[0].cards.forEach((c, i) => {
    if (i === 1 && hideDealer) {
      dealerHTML += renderCardBack('sm');
    } else {
      dealerHTML += renderMiniCard(c);
    }
  });
  document.getElementById('dealerCards').innerHTML = dealerHTML;
  document.getElementById('dealerValue').textContent = dealer.hands[0].cards.length
    ? formatValue(dealer.hands[0].cards, hideDealer)
    : '';

  // Bots
  const botsRow = document.getElementById('botsRow');
  botsRow.innerHTML = '';
  for (let i = 1; i < players.length; i++) {
    const p = players[i];
    const hand = p.hands[0];
    let cardsHTML = hand.cards.map(c => renderMiniCard(c)).join('');
    const val = hand.cards.length ? formatValue(hand.cards, false) : '';
    const resultClass = p.roundResult || '';
    const resultText = p.roundResultText || '';
    const outClass = p.chips <= 0 && gamePhase === 'results' ? ' busted-out' : '';

    botsRow.innerHTML += `
      <div class="bot-seat${outClass}">
        <div><span class="bot-name">${p.name}</span><span class="bot-chips">${p.chips}</span></div>
        <div class="bot-bet">${p.bet > 0 ? 'Bet: ' + p.bet : ''}</div>
        <div class="bot-cards">${cardsHTML}</div>
        <div class="bot-value">${val}</div>
        <div class="bot-result ${resultClass}">${resultText}</div>
      </div>`;
  }

  // Player
  const me = players[0];
  document.getElementById('playerChips').textContent = me.chips;
  document.getElementById('playerBetLabel').textContent = me.bet > 0 ? 'Bet: ' + me.bet : '';

  const handsDiv = document.getElementById('playerHands');
  let handsHTML = '';
  me.hands.forEach((hand, hi) => {
    const activeClass = me.hands.length > 1
      ? (hi === currentHandIndex && gamePhase === 'playing' && currentPlayerIndex === 0 ? ' active-hand' : ' inactive-hand')
      : '';
    const cardsHTML = hand.cards.map(c => renderHandCard(c)).join('');
    const val = hand.cards.length ? formatValue(hand.cards, false) : '';
    handsHTML += `<div class="hand-group${activeClass}"><div class="hand-cards-row">${cardsHTML}</div><div class="player-value">${val}</div></div>`;
  });
  handsDiv.innerHTML = handsHTML;

  // Player result
  const pr = document.getElementById('playerResult');
  if (me.roundResultText) {
    pr.textContent = me.roundResultText;
    pr.className = 'player-result ' + (me.roundResult || '');
  } else {
    pr.textContent = '';
    pr.className = 'player-result';
  }

  // Action bar
  const actionBar = document.getElementById('actionBar');
  if (gamePhase === 'playing' && currentPlayerIndex === 0) {
    actionBar.classList.add('show');
    const hand = me.hands[currentHandIndex];
    document.getElementById('btnDouble').disabled = !canDouble(hand, me.chips, me.bet);
    document.getElementById('btnSplit').style.display = canSplit(hand, me.chips, me.bet) ? '' : 'none';
  } else {
    actionBar.classList.remove('show');
  }

  // Shoe count
  document.getElementById('shoeCount').textContent = shoe.length;
}

// ── Game Flow ──
function startGame() {
  config.numBots = parseInt(document.getElementById('selBots').value);
  config.numDecks = parseInt(document.getElementById('selDecks').value);

  shoe = shuffle(createShoe(config.numDecks));

  players = [];
  players.push({ name: 'You', chips: STARTING_CHIPS, bet: 0, hands: [{ cards: [], stood: false, busted: false }], isBot: false, roundResult: '', roundResultText: '' });
  for (let i = 0; i < config.numBots; i++) {
    players.push({ name: BOT_NAMES[i] || 'Bot ' + (i + 1), chips: STARTING_CHIPS, bet: 0, hands: [{ cards: [], stood: false, busted: false }], isBot: true, roundResult: '', roundResultText: '' });
  }
  dealer = { hands: [{ cards: [], stood: false, busted: false }] };
  roundNum = 0;

  document.getElementById('setupScreen').style.display = 'none';
  document.getElementById('gameBoard').style.display = 'flex';
  startBetting();
}

function startBetting() {
  roundNum++;
  // Reset hands
  for (const p of players) {
    p.bet = 0;
    p.hands = [{ cards: [], stood: false, busted: false }];
    p.roundResult = '';
    p.roundResultText = '';
  }
  dealer.hands = [{ cards: [], stood: false, busted: false }];
  currentPlayerIndex = 0;
  currentHandIndex = 0;
  gamePhase = 'betting';

  // Remove busted bots
  players = players.filter((p, i) => i === 0 || p.chips > 0);

  // Check if player is busted
  if (players[0].chips <= 0) {
    showGameOver();
    return;
  }

  // Clamp bet to chips
  selectedBet = Math.min(selectedBet, players[0].chips);
  document.getElementById('betAmount').textContent = selectedBet;

  render();
  document.getElementById('betOverlay').classList.add('show');
  document.getElementById('resultsOverlay').classList.remove('show');
  updateBetButtons();
}

function updateBetButtons() {
  document.querySelectorAll('.bet-btn').forEach(btn => {
    const val = btn.dataset.bet;
    if (val === 'all') {
      btn.classList.toggle('active', selectedBet === players[0].chips);
    } else {
      btn.classList.toggle('active', selectedBet === parseInt(val));
    }
  });
}

async function dealInitial() {
  // Deal 2 cards to each player and dealer, one at a time
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < players.length; i++) {
      players[i].hands[0].cards.push(drawCard());
      render();
      await delay(150);
    }
    dealer.hands[0].cards.push(drawCard());
    render();
    await delay(150);
  }

  // Check for dealer blackjack
  if (isBlackjack(dealer.hands[0])) {
    gamePhase = 'results';
    resolveRound();
    return;
  }

  // Check for player blackjacks — bots auto-stand
  for (let i = 1; i < players.length; i++) {
    if (isBlackjack(players[i].hands[0])) {
      players[i].hands[0].stood = true;
    }
  }

  // Start play
  gamePhase = 'playing';
  currentPlayerIndex = 0;
  currentHandIndex = 0;

  if (isBlackjack(players[0].hands[0])) {
    players[0].hands[0].stood = true;
    nextTurn();
  } else {
    render();
  }
}

function nextTurn() {
  const p = players[currentPlayerIndex];
  const hand = p.hands[currentHandIndex];

  // If current hand is done, move to next hand or next player
  if (hand.stood || hand.busted) {
    if (currentHandIndex < p.hands.length - 1) {
      currentHandIndex++;
      render();
      if (p.isBot) playBotTurn();
      return;
    }
    currentPlayerIndex++;
    currentHandIndex = 0;

    if (currentPlayerIndex >= players.length) {
      playDealerTurn();
      return;
    }

    const next = players[currentPlayerIndex];
    if (isBlackjack(next.hands[0])) {
      next.hands[0].stood = true;
      nextTurn();
      return;
    }

    render();
    if (next.isBot) playBotTurn();
    return;
  }

  render();
  if (p.isBot) playBotTurn();
}

// ── Player Actions ──
function hit() {
  if (gamePhase !== 'playing' || currentPlayerIndex !== 0) return;
  const hand = players[0].hands[currentHandIndex];
  hand.cards.push(drawCard());
  if (isBusted(hand)) hand.busted = true;
  if (handValue(hand.cards).total === 21) hand.stood = true;
  if (hand.busted || hand.stood) {
    render();
    setTimeout(() => nextTurn(), 400);
  } else {
    render();
  }
}

function stand() {
  if (gamePhase !== 'playing' || currentPlayerIndex !== 0) return;
  players[0].hands[currentHandIndex].stood = true;
  render();
  setTimeout(() => nextTurn(), 300);
}

function doubleDown() {
  if (gamePhase !== 'playing' || currentPlayerIndex !== 0) return;
  const me = players[0];
  const hand = me.hands[currentHandIndex];
  if (!canDouble(hand, me.chips, me.bet)) return;
  me.chips -= me.bet;
  me.bet *= 2;
  hand.cards.push(drawCard());
  if (isBusted(hand)) hand.busted = true;
  hand.stood = true;
  hand.doubled = true;
  render();
  setTimeout(() => nextTurn(), 400);
}

function splitHand() {
  if (gamePhase !== 'playing' || currentPlayerIndex !== 0) return;
  const me = players[0];
  const hand = me.hands[currentHandIndex];
  if (!canSplit(hand, me.chips, me.bet)) return;

  const card2 = hand.cards.pop();
  hand.split = true;
  const newHand = { cards: [card2], stood: false, busted: false, split: true };

  // Deal one card to each split hand
  hand.cards.push(drawCard());
  newHand.cards.push(drawCard());

  me.hands.splice(currentHandIndex + 1, 0, newHand);
  me.chips -= me.bet; // additional bet for split hand

  // If split aces, only one card each, stand both
  if (bjValue(hand.cards[0]) === 11) {
    hand.stood = true;
    newHand.stood = true;
    render();
    setTimeout(() => nextTurn(), 400);
    return;
  }

  if (handValue(hand.cards).total === 21) hand.stood = true;
  render();
  if (hand.stood) setTimeout(() => nextTurn(), 300);
}

// ── Bot AI ──
async function playBotTurn() {
  const p = players[currentPlayerIndex];
  const hand = p.hands[currentHandIndex];
  const dealerUp = bjValue(dealer.hands[0].cards[0]);

  await delay(500);

  while (!hand.stood && !hand.busted) {
    const action = basicStrategy(hand, dealerUp, p.chips, p.bet);

    if (action === 'hit') {
      hand.cards.push(drawCard());
      if (isBusted(hand)) hand.busted = true;
      if (handValue(hand.cards).total === 21) hand.stood = true;
    } else if (action === 'double') {
      p.chips -= p.bet;
      p.bet *= 2;
      hand.cards.push(drawCard());
      if (isBusted(hand)) hand.busted = true;
      hand.stood = true;
      hand.doubled = true;
    } else if (action === 'split' && canSplit(hand, p.chips, p.bet)) {
      const card2 = hand.cards.pop();
      hand.split = true;
      const newHand = { cards: [card2], stood: false, busted: false, split: true };
      hand.cards.push(drawCard());
      newHand.cards.push(drawCard());
      p.hands.splice(currentHandIndex + 1, 0, newHand);
      p.chips -= p.bet;
      if (bjValue(hand.cards[0]) === 11) {
        hand.stood = true;
        newHand.stood = true;
      }
      if (handValue(hand.cards).total === 21) hand.stood = true;
    } else {
      hand.stood = true;
    }

    render();
    await delay(400);
  }

  nextTurn();
}

function basicStrategy(hand, dealerUp, chips, bet) {
  const v = handValue(hand.cards);
  const total = v.total;
  const soft = v.soft;
  const canDbl = hand.cards.length === 2 && chips >= bet;
  const canSpl = canSplit(hand, chips, bet);

  // Pairs
  if (canSpl) {
    const pairVal = bjValue(hand.cards[0]);
    if (pairVal === 11 || pairVal === 8) return 'split';
    if (pairVal === 10 || pairVal === 5) { /* don't split */ }
    else if (pairVal === 9) {
      if (dealerUp !== 7 && dealerUp <= 9) return 'split';
    } else if (pairVal === 7 || pairVal === 6 || pairVal === 3 || pairVal === 2) {
      if (dealerUp >= 2 && dealerUp <= 7) return 'split';
    } else if (pairVal === 4) {
      if (dealerUp === 5 || dealerUp === 6) return 'split';
    }
  }

  // Soft hands
  if (soft) {
    if (total >= 19) return 'stand';
    if (total === 18) {
      if (dealerUp >= 9) return 'hit';
      if (dealerUp >= 3 && dealerUp <= 6 && canDbl) return 'double';
      return 'stand';
    }
    if (total === 17) {
      if (dealerUp >= 3 && dealerUp <= 6 && canDbl) return 'double';
      return 'hit';
    }
    if (total >= 15 && total <= 16) {
      if (dealerUp >= 4 && dealerUp <= 6 && canDbl) return 'double';
      return 'hit';
    }
    if (total >= 13 && total <= 14) {
      if (dealerUp >= 5 && dealerUp <= 6 && canDbl) return 'double';
      return 'hit';
    }
    return 'hit';
  }

  // Hard hands
  if (total >= 17) return 'stand';
  if (total >= 13 && total <= 16) {
    return dealerUp >= 2 && dealerUp <= 6 ? 'stand' : 'hit';
  }
  if (total === 12) {
    return dealerUp >= 4 && dealerUp <= 6 ? 'stand' : 'hit';
  }
  if (total === 11) return canDbl ? 'double' : 'hit';
  if (total === 10) {
    return (dealerUp >= 2 && dealerUp <= 9 && canDbl) ? 'double' : 'hit';
  }
  if (total === 9) {
    return (dealerUp >= 3 && dealerUp <= 6 && canDbl) ? 'double' : 'hit';
  }
  return 'hit';
}

// ── Dealer Turn ──
async function playDealerTurn() {
  gamePhase = 'dealer-turn';
  render(); // reveals hole card

  await delay(600);

  // Check if all players busted
  const allBusted = players.every(p => p.hands.every(h => h.busted));
  if (!allBusted) {
    while (true) {
      const v = handValue(dealer.hands[0].cards);
      if (v.total > 21) { dealer.hands[0].busted = true; break; }
      // Dealer hits on soft 17
      if (v.total < 17 || (v.total === 17 && v.soft)) {
        dealer.hands[0].cards.push(drawCard());
        render();
        await delay(500);
      } else {
        break;
      }
    }
  }

  dealer.hands[0].stood = true;
  gamePhase = 'results';
  resolveRound();
}


function showResults() {
  const dv = handValue(dealer.hands[0].cards).total;
  const dealerBust = dealer.hands[0].busted;

  let body = '';
  body += `<div class="results-row"><span class="rname" style="color:var(--muted);">Dealer</span><span style="color:var(--amber);">${dealerBust ? 'BUST (' + dv + ')' : dv}</span></div>`;

  for (const p of players) {
    const chipClass = p.roundResult === 'win' || p.roundResult === 'blackjack' ? 'pos' :
                      p.roundResult === 'lose' ? 'neg' : 'zero';
    body += `<div class="results-row">
      <span class="rname">${p.name}</span>
      <span><span class="rtag ${p.roundResult}">${p.roundResultText}</span> <span class="rchips ${chipClass}">${p.chips} chips</span></span>
    </div>`;
  }

  document.getElementById('resultsBody').innerHTML = body;
  document.getElementById('resultsOverlay').classList.add('show');

  // Disable play again if player is broke
  document.getElementById('btnAgain').style.display = players[0].chips > 0 ? '' : 'none';
}

function showGameOver() {
  document.getElementById('resultsTitle').textContent = 'Game Over';
  document.getElementById('resultsBody').innerHTML = `<div style="color:var(--red);font-family:'Courier New',monospace;font-size:1rem;padding:16px 0;">You're out of chips!</div>`;
  document.getElementById('btnAgain').style.display = 'none';
  document.getElementById('resultsOverlay').classList.add('show');
}

// ── Helpers ──
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1500);
}

// ── Event Listeners ──
document.getElementById('btnStart').addEventListener('click', startGame);
document.getElementById('btnHit').addEventListener('click', hit);
document.getElementById('btnStand').addEventListener('click', stand);
document.getElementById('btnDouble').addEventListener('click', doubleDown);
document.getElementById('btnSplit').addEventListener('click', splitHand);

document.getElementById('btnDeal').addEventListener('click', () => placeBet());

document.getElementById('btnAgain').addEventListener('click', () => startBetting());
document.getElementById('btnNew').addEventListener('click', () => {
  document.getElementById('resultsOverlay').classList.remove('show');
  document.getElementById('gameBoard').style.display = 'none';
  document.getElementById('setupScreen').style.display = 'flex';
  gamePhase = 'setup';
});

// Bet buttons
document.querySelectorAll('.bet-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const val = btn.dataset.bet;
    if (val === 'all') {
      selectedBet = players[0].chips;
    } else {
      selectedBet = Math.min(parseInt(val), players[0].chips);
    }
    document.getElementById('betAmount').textContent = selectedBet;
    updateBetButtons();
  });
});

// Settings
document.getElementById('logoWrap').addEventListener('click', (e) => {
  e.stopPropagation();
  document.getElementById('settingsDropdown').classList.toggle('open');
});
document.addEventListener('click', () => {
  document.getElementById('settingsDropdown').classList.remove('open');
});
// Theme
initTheme();

// ── Bet & Chip Logic ──
function placeBet() {
  const me = players[0];
  me.bet = selectedBet;

  // Bots auto-bet
  for (let i = 1; i < players.length; i++) {
    const bot = players[i];
    const maxBet = Math.min(100, bot.chips);
    bot.bet = Math.max(10, Math.min(maxBet, Math.floor(Math.random() * 5 + 1) * 10));
  }

  // Deduct bets from all players
  for (const p of players) {
    p.chips -= p.bet;
  }

  document.getElementById('betOverlay').classList.remove('show');
  gamePhase = 'dealing';
  dealInitial();
}

// ── Round Resolution ──
function resolveRound() {
  const dv = handValue(dealer.hands[0].cards).total;
  const dealerBJ = isBlackjack(dealer.hands[0]);
  const dealerBust = dealer.hands[0].busted;

  for (const p of players) {
    let totalReturn = 0;
    const betPerHand = p.hands.length > 1 ? p.bet / p.hands.length : p.bet;

    for (const hand of p.hands) {
      const pv = handValue(hand.cards).total;
      const playerBJ = isBlackjack(hand) && !hand.split;
      const hBet = hand.doubled ? betPerHand * 2 : betPerHand;

      if (hand.busted) {
        // lose — nothing returned
      } else if (playerBJ && dealerBJ) {
        totalReturn += hBet; // push
        p.roundResult = 'push'; p.roundResultText = 'PUSH';
      } else if (playerBJ) {
        totalReturn += hBet + Math.floor(hBet * 1.5); // 3:2
        p.roundResult = 'blackjack'; p.roundResultText = 'BLACKJACK!';
      } else if (dealerBJ) {
        // lose
        p.roundResult = 'lose'; p.roundResultText = 'LOSE';
      } else if (dealerBust) {
        totalReturn += hBet * 2;
        p.roundResult = 'win'; p.roundResultText = 'WIN';
      } else if (pv > dv) {
        totalReturn += hBet * 2;
        p.roundResult = 'win'; p.roundResultText = 'WIN';
      } else if (pv === dv) {
        totalReturn += hBet;
        p.roundResult = 'push'; p.roundResultText = 'PUSH';
      } else {
        p.roundResult = 'lose'; p.roundResultText = 'LOSE';
      }
    }

    p.chips += totalReturn;
  }

  render();
  showResults();
}
