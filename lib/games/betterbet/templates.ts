/**
 * Better Bet template bank (DESIGN_V2_GAMES.md §5.2). Pure data, zero Gemini:
 * 12 peso-framed scenario templates (4 per tier) with EXACT integer EV math.
 *
 * Units: probabilities are integer basis points (p_bp, 100 bp = 1%); payoffs
 * and costs are integer pesos. EVs are integer EV_bp = Σ payoff × p_bp (a sure
 * amount Y contributes Y × 10⁴) — all comparisons are exact integer arithmetic.
 *
 * Every template declares a "solved knob": always a PESO payoff (never a
 * probability) so the generator can hit any target EV ratio — including the
 * ±3% "about equal" band — exactly (§5.3). `params[knobIndex]` carries the
 * knob's generous answer-time sanity bounds [1, 10⁶]; its `step` is the
 * natural rounding grid for clear-class rounds (equal-class rounds solve at ₱1).
 *
 * Tier ramp: T1 = single multiply vs a sure amount. T2 = closer EVs, two-outcome
 * options. T3 = compound probability, negative-EV comparisons, framing traps.
 */

export const BP_SCALE = 10_000; // 100% in basis points

export interface BetParam {
  name: string; // "*_bp" names are probabilities; everything else is pesos/counts
  lo: number;
  hi: number;
  step: number; // sampling grid (free params) / clear-class rounding grid (knob)
}

export interface BetTemplate {
  id: string;
  tier: 1 | 2 | 3;
  params: BetParam[]; // canonical order; doubles as answer-time sanity bounds
  knobIndex: number; // the solved param — always a peso payoff
  knobSide: "a" | "b"; // which option's EV the knob drives
  evA: (p: number[]) => number; // EV_bp
  evB: (p: number[]) => number; // EV_bp
  scenario: (p: number[]) => string;
  optionA: (p: number[]) => string;
  optionB: (p: number[]) => string;
  breakdownA: (p: number[]) => string; // reveal math line, e.g. "A: 4% × ₱12,500 = ₱500 expected."
  breakdownB: (p: number[]) => string;
  insight: string; // fixed one-line teach-back appended to the reveal
}

/** Thousands-separated peso amount for an integer number of pesos. */
export function pesoInt(n: number): string {
  return `₱${n.toLocaleString("en-US")}`;
}

/** EV_bp → peso amount (2-dp max), absolute value — loss framing adds its own sign. */
export function pesoEv(bp: number): string {
  return `₱${(Math.round(Math.abs(bp) / 100) / 100).toLocaleString("en-US")}`;
}

/** Basis points → "4%" / "0.5%" / "12.5%". */
export function pctBp(bp: number): string {
  return `${bp / 100}%`;
}

