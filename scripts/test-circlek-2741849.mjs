/**
 * Regression: Circle K 2741849 — Holly Rd, Corpus Christi
 * Ground truth from photo 9430a576-…jpg.jpeg (2026-07-24):
 *   store Circle K 2741849, 25.029 gal @ $3.699 = $92.58, card ··7716
 */
import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const samples = {
  clean: `7/24/2026 8:32:43 AM
Order Number: 3947166
Circle K  2741849
2202 Holly Rd
Corpus Christi, TX 78415
(361) 854-7769
Register:100 ICR
(DUPLICATE RECEIPT)
Pay at Pump Sale
Pump # 11 UNL-REG
25.029 Gallons @ $3.699/Gal     $92.58
Sub. Total:  $92.58
Tax:  $0.00
Penny Rounding:  $0.00
Total:  $92.58
Discount Total:  $0.00
Visa:  $92.58
Change  $0.00
SALE
Visa
Card Num : (R)
XXXXXXXXXXXX7716
Contactless
USD$ 92.58
CAPITAL ONE VISA
AID: A0000000031010
07/24/2026 08:32:23
`,

  // OCR often mangled brand + 7→1 on card
  ocrBrandTypo: `7/24/2026 8:32:43 AM
Order Number: 3947166
Circte K  2741849
2202 Holly Rd
Corpus Christi, TX 78415
Pump # 11 UNL-REG
25.029 Gallons @ $3.699/Gal     $92.58
Sub. Total:  $92.58
Total:  $92.58
Visa:  $92.58
SALE
Visa
Card Num : (R)
XXXXXXXXXXXX7716
Contactless
USD$ 92.58
CAPITAL ONE VISA
`,

  // Brand on its own line, site # on next (common OCR split)
  brandSplit: `7/24/2026 8:32:43 AM
Circle K
2741849
2202 Holly Rd
25.029 Gallons @ $3.699/Gal $92.58
Total: $92.58
XXXXXXXXXXXX7716
USD$ 92.58
`,

  // CIRCLEK glued, gallons OCR 25.O29 / Gal as Ga1
  ocrJunkNums: `7/24/2026 8:32:43 AM
CIRCLEK 2741849
2202 Holly Rd
Pump #11 UNL-REG
25.O29 Gallons @ $3.699/Ga1 $92.58
Total: $92.58
XXXXXXXXXXXX7716
USD$92.58
`,

  // Card Num line + mask; total only via Visa line
  cardNumLabel: `7/24/2026 8:32:43 AM
Circle K 2741849
25.029 Gallons @ $3.699/Gal $92.58
Sub. Total: $92.58
Total: $92.58
SALE
Visa
Card Num : (R)
XXXXXXXXXXXX7716
Contactless
USD$ 92.58
`,

  // Holly Rd address hint when brand fails entirely
  addressOnly: `7/24/2026 8:32:43 AM
2741849
2202 Holly Rd
Corpus Christi, TX 78415
(361) 854-7769
25.029 Gallons @ $3.699/Gal $92.58
Total: $92.58
XXXXXXXXXXXX7716
USD$ 92.58
`,

  // Realistic messy phone OCR (what often fails store/gallons)
  messyPhone: `7/24/2026 8:32:43 AM
Order Number: 3947166
Cirele K 2741849
2202 Holly Rd
Corpus Christi TX 78415
Pay at Pump Sale
Pump # 11 UNL-REG
25.029 Gallons @ $3.699/Gal $92.58
Sub Total $92.58
Total $92.58
SALE
Visa
Card Num (R)
XXXX XXXX XXXX 7716
Contactless
USD$ 92.58
CAPITAL ONE VISA
`,

  // Price-first line OCR sometimes puts amount before gallons words
  amountFirst: `7/24/2026 8:32:43 AM
Circle K 2741849
UNL-REG
25.029 Gallons @ $3.699/Gal
$92.58
Total: $92.58
XXXXXXXXXXXX7716
`,
};

const expect = {
  date: "2026-07-24",
  time: "08:32",
  storeIncludes: "2741849",
  card: "7716",
  gallons: 25.029,
  total: 92.58,
};

let failed = 0;
for (const [name, text] of Object.entries(samples)) {
  const r = parseReceiptText(text);
  const problems = [];
  if (r.fuel_date !== expect.date) problems.push(`date=${r.fuel_date}`);
  if (r.fuel_time !== expect.time) problems.push(`time=${r.fuel_time}`);
  if (!String(r.store_number || "").includes(expect.storeIncludes)) {
    problems.push(`store=${r.store_number}`);
  }
  if (r.card_last4 !== expect.card) problems.push(`card=${r.card_last4}`);
  if (r.gallons !== expect.gallons) {
    problems.push(`gal=${r.gallons} (disp ${formatGallonsDisplay(r.gallons)})`);
  }
  if (r.total_cost !== expect.total) problems.push(`total=${r.total_cost}`);
  if (r.missing_core.length) problems.push(`missing_core=${r.missing_core.join(",")}`);
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(ok ? "PASS" : "FAIL", name, {
    date: r.fuel_date,
    time: r.fuel_time,
    store: r.store_number,
    card: r.card_last4,
    gal: r.gallons,
    total: r.total_cost,
    conf: r.confidence,
    miss: [...r.missing_core, ...r.missing_extra],
  });
  if (!ok) console.log("  problems:", problems.join("; "));
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
