/**
 * Run:
 * npx esbuild scripts/test-job-lengths.ts --bundle --platform=node --format=esm --outfile=tmp-build-permit/test-job-lengths.mjs
 * node tmp-build-permit/test-job-lengths.mjs
 */
import {
  dropOutlierMinutes,
  formatJobLengthMinutes,
  medianMinutes,
  p80Minutes,
  stEstimateMinutes,
  summarizeDurations,
} from "../src/jobLengthFormat";

let fails = 0;
let n = 0;
function check(name: string, ok: boolean, got?: unknown) {
  n++;
  if (ok) console.log("PASS", name);
  else {
    fails++;
    console.log("FAIL", name, got === undefined ? "" : JSON.stringify(got));
  }
}

check("median odd", medianMinutes([10, 20, 30]) === 20);
check("median even rounds average", medianMinutes([10, 20, 30, 40]) === 25);
check("median empty", medianMinutes([]) === null);

const ten = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
check("p80 of 10 is the 8th value", p80Minutes(ten) === 80);
check("p80 of 5 is the 4th value", p80Minutes([10, 20, 30, 40, 50]) === 40);
check("p80 empty", p80Minutes([]) === null);

const dropped = dropOutlierMinutes([5, 9, 10, 30, 16 * 60, 16 * 60 + 1, 1000]);
check(
  "outliers under 10 min and over 16 h drop",
  dropped.length === 3 && dropped[0] === 10 && dropped[1] === 30 && dropped[2] === 16 * 60,
  dropped
);

const thin = summarizeDurations([30, 40, 50, 5, 2000]);
check("under 5 kept jobs", thin.jobs === 3 && thin.median_minutes === null && thin.p80_minutes === null, thin);

const enough = summarizeDurations([15, 30, 45, 60, 90, 9, 2000]);
check(
  "five kept jobs get a median",
  enough.jobs === 5 && enough.median_minutes === 45 && enough.p80_minutes === 60,
  enough
);

check("format 2 h 15 min", formatJobLengthMinutes(135) === "2 h 15 min");
check("format 1 h", formatJobLengthMinutes(60) === "1 h");
check("format 45 min", formatJobLengthMinutes(45) === "45 min");
check("format 1 h 30 min", formatJobLengthMinutes(90) === "1 h 30 min");
check("format rounds", formatJobLengthMinutes(134.4) === "2 h 14 min");
check("estimate seconds 7200 is 2 h", stEstimateMinutes({ duration: 7200 }) === 120);
check("estimate seconds 1800 is 30 min", stEstimateMinutes({ duration: 1800 }) === 30);
check("estimate minutes stay minutes", stEstimateMinutes({ duration: 90 }) === 90);
check("estimate hours under 30", stEstimateMinutes({ duration: 2 }) === 120);
check("estimate over 16 h is dropped", stEstimateMinutes({ duration: 20 * 3600 }) === null);
check("estimate blank", stEstimateMinutes({ duration: 0 }) === null);

console.log(fails ? `FAILED ${fails}/${n}` : `OK ${n}/${n}`);
if (fails) process.exit(1);
