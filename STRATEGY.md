# Contract Rummy — STRATEGY.md

## Current Direction
Real-time multiplayer Contract Rummy card game with AI opponents.
Frontend is HTML/CSS/JS, backend is Supabase (PostgreSQL + Realtime + Edge Functions).
Deployed via GitHub Pages (static frontend) + Supabase cloud (backend).

## Confirmed Decisions
- **Signup**: Invite-only. Codes are multi-use, expire after 4 hours. Game codes double as invite codes.
- **Stack**: Supabase (DB + Realtime + Auth + Edge Functions) + GitHub Pages (static frontend)
- **Layout**: Landscape on desktop/tablet, portrait on mobile. Settings persist in localStorage.
- **Players**: 2–6 players, real-time. At least 1 human required (host). AI fills remaining seats.
- **AI Players**: 4 names (LuVerne, Jeanne, Ron, Sue) × 4 tiers (Easy, Normal, Hard, Unfair). Max 1 per name per game. Server-side via Edge Functions.
- **Buy mechanic**: Configurable countdown timer (default 5s). Multiple players can buy during window. Winner = earliest in turn order. Buy = discard + 1 penalty card from deck.
- **Lay-offs**: Only after meeting contract, and NOT on the same turn as fulfillment.
- **Aces**: High (after K) or low (before 2). No wrapping (K-A-2 is invalid).
- **Jokers**: Wild in any set or run. Score 50 points as deadwood. Can be laid off on any meld.
- **Scoring**: Face value for number cards, 10 for face cards (J/Q/K), 15 for aces, 50 for jokers.
- **Round 7**: 3 Runs, must meld all cards. Exactly 1 card remains for final discard. Runs can be longer than 3.

## Game Rounds
| Round | Contract | Cards Dealt |
|-------|----------|-------------|
| 1 | 2 Sets of 3 | 6 |
| 2 | 1 Set + 1 Run | 7 |
| 3 | 2 Runs | 8 |
| 4 | 3 Sets | 9 |
| 5 | 2 Sets + 1 Run | 10 |
| 6 | 1 Set + 2 Runs | 11 |
| 7 | 3 Runs (must meld all) | 12 |

## AI Tier Summary
| Tier | Mistake Rate | Lay-off Detection | Speculative Pickups | Urgency |
|------|-------------|-------------------|---------------------|---------|
| Easy | 50% | 15% | No | No change |
| Normal | 30% (→5% at 200+) | 70% | Yes (2-match) | Loosens to 1-match at 200+ |
| Hard | 10% (→5% at 150+) | 100% | Yes (1-match) | Near-perfect at 150+ |
| Unfair | 0% | 100% | Yes (1-match) | Already perfect |

See `assets/ai-tier-reference.md` for full decision logic and evaluation checklist.

## Architecture
- SQL functions handle all game state mutations (draw, discard, meld, buy, etc.)
- `p_acting_as` parameter lets Edge Functions call RPCs on behalf of AI players
- Realtime subscriptions notify clients of state changes
- Host client triggers AI turns via Edge Function calls
- AI decision engine: hand-analyzer.ts (meld detection, contract solving) + strategy.ts (tier-based decisions) + tiers.ts (profiles)
