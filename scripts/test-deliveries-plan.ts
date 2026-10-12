/**
 * Deliveries plan checks. Nothing here sends a text or touches D1.
 * Run: npx esbuild scripts/test-deliveries-plan.ts --bundle --platform=node --outfile=tmp-deliveries-test.mjs
 *      node tmp-deliveries-test.mjs
 */
import { readFileSync } from "node:fs";
import { progressSteps } from "../src/deliveriesView";
import {
  ageDaysCt,
  cleanDeliveryPhotoKey,
  cleanSpotLabel,
  isOverdue,
  nextStatus,
  officeNoticeText,
  parseDeliveryLines,
  parseScheduledFor,
  receiveError,
  settingOn,
  smsCapReached,
  warrantyLinks,
} from "../worker/deliveriesPlan";

let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    console.log(`ok ${name}`);
  }
}

const spot = "Office - next to Kelsie's desk (small parts)";
const job = {
  job_kind: "job" as const,
  job_number: "104682",
  customer_name: "Jane Smith",
  job_address: "5806 Crest Pebble Dr, Corpus Christi, TX 78414",
};

const notice = officeNoticeText(job, spot);
check(
  "1 notice job",
  notice ===
    "Parts in for job #104682 / Jane Smith - staged at Office - next to Kelsie's desk (small parts) - ready to schedule."
);
check("1 ascii", !/[^\x00-\x7F]/.test(notice) && notice.length <= 280);
const hashed = officeNoticeText({ ...job, job_number: "#104682" }, spot);
check("1 no double hash", hashed.includes("job #104682") && !hashed.includes("##"));

check(
  "2 notice stock",
  officeNoticeText({ job_kind: "stock" }, "Shelf A") === "Parts in for stock (no job) - staged at Shelf A."
);

const longText = officeNoticeText(
  { job_kind: "job", job_number: "9", customer_name: "C".repeat(200) },
  "S".repeat(200)
);
check("3 length", longText.length <= 280, String(longText.length));
check("3 spot cut", longText.includes("S".repeat(60)) && !longText.includes("S".repeat(61)));
check("3 target cut", !longText.includes("C".repeat(53)));

const base = { job_kind: "job", job_number: "104682", customer_name: "Jane Smith", spot_id: 1 };
check(
  "4 photo or po missing",
  receiveError({ ...base, photo_key: "", po_number: "" }) === "Add a photo of the label/slip or the PO."
);
check("4 photo only", receiveError({ ...base, photo_key: "part-deliveries/a.jpg", po_number: "" }) === null);
check("4 po only", receiveError({ ...base, photo_key: "", po_number: "PO1" }) === null);
check(
  "4 job missing",
  receiveError({ job_kind: "job", photo_key: "x", po_number: "PO1", spot_id: 1 }) ===
    "Pick the job, or choose No job / stock."
);
check(
  "4 stock ok",
  receiveError({ job_kind: "stock", photo_key: "", po_number: "PO1", spot_id: 1 }) === null
);
check(
  "4 spot missing",
  receiveError({
    job_kind: "job",
    job_number: "104682",
    customer_name: "Jane Smith",
    photo_key: "",
    po_number: "PO1",
    spot_id: null,
    new_spot_label: "",
  }) === "Pick where it is staged."
);

const linesOk = parseDeliveryLines([
  { description: "", qty: "" },
  { description: "Capacitor", qty: "" },
  { description: "Contactor", qty: "2.5" },
]);
check("5 blank dropped", "lines" in linesOk && linesOk.lines.length === 2);
check("5 blank qty", "lines" in linesOk && linesOk.lines[0].qty === 1);
check("5 decimal", "lines" in linesOk && linesOk.lines[1].qty === 2.5);
check("5 zero rows", "error" in parseDeliveryLines([]));
check("5 thirty one", "error" in parseDeliveryLines(Array.from({ length: 31 }, () => ({ description: "Bolt", qty: 1 }))));
const zero = parseDeliveryLines([{ description: "Bolt", qty: "0" }]);
check("5 qty zero", "error" in zero && zero.error.includes("Line 1"));
const short = parseDeliveryLines([{ description: "a", qty: "1" }]);
check("5 short desc", "error" in short);

const shelf = cleanSpotLabel("  Office   shelf ");
check("6 collapse", "label" in shelf && shelf.label === "Office shelf" && shelf.key === "office shelf");
check("6 short", "error" in cleanSpotLabel("ab"));
check("6 long", "error" in cleanSpotLabel("a".repeat(61)));
const curly = cleanSpotLabel(`Kelsie${String.fromCharCode(0x2019)}s desk`);
check("6 ascii apostrophe", "label" in curly && curly.label === "Kelsie's desk" && !/[^\x00-\x7F]/.test(curly.label));

const photoOk = cleanDeliveryPhotoKey("part-deliveries/1727-abc.jpg");
check("7 ok key", photoOk.key === "part-deliveries/1727-abc.jpg" && photoOk.error === null);
check("7 wrong folder", cleanDeliveryPhotoKey("parts-arrivals/x.jpg").error != null);
check("7 traversal", cleanDeliveryPhotoKey("../x").error != null);
const emptyPhoto = cleanDeliveryPhotoKey("");
check("7 empty", emptyPhoto.key === null && emptyPhoto.error === null);

