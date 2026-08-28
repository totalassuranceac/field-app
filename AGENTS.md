# Field App (Total Assurance) — agent handoff

You are working on **Total Assurance Field App**: fleet + warehouse + shop ops for an HVAC company.

## Grab the app

| Item | Value |
|------|--------|
| Source | `C:\grok\fueltracker` (this PC is often the shop NUC) |
| Live URL | https://total-assurance-fleet.totalassurance.workers.dev |
| Worker name | `total-assurance-fleet` |
| Cloudflare account id | `f6da342467e60df683731c55dfc0e7b4` |
| D1 database | `fleet_db` · id `9126adda-009e-4aff-8f78-dddf54be8ffa` |
| Stack | React (`src/`) + Cloudflare Worker (`worker/`) + D1 + Wrangler assets |

```powershell
cd C:\grok\fueltracker
npm install          # if needed
npm run deploy       # vite build + wrangler deploy (production)
```

Local UI (optional): `npm run dev` (Vite) + `npm run dev:worker` (API).

D1 SQL (production):

```powershell
npx wrangler d1 execute fleet_db --remote --command "SELECT ..."
npx wrangler d1 execute fleet_db --remote --file=migrations\NNN_name.sql
```

Never commit `.dev.vars` or secrets. Secrets live on Cloudflare (`wrangler secret put ...`).

More ops/backup: `SAVE-THIS.md`. Product overview: `README.md`.

## Architecture (where to edit)

| Concern | Primary files |
|---------|----------------|
| API routes | `worker/index.ts` |
| Auth / roles / `ROLE_PERMS` | `worker/auth.ts` |
| UI permissions (`can()`) | `src/api.ts` |
| Nav / menus | `src/components/Layout.tsx` |
| Live map GPS | `worker/gps.ts`, `src/pages/LiveMapPage.tsx` |
| Security cameras | `src/pages/WarehouseCamerasPage.tsx`, `worker/nvrProxy.ts`, `scripts/nvr-media-proxy.mjs` |
| Styles | `src/styles.css` |
| How-to guides copy | `src/howtoContent.ts` |
| Schema / migrations | `schema.sql`, `migrations/NNN_*.sql` |

**Roles:** `admin`, `office`, `supervisor`, `warehouse` (stored as `office` + `is_warehouse=1`), `mechanic`, `driver` (field), `viewer`.

## Hard rules for this product

1. **Deploy after UI/API changes** the user needs live: `npm run deploy`.
2. **UI changes:** verify in the browser when tools allow; otherwise say what you could not verify.
3. **Do not** invent GitHub remotes / force-push; ask before destructive git/cloud ops.
4. Prefer small, focused diffs — no drive-by refactors.
5. Field techs (`driver`) must **not** see Live map / others’ locations (`viewLiveMap`).
6. Camera playback: NVR is **motion-only**; quiet gaps have no video. Prefer **clip list near picked time**, not blind scrubbing.

## Shop PC — security cameras (critical)

Cameras go: Field App → Worker → Cloudflare tunnel → **local** `nvr-media-proxy` → Hikvision NVR (+ optional Wyze).

| Item | Path / note |
|------|-------------|
| Repo proxy source | `scripts/nvr-media-proxy.mjs` |
| Installed copy | `C:\ProgramData\TotalAssurance\nvr-tunnel\nvr-media-proxy.mjs` |
| Launch wrapper | `run-proxy.mjs` (sets port **8791**) |
| Windows services | `TA-NVR-MediaProxy`, `TA-NVR-Tunnel` (nssm; **needs Admin** to restart) |
| Health | `http://127.0.0.1:8791/fieldapp/health` |
| Clip API | `/fieldapp/clip?channel=&start=&end=&mode=at\|prev\|next` |
| Segments list | `/fieldapp/segments?channel=&around=&padMin=60` |
| Quick fix | Double-click `scripts\FIX-CAMERAS-NOW.bat` (Admin) — copies proxy + restarts |

After editing `nvr-media-proxy.mjs`, copy to ProgramData and restart the service (Admin). Old proxy → HTML 404 on new `/fieldapp/*` routes.

NVR search times often use **local wall clock labeled with trailing Z** (not true UTC). Proxy handles `local` + `utc` formats — keep that behavior.

## Recent product state (as of 2026-08-19)

Full pasteable narrative for a new chat: `docs/PASTE-TO-GROK-BOT.md`.

### Done + deployed (this arc)
- **Live map privacy:** `viewLiveMap` only — not field/`driver`. API gated on `/live/positions` + `/tracking/health`.
- **Box2 warehouse truck:** DB unit `Box2`, `assigned_driver='Warehouse truck'`, no employee; still on map. GPS must not fall back to device name when unassigned. Assign UI: warehouse/pool checkbox. Migration `069` applied remote.
- **Camera Find clips:** motion segment list near time, tap to play, Prev/Next, Wider search; long segments land near pick. Proxy `/fieldapp/segments` + Worker `/warehouse-cameras/segments`. Shop proxy was updated/restarted on NUC.

### In tree (often uncommitted — check `git status`)
- Dump runs + dump-specific OCR (`DumpRunsPage`, `068_dump_runs.sql`) — Dump nav Warehouse only.
- Fuel alerts: group by unit, receipt modal, void duplicate, print-for-tech.
- Shop work log / Done today / printable tech receipts (`067`).
- Tool loan ack pre-filled date; paperwork/charge migrations `065`–`066`.
- Twilio A2P / Messaging Service (`sms.ts`) — campaign may still need approval (30034).
- NVR tunnel / Wyze helper scripts under `scripts/`.

### Owner preferences
- Emergency camera find = clip list, not scrubbing quiet gaps.
- Field must not see others on the map.
- Prefer deploy when staff need the change live.

## Permissions pattern

- UI: add key to `ALL_PERMISSIONS` + `can()` map in `src/api.ts`.
- API: add matching entry in `ROLE_PERMS` in `worker/auth.ts` and `requireRoles(...)` on routes.
- Keep UI and worker lists in sync.

## When stuck

- Cameras blank / 530: tunnel or media proxy down on shop PC → `FIX-CAMERAS-NOW.bat`.
- Map empty: OneStep/Verizon secrets or password rotate.
- D1 “account not authorized”: Wrangler login / account id; `--remote` uses Cloudflare.
- Warehouse role looks like office in DB: expected — `is_warehouse=1`; `toPublicUser` maps to `warehouse`.
