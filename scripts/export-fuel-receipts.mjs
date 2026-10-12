import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const keys = [
  ["221", "fuel-receipts/1789000060216-ae668373-8232-4c16-b35a-b39d073c2a78.jpg"],
  ["220", "fuel-receipts/1788997512661-7707c9de-6782-422b-b697-2dd830fd8480.jpg"],
  ["219", "fuel-receipts/1788991015418-e4f6dc0a-b6a4-4dcf-9fd0-130c226f0697.jpg"],
  ["218", "fuel-receipts/1788975299031-d1018634-ac14-456b-94a1-bf758818441b.jpg"],
  ["217", "fuel-receipts/1788908399386-2e9e9dd3-1ae4-4db2-ab62-c0beccf8733c.jpg"],
  ["213", "fuel-receipts/1788870644321-1d51dd67-16cf-4693-95ca-c3e736346128.jpg"],
];
const outDir = "tmp-fuel-export";
mkdirSync(outDir, { recursive: true });
const npx = "npx.cmd";
const sizes = { "221":834157, "220":811857, "219":818518, "218":410488, "217":636906, "213":807348 };

function wranglerFile(sql) {
  const f = join(outDir, "_q.sql");
  writeFileSync(f, sql);
  const raw = execFileSync(
    npx,
    ["wrangler", "d1", "execute", "fleet_db", "--remote", "--json", `--file=${f}`],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024, shell: true }
  );
  const start = raw.indexOf("[");
  return JSON.parse(raw.slice(start))[0]?.results || [];
}

for (const [id, key] of keys) {
  const size = sizes[id];
  console.log(`#${id} exporting ${size} bytes`);
  const chunk = 80000;
  const parts = [];
  for (let off = 1; off <= size; off += chunk) {
    const len = Math.min(chunk, size - off + 1);
    const esc = key.replace(/'/g, "''");
    const rows = wranglerFile(`SELECT hex(substr(data, ${off}, ${len})) as h FROM receipt_blobs WHERE key = '${esc}';`);
    const h = rows[0]?.h || "";
    if (!h) { console.log(" empty at", off); break; }
    parts.push(Buffer.from(h, "hex"));
    console.log(`  @${off} +${h.length/2}`);
  }
  const buf = Buffer.concat(parts);
  const path = join(outDir, `receipt-${id}.jpg`);
  writeFileSync(path, buf);
  console.log("wrote", path, buf.length, "jpeg", buf[0]===0xff && buf[1]===0xd8);
}
