// Membership billing for QUASI. Inactive unless BILLING_MODE is sandbox or live.
// Credentials are Cloudflare Secrets named below. This file has no secret values.

const SQUARE_VERSION = "2026-09-16";
const WEBHOOK_MAX = 262_144;
const SUBSCRIBE_LIMIT = 8;
const SUBSCRIBE_WINDOW_MS = 60 * 60 * 1000;

const HOSTS = {
  sandbox: {
    square: "https://connect.squareupsandbox.com",
    paypal: "https://api-m.sandbox.paypal.com",
  },
  live: {
    square: "https://connect.squareup.com",
    paypal: "https://api-m.paypal.com",
  },
};

export const TIERS = [
  { id: "basic", name: "Basic", rank: 1, amountCents: 1900, price: "$19/mo" },
  { id: "pro", name: "Pro", rank: 2, amountCents: 4900, price: "$49/mo" },
  { id: "business", name: "Business", rank: 3, amountCents: 14900, price: "$149/mo" },
];

const TIER_BY_ID = Object.fromEntries(TIERS.map((tier) => [tier.id, tier]));

const SQUARE_LEAVES = [
  "ACCESS_TOKEN",
  "APPLICATION_ID",
  "LOCATION_ID",
  "WEBHOOK_SIGNATURE_KEY",
  "WEBHOOK_URL",
  "PLAN_BASIC",
  "PLAN_PRO",
  "PLAN_BUSINESS",
];

const PAYPAL_LEAVES = [
  "CLIENT_ID",
  "CLIENT_SECRET",
  "WEBHOOK_ID",
  "PLAN_BASIC",
  "PLAN_PRO",
  "PLAN_BUSINESS",
];

export const SECRET_NAMES = [
  ...SQUARE_LEAVES.map((leaf) => `SQUARE_SANDBOX_${leaf}`),
  ...SQUARE_LEAVES.map((leaf) => `SQUARE_LIVE_${leaf}`),
  ...PAYPAL_LEAVES.map((leaf) => `PAYPAL_SANDBOX_${leaf}`),
  ...PAYPAL_LEAVES.map((leaf) => `PAYPAL_LIVE_${leaf}`),
];

const OPEN_STATUSES = ["pending", "active", "past_due", "suspended"];

export function billingMode(env) {
  const mode = String(env && env.BILLING_MODE || "").trim().toLowerCase();
  return mode === "sandbox" || mode === "live" ? mode : "off";
}

export function emptyAccess() {
  return { tier: "none", rank: 0, active: false, cancelAtPeriodEnd: false, entitlements: [] };
}

export async function accountBilling(env, userId) {
  const mode = billingMode(env);
  if (mode === "off") return null;
  let row = null;
  try {
    row = await latestOpen(env, userId, mode);
  } catch (error) {
    if (isMissingTable(error)) {
      return { ready: false, planLabel: "none", planStatus: "not_activated", plans: planViews(emptyAccess(), false), access: emptyAccess() };
    }
    throw error;
  }
  const access = accessFromRow(row);
  return {
    ready: true,
    planLabel: access.active ? TIER_BY_ID[access.tier].name : "none",
    planStatus: access.active ? (access.cancelAtPeriodEnd ? "cancel_scheduled" : "active") : "not_activated",
    plans: planViews(access, access.cancelAtPeriodEnd),
    access,
  };
}

export async function handleBilling(request, env, path, deps) {
  try {
    if (request.method === "GET" && path === "/billing/plans") return plans(env);
    if (request.method === "GET" && path === "/billing/status") return status(request, env, deps);
    if (request.method === "POST" && path === "/billing/subscribe") return subscribe(request, env, deps);
    if (request.method === "POST" && path === "/billing/cancel") return cancel(request, env, deps);
    if (request.method === "POST" && path === "/billing/confirm") return confirm(request, env, deps);
    if (request.method === "POST" && path === "/billing/webhooks/square") return squareWebhook(request, env);
    if (request.method === "POST" && path === "/billing/webhooks/paypal") return paypalWebhook(request, env);
    return jsonBody(404, { error: "Not found" });
  } catch (error) {
    if (isMissingTable(error)) return jsonBody(503, { error: "Billing storage is not ready.", billing: billingMode(env) });
    throw error;
  }
}

export async function verifySquareSignature({ rawBody, signatureHeader, signatureKey, notificationUrl }) {
  if (!signatureHeader || !signatureKey || !notificationUrl) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signatureKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(notificationUrl + rawBody)));
  let provided;
  try {
    provided = base64ToBytes(String(signatureHeader).trim());
  } catch {
    return false;
  }
  if (provided.length !== mac.length) return false;
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    try {
      return crypto.subtle.timingSafeEqual(mac, provided);
    } catch {
      /* compare below */
    }
  }
  let diff = 0;
  for (let i = 0; i < mac.length; i++) diff |= mac[i] ^ provided[i];
  return diff === 0;
}

