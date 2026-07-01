// Extends the v1 banking tables with ownership, registered-account, and
// categorization/transfer columns. FK targets created by later migrations
// (categories, recurring_payments) are fine here — SQLite only checks
// foreign keys at DML time, not at DDL time.
export const migration = {
  version: 3,
  name: "extend_banking",
  sql: `
ALTER TABLE items ADD COLUMN person_id TEXT REFERENCES persons(person_id);

ALTER TABLE accounts ADD COLUMN person_id TEXT REFERENCES persons(person_id);
ALTER TABLE accounts ADD COLUMN registered_type TEXT
  CHECK (registered_type IN ('FHSA','TFSA','RRSP','RESP','NONREG') OR registered_type IS NULL);
ALTER TABLE accounts ADD COLUMN purpose TEXT;
ALTER TABLE accounts ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0;

ALTER TABLE transactions ADD COLUMN category_id TEXT REFERENCES categories(category_id);
ALTER TABLE transactions ADD COLUMN categorization_source TEXT NOT NULL DEFAULT 'plaid'
  CHECK (categorization_source IN ('plaid','rule','manual'));
ALTER TABLE transactions ADD COLUMN notes TEXT;
ALTER TABLE transactions ADD COLUMN reimbursed_by TEXT
  CHECK (reimbursed_by IN ('work','buildings') OR reimbursed_by IS NULL);
ALTER TABLE transactions ADD COLUMN is_transfer INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN transfer_group_id TEXT;
ALTER TABLE transactions ADD COLUMN recurring_payment_id TEXT REFERENCES recurring_payments(rp_id);

CREATE INDEX idx_transactions_category  ON transactions(category_id);
CREATE INDEX idx_transactions_recurring ON transactions(recurring_payment_id);
`,
};
