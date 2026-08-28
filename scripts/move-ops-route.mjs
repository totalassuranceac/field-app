import fs from "node:fs";

let s = fs.readFileSync("worker/index.ts", "utf8");
const start = s.indexOf("/**\n * One-shot ops: confirm MG pool");
const end = s.indexOf("/** Recent SMS attempts");
if (start < 0 || end < 0) {
  console.error("markers", start, end);
  process.exit(1);
}
const block = s.slice(start, end);
s = s.slice(0, start) + s.slice(end);

const moved = block.replace(
  'api.post("/sms/ops-sender-fix"',
  'app.post("/api/sms/ops-sender-fix"'
);

const anchor = 'app.route("/api", api);';
const ai = s.indexOf(anchor);
if (ai < 0) {
  console.error("no app.route");
  process.exit(1);
}
s = s.slice(0, ai) + moved + "\n" + s.slice(ai);

s = s.replace(
  'p === "/api/health" ||',
  'p === "/api/health" ||\n    p === "/api/sms/ops-sender-fix" ||'
);

fs.writeFileSync("worker/index.ts", s);
console.log("ok moved", moved.length);