export function squarePlanMatches(catalog, tier) {
  const object = catalog && catalog.object ? catalog.object : catalog;
  if (object && object.type && object.type !== "SUBSCRIPTION_PLAN_VARIATION") return false;
  const phases = object && object.subscription_plan_variation_data && object.subscription_plan_variation_data.phases;
  if (!Array.isArray(phases) || !phases.length) return false;
  const ordered = [...phases].sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0));
  const last = ordered[ordered.length - 1];
  if (last.cadence !== "MONTHLY") return false;
  if (last.periods != null && Number(last.periods) !== 0) return false;
  if (!phasePrice(last, tier.amountCents)) return false;
  return ordered.slice(0, -1).every((phase) => phase.cadence === "MONTHLY" && (phasePrice(phase, 0) || phasePrice(phase, tier.amountCents)));
}

export function paypalPlanMatches(plan, tier) {
  const cycles = plan && Array.isArray(plan.billing_cycles) ? plan.billing_cycles : [];
  const regular = cycles.filter((cycle) => cycle && cycle.tenure_type === "REGULAR");
  if (regular.length !== 1) return false;
  const cycle = regular[0];
  const interval = cycle.frequency || {};
  if (interval.interval_unit !== "MONTH" || Number(interval.interval_count || 1) !== 1) return false;
  if (Number(cycle.total_cycles) !== 0) return false;
  const price = cycle.pricing_scheme && cycle.pricing_scheme.fixed_price;
  if (!price || price.currency_code !== "USD" || !usdCents(price.value, tier.amountCents)) return false;
  for (const trial of cycles) {
    if (!trial || trial.tenure_type === "REGULAR") continue;
    if (trial.tenure_type !== "TRIAL") return false;
    const trialPrice = trial.pricing_scheme && trial.pricing_scheme.fixed_price;
    if (trialPrice && !usdCents(trialPrice.value, 0)) return false;
  }
  const setup = plan.payment_preferences && plan.payment_preferences.setup_fee;
  if (setup && !usdCents(setup.value, 0)) return false;
  const taxes = plan.taxes;
  if (taxes && taxes.inclusive === false && Number(taxes.percentage) > 0) return false;
  return true;
}

function plans(env) {
  const mode = billingMode(env);
  const providers = [];
  const body = { billing: mode, plans: planViews(emptyAccess(), false), providers };
  if (providerReady(env, mode, "square")) {
    providers.push("square");
    body.square = {
      applicationId: readSecret(env, squareSecret(mode, "APPLICATION_ID")),
      locationId: readSecret(env, squareSecret(mode, "LOCATION_ID")),
    };
  }
  if (providerReady(env, mode, "paypal")) providers.push("paypal");
  if (!providers.length) fail(503, "Billing is not configured.");
  return jsonBody(200, body);
}

async function status(request, env, deps) {
  const mode = billingMode(env);
  const user = await requireUser(request, env, deps, false);
  const row = await latestAny(env, user.id, mode);
  const access = accessFromRow(await latestOpen(env, user.id, mode));
  return jsonBody(200, { billing: mode, subscription: publicSubscription(row), access });
}

async function subscribe(request, env, deps) {
  const mode = billingMode(env);
  deps.requireClientHeader(request);
  const user = await requireUser(request, env, deps, false);
  await assertSubscribeAllowed(env, user.email);
  await recordSubscribe(env, user.email, request);
  const body = await readJson(request);
  const tier = TIER_BY_ID[String(body.tier || "").toLowerCase()];
  if (!tier) fail(400, "Choose Basic, Pro, or Business.");
  const provider = String(body.provider || "").toLowerCase();
  if (provider !== "square" && provider !== "paypal") fail(400, "Choose Square or PayPal.");
  if (!providerReady(env, mode, provider)) fail(503, "Billing is not configured.");
  const existing = await latestOpen(env, user.id, mode);
  if (existing) fail(409, "This account already has a membership. Cancel it before starting another.");

  const id = crypto.randomUUID();
  const stamp = nowIso();
  try {
    await env.DB.prepare("INSERT INTO subscriptions (id, user_id, provider, mode, tier, status, amount_cents, currency, cancel_at_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, 'USD', 0, ?, ?)").bind(id, user.id, provider, mode, tier.id, tier.amountCents, stamp, stamp).run();
  } catch (error) {
    if (isUnique(error)) fail(409, "This account already has a membership. Cancel it before starting another.");
    throw error;
  }

  let providerSubscriptionId = "";
  try {
    const result = provider === "square"
      ? await startSquare(env, mode, user, tier, body)
      : await startPaypal(env, mode, user, tier);
    providerSubscriptionId = result.providerSubscriptionId;
    if (provider === "paypal" && !result.approvalUrl) {
      await env.DB.prepare("UPDATE subscriptions SET provider_subscription_id = ?, status = 'pending', approval_url = NULL, updated_at = ? WHERE id = ?").bind(result.providerSubscriptionId, nowIso(), id).run();
      fail(502, "The payment provider could not complete that request.");
    }
    await env.DB.prepare("UPDATE subscriptions SET provider_customer_id = ?, provider_subscription_id = ?, approval_url = ?, status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ? WHERE id = ?").bind(
      result.providerCustomerId || null,
      result.providerSubscriptionId,
      result.approvalUrl || null,
      result.status,
      result.currentPeriodEnd || null,
      result.cancelAtPeriodEnd ? 1 : 0,
      nowIso(),
      id,
    ).run();
    await syncUserPlan(env, user.id, mode);
    const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first();
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "subscription created", userId: user.id, provider, tier: tier.id, mode, status: row.status }));
    return jsonBody(200, {
      billing: mode,
      subscription: publicSubscription(row),
      access: accessFromRow(row.status === "active" ? row : null),
      approvalUrl: row.approval_url || undefined,
    });
  } catch (error) {
    if (!providerSubscriptionId) await markFailed(env, id);
    else if (!(error && error.status)) console.error(JSON.stringify({ service: "quasi-business-auth", message: "provider subscription was created and the local row needs review", provider, providerSubscriptionId }));
    throw error;
  }
}

