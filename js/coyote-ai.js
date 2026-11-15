// ============================================================
// play27 — Coyote AI (client-side, phase 3)
// One instance per AI seat. Uses only what that seat could know:
// its own hand and role, public events, and private events sent
// to it. Never reads another player's role unless game.knownRole
// says it is known.
// ============================================================

const TEAM = { shepherd: 'flock', farmhand: 'flock', hunter: 'flock', coyote: 'coyote', fox: 'fox' };

// Difficulty tiers, all behavior differences in one place (like rummy's tiers.ts).
//   mistake    chance of a sloppy choice (random target, skipped play, missed Dodge!)
//   noise      random jitter when ranking suspects
//   readReveal weight on the night's reveal counts
//   threshold  shift to how sure the flock must be before attacking (lower = bolder)
//   darkSkill  chance of putting the best card in the Dark pile
//   coordinate coyotes gang up on a weak Shepherd
//   seesDark   cheats: chance to see each face-down Dark card as it goes in
export const TIERS = {
  easy:   { label: 'Easy',   mistake: 0.25, noise: 1.5,  readReveal: 0.4, threshold: 0.8,  darkSkill: 0.6, coordinate: false, seesDark: 0 },
  normal: { label: 'Normal', mistake: 0,    noise: 0.01, readReveal: 1.0, threshold: 0,    darkSkill: 1,   coordinate: false, seesDark: 0 },
  hard:   { label: 'Hard',   mistake: 0,    noise: 0.01, readReveal: 1.3, threshold: -0.3, darkSkill: 1,   coordinate: true,  seesDark: 0.35 },
  unfair: { label: 'Unfair', mistake: 0,    noise: 0.01, readReveal: 1.3, threshold: -0.3, darkSkill: 1,   coordinate: true,  seesDark: 1 },
};

export class CoyoteAI {
  constructor({ rng = Math.random, tier = 'normal' } = {}) {
    this.rng = rng;
    this.setTier(tier);
    this.sus = {};       // seat -> coyote-likelihood score (flock/fox view)
    this.threat = {};    // seat -> how much they hunt coyotes (coyote view)
    this.attacks = [];   // { by, target }
    this.exposed = false;
    this.tonight = this.freshNight();
  }

  setTier(name) {
    this.tierName = TIERS[name] ? name : 'normal';
    this.t = TIERS[this.tierName];
  }

  slip(scale = 1) { return this.t.mistake > 0 && this.rng() < this.t.mistake * scale; }

  freshNight() {
    return { hidden: {}, crowDrops: [], faceUp: { moon: 0, lantern: 0, blank: 0 }, own: { moon: 0, lantern: 0, blank: 0 }, peek: null };
  }

  me(game) { return game.players[this.seat]; }
  team(game) { return TEAM[this.me(game).role]; }

  suspicion(game, q) {
    const known = game.knownRole(this.me(game), q);
    if (known) return TEAM[known] === 'coyote' ? 10 : known === 'fox' ? 2 : -10;
    return this.sus[q.seat] || 0;
  }

  trust(game, seat) {
    const q = game.players[seat];
    const known = game.knownRole(this.me(game), q);
    if (known) return TEAM[known] === 'flock' ? 1 : TEAM[known] === 'coyote' ? -1 : -0.3;
    return -Math.tanh((this.sus[seat] || 0) / 2);
  }

  bump(seat, v) { if (seat !== this.seat && seat != null) this.sus[seat] = (this.sus[seat] || 0) + v; }
  bumpThreat(seat, v) { if (seat !== this.seat && seat != null) this.threat[seat] = (this.threat[seat] || 0) + v; }

  isTeammate(game, q) {
    const known = game.knownRole(this.me(game), q);
    return !!known && q !== this.me(game) && TEAM[known] === this.team(game) && this.team(game) !== 'fox';
  }

