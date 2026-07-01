// Persons are the ownership lens every later table hangs off (person_id,
// nullable = joint). Seeded with the two household members named throughout
// docs/DATA_MODEL.md and docs/PLATFORM_PROPOSAL.md.
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

INSERT INTO persons (person_id, display_name, created_at) VALUES
  ('nick', 'Nick', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ('shanthi', 'Shanthi', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

INSERT INTO settings (key, value) VALUES
  ('base_currency', 'CAD');
`,
};
