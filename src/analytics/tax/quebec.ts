/**
 * analytics/tax/quebec.ts — simplified TP-1. Pure.
 * Same structure as federal (bracket walk + BPA/donation/medical/dividend
 * credits), no abatement. Out-of-scope QC credits: Solidarity tax credit,
 * work premium, québec prescription drug insurance premium.
 */
import { roundCents } from "../money.js";
import type { JurisdictionResult, TaxInput, TaxTablePayload } from "./types.js";
import { donationCredit, medicalCredit, taxableIncome, walkBrackets } from "./federal.js";

export const QUEBEC_SCOPE_EXCLUSIONS = [
  "Solidarity tax credit and work premium",
  "Québec prescription drug insurance plan premium",
  "childcare expense credit (refundable)",
];

export function quebecTax(input: TaxInput, t: TaxTablePayload): JurisdictionResult {
  const taxable = taxableIncome(input, t);
  const grossTax = walkBrackets(taxable, t.brackets);
  const grossedDividends = input.eligibleDividends * (1 + t.eligibleDividend.grossUp);
  const credits =
    t.bpa * t.creditRate +
    donationCredit(input.donations, t) +
    medicalCredit(input.medicalExpenses, taxable, t) +
    grossedDividends * t.eligibleDividend.creditRate;
  const netTax = Math.max(0, grossTax - credits);
  return {
    taxableIncome: roundCents(taxable),
    grossTax: roundCents(grossTax),
    credits: roundCents(credits),
    netTax: roundCents(netTax),
  };
}
