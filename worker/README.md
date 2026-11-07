# quasi-business-auth

Cloudflare Worker for QUASI / HYDRA Hook Studio accounts and project storage.

This Worker is separate from Lala Ayen Global Plaza. Do not edit Plaza’s Worker, Plaza routes, or Plaza `ALLOWED_ORIGINS`.

Billing is off in the committed config. `BILLING_MODE` must stay `off`. Memberships stay not for sale, and `/billing/*` returns **503**, until that value is changed to `sandbox` or `live`. Any other value, including `on`, also stays off. Phase 3 code for Square Subscriptions and PayPal Subscriptions is in this Worker. It does not run, create a charge, or read the billing tables while the mode is off.

Do not deploy this Worker, run `wrangler deploy`, put secrets in `wrangler.jsonc`, or apply `migrations/0002_billing.sql` to the remote D1 database until Lala approves that step. `0001_init.sql` is already applied remotely. `0002_billing.sql` is not.

## What it stores

D1 database `quasi-business-auth`:

- `users` — email and PBKDF2-SHA256 password hash (100,000 iterations). While billing is off, `plan_status` stays `not_activated` and a subscription row cannot grant access.
- `subscriptions` and `billing_events` — created by `migrations/0002_billing.sql` only. Not on the remote database yet.
- `sessions` — SHA-256 hash of a random session token. Raw tokens are not stored.
- `login_attempts` — signup and login rate limits.
- `projects` — `id`, `user_id`, `title`, `brief_json`, `hooks_json`, `updated_at`. One `library` row per user holds saved favorites. Named rows are briefs the studio saves.

