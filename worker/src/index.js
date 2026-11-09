// QUASI business auth + project storage.
// Billing is intentionally unimplemented. BILLING_MODE=off (the default) returns 503.

const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;
const LOGIN_FAIL_LIMIT = 8;
const LOGIN_IP_LIMIT = 20;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PROJECTS = 50;
const MAX_BODY = 100_000;
const DEFAULT_ITERATIONS = 100_000;
const CLIENT_HEADER = "x-quasi-client";
const BRIEF_KEYS = ["brand", "offer", "audience", "pain", "benefit", "proof", "platform", "length", "cta", "site", "source"];

const PLANS = [
  { name: "Basic", status: "not_activated" },
  { name: "Pro", status: "not_activated" },
  { name: "Business", status: "not_activated" },
];

export default {
  async fetch(request, env) {
    return handle(request, env);
  },
};

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (request.method === "OPTIONS") return withCors(request, env, new Response(null, { status: 204 }));
  try {
    const response = await route(request, env, path);
    return withCors(request, env, response);
  } catch (error) {
    const status = Number(error && error.status) || 500;
    if (status >= 500) {
      console.error(JSON.stringify({
        service: "quasi-business-auth",
        message: "request failed",
        path,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    const message = status >= 500 ? "Server error" : (error instanceof Error ? error.message : "Request failed");
    return withCors(request, env, jsonBody(status, { error: message }));
  }
}

async function route(request, env, path) {
  if (path === "/billing" || path.startsWith("/billing/")) {
    const mode = String(env.BILLING_MODE || "off");
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "billing blocked", mode }));
    return jsonBody(503, {
      error: "Billing is not activated.",
      billing: "off",
    });
  }

  if (request.method === "GET" && (path === "/" || path === "/health")) {
    return jsonBody(200, {
      ok: true,
      service: "quasi-business-auth",
      billing: "off",
      auth: ["signup", "login", "logout", "me"],
      storage: ["library", "projects", "quotes"],
    });
  }

  if (!env || !env.DB) fail(500, "Database is not configured.");

  // Public quote view by unguessable share token. Returns only that one quote.
  const shareMatch = path.match(/^\/q\/([A-Za-z0-9_-]{40,64})$/);
  if (shareMatch && request.method === "GET") return getSharedQuote(env, shareMatch[1]);

  if (request.method === "POST" && path === "/auth/signup") return signup(request, env);
  if (request.method === "POST" && path === "/auth/login") return login(request, env);
  if (request.method === "POST" && path === "/auth/logout") return logout(request, env);
  if (request.method === "GET" && path === "/auth/me") return me(request, env);
  if (request.method === "GET" && path === "/library") return getLibrary(request, env);
  if (request.method === "PUT" && path === "/library") return putLibrary(request, env);
  if (request.method === "GET" && path === "/projects") return listProjects(request, env);
  if (request.method === "POST" && path === "/projects") return createProject(request, env);

  if (request.method === "GET" && path === "/quote/profile") return getQuoteProfile(request, env);
  if (request.method === "PUT" && path === "/quote/profile") return putQuoteProfile(request, env);
  if (request.method === "GET" && path === "/quotes") return listQuotes(request, env);
  if (request.method === "POST" && path === "/quotes") return createQuote(request, env);
  const quoteMatch = path.match(/^\/quotes\/([0-9a-f-]{36})$/i);
  if (quoteMatch && request.method === "DELETE") return deleteQuote(request, env, quoteMatch[1]);

  const projectMatch = path.match(/^\/projects\/([0-9a-f-]{36})$/i);
  if (projectMatch) {
    const id = projectMatch[1];
    if (request.method === "GET") return getProject(request, env, id);
    if (request.method === "PUT") return updateProject(request, env, id);
    if (request.method === "DELETE") return deleteProject(request, env, id);
  }

  return jsonBody(404, { error: "Not found" });
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireClientHeader(request) {
  if (request.method === "GET" || request.method === "HEAD") return;
  if (request.headers.get(CLIENT_HEADER) !== "1") fail(403, "Missing client header.");
}

function clientIp(request) {
  return (request.headers.get("CF-Connecting-IP") || "0.0.0.0").slice(0, 80);
}

function nowIso() {
  return new Date().toISOString();
}

function isoFromNow(ms) {
  return new Date(Date.now() + ms).toISOString();
}

async function readJson(request) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY) fail(413, "Body is too large.");
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, "Body is too large.");
  if (!text) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(400, "Invalid JSON.");
    return data;
  } catch (error) {
    if (error && error.status) throw error;
    fail(400, "Invalid JSON.");
  }
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 6 || email.length > 254) return "";
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return "";
  return email;
}

