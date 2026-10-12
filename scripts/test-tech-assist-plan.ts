// Run: npx esbuild scripts/test-tech-assist-plan.ts --bundle --platform=node --format=esm --outfile=tmp-tech-assist-test.mjs; node tmp-tech-assist-test.mjs
import { needsSolder, jobNotesFor, SOLDER_TEXT } from "../worker/jobNoteRules";
import { decodeEquipment, tonnageFromModel } from "../worker/equipmentDecode";
import { splitWrapup, splitWrapupSmart, wrapupCopyText } from "../worker/wrapupPlan";
import { buildBriefLines } from "../worker/techBriefPlan";

let fails = 0, n = 0;
function check(name: string, ok: boolean, got?: unknown) {
  n++;
  if (ok) console.log("PASS", name);
  else { fails++; console.log("FAIL", name, got === undefined ? "" : JSON.stringify(got)); }
}
const now = new Date("2026-10-02T13:00:00Z");
const S = (texts: string[], job_type: string | null = null, job_type_id: number | null = null) => needsSolder({ texts, job_type, job_type_id });

// --- SOLDER: the 7 real install/replace jobs from the 10/01 ST scan (MATCHES.md) ---
check("103307", S(["remove and replace compressor, and filter drier"]));
check("102516", S(["replace compressor under manufacturer warranty"]));
check("102050", S(["install new compressor under warranty"]));
check("101972", S(["remove/install compressor under warranty"]));
check("101697", S(["replace warranty compressor, TXV, and filter drier"]));
check("101266", S(["compressor removal/replacement"]));
check("100085", S(["replace faulty compressor"]));
// --- negatives ---
check("104720 roof leak mention", !S(["Roof leak where compressor attaches, check curb and flashing"]));
check("diagnose only", !S(["No cool. Compressor not running, diagnose"]));
check("capacitor job", !S(["replace capacitor and contactor on condenser"]));
check("quote only", !S(["quote only: replace compressor, customer deciding"]));
check("comp alone", !S(["replace comp fan motor"]));
check("empty", !S([null as unknown as string, ""]));
// --- other positives ---
check("TXV replacement", S(["TXV replacement on coil"]));
check("expansion valve swap", S(["Swap expansion valve, pull vacuum"]));
check("HTML text", S(["<p>Tech to <b>R&amp;R</b> compressor</p>"]));
check("job type id 339591774", S([], null, 339591774));
check("job type id 336193175", S([], null, 336193175));
check("job type name", S([], "Warranty Compressor Replacement", 1));
check("custom ids override", needsSolder({ texts: [], job_type: null, job_type_id: 5, solder_type_ids: [5] }));
check("solder text ascii", /^[\x20-\x7E]+$/.test(SOLDER_TEXT) && SOLDER_TEXT.includes("15% silver"));

// --- jobNotesFor ---
const notes = jobNotesFor({ job_type_id: null, job_type: "Service", texts: ["replace compressor"], now,
  prior_jobs: [{ job_number: "104500", completed_on: "2026-09-20T18:00:00Z", job_type: "No Cool" }],
  equipment: [{ mfg_year: 2008, refrigerant_hint: "likely R-22 (check nameplate)" }] });
check("notes order", notes.map((x) => x.code).join(",") === "SOLDER,CALLBACK_30D,OPTIONS_AGE,R22", notes);
check("callback text CT date", notes[1]?.text.includes("9/20") && notes[1]?.text.includes("#104500"), notes[1]);
check("old callback ignored", jobNotesFor({ job_type_id: null, job_type: null, texts: [], now, prior_jobs: [{ job_number: "1", completed_on: "2026-08-01T00:00:00Z", job_type: null }] }).length === 0);
check("young unit no options", jobNotesFor({ job_type_id: null, job_type: null, texts: [], now, equipment: [{ mfg_year: 2020, refrigerant_hint: "likely R-410A" }] }).length === 0);

