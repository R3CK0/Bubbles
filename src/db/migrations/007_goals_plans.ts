// Goals (house/kid/trip/purchase/savings/event/emergency_fund/debt_payoff),
// the unified funding plan (goals, debt paydown, and registered-account
// contributions compete for the same monthly dollars, so one schedule), and
// what-if scenarios. No seed data yet (wedding/Greece line items come from
// the workbook, deferred like the other Excel-derived seeds).
export const migration = {
  version: 7,
  name: "goals_plans",
  sql: `
CREATE TABLE goals (
  goal_id           TEXT PRIMARY KEY,
  goal_type         TEXT NOT NULL CHECK (goal_type IN ('house','kid','trip','purchase','savings','event','emergency_fund','debt_payoff')),
  name              TEXT NOT NULL,
  person_id         TEXT REFERENCES persons(person_id),
  target_amount     REAL NOT NULL,
  target_date       TEXT,
  priority          INTEGER NOT NULL DEFAULT 3,
  linked_account_id TEXT REFERENCES accounts(account_id),
  linked_debt_id    TEXT REFERENCES debts(debt_id),
  funded_amount     REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','achieved','abandoned','paused')),
  params_json       TEXT CHECK (params_json IS NULL OR json_valid(params_json)),
  created_at        TEXT NOT NULL,
  notes             TEXT
);

CREATE TABLE goal_line_items (
  line_id   TEXT PRIMARY KEY,
  goal_id   TEXT NOT NULL REFERENCES goals(goal_id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  amount    REAL NOT NULL,
  due_date  TEXT,
  status    TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','deposit_paid','paid','cancelled')),
  transaction_id TEXT REFERENCES transactions(transaction_id)
);

CREATE TABLE plans (
  plan_id     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  approved_at TEXT,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','superseded','completed')),
  solver_inputs_json TEXT CHECK (solver_inputs_json IS NULL OR json_valid(solver_inputs_json)),
  notes       TEXT
);

CREATE TABLE plan_lines (
  plan_id     TEXT NOT NULL REFERENCES plans(plan_id) ON DELETE CASCADE,
  month       TEXT NOT NULL,
  person_id   TEXT REFERENCES persons(person_id),
  target_type TEXT NOT NULL CHECK (target_type IN ('goal','debt','fhsa','rrsp','tfsa','buffer')),
  target_id   TEXT,
  amount      REAL NOT NULL,
  PRIMARY KEY (plan_id, month, person_id, target_type, target_id)
);

CREATE TABLE scenarios (
  scenario_id TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  params_json TEXT NOT NULL CHECK (json_valid(params_json)),
  created_at  TEXT NOT NULL,
  notes       TEXT
);
`,
};
