/**
 * Vendor hand-off pure checks. API checks (8.1 items 5-13 and 15) need a local worker
 * and are not executed by this file.
 * Run: npx esbuild scripts/test-vendor-handoffs.ts --bundle --platform=node --format=cjs --outfile=tmp-vendor-handoff-test.cjs ; node tmp-vendor-handoff-test.cjs
 */
import { readFileSync } from "node:fs";
import { isPng, renderHandoffReceiptHtml, validateHandoffFields } from "../worker/vendorHandoffs";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) console.log("PASS", name);
  else {
    failed += 1;
    console.log("FAIL", name, detail);
  }
}

const base = {
  client_uuid: "abc-123456",
  source_type: "warranty",
  source_id: 59,
  handoff_type: "counter_dropoff",
  rep_name: "Victoria V",
  vendor_name: "Aces",
  gps_status: "skipped",
};

check("rep empty", !validateHandoffFields({ ...base, rep_name: "" }).ok);
check("rep space", !validateHandoffFields({ ...base, rep_name: " " }).ok);
check("rep one char", !validateHandoffFields({ ...base, rep_name: "1" }).ok);
check("rep 81", !validateHandoffFields({ ...base, rep_name: "A".repeat(81) }).ok);
check("rep ok", validateHandoffFields({ ...base, rep_name: "Victoria V" }).ok);
const gps = validateHandoffFields({ ...base, gps_status: "denied", gps_lat: 27, gps_lng: -97 });
check("gps forced null", gps.ok && gps.ok && gps.value.gps_lat == null && gps.value.gps_lng == null);
check("lat 91", !validateHandoffFields({ ...base, gps_status: "ok", gps_lat: 91, gps_lng: -97 }).ok);
check("correction without reason", !validateHandoffFields({ ...base, supersedes_id: 4 }).ok);
check("bad uuid", !validateHandoffFields({ ...base, client_uuid: "no" }).ok);
check("bad source", !validateHandoffFields({ ...base, source_type: "truck" }).ok);

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0]);
check("png header", isPng(png));
check("jpeg is not png", !isPng(jpg));
const src = readFileSync("worker/vendorHandoffs.ts", "utf8");
check("signature over 300KB rejected", src.includes("sig.size > 300 * 1024"));

const html = renderHandoffReceiptHtml(
  {
    id: 1,
    source_type: "warranty",
    source_id: 59,
    warranty_claim_id: 59,
    handoff_type: "counter_dropoff",
    client_uuid: "abc-123456",
    recorded_at: "2026-10-01 18:00:00",
    recorded_by_user_id: 3,
    recorded_by_name: "Chris",
    handed_by_user_id: 3,
    handed_by_name: "Chris",
    rep_name: "<b>x</b>",
    vendor_name: "Aces",
    vendor_branch: "Ayers",
    part_name: "A2L sensor",
    part_code: "SEN03269",
    rma_number: null,
    service_address: "7026 Saar Ct",
    customer_name: "Tabatha",
    log_number: "W1026-002",
    signature_key: "vendor-handoffs/sig.png",
    photo_key: "vendor-handoffs/photo.jpg",
    signature_sha256: "aa",
    photo_sha256: "bb",
    client_captured_at: "2026-10-01 17:50:00",
    sent_offline: 0,
    gps_status: "ok",
    gps_lat: 27.7,
    gps_lng: -97.4,
    gps_accuracy_m: 12,
    notes: null,
    supersedes_id: 1,
    correction_reason: "wrong branch",
    superseded_by_id: 2,
  },
  { autoprint: true }
);
check("escapes rep", html.includes("&lt;b&gt;x&lt;/b&gt;") && !html.includes("<b>x</b>"));
check("shows CT", html.includes(" CT"));
check("part and code", html.includes("A2L sensor") && html.includes("SEN03269"));
check("rma none", html.includes("none on card"));
check("print script", html.includes("document.images") && html.includes("window.print()"));
const quiet = renderHandoffReceiptHtml(
  {
    id: 2,
    source_type: "warranty",
    source_id: 59,
    warranty_claim_id: 59,
    handoff_type: "counter_dropoff",
    client_uuid: "abc-123456",
    recorded_at: "2026-10-01 18:00:00",
    recorded_by_user_id: 3,
    recorded_by_name: "Chris",
    handed_by_user_id: 3,
    handed_by_name: "Chris",
    rep_name: "Test Rep",
    vendor_name: "Aces",
    vendor_branch: null,
    part_name: "A2L sensor",
    part_code: null,
    rma_number: "R1",
    service_address: null,
    customer_name: null,
    log_number: "W1026-002",
    signature_key: "vendor-handoffs/sig.png",
    photo_key: "vendor-handoffs/photo.jpg",
    signature_sha256: "aa",
    photo_sha256: "bb",
    client_captured_at: null,
    sent_offline: 0,
    gps_status: "denied",
    gps_lat: null,
    gps_lng: null,
    gps_accuracy_m: null,
    notes: null,
    supersedes_id: null,
    correction_reason: null,
  },
  { autoprint: false }
);
check("no auto print", !quiet.includes("document.images"));

console.log("API checks 5-13 and 15: NOT EXECUTED (no local worker this run)");
if (failed) {
  console.log("FAILS", failed);
  process.exit(1);
}
console.log("ALL PASS");
