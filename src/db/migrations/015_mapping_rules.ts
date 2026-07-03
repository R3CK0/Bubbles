// Merchant→target mappings grow two capabilities:
//   1. A rule can now point at a goal (and optionally one of its line items /
//      subcategories) instead of a budget category — "Airbnb Tokyo" → Japan
//      trip / hotel — so goal spending auto-tags the same way categories do.
//   2. Rules carry provenance (source: manual | ai) and can be locked
//      (locked_at): a locked mapping is the "confirmed forever" state the AI
//      review flow writes after the user accepts a suggestion — it can be
//      deleted, never silently edited.
// category_rules is rebuilt because category_id loses its NOT NULL (a goal
// rule has no category). Transactions gain goal_line_id so goal-tagged
// spending can land on a specific line item (trip → hotel vs food).
export const migration = {
  version: 15,
  name: "mapping_rules",
  sql: `
CREATE TABLE category_rules_v2 (
  rule_id          TEXT PRIMARY KEY,
  priority         INTEGER NOT NULL,
  merchant_pattern TEXT,
  payee_pattern    TEXT,
  plaid_category   TEXT,
  account_id       TEXT REFERENCES accounts(account_id),
  amount_min       REAL,
  amount_max       REAL,
  category_id      TEXT REFERENCES categories(category_id),
  goal_id          TEXT REFERENCES goals(goal_id),
  goal_line_id     TEXT REFERENCES goal_line_items(line_id),
  source           TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai')),
  locked_at        TEXT,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  CHECK (category_id IS NOT NULL OR goal_id IS NOT NULL)
);

INSERT INTO category_rules_v2
  (rule_id, priority, merchant_pattern, payee_pattern, plaid_category,
   account_id, amount_min, amount_max, category_id, active, created_at)
SELECT rule_id, priority, merchant_pattern, payee_pattern, plaid_category,
       account_id, amount_min, amount_max, category_id, active, created_at
FROM category_rules;

DROP TABLE category_rules;
ALTER TABLE category_rules_v2 RENAME TO category_rules;

ALTER TABLE transactions ADD COLUMN goal_line_id TEXT REFERENCES goal_line_items(line_id);
CREATE INDEX idx_transactions_goal_line ON transactions(goal_line_id) WHERE goal_line_id IS NOT NULL;
`,
};
