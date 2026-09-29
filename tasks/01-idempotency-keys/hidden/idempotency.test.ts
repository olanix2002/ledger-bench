import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb } from "../../../src/db.js";
import { createApp } from "../../../src/app.js";

let app: ReturnType<typeof createApp>;
beforeEach(() => {
  app = createApp(openDb());
});

async function mk(owner: string, cents: number) {
  return (await request(app).post("/accounts").send({ owner, initial_balance_cents: cents })).body as { id: string };
}
const bal = async (id: string) => (await request(app).get(`/accounts/${id}`)).body.balance_cents as number;
const pay = (from: string, to: string, amount: number, key?: string) => {
  const r = request(app).post("/transfers").send({ from_account: from, to_account: to, amount_cents: amount });
  return key ? r.set("Idempotency-Key", key) : r;
};

describe("idempotency keys", () => {
  it("replays the original response and moves money once", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    const first = await pay(a.id, b.id, 300, "k1");
    const second = await pay(a.id, b.id, 300, "k1");
    expect(first.status).toBe(201);
    expect(second.status).toBe(first.status);
    expect(second.body.id).toBe(first.body.id);
    expect(await bal(a.id)).toBe(700);
    expect(await bal(b.id)).toBe(300);
    expect((await request(app).get(`/accounts/${a.id}/transfers`)).body).toHaveLength(1);
  });

  it("rejects key reuse with a different amount and moves no money", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    await pay(a.id, b.id, 300, "k1");
    const r = await pay(a.id, b.id, 500, "k1");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await bal(a.id)).toBe(700);
  });

  it("rejects key reuse with a different destination and moves no money", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    const c = await mk("chi", 0);
    await pay(a.id, b.id, 300, "k1");
    const r = await pay(a.id, c.id, 300, "k1");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await bal(c.id)).toBe(0);
    expect(await bal(a.id)).toBe(700);
  });

  it("does not lock a key to a failed request", async () => {
    const a = await mk("ada", 100);
    const b = await mk("bola", 0);
    const funder = await mk("funder", 1000);
    const failed = await pay(a.id, b.id, 500, "k1");
    expect(failed.status).toBe(409);
    await pay(funder.id, a.id, 1000);
    const retry = await pay(a.id, b.id, 500, "k1");
    expect(retry.status).toBe(201);
    expect(await bal(b.id)).toBe(500);
  });

  it("keeps working without the header", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    expect((await pay(a.id, b.id, 100)).status).toBe(201);
    expect((await pay(a.id, b.id, 100)).status).toBe(201);
    expect(await bal(b.id)).toBe(200);
  });

  it("scopes keys per source account", async () => {
    const a = await mk("ada", 1000);
    const c = await mk("chi", 1000);
    const b = await mk("bola", 0);
    const r1 = await pay(a.id, b.id, 100, "shared");
    const r2 = await pay(c.id, b.id, 100, "shared");
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.body.id).not.toBe(r1.body.id);
    expect(await bal(b.id)).toBe(200);
  });

  it("handles concurrent retries with the same key", async () => {
    const a = await mk("ada", 1000);
    const b = await mk("bola", 0);
    const rs = await Promise.all(Array.from({ length: 6 }, () => pay(a.id, b.id, 250, "burst")));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await bal(a.id)).toBe(750);
    expect(await bal(b.id)).toBe(250);
  });
});
