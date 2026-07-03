// What actually lands in the bank each week, per person. Compared against the
// bracket estimator's after-tax figure it exposes the non-statutory paycheque
// deductions (group health insurance, pension, union dues…) that neither the
// tax tables nor QPP/QPIP/EI account for.
export const migration = {
  version: 13,
  name: "weekly_take_home",
  sql: `
ALTER TABLE tax_profiles ADD COLUMN weekly_take_home REAL;
`,
};
