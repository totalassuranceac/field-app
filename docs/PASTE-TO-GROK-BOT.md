# Paste this into a new Grok Bot chat

Copy everything inside the fence below.

```
Read AGENTS.md and use /field-app. Continue Total Assurance Field App at C:\grok\fueltracker. Do not start from scratch — honor the progress and decisions below.

## Grab / deploy
- Repo: C:\grok\fueltracker (often the shop NUC)
- Live: https://total-assurance-fleet.totalassurance.workers.dev
- Worker: total-assurance-fleet · CF account f6da342467e60df683731c55dfc0e7b4
- D1: fleet_db · 9126adda-009e-4aff-8f78-dddf54be8ffa
- Deploy: npm run deploy
- D1 prod: npx wrangler d1 execute fleet_db --remote --command "..." or --file=migrations\NNN.sql
- Never commit .dev.vars; secrets on Cloudflare

## Stack
React src/ + Worker worker/ + D1 + Wrangler assets. Roles: admin, office, supervisor, warehouse (DB: office+is_warehouse=1), mechanic, driver=field, viewer.

## Progress already shipped / in tree (honor this)

### Live map privacy (DONE + deployed)
- Field (driver) must NOT see Live map or others’ locations.
- Permission viewLiveMap: admin, office, mechanic, warehouse, supervisor, viewer.
- UI: Layout nav, Dashboard field tiles, LiveMapPage gate, howto.
- API: /live/positions and /tracking/health require ROLE_PERMS.viewLiveMap.

### Box2 warehouse truck (DONE + D1 updated + deployed)
- Unit number in DB is "Box2" (not "Box 2").
- assigned_driver = "Warehouse truck", assigned_employee_id/helper NULL.
- Still shows on map. Pool labels must NOT be used for GPS person-matching (worker/gps.ts isPoolDriverLabel).
- When matched unit has no person, do NOT fall back to GPS device display name (looked “assigned”).
- Trucks → Assign: Unassigned + checkbox “Warehouse / pool truck” → pool_label "Warehouse truck".
- Migration: migrations/069_box2_warehouse_truck.sql (already applied remote).

### Security camera playback (DONE + deployed; shop proxy updated)
User pain: emergency find (e.g. car drop-off ~3:30) jumped to wrong times across quiet gaps. NVR is MOTION-ONLY.
Chosen UX: list motion clips near picked time → tap to play.
- Proxy: /fieldapp/segments (+ wyze/segments), clip modes at|prev|next, X-Clip-* headers.
- Worker: /warehouse-cameras/segments → shop proxy.
- UI WarehouseCamerasPage: “Find clips”, scrollable list, Nearest/Playing, Prev/Next clip, Wider ±3h/±6h.
- Long continuous segments: land near picked time (clipWindowForPlay), don’t start at segment start.
- Shop install: copy scripts/nvr-media-proxy.mjs → C:\ProgramData\TotalAssurance\nvr-tunnel\ ; restart TA-NVR-MediaProxy (Admin). FIX-CAMERAS-NOW.bat does this.
- Health: http://127.0.0.1:8791/fieldapp/health
- NVR times: local wall clock often labeled with trailing Z — proxy searches local+utc; do not “fix” by only using true UTC.

### Dump runs (in tree / largely done)
- DumpRunsPage, dumpTicketOcr.ts, migrations/068_dump_runs.sql
- Dump OCR learning must stay dump-specific (don’t pollute fuel OCR prefer_G_token / value_in_text).
- Nav: Dump under Warehouse only (not duplicate under Shop).

### Fuel alerts (in tree)
- AlertsPage: group by unit, receipt viewer, compact buttons, void duplicate fuel, print-for-tech packet.

### Shop / issues (in tree)
- Mechanic log shop work + Done today; printable tech shop receipts (migrations/067_shop_work_origin.sql).

### Tool loans (in tree)
- Ack with pre-filled date; don’t over-explain the date in UI.
- Paperwork / charge links migrations 065–066; ledger print dates.

### SMS / Twilio (in tree, ops pending)
- A2P 10DLC / Messaging Service; error 30034 until campaign approved + Messaging Service linked.
- worker/sms.ts uses Messaging Service SID when set.

### Cameras / tunnel scripts (uncommitted helpers)
- Many scripts under scripts/: named tunnel, wyze bridge, watch-tunnel-url, easy-cameras-always-on, etc.
- git status shows lots of modified + untracked files — check before assuming clean.

## Product preferences from owner (Chris)
- Emergency camera find must be easy — clip list, not scrubbing gaps.
- Field guys don’t need to see where others are.
- Warehouse truck Box2 = unassigned label but still on map.
- Dump only under Warehouse nav.
- Prefer deploy when features need to be live for staff.
- UI changes: verify in browser when possible.

## If continuing cameras
Proxy must be running updated file; if /fieldapp/segments 404 HTML → FIX-CAMERAS-NOW.bat.
Prefer improving clip list / time UX over rewind-across-gaps.

## If continuing map
Don’t re-enable Live map for drivers. Pool trucks use Warehouse truck label pattern.

Start by reading AGENTS.md, then git status, then ask what I want next — or continue any unfinished item I name.
```
