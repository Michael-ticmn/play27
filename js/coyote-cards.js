// ============================================================
// play27 — Lanterns Out player cards (no game logic)
// Character cards (dealt face up), role cards (dealt face down), and
// status cards (Woken, Bell, Crook, Crow, kits). One HTML source for the
// desktop page and the physical print sheet, with text taken from the
// engine so the two never disagree. Styles: css/coyote-cards.css.
// ============================================================
import { CHARACTERS, ROLE_INFO } from './coyote-engine.js?v=0.15.30';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TEAM_LINE = { flock: 'Flock team', coyote: 'Coyote team', fox: 'Plays for itself' };
const ROLE_FOOT = {
  shepherd: 'Show this card at the start. +1 life, and take the Crook.',
  sheepdog: 'Keep face down. Show it when you are knocked out.',
  hunter: 'Keep face down until your long gun or a knockout shows it.',
  coyote: 'Keep face down. Coyotes don\'t know each other.',
  fox: 'Keep face down. Show it when you are knocked out.',
};

// Small inline icons for the status cards.
const ICON = {
  bell: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 5c-6 0-10 5-10 11v8l-4 5h28l-4-5v-8c0-6-4-11-10-11z" fill="#d4a027"/><circle cx="20" cy="33" r="3.2" fill="#a8452f"/><rect x="18.5" y="2" width="3" height="4" rx="1" fill="#8a6a1c"/></svg>',
  crook: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M17 38V14c0-7 11-8 12-1 .5 4-4 5.5-6 2.5" stroke="#8a6a1c" stroke-width="3.6" fill="none" stroke-linecap="round"/></svg>',
  crow: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M6 24c6-1 9-5 13-9 3-3 8-4 11-2l5 1-4 2c1 4-1 8-5 10l-3 1 2 7h-2l-3-6-4 1 1 5h-2l-2-5c-3 0-5-2-7-5z" fill="#2b2f36"/><circle cx="30" cy="15.5" r="1.2" fill="#f3efe6"/></svg>',
  hayloft: '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M6 18 20 6l14 12v16H6z" fill="#a8452f"/><path d="M14 34V22h12v12" fill="#e6c370"/><path d="M14 22l12 12M26 22 14 34" stroke="#a8452f" stroke-width="1.6"/></svg>',
  thicket: '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="13" cy="24" r="9" fill="#24402f"/><circle cx="26" cy="21" r="10" fill="#2e5a3f"/><circle cx="20" cy="29" r="8" fill="#3c7a52"/></svg>',
  lantern: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#d4a027" fill-rule="evenodd" d="M10 2h4v2h2l1 3v11l-1 3H8l-1-3V7l1-3h2zM12 9.5c-1.2 1.4-2 2.6-2 3.7a2 2 0 0 0 4 0c0-1.1-.8-2.3-2-3.7z"/></svg>',
};

// What each status card says, and where it comes from. `physical` is the
// table procedure for the printed game.
export const STATUS = {
  woken: { name: 'Woken', cls: 's-woken', art: 'char-duke.svg', text: 'Your Dark cards tonight go in face up.', from: 'Duke hands this out at nightfall. Give it back at dawn.' },
  bell: { name: 'Bell', cls: 's-bell', icon: 'bell', text: 'Your next Dark card goes in face up.', from: 'A Bell card hung on you. Discard it after your next Dark card.' },
  crook: { name: 'Crook', cls: 's-crook', icon: 'crook', text: '+1 range. It can\'t be spooked away.', from: 'The Shepherd starts with it in play.' },
  crow: { name: 'Crow', cls: 's-crow', icon: 'crow', text: 'Each night, draw 1 card: drop it face down into the Dark pile or discard it.', from: 'Knocked out: show your role. You can\'t be attacked, and you still win with your side.' },
  hayloft: { name: 'Hayloft', cls: 's-kit', icon: 'hayloft', text: '+1 range. You can\'t Dodge! while up here.', from: 'Kit card in play.' },
  thicket: { name: 'Thicket', cls: 's-kit', icon: 'thicket', text: 'The next Snap! that would cost you a life costs nothing. Then discard it.', from: 'Kit card in play.' },
  lantern: { name: 'Lantern', cls: 's-kit', icon: 'lantern', text: 'Adds a lantern to every reveal. Discard it when you lose a life.', from: 'Kit card in play.' },
};

const hearts = n => `<span class="lc-hearts" aria-hidden="true">${'♥'.repeat(n)}</span>`;

export function characterCard(id, { art = 'assets/coyote/', v = '' } = {}) {
  const c = CHARACTERS.find(x => x.id === id);
  if (!c) return '';
  return `<div class="lo-card lo-char" data-char="${c.id}">
    <div class="lc-kicker">Character <span>face up</span></div>
    <div class="lc-name">${esc(c.name)}</div>
    <div class="lc-sub">${esc(c.animal)}</div>
    <img class="lc-portrait" src="${art}char-${c.id}.svg${v}" alt="">
    <div class="lc-ability">${esc(c.ability)}</div>
    <div class="lc-text">${esc(c.text)}</div>
    <div class="lc-foot">${hearts(c.lives)} ${c.lives} lives</div>
  </div>`;
}

