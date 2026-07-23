import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cmd = `npx wrangler d1 execute fleet_db --remote --json --command "SELECT id, code, name, truck_stock, min_qty, max_qty FROM parts WHERE active=1"`;
const out = execSync(cmd, {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
  shell: true,
});
const i = out.indexOf("[");
if (i < 0) {
  console.error(out.slice(0, 500));
  process.exit(1);
}
const json = out.slice(i);
JSON.parse(json);
const path = join(root, "scripts", "parts-export.json");
writeFileSync(path, json, "utf8");
console.log("Wrote", path, json.length, "bytes");
