---
name: field-app
description: >
  Operate and extend Total Assurance Field App (fleet tracker) at C:\grok\fueltracker —
  deploy, D1, roles, live map, shop NVR cameras, warehouse/shop features.
  Use when the user mentions Field App, fueltracker, live map, NVR cameras, warehouse
  truck, Cloudflare Worker deploy, or continuing prior Grok work on this app.
  Use when the user runs /field-app.
---

# Field App

## First action every session

Read **`AGENTS.md`** at the repo root (`C:\grok\fueltracker\AGENTS.md`). It is the source of truth for paths, deploy, D1, shop camera proxy, roles, and recent state. Do not re-ask for the live URL or Worker name if `AGENTS.md` has them.

If the user pasted a handoff or mentioned continuing prior work, also read **`docs/PASTE-TO-GROK-BOT.md`** for the full progress narrative (live map privacy, Box2, camera Find clips, dump/fuel/shop/tool-loan/SMS).

Also skim `git status` before editing — there is often uncommitted work.

## Default workflow

1. Confirm cwd is `C:\grok\fueltracker`.
2. Make the smallest change that solves the request (UI `src/`, API `worker/`, proxy `scripts/nvr-media-proxy.mjs`).
3. If cameras proxy changed: copy to `C:\ProgramData\TotalAssurance\nvr-tunnel\` and restart `TA-NVR-MediaProxy` (Admin / `FIX-CAMERAS-NOW.bat`).
4. Deploy when the user needs it live: `npm run deploy`.
5. Apply new SQL with `npx wrangler d1 execute fleet_db --remote --file=migrations\...` when schema/data must change in production.
6. For UI work, verify in the browser when tools allow; otherwise state what was not verified.

## Do not

- Expose or commit secrets from `.dev.vars`.
- Give Live map to field (`driver`) roles.
- Assume unassigned units disappear from the map — they stay; use pool labels like `Warehouse truck` when needed.
- Scrub camera time across motion gaps without listing clips — use `/fieldapp/segments` + clip list UX.

## Quick commands

```powershell
cd C:\grok\fueltracker
npm run deploy
npx wrangler d1 execute fleet_db --remote --command "SELECT id, unit_number, assigned_driver FROM vehicles WHERE unit_number LIKE '%Box%'"
Invoke-RestMethod http://127.0.0.1:8791/fieldapp/health
```

Live app: https://total-assurance-fleet.totalassurance.workers.dev
