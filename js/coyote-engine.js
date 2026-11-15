// ============================================================
// play27 — Coyote rules engine
// Pure game logic, no DOM. Used by coyote.html and by the
// simulation script (tools/coyote-sim.mjs) under Node.
// Rules: COYOTE.md (spec v2).
//
// Every decision goes through a controller (human UI or AI),
// one per seat. Controller methods may be async:
//   chooseAction(game, me)                      -> { cardId, target?, targets?, kitId? } | { type:'end' }
//   chooseDark(game, me, { count, forced, canFaceUp }) -> { cardIds:[], faceUp:bool }
//   respondSnap(game, me, attacker, { canDodge, canBristle }) -> 'dodge' | 'bristle' | 'none'
//   joinHowl(game, me, target)                  -> cardId | null
//   chooseDiscard(game, me, n)                  -> [cardId]
//   crowChoice(game, me, card)                  -> 'drop' | 'discard'
//   tinyCharge(game, me, attacker)              -> cardId | null
//   woollySave(game, me, lost)                  -> bool
//   dukePick(game, me)                          -> seat | null
//   lastShot(game, me)                          -> seat | null   (Hunter, when knocked out)
//   bootsCount(game, me)                        -> 0 | 1 | 2
//   observe(game, event)                        (optional, sync)
// ============================================================

export const ICONS = ['moon', 'lantern', 'blank'];

// icons = [moon, lantern, blank] counts. 60 cards total.
export const CARD_TYPES = {
  snap:      { name: 'Snap!',     group: 'Fighting', icons: [7, 3, 7], text: 'A player in range loses 1 life unless they Dodge!. One per turn.' },
  dodge:     { name: 'Dodge!',    group: 'Fighting', icons: [3, 3, 4], text: 'Cancel a Snap! aimed at you. Not while you are in the Hayloft.', reaction: true },
  bristle:   { name: 'Bristle',   group: 'Fighting', icons: [1, 0, 1], text: 'When a Snap! targets you: cancel it, and the attacker loses 1 life.', reaction: true },
  packhowl:  { name: 'Pack Howl', group: 'Fighting', icons: [1, 0, 1], text: 'Name a player. Every other living player, clockwise from you, may Snap! them, ignoring range.' },
  frenzy:    { name: 'Frenzy',    group: 'Fighting', icons: [0, 1, 0], text: 'You may play up to 2 more Snap!s this turn.' },
  mend:      { name: 'Mend',      group: 'Care',     icons: [2, 2, 1], text: 'You or a player at distance 1 regains 1 life.' },
  roundup:   { name: 'Round Up',  group: 'Care',     icons: [2, 0, 0], text: 'Move 1 sheep from the den back to the pen.' },
  forage:    { name: 'Forage',    group: 'Tricks',   icons: [1, 1, 1], text: 'Draw 3 cards, then put 1 card from your hand in the Dark pile.' },
  swipe:     { name: 'Swipe',     group: 'Tricks',   icons: [2, 0, 1], text: 'Take a random card from the hand of a player in range.' },
  spook:     { name: 'Spook',     group: 'Tricks',   icons: [1, 0, 2], text: 'A player discards a kit card of your choice, or a random card if they have no kit.' },
  bell:      { name: 'Bell',      group: 'Finding',  icons: [2, 0, 1], text: 'Hang it on another player. Their next Dark card goes in face up.' },
  sniff:     { name: 'Sniff',     group: 'Finding',  icons: [1, 0, 1], text: "Look at 2 random cards in a player's hand." },
  headcount: { name: 'Headcount', group: 'Finding',  icons: [1, 0, 0], text: 'See the icons in the Dark pile so far tonight (not who put them in).' },
  hayloft:   { name: 'Hayloft',   group: 'Kit', kit: true, icons: [0, 1, 1], text: 'Kit. +1 range. You cannot Dodge! while up here.' },
  thicket:   { name: 'Thicket',   group: 'Kit', kit: true, icons: [0, 1, 1], text: 'Kit. The next Snap! that would cost you a life costs nothing. Then discard it.' },
  lantern:   { name: 'Lantern',   group: 'Kit', kit: true, icons: [0, 2, 0], text: 'Kit. Adds a lantern to every reveal. Discard it when you lose a life.' },
};
export const KIT_TYPES = ['hayloft', 'thicket', 'lantern'];

