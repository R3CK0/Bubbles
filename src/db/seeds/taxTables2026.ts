/**
 * db/seeds/taxTables2026.ts — 2026 federal + Québec parameters as DATA.
 * Sources (November 2025 announcements, retrieved July 2026):
 *   - CRA: 2026 brackets 14/20.5/26/29/33 at 58,523 / 117,045 / 181,440 /
 *     258,482; BPA 16,452 (base 14,829 + 1,623 tapered over 181,440→258,482);
 *     indexation 2.0%. https://www.canada.ca/.../tax-rates-brackets/current-year.html
 *   - Québec (Finances): 14/19/24/25.75 at 54,345 / 108,680 / 132,245;
 *     BPA 18,952; indexation 2.05%. AUTEN_IncomeTax2026.pdf
 *   - QPP 2026: 6.3% (5.3 base + 1.0 add'l) to YMPE 74,600 less 3,500
 *     exemption; QPP2 4% on 74,600→85,000. Retraite Québec.
 *   - QPIP 2026: 0.430% to MIE 103,000. Revenu Québec.
 *   - EI (QC-reduced) 2026: 1.30% to MIE 68,900. CEIC.
 * Next January: INSERT the 2027 payloads — no code change.
 */
import type { TaxTablePayload } from "../../analytics/tax/types.js";

export const TAX_TABLES_2026: { CA: TaxTablePayload; QC: TaxTablePayload } = {
  CA: {
    brackets: [
      { upTo: 58_523, rate: 0.14 },
      { upTo: 117_045, rate: 0.205 },
      { upTo: 181_440, rate: 0.26 },
      { upTo: 258_482, rate: 0.29 },
      { upTo: null, rate: 0.33 },
    ],
    bpa: 16_452,
    bpaBase: 14_829,
    bpaTaperStart: 181_440,
    bpaTaperEnd: 258_482,
    creditRate: 0.14,
    abatement: 0.165,
    donation: { lowRate: 0.14, highRate: 0.29, threshold: 200 },
    medical: { rate: 0.14, incomeFraction: 0.03, maxThreshold: 2_834 },
    eligibleDividend: { grossUp: 0.38, creditRate: 0.150198 },
    capitalGainsInclusion: 0.5,
    payroll: {
      qpp: { rate: 0.063, exemption: 3_500, maxEarnings: 74_600, rate2: 0.04, maxEarnings2: 85_000 },
      qpip: { rate: 0.0043, maxEarnings: 103_000 },
      ei: { rate: 0.013, maxEarnings: 68_900 },
    },
  },
  QC: {
    brackets: [
      { upTo: 54_345, rate: 0.14 },
      { upTo: 108_680, rate: 0.19 },
      { upTo: 132_245, rate: 0.24 },
      { upTo: null, rate: 0.2575 },
    ],
    bpa: 18_952,
    creditRate: 0.14,
    donation: { lowRate: 0.2, highRate: 0.24, threshold: 200 },
    medical: { rate: 0.2, incomeFraction: 0.03, maxThreshold: Number.POSITIVE_INFINITY },
    eligibleDividend: { grossUp: 0.38, creditRate: 0.117 },
    capitalGainsInclusion: 0.5,
  },
};
