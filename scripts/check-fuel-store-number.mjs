// Acceptance checks for BUILD-PASTE-fuel-store-number-2026-10-01. Local only: no network, no D1, no deploy.
// Run from the repo root:  node scripts/check-fuel-store-number.mjs
import { buildSync } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "fuel-store-"));
const out = join(dir, "bundle.mjs");
buildSync({
  stdin: {
    contents:
      'export * from "./src/receiptOcr";\nexport * from "./src/lib/fuelStoreFromReceipt";\n',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: out,
  logLevel: "error",
});
const m = await import(pathToFileURL(out).href);

let fail = 0;
const ok = (name, cond, got) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  got: " + JSON.stringify(got)}`);
  if (!cond) fail++;
};

// Receipt #275 OCR text, exactly as stored in fuel_entries.ocr_raw_text (Unit 002, Abel, 9/30/2026)
const R275 =
  "OH THANK HEAVEN\nFOR 7-ELEVEN\n3402 MCKINZIE RD\nCORPUS CHRISTI\nTX\nSTORE :41980\nPHONE : 3614468505\n09/30/2026 13:54:35\nReceipt #:2080568\nTID:00074198001\nPUMP8  RUL\n22.487 GAL 6 3.849 /GAL 86.55\nTRewards $0.05/gal\nSUB TOTAL $86.55\nFUEL TOTAL $86.55\nCREDIT $86.55\nSALE\nVISA\nFrkkkkkkkkk430 1\nAUTH: 012660\nREF :68264915557\nAPPROVED\nEntry :CHIP\nBatch:65\n";
const NO_STORE = R275.replace("STORE :41980\n", "");
// Receipt #206 style: Stripes header, 7-eleven.com footer, masked "Store #"
const R206 =
  "We I cc TO\nstripea #40823\n2022 Rodd Field Rd\nCorpus Christi, TX 78412\n361-985-0998\nUNLD CR #10 20.4356 75.50\nSELF @ 3.699/ G\nTOTAL 75.59\nStore # kkkkxkkkkkkkkRK\nREWARDS @ 7-gleven.con/7rewards\nnow! Careers. 7-eleven.com :\n";
// Garbage OCR that contains "NAS" (receipt #233 style) and a Weber Rd slip with no store line
const GARBAGE = "_ - \n; ) / VT RE m-\n) NAS a, CC\nJk Br i FAAS i es TII08\n";
const WEBER_NO_NUM = "Welcome To\n6418 Weber Rd\nCorpus Christi TX\nGALLONS: 15.408\nPRICE/G 2.659\nFUEL SALE 40.97\n";
const MURPHY = "Murphy USA\n123 Main\nSITE: 7738\nQTY(GAL) 12.345\nFUEL TOTAL 40.00\n";

// Poisoned hints, same shape as prod ocr_memory today
const POISON = {
  subs: {
    global: {
      store_number: { "7-Eleven": "Stripes 9386", "Stripes 9386": "7 Eleven 42360", HHATABURGER: "Whataburger", "Stripes 2271": "Stripes 2221" },
      gallons: { "2.659": "15.408" },
    },
  },
  line_labels: {},
  patterns: { global: { store_number: ["prefer_st_hash"] } },
  known_values: {},
  brand_aliases: [{ key: "QUIK STOP", brand: "Stripes" }],
};

// T1 #275 -> 7-Eleven 41980, no review
const s1 = m.storeFromReceiptText(R275);
ok("T1 #275 store is 7-Eleven 41980", s1.store_label === "7-Eleven 41980" && s1.brand === "7-Eleven" && !s1.needs_review, s1);
// T2 full scan path with poisoned hints still yields 7-Eleven 41980
const p2 = m.parseReceiptText(R275);
const l2 = m.applyReceiptStore(m.applyOcrLearning(p2, R275, POISON), R275, POISON);
ok("T2 #275 through parse + learning + applyReceiptStore", l2.store_number === "7-Eleven 41980" && !l2.store_needs_review, l2.store_number);
// T3 no store line -> blank + review
const l3 = m.applyReceiptStore(m.applyOcrLearning(m.parseReceiptText(NO_STORE), NO_STORE, POISON), NO_STORE, POISON);
ok("T3 no store line -> blank + review", l3.store_number === null && l3.store_needs_review === true && l3.store_brand === "7-Eleven", l3);
// T4 Stripes header beats 7-eleven.com footer
ok("T4 #206 Stripes header -> Stripes 40823", m.storeFromReceiptText(R206).store_label === "Stripes 40823", m.storeFromReceiptText(R206));
// T5 no address / NAS / Weber guesses
const g = m.storeFromReceiptText(GARBAGE), w = m.storeFromReceiptText(WEBER_NO_NUM);
ok("T5a garbage with NAS -> blank + review", g.store_label === null && g.needs_review, g);
ok("T5b Weber Rd without store line -> blank + review", w.store_label === null && w.needs_review, w);
// T6 numeric subs still work; labels never parseFloat-match
ok("T6a gallons sub 2.659 -> 15.408 still applies", m.applyOcrLearning({ ...p2, gallons: 2.659 }, R275, POISON).gallons === 15.408);
// T7 parts/vendor path keeps legacy store subs
const parts = m.applyOcrLearning({ ...p2, store_number: "HHATABURGER" }, "HHATABURGER", POISON, { storeMode: "legacy" });
ok("T7 parts legacy vendor sub still works", parts.store_number === "Whataburger", parts.store_number);
// T8 Murphy SITE
ok("T8 Murphy USA SITE: 7738", m.storeFromReceiptText(MURPHY).store_label === "Murphy USA 7738", m.storeFromReceiptText(MURPHY));
// T9 two different store numbers -> review
const two = m.storeFromReceiptText("Stripes #2221\nWeber\nST#40870\n");
ok("T9 two store numbers -> first label + review", two.store_label === "Stripes 2221" && two.needs_review, two);
// T10 alias gives the brand, never a number
const a1 = m.applyReceiptStore({ store_number: null, store_name: null }, "QUIK STOP\nSTORE: 2215\n", POISON);
const a2 = m.applyReceiptStore({ store_number: null, store_name: null }, "QUIK STOP\nGALLONS: 10.000\n", POISON);
ok("T10a alias header + STORE: 2215 -> Stripes 2215", a1.store_number === "Stripes 2215", a1);
ok("T10b alias header, no store line -> blank + review", a2.store_number === null && a2.store_needs_review, a2);
// T11 known same-brand misread -> flag only, keep printed number
const k = m.applyReceiptStore({ store_number: null, store_name: null }, "Stripes 2271\nGALLONS: 10.000\n", POISON);
ok("T11 Stripes 2271 stays 2271 but is flagged", k.store_number === "Stripes 2271" && k.store_needs_review, k);
// T12 no 9386 anywhere in the parser
ok("T12 parser never invents 9386", ![R275, NO_STORE, R206, GARBAGE, WEBER_NO_NUM].some((t) => /9386/.test(String(m.applyReceiptStore(m.applyOcrLearning(m.parseReceiptText(t), t, POISON), t, POISON).store_number))));

console.log(fail ? `\n${fail} FAILED` : "\nALL PASS");
process.exit(fail ? 1 : 0);
