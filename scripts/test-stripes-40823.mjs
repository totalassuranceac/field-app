import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const text = `
Welcome To
Stripes #40823
2022 Rodd Field Rd
Corpus Christi, TX 78412
361-985-0998
NE CORNER RODD FIE
UNLD CR #13 17.757G 67.10
SELF @ 3.779 / G
Subtotal 67.10
TOTAL 67.10
CREDIT DEBIT $ 67.10
USD$67.10
************6069
Entry: Contactless ICC
ST#2453
CSH: 0
5/17/26 11:02:15 AM
`;

const r = parseReceiptText(text);
console.log({
  store: r.store_number,
  gal: r.gallons,
  disp: formatGallonsDisplay(r.gallons),
  total: r.total_cost,
  card: r.card_last4,
  date: r.fuel_date,
});

const ok =
  String(r.store_number).includes("40823") &&
  !String(r.store_number).includes("2453") &&
  r.gallons != null &&
  Math.abs(r.gallons - 17.757) < 0.0005 &&
  Math.abs((r.total_cost || 0) - 67.1) < 0.02;

if (!ok) {
  console.error("FAIL");
  process.exit(1);
}
console.log("PASS");
