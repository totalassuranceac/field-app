import { createRequire } from "module";
import { pathToFileURL } from "url";
import { readFileSync, writeFileSync } from "fs";

// Compile-free: duplicate import via dynamic after building a temp ts strip — use tsx if available
// Prefer running through node with the source as plain JS by importing built output.
// For local: use dynamic import of the TS via experimental — fall back to copying parser logic test.

async function main() {
  let parseReceiptText;
  try {
    // Vite/ts may not resolve; try direct
    const mod = await import("../src/receiptOcr.ts");
    parseReceiptText = mod.parseReceiptText;
  } catch (e) {
    console.error("import failed", e.message);
    // strip types manually for a quick test? use npx tsx
    process.exit(1);
  }

  const clean = `
Welcome To
Stripes 5216
601 S.P.I.D.
Corpus Christi, TX
361-814-8206
601 SOUTH PADRE IS
CORPUS CHRISTI TX 78405
DUPLICATE RECEIPT
Description Qty Amount
UNLD CR #13 20.220G 55.79
SELF @ 2.759 / G
Subtotal 55.79
TOTAL 55.79
CREDIT DEBIT
USD$55.79
************1845
Entry: Contactless ICC
AppName: CAPITAL ONE VISA
AuthNet: VISA
MODE: Issuer
AID: A0000000031010
Auth #: 005455
Resp Code: 000
Stan: 01911250759
Invoice #: 415199
Shift #: 1
Store # **************
THANKS COME AGAIN
ST#5216 DR#1 TRAN#9132860
CSH: 0 2/23/26 12:00:59 PM
`;

  const cases = {
    clean,
    noG: `
Stripes 5216
UNLD CR #13 20.220 55.79
SELF @ 2.759 / G
USD$55.79
xxxxx***xx1845
Entry: Contactless ICC
ST#5216
2/23/26 12:00:59 PM
`,
    gGlued: `
Stripes 5216
UNLD CR #13 20.2206 55.79
SELF @ 2.759 / G
USD$55.79
* * * * * * * * * * * *1845
Entry Contactless
2/23/26 12:00:59PM
ST#5216
`,
    ocrJunk: `
Welcome To
Stripes 5216
UNLD CR #13 2O.22OG 55.79
SELF @ 2.759 / G
Sub total 55.79
TOTAL 55.79
USD$55.79
xxxxxxxxxxxx1845
Entry: Contactless ICC
AppName: CAPITAL ONE VISA
ST#5216 DR#1
2/23/26 12:00:59 PM
`,
    // Worst case: gallons OCR lost, only total + price visible
    derived: `
Stripes 5216
UNLD CR #13 55.79
SELF @ 2.759 / G
TOTAL 55.79
USD$55.79
************1845
2/23/26 12:00:59 PM
ST#5216
`,
    // Actual tesseract dump from photo 39a7b14d… (20.220G lost, USD spaced)
    realOcrDump: `
Welcome To
Stripes 5216
NLD CR #13
SELF @ 2.7597 6 Pra
TOTAL ) 3
USD$55. 78
Kdxionkkk 1845
Entry: Contactless IC
AppName: CAPITAL ONE VISA
Auth #: 005455
ST#5216 DR#1 TRANS 132860
0 2/23/26 12:00:59 pM
`,
  };

  let failed = 0;
  for (const [name, text] of Object.entries(cases)) {
    const r = parseReceiptText(text);
    const ok =
      r.fuel_date === "2026-02-23" &&
      r.fuel_time === "12:00" &&
      String(r.store_number || "").includes("5216") &&
      r.card_last4 === "1845" &&
      r.gallons != null &&
      r.gallons > 18 &&
      r.gallons < 22 &&
      r.total_cost != null &&
      r.total_cost > 50 &&
      r.total_cost < 60 &&
      // Must NOT put the dollar total into gallons
      Math.abs(r.gallons - (r.total_cost || 0)) > 5;

    console.log("\n===", name, ok ? "PASS" : "FAIL", "===");
    console.log({
      date: r.fuel_date,
      time: r.fuel_time,
      store: r.store_number,
      card: r.card_last4,
      gallons: r.gallons,
      total: r.total_cost,
      conf: r.confidence,
      missing: [...r.missing_core, ...r.missing_extra],
    });
    if (!ok) failed++;
  }
  if (failed) {
    console.error("\n" + failed + " case(s) failed");
    process.exit(1);
  }
  console.log("\nAll cases PASS");
}

main();
