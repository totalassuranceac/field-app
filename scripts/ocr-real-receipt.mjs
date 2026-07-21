import { createWorker } from "tesseract.js";
import { readFileSync } from "fs";
import { parseReceiptText } from "../src/receiptOcr.ts";

const imgPath =
  process.argv[2] ||
  "C:/Users/chris/Downloads/39a7b14d-40e6-4395-b530-0e530e66acca.jpg.jpeg";

const buf = readFileSync(imgPath);
console.log("Image bytes:", buf.length);

const worker = await createWorker("eng");
const {
  data: { text },
} = await worker.recognize(buf);
await worker.terminate();

console.log("\n===== RAW OCR =====\n");
console.log(text);
console.log("\n===== PARSE =====\n");
const r = parseReceiptText(text);
console.log({
  date: r.fuel_date,
  time: r.fuel_time,
  store: r.store_number,
  card: r.card_last4,
  gallons: r.gallons,
  total: r.total_cost,
  conf: r.confidence,
  missing_core: r.missing_core,
  missing_extra: r.missing_extra,
});
