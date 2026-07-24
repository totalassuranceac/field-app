import { parsePartsReceiptText } from "../src/partsReceiptOcr.ts";

const samples = {
  johnstone: `JOHNSTONE SUPPLY
Corpus Christi
INVOICE NO: JS-4829103
Date: 7/22/2026
Qty  Description
1  Contactor 40A
TOTAL DUE  $87.45
************7716
VISA
`,
  packingSlip: `Carrier Enterprise
PACKING SLIP # CE-99201
PO: 12345
Ship date 07/20/2026
Line items...
`,
  homeDepot: `THE HOME DEPOT
Store #4821
07/21/2026
TOTAL  $42.19
XXXXXXXXXXXX5017
`,
};

let fail = 0;
for (const [name, text] of Object.entries(samples)) {
  const r = parsePartsReceiptText(text);
  console.log(name, r);
  if (name === "johnstone") {
    if (r.vendor_name !== "Johnstone" || !r.invoice_number?.includes("4829103") || r.total_cost !== 87.45) {
      fail++;
      console.log("  FAIL johnstone");
    }
  }
  if (name === "packingSlip") {
    if (!/Carrier/i.test(r.vendor_name || "") || !r.invoice_number?.includes("99201")) {
      fail++;
      console.log("  FAIL packingSlip");
    }
  }
  if (name === "homeDepot") {
    if (r.vendor_name !== "Home Depot" || r.total_cost !== 42.19) {
      fail++;
      console.log("  FAIL homeDepot");
    }
  }
}
console.log(fail ? `${fail} FAIL` : "ALL PASS");
process.exit(fail ? 1 : 0);
