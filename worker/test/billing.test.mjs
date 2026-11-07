import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { handle } from "../src/index.js";
import { createTestDb } from "./d1.js";
import { paypalPlanMatches, squarePlanMatches, verifySquareSignature } from "../src/billing.js";

const ORIGIN = "https://quasihydra.lalaayenglobalplaza.com";
const SQUARE_WEBHOOK_URL = "https://quasi-business-auth.test/billing/webhooks/square";
const SQUARE_KEY = "sandbox-square-signature-key";
const SQUARE_PLANS = {
  basic: "SQBASIC00000001",
  pro: "SQPRO0000000001",
  business: "SQBUSINESS000001",
};
const PAYPAL_PLANS = {
  basic: "P-111111111111111111111111",
  pro: "P-222222222222222222222222",
  business: "P-333333333333333333333333",
};
const PAYPAL_TOKEN = "paypal-test-token";
const SQUARE_TOKEN = "sandbox-square-access-token";

function secrets(mode) {
  const prefix = mode === "live" ? "LIVE" : "SANDBOX";
  const squareApp = mode === "live" ? "sq0idp-quasihydra0001" : "sandbox-sq0idb-quasihydra0001";
  return {
    [`SQUARE_${prefix}_ACCESS_TOKEN`]: SQUARE_TOKEN,
    [`SQUARE_${prefix}_APPLICATION_ID`]: squareApp,
    [`SQUARE_${prefix}_LOCATION_ID`]: "LQUASI01",
    [`SQUARE_${prefix}_WEBHOOK_SIGNATURE_KEY`]: SQUARE_KEY,
    [`SQUARE_${prefix}_WEBHOOK_URL`]: SQUARE_WEBHOOK_URL,
    [`SQUARE_${prefix}_PLAN_BASIC`]: SQUARE_PLANS.basic,
    [`SQUARE_${prefix}_PLAN_PRO`]: SQUARE_PLANS.pro,
    [`SQUARE_${prefix}_PLAN_BUSINESS`]: SQUARE_PLANS.business,
    [`PAYPAL_${prefix}_CLIENT_ID`]: "AbcdPayPalClientId0001",
    [`PAYPAL_${prefix}_CLIENT_SECRET`]: "paypal-client-secret-value",
    [`PAYPAL_${prefix}_WEBHOOK_ID`]: "WHQUASI0001",
    [`PAYPAL_${prefix}_PLAN_BASIC`]: PAYPAL_PLANS.basic,
    [`PAYPAL_${prefix}_PLAN_PRO`]: PAYPAL_PLANS.pro,
    [`PAYPAL_${prefix}_PLAN_BUSINESS`]: PAYPAL_PLANS.business,
  };
}

function envWith(overrides = {}) {
  return {
    DB: createTestDb(),
    BILLING_MODE: "off",
    ALLOWED_ORIGINS: `${ORIGIN},https://www.quasihydra.lalaayenglobalplaza.com`,
    PBKDF2_ITERATIONS: "1000",
    ...overrides,
  };
}

async function call(env, method, path, { body, token, origin = ORIGIN, headers = {}, raw } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set("Origin", origin);
  if (!requestHeaders.has("X-Quasi-Client")) requestHeaders.set("X-Quasi-Client", "1");
  if (token) requestHeaders.set("Authorization", `Bearer ${token}`);
  requestHeaders.set("CF-Connecting-IP", "203.0.113.50");
  let payload;
  if (raw !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
    payload = raw;
  } else if (body !== undefined) {
    requestHeaders.set("Content-Type", "application/json");
    payload = JSON.stringify(body);
  }
  const response = await handle(new Request(`https://quasi-business-auth.test${path}`, { method, headers: requestHeaders, body: payload }), env);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: response.status, json, text };
}

function useFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const entry = { url: String(url), method: init.method || "GET", body: init.body || "", headers: init.headers || {} };
    calls.push(entry);
    const result = await handler(entry);
    if ((result.status || 200) === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(result.body ?? {}), { status: result.status || 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

function squarePlan(amount) {
  return {
    object: {
      type: "SUBSCRIPTION_PLAN_VARIATION",
      subscription_plan_variation_data: {
        phases: [{ cadence: "MONTHLY", ordinal: 0, pricing: { type: "STATIC", price: { amount, currency: "USD" } } }],
      },
    },
  };
}

function paypalPlan(value) {
  return {
    id: PAYPAL_PLANS.pro,
    billing_cycles: [{
      tenure_type: "REGULAR",
      sequence: 1,
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: "USD", value } },
    }],
  };
}

