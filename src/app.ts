import express from "express";
import type { DB } from "./db.js";
import { Ledger, LedgerError } from "./ledger.js";
import type { RiskCheck } from "./risk.js";

export function createApp(db: DB, opts: { risk?: RiskCheck } = {}) {
  const ledger = new Ledger(db, opts.risk);
  const app = express();
  app.use(express.json());

  app.post("/accounts", (req, res) => {
    const { owner, initial_balance_cents } = req.body ?? {};
    res.status(201).json(ledger.createAccount(owner, initial_balance_cents ?? 0));
  });

  app.get("/accounts/:id", (req, res) => {
    res.json(ledger.getAccount(req.params.id));
  });

  app.get("/accounts/:id/transfers", (req, res) => {
    res.json(ledger.listTransfers(req.params.id));
  });

  app.post("/transfers", async (req, res) => {
    const { from_account, to_account, amount_cents } = req.body ?? {};
    res.status(201).json(await ledger.transfer(from_account, to_account, amount_cents, req.header("Idempotency-Key") || undefined));
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
