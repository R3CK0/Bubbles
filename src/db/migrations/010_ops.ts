// Operational tables: alerts, archived reports, the couple's decision log,
// and a health record of every nightly sync job run. The computed views from
// docs/DATA_MODEL.md section 11 (net worth, flux matrix, budget vs. actual,
// upcoming bills, contribution room) are intentionally NOT created here —
// the doc itself lists them as placeholders ("...") to be written once the
// analytics engine exists, not real SQL yet.
export const migration = {
  version: 10,
  name: "ops",
  sql: `
CREATE TABLE alerts (
  alert_id        TEXT PRIMARY KEY,
  alert_type      TEXT NOT NULL,
  severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title           TEXT NOT NULL,
  body            TEXT,
  payload_json    TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at      TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES persons(person_id)
);
CREATE INDEX idx_alerts_open ON alerts(created_at) WHERE acknowledged_at IS NULL;

CREATE TABLE reports (
  report_id    TEXT PRIMARY KEY,
  report_type  TEXT NOT NULL CHECK (report_type IN ('monthly','quarterly','annual','adhoc')),
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  content_md   TEXT NOT NULL,
  data_json    TEXT CHECK (data_json IS NULL OR json_valid(data_json)),
  created_at   TEXT NOT NULL
);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  links_json  TEXT CHECK (links_json IS NULL OR json_valid(links_json))
);

CREATE TABLE sync_runs (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','success','partial','failed')),
  stats_json  TEXT CHECK (stats_json IS NULL OR json_valid(stats_json))
);
`,
};