function squareSignature(url, body, key = SQUARE_KEY) {
  return createHmac("sha256", key).update(url + body).digest("base64");
}

async function signup(env, email = "member@quasi.test") {
  const created = await call(env, "POST", "/auth/signup", { body: { email, password: "studio-pass-1" } });
  assert.equal(created.status, 200);
  return created.json;
}

test("square webhook signature matches the published test vector", async () => {
  const url = "https://example.com/webhook";
  const body = '{"hello":"world"}';
  const header = "2kRE5qRU2tR+tBGlDwMEw2avJ7QM4ikPYD/PJ3bd9Og=";
  assert.equal(await verifySquareSignature({
    rawBody: body,
    signatureHeader: header,
    signatureKey: "asdf1234",
    notificationUrl: url,
  }), true);
  assert.equal(await verifySquareSignature({
    rawBody: body,
    signatureHeader: squareSignature(url, body, "asdf1234"),
    signatureKey: "asdf1234",
    notificationUrl: url,
  }), true);
  assert.equal(await verifySquareSignature({
    rawBody: body,
    signatureHeader: header,
    signatureKey: "wrong-key",
    notificationUrl: url,
  }), false);
  const left = Buffer.from(header);
  const right = Buffer.from(squareSignature(url, body, "asdf1234"));
  assert.equal(timingSafeEqual(left, right), true);
});

test("published monthly prices are the only accepted plan prices", () => {
  assert.equal(squarePlanMatches(squarePlan(1900), { amountCents: 1900 }), true);
  assert.equal(squarePlanMatches(squarePlan(100), { amountCents: 1900 }), false);
  assert.equal(squarePlanMatches({
    object: {
      type: "SUBSCRIPTION_PLAN_VARIATION",
      subscription_plan_variation_data: {
        phases: [{ cadence: "MONTHLY", ordinal: 0, pricing: { type: "RELATIVE" } }],
      },
    },
  }, { amountCents: 1900 }), false);
  assert.equal(paypalPlanMatches(paypalPlan("49.00"), { amountCents: 4900 }), true);
  assert.equal(paypalPlanMatches(paypalPlan("49"), { amountCents: 4900 }), true);
  assert.equal(paypalPlanMatches(paypalPlan("1.00"), { amountCents: 4900 }), false);
  assert.equal(paypalPlanMatches({
    billing_cycles: [{
      tenure_type: "REGULAR",
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: "USD", value: "49.00" } },
    }],
    payment_preferences: { setup_fee: { currency_code: "USD", value: "10.00" } },
  }, { amountCents: 4900 }), false);
});

test("billing stays off for every non sandbox and non live mode", async () => {
  const env = envWith();
  const health = await call(env, "GET", "/health");
  assert.equal(health.json.billing, "off");
  for (const mode of ["off", "on", "true", "production"]) {
    const response = await call(envWith({ BILLING_MODE: mode }), "POST", "/billing/subscribe", { body: { tier: "pro", provider: "paypal" } });
    assert.equal(response.status, 503);
    assert.equal(response.json.error, "Billing is not activated.");
    assert.equal(response.json.billing, "off");
  }
  const webhook = await call(env, "POST", "/billing/webhooks/square", { raw: "{}" });
  assert.equal(webhook.status, 503);
});

test("an active membership does not grant access while billing is off", async () => {
  const env = envWith();
  const account = await signup(env);
  assert.equal(account.user.planStatus, "not_activated");
  assert.equal(account.user.access, undefined);
  const stamp = new Date().toISOString();
  await env.DB.prepare("INSERT INTO subscriptions (id, user_id, provider, mode, tier, status, amount_cents, currency, provider_subscription_id, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, 'square', 'sandbox', 'business', 'active', 14900, 'USD', 'sub-seeded', 0, ?, ?)").bind(crypto.randomUUID(), account.user.id, stamp, stamp).run();
  const hidden = await call(env, "GET", "/auth/me", { token: account.token });
  assert.equal(hidden.json.user.planLabel, "none");
  assert.equal(hidden.json.user.planStatus, "not_activated");
  assert.equal(hidden.json.user.access, undefined);

  env.BILLING_MODE = "sandbox";
  const shown = await call(env, "GET", "/auth/me", { token: account.token });
  assert.equal(shown.json.user.planLabel, "Business");
  assert.equal(shown.json.user.planStatus, "active");
  assert.deepEqual(shown.json.user.access.entitlements, ["basic", "pro", "business"]);
});

