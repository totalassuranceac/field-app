/**
 * Correct Circle K receipt: cbfd0844-… (Agnes St) — NOT the Holly Rd photo.
 * Ground truth:
 *   Circle K 2706973 · 2730 Agnes St
 *   6/7/2026 1:45 PM · 22.116 gal @ $3.499 = $77.38 · card ··0028
 * Handwritten 177841 on top is odometer — never read as fuel field.
 */
import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const clean = `6/7/2026 1:45:05 PM
Order Number: 1915652
Circle K  2706973
2730 Agnes St
Corpus Christi, TX 78405
(361) 888-9397
Register:100 ICR
(DUPLICATE RECEIPT)
Pay at Pump Sale
Pump # 5 UNL-REG
22.116 Gallons @ $3.499/Gal     $77.38
Sub. Total:  $77.38
Tax:  $0.00
Penny Rounding:  $0.00
Total:  $77.38
Discount Total:  $0.00
Visa:  $77.38
Change  $0.00
SALE
Visa
Card Num : (R)
XXXXXXXXXXXX0028
Contactless
USD$ 77.38
CAPITAL ONE VISA
06/07/2026 13:44:44
Thank You
Come Again
`;

// Address when brand OCR fails
const agnesOnly = `6/7/2026 1:45:05 PM
2706973
2730 Agnes St
Corpus Christi, TX 78405
(361) 888-9397
22.116 Gallons @ $3.499/Gal $77.38
Total: $77.38
XXXXXXXXXXXX0028
USD$ 77.38
`;

// Real-ish OCR junk (date header lost, footer partial)
const messy = `Order Number i * or
Circle K 2706973
2730 Agnes St
Corpus Christi, TX 78405
(DUPLICATE RECEIPT)
Pay at Pump Sale
Pump # 5 UNL-REG
22.116 Gallons @ $3.499/Gal $77.38
Sub. Total: $77.38
Total: $77.38
Visa: $77.38
SALE
Visa
Card Num : (R)
XXXXXXXXXXXX0028
Contactless
USD$ 77.38
CAPITAL ONE VISA
06/07/2026 13:44:44
Thank You
`;

const expect = {
  date: "2026-06-07",
  storeIncludes: "2706973",
  card: "0028",
  gal: 22.116,
  total: 77.38,
};

let fail = 0;
for (const [name, text] of Object.entries({ clean, agnesOnly, messy })) {
  const r = parseReceiptText(text);
  const problems = [];
  if (r.fuel_date !== expect.date) problems.push(`date=${r.fuel_date}`);
  if (!String(r.store_number || "").includes(expect.storeIncludes)) {
    problems.push(`store=${r.store_number}`);
  }
  // Must never pick Holly Rd store from Agnes slip
  if (String(r.store_number || "").includes("2741849")) {
    problems.push("wrong store 2741849 (Holly Rd leak)");
  }
  if (r.card_last4 !== expect.card) problems.push(`card=${r.card_last4}`);
  if (r.gallons !== expect.gal) {
    problems.push(`gal=${r.gallons} (${formatGallonsDisplay(r.gallons)})`);
  }
  if (r.total_cost !== expect.total) problems.push(`total=${r.total_cost}`);
  // Handwritten odo must not become gallons
  if (r.gallons === 177841 || r.gallons === 177.841) problems.push("read handwritten odo as gallons");
  const ok = problems.length === 0;
  if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", name, {
    date: r.fuel_date,
    time: r.fuel_time,
    store: r.store_number,
    card: r.card_last4,
    gal: r.gallons,
    total: r.total_cost,
    conf: r.confidence,
  });
  if (!ok) console.log("  ", problems.join("; "));
}

console.log(fail ? `\n${fail} FAIL` : "\nALL PASS");
process.exit(fail ? 1 : 0);
