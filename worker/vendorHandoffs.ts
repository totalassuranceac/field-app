/**
 * Vendor hand-off proof. Append-only rows. No SMS, no bell, no webhook.
 */
import { getSetting, setSetting, writeAudit } from "./audit";
import { settingOn } from "./deliveriesPlan";
import type { PublicUser } from "./types";

const NOT_READY = "Run migration 110_vendor_handoffs.sql (after Chris says Y).";
export const HANDOFF_MIGRATION_ERROR = NOT_READY;

let readyCache = false;

export async function handoffsReady(db: D1Database): Promise<boolean> {
  if (readyCache) return true;
  try {
    const row = await db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'vendor_handoffs'`)
      .first<{ ok: number }>();
    if (row?.ok) readyCache = true;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

export async function proofRequiredWarranty(db: D1Database): Promise<boolean> {
  const raw = await getSetting(db, "handoff_proof_required_warranty", "true");
  return settingOn(raw);
}

export async function proofRequiredArrivalReturn(db: D1Database): Promise<boolean> {
  const raw = await getSetting(db, "handoff_proof_required_arrival_return", "false");
  return settingOn(raw);
}

export async function warrantyHasHandoff(db: D1Database, warrantyId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS ok FROM vendor_handoffs WHERE warranty_claim_id = ? LIMIT 1`)
    .bind(warrantyId)
    .first<{ ok: number }>();
  return Boolean(row?.ok);
}

const GPS = ["ok", "denied", "unavailable", "timeout", "unsupported", "skipped"] as const;
const SOURCES = ["warranty", "parts_arrival"] as const;
const TYPES = ["return_to_vendor", "take_back", "counter_dropoff"] as const;

export type HandoffFields = {
  client_uuid: string;
  source_type: (typeof SOURCES)[number];
  source_id: number;
  handoff_type: (typeof TYPES)[number];
  rep_name: string;
  vendor_name: string;
  vendor_branch: string | null;
  notes: string | null;
  gps_status: (typeof GPS)[number];
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy_m: number | null;
  client_captured_at: string | null;
  supersedes_id: number | null;
  correction_reason: string | null;
  handed_by_user_id: number | null;
};

export function validateHandoffFields(input: Record<string, unknown>): { ok: true; value: HandoffFields } | { ok: false; error: string } {
  const uuid = String(input.client_uuid || "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(uuid)) return { ok: false, error: "client_uuid is invalid" };
  const sourceType = String(input.source_type || "");
  if (!SOURCES.includes(sourceType as (typeof SOURCES)[number])) return { ok: false, error: "Unknown source type" };
  const sourceId = Number(input.source_id);
  if (!Number.isInteger(sourceId) || sourceId <= 0) return { ok: false, error: "source_id is invalid" };
  const handoffType = String(input.handoff_type || "");
  if (!TYPES.includes(handoffType as (typeof TYPES)[number])) return { ok: false, error: "Unknown hand-off type" };
  const rep = String(input.rep_name || "").replace(/\s+/g, " ").trim();
  if (rep.length < 2 || rep.length > 80 || !/[A-Za-z]/.test(rep)) return { ok: false, error: "Type the vendor rep printed name (2-80 letters)." };
  const vendor = String(input.vendor_name || "").replace(/\s+/g, " ").trim();
  if (vendor.length < 1 || vendor.length > 80) return { ok: false, error: "Vendor name is required (1-80)." };
  const branchRaw = String(input.vendor_branch || "").replace(/\s+/g, " ").trim();
  if (branchRaw.length > 80) return { ok: false, error: "Branch is too long" };
  const notesRaw = String(input.notes || "").trim();
  if (notesRaw.length > 500) return { ok: false, error: "Notes are too long" };
  let gps = String(input.gps_status || "skipped");
  if (!GPS.includes(gps as (typeof GPS)[number])) gps = "skipped";
  let lat: number | null = input.gps_lat == null || input.gps_lat === "" ? null : Number(input.gps_lat);
  let lng: number | null = input.gps_lng == null || input.gps_lng === "" ? null : Number(input.gps_lng);
  let acc: number | null = input.gps_accuracy_m == null || input.gps_accuracy_m === "" ? null : Number(input.gps_accuracy_m);
  if (gps === "ok") {
    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return { ok: false, error: "GPS coordinates are invalid" };
    }
    if (acc != null && (!Number.isFinite(acc) || acc < 0 || acc > 100000)) return { ok: false, error: "GPS accuracy is invalid" };
  } else {
    lat = null;
    lng = null;
    acc = null;
  }
  let captured: string | null = null;
  const capRaw = String(input.client_captured_at || "").trim();
  if (capRaw) {
    const ms = Date.parse(capRaw);
    if (!Number.isFinite(ms)) return { ok: false, error: "client_captured_at is invalid" };
    captured = new Date(ms).toISOString();
  }
  let supersedes: number | null = null;
  if (input.supersedes_id != null && String(input.supersedes_id).trim() !== "") {
    supersedes = Number(input.supersedes_id);
    if (!Number.isInteger(supersedes) || supersedes <= 0) return { ok: false, error: "supersedes_id is invalid" };
  }
  const reason = String(input.correction_reason || "").trim();
  if (supersedes && (reason.length < 3 || reason.length > 300)) {
    return { ok: false, error: "Correction reason is required (3-300)." };
  }
  let handed: number | null = null;
  if (input.handed_by_user_id != null && String(input.handed_by_user_id).trim() !== "") {
    handed = Number(input.handed_by_user_id);
    if (!Number.isInteger(handed) || handed <= 0) return { ok: false, error: "handed_by_user_id is invalid" };
  }
  return {
    ok: true,
    value: {
      client_uuid: uuid,
      source_type: sourceType as HandoffFields["source_type"],
      source_id: sourceId,
      handoff_type: handoffType as HandoffFields["handoff_type"],
      rep_name: rep,
      vendor_name: vendor,
      vendor_branch: branchRaw || null,
      notes: notesRaw || null,
      gps_status: gps as HandoffFields["gps_status"],
      gps_lat: lat,
      gps_lng: lng,
      gps_accuracy_m: acc,
      client_captured_at: captured,
      supersedes_id: supersedes,
      correction_reason: supersedes ? reason : null,
      handed_by_user_id: handed,
    },
  };
}

