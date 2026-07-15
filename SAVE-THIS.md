# How to keep Total Assurance Fleet Tracker safe

Your app already **runs in the cloud**. Saving it means protecting three things:

1. **The live website** (Cloudflare Worker)  
2. **Your data** (fuel logs, vehicles, users in D1)  
3. **The source code** (so you can fix or rebuild later)

---

## What you have right now

| Piece | Where it lives | Status |
|--------|----------------|--------|
| Live app | https://total-assurance-fleet.totalassurance.workers.dev | Hosted by Cloudflare |
| Cloudflare account | `ta.chrismarroquin@gmail.com` · account `f6da342467e60df683731c55dfc0e7b4` | You control this |
| Database (D1) | `fleet_db` · id `9126adda-009e-4aff-8f78-dddf54be8ffa` | On Cloudflare |
| Source code | `C:\grok\fueltracker` on this PC | **Must back up** — not on GitHub yet |

The website will **not** disappear just because you close your laptop.  
It **can** be lost if someone deletes the Worker/D1, the Cloudflare account is closed, or the only copy of the code on this PC is wiped.

---

## Step 1 — Protect the live app (Cloudflare)

1. **Do not delete**  
   - Worker: `total-assurance-fleet`  
   - D1 database: `fleet_db`  
   - (Later) R2 bucket for receipts  

2. **Secure the account**  
   - Change password if it was ever shared in chat  
   - Turn on **two-factor authentication** (2FA)  
   - Keep recovery email/phone current  

3. **Optional but smart: short domain**  
   - Workers → total-assurance-fleet → Custom domain  
   - e.g. `fleet.totalassuranceac.com`  
   - Easier for staff; still runs if workers.dev name changes  

4. **Secrets stay on Cloudflare** (already set)  
   - `SESSION_SECRET`  
   - `APP_BASE_URL`  
   - `ONESTEP_USER` / `ONESTEP_PASS`  
   - `VERIZON_USER` / `VERIZON_PASS`  
   - Never put these in email or a public folder  

---

## Step 2 — Back up the source code (critical)

### Option A — Zip (fastest, do this today)

1. Copy the whole folder:  
   `C:\grok\fueltracker`
2. Zip it (right‑click → Send to → Compressed folder)  
3. Store copies in **at least two places**, for example:  
   - Google Drive / OneDrive (company Google Workspace)  
   - External USB drive  
4. Name it with the date: `fleet-tracker-2026-07-15.zip`

### Option B — GitHub private repo (best long-term)

1. Install [Git for Windows](https://git-scm.com/download/win)  
2. Create a **private** repo on GitHub (company or personal account you control)  
3. From PowerShell in `C:\grok\fueltracker`:

```powershell
git init
git add .
git commit -m "Total Assurance Fleet Tracker - production snapshot"
git branch -M main
git remote add origin https://github.com/YOUR_ORG/fleet-tracker.git
git push -u origin main
```

4. Only invite people you trust (private repo)

**Never commit** `.dev.vars`, passwords, or API secrets.

---

## Step 3 — Back up the database regularly

Cloudflare keeps D1 online, but you should export snapshots:

### Manual export (any time)

```powershell
cd C:\grok\fueltracker
$env:CLOUDFLARE_ACCOUNT_ID = "f6da342467e60df683731c55dfc0e7b4"
npx wrangler d1 export fleet_db --remote --output "backups\fleet-db-$(Get-Date -Format yyyy-MM-dd).sql"
```

Save that `.sql` file to Drive/USB.

### Suggested schedule

| How often | What |
|-----------|------|
| Weekly | D1 export to Google Drive |
| After big changes | Zip of source code + D1 export |
| Monthly | Confirm site loads + login works |

---

## Step 4 — Make sure it “always works”

| Check | Why |
|--------|-----|
| Site loads | https://total-assurance-fleet.totalassurance.workers.dev |
| Login works | Admin + one tech account |
| Fuel log | Save a test entry |
| Live map | GPS still returns units (OneStep/Verizon passwords valid) |
| Cloudflare paid/free plan | Stay logged into account; keep payment method if you use paid features (R2, etc.) |

### If GPS stops

- OneStep or Verizon **password change** breaks map until Worker secrets are updated:  
  `npx wrangler secret put ONESTEP_PASS` (etc.)

### If you need to redeploy from a backup PC

```powershell
cd path\to\fueltracker
npm install
npx wrangler login
$env:CLOUDFLARE_ACCOUNT_ID = "f6da342467e60df683731c55dfc0e7b4"
npm run build
npx wrangler deploy
```

Secrets already on Cloudflare usually **do not** need re-entering unless you create a new Worker.

---

## Step 5 — Who owns what

Write this down (password manager or office safe):

- Cloudflare login email  
- Admin app username (not the default forever — change `ChangeMe123!`)  
- Where code zip / GitHub lives  
- Where DB backups live  
- OneStep & Verizon accounts used for GPS  

---

## Quick “am I safe?” checklist

- [ ] Cloudflare 2FA on  
- [ ] Admin password changed from default  
- [ ] Zip (or GitHub) of `C:\grok\fueltracker` in Drive + one other place  
- [ ] At least one D1 `.sql` export saved  
- [ ] Bookmarked live URL (and custom domain if you set one)  
- [ ] Second person (office) knows where backups are  

---

## Bottom line

| Question | Answer |
|----------|--------|
| Does the app keep running if my PC dies? | **Yes** — it’s on Cloudflare |
| Can I rebuild if something is deleted? | **Only if** you have the source zip/GitHub |
| Can I restore fuel data? | **Only if** you export D1 backups |
| What should I do today? | Zip the folder → Drive + USB · export D1 · enable 2FA |

This file lives in your project: `SAVE-THIS.md` — keep it with your backups.
