/**
 * Done today plan checks. Nothing here touches D1.
 * Run: npx esbuild scripts/test-done-today-plan.ts --bundle --platform=node --format=cjs --outfile=tmp-done-today-test.cjs
 *      node tmp-done-today-test.cjs
 */
import { splitChecklist } from "../worker/doneTodayAi";
import {
  dayBoundsUtc,
  formatTimeCt,
  inChicagoDay,
  mergeItems,
  splitExtras,
} from "../worker/doneTodayPlan";

let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (!cond) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? ` ${detail}` : ""}`);
  } else {
    console.log(`ok ${name}`);
  }
}

const oct = dayBoundsUtc("2026-10-01");
check("19 oct bounds", oct[0] === "2026-10-01 05:00:00" && oct[1] === "2026-10-02 05:00:00", oct.join(" .. "));
const nov = dayBoundsUtc("2026-11-01");
check("19 dst bounds", nov[0] === "2026-11-01 05:00:00" && nov[1] === "2026-11-02 06:00:00", nov.join(" .. "));

check("20 chuck pickup time", formatTimeCt("2026-10-01 18:05:40") === "1:05 PM", formatTimeCt("2026-10-01 18:05:40"));
check("20 inside day", inChicagoDay("2026-10-01 18:05:40", "2026-10-01"));
check("20 late utc still oct 1", inChicagoDay("2026-10-02 04:59:59", "2026-10-01"));
check("20 next day out", inChicagoDay("2026-10-02 05:00:00", "2026-10-01") === false);

const merged = mergeItems([
  {
    at: "2026-10-01 18:05:40",
    text: "Picked up sensor at Aces",
    kind: "pickup",
    source: "part_pickup",
    entity_type: "part_pickup",
    entity_id: 12,
  },
  {
    at: "2026-10-01 18:06:10",
    text: "part_pickup update",
    kind: "audit",
    source: "audit",
    entity_type: "part_pickup",
    entity_id: 12,
  },
  {
    at: "2026-10-01 19:00:00",
    text: "Started WO #4",
    kind: "wo_start",
    source: "fleet_wo",
    issue_id: 4,
    wo_minutes: 20,
  },
  {
    at: "2026-10-01 19:20:00",
    text: "Paused",
    kind: "wo_pause",
    source: "fleet_wo",
    issue_id: 4,
    wo_minutes: 30,
  },
  {
    at: "2026-10-01 19:40:00",
    text: "Resumed",
    kind: "wo_resume",
    source: "fleet_wo",
    issue_id: 4,
    wo_minutes: 34,
  },
  {
    at: "2026-10-01 20:14:00",
    text: "Done",
    kind: "wo_done",
    source: "fleet_wo",
    issue_id: 4,
  },
]);
check("21 one pickup", merged.filter((m) => m.kind === "pickup").length === 1 && merged.every((m) => m.source !== "audit"));
check(
  "21 finished line",
  merged.some((m) => m.text === "Finished WO #4 (1.4 h)") && merged.filter((m) => m.issue_id === 4).length === 1,
  merged.map((m) => m.text).join(" | ")
);

const three = splitExtras("Swept the bay and then changed wiper blades on 018, also checked tire pressure on Box 1");
check("22 three lines", three.length === 3, JSON.stringify(three));
check("22 empty", splitExtras("   ").length === 0);
const sentences = Array.from({ length: 15 }, (_, i) => `Task number ${i + 1} done`).join(". ");
check("22 max 10", splitExtras(sentences).length === 10);
const long = "A".repeat(300);
check("22 cut 200", splitExtras(long)[0].length === 200);
const quoted = splitExtras("He said \u201Chello there\u201D");
check("22 ascii quotes", quoted.length === 1 && quoted[0].includes('"') && !/[^\x00-\x7F]/.test(quoted[0]), quoted[0]);

async function main(): Promise<void> {
  const missing = await splitChecklist("Swept the bay", { ai: null, setting: "1" });
  check("23 no ai", missing.split_by === "rules");
  const off = await splitChecklist("Swept the bay", {
    ai: { run: async () => "Should not run" },
    setting: "0",
  });
  check("23 setting off", off.split_by === "rules" && off.lines[0] === "Swept the bay");
  const thrown = await splitChecklist("Swept the bay", {
    ai: {
      run: async () => {
        throw new Error("stub");
      },
    },
    setting: "1",
  });
  check("23 throw fallback", thrown.split_by === "rules" && thrown.lines[0] === "Swept the bay");
  console.log(failed ? `FAILS ${failed}` : "ALL PASS");
  process.exit(failed ? 1 : 0);
}

void main();
