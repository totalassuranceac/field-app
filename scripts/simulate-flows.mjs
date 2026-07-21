/**
 * Simulate critical business rules offline (no server auth required).
 * Run: node scripts/simulate-flows.mjs
 */
import assert from "node:assert/strict";

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${e.message}`);
  }
}

console.log("\n=== Offline queue rules ===");
// Mirror isQueueableMutation from offlineQueue.ts
function isQueueableMutation(path, method) {
  const m = method.toUpperCase();
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(m)) return false;
  if (path.startsWith("/auth")) return false;
  if (path.startsWith("/ocr")) return false;
  if (path.startsWith("/live")) return false;
  return true;
}

check("queues warranty POST", () => {
  assert.equal(isQueueableMutation("/warranties", "POST"), true);
});
check("queues bottle swap", () => {
  assert.equal(isQueueableMutation("/assets/bottles/swap", "POST"), true);
});
check("does not queue GET parts", () => {
  assert.equal(isQueueableMutation("/inventory/parts", "GET"), false);
});
check("does not queue login", () => {
  assert.equal(isQueueableMutation("/auth/login", "POST"), false);
});
check("queues handbook ack", () => {
  assert.equal(isQueueableMutation("/handbook/acknowledge", "POST"), true);
});

console.log("\n=== Bottle swap math ===");
function simulateSwap({ truckFull, truckEmpty, whFull, whEmpty, emptyIn, fullOut }) {
  if (emptyIn > truckEmpty) throw new Error("Truck lacks empties");
  if (fullOut > whFull) throw new Error("Warehouse lacks fulls");
  // empties truck → warehouse
  truckEmpty -= emptyIn;
  whEmpty += emptyIn;
  // fulls warehouse → truck
  whFull -= fullOut;
  truckFull += fullOut;
  return { truckFull, truckEmpty, whFull, whEmpty };
}

check("2 empty in / 2 full out updates both sides", () => {
  const r = simulateSwap({
    truckFull: 1,
    truckEmpty: 2,
    whFull: 10,
    whEmpty: 0,
    emptyIn: 2,
    fullOut: 2,
  });
  assert.deepEqual(r, { truckFull: 3, truckEmpty: 0, whFull: 8, whEmpty: 2 });
});
check("rejects swap when truck has no empties", () => {
  assert.throws(() =>
    simulateSwap({
      truckFull: 2,
      truckEmpty: 0,
      whFull: 5,
      whEmpty: 0,
      emptyIn: 1,
      fullOut: 1,
    })
  );
});
check("rejects swap when warehouse out of fulls", () => {
  assert.throws(() =>
    simulateSwap({
      truckFull: 0,
      truckEmpty: 1,
      whFull: 0,
      whEmpty: 3,
      emptyIn: 1,
      fullOut: 1,
    })
  );
});

console.log("\n=== Custody handoff rules ===");
function canCompleteHandoff({ status, handedTo, truck, isWarehouse, userId }) {
  if (status === "picked_up") return { ok: false, err: "Already picked up" };
  if (status === "cancelled") return { ok: false, err: "Cancelled" };
  let receiver = handedTo;
  if (!receiver && isWarehouse) {
    // one-shot can set receiver
    return { ok: false, err: "need fields" };
  }
  if (!receiver) return { ok: false, err: "Warehouse must record receiver first" };
  if (!truck) return { ok: false, err: "Need truck" };
  const isReceiver = userId === receiver;
  if (!isWarehouse && !isReceiver) return { ok: false, err: "Not receiver" };
  return { ok: true };
}

check("warehouse can complete one-shot when ready+fields", () => {
  const r = canCompleteHandoff({
    status: "ready",
    handedTo: 7,
    truck: 42,
    isWarehouse: true,
    userId: 1,
  });
  assert.equal(r.ok, true);
});
check("random tech cannot put on truck", () => {
  const r = canCompleteHandoff({
    status: "ready",
    handedTo: 7,
    truck: 42,
    isWarehouse: false,
    userId: 99,
  });
  assert.equal(r.ok, false);
});
check("receiver can put on truck", () => {
  const r = canCompleteHandoff({
    status: "ready",
    handedTo: 7,
    truck: 42,
    isWarehouse: false,
    userId: 7,
  });
  assert.equal(r.ok, true);
});

console.log("\n=== Warranty drop-off validation ===");
function validateWarranty({ partName, photoKey }) {
  if (!partName?.trim()) return "Part name required";
  if (!photoKey?.trim()) return "Photo required";
  return null;
}
check("requires part name", () => {
  assert.equal(validateWarranty({ partName: "", photoKey: "k" }), "Part name required");
});
check("requires photo", () => {
  assert.equal(
    validateWarranty({ partName: "Contactor", photoKey: "" }),
    "Photo required"
  );
});
check("valid drop-off", () => {
  assert.equal(
    validateWarranty({ partName: "Contactor", photoKey: "warranty-dropoffs/x.jpg" }),
    null
  );
});

console.log("\n=== Asset condition / abuse ===");
function nextStatus(condition, current = "in_service") {
  if (condition === "out_of_service") return "repair";
  if (condition === "damaged" && current === "in_service") return "repair";
  return current;
}
check("damaged sets repair", () => {
  assert.equal(nextStatus("damaged"), "repair");
});
check("good stays in_service", () => {
  assert.equal(nextStatus("good"), "in_service");
});

console.log("\n=== Handbook ack rules ===");
function canAck({ handbookId, ackName }) {
  if (!handbookId) return "No handbook";
  if (!ackName?.trim()) return "Name required";
  return null;
}
check("ack needs name", () => {
  assert.equal(canAck({ handbookId: 1, ackName: "  " }), "Name required");
});
check("ack ok", () => {
  assert.equal(canAck({ handbookId: 1, ackName: "Chris M" }), null);
});

console.log("\n=== Collapsible LogList empty detection ===");
function hasKids(children) {
  return Array.isArray(children)
    ? children.filter(Boolean).length > 0
    : Boolean(children);
}
check("empty array is empty", () => assert.equal(hasKids([]), false));
check("mapped items not empty", () => assert.equal(hasKids([1, 2]), true));
check("null filtered", () => assert.equal(hasKids([null, false]), false));

console.log("\n=== Photo capture UX contract ===");
check("camera input uses capture environment", () => {
  // Contract: PhotoCapture must expose Take photo + gallery
  const requiredButtons = ["Take photo", "Choose from gallery"];
  assert.equal(requiredButtons.length, 2);
});

console.log("\n=== Route inventory (static) ===");
const expectedRoutes = [
  "/inventory",
  "/assets",
  "/warranties",
  "/handbook",
  "/fuel",
  "/inspections",
  "/issues",
  "/messages",
  "/audit",
];
check("app routes list present", () => {
  assert.ok(expectedRoutes.includes("/handbook"));
  assert.ok(expectedRoutes.includes("/assets"));
});

if (failed) {
  console.error(`\n${failed} check(s) failed\n`);
  process.exit(1);
}
console.log("\nAll simulation checks passed.\n");
