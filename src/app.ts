import express from "express";
import type { DB } from "./db.js";
import { Ledger, LedgerError } from "./ledger.js";

export function createApp(db: DB) {
  const ledger = new Ledger(db);
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

  app.post("/transfers", (req, res) => {
    const { from_account, to_account, amount_cents } = req.body ?? {};
    res.status(201).json(ledger.transfer(from_account, to_account, amount_cents));
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
