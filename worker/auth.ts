import type { Context } from "hono";
import type { Env, PublicUser, Role, UserRow } from "./types";

const SESSION_COOKIE = "fleet_session";
const SESSION_DAYS = 14;

/** Map DB row → public user. Warehouse is stored as office + is_warehouse=1 (CHECK on role). */
export function toPublicUser(u: UserRow): PublicUser {
  const isWh = Boolean(u.is_warehouse) || u.role === "warehouse";
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    display_name: u.display_name,
    role: isWh ? "warehouse" : u.role,
    is_warehouse: isWh,
    employee_id: u.employee_id,
    phone: u.phone ?? null,
    must_change_password: Boolean(u.must_change_password),
  };
}

/** Persist role for users table (CHECK allows admin|office|driver|mechanic|viewer only). */
export function dbRoleFor(role: Role): { role: Role; is_warehouse: number } {
  if (role === "warehouse") return { role: "office", is_warehouse: 1 };
  return { role, is_warehouse: 0 };
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
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  return {
    hash: bufToHex(bits),
    salt: saltHex ?? bufToHex(salt.buffer),
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

export const ROLE_PERMS = {
  manageUsers: ["admin"] as Role[],
  manageEmployees: ["admin", "office"] as Role[],
  manageVehicles: ["admin", "office", "mechanic"] as Role[],
  /** Registration stickers + insurance dates (office, shop, admin — not field drivers). */
  manageVehicleCompliance: ["admin", "office", "mechanic"] as Role[],
  /** Any staff can log a fuel receipt photo (warehouse / shop included). */
  logFuel: ["admin", "office", "driver", "mechanic", "warehouse"] as Role[],
  editAnyFuel: ["admin", "office"] as Role[],
  viewFuel: ["admin", "office", "driver", "mechanic", "warehouse", "viewer"] as Role[],
  /** Company-card parts receipts (invoice / packing slip photos) */
  logPartsPurchase: ["admin", "office", "driver", "mechanic", "warehouse"] as Role[],
  viewPartsPurchase: ["admin", "office", "driver", "mechanic", "warehouse", "viewer"] as Role[],
  /** Read mileage flags + tracking health (viewers browse-only) */
  viewAlerts: ["admin", "office", "mechanic", "viewer"] as Role[],
  /** Ack / dismiss flags — admin, office, mechanic (shop eyes) */
  manageAlerts: ["admin", "office", "mechanic"] as Role[],
  reportIssues: ["admin", "office", "driver", "mechanic"] as Role[],
  manageIssues: ["admin", "mechanic", "office"] as Role[],
  /** Audit trail: admin + viewer (browse only; mutations still admin-only) */
  viewAudit: ["admin", "viewer"] as Role[],
  viewReports: ["admin", "office", "mechanic", "viewer", "warehouse"] as Role[],
  manageSettings: ["admin"] as Role[],
  /** Read company settings / people lists without write (viewer explores app) */
  browseAdmin: ["admin", "viewer"] as Role[],
  /**
   * Inventory
   * - view: admin, office, warehouse, viewer (techs do not browse full catalog)
   * - manage: issue/receive, transfers, import (admin + warehouse; office view-only helpers)
   * - levels: min/max only admin + warehouse
   */
  viewInventory: ["admin", "office", "warehouse", "viewer"] as Role[],
  manageInventory: ["admin", "warehouse"] as Role[],
  manageInventoryLevels: ["admin", "warehouse"] as Role[],
  /**
   * Company assets (bottles, ladders, tools) — outside pricebook
   * - view: warehouse/office/admin/viewer full; field + mechanic can see (field scoped in routes)
   * - manage: warehouse + admin only
   */
  viewCompanyAssets: ["admin", "office", "warehouse", "driver", "mechanic", "viewer"] as Role[],
  manageCompanyAssets: ["admin", "warehouse"] as Role[],
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

/** SQL fragment: AND col IN (?,?,?) — empty ids become AND 0 (no rows). */
export function sqlInIds(
  column: string,
  ids: number[]
): { clause: string; binds: number[] } {
  if (!ids.length) return { clause: ` AND 0`, binds: [] };
  const placeholders = ids.map(() => "?").join(",");
  return { clause: ` AND ${column} IN (${placeholders})`, binds: ids };
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
        "UPDATE users SET password_hash = ?, password_salt = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(hash, salt, u.id)
        .run();
    }
    bootstrapDoneInIsolate = true;
    return;
  }

  const { hash, salt } = await hashPassword("ChangeMe123!");
  await env.DB.prepare(
    `INSERT INTO users (email, username, display_name, password_hash, password_salt, role, auth_provider, active)
     VALUES (?, ?, ?, ?, ?, 'admin', 'password', 1)`
  )
    .bind("admin@example.com", "admin", "Fleet Admin", hash, salt)
    .run();

  const mech = await hashPassword("ChangeMe123!");
  await env.DB.prepare(
    `INSERT INTO users (email, username, display_name, password_hash, password_salt, role, auth_provider, active)
     VALUES (?, ?, ?, ?, ?, 'mechanic', 'password', 1)`
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
