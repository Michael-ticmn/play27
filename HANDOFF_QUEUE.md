# Contract Rummy — HANDOFF_QUEUE.md

## Pending

- Buy first claim (agreed 2026-10-25): apply `sql/migration-buy-first-claim.sql` in the Supabase SQL editor. It lets whoever's turn it is take the discard free during a buy countdown (cancelling the buys) and locks the round row against resolve_buy. Then set `AI_BUYS_ON_PEOPLES_TURNS = true` in js/contract-rummy.js so AIs start buys on every turn, not only on AI turns. The Draw Discard button and "Take it free" label are already live.
- Round 6 AI tuning: in Michael's live round 6 (all Hard) the AIs took the discard 58 to 75% of turns, threw recent pickups straight back out, and 3 of 4 never made the contract in 120 turns. Baseline R6 in the training harness per AI_TUNING_PLAYBOOK.md; target is a clear ladder of levels. Michael's uncommitted ai-training work is mid-experiment: read and report on it before building on it.
- Scorekeeper "Who went out?" picker on phones (needs a database change). A new SECURITY DEFINER function lets a seated player mark another player as going out for the current hand: only when nobody has 0 yet, and only for a player with no score. Michael applies the SQL in the Supabase SQL editor; then the phone flow asks "Who went out?" first and the winner's phone shows "You went out". The contested screen (v0.15.12) already handles disputes. Agreed 2026-10-25.
- Contract Rummy (in-app) round-end reveal plus scoreboard countdown and auto-deal: X minutes set by the host, default 1 (needs a database change). Agreed 2026-10-25.

## Completed
- ✅ Initial landscape layout built (portrait → landscape) — 2026-04-02
- ✅ Buy countdown mechanic added — 2026-04-02
- ✅ YOU panel identity + active player green indicator — 2026-04-02
- ✅ Portrait rotate prompt added — 2026-04-02
- ✅ Phone landscape layout redesign — 2026-04-03
- ✅ Supabase backend — full SQL schema + RPC functions — 2026-04-04
- ✅ Real-time multiplayer — realtime subscriptions + game state sync — 2026-04-05
- ✅ AI player system — 16 profiles, edge functions, tier-based decisions — 2026-04-08
- ✅ Mobile portrait layout — large cards, horizontal buttons, z-index for selected — 2026-04-09
- ✅ Ready check at round start — 2026-04-10
- ✅ Late join / spectator system — 2026-04-10
- ✅ AI tier tuning — contract weakness bias, urgency system, quality gates — 2026-04-12
- ✅ Round 7 must-meld-all — variable-length runs, server enforcement, client validation — 2026-04-12
