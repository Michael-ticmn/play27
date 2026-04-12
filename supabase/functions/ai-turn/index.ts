import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { supabase, rpc } from '../_shared/supabase.ts';
import { sleep } from '../_shared/delays.ts';
import { CardId, cardValue, isJoker } from '../_shared/types.ts';
import { planTurn } from './strategy.ts';
import { bestContractSolution, rankDiscards, findLayOffs, evaluatePostContractDraw } from './hand-analyzer.ts';
import { getTier, randomDelay, preDrawDelay, filterLayOffs } from './tiers.ts';

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
    const tp = getTier(tier);

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

    // Get total score from player_round_state for urgent meld logic
    const { data: scoreData } = await supabase
      .from('player_round_state')
      .select('score, round_id!inner(game_id, status)')
      .eq('player_id', ai_player_id)
      .eq('round_id.game_id', round.game_id)
      .eq('round_id.status', 'finished');
    const totalScore = (scoreData || []).reduce((sum: number, r: any) => sum + (r.score || 0), 0);

    if (!gp || gp.seat_position !== round.current_turn_seat) {
      return new Response(
        JSON.stringify({
          error: 'Not this AI\'s turn',
          ai_seat: gp?.seat_position ?? null,
          current_seat: round.current_turn_seat,
          phase: round.turn_phase
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Only handle draw or action phase (action = recovery from mid-turn crash)
    if (round.turn_phase !== 'draw' && round.turn_phase !== 'action') {
      return new Response(
        JSON.stringify({ status: 'wrong_phase', phase: round.turn_phase }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const resumingFromAction = round.turn_phase === 'action';

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

    // Fetch AI's last discard to avoid picking it back up
    const { data: lastDiscardAction } = await supabase
      .from('game_actions')
      .select('details')
      .eq('round_id', round_id)
      .eq('player_id', ai_player_id)
      .eq('action_type', 'discard')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const myLastDiscard: CardId | null = lastDiscardAction?.details?.card || null;

    // Fetch recently bought cards (protected from discard)
    const { data: recentBuys } = await supabase
      .from('game_actions')
      .select('details, created_at')
      .eq('round_id', round_id)
      .eq('player_id', ai_player_id)
      .eq('action_type', 'buy_awarded')
      .order('created_at', { ascending: false })
      .limit(2);
    const boughtCards: CardId[] = (recentBuys || []).flatMap(b => {
      const cards: CardId[] = [];
      if (b.details?.discard_card) cards.push(b.details.discard_card);
      if (b.details?.penalty_card) cards.push(b.details.penalty_card);
      return cards;
    }).filter(c => hand.includes(c));

    console.log(`[AI ${profile.ai_name} ${tier}] Turn start: ${hand.length} cards, contract: ${contract?.num_sets}S/${contract?.num_runs}R, met: ${hasMetContract}`);

    let currentHand = [...hand];
    let protectedCards: CardId[] = [...boughtCards];
    const tableMelds = tp.checksTableMelds ? melds : [];

    if (!resumingFromAction) {
      // ── PRE-DRAW PAUSE — let humans see the last discard ──
      await sleep(preDrawDelay(tp));

      // Re-verify it's still this AI's turn (may have changed during delay)
      const { data: roundCheck } = await supabase
        .from('rounds')
        .select('current_turn_seat, turn_phase, status')
        .eq('id', round_id)
        .single();

      if (!roundCheck || roundCheck.status !== 'active' ||
          roundCheck.current_turn_seat !== gp.seat_position ||
          (roundCheck.turn_phase !== 'draw' && roundCheck.turn_phase !== 'action')) {
        console.log(`[AI ${profile.ai_name}] Turn changed during delay, aborting`);
        return new Response(
          JSON.stringify({ status: 'aborted', reason: 'turn_changed' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Don't pick up card we just discarded last turn
      const discardBlocked = topDiscard && myLastDiscard && topDiscard === myLastDiscard;

      // Post-contract draw restriction
      let postContractBlock = false;
      if (hasMetContract && topDiscard && !isJoker(topDiscard)) {
        const isLayOff = evaluatePostContractDraw(topDiscard, melds);
        if (tp.postContractSpeculation) {
          // Hard/Unfair: also allow if it completes a set (2+ same value in hand)
          const dv = cardValue(topDiscard);
          const sameValCount = hand.filter(c => !isJoker(c) && cardValue(c) === dv).length;
          postContractBlock = !isLayOff && sameValCount < 2;
        } else {
          postContractBlock = !isLayOff;
        }
      }

      const plan = planTurn({
        hand,
        topDiscard: (discardBlocked || postContractBlock) ? null : topDiscard,
        discardBought: round.discard_bought || discardBlocked || postContractBlock,
        contractSets: contract?.num_sets || 0,
        contractRuns: contract?.num_runs || 0,
        hasMetContract,
        hasDrawn: false,
        melds,
        tier,
        roundNumber: round.round_number,
      });

      if (discardBlocked) console.log(`[AI ${profile.ai_name}] Skipping own discard: ${topDiscard}`);
      if (postContractBlock) console.log(`[AI ${profile.ai_name}] Post-contract: ${topDiscard} not a lay-off, drawing from deck`);

      let drawnCard: CardId | null = null;
      if (plan.drawFrom === 'discard' && topDiscard && !round.discard_bought && !discardBlocked && !postContractBlock) {
        const result = await rpc('draw_from_discard', { p_round_id: round_id, p_acting_as: ai_player_id });
        drawnCard = result as string;
        console.log(`[AI ${profile.ai_name}] Drew from discard: ${drawnCard}`);
      } else {
        const result = await rpc('draw_from_deck', { p_round_id: round_id, p_acting_as: ai_player_id });
        drawnCard = result as string;
        console.log(`[AI ${profile.ai_name}] Drew from deck: ${drawnCard}`);
      }

      currentHand = [...hand, drawnCard!];
      if (drawnCard) protectedCards.push(drawnCard);
    } else {
      console.log(`[AI ${profile.ai_name}] Resuming from action phase with ${hand.length} cards`);
    }

    // ── ACTION PHASE ──

    // Try to meet contract
    if (!hasMetContract) {
      const solution = bestContractSolution(
        currentHand,
        contract?.num_sets || 0,
        contract?.num_runs || 0
      );

      // Can this tier miss the contract?
      const urgent = totalScore >= tp.urgentMeldThreshold;
      let shouldMeld = !!solution;
      if (solution && tp.canMissContract && !urgent) {
        shouldMeld = Math.random() > tp.missContractRate;
      }

      if (shouldMeld && solution) {
        console.log(`[AI ${profile.ai_name}] Fulfilling contract with ${solution.length} melds`);
        await rpc('fulfill_contract', {
          p_round_id: round_id,
          p_melds: solution,
          p_acting_as: ai_player_id
        });

        const usedCards = new Set(solution.flatMap(m => m.cards));
        const handAfterMeld = currentHand.filter(c => !usedCards.has(c));

        if (handAfterMeld.length === 0) {
          console.log(`[AI ${profile.ai_name}] Won the round! (melded all cards)`);
          return new Response(
            JSON.stringify({ status: 'completed', action: 'won_round' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // No lay-offs on the same turn as fulfilling contract
        await sleep(randomDelay(tp) * 0.4);
        const discard = rankDiscards(handAfterMeld, contract?.num_sets || 0, contract?.num_runs || 0, tableMelds, protectedCards, tp.drawnCardProtection)[0]
          || handAfterMeld[0];
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
      const filteredLayoffs = filterLayOffs(tp, layoffs);

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
      await sleep(randomDelay(tp));
      const discard = rankDiscards(handAfterLayoffs, contract?.num_sets || 0, contract?.num_runs || 0, tableMelds, protectedCards, tp.drawnCardProtection)[0]
        || handAfterLayoffs[0];
      await rpc('discard_card', { p_round_id: round_id, p_card: discard, p_acting_as: ai_player_id });
      console.log(`[AI ${profile.ai_name}] Discarded: ${discard}`);

      return new Response(
        JSON.stringify({ status: 'completed', action: 'turn_complete' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Contract not met, no solution found — just discard ──
    await sleep(randomDelay(tp) * 0.4);
    const discard = rankDiscards(currentHand, contract?.num_sets || 0, contract?.num_runs || 0, tableMelds, protectedCards, tp.drawnCardProtection)[0]
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
