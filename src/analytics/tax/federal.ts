/**
 * analytics/tax/federal.ts — simplified T1 for a Québec resident. Pure.
 *
 * SCOPE (what this estimator deliberately ignores — surfaced in the UI):
 * self-employment/corp income, non-eligible dividends, capital-loss
 * carry-backs, CPP/QPP enhanced-contribution deduction, employment amount,
 * Canada Workers Benefit, foreign tax credits, AMT.
 */
import { roundCents } from "../money.js";
import type { Bracket, JurisdictionResult, TaxInput, TaxTablePayload } from "./types.js";

export const FEDERAL_SCOPE_EXCLUSIONS = [
  "self-employment and corporate income",
  "non-eligible dividends",
  "capital-loss carry-backs",
  "QPP enhanced-contribution deduction and employment amount credits",
  "Canada Workers Benefit, foreign tax credits, AMT",
];

export function walkBrackets(taxable: number, brackets: Bracket[]): number {
  let tax = 0;
  let prev = 0;
  for (const b of brackets) {
    const cap = b.upTo ?? Number.POSITIVE_INFINITY;
    if (taxable <= prev) break;
    tax += (Math.min(taxable, cap) - prev) * b.rate;
    prev = cap;
  }
  return tax;
}

/** Income components → taxable income (shared shape for both jurisdictions). */
export function taxableIncome(input: TaxInput, tables: TaxTablePayload): number {
  const grossedDividends = input.eligibleDividends * (1 + tables.eligibleDividend.grossUp);
  const total =
    input.employmentIncome +
    input.rentalNet +
    input.interestIncome +
    grossedDividends +
    input.capitalGains * tables.capitalGainsInclusion;
  return Math.max(0, total - input.rrspDeduction - input.fhsaDeduction);
}

function bpaFor(netIncome: number, t: TaxTablePayload): number {
  if (t.bpaBase === undefined || t.bpaTaperStart === undefined || t.bpaTaperEnd === undefined) return t.bpa;
  if (netIncome <= t.bpaTaperStart) return t.bpa;
  if (netIncome >= t.bpaTaperEnd) return t.bpaBase;
  const additional = t.bpa - t.bpaBase;
  const fraction = (netIncome - t.bpaTaperStart) / (t.bpaTaperEnd - t.bpaTaperStart);
  return t.bpa - additional * fraction;
}

export function donationCredit(donations: number, t: TaxTablePayload): number {
  if (donations <= 0) return 0;
  const low = Math.min(donations, t.donation.threshold);
  const high = Math.max(0, donations - t.donation.threshold);
  return low * t.donation.lowRate + high * t.donation.highRate;
}

export function medicalCredit(medical: number, netIncome: number, t: TaxTablePayload): number {
  const threshold = Math.min(netIncome * t.medical.incomeFraction, t.medical.maxThreshold);
  return Math.max(0, medical - threshold) * t.medical.rate;
}

/** Federal tax net of credits and the 16.5% Québec abatement. */
export function federalTax(input: TaxInput, t: TaxTablePayload): JurisdictionResult {
  const taxable = taxableIncome(input, t);
  const grossTax = walkBrackets(taxable, t.brackets);

  const grossedDividends = input.eligibleDividends * (1 + t.eligibleDividend.grossUp);
  const credits =
    bpaFor(taxable, t) * t.creditRate +
    donationCredit(input.donations, t) +
    medicalCredit(input.medicalExpenses, taxable, t) +
    grossedDividends * t.eligibleDividend.creditRate;

  const beforeAbatement = Math.max(0, grossTax - credits);
  const netTax = beforeAbatement * (1 - (t.abatement ?? 0));
  return {
    taxableIncome: roundCents(taxable),
    grossTax: roundCents(grossTax),
    credits: roundCents(credits),
    netTax: roundCents(netTax),
  };
}
