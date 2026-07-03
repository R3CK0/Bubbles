// Persons are the ownership lens every later table hangs off (person_id,
// nullable = joint). Deliberately NOT seeded: the database starts clean and
// household members are created by the onboarding wizard (POST /api/persons).
export const migration = {
  version: 2,
  name: "persons_settings",
  sql: `
CREATE TABLE persons (
  person_id     TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  color         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('base_currency', 'CAD');
`,
};
