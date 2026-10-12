/**
 * Run:
 * npx esbuild scripts/test-job-durations.ts --bundle --platform=node --format=esm --outfile=tmp-build-permit/test-job-durations.mjs
 * node tmp-build-permit/test-job-durations.mjs
 */
import {
  JOB_DURATION_ROWS,
  JOB_DURATIONS_BUILT,
  JOB_DURATIONS_JOB_COUNT,
  bookSlotLabel,
  dayBoardUsualLine,
  lookupJobDuration,
  multiDayLabel,
  realMedianNote,
  usualAboutLine,
} from "../src/jobDurations";

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

check("table built date", JOB_DURATIONS_BUILT === "2026-10-02");
check("1540 jobs in the averages", JOB_DURATIONS_JOB_COUNT === 1540);
check("53 job types", JOB_DURATION_ROWS.length === 53);

const noCool = lookupJobDuration("No Cool");
check("exact No Cool", noCool?.job_type === "No Cool" && noCool.median_minutes === 65, noCool);
check("case and space", lookupJobDuration("  no   cool ")?.job_type === "No Cool");
check("unknown is null", lookupJobDuration("Not a real job type") === null);
check("blank is null", lookupJobDuration("   ") === null);

const slash = lookupJobDuration("Air Conditioner Service / Repair");
check("slash spacing", slash?.job_type === "Air Conditioner Service/Repair", slash?.job_type);
check(
  "minisplit slash variants",
  lookupJobDuration("MiniSplit/Ductless Install")?.job_type === "MiniSplit / Ductless Install" &&
    lookupJobDuration("minisplit  /   ductless install")?.job_type === "MiniSplit / Ductless Install"
);

const filter = lookupJobDuration("Filter Change");
check("low_sample flag", filter?.low_sample === true && noCool?.low_sample === false, filter?.low_sample);

check("No Cool slot 120", noCool?.book_slot_minutes === 120);
check("Diagnostic Visit slot 150", lookupJobDuration("Diagnostic Visit")?.book_slot_minutes === 150);
check(
  "Complete System Install slot 720",
  lookupJobDuration("Complete System Install")?.book_slot_minutes === 720
);

const finalRow = lookupJobDuration("Final");
const rough = lookupJobDuration("Residential Rough In");
const system = lookupJobDuration("Complete System Install");
check("Final is multi-day", multiDayLabel(finalRow!) === "over about 2 days", multiDayLabel(finalRow!));
check("Rough In is over about 4 days", multiDayLabel(rough!) === "over about 4 days", multiDayLabel(rough!));
check("No Cool is not multi-day", multiDayLabel(noCool!) === null);
check("Complete System under 1.5 days is not multi-day", multiDayLabel(system!) === null, system?.days_mean);
check(
  "Final book slot label",
  bookSlotLabel(finalRow!) === "12 h total, over about 2 days",
  bookSlotLabel(finalRow!)
);

check(
  "today No Cool",
  usualAboutLine("No Cool") === "Usually about 1 h 5 min on site",
  usualAboutLine("No Cool")
);
check("today skips few jobs", usualAboutLine("Filter Change") === null);
check("today skips unknown", usualAboutLine("Mystery Visit") === null);
check(
  "today multi-day",
  usualAboutLine("Final") === "Usually about 5 h 6 min total, over about 2 days",
  usualAboutLine("Final")
);
check(
  "today complete system stays one line on site",
  usualAboutLine("Complete System Install") === "Usually about 7 h 48 min on site",
  usualAboutLine("Complete System Install")
);

check(
  "day board real plus tight",
  dayBoardUsualLine("No Cool", 76, "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z") ===
    "Usually 1 h 5 min \u00B7 book 2 h \u00B7 Tight",
  dayBoardUsualLine("No Cool", 76, "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z")
);
check(
  "day board real without tight when the booking is long enough",
  dayBoardUsualLine("No Cool", 76, "2026-10-02T15:00:00Z", "2026-10-02T17:00:00Z") ===
    "Usually 1 h 5 min \u00B7 book 2 h"
);
check(
  "day board few jobs falls back",
  dayBoardUsualLine("Filter Change", 80) === "Booked about 1 h 20 min",
  dayBoardUsualLine("Filter Change", 80)
);
check("day board unknown with no fallback is blank", dayBoardUsualLine("Mystery Visit", null) === null);
check(
  "real note",
  realMedianNote("Complete System Install") === "Real: 7 h 48 min",
  realMedianNote("Complete System Install")
);
check("real note skips few jobs", realMedianNote("Filter Change") === null);

/** Gauge job-type mapping (docs/data/JOB-DURATIONS-REPORT-2026-10-02.md). Not a live catalog fetch. */
const GAUGE_NAMES = [
  "10-year Manufacturer labor",
  "Air Conditioner Service/Repair",
  "Bi-Annual Maintenance",
  "Bi-Monthly Maintenance",
  "Coil Cleaning",
  "Diagnostic Visit",
  "Duct Cleaning",
  "Duct Repairs",
  "Filter Change",
  "Follow-up Visit",
  "IAQ Installation & Service",
  "Leak Detection",
  "Misc HVAC",
  "Monthly Maintenance Visit",
  "Motor Replacement",
  "No Cool",
  "No Heat",
  "Noise Issue Diagnostic",
  "Quarterly Maintenance",
  "Seasonal Check Up",
  "Second Opinion",
  "System Checkup",
  "Thermostat Service/Repair",
  "Warranty Service",
  "Water Leak Repair",
  "Air Handler Install",
  "Attic Register Installation",
  "Complete Duct system w/Furnace only",
  "Complete System Install",
  "Condenser Install",
  "Dehumidifier Installation",
  "Drain Pan Installation",
  "Ductwork & Installation",
  "Exhaust Duct Connections",
  "Exhaust Fan Install",
  "Final",
  "Full System Install",
  "Furdown Installation",
  "Grills and Installation",
  "Installation Services",
  "Kitchen Vent Hood Installation",
  "MiniSplit / Ductless Install",
  "PTAC Install",
  "Package Unit Install",
  "Removal",
  "Residential Full duct system install",
  "Residential Rough In",
  "Startup",
  "Thermostat Install",
  "Trim Out",
  "Compressor Replacement",
  "Condenser Coil Replacement",
  "Condenser Coil Replacement - Outdoor",
  "Copper line set replacement",
  "Evaporator Coil Replacement",
  "Warranty Coil Replacement",
  "Warranty Compressor Replacement",
  "Customer Quote",
  "Imported Default JobType",
  "Real Estate Inspection",
  "System Information",
  "System Inspection",
  "Two System Real Estate Inspection",
];

const missed = GAUGE_NAMES.filter((name) => !lookupJobDuration(name));
const matched = GAUGE_NAMES.length - missed.length;
console.log(`CATALOG_MATCH gauge=${GAUGE_NAMES.length} matched=${matched} missed=${missed.length}`);
if (missed.length) console.log("CATALOG_MISSED " + missed.join(" | "));

console.log(fails ? `FAILED ${fails}/${n}` : `OK ${n}/${n}`);
if (fails) process.exit(1);