export const TEMPLATES: BetTemplate[] = [
  // --- tier 1 ---------------------------------------------------------------
  {
    id: "raffle_vs_cash",
    tier: 1,
    params: [
      { name: "p_bp", lo: 200, hi: 1000, step: 100 },
      { name: "prize", lo: 2000, hi: 20000, step: 500 },
      { name: "offer", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 2,
    knobSide: "b",
    evA: ([p_bp, prize]) => prize * p_bp,
    evB: ([, , offer]) => offer * BP_SCALE,
    scenario: ([p_bp, prize]) =>
      `An office raffle ticket gives a ${pctBp(p_bp)} chance at ${pesoInt(prize)}. ` +
      `A coworker offers to buy your ticket.`,
    optionA: ([p_bp, prize]) => `Keep the ticket (${pctBp(p_bp)} chance at ${pesoInt(prize)})`,
    optionB: ([, , offer]) => `Sell it for ${pesoInt(offer)} cash`,
    breakdownA: (p) =>
      `A: ${pctBp(p[0])} × ${pesoInt(p[1])} = ${pesoEv(p[1] * p[0])} expected.`,
    breakdownB: (p) => `B: sure ${pesoInt(p[2])}.`,
    insight: "A rare big win usually isn't worth more than its probability-weighted value.",
  },
  {
    id: "coinflip_or_sure",
    tier: 1,
    params: [
      { name: "flip_prize", lo: 1000, hi: 10000, step: 200 },
      { name: "sure", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 1,
    knobSide: "b",
    evA: ([flip]) => flip * 5000,
    evB: ([, sure]) => sure * BP_SCALE,
    scenario: ([flip]) =>
      `A client offers to settle a disputed fee with a coin flip for ${pesoInt(flip)} — ` +
      `or you can take a sure amount now.`,
    optionA: ([flip]) => `Flip: 50% chance at ${pesoInt(flip)}, otherwise nothing`,
    optionB: ([, sure]) => `Take ${pesoInt(sure)} now`,
    breakdownA: (p) => `A: 50% × ${pesoInt(p[0])} = ${pesoEv(p[0] * 5000)} expected.`,
    breakdownB: (p) => `B: sure ${pesoInt(p[1])}.`,
    insight: "A 50/50 shot is worth exactly half its prize — compare that number, not the thrill.",
  },
  {
    id: "gig_approval",
    tier: 1,
    params: [
      { name: "p_bp", lo: 4000, hi: 9000, step: 500 },
      { name: "gig_pay", lo: 1500, hi: 12000, step: 500 },
      { name: "flat_pay", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 2,
    knobSide: "b",
    evA: ([p_bp, gig]) => gig * p_bp,
    evB: ([, , flat]) => flat * BP_SCALE,
    scenario: ([p_bp, gig]) =>
      `A gig pays ${pesoInt(gig)}, but only if the client approves the final output ` +
      `(${pctBp(p_bp)} approval rate). Another client offers a flat-rate gig.`,
    optionA: ([p_bp, gig]) => `Take the ${pesoInt(gig)} gig (${pctBp(p_bp)} chance it pays)`,
    optionB: ([, , flat]) => `Take the flat ${pesoInt(flat)} gig`,
    breakdownA: (p) =>
      `A: ${pctBp(p[0])} × ${pesoInt(p[1])} = ${pesoEv(p[1] * p[0])} expected.`,
    breakdownB: (p) => `B: sure ${pesoInt(p[2])}.`,
    insight: "Discount an uncertain payday by its probability before comparing it to a sure one.",
  },
  {
    id: "bulk_sale",
    tier: 1,
    params: [
      { name: "items", lo: 10, hi: 40, step: 5 },
      { name: "unit_profit", lo: 20, hi: 150, step: 10 },
      { name: "p_bp", lo: 3000, hi: 8000, step: 500 },
      { name: "lot_offer", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 3,
    knobSide: "b",
    evA: ([m, r]) => m * r * BP_SCALE,
    evB: ([, , p_bp, lot]) => lot * p_bp,
    scenario: ([m, r, p_bp]) =>
      `You have ${m} items that sell for a sure ${pesoInt(r)} profit each. A reseller ` +
      `offers to take the whole lot, but that deal only closes ${pctBp(p_bp)} of the time.`,
    optionA: ([m, r]) => `Sell them yourself: ${m} × ${pesoInt(r)} guaranteed`,
    optionB: ([, , p_bp, lot]) => `Take the reseller deal: ${pctBp(p_bp)} chance at ${pesoInt(lot)}`,
    breakdownA: (p) => `A: ${p[0]} × ${pesoInt(p[1])} = ${pesoEv(p[0] * p[1] * BP_SCALE)} sure.`,
    breakdownB: (p) =>
      `B: ${pctBp(p[2])} × ${pesoInt(p[3])} = ${pesoEv(p[3] * p[2])} expected.`,
    insight: "One big maybe versus many small certainties is still just a multiplication.",
  },

  // --- tier 2 ---------------------------------------------------------------
  {
    id: "discount_vs_cashback",
    tier: 2,
    params: [
      { name: "price", lo: 3000, hi: 30000, step: 1000 },
      { name: "d_bp", lo: 500, hi: 1500, step: 100 },
      { name: "p_bp", lo: 5000, hi: 9500, step: 500 },
      { name: "cashback", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 3,
    knobSide: "b",
    evA: ([price, d_bp]) => price * d_bp,
    evB: ([, , p_bp, cashback]) => cashback * p_bp,
    scenario: ([price, d_bp, p_bp, cashback]) =>
      `A ${pesoInt(price)} gadget is on offer two ways: ${pctBp(d_bp)} off today, or ` +
      `list price with a ${pesoInt(cashback)} cashback that only posts ${pctBp(p_bp)} of the time.`,
    optionA: ([, d_bp]) => `Take the ${pctBp(d_bp)} discount today`,
    optionB: ([, , p_bp, cashback]) =>
      `Pay list price for the ${pesoInt(cashback)} cashback (${pctBp(p_bp)} chance it posts)`,
    breakdownA: (p) =>
      `A: ${pctBp(p[1])} of ${pesoInt(p[0])} = ${pesoEv(p[0] * p[1])} saved for sure.`,
    breakdownB: (p) =>
      `B: ${pctBp(p[2])} × ${pesoInt(p[3])} = ${pesoEv(p[3] * p[2])} expected.`,
    insight: "A sure discount and a maybe-cashback only compare after the probability haircut.",
  },
  {
    id: "two_raffles",
    tier: 2,
    params: [
      { name: "p1_bp", lo: 500, hi: 3000, step: 100 },
      { name: "prize1", lo: 1000, hi: 15000, step: 500 },
      { name: "p2_bp", lo: 500, hi: 3000, step: 100 },
      { name: "prize2", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 3,
    knobSide: "b",
    evA: ([p1, x1]) => x1 * p1,
    evB: ([, , p2, x2]) => x2 * p2,
    scenario: ([p1, x1, p2, x2]) =>
      `Two raffles, same ticket price. Raffle A: ${pctBp(p1)} chance at ${pesoInt(x1)}. ` +
      `Raffle B: ${pctBp(p2)} chance at ${pesoInt(x2)}.`,
    optionA: ([p1, x1]) => `Raffle A: ${pctBp(p1)} at ${pesoInt(x1)}`,
    optionB: ([, , p2, x2]) => `Raffle B: ${pctBp(p2)} at ${pesoInt(x2)}`,
    breakdownA: (p) =>
      `A: ${pctBp(p[0])} × ${pesoInt(p[1])} = ${pesoEv(p[1] * p[0])} expected.`,
    breakdownB: (p) =>
      `B: ${pctBp(p[2])} × ${pesoInt(p[3])} = ${pesoEv(p[3] * p[2])} expected.`,
    insight: "Bigger prize or better odds — neither wins alone; the product decides.",
  },
  {
    id: "mixed_bonus",
    tier: 2,
    params: [
      { name: "flat", lo: 2000, hi: 10000, step: 500 },
      { name: "p_bp", lo: 2000, hi: 6000, step: 500 },
      { name: "low", lo: 200, hi: 1500, step: 100 },
      { name: "high", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 3,
    knobSide: "b",
    evA: ([flat]) => flat * BP_SCALE,
    evB: ([, p_bp, low, high]) => high * p_bp + low * (BP_SCALE - p_bp),
    scenario: ([, p_bp]) =>
      `Your bonus plan is up for a choice. Plan A pays a flat amount. Plan B pays big ` +
      `if the team hits target (${pctBp(p_bp)} likely), and a small amount otherwise.`,
    optionA: ([flat]) => `Plan A: flat ${pesoInt(flat)}`,
    optionB: ([, p_bp, low, high]) =>
      `Plan B: ${pctBp(p_bp)} chance at ${pesoInt(high)}, otherwise ${pesoInt(low)}`,
    breakdownA: (p) => `A: sure ${pesoInt(p[0])}.`,
    breakdownB: (p) =>
      `B: ${pctBp(p[1])} × ${pesoInt(p[3])} + ${pctBp(BP_SCALE - p[1])} × ${pesoInt(p[2])} ` +
      `= ${pesoEv(p[3] * p[1] + p[2] * (BP_SCALE - p[1]))} expected.`,
    insight: "Two-outcome offers are a weighted average — weight both branches, not just the big one.",
  },
  {
    id: "sell_now_or_wait",
    tier: 2,
    params: [
      { name: "now_price", lo: 3000, hi: 15000, step: 500 },
      { name: "p_bp", lo: 3000, hi: 7000, step: 500 },
      { name: "wait_price", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 2,
    knobSide: "b",
    evA: ([now]) => now * BP_SCALE,
    evB: ([now, p_bp, wait]) => {
      const fallback = Math.round((now * 0.6) / 100) * 100; // 60% of today's price
      return wait * p_bp + fallback * (BP_SCALE - p_bp);
    },
    scenario: ([now, p_bp, wait]) => {
      const fallback = Math.round((now * 0.6) / 100) * 100;
      return (
        `You can sell your old phone today for ${pesoInt(now)}. Or wait for a specific ` +
        `buyer: ${pctBp(p_bp)} chance they pay ${pesoInt(wait)}; if they bail, you offload ` +
        `it at ${pesoInt(fallback)}.`
      );
    },
    optionA: ([now]) => `Sell today for ${pesoInt(now)}`,
    optionB: ([, p_bp, wait]) => `Wait for the buyer (${pctBp(p_bp)} chance at ${pesoInt(wait)})`,
    breakdownA: (p) => `A: sure ${pesoInt(p[0])}.`,
    breakdownB: (p) => {
      const fallback = Math.round((p[0] * 0.6) / 100) * 100;
      const ev = p[2] * p[1] + fallback * (BP_SCALE - p[1]);
      return (
        `B: ${pctBp(p[1])} × ${pesoInt(p[2])} + ${pctBp(BP_SCALE - p[1])} × ` +
        `${pesoInt(fallback)} = ${pesoEv(ev)} expected.`
      );
    },
    insight: "Waiting has a downside branch too — price it in before turning down cash today.",
  },

  // --- tier 3 ---------------------------------------------------------------
  {
    id: "gadget_insurance",
    tier: 3,
    params: [
      { name: "value", lo: 15000, hi: 60000, step: 5000 },
      { name: "p_bp", lo: 300, hi: 1200, step: 100 },
      { name: "plan_fee", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 2,
    knobSide: "a",
    evA: ([, , fee]) => -fee * BP_SCALE,
    evB: ([value, p_bp]) => -value * p_bp,
    scenario: ([value, p_bp]) =>
      `Your new ${pesoInt(value)} phone has about a ${pctBp(p_bp)} chance of getting ` +
      `broken this year. The store offers a protection plan.`,
    optionA: ([, , fee]) => `Buy the plan for ${pesoInt(fee)}`,
    optionB: () => `Skip it and carry the risk`,
    breakdownA: (p) => `A: certain cost ${pesoInt(p[2])}.`,
    breakdownB: (p) =>
      `B: ${pctBp(p[1])} × ${pesoInt(p[0])} = ${pesoEv(p[0] * p[1])} expected loss.`,
    insight: "Insurance is an EV comparison too: certain cost vs probability × loss.",
  },
  {
    id: "long_shot",
    tier: 3,
    params: [
      { name: "cash", lo: 20, hi: 100, step: 10 },
      { name: "one_in_k", lo: 50, hi: 500, step: 50 }, // 50/100/200/500 sampled explicitly
      { name: "jackpot", lo: 1, hi: 1_000_000, step: 500 }, // knob
    ],
    knobIndex: 2,
    knobSide: "a",
    evA: ([, k, jackpot]) => jackpot * (BP_SCALE / k),
    evB: ([cash]) => cash * BP_SCALE,
    scenario: ([cash, k, jackpot]) =>
      `You have ${pesoInt(cash)} in hand. A scratch card costs exactly ${pesoInt(cash)}: ` +
      `1 in ${k} chance of winning ${pesoInt(jackpot)}, otherwise nothing.`,
    optionA: ([, k, jackpot]) => `Buy the card: 1 in ${k} at ${pesoInt(jackpot)}`,
    optionB: ([cash]) => `Keep your ${pesoInt(cash)}`,
    breakdownA: (p) =>
      `A: 1 in ${p[1]} × ${pesoInt(p[2])} = ${pesoEv(p[2] * (BP_SCALE / p[1]))} expected.`,
    breakdownB: (p) => `B: keep ${pesoInt(p[0])} for sure.`,
    insight: "A huge prize can't rescue a tiny probability — multiply before you feel.",
  },
  {
    id: "pipeline_deal",
    tier: 3,
    params: [
      { name: "p1_bp", lo: 3000, hi: 7000, step: 500 },
      { name: "p2_bp", lo: 2000, hi: 6000, step: 500 },
      { name: "package", lo: 20000, hi: 80000, step: 5000 },
      { name: "sure_gig", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 3,
    knobSide: "b",
    // p1, p2 on 500-bp grids ⇒ p1·p2/10⁴ is an exact integer.
    evA: ([p1, p2, pkg]) => pkg * ((p1 * p2) / BP_SCALE),
    evB: ([, , , gig]) => gig * BP_SCALE,
    scenario: ([p1, p2, pkg]) =>
      `A prospect has a ${pctBp(p1)} chance of booking a call; if they do, there's a ` +
      `${pctBp(p2)} chance they sign a ${pesoInt(pkg)} package. Meanwhile a guaranteed ` +
      `gig is on the table this week.`,
    optionA: ([p1, p2, pkg]) =>
      `Chase the prospect (${pctBp(p1)} then ${pctBp(p2)} at ${pesoInt(pkg)})`,
    optionB: ([, , , gig]) => `Take the guaranteed ${pesoInt(gig)} gig`,
    breakdownA: (p) =>
      `A: ${pctBp(p[0])} × ${pctBp(p[1])} × ${pesoInt(p[2])} = ` +
      `${pesoEv(p[2] * ((p[0] * p[1]) / BP_SCALE))} expected.`,
    breakdownB: (p) => `B: sure ${pesoInt(p[3])}.`,
    insight: "Compound probabilities multiply — two “likely”s can still be a coin flip.",
  },
  {
    id: "extended_warranty",
    tier: 3,
    params: [
      { name: "value", lo: 20000, hi: 60000, step: 5000 }, // context only
      { name: "p_bp", lo: 1000, hi: 3000, step: 100 },
      { name: "repair", lo: 3000, hi: 15000, step: 500 },
      { name: "warranty_fee", lo: 1, hi: 1_000_000, step: 50 }, // knob
    ],
    knobIndex: 3,
    knobSide: "a",
    evA: ([, , , fee]) => -fee * BP_SCALE,
    evB: ([, p_bp, repair]) => -repair * p_bp,
    scenario: ([value, p_bp, repair]) =>
      `Your ${pesoInt(value)} appliance can be covered by an extended warranty. There's ` +
      `a ${pctBp(p_bp)} chance of a failure that would cost ${pesoInt(repair)} to repair.`,
    optionA: ([, , , fee]) => `Buy the warranty for ${pesoInt(fee)}`,
    optionB: () => `Skip it and pay repairs if they happen`,
    breakdownA: (p) => `A: certain cost ${pesoInt(p[3])}.`,
    breakdownB: (p) =>
      `B: ${pctBp(p[1])} × ${pesoInt(p[2])} = ${pesoEv(p[2] * p[1])} expected loss.`,
    insight: "Warranties are usually priced above the expected repair cost — do the multiplication.",
  },
];
