# QUASI / HYDRA Hook Studio

Public business site for `https://quasihydra.lalaayenglobalplaza.com` (GitHub Pages).

- `index.html` — landing page, account sign-in / create account, plan labels
- `studio.html` — HYDRA Hook Studio
- `config.js` — `window.QUASI_API` (no secrets)
- `auth.js` — browser client for the account API
- `worker/` — separate Cloudflare Worker `quasi-business-auth` and its own D1 database

Lala Ayen Global Plaza is not part of this repo. Do not point this Worker at Plaza or edit Plaza’s allowlist.

**Billing is off.** Basic, Pro, and Business render as **not activated**. There is no checkout, charge, or subscription endpoint. `/billing/*` on the Worker returns 503.

Cloud save uses the Worker when `config.js` has a real workers.dev host. Until then the studio keeps favorites in `localStorage`.

## Deploy the API (Ara)

The Worker is not deployed from this repository automatically. Placeholder host in `config.js`:

`https://quasi-business-auth.PLACEHOLDER.workers.dev`

From `worker/`:

```bash
cd worker
npm install
npx wrangler login
npx wrangler d1 create quasi-business-auth
```

Paste the printed `database_id` over `00000000-0000-0000-0000-000000000000` in `worker/wrangler.jsonc`.

```bash
npx wrangler d1 migrations apply quasi-business-auth --remote
npx wrangler deploy
```

Put the printed `https://quasi-business-auth.<subdomain>.workers.dev` URL into `config.js` as `window.QUASI_API`, then commit it so Pages updates.

Full notes, CORS, cookie name, and the local test URL are in [worker/README.md](worker/README.md).

Signup and login need Workers Paid. The Free plan’s 10ms CPU limit is too small for PBKDF2 (100,000 iterations).

## Local site

```bash
npm start
```

Opens the static site on `http://127.0.0.1:5187`. Optional local API: `cd worker && npm run local`, then open `http://127.0.0.1:5187/index.html?api=http://127.0.0.1:8787`.

Worker tests: `cd worker && npm test`.
