import type Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations/index.js";

interface MigrationRow {
  version: number;
}

// schema_migrations is also (re)declared by migration 001 itself — both are
// idempotent (CREATE TABLE IF NOT EXISTS / PRIMARY KEY conflict-free), so
// this bootstrap just guarantees the tracking table exists even before any
// migration has run.
function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
}

export function runMigrations(db: Database.Database): void {
  ensureMigrationsTable(db);

  const applied = new Set(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as MigrationRow[]).map((row) => row.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
        migration.version,
        new Date().toISOString(),
      );
    });
    apply();
  }
}
