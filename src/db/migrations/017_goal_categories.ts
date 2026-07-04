// Every goal now belongs to one of three categories that decide how progress
// is measured: 'saving' tracks a linked account balance up to the target,
// 'spending' tracks transactions tagged to the goal against its own budget,
// 'loan' tracks a linked debt/account balance down to the target by a date.
// Existing rows are backfilled from their thematic goal_type.
export const migration = {
  version: 17,
  name: "goal_categories",
  sql: `
ALTER TABLE goals ADD COLUMN category TEXT NOT NULL DEFAULT 'saving'
  CHECK (category IN ('saving','spending','loan'));

UPDATE goals SET category = CASE
  WHEN goal_type IN ('trip','purchase','event') THEN 'spending'
  WHEN goal_type = 'debt_payoff' THEN 'loan'
  ELSE 'saving'
END;
`,
};
