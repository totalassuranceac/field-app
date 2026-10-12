/**
 * Repair part finder (serial-first). TEST stub for Lennox / Daikin / Carrier.
 * HARD: no vendor secrets in public Worker, no auto ST PO, no invent qty.
 * po_reference = job site address string.
 */
import type { PublicUser } from "./types";
import { getSetting, setSetting, writeAudit } from "./audit";
import { notifyUsers, usersByRoles } from "./notifications";
import { HARD_LOCK_INSTALL_PAIRS, namesMatchHint } from "./installCrewPairs";

export const PART_FINDER_V1_KEY = "part_finder_v1_enabled";

export const PART_FINDER_VENDORS = {
  lennox: {
    brand: "lennox" as const,
    label: "Lennox",
    vendorLabel: "LennoxPros",
    finderUrl: "https://www.lennoxpros.com/hvac-repair-part-finder",
  },
  daikin: {
    brand: "daikin" as const,
    label: "Daikin",
    vendorLabel: "Daikin Comfort",
    finderUrl: "https://my.daikincomfort.com/parts-finder",
  },
  carrier: {
    brand: "carrier" as const,
    label: "Carrier",
    vendorLabel: "Carrier Enterprise",
    finderUrl: "https://www.carrierenterprise.com/part-finder",
  },
  other: {
    brand: "other" as const,
    label: "Other",
    vendorLabel: "Other",
    finderUrl: null as string | null,
  },
};

export type PartFinderBrand = keyof typeof PART_FINDER_VENDORS;

export const FAILED_COMPONENTS = [
  "board",
  "txv",
  "motor",
  "compressor",
  "coil",
  "other",
] as const;

export type FailedComponent = (typeof FAILED_COMPONENTS)[number];

export type StubLine = {
  lineKey: string;
  failedComponent: string;
  catNumber: string | null;
  oem: string;
  description: string;
  pickupQty: number | null;
  shippingStatus: string;
  productUrl: string | null;
  vendor: string;
  availability: "available" | "ship_only" | "out" | "pending";
  source: "stub";
};

