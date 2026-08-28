import fs from "node:fs";
import path from "node:path";

const dir = "dist/client/assets";
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), "utf8");
  if (!s.includes("Picked up")) continue;
  const hasMech =
    s.includes('==="mechanic"') ||
    s.includes("==='mechanic'") ||
    s.includes('"mechanic"===') ||
    /role\s*===\s*"mechanic"/.test(s);
  const hasSup =
    s.includes('==="supervisor"') ||
    s.includes("==='supervisor'") ||
    s.includes('"supervisor"===') ||
    /role\s*===\s*"supervisor"/.test(s);
  const hasWh =
    s.includes('==="warehouse"') || s.includes("==='warehouse'");
  console.log(
    JSON.stringify({ file: f, hasMech, hasSup, hasWh, size: s.length })
  );
}
