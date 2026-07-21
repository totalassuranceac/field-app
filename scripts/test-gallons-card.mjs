import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const t = `
Welcome to
Stripes 2221
6418 Weber Rd
Corpus Christi, TX
361-855-8865
DATE 3/4/26 14:23
GALLONS: 16.290
PRICE/G: $2.999
FUEL SALE $48.85
CREDIT DE $48.85
USD$48.85
************8114
Entry: Chip Read
`;

const r = parseReceiptText(t);
console.log({
  store: r.store_number,
  card: r.card_last4,
  gallons: r.gallons,
  gallonsDisplay: formatGallonsDisplay(r.gallons),
  total: r.total_cost,
  date: r.fuel_date,
  time: r.fuel_time,
});

const ok =
  String(r.store_number).includes("2221") &&
  r.card_last4 === "8114" &&
  formatGallonsDisplay(r.gallons) === "16.290" &&
  r.total_cost === 48.85 &&
  r.fuel_date === "2026-03-04";

// Weber-only (brand OCR failed)
const w = parseReceiptText(`
6418 Weber Rd
Corpus Christi
DATE 3/4/26 14:23
GALLONS: 16.290
PRICE/G: $2.999
FUEL SALE $48.85
USD$48.85
************8114
`);
console.log("weber-only store", w.store_number, formatGallonsDisplay(w.gallons));

if (!ok || !String(w.store_number).includes("2221")) {
  console.error("FAIL");
  process.exit(1);
}
console.log("PASS");
