# QUASI / HYDRA Hook Studio

Public business site for `https://quasihydra.lalaayenglobalplaza.com` (GitHub Pages).

- `index.html` — landing page, account sign-in / create account, plan labels
- `studio.html` — HYDRA Hook Studio
- `config.js` — `window.QUASI_API` (no secrets)
- `auth.js` — browser client for the account API
- `worker/` — separate Cloudflare Worker `quasi-business-auth` and its own D1 database

Lala Ayen Global Plaza is not part of this repo. Do not point this Worker at Plaza or edit Plaza’s allowlist.

**Billing is off.** `BILLING_MODE` in `worker/wrangler.jsonc` stays `off`, so Basic, Pro, and Business render as **not for sale**. `/billing/*` returns 503 and does not charge a card. Square and PayPal subscription code is in `worker/` and runs only when that mode is `sandbox` or `live`. Do not change the mode, deploy, or apply `worker/migrations/0002_billing.sql` remotely until that is approved. Prices stay $19, $49, and $149 per month.

Cloud save calls the live Worker. Favorites stay in `localStorage` when the browser is offline.

## Live API

`config.js` sets `window.QUASI_API` to `https://quasi-business-auth.zapbo777.workers.dev`.

D1 database `quasi-business-auth` id `218f3cc3-589a-4744-b744-913350cc56e3` already has `0001_init.sql` applied. Do not apply `worker/migrations/0002_billing.sql` remotely. Do not add `limits.cpu_ms` to `worker/wrangler.jsonc`. A deploy with that field failed on the Free plan; the live Worker does not include it.

To redeploy code only:

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Full notes are in [worker/README.md](worker/README.md).

## Local site

```bash
npm start
```

Opens the static site on `http://127.0.0.1:5187`. Optional local API: `cd worker && npm run local`, then open `http://127.0.0.1:5187/index.html?api=http://127.0.0.1:8787`.

Worker tests: `cd worker && npm test`.