export function roleCard(role, { art = 'assets/coyote/', v = '' } = {}) {
  const r = ROLE_INFO[role];
  if (!r) return '';
  return `<div class="lo-card lo-role rc-${role}" data-role="${role}">
    <div class="lc-kicker">Role <span>${role === 'shepherd' ? 'shown' : 'secret'}</span></div>
    <img class="lc-badge" src="${art}role-${role}.svg${v}" alt="">
    <div class="lc-name">${esc(r.name)}</div>
    <div class="lc-sub">${TEAM_LINE[r.team]}</div>
    <div class="lc-text">${esc(r.goal)}</div>
    <div class="lc-foot">${ROLE_FOOT[role]}</div>
  </div>`;
}

export function statusCard(kind, { art = 'assets/coyote/', v = '' } = {}) {
  const s = STATUS[kind];
  if (!s) return '';
  const pic = s.art ? `<img class="lc-icon lc-round" src="${art}${s.art}${v}" alt="">` : `<span class="lc-icon">${ICON[s.icon]}</span>`;
  return `<div class="lo-card lo-status ${s.cls}" data-status="${kind}">
    <div class="lc-kicker">Status <span>face up</span></div>
    ${pic}
    <div class="lc-name">${esc(s.name)}</div>
    <div class="lc-text">${esc(s.text)}</div>
    <div class="lc-foot">${esc(s.from)}</div>
  </div>`;
}

const BAND = { 's-woken': '#6a58b8', 's-bell': '#c8941c', 's-crook': '#c8941c', 's-crow': '#2b2f36', 's-kit': '#6a58b8' };
function statusIcon(s, art, v) {
  return s.art ? `<img class="st-ic" src="${art}${s.art}${v}" alt="">` : `<span class="st-ic">${ICON[s.icon]}</span>`;
}

// A status card lying sideways in front of you: name and what it does.
export function statusLine(kind, { art = 'assets/coyote/', v = '' } = {}) {
  const s = STATUS[kind];
  if (!s) return '';
  return `<span class="st-card" style="--band:${BAND[s.cls]}" title="${esc(s.from)}">${statusIcon(s, art, v)}<span><b>${esc(s.name)}</b> ${esc(s.text)}</span></span>`;
}

// The same card seen across the table: name only, text on hover.
export function statusChip(kind, { art = 'assets/coyote/', v = '' } = {}) {
  const s = STATUS[kind];
  if (!s) return '';
  return `<span class="st-chip" style="--band:${BAND[s.cls]}" title="${esc(`${s.name}: ${s.text}`)}">${statusIcon(s, art, v)}${esc(s.name)}</span>`;
}

// The shared back: every player card has it, so a dealt role gives nothing away.
export function cardBack() {
  return `<div class="lo-card lo-back" aria-label="Lanterns Out card back">
    <svg class="lb-art" viewBox="0 0 100 140" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="100" height="140" fill="#14161a"/>
      <g fill="#c0c0bc" opacity=".5"><circle cx="14" cy="18" r=".9"/><circle cx="34" cy="10" r=".7"/><circle cx="58" cy="22" r=".8"/><circle cx="20" cy="44" r=".6"/><circle cx="86" cy="40" r=".7"/><circle cx="48" cy="36" r=".5"/></g>
      <path d="M82 7a9 9 0 1 0 8 15 7 7 0 0 1-8-15z" fill="#9a8ae6"/>
      <path d="M0 96c22-6 48-2 70-6 12-2 22 0 30 2v48H0z" fill="#1c2a24"/>
      <g stroke="#3a3f47" stroke-width="2"><line x1="10" y1="100" x2="10" y2="84"/><line x1="40" y1="96" x2="40" y2="80"/><line x1="70" y1="92" x2="70" y2="76"/><line x1="96" y1="94" x2="96" y2="78"/></g>
      <path d="M8 88 98 82M8 95 98 89" stroke="#3a3f47" stroke-width="1.6"/>
      <g transform="translate(40 66)"><rect x="-4" y="0" width="8" height="12" rx="2" fill="#3a3f47"/><circle cx="0" cy="6" r="2.2" fill="#e9c24a" opacity=".45"/></g>
      <g fill="#e9c24a"><ellipse cx="30" cy="122" rx="2.2" ry="1.4"/><ellipse cx="38" cy="122" rx="2.2" ry="1.4"/><ellipse cx="66" cy="128" rx="1.8" ry="1.1"/><ellipse cx="72" cy="128" rx="1.8" ry="1.1"/></g>
    </svg>
    <div class="lb-title">Lanterns <span>Out</span></div>
  </div>`;
}

// Your dealt pair for the start of a game: character face up, role face
// down until it flips for you (CSS animation; instant with reduced motion).
export function dealtPair(charId, role, opts = {}) {
  return `<div class="dealt">
    <figure class="dealt-slot">${characterCard(charId, opts)}<figcaption>Face up: everyone sees your character.</figcaption></figure>
    <figure class="dealt-slot"><div class="flip"><div class="flip-in">${roleCard(role, opts)}${cardBack()}</div></div><figcaption>${role === 'shepherd' ? 'Your role: the Shepherd is shown to everyone.' : 'Face down: only you see your role.'}</figcaption></figure>
  </div>`;
}
