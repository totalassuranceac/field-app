import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

// Clean slip matching photo 1016fee0 (21.701 gal, $2.319, $50.32)
const clean = `
Welcome to
Stripes 2221
6418 Weber Rd
Corpus Christi, TX
361-855-8865
DATE 1/23/26 9:47
TRAN#9132327
PUMP# 13
SERVICE LEVEL: SELF
PRODUCT: UNLD
GALLONS: 21.701
PRICE/G: $2.319
FUEL SALE $50.32
CREDIT DE $50.32
USD$50.32
************5017
Entry: Chip Read
`;

// Wrong price OCR but labeled totals agree — must keep $50.32 (not invent $50.57)
const wrongPrice = `
Stripes 2221
6418 Weber Rd
DATE 1/23/26 9:47
GALLONS: 21.701
PRICE/G: $2.330
FUEL SALE $50.32
CREDIT DE $50.32
USD$50.32
************5017
Entry: Chip Read
`;

// One line OCR wrong — consensus of CREDIT DE + USD$ wins
const mixed = `
GALLONS: 21.701
PRICE/G: $2.319
FUEL SALE $50.57
CREDIT DE $50.32
USD$50.32
`;

// Gallons last digit OCR 21.700 but price correct — keep total $50.32; gal may stay 21.700
// (21.700×2.319 still rounds to $50.32)
const galSlight = `
Stripes 2221
6418 Weber Rd
DATE 1/23/26 9:47
GALLONS: 21.700
PRICE/G: $2.319
FUEL SALE $50.32
CREDIT DE $50.32
USD$50.32
************5017
`;

for (const [name, text, check] of [
  ["clean", clean, { gal: 21.701, total: 50.32 }],
  ["wrongPrice", wrongPrice, { gal: 21.701, total: 50.32 }],
  ["mixed", mixed, { gal: 21.701, total: 50.32 }],
  ["galSlight", galSlight, { gal: 21.7, total: 50.32, galTol: 0.002 }],
]) {
  const r = parseReceiptText(text);
  const tol = check.galTol ?? 0.0015;
  const galOk = r.gallons != null && Math.abs(r.gallons - check.gal) <= tol;
  const totOk = r.total_cost != null && Math.abs(r.total_cost - check.total) < 0.01;
  console.log(name, galOk && totOk ? "PASS" : "FAIL", {
    store: r.store_number,
    card: r.card_last4,
    gal: r.gallons,
    galDisp: formatGallonsDisplay(r.gallons),
    total: r.total_cost,
    date: r.fuel_date,
  });
  if (!galOk || !totOk) process.exitCode = 1;
}
