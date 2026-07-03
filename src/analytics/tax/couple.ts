/**
 * analytics/tax/couple.ts — couple-coordination strategies, each priced by
 * diffing estimator runs. Pure. The agent layer narrates these — it never
 * invents its own numbers.
 */
import { roundCents } from "../money.js";
import type { CoupleStrategy, TaxInput, TaxTables } from "./types.js";
import { estimateTax } from "./estimator.js";

export interface CoupleInputs {
  a: TaxInput;
  b: TaxInput;
  roomRrspA: number;
  roomRrspB: number;
  /** Planned RRSP contribution this year (household), for spousal analysis. */
  plannedRrsp: number;
  /** Expected income next year per person (for deduction timing), optional. */
  expectedNextYearIncome?: { a?: number; b?: number };
}

function tax(input: TaxInput, tables: TaxTables): number {
  return estimateTax(input, tables).totalIncomeTax;
}

export function enumerateStrategies(inputs: CoupleInputs, tables: TaxTables): CoupleStrategy[] {
  const out: CoupleStrategy[] = [];
  const { a, b } = inputs;
  const rateA = estimateTax(a, tables).marginalRate;
  const rateB = estimateTax(b, tables).marginalRate;
  const higher = rateA >= rateB ? a : b;
  const lower = rateA >= rateB ? b : a;
  const higherRoom = rateA >= rateB ? inputs.roomRrspA : inputs.roomRrspB;

  // 1. Spousal RRSP: the higher earner takes the whole household deduction.
  if (inputs.plannedRrsp > 0 && Math.abs(rateA - rateB) > 0.005) {
    const half = inputs.plannedRrsp / 2;
    const splitCost =
      tax({ ...a, rrspDeduction: a.rrspDeduction + half }, tables) +
      tax({ ...b, rrspDeduction: b.rrspDeduction + half }, tables);
    const concentrated = Math.min(inputs.plannedRrsp, higherRoom);
    const concentratedCost =
      tax({ ...higher, rrspDeduction: higher.rrspDeduction + concentrated }, tables) +
      tax({ ...lower, rrspDeduction: lower.rrspDeduction + (inputs.plannedRrsp - concentrated) }, tables);
    const impact = roundCents(splitCost - concentratedCost);
    if (impact > 10) {
      out.push({
        kind: "spousal_rrsp",
        title: `${higher.personId} deducts the household RRSP via a spousal plan`,
        description: `Deducting the planned $${inputs.plannedRrsp.toFixed(0)} at ${higher.personId}'s higher marginal rate instead of splitting it evenly, using a spousal RRSP so retirement assets still balance.`,
        dollarImpact: impact,
        actions: [
          `Open (or use) a spousal RRSP with ${lower.personId} as annuitant`,
          `${higher.personId} contributes and claims the full deduction`,
        ],
        caveats: ["3-year attribution rule on spousal withdrawals", "watch the contributor's own room"],
      });
    }
  }

  // 2. Credit pooling: donations claimed once, crossing the $200 low-rate
  //    threshold a single time instead of twice.
  const donations = a.donations + b.donations;
  if (a.donations > 0 && b.donations > 0) {
    const separate =
      tax(a, tables) + tax(b, tables);
    const pooled =
      tax({ ...a, donations }, tables) + tax({ ...b, donations: 0 }, tables);
    const impact = roundCents(separate - pooled);
    if (impact > 1) {
      out.push({
        kind: "credit_pooling",
        title: `Pool all donations on ${a.personId}'s return`,
        description: `Claiming the household's $${donations.toFixed(0)} of donations on one return crosses the $200 low-rate threshold once instead of twice.`,
        dollarImpact: impact,
        actions: ["Combine all donation receipts on a single return (either spouse may claim)"],
        caveats: [],
      });
    }
  }

  // 3. Deduction timing: bank the RRSP deduction for a higher-income year.
  for (const [person, expected] of [
    [a, inputs.expectedNextYearIncome?.a],
    [b, inputs.expectedNextYearIncome?.b],
  ] as const) {
    if (!expected || expected <= person.employmentIncome * 1.1 || person.rrspDeduction <= 0) continue;
    const nowSaving =
      tax({ ...person, rrspDeduction: 0 }, tables) - tax(person, tables);
    const futureSaving =
      tax({ ...person, employmentIncome: expected, rrspDeduction: 0 }, tables) -
      tax({ ...person, employmentIncome: expected }, tables);
    const impact = roundCents(futureSaving - nowSaving);
    if (impact > 50) {
      out.push({
        kind: "deduction_timing",
        title: `${person.personId}: contribute now, deduct next year`,
        description: `Income is expected to jump (~$${expected.toFixed(0)}); the same $${person.rrspDeduction.toFixed(0)} deduction is worth more against next year's marginal rate. Contribute now (growth is sheltered either way) and carry the deduction forward.`,
        dollarImpact: impact,
        actions: ["Report the contribution but defer the deduction on Schedule 7"],
        caveats: ["Only worth it if the income jump actually happens"],
      });
    }
  }

  // 4. Asset location (flag-only: attribution rules make moves non-trivial).
  const invA = a.interestIncome + a.eligibleDividends + a.capitalGains;
  const invB = b.interestIncome + b.eligibleDividends + b.capitalGains;
  const higherInv = rateA >= rateB ? invA : invB;
  if (higherInv > 1000 && Math.abs(rateA - rateB) > 0.04) {
    const shift = higherInv;
    const now = tax(higher, tables) + tax(lower, tables);
    const moved =
      tax({ ...higher, interestIncome: 0, eligibleDividends: 0, capitalGains: 0 }, tables) +
      tax(
        {
          ...lower,
          interestIncome: lower.interestIncome + higher.interestIncome,
          eligibleDividends: lower.eligibleDividends + higher.eligibleDividends,
          capitalGains: lower.capitalGains + higher.capitalGains,
        },
        tables,
      );
    out.push({
      kind: "asset_location",
      title: `Future taxable investing in ${lower.personId}'s name`,
      description: `$${shift.toFixed(0)} of taxable investment income currently lands at the higher marginal rate. New taxable investments funded from ${lower.personId}'s own income would be taxed lower.`,
      dollarImpact: roundCents(now - moved),
      actions: ["Direct future non-registered savings to the lower-income spouse's account, funded from their income"],
      caveats: [
        "Attribution rules: simply gifting existing assets attributes the income back — this applies to NEW savings only",
        "Registered room should be exhausted first",
      ],
    });
  }

  return out.sort((x, y) => y.dollarImpact - x.dollarImpact);
}
