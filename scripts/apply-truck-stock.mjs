/**
 * Apply truck-stock flags + min/max (low/high) from the field stock list.
 * Match by exact code or exact name only for explicit codes; series use code/name patterns.
 * Never inserts new parts — only updates existing pricebook rows.
 *
 * Usage: node scripts/apply-truck-stock.mjs
 * Expects scripts/parts-export.json from wrangler d1 execute --json
 */
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

let exportRaw = readFileSync(join(__dirname, "parts-export.json"), "utf8");
// strip UTF-8 BOM if present
if (exportRaw.charCodeAt(0) === 0xfeff) exportRaw = exportRaw.slice(1);
if (exportRaw.charCodeAt(0) === 0xfffd || exportRaw.startsWith("\uFFFD")) {
  exportRaw = exportRaw.replace(/^\uFEFF/, "").replace(/^\uFFFD+/, "");
}
const bi = exportRaw.indexOf("[");
if (bi > 0) exportRaw = exportRaw.slice(bi);
const raw = JSON.parse(exportRaw);
const parts = raw[0]?.results || raw.results || [];
if (!parts.length) {
  console.error("No parts in parts-export.json — re-export from D1 first.");
  process.exit(1);
}

const byCode = new Map();
const byName = new Map();
for (const p of parts) {
  byCode.set(String(p.code || "").trim().toLowerCase(), p);
  byName.set(String(p.name || "").trim().toLowerCase(), p);
}

/** @type {Array<{codes?: string[], nameExact?: string, label?: string, min: number, max: number, series?: string}>} */
const specs = [];

function add(codes, min, max, label) {
  const list = Array.isArray(codes) ? codes : [codes];
  specs.push({ codes: list, min, max, label: label || list.join(" / ") });
}

// ——— electrical / disconnects / power ———
add("171423551", 0, 1, "PIPE DOPE 8OZ");
add("170710552", 0, 1, "PLUMBERS TAPE");
add("RUD4210743003", 1, 3, "BREAKER 60A");
add("AMAXP60ANF", 0, 1, "DISC 60 NONFUSED");
add("AMAXP137", 0, 1, "COND WHIP 3/4");
add("AMAXP135", 0, 1, "COND WHIP 1/2");
add("DVT750NMLT75", 1, 2, "LT 3/4 CONN");
add("DVT750NMLT9075", 1, 2, "LT 3/4 90");
add("DVT62516690", 1, 2, "POWER CORD 6FT");
add("Contactor 1P 30A 24V", 1, 2, "Contactor 1P 30A 24V");
add("MAR17425", 2, 4, "2P40A24V CONTACTOR");
add("MAR17435", 1, 2, "3P40A24V CONTACTOR");
add("MAR92370", 2, 4, "12A24V SPDT RELAY");
add(["SUPQ103", "SUPQ111", "SUPQ112"], 1, 3, "sequencers");
add("DVT626AT03LED", 8, 20, "FUSE 3A BLADE");
add("MAR82231", 8, 20, "FUSE 5A BLADE");
for (const c of ["DVT7CRNR30", "DVT7CRNR35", "DVT7CRNR40", "DVT7CRNR45", "DVT7CRNR50", "DVT7CRNR60"]) {
  add(c, 1, 1, `${c} FUSE box`);
}

// ——— capacitors ———
for (const c of ["CAP 30/5", "CAP 35/5", "CAP 40/5", "CAP 45/5", "CAP 50/5", "CAP 55/5"]) {
  add(c, 1, 4, c);
}
for (const c of ["CAP 30/7.5", "CAP 35/7.5", "CAP 40/7.5", "CAP 45/7.5", "CAP 50/7.5", "CAP 55/7.5"]) {
  add(c, 1, 2, c);
}
add("GLSTURBO200", 1, 2);
add("GLSTURBOMINI", 1, 2);

