# Coyote: Design Spec

## As of 2026-11-14, draft v2 (branch `coyote`, based on v0.15.24)

A hidden-role card game for 4 to 7 players. A farm, dusk to dawn: the Shepherd
has to hold the flock together while coyotes hide among the animals.

**What changed from v1.** v1 (2026-07-09) copied the classic hidden-role shootout's
card list, card counts, and character abilities one for one under new names. v2
keeps only the genre structure (a public leader with hidden teams, seat distance
and range, attack and dodge, gear in front of you) and replaces the rest with an
original design built on four farm ideas:

- **Dawn clock.** The game lasts 6 nights. If the Shepherd survives to dawn, the
  flock wins. Games have a fixed length.
- **The flock.** Coyotes can win by raiding sheep, not only by killing the Shepherd.
  That gives the game a second front.
- **The Dark pile.** Every turn, every player puts one card face down into a shared
  pile. At the end of the night the pile is revealed anonymously, and the counts
  decide how many sheep are lost. This is where the deduction comes from.
- **Crows.** Knocked-out players keep playing with one small action per night, so
  nobody sits out.

All numbers in this doc are starting values, to be tuned with simulated games the
same way rummy's AI was tuned.

## Legal guardrails (do not violate)

Game mechanics are not copyrightable (*DaVinci Editrice v. ZiKo Games*, S.D. Tex.
2016), but a game's specific expression is. Do NOT use:

- The name "BANG!", its card names, art, logo, card layout, trade dress, rules
  text, character names, flavor text, or anything from its expansions.
- Its card list, card counts, or character abilities, renamed or not. v1 of this
  spec did exactly that; v2 replaced them. Don't drift back.

Everything below is original naming, flavor, and design. Keep it that way.

## Roles

| Players | Shepherd | Sheepdogs | Coyotes | Fox | Den target |
|---|---|---|---|---|---|
| 4 | 1 | 1 | 2 | 0 | 5 sheep |
| 5 | 1 | 2 | 2 | 0 | 4 sheep |
| 6 | 1 | 2 | 2 | 1 | 4 sheep |
| 7 | 1 | 2 | 3 | 1 | 6 sheep |

- **Shepherd** (public, flock team). +1 life. Starts with the Crook in play.
- **Sheepdog** (hidden, flock team). Still wins with the flock after being knocked out.
- **Coyote** (hidden, coyote team). Still wins with the coyotes after being knocked out.
- **Fox** (hidden, 6+ players, plays for itself). Wins if it is alive when the game
  ends and has knocked out at least 2 players, whichever team wins. The Fox's win
  is in addition to the team win, not instead of it.

The den targets come from rough supply math. Two draws a turn bring in about
0.8 moons but only about 0.47 lanterns on average, so the flock can't cancel
every moon and the sheep raid is a real threat at every player count. More
coyotes per flock player means more moons a night, hence the higher targets at
4 and 7 players. These are the first numbers to tune.

### How each side wins

- **Coyotes** win immediately when the Shepherd is knocked out, or when the den
  reaches the target.
