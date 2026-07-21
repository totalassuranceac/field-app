import { parseReceiptText, formatGallonsDisplay } from "../src/receiptOcr.ts";

const clean = `
7-ELEVEN
OH THANK HEAVEN
TID : 00074236001
10/02/2025 19:43:59
Receipt # 2042253
2000 S US HWY 77
KINGSVILLE, TX
STORE: 42360
PHONE: 3612198742
SALE
VISA
************0879
AUTH :071024
PUMP 4
GRADE RUL
GALLONS 5.167
PRICE/GAL $ 2.929
FUEL TOTAL $ 15.13
`;

// Garbled time seconds like phone OCR
const garbledTime = `
7 ELEVEN
OH THANK HEAVEN
10/02/2025 19:43:5¢
STORE: 42360
GALLONS 5.167
PRICE/GAL $ 2.929
FUEL TOTAL $ 15.13
************0879
`;

// Must NOT become Stripes 9386 from random noise / heaven slogan
const noFalseStripes = `
7 ELEVEN Eero
c ur THAT
10/02/2025 19:43:5¢
STORE: 42366
PHONE: 361219874
GALLONS 5.167
PRICE/GAL $ 2.929
FUEL TOTAL $ 15.13
`;

for (const [name, text] of Object.entries({ clean, garbledTime, noFalseStripes })) {
  const r = parseReceiptText(text);
  const storeOk = String(r.store_number || "").toLowerCase().includes("7-eleven") &&
    String(r.store_number || "").includes("4236");
  const dateOk = r.fuel_date === "2025-10-02";
  const timeOk = r.fuel_time === "19:43";
  const notStripes = !/stripes/i.test(String(r.store_number || ""));
  console.log(name, storeOk && dateOk && timeOk && notStripes ? "PASS" : "FAIL", {
    store: r.store_number,
    date: r.fuel_date,
    time: r.fuel_time,
    gal: r.gallons,
    galDisp: formatGallonsDisplay(r.gallons),
    total: r.total_cost,
    card: r.card_last4,
  });
  if (!(storeOk && dateOk && timeOk && notStripes)) process.exitCode = 1;
}
