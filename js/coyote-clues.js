// ============================================================
// play27 — Coyote clues (the in-game helper)
// What one seat has seen each player do, and what it suggests
// about their side. Built only from events that seat could see
// plus game.knownRole, so it never leaks a hidden role. No DOM:
// coyote.js and tools/coyote-clue-check.mjs share it.
//
// Scores use the same weights as the Normal computer players
// (coyote-ai.js), so a read means "what a Normal player would
// conclude from what you've seen". Read thresholds were checked
// with tools/coyote-clue-check.mjs.
// ============================================================

const TEAM = { shepherd: 'flock', sheepdog: 'flock', hunter: 'flock', coyote: 'coyote', fox: 'fox' };
const ROLE_NAME = { shepherd: 'Shepherd', sheepdog: 'Sheepdog', hunter: 'Hunter', coyote: 'Coyote', fox: 'Fox' };
const ARTICLE = { shepherd: 'the', hunter: 'the', fox: 'the', sheepdog: 'a', coyote: 'a' };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Strongest coyote lean first; a score at or above `min` gets that read.
export const READS = [
  { key: 'coyote', label: 'Likely coyote', min: 2.5 },
  { key: 'sus', label: 'Suspicious', min: 1 },
  { key: 'none', label: 'No read yet', min: -1 },
  { key: 'flockish', label: 'Seems flock', min: -2.5 },
  { key: 'flock', label: 'Likely flock', min: -Infinity },
];

export const readFor = score => READS.find(r => score >= r.min);

// Short tag for the feed line that produced a clue.
export function leanTag(lean) {
  if (lean >= 1) return { text: 'coyote move', cls: 'lean-c' };
  if (lean <= -1) return { text: 'flock move', cls: 'lean-f' };
  return null;
}

export const leanClass = lean => (lean > 0.25 ? 'lean-c' : lean < -0.25 ? 'lean-f' : 'lean-n');

const freshNight = () => ({ hidden: {}, crowDrops: [], faceUp: { moon: 0, lantern: 0, blank: 0 }, own: { moon: 0, lantern: 0, blank: 0 }, peek: null });

export class ClueTracker {
  constructor(game, viewer) {
    this.g = game;
    this.viewer = viewer;
    this.score = {};
    this.items = {};
    this.attacks = [];
    this.lastShot = false;
    this.tonight = freshNight();
  }

  get me() { return this.g.players[this.viewer]; }
  known(seat) { return this.g.knownRole(this.me, this.g.players[seat]); }

  // Role counts are public. Take away every role this viewer knows;
  // whatever is left is spread over the seats still unknown.
  rolesLeft() {
    const left = { ...this.g.roleCounts };
    for (const q of this.g.players) {
      const r = this.known(q.seat);
      if (r) left[r]--;
    }
    return left;
  }

  // What this viewer knows a seat to be: a role (seen or worked out by
  // elimination), or a read from the clues.
  read(seat) {
    const role = this.known(seat);
    if (role) return { key: 'known', role, label: ROLE_NAME[role], score: 0 };
    const left = this.rolesLeft();
    const roles = Object.keys(left).filter(r => left[r] > 0);
    if (roles.length === 1) return { key: 'known', role: roles[0], label: ROLE_NAME[roles[0]], score: 0, deduced: true };
    if (roles.every(r => TEAM[r] === 'flock')) return { key: 'flockteam', team: 'flock', label: 'Flock', score: 0, deduced: true };
    const score = this.score[seat] || 0;
    const r = { ...readFor(score), score };
    // Every coyote is accounted for, so a hostile read can only be the Fox.
    if (!left.coyote && left.fox) {
      if (r.key === 'coyote') r.label = 'Likely Fox';
      if (r.key === 'sus') r.label = 'Maybe the Fox';
    }
    return r;
  }

  clues(seat) { return this.items[seat] || []; }

  // How a seat is described inside another player's clue.
  who(seat) {
    if (seat === this.viewer) return 'you';
    const p = this.g.players[seat];
    if (seat === this.g.shepherdSeat) return 'the Shepherd';
    const role = this.known(seat);
    if (role) {
      if (role === 'coyote' && this.me.role === 'coyote') return `${p.name}, your packmate`;
      return `${p.name}, ${ARTICLE[role]} ${ROLE_NAME[role]}`;
    }
    const k = readFor(this.score[seat] || 0).key;
    if (k === 'flock' || k === 'flockish') return `${p.name}, who seems flock`;
    if (k === 'coyote' || k === 'sus') return `${p.name}, who looks suspicious`;
    return p.name;
  }

  // +1 = surely flock, -1 = surely coyote (mirrors CoyoteAI.trust).
  trust(seat) {
    const role = this.known(seat);
    if (role) return TEAM[role] === 'flock' ? 1 : TEAM[role] === 'coyote' ? -1 : -0.3;
    return -Math.tanh((this.score[seat] || 0) / 2);
  }

  add(seat, night, text, lean) {
    if (seat == null || seat === this.viewer) return null;
    const item = { seat, night, text, lean: Math.round(lean * 100) / 100 };
    (this.items[seat] ||= []).push(item);
    this.score[seat] = (this.score[seat] || 0) + lean;
    return item;
  }