- **Flock** wins immediately when every Coyote is knocked out, or at dawn (after
  night 6's reveal) if the coyotes haven't won.

## A night

A night is one turn for each living player, starting with the Shepherd and going
clockwise. Everyone starts the game with 4 cards.

### Your turn

1. **Draw** 2 cards.
2. **Day.** Play any number of cards. At most one Snap! per turn.
3. **Dark.** Put exactly 1 card from your hand face down in the Dark pile. With
   an empty hand, put in the top card of the deck unseen.
4. **Rest.** Discard down to 5 cards. The hand limit is 5 for everyone.

### The reveal (end of each night)

After the last player's turn, shuffle the Dark pile and turn it over.

- Each **moon** takes one sheep from the pen to the den.
- Each **lantern** cancels one moon. Each Lantern kit in play adds one lantern.
- Sheep lost = moons minus lanterns, never below 0.

Everyone sees the icon counts, never who put in what. The revealed cards are
discarded, so their day effects are gone. Then the moon marker moves on. After
night 6's reveal, dawn breaks.

### Night icons

Every card has one icon in its corner: **moon**, **lantern**, or **blank**. The deck
holds 24 moons, 14 lanterns, and 22 blanks. Coyotes want moons in the dark and
the flock wants lanterns. Putting a card in the dark means giving up its day
effect, so every turn is a trade-off.

The flock's best tools (Bell, Round Up, Headcount) mostly carry moons. A coyote
can bury one in the dark, take a tool away from the flock and add a moon in one
move, and claim they were "just getting rid of a card."

## Distance, range, and lives

- Players sit in a circle. Distance is the number of seats between you, counting
  the shorter way. Crows don't count.
- You can Snap! a player whose distance is no more than your range. Base range
  is 1. The Crook and the Hayloft each add 1.
- Characters have 3 or 4 lives (Shepherd +1). Healing can't go above your
  starting total.

## Knocked out: crows

At 0 lives you're knocked out. Reveal your role and discard your hand and kit.
You become a **Crow** and stay on your team.

- At the start of each night, before the Shepherd's turn, each Crow draws 1 card,
  looks at it, and either drops it face down into the Dark pile or discards it.
- Crows don't take turns, can't be targeted, and don't count for distance.
- If the Shepherd knocks out a Sheepdog, one sheep runs off to the den.

## Card list (60 cards)

Icon column is moon / lantern / blank.

### Fighting

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Snap!** | 17 | 7 / 3 / 7 | A player in range loses 1 life unless they Dodge!. One per turn. |
| **Dodge!** | 10 | 3 / 3 / 4 | Cancel a Snap! aimed at you. Can't be used while you're in the Hayloft. |
| **Bristle** | 2 | 1 / 0 / 1 | Play when a Snap! targets you: cancel it, and the attacker loses 1 life. |
| **Pack Howl** | 2 | 1 / 0 / 1 | Name a player. Going clockwise from you, every other living player may Snap! them, ignoring range and their one-per-turn limit. The target may Dodge! each one. |
| **Frenzy** | 1 | 0 / 1 / 0 | You may play up to 2 more Snap!s this turn. |

Pack Howl is a public vote: everyone sees who joins in and who holds back.

### Care

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Mend** | 5 | 2 / 2 / 1 | You or a player at distance 1 regains 1 life. |
| **Round Up** | 2 | 2 / 0 / 0 | Move 1 sheep from the den back to the pen. |

### Cards and tricks

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Forage** | 3 | 1 / 1 / 1 | Draw 3 cards, then put 1 card from your hand in the Dark pile, on top of your normal Dark card. Everyone sees that you did. |
| **Swipe** | 3 | 2 / 0 / 1 | Take a random card from the hand of a player in range. |
| **Spook** | 3 | 1 / 0 / 2 | Any player discards one of their kit cards (your choice), or a random card from hand if they have no kit. |

### Finding the coyotes

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Bell** | 3 | 2 / 0 / 1 | Hang it on another player. Their next Dark card goes in face up, then the Bell is discarded. One Bell per player at a time. |
| **Sniff** | 2 | 1 / 0 / 1 | Look at 2 random cards in a player's hand. |
| **Headcount** | 1 | 1 / 0 / 0 | Look at the Dark pile so far tonight. Tell the table, lie, or say nothing. |

### Kit (stays in front of you; at most 2, no duplicates)

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Hayloft** | 2 | 0 / 1 / 1 | +1 range. You can't Dodge! while you're up here. |
| **Thicket** | 2 | 0 / 1 / 1 | The next Snap! that would cost you a life costs nothing. Then discard the Thicket. |
| **Lantern** | 2 | 0 / 2 / 0 | Adds a lantern to every reveal. Discard it when you lose a life. |

**Crook.** The Shepherd's starting kit, not in the deck. +1 range, can't be
Spooked, and doesn't count toward the 2-kit limit.

A coyote can put a Lantern in play to look trustworthy, at the cost of a sheep
a night. That's the kind of bluff the design wants.

## Characters (8, dealt at random, public)

Every ability ties into this game's own systems: the Dark pile, the sheep,
healing, and Snap!.

| Character | Lives | Ability |
|---|---|---|
| **Old Blue** (hound) | 4 | *Nose for trouble.* Once per night, before the reveal, look at one random card in the Dark pile. |
| **Mabel** (goose) | 4 | *Hiss.* When you Dodge! a Snap!, the attacker discards a random card. |
| **Woolly** (ram) | 4 | *Hold the gate.* Once per night, when the reveal would cost a sheep, you may lose 1 life to save it. |
| **Clementine** (dairy cow) | 4 | *Warm milk.* Your Mend restores 2 lives, split as you like between you and players at distance 1. |
| **Tiny** (bull) | 4 | *Charge.* When someone's Snap! costs you a life, you may play a Snap! back at them at once, ignoring range. It doesn't use your one Snap!. |
| **Duke** (rooster) | 3 | *Wake-up call.* Once per night, pick another player before their turn. Their Dark card tonight goes in face up. |
| **Hazel** (barn owl) | 3 | *Watchful.* You may put your Dark card in face up. If you do, draw 1 card. |
| **Boots** (barn cat) | 3 | *Prowler.* On your turn, put 0 or 2 cards in the Dark pile instead of 1. |

The Shepherd is dealt a character like everyone else.

## Timing and edge rules

- Check for a win immediately after any life is lost and after each reveal.
- When the deck runs out, shuffle the discards into a new deck.
- Face-up Dark cards (from Bell, Duke, Hazel) still count in the reveal.
- A cancelled Snap! still uses up your Snap! for the turn.

## Platform plan

1. **Landing tile.** Done, committed on `coyote`.
2. **Spec.** This doc (v2). Card art in the play27 brand comes later; the first
   build uses text cards with icons.
3. **Single page vs AI.** `coyote.html`, one human plus AI seats, all client-side.
   Validates the rules, balance, and phone layout before any backend work.
   (Pass-and-play was dropped: handing one device around exposes roles.)
4. **Multiplayer.** Supabase schema and RPCs following the contract-rummy pattern
   (games, seats, actions, Realtime), ready check, reconnection.
5. **Server AI seats.** Move the phase-3 AI into an edge function with tier
   profiles. Reading suspicion from the Dark pile counts is the interesting problem.

## Open questions

- **Reveal detail.** Show only icon counts (current default), or the full cards?
  Full cards give more to argue about, but more to read on a phone.
- **8 players.** Rummy supports 8 now. Would need a role row (maybe Shepherd,
  2 Sheepdogs, 3 Coyotes, 2 Foxes?) and makes each night longer.
- **Tile tagline.** The landing tile says "find the coyotes before dark", but the
  game now runs dusk to dawn. Something like "Keep the flock safe until dawn" fits.
- **Phone layout.** Players around the barnyard edge; Dark pile, pen, and den in
  the middle.
