/**
 * Run:
 * npx esbuild scripts/test-safety-status.ts --bundle --platform=node --format=esm --outfile=tmp-build-permit/test-safety-status.mjs
 * node tmp-build-permit/test-safety-status.mjs
 */
import {
  buildSafetyStatusGrid,
  filterSafetyStatusRows,
  safetyDoneLabel,
  safetyStatusTotals,
} from "../src/safetyStatus";

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

check("Done Mar 4 from sqlite datetime", safetyDoneLabel("2026-03-04 15:00:00") === "Done Mar 4");
check("Done Mar 4 from iso", safetyDoneLabel("2026-03-04T15:00:00Z") === "Done Mar 4");
check("blank stamp label", safetyDoneLabel("") === "Done");

const grid = buildSafetyStatusGrid({
  topics: [
    { id: 1, title: "Ladders", active: 1 },
    { id: 2, title: "Archived", active: 0 },
    { id: 3, title: "Electrical", active: true },
  ],
  users: [
    { id: 2, display_name: "Blair", role: "driver", position_title: "Installer" },
    { id: 1, display_name: "Avery", role: "office", position_title: null },
  ],
  stamps: [
    { id: 1, user_id: 1, topic_id: 1, completed_at: "2026-03-01 12:00:00", is_retake: 0 },
    { id: 2, user_id: 1, topic_id: 1, completed_at: "2026-03-04 12:00:00", is_retake: 1 },
    { id: 9, user_id: 1, topic_id: 2, completed_at: "2026-01-01 00:00:00", is_retake: 0 },
    { id: 4, user_id: 2, topic_id: 1, completed_at: "2026-02-02 08:00:00", is_retake: 0 },
    { id: 5, user_id: 2, topic_id: 1, completed_at: "2026-02-02 08:00:00", is_retake: 1 },
    { id: 3, user_id: 2, topic_id: 3, completed_at: "2026-05-05 09:00:00", is_retake: 0 },
  ],
});

check(
  "inactive topic dropped",
  grid.topics.length === 2 && grid.topics.every((topic) => topic.title !== "Archived"),
  grid.topics
);
check("people sorted by name", grid.rows[0]?.user.display_name === "Avery" && grid.rows[1]?.user.display_name === "Blair");

const averyLadder = grid.rows[0]?.cells.find((cell) => cell.topic_id === 1);
check(
  "latest stamp wins and retake counts as done",
  averyLadder?.done === true &&
    averyLadder.label === "Done Mar 4" &&
    averyLadder.is_retake === true &&
    averyLadder.completed_at === "2026-03-04 12:00:00",
  averyLadder
);
const averyElec = grid.rows[0]?.cells.find((cell) => cell.topic_id === 3);
check("missing stamp is Needs it", averyElec?.done === false && averyElec?.label === "Needs it", averyElec);

const blairLadder = grid.rows[1]?.cells.find((cell) => cell.topic_id === 1);
check(
  "same timestamp keeps the higher id",
  blairLadder?.done === true && blairLadder.is_retake === true && blairLadder.completed_at === "2026-02-02 08:00:00",
  blairLadder
);
check("blair is done with both active topics", grid.rows[1]?.needs_any === false && grid.rows[1]?.done_count === 2);
check("avery still needs one", grid.rows[0]?.needs_any === true && grid.rows[0]?.done_count === 1);

check(
  "totals count people on active topics only",
  grid.totals[0]?.label === "2 of 2 done" && grid.totals[1]?.label === "1 of 2 done",
  grid.totals
);

const onlyNeeds = filterSafetyStatusRows(grid.rows, { onlyNeeds: true });
check("only people who still need something", onlyNeeds.length === 1 && onlyNeeds[0]?.user.display_name === "Avery");
const drivers = filterSafetyStatusRows(grid.rows, { role: "driver" });
check("role filter", drivers.length === 1 && drivers[0]?.user.role === "driver");
const filteredTotals = safetyStatusTotals(grid.topics, onlyNeeds);
check(
  "totals follow the filtered rows",
  filteredTotals[0]?.label === "1 of 1 done" && filteredTotals[1]?.label === "0 of 1 done",
  filteredTotals
);

const hire = buildSafetyStatusGrid({
  topics: [
    { id: 1, title: "Stop", active: 1, for_new_hire: 1 },
    { id: 2, title: "Attic", active: 1, for_new_hire: 0 },
  ],
  users: [{ id: 1, display_name: "Avery", role: "driver" }],
  stamps: [],
});
check(
  "new hire flag is kept on the grid",
  hire.topics[0]?.for_new_hire === 1 && hire.topics[1]?.for_new_hire === 0,
  hire.topics
);

const empty = buildSafetyStatusGrid({ topics: [], users: [], stamps: [] });
check("empty grid", empty.topics.length === 0 && empty.rows.length === 0 && empty.totals.length === 0);

console.log(fails ? `FAILED ${fails}/${n}` : `OK ${n}/${n}`);
if (fails) process.exit(1);
