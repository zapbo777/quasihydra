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
      ".qa-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}",
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
    for (const name of PLANS) {
      const pill = el("span", "qa-pill");
      pill.textContent = name + " · not activated";
      plans.append(pill);
    }
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
    signedIn.append(who, plans, signedMsg, actions);
    box.append(signedOut, signedIn);
    root.append(box);

    loginBtn.addEventListener("click", () => { mode = "login"; message = ""; paintAll(); });
    signupBtn.addEventListener("click", () => { mode = "signup"; message = ""; paintAll(); });
    signOut.addEventListener("click", () => { logout(); });
    form.addEventListener("submit", (event) => submitForm(event, form));

    const record = { root, options, signedOut, signedIn, loginBtn, signupBtn, confirmWrap, passwordField, submit, msg, email };
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
  }

  function paintAll() {
    for (const mount of mounts) paint(mount);
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
      setMessage(mode === "signup" ? "Account created. Plans are not activated." : "Signed in. Plans are not activated.", "good");
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
    if (!configured()) {
      emit();
      return;
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
      emit();
      return;
    }
    try {
      const result = await request("/auth/me");
      user = result.user || null;
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      user = null;
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
