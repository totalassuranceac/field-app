/**
 * Run:
 * npx esbuild scripts/test-stock-moves.ts --bundle --platform=node --format=esm --outfile=tmp-build-permit/test-stock-moves.mjs
 * node tmp-build-permit/test-stock-moves.mjs
 */
import {
  ShortStockError,
  clampFlagText,
  planAdjust,
  planPartsRunLine,
  planStrictIssue,
  planUndo,
  shouldTransferOnDeliver,
  shortFlag,
} from "../worker/stockMoves";

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

const moved = planPartsRunLine({
  killSwitchOn: true,
  alreadyTransferred: false,
  qty: 2,
  fromBefore: 5,
  toBefore: 1,
});
check("normal move", moved.action === "move" && moved.action === "move");
if (moved.action === "move") {
  check("move from 5 to 3", moved.fromAfter === 3 && moved.toAfter === 3, moved);
  check("move stays non-negative", moved.fromAfter >= 0 && moved.toAfter >= 0);
}

const short = planPartsRunLine({
  killSwitchOn: true,
  alreadyTransferred: false,
  qty: 5,
  fromBefore: 2,
  toBefore: 0,
});
check(
  "short block",
  short.action === "blocked_short" &&
    short.action === "blocked_short" &&
    short.flag === "Short: warehouse shows 2, needs 5",
  short
);
check("short flag helper", shortFlag(2, 5) === "Short: warehouse shows 2, needs 5");

const noTruckShort = planPartsRunLine({
  killSwitchOn: true,
  alreadyTransferred: false,
  qty: 4,
  fromBefore: 1,
  toBefore: null,
});
check("no-truck issue block", noTruckShort.action === "blocked_short", noTruckShort);

const noTruckOk = planPartsRunLine({
  killSwitchOn: true,
  alreadyTransferred: false,
  qty: 2,
  fromBefore: 4,
  toBefore: null,
});
check(
  "no-truck issue",
  noTruckOk.action === "issue" && noTruckOk.fromAfter === 2,
  noTruckOk
);

const ledger = { warehouse: 2, truck: 0, writes: 0 };
function apply(qty: number) {
  const plan = planPartsRunLine({
    killSwitchOn: true,
    alreadyTransferred: false,
    qty,
    fromBefore: ledger.warehouse,
    toBefore: ledger.truck,
  });
  if (plan.action === "blocked_short") return plan;
  if (plan.action === "move") {
    ledger.warehouse = plan.fromAfter;
    ledger.truck = plan.toAfter;
    ledger.writes++;
  }
  return plan;
}
const blockedApply = apply(5);
check("ledger did not go negative", ledger.warehouse === 2 && ledger.writes === 0, ledger);
check("ledger block", blockedApply.action === "blocked_short");
apply(1);
check("ledger after a safe move", ledger.warehouse === 1 && ledger.truck === 1 && ledger.writes === 1, ledger);

const again = planPartsRunLine({
  killSwitchOn: true,
  alreadyTransferred: true,
  qty: 1,
  fromBefore: ledger.warehouse,
  toBefore: ledger.truck,
});
check("idempotent retry skips", again.action === "skip_done");
check("retry did not change the ledger", ledger.warehouse === 1 && ledger.writes === 1);

const killed = planPartsRunLine({
  killSwitchOn: false,
  alreadyTransferred: false,
  qty: 1,
  fromBefore: 9,
  toBefore: 0,
});
check("kill switch off plans no move", killed.action === "skip_kill");
check(
  "deliver gate off",
  shouldTransferOnDeliver({ setting: "0", clientOptOut: false, lineCount: 2 }) === false
);
check(
  "deliver gate on",
  shouldTransferOnDeliver({ setting: "1", clientOptOut: false, lineCount: 2 }) === true
);
check(
  "checkbox skips",
  shouldTransferOnDeliver({ setting: "1", clientOptOut: true, lineCount: 2 }) === false
);

const undoOk = planUndo({
  status: "moved",
  qty: 3,
  destOnHand: 5,
  sourceOnHand: 1,
  hasDestination: true,
});
check(
  "undo ok",
  undoOk.ok === true && undoOk.ok && undoOk.destAfter === 2 && undoOk.sourceAfter === 4,
  undoOk
);

const undoNo = planUndo({
  status: "moved",
  qty: 3,
  destOnHand: 1,
  sourceOnHand: 4,
  hasDestination: true,
});
check(
  "undo blocked when truck is short",
  undoOk && undoNo.ok === false && undoNo.message === "Truck shows 1, can't undo 3",
  undoNo
);

const state = { qty: 2, writes: 0 };
function strict(qty: number) {
  const plan = planStrictIssue(state.qty, qty);
  if (!plan.ok) throw new ShortStockError(plan.have, plan.need);
  state.qty = plan.after;
  state.writes++;
  return plan.after;
}
let threw = false;
try {
  strict(5);
} catch (e) {
  threw = e instanceof ShortStockError && e.have === 2 && e.need === 5;
}
check("strict issue throws when short", threw);
check("strict issue writes nothing", state.qty === 2 && state.writes === 0, state);
check("strict issue succeeds", strict(1) === 1 && state.writes === 1, state);

const clamped = planAdjust(2, -5);
check("clamp returns 0", clamped.next === Math.max(0, 2 + -5) && clamped.next === 0, clamped);
check("clamp flag", clamped.flagText === clampFlagText(2, 5), clamped.flagText);
check(
  "clamp sentence",
  clamped.flagText === "Clamped: had 2, asked to remove 5 (3 short)"
);
const plain = planAdjust(10, -3);
check("adjust return unchanged when it fits", plain.next === 7 && plain.clamped === false, plain);
check("positive adjust unchanged", planAdjust(1, 4).next === 5 && planAdjust(1, 4).clamped === false);

console.log(fails ? `FAIL ${fails}/${n}` : `OK ${n}/${n}`);
process.exit(fails ? 1 : 0);
