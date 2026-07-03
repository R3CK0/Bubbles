/**
 * analytics/tax/types.ts — tax domain types. Pure.
 * Rates are fractions (0.14), amounts are dollars, years are tax years.
 */

export interface Bracket {
  /** Upper bound of the bracket; null = top bracket. */
  upTo: number | null;
  rate: number;
}

export interface PayrollParams {
  qpp: { rate: number; exemption: number; maxEarnings: number; rate2: number; maxEarnings2: number };
  qpip: { rate: number; maxEarnings: number };
  ei: { rate: number; maxEarnings: number };
}

/** Parsed payload of one tax_tables row (per jurisdiction, per year). */
export interface TaxTablePayload {
  brackets: Bracket[];
  /** Basic personal amount; federal has a taper on the additional portion. */
  bpa: number;
  bpaBase?: number;
  bpaTaperStart?: number;
  bpaTaperEnd?: number;
  /** Credit rate applied to BPA and most non-refundable credits. */
  creditRate: number;
  /** Québec abatement on federal tax (federal table only). */
  abatement?: number;
  donation: { lowRate: number; highRate: number; threshold: number };
  medical: { rate: number; incomeFraction: number; maxThreshold: number };
  eligibleDividend: { grossUp: number; creditRate: number };
  capitalGainsInclusion: number;
  /** Payroll params live on the federal table (QC values, we're QC residents). */
  payroll?: PayrollParams;
}

export interface TaxTables {
  CA: TaxTablePayload;
  QC: TaxTablePayload;
}

export interface TaxInput {
  personId: string;
  taxYear: number;
  employmentIncome: number;
  rentalNet: number;
  interestIncome: number;
  eligibleDividends: number;
  capitalGains: number;
  rrspDeduction: number;
  fhsaDeduction: number;
  donations: number;
  medicalExpenses: number;
  withholdingPaid: number;
}

export interface JurisdictionResult {
  taxableIncome: number;
  grossTax: number;
  credits: number;
  netTax: number;
}

export interface PayrollResult {
  qpp: number;
  qpip: number;
  ei: number;
  total: number;
}

export interface TaxResult {
  personId: string;
  taxYear: number;
  totalIncome: number;
  taxableIncome: number;
  federal: JurisdictionResult;
  quebec: JurisdictionResult;
  payroll: PayrollResult;
  totalIncomeTax: number;
  marginalRate: number;
  averageRate: number;
  withheld: number;
  /** totalIncomeTax − withheld: positive = owing, negative = refund. */
  balance: number;
}

export interface BracketFill {
  jurisdiction: "CA" | "QC";
  tiers: { upTo: number | null; rate: number; filled: number; capacity: number | null }[];
}

export interface OptimizerAllocation {
  personId: string;
  fhsa: number;
  rrsp: number;
  tfsa: number;
  taxSaved: number;
  reasons: string[];
}

export interface OptimizerResult {
  allocations: OptimizerAllocation[];
  totalTaxSaved: number;
  totalDeployed: number;
  monthlySchedule: { personId: string; type: "fhsa" | "rrsp" | "tfsa"; monthly: number }[];
}

export interface CoupleStrategy {
  kind: "spousal_rrsp" | "credit_pooling" | "deduction_timing" | "asset_location";
  title: string;
  description: string;
  dollarImpact: number;
  actions: string[];
  caveats: string[];
}
