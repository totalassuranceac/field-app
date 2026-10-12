import type { Context } from "hono";
import type { Env, PublicUser, Role, UserRow } from "./types";

const SESSION_COOKIE = "fleet_session";
const SESSION_DAYS = 14;

/** Map DB row → public user. Warehouse is stored as office + is_warehouse=1 (CHECK on role). */
export function toPublicUser(u: UserRow): PublicUser {
  const isWh = Boolean(u.is_warehouse) || u.role === "warehouse";
  const stId =
    u.st_technician_id != null && Number(u.st_technician_id) > 0
      ? Number(u.st_technician_id)
      : null;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    display_name: u.display_name,
    role: isWh ? "warehouse" : u.role,
    is_warehouse: isWh,
    employee_id: u.employee_id,
    phone: u.phone ?? null,
    st_technician_id: stId,
    must_change_password: Boolean(u.must_change_password),
  };
}

/**
 * Persist role for users table.
 * Warehouse is still office + is_warehouse=1 (legacy CHECK workaround).
 * Supervisor is a first-class role value (migration 063).
 */
export function dbRoleFor(role: Role): { role: Role; is_warehouse: number } {
  if (role === "warehouse") return { role: "office", is_warehouse: 1 };
  if (role === "supervisor") return { role: "supervisor", is_warehouse: 0 };
  return { role, is_warehouse: 0 };
}

/** Office leadership + supervisors (day-to-day ops, not full admin). */
export function isOfficeSide(role: string): boolean {
  return role === "admin" || role === "office" || role === "supervisor";
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return bufToHex(arr.buffer);
}

export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return {
    hash: bufToHex(bits),
    salt: saltHex ?? bufToHex(salt.buffer as ArrayBuffer),
  };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const result = await hashPassword(password, salt);
  return result.hash === hash;
}

export function sessionCookie(token: string, maxAgeSec: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}