async function cancel(request, env, deps) {
  const mode = billingMode(env);
  deps.requireClientHeader(request);
  const user = await requireUser(request, env, deps, false);
  const row = await latestOpen(env, user.id, mode);
  if (!row) fail(404, "No membership to cancel.");
  if (!providerReady(env, mode, row.provider)) fail(503, "Billing is not configured.");
  if (row.provider_subscription_id) {
    if (row.provider === "square") await cancelSquare(env, mode, row);
    else await cancelPaypal(env, mode, row);
  } else {
    await env.DB.prepare("UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  }
  await syncUserPlan(env, user.id, mode);
  const updated = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(row.id).first();
  console.log(JSON.stringify({ service: "quasi-business-auth", message: "subscription cancel requested", userId: user.id, provider: row.provider, mode, status: updated.status }));
  return jsonBody(200, { billing: mode, subscription: publicSubscription(updated), access: accessFromRow(await latestOpen(env, user.id, mode)) });
}

async function confirm(request, env, deps) {
  const mode = billingMode(env);
  deps.requireClientHeader(request);
  const user = await requireUser(request, env, deps, false);
  const body = await readJson(request);
  if (String(body.provider || "").toLowerCase() !== "paypal") fail(400, "Choose PayPal.");
  const subscriptionId = String(body.subscriptionId || "");
  if (!/^I-[A-Z0-9]{4,40}$/.test(subscriptionId)) fail(400, "PayPal subscription id is not valid.");
  if (!providerReady(env, mode, "paypal")) fail(503, "Billing is not configured.");
  const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND provider = 'paypal' AND mode = ? AND provider_subscription_id = ?").bind(user.id, mode, subscriptionId).first();
  if (!row) fail(404, "No membership to confirm.");
  const remote = await paypalFetch(env, mode, "GET", `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`);
  await applyPaypalResource(env, row, remote);
  await syncUserPlan(env, user.id, mode);
  const updated = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(row.id).first();
  return jsonBody(200, { billing: mode, subscription: publicSubscription(updated), access: accessFromRow(await latestOpen(env, user.id, mode)) });
}

async function squareWebhook(request, env) {
  const mode = billingMode(env);
  if (!providerReady(env, mode, "square")) return jsonBody(503, { error: "Billing is not configured.", billing: mode });
  const rawBody = await rawText(request);
  const notificationUrl = readSecret(env, squareSecret(mode, "WEBHOOK_URL"));
  const valid = await verifySquareSignature({
    rawBody,
    signatureHeader: request.headers.get("x-square-hmacsha256-signature"),
    signatureKey: readSecret(env, squareSecret(mode, "WEBHOOK_SIGNATURE_KEY")),
    notificationUrl,
  });
  if (!valid) {
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "square webhook rejected" }));
    return jsonBody(403, { error: "Invalid webhook signature." });
  }
  const event = parseJson(rawBody);
  const eventId = String(event.event_id || "");
  const eventType = String(event.type || "");
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(eventId) || !eventType) fail(400, "Invalid webhook.");
  if (await seenEvent(env, "square", eventId)) return jsonBody(200, { ok: true, duplicate: true });
  if (eventType === "subscription.created" || eventType === "subscription.updated") {
    const subscription = event.data && event.data.object && event.data.object.subscription;
    if (!subscription || !subscription.id) fail(400, "Invalid webhook.");
    const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE provider = 'square' AND mode = ? AND provider_subscription_id = ?").bind(mode, String(subscription.id)).first();
    if (!row) {
      console.log(JSON.stringify({ service: "quasi-business-auth", message: "square webhook waiting for local subscription", eventType }));
      return jsonBody(503, { error: "Subscription is not ready." });
    }
    await applySquareSubscription(env, row, subscription);
    await syncUserPlan(env, row.user_id, mode);
  }
  await rememberEvent(env, "square", eventId, eventType);
  return jsonBody(200, { ok: true });
}

