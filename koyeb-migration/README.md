# Koyeb Migration — Step-by-Step (staged, not yet executed)

Status: **staged only**. Nothing here is committed to `.github/workflows/` or active yet.
This folder can be deleted with zero effect on production at any point before you decide
to go ahead. The parallel `render-migration/` folder (and the live `render.yaml` at the
repo root) are left untouched — this is an independent option, not a replacement.

## Why Koyeb over Render (per our discussion, 2026-10-30)

Both are free-tier fallbacks for if Vercel ever pauses the site again. Chosen Koyeb because
its free instance includes **100GB/month outbound bandwidth** (vs Render's 5GB) and bills
overage instead of suspending the whole site when a payment method is on file — a better
fit given this site's bot-heavy traffic pattern. Tradeoffs accepted knowingly:
- Free instance only deploys in **Frankfurt or Washington, D.C.** (no Singapore/Asia region
  for the free tier) — higher latency for Indian visitors than Render's Singapore option.
- Spins down (scale-to-zero) after **1 hour** of no inbound traffic, then cold-starts on the
  next request. Accepted since sub-1s latency for real visitors isn't a priority here, same
  reasoning as the Render free-tier decision.

**Confirmed already-portable** (same as the Render migration — verified in server.js):
- MongoDB Atlas, ImageKit, Cloudinary — external services, connected via env vars only.
- Sessions — stored in MongoDB via `connect-mongo`, not in-memory.
- Server reads `process.env.PORT` (`server.js` line ~2256) and `npm start` runs `node server.js`
  (see `package.json`) — Koyeb's buildpack builder auto-detects Node.js apps via this script,
  no Procfile or custom run-command needed.
- `app.set('trust proxy', 1)` already set — correct behavior behind Koyeb's proxy too.

## Prerequisites

- A Koyeb account (https://app.koyeb.com) — sign up with GitHub for easiest repo access.
- A credit card on file (Koyeb requires one even for the free instance, to prevent abuse —
  a $29 pre-authorization hold is placed and immediately released, you are NOT charged as
  long as you stay within the single free instance's limits).
- The [Koyeb CLI](https://www.koyeb.com/docs/build-and-deploy/cli/installation) installed
  locally, OR just use the Koyeb control panel (dashboard) — both are documented below.

## Step 1 — Create the free Web Service

### Option A: Koyeb CLI (reproducible, recommended)

```sh
koyeb login
koyeb app init janta-ka-sandesh \
  --git github.com/mahmedk13/jantakasandesh \
  --git-branch main \
  --git-builder buildpack \
  --instance-type free \
  --regions fra \
  --ports 3000:http \
  --routes /:3000 \
  --env NODE_ENV=production \
  --env PORT=3000
```

- `--regions fra` = Frankfurt (use `was` for Washington, D.C. instead if you prefer).
- `--instance-type free` is what keeps this at $0 — don't change this to an `eco-*` or
  standard type unless you've decided to pay.
- Port `3000` matches `server.js`'s fallback default; Koyeb injects its own `PORT` env var
  at runtime regardless, so the app will bind correctly either way.
- This command only creates the App/Service — you still add the secret env vars in Step 2
  before (or right after) your first deploy.

### Option B: Koyeb control panel

1. Dashboard → **Create Web Service** → choose **GitHub** → select this repo, branch `main`.
2. Builder: **buildpack** (auto-detects Node.js + `npm start` — no Dockerfile needed).
3. Service type: **Web**. Region: **Frankfurt** (or Washington, D.C.). Instance type: **Free**.
4. Exposed port: `3000` (or whatever `PORT` Koyeb's UI defaults to — either works since the
   app reads `process.env.PORT`).
5. Don't click Deploy yet — add the environment variables first (next step).

## Step 2 — Environment variables

Add every one of these as **Secrets** (Koyeb's term for encrypted env vars) in the Service's
**Environment variables** section — same values as your existing `.env` / Vercel project
settings. Never paste actual secret values into chat/AI tools.

| Variable | Needed for |
|---|---|
| `NODE_ENV` | set to `production` |
| `MONGODB_URI` | database connection |
| `ADMIN_USERNAME` | admin login |
| `ADMIN_PASSWORD` | admin login |
| `SESSION_SECRET` | session cookie signing |
| `CRON_SECRET` | protects `/api/cron/*` endpoints — reuse your existing value, or generate a new one and update the cron workflow (Step 4) to match |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | legacy media reads |
| `IMAGEKIT_PUBLIC_KEY` / `IMAGEKIT_PRIVATE_KEY` / `IMAGEKIT_URL_ENDPOINT` | all new image/PDF uploads |
| `GEMINI_API_KEY` | AI content generation |
| `GROQ_API_KEY` | AI content generation |
| `NEWSDATA_API_KEY` | RSS/news import |
| `GNEWS_API_KEY` | RSS/news import |
| `CURRENTS_API_KEY` | RSS/news import |
| `PBSHABD_EMAIL` / `PBSHABD_PASSWORD` | PB SHABD admin-triggered sync inside server.js |

**Not needed here** (belong to separate GitHub Actions workflows, unaffected by this
migration): `GDRIVE_*` (backup-to-gdrive.js), `RESEND_API_KEY` / `SITE_URL` (sync-pbshabd.js).

`PORT` — Koyeb injects this automatically; the app already reads `process.env.PORT`, so you
don't need to set it manually (the CLI example above sets it only to be explicit).

## Step 3 — Deploy and test on the temporary URL

1. Deploy. Koyeb gives you `https://<app-name>-<org>.koyeb.app` immediately — this does NOT
   touch your live domains, fully safe to test.
2. Checklist before going further:
   - [ ] Homepage loads with real news (confirms MongoDB connection)
   - [ ] An article page (`/news/<slug>`) loads, correct branding/images
   - [ ] `/styles.css`, logo, og-banner load correctly
   - [ ] Admin login works (`/login`), can publish/edit an article (confirms session + ImageKit upload work)
   - [ ] `/sitemap.xml`, `/sitemap-news.xml`, `/feed` all return valid XML
   - [ ] Manually hit each cron endpoint once with the right header to confirm they work:
     `curl -H "Authorization: Bearer <CRON_SECRET>" https://<app-name>-<org>.koyeb.app/api/cron/fetch-rss`
     (repeat for `/generate-daily-article` and `/generate-aaj-ka-itihas`)
   - [ ] After ~1 hour with no traffic, confirm the cold-start behavior is tolerable (first
     request after the gap should still succeed, just slower)

## Step 4 — Replace Vercel's cron jobs

Vercel's `crons` in `vercel.json` only fire for Vercel deployments — they won't run once
you're off Vercel. `koyeb-cron.yml` in this folder is a ready-made GitHub Actions replacement
using the exact same 3 schedules as `render-cron.yml`.

1. Edit `koyeb-cron.yml`: replace `https://REPLACE-ME.koyeb.app` with your real Koyeb URL.
2. Add a GitHub repo secret `CRON_SECRET` matching what you set in Koyeb's environment
   variables (reuse the same secret if `render-cron.yml` already added one).
3. Move the file into `.github/workflows/koyeb-cron.yml` and commit — only then does it
   start actually running.
4. Once confirmed working, you can remove the `crons` block from `vercel.json` (or leave
   it — harmless if nothing's deployed there anymore).

## Step 5 — Custom domains + DNS cutover (do this LAST, only once Steps 1-4 are fully verified)

1. In Koyeb, add your custom domains (`voiceofkranti.com`, `www.voiceofkranti.com`,
   `jantakasandesh.in`, `www.jantakasandesh.in`) under the Service's **Domains** settings.
   Koyeb shows you the exact DNS records (CNAME) needed — free tier includes up to 10
   custom domains, so all 4 fit comfortably.
2. Update DNS at whichever provider currently holds the authoritative zone to point at
   Koyeb's provided records instead of Vercel's.
3. Koyeb auto-provisions TLS — watch for certificate issuance to complete before relying
   on HTTPS.
4. Re-run the full Step 3 checklist against the REAL domain once DNS propagates.

## Rollback plan

Until you change DNS in Step 5, the live site keeps running on Vercel completely
untouched — this entire migration is zero-risk right up to that point. If anything looks
wrong after cutover, just revert the DNS record(s) back to Vercel's values; propagation is
the only delay, no app-level rollback needed since Vercel's deployment is still live
underneath.