  // ── Observation ──
  observe(game, ev) {
    const me = this.me(game);
    const shep = game.shepherdSeat;
    const mine = ev.by === this.seat;
    switch (ev.type) {
      case 'night':
        this.tonight = this.freshNight();
        break;
      case 'dark':
        if (ev.faceUp) {
          this.tonight.faceUp[ev.icon]++;
          if (!mine) {
            this.bump(ev.by, { moon: 2.0, lantern: -1.2, blank: -0.2 }[ev.icon]);
            if (ev.icon === 'lantern') this.bumpThreat(ev.by, 0.5);
          } else if (ev.icon === 'moon' && this.team(game) === 'coyote') this.exposed = true;
        } else if (!mine) {
          const last = this.t.seesDark && this.rng() < this.t.seesDark ? game.dark[game.dark.length - 1] : null;
          if (last && last.by === ev.by) {
            this.tonight.faceUp[last.card.icon]++;
            this.bump(ev.by, { moon: 2.0, lantern: -1.2, blank: -0.2 }[last.card.icon]);
            if (last.card.icon === 'lantern') this.bumpThreat(ev.by, 0.8);
          } else {
            this.tonight.hidden[ev.by] = (this.tonight.hidden[ev.by] || 0) + 1;
          }
        }
        break;
      case 'longshot':
        this.bumpThreat(ev.by, 2);
        break;
      case 'dark-private':
        this.tonight.own[ev.icon]++;
        break;
      case 'crow-drop':
        if (!mine) this.tonight.crowDrops.push(ev.by);
        break;
      case 'peek':
        this.tonight.peek = { by: ev.target, icon: ev.icon };
        this.bump(ev.target, { moon: 3, lantern: -1.5, blank: 0 }[ev.icon]);
        break;
      case 'snap':
        this.attacks.push({ by: ev.by, target: ev.target });
        if (mine) {
          if (ev.target === shep) this.exposed = true;
          break;
        }
        if (ev.target === shep) this.bump(ev.by, ev.charge ? 0.5 : 3);
        else this.bump(ev.by, (ev.charge ? 0.2 : 0.9) * this.trust(game, ev.target));
        if (ev.target === this.seat || (game.players[ev.target] && this.isTeammate(game, game.players[ev.target]) && this.team(game) === 'coyote')) {
          this.bumpThreat(ev.by, 1.5);
        }
        if (ev.target === this.seat && this.team(game) === 'coyote' && !ev.charge) this.exposed = true;
        break;
      case 'howl':
        if (mine) break;
        if (ev.target === shep) this.bump(ev.by, 4);
        else this.bump(ev.by, 1.0 * this.trust(game, ev.target));
        break;
      case 'howl-hold':
        if (!mine && ev.target === shep) this.bump(ev.by, -0.3);
        break;
      case 'heal':
        if (mine || ev.by === ev.target) break;
        if (ev.target === shep) { this.bump(ev.by, -1.5); this.bumpThreat(ev.by, 1); }
        else this.bump(ev.by, -0.5 * this.trust(game, ev.target));
        break;
      case 'roundup':
        if (!mine) { this.bump(ev.by, -2); this.bumpThreat(ev.by, 1); }
        break;
      case 'kit':
        if (!mine && ev.cardType === 'lantern') { this.bump(ev.by, -1.2); this.bumpThreat(ev.by, 0.5); }
        break;
      case 'bell':
        if (!mine) {
          this.bump(ev.by, -0.3);
          this.bumpThreat(ev.by, ev.target === this.seat ? 1 : 0.3);
        }
        break;
      case 'spook':
        if (!mine) this.bump(ev.by, 0.4 * this.trust(game, ev.target));
        break;
      case 'knockout': {
        const wasCoyote = TEAM[ev.role] === 'coyote';
        const wasFlock = TEAM[ev.role] === 'flock';
        const counted = {};
        for (const a of this.attacks) {
          if (a.target !== ev.target || a.by === this.seat) continue;
          counted[a.by] = (counted[a.by] || 0) + 1;
          if (counted[a.by] > 2) continue;
          if (wasCoyote) this.bump(a.by, -0.8);
          if (wasFlock) this.bump(a.by, 0.8);
        }
        break;
      }
      case 'reveal':
        if (this.team(game) !== 'coyote') this.readReveal(game, ev);
        break;
    }
    void me;
  }

