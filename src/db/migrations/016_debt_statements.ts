// Monthly statement rows for revolving debt. Credit cards demand a pay-by
// date every month (the short-term debt screen refuses to project interest
// without one); statement_balance overrides the computed start-of-month
// balance when the user copies it off the real statement.
export const migration = {
  version: 16,
  name: "debt_statements",
  sql: `
CREATE TABLE debt_statements (
  debt_id           TEXT NOT NULL REFERENCES debts(debt_id),
  month             TEXT NOT NULL,            -- YYYY-MM the payment is due in
  due_date          TEXT NOT NULL,            -- YYYY-MM-DD pay-by date
  statement_balance REAL,                     -- from the statement, optional
  minimum_due       REAL,                     -- from the statement, optional
  created_at        TEXT NOT NULL,
  PRIMARY KEY (debt_id, month)
);
`,
};
