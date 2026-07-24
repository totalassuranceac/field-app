/**
 * Real Tesseract dump from photo 9430a576-… (Circle K Holly Rd).
 * Ground truth: store 2741849, 25.029 gal, $92.58, card 7716.
 * Known OCR bugs: 25.079 (not 25.029), "Circle Kk", optional 7716→1716.
 */
import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const realDump = `a_i
Or. 7/24/2026 8:32:43 AM
"®r Number : 3947166
Circle Kk 2741849
2 2202 Holly Rd
: Corpus Christi, TX 78415
pe (361) 854-7769
"ister:100 ICR
(DUPLICATE RECEIPT)
( DUPLICATE RECEIPT )
Pay at pump Sale
Pump # 11 UNL-REG
25.079 Gallons @ $3.699/Gal $92.58
Sub. Total: $92.58 ~
Tax: $0.00
Penny Rounding: $0.00
Total: $92.58
Discount Total: $0.00
Visa: $92.58
Change $0.00
SALE
Visa
Card Num : (R)
XXXXXXXXXXXX7716
Contactless
USD$ 92.58
bE CAPITAL ONE VISA
; AID: A0000000031010
i TVR: 0000000000
a TAD: XXXXXXXXXXXXXX
TSI: 0000
ARC: 00
ARQC:
59DBEB7CA918C712
07/24/2026 08:32:23
1 agree to pay the
above Total Amount
according to Card
pe Issuer Agreement.
`;

// What the phone UI showed: wrong card only + missing body (date/time ok)
const weakPhone = `7/24/2026 8:32:43 AM
Order Number: 3947166
(DUPLICATE RECEIPT)
Pay at Pump Sale
SALE
Visa
XXXXXXXXXXXX1716
Contactless
USD$
CAPITAL ONE VISA
07/24/2026 08:32:23
`;

// Weak phone but body available from second pass
const weakPlusBody = `${weakPhone}
Circle Kk 2741849
2202 Holly Rd
25.079 Gallons @ $3.699/Gal $92.58
Total: $92.58
XXXXXXXXXXXX7716
USD$ 92.58
`;

const cases = [
  {
    name: "realDump",
    text: realDump,
    expect: {
      date: "2026-07-24",
      storeIncludes: "2741849",
      card: "7716",
      gal: 25.029, // pump-math correct from 25.079
      total: 92.58,
    },
  },
  {
    name: "weakPlusBody",
    text: weakPlusBody,
    expect: {
      date: "2026-07-24",
      storeIncludes: "2741849",
      card: "7716", // mask 7716 beats 1716
      gal: 25.029,
      total: 92.58,
    },
  },
];

let fail = 0;
for (const { name, text, expect } of cases) {
  const r = parseReceiptText(text);
  const problems = [];
  if (r.fuel_date !== expect.date) problems.push(`date=${r.fuel_date}`);
  if (!String(r.store_number || "").includes(expect.storeIncludes)) {
    problems.push(`store=${r.store_number}`);
  }
  if (r.card_last4 !== expect.card) problems.push(`card=${r.card_last4}`);
  if (r.gallons !== expect.gal) {
    problems.push(`gal=${r.gallons} (${formatGallonsDisplay(r.gallons)})`);
  }
  if (r.total_cost !== expect.total) problems.push(`total=${r.total_cost}`);
  const ok = problems.length === 0;
  if (!ok) fail++;
  console.log(ok ? "PASS" : "FAIL", name, {
    store: r.store_number,
    card: r.card_last4,
    gal: r.gallons,
    total: r.total_cost,
    conf: r.confidence,
  });
  if (!ok) console.log("  ", problems.join("; "));
}

// weak phone alone — document that body is required
const weak = parseReceiptText(weakPhone);
console.log("weakPhone alone (expected incomplete):", {
  store: weak.store_number,
  card: weak.card_last4,
  gal: weak.gallons,
  total: weak.total_cost,
  miss: [...weak.missing_core, ...weak.missing_extra],
});

console.log(fail ? `\n${fail} FAIL` : "\nALL PASS");
process.exit(fail ? 1 : 0);