test("square signup, subscribe, access, and cancel", async () => {
  const env = envWith({ BILLING_MODE: "sandbox", ...secrets("sandbox") });
  const account = await signup(env, "square@quasi.test");
  assert.equal(account.user.planStatus, "not_activated");
  const plans = await call(env, "GET", "/billing/plans");
  assert.equal(plans.status, 200);
  assert.deepEqual(plans.json.plans.map((plan) => [plan.id, plan.amountCents, plan.price]), [
    ["basic", 1900, "$19/mo"],
    ["pro", 4900, "$49/mo"],
    ["business", 14900, "$149/mo"],
  ]);
  assert.equal(JSON.stringify(plans.json).includes(SQUARE_TOKEN), false);

  const fetchMock = useFetch(async ({ url, method }) => {
    assert.equal(url.startsWith("https://connect.squareupsandbox.com"), true);
    assert.equal(url.includes("connect.squareup.com"), false);
    if (url.includes("/v2/catalog/object/")) return { body: squarePlan(4900) };
    if (url.endsWith("/v2/customers") && method === "POST") return { body: { customer: { id: "CUST1" } } };
    if (url.endsWith("/v2/cards")) return { body: { card: { id: "ccof:card1" } } };
    if (url.endsWith("/v2/subscriptions") && method === "POST") {
      return { body: { subscription: { id: "sub_square_1", status: "ACTIVE", plan_variation_id: SQUARE_PLANS.pro, customer_id: "CUST1" } } };
    }
    if (url.endsWith("/cancel")) {
      return { body: { subscription: { id: "sub_square_1", status: "ACTIVE", plan_variation_id: SQUARE_PLANS.pro, canceled_date: "2099-01-01", customer_id: "CUST1" } } };
    }
    throw new Error(`unexpected square call ${method} ${url}`);
  });
  try {
    const subscribed = await call(env, "POST", "/billing/subscribe", {
      token: account.token,
      body: { tier: "pro", provider: "square", sourceId: "cnon:sandbox-token-ok", amountCents: 100 },
    });
    assert.equal(subscribed.status, 200);
    assert.equal(subscribed.json.subscription.amountCents, 4900);
    assert.equal(subscribed.json.subscription.status, "active");
    assert.equal(subscribed.json.access.tier, "pro");
    assert.deepEqual(subscribed.json.access.entitlements, ["basic", "pro"]);
    assert.equal(JSON.stringify(subscribed.json).includes("cnon:sandbox-token-ok"), false);
    const callsBeforeSecond = fetchMock.calls.length;
    const again = await call(env, "POST", "/billing/subscribe", {
      token: account.token,
      body: { tier: "business", provider: "square", sourceId: "cnon:sandbox-token-ok" },
    });
    assert.equal(again.status, 409);
    assert.equal(fetchMock.calls.length, callsBeforeSecond);

    const me = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(me.json.user.planLabel, "Pro");
    assert.equal(me.json.user.planStatus, "active");
    assert.equal(me.json.user.plans.find((plan) => plan.id === "basic").status, "included");
    assert.equal(me.json.user.plans.find((plan) => plan.id === "business").status, "not_activated");

    const status = await call(env, "GET", "/billing/status", { token: account.token });
    assert.equal(status.json.subscription.provider, "square");
    assert.equal(status.json.access.active, true);

    const canceled = await call(env, "POST", "/billing/cancel", { token: account.token, body: {} });
    assert.equal(canceled.status, 200);
    assert.equal(canceled.json.subscription.cancelAtPeriodEnd, true);
    assert.equal(canceled.json.access.tier, "pro");
    const during = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(during.json.user.planStatus, "cancel_scheduled");
    assert.equal(during.json.user.access.active, true);
  } finally {
    fetchMock.restore();
  }

  const endedBody = JSON.stringify({
    event_id: "evt-square-canceled-0001",
    type: "subscription.updated",
    data: { object: { subscription: { id: "sub_square_1", status: "CANCELED", plan_variation_id: SQUARE_PLANS.pro, customer_id: "CUST1" } } },
  });
  const ended = await call(env, "POST", "/billing/webhooks/square", {
    raw: endedBody,
    headers: { "x-square-hmacsha256-signature": squareSignature(SQUARE_WEBHOOK_URL, endedBody) },
  });
  assert.equal(ended.status, 200);
  const after = await call(env, "GET", "/auth/me", { token: account.token });
  assert.equal(after.json.user.planStatus, "not_activated");
  assert.equal(after.json.user.access.active, false);
  const replay = await call(env, "POST", "/billing/webhooks/square", {
    raw: endedBody,
    headers: { "x-square-hmacsha256-signature": squareSignature(SQUARE_WEBHOOK_URL, endedBody) },
  });
  assert.equal(replay.json.duplicate, true);
  const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE provider = 'square'").bind().first();
  assert.equal(Number(events.n), 1);
});