// ——— pvc / drain / floats ———
// fittings series applied below
add("0609PVC4007B071", 5, 15, "PVC PIPE 10FT STICK");
add(["515876032", "515876033", "515876034"], 0, 1, "PVC GLUE");
add("171497632", 1, 2, "SS1 FLOAT SWITCH");
add("171497637", 1, 2, "SS2 FLOAT SWITCH");
add("171483411", 1, 2, "AA1 FLOAT SWITCH");
add("171483412", 1, 2, "AA2 FLOAT SWITCH");
add("171483413", 1, 2, "AA3 FLOAT SWITCH");
add("171497089", 1, 2, "SS3 FLOAT SWITCH");
add("171483887", 0, 1, "COND PUMP 120V");

// ——— refrigeration / gases ———
add("CSODBX1017FR", 2, 4, "DRIER BOX");
add("AGROX20CF", 1, 2, "GAS-OXYGEN REFILL");
add("AGRACMC10CF", 1, 2, "GAS-ACETYLENE REFILL");
add("AGRNI40CF", 1, 2, "GAS-NITROGEN REFILL");
add("R410A1LB", 1, 2);
add("R422B1LB", 0, 1);
add("R454B20LB", 0, 1);
add("SUPSFL1450", 4, 10, "LOCKING CAPS 50PK");
add("DVTVVC1", 4, 10, "1/4 VALVE CORE");

// ——— chemicals / tapes / coatings ———
add("CAL437188", 0, 1, "NC COIL CLEANER TRI-POWR 1GAL");
add("CAL417175", 0, 1, "NO RINSE COIL CLEANER 18OZ");
add("CAL436975", 0, 1, "ADHESIVE SPRAY 12OZ");
add("CAL429651", 0, 1, "PAN SPRAY BLK");
add("171472000", 0, 1, "CIRCUIT SHIELD 12OZ");
add("CAL430009", 0, 1, "RX11 FLUSH 1LB");
add("SHU232622", 1, 2, "2.5 ALUM TAPE");
add("DVT63460", 1, 2, "ELECTRICAL TAPE");
add("HRD304100", 0, 1, "TAPE HARDCAST");
add("HRD304144", 0, 1, "AIRLOCK/POOKIE 1GAL");
add("HJW15SILSOLDER", 0, 1, "WEL SOLDER 15");

// ——— hardware / misc ———
add("ACC37003", 0, 1, "CAULK 10OZ ALUM");
add(["4512677503", "4512677504"], 0, 1, "SAF SAFETY GLOVES");
add("4512688406", 0, 1, "SAF SHOE COVERS");
add("AMADCTSTRP175B", 0, 1, "BLACK NYLON STRAP");
add("MEMRDHS34", 0, 1, "Perforated Hanger Strap");
add("AMAXCT36NAT", 0, 1, "PANDUIT STRAPS");
add("DVTWTB11C", 0, 1, "ZIP TIES 11IN");
add("DVT540506", 0, 1, "3/8 STAPLES");
add(["DVTTDC4", "DVTTDC4100"], 3, 8, "TIE DOWN COND CLIP");
add("1409CSSC4424", 0, 1, "1/2 GAS CONNECTOR 24");
add("1409CSSC4436", 0, 1, "1/2 GAS CONNECTOR 36");
add("077008400", 1, 2, "BRASS 1/2 F GAS BALL VALVE");
add("CAL437132", 0, 1, "NC THERMOTRAP 1QT");
add("CAL438324", 0, 1, "VACUUM OIL 1QT");
add("RIT78104", 0, 1, "Inspection Mirror");
add(["DVT623MIX", "DVT623002", "DVT6293CX"], 1, 2, "wire nuts");
add("CAL418224", 0, 1, "LEAK DETECTOR 1QT");
add("DVTB503", 0, 1, "2IN BRUSH");

// ——— oem / motors / boards / stats ———
add("GOODMAN-CONTROL", 0, 1);
add("LENNOX-CONTROL", 0, 1);
add(["GOODMAN-BLOWER", "GOODMAN-CONDENSER", "LENNOX-BLOWER", "LENNOX-CONDENSER"], 0, 1);
add("HWLTH4110U2005", 0, 1, "Honeywell T4 Pro");
add("ECBEBSTATE6P01", 0, 1, "ECOBEE");
add("ls40", 0, 1, "Lennox S40");

function findExact(codeOrName) {
  const k = String(codeOrName).trim().toLowerCase();
  return byCode.get(k) || byName.get(k) || null;
}