## API

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/auth/signup` | No |
| `POST` | `/auth/login` | No |
| `POST` | `/auth/logout` | Session |
| `GET` | `/auth/me` | Session |
| `GET` / `PUT` | `/library` | Session |
| `GET` / `POST` | `/projects` | Session |
| `GET` / `PUT` / `DELETE` | `/projects/:id` | Session |
| `*` | `/billing` and `/billing/*` | **503** while `BILLING_MODE` is not `sandbox` or `live` |
| `GET` | `/billing/plans` | Sandbox or live, and only when that mode's secrets are set |
| `POST` | `/billing/subscribe` | Session. Body: `tier` (`basic`, `pro`, `business`) and `provider` (`square` or `paypal`). Square also needs `sourceId` from the Web Payments SDK (`cnon:…`). |
| `GET` | `/billing/status` | Session |
| `POST` | `/billing/cancel` | Session. Square keeps access until the period ends. PayPal cancels immediately. |
| `POST` | `/billing/confirm` | Session. PayPal return only. Access is granted only when PayPal reports `ACTIVE`. |
| `POST` | `/billing/webhooks/square` | Square signature required |
| `POST` | `/billing/webhooks/paypal` | PayPal signature verification required |

Prices are fixed in code: Basic **$19/month** (1900 cents), Pro **$49/month** (4900), Business **$149/month** (14900). The Worker refuses a provider plan whose ongoing monthly price, setup fee, or exclusive tax does not match. It does not create plans. Basic access is `basic`. Pro includes Basic. Business includes Pro and Basic. Access is returned on `/auth/me` only while `BILLING_MODE` is `sandbox` or `live` and the subscription is active.

Sandbox calls `https://connect.squareupsandbox.com` and `https://api-m.sandbox.paypal.com`. Live calls `https://connect.squareup.com` and `https://api-m.paypal.com`. A sandbox PayPal approval link is rejected in live mode.

Square webhook signatures are HMAC-SHA256 of the exact notification URL plus the raw body, compared in constant time. PayPal webhooks are accepted only when PayPal's verify endpoint returns `verification_status` `SUCCESS` and the certificate URL is `https` on `paypal.com`.

### Secrets

Set these with `npx wrangler secret put NAME` from this directory when Lala approves. Do not write the values into a file in git. `wrangler secret put` publishes a Worker version, so do not run it until a deploy is approved. Square plan secrets are **subscription plan variation** IDs. PayPal plan secrets are billing plan IDs (`P-` plus 24 characters). The Square webhook URL secret must be the exact URL registered in Square.

Sandbox:

- `SQUARE_SANDBOX_ACCESS_TOKEN`
- `SQUARE_SANDBOX_APPLICATION_ID` (`sandbox-sq0idb-…`)
- `SQUARE_SANDBOX_LOCATION_ID`
- `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_SANDBOX_WEBHOOK_URL`
- `SQUARE_SANDBOX_PLAN_BASIC`
- `SQUARE_SANDBOX_PLAN_PRO`
- `SQUARE_SANDBOX_PLAN_BUSINESS`
- `PAYPAL_SANDBOX_CLIENT_ID`
- `PAYPAL_SANDBOX_CLIENT_SECRET`
- `PAYPAL_SANDBOX_WEBHOOK_ID`
- `PAYPAL_SANDBOX_PLAN_BASIC`
- `PAYPAL_SANDBOX_PLAN_PRO`
- `PAYPAL_SANDBOX_PLAN_BUSINESS`

Production, only after a separate live-billing approval:

- `SQUARE_LIVE_ACCESS_TOKEN`
- `SQUARE_LIVE_APPLICATION_ID` (`sq0idp-…`)
- `SQUARE_LIVE_LOCATION_ID`
- `SQUARE_LIVE_WEBHOOK_SIGNATURE_KEY`
- `SQUARE_LIVE_WEBHOOK_URL`
- `SQUARE_LIVE_PLAN_BASIC`
- `SQUARE_LIVE_PLAN_PRO`
- `SQUARE_LIVE_PLAN_BUSINESS`
- `PAYPAL_LIVE_CLIENT_ID`
- `PAYPAL_LIVE_CLIENT_SECRET`
- `PAYPAL_LIVE_WEBHOOK_ID`
- `PAYPAL_LIVE_PLAN_BASIC`
- `PAYPAL_LIVE_PLAN_PRO`
- `PAYPAL_LIVE_PLAN_BUSINESS`

Session cookie: `quasi_session`; `HttpOnly`; `Secure`; `SameSite=None`; `Path=/`; no `Domain` (host-only on the Worker). Signup and login also return a bearer token because `quasihydra.lalaayenglobalplaza.com` and `*.workers.dev` are different sites. The Pages script stores that token in `localStorage` and sends `Authorization: Bearer`. State-changing requests must send `X-Quasi-Client: 1`.

CORS allowlist (credentials allowed only for these origins):

- `https://quasihydra.lalaayenglobalplaza.com`
- `https://www.quasihydra.lalaayenglobalplaza.com`

Live host (set in the site root `config.js`):

`https://quasi-business-auth.zapbo777.workers.dev`

D1 `database_id` in `wrangler.jsonc` is `218f3cc3-589a-4744-b744-913350cc56e3`. That database already exists and `0001_init.sql` has been applied remotely. Do not apply `0002_billing.sql` remotely. Do not add `limits.cpu_ms`. Deploy failed on the Free plan when that field was set; the live Worker was deployed without it.

## Redeploy

Do not deploy this branch, and do not change `BILLING_MODE`, until Lala approves. The commands below are the existing path for the live Worker. They are not a step in preparing billing.

From this directory, on the Cloudflare account that owns QUASI (not Plaza):

```bash
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

Leave `account_id` unset. Do not commit API tokens. Do not run `d1 create` again.

Check:

```bash
curl -sS "https://quasi-business-auth.zapbo777.workers.dev/health"
```

Expect `"billing":"off"` and `"service":"quasi-business-auth"`.

Password hashing uses PBKDF2 at 100,000 iterations. The Free plan CPU cap is 10ms, and this config does not raise it. If signup or login returns Cloudflare error 1102, the request ran out of CPU. Do not fix that by adding `limits.cpu_ms` on this Free account.

## Local checks

Worker unit tests (no Cloudflare account):

```bash
cd worker
npm test
```

Optional local API for the static site (not production):

```bash
cd worker
PBKDF2_ITERATIONS=100000 npm run local
```

That listens on `http://127.0.0.1:8787` and allows `http://127.0.0.1:5187`. In another terminal, from the repo root:

```bash
npm start
```

Open:

`http://127.0.0.1:5187/index.html?api=http://127.0.0.1:8787`

The `api` query is accepted only for that localhost port. Production keeps using `window.QUASI_API`.

`wrangler dev` against local D1. This does not touch the remote database. Do not add `--remote`.

```bash
npx wrangler d1 migrations apply quasi-business-auth --local
npx wrangler dev
```

To call the dev Worker from the local site, create `worker/.dev.vars` (gitignored) with a single line:

```bash
ALLOWED_ORIGINS=https://quasihydra.lalaayenglobalplaza.com,https://www.quasihydra.lalaayenglobalplaza.com,http://127.0.0.1:5187,http://localhost:5187
```

Do not put that localhost origin in the committed `wrangler.jsonc` vars. Do not put secrets in the repo.
