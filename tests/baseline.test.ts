import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb } from "../src/db.js";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp(openDb());
});

async function mk(owner: string, cents: number) {
  const r = await request(app).post("/accounts").send({ owner, initial_balance_cents: cents });
  return r.body as { id: string; balance_cents: number };
}

describe("baseline ledger", () => {
  it("creates and fetches an account", async () => {
    const a = await mk("ada", 1000);
    const r = await request(app).get(`/accounts/${a.id}`);
    expect(r.status).toBe(200);
    expect(r.body.balance_cents).toBe(1000);
  });

  it("moves money and conserves the total", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    const r = await request(app).post("/transfers").send({ from_account: a.id, to_account: b.id, amount_cents: 400 });
    expect(r.status).toBe(201);
    const [ra, rb] = await Promise.all([request(app).get(`/accounts/${a.id}`), request(app).get(`/accounts/${b.id}`)]);
    expect(ra.body.balance_cents).toBe(600);
    expect(rb.body.balance_cents).toBe(400);
  });

  it("rejects overdrafts with 409 and leaves balances unchanged", async () => {
    const a = await mk("ada", 100);
    const b = await mk("bola", 0);
    const r = await request(app).post("/transfers").send({ from_account: a.id, to_account: b.id, amount_cents: 500 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("insufficient_funds");
    expect((await request(app).get(`/accounts/${a.id}`)).body.balance_cents).toBe(100);
  });

  it("rejects invalid amounts and same-account transfers", async () => {
    const a = await mk("ada", 100);
    const b = await mk("bola", 0);
    expect((await request(app).post("/transfers").send({ from_account: a.id, to_account: b.id, amount_cents: -5 })).status).toBe(400);
    expect((await request(app).post("/transfers").send({ from_account: a.id, to_account: a.id, amount_cents: 5 })).status).toBe(400);
  });

  it("returns 404 for unknown accounts", async () => {
    expect((await request(app).get("/accounts/nope")).status).toBe(404);
  });

  it("lists transfers for an account", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    await request(app).post("/transfers").send({ from_account: a.id, to_account: b.id, amount_cents: 100 });
    const r = await request(app).get(`/accounts/${b.id}/transfers`);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].amount_cents).toBe(100);
  });
});
