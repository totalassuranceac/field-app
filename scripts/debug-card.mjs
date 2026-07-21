import { parseReceiptText } from "../src/receiptOcr.ts";
import { readFileSync } from "fs";
import { createWorker } from "tesseract.js";

const img =
  process.argv[2] ||
  "C:/Users/chris/Downloads/ce30b44b-04bd-470b-b135-57655d991b5d.jpg.jpeg";
const buf = readFileSync(img);
const worker = await createWorker("eng");
const { data } = await worker.recognize(buf);
await worker.terminate();
const text = data.text;
console.log("--- lines near USD ---");
const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
for (let i = 0; i < lines.length; i++) {
  if (/USD|UsD|Entry|Chip|XKK|Auth|Stan|GALLON|Weber|Sirine/i.test(lines[i])) {
    console.log(i, JSON.stringify(lines[i]));
  }
}
const r = parseReceiptText(text);
console.log("parse", r.store_number, r.card_last4, r.gallons, r.total_cost);