async function paypalWebhook(request, env) {
  const mode = billingMode(env);
  if (!providerReady(env, mode, "paypal")) return jsonBody(503, { error: "Billing is not configured.", billing: mode });
  const rawBody = await rawText(request);
  const event = parseJson(rawBody);
  const verified = await verifyPaypalSignature(env, mode, request, event);
  if (!verified) {
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "paypal webhook rejected" }));
    return jsonBody(403, { error: "Invalid webhook signature." });
  }
  const eventId = String(event.id || "");
  const eventType = String(event.event_type || "");
  if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(eventId) || !eventType) fail(400, "Invalid webhook.");
  if (await seenEvent(env, "paypal", eventId)) return jsonBody(200, { ok: true, duplicate: true });
  const resource = event.resource || {};
  const handled = eventType.startsWith("BILLING.SUBSCRIPTION.") || eventType === "PAYMENT.SALE.COMPLETED";
  if (handled) {
    const subscriptionId = paypalSubscriptionId(eventType, resource);
    if (!subscriptionId) fail(400, "Invalid webhook.");
    const row = await env.DB.prepare("SELECT * FROM subscriptions WHERE provider = 'paypal' AND mode = ? AND provider_subscription_id = ?").bind(mode, subscriptionId).first();
    if (!row) {
      console.log(JSON.stringify({ service: "quasi-business-auth", message: "paypal webhook waiting for local subscription", eventType }));
      return jsonBody(503, { error: "Subscription is not ready." });
    }
    if (eventType === "PAYMENT.SALE.COMPLETED") {
      if (row.status === "active" && resource.billing_agreement_id) {
        await touchRow(env, row.id, {});
      }
    } else {
      await applyPaypalResource(env, row, resource, eventType);
      await syncUserPlan(env, row.user_id, mode);
    }
  }
  await rememberEvent(env, "paypal", eventId, eventType);
  return jsonBody(200, { ok: true });
}

async function startSquare(env, mode, user, tier, body) {
  const sourceId = String(body.sourceId || "");
  if (/[0-9]{13,19}/.test(sourceId)) fail(400, "Send a Square card token, not a card number.");
  if (!/^cnon:[A-Za-z0-9_-]{8,180}$/.test(sourceId)) fail(400, "Square card token is not valid.");
  const planId = planIdFor(env, mode, "square", tier.id);
  const catalog = await squareFetch(env, mode, "GET", `/v2/catalog/object/${encodeURIComponent(planId)}`);
  if (!squarePlanMatches(catalog, tier)) {
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "square plan price mismatch", tier: tier.id, mode }));
    fail(409, "The membership plan price does not match the published price. Nothing was charged.");
  }
  const customerId = await squareCustomerId(env, mode, user);
  const card = await squareFetch(env, mode, "POST", "/v2/cards", {
    idempotency_key: crypto.randomUUID(),
    source_id: sourceId,
    card: { customer_id: customerId },
  });
  const cardId = card && card.card && card.card.id;
  if (!cardId) fail(502, "The payment provider could not complete that request.");
  const created = await squareFetch(env, mode, "POST", "/v2/subscriptions", {
    idempotency_key: crypto.randomUUID(),
    location_id: readSecret(env, squareSecret(mode, "LOCATION_ID")),
    plan_variation_id: planId,
    customer_id: customerId,
    card_id: cardId,
  });
  const subscription = created && created.subscription;
  if (!subscription || !subscription.id) fail(502, "The payment provider could not complete that request.");
  if (subscription.plan_variation_id && subscription.plan_variation_id !== planId) fail(502, "The payment provider could not complete that request.");
  const mapped = mapSquareStatus(subscription);
  return {
    providerCustomerId: customerId,
    providerSubscriptionId: String(subscription.id),
    status: mapped.status,
    currentPeriodEnd: mapped.currentPeriodEnd,
    cancelAtPeriodEnd: mapped.cancelAtPeriodEnd,
  };
}

