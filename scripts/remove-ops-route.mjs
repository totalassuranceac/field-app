import fs from "node:fs";

let s = fs.readFileSync("worker/index.ts", "utf8");
const start = s.indexOf("/**\n * One-shot ops: confirm MG pool");
const marker = "\n\napp.route(\"/api\", api);";
const end = s.indexOf(marker);
if (start < 0 || end < 0) {
  console.error("markers", start, end);
  process.exit(1);
}
s = s.slice(0, start) + marker + s.slice(end + marker.length);
s = s.replace(
  /app\.route\("\/api", api\);\s*\napp\.route\("\/api", api\);/g,
  'app.route("/api", api);'
);
fs.writeFileSync("worker/index.ts", s);
console.log("removed ops route");
