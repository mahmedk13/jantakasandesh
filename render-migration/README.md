# Render Migration — Step-by-Step (prepared, not yet executed)

Status: **staged only**. Nothing here is committed or active yet. This folder can be
deleted with zero effect on production at any point before you decide to go ahead.

## Why

Vercel's "Fast Origin Transfer" free-tier usage hit 100% (2026-10-19). Two code
fixes already shipped to Vercel today to reduce that (static asset split in
`vercel.json`, `/feed` edge caching) — this migration is the fallback plan if
those aren't enough, or if you decide a fixed-price host is just simpler long-term.

**Confirmed already-portable** (no code changes needed, verified in server.js):
- MongoDB Atlas, ImageKit, Cloudinary — all external services, connected via env vars only.
- Sessions — stored in MongoDB via `connect-mongo`, not in-memory.
- Server already reads `process.env.PORT` (`server.js` line ~2250) — Render-compatible out of the box.
- `app.set('trust proxy', 1)` already set — correct behavior behind Render's proxy too.

## Prerequisites

- A Render account (https://render.com) — sign up with GitHub for easiest repo access.
- This repo accessible to Render (GitHub App install, same as Vercel's).

**Shortcut available:** `render.yaml` is now live at the repo root — in Render, choose
"New +" -> "Blueprint" instead of "Web Service" and it pre-fills everything in Step 1
(plan, region, build/start commands, env var names) automatically; you'd still need to
fill in the actual secret values. Steps below are the manual equivalent if you'd rather
not use Blueprint.

## Step 1 — Create the web service

1. Render dashboard → **New +** → **Web Service**.
2. Connect this GitHub repo (`mahmedk13/jantakasandesh`).
3. Settings:
   - **Name**: `janta-ka-sandesh` (or anything — this becomes part of the temporary `<name>.onrender.com` URL)
   - **Region**: pick whichever is closest to India in Render's list (e.g. Singapore) for lowest latency.
   - **Branch**: `main`
   - **Runtime**: Node
   - **Build Command**: `npm ci`
   - **Start Command**: `node server.js`
   - **Instance Type**: **Starter ($7/month)** — NOT Free. Free spins down after 15 min idle, unacceptable for a live news site.
4. Don't click "Create Web Service" yet — add environment variables first (next step), or add them right after and let it redeploy once.

## Step 2 — Environment variables

Add every one of these in Render's **Environment** tab (values come from your existing `.env` / Vercel project settings — never paste them into chat/AI tools):

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

**Not needed here** (these belong to separate GitHub Actions workflows, not the web service): `GDRIVE_*` (backup-to-gdrive.js), `RESEND_API_KEY` / `SITE_URL` (sync-pbshabd.js) — those workflows are unaffected by this migration and keep running exactly as-is.

`PORT` — don't set this; Render injects it automatically and the app already reads `process.env.PORT`.

## Step 3 — Deploy and test on the temporary URL

1. Deploy. Render gives you `https://<name>.onrender.com` immediately — this does NOT touch your live domains, fully safe to test.
2. Checklist before going further:
   - [ ] Homepage loads with real news (confirms MongoDB connection)
   - [ ] An article page (`/news/<slug>`) loads, correct branding/images
   - [ ] `/styles.css`, logo, og-banner load correctly
   - [ ] Admin login works (`/login`), can publish/edit an article (confirms session + ImageKit upload work)
   - [ ] `/sitemap.xml`, `/sitemap-news.xml`, `/feed` all return valid XML
   - [ ] Manually hit each cron endpoint once with the right header to confirm they work:
     `curl -H "Authorization: Bearer <CRON_SECRET>" https://<name>.onrender.com/api/cron/fetch-rss`
     (repeat for `/generate-daily-article` and `/generate-aaj-ka-itihas`)

## Step 4 — Replace Vercel's cron jobs

Vercel's `crons` in `vercel.json` only fire for Vercel deployments — they won't run once you're off Vercel. `render-cron.yml` in this folder is a ready-made GitHub Actions replacement using the exact same 3 schedules.

1. Edit `render-cron.yml`: replace `https://REPLACE-ME.onrender.com` with your real Render URL (temporary `.onrender.com` one is fine for testing; update again after DNS cutover if you prefer to call the real domain instead).
2. Add a GitHub repo secret `CRON_SECRET` matching what you set in Render.
3. Move the file into `.github/workflows/render-cron.yml` and commit — only then does it start actually running.
4. Once confirmed working, you can remove the `crons` block from `vercel.json` (or leave it — it's harmless if nothing's deployed there anymore, but tidy it up if you fully decommission Vercel).

## Step 5 — Custom domains + DNS cutover (do this LAST, only once Steps 1-4 are fully verified)

**Important — check for conflicts with any in-progress Cloudflare setup first.** If you're also partway through pointing Cloudflare at Vercel (from the earlier conversation), decide ONE final target before touching DNS again: either Cloudflare → Vercel, or DNS → Render directly (Render also supports being proxied through Cloudflare if you want that CDN layer in front of Render instead). Don't leave both half-configured.

1. In Render, add your custom domains (`voiceofkranti.com`, `www.voiceofkranti.com`, `jantakasandesh.in`, `www.jantakasandesh.in`) under the service's **Settings → Custom Domains**. Render shows you the exact DNS records it needs (similar to Vercel's own domain settings page).
2. Update DNS (at whichever provider currently holds the authoritative zone — GoDaddy or Cloudflare, depending on what you decided) to point at Render's provided records instead of Vercel's.
3. Watch certificate issuance (Render auto-provisions via Let's Encrypt) complete before relying on HTTPS.
4. Re-run the full Step 3 checklist against the REAL domain once DNS propagates.

## Rollback plan

Until you change DNS in Step 5, the live site keeps running on Vercel completely untouched — this entire migration is zero-risk right up to that point. If anything looks wrong after cutover, just revert the DNS record(s) back to Vercel's values; propagation is the only delay, no app-level rollback needed since Vercel's deployment is still live underneath.