async function startPaypal(env, mode, user, tier) {
  const planId = planIdFor(env, mode, "paypal", tier.id);
  const plan = await paypalFetch(env, mode, "GET", `/v1/billing/plans/${encodeURIComponent(planId)}`);
  if (!paypalPlanMatches(plan, tier)) {
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "paypal plan price mismatch", tier: tier.id, mode }));
    fail(409, "The membership plan price does not match the published price. Nothing was charged.");
  }
  const origin = siteOrigin(env);
  if (!origin) fail(503, "Billing is not configured.");
  const created = await paypalFetch(env, mode, "POST", "/v1/billing/subscriptions", {
    plan_id: planId,
    custom_id: user.id,
    application_context: {
      brand_name: "QUASI",
      locale: "en-US",
      shipping_preference: "NO_SHIPPING",
      user_action: "SUBSCRIBE_NOW",
      return_url: `${origin}/?billing=paypal-return`,
      cancel_url: `${origin}/?billing=paypal-cancel`,
    },
  });
  if (!created || !created.id) fail(502, "The payment provider could not complete that request.");
  return {
    providerSubscriptionId: String(created.id),
    approvalUrl: paypalApprovalUrl(mode, created.links),
    status: "pending",
    cancelAtPeriodEnd: false,
  };
}

async function cancelSquare(env, mode, row) {
  const payload = await squareFetch(env, mode, "POST", `/v2/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`, {});
  const subscription = payload && payload.subscription;
  if (!subscription) fail(502, "The payment provider could not complete that request.");
  await applySquareSubscription(env, row, subscription);
}

