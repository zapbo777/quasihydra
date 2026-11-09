import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { createTestDb } from "./d1.js";

const ORIGIN = "https://lalaayenglobalplaza.com";
const env = () => ({ DB: createTestDb(), BILLING_MODE: "off", ALLOWED_ORIGINS: ORIGIN, PBKDF2_ITERATIONS: "1000" });

async function call(e, method, path, { body, token, client = "1", ip = "203.0.113.50" } = {}) {
  const headers = new Headers({ Origin: ORIGIN, "CF-Connecting-IP": ip });
  if (client) headers.set("X-Quasi-Client", client);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  let payload;
  if (body !== undefined) { headers.set("Content-Type", "application/json"); payload = JSON.stringify(body); }
  const res = await handle(new Request(`https://quasi.test${path}`, { method, headers, body: payload }), e);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const PRICES = { base: { standard: 100, deep: 180, moveout: 250 }, perBedroom: 25 };

async function cleaner(e, email, ip) {
  const r = await call(e, "POST", "/auth/signup", { body: { email, password: "clean-pass-123" }, ip });
  assert.equal(r.status, 200);
  return r.json.token;
}

test("quote endpoints require sign-in", async () => {
  const e = env();
  for (const [m, p] of [["GET", "/quote/profile"], ["PUT", "/quote/profile"], ["GET", "/quotes"], ["POST", "/quotes"], ["DELETE", "/quotes/00000000-0000-0000-0000-000000000000"]]) {
    const r = await call(e, m, p, { body: m === "GET" || m === "DELETE" ? undefined : {} });
    assert.equal(r.status, 401, `${m} ${p}`);
  }
});

test("cleaner sets own prices; quote price is built server-side from the form", async () => {
  const e = env();
  const t = await cleaner(e, "ana@clean.test", "203.0.113.51");
  const none = await call(e, "POST", "/quotes", { token: t, body: { customerName: "Kim", cleanType: "deep", homeSize: "bed3" } });
  assert.equal(none.status, 409);
  const prof = await call(e, "PUT", "/quote/profile", { token: t, body: { businessName: "Ana's Sparkle Cleaning", prices: PRICES } });
  assert.equal(prof.status, 200);
  assert.equal(prof.json.profile.prices.base.deep, 18000);
  const q = await call(e, "POST", "/quotes", { token: t, body: { customerName: "Kim", cleanType: "deep", homeSize: "bed3", totalCents: 1 } });
  assert.equal(q.status, 201);
  assert.equal(q.json.quote.totalCents, 18000 + 2 * 2500); // client total is ignored
  assert.equal(q.json.quote.businessName, "Ana's Sparkle Cleaning");
  assert.match(q.json.quote.shareToken, /^[A-Za-z0-9_-]{43}$/);
  const bad = await call(e, "POST", "/quotes", { token: t, body: { customerName: "Kim", cleanType: "windows", homeSize: "bed3" } });
  assert.equal(bad.status, 400);
  const badSize = await call(e, "POST", "/quotes", { token: t, body: { customerName: "Kim", cleanType: "standard", homeSize: "castle" } });
  assert.equal(badSize.status, 400);
  const neg = await call(e, "PUT", "/quote/profile", { token: t, body: { businessName: "X", prices: { base: { standard: -1, deep: 1, moveout: 1 }, perBedroom: 0 } } });
  assert.equal(neg.status, 400);
  // only needed columns are stored
  const cols = (await e.DB.prepare("SELECT name FROM pragma_table_info('quotes')").bind().all()).results.map((r) => r.name);
  assert.deepEqual(cols.sort(), ["business_name", "clean_type", "created_at", "customer_name", "home_size", "id", "share_token", "total_cents", "user_id"].sort());
});

test("two-account isolation: saved quotes, delete and profile are per account", async () => {
  const e = env();
  const a = await cleaner(e, "a@clean.test", "203.0.113.52");
  const b = await cleaner(e, "b@clean.test", "203.0.113.53");
  await call(e, "PUT", "/quote/profile", { token: a, body: { businessName: "A Clean", prices: PRICES } });
  const qa = await call(e, "POST", "/quotes", { token: a, body: { customerName: "Alice Customer", cleanType: "standard", homeSize: "studio" } });
  const listA = await call(e, "GET", "/quotes", { token: a });
  assert.equal(listA.json.quotes.length, 1);
  const listB = await call(e, "GET", "/quotes", { token: b });
  assert.equal(listB.json.quotes.length, 0);
  const profB = await call(e, "GET", "/quote/profile", { token: b });
  assert.equal(profB.json.profile, null);
  const steal = await call(e, "DELETE", `/quotes/${qa.json.quote.id}`, { token: b });
  assert.equal(steal.status, 404);
  assert.equal((await call(e, "GET", "/quotes", { token: a })).json.quotes.length, 1);
  const own = await call(e, "DELETE", `/quotes/${qa.json.quote.id}`, { token: a });
  assert.equal(own.status, 200);
  assert.equal((await call(e, "GET", "/quotes", { token: a })).json.quotes.length, 0);
});

test("share link shows only that quote, no account details, and needs the exact token", async () => {
  const e = env();
  const a = await cleaner(e, "s@clean.test", "203.0.113.54");
  await call(e, "PUT", "/quote/profile", { token: a, body: { businessName: "Shiny Homes", prices: PRICES } });
  const q = await call(e, "POST", "/quotes", { token: a, body: { customerName: "Dee", cleanType: "moveout", homeSize: "bed5" } });
  const pub = await call(e, "GET", `/q/${q.json.quote.shareToken}`, { client: null });
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.json.quote).sort(), ["businessName", "cleanType", "cleanTypeLabel", "createdAt", "customerName", "homeSize", "homeSizeLabel", "totalCents"].sort());
  assert.equal(pub.json.quote.totalCents, 25000 + 4 * 2500);
  assert.ok(!JSON.stringify(pub.json).includes("s@clean.test"));
  const wrong = await call(e, "GET", `/q/${"x".repeat(43)}`, { client: null });
  assert.equal(wrong.status, 404);
  const short = await call(e, "GET", "/q/abc", { client: null });
  assert.equal(short.status, 404);
});

test("billing still off", async () => {
  const r = await call(env(), "POST", "/billing/checkout", { body: {} });
  assert.equal(r.status, 503);
});
