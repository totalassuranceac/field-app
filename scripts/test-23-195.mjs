import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const cases = {
  // Real OCR dump style: G→6
  ocrDump: `
Welcome To
Stripes 2221
6814 Weber Rd
UNLD CR #07 23.1956 52.17
SELF @ 2.249/ G
Subtotal 52.17
TOTAL 52.17
CREDIT DEBIT $ 52.17
USD$52.17
************5017
Entry: Chip Read
ST#2221
1/12/26 6:53:16 AM
`,
  clean: `
Welcome To
Stripes 2221
6814 Weber Rd
UNLD CR #07 23.195G 52.17
SELF @ 2.249 / G
TOTAL 52.17
USD$52.17
************5017
1/12/26 6:53:16 AM
`,
  // Truncated price must NOT yield 52.17/2.25 = 23.186
  badPrice: `
Stripes 2221
6814 Weber Rd
UNLD CR #07 23.195G 52.17
SELF @ 2.25 / G
TOTAL 52.17
USD$52.17
************5017
`,
};

let fail = 0;
for (const [name, text] of Object.entries(cases)) {
  const r = parseReceiptText(text);
  const galOk = r.gallons != null && Math.abs(r.gallons - 23.195) < 0.002;
  const totOk = r.total_cost != null && Math.abs(r.total_cost - 52.17) < 0.01;
  // Must not be the classic wrong derive
  const notWrong = r.gallons == null || Math.abs(r.gallons - 23.186) > 0.001;
  console.log(name, galOk && totOk && notWrong ? "PASS" : "FAIL", {
    gal: r.gallons,
    disp: formatGallonsDisplay(r.gallons),
    total: r.total_cost,
    store: r.store_number,
    card: r.card_last4,
  });
  if (!galOk || !totOk || !notWrong) fail++;
}
if (fail) process.exit(1);
console.log("All PASS");
