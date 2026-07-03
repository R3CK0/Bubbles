/** Extra (non-employment) income helpers shared by onboarding and the Taxes page. */

export interface ExtraIncome {
  rentalNet?: number;
  interest?: number;
  eligibleDividends?: number;
  capitalGains?: number;
  donations?: number;
  medicalExpenses?: number;
}

export function parseExtra(json: string | null | undefined): ExtraIncome {
  if (!json) return {};
  try {
    return JSON.parse(json) as ExtraIncome;
  } catch {
    return {};
  }
}

/** Annual gross of the income-type fields (ignores donations/medical credits). */
export function extraGrossAnnual(e: ExtraIncome): number {
  return (e.rentalNet ?? 0) + (e.interest ?? 0) + (e.eligibleDividends ?? 0) + (e.capitalGains ?? 0);
}

/**
 * Approximate after-tax value of the extra income at the person's marginal
 * rate: rental/interest/dividends as ordinary income, capital gains at the
 * 50% inclusion rate. Good enough to split "job pay" from "extra income" in
 * the paycheque analysis — the exact combined tax lives in the estimator.
 */
export function extraNetAnnual(e: ExtraIncome, marginalRate: number): number {
  const ordinary = ((e.rentalNet ?? 0) + (e.interest ?? 0) + (e.eligibleDividends ?? 0)) * (1 - marginalRate);
  const gains = (e.capitalGains ?? 0) * (1 - marginalRate * 0.5);
  return ordinary + gains;
}
