// ============================================================
// Training Harness — Config & CLI Parsing
// ============================================================

export interface SeatConfig {
  aiName: string;   // LuVerne | Jeanne | Ron | Sue
  aiTier: string;   // easy | normal | hard | unfair
}

export interface TrainingConfig {
  label: string;
  numGames: number;
  roundNumber: number;
  seats: SeatConfig[];
  gameSettings: {
    buyCountdown: number;
    maxBuys: number | null;
    numDecks: number;
    numJokers: number;
  };
  logDecisions: boolean;
}

const AI_NAMES = ['LuVerne', 'Jeanne', 'Ron', 'Sue'];
const AI_TIERS = ['easy', 'normal', 'hard', 'unfair'];

export function parseArgs(args: string[]): TrainingConfig {
  const config: TrainingConfig = {
    label: `training_${Date.now()}`,
    numGames: 10,
    roundNumber: 1,
    seats: [
      { aiName: 'LuVerne', aiTier: 'easy' },
      { aiName: 'Jeanne', aiTier: 'normal' },
      { aiName: 'Ron', aiTier: 'hard' },
      { aiName: 'Sue', aiTier: 'unfair' },
    ],
    gameSettings: {
      buyCountdown: 10,
      maxBuys: 3,       // null would be unlimited — 3 is reasonable default
      numDecks: 2,
      numJokers: 0,
    },
    logDecisions: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '--label' && next) {
      config.label = next;
      i++;
    } else if (arg === '--games' && next) {
      config.numGames = parseInt(next, 10);
      if (isNaN(config.numGames) || config.numGames < 1) {
        throw new Error(`Invalid --games value: ${next}`);
      }
      i++;
    } else if (arg === '--round' && next) {
      config.roundNumber = parseInt(next, 10);
      if (config.roundNumber < 1 || config.roundNumber > 7) {
        throw new Error(`Invalid --round value: ${next} (must be 1-7)`);
      }
      i++;
    } else if (arg === '--seats' && next) {
      config.seats = parseSeats(next);
      i++;
    } else if (arg === '--jokers' && next) {
      config.gameSettings.numJokers = parseInt(next, 10);
      i++;
    } else if (arg === '--max-buys' && next) {
      config.gameSettings.maxBuys = next === 'none' ? null : parseInt(next, 10);
      i++;
    } else if (arg === '--log-decisions') {
      config.logDecisions = true;
    } else if (arg === '--help') {
      printUsage();
      Deno.exit(0);
    }
  }

  if (config.seats.length < 2) {
    throw new Error('Need at least 2 seats');
  }
  if (config.seats.length > 6) {
    throw new Error('Max 6 seats');
  }

  return config;
}

function parseSeats(raw: string): SeatConfig[] {
  // Format: "LuVerne:easy,Jeanne:hard,Ron:normal,Sue:unfair"
  return raw.split(',').map(entry => {
    const [name, tier] = entry.trim().split(':');
    if (!AI_NAMES.includes(name)) {
      throw new Error(`Unknown AI name: ${name}. Valid: ${AI_NAMES.join(', ')}`);
    }
    if (!AI_TIERS.includes(tier)) {
      throw new Error(`Unknown AI tier: ${tier}. Valid: ${AI_TIERS.join(', ')}`);
    }
    return { aiName: name, aiTier: tier };
  });
}

function printUsage(): void {
  console.log(`
play27 AI Training Harness

Usage:
  deno run --allow-net --allow-env train.ts [options]

Options:
  --label <name>       Run label (default: training_<timestamp>)
  --games <n>          Number of games to run (default: 10)
  --round <1-7>        Which round to play (default: 1)
  --seats <config>     Seat config: "Name:tier,Name:tier,..." (default: all 4 tiers)
  --jokers <n>         Jokers per deck (default: 0)
  --max-buys <n|none>  Max buys per player per round (default: 3)
  --log-decisions      Log every decision to training_decisions table
  --help               Show this help

Seat config examples:
  --seats "LuVerne:easy,Jeanne:hard"
  --seats "LuVerne:easy,Jeanne:easy,Ron:easy,Sue:unfair"

Environment variables (required):
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  TRAINER_EMAIL
  TRAINER_PASSWORD
`);
}