  // Spread the night's unexplained moons and lanterns over the
  // players whose cards went in face down.
  readReveal(game, ev) {
    const t = this.tonight;
    let moons = ev.icons.moon - t.faceUp.moon - t.own.moon;
    let lanterns = ev.icons.lantern - t.faceUp.lantern - t.own.lantern;
    const hidden = { ...t.hidden };
    if (t.peek && hidden[t.peek.by]) {
      hidden[t.peek.by]--;
      if (t.peek.icon === 'moon') moons--;
      if (t.peek.icon === 'lantern') lanterns--;
    }
    for (const s of t.crowDrops) {
      const role = game.players[s].role; // crows are revealed
      if (TEAM[role] === 'coyote') moons--;
      else if (TEAM[role] === 'flock') lanterns--;
    }
    moons = Math.max(0, moons);
    lanterns = Math.max(0, lanterns);
    const total = Object.values(hidden).reduce((a, b) => a + b, 0);
    if (!total) return;
    for (const [seat, n] of Object.entries(hidden)) {
      const share = n / total;
      this.bump(Number(seat), this.t.readReveal * (1.4 * moons * share - 0.7 * lanterns * share));
    }
  }

  // ── Valuations ──
  dayValue(game, me, card) {
    const flock = this.team(game) === 'flock';
    switch (card.type) {
      case 'snap': return 3;
      case 'dodge': return 5;
      case 'bristle': return 5;
      case 'packhowl': return 2;
      case 'frenzy': return 1;
      case 'mend': return me.lives < me.maxLives ? 4 : 2;
      case 'roundup': return flock ? (game.den > 0 ? 5 : 3) : 0.5;
      case 'forage': return 3;
      case 'swipe': return 2;
      case 'spook': return 2;
      case 'bell': return flock ? 3 : 0.5;
      case 'sniff': return flock ? 1.5 : 0.5;
      case 'headcount': return flock ? 1.5 : 0.5;
      case 'hayloft': return 2;
      case 'thicket': return 3;
      case 'lantern': return flock ? 4 : 0.5;
    }
    return 1;
  }

  darkScore(game, me, card, forced) {
    const team = this.team(game);
    let iv;
    if (team === 'flock') iv = { lantern: 6, blank: 0, moon: -6 }[card.icon];
    else if (team === 'coyote') iv = forced ? { moon: -8, lantern: 1, blank: 2 }[card.icon] : { moon: 6, blank: 0, lantern: -4 }[card.icon];
    else iv = { moon: 0, lantern: 0, blank: 1 }[card.icon];
    return iv - 0.5 * this.dayValue(game, me, card);
  }

  wantedIcon(game) {
    const team = this.team(game);
    return team === 'flock' ? 'lantern' : team === 'coyote' ? 'moon' : null;
  }

  reserveDark(game, me) {
    const want = this.wantedIcon(game);
    if (!want) return new Set();
    const n = me.character.id === 'boots' ? 2 : 1;
    const ranked = me.hand.filter(c => c.icon === want)
      .sort((a, b) => this.darkScore(game, me, b, false) - this.darkScore(game, me, a, false));
    return new Set(ranked.slice(0, n).map(c => c.id));
  }

  attackThreshold(game, me) {
    let th = me.role === 'shepherd' ? 2.4 : 1.6;
    th -= 0.12 * (game.night - 1);
    if (game.den >= game.denTarget - 1) th -= 0.4;
    return th + this.t.threshold;
  }

  // Coyotes stay hidden early and raid sheep; they show their teeth
  // once the Shepherd is weak, they're already suspected, or time is short.
  shouldHitShepherd(game) {
    const shep = game.players[game.shepherdSeat];
    if (shep.lives <= 2 || this.exposed || game.night >= 4) return true;
    if (this.t.coordinate) {
      const pack = game.players.filter(q => q.role === 'coyote' && !q.crow && game.knownRole(this.me(game), q)).length;
      if (shep.lives <= pack + 1) return true;
    }
    if (game.night >= 3 && this.rng() < 0.4) return true;
    return false;
  }

