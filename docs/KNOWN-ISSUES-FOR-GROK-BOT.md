# Known issues & pain — Field App (for Grok Bot)

Owner: Chris · Repo: `C:\grok\fueltracker` · Live: https://total-assurance-fleet.totalassurance.workers.dev

Use this with `AGENTS.md` and `/field-app`. **Do not reinvent fixed solutions**; improve what’s still weak.

---

## 1. Security cameras — hardest ongoing pain (PARTIALLY FIXED)

### What went wrong (user story)
In a real emergency Chris needed to see someone drop a car off around **~3:30–3:35**. The player jumped around (e.g. landed near **~2:51**) and skipped the minutes that mattered. Even after time corrections, **scrubbing / rewind felt unusable in a crisis** — “it shouldn’t be this hard to find a clip.”

### Root causes (not one bug)
1. **NVR records motion only.** Quiet stretches have **no video**. Scrubbing a continuous timeline lies to you — there is nothing there.
2. **Old chaining used fixed clock blocks** (e.g. 2.5‑min snaps) then “nearest segment,” which **skipped over gaps** and felt like random jumps.
3. **Hikvision / LTS time quirk:** search/download often treats times as **shop local wall clock with a trailing `Z`** (not true UTC). Using only `toISOString()` UTC shifts Central by 5–6 hours and finds the wrong day/hour.
4. **Shop media proxy must be updated on the NUC.** Code in the repo is useless until copied to  
   `C:\ProgramData\TotalAssurance\nvr-tunnel\nvr-media-proxy.mjs` and **`TA-NVR-MediaProxy` restarted as Admin**. Stale proxy → HTML **404 Document Error** on new `/fieldapp/*` routes (Worker then looks “broken”).
5. **Tunnel offline** → Cloudflare **530** / “tunnel error” — cameras blank even if app is fine.
6. **Wyze** path is separate and often unfinished: Bridge/Docker, `install-wyze-bridge.ps1`, recording ring buffer; NVR is the reliable path today.
7. Some NVR “segments” are **very long** (~40 min continuous). Playing from segment *start* missed the user’s picked minute — now we land near pick for long clips, but UX can still feel coarse.

### What we already built (don’t rip out)
- Clip modes `at` | `prev` | `next` + `X-Clip-Start/End/Gap-Sec` headers.
- **`/fieldapp/segments`** + Worker **`/warehouse-cameras/segments`**.
- UI: **Find clips** → list near time → tap; Prev/Next clip; Wider ±3h/±6h; gap messaging.
- `FIX-CAMERAS-NOW.bat` copies proxy + restarts service.

### Still worth Grok Bot trying
- [ ] **Verify Find clips E2E in browser** as a real user (pick ~3:30, confirm list + play). Prior session often lacked browser automation.
- [ ] **Shorter / clearer emergency UX** (bigger tap targets, default ±30m, “jump to nearest motion at this minute”).
- [ ] **Timeline with clip marks** (owner previously considered; list shipped first).
- [ ] Confirm shop proxy stays on latest file after reboots (service + copy path).
- [ ] Wyze reliability only if owner asks — don’t derail NVR.

---

## 2. Live map / privacy / warehouse truck (MOSTLY FIXED — don’t regress)

### Problems we hit
- Field techs could see **where everyone else was** — owner does not want that.
- **Box2** (warehouse truck) needed to be **unassigned** but **still on the map**. Clearing assignment used to make the map show the **GPS device name**, which looked like someone was still assigned.
- GPS matching by driver name could confuse **pool labels** (“Warehouse truck”) with people if treated as names.

### Fixed
- `viewLiveMap` permission; drivers blocked in nav, page, and API.
- Box2 → `assigned_driver = 'Warehouse truck'`, no employee IDs; pool-label helpers in `worker/gps.ts`.
- Assign UI: “Warehouse / pool truck” checkbox.

### Still worth trying
- [ ] Confirm in UI (Preview as Field) Live map gone; as Warehouse/Office map works.
- [ ] Any other pool units (shop spare, etc.) using same pattern?
- [ ] Uncommitted map/gps changes — ensure deployed matches intent (`git status`).

---

## 3. SMS / Twilio A2P (OPS BLOCKER — code partly ready)

