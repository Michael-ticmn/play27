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
- Settings: theme (light/dark), hand view, meld view, card sort, ding on turn, fullscreen (also a Full screen button in the top bar; in full screen the top bar clears the iPad close button)
- Seats around the table follow turn order from each viewer: the next player to play sits on your left (v0.15.15; before this only seat 0 saw the right order)
- Ding on turn — Web Audio sine tone when it becomes your turn (toggle in settings)
- Ready check at round start — all players confirm before play begins
- Late join / spectator system — spectator view, host approval, deal-in next round

**Scorekeeper: in-person Contract Rummy with real cards (v0.15.0 to v0.15.2, 2026-10-16):**
- scorekeeper.html: host table display for an iPad or laptop. Current contract with example melds, dealer and first player, standings and a score sheet; landscape fills the screen. Starting a table requires a play27 sign-in.
- scorecard.html?t=CODE: player page for phones. Scan the join QR, enter a name or claim a seat the host added, then enter your own score with the card keypad. No account needed.
- Host controls: add players without a phone, enter or fix any score, seat order and first dealer, deal, finish, rematch, free a seat, and a host QR that makes another device a host (no sign-in on that device).
- Read aloud: any host device can have host devices with Speaker on read the standings and/or the current hand (browser speech).
- Hand reveal (v0.15.4, layout v0.15.7, js/score-reveal.js): when the last score of a hand comes in, host screens show the hand's scores low to high (optional funny remarks, toggle in Setup), the next deal, then the standings high to low, each flown into a reserved slot of a centered stack; the next hand sits top center in large type the countdown in the middle of the screen (v0.15.10), and the time of day at the bottom (v0.15.11). A 2-minute countdown follows; then the next hand starts by itself and the board returns. "Deal now" skips the wait. The final hand plays the hand scores, then a full-page final standings (last place first, winner row larger with a trophy) with confetti and floating emoji; no countdown, and it stays up until the host taps Finish game or Back to the board (v0.15.14). Every host device works out the same deal time from the last score's save time, so any one of them can deal; a hand set back from Setup is never auto-dealt.
- Backend: sql/migration-scorekeeper.sql. score_* tables, SECURITY DEFINER functions, a secret key per device (stored hashed), anon read access, realtime. Defaults come from the contracts table. Tables idle for 24 hours are removed; finished games stay in score_history.
- Board right side (v0.15.8): once play starts, the wide board shows standings and the score sheet one at a time, switching every 30 seconds (tabs switch by hand and restart the timer). Rows size to the space for the number of players; the score sheet lists the lowest total first (v0.15.13). The current hand's melds also size to the height left, so the Start / Deal bar never needs a scroll (v0.15.6).
- Contested hand (v0.15.12): only one player can go out. The keypad refuses a second 0 ("Ann already went out") unless the player taps the dispute link. When every score is in and two or more are 0, host screens show "Winner contested" instead of the reveal, with no automatic deal; the host taps who really went out, the others go back to no score, and the reveal plays once they re-enter. Phones show the contest and "Ann went out" in their status line.
- Local testing: add ?sb=local to point both pages at the local Supabase stack.

**Invite-first sign-up (v0.15.2):**
- login.js checks the code with check_invite_code() before calling signUp and sends it in the sign-up metadata. Previously the account was created first, and with email confirmation on the code was never checked.
- sql/migration-invite-signup.sql: a BEFORE INSERT trigger on auth.users rejects accounts without a valid, unexpired code; an AFTER INSERT trigger records the redemption.
- The dashboard "Add user" is now refused; the admin API needs user_metadata.invite_code. Accounts created before the fix may have no recorded redemption.

**Password reset (v0.15.5):**
- "Forgot your password?" on login.html and on Scorekeeper's sign-in (login.html?reset=scorekeeper). Emails a reset link with redirect_to = login.html; the link opens a "Choose a new password" form (PUT /auth/v1/user by direct fetch), then returns to Scorekeeper or the lobby.
- index.html forwards a recovery or link-error hash to login.html, in case Supabase falls back to the Site URL.
- iOS Keychain stores passwords per domain, and mycellar shares michael-ticmn.github.io, so autofill can offer the mycellar password on play27.

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
