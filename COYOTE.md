# Coyote — Design Spec

## As of 2026-07-09 (v0.14.3) — DRAFT, pre-implementation

A hidden-role elimination card game for 4–7 players. The flock knows something's
wrong — find the coyotes before dark.

Gameplay is modeled on the classic BANG!-style shootout structure (hidden roles,
distance-based targeting, attack/dodge loop) with an original farm/predator theme.

## Legal guardrails (do not violate)

Per *DaVinci Editrice v. ZiKo Games* (S.D. Tex. 2016), game **mechanics** are not
copyrightable — the hidden roles, distance system, turn structure, and card effects
are free to use. What we must NOT use:

- The name "BANG!" or its card names (BANG!, Missed!, etc.) — trademark + expression
- Any BANG! artwork, logo, card layout, or trade dress
- BANG! rules text (write all rules in our own words)
- BANG! character names, likenesses, or flavor text
- Anything from BANG! expansions

Everything below is original naming and flavor. Keep it that way.

## Setting

A farm at dusk. The Shepherd guards the flock. Coyotes have slipped in among the
animals. Nobody knows who anyone is — except the Shepherd, who wears the badge
of the barnyard openly.

## Roles (hidden except Shepherd)

| Role | Count (4/5/6/7 players) | Win condition |
|---|---|---|
| **Shepherd** | 1 / 1 / 1 / 1 | Eliminate all Coyotes and the Lone Wolf |
| **Sheepdog** | 0 / 1 / 1 / 2 | Same as Shepherd (wins even if dead) |
| **Coyote** | 2 / 2 / 3 / 3 | The Shepherd dies |
| **Lone Wolf** | 1 / 1 / 1 / 1 | Be the last one standing |

- Shepherd's role is public and gets +1 life.
- Elimination reveals your role card.
- Bounty: any player who eliminates a Coyote draws 3 cards.
- Friendly fire: if the Shepherd eliminates a Sheepdog, the Shepherd discards
  their whole hand and all gear in play.

## Lives ("Hearts of the flock")

Each character has a base of 3 or 4 lives; Shepherd +1. Lives = current hand
limit at end of turn (discard down).

## Distance and range

Players sit in a circle (the barnyard). Distance = seats between players, counting
the shorter way around. Eliminated players don't count. You can only Snap! at
targets within your range (base range 1). Modified by Vantage and gear cards.

## Turn structure

1. **Forage** — draw 2 cards.
2. **Act** — play any number of cards, but only one **Snap!** per turn
   (unless Night Prowl is in play).
3. **Bed down** — discard down to your current life total.

## Card list (draw deck, ~80 cards)

### Attacks and defense
| Card | Count | Effect |
|---|---|---|
| **Snap!** | 25 | Deal 1 damage to a target in range. One per turn. |
| **Dodge!** | 12 | Cancel a Snap! aimed at you. |
| **Stampede** | 1 | Snap! at every other player (they may Dodge!). |
| **Wildfire** | 2 | Every other player discards a Snap! or loses 1 life. |
| **Standoff** | 3 | Challenge any player: alternate discarding Snap!s; first who can't loses 1 life. |

### Recovery
| Card | Count | Effect |
|---|---|---|
| **Graze** | 6 | Regain 1 life (max = starting lives). No effect in 2-player endgame. |
| **Watering Hole** | 1 | Every player regains 1 life. |

### Card economy
| Card | Count | Effect |
|---|---|---|
| **Forage** (card) | 2 | Draw 2 extra cards. |
| **Feast** | 1 | Draw 3 extra cards. |
| **Market Day** | 2 | Reveal cards = players; each player takes one, starting with you. |
| **Pounce** | 4 | Steal a card from a player at distance 1. |
| **Scatter** | 4 | Force any player to discard a card of your choice. |

### Gear (stays in play, one copy of each type per player)
| Card | Count | Effect |
|---|---|---|
| **Bramble** | 2 | When Snapped at, flip a card: if it's a ♥-suit equivalent, the Snap! misses. |
| **Shadows** | 2 | Other players see you at +1 distance. |
| **Keen Nose** | 1 | You see other players at −1 distance. |
| **Snare** | 3 | Play on another player (not the Shepherd). They flip at turn start: escape on ♥, otherwise skip the turn. Discard after. |
| **Blizzard** | 1 | Passes around the table. Flip at turn start: on ♠ 2–9 it hits you for 3 lives, otherwise pass it on. |

### Vantage (gear that sets your Snap! range — one at a time)
| Card | Count | Range |
|---|---|---|
| **Ridge** | 3 | 2 |
| **Upwind** | 2 | 3 |
| **Moonlight** | 1 | 4 |
| **High Ground** | 1 | 5 |
| **Night Prowl** | 2 | 1, but unlimited Snap!s per turn |

Suit/value "flip" checks use the standard 52-card suits printed in the corner of
each deck card (same trick as the classic structure — every card doubles as a
flip outcome).

## Characters (each player gets one, public, with a unique passive)

Original roster — abilities are classic-style passives, names and flavor are ours:

| Character | Lives | Ability |
|---|---|---|
| **Old Blue** (sheepdog) | 4 | Each time you lose a life, draw a card. |
| **Mabel** (goose) | 4 | Honk: your Snap!s and Dodge!s are interchangeable. |
| **Duke** (rooster) | 4 | Crow's-eye: you see all players at distance −1. |
| **Hazel** (barn owl) | 3 | At draw phase, look at top 3 cards and keep 2. |
| **Grits** (buzzard) | 3 | When any player is eliminated, take their cards. |
| **Clementine** (mule) | 4 | When you Dodge! a Snap!, draw a card. |
| **Boots** (barn cat) | 3 | Nine lives: flip 2 cards on every flip check, choose the better. |
| **Tiny** (bull) | 4 | Your Snap!s need two Dodge!s to cancel. |

(Expand to 12+ later; assign randomly, one per player, like the classic setup.)

## Elimination and endgame

- At 0 lives you're out — reveal role, discard everything.
- Coyotes win the moment the Shepherd dies (unless the Lone Wolf is the only
  survivor at that instant — then the Lone Wolf wins).
- Shepherd's side wins when all Coyotes and the Lone Wolf are gone.

## Platform plan (phased)

1. **Phase 1 — landing tile** ✅ Coming Soon tile on index.html (v0.14.3).
2. **Phase 2 — spec + assets** — this doc; card face design in play27 brand
   (amber/teal/green/purple, Courier New); original SVG art, no BANG! trade dress.
3. **Phase 3 — pass-and-play / vs bots** — coyote.html client-side prototype
   (like blackjack.html) to validate rules and UI fast.
4. **Phase 4 — multiplayer** — Supabase schema + RPCs following the contract-rummy
   pattern (games, seats, actions, Realtime), ready check, reconnection.
5. **Phase 5 — AI seats** — edge-function AI with tier profiles, reusing the
   ai-turn architecture; hidden-role inference is the interesting AI problem here.

## Open design questions

- Player count below 4? (Classic structure needs 4+ for roles to work; a 3-player
  variant exists in spirit but is weak. Recommend 4–7 hard requirement.)
- Do we keep the one-character-each public roster, or hide characters too?
- Death continues as spectator (already have spectator system from rummy).
- Mobile portrait layout — circle of players around a barnyard table.
