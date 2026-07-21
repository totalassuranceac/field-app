/**
 * Simulate permission matrix for every role (mirrors src/api.ts can()).
 * node scripts/simulate-roles.mjs
 */

const ROLES = ["admin", "warehouse", "office", "driver", "mechanic", "viewer"];
const PERMS = [
  "manageUsers",
  "manageEmployees",
  "manageVehicles",
  "logFuel",
  "editFuel",
  "viewAlerts",
  "manageAlerts",
  "reportIssues",
  "manageIssues",
  "viewAudit",
  "viewReports",
  "manageSettings",
  "viewInventory",
  "manageInventory",
  "manageInventoryLevels",
  "viewCompanyAssets",
  "manageCompanyAssets",
];

const map = {
  manageUsers: ["admin"],
  manageEmployees: ["admin", "office"],
  manageVehicles: ["admin", "office", "mechanic"],
  logFuel: ["admin", "office", "driver"],
  editFuel: ["admin", "office"],
  viewAlerts: ["admin", "office", "mechanic", "viewer"],
  manageAlerts: ["admin", "office", "mechanic"],
  reportIssues: ["admin", "office", "driver", "mechanic"],
  manageIssues: ["admin", "mechanic", "office"],
  viewAudit: ["admin"],
  viewReports: ["admin", "office", "mechanic", "viewer", "warehouse"],
  manageSettings: ["admin"],
  viewInventory: ["admin", "office", "warehouse"],
  manageInventory: ["admin", "warehouse"],
  manageInventoryLevels: ["admin", "warehouse"],
  viewCompanyAssets: ["admin", "office", "warehouse", "driver", "mechanic"],
  manageCompanyAssets: ["admin", "warehouse"],
};

function can(role, action) {
  if (role === "admin") return true; // superuser
  return (map[action] || []).includes(role);
}

function roleAtLeast(role, allowed) {
  if (role === "admin") return true;
  return allowed.includes(role);
}

console.log("\n=== Admin superuser (API roleAtLeast) ===");
const samples = [
  ["admin", ["warehouse"], true],
  ["admin", ["driver"], true],
  ["admin", ["viewer"], true],
  ["warehouse", ["admin", "warehouse"], true],
  ["driver", ["admin", "warehouse"], false],
  ["office", ["admin", "office"], true],
];
let fail = 0;
for (const [role, allowed, expect] of samples) {
  const got = roleAtLeast(role, allowed);
  const ok = got === expect;
  if (!ok) fail++;
  console.log(`  ${ok ? "OK" : "FAIL"}  roleAtLeast(${role}, ${allowed.join("|")}) → ${got}`);
}

console.log("\n=== Admin has every UI permission ===");
for (const p of PERMS) {
  const ok = can("admin", p);
  if (!ok) fail++;
  console.log(`  ${ok ? "OK" : "FAIL"}  admin → ${p}`);
}

console.log("\n=== Permission matrix (role × perm) ===");
const header = ["perm".padEnd(24), ...ROLES.map((r) => r.slice(0, 5).padStart(6))].join(" ");
console.log(header);
for (const p of PERMS) {
  const row = [
    p.padEnd(24),
    ...ROLES.map((r) => (can(r, p) ? "  ✓   " : "  ·   ")),
  ].join("");
  console.log(row);
}

console.log("\n=== Feature coverage by role (expected screens) ===");
const features = {
  admin: ["inventory", "assets", "fuel", "warranties", "audit", "admin", "handbook"],
  warehouse: ["inventory", "assets", "warranties", "handbook"],
  office: ["inventory-view", "warranties", "repairs", "handbook"],
  driver: ["fuel", "warranties", "inspections", "assets-mine", "handbook"],
  mechanic: ["repairs", "vehicles", "yard", "alerts", "handbook"],
  viewer: ["alerts", "reports", "handbook"],
};
for (const [role, feats] of Object.entries(features)) {
  console.log(`  ${role.padEnd(10)} ${feats.join(", ")}`);
}

if (fail) {
  console.error(`\n${fail} failure(s)\n`);
  process.exit(1);
}
console.log("\nAdmin superuser + role matrix simulation OK.\n");