check("8 pickup received", "to" in nextStatus("received", "pickup", false) && nextStatus("received", "pickup", false).to === "picked_up");
check("8 pickup scheduled", "to" in nextStatus("scheduled", "pickup", true) && nextStatus("scheduled", "pickup", true).to === "picked_up");
check("8 pickup again", "error" in nextStatus("picked_up", "pickup", true));
check("8 schedule", "to" in nextStatus("received", "schedule", false) && nextStatus("received", "schedule", false).to === "scheduled");
check("8 redate", "to" in nextStatus("scheduled", "schedule", true) && nextStatus("scheduled", "schedule", true).to === "scheduled");
check("8 unschedule early", "error" in nextStatus("received", "unschedule", false));
const undoYes = nextStatus("picked_up", "undo_pickup", true);
const undoNo = nextStatus("picked_up", "undo_pickup", false);
check("8 undo scheduled", "to" in undoYes && undoYes.to === "scheduled");
check("8 undo received", "to" in undoNo && undoNo.to === "received");
check("8 voided", "error" in nextStatus("voided", "pickup", false) && nextStatus("voided", "void", false).error === "This delivery was voided");

const blankDate = parseScheduledFor("");
check("9 blank", "ymd" in blankDate && blankDate.ymd === null);
const goodDate = parseScheduledFor("2026-10-03");
check("9 good", "ymd" in goodDate && goodDate.ymd === "2026-10-03");
check("9 fake", "error" in parseScheduledFor("2026-02-30"));
check("9 slash", "error" in parseScheduledFor("10/3"));

const now = Date.parse("2026-10-01T15:00:00Z");
check("10 late night", ageDaysCt("2026-10-01 04:30:00", now) === 1);
check("10 after midnight", ageDaysCt("2026-10-01 05:30:00", now) === 0);

check("11 age 8", isOverdue("received", 8) === true);
check("11 age 7", isOverdue("received", 7) === false);
check("11 scheduled", isOverdue("scheduled", 9) === true);
check("11 picked", isOverdue("picked_up", 30) === false);
check("11 voided", isOverdue("voided", 30) === false);

const addressClaim = {
  id: 4,
  log_number: "W0926-005",
  status: "dropped_off",
  service_address: "5806 Crest Pebble Dr",
  customer_name: "Other Person",
  rma_number: "",
};
const addrHit = warrantyLinks(job, [addressClaim]);
check("12 address", addrHit.length === 1 && addrHit[0].why === "address" && addrHit[0].log_number === "W0926-005");
check("12 approved", warrantyLinks(job, [{ ...addressClaim, status: "approved" }]).length === 0);
check("12 stock", warrantyLinks({ job_kind: "stock", job_address: job.job_address }, [addressClaim]).length === 0);
const custHit = warrantyLinks(
  { job_kind: "job", customer_name: "Jane Smith", job_address: "", po_number: "" },
  [{ id: 2, log_number: "W1", status: "delivered", customer_name: "JANE  SMITH.", service_address: "", rma_number: "" }]
);
check("12 customer", custHit.length === 1 && custHit[0].why === "customer");
const poHit = warrantyLinks(
  { job_kind: "job", customer_name: "A", job_address: "1", po_number: "#RMA-77" },
  [{ id: 3, log_number: "W2", status: "claim_submitted", customer_name: "B", service_address: "9", rma_number: "rma-77" }]
);
check("12 po", poHit.length === 1 && poHit[0].why === "po");
const near = warrantyLinks(
  { job_kind: "job", customer_name: "No Match", job_address: "98 Oaks", po_number: "" },
  [{ id: 8, log_number: "W9", status: "dropped_off", customer_name: "Other", service_address: "99 Oakx", rma_number: "" }]
);
check("12 near ignored", near.length === 0);
const many = [5, 4, 3, 2, 1, 5].map((id) => ({
  id,
  log_number: `W${id}`,
  status: "dropped_off",
  customer_name: "Jane Smith",
  service_address: "",
  rma_number: "",
}));
const top = warrantyLinks({ job_kind: "job", customer_name: "Jane Smith" }, many);
check(
  "12 max 3",
  top.length === 3 && top.map((x) => x.id).join(",") === "5,4,3"
);

check("13 cap 7", smsCapReached(7) === false);
check("13 cap 8", smsCapReached(8) === true);

check("14 on", ["true", "1", "on", "yes"].every((v) => settingOn(v)));
check("14 off", ["", "false", "off", undefined].every((v) => settingOn(v) === false));

const io = readFileSync("worker/deliveries.ts", "utf8");
const bellHits = io.split("IFNULL(is_warehouse, 0) = 0").length - 1;
check("15 warehouse filter", bellHits === 2, String(bellHits));
const smsSql = /OFFICE_SMS_SQL =\s*\n?\s*"([^"]+)"/.exec(io);
check(
  "15 sms no admin",
  Boolean(smsSql) && !String(smsSql?.[1] || "").includes("'admin'") && String(smsSql?.[1] || "").includes("role = 'office'")
);

const received = progressSteps({ status: "received", received_at: "2026-10-01 15:00:00" });
check("16 received active", received[0].active === true && received[0].label === "Received");
const scheduled = progressSteps({
  status: "scheduled",
  scheduled_for: "2026-10-03",
  scheduled_at: "2026-10-01 16:00:00",
});
check("16 scheduled date", scheduled[1].done === true && scheduled[1].when.includes("Oct"));
const grabbed = progressSteps({ status: "picked_up", picked_up_at: "2026-10-02 15:00:00" });
check("16 skipped", grabbed[2].done === true && grabbed[1].label === "Scheduled (skipped)" && grabbed[1].done === false);

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("deliveries plan tests passed");