export function isPng(bytes: Uint8Array): boolean {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8) return false;
  return sig.every((b, i) => bytes[i] === b);
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fmtCt(utcSql: string | null | undefined): string {
  const raw = String(utcSql || "").trim();
  if (!raw) return "";
  const norm = /Z|[+-]\d{2}:?\d{2}$/i.test(raw) ? raw : raw.includes("T") ? `${raw}Z` : `${raw.replace(" ", "T")}Z`;
  const ms = Date.parse(norm);
  if (!Number.isFinite(ms)) return "";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(ms));
  return `${s.replace(/\u202f/g, " ")} CT`;
}

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type HandoffRow = {
  id: number;
  client_uuid: string;
  source_type: string;
  source_id: number;
  warranty_claim_id: number | null;
  handoff_type: string;
  log_number: string | null;
  part_name: string | null;
  part_code: string | null;
  rma_number: string | null;
  vendor_name: string;
  vendor_branch: string | null;
  rep_name: string;
  signature_key: string;
  photo_key: string;
  handed_by_name: string;
  recorded_at: string;
  client_captured_at: string | null;
  sent_offline: number;
  gps_status: string;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy_m: number | null;
  notes: string | null;
  supersedes_id: number | null;
  correction_reason: string | null;
  superseded_by_id?: number | null;
};

export function publicHandoff(row: HandoffRow) {
  const keyUrl = (key: string) => `/api/uploads/${encodeURIComponent(key)}`;
  return {
    ...row,
    recorded_at_ct: fmtCt(row.recorded_at),
    client_captured_at_ct: row.client_captured_at ? fmtCt(row.client_captured_at) : null,
    signature_url: keyUrl(row.signature_key),
    photo_url: keyUrl(row.photo_key),
    receipt_url: `/api/handoffs/${row.id}/receipt`,
  };
}

export async function listHandoffs(db: D1Database, sourceType: string, sourceId: number): Promise<HandoffRow[]> {
  const rows = await db
    .prepare(
      `SELECT h.*,
        (SELECT id FROM vendor_handoffs x WHERE x.supersedes_id = h.id ORDER BY x.id DESC LIMIT 1) AS superseded_by_id
       FROM vendor_handoffs h
       WHERE h.source_type = ? AND h.source_id = ?
       ORDER BY h.recorded_at DESC, h.id DESC`
    )
    .bind(sourceType, sourceId)
    .all<HandoffRow>();
  return rows.results || [];
}

