import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { runMigrations } from "./migrator.js";

let instance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (instance) return instance;

  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  instance = new Database(config.dbPath);
  instance.pragma("journal_mode = WAL");
  instance.pragma("foreign_keys = ON");
  runMigrations(instance);

  return instance;
}
