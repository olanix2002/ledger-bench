import Database from "better-sqlite3";

export type DB = Database.Database;

export function openDb(path = ":memory:"): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY,
      from_account TEXT NOT NULL REFERENCES accounts(id),
      to_account TEXT NOT NULL REFERENCES accounts(id),
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