test("square rejects a bad signature, a raw card number, and a mismatched plan price", async () => {
  const env = envWith({ BILLING_MODE: "sandbox", ...secrets("sandbox") });
  const account = await signup(env, "guard@quasi.test");
  let fetches = 0;
  const fetchMock = useFetch(async ({ url }) => {
    fetches += 1;
    if (url.includes("/v2/catalog/object/")) return { body: squarePlan(100) };
    if (url.endsWith("/v2/cards") || url.endsWith("/v2/subscriptions")) throw new Error("charge path was reached");
    if (url.endsWith("/v2/customers")) return { body: { customer: { id: "CUST2" } } };
    throw new Error(`unexpected ${url}`);
  });
  try {
    const card = await call(env, "POST", "/billing/subscribe", {
      token: account.token,
      body: { tier: "basic", provider: "square", sourceId: "4242424242424242" },
    });
    assert.equal(card.status, 400);
    assert.equal(fetches, 0);
    const mismatch = await call(env, "POST", "/billing/subscribe", {
      token: account.token,
      body: { tier: "basic", provider: "square", sourceId: "cnon:sandbox-token-ok" },
    });
    assert.equal(mismatch.status, 409);
    assert.match(mismatch.json.error, /Nothing was charged/);
    assert.equal(fetchMock.calls.some((entry) => entry.url.endsWith("/v2/cards")), false);
  } finally {
    fetchMock.restore();
  }
  const me = await call(env, "GET", "/auth/me", { token: account.token });
  assert.equal(me.json.user.planStatus, "not_activated");
  const raw = JSON.stringify({
    event_id: "evt-square-forged-0001",
    type: "subscription.updated",
    data: { object: { subscription: { id: "sub-forged", status: "ACTIVE", plan_variation_id: SQUARE_PLANS.business } } },
  });
  const forged = await call(env, "POST", "/billing/webhooks/square", {
    raw,
    headers: { "x-square-hmacsha256-signature": squareSignature(SQUARE_WEBHOOK_URL, raw, "other-key") },
  });
  assert.equal(forged.status, 403);
  const still = await call(env, "GET", "/auth/me", { token: account.token });
  assert.equal(still.json.user.access.active, false);
});

