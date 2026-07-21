import fs from "fs";
const p = "src/pages/InventoryPage.tsx";
const lines = fs.readFileSync(p, "utf8").split(/\n/);
const start = lines.findIndex((l) => l.includes("const vCount = full.vendor_names"));
if (start < 0) {
  console.error("not found");
  process.exit(1);
}
// replace lines start .. start+3 (vCount, setOk(, template, );)
const replacement = [
  "      const vCount = full.vendor_names?.length || 0;",
  "      const vLabel = vCount === 1 ? '1 vendor group' : vCount + ' vendor groups';",
  "      setOk(",
  "        'Exported ' +",
  "          rows.length +",
  "          ' parts with ' +",
  "          vLabel +",
  "          '. ST vendor columns included (Active, Part #, Price, Primary). Import Materials into ServiceTitan to push new vendors and part numbers.'",
  "      );",
];
// find closing of setOk - line with only `      );` after start
let end = start;
while (end < lines.length && !(end > start && lines[end].trim() === ");")) end++;
if (end >= lines.length) {
  console.error("end not found");
  process.exit(1);
}
const out = [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)];
fs.writeFileSync(p, out.join("\n"));
console.log("replaced lines", start + 1, "to", end + 1);
