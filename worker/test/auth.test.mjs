import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { createTestDb } from "./d1.js";

const ORIGIN = "https://quasihydra.lalaayenglobalplaza.com";

function envWith(overrides = {}) {
  return {
    DB: createTestDb(),
    BILLING_MODE: "off",
    ALLOWED_ORIGINS: `${ORIGIN},https://www.quasihydra.lalaayenglobalplaza.com`,
    PBKDF2_ITERATIONS: "1000",
    ...overrides,
  };
}

async function call(env, method, path, { body, token, origin = ORIGIN, cookie, client = "1", ip = "203.0.113.10" } = {}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  if (client != null) headers.set("X-Quasi-Client", client);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (cookie) headers.set("Cookie", cookie);
  headers.set("CF-Connecting-IP", ip);
  let payload;
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await handle(new Request(`https://quasi-business-auth.test${path}`, { method, headers, body: payload }), env);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json, headers: response.headers };
}

test("health and billing stay off", async () => {
  const env = envWith();
  const health = await call(env, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.billing, "off");
  assert.equal(health.json.service, "quasi-business-auth");

  const billing = await call(env, "POST", "/billing/checkout", { body: { plan: "pro" } });
  assert.equal(billing.status, 503);
  assert.equal(billing.json.billing, "off");

  const forced = await call(envWith({ BILLING_MODE: "on" }), "POST", "/billing/subscribe", { body: {} });
  assert.equal(forced.status, 503);
  assert.equal(forced.json.error, "Billing is not activated.");
});