export const CHARACTERS = [
  { id: 'oldblue',    name: 'Old Blue',   animal: 'hound',      lives: 3, ability: 'Nose for trouble', text: 'Once per night, before the reveal, see one face-down card in the Dark pile and who put it in.' },
  { id: 'mabel',      name: 'Mabel',      animal: 'goose',      lives: 3, ability: 'Hiss',             text: 'When you Dodge! a Snap!, the attacker discards a random card.' },
  { id: 'woolly',     name: 'Woolly',     animal: 'ram',        lives: 3, ability: 'Hold the gate',    text: 'Once per night, when the reveal would cost a sheep, you may lose 1 life to save it.' },
  { id: 'clementine', name: 'Clementine', animal: 'dairy cow',  lives: 3, ability: 'Warm milk',        text: 'Your Mend restores 2 lives, split between you and players at distance 1.' },
  { id: 'tiny',       name: 'Tiny',       animal: 'bull',       lives: 3, ability: 'Charge',           text: 'When a Snap! costs you a life, you may Snap! the attacker back at once, ignoring range.' },
  { id: 'duke',       name: 'Duke',       animal: 'rooster',    lives: 2, ability: 'Wake-up call',     text: 'At the start of each night, pick another player. Their Dark cards tonight go in face up.' },
  { id: 'hazel',      name: 'Hazel',      animal: 'barn owl',   lives: 2, ability: 'Watchful',         text: 'You may put your Dark card in face up. If you do, draw 1 card.' },
  { id: 'boots',      name: 'Boots',      animal: 'barn cat',   lives: 2, ability: 'Prowler',          text: 'Put 0 or 2 cards in the Dark pile instead of 1.' },
];

// Spec v2.2, tuned 2026-11-14 with tools/coyote-sim.mjs (Normal AI on both sides):
// coyotes win 43-53% at every count. See COYOTE.md "Tuning log".
export const ROLE_TABLE = {
  4: { shepherd: 1, farmhand: 1, hunter: 0, coyote: 2, fox: 0, den: 7,  nights: 7 },
  5: { shepherd: 1, farmhand: 1, hunter: 1, coyote: 2, fox: 0, den: 3,  nights: 7 },
  6: { shepherd: 1, farmhand: 1, hunter: 1, coyote: 2, fox: 1, den: 4,  nights: 7 },
  7: { shepherd: 1, farmhand: 1, hunter: 1, coyote: 3, fox: 1, den: 11, nights: 6 },
};

export const ROLE_INFO = {
  shepherd: { name: 'Shepherd', team: 'flock',  goal: 'Survive to dawn, or knock out every Coyote. Everyone knows you.' },
  farmhand: { name: 'Farmhand', team: 'flock',  goal: 'Keep the Shepherd alive and the sheep out of the den. Find the Coyotes.' },
  hunter:   { name: 'Hunter',   team: 'flock',  goal: 'Hidden on the flock side. Long gun: once a night, Snap! at any distance (it reveals you). Last shot: when knocked out, Snap! anyone.' },
  coyote:   { name: 'Coyote',   team: 'coyote', goal: 'Knock out the Shepherd, or get enough sheep into the den before dawn.' },
  fox:      { name: 'Fox',      team: 'fox',    goal: 'Be alive at the end having knocked out a player. You win alongside whoever wins.' },
};

export const DEFAULTS = {
  nights: null,        // null = from ROLE_TABLE
  startHand: 4,
  handLimit: 5,
  draw: 2,
  coyotesKnow: true,   // coyotes know each other (a pack)
  foxKills: 1,
  shepherdBonus: 1,    // extra lives for the Shepherd
  bounty: 1,           // sheep that come home from the den when a Coyote is knocked out
  lifeDelta: 0,        // added to every character's lives (tuning)
  denTarget: null,     // null = from ROLE_TABLE (or denTargets[n])
  denTargets: null,    // { 4: n, 5: n, ... } override for tuning
  lanternsPerMoon: 2,  // how many lanterns it takes to cancel one moon
  roleTable: null,     // { 7: { shepherd, farmhand, hunter, coyote, fox, den } } override for tuning
  debug: false,        // check card conservation after every turn
};

