/**
 * analytics/tax/estimator.ts — composes payroll + federal + Québec. Pure.
 * Marginal rate is empirical (re-run at +$100) so it's correct across
 * credit tapers, not just bracket edges.
 */
import { roundCents } from "../money.js";
import type { BracketFill, TaxInput, TaxResult, TaxTables } from "./types.js";
import { federalTax, taxableIncome, walkBrackets } from "./federal.js";
import { quebecTax } from "./quebec.js";
import { payrollContributions } from "./payroll.js";

function incomeTaxAt(input: TaxInput, tables: TaxTables): number {
  return federalTax(input, tables.CA).netTax + quebecTax(input, tables.QC).netTax;
}

export function estimateTax(input: TaxInput, tables: TaxTables): TaxResult {
  const federal = federalTax(input, tables.CA);
  const quebec = quebecTax(input, tables.QC);
  const payroll = tables.CA.payroll
    ? payrollContributions(input.employmentIncome, tables.CA.payroll)
    : { qpp: 0, qpip: 0, ei: 0, total: 0 };

  const totalIncome =
    input.employmentIncome + input.rentalNet + input.interestIncome + input.eligibleDividends + input.capitalGains;
  const totalIncomeTax = roundCents(federal.netTax + quebec.netTax);

  const base = incomeTaxAt(input, tables);
  const bumped = incomeTaxAt({ ...input, employmentIncome: input.employmentIncome + 100 }, tables);
  const marginalRate = Math.round(((bumped - base) / 100) * 10000) / 10000;

  return {
    personId: input.personId,
    taxYear: input.taxYear,
    totalIncome: roundCents(totalIncome),
    taxableIncome: federal.taxableIncome,
    federal,
    quebec,
    payroll,
    totalIncomeTax,
    marginalRate,
    averageRate: totalIncome > 0 ? Math.round((totalIncomeTax / totalIncome) * 10000) / 10000 : 0,
    withheld: input.withholdingPaid,
    balance: roundCents(totalIncomeTax - input.withholdingPaid),
  };
}

export interface HouseholdEstimate {
  totalIncome: number;
  totalIncomeTax: number;
  totalPayroll: number;
  balance: number;
  averageRate: number;
}

export function householdEstimate(results: TaxResult[]): HouseholdEstimate {
  const totalIncome = roundCents(results.reduce((s, r) => s + r.totalIncome, 0));
  const totalIncomeTax = roundCents(results.reduce((s, r) => s + r.totalIncomeTax, 0));
  return {
    totalIncome,
    totalIncomeTax,
    totalPayroll: roundCents(results.reduce((s, r) => s + r.payroll.total, 0)),
    balance: roundCents(results.reduce((s, r) => s + r.balance, 0)),
    averageRate: totalIncome > 0 ? Math.round((totalIncomeTax / totalIncome) * 10000) / 10000 : 0,
  };
}

/** Per-tier fill levels for the “bracket glasses” visualization. */
export function bracketGlasses(input: TaxInput, tables: TaxTables): BracketFill[] {
  return (["CA", "QC"] as const).map((jurisdiction) => {
    const t = tables[jurisdiction];
    const taxable = taxableIncome(input, t);
    let prev = 0;
    const tiers = t.brackets.map((b) => {
      const cap = b.upTo;
      const capacity = cap === null ? null : cap - prev;
      const filled = Math.max(0, Math.min(taxable, cap ?? Number.POSITIVE_INFINITY) - prev);
      prev = cap ?? prev;
      return { upTo: cap, rate: b.rate, filled: roundCents(filled), capacity };
    });
    return { jurisdiction, tiers };
  });
}

/** Sanity helper used by tests: raw bracket tax before credits. */
export function grossTaxFor(taxable: number, tables: TaxTables, jurisdiction: "CA" | "QC"): number {
  return roundCents(walkBrackets(taxable, tables[jurisdiction].brackets));
}
