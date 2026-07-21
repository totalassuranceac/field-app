import { parseReceiptText } from "../src/receiptOcr";

const sample = `
Welcome To
Stripes 2221
6814 Weber Rd
Corpus Christi, Tx 78413
UNLD CR #09 15.408G 40.97
SELF @ 2.659 / G
Subtotal 40.97
TOTAL 40.97
CREDIT DEBIT $ 40.97
USD$40.97
************7716
Entry: Contactless ICC
AppName: CAPITAL ONE VISA
Auth #: 057878
ST#2221
1/13/26 8:16:50 AM
`;

const r = parseReceiptText(sample);
console.log({
  gallons: r.gallons,
  card_last4: r.card_last4,
  total_cost: r.total_cost,
  store: r.store_number,
  date: r.fuel_date,
});

const ok =
  r.gallons != null &&
  Math.abs(r.gallons - 15.408) < 0.01 &&
  r.card_last4 === "7716" &&
  r.total_cost != null &&
  Math.abs(r.total_cost - 40.97) < 0.05;

if (!ok) {
  console.error("FAIL");
  process.exit(1);
}
console.log("PASS");