/** @type {Map<number, {part: any, min: number, max: number, sources: string[]}>} */
const matched = new Map();
const missing = [];

function applyPart(p, min, max, source) {
  if (!p) return false;
  const prev = matched.get(p.id);
  if (prev) {
    prev.sources.push(source);
    // Prefer more specific (already set) levels — do not overwrite explicit with series
    return true;
  }
  matched.set(p.id, { part: p, min, max, sources: [source] });
  return true;
}

// 1) Explicit code/name matches
for (const s of specs) {
  const label = s.label || (s.codes || []).join("/");
  let any = false;
  for (const c of s.codes || []) {
    const p = findExact(c);
    if (p) {
      applyPart(p, s.min, s.max, label);
      any = true;
    }
  }
  if (s.nameExact) {
    const p = findExact(s.nameExact);
    if (p) {
      applyPart(p, s.min, s.max, label);
      any = true;
    }
  }
  if (!any && s.codes?.length) {
    missing.push({ label, codes: s.codes, min: s.min, max: s.max });
  }
}

// 2) Series / fuzzy (only existing catalog rows; never invent)
function seriesApply(predicate, min, max, label) {
  let n = 0;
  for (const p of parts) {
    if (matched.has(p.id)) continue; // already set by explicit code
    if (predicate(p)) {
      applyPart(p, min, max, label);
      n++;
    }
  }
  if (!n) missing.push({ label, codes: ["(series)"], min, max });
  return n;
}

// 0609PVC fittings (coup, male, female, 90, 45, tee, cap, ptrap) — not the 10ft stick
const pvcFitN = seriesApply(
  (p) => {
    const c = String(p.code || "").toLowerCase();
    const n = String(p.name || "").toLowerCase();
    if (!c.startsWith("0609pvc") && !n.includes("0609")) return false;
    if (c.includes("4007") || n.includes("10ft") || n.includes("pipe 10")) return false;
    // fittings keywords or any 0609PVC that's not pipe stick
    return (
      /coup|male|female|\b90\b|\b45\b|tee|cap|ptrap|p-trap|elbow|adapter|bushing|coupling/i.test(
        c + " " + n
      ) || c.startsWith("0609pvc")
    );
  },
  3,
  10,
  "0609PVC fittings series"
);

// 1/2 BLK IRN fittings series
const irnN = seriesApply(
  (p) => {
    const c = String(p.code || "").toLowerCase();
    const n = String(p.name || "").toLowerCase();
    const half = c.includes("1/2") || n.includes("1/2") || n.includes("1/2\"");
    const irn =
      c.includes("blk irn") ||
      n.includes("blk irn") ||
      n.includes("black iron") ||
      /\b(irn|iron)\b/i.test(n);
    return half && irn;
  },
  1,
  3,
  "1/2 BLK IRN fittings series"
);

// Dye
seriesApply(
  (p) => {
    const n = String(p.name || "").toLowerCase();
    const c = String(p.code || "").toLowerCase();
    return (
      n.includes("dye") &&
      (n.includes("flour") || n.includes("fluor") || n.includes("1/4") || c.includes("dye"))
    );
  },
  2,
  6,
  "1/4oz Flourent Dye - Single Use"
);

// Gulf Coat
seriesApply(
  (p) => {
    const n = String(p.name || "").toLowerCase();
    return n.includes("gulf coat") || (n.includes("protective coating") && n.includes("gulf"));
  },
  0,
  1,
  "Gulf Coat Protective Coating"
);

// Black Duct Tape
seriesApply(
  (p) => {
    const n = String(p.name || "").toLowerCase();
    const c = String(p.code || "").toLowerCase();
    return (
      (n.includes("black") && n.includes("duct") && n.includes("tape")) ||
      c.includes("black duct") ||
      n === "black duct tape"
    );
  },
  1,
  2,
  "Black Duct Tape"
);

// Belly Band
seriesApply(
  (p) => {
    const n = String(p.name || "").toLowerCase();
    const c = String(p.code || "").toLowerCase();
    return n.includes("belly band") || c.includes("belly");
  },
  0,
  1,
  "Belly Band"
);

