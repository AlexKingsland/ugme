# Deploying Social Wall (Render)

Production runs on Render from this repo: one Docker web service + one Postgres
database, both defined in `render.yaml`. Media stays on Cloudflare R2 + the
`media.cloverkitstudio.com` CDN.

| Piece | Plan | ≈ Cost |
|---|---|---|
| Web service `social-wall` | `0.5c-512mb` (Starter) | $7/mo |
| Postgres `social-wall-db` | `0.1c-256mb` | $6/mo |
| Workspace | Hobby | $0 |

---

## 0. Local dev now uses Postgres (do this first)

The app moved from SQLite to Postgres, so `shopify app dev` needs a database URL.

1. Create a free database at **neon.tech** → new project `social-wall-dev` → copy the
   connection string (starts with `postgresql://`, ends with `?sslmode=require`).
2. Add it to `.env`: `DATABASE_URL=postgresql://…`
3. `npx prisma migrate deploy`
4. Restart `shopify app dev`. Dev data starts fresh (the old `prisma/dev.sqlite` is left
   untouched as a backup). Open the app once in admin, recreate a wall or two.

Tests use the same `DATABASE_URL` (each run makes and drops its own schema), or set
`TEST_DATABASE_URL` to keep them on a separate database.

## 1. Split dev and production into two Shopify apps

Today `shopify app dev` rewrites the app's URLs to your laptop. Before anyone else
installs it, give dev its own app:

1. `shopify app config link` → **Create a new app** → name it `Social Wall (dev)` →
   config name `dev`. This writes `shopify.app.dev.toml`.
2. Ask Claude to fill `shopify.app.dev.toml` from `shopify.app.toml` (scopes, webhooks,
   app proxy, metaobjects) and to turn off `automatically_update_urls_on_dev` in the
   production config.
3. From then on:
   - develop: `shopify app dev --config dev`
   - ship the production app: `shopify app deploy --config shopify.app.toml`
4. Install `Social Wall (dev)` on your dev store (uninstall the production one there if
   you want a clean split).

## 2. Push to GitHub

Commit everything (including `package-lock.json` and `render.yaml`) and push the branch
Render should deploy (e.g. `main`).

## 3. Create the Render services

1. render.com → **New → Blueprint** → connect GitHub → pick `AlexKingsland/ugme` and
   the branch.
2. Render reads `render.yaml` and asks for the secret values:
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` — Dev Dashboard → **Social Wall** (the
     production app) → Settings → Client ID / Client secret
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
   - `RESEND_API_KEY`, `EMAIL_FROM`
   - `TEST_SUBMITTERS` (optional)
3. **Apply**. The first deploy builds the Docker image, runs the database migration and
   starts the server. It's healthy when `/healthz` returns `ok`.

## 4. Point the domain at Render

1. Render → `social-wall` → **Settings → Custom Domains**: `social-wall.cloverkitstudio.com`
   is listed (from the Blueprint). Copy the target it shows (`social-wall-xxxx.onrender.com`).
2. Cloudflare → `cloverkitstudio.com` → **DNS → Add record**: `CNAME`, name
   `social-wall`, target `social-wall-xxxx.onrender.com`, proxy status **DNS only**
   (grey cloud) so Render can issue the certificate.
3. Back in Render, **Verify**. `https://social-wall.cloverkitstudio.com/healthz` → `ok`.

## 5. Ship the production app config

`shopify app deploy --config shopify.app.toml`

This sends the production URLs, webhooks, app proxy, theme block and checkout pixel to
the **Social Wall** app. Install it on a development store and open it once.

## 6. Friends testing

Until the app is approved for the App Store it only installs on **development stores**:

1. Partner Dashboard → **Stores → Add store → Development store**, one per friend.
2. Invite the friend as **staff** on that store.
3. Install **Social Wall** there (Dev Dashboard → Social Wall → Install app → pick store).

`BILLING_TEST=true` and `COUNT_TEST_ORDERS=true` keep upgrades as test charges and show
test orders in Analytics. Set both to `false` before real merchants install.

---

## Scaling up

Change the plan in the Render dashboard (or in `render.yaml` and push). No code changes.

| When | Web service | Database |
|---|---|---|
| Friends testing | `0.5c-512mb` ($7) | `0.1c-256mb` ($6) |
| First real merchants | `1c-2g` ($25) | `0.5c-1g` ($19) |
| More traffic | more instances (`numInstances`) or bigger plan | `1c-2g` ($40)+ |

On a bigger server you can also raise `FALLBACK_UPLOAD_MAX_MB` (e.g. 100) and
`FALLBACK_UPLOAD_CONCURRENCY`.

## Useful

- Health: `GET /healthz` → `ok` (checks the database too).
- Migrations run automatically on every deploy (`npm run docker-start`).
- The database only accepts connections from the Render service (`ipAllowList: []`).
- Logs: Render → `social-wall` → Logs.