export async function partFinderV1Enabled(db: D1Database): Promise<boolean> {
  const raw = (await getSetting(db, PART_FINDER_V1_KEY, "true")).trim().toLowerCase();
  if (raw === "") return true;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export async function setPartFinderV1Enabled(db: D1Database, on: boolean): Promise<void> {
  await setSetting(db, PART_FINDER_V1_KEY, on ? "true" : "false");
}

function isHelper(name: string): boolean {
  return HARD_LOCK_INSTALL_PAIRS.some((p) => namesMatchHint(name, p.helper));
}

function isLeadInstaller(name: string): boolean {
  return HARD_LOCK_INSTALL_PAIRS.some((p) => namesMatchHint(name, p.lead));
}

/** Admin always. Others when PART_FINDER_V1 on (default true for TEST). */
export async function canUsePartFinder(db: D1Database, user: PublicUser): Promise<boolean> {
  if (user.role === "admin") return true;
  if (!(await partFinderV1Enabled(db))) return false;
  if (user.role === "warehouse" || user.role === "office" || user.role === "supervisor") {
    return true;
  }
  const name = user.display_name || "";
  if (isHelper(name)) return false;
  if (user.role === "driver") return true;
  if (isLeadInstaller(name)) return true;
  if (user.role === "mechanic") return true;
  return false;
}

export async function ensurePartFinderTables(db: D1Database): Promise<void> {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS part_finder_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      serial TEXT NOT NULL,
      brand TEXT NOT NULL,
      failed_components TEXT NOT NULL,
      failed_other_text TEXT,
      job_id TEXT,
      job_number TEXT,
      job_address TEXT NOT NULL,
      po_reference TEXT NOT NULL,
      finder_url TEXT,
      vendor_label TEXT,
      fulfillment_preference TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'queued',
      lookup_source TEXT NOT NULL DEFAULT 'stub',
      stub_mode INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      needs_install INTEGER NOT NULL DEFAULT 0,
      no_cool INTEGER NOT NULL DEFAULT 0,
      picked_up_at TEXT,
      schedule_status TEXT,
      manager_pinged_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_part_finder_req_user
      ON part_finder_requests(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_part_finder_req_status
      ON part_finder_requests(status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS part_finder_request_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL,
      line_key TEXT,
      failed_component TEXT,
      cat_number TEXT,
      oem TEXT,
      description TEXT,
      qty REAL NOT NULL DEFAULT 1,
      pickup_qty REAL,
      shipping_status TEXT,
      product_url TEXT,
      vendor TEXT,
      availability TEXT,
      fulfillment TEXT,
      source TEXT NOT NULL DEFAULT 'stub',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_part_finder_lines_req
      ON part_finder_request_lines(request_id)`,
    `ALTER TABLE part_finder_requests ADD COLUMN needs_install INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE part_finder_requests ADD COLUMN no_cool INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE part_finder_requests ADD COLUMN picked_up_at TEXT`,
    `ALTER TABLE part_finder_requests ADD COLUMN schedule_status TEXT`,
    `ALTER TABLE part_finder_requests ADD COLUMN manager_pinged_at TEXT`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* already exists */
    }
  }
}

export function parseBrand(raw: unknown): PartFinderBrand | null {
  const b = String(raw || "").trim().toLowerCase();
  if (b === "lennox" || b === "daikin" || b === "carrier" || b === "other") return b;
  return null;
}

export function parseFailedComponents(raw: unknown): FailedComponent[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: FailedComponent[] = [];
  for (const x of raw) {
    const t = String(x || "").trim().toLowerCase();
    if ((FAILED_COMPONENTS as readonly string[]).includes(t) && !out.includes(t as FailedComponent)) {
      out.push(t as FailedComponent);
    }
  }
  return out.length ? out : null;
}

function looksLikeAddress(s: string): boolean {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length < 5) return false;
  if (/^\d{1,6}[A-Za-z]?\s+\S/.test(t)) return true;
  if (/^(p\.?\s*o\.?\s*box|hwy|fm|ih|us)\b/i.test(t)) return true;
  return t.length >= 8;
}

const FAILED_LABEL: Record<FailedComponent, string> = {
  board: "Board",
  txv: "TXV",
  motor: "Motor",
  compressor: "Compressor",
  coil: "Coil",
  other: "Other",
};

/**
 * Brand router only. Live BOM lookup is phase-2.
 * Does not invent a Cat # or a pickup qty.
 */
export function stubLookup(opts: {
  serial: string;
  brand: PartFinderBrand;
  failed: FailedComponent[];
  needText?: string | null;
}): {
  lookupStatus: string;
  source: "stub";
  stubBanner: string;
  serial: string;
  brand: PartFinderBrand;
  vendor: string;
  finderUrl: string | null;
  lines: StubLine[];
} {
  const v = PART_FINDER_VENDORS[opts.brand];
  const need = String(opts.needText || "").replace(/\s+/g, " ").trim();
  const oem =
    opts.brand === "lennox" ? "Lennox" : opts.brand === "daikin" ? "Daikin" : opts.brand === "carrier" ? "Carrier" : "";

  if (opts.brand === "other" || !v.finderUrl) {
    return {
      lookupStatus: "needs_brand_or_manual",
      source: "stub",
      stubBanner: "No parts yet - office will research. Your request can still be sent.",
      serial: opts.serial,
      brand: opts.brand,
      vendor: v.vendorLabel,
      finderUrl: null,
      lines: [],
    };
  }

  const chips = opts.failed.filter((c, i, arr) => c !== "other" && arr.indexOf(c) === i).slice(0, 6);
  const keywordHits = chips.length
    ? []
    : [
        { id: "board", re: /\bboards?\b/i, label: "Board" },
        { id: "txv", re: /\btxv\b/i, label: "TXV" },
        { id: "motor", re: /\bmotors?\b/i, label: "Motor" },
        { id: "compressor", re: /\bcompressors?\b/i, label: "Compressor" },
        { id: "coil", re: /\bcoils?\b/i, label: "Coil" },
        { id: "capacitor", re: /\bcapacitors?\b/i, label: "Capacitor" },
        { id: "contactor", re: /\bcontactors?\b/i, label: "Contactor" },
      ].filter((k) => k.re.test(need));

  const specs = chips.length
    ? chips.map((comp) => ({
        id: comp,
        label: need ? `${FAILED_LABEL[comp] || comp} - ${need}` : FAILED_LABEL[comp] || comp,
      }))
    : keywordHits.length
      ? keywordHits.map((k) => ({ id: k.id, label: k.label }))
      : [{ id: "other", label: need || "Part per description" }];

  const lines: StubLine[] = specs.map((spec, idx) => ({
    lineKey: `stub-${opts.brand}-${spec.id}-${idx + 1}`,
    failedComponent: spec.id,
    catNumber: null,
    oem,
    description: `${spec.label} (STUB - not live vendor)`,
    pickupQty: null,
    shippingStatus: "lookup_pending",
    productUrl: v.finderUrl,
    vendor: v.vendorLabel,
    availability: "pending",
    source: "stub",
  }));

  return {
    lookupStatus: "pending",
    source: "stub",
    stubBanner: "Lookup pending - not a live vendor catalog. Cat # and stock are not guessed.",
    serial: opts.serial,
    brand: opts.brand,
    vendor: v.vendorLabel,
    finderUrl: v.finderUrl,
    lines,
  };
}

export async function notifyPartFinderRequest(
  db: D1Database,
  actor: PublicUser,
  requestId: number,
  poReference: string,
  summary: string
): Promise<void> {
  const notifyIds = new Set<number>();
  for (const uid of await usersByRoles(db, ["warehouse", "admin", "office", "supervisor"])) {
    notifyIds.add(uid);
  }
  try {
    const chris = await db
      .prepare(
        `SELECT id FROM users WHERE active = 1 AND (
           lower(IFNULL(display_name,'')) LIKE 'chris marroquin%'
           OR lower(IFNULL(username,'')) IN ('admin', 'chrismarroquin')
         ) LIMIT 5`
      )
      .all<{ id: number }>();
    for (const r of chris.results || []) notifyIds.add(r.id);
  } catch {
    /* optional */
  }
  notifyIds.delete(actor.id);
  if (!notifyIds.size) return;
  await notifyUsers(
    db,
    [...notifyIds].slice(0, 40),
    "part_finder_request",
    `Repair part request - ${poReference.slice(0, 80)}`,
    `${actor.display_name}: ${summary}`.slice(0, 240),
    { type: "part_finder_request", id: requestId }
  );
}

export type OrderLineIn = {
  lineKey?: string | null;
  failedComponent?: string | null;
  catNumber?: string | null;
  oem?: string | null;
  description?: string | null;
  qty?: number | null;
  pickupQty?: number | null;
  shippingStatus?: string | null;
  productUrl?: string | null;
  vendor?: string | null;
  availability?: string | null;
  source?: string | null;
  fulfillment?: string | null;
};

export async function createPartFinderOrderRequest(
  db: D1Database,
  user: PublicUser,
  body: {
    serial: string;
    brand: PartFinderBrand;
    failed_components: FailedComponent[];
    failed_other_text?: string | null;
    job_id?: string | null;
    job_number?: string | null;
    job_address: string;
    fulfillment_preference?: string | null;
    lines: OrderLineIn[];
    note?: string | null;
    needs_install?: boolean | null;
    no_cool?: boolean | null;
  }
): Promise<{
  id: number;
  status: string;
  po_reference: string;
  message: string;
  vendor_checkout: false;
  st_po_minted: false;
  stub_mode: true;
}> {
  await ensurePartFinderTables(db);
  const serial = body.serial.trim();
  if (!serial) throw new Error("Serial is required");
  const address = (body.job_address || "").replace(/\s+/g, " ").trim();
  if (!looksLikeAddress(address)) {
    throw new Error("Job site address is required - it becomes the PO reference");
  }
  const poReference = address;
  const linesIn = body.lines?.length
    ? body.lines
    : [
        {
          lineKey: "office-research",
          failedComponent: body.failed_components[0] || "other",
          description: (body.note || body.failed_other_text || "Office research").slice(0, 180),
          qty: 1,
          pickupQty: null,
          shippingStatus: "lookup_pending",
          availability: "pending",
          source: "stub",
          fulfillment: "pending_review",
        },
      ];

  const v = PART_FINDER_VENDORS[body.brand];
  const hasCoil = partMentionsCoil([
    ...body.failed_components,
    body.failed_other_text || "",
    body.note || "",
    ...linesIn.map((l) => `${l.failedComponent || ""} ${l.description || ""}`),
  ]);
  const needsInstall = body.needs_install === true || hasCoil;
  const noCool = body.no_cool === true;
  const prefRaw = String(body.fulfillment_preference || (noCool ? "pickup" : "auto")).toLowerCase();
  let pref = prefRaw === "pickup" || prefRaw === "ship" || prefRaw === "auto" ? prefRaw : "auto";
  if (noCool) pref = "pickup";

  const ins = await db
    .prepare(
      `INSERT INTO part_finder_requests (
         user_id, serial, brand, failed_components, failed_other_text,
         job_id, job_number, job_address, po_reference, finder_url, vendor_label,
         fulfillment_preference, status, lookup_source, stub_mode, note,
         needs_install, no_cool,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'stub', 1, ?, ?, ?, datetime('now'), datetime('now'))`
    )
    .bind(
      user.id,
      serial,
      body.brand,
      JSON.stringify(body.failed_components),
      (body.failed_other_text || "").trim() || null,
      (body.job_id || "").trim() || null,
      (body.job_number || "").trim() || null,
      address,
      poReference,
      v.finderUrl,
      v.vendorLabel,
      pref,
      (body.note || "").trim() || null,
      needsInstall ? 1 : 0,
      noCool ? 1 : 0
    )
    .run();
  const id = Number(ins.meta.last_row_id);

  for (const line of linesIn) {
    const pickupQty =
      line.pickupQty != null && Number.isFinite(Number(line.pickupQty))
        ? Number(line.pickupQty)
        : null;
    let fulfillment = String(line.fulfillment || "").toLowerCase();
    if (fulfillment !== "pickup" && fulfillment !== "ship" && fulfillment !== "pending_review") {
      if (pref === "pickup") fulfillment = "pickup";
      else if (pref === "ship") fulfillment = "ship";
      else if (pickupQty != null && pickupQty > 0) fulfillment = "pickup";
      else if (String(line.shippingStatus || "").includes("ship")) fulfillment = "ship";
      else fulfillment = "pending_review";
    }
    const qty = Number(line.qty);
    await db
      .prepare(
        `INSERT INTO part_finder_request_lines (
           request_id, line_key, failed_component, cat_number, oem, description,
           qty, pickup_qty, shipping_status, product_url, vendor, availability,
           fulfillment, source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .bind(
        id,
        (line.lineKey || "").trim() || null,
        (line.failedComponent || "").trim() || null,
        (line.catNumber || "").trim() || null,
        (line.oem || "").trim() || null,
        (line.description || "").trim() || null,
        Number.isFinite(qty) && qty > 0 ? qty : 1,
        pickupQty,
        (line.shippingStatus || "").trim() || null,
        (line.productUrl || "").trim() || null,
        (line.vendor || "").trim() || v.vendorLabel,
        (line.availability || "").trim() || null,
        fulfillment,
        (line.source || "stub").trim() || "stub"
      )
      .run();
  }

  const catSummary = linesIn
    .map((l) => l.catNumber || l.description || "?")
    .slice(0, 4)
    .join(", ");
  try {
    await notifyPartFinderRequest(
      db,
      user,
      id,
      poReference,
      `${noCool ? "RUSH no-cool - " : ""}${body.brand} serial ${serial} - ${catSummary}`
    );
  } catch {
    /* non-fatal */
  }

  try {
    await writeAudit(
      db,
      user,
      "create",
      "part_finder_request",
      id,
      `PO ${poReference} / ${serial}`.slice(0, 120)
    );
  } catch {
    /* optional */
  }

  return {
    id,
    status: "queued",
    po_reference: poReference,
    message: `Order queued - address PO: ${poReference}`,
    vendor_checkout: false,
    st_po_minted: false,
    stub_mode: true,
  };
}

function partMentionsCoil(parts: string[]): boolean {
  return parts.some((p) => /\bcoils?\b/i.test(String(p || "")));
}

async function millerUserIds(db: D1Database): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT id FROM users WHERE active = 1 AND (
         lower(IFNULL(display_name, '')) LIKE '%miller%'
         OR lower(IFNULL(username, '')) LIKE '%miller%'
       )`
    )
    .all<{ id: number }>();
  return (rows.results || []).map((r) => r.id);
}

async function chrisUserIds(db: D1Database): Promise<number[]> {
  const rows = await db
    .prepare(
      `SELECT id FROM users WHERE active = 1 AND (
         lower(IFNULL(display_name,'')) LIKE 'chris marroquin%'
         OR lower(IFNULL(username,'')) IN ('admin', 'chrismarroquin')
       ) LIMIT 5`
    )
    .all<{ id: number }>();
  return (rows.results || []).map((r) => r.id);
}

type FinderRow = {
  id: number;
  user_id: number;
  serial: string;
  brand: string;
  po_reference: string;
  job_address: string;
  needs_install: number | null;
  no_cool: number | null;
  picked_up_at: string | null;
  schedule_status: string | null;
  manager_pinged_at: string | null;
  note: string | null;
  failed_components: string | null;
  failed_other_text: string | null;
};

async function loadFinder(db: D1Database, id: number): Promise<FinderRow | null> {
  return db
    .prepare(`SELECT * FROM part_finder_requests WHERE id = ?`)
    .bind(id)
    .first<FinderRow>();
}

function canMarkPickedUp(user: PublicUser, row: FinderRow): boolean {
  if (user.id === row.user_id) return true;
  return (
    user.role === "admin" ||
    user.role === "warehouse" ||
    user.role === "office" ||
    user.role === "supervisor"
  );
}

function isMillerUser(user: PublicUser): boolean {
  const name = `${user.display_name || ""} ${user.username || ""}`.toLowerCase();
  return user.role === "admin" || name.includes("miller");
}

/** Picked up: always the requesting tech. Miller only for coil or needs-install. */
export async function markPartFinderPickedUp(
  db: D1Database,
  user: PublicUser,
  id: number
): Promise<{ already: boolean; needs_install: boolean }> {
  await ensurePartFinderTables(db);
  const row = await loadFinder(db, id);
  if (!row) throw new Error("Not found");
  if (!canMarkPickedUp(user, row)) throw new Error("Not allowed to mark picked up");
  const install = Number(row.needs_install || 0) === 1;
  if (row.picked_up_at) return { already: true, needs_install: install };

  await db
    .prepare(
      `UPDATE part_finder_requests
       SET picked_up_at = datetime('now'),
           schedule_status = CASE WHEN ? = 1 THEN 'needs_miller' ELSE schedule_status END,
           updated_at = datetime('now')
       WHERE id = ? AND picked_up_at IS NULL`
    )
    .bind(install ? 1 : 0, id)
    .run();

  const place = row.po_reference || row.job_address;
  const rush = Number(row.no_cool || 0) === 1 ? "RUSH no-cool - " : "";
  await notifyUsers(
    db,
    [row.user_id],
    "part_finder_picked",
    "Part picked up",
    `${rush}${place} - serial ${row.serial}`.slice(0, 220),
    { type: "part_finder_request", id }
  );

  if (install) {
    const millers = (await millerUserIds(db)).filter((uid) => uid !== user.id);
    if (millers.length) {
      await notifyUsers(
        db,
        millers,
        "part_finder_schedule",
        "Parts ready - put on schedule",
        `${rush}${place} - coil or install. Pick a crew.`.slice(0, 220),
        { type: "part_finder_request", id }
      );
    }
  } else {
    const warehouse = (await usersByRoles(db, ["warehouse"])).filter(
      (uid) => uid !== user.id && uid !== row.user_id
    );
    if (warehouse.length) {
      await notifyUsers(
        db,
        warehouse,
        "part_finder_picked",
        "Part picked up - tech only",
        `${rush}${place} - no install. Miller not notified.`.slice(0, 220),
        { type: "part_finder_request", id }
      );
    }
  }

  return { already: false, needs_install: install };
}

export async function markPartFinderScheduled(
  db: D1Database,
  user: PublicUser,
  id: number
): Promise<{ schedule_status: string }> {
  await ensurePartFinderTables(db);
  const row = await loadFinder(db, id);
  if (!row) throw new Error("Not found");
  if (!row.picked_up_at) throw new Error("Mark the part picked up first");
  const install = Number(row.needs_install || 0) === 1;
  if (install) {
    if (!isMillerUser(user)) throw new Error("Miller marks the install scheduled");
  } else if (!canMarkPickedUp(user, row)) {
    throw new Error("Not allowed");
  }
  const next = install ? "booked" : "return_scheduled";
  if (row.schedule_status === next) return { schedule_status: next };
  await db
    .prepare(
      `UPDATE part_finder_requests
       SET schedule_status = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
    .bind(next, id)
    .run();
  return { schedule_status: next };
}

const NO_COOL_WAIT_MS = 2 * 60 * 60 * 1000;
const NORMAL_WAIT_MS = 24 * 60 * 60 * 1000;
const SCHEDULED = new Set(["booked", "return_scheduled", "skipped", "assigned"]);

/** In-app only. No-cool waits 2h; other unscheduled waits 24h. One ping. */
export async function pingUnscheduledPartFinder(db: D1Database): Promise<number> {
  await ensurePartFinderTables(db);
  let rows: Array<FinderRow & { manager_user_id: number | null }> = [];
  try {
    const got = await db
      .prepare(
        `SELECT r.*, u.manager_user_id AS manager_user_id
         FROM part_finder_requests r
         JOIN users u ON u.id = r.user_id
         WHERE r.picked_up_at IS NOT NULL
           AND r.manager_pinged_at IS NULL
         ORDER BY r.picked_up_at ASC
         LIMIT 40`
      )
      .all<FinderRow & { manager_user_id: number | null }>();
    rows = got.results || [];
  } catch {
    return 0;
  }
  let n = 0;
  const now = Date.now();
  for (const row of rows) {
    if (SCHEDULED.has(String(row.schedule_status || ""))) continue;
    const picked = Date.parse(String(row.picked_up_at || "").replace(" ", "T") + "Z");
    if (!Number.isFinite(picked)) continue;
    const limit = Number(row.no_cool || 0) === 1 ? NO_COOL_WAIT_MS : NORMAL_WAIT_MS;
    if (now - picked < limit) continue;
    let managerId = Number(row.manager_user_id || 0);
    if (!(managerId > 0)) {
      const chris = await chrisUserIds(db);
      managerId = chris[0] || 0;
    }
    if (!(managerId > 0) || managerId === row.user_id) {
      const chris = (await chrisUserIds(db)).find((id) => id !== row.user_id);
      managerId = chris || 0;
    }
    if (!(managerId > 0)) continue;
    const place = row.po_reference || row.job_address;
    const rush = Number(row.no_cool || 0) === 1;
    await notifyUsers(
      db,
      [managerId],
      "part_finder_wait",
      rush
        ? "No-cool wait - confirm the customer is not sitting"
        : "Part wait - confirm a delay is necessary",
      `${place} - picked up, not scheduled yet.`.slice(0, 220),
      { type: "part_finder_request", id: row.id }
    );
    await db
      .prepare(
        `UPDATE part_finder_requests
         SET manager_pinged_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND manager_pinged_at IS NULL`
      )
      .bind(row.id)
      .run();
    n += 1;
  }
  return n;
}
