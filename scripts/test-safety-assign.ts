/**
 * Run:
 * npx esbuild scripts/test-safety-assign.ts --bundle --platform=node --format=esm --outfile=tmp-build-permit/test-safety-assign.mjs
 * node tmp-build-permit/test-safety-assign.mjs
 */
import {
  JOB_AUDIENCES,
  audiencesForKey,
  forNewHireFlag,
  levelFor,
  safetyDue,
  safetyTrack,
} from "../src/safetyAssign";

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

check("service tech from role", safetyTrack({ role: "driver" }) === "service");
check(
  "installer from title",
  safetyTrack({ role: "driver", position_title: "Install Technician" }) === "install"
);
check(
  "service title beats driver role",
  safetyTrack({ role: "driver", position_title: "Lead Service Technician" }) === "service"
);
check(
  "apprentice stays on service",
  safetyTrack({ role: "driver", position_title: "Apprentice" }) === "service"
);
check("warehouse role", safetyTrack({ role: "warehouse" }) === "warehouse");
check("shop mechanic", safetyTrack({ role: "mechanic" }) === "shop");
check("office default", safetyTrack({ role: "office" }) === "office");
check(
  "dispatcher title is office",
  safetyTrack({ role: "office", position_title: "Dispatcher" }) === "office"
);
check(
  "field supervisor follows service",
  safetyTrack({ role: "supervisor", position_title: "Field Supervisor" }) === "service"
);

const serviceStop = levelFor(audiencesForKey("nh-stop"), "service");
const serviceBraze = levelFor(audiencesForKey("rf-brazing"), "service");
const installBraze = levelFor(audiencesForKey("rf-brazing"), "install");
const installCap = levelFor(audiencesForKey("el-capacitors"), "install");
const serviceCap = levelFor(audiencesForKey("el-capacitors"), "service");
check("stop is essential for service", serviceStop === "essential");
check("service does not take brazing", serviceBraze === null);
check("install brazing is essential", installBraze === "essential");
check("capacitors are a service extra", serviceCap === "extra" && installCap === null);
check(
  "warehouse lift is not on a service list",
  levelFor(JOB_AUDIENCES["wh-lift"], "service") === null &&
    levelFor(JOB_AUDIENCES["wh-lift"], "warehouse") === "essential"
);

const fresh = safetyDue("2026-03-04 15:00:00", "2026-06-01");
check(
  "fresh stamp is current through the anniversary",
  fresh.status === "current" && fresh.due_on === "2027-03-04" && fresh.refresh_on === "2027-02-02",
  fresh
);
check("day before the window is still current", safetyDue("2026-03-04", "2027-02-01").status === "current");
check("refresh opens 30 days before the year", safetyDue("2026-03-04", "2027-02-02").status === "due_soon");
check("anniversary day is past due", safetyDue("2026-03-04", "2027-03-04").status === "overdue");
check("missing stamp", safetyDue(null, "2026-10-09").status === "none");
check("brazing counts as field essential flag", forNewHireFlag(audiencesForKey("rf-brazing")) === 1);
check("office course is not a field essential flag", forNewHireFlag(audiencesForKey("of-stop")) === 0);

console.log(fails ? `FAILED ${fails}/${n}` : `OK ${n}/${n}`);
if (fails) process.exit(1);