  mostSuspicious(game, me, seats, min = -Infinity) {
    let best = null, bs = -Infinity;
    for (const s of seats || []) {
      const q = game.players[s];
      if (q === me || s === game.shepherdSeat || this.isTeammate(game, q)) continue;
      const v = this.suspicion(game, q) + this.rng() * this.t.noise;
      if (v > bs) { bs = v; best = s; }
    }
    return bs >= min ? best : null;
  }

  // ── Day ──
  async chooseAction(game, me) {
    return this.planDay(game, me) || { type: 'end' };
  }

  planDay(game, me) {
    if (this.slip(0.5)) return null;
    const team = this.team(game);
    const reserve = this.reserveDark(game, me);
    const usable = me.hand.filter(c => !reserve.has(c.id));
    const opts = c => game.playOptions(me, c);
    const pick = type => usable.find(c => c.type === type && opts(c).ok);

    // Kit
    for (const kt of ['thicket', 'lantern', 'hayloft']) {
      const c = pick(kt);
      if (!c) continue;
      if (kt === 'lantern' && team !== 'flock') continue;
      if (kt === 'hayloft' && !this.wantsHayloft(game, me)) continue;
      return { cardId: c.id };
    }
    // Round up
    if (team === 'flock') {
      const c = pick('roundup');
      if (c) return { cardId: c.id };
    }
    // Mend
    {
      const c = pick('mend');
      if (c) {
        const t = this.mendTargets(game, me, opts(c).targets);
        if (t) return { cardId: c.id, target: t[0], targets: t };
      }
    }
    // Forage
    {
      const c = pick('forage');
      if (c) return { cardId: c.id };
    }
    // Finding tools
    if (team === 'flock') {
      const b = pick('bell');
      if (b) {
        const t = this.mostSuspicious(game, me, opts(b).targets);
        if (t != null) return { cardId: b.id, target: t };
      }
      const h = pick('headcount');
      if (h && game.dark.length >= 2) return { cardId: h.id };
      const s = pick('sniff');
      if (s && me.hand.length >= 4) {
        const t = this.mostSuspicious(game, me, opts(s).targets);
        if (t != null) return { cardId: s.id, target: t };
      }
    }
    // Pack Howl
    {
      const c = pick('packhowl');
      if (c) {
        const t = this.howlTarget(game, me);
        if (t != null && opts(c).targets.includes(t)) return { cardId: c.id, target: t };
      }
    }
    // Snap (Frenzy first if there's more to throw)
    if (me.snapsLeft > 0) {
      const snaps = usable.filter(c => c.type === 'snap');
      if (snaps.length) {
        const o = opts(snaps[0]);
        const t = o.ok ? this.snapTarget(game, me, o.targets) : null;
        if (t != null) {
          const fr = pick('frenzy');
          if (fr && snaps.length >= 2 && me.snapsLeft === 1) return { cardId: fr.id };
          return { cardId: snaps[0].id, target: t };
        }
      }
    }
    // Swipe
    {
      const c = pick('swipe');
      if (c && me.hand.length <= 5) {
        const t = this.trickTarget(game, me, opts(c).targets);
        if (t != null) return { cardId: c.id, target: t };
      }
    }
    // Spook
    {
      const c = pick('spook');
      if (c) {
        const r = this.spookPlan(game, me, opts(c).targets);
        if (r) return { cardId: c.id, ...r };
      }
    }
    return null;
  }

  wantsHayloft(game, me) {
    const team = this.team(game);
    if (team === 'fox') return false;
    const reach = game.range(me) + 1;
    const others = game.alive().filter(q => q !== me);
    if (team === 'coyote') {
      const shep = game.players[game.shepherdSeat];
      const d = game.distance(me, shep);
      return d > game.range(me) && d <= reach && this.shouldHitShepherd(game);
    }
    const th = this.attackThreshold(game, me);
    return others.some(q => {
      const d = game.distance(me, q);
      return d > game.range(me) && d <= reach && q.seat !== game.shepherdSeat && this.suspicion(game, q) >= th;
    });
  }

