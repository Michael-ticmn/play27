# Contract Rummy — CURRENT_STATE.md

## As of 2026-04-12 (v0.13.9)

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
- Contract solver with backtracking — finds optimal meld combinations
- Speculative pickups with quality gates and contract weakness bias
- Multi-meld progress tracking for mixed contracts (e.g., 2S+1R tracks top-2 value groups)
- Urgency system — reduced mistake rate and loosened pickup gates at high scores
- Round 7 support — variable-length runs, must-meld-all solver, server enforcement
- Drawn/bought card protection — hard block on discarding recently acquired cards
- Table awareness — avoids discarding cards opponents can lay off on (Normal+)
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

**Infrastructure:**
- Supabase: PostgreSQL DB, Realtime subscriptions, Edge Functions, Auth
- GitHub Pages: static frontend hosting
- SQL: CREATE OR REPLACE functions applied via `supabase db query --linked`
- Edge Functions deployed via `supabase functions deploy`

**What's in progress:**
- Playtesting AI tier behavior and tuning decision quality per round
- Mobile portrait layout refinements

**Which surface should act next:** Playtesting