// --- equipment decode ---
const len = decodeEquipment("Lennox", "ML17XC1-018-230A02", "1924B28788", now);
check("lennox year/month", len.mfg_year === 2024 && len.mfg_month === 2, len);
check("lennox tonnage 1.5 high", len.tonnage === 1.5 && len.confidence === "high", len);
const car = decodeEquipment("Carrier", "24ACC636A003", "2419E12345", now);
check("carrier wk24 2019", car.mfg_year === 2019 && car.mfg_month === 6, car);
check("carrier 636 -> 3 ton low path", car.tonnage === 3, car);
const goo = decodeEquipment("Goodman", "GSX140361", "1905123456", now);
check("goodman 2019-05 3 ton", goo.mfg_year === 2019 && goo.mfg_month === 5 && goo.tonnage === 3, goo);
const tr = decodeEquipment("Trane", "4TTR4036L1000A", "19321ABCDE", now);
check("trane 2019 wk32 3 ton", tr.mfg_year === 2019 && tr.mfg_month === 8 && tr.tonnage === 3, tr);
const rh = decodeEquipment("Rheem", "RA1448AJ1NA", "W061912345", now);
check("rheem 2019-06 4 ton (1448 -> 48)", rh.mfg_year === 2019 && rh.mfg_month === 6 && rh.tonnage === 4 && rh.confidence === "medium", rh);
const old = decodeEquipment("Goodman", "CK36-1", "0207654321", now);
check("2002 -> R-22 hint", old.mfg_year === 2002 && String(old.refrigerant_hint).startsWith("likely R-22"), old);
const fut = decodeEquipment("Goodman", null, "2905123456", now);
check("future year rejected (29 -> 1929 < 1990)", fut.mfg_year === null && fut.confidence === "low", fut);
const unk = decodeEquipment("York", "YCD036", "W1K1234567", now);
check("york unknown serial, tonnage only", unk.mfg_year === null && unk.tonnage === 3 && unk.confidence === "medium", unk);
check("no model", tonnageFromModel(null).tons === null);
check("2025 unit A2L hint", String(decodeEquipment("Goodman", null, "2503123456", now).refrigerant_hint).includes("A2L"));

// --- wrap-up split ---
const w = splitWrapup("Found low charge and a leak at the TXV. Replaced TXV and brazed in with 15% silver. Recommend coil cleaning next visit. Used 1 TXV and 2 sticks of solder");
check("wrapup found", w.found.length === 1 && w.found[0].startsWith("Found low charge"), w);
check("wrapup did", w.did.length === 1 && w.did[0].startsWith("Replaced TXV"), w);
check("wrapup recommend", w.recommend.length === 1, w);
check("wrapup parts", w.parts.length === 1 && w.parts[0].includes("2 sticks"), w);
check("copy text", wrapupCopyText(w).split("\n").length === 4 && wrapupCopyText({ found: [], did: [], recommend: [], parts: [] }).includes("FOUND: -"));
check("wrapup ascii + caps", splitWrapup("um reset breaker \u2014 unit running").did[0] === "Reset breaker   unit running".replace(/\s+/g, " "), splitWrapup("um reset breaker \u2014 unit running"));

// --- AI fallback (async) ---
(async () => {
  const noAi = await splitWrapupSmart("Replaced capacitor");
  check("no ai -> rules", noAi.split_by === "rules" && noAi.result.did.length === 1);
  const bad = await splitWrapupSmart("Replaced capacitor", async () => ({ ok: true, text: "not json", model: "x" }));
  check("bad json -> rules", bad.split_by === "rules");
  const thrown = await splitWrapupSmart("Replaced capacitor", async () => { throw new Error("boom"); });
  check("throw -> rules", thrown.split_by === "rules");
  const off = await splitWrapupSmart("Replaced capacitor", async () => ({ ok: false, reason: "off" }));
  check("off -> rules", off.split_by === "rules");
  const good = await splitWrapupSmart("x", async () => ({ ok: true, text: '{"found":["Weak cap"],"did":["Replaced cap"],"recommend":[],"parts":["45/5 cap"]}', model: "m" }));
  check("good ai -> ai", good.split_by === "ai" && good.result.did[0] === "Replaced cap");

  // --- brief lines ---
  const lines = buildBriefLines({
    now,
    notes: jobNotesFor({ job_type_id: 339591774, job_type: "Compressor Replacement", texts: [], now, equipment: [{ mfg_year: 2010, refrigerant_hint: "likely R-410A" }] }),
    past_jobs: [{ job_number: "104500", date: "2026-09-20T18:00:00Z", job_type: "No Cool" }, { job_number: "100001", date: "2025-01-05T18:00:00Z", job_type: "Maintenance" }],
    equipment: [{ unit_role: "outdoor", manufacturer: "Lennox", model_number: "ML17XC1-018", tonnage: 1.5, mfg_year: 2010 }],
    warranty: [{ log_number: "W1026-002", part_name: "A2L sensor" }],
    open_estimates: 2, access_code: "#1234", permit_blocking: true,
  });
  check("brief starts with SOLDER", lines[0] === SOLDER_TEXT, lines);
  check("brief last-here line", lines.some((l) => l.startsWith("Last here: 9/20/2026 No Cool (#104500). 1 job here in 12 months.")), lines);
  check("brief equipment line", lines.includes("Outdoor: Lennox ML17XC1-018, 1.5 ton, made 2010 (16 yrs)"), lines);
  check("brief talk last", lines[lines.length - 1].startsWith("Unit is about 16 years old"), lines);
  check("brief max 8 + ascii", lines.length <= 8 && lines.every((l) => /^[\x20-\x7E]*$/.test(l)), lines);
  check("first visit", buildBriefLines({ notes: [], past_jobs: [], equipment: [], warranty: [], open_estimates: 0, access_code: null, permit_blocking: false, now })[0] === "First visit on record at this address.");

  console.log(`${n - fails}/${n} PASS`);
  process.exit(fails ? 1 : 0);
})();
