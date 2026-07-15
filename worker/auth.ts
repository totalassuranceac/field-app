import type { Context } from "hono";
import type { Env, PublicUser, Role, UserRow } from "./types";

const SESSION_COOKIE = "fleet_session";
const SESSION_DAYS = 14;

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    display_name: u.display_name,
    role: u.role,
    employee_id: u.employee_id,
  };
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

export function roleAtLeast(role: Role, allowed: Role[]): boolean {
  return allowed.includes(role);
}

export const ROLE_PERMS = {
  manageUsers: ["admin"] as Role[],
  manageEmployees: ["admin", "office"] as Role[],
  manageVehicles: ["admin", "office", "mechanic"] as Role[],
  logFuel: ["admin", "office", "driver"] as Role[],
  editAnyFuel: ["admin", "office"] as Role[],
  viewFuel: ["admin", "office", "driver", "mechanic", "viewer"] as Role[],
  manageAlerts: ["admin", "office"] as Role[],
  reportIssues: ["admin", "office", "driver", "mechanic"] as Role[],
  manageIssues: ["admin", "mechanic", "office"] as Role[],
  viewAudit: ["admin"] as Role[],
  viewReports: ["admin", "office", "mechanic", "viewer"] as Role[],
  manageSettings: ["admin"] as Role[],
};

export async function ensureBootstrapAdmin(env: Env): Promise<void> {
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
