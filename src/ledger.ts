import { randomUUID } from "node:crypto";
import type { DB } from "./db.js";

export class LedgerError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export interface Account {
  id: string;
  owner: string;
  balance_cents: number;
  created_at: string;
}

export interface Transfer {
  id: string;
  from_account: string;
  to_account: string;
  amount_cents: number;
  created_at: string;
}

export class Ledger {
  constructor(private db: DB) {}

  createAccount(owner: string, initialCents = 0): Account {
    if (!owner) throw new LedgerError("invalid_owner", "owner is required");
    if (!Number.isInteger(initialCents) || initialCents < 0)
      throw new LedgerError("invalid_amount", "initial balance must be a non-negative integer");
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO accounts (id, owner, balance_cents) VALUES (?, ?, ?)")
      .run(id, owner, initialCents);
    return this.getAccount(id);
  }

  getAccount(id: string): Account {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Account | undefined;
    if (!row) throw new LedgerError("account_not_found", `account ${id} not found`, 404);
    return row;
  }

  transfer(from: string, to: string, amountCents: number, idempotencyKey?: string): Transfer {
    if (!Number.isInteger(amountCents) || amountCents <= 0)
      throw new LedgerError("invalid_amount", "amount must be a positive integer (cents)");
    if (from === to) throw new LedgerError("same_account", "cannot transfer to the same account");

    const requestHash = `${from}|${to}|${amountCents}`;
    const run = this.db.transaction(() => {
      if (idempotencyKey) {
        const seen = this.db
          .prepare("SELECT request_hash, response_json FROM idempotency_keys WHERE account_id = ? AND key = ?")
          .get(from, idempotencyKey) as { request_hash: string; response_json: string } | undefined;
        if (seen) {
          if (seen.request_hash !== requestHash)
            throw new LedgerError("idempotency_key_reuse", "key was used with a different request", 422);
          return JSON.parse(seen.response_json) as Transfer;
        }
      }
      const src = this.getAccount(from);
      this.getAccount(to);
      if (src.balance_cents < amountCents)
        throw new LedgerError("insufficient_funds", "insufficient funds", 409);
      this.db.prepare("UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?").run(amountCents, from);
      this.db.prepare("UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?").run(amountCents, to);
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO transfers (id, from_account, to_account, amount_cents) VALUES (?, ?, ?, ?)")
        .run(id, from, to, amountCents);
      const created = this.db.prepare("SELECT * FROM transfers WHERE id = ?").get(id) as Transfer;
      if (idempotencyKey)
        this.db
          .prepare("INSERT INTO idempotency_keys (account_id, key, request_hash, response_json) VALUES (?, ?, ?, ?)")
          .run(from, idempotencyKey, requestHash, JSON.stringify(created));
      return created;
    });
    return run();
  }

  listTransfers(accountId: string): Transfer[] {
    this.getAccount(accountId);
    return this.db
      .prepare(
        "SELECT * FROM transfers WHERE from_account = ? OR to_account = ? ORDER BY created_at, rowid"
      )
      .all(accountId, accountId) as Transfer[];
  }
}
