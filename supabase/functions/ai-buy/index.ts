import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, rpc } from '../_shared/supabase.ts';
import { sleep, BUY_TIMING } from '../_shared/delays.ts';
import { CardId, cardPoints, cardValue, isJoker } from '../_shared/types.ts';
import { groupByValue, groupBySuit } from '../ai-turn/hand-analyzer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { round_id, ai_player_id, countdown_seconds } = await req.json();

    if (!round_id || !ai_player_id) {
      return new Response(
        JSON.stringify({ error: 'Missing round_id or ai_player_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify AI player
    const { data: profile } = await supabase
      .from('profiles')
      .select('id, ai_name, ai_tier, is_ai')
      .eq('id', ai_player_id)
      .single();

    if (!profile?.is_ai) {
      return new Response(
        JSON.stringify({ error: 'Not an AI player' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tier = profile.ai_tier || 'normal';

    // Check round state
    const { data: round } = await supabase
      .from('rounds')
      .select('id, game_id, turn_phase, current_turn_seat, discard_bought, round_number')
      .eq('id', round_id)
      .single();

    if (!round || !['draw', 'buy_window'].includes(round.turn_phase)) {
      return new Response(
        JSON.stringify({ status: 'no_buy_window' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (round.discard_bought) {
      return new Response(
        JSON.stringify({ status: 'already_bought' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify AI is not the active player
    const { data: gp } = await supabase
      .from('game_players')
      .select('seat_position')
      .eq('game_id', round.game_id)
      .eq('player_id', ai_player_id)
      .single();

    if (!gp || gp.seat_position === round.current_turn_seat) {
      return new Response(
        JSON.stringify({ status: 'active_player_skips_buy' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check if already in buy queue
    const { data: existingBuy } = await supabase
      .from('buy_requests')
      .select('id')
      .eq('round_id', round_id)
      .eq('player_id', ai_player_id)
      .single();

    if (existingBuy) {
      return new Response(
        JSON.stringify({ status: 'already_in_queue' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get AI's hand and the top discard
    const { data: handCards } = await supabase
      .from('round_cards')
      .select('card_id')
      .eq('round_id', round_id)
      .eq('player_id', ai_player_id)
      .eq('location', 'hand');

    const hand: CardId[] = (handCards || []).map(c => c.card_id);

    const { data: topDiscardRow } = await supabase
      .from('round_cards')
      .select('card_id')
      .eq('round_id', round_id)
      .eq('location', 'discard')
      .order('position', { ascending: false })
      .limit(1)
      .single();

    const topDiscard: CardId | null = topDiscardRow?.card_id || null;
    if (!topDiscard) {
      return new Response(
        JSON.stringify({ status: 'no_discard' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── EVALUATE: should the AI buy this card? ──
    const dv = cardValue(topDiscard);
    const byValue = groupByValue(hand);
    const bySuit = groupBySuit(hand);

    let buyScore = 0;

    // Card completes a set (2 in hand + discard = 3)
    const sameValue = byValue.get(dv) || [];
    if (sameValue.length >= 2) buyScore += 80;
    else if (sameValue.length >= 1) buyScore += 30;

    // Card fits a run (adjacent in suit)
    if (!isJoker(topDiscard)) {
      const ds = parseInt(topDiscard[1]);
      const sameSuit = (bySuit.get(ds) || []).map(c => cardValue(c));
      for (const v of sameSuit) {
        if (Math.abs(v - dv) <= 2) buyScore += 20;
      }
    }

    // Joker is always valuable
    if (isJoker(topDiscard)) buyScore += 90;

    // Penalty: buying costs an extra card from deck
    buyScore -= 15;

    // Tier-specific thresholds
    const thresholds: Record<string, number> = {
      easy: 70,    // only buys obvious completions
      normal: 40,  // reasonable threshold
      hard: 25,    // more aggressive
      unfair: 10,  // buys almost anything useful, even buy-blocks
    };

    const threshold = thresholds[tier] ?? 40;
    const shouldBuy = buyScore >= threshold;

    console.log(`[AI Buy ${profile.ai_name} ${tier}] Card: ${topDiscard}, Score: ${buyScore}, Threshold: ${threshold}, Buy: ${shouldBuy}`);

    if (!shouldBuy) {
      return new Response(
        JSON.stringify({ status: 'decided_not_to_buy', score: buyScore }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── DELAY: wait within the buy window based on tier ──
    const cd = countdown_seconds || 10;
    const timing = BUY_TIMING[tier] || BUY_TIMING.normal;
    const delayFraction = timing.earliest + Math.random() * (timing.latest - timing.earliest);
    const buyDelay = delayFraction * cd * 1000;
    await sleep(Math.min(buyDelay, cd * 900)); // never exceed 90% of countdown

    // ── SUBMIT BUY REQUEST ──
    try {
      await rpc('request_buy', { p_round_id: round_id, p_acting_as: ai_player_id });
      console.log(`[AI Buy ${profile.ai_name}] Buy requested after ${Math.round(buyDelay)}ms`);
    } catch (e) {
      // May fail if buy window closed, that's OK
      console.log(`[AI Buy ${profile.ai_name}] Buy failed: ${e.message}`);
    }

    return new Response(
      JSON.stringify({ status: 'buy_requested' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[AI Buy Error]', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
