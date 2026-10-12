/**
 * Shop scoreboard coaching math. Pure only.
 * Run: npx esbuild scripts/test-ops-coaching.ts --bundle --platform=node --outfile=tmp-ops-coaching.mjs
 *      node tmp-ops-coaching.mjs
 */
import {
  averageTicket,
  comebackRate,
  countComebackTypes,
  recallsForTech,
  type RecallJobRef,
} from "../worker/opsCoaching";

let failed = 0;
function eq(name: string, got: unknown, expect: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(expect);
  if (a === b) console.log(`ok ${name}`);
  else {
    failed += 1;
    console.log(`FAIL ${name}\n  got ${a}\n  expect ${b}`);
  }
}

eq("rate 2 of 18", comebackRate(2, 18), 0.111);
eq("rate zero comebacks", comebackRate(0, 18), 0);
eq("rate no jobs", comebackRate(0, 0), null);
eq("rate missing", comebackRate(null, 10), null);
eq("avg ticket", averageTicket(824, 4), 206);
eq("avg ticket without sales", averageTicket(null, 4), null);

eq(
  "types by count",
  countComebackTypes(["Drain", "Maintenance", "Drain", "  ", "Drain"]),
  [
    { job_type: "Drain", count: 3 },
    { job_type: "Maintenance", count: 1 },
    { job_type: "Warranty / follow-up", count: 1 },
  ]
);

const original: RecallJobRef = {
  id: 100,
  jobNumber: "4521",
  jobTypeName: "Maintenance",
  recallForId: null,
  technicianIds: [7, 8],
};
const recall: RecallJobRef = {
  id: 200,
  jobNumber: "4602",
  jobTypeName: "Warranty Service",
  recallForId: 100,
  technicianIds: [9],
};
const originals = new Map<number, RecallJobRef>([[100, original]]);

eq("recall names original techs", recallsForTech([recall], originals, 7).recalls, [
  {
    original_job_id: "100",
    original_job_number: "4521",
    original_job_type: "Maintenance",
    recall_job_id: "200",
    recall_job_number: "4602",
  },
]);
eq("helper on the original is listed too", recallsForTech([recall], originals, 8).recalls.length, 1);
eq("callback tech is not blamed for the original", recallsForTech([recall], originals, 9).recalls.length, 0);
eq("missing original is skipped", recallsForTech([recall], new Map(), 7).recalls.length, 0);

const many = Array.from({ length: 10 }, (_, i) => ({
  ...recall,
  id: 300 + i,
  jobNumber: String(5000 + i),
}));
const packed = recallsForTech(many, originals, 7);
eq("recall list cap", packed.recalls.length, 8);
eq("recall overflow", packed.recalls_more, 2);

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log("all ok");