function checkPassword(value) {
  const password = String(value ?? "");
  if (password.length < 10 || password.length > 128) fail(400, "Use a password between 10 and 128 characters.");
  return password;
}

function kdfIterations(env) {
  const configured = Number(env.PBKDF2_ITERATIONS || DEFAULT_ITERATIONS);
  if (!Number.isInteger(configured) || configured < 1000 || configured > 600000) return DEFAULT_ITERATIONS;
  return configured;
}

function bytesToB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, key, 256);
  return new Uint8Array(bits);
}

async function hashesEqual(left, right) {
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", left),
    crypto.subtle.digest("SHA-256", right),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") return crypto.subtle.timingSafeEqual(leftHash, rightHash);
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function hashPassword(password, iterations) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const hash = await pbkdf2(password, salt, iterations);
  return { salt: bytesToB64(salt), hash: bytesToB64(hash), iterations };
}

async function verifyPassword(password, saltB64, hashB64, iterations) {
  let salt;
  let expected;
  try {
    salt = b64ToBytes(saltB64);
    expected = b64ToBytes(hashB64);
  } catch {
    return false;
  }
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  return hashesEqual(actual, expected);
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    planLabel: "none",
    planStatus: "not_activated",
    plans: PLANS,
    createdAt: row.created_at,
  };
}

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_MS / 1000);
  return `quasi_session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}; Partitioned`;
}

function clearSessionCookie() {
  return "quasi_session=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0; Partitioned";
}

function readBearer(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return "";
  return header.slice(7).trim();
}