// Suction driers (companion to drier box)
seriesApply(
  (p) => {
    const n = String(p.name || "").toLowerCase();
    const c = String(p.code || "").toLowerCase();
    if (c === "csodbx1017fr") return false;
    return (
      (n.includes("drier") || n.includes("dryer") || c.includes("drier")) &&
      (n.includes("suction") || n.includes("liquid") || n.includes("filter") || c.includes("drier"))
    );
  },
  2,
  4,
  "suction driers with drier box"
);

// Common MAR motors
seriesApply(
  (p) => {
    const c = String(p.code || "").toLowerCase();
    const n = String(p.name || "").toLowerCase();
    if (!c.startsWith("mar")) return false;
    return (
      n.includes("motor") ||
      n.includes("blower") ||
      n.includes("condenser") ||
      n.includes("inducer") ||
      n.includes("fan")
    );
  },
  0,
  1,
  "common MAR motors"
);

// Goodman/Lennox motors already via codes; also name-based if code differs
seriesApply(
  (p) => {
    const c = String(p.code || "").toUpperCase();
    return (
      c === "GOODMAN-BLOWER" ||
      c === "GOODMAN-CONDENSER" ||
      c === "LENNOX-BLOWER" ||
      c === "LENNOX-CONDENSER"
    );
  },
  0,
  1,
  "OEM blower/condenser motors"
);

const sql = [];
for (const [, v] of matched) {
  sql.push(
    `UPDATE parts SET truck_stock = 1, min_qty = ${v.min}, max_qty = ${v.max}, updated_at = datetime('now') WHERE id = ${v.part.id};`
  );
}
sql.push(`
-- Ensure zero qty rows exist on every active truck for truck-stock parts
INSERT OR IGNORE INTO stock_balances (location_id, part_id, qty, updated_at)
SELECT l.id, p.id, 0, datetime('now')
FROM stock_locations l
CROSS JOIN parts p
WHERE l.type = 'vehicle' AND IFNULL(l.active,1) = 1 AND IFNULL(p.truck_stock,0) = 1;
`);

const sqlPath = join(__dirname, "truck-stock-apply.sql");
writeFileSync(sqlPath, sql.join("\n"));

const report = {
  catalog_parts: parts.length,
  matched_count: matched.size,
  pvc_fittings_added: pvcFitN,
  black_iron_added: irnN,
  matched: [...matched.values()]
    .map((v) => ({
      id: v.part.id,
      code: v.part.code,
      name: v.part.name,
      low: v.min,
      high: v.max,
      sources: v.sources,
      prior_truck: v.part.truck_stock,
      prior_min: v.part.min_qty,
      prior_max: v.part.max_qty,
    }))
    .sort((a, b) => String(a.code).localeCompare(String(b.code))),
  missing,
};

writeFileSync(join(__dirname, "truck-stock-report.json"), JSON.stringify(report, null, 2));

console.log(`Catalog: ${parts.length} parts`);
console.log(`Matched & will update: ${matched.size}`);
console.log(`Missing (not in pricebook): ${missing.length}`);
for (const m of missing) {
  console.log(`  MISS  ${m.label}  codes=${(m.codes || []).join(",") || "—"}  low=${m.min} high=${m.max}`);
}
console.log(`SQL → ${sqlPath}`);

// Apply remote
console.log("Applying SQL to remote D1…");
try {
  execSync(`npx wrangler d1 execute fleet_db --remote --file="${sqlPath}"`, {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  console.log("Done.");
} catch (e) {
  console.error("wrangler execute failed — run SQL manually:", sqlPath);
  process.exit(1);
}

// Verify sample
console.log("\\nVerification (sample):");
try {
  const out = execSync(
    `npx wrangler d1 execute fleet_db --remote --json --command "SELECT COUNT(*) as truck FROM parts WHERE active=1 AND truck_stock=1; SELECT code, name, min_qty, max_qty, truck_stock FROM parts WHERE truck_stock=1 ORDER BY code LIMIT 25"`,
    { cwd: root, encoding: "utf8", shell: true }
  );
  console.log(out.slice(0, 2500));
} catch {
  /* ok */
}