### Problem
Staff SMS failed with Twilio **error 30034** (A2P 10DLC / unregistered traffic). US carriers block until:
- Brand + **A2P Campaign** approved, and
- Phone number attached to a **Messaging Service** that is linked to that campaign.

### What we did
- Guided Twilio console / Messaging Service setup; `worker/sms.ts` can use Messaging Service SID.
- Campaign forms rejected at least once — field wording mattered.

### Still open
- [ ] Confirm campaign **approved** in Twilio and number on Messaging Service.
- [ ] End-to-end SMS test from app after approval.
- [ ] Don’t “fix” 30034 in app code alone — it’s compliance, not a missing if-statement.

---

## 4. Dump runs + OCR (FEATURE IN TREE — fragile)

### Problems
- Need dump/landfill ticket logging with OCR learn.
- Early OCR learning **polluted fuel OCR** (shared `prefer_G_token` / `value_in_text` style memory) — dump must stay **dump-specific**.
- Nav mistakenly showed Dump under Shop as well — owner wants **Warehouse only**.

### Still open
- [ ] User acceptance: create/view/fix dump run on live app.
- [ ] Confirm migrations `068` applied on remote if not already.
- [ ] Guard OCR learn paths so fuel + dump never share bad tokens again.
- [ ] Lots of related files still **uncommitted**.

---

## 5. Fuel alerts / receipts (IN TREE)

### Problems addressed in session
- Alerts hard to work: needed **group by unit**, **view receipt**, **compact actions**, **void duplicate fuel**, **print packet for tech**.

### Still open
- [ ] Browser verify void + receipt + print flows.
- [ ] Edge cases: missing receipt blob, already-voided, permissions for mechanic vs office.

---

## 6. Shop work / printable tech receipts (IN TREE)

### Problems
- Mechanics needed to log shop work and mark **Done today**.
- Needed **printable tech shop receipts**.
- Migration `067_shop_work_origin.sql`.

### Still open
- [ ] Confirm print layout on phone + desktop.
- [ ] Confirm “Done today” doesn’t break existing issue statuses.

---

## 7. Tool loans (IN TREE)

### Problems
- Ack flow: **pre-fill date**, and **don’t explain the date** in UI copy (owner asked not to).
- Paperwork / charge links (`065`, `066`); ledger print dates.

### Still open
- [ ] Regression: ack → ledger → print still coherent.
- [ ] Charge links / paperwork paths if incomplete.

---

## 8. Shop PC / tunnel ops (RECURRING)

### Chronic issues
- Media proxy or cloudflared dies → cameras die for everyone.
- Updating Worker without updating **shop proxy** → half-features (segments 404).
- Admin elevation required to restart nssm services (`Access is denied` without UAC).
- Named tunnel URL sync scripts exist but are easy to leave stale (`current-url.txt`, watch scripts).

### Worth trying
- [ ] Health check + document “cameras down” runbook in-app or howto (short).
- [ ] Ensure `FIX-CAMERAS-NOW.bat` always copies from repo path that exists on this PC.

---

## 9. Engineering / process debt

### Problems
- **Huge dirty git tree** (many modified + untracked). Easy to lose work or deploy partial mental model. Consider commit/PR when owner allows.
- **No GitHub backup** stressed in `SAVE-THIS.md` — code mainly on this PC.
- Wrangler **out of date** warnings; D1 sometimes needs `--remote` and logged-in account.
- Pre-existing **tsc errors** in unrelated files (Layout null user, PickupPanel, auth Buffer types, etc.) — don’t block on cleaning all unless asked.
- Browser verification often skipped when MCP browser tools unavailable — owner rule still wants UI verified when possible.

---

## Suggested order for Grok Bot (if owner says “fix what’s broken”)

1. **Cameras E2E** — Find clips at a real time; confirm proxy `/fieldapp/segments` on NUC.
2. **Live map role check** — Field vs office.
3. **Twilio 30034** — status only / guide ops; don’t fake-fix in code.
4. **Dump runs** smoke + OCR isolation check.
5. **Fuel alerts void/receipt** smoke.
6. Offer to **commit** a coherent slice of the dirty tree (ask first).

## Explicit non-goals unless asked
- Rewriting the whole camera player as a DVR scrubber over empty gaps.
- Giving drivers Live map again.
- Treating Box2 as a personal assigned truck.
```