test("paypal signup, subscribe, access, and cancel", async () => {
  const env = envWith({ BILLING_MODE: "sandbox", ...secrets("sandbox") });
  const account = await signup(env, "paypal@quasi.test");
  const fetchMock = useFetch(async ({ url, method, headers, body }) => {
    assert.equal(url.startsWith("https://api-m.sandbox.paypal.com"), true);
    assert.equal(url.includes("api-m.paypal.com"), false);
    if (url.endsWith("/v1/oauth2/token")) return { body: { access_token: PAYPAL_TOKEN, expires_in: 3000 } };
    if (url.includes("/v1/billing/plans/")) return { body: paypalPlan("49.00") };
    if (url.endsWith("/v1/billing/subscriptions") && method === "POST") {
      const payload = JSON.parse(body);
      assert.equal(payload.plan_id, PAYPAL_PLANS.pro);
      assert.equal(payload.custom_id, account.user.id);
      assert.equal(payload.application_context.return_url, `${ORIGIN}/?billing=paypal-return`);
      return { body: { id: "I-PAYPALSUB0001", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-TEST" }] } };
    }
    if (url.endsWith("/v1/notifications/verify-webhook-signature")) {
      assert.equal(headers.Authorization, `Bearer ${PAYPAL_TOKEN}`);
      const payload = JSON.parse(body);
      const ok = payload.webhook_id === "WHQUASI0001" && payload.transmission_sig === "good-sig" && payload.cert_url.startsWith("https://api.sandbox.paypal.com/");
      return { body: { verification_status: ok ? "SUCCESS" : "FAILURE" } };
    }
    if (url.endsWith("/cancel")) return { status: 204 };
    throw new Error(`unexpected paypal call ${method} ${url}`);
  });
  try {
    const subscribed = await call(env, "POST", "/billing/subscribe", {
      token: account.token,
      body: { tier: "pro", provider: "paypal", amountCents: 100 },
    });
    assert.equal(subscribed.status, 200);
    assert.equal(subscribed.json.subscription.status, "pending");
    assert.equal(subscribed.json.subscription.amountCents, 4900);
    assert.equal(subscribed.json.access.active, false);
    assert.match(subscribed.json.approvalUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
    const pending = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(pending.json.user.planStatus, "not_activated");

    const forged = await call(env, "POST", "/billing/webhooks/paypal", {
      raw: JSON.stringify({
        id: "WH-FORGED-0001",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: { id: "I-PAYPALSUB0001", plan_id: PAYPAL_PLANS.business, status: "ACTIVE", custom_id: account.user.id },
      }),
      headers: paypalHeaders("bad-sig"),
    });
    assert.equal(forged.status, 403);
    const stillPending = await call(env, "GET", "/billing/status", { token: account.token });
    assert.equal(stillPending.json.access.active, false);

    const activated = await call(env, "POST", "/billing/webhooks/paypal", {
      raw: JSON.stringify({
        id: "WH-ACTIVE-0001",
        event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
        resource: {
          id: "I-PAYPALSUB0001",
          plan_id: PAYPAL_PLANS.pro,
          status: "ACTIVE",
          custom_id: account.user.id,
          billing_info: { next_billing_time: "2026-12-07T00:00:00Z" },
        },
      }),
      headers: paypalHeaders("good-sig"),
    });
    assert.equal(activated.status, 200);
    const access = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(access.json.user.planLabel, "Pro");
    assert.equal(access.json.user.access.active, true);
    assert.deepEqual(access.json.user.access.entitlements, ["basic", "pro"]);

    const unknownPlan = await call(env, "POST", "/billing/webhooks/paypal", {
      raw: JSON.stringify({
        id: "WH-UNKNOWN-0001",
        event_type: "BILLING.SUBSCRIPTION.UPDATED",
        resource: { id: "I-PAYPALSUB0001", plan_id: "P-999999999999999999999999", status: "ACTIVE", custom_id: account.user.id },
      }),
      headers: paypalHeaders("good-sig"),
    });
    assert.equal(unknownPlan.status, 200);
    const reviewed = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(reviewed.json.user.access.active, false);

    await env.DB.prepare("UPDATE subscriptions SET status = 'active', tier = 'pro', amount_cents = 4900 WHERE provider_subscription_id = ?").bind("I-PAYPALSUB0001").run();
    await env.DB.prepare("UPDATE users SET plan_label = 'Pro', plan_status = 'active' WHERE id = ?").bind(account.user.id).run();
    const restored = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(restored.json.user.access.tier, "pro");

    const canceled = await call(env, "POST", "/billing/cancel", { token: account.token, body: {} });
    assert.equal(canceled.status, 200);
    assert.equal(canceled.json.subscription.status, "canceled");
    assert.equal(canceled.json.access.active, false);
    const done = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(done.json.user.planStatus, "not_activated");
    assert.equal(done.json.user.planLabel, "none");
  } finally {
    fetchMock.restore();
  }
});

test("paypal confirm grants access only after PayPal reports the subscription active", async () => {
  const env = envWith({ BILLING_MODE: "sandbox", ...secrets("sandbox") });
  const account = await signup(env, "confirm@quasi.test");
  const fetchMock = useFetch(async ({ url, method }) => {
    if (url.endsWith("/v1/oauth2/token")) return { body: { access_token: PAYPAL_TOKEN } };
    if (url.includes("/v1/billing/plans/")) return { body: { ...paypalPlan("19.00"), id: PAYPAL_PLANS.basic } };
    if (url.endsWith("/v1/billing/subscriptions") && method === "POST") {
      return { body: { id: "I-CONFIRM0000001", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/billing/subscribe?ba_token=BA-CONFIRM" }] } };
    }
    if (url.endsWith("/v1/billing/subscriptions/I-CONFIRM0000001")) {
      return { body: { id: "I-CONFIRM0000001", plan_id: PAYPAL_PLANS.basic, status: "ACTIVE", custom_id: account.user.id } };
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  try {
    const subscribed = await call(env, "POST", "/billing/subscribe", { token: account.token, body: { tier: "basic", provider: "paypal" } });
    assert.equal(subscribed.json.access.active, false);
    const confirmed = await call(env, "POST", "/billing/confirm", {
      token: account.token,
      body: { provider: "paypal", subscriptionId: "I-CONFIRM0000001" },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.json.access.tier, "basic");
    assert.deepEqual(confirmed.json.access.entitlements, ["basic"]);
    const me = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(me.json.user.planLabel, "Basic");
    assert.equal(me.json.user.plans.find((plan) => plan.id === "pro").status, "not_activated");
  } finally {
    fetchMock.restore();
  }
});

test("live mode uses live hosts and sandbox approval links are refused", async () => {
  const env = envWith({ BILLING_MODE: "live", ...secrets("live") });
  const account = await signup(env, "live@quasi.test");
  const fetchMock = useFetch(async ({ url, method }) => {
    assert.equal(url.startsWith("https://api-m.paypal.com"), true);
    if (url.endsWith("/v1/oauth2/token")) return { body: { access_token: PAYPAL_TOKEN } };
    if (url.includes("/v1/billing/plans/")) return { body: { ...paypalPlan("149.00"), id: PAYPAL_PLANS.business } };
    if (method === "POST") {
      return { body: { id: "I-LIVE0000000001", status: "APPROVAL_PENDING", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/billing/subscribe?ba_token=BA-LIVE" }] } };
    }
    throw new Error(`unexpected ${url}`);
  });
  try {
    const refused = await call(env, "POST", "/billing/subscribe", { token: account.token, body: { tier: "business", provider: "paypal" } });
    assert.equal(refused.status, 502);
    const me = await call(env, "GET", "/auth/me", { token: account.token });
    assert.equal(me.json.user.access.active, false);
    assert.equal(fetchMock.calls.every((entry) => entry.url.startsWith("https://api-m.paypal.com")), true);
  } finally {
    fetchMock.restore();
  }
});

test("sandbox billing without secrets does not call a provider", async () => {
  const env = envWith({ BILLING_MODE: "sandbox" });
  const account = await signup(env, "unconfigured@quasi.test");
  const fetchMock = useFetch(async () => {
    throw new Error("provider was called");
  });
  try {
    const plans = await call(env, "GET", "/billing/plans");
    assert.equal(plans.status, 503);
    assert.equal(plans.json.error, "Billing is not configured.");
    const subscribed = await call(env, "POST", "/billing/subscribe", { token: account.token, body: { tier: "basic", provider: "square", sourceId: "cnon:sandbox-token-ok" } });
    assert.equal(subscribed.status, 503);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

test("subscribe attempts are rate limited before a provider call", async () => {
  const env = envWith({ BILLING_MODE: "sandbox", ...secrets("sandbox") });
  const account = await signup(env, "limit-billing@quasi.test");
  const fetchMock = useFetch(async () => {
    throw new Error("provider was called");
  });
  try {
    for (let i = 0; i < 8; i++) {
      const attempt = await call(env, "POST", "/billing/subscribe", { token: account.token, body: { tier: "basic", provider: "square", sourceId: "not-a-token" } });
      assert.equal(attempt.status, 400);
    }
    const locked = await call(env, "POST", "/billing/subscribe", { token: account.token, body: { tier: "basic", provider: "square", sourceId: "cnon:sandbox-token-ok" } });
    assert.equal(locked.status, 429);
    assert.equal(fetchMock.calls.length, 0);
  } finally {
    fetchMock.restore();
  }
});

function paypalHeaders(signature) {
  return {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-TEST",
    "paypal-transmission-id": "transmission-0001",
    "paypal-transmission-sig": signature,
    "paypal-transmission-time": "2026-11-07T00:00:00Z",
  };
}
