# Contract Rummy — CURRENT_STATE.md

## As of 2026-04-02

**What exists and works:**
- contract-rummy-v3.html — full landscape game UI
  - 6-column opponent strip with melds, card backs, scores
  - Buy countdown mechanic (animated ring, turn-order queue, toast)
  - Your hand with card selection (tap to select/deselect)
  - YOU panel (gold border + ribbon) clearly identifies local player
  - Active player (green border + "THEIR TURN" label) clearly identified
  - Portrait blocker — rotate prompt shown in portrait, game hidden
  - Locked vs interactive melds (locked until contract met)
  - Game log + chat column
  - All action buttons (Draw Deck, Draw Discard, Lay Down Meld, Lay Off Card, Discard)

**What's broken / incomplete:**
- Phone landscape layout is broken — too tall/narrow, grid collapses badly
  (tested on Android phone ~740px landscape viewport)
- No real backend yet — all data is static/demo
- No Supabase connection
- T-SQL procedures not yet shared or ported

**What's in progress:**
- Phone landscape layout redesign — handed off to Claude Code

**Immediate next action:**
- Claude Code: design phone landscape layout using CSS media query breakpoint
  (target: max-height ~400px landscape, or max-width ~900px landscape)
  Keep desktop layout untouched. Gold aesthetic must carry through.

**Which surface should act next:** Code
