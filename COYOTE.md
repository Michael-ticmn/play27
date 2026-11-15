# Coyote: Design Spec

## As of 2026-11-14, draft v2.2 (branch `coyote`, based on v0.15.24)

v2.2 adds the Hunter, a weaker Shepherd (everyone lost a life, the Shepherd kept
only its +1), the coyote bounty, per-count nights, and AI difficulty levels. Each
change was tested in simulation first (see "Tuning log" at the end). Playable
preview: `coyote.html` (one human vs computer players). Simulator:
`tools/coyote-sim.mjs`.

A hidden-role card game for 4 to 7 players. A farm, dusk to dawn: the Shepherd
has to hold the flock together while coyotes hide among the animals.

**What changed from v1.** v1 (2026-07-09) copied the classic hidden-role shootout's
card list, card counts, and character abilities one for one under new names. v2
keeps only the genre structure (a public leader with hidden teams, seat distance
and range, attack and dodge, gear in front of you) and replaces the rest with an
original design built on four farm ideas:

- **Dawn clock.** The game lasts 7 nights (6 at 7 players). If the Shepherd
  survives to dawn, the flock wins. Games have a fixed length.
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

| Players | Shepherd | Farmhands | Hunter | Coyotes | Fox | Den target | Nights |
|---|---|---|---|---|---|---|---|
| 4 | 1 | 1 | 0 | 2 | 0 | 7 sheep | 7 |
| 5 | 1 | 1 | 1 | 2 | 0 | 3 sheep | 7 |
| 6 | 1 | 1 | 1 | 2 | 1 | 4 sheep | 7 |
| 7 | 1 | 1 | 1 | 3 | 1 | 11 sheep | 6 |

- **Shepherd** (public, flock team). +1 life. Starts with the Crook in play.
- **Farmhand** (hidden, flock team). Still wins with the flock after being knocked out.
  (Called the Sheepdog until 2026-11-14; renamed because roles and characters
  were both animals, so a goose who was a Sheepdog read as a contradiction.)
- **Hunter** (hidden, flock team, 5+ players). *Long gun:* once per night, may
  Snap! a player at any distance; the first long shot reveals the Hunter.
  *Last shot:* when knocked out, immediately Snap! any player (no card needed;
  they may Dodge!). Still wins with the flock after being knocked out.
- **Coyote** (hidden, coyote team). Coyotes know each other (a pack). Still wins
  with the coyotes after being knocked out.
- **Fox** (hidden, 6+ players, plays for itself). Wins if it is alive when the game
  ends and has knocked out at least 1 player, whichever team wins. The Fox's win
  is in addition to the team win, not instead of it.

The den targets look uneven because the moon rate depends on how many coyotes
face how many flock players: 5 players (2 coyotes against 3 flock) loses sheep
slowly, 7 players (3 against 3) loses them fast. One sheep swings the 5 and 6
player games by about 20 points, so the extra seventh night is the fine-tuning
lever there. Each setting was chosen by simulation so coyotes win close to half
the time at every count.

### How each side wins

- **Coyotes** win immediately when the Shepherd is knocked out, or when the den
  reaches the target.