async function cancelPaypal(env, mode, row) {
  await paypalFetch(env, mode, "POST", `/v1/billing/subscriptions/${encodeURIComponent(row.provider_subscription_id)}/cancel`, {
    reason: "Customer requested cancellation",
  });
  await env.DB.prepare("UPDATE subscriptions SET status = 'canceled', cancel_at_period_end = 0, approval_url = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
}

async function squareCustomerId(env, mode, user) {
  const previous = await env.DB.prepare("SELECT provider_customer_id FROM subscriptions WHERE user_id = ? AND provider = 'square' AND mode = ? AND provider_customer_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1").bind(user.id, mode).first();
  if (previous && previous.provider_customer_id) return previous.provider_customer_id;
  const created = await squareFetch(env, mode, "POST", "/v2/customers", {
    idempotency_key: crypto.randomUUID(),
    email_address: user.email,
    reference_id: user.id,
  });
  const customerId = created && created.customer && created.customer.id;
  if (!customerId) fail(502, "The payment provider could not complete that request.");
  return String(customerId);
}

async function applySquareSubscription(env, row, subscription) {
  const planId = planIdFor(env, billingMode(env), "square", row.tier);
  if (subscription.plan_variation_id && subscription.plan_variation_id !== planId) {
    const mappedTier = tierForPlan(env, row.mode, "square", subscription.plan_variation_id);
    if (!mappedTier) {
      await env.DB.prepare("UPDATE subscriptions SET status = 'review', cancel_at_period_end = 0, updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
      return;
    }
    row = { ...row, tier: mappedTier.id };
    await env.DB.prepare("UPDATE subscriptions SET tier = ?, amount_cents = ?, updated_at = ? WHERE id = ?").bind(mappedTier.id, mappedTier.amountCents, nowIso(), row.id).run();
  }
  const mapped = mapSquareStatus(subscription);
  await env.DB.prepare("UPDATE subscriptions SET status = ?, current_period_end = ?, cancel_at_period_end = ?, provider_customer_id = COALESCE(?, provider_customer_id), updated_at = ? WHERE id = ?").bind(
    mapped.status,
    mapped.currentPeriodEnd,
    mapped.cancelAtPeriodEnd ? 1 : 0,
    subscription.customer_id || null,
    nowIso(),
    row.id,
  ).run();
}

async function applyPaypalResource(env, row, resource, eventType) {
  if (resource.custom_id && resource.custom_id !== row.user_id) fail(403, "Invalid webhook.");
  const planId = resource.plan_id ? String(resource.plan_id) : "";
  if (planId) {
    const mappedTier = tierForPlan(env, row.mode, "paypal", planId);
    if (!mappedTier) {
      await env.DB.prepare("UPDATE subscriptions SET status = 'review', cancel_at_period_end = 0, approval_url = NULL, updated_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
      return;
    }
    if (mappedTier.id !== row.tier) {
      await env.DB.prepare("UPDATE subscriptions SET tier = ?, amount_cents = ?, updated_at = ? WHERE id = ?").bind(mappedTier.id, mappedTier.amountCents, nowIso(), row.id).run();
      row = { ...row, tier: mappedTier.id };
    }
  }
  const remoteStatus = String(resource.status || "").toUpperCase();
  let status = row.status;
  if (remoteStatus === "ACTIVE") status = "active";
  else if (remoteStatus === "SUSPENDED" || eventType === "BILLING.SUBSCRIPTION.SUSPENDED") status = "suspended";
  else if (remoteStatus === "CANCELLED" || eventType === "BILLING.SUBSCRIPTION.CANCELLED") status = "canceled";
  else if (remoteStatus === "EXPIRED" || eventType === "BILLING.SUBSCRIPTION.EXPIRED") status = "expired";
  else if (eventType === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") status = "past_due";
  else if (remoteStatus === "APPROVAL_PENDING" || remoteStatus === "APPROVED") status = "pending";
  const periodEnd = resource.billing_info && resource.billing_info.next_billing_time ? String(resource.billing_info.next_billing_time) : null;
  await env.DB.prepare("UPDATE subscriptions SET status = ?, current_period_end = COALESCE(?, current_period_end), cancel_at_period_end = 0, approval_url = CASE WHEN ? = 'pending' THEN approval_url ELSE NULL END, updated_at = ? WHERE id = ?").bind(status, periodEnd, status, nowIso(), row.id).run();
}

function mapSquareStatus(subscription) {
  const remote = String(subscription.status || "").toUpperCase();
  const canceledDate = subscription.canceled_date ? String(subscription.canceled_date).slice(0, 10) : "";
  const today = nowIso().slice(0, 10);
  if (remote === "ACTIVE" && canceledDate) {
    if (canceledDate >= today) return { status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: canceledDate };
    return { status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: canceledDate };
  }
  if (remote === "ACTIVE") return { status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: subscription.paid_until_date ? String(subscription.paid_until_date).slice(0, 10) : null };
  if (remote === "PENDING") return { status: "pending", cancelAtPeriodEnd: false, currentPeriodEnd: null };
  if (remote === "PAUSED") return { status: "suspended", cancelAtPeriodEnd: false, currentPeriodEnd: null };
  if (remote === "CANCELED" || remote === "DEACTIVATED") return { status: "canceled", cancelAtPeriodEnd: false, currentPeriodEnd: canceledDate || null };
  return { status: "review", cancelAtPeriodEnd: false, currentPeriodEnd: null };
}

function accessFromRow(row) {
  if (!row || row.status !== "active") return emptyAccess();
  if (row.cancel_at_period_end && row.current_period_end && row.current_period_end < nowIso().slice(0, 10)) return emptyAccess();
  const tier = TIER_BY_ID[row.tier];
  if (!tier) return emptyAccess();
  return {
    tier: tier.id,
    rank: tier.rank,
    active: true,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    entitlements: TIERS.filter((item) => item.rank <= tier.rank).map((item) => item.id),
  };
}

function planViews(access, cancelAtPeriodEnd) {
  return TIERS.map((tier) => {
    let status = "not_activated";
    if (access && access.active && access.tier === tier.id) status = cancelAtPeriodEnd ? "cancel_scheduled" : "active";
    else if (access && access.active && access.rank > tier.rank) status = "included";
    return { id: tier.id, name: tier.name, status, amountCents: tier.amountCents, currency: "USD", interval: "month", price: tier.price };
  });
}

async function syncUserPlan(env, userId, mode) {
  const row = await latestOpen(env, userId, mode);
  const access = accessFromRow(row);
  const label = access.active ? TIER_BY_ID[access.tier].name : "none";
  const planStatus = access.active ? (access.cancelAtPeriodEnd ? "cancel_scheduled" : "active") : "not_activated";
  await env.DB.prepare("UPDATE users SET plan_label = ?, plan_status = ? WHERE id = ?").bind(label, planStatus, userId).run();
}

function publicSubscription(row) {
  if (!row) return null;
  const tier = TIER_BY_ID[row.tier];
  return {
    id: row.id,
    provider: row.provider,
    tier: row.tier,
    name: tier ? tier.name : row.tier,
    status: row.status,
    amountCents: row.amount_cents,
    currency: row.currency,
    interval: "month",
    price: tier ? tier.price : "",
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    currentPeriodEnd: row.current_period_end || null,
    approvalUrl: row.status === "pending" ? row.approval_url || null : null,
  };
}

async function latestOpen(env, userId, mode) {
  return env.DB.prepare(`SELECT * FROM subscriptions WHERE user_id = ? AND mode = ? AND status IN (${OPEN_STATUSES.map(() => "?").join(", ")}) ORDER BY updated_at DESC LIMIT 1`).bind(userId, mode, ...OPEN_STATUSES).first();
}

async function latestAny(env, userId, mode) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND mode = ? ORDER BY updated_at DESC LIMIT 1").bind(userId, mode).first();
}

async function markFailed(env, id) {
  try {
    await env.DB.prepare("UPDATE subscriptions SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'").bind(nowIso(), id).run();
  } catch (error) {
    console.error(JSON.stringify({ service: "quasi-business-auth", message: "could not mark subscription failed", error: error instanceof Error ? error.message : String(error) }));
  }
}

async function touchRow(env, id, fields) {
  await env.DB.prepare("UPDATE subscriptions SET updated_at = ? WHERE id = ?").bind(nowIso(), id).run();
  return fields;
}

async function seenEvent(env, provider, eventId) {
  const row = await env.DB.prepare("SELECT event_id FROM billing_events WHERE provider = ? AND event_id = ?").bind(provider, eventId).first();
  return Boolean(row);
}

async function rememberEvent(env, provider, eventId, eventType) {
  try {
    await env.DB.prepare("INSERT INTO billing_events (provider, event_id, event_type, created_at) VALUES (?, ?, ?, ?)").bind(provider, eventId, eventType.slice(0, 80), nowIso()).run();
  } catch (error) {
    if (!isUnique(error)) throw error;
  }
}

async function assertSubscribeAllowed(env, email) {
  const since = new Date(Date.now() - SUBSCRIBE_WINDOW_MS).toISOString();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE action = 'subscribe' AND email = ? AND created_at > ?").bind(email, since).first();
  if ((Number(row && row.n) || 0) >= SUBSCRIBE_LIMIT) fail(429, "Too many attempts. Try again later.");
}

async function recordSubscribe(env, email, request) {
  const ip = String(request.headers.get("CF-Connecting-IP") || "0.0.0.0").slice(0, 80);
  await env.DB.prepare("INSERT INTO login_attempts (email, ip, action, success, created_at) VALUES (?, ?, 'subscribe', 0, ?)").bind(email, ip, nowIso()).run();
}

async function squareFetch(env, mode, method, pathname, body) {
  return providerFetch(mode, "square", pathname, {
    method,
    headers: squareHeaders(env, mode),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function paypalFetch(env, mode, method, pathname, body) {
  const token = await paypalAccessToken(env, mode);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["PayPal-Request-Id"] = crypto.randomUUID();
  }
  return providerFetch(mode, "paypal", pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function paypalAccessToken(env, mode) {
  const clientId = readSecret(env, paypalSecret(mode, "CLIENT_ID"));
  const clientSecret = readSecret(env, paypalSecret(mode, "CLIENT_SECRET"));
  const payload = await providerFetch(mode, "paypal", "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${bytesToB64(new TextEncoder().encode(`${clientId}:${clientSecret}`))}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });
  const token = payload && payload.access_token;
  if (!headerSafe(token)) fail(502, "The payment provider could not complete that request.");
  return token;
}

async function verifyPaypalSignature(env, mode, request, event) {
  const transmissionId = request.headers.get("paypal-transmission-id") || "";
  const transmissionSig = request.headers.get("paypal-transmission-sig") || "";
  const transmissionTime = request.headers.get("paypal-transmission-time") || "";
  const authAlgo = request.headers.get("paypal-auth-algo") || "";
  const certUrl = request.headers.get("paypal-cert-url") || "";
  if (!transmissionId || !transmissionSig || !transmissionTime || !authAlgo || !paypalCertAllowed(certUrl)) return false;
  const webhookId = readSecret(env, paypalSecret(mode, "WEBHOOK_ID"));
  let payload;
  try {
    payload = await providerFetch(mode, "paypal", "/v1/notifications/verify-webhook-signature", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await paypalAccessToken(env, mode)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
  } catch (error) {
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "paypal verify failed", error: error instanceof Error ? error.message : "request failed" }));
    return false;
  }
  return payload && payload.verification_status === "SUCCESS";
}

async function providerFetch(mode, provider, pathname, init) {
  const url = `${HOSTS[mode][provider]}${pathname}`;
  assertProviderUrl(mode, provider, url);
  let response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(20000) });
  } catch (error) {
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "provider unreachable", provider, mode }));
    fail(502, "The payment provider could not complete that request.");
  }
  if (response.status >= 300 && response.status < 400) fail(502, "The payment provider could not complete that request.");
  if (response.status === 204) return {};
  const text = await response.text();
  if (text.length > WEBHOOK_MAX) fail(502, "The payment provider could not complete that request.");
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok || !data || typeof data !== "object") {
    const code = data && Array.isArray(data.errors) && data.errors[0] ? data.errors[0].code : data && data.name;
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "provider error", provider, mode, status: response.status, code: String(code || "").slice(0, 80) }));
    fail(502, "The payment provider could not complete that request.");
  }
  return data;
}

