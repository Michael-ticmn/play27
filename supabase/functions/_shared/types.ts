// Card ID format: DSVV (deck, suit, value)
export type CardId = string;

export interface GameState {
  game_id: string;
  code: string;
  status: 'waiting' | 'active' | 'finished';
  players: Player[];
  buy_countdown_seconds: number;
  has_ai_players: boolean;
  is_modified: boolean;
  created_by: string;
  round?: Round;
  my_hand?: CardId[];
  my_has_met_contract?: boolean;
  my_has_drawn?: boolean;
  melds?: Meld[];
  opponents?: Opponent[];
  round_scores?: RoundScore[];
  dealer_seat?: number;
  next_dealer_seat?: number;
}

export interface Player {
  player_id: string;
  display_name: string;
  seat_position: number;
  is_connected: boolean;
  is_you: boolean;
  is_ai: boolean;
  ai_name: string | null;
  ai_tier: string | null;
  total_score: number;
  rounds_won: number;
  total_buys: number;
  jokers_used: number;
  final_round_score: number;
}

export interface Round {
  id: string;
  round_number: number;
  contract_sets: number;
  contract_runs: number;
  cards_dealt: number;
  dealer_seat: number;
  current_turn_seat: number;
  turn_phase: 'draw' | 'action' | 'discard' | 'buy_window';
  draw_pile_count: number;
  top_discard: CardId | null;
  discard_count: number;
  discard_bought: boolean;
  status: 'dealing' | 'active' | 'finished';
}

export interface Meld {
  id: string;
  player_id: string;
  meld_type: 'set' | 'run';
  cards: CardId[];
}

export interface Opponent {
  player_id: string;
  cards_in_hand: number;
  has_met_contract: boolean;
  buys_used: number;
  score: number;
}

export interface RoundScore {
  round_number: number;
  scores: { player_id: string; score: number }[];
}

// Card parsing helpers
export function cardDeck(card: CardId): number { return parseInt(card[0]); }
export function cardSuit(card: CardId): number { return parseInt(card[1]); }
export function cardValue(card: CardId): number { return parseInt(card.slice(2)); }
export function isJoker(card: CardId): boolean { return card[1] === '9'; }

// Suit names for display
export const SUIT_NAMES = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];

// Card point value for scoring
export function cardPoints(card: CardId): number {
  if (isJoker(card)) return 25;
  const v = cardValue(card);
  if (v === 14) return 15; // Ace
  if (v >= 11) return 10; // Face cards
  return v;
}