  // Feed one event (already filtered to what the viewer can see).
  // Returns the clue it created about the acting player, if any.
  observe(ev) {
    const shep = this.g.shepherdSeat;
    const n = ev.night;
    switch (ev.type) {
      case 'night':
        this.tonight = freshNight();
        return null;
      case 'dark':
        if (ev.by === this.viewer) return null;
        if (!ev.faceUp) {
          this.tonight.hidden[ev.by] = (this.tonight.hidden[ev.by] || 0) + 1;
          return null;
        }
        this.tonight.faceUp[ev.icon]++;
        return this.add(ev.by, n, `Put a ${ev.icon} in the Dark pile face up`, { moon: 2.0, lantern: -1.2, blank: -0.2 }[ev.icon]);
      case 'dark-private':
        this.tonight.own[ev.icon]++;
        return null;
      case 'crow-drop':
        if (ev.by !== this.viewer) this.tonight.crowDrops.push(ev.by);
        return null;
      case 'peek':
        this.tonight.peek = { by: ev.target, icon: ev.icon };
        return this.add(ev.target, n, `Your nose: put a ${ev.icon} in the dark`, { moon: 3, lantern: -1.5, blank: 0 }[ev.icon]);
      case 'snap': {
        this.attacks.push({ by: ev.by, target: ev.target });
        if (ev.by === this.viewer) return null;
        const t = this.who(ev.target);
        if (this.lastShot) {
          this.lastShot = false;
          return this.add(ev.by, n, `Fired a last shot at ${t}`, 0);
        }
        if (ev.target === shep) {
          if (ev.charge) return this.add(ev.by, n, 'Charged back at the Shepherd (Tiny\'s reflex)', 0.5);
          return this.add(ev.by, n, ev.howl ? 'Joined the Pack Howl at the Shepherd' : 'Snapped the Shepherd', 3);
        }
        const lean = (ev.charge ? 0.2 : 0.9) * this.trust(ev.target);
        const verb = ev.charge ? 'Charged back at' : ev.howl ? 'Joined the howl at' : 'Snapped';
        return this.add(ev.by, n, `${verb} ${t}`, lean);
      }
      case 'howl':
        if (ev.by === this.viewer) return null;
        if (ev.target === shep) return this.add(ev.by, n, 'Started a Pack Howl at the Shepherd', 4);
        return this.add(ev.by, n, `Started a Pack Howl at ${this.who(ev.target)}`, 1.0 * this.trust(ev.target));
      case 'howl-hold':
        if (ev.target === shep) return this.add(ev.by, n, 'Held back from the howl at the Shepherd', -0.3);
        return null;
      case 'heal':
        if (ev.by === ev.target) return null;
        if (ev.target === shep) return this.add(ev.by, n, 'Mended the Shepherd', -1.5);
        return this.add(ev.by, n, `Mended ${this.who(ev.target)}`, -0.5 * this.trust(ev.target));
      case 'roundup':
        return this.add(ev.by, n, 'Rounded up a sheep from the den', -2);
      case 'kit':
        if (ev.cardType === 'lantern') return this.add(ev.by, n, 'Put a Lantern in play (it cancels moons)', -1.2);
        return null;
      case 'bell':
        return this.add(ev.by, n, `Hung a Bell on ${this.who(ev.target)}`, -0.3);
      case 'spook':
        return this.add(ev.by, n, `Spooked ${this.who(ev.target)}`, 0.4 * this.trust(ev.target));
      case 'swipe':
        return this.add(ev.by, n, `Swiped a card from ${this.who(ev.target)}`, 0);
      case 'longshot':
        if (ev.by === this.viewer) return null;
        return this.add(ev.by, n, 'Used a long gun, so everyone knows they are the Hunter', 0);
      case 'lastshot':
        this.lastShot = true; // the snap that follows is the last shot
        return null;
      case 'knockout': {
        const team = TEAM[ev.role];
        const counted = {};
        for (const a of this.attacks) {
          if (a.target !== ev.target || a.by === this.viewer || a.by === ev.target) continue;
          counted[a.by] = (counted[a.by] || 0) + 1;
        }
        const who = `${this.g.players[ev.target].name}, ${ARTICLE[ev.role]} ${ROLE_NAME[ev.role]}`;
        for (const [seat, k] of Object.entries(counted)) {
          const hits = Math.min(k, 2);
          if (team === 'coyote') this.add(Number(seat), n, `Helped knock out ${who}`, -0.8 * hits);
          else if (team === 'flock') this.add(Number(seat), n, `Helped knock out ${who}`, 0.8 * hits);
        }
        return null;
      }
      case 'reveal':
        this.readReveal(ev);
        return null;
    }
    return null;
  }

  // Spread the night's unexplained moons and lanterns over the
  // players whose cards went in face down (same as CoyoteAI.readReveal,
  // plus: known coyotes are assumed to have put in moons and known
  // flock lanterns).
  readReveal(ev) {
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
      const team = TEAM[this.g.players[s].role]; // crows are revealed
      if (team === 'coyote') moons--;
      else if (team === 'flock') lanterns--;
    }
    for (const [seat, k] of Object.entries(hidden)) {
      const role = this.known(Number(seat));
      if (!role) continue;
      if (TEAM[role] === 'coyote') moons -= k;
      else if (TEAM[role] === 'flock') lanterns -= k;
      delete hidden[seat];
    }
    moons = Math.max(0, moons);
    lanterns = Math.max(0, lanterns);
    const total = Object.values(hidden).reduce((a, b) => a + b, 0);
    if (!total) return;
    const what = moons && lanterns ? `${plural(moons, 'moon')} and ${plural(lanterns, 'lantern')}`
      : moons ? plural(moons, 'moon') : plural(lanterns, 'lantern');
    const others = total > 1 ? `, shared with ${total - 1} other face-down card${total > 2 ? 's' : ''}` : '';
    for (const [seat, k] of Object.entries(hidden)) {
      const share = k / total;
      const lean = 1.4 * moons * share - 0.7 * lanterns * share;
      if (Math.abs(lean) < 0.3) continue;
      this.add(Number(seat), ev.night, `Went face down when hidden cards brought ${what}${others}`, lean);
    }
  }
}
