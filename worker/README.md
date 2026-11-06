# quasi-business-auth

Cloudflare Worker for QUASI / HYDRA Hook Studio accounts and project storage.

This Worker is separate from Lala Ayen Global Plaza. Do not edit Plaza’s Worker, Plaza routes, or Plaza `ALLOWED_ORIGINS`.

Billing is off. `POST /billing/*` returns **503** and does not create a charge, even if `BILLING_MODE` is changed. Phase 3 (Square/PayPal) is not implemented.

## What it stores

D1 database `quasi-business-auth`:

- `users` — email and PBKDF2-SHA256 password hash (100,000 iterations). `plan_status` stays `not_activated`.
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
| `*` | `/billing` and `/billing/*` | **503**, billing off |

Session cookie: `quasi_session`; `HttpOnly`; `Secure`; `SameSite=None`; `Path=/`; no `Domain` (host-only on the Worker). Signup and login also return a bearer token because `quasihydra.lalaayenglobalplaza.com` and `*.workers.dev` are different sites. The Pages script stores that token in `localStorage` and sends `Authorization: Bearer`. State-changing requests must send `X-Quasi-Client: 1`.

CORS allowlist (credentials allowed only for these origins):

- `https://quasihydra.lalaayenglobalplaza.com`
- `https://www.quasihydra.lalaayenglobalplaza.com`

Live host (set in the site root `config.js`):

`https://quasi-business-auth.zapbo777.workers.dev`

D1 `database_id` in `wrangler.jsonc` is `218f3cc3-589a-4744-b744-913350cc56e3`. That database already exists and the migration has been applied remotely. Do not add `limits.cpu_ms`. Deploy failed on the Free plan when that field was set; the live Worker was deployed without it.

## Redeploy

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

`wrangler dev` against local D1 (`database_id` in `wrangler.jsonc` is the remote database):

```bash
npx wrangler d1 migrations apply quasi-business-auth --local
npx wrangler dev
```

To call the dev Worker from the local site, create `worker/.dev.vars` (gitignored) with a single line:

```bash
ALLOWED_ORIGINS=https://quasihydra.lalaayenglobalplaza.com,https://www.quasihydra.lalaayenglobalplaza.com,http://127.0.0.1:5187,http://localhost:5187
```

Do not put that localhost origin in the committed `wrangler.jsonc` vars. Do not put secrets in the repo.
