/**
 * Quick unit check for Stripes OCR parse (gallons vs $/gal, card last4).
 * Run: node scripts/test-stripes-receipt.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import path from "path";
import { fileURLToPath } from "url";

// Parse TypeScript via dynamic import of built path — use ts transpile inline
// Instead reimplement minimal by spawning vite-node or compile with esbuild if available.
// Simplest: duplicate export by reading and eval — use `npx tsx` if present.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

async function loadParse() {
  try {
    const mod = await import(pathToFileURL(path.join(root, "src/receiptOcr.ts")).href);
    return mod.parseReceiptText;
  } catch {
    // Fallback: use npx tsx in parent — parse via child
    return null;
  }
}

const sample = `
Welcome To
Stripes 2221
6814 Weber Rd
Corpus Christi, Tx 78413
361-855-8865
Sunoco
6814 WEBER ROAD
CORPUS CHRISTI TX 78413
Description Qty Amount
UNLD CR #09 15.408G 40.97
SELF @ 2.659 / G
Subtotal 40.97
TOTAL 40.97
CREDIT DEBIT $ 40.97
USD$40.97
************7716
Entry: Contactless ICC
AppName: CAPITAL ONE VISA
AuthNet: VISA
MODE: Issuer
AID: A0000000031010
Auth #: 057878
Resp Code: 000
Stan: 360323845307
Invoice #: 334101
Shift #: 1
Store # ***************
THANKS COME AGAIN
ST#2221
DR#1 TRAN#9097909
1/13/26 8:16:50 AM
`;

const parse = await loadParse();
if (!parse) {
  console.error("Could not import receiptOcr.ts directly; run with: npx tsx scripts/test-stripes-receipt.ts");
  process.exit(1);
}

const r = parse(sample);
console.log(JSON.stringify(r, null, 2));
const ok =
  r.gallons != null &&
  Math.abs(r.gallons - 15.408) < 0.01 &&
  r.card_last4 === "7716" &&
  r.total_cost != null &&
  Math.abs(r.total_cost - 40.97) < 0.02;
if (!ok) {
  console.error("FAIL expected gallons=15.408 card=7716 total=40.97");
  process.exit(1);
}
console.log("PASS");