// ── RNG helpers ──
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleWith(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function buildDeck() {
  const deck = [];
  let id = 1;
  for (const [type, def] of Object.entries(CARD_TYPES)) {
    def.icons.forEach((count, i) => {
      for (let k = 0; k < count; k++) deck.push({ id: id++, type, icon: ICONS[i] });
    });
  }
  return deck;
}
export const DECK_SIZE = buildDeck().length;

export function cardName(c) {
  return c.type === 'crook' ? 'Crook' : CARD_TYPES[c.type].name;
}

// ============================================================
export class CoyoteGame {
  constructor({ numPlayers, names = null, controllers, rng = Math.random, options = {}, onEvent = null, forceRole = null }) {
    if (!ROLE_TABLE[numPlayers]) throw new Error('Coyote needs 4 to 7 players');
    this.n = numPlayers;
    this.rng = rng;
    this.opt = { ...DEFAULTS, ...options };
    const table = this.opt.roleTable?.[numPlayers] ?? ROLE_TABLE[numPlayers];
    // Public: everyone knows how many of each role are in the game.
    this.roleCounts = Object.fromEntries(['shepherd', 'farmhand', 'hunter', 'coyote', 'fox'].map(r => [r, table[r] || 0]));
    this.denTarget = this.opt.denTarget ?? this.opt.denTargets?.[numPlayers] ?? table.den;
    this.opt.nights = this.opt.nights ?? table.nights ?? 6;
    this.controllers = controllers;
    controllers.forEach((c, i) => { if (c) c.seat = i; });
    this.onEvent = onEvent;
    this.log = [];
    this.night = 0;
    this.den = 0;
    this.dark = [];          // { card, by, faceUp }
    this.dukeTarget = null;
    this.turnSeat = null;
    this.phase = 'setup';    // setup | night-start | day | dark | rest | reveal | over
    this.over = false;
    this.result = null;
    this.deck = shuffleWith(buildDeck(), rng);
    this.discard = [];
    this.stats = { reshuffles: 0, snaps: 0, dodges: 0, knockouts: 0, sheepLost: 0, sheepSaved: 0, invalid: 0 };

    let roles = [];
    for (const r of ['shepherd', 'farmhand', 'hunter', 'coyote', 'fox']) for (let i = 0; i < (table[r] || 0); i++) roles.push(r);
    roles = shuffleWith(roles, rng);
    if (forceRole) {
      const idx = roles.indexOf(forceRole);
      if (idx > 0) [roles[0], roles[idx]] = [roles[idx], roles[0]];
    }
    const chars = shuffleWith([...CHARACTERS], rng);
    this.players = roles.map((role, seat) => {
      const ch = chars[seat];
      const max = Math.max(1, ch.lives + this.opt.lifeDelta) + (role === 'shepherd' ? this.opt.shepherdBonus : 0);
      return {
        seat, role, character: ch,
        name: names?.[seat] ?? ch.name,
        maxLives: max, lives: max,
        hand: [],
        kits: role === 'shepherd' ? [{ id: 0, type: 'crook', icon: 'blank' }] : [],
        crow: false, revealed: role === 'shepherd',
        kills: 0, bell: false, snapsLeft: 0, longGunNight: 0,
      };
    });
    this.shepherdSeat = this.players.find(p => p.role === 'shepherd').seat;
    for (const p of this.players) this.drawTo(p, this.opt.startHand);
  }

  // ── Queries ──
  ctrl(p) { return this.controllers[p.seat]; }
  alive() { return this.players.filter(p => !p.crow); }
  hasKit(p, type) { return p.kits.some(k => k.type === type); }
  ownKits(p) { return p.kits.filter(k => k.type !== 'crook'); }
  range(p) { return 1 + (this.hasKit(p, 'crook') ? 1 : 0) + (this.hasKit(p, 'hayloft') ? 1 : 0); }
  team(p) { return ROLE_INFO[p.role].team; }

  distance(a, b) {
    const A = typeof a === 'number' ? a : a.seat;
    const B = typeof b === 'number' ? b : b.seat;
    if (A === B) return 0;
    const counts = s => !this.players[s].crow || s === A || s === B;
    let cw = 0, s = A;
    while (s !== B) { s = (s + 1) % this.n; if (counts(s)) cw++; }
    let total = 0;
    for (let i = 0; i < this.n; i++) if (counts(i)) total++;
    return Math.min(cw, total - cw);
  }

  // Hunter: once per night, a Snap! at any distance (reveals the Hunter).
  hasLongGun(p) {
    return p.role === 'hunter' && !p.crow && p.longGunNight !== this.night;
  }

  inRange(a, b) {
    return a !== b && !a.crow && !b.crow && this.distance(a, b) <= this.range(a);
  }

  turnOrder() {
    return Array.from({ length: this.n }, (_, i) => (this.shepherdSeat + i) % this.n);
  }

  // What `viewer` legitimately knows about `target`'s role.
  knownRole(viewer, target) {
    if (viewer === target || target.revealed) return target.role;
    if (this.opt.coyotesKnow && viewer.role === 'coyote' && target.role === 'coyote') return 'coyote';
    return null;
  }

  lanternKits() {
    return this.alive().filter(p => this.hasKit(p, 'lantern')).length;
  }

  // ── Cards ──
  drawOne() {
    if (!this.deck.length && this.discard.length) {
      this.deck = shuffleWith(this.discard, this.rng);
      this.discard = [];
      this.stats.reshuffles++;
    }
    return this.deck.pop() || null;
  }

  drawTo(p, k) {
    const got = [];
    for (let i = 0; i < k; i++) {
      const c = this.drawOne();
      if (!c) break;
      p.hand.push(c);
      got.push(c);
    }
    return got;
  }

  removeFromHand(p, cardId) {
    const i = p.hand.findIndex(c => c.id === cardId);
    return i < 0 ? null : p.hand.splice(i, 1)[0];
  }

  randomFromHand(p) {
    if (!p.hand.length) return null;
    return p.hand.splice(Math.floor(this.rng() * p.hand.length), 1)[0];
  }

  // ── Events ──
  async emit(type, data = {}, visibleTo = null) {
    const ev = { i: this.log.length, night: this.night, type, visibleTo, ...data };
    this.log.push(ev);
    for (const c of this.controllers) {
      if (c && c.observe && (!visibleTo || visibleTo.includes(c.seat))) c.observe(this, ev);
    }
    if (this.onEvent) await this.onEvent(ev);
    return ev;
  }

  // ── Main loop ──
  async run() {
    await this.emit('start', { text: `The sun sets on ${this.n} animals. The Shepherd is ${this.players[this.shepherdSeat].name}.` });
    for (let night = 1; night <= this.opt.nights; night++) {
      this.night = night;
      await this.startNight();
      for (const seat of this.turnOrder()) {
        if (this.over) break;
        if (this.players[seat].crow) continue;
        await this.takeTurn(this.players[seat]);
      }
      if (this.over) break;
      await this.reveal();
      if (this.over) break;
    }
    if (!this.over) await this.finish('flock', 'dawn');
    return this.result;
  }

  async startNight() {
    this.phase = 'night-start';
    this.dark = [];
    this.dukeTarget = null;
    await this.emit('night', { text: `Night ${this.night} of ${this.opt.nights} falls.` });

    for (const seat of this.turnOrder()) {
      const p = this.players[seat];
      if (!p.crow) continue;
      const card = this.drawOne();
      if (!card) continue;
      await this.emit('crow-draw', { by: seat, cardType: card.type, icon: card.icon, text: `You draw ${cardName(card)} (${card.icon}).` }, [seat]);
      const choice = await this.ctrl(p).crowChoice(this, p, card);
      if (choice === 'drop') {
        this.dark.push({ card, by: seat, faceUp: false, crow: true });
        await this.emit('crow-drop', { by: seat, text: `${p.name} (crow) drops a card into the Dark pile.` });
      } else {
        this.discard.push(card);
        await this.emit('crow-pass', { by: seat, text: `${p.name} (crow) circles and drops nothing.` });
      }
    }

    const duke = this.alive().find(p => p.character.id === 'duke');
    if (duke) {
      const pick = await this.ctrl(duke).dukePick(this, duke);
      const t = this.players[pick];
      if (t && t !== duke && !t.crow) {
        this.dukeTarget = t.seat;
        await this.emit('duke', { by: duke.seat, target: t.seat, text: `${duke.name} crows at ${t.name}: their Dark cards tonight go in face up.` });
      }
    }
  }

  async takeTurn(p) {
    this.turnSeat = p.seat;
    p.snapsLeft = 1;
    this.phase = 'day';
    await this.emit('turn', { by: p.seat, text: `${p.name}'s turn.` });
    const got = this.drawTo(p, this.opt.draw);
    await this.emit('draw', { by: p.seat, count: got.length, text: `${p.name} draws ${got.length}.` });
    if (got.length) {
      await this.emit('draw-private', { by: p.seat, text: `You draw ${got.map(cardName).join(' and ')}.` }, [p.seat]);
    }

    let invalid = 0;
    while (!this.over && !p.crow) {
      const act = await this.ctrl(p).chooseAction(this, p);
      if (!act || act.type === 'end') break;
      const ok = await this.playCard(p, act);
      if (!ok) {
        this.stats.invalid++;
        if (++invalid >= 3) break;
      }
    }
    if (this.over || p.crow) return this.endTurn(p);

    this.phase = 'dark';
    await this.darkStep(p);
    if (this.over || p.crow) return this.endTurn(p);

    this.phase = 'rest';
    const extra = p.hand.length - this.opt.handLimit;
    if (extra > 0) {
      let ids = await this.ctrl(p).chooseDiscard(this, p, extra);
      ids = Array.isArray(ids) ? ids.filter(id => p.hand.some(c => c.id === id)) : [];
      ids = [...new Set(ids)].slice(0, extra);
      while (ids.length < extra) {
        const left = p.hand.filter(c => !ids.includes(c.id));
        ids.push(left[Math.floor(this.rng() * left.length)].id);
      }
      for (const id of ids) this.discard.push(this.removeFromHand(p, id));
      await this.emit('rest', { by: p.seat, count: extra, text: `${p.name} discards ${extra} to rest.` });
    }
    return this.endTurn(p);
  }

  endTurn(p) {
    this.turnSeat = null;
    if (this.opt.debug) this.checkInvariants();
  }

  // ── Playing cards ──
  // Returns { ok, reason?, targets?: [seat] } for the UI and AI.
  playOptions(p, card) {
    const no = reason => ({ ok: false, reason });
    if (this.over || p.crow) return no('Not now.');
    const others = this.alive().filter(q => q !== p);
    const seats = list => list.map(q => q.seat);
    const t = card.type;
    if (CARD_TYPES[t].kit) {
      if (this.hasKit(p, t)) return no(`You already have a ${CARD_TYPES[t].name}.`);
      if (this.ownKits(p).length >= 2) return no('You already have 2 kit cards.');
      return { ok: true };
    }
    switch (t) {
      case 'dodge':
      case 'bristle':
        return no('You play this when someone Snaps at you.');
      case 'snap': {
        if (p.snapsLeft <= 0) return no('You have already Snapped this turn.');
        const ts = this.hasLongGun(p) ? others : others.filter(q => this.inRange(p, q));
        return ts.length ? { ok: true, targets: seats(ts) } : no('Nobody is in range.');
      }
      case 'packhowl':
        return others.length ? { ok: true, targets: seats(others) } : no('Nobody to howl at.');
      case 'frenzy':
        return { ok: true };
      case 'mend': {
        const ts = [p, ...others.filter(q => this.distance(p, q) === 1)].filter(q => q.lives < q.maxLives);
        return ts.length ? { ok: true, targets: seats(ts) } : no('Nobody nearby is hurt.');
      }
      case 'roundup':
        return this.den > 0 ? { ok: true } : no('The den is empty.');
      case 'forage':
        return { ok: true };
      case 'swipe': {
        const ts = others.filter(q => this.inRange(p, q) && q.hand.length);
        return ts.length ? { ok: true, targets: seats(ts) } : no('Nobody in range has cards.');
      }
      case 'spook': {
        const ts = others.filter(q => this.ownKits(q).length || q.hand.length);
        return ts.length ? { ok: true, targets: seats(ts) } : no('Nobody has anything to lose.');
      }
      case 'bell': {
        const ts = others.filter(q => !q.bell);
        return ts.length ? { ok: true, targets: seats(ts) } : no('Everyone already has a Bell.');
      }
      case 'sniff': {
        const ts = others.filter(q => q.hand.length);
        return ts.length ? { ok: true, targets: seats(ts) } : no('Nobody has cards.');
      }
      case 'headcount':
        return { ok: true };
    }
    return no('Unknown card.');
  }

  async playCard(p, act) {
    const card = p.hand.find(c => c.id === act.cardId);
    if (!card) return false;
    const opt = this.playOptions(p, card);
    if (!opt.ok) return false;

    let target = null;
    let mendTargets = null;
    if (card.type === 'mend' && p.character.id === 'clementine') {
      const allowed = [p, ...this.alive().filter(q => q !== p && this.distance(p, q) === 1)].map(q => q.seat);
      const picks = (act.targets ?? [act.target]).filter(s => allowed.includes(s)).slice(0, 2);
      if (!picks.length) return false;
      mendTargets = picks.map(s => this.players[s]);
    } else if (opt.targets) {
      if (!opt.targets.includes(act.target)) return false;
      target = this.players[act.target];
    }
    if (card.type === 'spook' && act.kitId != null && !this.ownKits(target).some(k => k.id === act.kitId)) return false;

    this.removeFromHand(p, card.id);
    const name = CARD_TYPES[card.type].name;

    if (CARD_TYPES[card.type].kit) {
      p.kits.push(card);
      await this.emit('kit', { by: p.seat, cardType: card.type, text: `${p.name} puts a ${name} in play.` });
      return true;
    }
    this.discard.push(card);

    switch (card.type) {
      case 'snap':
        p.snapsLeft--;
        if (!this.inRange(p, target)) {
          p.longGunNight = this.night;
          const first = !p.revealed;
          p.revealed = true;
          await this.emit('longshot', { by: p.seat, target: target.seat, text: first ? `${p.name} raises a long gun. ${p.name} is the Hunter!` : `${p.name} the Hunter takes a long shot.` });
        }
        await this.snap(p, target, {});
        break;

      case 'frenzy':
        p.snapsLeft += 2;
        await this.emit('frenzy', { by: p.seat, text: `${p.name} works into a Frenzy: 2 more Snap!s this turn.` });
        break;

      case 'packhowl': {
        await this.emit('howl', { by: p.seat, target: target.seat, text: `${p.name} starts a Pack Howl at ${target.name}!` });
        const order = Array.from({ length: this.n - 1 }, (_, i) => (p.seat + 1 + i) % this.n);
        for (const s of order) {
          if (this.over || target.crow) break;
          const q = this.players[s];
          if (q.crow || q === target) continue;
          let cid = null;
          if (q.hand.some(c => c.type === 'snap')) cid = await this.ctrl(q).joinHowl(this, q, target);
          const snapCard = cid != null ? q.hand.find(c => c.id === cid && c.type === 'snap') : null;
          if (snapCard) {
            this.removeFromHand(q, snapCard.id);
            this.discard.push(snapCard);
            await this.snap(q, target, { howl: true });
          } else {
            await this.emit('howl-hold', { by: q.seat, target: target.seat, text: `${q.name} holds back.` });
          }
        }
        break;
      }

      case 'mend': {
        const amount = mendTargets ? 2 : 1;
        const list = mendTargets ? (mendTargets.length === 1 ? [mendTargets[0], mendTargets[0]] : mendTargets) : [target];
        for (const q of list.slice(0, amount)) {
          if (q.crow || q.lives >= q.maxLives) continue;
          q.lives++;
          await this.emit('heal', { by: p.seat, target: q.seat, text: q === p ? `${p.name} mends: back to ${q.lives} lives.` : `${p.name} mends ${q.name}: back to ${q.lives} lives.` });
        }
        break;
      }

      case 'roundup':
        this.den--;
        await this.emit('roundup', { by: p.seat, text: `${p.name} rounds up a sheep from the den. Den: ${this.den}/${this.denTarget}.` });
        break;

      case 'forage': {
        const got = this.drawTo(p, 3);
        await this.emit('forage', { by: p.seat, text: `${p.name} forages: draws ${got.length}, and must put 1 card in the Dark pile.` });
        if (got.length) await this.emit('draw-private', { by: p.seat, text: `You draw ${got.map(cardName).join(', ')}.` }, [p.seat]);
        if (p.hand.length) {
          const pick = await this.ctrl(p).chooseDark(this, p, { count: 1, forced: this.isForcedFaceUp(p), canFaceUp: p.character.id === 'hazel', forage: true });
          let id = pick?.cardIds?.find(cid => p.hand.some(c => c.id === cid));
          if (id == null) id = p.hand[0].id;
          await this.placeDark(p, this.removeFromHand(p, id), !!pick?.faceUp, 'forage');
        }
        break;
      }

      case 'swipe': {
        const c = this.randomFromHand(target);
        p.hand.push(c);
        await this.emit('swipe', { by: p.seat, target: target.seat, text: `${p.name} swipes a card from ${target.name}.` });
        await this.emit('swipe-private', { by: p.seat, text: `You took ${cardName(c)} (${c.icon}).` }, [p.seat]);
        await this.emit('swipe-private', { by: target.seat, text: `${p.name} took your ${cardName(c)}.` }, [target.seat]);
        break;
      }

      case 'spook': {
        const kits = this.ownKits(target);
        if (kits.length) {
          const kit = kits.find(k => k.id === act.kitId) || kits[0];
          target.kits = target.kits.filter(k => k !== kit);
          this.discard.push(kit);
          await this.emit('spook', { by: p.seat, target: target.seat, text: `${p.name} spooks ${target.name}: their ${cardName(kit)} is gone.` });
        } else {
          const c = this.randomFromHand(target);
          this.discard.push(c);
          await this.emit('spook', { by: p.seat, target: target.seat, text: `${p.name} spooks ${target.name}: they drop ${cardName(c)} (${c.icon}).` });
        }
        break;
      }

      case 'bell':
        target.bell = true;
        await this.emit('bell', { by: p.seat, target: target.seat, text: `${p.name} hangs a Bell on ${target.name}. Their next Dark card goes in face up.` });
        break;

      case 'sniff': {
        const pool = [...target.hand];
        shuffleWith(pool, this.rng);
        const seen = pool.slice(0, 2);
        await this.emit('sniff', { by: p.seat, target: target.seat, text: `${p.name} sniffs ${target.name}'s hand.` });
        await this.emit('sniff-private', { by: p.seat, target: target.seat, cards: seen.map(c => ({ type: c.type, icon: c.icon })), text: `${target.name} holds ${seen.map(c => `${cardName(c)} (${c.icon})`).join(' and ')}.` }, [p.seat]);
        break;
      }

      case 'headcount': {
        const icons = { moon: 0, lantern: 0, blank: 0 };
        for (const d of this.dark) icons[d.card.icon]++;
        await this.emit('headcount', { by: p.seat, text: `${p.name} counts heads in the dark.` });
        await this.emit('headcount-private', { by: p.seat, icons, text: `Dark pile so far: ${icons.moon} moon, ${icons.lantern} lantern, ${icons.blank} blank.` }, [p.seat]);
        break;
      }
    }
    return true;
  }

  // ── Combat ──
  async snap(attacker, target, { howl = false, charge = false }) {
    this.stats.snaps++;
    await this.emit('snap', { by: attacker.seat, target: target.seat, howl, charge, text: `${attacker.name} snaps at ${target.name}!` });
    const canDodge = !this.hasKit(target, 'hayloft') && target.hand.some(c => c.type === 'dodge');
    const canBristle = target.hand.some(c => c.type === 'bristle');
    let resp = 'none';
    if (canDodge || canBristle) resp = await this.ctrl(target).respondSnap(this, target, attacker, { canDodge, canBristle });

    if (resp === 'bristle' && canBristle) {
      const c = target.hand.find(x => x.type === 'bristle');
      this.discard.push(this.removeFromHand(target, c.id));
      await this.emit('bristle', { by: target.seat, target: attacker.seat, text: `${target.name} bristles! The Snap! misses and ${attacker.name} gets hurt.` });
      await this.loseLife(attacker, target, { viaSnap: false });
      return;
    }
    if (resp === 'dodge' && canDodge) {
      this.stats.dodges++;
      const c = target.hand.find(x => x.type === 'dodge');
      this.discard.push(this.removeFromHand(target, c.id));
      await this.emit('dodge', { by: target.seat, target: attacker.seat, text: `${target.name} dodges.` });
      if (target.character.id === 'mabel' && attacker.hand.length) {
        const lost = this.randomFromHand(attacker);
        this.discard.push(lost);
        await this.emit('hiss', { by: target.seat, target: attacker.seat, text: `Mabel hisses: ${attacker.name} drops ${cardName(lost)} (${lost.icon}).` });
      }
      return;
    }
    const thicket = target.kits.find(k => k.type === 'thicket');
    if (thicket) {
      target.kits = target.kits.filter(k => k !== thicket);
      this.discard.push(thicket);
      await this.emit('thicket', { by: target.seat, text: `${target.name}'s Thicket takes the hit.` });
      return;
    }
    await this.loseLife(target, attacker, { viaSnap: true, noCharge: charge });
  }

  async loseLife(p, source, { viaSnap = false, noCharge = false } = {}) {
    if (p.crow || this.over) return;
    p.lives--;
    await this.emit('hurt', { by: source?.seat ?? null, target: p.seat, text: `${p.name} loses a life (${p.lives} left).` });
    const lantern = p.kits.find(k => k.type === 'lantern');
    if (lantern) {
      p.kits = p.kits.filter(k => k !== lantern);
      this.discard.push(lantern);
      await this.emit('lantern-out', { by: p.seat, text: `${p.name}'s Lantern goes out.` });
    }
    if (p.lives <= 0) {
      await this.knockOut(p, source);
      return;
    }
    if (viaSnap && !noCharge && p.character.id === 'tiny' && source && !source.crow && p.hand.some(c => c.type === 'snap')) {
      const cid = await this.ctrl(p).tinyCharge(this, p, source);
      const c = cid != null ? p.hand.find(x => x.id === cid && x.type === 'snap') : null;
      if (c) {
        this.discard.push(this.removeFromHand(p, c.id));
        await this.emit('charge', { by: p.seat, target: source.seat, text: `Tiny charges back at ${source.name}!` });
        await this.snap(p, source, { charge: true });
      }
    }
  }

  async knockOut(p, source) {
    p.lives = 0;
    p.crow = true;
    p.revealed = true;
    p.bell = false;
    this.stats.knockouts++;
    for (const c of p.hand) this.discard.push(c);
    for (const k of p.kits) if (k.type !== 'crook') this.discard.push(k);
    p.hand = [];
    p.kits = [];
    if (source && source !== p) source.kills++;
    await this.emit('knockout', { by: source?.seat ?? null, target: p.seat, role: p.role, text: `${p.name} is knocked out and becomes a crow. They were a ${ROLE_INFO[p.role].name}.` });
    if (source && source.role === 'shepherd' && ROLE_INFO[p.role].team === 'flock') {
      this.den++;
      this.stats.sheepLost++;
      await this.emit('runoff', { text: `The Shepherd knocked out one of the flock. A sheep runs off to the den. Den: ${this.den}/${this.denTarget}.` });
    }
    if (p.role === 'coyote' && this.opt.bounty > 0 && this.den > 0) {
      const back = Math.min(this.opt.bounty, this.den);
      this.den -= back;
      this.stats.bountySheep = (this.stats.bountySheep || 0) + back;
      await this.emit('bounty', { by: source?.seat ?? null, text: `With a coyote gone, ${back === 1 ? 'a sheep finds its' : `${back} sheep find their`} way home. Den: ${this.den}/${this.denTarget}.` });
    }
    await this.checkWin();
    if (p.role === 'hunter' && !this.over) {
      const pick = await this.ctrl(p).lastShot(this, p);
      const t = this.players[pick];
      if (t && t !== p && !t.crow) {
        this.stats.lastShots = (this.stats.lastShots || 0) + 1;
        await this.emit('lastshot', { by: p.seat, target: t.seat, text: `With a last shot, the Hunter fires at ${t.name}!` });
        await this.snap(p, t, { charge: true });
      }
    }
  }

  // ── The dark ──
  isForcedFaceUp(p) {
    return p.bell || this.dukeTarget === p.seat;
  }

  async darkStep(p) {
    let count = 1;
    if (p.character.id === 'boots') {
      const c = await this.ctrl(p).bootsCount(this, p);
      count = [0, 1, 2].includes(c) ? c : 1;
    }
    if (count === 0) {
      await this.emit('dark-skip', { by: p.seat, text: `${p.name} slinks past the Dark pile (puts in nothing).` });
      return;
    }
    if (!p.hand.length) {
      const c = this.drawOne();
      if (c) await this.placeDark(p, c, false, 'deck');
      return;
    }
    count = Math.min(count, p.hand.length);
    const pick = await this.ctrl(p).chooseDark(this, p, { count, forced: this.isForcedFaceUp(p), canFaceUp: p.character.id === 'hazel' });
    let ids = (pick?.cardIds ?? []).filter(id => p.hand.some(c => c.id === id));
    ids = [...new Set(ids)].slice(0, count);
    while (ids.length < count) ids.push(p.hand.find(c => !ids.includes(c.id)).id);
    for (const id of ids) await this.placeDark(p, this.removeFromHand(p, id), !!pick?.faceUp, 'turn');
  }

  async placeDark(p, card, chooseFaceUp, source) {
    const forced = this.isForcedFaceUp(p);
    const faceUp = forced || (chooseFaceUp && p.character.id === 'hazel');
    this.dark.push({ card, by: p.seat, faceUp });
    if (p.bell) p.bell = false;
    if (faceUp) {
      await this.emit('dark', { by: p.seat, faceUp: true, cardType: card.type, icon: card.icon, source, text: `${p.name} puts ${cardName(card)} (${card.icon}) in the Dark pile, face up.` });
      if (p.character.id === 'hazel') {
        const got = this.drawTo(p, 1);
        if (got.length) await this.emit('draw-private', { by: p.seat, text: `Watchful: you draw ${cardName(got[0])}.` }, [p.seat]);
      }
    } else {
      await this.emit('dark', { by: p.seat, faceUp: false, source, text: `${p.name} puts a card in the Dark pile.` });
      await this.emit('dark-private', { by: p.seat, cardType: card.type, icon: card.icon, text: `You put ${cardName(card)} (${card.icon}) in the dark.` }, [p.seat]);
    }
  }

  async reveal() {
    this.phase = 'reveal';
    const ob = this.alive().find(p => p.character.id === 'oldblue');
    if (ob) {
      const hidden = this.dark.filter(d => !d.faceUp && d.by !== ob.seat);
      if (hidden.length) {
        const d = hidden[Math.floor(this.rng() * hidden.length)];
        const who = this.players[d.by];
        await this.emit('peek', { by: ob.seat, target: d.by, cardType: d.card.type, icon: d.card.icon, text: `Nose for trouble: ${who.name} put in ${cardName(d.card)} (${d.card.icon}).` }, [ob.seat]);
      }
    }

    shuffleWith(this.dark, this.rng);
    const icons = { moon: 0, lantern: 0, blank: 0 };
    for (const d of this.dark) icons[d.card.icon]++;
    const kitLanterns = this.lanternKits();
    let lost = Math.max(0, icons.moon - Math.floor((icons.lantern + kitLanterns) / this.opt.lanternsPerMoon));
    const wouldLose = lost;

    let saved = 0;
    const woolly = this.alive().find(p => p.character.id === 'woolly');
    if (lost > 0 && woolly && await this.ctrl(woolly).woollySave(this, woolly, lost)) {
      lost--;
      saved = 1;
      this.stats.sheepSaved++;
      await this.emit('woolly', { by: woolly.seat, text: `${woolly.name} holds the gate and saves a sheep.` });
      await this.loseLife(woolly, null);
      if (this.over) return;
    }

    this.den += lost;
    this.stats.sheepLost += lost;
    for (const d of this.dark) this.discard.push(d.card);
    const cards = this.dark.map(d => ({ type: d.card.type, icon: d.card.icon }));
    this.dark = [];
    await this.emit('reveal', {
      icons, kitLanterns, lost, wouldLose, saved, den: this.den, cards,
      text: `Reveal: ${icons.moon} moon, ${icons.lantern} lantern${kitLanterns ? ` (+${kitLanterns} Lantern kit)` : ''}, ${icons.blank} blank. ${lost ? `${lost} sheep lost` : 'No sheep lost'}. Den: ${this.den}/${this.denTarget}.`,
    });
    for (const p of this.players) p.bell = p.bell && !p.crow;
    await this.checkWin();
  }

  // ── Winning ──
  async checkWin() {
    if (this.over) return;
    const shep = this.players[this.shepherdSeat];
    if (shep.crow) return this.finish('coyote', 'shepherd');
    const coyotes = this.players.filter(p => p.role === 'coyote');
    if (coyotes.every(p => p.crow)) return this.finish('flock', 'coyotes');
    if (this.den >= this.denTarget) return this.finish('coyote', 'den');
  }

  async finish(winner, reason) {
    if (this.over) return;
    this.over = true;
    this.phase = 'over';
    this.turnSeat = null;
    const fox = this.players.find(p => p.role === 'fox');
    const foxWin = !!fox && !fox.crow && fox.kills >= this.opt.foxKills;
    for (const p of this.players) p.revealed = true;
    this.result = { winner, reason, foxWin, night: this.night, den: this.den };
    const why = {
      shepherd: 'The Shepherd has fallen. The coyotes win.',
      den: `The den holds ${this.den} sheep. The coyotes win.`,
      coyotes: 'Every coyote is out. The flock wins.',
      dawn: 'Dawn breaks with the Shepherd standing. The flock wins.',
    }[reason];
    await this.emit('over', { winner, reason, foxWin, text: why + (foxWin ? ' The Fox wins too.' : '') });
  }

  // ── Debug ──
  checkInvariants() {
    let total = this.deck.length + this.discard.length + this.dark.length;
    for (const p of this.players) {
      total += p.hand.length + this.ownKits(p).length;
      if (p.lives > p.maxLives) throw new Error(`${p.name} above max lives`);
      if (!p.crow && p.lives <= 0) throw new Error(`${p.name} alive at 0 lives`);
      if (this.ownKits(p).length > 2) throw new Error(`${p.name} has more than 2 kits`);
    }
    if (total !== DECK_SIZE) throw new Error(`Card count ${total}, expected ${DECK_SIZE}`);
    const ids = new Set();
    const all = [...this.deck, ...this.discard, ...this.dark.map(d => d.card), ...this.players.flatMap(p => [...p.hand, ...this.ownKits(p)])];
    for (const c of all) {
      if (ids.has(c.id)) throw new Error(`Duplicate card id ${c.id}`);
      ids.add(c.id);
    }
  }
}
