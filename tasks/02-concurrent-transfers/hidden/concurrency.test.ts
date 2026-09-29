import { describe, it, expect } from "vitest";
import request from "supertest";
import { openDb } from "../../../src/db.js";
import { createApp } from "../../../src/app.js";
import type { RiskCheck, RiskRequest } from "../../../src/risk.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Slow, always-allow risk service so concurrent requests reliably overlap. */
function slowRisk(calls: RiskRequest[] = []): RiskCheck {
  return {
    async assess(req) {
      calls.push(req);
      await sleep(15);
      return { allow: true };
    },
  };
}

function setup(risk: RiskCheck = slowRisk()) {
  const app = createApp(openDb(), { risk });
  const mk = async (owner: string, cents: number) =>
    (await request(app).post("/accounts").send({ owner, initial_balance_cents: cents })).body.id as string;
  const pay = (from: string, to: string, amount: number, key?: string) => {
    const r = request(app).post("/transfers").send({ from_account: from, to_account: to, amount_cents: amount });
    return key ? r.set("Idempotency-Key", key) : r;
  };
  const bal = async (id: string) => (await request(app).get(`/accounts/${id}`)).body.balance_cents as number;
  const history = async (id: string) =>
    (await request(app).get(`/accounts/${id}/transfers`)).body as { from_account: string; to_account: string; amount_cents: number }[];
  return { app, mk, pay, bal, history };
}

/** Balance must equal starting balance plus incoming minus outgoing, per the history. */
async function reconciles(s: ReturnType<typeof setup>, id: string, start: number) {
  let expected = start;
  for (const t of await s.history(id)) {
    if (t.to_account === id) expected += t.amount_cents;
    if (t.from_account === id) expected -= t.amount_cents;
  }
  expect(await s.bal(id)).toBe(expected);
}

describe("concurrent transfers", () => {
  it("never overdraws: only the transfers that fit succeed, the rest get 409", async () => {
    const s = setup();
    const a = await s.mk("ada", 1000);
    const b = await s.mk("bola", 0);
    const rs = await Promise.all(Array.from({ length: 10 }, () => s.pay(a, b, 300)));
    const ok = rs.filter((r) => r.status === 201);
    const declined = rs.filter((r) => r.status === 409);
    expect(ok).toHaveLength(3);
    expect(declined).toHaveLength(7);
    expect(declined.every((r) => r.body.error === "insufficient_funds")).toBe(true);
    expect(await s.bal(a)).toBe(100);
    expect(await s.bal(b)).toBe(900);
    expect(await s.history(a)).toHaveLength(3);
  });

  it("two payments that cannot both fit: exactly one succeeds", async () => {
    const s = setup();
    const a = await s.mk("ada", 1000);
    const b = await s.mk("bola", 0);
    const [r1, r2] = await Promise.all([s.pay(a, b, 600), s.pay(a, b, 600)]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(await s.bal(a)).toBe(400);
    expect(await s.bal(b)).toBe(600);
  });

  it("never answers with a server error under load", async () => {
    const s = setup();
    const a = await s.mk("ada", 500);
    const b = await s.mk("bola", 0);
    const rs = await Promise.all(Array.from({ length: 25 }, () => s.pay(a, b, 100)));
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
  });

  it("does not lose updates when many sources pay one destination", async () => {
    const s = setup();
    const dst = await s.mk("shop", 0);
    const sources = await Promise.all(Array.from({ length: 8 }, (_, i) => s.mk(`payer${i}`, 1000)));
    const rs = await Promise.all(sources.flatMap((src) => [1, 2, 3].map(() => s.pay(src, dst, 100))));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await s.bal(dst)).toBe(2400);
    for (const src of sources) expect(await s.bal(src)).toBe(700);
  });

  it("conserves money and reconciles with history for transfers in both directions", async () => {
    const s = setup();
    const a = await s.mk("ada", 1000);
    const b = await s.mk("bola", 1000);
    const rs = await Promise.all(
      Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? s.pay(a, b, 150) : s.pay(b, a, 90)))
    );
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect((await s.bal(a)) + (await s.bal(b))).toBe(2000);
    expect(await s.bal(a)).toBeGreaterThanOrEqual(0);
    expect(await s.bal(b)).toBeGreaterThanOrEqual(0);
    await reconciles(s, a, 1000);
    await reconciles(s, b, 1000);
  });

  it("a mixed burst across several accounts still reconciles everywhere", async () => {
    const s = setup();
    const ids = await Promise.all([700, 300, 900, 100].map((c, i) => s.mk(`u${i}`, c)));
    const jobs: Promise<request.Response>[] = [];
    for (let i = 0; i < 40; i++) {
      const from = ids[i % 4];
      const to = ids[(i * 3 + 1) % 4];
      if (from !== to) jobs.push(s.pay(from, to, 80));
    }
    const rs = await Promise.all(jobs);
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    let total = 0;
    for (const [i, id] of ids.entries()) {
      const b = await s.bal(id);
      expect(b).toBeGreaterThanOrEqual(0);
      total += b;
      await reconciles(s, id, [700, 300, 900, 100][i]);
    }
    expect(total).toBe(2000);
  });

  it("still consults the risk check for every new transfer", async () => {
    const calls: RiskRequest[] = [];
    const s = setup(slowRisk(calls));
    const a = await s.mk("ada", 1000);
    const b = await s.mk("bola", 0);
    await Promise.all([1, 2, 3, 4, 5].map(() => s.pay(a, b, 100)));
    expect(calls).toHaveLength(5);
    expect(calls.every((c) => c.from === a && c.to === b && c.amountCents === 100)).toBe(true);
  });

  it("a blocked transfer moves no money and leaves no history", async () => {
    const s = setup({ assess: async () => ({ allow: false, reason: "flagged" }) });
    const a = await s.mk("ada", 1000);
    const b = await s.mk("bola", 0);
    const r = await s.pay(a, b, 100);
    expect(r.status).toBe(403);
    expect(await s.bal(a)).toBe(1000);
    expect(await s.bal(b)).toBe(0);
    expect(await s.history(a)).toHaveLength(0);
  });

  it("concurrent retries with one idempotency key still move money once", async () => {
    const s = setup();
    const a = await s.mk("ada", 1000);
    const b = await s.mk("bola", 0);
    const rs = await Promise.all(Array.from({ length: 6 }, () => s.pay(a, b, 250, "burst")));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await s.bal(a)).toBe(750);
    expect(await s.bal(b)).toBe(250);
  });
});
