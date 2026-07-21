import fs from "fs";
const p = "src/pages/InventoryPage.tsx";
const lines = fs.readFileSync(p, "utf8").split(/\n/);
const start = lines.findIndex((l) => l.includes("PLACEHOLDER_REMOVE_OLD_VENDOR_TABLE"));
if (start < 0) {
  console.error("placeholder not found");
  process.exit(1);
}
let end = start;
while (end < lines.length && !lines[end].includes('tab === "order"')) end++;
if (end >= lines.length) {
  console.error("order tab not found");
  process.exit(1);
}
// Also drop blank lines immediately before order if leftover from dead block closers
const out = [...lines.slice(0, start), ...lines.slice(end)];
fs.writeFileSync(p, out.join("\n"));
console.log(`Removed lines ${start + 1}-${end} (${end - start} lines)`);
