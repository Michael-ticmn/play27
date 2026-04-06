# Contract Rummy — STRATEGY.md

## Current Direction
Building a real-time multiplayer Contract Rummy card game. Frontend is HTML/CSS/JS,
backend will be Supabase (PostgreSQL + Realtime). Deployed via GitHub Pages (free).
SQL procedures exist in T-SQL and will need porting to PostgreSQL/PL/pgSQL.

## Confirmed Decisions
- **Stack**: Supabase (DB + Realtime + Auth) + GitHub Pages (static frontend)
- **Layout**: Landscape-forced. Portrait shows a "rotate your phone" prompt.
- **Players**: 2–6 players, real-time (same session)
- **Buy mechanic**: Configurable countdown timer (default 5s). Multiple players can hit Buy
  during the window. Winner = earliest in turn order among those who pressed Buy before time ran out.
  Active player gets discard free (no buy needed). Out-of-turn buy = discard + 1 penalty card from deck.
- **Lay off on melds**: Only unlocked after you've met your own contract for the round.
- **Opponent melds**: Locked/dimmed until you meet contract, then interactive for lay-offs.

## Game Rules (Contract Rummy)
- 7 rounds, each with a different contract (sets/runs required)
- Contract must be met before laying off cards on others' melds
- Buying happens in turn order — configurable countdown window
- Standard scoring (unmelded cards count against you)

## Phone Layout Problem (HANDOFF TO CODE)
The current v3 layout (contract-rummy.html) looks great on desktop/tablet landscape
but breaks badly on phone landscape (Samsung-style ~740px tall landscape viewport).
The grid layout collapses — opponent melds disappear, hand is cut off, everything chunks.

Code needs to design a phone-optimized landscape layout from scratch.
Key constraints:
- Max usable height ~360–380px in phone landscape after browser chrome
- Must show: your hand, deck+discard, buy button, your status
- Must show opponent names/scores at minimum always
- Melds and opponent detail: Code's call on best UX pattern
- Existing desktop layout should be PRESERVED (use CSS media query to swap)
- The rotate prompt (portrait blocker) is already working — keep it

## Open Questions (for Chat to resolve)
- What are the actual T-SQL procedures? (user hasn't shared yet)
- How many buys per round are allowed? (not confirmed)
- Joker/wild card rules? (not confirmed)

## Constraints Code Must Respect
- Keep existing desktop layout intact — only add a phone landscape breakpoint
- Gold/felt/wood aesthetic must carry through — no generic reskins
- Buy countdown widget must work on phone too
- "YOU" panel identity and active player green indicator must be clear on phone
- File: contract-rummy.html is the current working file