  mendTargets(game, me, seats) {
    const team = this.team(game);
    const order = [];
    if (team === 'flock' && seats.includes(game.shepherdSeat) && me.seat !== game.shepherdSeat) order.push(game.shepherdSeat);
    if (seats.includes(me.seat)) order.push(me.seat);
    for (const s of seats) {
      if (order.includes(s)) continue;
      const q = game.players[s];
      if (this.isTeammate(game, q)) order.push(s);
      else if (team === 'flock' && this.suspicion(game, q) < 0) order.push(s);
    }
    if (!order.length) return null;
    return me.character.id === 'clementine' ? order.slice(0, 2) : [order[0]];
  }

  howlTarget(game, me) {
    const team = this.team(game);
    const alive = game.alive().filter(q => q !== me).map(q => q.seat);
    if (team === 'flock') return this.mostSuspicious(game, me, alive, this.attackThreshold(game, me) + 1);
    if (team === 'coyote') {
      const shep = game.players[game.shepherdSeat];
      return shep.lives <= 3 ? shep.seat : null;
    }
    return null;
  }

  snapTarget(game, me, seats) {
    const team = this.team(game);
    if (this.slip()) {
      const pool = seats.filter(s => s !== game.shepherdSeat && !this.isTeammate(game, game.players[s]) && game.inRange(me, game.players[s]));
      if (pool.length) return pool[Math.floor(this.rng() * pool.length)];
    }
    if (team === 'flock') {
      const th = this.attackThreshold(game, me);
      const near = seats.filter(s => game.inRange(me, game.players[s]));
      const t = this.mostSuspicious(game, me, near, th);
      if (t != null || me.role !== 'hunter') return t;
      // Long gun: only for a strong suspect, since it gives the Hunter away.
      const far = seats.filter(s => !near.includes(s));
      return this.mostSuspicious(game, me, far, th + (me.revealed ? 0 : 0.8));
    }
    if (team === 'coyote') {
      if (seats.includes(game.shepherdSeat) && this.shouldHitShepherd(game)) return game.shepherdSeat;
      let best = null, bs = -Infinity;
      for (const s of seats) {
        const q = game.players[s];
        if (s === game.shepherdSeat || this.isTeammate(game, q)) continue;
        const v = (this.threat[s] || 0) + (q.lives <= 1 ? 1.5 : 0);
        if (v > bs) { bs = v; best = s; }
      }
      if (best != null && bs >= 1) return best;
      if (best != null && this.exposed && this.rng() < 0.5) return best;
      return null;
    }
    // Fox: finish off the weak, otherwise keep a low profile.
    const weak = seats.map(s => game.players[s]).filter(q => q.lives <= 1);
    if (weak.length) return weak[0].seat;
    const low = seats.map(s => game.players[s]).filter(q => q.lives <= 2);
    if (low.length && this.rng() < 0.4) return low[0].seat;
    return null;
  }

  trickTarget(game, me, seats) {
    const team = this.team(game);
    if (team === 'flock') return this.mostSuspicious(game, me, seats, 0.5);
    if (team === 'coyote') {
      if (seats.includes(game.shepherdSeat)) return game.shepherdSeat;
      const s = seats.filter(x => !this.isTeammate(game, game.players[x]));
      return s.length ? s[Math.floor(this.rng() * s.length)] : null;
    }
    return seats.length ? seats[Math.floor(this.rng() * seats.length)] : null;
  }

  spookPlan(game, me, seats) {
    const team = this.team(game);
    const withKit = (s, types) => game.ownKits(game.players[s]).find(k => types.includes(k.type));
    if (team === 'flock') {
      const th = this.attackThreshold(game, me) - 0.5;
      for (const s of seats) {
        if (s === game.shepherdSeat || this.suspicion(game, game.players[s]) < th) continue;
        const k = withKit(s, ['thicket', 'hayloft']);
        if (k) return { target: s, kitId: k.id };
      }
      const t = this.mostSuspicious(game, me, seats, th);
      return t != null ? { target: t } : null;
    }
    if (team === 'coyote') {
      for (const s of seats) {
        if (this.isTeammate(game, game.players[s])) continue;
        const k = withKit(s, ['lantern']);
        if (k) return { target: s, kitId: k.id };
      }
      if (seats.includes(game.shepherdSeat)) {
        const k = withKit(game.shepherdSeat, ['thicket']);
        if (k) return { target: game.shepherdSeat, kitId: k.id };
      }
    }
    return null;
  }

