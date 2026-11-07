// Shared QUASI account client for the static Pages site.
// Session cookie is httpOnly on the API host. A bearer token is kept in
// localStorage because the Pages host and workers.dev host do not share a site.
(function () {
  const TOKEN_KEY = "quasi_session_token";
  const PLANS = ["Basic", "Pro", "Business"];
  let user = null;
  let mode = "login";
  let busy = false;
  let message = "";
  let messageTone = "info";
  let billingOffer = null;
  let squareTier = "";
  let squareCardField = null;
  const listeners = new Set();
  const mounts = [];

  function apiBase() {
    try {
      const override = new URLSearchParams(location.search).get("api");
      if (override && /^http:\/\/(127\.0\.0\.1|localhost):8787$/.test(override)) return override;
    } catch { /* keep the configured host */ }
    const raw = String(window.QUASI_API || "").trim().replace(/\/$/, "");
    if (!raw || /PLACEHOLDER/i.test(raw)) return "";
    return raw;
  }

  function configured() {
    return Boolean(apiBase());
  }

  function ensureStyles() {
    if (document.getElementById("quasi-auth-styles")) return;
    const style = document.createElement("style");
    style.id = "quasi-auth-styles";
    style.textContent = [
      ".qa{display:grid;gap:14px}",
      ".qa-switch{display:flex;gap:8px;flex-wrap:wrap}",
      ".qa-btn{border:1px solid #47415f;background:#29243e;color:#fff;border-radius:11px;padding:11px 14px;font:inherit;font-weight:750;cursor:pointer}",
      ".qa-btn.primary{background:linear-gradient(120deg,#ffb1d1,#b9a7ff);color:#23152e;border:0}",
      ".qa-btn:disabled{opacity:.55;cursor:default}",
      ".qa-grid{display:grid;gap:12px}",
      "@media(min-width:760px){.qa-grid.wide{grid-template-columns:1fr 1fr}}",
      ".qa label{display:block;font-size:13px;font-weight:750;margin-bottom:6px}",
      ".qa input{display:block;width:100%;background:#100f1d;border:1px solid #71668f;color:#fff;padding:12px;border-radius:10px;font:inherit}",
      ".qa-msg{font-size:13px;border-radius:12px;padding:12px 14px;margin:0}",
      ".qa-msg.info{color:#e5cad8;background:#392437;border:1px solid #74516c}",
      ".qa-msg.good{color:#e7fff6;background:#17352d;border:1px solid #3f7564}",
      ".qa-msg.bad{color:#ffe8e8;background:#3a2230;border:1px solid #8a4d5d}",
      ".qa-plans{display:flex;gap:8px;flex-wrap:wrap}",
      ".qa-pill{border:1px solid #876c74;border-radius:30px;padding:4px 9px;font-size:12px;color:#ffaccb}",
      ".qa-email{font-weight:800;overflow-wrap:anywhere}",
      ".qa-actions,.qa-billing-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}",
      ".qa-billing{display:grid;gap:10px}",
      ".qa-square-card{min-height:88px;background:#100f1d;border:1px solid #71668f;border-radius:10px;padding:10px}",
      ".qa a{color:#d9cbff}",
    ].join("");
    document.head.appendChild(style);
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function setMessage(text, tone) {
    message = text;
    messageTone = tone || "info";
    for (const mount of mounts) paint(mount);
  }

  function emit() {
    for (const listener of listeners) listener(user);
    for (const mount of mounts) paint(mount);
    paintMemberships();
  }

  async function request(path, { method = "GET", body } = {}) {
    const root = apiBase();
    if (!root) {
      const error = new Error("The QUASI API is not deployed yet. Set window.QUASI_API in config.js to the workers.dev URL. Nothing was charged.");
      error.code = "not_configured";
      throw error;
    }
    const headers = { "X-Quasi-Client": "1" };
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = "Bearer " + token;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetch(root + path, {
        method,
        headers,
        credentials: "include",
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error("Could not reach the QUASI API. Check config.js and your connection. Your on-device copy is unchanged.");
    }
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!response.ok) {
      if (response.status === 401 && path !== "/auth/login" && path !== "/auth/signup") {
        localStorage.removeItem(TOKEN_KEY);
        user = null;
        emit();
      }
      throw new Error(data.error || "Request failed.");
    }
    if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
    return data;
  }

  function mergeHookLists(primary, secondary) {
    const out = [];
    const seen = new Set();
    for (const item of [...(primary || []), ...(secondary || [])]) {
      if (!item || typeof item.text !== "string" || !item.text.trim()) continue;
      if (seen.has(item.text)) continue;
      seen.add(item.text);
      out.push(item);
      if (out.length >= 100) break;
    }
    return out;
  }

  function mount(root, options) {
    if (!root) return;
    ensureStyles();
    options = options || {};
    root.replaceChildren();
    const box = el("div", "qa");
    const signedOut = el("div", "qa-out");
    const switcher = el("div", "qa-switch");
    const loginBtn = el("button", "qa-btn primary");
    loginBtn.type = "button";
    loginBtn.textContent = "Sign in";
    const signupBtn = el("button", "qa-btn");
    signupBtn.type = "button";
    signupBtn.textContent = "Create account";
    switcher.append(loginBtn, signupBtn);

    const form = el("form");
    form.noValidate = true;
    const grid = el("div", "qa-grid wide");
    const emailField = field("Email", "email", "email", "username");
    const passwordField = field("Password", "password", "password", "current-password");
    const confirmWrap = el("div");
    const confirmField = field("Confirm password", "confirm", "password", "new-password");
    confirmWrap.append(confirmField.label, confirmField.input);
    grid.append(emailField.wrap, passwordField.wrap, confirmWrap);
    const msg = el("p", "qa-msg info");
    msg.setAttribute("role", "status");
    const submit = el("button", "qa-btn primary");
    submit.type = "submit";
    form.append(grid, msg, submit);

    const hint = el("p", "qa-msg info");
    hint.textContent = "Basic, Pro, and Business are not activated. Creating an account does not charge a card or unlock a paid plan.";
    signedOut.append(switcher, form, hint);

    const signedIn = el("div", "qa-in");
    const who = el("p");
    who.append("Signed in as ");
    const email = el("span", "qa-email");
    who.append(email);
    const plans = el("div", "qa-plans");
    const billingBox = el("div", "qa-billing");
    const billingStatus = el("p", "qa-msg info");
    const billingActions = el("div", "qa-billing-actions");
    const squareCard = el("div", "qa-square-card");
    const squareConfirm = el("button", "qa-btn primary");
    squareConfirm.type = "button";
    squareConfirm.textContent = "Confirm Square card";
    squareCard.hidden = true;
    squareConfirm.hidden = true;
    billingBox.hidden = true;
    billingBox.append(billingStatus, billingActions, squareCard, squareConfirm);
    const signedMsg = el("p", "qa-msg info");
    signedMsg.textContent = options.context === "studio"
      ? "Favorites and named briefs save to your account. Plans stay not activated."
      : "Open HYDRA Hook Studio to save hooks to this account. Plans stay not activated.";
    const actions = el("div", "qa-actions");
    if (options.context !== "studio") {
      const open = el("a", "qa-btn primary");
      open.href = "studio.html" + (location.search || "");
      open.textContent = "Open HYDRA Hook Studio";
      actions.append(open);
    }
    const signOut = el("button", "qa-btn");
    signOut.type = "button";
    signOut.textContent = "Sign out";
    actions.append(signOut);
    signedIn.append(who, plans, billingBox, signedMsg, actions);
    squareConfirm.addEventListener("click", () => confirmSquare());
    box.append(signedOut, signedIn);
    root.append(box);

    loginBtn.addEventListener("click", () => { mode = "login"; message = ""; paintAll(); });
    signupBtn.addEventListener("click", () => { mode = "signup"; message = ""; paintAll(); });
    signOut.addEventListener("click", () => { logout(); });
    form.addEventListener("submit", (event) => submitForm(event, form));

    const record = { root, options, signedOut, signedIn, loginBtn, signupBtn, confirmWrap, passwordField, submit, msg, email, plans, billingBox, billingStatus, billingActions, squareCard, squareConfirm, signedMsg };
    mounts.push(record);
    paint(record);
  }

  function field(labelText, name, type, auto) {
    const wrap = el("div");
    const label = el("label");
    const input = el("input");
    input.name = name;
    input.type = type;
    input.autocomplete = auto;
    input.maxLength = type === "email" ? 254 : 128;
    input.required = true;
    label.append(labelText, input);
    wrap.append(label);
    return { wrap, label, input };
  }

  function paint(record) {
    const signed = Boolean(user);
    record.signedOut.hidden = signed;
    record.signedIn.hidden = !signed;
    record.loginBtn.classList.toggle("primary", mode === "login");
    record.signupBtn.classList.toggle("primary", mode === "signup");
    record.confirmWrap.hidden = mode !== "signup";
    record.passwordField.input.autocomplete = mode === "signup" ? "new-password" : "current-password";
    record.submit.textContent = busy ? "Please wait…" : (mode === "signup" ? "Create account" : "Sign in");
    record.submit.disabled = busy;
    record.msg.className = "qa-msg " + (messageTone || "info");
    record.msg.textContent = message || (configured()
      ? "Sign in to save HYDRA projects to your account."
      : "Sign-in is on this page. Cloud save turns on after the API hostname in config.js replaces PLACEHOLDER.");
    record.email.textContent = user ? user.email : "";
    record.signedMsg.textContent = user && user.access && user.access.active
      ? membershipNotice(user)
      : (record.options.context === "studio"
        ? "Favorites and named briefs save to your account. Plans stay not activated."
        : "Open HYDRA Hook Studio to save hooks to this account. Plans stay not activated.");
    paintPlans(record);
    paintBilling(record);
  }

  function planPhrase(status) {
    if (status === "active") return "active";
    if (status === "included") return "included";
    if (status === "cancel_scheduled") return "cancels at period end";
    return "not activated";
  }

  function paintPlans(record) {
    record.plans.replaceChildren();
    const source = user && Array.isArray(user.plans) && user.plans.length
      ? user.plans
      : PLANS.map((name) => ({ name, status: "not_activated" }));
    for (const plan of source) {
      const pill = el("span", "qa-pill");
      pill.textContent = plan.name + " · " + planPhrase(plan.status);
      record.plans.append(pill);
    }
  }

  function paintBilling(record) {
    if (!billingOffer || !user) {
      record.billingBox.hidden = true;
      return;
    }
    record.billingBox.hidden = false;
    const access = user.access || {};
    record.billingStatus.textContent = access.active
      ? membershipNotice(user)
      : (billingOffer.billing === "live"
        ? "Live billing is on. Subscribing charges the monthly price until you cancel."
        : "Sandbox billing is on. Square and PayPal stay in sandbox. This is not a live sale.");
    record.billingActions.replaceChildren();
    if (access.active) {
      const cancel = el("button", "qa-btn");
      cancel.type = "button";
      cancel.textContent = access.cancelAtPeriodEnd ? "Cancellation scheduled" : "Cancel membership";
      cancel.disabled = busy || Boolean(access.cancelAtPeriodEnd);
      cancel.addEventListener("click", () => cancelMembership());
      record.billingActions.append(cancel);
      record.squareCard.hidden = true;
      record.squareConfirm.hidden = true;
      return;
    }
    for (const plan of billingOffer.plans) {
      for (const provider of billingOffer.providers) {
        const button = el("button", "qa-btn");
        button.type = "button";
        button.disabled = busy;
        button.textContent = plan.name + " " + plan.price + " · " + (provider === "square" ? "Square" : "PayPal");
        button.addEventListener("click", () => startSubscribe(plan.id, provider, record));
        record.billingActions.append(button);
      }
    }
  }

  function paintMemberships() {
    const sale = document.getElementById("membershipSale");
    const note = document.getElementById("membershipNote");
    const feature = document.getElementById("billingFeatureState");
    if (!sale || !note || !billingOffer) return;
    sale.textContent = billingOffer.billing === "live" ? "LIVE BILLING" : "SANDBOX BILLING";
    note.textContent = billingOffer.billing === "live"
      ? "Live billing is on. Sign in above to subscribe or cancel. Prices stay $19, $49, and $149 per month."
      : "Sandbox billing is on. Sign in above to subscribe or cancel. Prices stay $19, $49, and $149 per month. This is not a live sale.";
    if (feature) feature.textContent = "video rendering and public posting";
    for (const article of document.querySelectorAll("#membershipBands [data-tier]")) {
      const blurb = article.querySelector("p");
      const tier = article.getAttribute("data-tier");
      const plan = billingOffer.plans.find((item) => item.id === tier);
      if (blurb && plan) blurb.textContent = plan.name + " is " + plan.price + ". Subscribe from your account above.";
    }
  }

  function membershipNotice(account) {
    const access = account && account.access;
    if (!access || !access.active) return "Signed in. Favorites sync to your account. Plans are not activated, and this does not unlock a paid tier.";
    const names = { basic: "Basic", pro: "Pro", business: "Business" };
    const included = (access.entitlements || []).filter((id) => id !== access.tier).map((id) => names[id]).filter(Boolean);
    const label = account.planLabel || names[access.tier] || "Membership";
    return included.length
      ? "Signed in. " + label + " membership is active and includes " + included.join(" and ") + "."
      : "Signed in. " + label + " membership is active.";
  }

  function paintAll() {
    for (const mount of mounts) paint(mount);
    paintMemberships();
  }

  async function refreshBilling() {
    billingOffer = null;
    if (!configured()) return;
    try {
      const health = await request("/health");
      if (health.billing !== "sandbox" && health.billing !== "live") return;
      const offer = await request("/billing/plans");
      const prices = { basic: [1900, "$19/mo"], pro: [4900, "$49/mo"], business: [14900, "$149/mo"] };
      const plans = Array.isArray(offer.plans) ? offer.plans : [];
      const pricesMatch = Object.entries(prices).every(([id, expected]) => {
        const plan = plans.find((item) => item.id === id);
        return plan && plan.amountCents === expected[0] && plan.price === expected[1] && plan.currency === "USD" && plan.interval === "month";
      });
      const providers = Array.isArray(offer.providers) ? offer.providers.filter((provider) => provider === "square" || provider === "paypal") : [];
      if (!pricesMatch || !providers.length || offer.billing !== health.billing) return;
      billingOffer = { billing: health.billing, plans, providers, square: offer.square || null };
    } catch {
      billingOffer = null;
    }
  }

  function paypalApprovalAllowed(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      const allowed = billingOffer && billingOffer.billing === "live"
        ? ["www.paypal.com", "paypal.com"]
        : ["www.sandbox.paypal.com", "sandbox.paypal.com"];
      return url.protocol === "https:" && allowed.includes(host);
    } catch {
      return false;
    }
  }

  async function startSubscribe(tier, provider, record) {
    if (busy) return;
    if (provider === "paypal") {
      busy = true;
      setMessage("Opening PayPal. Nothing is charged until you approve it there.", "info");
      try {
        const result = await request("/billing/subscribe", { method: "POST", body: { tier, provider } });
        if (!paypalApprovalAllowed(result.approvalUrl)) throw new Error("PayPal did not return an approval link on the expected host. Nothing was charged.");
        location.assign(result.approvalUrl);
      } catch (error) {
        busy = false;
        setMessage(error.message || "Could not start the membership. Nothing was charged.", "bad");
      }
      return;
    }
    squareTier = tier;
    record.squareCard.hidden = false;
    record.squareConfirm.hidden = false;
    record.squareConfirm.disabled = true;
    setMessage("Loading the Square card form. QUASI does not see the card number.", "info");
    try {
      await mountSquareCard(record);
      record.squareConfirm.disabled = false;
      setMessage("Enter the card in the Square form, then confirm. Nothing is charged until Square accepts it.", "info");
    } catch (error) {
      record.squareConfirm.hidden = true;
      setMessage(error.message || "The Square card form could not be loaded. Nothing was charged.", "bad");
    }
  }

  async function mountSquareCard(record) {
    const square = billingOffer && billingOffer.square;
    const applicationId = square && square.applicationId;
    const locationId = square && square.locationId;
    if (!/^(sandbox-sq0idb-[A-Za-z0-9_-]{8,60}|sq0idp-[A-Za-z0-9_-]{8,60})$/.test(applicationId || "")) throw new Error("Square is not configured. Nothing was charged.");
    if (!/^[A-Za-z0-9]{4,40}$/.test(locationId || "")) throw new Error("Square is not configured. Nothing was charged.");
    const src = billingOffer.billing === "live" ? "https://web.squarecdn.com/v1/square.js" : "https://sandbox.web.squarecdn.com/v1/square.js";
    await loadScript(src);
    if (!window.Square || typeof window.Square.payments !== "function") throw new Error("The Square card form could not be loaded. Nothing was charged.");
    if (squareCardField && typeof squareCardField.destroy === "function") {
      try { await squareCardField.destroy(); } catch { /* replace the form */ }
    }
    const payments = window.Square.payments(applicationId, locationId);
    squareCardField = await payments.card();
    record.squareCard.replaceChildren();
    await squareCardField.attach(record.squareCard);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Square) {
        resolve();
        return;
      }
      let script = document.querySelector('script[src="' + src + '"]');
      if (!script) {
        script = document.createElement("script");
        script.src = src;
        script.async = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("The Square card form could not be loaded. Nothing was charged.")), { once: true });
    });
  }

  async function confirmSquare() {
    if (busy || !squareCardField || !squareTier) return;
    busy = true;
    paintAll();
    setMessage("Confirming the Square membership…", "info");
    try {
      const result = await squareCardField.tokenize();
      if (!result || result.status !== "OK" || typeof result.token !== "string") throw new Error("The card form could not be confirmed. Nothing was charged.");
      await request("/billing/subscribe", { method: "POST", body: { tier: squareTier, provider: "square", sourceId: result.token } });
      const me = await request("/auth/me");
      user = me.user || user;
      squareTier = "";
      setMessage(user.access && user.access.active ? membershipNotice(user) : "Square has not activated this membership yet.", user.access && user.access.active ? "good" : "info");
    } catch (error) {
      setMessage(error.message || "Could not start the Square membership. Nothing was charged.", "bad");
    } finally {
      busy = false;
      paintAll();
    }
  }

  async function cancelMembership() {
    if (busy) return;
    if (!window.confirm("Cancel this membership?")) return;
    busy = true;
    paintAll();
    try {
      await request("/billing/cancel", { method: "POST", body: {} });
      const me = await request("/auth/me");
      user = me.user || user;
      setMessage(user.access && user.access.active ? "Cancellation is scheduled. Access stays until the period ends." : "Membership canceled.", "good");
    } catch (error) {
      setMessage(error.message || "Could not cancel the membership.", "bad");
    } finally {
      busy = false;
      paintAll();
    }
  }

  async function maybeConfirmPaypal() {
    const params = new URLSearchParams(location.search);
    if (params.get("billing") !== "paypal-return" || !user) return;
    const subscriptionId = params.get("subscription_id") || "";
    if (!/^I-[A-Z0-9]{4,40}$/.test(subscriptionId)) return;
    try {
      await request("/billing/confirm", { method: "POST", body: { provider: "paypal", subscriptionId } });
      const me = await request("/auth/me");
      user = me.user || user;
      setMessage(user.access && user.access.active ? "PayPal membership is active." : "PayPal has not activated this membership yet.", user.access && user.access.active ? "good" : "info");
    } catch (error) {
      setMessage(error.message || "Could not confirm the PayPal membership.", "bad");
    }
    params.delete("billing");
    params.delete("subscription_id");
    params.delete("ba_token");
    params.delete("token");
    const next = params.toString();
    history.replaceState({}, "", location.pathname + (next ? "?" + next : "") + location.hash);
  }

  async function submitForm(event, form) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const confirm = String(data.get("confirm") || "");
    if (!email.includes("@")) return setMessage("Enter a valid email address.", "bad");
    if (password.length < 10) return setMessage("Use at least 10 characters.", "bad");
    if (mode === "signup" && password !== confirm) return setMessage("Those passwords do not match.", "bad");
    busy = true;
    setMessage(mode === "signup" ? "Creating your account…" : "Signing in…", "info");
    try {
      const path = mode === "signup" ? "/auth/signup" : "/auth/login";
      const result = await request(path, { method: "POST", body: { email, password } });
      user = result.user;
      setMessage(user && user.access && user.access.active
        ? membershipNotice(user)
        : (mode === "signup" ? "Account created. Plans are not activated." : "Signed in. Plans are not activated."), "good");
      form.reset();
      emit();
    } catch (error) {
      setMessage(error.message || "Could not sign in.", "bad");
    } finally {
      busy = false;
      paintAll();
    }
  }

  async function logout() {
    busy = true;
    paintAll();
    try { await request("/auth/logout", { method: "POST", body: {} }); } catch { /* clear the local session either way */ }
    localStorage.removeItem(TOKEN_KEY);
    user = null;
    busy = false;
    setMessage("Signed out. Ideas already on this device stay here.", "info");
    emit();
  }

  async function start() {
    await refreshBilling();
    if (configured()) {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        try {
          const result = await request("/auth/me");
          user = result.user || null;
        } catch {
          localStorage.removeItem(TOKEN_KEY);
          user = null;
        }
      }
      await maybeConfirmPaypal();
    }
    emit();
  }

  function preserveLocalApiLinks() {
    const search = location.search || "";
    if (!/^\?api=http:\/\/(127\.0\.0\.1|localhost):8787$/.test(search)) return;
    document.querySelectorAll('a[href="studio.html"], a[href="index.html"]').forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (href && !href.includes("?")) anchor.href = href + search;
    });
  }
  preserveLocalApiLinks();

  window.QuasiAuth = {
    configured,
    mount,
    start,
    mergeHookLists,
    onChange(listener) {
      listeners.add(listener);
      listener(user);
    },
    currentUser() { return user; },
    membershipNotice,
    async getLibrary() {
      const data = await request("/library");
      return data.project || null;
    },
    async saveLibrary(payload) {
      const data = await request("/library", { method: "PUT", body: payload });
      return data.project;
    },
    async listProjects() {
      const data = await request("/projects");
      return data.projects || [];
    },
    async createProject(payload) {
      const data = await request("/projects", { method: "POST", body: payload });
      return data.project;
    },
    async getProject(id) {
      const data = await request("/projects/" + encodeURIComponent(id));
      return data.project;
    },
    async deleteProject(id) {
      await request("/projects/" + encodeURIComponent(id), { method: "DELETE" });
    },
  };
})();