function readCookieToken(request) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)quasi_session=([^;]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

async function countAttempts(env, { action, email, ip, since, success }) {
  const clauses = ["action = ?", "created_at > ?"];
  const params = [action, since];
  if (email) {
    clauses.push("email = ?");
    params.push(email);
  }
  if (ip) {
    clauses.push("ip = ?");
    params.push(ip);
  }
  if (success != null) {
    clauses.push("success = ?");
    params.push(success);
  }
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ${clauses.join(" AND ")}`).bind(...params).first();
  return Number(row && row.n) || 0;
}

async function pruneAttempts(env) {
  const cutoff = isoFromNow(-48 * 60 * 60 * 1000);
  await env.DB.prepare("DELETE FROM login_attempts WHERE created_at < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(nowIso()).run();
}

async function recordAttempt(env, { email, ip, action, success }) {
  await env.DB.prepare("INSERT INTO login_attempts (email, ip, action, success, created_at) VALUES (?, ?, ?, ?, ?)").bind(email, ip, action, success ? 1 : 0, nowIso()).run();
}

async function assertSignupAllowed(env, email, ip) {
  const since = isoFromNow(-SIGNUP_WINDOW_MS);
  const byIp = await countAttempts(env, { action: "signup", ip, since });
  const byEmail = await countAttempts(env, { action: "signup", email, since });
  if (byIp >= SIGNUP_LIMIT || byEmail >= SIGNUP_LIMIT) fail(429, "Too many attempts. Try again later.");
}

async function assertLoginAllowed(env, email, ip) {
  const since = isoFromNow(-LOGIN_WINDOW_MS);
  const byEmail = await countAttempts(env, { action: "login", email, since, success: 0 });
  const byIp = await countAttempts(env, { action: "login", ip, since, success: 0 });
  if (byEmail >= LOGIN_FAIL_LIMIT || byIp >= LOGIN_IP_LIMIT) fail(429, "Too many attempts. Try again later.");
}

async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const created = nowIso();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), userId, tokenHash, isoFromNow(SESSION_MS), created).run();
  const rows = await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all();
  const extra = (rows.results || []).slice(10);
  for (const row of extra) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.id).run();
  return token;
}

function authResponse(user, token) {
  return jsonBody(200, { user: publicUser(user), token }, { "Set-Cookie": sessionCookie(token) });
}

async function signup(request, env) {
  requireClientHeader(request);
  await pruneAttempts(env);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) fail(400, "Enter a valid email address.");
  const password = checkPassword(body.password);
  const ip = clientIp(request);
  await assertSignupAllowed(env, email, ip);
  const iterations = kdfIterations(env);
  const hashed = await hashPassword(password, iterations);
  const user = {
    id: crypto.randomUUID(),
    email,
    password_hash: hashed.hash,
    password_salt: hashed.salt,
    kdf_iterations: hashed.iterations,
    plan_label: "none",
    plan_status: "not_activated",
    created_at: nowIso(),
  };
  try {
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, password_salt, kdf_iterations, plan_label, plan_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(user.id, user.email, user.password_hash, user.password_salt, user.kdf_iterations, user.plan_label, user.plan_status, user.created_at).run();
  } catch (error) {
    await recordAttempt(env, { email, ip, action: "signup", success: false });
    if (/UNIQUE/i.test(String(error && error.message))) fail(409, "An account with that email already exists.");
    throw error;
  }
  await recordAttempt(env, { email, ip, action: "signup", success: true });
  const token = await createSession(env, user.id);
  console.log(JSON.stringify({ service: "quasi-business-auth", message: "signup", userId: user.id }));
  return authResponse(user, token);
}

async function login(request, env) {
  requireClientHeader(request);
  await pruneAttempts(env);
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) fail(400, "Enter a valid email address.");
  const password = checkPassword(body.password);
  const ip = clientIp(request);
  await assertLoginAllowed(env, email, ip);
  const user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
  const iterations = user ? Number(user.kdf_iterations) || kdfIterations(env) : kdfIterations(env);
  const salt = user ? user.password_salt : bytesToB64(new Uint8Array(16));
  const hash = user ? user.password_hash : bytesToB64(new Uint8Array(32));
  const matches = await verifyPassword(password, salt, hash, iterations);
  if (!user || !matches) {
    await recordAttempt(env, { email, ip, action: "login", success: false });
    console.log(JSON.stringify({ service: "quasi-business-auth", message: "login failed" }));
    fail(401, "Invalid email or password.");
  }
  await recordAttempt(env, { email, ip, action: "login", success: true });
  const token = await createSession(env, user.id);
  console.log(JSON.stringify({ service: "quasi-business-auth", message: "login", userId: user.id }));
  return authResponse(user, token);
}

async function currentUser(request, env) {
  const bearer = readBearer(request);
  const cookie = readCookieToken(request);
  const token = bearer || cookie;
  if (!token) fail(401, "Sign in required.");
  if (!bearer && request.method !== "GET" && request.method !== "HEAD") requireClientHeader(request);
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare("SELECT sessions.id AS session_id, sessions.expires_at, users.id, users.email, users.created_at, users.plan_label, users.plan_status FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?").bind(tokenHash).first();
  if (!row || row.expires_at <= nowIso()) {
    if (row) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.session_id).run();
    fail(401, "Sign in required.");
  }
  return { user: row, token, sessionId: row.session_id };
}

async function me(request, env) {
  const { user } = await currentUser(request, env);
  return jsonBody(200, { user: publicUser(user) });
}

async function logout(request, env) {
  requireClientHeader(request);
  const bearer = readBearer(request);
  const token = bearer || readCookieToken(request);
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
  }
  console.log(JSON.stringify({ service: "quasi-business-auth", message: "logout" }));
  return jsonBody(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
}

function sanitizeBrief(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Brief must be an object.");
  const brief = {};
  for (const key of BRIEF_KEYS) {
    if (input[key] == null) continue;
    brief[key] = String(input[key]).slice(0, 600);
  }
  return brief;
}

function sanitizeHooks(input) {
  if (!Array.isArray(input)) fail(400, "Hooks must be a list.");
  if (input.length > 100) fail(400, "Too many hooks.");
  const hooks = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(400, "Invalid hook.");
    const text = String(item.text ?? "").slice(0, 500).trim();
    if (!text) continue;
    const hook = {
      text,
      category: String(item.category ?? "").slice(0, 40),
      brand: String(item.brand ?? "").slice(0, 90),
      date: String(item.date ?? "").slice(0, 40),
    };
    const id = String(item.id ?? "").slice(0, 80);
    if (id) hook.id = id;
    if (item.review && typeof item.review === "object" && !Array.isArray(item.review)) {
      const value = Number(item.review.value);
      hook.review = {
        value: Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0,
        why: Array.isArray(item.review.why) ? item.review.why.slice(0, 6).map((entry) => String(entry).slice(0, 180)) : [],
        issues: Array.isArray(item.review.issues) ? item.review.issues.slice(0, 6).map((entry) => String(entry).slice(0, 180)) : [],
      };
    }
    hooks.push(hook);
  }
  const encoded = JSON.stringify(hooks);
  if (encoded.length > 80_000) fail(400, "Project is too large.");
  return hooks;
}

function projectPayload(row) {
  let brief = {};
  let hooks = [];
  try { brief = JSON.parse(row.brief_json || "{}"); } catch { brief = {}; }
  try { hooks = JSON.parse(row.hooks_json || "[]"); } catch { hooks = []; }
  return {
    id: row.id,
    title: row.title,
    brief,
    hooks,
    kind: row.kind,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

async function getLibrary(request, env) {
  const { user } = await currentUser(request, env);
  const row = await env.DB.prepare("SELECT * FROM projects WHERE user_id = ? AND kind = 'library'").bind(user.id).first();
  return jsonBody(200, { project: row ? projectPayload(row) : null });
}

async function putLibrary(request, env) {
  const { user } = await currentUser(request, env);
  const body = await readJson(request);
  const brief = sanitizeBrief(body.brief || {});
  const hooks = sanitizeHooks(body.hooks || []);
  const updated = nowIso();
  const existing = await env.DB.prepare("SELECT id, created_at FROM projects WHERE user_id = ? AND kind = 'library'").bind(user.id).first();
  if (existing) {
    await env.DB.prepare("UPDATE projects SET title = ?, brief_json = ?, hooks_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind("Saved ideas", JSON.stringify(brief), JSON.stringify(hooks), updated, existing.id, user.id).run();
    const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(existing.id).first();
    return jsonBody(200, { project: projectPayload(row) });
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO projects (id, user_id, title, brief_json, hooks_json, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'library', ?, ?)").bind(id, user.id, "Saved ideas", JSON.stringify(brief), JSON.stringify(hooks), updated, updated).run();
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  return jsonBody(200, { project: projectPayload(row) });
}

async function listProjects(request, env) {
  const { user } = await currentUser(request, env);
  const rows = await env.DB.prepare("SELECT id, title, updated_at FROM projects WHERE user_id = ? AND kind = 'project' ORDER BY updated_at DESC").bind(user.id).all();
  const projects = (rows.results || []).map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at }));
  return jsonBody(200, { projects });
}

function cleanTitle(value) {
  const title = String(value ?? "").replace(/[\u0000-\u001f]/g, "").trim();
  if (!title) fail(400, "Title is required.");
  if (title.length > 120) fail(400, "Title is too long.");
  return title;
}

async function createProject(request, env) {
  const { user } = await currentUser(request, env);
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND kind = 'project'").bind(user.id).first();
  if ((Number(countRow && countRow.n) || 0) >= MAX_PROJECTS) fail(409, "Project limit reached.");
  const body = await readJson(request);
  const title = cleanTitle(body.title);
  const brief = sanitizeBrief(body.brief || {});
  const hooks = sanitizeHooks(body.hooks || []);
  const stamp = nowIso();
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO projects (id, user_id, title, brief_json, hooks_json, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'project', ?, ?)").bind(id, user.id, title, JSON.stringify(brief), JSON.stringify(hooks), stamp, stamp).run();
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  return jsonBody(201, { project: projectPayload(row) });
}

async function ownedProject(env, userId, id) {
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ? AND kind = 'project'").bind(id, userId).first();
  if (!row) fail(404, "Project not found.");
  return row;
}

async function getProject(request, env, id) {
  const { user } = await currentUser(request, env);
  const row = await ownedProject(env, user.id, id);
  return jsonBody(200, { project: projectPayload(row) });
}

async function updateProject(request, env, id) {
  const { user } = await currentUser(request, env);
  await ownedProject(env, user.id, id);
  const body = await readJson(request);
  const title = cleanTitle(body.title);
  const brief = sanitizeBrief(body.brief || {});
  const hooks = sanitizeHooks(body.hooks || []);
  const updated = nowIso();
  await env.DB.prepare("UPDATE projects SET title = ?, brief_json = ?, hooks_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(title, JSON.stringify(brief), JSON.stringify(hooks), updated, id, user.id).run();
  const row = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  return jsonBody(200, { project: projectPayload(row) });
}

async function deleteProject(request, env, id) {
  const { user } = await currentUser(request, env);
  await ownedProject(env, user.id, id);
  await env.DB.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return jsonBody(200, { ok: true });
}

// ---- Quotation Maker (cleaners) ----
const MAX_QUOTES = 500;
const MAX_PRICE_CENTS = 10_000_000; // $100,000 cap per entry
const CLEAN_TYPES = { standard: "Standard clean", deep: "Deep clean", moveout: "Move-out clean" };
const HOME_SIZES = {
  studio: { label: "Studio / 1 bedroom", extra: 0 },
  bed2: { label: "2 bedrooms", extra: 1 },
  bed3: { label: "3 bedrooms", extra: 2 },
  bed4: { label: "4 bedrooms", extra: 3 },
  bed5: { label: "5+ bedrooms", extra: 4 },
};

function cleanText(value, max, label) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (!text) fail(400, `${label} is required.`);
  if (text.length > max) fail(400, `${label} is too long.`);
  return text;
}

function priceCents(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) fail(400, `Enter a price of 0 or more for ${label}.`);
  const cents = Math.round(amount * 100);
  if (cents > MAX_PRICE_CENTS) fail(400, `Price for ${label} is too high.`);
  return cents;
}

function sanitizePrices(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "Prices are required.");
  const base = input.base && typeof input.base === "object" ? input.base : {};
  return {
    base: {
      standard: priceCents(base.standard, CLEAN_TYPES.standard),
      deep: priceCents(base.deep, CLEAN_TYPES.deep),
      moveout: priceCents(base.moveout, CLEAN_TYPES.moveout),
    },
    perBedroom: priceCents(input.perBedroom, "each extra bedroom"),
  };
}

function profilePayload(row) {
  if (!row) return null;
  let prices = null;
  try { prices = JSON.parse(row.prices_json); } catch { prices = null; }
  return { businessName: row.business_name, prices, updatedAt: row.updated_at };
}

function computeQuoteCents(prices, cleanType, homeSize) {
  const base = Number(prices && prices.base && prices.base[cleanType]) || 0;
  const per = Number(prices && prices.perBedroom) || 0;
  return base + per * HOME_SIZES[homeSize].extra;
}

function quotePayload(row, includeToken) {
  const out = {
    businessName: row.business_name,
    customerName: row.customer_name,
    cleanType: row.clean_type,
    cleanTypeLabel: CLEAN_TYPES[row.clean_type] || row.clean_type,
    homeSize: row.home_size,
    homeSizeLabel: (HOME_SIZES[row.home_size] || {}).label || row.home_size,
    totalCents: row.total_cents,
    createdAt: row.created_at,
  };
  if (includeToken) {
    out.id = row.id;
    out.shareToken = row.share_token;
  }
  return out;
}

async function getQuoteProfile(request, env) {
  const { user } = await currentUser(request, env);
  const row = await env.DB.prepare("SELECT * FROM cleaner_profiles WHERE user_id = ?").bind(user.id).first();
  return jsonBody(200, { profile: profilePayload(row), cleanTypes: CLEAN_TYPES, homeSizes: Object.fromEntries(Object.entries(HOME_SIZES).map(([k, v]) => [k, v.label])) });
}

async function putQuoteProfile(request, env) {
  const { user } = await currentUser(request, env);
  const body = await readJson(request);
  const businessName = cleanText(body.businessName, 120, "Business name");
  const prices = sanitizePrices(body.prices);
  const stamp = nowIso();
  await env.DB.prepare("INSERT INTO cleaner_profiles (user_id, business_name, prices_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET business_name = excluded.business_name, prices_json = excluded.prices_json, updated_at = excluded.updated_at").bind(user.id, businessName, JSON.stringify(prices), stamp).run();
  const row = await env.DB.prepare("SELECT * FROM cleaner_profiles WHERE user_id = ?").bind(user.id).first();
  return jsonBody(200, { profile: profilePayload(row) });
}

async function listQuotes(request, env) {
  const { user } = await currentUser(request, env);
  const rows = await env.DB.prepare("SELECT * FROM quotes WHERE user_id = ? ORDER BY created_at DESC LIMIT ?").bind(user.id, MAX_QUOTES).all();
  return jsonBody(200, { quotes: (rows.results || []).map((row) => quotePayload(row, true)) });
}

async function createQuote(request, env) {
  const { user } = await currentUser(request, env);
  const profile = await env.DB.prepare("SELECT * FROM cleaner_profiles WHERE user_id = ?").bind(user.id).first();
  if (!profile) fail(409, "Set your business name and prices first.");
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM quotes WHERE user_id = ?").bind(user.id).first();
  if ((Number(countRow && countRow.n) || 0) >= MAX_QUOTES) fail(409, "Quote limit reached. Delete old quotes first.");
  const body = await readJson(request);
  const customerName = cleanText(body.customerName, 80, "Customer name");
  const cleanType = String(body.cleanType || "");
  const homeSize = String(body.homeSize || "");
  if (!Object.hasOwn(CLEAN_TYPES, cleanType)) fail(400, "Choose standard, deep or move-out.");
  if (!Object.hasOwn(HOME_SIZES, homeSize)) fail(400, "Choose a home size.");
  let prices;
  try { prices = JSON.parse(profile.prices_json); } catch { fail(409, "Set your prices first."); }
  const total = computeQuoteCents(prices, cleanType, homeSize);
  const row = {
    id: crypto.randomUUID(),
    user_id: user.id,
    share_token: randomToken(),
    business_name: profile.business_name,
    customer_name: customerName,
    clean_type: cleanType,
    home_size: homeSize,
    total_cents: total,
    created_at: nowIso(),
  };
  await env.DB.prepare("INSERT INTO quotes (id, user_id, share_token, business_name, customer_name, clean_type, home_size, total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(row.id, row.user_id, row.share_token, row.business_name, row.customer_name, row.clean_type, row.home_size, row.total_cents, row.created_at).run();
  return jsonBody(201, { quote: quotePayload(row, true) });
}

async function deleteQuote(request, env, id) {
  const { user } = await currentUser(request, env);
  const row = await env.DB.prepare("SELECT id FROM quotes WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!row) fail(404, "Quote not found.");
  await env.DB.prepare("DELETE FROM quotes WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return jsonBody(200, { ok: true });
}

async function getSharedQuote(env, token) {
  const row = await env.DB.prepare("SELECT * FROM quotes WHERE share_token = ?").bind(token).first();
  if (!row) fail(404, "Quote not found.");
  return jsonBody(200, { quote: quotePayload(row, false) });
}

function allowedOrigins(env) {
  return new Set(String(env.ALLOWED_ORIGINS || "https://quasihydra.lalaayenglobalplaza.com,https://www.quasihydra.lalaayenglobalplaza.com").split(",").map((origin) => origin.trim()).filter(Boolean));
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Quasi-Client",
    "Access-Control-Max-Age": "86400",
  };
  if (allowedOrigins(env).has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

function withCors(request, env, response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env || {}))) headers.set(key, value);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Content-Security-Policy", "default-src 'none'");
  return new Response(response.body, { status: response.status, headers });
}

function jsonBody(status, data, extra) {
  const headers = new Headers(extra || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}