- **Flock** wins immediately when every Coyote is knocked out, or at dawn (after
  the last night's reveal) if the coyotes haven't won.

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

- Each **moon** takes one sheep to the den.
- Every **2 lanterns** cancel one moon. Each Lantern kit in play adds one lantern.
- Sheep lost = moons minus (lanterns ÷ 2, rounded down), never below 0.

Everyone sees the icon counts, never who put in what. The revealed cards are
discarded, so their day effects are gone. Then the moon marker moves on. After
the last night's reveal, dawn breaks.

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
- Characters have 2 or 3 lives (Shepherd +1). Healing can't go above your
  starting total.

## Knocked out: crows

At 0 lives you're knocked out. Reveal your role and discard your hand and kit.
You become a **Crow** and stay on your team.

- At the start of each night, before the Shepherd's turn, each Crow draws 1 card,
  looks at it, and either drops it face down into the Dark pile or discards it.
- Crows don't take turns, can't be targeted, and don't count for distance.
- **Bounty:** when a Coyote is knocked out, one sheep comes home from the den.
  This is what makes finding the coyotes pay off; without it, coyote crows kept
  raiding and catching coyotes barely changed who won.
- If the Shepherd knocks out one of the flock (Farmhand or Hunter), one sheep
  runs off to the den.

## Card list (60 cards)

Icon column is moon / lantern / blank.

### Fighting

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Snap!** | 17 | 7 / 3 / 7 | A player in range loses 1 life unless they Dodge!. One per turn. |
| **Dodge!** | 10 | 3 / 3 / 4 | Cancel a Snap! aimed at you. Can't be used while you're in the Hayloft. |
| **Bristle** | 2 | 1 / 0 / 1 | Play when a Snap! targets you: cancel it, and the attacker loses 1 life. |
| **Pack Howl** | 2 | 1 / 0 / 1 | Name a player. Going clockwise from you, every other living player (not you, not the target) may Snap! them, ignoring range and their one-per-turn limit. The target may Dodge! each one. |
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
| **Headcount** | 1 | 1 / 0 / 0 | See the icons in the Dark pile so far tonight (not who put them in). Tell the table, lie, or say nothing. |

### Kit (stays in front of you; at most 2, no duplicates)

| Card | Count | Icons | Effect |
|---|---|---|---|
| **Hayloft** | 2 | 0 / 1 / 1 | +1 range. You can't Dodge! while you're up here. |
| **Thicket** | 2 | 0 / 1 / 1 | The next Snap! that would cost you a life costs nothing. Then discard the Thicket. |
| **Lantern** | 2 | 0 / 2 / 0 | Adds a lantern to every reveal. Discard it when you lose a life. |

**Crook.** The Shepherd's starting kit, not in the deck. +1 range, can't be
Spooked, and doesn't count toward the 2-kit limit.

A coyote can put a Lantern in play to look trustworthy, at the cost of half a moon
a night. That's the kind of bluff the design wants.

## Characters (8, dealt at random, public)

A character is separate from a role. The role is your secret side; the
character is the farm animal you play, with one ability. Any animal can have any
role, so the game says so on the intro screen and in the rules, and always labels
the two ("Role", "Character"). Playtest note: without those labels, "You are a
Sheepdog" next to "You are Mabel the goose" read as a contradiction.

Every ability ties into this game's own systems: the Dark pile, the sheep,
healing, and Snap!.

| Character | Lives | Ability |
|---|---|---|
| **Old Blue** (hound) | 3 | *Nose for trouble.* Once per night, before the reveal, see one random face-down card in the Dark pile and who put it in. |
| **Mabel** (goose) | 3 | *Hiss.* When you Dodge! a Snap!, the attacker discards a random card. |
| **Woolly** (ram) | 3 | *Hold the gate.* Once per night, when the reveal would cost a sheep, you may lose 1 life to save it. |
| **Clementine** (dairy cow) | 3 | *Warm milk.* Your Mend restores 2 lives, split as you like between you and players at distance 1. |
| **Tiny** (bull) | 3 | *Charge.* When someone's Snap! costs you a life, you may play a Snap! back at them at once, ignoring range. It doesn't use your one Snap!. |
| **Duke** (rooster) | 2 | *Wake-up call.* At the start of each night, pick another player. Their Dark cards tonight go in face up. |
| **Hazel** (barn owl) | 2 | *Watchful.* You may put your Dark card in face up. If you do, draw 1 card. |
| **Boots** (barn cat) | 2 | *Prowler.* On your turn, put 0 or 2 cards in the Dark pile instead of 1. |

The Shepherd is dealt a character like everyone else.

## Timing and edge rules

- Check for a win immediately after any life is lost and after each reveal.
- When the deck runs out, shuffle the discards into a new deck.
- Face-up Dark cards (from Bell, Duke, Hazel) still count in the reveal.
- A Bell applies to the next card you put in the Dark pile, including a Forage card.
- A cancelled Snap! still uses up your Snap! for the turn.
- You can't put a third kit card in play; Spook one away first.
- Night order: crows act, then Duke wakes someone, then turns from the Shepherd
  clockwise, then Old Blue peeks, then Woolly may hold the gate, then the reveal.
- A Hunter's last shot happens right after the knockout, before play continues.

## Computer players and difficulty

Tiers live in one table in `js/coyote-ai.js` (like rummy's `tiers.ts`). In a game
the chosen difficulty applies to your opponents; computer teammates play Normal.

| Tier | What changes |
|---|---|
| Easy | 25% sloppy choices (random targets, skipped plays, missed Dodge!s), reads the reveal poorly, timid attacks |
| Normal | The baseline everything is balanced around |
| Hard | Bolder attacks, weighs the reveal more, coyotes gang up on a weak Shepherd, and peeks at about 1 in 3 face-down Dark cards |
| Unfair | Hard, plus sees every face-down Dark card |

Measured against Normal opponents (500 games per count): an Easy flock wins only
15 to 21%, a Hard or Unfair flock wins 51 to 67% (the gain shows at 5 and 6
players). Easy coyotes win 27 to 32%. Hard and Unfair coyotes are no stronger
than Normal: seeing who holds lanterns doesn't help fill the den, and attacking
the Shepherd earlier only exposes them. So Hard and Unfair are a real step up
when you play a Coyote or the Fox, but not yet when you play the flock.

## The helper (reads and coach)

Hidden-role games are hard to follow from a phone: the board shows what happened
but not what it means. The helper fixes that from your own seat's point of view.

- **Clues and reads** (`js/coyote-clues.js`, no DOM). Every event you can see is
  turned into a clue about the player who did it ("Snapped the Shepherd",
  "Mended the Shepherd", "Put a moon in the Dark pile face up"), weighted the
  same way the Normal computer players weigh it. Each unknown seat shows a read:
  Likely coyote, Suspicious, Seems flock, Likely flock (or none yet). A coyote
  already knows its pack, so for a coyote a hostile read says "Likely Fox".
- **Elimination.** Role counts are public, so when only one role (or only flock
  roles) can be left among the seats you don't know, the seat shows that role.
- **Player sheet.** Tap any player for everything you've seen them do, newest
  first, each marked coyote-like or flock-like. Tap your own panel for your role,
  goal, and a short plan. **Who's who** (top bar) shows each side's goal and
  every player's read. The game pauses while a sheet or the rules are open.
- **Feed tags.** Lines that matter get a "coyote move" or "flock move" tag, and
  attacks on the Shepherd name the Shepherd.
- **Coach.** First-game tips at the moments they matter: your plan after the
  intro, your first day, first Dark card, first reveal, first knockout, the first
  coyote-like or flock-like move by someone else, a Shepherd down to 2 lives, the
  den one sheep from full. At most 3 queue up; older ones drop.
- **Learn to play** (setup) starts the friendliest first game: Farmhand, 5
  players, Easy opponents, coach on. A scripted tutorial was considered and
  passed over: rules are still being tuned, and a fixed script would break on
  every change.
- **Helper setting:** Coach tips + reads (default), Reads only, or Off (the
  sheets still list what people did, with no reads or tags).

Accuracy, from `node tools/coyote-clue-check.mjs` (1,200 games, all four
player counts, Normal AI, reads sampled at every nightly reveal), for a viewer on
the flock side:

| Read | Share of reads | Really coyote | Really Fox | Really flock |
|---|---|---|---|---|
| (everyone unknown) | 100% | 53% | 15% | 31% |
| Likely coyote | 33% | 88% | 12% | 0% |
| Suspicious | 18% | 66% | 23% | 11% |
| No read yet | 28% | 42% | 20% | 37% |
| Seems flock | 9% | 8% | 10% | 82% |
| Likely flock | 12% | 0% | 3% | 97% |

13,394 roles worked out by elimination, 0 wrong. These numbers are against
computer players, who don't bluff much. Against people, reads will be weaker.
They also make the flock's job easier, which is why the helper can be turned off.

## Platform plan

1. **Landing tile.** Done, committed on `coyote`.
2. **Spec and art.** This doc. Art lives in `assets/coyote/` as flat SVG in the
   play27 house style, generated by `tools/coyote-art.py` (edit there and rerun):
   8 character portraits, 5 role badges, the card back, and the setup banner.
   Card-face illustrations for the 16 card types are still to do; cards show
   name, group color, effect text, and night icon for now.
3. **Single page vs AI.** In progress. `coyote.html` + `js/coyote-engine.js`
   (rules, no DOM) + `js/coyote-ai.js` (computer players) + `css/coyote.css`.
   One human plus AI seats, all client-side. (Pass-and-play was dropped: handing
   one device around exposes roles.) The engine is shared with the simulator, so
   balance changes are tested headless before anyone plays them.
4. **Multiplayer.** Supabase schema and RPCs following the contract-rummy pattern
   (games, seats, actions, Realtime), ready check, reconnection.
5. **Server AI seats.** Move the phase-3 AI into an edge function with tier
   profiles. Reading suspicion from the Dark pile counts is the interesting problem.

## Open questions

- **Reveal detail.** Show only icon counts (current default), or the full cards?
  Full cards give more to argue about, but more to read on a phone.
- **8 players.** Rummy supports 8 now. Would need a role row (maybe Shepherd,
  2 Farmhands, 3 Coyotes, 2 Foxes?) and makes each night longer.
- **Tile tagline.** The landing tile says "find the coyotes before dark", but the
  game now runs dusk to dawn. Something like "Keep the flock safe until dawn" fits.
- **Phone layout.** Built as a grid of seats in clockwise order from you, with
  the night track, den, and Dark pile in the middle. A true circle around the
  barnyard may read better on a tablet.
- **Stronger computer coyotes.** Hard and Unfair coyotes need a real skill
  edge (better den play or bluffing), not more information.
- **Fox is generous.** With knockouts more common in v2.2, a Fox that needs 1
  knockout wins 38 to 45% (2 knockouts: 4 to 11%). It never takes a win away
  from anyone, so 1 stays for now. Revisit after people play it.
- **Fragile characters.** Duke, Hazel, and Boots have 2 lives. Watch whether
  they feel too easy to knock out.
- **Game name.** "Coyote" is already a published card game, so it needs a new
  name before any retail sale. Checked 2026-11-14 (web search, not a trademark
  search): Prowl (two games, 2024 and 2025), Hunt/Hunted (several), and anything
  with "Sheep's Clothing" are taken. No exact match found for "By the Moonlight",
  "Lanterns Out", or "Dusk to Dawn". Run a USPTO search before printing.
- **Helper vs challenge.** Reads are right about 90% of the time against the
  computer players. Consider defaulting experienced players to Reads only or
  Off, or hiding reads on Hard and Unfair.

## Tuning log

**2026-11-14, first pass** (`node tools/coyote-sim.mjs`, 400 to 1,000 games per
setting, phase-3 AI):

- With 1 lantern cancelling 1 moon, flock players found a lantern on about 64% of
  turns (well above the 47% estimate) and the den barely moved: 0.18 sheep a night
  at 5 players. Flock won 58% to 94% depending on count, mostly by waiting for
  dawn. Lantern kits were not the cause (about 0.04 moons a night).
- Changed to 2 lanterns per moon, then set den targets per count, moved the Fox
  to 1 knockout (at 2 it won 2%), and kept 3 coyotes at 7 players (2 coyotes
  made the flock win 80%+).
- Result, 1,000 games per count, card conservation checked every turn, 0 errors:

| Players | Flock wins | Coyotes win (Shepherd / den) | Fox also wins |
|---|---|---|---|
| 4 | 50% | 50% (9% / 41%) | n/a |
| 5 | 56% | 44% (3% / 41%) | n/a |
| 6 | 50% | 50% (6% / 44%) | 17% |
| 7 | 52% | 48% (18% / 30%) | 27% |

**2026-11-14, second pass** (Hunter, weaker Shepherd, difficulty):

- Difficulty tiers exposed a design flaw: a flock that could see every
  face-down card knocked out 3 times as many coyotes but won no more often,
  because knockouts were rare (0.4 to 1.0 per game) and coyote crows kept the
  den filling. Finding the coyotes, the point of the game, barely mattered.
- Fixes: everyone has 1 fewer life (the Shepherd keeps +1, so the Shepherd
  drops from 4-5 to 3-4 lives), and knocking out a Coyote returns a sheep from
  the den (bounty 1 and 2 tested the same; kept 1).
- Hunter replaces one Sheepdog (now Farmhand) at 5+ players. On its own it moved win rates by
  a point or two; long shots happen in 25 to 31% of games, last shots in 8 to 18%.
- Den targets and nights retuned (7 nights at 4 to 6 players, 6 at 7 players).
- Result, 1,000 games per count, Normal vs Normal, 0 errors:

| Players | Flock wins (dawn / all coyotes out) | Coyotes win (Shepherd / den) | Fox also wins | Knockouts per game |
|---|---|---|---|---|
| 4 | 47% (35% / 12%) | 54% (24% / 29%) | n/a | 1.0 |
| 5 | 58% (20% / 38%) | 42% (7% / 35%) | n/a | 1.2 |
| 6 | 51% (15% / 36%) | 49% (10% / 39%) | 38% | 1.4 |
| 7 | 48% (40% / 9%) | 52% (33% / 19%) | 44% | 1.9 |
