/**
 * analytics/tax/payroll.ts — QPP, QPIP, EI employee contributions. Pure.
 */
import { roundCents } from "../money.js";
import type { PayrollParams, PayrollResult } from "./types.js";

export function payrollContributions(employmentIncome: number, params: PayrollParams): PayrollResult {
  const e = Math.max(0, employmentIncome);
  const qppBase = Math.max(0, Math.min(e, params.qpp.maxEarnings) - params.qpp.exemption) * params.qpp.rate;
  const qpp2 = Math.max(0, Math.min(e, params.qpp.maxEarnings2) - params.qpp.maxEarnings) * params.qpp.rate2;
  const qpip = Math.min(e, params.qpip.maxEarnings) * params.qpip.rate;
  const ei = Math.min(e, params.ei.maxEarnings) * params.ei.rate;
  const qpp = roundCents(qppBase + qpp2);
  return {
    qpp,
    qpip: roundCents(qpip),
    ei: roundCents(ei),
    total: roundCents(qpp + qpip + ei),
  };
}
