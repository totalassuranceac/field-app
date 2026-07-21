import { parseReceiptText } from "../src/receiptOcr.ts";

const cases = {
  // Real tesseract dump from ce30b44b photo
  realDump: `
y A )
VSirine i
6418 Weber R
( pu Christi, TX
DATE 3/6/26 10:19 pec T
SERVICE LEVEL: SELF
PRODUCT: UNLD
GALLONS: 25.008
PRICE/G: $3.199
FUEL SALE $80.00
CREDIT DE $80.00
UsD$80.00
XKKXKXXXKXKXX()G7Q
Entry: Chip Read
AppNane: CAPITAL ONE
AuthNet: VISA
Auth #: 005109
Stan: 365524189274
`,
  clean: `
Welcome to
Stripes 2221
6418 Weber Rd
Corpus Christi, TX
DATE 3/6/26 10:19
GALLONS: 25.008
PRICE/G: $3.199
FUEL SALE $80.00
CREDIT DE $80.00
USD$80.00
************0879
Entry: Chip Read
AppName: CAPITAL ONE
VISA
`,
  weberOnly: `
6418 Weber Rd
Corpus Christi TX
DATE 3/6/26 10:19
GALLONS: 25.008
USD$80.00
************0879
Entry: Chip Read
`,
};

let fail = 0;
for (const [name, text] of Object.entries(cases)) {
  const r = parseReceiptText(text);
  const storeOk = String(r.store_number || "").includes("2221");
  const cardOk = r.card_last4 === "0879";
  const ok = storeOk && cardOk && r.gallons != null && Math.abs(r.gallons - 25.008) < 0.02;
  console.log(name, ok ? "PASS" : "FAIL", {
    store: r.store_number,
    card: r.card_last4,
    gal: r.gallons,
    total: r.total_cost,
    date: r.fuel_date,
    time: r.fuel_time,
  });
  if (!ok) fail++;
}
if (fail) process.exit(1);
console.log("All PASS");
