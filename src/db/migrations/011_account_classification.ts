// Adds the two account-classification columns introduced in DATA_MODEL.md §2:
//   - tracked:       deselected in the add-bank wizard → still synced/listed,
//                    but excluded from all downstream analytics.
//   - classified_at: NULL until the user has reviewed the account in the
//                    add-bank wizard; onboarding gates on this.
//
// These live in their own migration (not folded into 003) because 003 has
// already been applied to live databases — migrations are immutable once
// shipped, so new columns arrive as a new numbered step.
export const migration = {
  version: 11,
  name: "account_classification",
  sql: `
ALTER TABLE accounts ADD COLUMN tracked INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN classified_at TEXT;
`,
};
