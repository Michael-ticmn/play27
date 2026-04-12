import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, rpc } from '../_shared/supabase.ts';
import { randomDelay, sleep } from '../_shared/delays.ts';
import { GameState, CardId } from '../_shared/types.ts';
import { planTurn } from './strategy.ts';
import { bestContractSolution, rankDiscards, findLayOffs } from './hand-analyzer.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { round_id, ai_player_id } = await req.json();

    if (!round_id || !ai_player_id) {
      return new Response(
        JSON.stringify({ error: 'Missing round_id or ai_player_id' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify this is an AI player
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

    // Get round info to find game_id
    const { data: round } = await supabase
      .from('rounds')
      .select('id, game_id, round_number, current_turn_seat, turn_phase, discard_bought, status, contract_sets, contract_runs')
      .eq('id', round_id)
      .single();

    if (!round || round.status !== 'active') {
      return new Response(
        JSON.stringify({ error: 'Round not active' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify it's this AI's turn
    const { data: gp } = await supabase
      .from('game_players')
      .select('seat_position')
      .eq('game_id', round.game_id)
      .eq('player_id', ai_player_id)
      .single();

    if (!gp || gp.seat_position !== round.current_turn_seat) {
      return new Response(
        JSON.stringify({ error: 'Not this AI\'s turn' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Idempotency: check turn_phase is 'draw' (hasn't started yet)
    if (round.turn_phase !== 'draw') {
      return new Response(
        JSON.stringify({ status: 'already_in_progress' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get AI's hand
    const { data: handCards } = await supabase
      .from('round_cards')
      .select('card_id')
      .eq('round_id', round_id)
      .eq('player_id', ai_player_id)
      .eq('location', 'hand');

    const hand: CardId[] = (handCards || []).map(c => c.card_id);

    // Get top discard
    const { data: topDiscardRow } = await supabase
      .from('round_cards')
      .select('card_id')
      .eq('round_id', round_id)
      .eq('location', 'discard')
      .order('position', { ascending: false })
      .limit(1)
      .single();

    const topDiscard: CardId | null = topDiscardRow?.card_id || null;

    // Get all melds on table
    const { data: meldsData } = await supabase
      .from('melds')
      .select('id, player_id, meld_type')
      .eq('round_id', round_id);

    const melds: { id: string; meld_type: string; cards: CardId[] }[] = [];
    for (const m of (meldsData || [])) {
      const { data: meldCards } = await supabase
        .from('round_cards')
        .select('card_id')
        .eq('round_id', round_id)
        .eq('meld_id', m.id)
        .order('position');
      melds.push({
        id: m.id,
        meld_type: m.meld_type,
        cards: (meldCards || []).map(c => c.card_id)
      });
    }

    // Get contract info
    const { data: contract } = await supabase
      .from('contracts')
      .select('num_sets, num_runs')
      .eq('round_number', round.round_number)
      .single();

    // Check if AI has met contract
    const { data: prs } = await supabase
      .from('player_round_state')
      .select('has_met_contract')
      .eq('round_id', round_id)
      .eq('player_id', ai_player_id)
      .single();

    const hasMetContract = prs?.has_met_contract || false;

    console.log(`[AI ${profile.ai_name} ${tier}] Turn start: ${hand.length} cards, contract: ${contract?.num_sets}S/${contract?.num_runs}R, met: ${hasMetContract}`);

    // ── DRAW PHASE ──
    await sleep(randomDelay(tier));

    // Decide draw source
    const plan = planTurn({
      hand,
      topDiscard,
      discardBought: round.discard_bought,
      contractSets: contract?.num_sets || 0,
      contractRuns: contract?.num_runs || 0,
      hasMetContract,
      hasDrawn: false,
      melds,
      tier,
      roundNumber: round.round_number,
    });

    let drawnCard: CardId | null = null;
    if (plan.drawFrom === 'discard' && topDiscard && !round.discard_bought) {
      const result = await rpc('draw_from_discard', { p_round_id: round_id, p_acting_as: ai_player_id });
      drawnCard = result as string;
      console.log(`[AI ${profile.ai_name}] Drew from discard: ${drawnCard}`);
    } else {
      const result = await rpc('draw_from_deck', { p_round_id: round_id, p_acting_as: ai_player_id });
      drawnCard = result as string;
      console.log(`[AI ${profile.ai_name}] Drew from deck: ${drawnCard}`);
    }

    // Update hand with drawn card
    const currentHand = [...hand, drawnCard!];

    // ── ACTION PHASE ──
    await sleep(randomDelay(tier));

    // Try to meet contract
    if (!hasMetContract) {
      const solution = bestContractSolution(
        currentHand,
        contract?.num_sets || 0,
        contract?.num_runs || 0
      );

      // Easy tier might miss the opportunity
      const shouldMeld = solution && (tier !== 'easy' || Math.random() > 0.2);

      if (shouldMeld && solution) {
        console.log(`[AI ${profile.ai_name}] Fulfilling contract with ${solution.length} melds`);
        await rpc('fulfill_contract', {
          p_round_id: round_id,
          p_melds: JSON.stringify(solution),
          p_acting_as: ai_player_id
        });

        // Remove melded cards from hand
        const usedCards = new Set(solution.flatMap(m => m.cards));
        const handAfterMeld = currentHand.filter(c => !usedCards.has(c));

        // Check if hand is empty (won the round)
        if (handAfterMeld.length === 0) {
          console.log(`[AI ${profile.ai_name}] Won the round! (melded all cards)`);
          return new Response(
            JSON.stringify({ status: 'completed', action: 'won_round' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Try lay-offs
        await sleep(randomDelay(tier) * 0.5);
        const layoffs = findLayOffs(handAfterMeld, melds);
        const filteredLayoffs = tier === 'easy'
          ? layoffs.filter(() => Math.random() < 0.15)
          : tier === 'normal'
            ? layoffs.filter(() => Math.random() < 0.7)
            : layoffs;

        let handAfterLayoffs = [...handAfterMeld];
        for (const lo of filteredLayoffs) {
          if (!handAfterLayoffs.includes(lo.card)) continue;
          try {
            await rpc('lay_off_card', {
              p_round_id: round_id,
              p_meld_id: lo.meld_id,
              p_card: lo.card,
              p_acting_as: ai_player_id
            });
            handAfterLayoffs = handAfterLayoffs.filter(c => c !== lo.card);
            console.log(`[AI ${profile.ai_name}] Laid off ${lo.card}`);
          } catch (e) {
            console.log(`[AI ${profile.ai_name}] Lay-off failed: ${e.message}`);
          }

          if (handAfterLayoffs.length === 0) {
            console.log(`[AI ${profile.ai_name}] Won the round! (laid off all cards)`);
            return new Response(
              JSON.stringify({ status: 'completed', action: 'won_round' }),
              { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
            );
          }
        }

        // ── DISCARD PHASE ──
        await sleep(randomDelay(tier));
        const discard = rankDiscards(handAfterLayoffs, contract?.num_sets || 0, contract?.num_runs || 0)[0]
          || handAfterLayoffs[0];
        await rpc('discard_card', { p_round_id: round_id, p_card: discard, p_acting_as: ai_player_id });
        console.log(`[AI ${profile.ai_name}] Discarded: ${discard}`);

        return new Response(
          JSON.stringify({ status: 'completed', action: 'turn_complete' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    } else {
      // Contract already met — try lay-offs
      const layoffs = findLayOffs(currentHand, melds);
      const filteredLayoffs = tier === 'easy'
        ? layoffs.filter(() => Math.random() < 0.15)
        : tier === 'normal'
          ? layoffs.filter(() => Math.random() < 0.7)
          : layoffs;

      let handAfterLayoffs = [...currentHand];
      for (const lo of filteredLayoffs) {
        if (!handAfterLayoffs.includes(lo.card)) continue;
        try {
          await rpc('lay_off_card', {
            p_round_id: round_id,
            p_meld_id: lo.meld_id,
            p_card: lo.card,
            p_acting_as: ai_player_id
          });
          handAfterLayoffs = handAfterLayoffs.filter(c => c !== lo.card);
          console.log(`[AI ${profile.ai_name}] Laid off ${lo.card}`);
          await sleep(randomDelay(tier) * 0.3);
        } catch (e) {
          console.log(`[AI ${profile.ai_name}] Lay-off failed: ${e.message}`);
        }

        if (handAfterLayoffs.length === 0) {
          return new Response(
            JSON.stringify({ status: 'completed', action: 'won_round' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      // Discard
      await sleep(randomDelay(tier));
      const discard = rankDiscards(handAfterLayoffs, contract?.num_sets || 0, contract?.num_runs || 0)[0]
        || handAfterLayoffs[0];
      await rpc('discard_card', { p_round_id: round_id, p_card: discard, p_acting_as: ai_player_id });
      console.log(`[AI ${profile.ai_name}] Discarded: ${discard}`);

      return new Response(
        JSON.stringify({ status: 'completed', action: 'turn_complete' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Contract not met, no solution found — just discard ──
    await sleep(randomDelay(tier));
    const discard = rankDiscards(currentHand, contract?.num_sets || 0, contract?.num_runs || 0)[0]
      || currentHand[0];
    await rpc('discard_card', { p_round_id: round_id, p_card: discard, p_acting_as: ai_player_id });
    console.log(`[AI ${profile.ai_name}] Discarded (no contract): ${discard}`);

    return new Response(
      JSON.stringify({ status: 'completed', action: 'turn_complete' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[AI Turn Error]', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
