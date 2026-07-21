import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const text = `
Welcome To
Stripes 2221
6814 Weber Rd
UNLD CR #01 20.137G 49.52
SELF @ 2.459 / G
Subtotal 49.52
TOTAL 49.52
CREDIT DEBIT $ 49.52
USD$49.52
************5017
Entry: Chip Read
ST#2221
1/5/26 8:24:03 AM
`;

const r = parseReceiptText(text);
console.log({
  gal: r.gallons,
  disp: formatGallonsDisplay(r.gallons),
  total: r.total_cost,
  store: r.store_number,
  card: r.card_last4,
});

// Must NOT be reverse-math 20.138
const ok =
  r.gallons != null &&
  Math.abs(r.gallons - 20.137) < 0.0005 &&
  Math.abs((r.total_cost || 0) - 49.52) < 0.01 &&
  formatGallonsDisplay(r.gallons) === "20.137";

if (!ok) {
  console.error("FAIL — expected 20.137 not", r.gallons);
  process.exit(1);
}
console.log("PASS");
