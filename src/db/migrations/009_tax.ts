// Registered-account room/contributions and the federal+Québec tax
// calculator's inputs/outputs. Bracket data (tax_tables) is versioned data,
// not code — no rows seeded here, that's a yearly data-entry task, not schema.
export const migration = {
  version: 9,
  name: "tax",
  sql: `
CREATE TABLE registered_room (
  person_id    TEXT NOT NULL REFERENCES persons(person_id),
  account_type TEXT NOT NULL CHECK (account_type IN ('FHSA','TFSA','RRSP')),
  tax_year     INTEGER NOT NULL,
  room_amount  REAL NOT NULL,
  as_of        TEXT NOT NULL,
  source       TEXT,
  PRIMARY KEY (person_id, account_type, tax_year)
);

CREATE TABLE registered_contributions (
  contrib_id        TEXT PRIMARY KEY,
  person_id         TEXT NOT NULL REFERENCES persons(person_id),
  account_type      TEXT NOT NULL CHECK (account_type IN ('FHSA','TFSA','RRSP','RRSP_SPOUSAL')),
  account_id        TEXT REFERENCES accounts(account_id),
  date              TEXT NOT NULL,
  amount            REAL NOT NULL,
  transaction_id    TEXT REFERENCES transactions(transaction_id),
  tax_year          INTEGER NOT NULL,
  deduction_year    INTEGER,
  contributor_person_id TEXT REFERENCES persons(person_id)
);

CREATE TABLE tax_profiles (
  person_id         TEXT NOT NULL REFERENCES persons(person_id),
  tax_year          INTEGER NOT NULL,
  employment_income REAL,
  withholding_paid  REAL,
  other_income_json TEXT CHECK (other_income_json IS NULL OR json_valid(other_income_json)),
  carryforwards_json TEXT CHECK (carryforwards_json IS NULL OR json_valid(carryforwards_json)),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (person_id, tax_year)
);

CREATE TABLE tax_tables (
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('CA','QC')),
  tax_year     INTEGER NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (jurisdiction, tax_year, version)
);

CREATE TABLE tax_estimates (
  estimate_id  TEXT PRIMARY KEY,
  person_id    TEXT REFERENCES persons(person_id),
  scenario_id  TEXT REFERENCES scenarios(scenario_id),
  tax_year     INTEGER NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('estimate','optimization')),
  computed_at  TEXT NOT NULL,
  inputs_json  TEXT NOT NULL CHECK (json_valid(inputs_json)),
  results_json TEXT NOT NULL CHECK (json_valid(results_json))
);
`,
};