function assertProviderUrl(mode, provider, value) {
  const expected = new URL(HOSTS[mode][provider]);
  const actual = new URL(value);
  if (actual.protocol !== "https:" || actual.origin !== expected.origin) fail(502, "The payment provider could not complete that request.");
}

function squareHeaders(env, mode) {
  return {
    Authorization: `Bearer ${readSecret(env, squareSecret(mode, "ACCESS_TOKEN"))}`,
    "Content-Type": "application/json",
    "Square-Version": SQUARE_VERSION,
  };
}

function providerReady(env, mode, provider) {
  const leaves = provider === "square" ? SQUARE_LEAVES : PAYPAL_LEAVES;
  return leaves.every((leaf) => secretValid(env, mode, provider, leaf));
}

function secretValid(env, mode, provider, leaf) {
  const name = provider === "square" ? squareSecret(mode, leaf) : paypalSecret(mode, leaf);
  const value = readSecret(env, name);
  if (!value) return false;
  if (leaf === "WEBHOOK_URL") return isHttpsUrl(value);
  if (leaf.startsWith("PLAN_")) return provider === "square" ? /^[A-Za-z0-9]{8,80}$/.test(value) : /^P-[A-Z0-9]{24}$/.test(value);
  if (leaf === "APPLICATION_ID") return /^sandbox-sq0idb-[A-Za-z0-9_-]{8,60}$/.test(value) || /^sq0idp-[A-Za-z0-9_-]{8,60}$/.test(value);
  if (leaf === "LOCATION_ID") return /^[A-Za-z0-9]{4,40}$/.test(value);
  if (leaf === "WEBHOOK_ID") return /^[A-Za-z0-9]{8,50}$/.test(value);
  return headerSafe(value);
}