export function getSessionToken(c: Context<{ Bindings: Env }>): string | null {
  const cookie = c.req.header("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export async function createSession(db: D1Database, userId: number): Promise<string> {
  const id = randomToken(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db
    .prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(id, userId, expires)
    .run();
  return id;
}

export async function destroySession(db: D1Database, token: string | null): Promise<void> {
  if (!token) return;
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(token).run();
}

export async function getUserFromSession(db: D1Database, token: string | null): Promise<UserRow | null> {
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now') AND u.active = 1`
    )
    .bind(token)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Permission check for API routes.
 * Admin always passes (superuser) so one admin login can exercise every feature.
 */
export function roleAtLeast(role: Role, allowed: Role[]): boolean {
  if (role === "admin") return true;
  return allowed.includes(role);
}

/**
 * Fleet map named exceptions. Field techs stay off the map.
 * Chuck is mechanic. Speedy is warehouse (office + is_warehouse).
 * Keep the same usernames in src/api.ts isNamedFleetMapUser.
 */
const FLEET_MAP_USERNAMES = new Set(["chuckdickerson", "speedy.marroquin"]);
const FLEET_MAP_NAMES = new Set(["chuck dickerson", "speedy marroquin"]);

export function isNamedFleetMapUser(
  user: { username?: string | null; display_name?: string | null } | null | undefined
): boolean {
  if (!user) return false;
  const username = String(user.username || "").trim().toLowerCase();
  if (username && FLEET_MAP_USERNAMES.has(username)) return true;
  const name = String(user.display_name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return FLEET_MAP_NAMES.has(name);
}

export const ROLE_PERMS = {
  /** Login accounts / role assignment — admin only */
  manageUsers: ["admin"] as Role[],
  /** Employee directory edits — office + supervisors (not system settings) */
  manageEmployees: ["admin", "office", "supervisor"] as Role[],
  manageVehicles: ["admin", "office", "mechanic", "supervisor"] as Role[],
  /** Registration stickers + insurance dates (office, shop, admin — not field drivers). */
  manageVehicleCompliance: ["admin", "office", "mechanic", "supervisor"] as Role[],
  /** Any staff can log a fuel receipt photo (warehouse / shop included). */
  logFuel: ["admin", "office", "driver", "mechanic", "warehouse", "supervisor"] as Role[],
  editAnyFuel: ["admin", "office", "supervisor"] as Role[],
  viewFuel: [
    "admin",
    "office",
    "driver",
    "mechanic",
    "warehouse",
    "viewer",
    "supervisor",
  ] as Role[],
  /** Company-card parts receipts (invoice / packing slip photos) */
  logPartsPurchase: [
    "admin",
    "office",
    "driver",
    "mechanic",
    "warehouse",
    "supervisor",
  ] as Role[],
  viewPartsPurchase: [
    "admin",
    "office",
    "driver",
    "mechanic",
    "warehouse",
    "viewer",
    "supervisor",
  ] as Role[],
  /** Dump / landfill ticket logs — warehouse + fleet mechanic */
  logDumpRuns: ["admin", "warehouse", "mechanic", "supervisor"] as Role[],
  viewDumpRuns: ["admin", "warehouse", "mechanic", "viewer", "supervisor"] as Role[],
  /** Read mileage flags + tracking health (viewers browse-only) */
  viewAlerts: ["admin", "office", "mechanic", "viewer", "supervisor"] as Role[],
  /** Ack / dismiss flags — admin, office, mechanic (shop eyes) */
  manageAlerts: ["admin", "office", "mechanic", "supervisor"] as Role[],
  reportIssues: ["admin", "office", "driver", "mechanic", "supervisor"] as Role[],
  manageIssues: ["admin", "mechanic", "office", "supervisor"] as Role[],
  /** Audit trail: admin + viewer + supervisor (browse only) */
  viewAudit: ["admin", "viewer", "supervisor"] as Role[],
  viewReports: [
    "admin",
    "office",
    "mechanic",
    "viewer",
    "warehouse",
    "supervisor",
  ] as Role[],
  /** System / integration settings — admin only */
  manageSettings: ["admin"] as Role[],
  /** Read company settings / people lists without write (viewer explores app) */
  browseAdmin: ["admin", "viewer", "supervisor"] as Role[],
  /**
   * Inventory
   * - view: admin, office, warehouse, viewer, supervisor
   * - manage: issue/receive, transfers, import (admin + warehouse only)
   * - levels: min/max only admin + warehouse
   */
  viewInventory: ["admin", "office", "warehouse", "viewer", "supervisor"] as Role[],
  manageInventory: ["admin", "warehouse"] as Role[],
  manageInventoryLevels: ["admin", "warehouse"] as Role[],
  /**
   * Live GPS map (OneStep + Verizon).
   * Admin, office (manager login), and supervisor only.
   * There is no separate manager role. Field techs do not see others.
   * Chuck and Speedy are named exceptions (see isNamedFleetMapUser).
   */
  viewLiveMap: ["admin", "office", "supervisor"] as Role[],
  /**
   * Company assets (bottles, ladders, tools) — outside pricebook
   * - view: broad; manage: warehouse + admin only
   */
  viewCompanyAssets: [
    "admin",
    "office",
    "warehouse",
    "driver",
    "mechanic",
    "viewer",
    "supervisor",
  ] as Role[],
  manageCompanyAssets: ["admin", "warehouse"] as Role[],
  /**
   * Studio door (live ta-ads app). Office + admin only in ROLE_PERMS.
   * Named extras (Kelsie, Adam, …) are checked in the UI via canOpenStudio —
   * there is no Field App API that proxies Studio votes.
   */
  openStudio: ["admin", "office"] as Role[],
  /**
   * Job clock (Dispatch → Arrive → Complete). Field techs + admin for testing.
   * Phase 1 queues locally — does not write ServiceTitan appointment status.
   */
  useJobClock: ["admin", "driver"] as Role[],
  manageInstallPermit: ["admin", "office", "supervisor"] as Role[],
  /** Ops Performance board — office eyes only (not field / warehouse / mechanic). */
  viewOpsPerformance: ["admin", "office", "supervisor", "driver", "mechanic", "warehouse"] as Role[],
  /**
   * Day Board (ST schedule read-only).
   * Office/admin/supervisor = all rows; driver = own day (enforced in handler).
   */
  viewDayBoard: ["admin", "office", "supervisor", "driver"] as Role[],
  /** How long each ServiceTitan job type takes. Office and supervisors only. */
  viewJobLengths: ["admin", "office", "supervisor"] as Role[],
  /** Deliveries (parts in -> staged -> picked up). Page + list. */
  viewDeliveries: ["admin", "office", "warehouse", "driver", "mechanic", "supervisor", "viewer"] as Role[],
  /** Receive a delivery + add a staging spot at receive time (Speedy). Also Void. */
  receiveDeliveries: ["admin", "warehouse"] as Role[],
  /** Office marks Scheduled / un-schedules. */
  scheduleDeliveries: ["admin", "office"] as Role[],
  /** Anyone working can tap Picked up (techs included). */
  pickupDeliveries: ["admin", "office", "warehouse", "driver", "mechanic", "supervisor"] as Role[],
  /** Undo pickup, move spot, retire a spot. */
  manageDeliveries: ["admin", "office", "warehouse"] as Role[],
  /** Vendor hand-off proof (vendor rep signs on the phone). Anyone who carries a part back. */
  recordVendorHandoff: ["admin", "office", "warehouse", "mechanic", "supervisor", "driver"] as Role[],
  /** See Proof of hand-off on cards + print the receipt. */
  viewVendorHandoffs: ["admin", "office", "warehouse", "mechanic", "supervisor", "driver", "viewer"] as Role[],
  /** Fleet Shop page, queue, vehicles, work order detail. */
  viewFleetShop: ["admin", "mechanic", "supervisor", "office", "viewer"] as Role[],
  /** Timer, schedule, notes, parts, photos, Done, clock. */
  workFleetShop: ["admin", "mechanic"] as Role[],
  /** PM intervals and last-done. */
  managePm: ["admin", "mechanic", "supervisor"] as Role[],
  /** Manager board. */
  viewFleetBoard: ["admin", "supervisor", "office", "viewer"] as Role[],
  /** 3-tap truck problem. Every working role. */
  reportTruckProblem: ["admin", "office", "driver", "mechanic", "supervisor", "warehouse"] as Role[],
  /** Fleet Shop settings and segment time fixes. */
  manageFleetShopSettings: ["admin"] as Role[],
  /** Done today: see every person. */
  viewDoneTodayAll: ["admin"] as Role[],
  /** Who still needs which safety topic. Read only. Not field, shop, or warehouse. */
  viewSafetyStatus: ["admin", "office", "supervisor"] as Role[],
  /** Who is ready to schedule a NATE test. Not a ranking. Not field. */
  viewNateStatus: ["admin", "office", "supervisor"] as Role[],
  /** Open tool borrows. Office eyes. Not a ranking and not shown to field. */
  viewToolCustody: ["admin", "office", "supervisor"] as Role[],
  /** Mark a gas bottle as the company's or an employee's. */
  manageGasBottleOwners: ["admin", "office", "warehouse", "supervisor"] as Role[],
  /**
   * Saved employee write-ups. Private HR.
   * Admin, office, and supervisor can save and read. Void is admin and office only
   * (checked in the write-up route). Field, shop, warehouse, and viewer never see them.
   */
  manageWriteups: ["admin", "office", "supervisor"] as Role[],
  /** Company card and company vehicle signature forms. Office eyes. Not field. */
  viewResponsibility: ["admin", "office", "supervisor"] as Role[],
};

function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Vehicles a driver is "home" on (their usual unit) — not partner vans.
 * Used as the default pick for fuel / forms. Empty if none linked.
 */
export async function getDriverHomeVehicleIds(
  db: D1Database,
  user: PublicUser
): Promise<number[]> {
  if (user.role !== "driver") return [];

  const myNames: string[] = [];
  if (user.display_name?.trim()) myNames.push(normName(user.display_name));
  if (user.username?.trim()) myNames.push(normName(user.username));

  const myEmpIds = new Set<number>();
  if (user.employee_id) {
    myEmpIds.add(user.employee_id);
    try {
      const emp = await db
        .prepare(`SELECT id, name FROM employees WHERE id = ? AND active = 1`)
        .bind(user.employee_id)
        .first<{ id: number; name: string }>();
      if (emp?.name) myNames.push(normName(emp.name));
    } catch {
      /* ignore */
    }
  }

  const idSet = new Set<number>();

  // My explicit driver or helper seat on a unit
  if (myEmpIds.size) {
    try {
      const ph = [...myEmpIds].map(() => "?").join(",");
      const byEmp = await db
        .prepare(
          `SELECT id FROM vehicles WHERE status != 'retired' AND (
             assigned_employee_id IN (${ph}) OR helper_employee_id IN (${ph})
           )`
        )
        .bind(...myEmpIds, ...myEmpIds)
        .all<{ id: number }>();
      for (const r of byEmp.results || []) idSet.add(r.id);
    } catch {
      /* columns may be missing pre-036 */
    }
  }

  // Legacy assigned_driver text match to *me only* (not rides-with partner)
  if (myNames.length) {
    const rows = await db
      .prepare(
        `SELECT id, assigned_driver FROM vehicles WHERE status != 'retired' AND assigned_driver IS NOT NULL`
      )
      .all<{ id: number; assigned_driver: string }>();

    for (const v of rows.results || []) {
      const ad = normName(v.assigned_driver || "");
      if (!ad) continue;
      const hit = myNames.some((n) => n && (ad === n || ad.includes(n) || n.includes(ad)));
      if (hit) idSet.add(v.id);
    }
  }

  return [...idSet];
}

/**
 * Vehicles a driver may see on restricted screens (map unit, my gear, etc.):
 * - assigned_employee_id / helper_employee_id match
 * - rides-with partner is assigned to the unit
 * - name match on assigned_driver (legacy)
 * Returns null for non-drivers (no restriction).
 *
 * Fuel logging uses scope=fleet instead so helpers can pick another van
 * when the usual driver is off.
 */
export async function getDriverVehicleIds(
  db: D1Database,
  user: PublicUser
): Promise<number[] | null> {
  if (user.role !== "driver") return null;

  const names: string[] = [];
  if (user.display_name?.trim()) names.push(normName(user.display_name));
  if (user.username?.trim()) names.push(normName(user.username));

  const empIds = new Set<number>();
  if (user.employee_id) {
    empIds.add(user.employee_id);
    try {
      const emp = await db
        .prepare(
          `SELECT id, name, rides_with_employee_id FROM employees WHERE id = ? AND active = 1`
        )
        .bind(user.employee_id)
        .first<{ id: number; name: string; rides_with_employee_id: number | null }>();
      if (emp?.name) names.push(normName(emp.name));
      if (emp?.rides_with_employee_id) empIds.add(emp.rides_with_employee_id);
      // Also: people who list me as rides_with
      const partners = await db
        .prepare(
          `SELECT id, name FROM employees WHERE active = 1 AND rides_with_employee_id = ?`
        )
        .bind(user.employee_id)
        .all<{ id: number; name: string }>();
      for (const p of partners.results || []) {
        empIds.add(p.id);
        if (p.name) names.push(normName(p.name));
      }
      // Partner's name for assigned_driver text match
      if (emp?.rides_with_employee_id) {
        const partner = await db
          .prepare(`SELECT name FROM employees WHERE id = ?`)
          .bind(emp.rides_with_employee_id)
          .first<{ name: string }>();
        if (partner?.name) names.push(normName(partner.name));
      }
    } catch {
      /* rides_with column optional until migration 036 */
      try {
        const emp = await db
          .prepare("SELECT name FROM employees WHERE id = ?")
          .bind(user.employee_id)
          .first<{ name: string }>();
        if (emp?.name) names.push(normName(emp.name));
      } catch {
        /* ignore */
      }
    }
  }

  const idSet = new Set<number>();

  // Explicit employee / helper assignment on vehicle
  if (empIds.size) {
    try {
      const ph = [...empIds].map(() => "?").join(",");
      const byEmp = await db
        .prepare(
          `SELECT id FROM vehicles WHERE status != 'retired' AND (
             assigned_employee_id IN (${ph}) OR helper_employee_id IN (${ph})
           )`
        )
        .bind(...empIds, ...empIds)
        .all<{ id: number }>();
      for (const r of byEmp.results || []) idSet.add(r.id);
    } catch {
      /* columns may be missing pre-036 */
    }
  }

  if (names.length) {
    const rows = await db
      .prepare(
        `SELECT id, assigned_driver FROM vehicles WHERE status != 'retired' AND assigned_driver IS NOT NULL`
      )
      .all<{ id: number; assigned_driver: string }>();

    for (const v of rows.results || []) {
      const ad = normName(v.assigned_driver || "");
      if (!ad) continue;
      const hit = names.some((n) => n && (ad === n || ad.includes(n) || n.includes(ad)));
      if (hit) idSet.add(v.id);
    }
  }

  return [...idSet];
}

/**
 * SQL fragment: AND col IN (?,?,?) — empty ids become AND 0 (no rows).
 * D1 allows max 100 bound parameters per query — keep IN lists well under that.
 */
export function sqlInIds(
  column: string,
  ids: number[],
  /** Soft cap; callers that need more must chunk with runInChunks. */
  maxIds = 80
): { clause: string; binds: number[] } {
  if (!ids.length) return { clause: ` AND 0`, binds: [] };
  const capped = ids.length > maxIds ? ids.slice(0, maxIds) : ids;
  const placeholders = capped.map(() => "?").join(",");
  return { clause: ` AND ${column} IN (${placeholders})`, binds: capped };
}

/** Run an async fn over id chunks (D1 max ~100 binds/query). */
export async function forIdChunks<T>(
  ids: number[],
  chunkSize: number,
  fn: (chunk: number[]) => Promise<T[]>
): Promise<T[]> {
  if (!ids.length) return [];
  const size = Math.max(1, Math.min(chunkSize, 80));
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) {
    const part = await fn(ids.slice(i, i + size));
    out.push(...part);
  }
  return out;
}

export function assertDriverVehicleAccess(
  vehicleIds: number[] | null,
  vehicleId: number
): boolean {
  if (vehicleIds === null) return true; // not a driver
  return vehicleIds.includes(vehicleId);
}

/** Per-isolate: skip DB bootstrap work after first successful pass (speeds every API call). */
let bootstrapDoneInIsolate = false;

export async function ensureBootstrapAdmin(env: Env): Promise<void> {
  if (bootstrapDoneInIsolate) return;
  const count = await env.DB.prepare("SELECT COUNT(*) as c FROM users").first<{ c: number }>();
  if ((count?.c ?? 0) > 0) {
    // Fix seed placeholder hashes if present
    const seedUsers = await env.DB.prepare(
      "SELECT id, username FROM users WHERE password_hash = 'seed-will-be-replaced-on-bootstrap'"
    ).all<{ id: number; username: string }>();
    for (const u of seedUsers.results || []) {
      const { hash, salt } = await hashPassword("ChangeMe123!");
      await env.DB.prepare(
        "UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(hash, salt, u.id)
        .run();
    }
    bootstrapDoneInIsolate = true;
    return;
  }

  const { hash, salt } = await hashPassword("ChangeMe123!");
  await env.DB.prepare(
    `INSERT INTO users (email, username, display_name, password_hash, password_salt, role, auth_provider, active, must_change_password)
     VALUES (?, ?, ?, ?, ?, 'admin', 'password', 1, 1)`
  )
    .bind("admin@example.com", "admin", "Fleet Admin", hash, salt)
    .run();

  const mech = await hashPassword("ChangeMe123!");
  await env.DB.prepare(
    `INSERT INTO users (email, username, display_name, password_hash, password_salt, role, auth_provider, active, must_change_password)
     VALUES (?, ?, ?, ?, ?, 'mechanic', 'password', 1, 1)`
  )
    .bind("mechanic@example.com", "mechanic", "Fleet Mechanic", mech.hash, mech.salt)
    .run();
  bootstrapDoneInIsolate = true;
}

export function googleConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function isGoogleEmailAllowed(env: Env, email: string): boolean {
  const domain = (env.WORKSPACE_DOMAIN || "").toLowerCase().replace(/^@/, "");
  const extra = (env.GOOGLE_ALLOWED_EXTRA || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const lower = email.toLowerCase();
  if (extra.includes(lower)) return true;
  if (!domain) {
    // If no domain configured, allow any Google account in dev
    return true;
  }
  return lower.endsWith(`@${domain}`);
}


/** True admin account (not warehouse-as-office, not role-preview). */
export function isTrueAdminUser(u: Pick<PublicUser, "role" | "is_warehouse"> | UserRow | null | undefined): boolean {
  if (!u) return false;
  const role = u.role;
  const isWh = Boolean((u as PublicUser).is_warehouse) || Boolean((u as UserRow).is_warehouse);
  return role === "admin" && !isWh;
}

export type SessionAuth = {
  token: string;
  realUser: UserRow;
  effectiveUser: UserRow;
  viewAsUserId: number | null;
};

/**
 * Resolve session with optional admin view-as.
 * Real identity stays sessions.user_id; UX identity is view_as_user_id when set.
 */
export async function resolveSessionAuth(
  db: D1Database,
  token: string | null
): Promise<SessionAuth | null> {
  if (!token) return null;

  type SessRow = UserRow & { view_as_user_id?: number | null };
  let row: SessRow | null = null;
  try {
    row =
      (await db
        .prepare(
          `SELECT u.*, s.view_as_user_id as view_as_user_id
           FROM sessions s
           JOIN users u ON u.id = s.user_id
           WHERE s.id = ? AND s.expires_at > datetime('now') AND u.active = 1`
        )
        .bind(token)
        .first<SessRow>()) ?? null;
  } catch {
    // Pre-migration 086: no view_as_user_id column
    const u = await getUserFromSession(db, token);
    if (!u) return null;
    return { token, realUser: u, effectiveUser: u, viewAsUserId: null };
  }
  if (!row) return null;

  const viewAsId =
    row.view_as_user_id != null && Number(row.view_as_user_id) > 0
      ? Number(row.view_as_user_id)
      : null;

  // Strip session-only field from user row shape
  const { view_as_user_id: _ignored, ...realUser } = row as SessRow;
  void _ignored;

  if (!viewAsId || !isTrueAdminUser(realUser)) {
    if (viewAsId && !isTrueAdminUser(realUser)) {
      // Non-admin somehow has view_as set — clear it
      try {
        await db
          .prepare("UPDATE sessions SET view_as_user_id = NULL WHERE id = ?")
          .bind(token)
          .run();
      } catch {
        /* ignore */
      }
    }
    return {
      token,
      realUser: realUser as UserRow,
      effectiveUser: realUser as UserRow,
      viewAsUserId: null,
    };
  }

  const target = await db
    .prepare("SELECT * FROM users WHERE id = ? AND active = 1")
    .bind(viewAsId)
    .first<UserRow>();
  if (!target) {
    try {
      await db
        .prepare("UPDATE sessions SET view_as_user_id = NULL WHERE id = ?")
        .bind(token)
        .run();
    } catch {
      /* ignore */
    }
    return {
      token,
      realUser: realUser as UserRow,
      effectiveUser: realUser as UserRow,
      viewAsUserId: null,
    };
  }

  return {
    token,
    realUser: realUser as UserRow,
    effectiveUser: target,
    viewAsUserId: viewAsId,
  };
}

export async function setSessionViewAs(
  db: D1Database,
  token: string,
  viewAsUserId: number | null
): Promise<void> {
  await db
    .prepare("UPDATE sessions SET view_as_user_id = ? WHERE id = ?")
    .bind(viewAsUserId, token)
    .run();
}

export async function endOpenViewAsAudit(
  db: D1Database,
  adminUserId: number,
  targetUserId?: number | null
): Promise<void> {
  try {
    if (targetUserId != null) {
      await db
        .prepare(
          `UPDATE view_as_audit
           SET ended_at = datetime('now')
           WHERE admin_user_id = ? AND target_user_id = ? AND ended_at IS NULL`
        )
        .bind(adminUserId, targetUserId)
        .run();
    } else {
      await db
        .prepare(
          `UPDATE view_as_audit
           SET ended_at = datetime('now')
           WHERE admin_user_id = ? AND ended_at IS NULL`
        )
        .bind(adminUserId)
        .run();
    }
  } catch {
    /* table may not exist yet */
  }
}

export async function startViewAsAudit(
  db: D1Database,
  admin: PublicUser,
  target: PublicUser
): Promise<void> {
  try {
    await endOpenViewAsAudit(db, admin.id);
    await db
      .prepare(
        `INSERT INTO view_as_audit (admin_user_id, admin_display, target_user_id, target_display)
         VALUES (?, ?, ?, ?)`
      )
      .bind(admin.id, admin.display_name, target.id, target.display_name)
      .run();
  } catch {
    /* table may not exist yet */
  }
}
