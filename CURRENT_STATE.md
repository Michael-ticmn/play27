# Contract Rummy — CURRENT_STATE.md

## As of 2026-04-12 (v0.14.0)

**What exists and works:**
- index.html — landing page with game directory, copyright footer
- login.html — auth with invite-only signup, lobby, game history
- contract-rummy.html — full game UI (landscape + mobile portrait)
- Invite-only signup — multi-use codes, 4-hour expiry, redeemed via RPC
- Game code = invite code — creating a game auto-generates an invite code; share one link to sign up + join
  - URL format: login.html?game=CODE (pre-fills invite, auto-joins after signup/login)
- Full 7-round game loop with Supabase backend (PostgreSQL + Realtime + Edge Functions)
- Real-time multiplayer with connection tracking and reconnection
- Buy countdown mechanic (animated ring, turn-order queue, toast)
- Card selection, drag-and-drop reorder, sort modes (Custom / Set / Run)
- Suit sort alternates black/red: Spades → Hearts → Clubs → Diamonds
- Meld staging UI with auto-detection (set vs run), contract validation
- Lay-off on opponent melds after contract met (not same turn as fulfillment)
- Round-end overlay with per-round scores, cumulative standings, deal-next
- Game log with timestamped entries
- Settings: theme (light/dark), hand view, meld view, card sort, ding on turn, fullscreen
- Ding on turn — Web Audio sine tone when it becomes your turn (toggle in settings)
- Ready check at round start — all players confirm before play begins
- Late join / spectator system — spectator view, host approval, deal-in next round

**AI System:**
- 4 AI players (LuVerne, Jeanne, Ron, Sue) × 4 tiers (Easy, Normal, Hard, Unfair)
- Supabase Edge Functions: ai-turn (full turn logic), ai-buy (buy decisions)
- Host client triggers AI turns — edge function reads state, decides, calls same RPCs as humans
- Centralized tier profiles (tiers.ts) — all behavior per tier in one file
- Round-specific strategy profiles (round-profiles.ts) — per-round modifiers on top of tiers
  - Set/run relevance weights, isolation penalty, speculative thresholds, buy adjustments
  - Resolver merges tier + round into effective profile for each decision
- Contract solver with backtracking — finds optimal meld combinations
- Speculative pickups with quality gates and contract weakness bias
- Multi-meld progress tracking for mixed contracts (e.g., 2S+1R tracks top-2 value groups)
- Urgency system — reduced mistake rate and loosened pickup gates at high scores
- Round 7 support — variable-length runs, must-meld-all solver, server enforcement
- Drawn/bought card protection — hard block on discarding recently acquired cards
- Table awareness — avoids discarding cards opponents can lay off on (Normal+)
- Card memory system (card-memory.ts) — tier-gated visible card tracking from game_actions
  - Normal: last 5 actions, tracks opponent pickups/buys
  - Hard: last 20 actions + opponent tracking, opponent hand model with memory decay
  - Unfair: full round history, perfect opponent hand model, feed strategy for manufacturing lay-offs
- Opponent hand model (opponent-model.ts) — tracks each opponent's known cards with timestamps
  - Hard forgets cards after N actions; Unfair remembers everything
  - Wired into rankDiscards — post-contract feedLayOffBonus scores strategic discards
  - Enables strategic discard: feed opponents to trigger melds, then lay off duplicates
- Game settings awareness — AI reads num_decks, num_jokers, max_buys from game table
  - Card availability math uses actual totalPerValue (numDecks × 4) instead of hardcoded 4
  - Dead-path rejection, contract relevance, and buy evaluation all deck-aware
- Post-contract buy skip — AI no longer buys cards after meeting contract
- Buy thresholds tuned: Easy 70, Normal 50, Hard 55, Unfair 55
- Unfair minSpeculativeMatch: 2 — only picks up discards that complete a set (already holding pair)
- Tier-appropriate timing delays for human-like pacing
- AI debug panel (host only) — pause/resume, show AI hands, action log

**Round 7 (Final Hand):**
- Contract: 3 Runs (must meld all cards except 1 discard)
- Runs can be longer than 3 cards
- Aces: high (after K) or low (before 2), no wrapping (K-A-2 invalid)
- Server enforces must_go_out — rejects melds leaving >1 card
- Client validates all-but-1 before allowing submit
- AI solver tries variable-length runs, only accepts 0–1 remaining
- AI draw: adjacency-based speculation with solvability check (not partial-meld logic)
- AI discard: solvability scoring — counts valid 3-run solutions without each card
- AI discard: -50 isolation penalty for face cards (J/Q/K/A) without same-suit neighbors
- AI buy: aggressive connector buying — gap-fillers score 90, extenders 60, no penalty cost

**UI Polish:**
- Suit sort alternates black/red: Spades → Hearts → Clubs → Diamonds
- Run sort: Ace sorts low when hand has a 2 of same suit
- Ding on turn: Web Audio tone when it becomes your turn (settings toggle)
- AI error recovery: auto-retry on errors, triggers on action phase for mid-turn crashes

**AI Training Harness:**
- Local Deno script that creates real games via existing RPCs — zero new game logic
- Imports strategy/hand-analyzer modules directly — same decisions as production, no delays
- Runs against local Supabase (Docker) for ~10s per game (vs ~200s hosted)
- Training tables: training_runs, training_games, training_decisions
- CLI: `train.ts --games 100 --seats "LuVerne:easy,Jeanne:hard" --round 1`
- Logs win rates, scores, turns per game; optional per-decision logging
- See TRAINING.md for setup and tuning workflow

**Infrastructure:**
- Supabase: PostgreSQL DB, Realtime subscriptions, Edge Functions, Auth
- GitHub Pages: static frontend hosting
- Local Supabase: Docker-based dev environment for training harness
- SQL: CREATE OR REPLACE functions applied via `supabase db query --linked`
- Edge Functions deployed via `supabase functions deploy`

**Round 1 Training Results (100-game runs):**
- Easy 1% / avg 32 — never wins, always melds, stable bottom
- Normal 54% / avg 8 — dominates through low mistakes and tight hand management
- Hard 18% / avg 15 — melds fast, speculative pickups sometimes backfire
- Unfair 26% / avg 19 — feed strategy has narrow impact in sets-only rounds
- Round 1 tier separation: Easy < Hard/Unfair < Normal (Normal still dominant)
- Feed strategy (opponent model) more impactful in run-heavy rounds with wider lay-off surface

**What's in progress:**
- AI training: Round 3 tuning (2 runs of 3) — first pure-run contract
- Mobile portrait layout refinements

**Which surface should act next:** Tune Round 3 (2 runs) — pure runs have wider lay-off surface (any adjacent suit card), should favor Unfair's feed strategy and card memory significantly more than sets-only Round 1