  // ── Dark and rest ──
  async chooseDark(game, me, { count, forced, canFaceUp }) {
    const ranked = [...me.hand].sort((a, b) => this.darkScore(game, me, b, forced) - this.darkScore(game, me, a, forced));
    if (this.t.darkSkill < 1 && this.rng() > this.t.darkSkill) ranked.sort(() => this.rng() - 0.5);
    const cards = ranked.slice(0, count);
    let faceUp = false;
    if (canFaceUp && !forced && cards.length) {
      const ic = cards[0].icon;
      const team = this.team(game);
      faceUp = team === 'flock' ? ic !== 'moon' : team === 'coyote' ? ic !== 'moon' : ic === 'blank';
    }
    return { cardIds: cards.map(c => c.id), faceUp };
  }

  async bootsCount(game, me) {
    const team = this.team(game);
    const forced = game.isForcedFaceUp(me);
    if (team === 'flock') return Math.min(2, me.hand.filter(c => c.icon === 'lantern').length);
    if (team === 'coyote') return forced ? 0 : Math.min(2, me.hand.filter(c => c.icon === 'moon').length);
    return 1;
  }

  async chooseDiscard(game, me, n) {
    const want = this.wantedIcon(game);
    const keep = c => this.dayValue(game, me, c) + (c.icon === want ? 2 : 0);
    return [...me.hand].sort((a, b) => keep(a) - keep(b)).slice(0, n).map(c => c.id);
  }

  // ── Reactions ──
  async respondSnap(game, me, attacker, { canDodge, canBristle }) {
    if (this.slip(0.5)) return 'none';
    if (canBristle && (!canDodge || me.lives <= 2)) return 'bristle';
    if (canDodge) return 'dodge';
    if (canBristle) return 'bristle';
    return 'none';
  }

  async joinHowl(game, me, target) {
    const snap = me.hand.find(c => c.type === 'snap');
    if (!snap) return null;
    const team = this.team(game);
    if (team === 'flock') {
      if (target.seat === game.shepherdSeat || this.isTeammate(game, target)) return null;
      return this.suspicion(game, target) >= this.attackThreshold(game, me) - 0.5 ? snap.id : null;
    }
    if (team === 'coyote') {
      if (this.isTeammate(game, target)) return null;
      if (target.seat === game.shepherdSeat) return snap.id;
      return (this.threat[target.seat] || 0) >= 1 || this.rng() < 0.4 ? snap.id : null;
    }
    return target.lives <= 1 || this.rng() < 0.25 ? snap.id : null;
  }

  async tinyCharge(game, me, attacker) {
    const snap = me.hand.find(c => c.type === 'snap');
    if (!snap || this.isTeammate(game, attacker)) return null;
    return snap.id;
  }

  async crowChoice(game, me, card) {
    const want = this.wantedIcon(game);
    if (!want) return this.rng() < 0.5 ? 'drop' : 'discard';
    return card.icon === want ? 'drop' : 'discard';
  }

  async woollySave(game, me, lost) {
    const team = this.team(game);
    if (team === 'flock') {
      if (me.role === 'shepherd' && me.lives <= 1) return false;
      if (me.lives >= 2) return true;
      return game.den + lost >= game.denTarget && game.den + lost - 1 < game.denTarget;
    }
    if (team === 'coyote') return me.lives >= 3 && game.den + lost < game.denTarget && this.rng() < 0.25;
    return false;
  }

  async lastShot(game, me) {
    const others = game.alive().filter(q => q !== me).map(q => q.seat);
    return this.mostSuspicious(game, me, others, 0.3);
  }

  async dukePick(game, me) {
    const others = game.alive().filter(q => q !== me && q.seat !== game.shepherdSeat).map(q => q.seat);
    if (!others.length) return null;
    if (this.team(game) === 'flock') return this.mostSuspicious(game, me, others);
    const pool = others.filter(s => !this.isTeammate(game, game.players[s]));
    return pool.length ? pool[Math.floor(this.rng() * pool.length)] : null;
  }
}