test("signup, me, logout, and password storage", async () => {
  const env = envWith();
  const created = await call(env, "POST", "/auth/signup", { body: { email: "Ara@Example.com", password: "studio-pass-1" } });
  assert.equal(created.status, 200);
  assert.equal(created.json.user.email, "ara@example.com");
  assert.equal(created.json.user.planStatus, "not_activated");
  assert.equal(created.json.user.planLabel, "none");
  assert.deepEqual(created.json.user.plans.map((plan) => plan.status), ["not_activated", "not_activated", "not_activated"]);
  assert.ok(created.json.token);
  assert.match(created.headers.get("set-cookie"), /quasi_session=/);
  assert.match(created.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(created.headers.get("set-cookie"), /Secure/);
  assert.match(created.headers.get("set-cookie"), /SameSite=None/i);
  assert.doesNotMatch(created.headers.get("set-cookie"), /Domain=/i);

  const row = await env.DB.prepare("SELECT password_hash, password_salt FROM users WHERE email = ?").bind("ara@example.com").first();
  assert.notEqual(row.password_hash, "studio-pass-1");
  assert.ok(row.password_salt);

  const me = await call(env, "GET", "/auth/me", { token: created.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.email, "ara@example.com");
  assert.equal(me.json.token, undefined);

  const duplicate = await call(env, "POST", "/auth/signup", { body: { email: "ara@example.com", password: "studio-pass-1" } });
  assert.equal(duplicate.status, 409);

  const loggedOut = await call(env, "POST", "/auth/logout", { token: created.json.token, body: {} });
  assert.equal(loggedOut.status, 200);
  assert.match(loggedOut.headers.get("set-cookie"), /Max-Age=0/);
  const after = await call(env, "GET", "/auth/me", { token: created.json.token });
  assert.equal(after.status, 401);
});

test("login rejects unknown and wrong passwords the same way, then accepts the right one", async () => {
  const env = envWith();
  await call(env, "POST", "/auth/signup", { body: { email: "owner@quasi.test", password: "studio-pass-1" } });
  const missing = await call(env, "POST", "/auth/login", { body: { email: "missing@quasi.test", password: "studio-pass-1" } });
  const wrong = await call(env, "POST", "/auth/login", { body: { email: "owner@quasi.test", password: "not-the-password" } });
  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(missing.json.error, wrong.json.error);

  const ok = await call(env, "POST", "/auth/login", { body: { email: "owner@quasi.test", password: "studio-pass-1" } });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get("set-cookie").split(";")[0];
  const viaCookie = await call(env, "GET", "/auth/me", { cookie, token: "" });
  assert.equal(viaCookie.status, 200);
  const csrf = await call(env, "POST", "/auth/logout", { cookie, token: "", client: null, body: {} });
  assert.equal(csrf.status, 403);
});

test("login and signup are rate limited", async () => {
  const env = envWith();
  await call(env, "POST", "/auth/signup", { body: { email: "limit@quasi.test", password: "studio-pass-1" }, ip: "203.0.113.20" });
  for (let i = 0; i < 8; i++) {
    const attempt = await call(env, "POST", "/auth/login", { body: { email: "limit@quasi.test", password: "wrong-password" }, ip: "203.0.113.20" });
    assert.equal(attempt.status, 401);
  }
  const locked = await call(env, "POST", "/auth/login", { body: { email: "limit@quasi.test", password: "studio-pass-1" }, ip: "203.0.113.20" });
  assert.equal(locked.status, 429);

  const fresh = envWith();
  for (let i = 0; i < 5; i++) {
    const attempt = await call(fresh, "POST", "/auth/signup", { body: { email: `person${i}@quasi.test`, password: "studio-pass-1" }, ip: "203.0.113.30" });
    assert.equal(attempt.status, 200);
  }
  const blocked = await call(fresh, "POST", "/auth/signup", { body: { email: "person6@quasi.test", password: "studio-pass-1" }, ip: "203.0.113.30" });
  assert.equal(blocked.status, 429);
});

test("projects and library stay private to the signed-in user", async () => {
  const env = envWith();
  const ada = await call(env, "POST", "/auth/signup", { body: { email: "ada@quasi.test", password: "studio-pass-1" }, ip: "203.0.113.40" });
  const bo = await call(env, "POST", "/auth/signup", { body: { email: "bo@quasi.test", password: "studio-pass-1" }, ip: "203.0.113.41" });
  const saved = await call(env, "PUT", "/library", {
    token: ada.json.token,
    body: { brief: { brand: "QUASI", offer: "hooks" }, hooks: [{ text: "Stop scrolling.", category: "Direct Offer" }] },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.project.kind, "library");
  assert.equal(saved.json.project.hooks[0].text, "Stop scrolling.");

  const again = await call(env, "PUT", "/library", {
    token: ada.json.token,
    body: { brief: { brand: "QUASI" }, hooks: [{ text: "A second favorite" }] },
  });
  assert.equal(again.json.project.id, saved.json.project.id);
  const libraries = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE kind = 'library'").bind().first();
  assert.equal(Number(libraries.n), 1);

  const created = await call(env, "POST", "/projects", {
    token: ada.json.token,
    body: { title: "Launch brief", brief: { offer: "a song" }, hooks: [{ text: "Meet the song.", review: { value: 80, why: ["Direct"], issues: [] } }] },
  });
  assert.equal(created.status, 201);
  const listed = await call(env, "GET", "/projects", { token: ada.json.token });
  assert.equal(listed.json.projects.length, 1);
  assert.equal(listed.json.projects[0].title, "Launch brief");

  const stolen = await call(env, "GET", `/projects/${created.json.project.id}`, { token: bo.json.token });
  assert.equal(stolen.status, 404);
  const boLibrary = await call(env, "GET", "/library", { token: bo.json.token });
  assert.equal(boLibrary.json.project, null);

  const removed = await call(env, "DELETE", `/projects/${created.json.project.id}`, { token: ada.json.token });
  assert.equal(removed.status, 200);
  const after = await call(env, "GET", `/projects/${created.json.project.id}`, { token: ada.json.token });
  assert.equal(after.status, 404);
});

test("cors allowlist is only the QUASI site", async () => {
  const env = envWith();
  const good = await call(env, "GET", "/health", { origin: ORIGIN });
  assert.equal(good.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(good.headers.get("access-control-allow-credentials"), "true");

  const www = await call(env, "OPTIONS", "/auth/login", { origin: "https://www.quasihydra.lalaayenglobalplaza.com" });
  assert.equal(www.status, 204);
  assert.equal(www.headers.get("access-control-allow-origin"), "https://www.quasihydra.lalaayenglobalplaza.com");

  const evil = await call(env, "GET", "/health", { origin: "https://evil.example" });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);

  const shortPassword = await call(env, "POST", "/auth/signup", { body: { email: "short@quasi.test", password: "short" } });
  assert.equal(shortPassword.status, 400);
});
