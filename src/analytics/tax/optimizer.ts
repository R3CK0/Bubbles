/**
 * analytics/tax/optimizer.ts — FHSA/RRSP/TFSA contribution optimizer. Pure.
 *
 * Greedy by $1,000 tranches: each tranche goes wherever it saves the most tax
 * this year, priced by re-running the estimator (so bracket walks and credit
 * tapers are respected). FHSA wins ties over RRSP while the house goal is
 * active (same deduction now, tax-free out for a first home). TFSA absorbs
 * the remainder — no deduction, still sheltered.
 */
import { roundCents } from "../money.js";
import type { OptimizerAllocation, OptimizerResult, TaxInput, TaxTables } from "./types.js";
import { estimateTax } from "./estimator.js";

export interface OptimizerPersonInput {
  input: TaxInput;
  roomFhsa: number;
  roomRrsp: number;
  roomTfsa: number;
}

export interface OptimizerInputs {
  persons: OptimizerPersonInput[];
  /** Cash available to deploy across the tax year (annual). */
  deployableCash: number;
  houseGoalActive: boolean;
  monthsRemaining: number;
}

const TRANCHE = 1000;

export function optimizeContributions(inputs: OptimizerInputs, tables: TaxTables): OptimizerResult {
  const state = inputs.persons.map((p) => ({
    personId: p.input.personId,
    input: { ...p.input },
    roomFhsa: p.roomFhsa,
    roomRrsp: p.roomRrsp,
    roomTfsa: p.roomTfsa,
    fhsa: 0,
    rrsp: 0,
    tfsa: 0,
    taxSaved: 0,
    currentTax: estimateTax(p.input, tables).totalIncomeTax,
    reasons: [] as string[],
  }));

  let remaining = Math.max(0, inputs.deployableCash);

  const savingFor = (s: (typeof state)[number], field: "rrspDeduction" | "fhsaDeduction", amount: number) => {
    const bumped = { ...s.input, [field]: s.input[field] + amount };
    return s.currentTax - estimateTax(bumped, tables).totalIncomeTax;
  };

  while (remaining >= 1) {
    const tranche = Math.min(TRANCHE, remaining);
    let best: { s: (typeof state)[number]; kind: "fhsa" | "rrsp"; saving: number } | null = null;
    for (const s of state) {
      if (s.roomFhsa >= 1) {
        const saving = savingFor(s, "fhsaDeduction", Math.min(tranche, s.roomFhsa));
        if (!best || saving > best.saving + 0.005 || (Math.abs(saving - best.saving) <= 0.005 && best.kind === "rrsp" && inputs.houseGoalActive)) {
          best = { s, kind: "fhsa", saving };
        }
      }
      if (s.roomRrsp >= 1) {
        const saving = savingFor(s, "rrspDeduction", Math.min(tranche, s.roomRrsp));
        if (!best || saving > best.saving + 0.005) best = { s, kind: "rrsp", saving };
      }
    }
    if (!best || best.saving <= 0.005) break; // no deductible room left worth using

    const cap = best.kind === "fhsa" ? best.s.roomFhsa : best.s.roomRrsp;
    const amount = Math.min(tranche, cap);
    if (best.kind === "fhsa") {
      best.s.fhsa += amount;
      best.s.roomFhsa -= amount;
      best.s.input.fhsaDeduction += amount;
    } else {
      best.s.rrsp += amount;
      best.s.roomRrsp -= amount;
      best.s.input.rrspDeduction += amount;
    }
    best.s.taxSaved += best.saving;
    best.s.currentTax -= best.saving;
    remaining -= amount;
    const rate = Math.round((best.saving / amount) * 100);
    const reason = `${best.kind.toUpperCase()} $${amount} @ ~${rate}% marginal saving`;
    if (best.s.reasons[best.s.reasons.length - 1] !== reason) best.s.reasons.push(reason);
  }

  // Remainder → TFSA by available room, split evenly across persons with room.
  while (remaining >= 1) {
    const withRoom = state.filter((s) => s.roomTfsa >= 1);
    if (withRoom.length === 0) break;
    const share = Math.min(remaining / withRoom.length, ...withRoom.map((s) => s.roomTfsa));
    if (share < 1) {
      const s = withRoom[0]!;
      const amount = Math.min(remaining, s.roomTfsa);
      s.tfsa += amount;
      s.roomTfsa -= amount;
      remaining -= amount;
      continue;
    }
    for (const s of withRoom) {
      s.tfsa += share;
      s.roomTfsa -= share;
      remaining -= share;
    }
  }

  const allocations: OptimizerAllocation[] = state.map((s) => ({
    personId: s.personId,
    fhsa: roundCents(s.fhsa),
    rrsp: roundCents(s.rrsp),
    tfsa: roundCents(s.tfsa),
    taxSaved: roundCents(s.taxSaved),
    reasons: s.reasons,
  }));

  const months = Math.max(1, inputs.monthsRemaining);
  const monthlySchedule = allocations.flatMap((a) =>
    (["fhsa", "rrsp", "tfsa"] as const)
      .filter((k) => a[k] > 0)
      .map((k) => ({ personId: a.personId, type: k, monthly: roundCents(a[k] / months) })),
  );

  return {
    allocations,
    totalTaxSaved: roundCents(allocations.reduce((s, a) => s + a.taxSaved, 0)),
    totalDeployed: roundCents(allocations.reduce((s, a) => s + a.fhsa + a.rrsp + a.tfsa, 0)),
    monthlySchedule,
  };
}