export function renderHandoffReceiptHtml(row: HandoffRow, opts: { autoprint: boolean }): string {
  const part = [row.part_name, row.part_code ? `(${row.part_code})` : ""].filter(Boolean).join(" ");
  const rma = row.rma_number?.trim() ? row.rma_number : "none on card";
  const branch = row.vendor_branch?.trim() ? row.vendor_branch : "-";
  const loc =
    row.gps_status === "ok" && row.gps_lat != null && row.gps_lng != null
      ? `${Number(row.gps_lat).toFixed(5)}, ${Number(row.gps_lng).toFixed(5)} (+/- ${Math.round(Number(row.gps_accuracy_m || 0))} m)`
      : `Not captured (${row.gps_status || "skipped"})`;
  const time = esc(fmtCt(row.recorded_at));
  const offline = row.sent_offline
    ? `<div>Signed on phone ${esc(fmtCt(row.client_captured_at))} (sent later, poor signal)</div>`
    : "";
  const corrects = row.supersedes_id
    ? `<div>Corrects proof #${row.supersedes_id}: ${esc(row.correction_reason || "")}</div>`
    : "";
  const superseded = row.superseded_by_id
    ? `<div class="band">Superseded by proof #${row.superseded_by_id}</div>`
    : "";
  const sig = `/api/uploads/${encodeURIComponent(row.signature_key)}`;
  const photo = `/api/uploads/${encodeURIComponent(row.photo_key)}`;
  const printScript = opts.autoprint
    ? `<script>
(function () {
  var imgs = Array.prototype.slice.call(document.images || []);
  var pending = imgs.filter(function (img) { return !img.complete; });
  var done = false;
  function go() { if (done) return; done = true; window.print(); }
  if (!pending.length) { setTimeout(go, 50); return; }
  var left = pending.length;
  pending.forEach(function (img) {
    function one() { left -= 1; if (left <= 0) go(); }
    img.addEventListener("load", one);
    img.addEventListener("error", one);
  });
  setTimeout(go, 4000);
})();
</script>`
    : "";
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Proof #${row.id}</title>
<style>
  html, body { background: #fff; color: #111; margin: 0; }
  body { font: 11pt system-ui, Segoe UI, sans-serif; }
  main.receipt { max-width: 7.5in; margin: 0 auto; break-inside: avoid; page-break-inside: avoid; }
  @page { size: letter portrait; margin: 0.5in; }
  .head { display: flex; justify-content: space-between; border-bottom: 1px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px; vertical-align: top; }
  td.k { width: 1.6in; color: #333; }
  img.sig { max-height: 1.5in; max-width: 100%; object-fit: contain; }
  img.photo { max-height: 3.6in; max-width: 100%; object-fit: contain; }
  .box { border: 1px solid #999; background: #fff; padding: 4px; margin-top: 8px; }
  .cap { font-size: 10pt; margin: 2px 0 8px; }
  .foot { font-size: 8pt; color: #666; margin-top: 8px; }
  .band { background: #eee; color: #444; padding: 4px 6px; margin: 6px 0; }
  .no-print { margin: 8px 0; }
  @media print { .no-print { display: none; } }
</style>
</head>
<body>
<main class="receipt">
  <div class="no-print">
    <button type="button" onclick="window.print()">Print</button>
    <button type="button" onclick="window.close()">Close</button>
  </div>
  <div class="head">
    <strong>Total Assurance - Vendor hand-off receipt</strong>
    <span>Proof #${row.id}</span>
  </div>
  ${superseded}
  <table>
    <tr><td class="k">Card / log #</td><td>${esc(row.log_number || "-")}</td></tr>
    <tr><td class="k">Part</td><td>${esc(part || "-")}</td></tr>
    <tr><td class="k">Claim / RMA #</td><td>${esc(rma)}</td></tr>
    <tr><td class="k">Vendor</td><td>${esc(row.vendor_name)}</td></tr>
    <tr><td class="k">Branch</td><td>${esc(branch)}</td></tr>
    <tr><td class="k">Signed by (vendor)</td><td>${esc(row.rep_name)}</td></tr>
    <tr><td class="k">Handed off by (Total Assurance)</td><td>${esc(row.handed_by_name)}</td></tr>
    <tr><td class="k">Time</td><td>${time}${offline}</td></tr>
    <tr><td class="k">Location</td><td>${esc(loc)}</td></tr>
  </table>
  ${corrects}
  <div class="box"><img class="sig" alt="Signature" src="${esc(sig)}" /><div class="cap">Signature of ${esc(row.rep_name)}</div></div>
  <div class="box"><img class="photo" alt="Part at the counter" src="${esc(photo)}" /><div class="cap">Part at the counter</div></div>
  <div class="foot">Recorded in the Total Assurance Field App. This record cannot be edited. Printed ${esc(fmtCt(new Date().toISOString()))}. Ref ${esc(String(row.client_uuid || "").slice(0, 8))}.</div>
</main>
${printScript}
</body>
</html>`;
}

const PROCESS_ROLES = new Set(["admin", "warehouse", "office", "mechanic"]);

function canRecordWarranty(user: PublicUser, card: { status: string; needs_vendor_return: number | null }): boolean {
  if (PROCESS_ROLES.has(user.role)) return true;
  if (user.role !== "driver" && user.role !== "supervisor") return false;
  if (card.status === "return_to_vendor" || card.status === "delivered") return true;
  if (card.status === "approved" && Number(card.needs_vendor_return) === 1) return true;
  return false;
}

function formText(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

export async function createHandoff(opts: {
  db: D1Database;
  user: PublicUser;
  form: FormData;
  userAgent: string;
  savePhoto: (file: File, folder: "vendor-handoffs") => Promise<string>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { db, user, form } = opts;
  const parsed = validateHandoffFields({
    client_uuid: formText(form, "client_uuid"),
    source_type: formText(form, "source_type"),
    source_id: formText(form, "source_id"),
    handoff_type: formText(form, "handoff_type"),
    rep_name: formText(form, "rep_name"),
    vendor_name: formText(form, "vendor_name"),
    vendor_branch: formText(form, "vendor_branch"),
    notes: formText(form, "notes"),
    gps_status: formText(form, "gps_status"),
    gps_lat: formText(form, "gps_lat"),
    gps_lng: formText(form, "gps_lng"),
    gps_accuracy_m: formText(form, "gps_accuracy_m"),
    client_captured_at: formText(form, "client_captured_at"),
    supersedes_id: formText(form, "supersedes_id"),
    correction_reason: formText(form, "correction_reason"),
    handed_by_user_id: formText(form, "handed_by_user_id"),
  });
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const v = parsed.value;

  const existing = await db
    .prepare(`SELECT * FROM vendor_handoffs WHERE client_uuid = ?`)
    .bind(v.client_uuid)
    .first<HandoffRow>();
  if (existing) {
    const full = await listHandoffs(db, existing.source_type, existing.source_id);
    const row = full.find((r) => r.id === existing.id) || existing;
    return { status: 200, body: { handoff: publicHandoff(row), duplicate: true } };
  }

  let snap: {
    log_number: string | null;
    part_name: string | null;
    part_code: string | null;
    rma_number: string | null;
    vendor_name: string;
    status_from: string | null;
    warranty_claim_id: number | null;
  };
  if (v.source_type === "warranty") {
    const card = await db
      .prepare(
        `SELECT id, log_number, part_name, part_code, rma_number, vendor_name, status, needs_vendor_return
         FROM warranty_claims WHERE id = ?`
      )
      .bind(v.source_id)
      .first<{
        id: number;
        log_number: string | null;
        part_name: string | null;
        part_code: string | null;
        rma_number: string | null;
        vendor_name: string | null;
        status: string;
        needs_vendor_return: number | null;
      }>();
    if (!card) return { status: 404, body: { error: "Warranty card not found" } };
    if (!canRecordWarranty(user, card)) return { status: 403, body: { error: "Not allowed on this card" } };
    snap = {
      log_number: card.log_number,
      part_name: card.part_name,
      part_code: card.part_code,
      rma_number: card.rma_number,
      vendor_name: v.vendor_name || card.vendor_name || "Vendor",
      status_from: card.status,
      warranty_claim_id: card.id,
    };
  } else {
    if (!(user.role === "admin" || user.role === "office" || user.role === "warehouse")) {
      return { status: 403, body: { error: "Not allowed" } };
    }
    const arrival = await db
      .prepare(`SELECT id, part_description, vendor_name, status FROM parts_arrivals WHERE id = ?`)
      .bind(v.source_id)
      .first<{ id: number; part_description: string | null; vendor_name: string | null; status: string }>();
    if (!arrival) return { status: 404, body: { error: "Arrival not found" } };
    snap = {
      log_number: null,
      part_name: arrival.part_description,
      part_code: null,
      rma_number: null,
      vendor_name: v.vendor_name || arrival.vendor_name || "Vendor",
      status_from: arrival.status,
      warranty_claim_id: null,
    };
  }

  const sig = form.get("signature");
  const photo = form.get("photo");
  if (!(sig instanceof File) || sig.size <= 0) {
    return { status: 400, body: { error: "Vendor rep signature is required" } };
  }
  const sigBuf = new Uint8Array(await sig.arrayBuffer());
  if (!isPng(sigBuf) || sig.size > 300 * 1024) {
    return { status: 400, body: { error: "Vendor rep signature is required" } };
  }
  if (!(photo instanceof File) || photo.size <= 0 || !String(photo.type || "").startsWith("image/")) {
    return { status: 400, body: { error: "Photo of the part at the counter is required" } };
  }

  if (v.supersedes_id) {
    const prior = await db
      .prepare(`SELECT id, source_type, source_id FROM vendor_handoffs WHERE id = ?`)
      .bind(v.supersedes_id)
      .first<{ id: number; source_type: string; source_id: number }>();
    if (!prior || prior.source_type !== v.source_type || prior.source_id !== v.source_id) {
      return { status: 400, body: { error: "That proof is not on this card" } };
    }
  }

  let handedId = user.id;
  if (v.handed_by_user_id && v.handed_by_user_id !== user.id) {
    if (!(user.role === "admin" || user.role === "office" || user.role === "warehouse")) {
      return { status: 400, body: { error: "You can only record a hand-off as yourself" } };
    }
    handedId = v.handed_by_user_id;
  }
  const who = await db
    .prepare(`SELECT id, display_name FROM users WHERE id = ?`)
    .bind(handedId)
    .first<{ id: number; display_name: string }>();
  if (!who) return { status: 400, body: { error: "Handed-off-by user was not found" } };

  const sigSha = await sha256Hex(sigBuf.buffer.slice(sigBuf.byteOffset, sigBuf.byteOffset + sigBuf.byteLength) as ArrayBuffer);
  const photoBytes = new Uint8Array(await photo.arrayBuffer());
  const photoSha = await sha256Hex(photoBytes.buffer.slice(photoBytes.byteOffset, photoBytes.byteOffset + photoBytes.byteLength) as ArrayBuffer);
  const sigFile = new File([sigBuf], "signature.png", { type: "image/png" });
  const photoFile = new File([photoBytes], photo.name || "handoff.jpg", { type: photo.type || "image/jpeg" });
  const signatureKey = await opts.savePhoto(sigFile, "vendor-handoffs");
  const photoKey = await opts.savePhoto(photoFile, "vendor-handoffs");
  const now = Date.now();
  const capturedMs = v.client_captured_at ? Date.parse(v.client_captured_at) : now;
  const sentOffline = Number.isFinite(capturedMs) && now - capturedMs > 120000 ? 1 : 0;

  try {
    await db
      .prepare(
        `INSERT INTO vendor_handoffs (
          client_uuid, source_type, source_id, warranty_claim_id, handoff_type,
          log_number, part_name, part_code, rma_number, vendor_name, vendor_branch,
          rep_name, signature_key, signature_sha256, photo_key, photo_sha256,
          handed_by_user_id, handed_by_name, recorded_by_user_id, client_captured_at,
          sent_offline, gps_status, gps_lat, gps_lng, gps_accuracy_m, status_from,
          notes, supersedes_id, correction_reason, user_agent
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .bind(
        v.client_uuid,
        v.source_type,
        v.source_id,
        snap.warranty_claim_id,
        v.handoff_type,
        snap.log_number,
        snap.part_name,
        snap.part_code,
        snap.rma_number,
        snap.vendor_name,
        v.vendor_branch,
        v.rep_name,
        signatureKey,
        sigSha,
        photoKey,
        photoSha,
        who.id,
        who.display_name,
        user.id,
        v.client_captured_at,
        sentOffline,
        v.gps_status,
        v.gps_lat,
        v.gps_lng,
        v.gps_accuracy_m,
        snap.status_from,
        v.notes,
        v.supersedes_id,
        v.correction_reason,
        opts.userAgent.slice(0, 200)
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE/i.test(msg)) {
      const again = await db.prepare(`SELECT * FROM vendor_handoffs WHERE client_uuid = ?`).bind(v.client_uuid).first<HandoffRow>();
      if (again) return { status: 200, body: { handoff: publicHandoff(again), duplicate: true } };
    }
    return { status: 400, body: { error: "Could not save the hand-off" } };
  }

  const saved = await db.prepare(`SELECT * FROM vendor_handoffs WHERE client_uuid = ?`).bind(v.client_uuid).first<HandoffRow>();
  if (!saved) return { status: 500, body: { error: "Save failed" } };
  const logLabel = snap.log_number || String(v.source_id);
  await writeAudit(
    db,
    user,
    "create",
    "vendor_handoff",
    saved.id,
    `Hand-off ${logLabel} to ${snap.vendor_name} - signed by ${v.rep_name}`
  );
  if (v.source_type === "warranty" && snap.warranty_claim_id) {
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const branchBit = v.vendor_branch ? ` ${v.vendor_branch}` : "";
    const line = `[${stamp} - ${user.display_name}]\nHanded to ${snap.vendor_name}${branchBit} - signed by ${v.rep_name} - proof #${saved.id}`;
    await db
      .prepare(
        `UPDATE warranty_claims
         SET notes = CASE WHEN notes IS NULL OR trim(notes) = '' THEN ? ELSE notes || char(10) || ? END,
             updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(line, line, snap.warranty_claim_id)
      .run();
  }
  const full = await listHandoffs(db, v.source_type, v.source_id);
  const row = full.find((r) => r.id === saved.id) || saved;
  return { status: 201, body: { handoff: publicHandoff(row) } };
}

export async function handoffSettings(db: D1Database) {
  return {
    ready: await handoffsReady(db),
    proof_required_warranty: await proofRequiredWarranty(db),
    proof_required_arrival_return: await proofRequiredArrivalReturn(db),
  };
}

export async function saveHandoffSettings(
  db: D1Database,
  user: PublicUser,
  body: { proof_required_warranty?: boolean; proof_required_arrival_return?: boolean }
) {
  const changes: string[] = [];
  if (typeof body.proof_required_warranty === "boolean") {
    const value = body.proof_required_warranty ? "true" : "false";
    await setSetting(db, "handoff_proof_required_warranty", value);
    await writeAudit(db, user, "update", "setting", "handoff_proof_required_warranty", `handoff_proof_required_warranty=${value}`);
    changes.push("warranty");
  }
  if (typeof body.proof_required_arrival_return === "boolean") {
    const value = body.proof_required_arrival_return ? "true" : "false";
    await setSetting(db, "handoff_proof_required_arrival_return", value);
    await writeAudit(db, user, "update", "setting", "handoff_proof_required_arrival_return", `handoff_proof_required_arrival_return=${value}`);
    changes.push("arrival");
  }
  return { ...(await handoffSettings(db)), updated: changes };
}

export async function attachHandoffCounts(db: D1Database, rows: Record<string, unknown>[]): Promise<void> {
  if (!(await handoffsReady(db))) return;
  const ids = rows.map((r) => Number(r.id)).filter((id) => Number.isInteger(id) && id > 0);
  const map = new Map<number, { n: number; last_at: string | null; last_id: number | null }>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const placeholders = chunk.map(() => "?").join(",");
    const found = await db
      .prepare(
        `SELECT warranty_claim_id, COUNT(*) n, MAX(recorded_at) last_at, MAX(id) last_id
         FROM vendor_handoffs WHERE warranty_claim_id IN (${placeholders})
         GROUP BY warranty_claim_id`
      )
      .bind(...chunk)
      .all<{ warranty_claim_id: number; n: number; last_at: string | null; last_id: number | null }>();
    for (const row of found.results || []) {
      map.set(Number(row.warranty_claim_id), { n: Number(row.n), last_at: row.last_at, last_id: row.last_id });
    }
  }
  for (const row of rows) {
    const hit = map.get(Number(row.id));
    row.handoff_count = hit?.n || 0;
    row.handoff_last_at = hit?.last_at || null;
    row.handoff_last_id = hit?.last_id || null;
  }
}
