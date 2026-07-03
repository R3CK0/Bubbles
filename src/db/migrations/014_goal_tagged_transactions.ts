// Tag a transaction as spending against a goal (trip, wedding…). Goal-tagged
// rows are excluded from household cashflow/budget — they draw from the
// goal's own envelope instead — mirroring how reimbursed_by (migration 003)
// excludes work/buildings-covered expenses.
export const migration = {
  version: 14,
  name: "goal_tagged_transactions",
  sql: `
ALTER TABLE transactions ADD COLUMN goal_id TEXT REFERENCES goals(goal_id);
CREATE INDEX idx_transactions_goal ON transactions(goal_id) WHERE goal_id IS NOT NULL;
`,
};
