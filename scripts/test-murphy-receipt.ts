import { parseReceiptText } from "../src/receiptOcr";

function run(
  name: string,
  sample: string,
  expect: {
    gallons: number;
    card: string;
    total: number;
    storeIncludes: string;
    brandIncludes: string;
    date: string;
    time: string;
  }
) {
  const r = parseReceiptText(sample);
  console.log(`\n=== ${name} ===`);
  console.log({
    gallons: r.gallons,
    card_last4: r.card_last4,
    total_cost: r.total_cost,
    store: r.store_number,
    store_name: r.store_name,
    date: r.fuel_date,
    time: r.fuel_time,
  });
  const checks: [string, boolean][] = [
    [
      `gallons exact ${expect.gallons}`,
      r.gallons != null && Math.abs(r.gallons - expect.gallons) < 0.0005,
    ],
    // Must NOT be the common reverse-math error (total÷price rounded)
    [
      "not reverse-math gallons",
      !(
        expect.gallons === 22.679 &&
        r.gallons != null &&
        Math.abs(r.gallons - 22.68) < 0.0005 &&
        Math.abs(r.gallons - 22.679) >= 0.0005
      ),
    ],
    [`card ${expect.card}`, r.card_last4 === expect.card],
    [
      `total ${expect.total}`,
      r.total_cost != null && Math.abs(r.total_cost - expect.total) < 0.02,
    ],
    [
      `store ${expect.storeIncludes}`,
      (r.store_number || "").includes(expect.storeIncludes) ||
        (r.store_name || "").includes(expect.storeIncludes),
    ],
    [
      `brand ${expect.brandIncludes}`,
      (r.store_name || "").toLowerCase().includes(expect.brandIncludes.toLowerCase()),
    ],
    [`date ${expect.date}`, r.fuel_date === expect.date],
    [`time ${expect.time}`, r.fuel_time === expect.time],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(ok ? `PASS ${label}` : `FAIL ${label}`);
    if (!ok) failed++;
  }
  return failed;
}

const usa = `
Murphy USA 7738
2045 Hwy. 181
Portland, TX 78374
07-17-26  08:37
SITE:          7738
TRACE:         3871
Merch***********5001
SALE
Visa
************0058
Entry Method: Q
Invoice#: 300462
Auth.#: 002359
CARD AMT: $  78.65
PUMP:           16
PROD:       UNLEAD
PRICE/GAL:   $3.429
NET/GAL:     $3.429
QTY(GAL):    22.936
FUEL TOTAL:  $78.65
NET TOTAL:    $78.65
`;

/** Live correction: Express not USA; gallons 22.679 not 22.680 from math */
const express = `
Murphy Express 8691
1302 Flour Bluff Dr.
Corpus Christi, TX 78418
07-22-26  14:41
SITE:          8691
TRACE:         9830
Merch***********7001
SALE
Visa
************0058
Entry Method: Q
Invoice#: 186285
Auth.#: 026510
CARD AMT: $  85.48
PUMP:            8
PROD:       UNLEAD
PRICE/GAL:   $3.769
NET/GAL:     $3.769
QTY(GAL):    22.679
FUEL TOTAL:  $85.48
NET TOTAL:    $85.48
murphysusa.com
`;

let failed = 0;
failed += run("Murphy USA 7738", usa, {
  gallons: 22.936,
  card: "0058",
  total: 78.65,
  storeIncludes: "7738",
  brandIncludes: "Murphy USA",
  date: "2026-07-17",
  time: "08:37",
});
failed += run("Murphy Express 8691", express, {
  gallons: 22.679,
  card: "0058",
  total: 85.48,
  storeIncludes: "8691",
  brandIncludes: "Murphy Express",
  date: "2026-07-22",
  time: "14:41",
});

// Explicit trap: total÷price must not win when QTY is present
const mathTrap = parseReceiptText(express);
const derived = Math.round((85.48 / 3.769) * 1000) / 1000; // 22.68
console.log(`\nMath trap: derived=${derived} scanned=${mathTrap.gallons}`);
if (mathTrap.gallons === derived && derived !== 22.679) {
  console.log("FAIL used reverse-math gallons");
  failed++;
} else {
  console.log("PASS preferred printed QTY over reverse-math");
}

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nALL PASS");