function planIdFor(env, mode, provider, tierId) {
  const leaf = `PLAN_${tierId.toUpperCase()}`;
  const value = readSecret(env, provider === "square" ? squareSecret(mode, leaf) : paypalSecret(mode, leaf));
  if (!secretValid(env, mode, provider, leaf)) fail(503, "Billing is not configured.");
  return value;
}

function tierForPlan(env, mode, provider, planId) {
  return TIERS.find((tier) => readSecret(env, provider === "square" ? squareSecret(mode, `PLAN_${tier.id.toUpperCase()}`) : paypalSecret(mode, `PLAN_${tier.id.toUpperCase()}`)) === planId) || null;
}

function squareSecret(mode, leaf) {
  return `SQUARE_${mode === "live" ? "LIVE" : "SANDBOX"}_${leaf}`;
}

function paypalSecret(mode, leaf) {
  return `PAYPAL_${mode === "live" ? "LIVE" : "SANDBOX"}_${leaf}`;
}

function readSecret(env, name) {
  const value = env && env[name];
  return typeof value === "string" ? value.trim() : "";
}

function headerSafe(value) {
  return typeof value === "string" && value.length > 0 && value.length < 4000 && !/[\r\n]/.test(value);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

function paypalCertAllowed(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "paypal.com" || host.endsWith(".paypal.com"));
  } catch {
    return false;
  }
}

function paypalApprovalUrl(mode, links) {
  const link = (links || []).find((item) => item && item.rel === "approve" && typeof item.href === "string");
  if (!link) return "";
  try {
    const url = new URL(link.href);
    const host = url.hostname.toLowerCase();
    const allowed = mode === "live" ? ["www.paypal.com", "paypal.com"] : ["www.sandbox.paypal.com", "sandbox.paypal.com"];
    if (url.protocol !== "https:" || !allowed.includes(host)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function paypalSubscriptionId(eventType, resource) {
  if (eventType === "PAYMENT.SALE.COMPLETED") return String(resource.billing_agreement_id || "");
  return String(resource.id || "");
}

function siteOrigin(env) {
  const origins = String(env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
  return origins.find((origin) => origin.startsWith("https://quasihydra.lalaayenglobalplaza.com")) || origins.find((origin) => origin.startsWith("https://")) || "";
}

function phasePrice(phase, cents) {
  if (phase && phase.pricing && phase.pricing.type === "RELATIVE") return false;
  if (phase && phase.pricing && phase.pricing.type && phase.pricing.type !== "STATIC") return false;
  const money = phase && phase.pricing && (phase.pricing.price || phase.pricing.price_money) || phase && phase.recurring_price_money;
  if (!money) return cents === 0;
  return money.currency === "USD" && Number(money.amount) === cents;
}

function usdCents(value, cents) {
  const text = String(value == null ? "" : value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return false;
  const [whole, frac = ""] = text.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2)) === cents;
}

function requireUser(request, env, deps) {
  return deps.currentUser(request, env).then((result) => result.user);
}

async function readJson(request) {
  const text = await rawText(request);
  return parseJson(text || "{}");
}

async function rawText(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > WEBHOOK_MAX) fail(413, "Body is too large.");
  const text = await request.text();
  if (text.length > WEBHOOK_MAX) fail(413, "Body is too large.");
  return text;
}

function parseJson(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "Invalid JSON.");
    return data;
  } catch (error) {
    if (error && error.status) throw error;
    fail(400, "Invalid JSON.");
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function isMissingTable(error) {
  return /no such table/i.test(String(error && error.message));
}

function isUnique(error) {
  return /UNIQUE/i.test(String(error && error.message));
}

function nowIso() {
  return new Date().toISOString();
}

function bytesToB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function jsonBody(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
