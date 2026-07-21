# Field App · Total Assurance

One app for the whole team: **field techs**, **warehouse**, **shop**, and **office**.

Covers trucks & fuel, live map, repairs, inventory/parts, assets, warranties, handbook, and more — with dual auth (username/password + Google Workspace) and an audit trail.

Built for **Cloudflare** (Workers + D1 + R2 + static assets).

## Features

| Area | What it does |
|------|----------------|
| **Fuel log** | Employee, vehicle, odometer, gallons, cost, notes, receipt photo |
| **Red flags** | Decrease, large jump, first reading, same-day duplicate |
| **Yard walk** | Phone-friendly cards: expired / due soon stickers, dash cam status |
| **Repairs** | Report issues → schedule → complete; printable work list |
| **Live map** | OneStep + Verizon GPS on one map (auto-refresh) |
| **Auth** | Password users (mechanic) + optional Google Workspace SSO |
| **Audit** | Who changed what and when |
| **Reports** | Print views + fuel CSV export |

## Roles

- **admin** — full access, users, settings, audit  
- **office** — fuel, employees, vehicles, alerts, reports  
- **driver** — log own fuel, report issues  
- **mechanic** — issues workflow, vehicles/compliance  
- **viewer** — read-only reports  

## Quick start (local)

### Prerequisites

- Node.js 20+
- Cloudflare account (for deploy; local D1/R2 works offline with Wrangler)

### Install & migrate

```bash
npm install
npx wrangler d1 create fleet_db
# Put the returned database_id into wrangler.toml (database_id)

npm run db:migrate:local
npm run db:seed:local
```

Create R2 buckets once for production:

```bash
npx wrangler r2 bucket create fleet-receipts
```

### Run API + UI

Terminal 1 — Worker/API (also serves built assets if present):

```bash
npm run dev:worker
```

Terminal 2 — Vite UI with proxy to the worker:

```bash
npm run dev
```

Open http://127.0.0.1:5173

**Demo logins** (created on first API boot if DB is empty, or after seed + bootstrap):

| User | Password | Role |
|------|----------|------|
| `admin` | `ChangeMe123!` | admin |
| `mechanic` | `ChangeMe123!` | mechanic |

Change these immediately in production.

## Google Workspace login

1. In Google Cloud Console, create an OAuth **Web** client.  
2. Authorized redirect URI: `https://YOUR_DOMAIN/api/auth/google/callback`  
   (local: `http://127.0.0.1:8787/api/auth/google/callback`)  
3. Set Worker secrets:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
```

4. Set vars in `wrangler.toml` or dashboard:

- `WORKSPACE_DOMAIN` = your company domain (e.g. `totalassurance.com`)  
- `APP_BASE_URL` = public origin of the app  
- optional `GOOGLE_ALLOWED_EXTRA` = comma-separated emails  

## Deploy to Cloudflare

Production (Total Assurance account):

- **App URL:** https://total-assurance-fleet.totalassurance.workers.dev  
- **Account:** `f6da342467e60df683731c55dfc0e7b4`  
- **D1:** `fleet_db` (`9126adda-009e-4aff-8f78-dddf54be8ffa`)  
- Default login after seed/bootstrap: `admin` / `ChangeMe123!` (change immediately)

```bash
# First-time account setup
npx wrangler login
# ensure account_id in wrangler.toml points at the right account

# Create resources (once)
npx wrangler d1 create fleet_db
# Enable R2 in the dashboard, then:
# npx wrangler r2 bucket create fleet-receipts
# (uncomment [[r2_buckets]] in wrangler.toml)

npm run db:migrate          # remote schema
npm run db:seed:sheet:local # use --remote file seed for production
npm run build
npm run deploy

npx wrangler secret put SESSION_SECRET
npx wrangler secret put APP_BASE_URL   # e.g. https://total-assurance-fleet.totalassurance.workers.dev
```

### Cleaner website address (recommended)

1. In Cloudflare Dashboard open the zone for your company domain (e.g. `totalassuranceac.com`).
2. **Workers & Pages** → **total-assurance-fleet** → **Settings** → **Domains & Routes** → **Add** → **Custom domain**.
3. Use something memorable, e.g. `fleet.totalassuranceac.com` or `track.totalassuranceac.com`.
4. DNS is created automatically on that zone. Then set:

```bash
npx wrangler secret put APP_BASE_URL
# value: https://fleet.yourdomain.com
```

### Receipt photos (R2)

1. Enable **R2** once: https://dash.cloudflare.com → R2 → Purchase / Enable  
2. `npx wrangler r2 bucket create fleet-receipts`  
3. Uncomment `[[r2_buckets]]` in `wrangler.toml` and redeploy  

Receipts are stored under the `fuel-receipts/` prefix in that bucket.

## Fleet Google Sheet import

Source sheet: [Total Assurance vehicle list](https://docs.google.com/spreadsheets/d/1FSUekGeQxM6YTr8RIwjkAtNhataK_FjrVtyICvC-mP8)

Local import (replaces demo vehicles/employees with sheet data):

```bash
npm run db:migrate:sheet:local   # if upgrading an older DB
npm run db:seed:sheet:local
```

Imported fields: driver, unit, plate, year/make/model, VIN, insurance card, registration expiration, cam type, GPS tracker, phone.

Notes:
- Sheet units labeled `XXX` are stored as unique IDs (`XXX-TRAILER`, `XXX-WKW2986`, etc.).
- Registration month/year values become the **last day of that month** (e.g. `6/2025` → `2025-06-30`).
- After import, edit vehicles in the app; the sheet is no longer required as the system of record.

## Project layout

```
worker/          Hono API (auth, fuel, vehicles, issues, audit, uploads)
src/             React UI (mobile-first PWA shell)
schema.sql       D1 schema
seed.sql         Sample employees/vehicles for local demos
wrangler.toml    Cloudflare bindings
```

## Security notes

- Sessions are HTTP-only cookies.  
- Passwords use PBKDF2-SHA256 (100k iterations).  
- Receipt files live in private R2; only authenticated users can fetch via `/api/uploads/...`.  
- Restrict Google logins with `WORKSPACE_DOMAIN`.  
- Rotate the default admin password before real use.

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite frontend |
| `npm run dev:worker` | Wrangler worker + D1/R2 |
| `npm run build` | Production UI → `dist/client` |
| `npm run deploy` | Build + `wrangler deploy` |
| `npm run db:migrate:local` | Apply schema to local D1 |
| `npm run db:seed:local` | Sample fleet data |
