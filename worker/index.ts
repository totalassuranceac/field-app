import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  assertDriverVehicleAccess,
  clearSessionCookie,
  createSession,
  destroySession,
  ensureBootstrapAdmin,
  getDriverHomeVehicleIds,
  getDriverVehicleIds,
  getSessionToken,
  getUserFromSession,
  googleConfigured,
  hashPassword,
  isGoogleEmailAllowed,
  ROLE_PERMS,
  roleAtLeast,
  randomToken,
  sessionCookie,
  sqlInIds,
  toPublicUser,
  dbRoleFor,
  verifyPassword,
} from "./auth";
import { getSetting, setSetting, writeAudit } from "./audit";
import { evaluateMileageAlerts, insertAlerts } from "./redflags";
import { getLivePositions } from "./gps";
import { computeTrackingHealth, type VehicleTrackRow } from "./trackingHealth";
import { catalogEntry } from "./issueCatalog";
import {
  ensureOilChangeScheduled,
  markNotificationRead,
  coreFleetNotifyIds,
  notifyAndSms,
  notifyOpsActionItems,
  notifyShopBringInsToday,
  notifyUsers,
  notifyWeeklyChecksDue,
  shortSms,
  userIdsForEmployees,
  userIdsForIssue,
  usersByRoles,
} from "./notifications";
import {
  applyTwilioStatusToLog,
  fetchTwilioMessageStatus,
  logSms,
  normalizePhone,
  sendSms,
  smsConfigured,
} from "./sms";
import { alertFleetIncident } from "./alertChannels";
import { getOcrHints, recordOcrFeedback, type OcrFieldSnapshot } from "./ocrLearn";
import {
  applyDueAnniversariesAll,
  applyDueAnniversary,
  applyLeaveOrRehireTransition,
  boardRowFrom,
  completedYearsOfService,
  deductForApprovedRequest,
  ensurePtoTables,
  hoursForDateRange,
  lastAnniversary,
  localIsoDate as ptoLocalIsoDate,
  normalizeBirthdayMd,
  parseFlexibleDate,
  PTO_REHIRE_BREAK_DAYS,
  upcomingRecognition,
  writePtoLedger,
  type EmployeePtoProfile,
  type PtoKind,
} from "./pto";
import {
  adjustStockQty,
  ensureStockLocations,
  ensureVehicleStockLocation,
  setPartTruckStock,
  importParts,
  setStockQty,
  transferStock,
  updatePartLevels,
  updateLocationLevels,
  lowStockReport,
  suggestedOrderQty,
  upsertPartVendor,
  deletePartVendor,
  applyDefaultVendor,
  createWarehouseSection,
  deactivateWarehouseSection,
  softDeletePart,
  type PartImportRow,
} from "./inventory";
import {
  ensureCompanyAssets,
  bottleSummary,
  setBottleCounts,
  adjustBottleCounts,
  swapBottles,
  listBottleEvents,
  listAssets,
  getAsset,
  createAsset,
  updateAssetMeta,
  issueAsset,
  returnAsset,
  transferAsset,
  updateAssetCondition,
  truckAssetsBundle,
  isValidCondition,
  type AssetCategory,
  type AssetCondition,
} from "./assets";
import {
  loadStCredentials,
  stConfigured,
  testStConnection,
  syncAllPartImages,
  syncMaterialImageToPart,
  downloadStPricebookImage,
  createStMaterial,
  deactivateStMaterial,
  applyStUsageDeductions,
} from "./servicetitan";
import type { Env, PublicUser, Role, UserRow, Variables } from "./types";
import {
  ledgerBalanceForUserId,
  policyWeeklyDeduction,
  registerToolLoanLedger,
  toPayFriday,
} from "./toolLoanLedger";
import { suggestTankCapacity } from "./tankCapacity";

/**
 * D1 BLOB columns sometimes arrive as ArrayBuffer, Uint8Array, number[],
 * or (rarely) base64 / comma-joined text. Passing a plain number[] to
 * `new Response(...)` stringifies to "137,80,78,71,..." which browsers
 * reject as a broken image — that was killing every inventory thumbnail.
 */
function blobToUint8Array(data: unknown): Uint8Array | null {
  if (data == null) return null;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data.map((n) => Number(n) & 0xff));
  }
  if (typeof data === "string") {
    const s = data.trim();
    if (!s) return null;
    // Accidental number-list serialization
    if (/^\d+(\s*,\s*\d+)+$/.test(s.slice(0, 200)) && s.includes(",")) {
      return new Uint8Array(s.split(",").map((n) => Number(n.trim()) & 0xff));
    }
    // Base64 (with or without data: prefix)
    try {
      const b64 = s.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
      const bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  // D1 sometimes returns { 0: n, 1: n, ... length } style objects
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (typeof o.length === "number" && o.length > 0 && typeof o[0] === "number") {
      const out = new Uint8Array(o.length as number);
      for (let i = 0; i < out.length; i++) out[i] = Number(o[i]) & 0xff;
      return out;
    }
  }
  return null;
}

function imageResponse(
  data: unknown,
  contentType: string,
  cacheControl = "private, max-age=86400"
): Response {
  const bytes = blobToUint8Array(data);
  if (!bytes || bytes.byteLength < 8) {
    return new Response(JSON.stringify({ error: "Image data empty" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Copy into a fresh ArrayBuffer-backed view (avoids SharedArrayBuffer issues)
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Response(copy, {
    headers: {
      "Content-Type": contentType || "image/jpeg",
      "Cache-Control": cacheControl,
      "Content-Length": String(copy.byteLength),
    },
  });
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/api/*", cors({ origin: (o) => o || "*", credentials: true }));

app.use("/api/*", async (c, next) => {
  // Auth/health must stay instant — never run bootstrap work on the hot path
  const p = new URL(c.req.url).pathname;
  if (
    p === "/api/health" ||
    p === "/api/auth/me" ||
    p === "/api/auth/login" ||
    p.startsWith("/api/auth/invite") ||
    p.startsWith("/api/auth/google")
  ) {
    await next();
    return;
  }
  // Never block API if bootstrap/DB is slow (isolate cache makes this near-free after first hit)
  try {
    await Promise.race([
      ensureBootstrapAdmin(c.env),
      new Promise<void>((resolve) => setTimeout(resolve, 800)),
    ]);
  } catch {
    // DB may not be migrated yet
  }
  await next();
});

function isSecure(c: { req: { url: string } }): boolean {
  return new URL(c.req.url).protocol === "https:";
}

/**
 * Keep a promise alive after the HTTP response is sent.
 * Fire-and-forget (void p) is killed by Cloudflare when the response finishes.
 */
function scheduleWaitUntil(
  c: { executionCtx: { waitUntil: (p: Promise<unknown>) => void } },
  task: Promise<unknown>
): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // Local/dev without ExecutionContext — best effort only
    void task;
  }
}

function requireRoles(roles: Role[]) {
  return async (
    c: {
      get: (k: "user") => PublicUser;
      json: (b: unknown, s?: number) => Response;
    },
    next: () => Promise<void>
  ) => {
    const user = c.get("user");
    if (!roleAtLeast(user.role, roles)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

// ---------- Auth ----------
app.get("/api/health", (c) =>
  c.json({
    ok: true,
    app: c.env.APP_NAME || "Field App",
    google: googleConfigured(c.env),
  })
);

app.get("/api/auth/me", async (c) => {
  const token = getSessionToken(c);
  const user = await getUserFromSession(c.env.DB, token);
  if (!user) return c.json({ user: null });
  return c.json({ user: toPublicUser(user), googleEnabled: googleConfigured(c.env) });
});

const FAVORITE_PATH_ALLOW = new Set([
  "/vehicles",
  "/live",
  "/yard",
  "/fuel",
  "/fuel/receipt-review",
  "/inspections",
  "/alerts",
  "/downtime",
  "/reports",
  "/inventory",
  "/part-pickup",
  "/parts-dropoff",
  "/parts-runs",
  "/truck-stock",
  "/parts-receipts",
  "/dump-runs",
  "/assets",
  "/warranties",
  "/issues",
  "/service",
  "/parts-orders",
  "/admin",
  "/warehouse-cameras",
  "/time-off",
  "/tool-loans",
  "/tool-loan-ledger",
  "/onboarding",
  "/termination",
  "/feedback",
  "/howto",
  "/handbook",
  "/notifications",
  "/tv",
  "/settings",
]);

function normalizeFavPath(path: string): string {
  let p = String(path || "")
    .split("?")[0]
    .split("#")[0]
    .trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function sanitizeFavoritePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const p = normalizeFavPath(String(raw || ""));
    if (!p || !FAVORITE_PATH_ALLOW.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= 16) break;
  }
  return out;
}

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>();
  // Usernames/emails are case-insensitive; only the password is case-sensitive
  const username = (body.username || "").trim().toLowerCase();
  const password = body.password || "";
  if (!username || !password) return c.json({ error: "Username and password required" }, 400);

  const user = await c.env.DB.prepare(
    `SELECT * FROM users
     WHERE active = 1
       AND (
         lower(trim(COALESCE(username, ''))) = ?
         OR lower(trim(COALESCE(email, ''))) = ?
       )`
  )
    .bind(username, username)
    .first<UserRow>();

  if (!user || !user.password_hash || !user.password_salt) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
  // Password remains case-sensitive (verifyPassword uses raw password)
  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) return c.json({ error: "Invalid credentials" }, 401);

  const token = await createSession(c.env.DB, user.id);
  const pub = toPublicUser(user);
  await writeAudit(c.env.DB, pub, "login", "user", user.id, "Password login");
  c.header("Set-Cookie", sessionCookie(token, 14 * 24 * 3600, isSecure(c)));
  return c.json({ user: pub });
});

app.post("/api/auth/logout", async (c) => {
  const token = getSessionToken(c);
  const user = await getUserFromSession(c.env.DB, token);
  await destroySession(c.env.DB, token);
  if (user) {
    await writeAudit(c.env.DB, toPublicUser(user), "logout", "user", user.id, "Logged out");
  }
  c.header("Set-Cookie", clearSessionCookie(isSecure(c)));
  return c.json({ ok: true });
});

/** Build a one-time join link for a user (invite / password setup). */
async function issueInviteToken(
  db: D1Database,
  opts: { userId: number; username: string; createdByUserId?: number | null }
): Promise<{ token: string; expires_at: string; invite_path: string }> {
  const token = randomToken(24);
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  // Invalidate prior unused invites for this user
  try {
    await db
      .prepare(
        `UPDATE invite_tokens SET used_at = datetime('now')
         WHERE user_id = ? AND used_at IS NULL`
      )
      .bind(opts.userId)
      .run();
  } catch {
    /* table may not exist yet */
  }
  await db
    .prepare(
      `INSERT INTO invite_tokens (id, user_id, username, expires_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?)`
    )
    .bind(
      token,
      opts.userId,
      opts.username.trim().toLowerCase(),
      expires,
      opts.createdByUserId ?? null
    )
    .run();
  return {
    token,
    expires_at: expires,
    invite_path: `/join/${token}`,
  };
}

/** Public: load invite details for the join page (no auth). */
app.get("/api/auth/invite/:token", async (c) => {
  const token = c.req.param("token")?.trim();
  if (!token) return c.json({ error: "Invalid invite" }, 400);
  try {
    const row = await c.env.DB.prepare(
      `SELECT t.id, t.username, t.expires_at, t.used_at, t.user_id,
              u.display_name, u.active, u.must_change_password
       FROM invite_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`
    )
      .bind(token)
      .first<{
        id: string;
        username: string;
        expires_at: string;
        used_at: string | null;
        user_id: number;
        display_name: string;
        active: number;
        must_change_password: number;
      }>();
    if (!row || !row.active) {
      return c.json({ error: "This invite link is not valid." }, 404);
    }
    if (row.used_at) {
      return c.json({ error: "This invite was already used. Sign in with your password." }, 410);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.json({ error: "This invite has expired. Ask your admin for a new link." }, 410);
    }
    return c.json({
      ok: true,
      username: row.username,
      display_name: row.display_name,
      expires_at: row.expires_at,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Invite system not ready. Run migration 030_invite_tokens.sql" }, 503);
    }
    return c.json({ error: "Could not load invite" }, 500);
  }
});

/**
 * Public: finish invite — confirm username admin gave them, set password, log in.
 */
app.post("/api/auth/invite/complete", async (c) => {
  const body = await c.req.json<{
    token?: string;
    username?: string;
    password?: string;
  }>();
  const token = (body.token || "").trim();
  const username = (body.username || "").trim().toLowerCase();
  const password = body.password || "";
  if (!token || !username || !password) {
    return c.json({ error: "Username and new password are required" }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  try {
    const row = await c.env.DB.prepare(
      `SELECT t.id, t.username, t.expires_at, t.used_at, t.user_id, u.active
       FROM invite_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.id = ?`
    )
      .bind(token)
      .first<{
        id: string;
        username: string;
        expires_at: string;
        used_at: string | null;
        user_id: number;
        active: number;
      }>();
    if (!row || !row.active) {
      return c.json({ error: "This invite link is not valid." }, 404);
    }
    if (row.used_at) {
      return c.json({ error: "This invite was already used. Sign in with your password." }, 410);
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      return c.json({ error: "This invite has expired. Ask your admin for a new link." }, 410);
    }
    if (username !== String(row.username || "").trim().toLowerCase()) {
      return c.json(
        {
          error:
            "Username does not match. Use the username your admin gave you (capitalization does not matter).",
        },
        400
      );
    }

    const p = await hashPassword(password);
    await c.env.DB.prepare(
      `UPDATE users SET
         password_hash = ?, password_salt = ?, must_change_password = 0,
         auth_provider = CASE WHEN auth_provider = 'google' THEN 'both' ELSE 'password' END,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(p.hash, p.salt, row.user_id)
      .run();
    await c.env.DB.prepare(
      `UPDATE invite_tokens SET used_at = datetime('now') WHERE id = ?`
    )
      .bind(token)
      .run();
    // Invalidate any other open invites for this user
    await c.env.DB.prepare(
      `UPDATE invite_tokens SET used_at = datetime('now')
       WHERE user_id = ? AND used_at IS NULL AND id != ?`
    )
      .bind(row.user_id, token)
      .run();

    const session = await createSession(c.env.DB, row.user_id);
    const full = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`)
      .bind(row.user_id)
      .first<UserRow>();
    const pub = toPublicUser(full!);
    await writeAudit(c.env.DB, pub, "login", "user", row.user_id, "Joined via invite link");
    c.header("Set-Cookie", sessionCookie(session, 14 * 24 * 3600, isSecure(c)));
    return c.json({ ok: true, user: pub });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Invite system not ready. Run migration 030." }, 503);
    }
    return c.json({ error: msg.slice(0, 160) }, 500);
  }
});


app.get("/api/auth/google", async (c) => {
  if (!googleConfigured(c.env)) {
    return c.json({ error: "Google OAuth is not configured" }, 400);
  }
  const base = c.env.APP_BASE_URL || new URL(c.req.url).origin;
  const redirectUri = `${base}/api/auth/google/callback`;
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    access_type: "online",
    prompt: "select_account",
    state,
  });
  c.header(
    "Set-Cookie",
    `fleet_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${isSecure(c) ? "; Secure" : ""}`
  );
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get("/api/auth/google/callback", async (c) => {
  if (!googleConfigured(c.env)) return c.text("Google OAuth not configured", 400);
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = c.req.header("Cookie") || "";
  const stateMatch = cookie.match(/(?:^|;\s*)fleet_oauth_state=([^;]+)/);
  if (!code || !state || !stateMatch || stateMatch[1] !== state) {
    return c.text("Invalid OAuth state", 400);
  }

  const base = c.env.APP_BASE_URL || url.origin;
  const redirectUri = `${base}/api/auth/google/callback`;
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) return c.text("Token exchange failed", 400);
  const tokens = (await tokenRes.json()) as { access_token: string };
  const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileRes.ok) return c.text("Failed to load Google profile", 400);
  const profile = (await profileRes.json()) as {
    sub: string;
    email: string;
    name?: string;
    email_verified?: boolean;
  };

  if (!profile.email || profile.email_verified === false) {
    return c.text("Google email not verified", 400);
  }
  if (!isGoogleEmailAllowed(c.env, profile.email)) {
    return c.text("Your Google account is not allowed for this organization", 403);
  }

  let user = await c.env.DB.prepare("SELECT * FROM users WHERE google_sub = ? OR email = ?")
    .bind(profile.sub, profile.email)
    .first<UserRow>();

  if (!user) {
    // First Google login for this email: create driver unless no users (bootstrap already ran)
    const result = await c.env.DB.prepare(
      `INSERT INTO users (email, display_name, role, auth_provider, google_sub, active)
       VALUES (?, ?, 'driver', 'google', ?, 1)`
    )
      .bind(profile.email, profile.name || profile.email, profile.sub)
      .run();
    user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
      .bind(result.meta.last_row_id)
      .first<UserRow>();
  } else {
    await c.env.DB.prepare(
      `UPDATE users SET google_sub = ?, email = COALESCE(email, ?),
       auth_provider = CASE WHEN password_hash IS NOT NULL THEN 'both' ELSE 'google' END,
       updated_at = datetime('now') WHERE id = ?`
    )
      .bind(profile.sub, profile.email, user.id)
      .run();
    user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first<UserRow>();
  }

  if (!user || !user.active) return c.text("Account inactive", 403);

  const session = await createSession(c.env.DB, user.id);
  const pub = toPublicUser(user);
  await writeAudit(c.env.DB, pub, "login", "user", user.id, "Google login");

  const headers = new Headers();
  headers.append("Set-Cookie", sessionCookie(session, 14 * 24 * 3600, isSecure(c)));
  headers.append(
    "Set-Cookie",
    `fleet_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isSecure(c) ? "; Secure" : ""}`
  );
  headers.set("Location", "/");
  return new Response(null, { status: 302, headers });
});

// ---------- Protected API ----------
const api = new Hono<{ Bindings: Env; Variables: Variables }>();
api.use("*", async (c, next) => {
  const token = getSessionToken(c);
  const user = await getUserFromSession(c.env.DB, token);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const pub = toPublicUser(user);
  c.set("user", pub);

  // Viewer = same browse surface as admin, but never mutate (except own password)
  if (pub.role === "viewer") {
    const method = c.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const path = new URL(c.req.url).pathname;
      const allowed =
        path.includes("/auth/change-password") ||
        path.includes("/auth/logout") ||
        path.endsWith("/auth/change-password") ||
        path.includes("/me/favorites");
      if (!allowed) {
        return c.json(
          {
            error:
              "Viewer accounts are look-around only. You can explore the app but not save changes.",
          },
          403
        );
      }
    }
  }

  await next();
});

api.get("/me/favorites", async (c) => {
  const user = c.get("user");
  try {
    const rows = await c.env.DB.prepare(
      `SELECT path, sort_order FROM user_favorites
       WHERE user_id = ?
       ORDER BY sort_order ASC, path ASC`
    )
      .bind(user.id)
      .all<{ path: string; sort_order: number }>();
    return c.json({
      favorites: (rows.results || []).map((r) => ({
        path: normalizeFavPath(r.path),
        sort_order: Number(r.sort_order) || 0,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ favorites: [] });
    return c.json({ error: msg }, 500);
  }
});

api.put("/me/favorites", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ paths?: string[] }>().catch(() => ({} as { paths?: string[] }));
  const paths = sanitizeFavoritePaths(body.paths);
  try {
    await c.env.DB.prepare(`DELETE FROM user_favorites WHERE user_id = ?`).bind(user.id).run();
    let i = 0;
    for (const path of paths) {
      await c.env.DB.prepare(
        `INSERT INTO user_favorites (user_id, path, sort_order) VALUES (?, ?, ?)`
      )
        .bind(user.id, path, i++)
        .run();
    }
    return c.json({ ok: true, favorites: paths.map((path, sort_order) => ({ path, sort_order })) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 075_user_favorites.sql" }, 500);
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/me/favorites", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ path?: string }>().catch(() => ({} as { path?: string }));
  const path = normalizeFavPath(body.path || "");
  if (!path || !FAVORITE_PATH_ALLOW.has(path)) {
    return c.json({ error: "Invalid path" }, 400);
  }
  try {
    const count = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM user_favorites WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ c: number }>();
    if ((count?.c ?? 0) >= 16) {
      return c.json({ error: "Maximum 16 stars" }, 400);
    }
    const maxOrd = await c.env.DB.prepare(
      `SELECT COALESCE(MAX(sort_order), -1) as m FROM user_favorites WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{ m: number }>();
    await c.env.DB.prepare(
      `INSERT INTO user_favorites (user_id, path, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(user_id, path) DO NOTHING`
    )
      .bind(user.id, path, (maxOrd?.m ?? -1) + 1)
      .run();
    return c.json({ ok: true, path });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 075_user_favorites.sql" }, 500);
    }
    return c.json({ error: msg }, 500);
  }
});

api.delete("/me/favorites", async (c) => {
  const user = c.get("user");
  const path = normalizeFavPath(c.req.query("path") || "");
  if (!path) return c.json({ error: "path required" }, 400);
  try {
    await c.env.DB.prepare(`DELETE FROM user_favorites WHERE user_id = ? AND path = ?`)
      .bind(user.id, path)
      .run();
    return c.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ ok: true });
    return c.json({ error: msg }, 500);
  }
});

/** Employee sets their own password (or finishes forced change after admin reset). */
api.post("/auth/change-password", async (c) => {
  const pub = c.get("user");
  const token = getSessionToken(c);
  const full = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(pub.id)
    .first<UserRow>();
  if (!full) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    current_password?: string;
    new_password?: string;
  }>();
  const newPw = body.new_password?.trim() || "";
  if (newPw.length < 8) {
    return c.json({ error: "New password must be at least 8 characters" }, 400);
  }

  if (!full.must_change_password) {
    if (!full.password_hash || !full.password_salt) {
      return c.json({ error: "Password login is not set up for this account" }, 400);
    }
    const current = body.current_password || "";
    if (!current) return c.json({ error: "Current password required" }, 400);
    const ok = await verifyPassword(current, full.password_hash, full.password_salt);
    if (!ok) return c.json({ error: "Current password is incorrect" }, 400);
  }

  const p = await hashPassword(newPw);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0,
     auth_provider = CASE WHEN auth_provider = 'google' THEN 'both' ELSE COALESCE(auth_provider, 'password') END,
     updated_at = datetime('now') WHERE id = ?`
  )
    .bind(p.hash, p.salt, full.id)
    .run();

  if (token) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .bind(full.id, token)
      .run();
  }

  const updated = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(full.id)
    .first<UserRow>();
  const next = toPublicUser(updated!);
  await writeAudit(c.env.DB, next, "password_change", "user", full.id, "User changed own password");
  return c.json({ user: next, ok: true });
});

/** Employee updates their own phone (for repair / weekly reminders). */
api.patch("/auth/profile", async (c) => {
  const pub = c.get("user");
  const body = await c.req.json<{ phone?: string | null }>();
  if (body.phone !== undefined) {
    const phone = body.phone?.trim() || null;
    await c.env.DB.prepare(
      "UPDATE users SET phone = ?, updated_at = datetime('now') WHERE id = ?"
    )
      .bind(phone, pub.id)
      .run();
    if (pub.employee_id) {
      await c.env.DB.prepare(
        "UPDATE employees SET phone = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(phone, pub.employee_id)
        .run();
    }
  }
  const updated = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(pub.id)
    .first<UserRow>();
  return c.json({ user: toPublicUser(updated!) });
});

// Live GPS (OneStep + Verizon) + tracking health (stale / not reporting / cam policy)
// Field drivers cannot see where others are — supervisors / warehouse / shop / office only.
api.get("/live/positions", requireRoles(ROLE_PERMS.viewLiveMap), async (c) => {
  const force = c.req.query("refresh") === "1";
  try {
    const data = await getLivePositions(c.env, force);
    const staleHours = Number(await getSetting(c.env.DB, "gps_stale_hours", "6"));
    const vrows = await c.env.DB.prepare(
      `SELECT id, unit_number, status, assigned_driver, gps_tracker, gps_status, dash_cam_status, cam_type
       FROM vehicles WHERE status != 'retired'`
    ).all<VehicleTrackRow>();
    const tracking = computeTrackingHealth(vrows.results || [], data, staleHours || 6);
    return c.json({ ...data, tracking });
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : "Failed to load GPS positions",
        fetched_at: new Date().toISOString(),
        positions: [],
        providers: {
          onestep: { ok: false, count: 0, configured: Boolean(c.env.ONESTEP_USER) },
          verizon: { ok: false, count: 0, configured: Boolean(c.env.VERIZON_USER) },
        },
        tracking: null,
      },
      500
    );
  }
});

/** Fleet tracking / equipment issues for admin & mechanic eyes */
api.get("/tracking/health", requireRoles(ROLE_PERMS.viewLiveMap), async (c) => {
  try {
    const staleHours = Number(await getSetting(c.env.DB, "gps_stale_hours", "6"));
    const data = await getLivePositions(c.env, c.req.query("refresh") === "1");
    const vrows = await c.env.DB.prepare(
      `SELECT id, unit_number, status, assigned_driver, gps_tracker, gps_status, dash_cam_status, cam_type
       FROM vehicles WHERE status != 'retired'`
    ).all<VehicleTrackRow>();
    const tracking = computeTrackingHealth(vrows.results || [], data, staleHours || 6);
    return c.json({ fetched_at: data.fetched_at, providers: data.providers, tracking });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Tracking health failed", tracking: null },
      500
    );
  }
});

api.get("/dashboard", async (c) => {
  const me = c.get("user");
  const driverVids = await getDriverVehicleIds(c.env.DB, me);
  const scope = driverVids !== null ? sqlInIds("vehicle_id", driverVids) : null;
  const vScope = driverVids !== null ? sqlInIds("v.id", driverVids) : null;
  const aScope = driverVids !== null ? sqlInIds("a.vehicle_id", driverVids) : null;

  const openAlerts = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM mileage_alerts WHERE status = 'open'${scope?.clause || ""}`
  )
    .bind(...(scope?.binds || []))
    .first<{ c: number }>();
  const openIssues = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicle_issues WHERE status IN ('open','scheduled','in_progress')${scope?.clause || ""}`
  )
    .bind(...(scope?.binds || []))
    .first<{ c: number }>();
  const soonDays = Number(await getSetting(c.env.DB, "expiring_soon_days", "30"));
  const expiring = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicles v WHERE v.status = 'active' AND (
      (v.registration_expires IS NOT NULL AND v.registration_expires <= date('now', '+' || ? || ' days')) OR
      (v.insurance_expires IS NOT NULL AND v.insurance_expires <= date('now', '+' || ? || ' days'))
    )${vScope?.clause || ""}`
  )
    .bind(String(soonDays), String(soonDays), ...(vScope?.binds || []))
    .first<{ c: number }>();

  // Weekly checks overdue (no inspection in last 7 days)
  const weeklyDue = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicles v
     WHERE v.status = 'active'
       ${vScope?.clause || ""}
       AND NOT EXISTS (
         SELECT 1 FROM inspections i
         WHERE i.vehicle_id = v.id
           AND i.inspection_date >= date('now', '-7 days')
       )`
  )
    .bind(...(vScope?.binds || []))
    .first<{ c: number }>();

  const recentFuel = await c.env.DB.prepare(
    `SELECT f.*, e.name as employee_name, v.unit_number,
            u.display_name as entered_by_name
     FROM fuel_entries f
     JOIN employees e ON e.id = f.employee_id
     JOIN vehicles v ON v.id = f.vehicle_id
     JOIN users u ON u.id = f.entered_by_user_id
     WHERE 1=1 ${scope ? scope.clause.replace("vehicle_id", "f.vehicle_id") : ""}
     ORDER BY f.created_at DESC LIMIT 8`
  )
    .bind(...(scope?.binds || []))
    .all();
  const recentAlerts = await c.env.DB.prepare(
    `SELECT a.*, v.unit_number FROM mileage_alerts a
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.status = 'open'${aScope?.clause || ""}
     ORDER BY a.created_at DESC LIMIT 8`
  )
    .bind(...(aScope?.binds || []))
    .all();

  // Personal / assigned-vehicle reminders
  const myWeekly = await c.env.DB.prepare(
    `SELECT v.id, v.unit_number, v.assigned_driver,
            (SELECT MAX(i.inspection_date) FROM inspections i WHERE i.vehicle_id = v.id) as last_check_date
     FROM vehicles v
     WHERE v.status = 'active'
       ${vScope?.clause || "AND 0"}
       AND NOT EXISTS (
         SELECT 1 FROM inspections i
         WHERE i.vehicle_id = v.id AND i.inspection_date >= date('now', '-7 days')
       )
     ORDER BY v.unit_number`
  )
    .bind(...(vScope?.binds || []))
    .all();

  const myRepairs = await c.env.DB.prepare(
    `SELECT i.id, i.title, i.status, i.scheduled_date, i.severity, v.unit_number,
            i.tech_confirm_status, i.tech_confirmed_at, i.tech_confirm_note,
            i.schedule_notes
     FROM vehicle_issues i
     JOIN vehicles v ON v.id = i.vehicle_id
     WHERE i.status IN ('scheduled', 'in_progress')
       ${scope ? scope.clause.replace("vehicle_id", "i.vehicle_id") : "AND 0"}
     ORDER BY i.scheduled_date IS NULL, i.scheduled_date, i.id DESC
     LIMIT 10`
  )
    .bind(...(scope?.binds || []))
    .all();

  // Non-drivers still get fleet-wide my_reminders empty unless we keep old name match —
  // for admin/office, personal reminders by name are less critical; leave empty when not driver
  // unless we want admin to see nothing personal — OK

  // Tracking stats: DB-only on home (never call live GPS here — it hung the whole app).
  // Live map page still loads OneStep/Verizon. Home uses vehicle gps_status columns.
  let trackingSummary: {
    not_reporting: number;
    stale_or_offline: number;
    dashcam_policy: number;
    equipment_manual: number;
    unmatched_devices: number;
    total: number;
    expected_trackers: number;
    live_matched: number;
  } | null = null;
  let trackingIssues: Array<{
    code: string;
    severity: string;
    message: string;
    unit_number: string | null;
    vehicle_id: number | null;
  }> = [];

  if (me.role !== "driver" && me.role !== "warehouse") {
    try {
      const vrows = await c.env.DB.prepare(
        `SELECT id, unit_number, status, assigned_driver, gps_tracker, gps_status, dash_cam_status, cam_type
         FROM vehicles WHERE status != 'retired'`
      ).all<VehicleTrackRow>();
      // Empty live positions — health still flags missing trackers / cam policy from DB
      const emptyLive = {
        fetched_at: new Date().toISOString(),
        positions: [] as never[],
        providers: {
          onestep: { ok: false, count: 0, configured: false },
          verizon: { ok: false, count: 0, configured: false },
        },
      };
      const th = computeTrackingHealth(vrows.results || [], emptyLive, 6);
      trackingSummary = {
        ...th.counts,
        expected_trackers: th.expected_trackers,
        live_matched: th.live_matched,
      };
      trackingIssues = th.issues.slice(0, 12).map((i) => ({
        code: i.code,
        severity: i.severity,
        message: i.message,
        unit_number: i.unit_number,
        vehicle_id: i.vehicle_id,
      }));
    } catch {
      /* optional */
    }
  }

  // Ops-wide counters (warehouse / admin bird’s-eye) — best-effort if tables missing
  let openWarranties = 0;
  let openPickups = 0;
  let assetsAttention = 0;
  let handbookPending = 0;
  let emergencies = 0;
  try {
    // Only claims that need action now (not quiet submitted-in-grace)
    openWarranties = await countWarrantyNeedsAttention(c.env.DB);
  } catch {
    /* table optional */
  }
  try {
    const p = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM part_pickups WHERE status IN ('open','ready')`
    ).first<{ c: number }>();
    openPickups = p?.c ?? 0;
  } catch {
    /* optional */
  }
  let openVendorRuns = 0;
  try {
    openVendorRuns = await countPartPickupWaiting(c.env.DB);
  } catch {
    try {
      const vr = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM vendor_run_lines WHERE status = 'waiting'`
      ).first<{ c: number }>();
      openVendorRuns = vr?.c ?? 0;
    } catch {
      /* optional */
    }
  }
  let partsDropoffsWaiting = 0;
  try {
    partsDropoffsWaiting = await countPartsDropoffWaiting(c.env.DB);
  } catch {
    /* optional */
  }
  let fuelOcrPending = 0;
  try {
    const fo = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM fuel_entries
       WHERE receipt_key IS NOT NULL AND trim(receipt_key) != ''
         AND ocr_reviewed_at IS NULL
         AND (IFNULL(ocr_needs_review, 0) = 1 OR ocr_json IS NULL)`
    ).first<{ c: number }>();
    fuelOcrPending = fo?.c ?? 0;
  } catch {
    /* optional */
  }
  let openIssuesStale = 0;
  try {
    const st = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM vehicle_issues
       WHERE status = 'open'
         AND datetime(created_at) < datetime('now', '-3 days')
         ${scope?.clause || ""}`
    )
      .bind(...(scope?.binds || []))
      .first<{ c: number }>();
    openIssuesStale = st?.c ?? 0;
  } catch {
    /* optional */
  }
  try {
    const a = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM company_assets
       WHERE active = 1 AND (
         condition IN ('poor','damaged','out_of_service')
         OR status IN ('repair','missing')
       )`
    ).first<{ c: number }>();
    assetsAttention = a?.c ?? 0;
  } catch {
    /* optional */
  }
  try {
    const book = await c.env.DB.prepare(
      `SELECT id FROM employee_handbooks WHERE active = 1 ORDER BY created_at DESC LIMIT 1`
    ).first<{ id: number }>();
    if (book) {
      const pending = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM users u
         WHERE u.active = 1
           AND NOT EXISTS (
             SELECT 1 FROM handbook_acknowledgments h
             WHERE h.handbook_id = ? AND h.user_id = u.id
           )`
      )
        .bind(book.id)
        .first<{ c: number }>();
      handbookPending = pending?.c ?? 0;
    }
  } catch {
    /* optional */
  }
  try {
    const em = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM vehicle_issues
       WHERE status IN ('open','scheduled','in_progress')
         AND (IFNULL(is_emergency,0) = 1 OR severity IN ('critical','high'))
         ${scope?.clause || ""}`
    )
      .bind(...(scope?.binds || []))
      .first<{ c: number }>();
    emergencies = em?.c ?? 0;
  } catch {
    /* optional */
  }

  return c.json({
    stats: {
      open_alerts: openAlerts?.c ?? 0,
      open_issues: openIssues?.c ?? 0,
      expiring_soon: expiring?.c ?? 0,
      weekly_checks_due: weeklyDue?.c ?? 0,
      tracking_issues: trackingSummary?.total ?? 0,
      not_reporting: trackingSummary?.not_reporting ?? 0,
      stale_or_offline: trackingSummary?.stale_or_offline ?? 0,
      dashcam_policy: trackingSummary?.dashcam_policy ?? 0,
      expected_trackers: trackingSummary?.expected_trackers ?? 0,
      live_matched: trackingSummary?.live_matched ?? 0,
      open_warranties: openWarranties,
      open_pickups: openPickups,
      open_vendor_runs: openVendorRuns,
      parts_dropoffs_waiting: partsDropoffsWaiting,
      fuel_ocr_pending: fuelOcrPending,
      open_issues_stale: openIssuesStale,
      assets_attention: assetsAttention,
      handbook_pending: handbookPending,
      emergencies,
    },
    tracking_issues: trackingIssues,
    my_reminders: {
      weekly_checks: myWeekly.results || [],
      repairs: myRepairs.results || [],
    },
    recent_fuel: recentFuel.results,
    recent_alerts: recentAlerts.results,
  });
});

// Employees
api.get("/employees", requireRoles(ROLE_PERMS.viewFuel), async (c) => {
  const all = c.req.query("all") === "1";
  // Keep this query simple (no correlated subquery) — safer on D1 and faster.
  // Gas-card last4 is attached in one grouped pass afterward.
  const rows = await c.env.DB.prepare(
    all
      ? `SELECT e.* FROM employees e ORDER BY e.name`
      : `SELECT e.* FROM employees e WHERE e.active = 1 ORDER BY e.name`
  ).all();
  const employees = (rows.results || []) as Array<Record<string, unknown>>;

  // Most-used card per employee (drivers often have their own gas card)
  let cardByEmp = new Map<number, string>();
  try {
    const cards = await c.env.DB.prepare(
      `SELECT employee_id, card_last4, COUNT(*) as cnt, MAX(id) as max_id
       FROM fuel_entries
       WHERE employee_id IS NOT NULL
         AND card_last4 IS NOT NULL
         AND length(trim(card_last4)) = 4
       GROUP BY employee_id, card_last4
       ORDER BY employee_id, cnt DESC, max_id DESC`
    ).all<{ employee_id: number; card_last4: string }>();
    for (const r of cards.results || []) {
      const id = Number(r.employee_id);
      if (!cardByEmp.has(id)) cardByEmp.set(id, String(r.card_last4));
    }
  } catch {
    /* fuel_entries optional shape */
  }

  return c.json({
    employees: employees.map((e) => ({
      ...e,
      gas_card_last4: cardByEmp.get(Number(e.id)) ?? null,
    })),
  });
});

/**
 * Find existing users/employees that might be the same person (name / phone / login).
 * Used when adding an employee so admin can confirm before creating a duplicate.
 */
function peopleMatchScore(
  inputName: string,
  inputPhone: string | null | undefined,
  candidate: {
    name: string;
    phone?: string | null;
    username?: string | null;
    email?: string | null;
  }
): { score: number; reasons: string[] } {
  const norm = (s: string) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const digits = (s: string | null | undefined) => String(s || "").replace(/\D/g, "");
  const a = norm(inputName);
  const b = norm(candidate.name);
  if (!a || !b) return { score: 0, reasons: [] };
  const reasons: string[] = [];
  let score = 0;

  if (a === b) {
    score = Math.max(score, 100);
    reasons.push("exact name");
  }

  const aTokens = a.split(" ").filter((t) => t.length >= 2);
  const bTokens = b.split(" ").filter((t) => t.length >= 2);
  if (aTokens.length && bTokens.length) {
    const allIn =
      aTokens.every((t) => bTokens.includes(t)) || bTokens.every((t) => aTokens.includes(t));
    if (allIn && a !== b) {
      score = Math.max(score, 92);
      reasons.push("same name parts");
    }
    const aLast = aTokens[aTokens.length - 1];
    const bLast = bTokens[bTokens.length - 1];
    if (aLast && aLast === bLast && aLast.length >= 3) {
      score = Math.max(score, 72);
      reasons.push(`same last name “${aLast}”`);
      if (aTokens[0] && bTokens[0] && aTokens[0][0] === bTokens[0][0]) {
        score = Math.max(score, 85);
        reasons.push("same first initial");
      }
    }
    // First name only match when both multi-part (avoid "Chris" matching everyone named Chris…)
    // still useful when last names are missing
    if (aTokens.length === 1 && bTokens.includes(aTokens[0]) && aTokens[0].length >= 4) {
      score = Math.max(score, 55);
      reasons.push(`first name “${aTokens[0]}”`);
    }
  }

  // Login / email looks like the person
  const un = norm(candidate.username || "").replace(/\s/g, "");
  const em = norm(candidate.email || "").split("@")[0] || "";
  const compact = a.replace(/\s/g, "");
  const dotted = aTokens.join(".");
  if (un && (un === compact || un === dotted || un === aTokens[0])) {
    score = Math.max(score, 88);
    reasons.push(`login “${candidate.username}”`);
  }
  if (em && (em === compact || em === dotted || em === aTokens[0])) {
    score = Math.max(score, 80);
    reasons.push("email local part");
  }

  const pIn = digits(inputPhone);
  const pCand = digits(candidate.phone);
  if (pIn.length >= 7 && pCand.length >= 7) {
    const tail = (s: string) => s.slice(-10);
    if (tail(pIn) === tail(pCand)) {
      score = Math.max(score, 96);
      reasons.push("same phone");
    }
  }

  // Simple edit distance for short close names (typos)
  if (score < 70 && a.length >= 4 && b.length >= 4 && Math.abs(a.length - b.length) <= 2) {
    let dist = 0;
    const m = Math.max(a.length, b.length);
    for (let i = 0; i < m; i++) {
      if (a[i] !== b[i]) dist++;
    }
    // rough: only count if very close
    if (dist <= 2 && a[0] === b[0]) {
      score = Math.max(score, 78);
      reasons.push("very similar spelling");
    }
  }

  return { score, reasons: [...new Set(reasons)] };
}

api.get("/employees/check-matches", requireRoles(ROLE_PERMS.manageEmployees), async (c) => {
  const name = (c.req.query("name") || "").trim();
  const phone = (c.req.query("phone") || "").trim() || null;
  if (!name) return c.json({ error: "name required" }, 400);

  const users = await c.env.DB.prepare(
    `SELECT id, display_name, username, email, role, employee_id, phone, active
     FROM users ORDER BY display_name`
  ).all<{
    id: number;
    display_name: string;
    username: string | null;
    email: string | null;
    role: string;
    employee_id: number | null;
    phone: string | null;
    active: number;
  }>();

  const emps = await c.env.DB.prepare(
    `SELECT id, name, phone, active FROM employees ORDER BY name`
  ).all<{ id: number; name: string; phone: string | null; active: number }>();

  const userMatches = (users.results || [])
    .map((u) => {
      const { score, reasons } = peopleMatchScore(name, phone, {
        name: u.display_name,
        phone: u.phone,
        username: u.username,
        email: u.email,
      });
      return { ...u, score, reasons, kind: "user" as const };
    })
    .filter((u) => u.score >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const employeeMatches = (emps.results || [])
    .map((e) => {
      const { score, reasons } = peopleMatchScore(name, phone, {
        name: e.name,
        phone: e.phone,
      });
      return { ...e, score, reasons, kind: "employee" as const };
    })
    .filter((e) => e.score >= 55)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  return c.json({
    name,
    phone,
    users: userMatches,
    employees: employeeMatches,
    has_matches: userMatches.length > 0 || employeeMatches.length > 0,
  });
});

api.post("/employees", requireRoles(ROLE_PERMS.manageEmployees), async (c) => {
  const body = await c.req.json<{
    name: string;
    notes?: string;
    phone?: string;
    hire_date?: string | null;
    birthday_md?: string | null;
    /** Skip match warning and create anyway */
    force?: boolean;
    /** After create, link this existing user login to the new employee */
    link_user_id?: number | null;
  }>();
  if (!body.name?.trim()) return c.json({ error: "Name required" }, 400);
  const name = body.name.trim();
  const phone = body.phone?.trim() || null;
  const hireDate = parseFlexibleDate(body.hire_date) || (body.hire_date?.trim() || null);
  const birthdayMd = normalizeBirthdayMd(body.birthday_md);

  // Unless force / explicit link, block possible duplicates for client confirmation
  if (!body.force && body.link_user_id == null) {
    const users = await c.env.DB.prepare(
      `SELECT id, display_name, username, email, role, employee_id, phone, active FROM users`
    ).all<{
      id: number;
      display_name: string;
      username: string | null;
      email: string | null;
      role: string;
      employee_id: number | null;
      phone: string | null;
      active: number;
    }>();
    const emps = await c.env.DB.prepare(`SELECT id, name, phone, active FROM employees`).all<{
      id: number;
      name: string;
      phone: string | null;
      active: number;
    }>();
    const userMatches = (users.results || [])
      .map((u) => {
        const { score, reasons } = peopleMatchScore(name, phone, {
          name: u.display_name,
          phone: u.phone,
          username: u.username,
          email: u.email,
        });
        return { ...u, score, reasons, kind: "user" as const };
      })
      .filter((u) => u.score >= 55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);
    const employeeMatches = (emps.results || [])
      .map((e) => {
        const { score, reasons } = peopleMatchScore(name, phone, {
          name: e.name,
          phone: e.phone,
        });
        return { ...e, score, reasons, kind: "employee" as const };
      })
      .filter((e) => e.score >= 70) // higher bar for existing employee dups
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (userMatches.length || employeeMatches.length) {
      return c.json(
        {
          needs_confirm: true,
          message:
            "Someone similar already exists — confirm this is a new person or link an existing login.",
          users: userMatches,
          employees: employeeMatches,
        },
        409
      );
    }
  }

  await ensurePtoTables(c.env.DB);
  let id: number;
  try {
    const result = await c.env.DB.prepare(
      "INSERT INTO employees (name, phone, notes, hire_date, birthday_md) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(name, phone, body.notes || null, hireDate, birthdayMd)
      .run();
    id = Number(result.meta.last_row_id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column/i.test(msg)) {
      const result = await c.env.DB.prepare(
        "INSERT INTO employees (name, phone, notes) VALUES (?, ?, ?)"
      )
        .bind(name, phone, body.notes || null)
        .run();
      id = Number(result.meta.last_row_id);
    } else {
      throw e;
    }
  }
  if (hireDate) {
    try {
      await applyDueAnniversary(c.env.DB, id, hireDate);
    } catch {
      /* balance tables optional until migration */
    }
  }

  let linkedUser: { id: number; display_name: string; username: string | null } | null = null;
  if (body.link_user_id != null && Number(body.link_user_id) > 0) {
    const uid = Number(body.link_user_id);
    const u = await c.env.DB.prepare(
      `SELECT id, display_name, username, employee_id FROM users WHERE id = ?`
    )
      .bind(uid)
      .first<{
        id: number;
        display_name: string;
        username: string | null;
        employee_id: number | null;
      }>();
    if (u) {
      await c.env.DB.prepare(
        `UPDATE users SET employee_id = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(id, uid)
        .run();
      if (phone) {
        await c.env.DB.prepare(
          `UPDATE employees SET phone = COALESCE(phone, ?), updated_at = datetime('now') WHERE id = ?`
        )
          .bind(phone, id)
          .run();
      }
      linkedUser = { id: u.id, display_name: u.display_name, username: u.username };
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "update",
        "user",
        uid,
        `Linked login to new employee #${id} (${name})`
      );
    }
  }

  await writeAudit(
    c.env.DB,
    c.get("user"),
    "create",
    "employee",
    id,
    `Created employee ${name}${linkedUser ? ` · linked user ${linkedUser.display_name}` : ""}`
  );
  const emp = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  return c.json({ employee: emp, linked_user: linkedUser }, 201);
});

api.patch("/employees/:id", requireRoles(ROLE_PERMS.manageEmployees), async (c) => {
  const me = c.get("user");
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?")
    .bind(id)
    .first<{
      id: number;
      name: string;
      active: number;
      hire_date?: string | null;
      birthday_md?: string | null;
      separation_date?: string | null;
      original_hire_date?: string | null;
      phone?: string | null;
      notes?: string | null;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    name?: string;
    notes?: string;
    phone?: string;
    active?: boolean;
    hire_date?: string | null;
    birthday_md?: string | null;
    rides_with_employee_id?: number | null;
    /** Last day worked when marking inactive */
    separation_date?: string | null;
    /** First day back when reactivating */
    rehire_date?: string | null;
    force_restart_pto?: boolean;
    force_keep_pto?: boolean;
  }>();

  await ensurePtoTables(c.env.DB);

  // Link helper ↔ tech (rides together)
  if (body.rides_with_employee_id !== undefined) {
    const partnerId =
      body.rides_with_employee_id == null || body.rides_with_employee_id === 0
        ? null
        : Number(body.rides_with_employee_id);
    if (partnerId === id) {
      return c.json({ error: "Someone cannot ride with themselves" }, 400);
    }
    if (partnerId) {
      const partner = await c.env.DB.prepare(
        `SELECT id, name FROM employees WHERE id = ? AND active = 1`
      )
        .bind(partnerId)
        .first<{ id: number; name: string }>();
      if (!partner) return c.json({ error: "Ride partner not found" }, 400);
    }
    try {
      await c.env.DB.prepare(
        `UPDATE employees SET rides_with_employee_id = ?, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(partnerId, id)
        .run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such column/i.test(msg)) {
        return c.json({ error: "Run migration 036_crew_vehicle_assign.sql" }, 503);
      }
      throw e;
    }
  }

  const wasActive = Number(before.active) !== 0;
  const willBeActive = body.active === undefined ? wasActive : Boolean(body.active);
  const isRehire = !wasActive && willBeActive;
  const isLeaving = wasActive && !willBeActive;

  // On rehire, hire_date is owned by the 90-day policy (unless staying active edits).
  const hireDate =
    isRehire
      ? undefined
      : body.hire_date !== undefined
        ? body.hire_date === null || body.hire_date === ""
          ? null
          : parseFlexibleDate(body.hire_date) || body.hire_date.trim()
        : undefined;
  const birthdayMd =
    body.birthday_md !== undefined
      ? body.birthday_md === null || body.birthday_md === ""
        ? null
        : normalizeBirthdayMd(body.birthday_md)
      : undefined;

  try {
    await c.env.DB.prepare(
      `UPDATE employees SET
        name = COALESCE(?, name),
        phone = COALESCE(?, phone),
        notes = COALESCE(?, notes),
        active = COALESCE(?, active),
        hire_date = CASE WHEN ? THEN ? ELSE hire_date END,
        birthday_md = CASE WHEN ? THEN ? ELSE birthday_md END,
        updated_at = datetime('now') WHERE id = ?`
    )
      .bind(
        body.name?.trim() ?? null,
        body.phone !== undefined ? body.phone : null,
        body.notes !== undefined ? body.notes : null,
        body.active === undefined ? null : body.active ? 1 : 0,
        hireDate !== undefined ? 1 : 0,
        hireDate ?? null,
        birthdayMd !== undefined ? 1 : 0,
        birthdayMd ?? null,
        id
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column/i.test(msg)) {
      await c.env.DB.prepare(
        `UPDATE employees SET
          name = COALESCE(?, name),
          phone = COALESCE(?, phone),
          notes = COALESCE(?, notes),
          active = COALESCE(?, active),
          updated_at = datetime('now') WHERE id = ?`
      )
        .bind(
          body.name?.trim() ?? null,
          body.phone !== undefined ? body.phone : null,
          body.notes !== undefined ? body.notes : null,
          body.active === undefined ? null : body.active ? 1 : 0,
          id
        )
        .run();
    } else {
      throw e;
    }
  }

  let ptoTransition: Awaited<ReturnType<typeof applyLeaveOrRehireTransition>> = null;
  if (isLeaving || isRehire) {
    try {
      ptoTransition = await applyLeaveOrRehireTransition(c.env.DB, {
        employee_id: id,
        was_active: wasActive,
        will_be_active: willBeActive,
        current_hire_date: before.hire_date ?? null,
        current_original_hire_date: before.original_hire_date ?? null,
        current_separation_date: before.separation_date ?? null,
        separation_date: body.separation_date,
        rehire_date: body.rehire_date || body.hire_date || null,
        created_by_user_id: me.id,
        force_restart: body.force_restart_pto === true,
        force_keep: body.force_keep_pto === true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/no such column/i.test(msg)) throw e;
    }
  }

  const after = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first<{
    id: number;
    hire_date?: string | null;
    separation_date?: string | null;
    original_hire_date?: string | null;
    active?: number;
  }>();
  if (after?.hire_date && Number(after.active) !== 0) {
    try {
      await applyDueAnniversary(c.env.DB, id, after.hire_date);
    } catch {
      /* optional */
    }
  }
  const auditDetail = ptoTransition
    ? `Updated employee · ${ptoTransition.message}`
    : "Updated employee";
  await writeAudit(c.env.DB, me, "update", "employee", id, auditDetail, before, after);
  return c.json({
    employee: after,
    pto_transition: ptoTransition,
    pto_rehire_break_days: PTO_REHIRE_BREAK_DAYS,
  });
});

/**
 * Fleet manager: put a tech (and optional helper) on a unit.
 * Clears the same people off other active units so map + driver access stay correct.
 */
api.post("/vehicles/:id/assign", requireRoles(ROLE_PERMS.manageVehicles), async (c) => {
  const user = c.get("user");
  const vehicleId = Number(c.req.param("id"));
  const body = await c.req.json<{
    employee_id?: number | null;
    helper_employee_id?: number | null;
    note?: string | null;
    clear?: boolean;
    /** When clearing, optional map label e.g. "Warehouse truck" (not a person) */
    pool_label?: string | null;
  }>();

  const vehicle = await c.env.DB.prepare(`SELECT * FROM vehicles WHERE id = ?`)
    .bind(vehicleId)
    .first<{
      id: number;
      unit_number: string;
      assigned_driver: string | null;
      assigned_employee_id?: number | null;
      helper_employee_id?: number | null;
    }>();
  if (!vehicle) return c.json({ error: "Vehicle not found" }, 404);

  try {
    const clear = body.clear === true || body.employee_id === null || body.employee_id === 0;
    let empId: number | null = clear ? null : Number(body.employee_id);
    let helperId: number | null =
      body.helper_employee_id == null || body.helper_employee_id === 0
        ? null
        : Number(body.helper_employee_id);

    let driverName: string | null = null;
    // Pool / warehouse trucks: no tech, but a map label so they stay visible as Unassigned/Warehouse
    if (clear) {
      const pool = (body.pool_label || "").trim();
      if (pool) driverName = pool.slice(0, 80);
    }
    if (empId) {
      const emp = await c.env.DB.prepare(
        `SELECT id, name, rides_with_employee_id FROM employees WHERE id = ? AND active = 1`
      )
        .bind(empId)
        .first<{ id: number; name: string; rides_with_employee_id: number | null }>();
      if (!emp) return c.json({ error: "Employee not found" }, 400);
      driverName = emp.name;
      // Auto-include linked helper if not specified
      if (helperId == null && emp.rides_with_employee_id) {
        helperId = emp.rides_with_employee_id;
      }
    }
    if (helperId) {
      if (helperId === empId) {
        return c.json({ error: "Helper must be a different person" }, 400);
      }
      const helper = await c.env.DB.prepare(
        `SELECT id, name FROM employees WHERE id = ? AND active = 1`
      )
        .bind(helperId)
        .first<{ id: number; name: string }>();
      if (!helper) return c.json({ error: "Helper not found" }, 400);
      if (driverName) driverName = `${driverName} + ${helper.name}`;
      else driverName = helper.name;
    }

    const prevEmp = vehicle.assigned_employee_id ?? null;
    const prevHelper = vehicle.helper_employee_id ?? null;
    const prevName = vehicle.assigned_driver;

    // Remove this tech/helper from any other unit (one primary truck at a time)
    // Use separate statements so we never multiply binds past D1's ~100 limit.
    if (empId || helperId) {
      const ids = [empId, helperId].filter((x): x is number => x != null);
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        await c.env.DB.prepare(
          `UPDATE vehicles SET
             assigned_employee_id = NULL,
             assigned_driver = CASE
               WHEN helper_employee_id IS NULL THEN NULL
               ELSE assigned_driver
             END,
             updated_at = datetime('now')
           WHERE id != ? AND status != 'retired' AND assigned_employee_id IN (${ph})`
        )
          .bind(vehicleId, ...ids)
          .run();
        await c.env.DB.prepare(
          `UPDATE vehicles SET
             helper_employee_id = NULL,
             updated_at = datetime('now')
           WHERE id != ? AND status != 'retired' AND helper_employee_id IN (${ph})`
        )
          .bind(vehicleId, ...ids)
          .run();
      }
    }

    await c.env.DB.prepare(
      `UPDATE vehicles SET
         assigned_employee_id = ?,
         helper_employee_id = ?,
         assigned_driver = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(empId, helperId, driverName, vehicleId)
      .run();

    await c.env.DB.prepare(
      `INSERT INTO vehicle_assignment_log (
         vehicle_id, assigned_employee_id, helper_employee_id, assigned_driver_name,
         previous_employee_id, previous_helper_employee_id, previous_driver_name,
         assigned_by_user_id, note, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(
        vehicleId,
        empId,
        helperId,
        driverName,
        prevEmp,
        prevHelper,
        prevName,
        user.id,
        body.note?.trim() || null
      )
      .run();

    await writeAudit(
      c.env.DB,
      user,
      "update",
      "vehicle",
      vehicleId,
      clear
        ? driverName
          ? `Unit ${vehicle.unit_number} marked ${driverName} (unassigned, stays on map)`
          : `Cleared assignment on unit ${vehicle.unit_number}`
        : `Assigned ${driverName} → unit ${vehicle.unit_number}`
    );

    // Notify the individual(s) put on the truck — not a role group
    if (!clear && (empId || helperId)) {
      const assigneeIds = await userIdsForEmployees(c.env.DB, [
        empId || 0,
        helperId || 0,
      ]);
      if (assigneeIds.length) {
        const unitNo = vehicle.unit_number || "?";
        scheduleWaitUntil(
          c,
          notifyAndSms(c.env, c.env.DB, assigneeIds, {
            kind: "vehicle_assigned",
            title: `You’re on unit ${unitNo}`,
            body: `${user.display_name} assigned you to unit ${unitNo}${
              body.note?.trim() ? ` · ${body.note.trim().slice(0, 100)}` : ""
            }`,
            entity: { type: "vehicle", id: vehicleId },
            sms: shortSms(
              `TA: You’re assigned to unit ${unitNo}${
                body.note?.trim() ? ` · ${body.note.trim().slice(0, 80)}` : ""
              }. — ${user.display_name}`
            ),
            excludeUserId: user.id,
            fromUserId: user.id,
            smsContext: `vehicle_assign:${vehicleId}:${empId || 0}`,
          }).catch(() => null)
        );
      }
    }

    const after = await c.env.DB.prepare(`SELECT * FROM vehicles WHERE id = ?`)
      .bind(vehicleId)
      .first();
    return c.json({ ok: true, vehicle: after });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column|no such table/i.test(msg)) {
      return c.json({ error: "Run migration 036_crew_vehicle_assign.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/vehicles/:id/assignment-log", requireRoles(ROLE_PERMS.manageVehicles), async (c) => {
  const vehicleId = Number(c.req.param("id"));
  try {
    const rows = await c.env.DB.prepare(
      `SELECT l.*, u.display_name as assigned_by_name
       FROM vehicle_assignment_log l
       LEFT JOIN users u ON u.id = l.assigned_by_user_id
       WHERE l.vehicle_id = ?
       ORDER BY l.created_at DESC LIMIT 30`
    )
      .bind(vehicleId)
      .all();
    return c.json({ log: rows.results || [] });
  } catch {
    return c.json({ log: [] });
  }
});

// Vehicles
/** Personal units (P101, P-12…) carry their own insurance; company fleet shares one policy. */
function isPersonalVehicleUnit(unit: string | null | undefined): boolean {
  const u = String(unit || "")
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
  return /^P\d/.test(u);
}

async function getFleetInsuranceExpires(db: D1Database): Promise<string | null> {
  const v = (await getSetting(db, "fleet_insurance_expires", "")).trim();
  return v || null;
}

/** Write fleet plan date and stamp every non-personal vehicle row (for yard filters / reports). */
async function syncFleetInsuranceToCompanyVehicles(
  db: D1Database,
  expires: string | null
): Promise<number> {
  await setSetting(db, "fleet_insurance_expires", expires || "");
  const rows = await db
    .prepare(`SELECT id, unit_number FROM vehicles WHERE status != 'retired'`)
    .all<{ id: number; unit_number: string }>();
  let n = 0;
  for (const v of rows.results || []) {
    if (isPersonalVehicleUnit(v.unit_number)) continue;
    await db
      .prepare(
        `UPDATE vehicles SET insurance_expires = ?, updated_at = datetime('now') WHERE id = ?`
      )
      .bind(expires, v.id)
      .run();
    n += 1;
  }
  return n;
}

/**
 * Fast vehicle lookup by license plate, unit #, or VIN (for form auto-fill).
 * Query: ?q= or ?plate=  (2+ chars). Returns best matches first.
 */
api.get("/vehicles/lookup", async (c) => {
  const raw = (c.req.query("q") || c.req.query("plate") || c.req.query("unit") || "").trim();
  if (raw.length < 2) {
    return c.json({ vehicles: [], query: raw });
  }
  const alnum = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const like = `%${raw.replace(/%/g, "").replace(/_/g, "")}%`;
  const alnumLike = alnum ? `%${alnum}%` : like;

  try {
    // Prefer plate match, then unit, then VIN. Active first.
    const rows = await c.env.DB.prepare(
      `SELECT id, unit_number, plate, year, make, model, vin, status,
              current_odometer, assigned_driver, phone
       FROM vehicles
       WHERE status != 'retired'
         AND (
           upper(replace(replace(replace(ifnull(plate,''),'-',''),' ',''),'.','')) LIKE ?
           OR upper(ifnull(unit_number,'')) LIKE upper(?)
           OR upper(replace(ifnull(vin,''),' ','')) LIKE ?
           OR upper(ifnull(make,'')) || ' ' || upper(ifnull(model,'')) LIKE upper(?)
         )
       ORDER BY
         CASE
           WHEN upper(replace(replace(replace(ifnull(plate,''),'-',''),' ',''),'.','')) = ? THEN 0
           WHEN upper(replace(replace(replace(ifnull(plate,''),'-',''),' ',''),'.','')) LIKE ? THEN 1
           WHEN upper(ifnull(unit_number,'')) = upper(?) THEN 2
           WHEN upper(ifnull(unit_number,'')) LIKE upper(?) THEN 3
           ELSE 4
         END,
         CASE status WHEN 'active' THEN 0 ELSE 1 END,
         unit_number
       LIMIT 12`
    )
      .bind(
        alnumLike,
        like,
        alnumLike,
        like,
        alnum,
        alnum + "%",
        raw,
        like
      )
      .all();

    return c.json({
      vehicles: rows.results || [],
      query: raw,
      normalized: alnum,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e), vehicles: [] }, 500);
  }
});

api.get("/vehicles", async (c) => {
  const filter = c.req.query("filter");
  /**
   * scope=fleet — full active fleet for fuel / ride-along (helpers pick another van).
   * Default: drivers only see home + usual-partner units.
   */
  const scope = (c.req.query("scope") || "").toLowerCase();
  const fleetScope = scope === "fleet" || scope === "all" || c.req.query("for") === "fuel";
  const soonDays = Number(await getSetting(c.env.DB, "expiring_soon_days", "30"));
  const fleetInsurance = await getFleetInsuranceExpires(c.env.DB);
  let sql = "SELECT * FROM vehicles WHERE 1=1";
  const binds: unknown[] = [];

  if (filter === "active") sql += " AND status = 'active'";
  if (filter === "expired") {
    // Texas: registration sticker + insurance (company rows keep fleet date synced)
    sql += ` AND status != 'retired' AND (
      (registration_expires IS NOT NULL AND registration_expires < date('now')) OR
      (insurance_expires IS NOT NULL AND insurance_expires < date('now'))
    )`;
  }
  if (filter === "expiring") {
    sql += ` AND status = 'active' AND (
      (registration_expires IS NOT NULL AND registration_expires <= date('now', '+' || ? || ' days') AND registration_expires >= date('now')) OR
      (insurance_expires IS NOT NULL AND insurance_expires <= date('now', '+' || ? || ' days') AND insurance_expires >= date('now'))
    )`;
    binds.push(String(soonDays), String(soonDays));
  }
  if (filter === "dash_cam") {
    // n/a is acceptable and not an issue
    sql += " AND dash_cam_status IN ('not_working','missing')";
  }
  if (filter === "gps") {
    // n/a is acceptable and not an issue (same as dash cam)
    sql += " AND gps_status IN ('not_working','missing')";
  }
  if (filter === "equipment") {
    sql += ` AND (
      dash_cam_status IN ('not_working','missing')
      OR gps_status IN ('not_working','missing')
    )`;
  }
  // Drivers: restricted list unless fuel/fleet scope (need other vans when covering)
  const user = c.get("user");
  const homeVids = user.role === "driver" ? await getDriverHomeVehicleIds(c.env.DB, user) : [];
  if (!fleetScope) {
    const driverVids = await getDriverVehicleIds(c.env.DB, user);
    if (driverVids !== null) {
      const sc = sqlInIds("id", driverVids);
      sql += sc.clause;
      binds.push(...sc.binds);
    }
  }

  sql += " ORDER BY unit_number";

  const stmt = c.env.DB.prepare(sql);
  const rows = binds.length ? await stmt.bind(...binds).all() : await stmt.all();

  // Enrich with matched driver employee only (helpers move around — not stored permanently)
  const emps = await c.env.DB.prepare(
    "SELECT id, name FROM employees WHERE active = 1"
  ).all<{ id: number; name: string }>();

  function norm(s: string) {
    return s
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchEmployee(driverName: string | null | undefined) {
    if (!driverName?.trim()) return null;
    const n = norm(driverName);
    const list = emps.results || [];
    let hit = list.find((e) => norm(e.name) === n);
    if (!hit) {
      hit = list.find((e) => {
        const en = norm(e.name);
        return en.includes(n) || n.includes(en);
      });
    }
    if (!hit) {
      const first = n.split(" ")[0];
      if (first.length >= 3) {
        const firstHits = list.filter((e) => norm(e.name).startsWith(first));
        if (firstHits.length === 1) hit = firstHits[0];
      }
    }
    return hit || null;
  }

  const homeSet = new Set(homeVids);
  const vehicles = (rows.results || []).map((v) => {
    const row = v as Record<string, unknown>;
    const driverName = String(row.assigned_driver || "");
    const emp = matchEmployee(driverName);
    const id = Number(row.id);
    const unit = String(row.unit_number || "");
    const personal = isPersonalVehicleUnit(unit);
    // Company units: show fleet plan date (synced on company rows; overlay if setting set)
    const insuranceExpires = personal
      ? (row.insurance_expires as string | null) || null
      : fleetInsurance || (row.insurance_expires as string | null) || null;
    return {
      ...row,
      insurance_expires: insuranceExpires,
      is_personal: personal,
      insurance_is_fleet: !personal,
      driver_employee_id: emp?.id ?? null,
      driver_name: emp?.name ?? (driverName || null),
      /** Usual unit for the logged-in tech (default pick on fuel form) */
      is_my_default: homeSet.has(id),
    };
  });

  // Prefer usual unit(s) at the top when showing full fleet
  if (fleetScope && homeSet.size) {
    vehicles.sort((a, b) => {
      const ad = a.is_my_default ? 0 : 1;
      const bd = b.is_my_default ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return String(a.unit_number || "").localeCompare(String(b.unit_number || ""), undefined, {
        numeric: true,
      });
    });
  }

  return c.json({
    vehicles,
    expiring_soon_days: soonDays,
    default_vehicle_ids: homeVids,
    fleet_insurance_expires: fleetInsurance,
    scope: fleetScope ? "fleet" : "assigned",
  });
});

/** Office sets one insurance expiration for all company (non-P) units. */
api.put("/vehicles/fleet-insurance", requireRoles(ROLE_PERMS.manageVehicleCompliance), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ insurance_expires?: string | null }>();
  const raw = body.insurance_expires != null ? String(body.insurance_expires).trim() : "";
  const expires = raw || null;
  if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
    return c.json({ error: "Use a date YYYY-MM-DD" }, 400);
  }
  try {
    const updated = await syncFleetInsuranceToCompanyVehicles(c.env.DB, expires);
    await writeAudit(
      c.env.DB,
      user,
      "update",
      "settings",
      null,
      `Fleet insurance expires → ${expires || "cleared"} (${updated} company units)`
    );
    return c.json({ ok: true, fleet_insurance_expires: expires, units_updated: updated });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Could not save" }, 500);
  }
});

api.get("/vehicles/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const vehicle = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
  if (!vehicle) return c.json({ error: "Not found" }, 404);
  const fuel = await c.env.DB.prepare(
    `SELECT f.*, e.name as employee_name FROM fuel_entries f
     JOIN employees e ON e.id = f.employee_id
     WHERE f.vehicle_id = ? ORDER BY f.fuel_date DESC, f.id DESC LIMIT 20`
  )
    .bind(id)
    .all();
  const issues = await c.env.DB.prepare(
    `SELECT i.*, u.display_name as reporter_name FROM vehicle_issues i
     JOIN users u ON u.id = i.reported_by_user_id
     WHERE i.vehicle_id = ? ORDER BY i.created_at DESC LIMIT 20`
  )
    .bind(id)
    .all();
  return c.json({ vehicle, fuel: fuel.results, issues: issues.results });
});

api.post("/vehicles", requireRoles(ROLE_PERMS.manageVehicles), async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const unit = String(body.unit_number || "").trim();
  if (!unit) return c.json({ error: "Unit number required" }, 400);
  const make = body.make != null && String(body.make).trim() ? String(body.make).trim() : null;
  const model = body.model != null && String(body.model).trim() ? String(body.model).trim() : null;
  let tankCap: number | null = null;
  if (body.tank_capacity_gallons !== undefined && body.tank_capacity_gallons !== "" && body.tank_capacity_gallons != null) {
    const n = Number(body.tank_capacity_gallons);
    if (!(n > 0) || !Number.isFinite(n)) {
      return c.json({ error: "Tank capacity must be a positive number of gallons" }, 400);
    }
    tankCap = Math.round(n * 10) / 10;
  } else {
    tankCap = suggestTankCapacity(make, model);
  }
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO vehicles (
        unit_number, plate, year, make, model, vin, status, current_odometer,
        assigned_driver, phone, insurance_card,
        dash_cam_status, cam_type, gps_tracker,
        registration_expires, inspection_expires,
        insurance_expires, modifications, notes, gps_status, tank_capacity_gallons
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        unit,
        body.plate || null,
        body.year || null,
        make,
        model,
        body.vin || null,
        body.status || "active",
        body.current_odometer ?? null,
        body.assigned_driver || null,
        body.phone || null,
        body.insurance_card || null,
        body.dash_cam_status || "n/a",
        body.cam_type || null,
        body.gps_tracker || null,
        body.registration_expires || null,
        body.inspection_expires || null,
        isPersonalVehicleUnit(unit)
          ? body.insurance_expires || null
          : (await getFleetInsuranceExpires(c.env.DB)) || body.insurance_expires || null,
        body.modifications || null,
        body.notes || null,
        body.gps_status || "n/a",
        tankCap
      )
      .run();
    const id = Number(result.meta.last_row_id);
    // New active units get a truck stock location + zero balances for truck-stock parts
    if ((body.status || "active") === "active") {
      try {
        await ensureVehicleStockLocation(c.env.DB, id, unit, { seedTruckParts: true });
      } catch {
        /* inventory tables may not exist yet */
      }
    }
    await writeAudit(c.env.DB, c.get("user"), "create", "vehicle", id, `Created vehicle ${unit}`);
    const vehicle = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
    return c.json({ vehicle }, 201);
  } catch {
    return c.json({ error: "Could not create vehicle (duplicate unit?)" }, 400);
  }
});

api.patch("/vehicles/:id", requireRoles(ROLE_PERMS.manageVehicles), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const canCompliance = roleAtLeast(user.role, ROLE_PERMS.manageVehicleCompliance);

  // Shop/techs: cam/GPS only. Office/admin: registration + insurance.
  if (!canCompliance) {
    for (const f of ["registration_expires", "insurance_expires", "insurance_card"] as const) {
      if (body[f] !== undefined) {
        return c.json(
          {
            error:
              "Only office or shop can set registration and insurance dates.",
          },
          403
        );
      }
    }
  }

  const unitForIns = String(
    body.unit_number !== undefined ? body.unit_number : before.unit_number || ""
  );
  const personal = isPersonalVehicleUnit(unitForIns);
  let fleetUpdated = false;

  // Company units share one insurance plan — changing it updates the fleet setting + all company rows
  if (!personal && body.insurance_expires !== undefined) {
    const raw =
      body.insurance_expires === "" || body.insurance_expires == null
        ? null
        : String(body.insurance_expires).trim();
    const expires = raw || null;
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      return c.json({ error: "Insurance date must be YYYY-MM-DD" }, 400);
    }
    await syncFleetInsuranceToCompanyVehicles(c.env.DB, expires);
    fleetUpdated = true;
    delete body.insurance_expires;
  }

  const fields = [
    "unit_number",
    "plate",
    "year",
    "make",
    "model",
    "vin",
    "status",
    "current_odometer",
    "assigned_driver",
    "phone",
    "insurance_card",
    "dash_cam_status",
    "cam_type",
    "gps_tracker",
    "gps_status",
    "registration_expires",
    "inspection_expires",
    "insurance_expires",
    "modifications",
    "notes",
    "tank_capacity_gallons",
  ] as const;

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      if (f === "insurance_expires" && !personal) continue;
      if (f === "tank_capacity_gallons") {
        if (body[f] === "" || body[f] == null) {
          sets.push(`${f} = ?`);
          values.push(null);
        } else {
          const n = Number(body[f]);
          if (!(n > 0) || !Number.isFinite(n)) {
            return c.json({ error: "Tank capacity must be a positive number of gallons" }, 400);
          }
          sets.push(`${f} = ?`);
          values.push(Math.round(n * 10) / 10);
        }
        continue;
      }
      sets.push(`${f} = ?`);
      values.push(body[f] === "" ? null : body[f]);
    }
  }

  // If make/model changed and capacity not explicitly sent, fill suggestion when still empty
  if (body.tank_capacity_gallons === undefined) {
    const nextMake =
      body.make !== undefined
        ? body.make === "" || body.make == null
          ? null
          : String(body.make)
        : (before.make as string | null);
    const nextModel =
      body.model !== undefined
        ? body.model === "" || body.model == null
          ? null
          : String(body.model)
        : (before.model as string | null);
    const curCap = before.tank_capacity_gallons as number | null | undefined;
    if (curCap == null || !(Number(curCap) > 0)) {
      const suggested = suggestTankCapacity(nextMake, nextModel);
      if (suggested != null) {
        sets.push("tank_capacity_gallons = ?");
        values.push(suggested);
      }
    }
  }

  if (!sets.length && !fleetUpdated) return c.json({ error: "No fields" }, 400);
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    values.push(id);
    await c.env.DB.prepare(`UPDATE vehicles SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }
  const after = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first<{
    id: number;
    unit_number: string;
    status: string;
  }>();
  // Keep truck stock location in sync when unit number / status changes
  if (after && after.status === "active") {
    try {
      await ensureVehicleStockLocation(c.env.DB, after.id, after.unit_number);
    } catch {
      /* inventory optional */
    }
  } else if (after && after.status !== "active") {
    try {
      await c.env.DB.prepare(
        `UPDATE stock_locations SET active = 0 WHERE type = 'vehicle' AND vehicle_id = ?`
      )
        .bind(after.id)
        .run();
    } catch {
      /* ok */
    }
  }
  await writeAudit(
    c.env.DB,
    c.get("user"),
    "update",
    "vehicle",
    id,
    `Updated vehicle ${(before as { unit_number: string }).unit_number}`,
    before,
    after
  );
  return c.json({ vehicle: after });
});

// Fuel
/** Ensure fuel OCR review columns exist (migration 043). Do not run bulk backfills here — that can hang mobile. */
let fuelOcrColsReady = false;
async function ensureFuelOcrReviewColumns(db: D1Database): Promise<void> {
  if (fuelOcrColsReady) return;
  const alters = [
    `ALTER TABLE fuel_entries ADD COLUMN ocr_raw_text TEXT`,
    `ALTER TABLE fuel_entries ADD COLUMN ocr_json TEXT`,
    `ALTER TABLE fuel_entries ADD COLUMN ocr_needs_review INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE fuel_entries ADD COLUMN ocr_reviewed_at TEXT`,
    `ALTER TABLE fuel_entries ADD COLUMN ocr_reviewed_by_user_id INTEGER`,
  ];
  for (const sql of alters) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* column exists */
    }
  }
  fuelOcrColsReady = true;
}

function fuelOcrNeedsReview(
  ocr: OcrFieldSnapshot | null | undefined,
  final: OcrFieldSnapshot | null | undefined
): boolean {
  if (!ocr || !final) return true;
  const fields = [
    "fuel_date",
    "fuel_time",
    "gallons",
    "total_cost",
    "store_number",
    "card_last4",
  ] as const;
  let anyDiff = false;
  let anyCore = false;
  for (const f of fields) {
    const o = ocr[f];
    const fin = final[f];
    if (fin != null && String(fin).trim() !== "") anyCore = true;
    const os = o == null ? "" : String(o).trim();
    const fs = fin == null ? "" : String(fin).trim();
    if (os !== fs) anyDiff = true;
  }
  // Missing gallons or total always review
  if (final.gallons == null || final.total_cost == null) return true;
  // OCR disagreed with submitted values — admin should confirm learning
  if (anyDiff) return true;
  // No usable final data
  if (!anyCore) return true;
  return false;
}

api.get("/fuel", requireRoles(ROLE_PERMS.viewFuel), async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const vehicleId = c.req.query("vehicle_id");
  const employeeId = c.req.query("employee_id");
  let sql = `SELECT f.*, e.name as employee_name, v.unit_number, u.display_name as entered_by_name
    FROM fuel_entries f
    JOIN employees e ON e.id = f.employee_id
    JOIN vehicles v ON v.id = f.vehicle_id
    JOIN users u ON u.id = f.entered_by_user_id WHERE 1=1`;
  const binds: unknown[] = [];
  if (from) {
    sql += " AND f.fuel_date >= ?";
    binds.push(from);
  }
  if (to) {
    sql += " AND f.fuel_date <= ?";
    binds.push(to);
  }
  if (vehicleId) {
    sql += " AND f.vehicle_id = ?";
    binds.push(Number(vehicleId));
  }
  if (employeeId) {
    sql += " AND f.employee_id = ?";
    binds.push(Number(employeeId));
  }
  // Drivers see fuel they logged / under their employee — any van (ride-alongs)
  const fuelUser = c.get("user");
  let driverMineClause = "";
  if (fuelUser.role === "driver") {
    if (fuelUser.employee_id) {
      driverMineClause = " AND (f.employee_id = ? OR f.entered_by_user_id = ?)";
      binds.push(fuelUser.employee_id, fuelUser.id);
    } else {
      driverMineClause = " AND f.entered_by_user_id = ?";
      binds.push(fuelUser.id);
    }
  }
  sql += driverMineClause;
  sql += " ORDER BY f.fuel_date DESC, f.id DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  const totalBinds: unknown[] = [];
  if (from) totalBinds.push(from);
  if (to) totalBinds.push(to);
  if (vehicleId) totalBinds.push(Number(vehicleId));
  if (employeeId) totalBinds.push(Number(employeeId));
  if (fuelUser.role === "driver") {
    if (fuelUser.employee_id) totalBinds.push(fuelUser.employee_id, fuelUser.id);
    else totalBinds.push(fuelUser.id);
  }

  const totals = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(gallons),0) as gallons, COALESCE(SUM(total_cost),0) as total_cost, COUNT(*) as count
     FROM fuel_entries f WHERE 1=1
     ${from ? " AND f.fuel_date >= ?" : ""}
     ${to ? " AND f.fuel_date <= ?" : ""}
     ${vehicleId ? " AND f.vehicle_id = ?" : ""}
     ${employeeId ? " AND f.employee_id = ?" : ""}
     ${driverMineClause}`
  )
    .bind(...totalBinds)
    .first();

  return c.json({ entries: rows.results, totals });
});

api.get("/ocr/hints", async (c) => {
  const hints = await getOcrHints(c.env.DB);
  return c.json(hints);
});

api.post(
  "/ocr/feedback",
  requireRoles([...ROLE_PERMS.logFuel, ...ROLE_PERMS.logPartsPurchase] as Role[]),
  async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    raw_text?: string;
    ocr?: OcrFieldSnapshot;
    final?: OcrFieldSnapshot;
  }>();
  if (!body.ocr || !body.final) {
    return c.json({ error: "ocr and final snapshots required" }, 400);
  }
  try {
    const r = await recordOcrFeedback(
      c.env.DB,
      user.id,
      body.raw_text || null,
      body.ocr,
      body.final
    );
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({
      ok: false,
      error: e instanceof Error ? e.message : "Could not save OCR feedback",
    }, 500);
  }
});

api.post("/fuel", requireRoles(ROLE_PERMS.logFuel), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    employee_id: number;
    vehicle_id: number;
    odometer: number;
    gallons?: number;
    total_cost?: number;
    fuel_date: string;
    fuel_time?: string;
    store_number?: string;
    card_last4?: string;
    station_notes?: string;
    receipt_key?: string;
    ocr_feedback?: {
      raw_text?: string;
      ocr?: OcrFieldSnapshot;
      final?: OcrFieldSnapshot;
    };
  }>();

  if (!body.vehicle_id || body.odometer == null || !body.fuel_date) {
    return c.json({ error: "vehicle_id, odometer, and fuel_date are required" }, 400);
  }
  // Receipt photo required for records
  if (!body.receipt_key?.trim()) {
    return c.json({ error: "Receipt photo is required. Take a picture of the receipt before saving." }, 400);
  }

  let employeeId = body.employee_id;
  if (user.role === "driver") {
    if (user.employee_id) employeeId = user.employee_id;
    else if (!employeeId) return c.json({ error: "Link your user to an employee profile first" }, 400);
  }
  if (!employeeId) return c.json({ error: "employee_id required" }, 400);

  // Any active fleet unit is allowed — helpers ride other vans when primary is off
  const vehicle = await c.env.DB.prepare(
    `SELECT id, unit_number, status FROM vehicles WHERE id = ?`
  )
    .bind(body.vehicle_id)
    .first<{ id: number; unit_number: string; status: string }>();
  if (!vehicle) return c.json({ error: "Vehicle not found" }, 404);
  if (vehicle.status === "retired") {
    return c.json({ error: "That unit is retired — pick an active van" }, 400);
  }
  const homeVids = user.role === "driver" ? await getDriverHomeVehicleIds(c.env.DB, user) : [];
  const offUsualUnit =
    user.role === "driver" && homeVids.length > 0 && !homeVids.includes(body.vehicle_id);

  const cardLast4 = body.card_last4?.replace(/\D/g, "").slice(-4) || null;

  // Driver's usual gas card (most common last-4 on their history)
  const expectedCardRow = await c.env.DB.prepare(
    `SELECT card_last4 as c, COUNT(*) as n FROM fuel_entries
     WHERE employee_id = ? AND card_last4 IS NOT NULL AND length(trim(card_last4)) = 4
     GROUP BY card_last4 ORDER BY n DESC, MAX(id) DESC LIMIT 1`
  )
    .bind(employeeId)
    .first<{ c: string; n: number }>();
  const expectedCard = expectedCardRow?.c?.replace(/\D/g, "").slice(-4) || null;
  const cardMismatch = Boolean(
    expectedCard && cardLast4 && expectedCard !== cardLast4 && (expectedCardRow?.n ?? 0) >= 1
  );
  let stationNotes = body.station_notes?.trim() || "";
  if (cardMismatch) {
    const flag = `CARD MISMATCH: receipt/form ••${cardLast4} vs driver’s usual ••${expectedCard}`;
    stationNotes = stationNotes ? `${stationNotes} | ${flag}` : flag;
  }
  if (offUsualUnit) {
    const flag = `RIDE-ALONG / OTHER VAN: Unit ${vehicle.unit_number} (not tech’s usual unit)`;
    stationNotes = stationNotes ? `${stationNotes} | ${flag}` : flag;
  }

  await ensureFuelOcrReviewColumns(c.env.DB);

  const ocrSnap = body.ocr_feedback?.ocr || null;
  const finalSnap: OcrFieldSnapshot = body.ocr_feedback?.final || {
    fuel_date: body.fuel_date || null,
    fuel_time: body.fuel_time?.trim() || null,
    gallons: body.gallons ?? null,
    total_cost: body.total_cost ?? null,
    store_number: body.store_number?.trim() || null,
    card_last4: cardLast4,
  };
  // Only queue when OCR is uncertain, disagrees with final, or card mismatch — not every clean scan
  const needsReviewFlag =
    fuelOcrNeedsReview(ocrSnap, finalSnap) || cardMismatch ? 1 : 0;
  const ocrJson = JSON.stringify({
    ocr: ocrSnap,
    final: finalSnap,
    raw_text: body.ocr_feedback?.raw_text || null,
    saved_at: new Date().toISOString(),
  });

  let result;
  try {
    result = await c.env.DB.prepare(
      `INSERT INTO fuel_entries
        (employee_id, vehicle_id, odometer, gallons, total_cost, fuel_date, fuel_time,
         store_number, card_last4, station_notes, receipt_key, entered_by_user_id,
         ocr_raw_text, ocr_json, ocr_needs_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        employeeId,
        body.vehicle_id,
        body.odometer,
        body.gallons ?? null,
        body.total_cost ?? null,
        body.fuel_date,
        body.fuel_time?.trim() || null,
        body.store_number?.trim() || null,
        cardLast4,
        stationNotes || null,
        body.receipt_key,
        user.id,
        body.ocr_feedback?.raw_text
          ? String(body.ocr_feedback.raw_text).slice(0, 8000)
          : null,
        ocrJson,
        needsReviewFlag
      )
      .run();
  } catch {
    // Pre-migration fallback
    result = await c.env.DB.prepare(
      `INSERT INTO fuel_entries
        (employee_id, vehicle_id, odometer, gallons, total_cost, fuel_date, fuel_time,
         store_number, card_last4, station_notes, receipt_key, entered_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        employeeId,
        body.vehicle_id,
        body.odometer,
        body.gallons ?? null,
        body.total_cost ?? null,
        body.fuel_date,
        body.fuel_time?.trim() || null,
        body.store_number?.trim() || null,
        cardLast4,
        stationNotes || null,
        body.receipt_key,
        user.id
      )
      .run();
  }

  const id = result.meta.last_row_id as number;

  // Update vehicle odometer if higher
  await c.env.DB.prepare(
    `UPDATE vehicles SET current_odometer = CASE
       WHEN current_odometer IS NULL OR current_odometer < ? THEN ?
       ELSE current_odometer END,
       updated_at = datetime('now') WHERE id = ?`
  )
    .bind(body.odometer, body.odometer, body.vehicle_id)
    .run();

  // Auto-schedule oil change shop job when miles hit next due
  try {
    await ensureOilChangeScheduled(c.env.DB, body.vehicle_id, body.odometer);
  } catch {
    // service_records may be empty / migration edge
  }

  const alerts = await evaluateMileageAlerts(c.env.DB, {
    id,
    vehicle_id: body.vehicle_id,
    employee_id: employeeId,
    odometer: body.odometer,
    fuel_date: body.fuel_date,
    gallons: body.gallons ?? null,
    total_cost: body.total_cost ?? null,
    card_last4: cardLast4,
    store_number: body.store_number?.trim() || null,
  });
  await insertAlerts(c.env.DB, id, body.vehicle_id, alerts);

  await writeAudit(
    c.env.DB,
    user,
    "create",
    "fuel_entry",
    id,
    `Fuel entry vehicle ${body.vehicle_id} @ ${body.odometer} mi`
  );

  // Learn from OCR mistakes when the user corrected fields
  if (body.ocr_feedback?.ocr && body.ocr_feedback?.final) {
    try {
      await recordOcrFeedback(
        c.env.DB,
        user.id,
        body.ocr_feedback.raw_text || null,
        body.ocr_feedback.ocr,
        body.ocr_feedback.final
      );
    } catch {
      // non-fatal
    }
  }

  const entry = await c.env.DB.prepare(
    `SELECT f.*, e.name as employee_name, v.unit_number FROM fuel_entries f
     JOIN employees e ON e.id = f.employee_id
     JOIN vehicles v ON v.id = f.vehicle_id WHERE f.id = ?`
  )
    .bind(id)
    .first();

  return c.json(
    {
      entry,
      alerts,
      card_check: {
        expected: expectedCard,
        on_receipt: cardLast4,
        match: expectedCard && cardLast4 ? expectedCard === cardLast4 : null,
        mismatch: cardMismatch,
      },
    },
    201
  );
});

api.patch("/fuel/:id", requireRoles(ROLE_PERMS.editAnyFuel), async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM fuel_entries WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const fields = [
    "employee_id",
    "vehicle_id",
    "odometer",
    "gallons",
    "total_cost",
    "fuel_date",
    "fuel_time",
    "store_number",
    "card_last4",
    "station_notes",
    "receipt_key",
  ] as const;
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      values.push(body[f] === "" ? null : body[f]);
    }
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await c.env.DB.prepare(`UPDATE fuel_entries SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  const after = await c.env.DB.prepare("SELECT * FROM fuel_entries WHERE id = ?").bind(id).first();
  await writeAudit(c.env.DB, c.get("user"), "update", "fuel_entry", id, "Updated fuel entry", before, after);
  return c.json({ entry: after });
});

/** Lightweight badge for admin/office fuel OCR verify queue */
api.get("/fuel/receipt-review/count", requireRoles(ROLE_PERMS.editAnyFuel), async (c) => {
  try {
    await ensureFuelOcrReviewColumns(c.env.DB);
    const pending = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM fuel_entries f
       WHERE f.receipt_key IS NOT NULL AND trim(f.receipt_key) != ''
         AND f.ocr_reviewed_at IS NULL
         AND (IFNULL(f.ocr_needs_review, 0) = 1 OR f.ocr_json IS NULL)`
    ).first<{ c: number }>();
    return c.json({ pending: pending?.c ?? 0 });
  } catch {
    return c.json({ pending: 0 });
  }
});

/**
 * Admin OCR receipt review queue — photos + OCR vs submitted values.
 * ?filter=needs (default) | reviewed | all
 */
api.get("/fuel/receipt-review", requireRoles(ROLE_PERMS.editAnyFuel), async (c) => {
  await ensureFuelOcrReviewColumns(c.env.DB);
  const filter = (c.req.query("filter") || "needs").toLowerCase();
  const wantId = Number(c.req.query("id") || "0");
  const limit = Math.min(100, Math.max(10, Number(c.req.query("limit") || "40")));
  let where = "WHERE f.receipt_key IS NOT NULL AND trim(f.receipt_key) != ''";
  // Needs = flagged for OCR learning / not yet admin-verified
  if (filter === "needs" || filter === "pending") {
    where +=
      " AND f.ocr_reviewed_at IS NULL AND (IFNULL(f.ocr_needs_review, 0) = 1 OR f.ocr_json IS NULL)";
  } else if (filter === "reviewed") {
    where += " AND f.ocr_reviewed_at IS NOT NULL";
  }
  // "all" — no extra filter
  if (wantId > 0) {
    where += " AND f.id = ?";
  }
  try {
    const binds: unknown[] = [];
    if (wantId > 0) binds.push(wantId);
    binds.push(limit);
    const rows = await c.env.DB.prepare(
      `SELECT f.*, e.name as employee_name, v.unit_number,
          u.display_name as entered_by_name,
          ru.display_name as reviewed_by_name
       FROM fuel_entries f
       JOIN employees e ON e.id = f.employee_id
       JOIN vehicles v ON v.id = f.vehicle_id
       LEFT JOIN users u ON u.id = f.entered_by_user_id
       LEFT JOIN users ru ON ru.id = f.ocr_reviewed_by_user_id
       ${where}
       ORDER BY f.created_at DESC
       LIMIT ?`
    )
      .bind(...binds)
      .all();

    const pending = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM fuel_entries f
       WHERE f.receipt_key IS NOT NULL AND trim(f.receipt_key) != ''
         AND f.ocr_reviewed_at IS NULL
         AND (IFNULL(f.ocr_needs_review, 0) = 1 OR f.ocr_json IS NULL)`
    ).first<{ c: number }>();

    const list = (rows.results || []).map((r) => {
      const row = r as Record<string, unknown>;
      let ocr_payload: unknown = null;
      if (row.ocr_json) {
        try {
          ocr_payload = JSON.parse(String(row.ocr_json));
        } catch {
          ocr_payload = null;
        }
      }
      return { ...row, ocr_payload };
    });

    return c.json({
      entries: list,
      pending_count: pending?.c ?? 0,
      filter,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column/i.test(msg)) {
      return c.json({
        entries: [],
        pending_count: 0,
        error: "Run migration 043_fuel_ocr_review.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Admin corrects receipt fields from the photo and teaches OCR memory.
 */
api.post("/fuel/:id/ocr-review", requireRoles(ROLE_PERMS.editAnyFuel), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  await ensureFuelOcrReviewColumns(c.env.DB);
  const body = await c.req.json<{
    fuel_date?: string | null;
    fuel_time?: string | null;
    gallons?: number | null;
    total_cost?: number | null;
    store_number?: string | null;
    card_last4?: string | null;
    station_notes?: string | null;
    odometer?: number | null;
    mark_reviewed?: boolean;
  }>();

  const before = await c.env.DB.prepare(`SELECT * FROM fuel_entries WHERE id = ?`)
    .bind(id)
    .first<Record<string, unknown>>();
  if (!before) return c.json({ error: "Not found" }, 404);

  let ocrSnap: OcrFieldSnapshot = {
    fuel_date: null,
    fuel_time: null,
    gallons: null,
    total_cost: null,
    store_number: null,
    card_last4: null,
  };
  let rawText: string | null =
    before.ocr_raw_text != null ? String(before.ocr_raw_text) : null;
  if (before.ocr_json) {
    try {
      const p = JSON.parse(String(before.ocr_json)) as {
        ocr?: OcrFieldSnapshot;
        raw_text?: string | null;
      };
      if (p.ocr) ocrSnap = { ...ocrSnap, ...p.ocr };
      if (p.raw_text) rawText = p.raw_text;
    } catch {
      /* ignore */
    }
  }

  const cardLast4 =
    body.card_last4 !== undefined
      ? body.card_last4
        ? String(body.card_last4).replace(/\D/g, "").slice(-4)
        : null
      : before.card_last4 != null
        ? String(before.card_last4)
        : null;

  const finalSnap: OcrFieldSnapshot = {
    fuel_date:
      body.fuel_date !== undefined
        ? body.fuel_date || null
        : (before.fuel_date as string | null) || null,
    fuel_time:
      body.fuel_time !== undefined
        ? body.fuel_time || null
        : (before.fuel_time as string | null) || null,
    gallons:
      body.gallons !== undefined
        ? body.gallons
        : before.gallons != null
          ? Number(before.gallons)
          : null,
    total_cost:
      body.total_cost !== undefined
        ? body.total_cost
        : before.total_cost != null
          ? Number(before.total_cost)
          : null,
    store_number:
      body.store_number !== undefined
        ? body.store_number || null
        : (before.store_number as string | null) || null,
    card_last4: cardLast4,
  };

  const odometer =
    body.odometer !== undefined && body.odometer != null && Number.isFinite(Number(body.odometer))
      ? Number(body.odometer)
      : before.odometer != null
        ? Number(before.odometer)
        : null;

  await c.env.DB.prepare(
    `UPDATE fuel_entries SET
       fuel_date = COALESCE(?, fuel_date),
       fuel_time = ?,
       gallons = ?,
       total_cost = ?,
       store_number = ?,
       card_last4 = ?,
       station_notes = COALESCE(?, station_notes),
       odometer = COALESCE(?, odometer),
       ocr_needs_review = 0,
       ocr_reviewed_at = datetime('now'),
       ocr_reviewed_by_user_id = ?,
       ocr_json = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      finalSnap.fuel_date,
      finalSnap.fuel_time,
      finalSnap.gallons,
      finalSnap.total_cost,
      finalSnap.store_number,
      finalSnap.card_last4,
      body.station_notes !== undefined ? body.station_notes || null : null,
      odometer,
      user.id,
      JSON.stringify({
        ocr: ocrSnap,
        final: finalSnap,
        raw_text: rawText,
        admin_reviewed_at: new Date().toISOString(),
        admin_reviewed_by: user.id,
      }),
      id
    )
    .run();

  // Teach OCR from original OCR read → admin-corrected final
  let learned = 0;
  try {
    const r = await recordOcrFeedback(c.env.DB, user.id, rawText, ocrSnap, finalSnap);
    learned = r.corrections || 0;
  } catch {
    /* non-fatal */
  }

  await writeAudit(
    c.env.DB,
    user,
    "update",
    "fuel_entry",
    id,
    `OCR review · taught ${learned} field(s)`
  );

  const entry = await c.env.DB.prepare(
    `SELECT f.*, e.name as employee_name, v.unit_number
     FROM fuel_entries f
     JOIN employees e ON e.id = f.employee_id
     JOIN vehicles v ON v.id = f.vehicle_id
     WHERE f.id = ?`
  )
    .bind(id)
    .first();

  return c.json({ ok: true, entry, learned });
});

// ——— Parts purchase receipts (company card / vendor invoice photos) ———

let partsPurchaseVehicleColsReady = false;
async function ensurePartsPurchaseVehicleCols(db: D1Database): Promise<void> {
  if (partsPurchaseVehicleColsReady) return;
  for (const sql of [
    `ALTER TABLE parts_purchase_receipts ADD COLUMN vehicle_id INTEGER`,
    `ALTER TABLE parts_purchase_receipts ADD COLUMN issue_id INTEGER`,
    `ALTER TABLE parts_purchase_receipts ADD COLUMN parts_order_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_parts_purch_vehicle ON parts_purchase_receipts(vehicle_id, created_at DESC)`,
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  partsPurchaseVehicleColsReady = true;
}

// ——— Dump / landfill ticket logs ———
api.get("/dump-runs", requireRoles(ROLE_PERMS.viewDumpRuns), async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT d.*, u.display_name as logged_by_name
       FROM dump_runs d
       LEFT JOIN users u ON u.id = d.logged_by_user_id
       ORDER BY d.dump_date DESC, d.id DESC
       LIMIT 100`
    ).all();
    return c.json({ dumps: rows.results || [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        dumps: [],
        error: "Run migration 068_dump_runs.sql on the database.",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/dump-runs", requireRoles(ROLE_PERMS.logDumpRuns), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    dump_date?: string;
    net_weight_lbs?: number | string | null;
    total_amount?: number | string | null;
    notes?: string | null;
    receipt_key?: string;
    ocr_feedback?: {
      raw_text?: string;
      ocr?: OcrFieldSnapshot;
      final?: OcrFieldSnapshot;
    };
  }>();

  const receiptKey = (body.receipt_key || "").trim();
  if (!receiptKey) {
    return c.json({ error: "Dump ticket photo is required." }, 400);
  }

  const dumpDate = (body.dump_date || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dumpDate)) {
    return c.json({ error: "Dump date is required (YYYY-MM-DD)." }, 400);
  }

  const weight = Number(body.net_weight_lbs);
  if (!Number.isFinite(weight) || weight < 0) {
    return c.json({ error: "Enter net weight in pounds." }, 400);
  }
  // Guard against OCR glue errors like 16001900 (two weights concatenated)
  if (weight > 80000) {
    return c.json(
      {
        error:
          "Net weight looks too high (over 80,000 lbs). Check the ticket and enter the correct net weight.",
      },
      400
    );
  }

  const total = Number(body.total_amount);
  if (!Number.isFinite(total) || total < 0) {
    return c.json({ error: "Enter the ticket total amount." }, 400);
  }

  const notes = (body.notes || "").trim() || null;
  const rawText = body.ocr_feedback?.raw_text
    ? String(body.ocr_feedback.raw_text).slice(0, 8000)
    : null;

  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO dump_runs
        (dump_date, net_weight_lbs, total_amount, notes, receipt_key, ocr_raw_text, logged_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        dumpDate,
        Math.round(weight * 100) / 100,
        Math.round(total * 100) / 100,
        notes,
        receiptKey,
        rawText,
        user.id
      )
      .run();
    const id = result.meta.last_row_id as number;

    // Learn: map weight → gallons + total_cost under store key "dump"
    if (body.ocr_feedback?.ocr && body.ocr_feedback?.final) {
      const ocr = { ...body.ocr_feedback.ocr, store_number: "dump" };
      const final = { ...body.ocr_feedback.final, store_number: "dump" };
      try {
        await recordOcrFeedback(c.env.DB, user.id, rawText, ocr, final);
      } catch {
        /* learning optional */
      }
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "dump_run",
      id,
      `Dump ${dumpDate}: ${weight} lbs · $${total}`
    );

    const row = await c.env.DB.prepare(
      `SELECT d.*, u.display_name as logged_by_name
       FROM dump_runs d
       LEFT JOIN users u ON u.id = d.logged_by_user_id
       WHERE d.id = ?`
    )
      .bind(id)
      .first();
    return c.json({ dump: row }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 068_dump_runs.sql on the database." }, 500);
    }
    return c.json({ error: msg }, 500);
  }
});

api.patch("/dump-runs/:id", requireRoles(ROLE_PERMS.logDumpRuns), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  const before = await c.env.DB.prepare(`SELECT * FROM dump_runs WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      dump_date: string;
      net_weight_lbs: number;
      total_amount: number;
      notes: string | null;
      ocr_raw_text: string | null;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{
    dump_date?: string;
    net_weight_lbs?: number | string | null;
    total_amount?: number | string | null;
    notes?: string | null;
    ocr_feedback?: {
      raw_text?: string;
      ocr?: OcrFieldSnapshot;
      final?: OcrFieldSnapshot;
    };
  }>();
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.dump_date !== undefined) {
    const d = String(body.dump_date || "").trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return c.json({ error: "Invalid date" }, 400);
    sets.push("dump_date = ?");
    binds.push(d);
  }
  if (body.net_weight_lbs !== undefined) {
    const w = Number(body.net_weight_lbs);
    if (!Number.isFinite(w) || w < 0) return c.json({ error: "Invalid weight" }, 400);
    if (w > 80000) {
      return c.json(
        {
          error:
            "Net weight looks too high (over 80,000 lbs). Check the ticket and enter the correct net weight.",
        },
        400
      );
    }
    sets.push("net_weight_lbs = ?");
    binds.push(Math.round(w * 100) / 100);
  }
  if (body.total_amount !== undefined) {
    const t = Number(body.total_amount);
    if (!Number.isFinite(t) || t < 0) return c.json({ error: "Invalid total" }, 400);
    sets.push("total_amount = ?");
    binds.push(Math.round(t * 100) / 100);
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?");
    binds.push(String(body.notes || "").trim() || null);
  }
  if (!sets.length && !body.ocr_feedback) return c.json({ error: "No fields" }, 400);
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    binds.push(id);
    await c.env.DB.prepare(`UPDATE dump_runs SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }

  // Learn from correction (wrong OCR/saved value → corrected)
  if (body.ocr_feedback?.final || body.net_weight_lbs !== undefined || body.total_amount !== undefined) {
    const finalWeight =
      body.net_weight_lbs !== undefined ? Number(body.net_weight_lbs) : before.net_weight_lbs;
    const finalTotal =
      body.total_amount !== undefined ? Number(body.total_amount) : before.total_amount;
    const finalDate =
      body.dump_date !== undefined
        ? String(body.dump_date).slice(0, 10)
        : before.dump_date;
    const ocr = body.ocr_feedback?.ocr || {
      store_number: "dump",
      fuel_date: before.dump_date,
      gallons: before.net_weight_lbs,
      total_cost: before.total_amount,
    };
    const final = body.ocr_feedback?.final || {
      store_number: "dump",
      fuel_date: finalDate,
      gallons: finalWeight,
      total_cost: finalTotal,
    };
    try {
      await recordOcrFeedback(
        c.env.DB,
        user.id,
        body.ocr_feedback?.raw_text || before.ocr_raw_text,
        { ...ocr, store_number: "dump" },
        { ...final, store_number: "dump" }
      );
    } catch {
      /* learning optional */
    }
  }

  await writeAudit(c.env.DB, user, "update", "dump_run", id, "Updated dump run");
  const row = await c.env.DB.prepare(
    `SELECT d.*, u.display_name as logged_by_name
     FROM dump_runs d
     LEFT JOIN users u ON u.id = d.logged_by_user_id
     WHERE d.id = ?`
  )
    .bind(id)
    .first();
  return c.json({ dump: row });
});

api.get("/parts-purchases", requireRoles(ROLE_PERMS.viewPartsPurchase), async (c) => {
  const user = c.get("user");
  await ensurePartsPurchaseVehicleCols(c.env.DB);
  const mine = c.req.query("mine") === "1";
  const vehicleId = Number(c.req.query("vehicle_id") || 0);
  try {
    let sql = `SELECT p.*, u.display_name as purchased_by_name,
        v.unit_number as vehicle_unit, v.plate as vehicle_plate,
        v.year as vehicle_year, v.make as vehicle_make, v.model as vehicle_model
       FROM parts_purchase_receipts p
       LEFT JOIN users u ON u.id = p.purchased_by_user_id
       LEFT JOIN vehicles v ON v.id = p.vehicle_id`;
    const binds: unknown[] = [];
    const where: string[] = [];
    if (mine || user.role === "driver") {
      where.push(`p.purchased_by_user_id = ?`);
      binds.push(user.id);
    }
    if (vehicleId > 0) {
      where.push(`p.vehicle_id = ?`);
      binds.push(vehicleId);
    }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY p.created_at DESC LIMIT 150`;
    const rows = await c.env.DB.prepare(sql).bind(...binds).all();
    return c.json({ receipts: rows.results || [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        receipts: [],
        error: "Run migration 037_parts_purchase_receipts.sql on the database.",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

/** Case/punctuation-insensitive key so "AutoZone" and "autozone" are the same place. */
function vendorNameKey(raw: string | null | undefined): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Prefer Title Case over ALL CAPS / all lowercase when merging spellings. */
function preferVendorSpelling(a: string, b: string): string {
  const score = (s: string) => {
    const t = s.trim();
    if (!t) return -1;
    if (t !== t.toLowerCase() && t !== t.toUpperCase()) return 3; // mixed / title
    if (t === t.toUpperCase() && /[A-Z]/.test(t)) return 1; // ALL CAPS
    return 0; // all lower
  };
  const sa = score(a);
  const sb = score(b);
  if (sb > sa) return b.trim();
  if (sa > sb) return a.trim();
  // Same quality — keep the longer / first
  return (a.trim().length >= b.trim().length ? a : b).trim();
}

/** Clean store names for parts receipt / pickup dropdown / save. */
function canonicalizePartsStoreName(raw: string): string | null {
  const n = String(raw || "").trim();
  if (!n) return null;
  const k = vendorNameKey(n);
  if (!k) return null;

  // Placeholders / noise (not real purchase stores)
  if (k.includes("replenish")) return null;
  if (k.includes("default vendor") || k === "imported default vendor") return null;
  if (k.includes("alcapulco") || k.includes("acapulco")) return null;

  // One official name per brand family
  if (k === "carrier" || k.startsWith("carrier ")) return "Carrier Enterprise";
  if (k === "ferguson" || k.startsWith("ferguson ")) return "Ferguson Supply";
  if (k === "lennox" || k.startsWith("lennox ")) return "Lennox Industries";
  // Daikin owns Goodman — keep "Goodman" as the shop-facing name
  if (
    k === "goodman" ||
    k.startsWith("goodman ") ||
    k === "daikin" ||
    k.startsWith("daikin ") ||
    k.includes("daikin comfort") ||
    k.includes("goodman manufacturing")
  ) {
    return "Goodman";
  }
  if (k === "autozone" || k.startsWith("auto zone")) return "AutoZone";
  if (k === "oreilly" || k === "o reilly" || k.startsWith("oreilly ") || k.startsWith("o reilly "))
    return "O'Reilly Auto Parts";
  if (k === "johnstone" || k.startsWith("johnstone ")) return "Johnstone Supply";
  if (k === "gemaire" || k.startsWith("gemaire ")) return "Gemaire";
  if (k === "baker" || k.startsWith("baker ")) return "Baker Distributing";
  if (k === "united refrigeration" || k === "united ref" || k.startsWith("united refrigeration"))
    return "United Refrigeration";
  if (k === "ac supply" || k === "a c supply") return "AC Supply";
  if (k === "first call" || k.startsWith("first call")) return "First Call";
  if (k === "amazon" || k.startsWith("amazon ")) return "Amazon";
  if (k === "home depot" || k === "homedepot") return "Home Depot";
  if (k === "lowes" || k === "lowe s") return "Lowe's";

  // Soft title-case when the user typed all-lower or ALL CAPS (keeps intentional MixedCase)
  if (n === n.toLowerCase() || n === n.toUpperCase()) {
    return n
      .toLowerCase()
      .split(/\s+/)
      .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
      .join(" ");
  }
  return n;
}

/**
 * Reuse an existing spelling of this vendor from pickup history when present
 * (so "autozone" becomes "AutoZone" if that spelling already exists).
 */
async function resolvePickupVendorName(
  db: D1Database,
  raw: string
): Promise<string> {
  const cleaned = canonicalizePartsStoreName(raw) || String(raw || "").trim();
  if (!cleaned) return cleaned;
  const key = vendorNameKey(cleaned);
  if (!key) return cleaned;
  try {
    const rows = await db
      .prepare(
        `SELECT vendor_name as n, COUNT(*) as c FROM part_pickup_tickets
         WHERE vendor_name IS NOT NULL AND trim(vendor_name) != ''
           AND lower(trim(vendor_name)) = lower(trim(?))
         GROUP BY vendor_name
         ORDER BY c DESC, length(vendor_name) DESC
         LIMIT 5`
      )
      .bind(cleaned)
      .all<{ n: string; c: number }>();
    let best = cleaned;
    for (const r of rows.results || []) {
      const cand = canonicalizePartsStoreName(r.n) || r.n;
      if (vendorNameKey(cand) !== key) continue;
      best = preferVendorSpelling(best, cand);
    }
    // Also check catalog vendors
    try {
      const cat = await db
        .prepare(
          `SELECT vendor_name as n FROM part_vendors
           WHERE vendor_name IS NOT NULL AND lower(trim(vendor_name)) = lower(trim(?))
           LIMIT 3`
        )
        .bind(cleaned)
        .all<{ n: string }>();
      for (const r of cat.results || []) {
        const cand = canonicalizePartsStoreName(r.n) || r.n;
        if (vendorNameKey(cand) === key) best = preferVendorSpelling(best, cand);
      }
    } catch {
      /* optional */
    }
    return best;
  } catch {
    return cleaned;
  }
}

/** Vendor name suggestions for datalist (part_vendors + recent tickets + prior receipts). */
api.get("/parts-purchases/vendors", requireRoles(ROLE_PERMS.logPartsPurchase), async (c) => {
  /** lower(trim) → preferred display name */
  const byKey = new Map<string, string>();
  function addName(raw: string | null | undefined) {
    const n = canonicalizePartsStoreName(String(raw || ""));
    if (!n) return;
    const key = n
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!key) return;
    // Canonical brands always win
    if (
      n === "Carrier Enterprise" ||
      n === "Ferguson Supply" ||
      n === "Lennox Industries"
    ) {
      byKey.set(key, n);
      return;
    }
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, n);
      return;
    }
    const prevLower = prev === prev.toLowerCase();
    const nextLower = n === n.toLowerCase();
    if (prevLower && !nextLower) byKey.set(key, n);
  }
  try {
    const a = await c.env.DB.prepare(
      `SELECT DISTINCT vendor_name as n FROM part_vendors
       WHERE vendor_name IS NOT NULL AND trim(vendor_name) != ''
       LIMIT 200`
    ).all<{ n: string }>();
    for (const r of a.results || []) addName(r.n);
  } catch {
    /* table may not exist */
  }
  try {
    const b = await c.env.DB.prepare(
      `SELECT DISTINCT vendor_name as n FROM part_pickup_tickets
       WHERE vendor_name IS NOT NULL AND trim(vendor_name) != ''
       ORDER BY id DESC LIMIT 80`
    ).all<{ n: string }>();
    for (const r of b.results || []) addName(r.n);
  } catch {
    /* optional */
  }
  try {
    const c2 = await c.env.DB.prepare(
      `SELECT DISTINCT vendor_name as n FROM parts_purchase_receipts
       WHERE vendor_name IS NOT NULL
       ORDER BY id DESC LIMIT 80`
    ).all<{ n: string }>();
    for (const r of c2.results || []) addName(r.n);
  } catch {
    /* optional */
  }
  // Ensure preferred brand names always appear even if not in DB yet
  addName("Carrier Enterprise");
  addName("Ferguson Supply");
  addName("Lennox Industries");
  return c.json({
    vendors: [...byKey.values()].sort((x, y) => x.localeCompare(y)).slice(0, 120),
  });
});

api.post("/parts-purchases", requireRoles(ROLE_PERMS.logPartsPurchase), async (c) => {
  const user = c.get("user");
  await ensurePartsPurchaseVehicleCols(c.env.DB);
  const body = await c.req.json<{
    purchase_kind?: "vendor" | "other";
    vendor_name?: string;
    invoice_number?: string;
    purchase_date?: string;
    total_cost?: number | null;
    card_last4?: string;
    notes?: string;
    receipt_key?: string;
    vehicle_id?: number | null;
    issue_id?: number | null;
    parts_order_id?: number | null;
    ocr_feedback?: {
      raw_text?: string;
      ocr?: OcrFieldSnapshot;
      final?: OcrFieldSnapshot;
    };
  }>();

  let vendorName = canonicalizePartsStoreName(String(body.vendor_name || "")) || "";
  const receiptKey = (body.receipt_key || "").trim();
  if (!vendorName) {
    return c.json(
      {
        error:
          "Store name is required (replenishment placeholders and blocked names cannot be used).",
      },
      400
    );
  }
  if (!receiptKey) {
    return c.json({ error: "Receipt photo is required. Take a picture of the invoice or packing slip." }, 400);
  }

  // Reuse existing store name ignoring case (avoid "Home Depot" vs "home depot")
  // Skip if already a canonical brand name
  const isCanonicalBrand =
    vendorName === "Carrier Enterprise" ||
    vendorName === "Ferguson Supply" ||
    vendorName === "Lennox Industries";
  if (!isCanonicalBrand) {
    try {
      const existing = await c.env.DB.prepare(
        `SELECT vendor_name FROM parts_purchase_receipts
         WHERE vendor_name IS NOT NULL AND lower(trim(vendor_name)) = lower(trim(?))
         ORDER BY id DESC LIMIT 1`
      )
        .bind(vendorName)
        .first<{ vendor_name: string }>();
      const reused = canonicalizePartsStoreName(existing?.vendor_name || "");
      if (reused) vendorName = reused;
      else {
        const fromTickets = await c.env.DB.prepare(
          `SELECT vendor_name FROM part_pickup_tickets
           WHERE vendor_name IS NOT NULL AND lower(trim(vendor_name)) = lower(trim(?))
           ORDER BY id DESC LIMIT 1`
        )
          .bind(vendorName)
          .first<{ vendor_name: string }>();
        const tName = canonicalizePartsStoreName(fromTickets?.vendor_name || "");
        if (tName) vendorName = tName;
      }
    } catch {
      /* optional */
    }
  }

  const kind = body.purchase_kind === "other" ? "other" : "vendor";
  const invoice = (body.invoice_number || "").trim() || null;
  if (kind === "vendor" && !invoice) {
    return c.json(
      { error: "Invoice or packing slip number is required for vendor pickups." },
      400
    );
  }

  let cardLast4: string | null = null;
  if (body.card_last4 != null && String(body.card_last4).trim()) {
    const digits = String(body.card_last4).replace(/\D/g, "");
    cardLast4 = digits.length >= 4 ? digits.slice(-4) : null;
  }

  let total: number | null = null;
  if (body.total_cost != null && body.total_cost !== ("" as unknown)) {
    const n = Number(body.total_cost);
    if (Number.isFinite(n) && n >= 0) total = Math.round(n * 100) / 100;
  }

  const purchaseDate =
    (body.purchase_date || "").trim() || new Date().toISOString().slice(0, 10);
  const notes = (body.notes || "").trim() || null;
  const vehicleId =
    body.vehicle_id != null && Number(body.vehicle_id) > 0 ? Number(body.vehicle_id) : null;
  const issueId =
    body.issue_id != null && Number(body.issue_id) > 0 ? Number(body.issue_id) : null;
  const partsOrderId =
    body.parts_order_id != null && Number(body.parts_order_id) > 0
      ? Number(body.parts_order_id)
      : null;

  // Vehicle is optional — form only collects store, date, total, purpose, photo

  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO parts_purchase_receipts (
         purchased_by_user_id, purchase_kind, vendor_name, invoice_number,
         purchase_date, total_cost, card_last4, notes, receipt_key, ocr_raw,
         vehicle_id, issue_id, parts_order_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        user.id,
        kind,
        vendorName,
        invoice,
        purchaseDate,
        total,
        cardLast4,
        notes,
        receiptKey,
        body.ocr_feedback?.raw_text ? body.ocr_feedback.raw_text.slice(0, 8000) : null,
        vehicleId,
        issueId,
        partsOrderId
      )
      .run();

    const id = Number(r.meta.last_row_id);
    const row = await c.env.DB.prepare(
      `SELECT p.*, u.display_name as purchased_by_name,
          v.unit_number as vehicle_unit, v.plate as vehicle_plate,
          v.year as vehicle_year, v.make as vehicle_make, v.model as vehicle_model
       FROM parts_purchase_receipts p
       LEFT JOIN users u ON u.id = p.purchased_by_user_id
       LEFT JOIN vehicles v ON v.id = p.vehicle_id
       WHERE p.id = ?`
    )
      .bind(id)
      .first();

    // Learn from corrections (vendor, invoice, total, card)
    if (body.ocr_feedback?.ocr && body.ocr_feedback?.final) {
      try {
        const ocrSnap = { ...body.ocr_feedback.ocr };
        const finSnap = { ...body.ocr_feedback.final };
        // Map vendor into store_number for storeKey + dual field learning
        if (finSnap.vendor_name && !finSnap.store_number) {
          finSnap.store_number = finSnap.vendor_name;
        }
        if (ocrSnap.vendor_name && !ocrSnap.store_number) {
          ocrSnap.store_number = ocrSnap.vendor_name;
        }
        if (finSnap.purchase_date && !finSnap.fuel_date) {
          finSnap.fuel_date = finSnap.purchase_date;
        }
        await recordOcrFeedback(
          c.env.DB,
          user.id,
          body.ocr_feedback.raw_text || null,
          ocrSnap,
          finSnap
        );
      } catch {
        /* learning is best-effort */
      }
    }

    const unitLabel =
      row && (row as { vehicle_unit?: string }).vehicle_unit
        ? ` · unit ${(row as { vehicle_unit: string }).vehicle_unit}`
        : vehicleId
          ? ` · vehicle #${vehicleId}`
          : "";

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "parts_purchase",
      id,
      `${kind}: ${vendorName}${invoice ? ` inv ${invoice}` : ""}${unitLabel}`,
      null,
      row
    );

    // Notify office/warehouse for visibility
    try {
      const targets = await usersByRoles(c.env.DB, ["admin", "office", "warehouse", "supervisor"]);
      await notifyUsers(
        c.env.DB,
        targets.filter((tid) => tid !== user.id),
        "parts_purchase",
        "Parts receipt submitted",
        `${user.display_name || "Tech"}: ${vendorName}${invoice ? ` · inv ${invoice}` : ""}${total != null ? ` · $${total.toFixed(2)}` : ""}${unitLabel}`,
        { type: "parts_purchase", id }
      );
    } catch {
      /* optional */
    }

    return c.json({ receipt: row }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json(
        { error: "Run migration 037_parts_purchase_receipts.sql on the database." },
        500
      );
    }
    // Older DBs without vehicle columns — retry insert without them
    if (/no such column|vehicle_id/i.test(msg) && vehicleId) {
      return c.json(
        { error: "Vehicle link not ready — refresh and try again (schema updating)." },
        500
      );
    }
    return c.json({ error: msg }, 500);
  }
});

/** Normalize photo extension (handles .jpg.jpeg, HEIC→jpg label, empty names). */
function receiptExt(file: File): string {
  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  if (type.includes("png") || name.endsWith(".png")) return "png";
  if (type.includes("webp") || name.endsWith(".webp")) return "webp";
  if (type.includes("heic") || name.endsWith(".heic") || name.endsWith(".heif")) return "jpg";
  if (type.includes("jpeg") || type.includes("jpg") || /\.jpe?g(\.|$)/i.test(name)) return "jpg";
  const parts = name.split(".").filter(Boolean);
  const last = parts[parts.length - 1]?.replace(/[^a-z0-9]/g, "") || "";
  if (last === "jpeg" || last === "jpg" || last === "jpe") return "jpg";
  if (last === "png" || last === "webp" || last === "gif") return last;
  return "jpg";
}

function receiptContentType(file: File, ext: string): string {
  if (file.type && file.type.startsWith("image/")) return file.type;
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

/**
 * Photo upload (fuel receipts, warranty drop-off location, etc.)
 * Any signed-in user — folder is restricted to known prefixes.
 * R2 when bound, otherwise D1 blob store.
 */
api.post("/uploads/receipt", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  // D1 row limit ~1MB; R2 can take more
  const maxBytes = c.env.RECEIPTS ? 10 * 1024 * 1024 : 900 * 1024;
  if (file.size > maxBytes) {
    return c.json(
      {
        error: c.env.RECEIPTS
          ? "Max 10MB photo"
          : "Photo too large (max ~900KB). Take a slightly smaller picture and try again.",
      },
      400
    );
  }

  const ext = receiptExt(file);
  const contentType = receiptContentType(file, ext);
  const formFolder = form.get("folder");
  const rawFolder =
    typeof formFolder === "string" ? formFolder.replace(/[^a-z0-9/_-]/gi, "") : "";
  const allowedFolders = [
    "fuel-receipts",
    "parts-receipts",
    "dump-runs",
    "warranty-dropoffs",
    "warranty-nameplates",
    "asset-photos",
    "issue-photos",
    "tool-loan-paperwork",
  ];
  const folder =
    rawFolder && allowedFolders.some((f) => rawFolder === f || rawFolder.startsWith(f + "/"))
      ? rawFolder
      : "fuel-receipts";
  const key = `${folder}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const buf = await file.arrayBuffer();

  if (c.env.RECEIPTS) {
    await c.env.RECEIPTS.put(key, buf, {
      httpMetadata: { contentType },
    });
    return c.json({ key, folder, storage: "r2" });
  }

  // D1 fallback — works without enabling R2 in Cloudflare
  try {
    await c.env.DB.prepare(
      `INSERT INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
    )
      .bind(key, contentType, new Uint8Array(buf), buf.byteLength)
      .run();
    return c.json({ key, folder, storage: "db" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json(
        {
          error:
            "Receipt storage table missing. Run migration 013_receipt_blobs.sql on the database.",
        },
        503
      );
    }
    return c.json(
      {
        error: `Could not save photo (${msg.slice(0, 120)}). Try a smaller picture.`,
      },
      500
    );
  }
});

/** D1 cell ~2MB; keep chunks under 700KB for reliable inserts. */
const D1_BLOB_CHUNK = 700 * 1024;
/** Without R2, handbooks may be stored as multipart chunks in receipt_blobs. */
const D1_HANDBOOK_MAX = 20 * 1024 * 1024;

async function putD1BlobChunked(
  db: D1Database,
  key: string,
  contentType: string,
  bytes: Uint8Array
): Promise<void> {
  // Clear prior parts for this key
  try {
    await db
      .prepare(`DELETE FROM receipt_blobs WHERE key = ? OR key LIKE ?`)
      .bind(key, `${key}.part.%`)
      .run();
  } catch {
    /* ok */
  }

  if (bytes.byteLength <= D1_BLOB_CHUNK) {
    await db
      .prepare(
        `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
      )
      .bind(key, contentType, bytes, bytes.byteLength)
      .run();
    return;
  }

  const n = Math.ceil(bytes.byteLength / D1_BLOB_CHUNK);
  // Meta row: multipart/<count>;<real content-type>
  await db
    .prepare(
      `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
    )
    .bind(key, `multipart/${n};${contentType}`, new Uint8Array(0), bytes.byteLength)
    .run();

  for (let i = 0; i < n; i++) {
    const start = i * D1_BLOB_CHUNK;
    const slice = bytes.subarray(start, Math.min(start + D1_BLOB_CHUNK, bytes.byteLength));
    const copy = new Uint8Array(slice.byteLength);
    copy.set(slice);
    await db
      .prepare(
        `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
      )
      .bind(`${key}.part.${i}`, contentType, copy, copy.byteLength)
      .run();
  }
}

async function getD1BlobChunked(
  db: D1Database,
  key: string
): Promise<{ contentType: string; bytes: Uint8Array } | null> {
  let row: { content_type: string; data: unknown; size: number } | null = null;
  try {
    row = await db
      .prepare(`SELECT content_type, data, size FROM receipt_blobs WHERE key = ?`)
      .bind(key)
      .first<{ content_type: string; data: unknown; size: number }>();
  } catch {
    return null;
  }
  if (!row) return null;

  const ct = row.content_type || "application/octet-stream";
  const multi = /^multipart\/(\d+);(.+)$/i.exec(ct);
  if (!multi) {
    const bytes = blobToUint8Array(row.data);
    if (!bytes?.byteLength) return null;
    return { contentType: ct, bytes };
  }

  const n = Number(multi[1]);
  const realCt = multi[2] || "application/pdf";
  if (!Number.isFinite(n) || n < 1 || n > 200) return null;

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const part = await db
      .prepare(`SELECT data FROM receipt_blobs WHERE key = ?`)
      .bind(`${key}.part.${i}`)
      .first<{ data: unknown }>();
    const b = blobToUint8Array(part?.data);
    if (!b?.byteLength) return null;
    chunks.push(b);
    total += b.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return { contentType: realCt, bytes: out };
}

api.get("/uploads/*", async (c) => {
  const full = new URL(c.req.url).pathname;
  const key = full.replace(/^\/api\/uploads\//, "");
  if (!key || key.includes("..")) return c.json({ error: "Not found" }, 404);
  // Decode path segments (part-images%2F1.jpg OR part-images/1.jpg)
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    decoded = key;
  }
  // Also try without double-encoding artifacts
  const candidates = Array.from(
    new Set([decoded, key, decoded.replace(/^\/+/, ""), key.replace(/%2F/gi, "/")])
  );

  if (c.env.RECEIPTS) {
    for (const cand of candidates) {
      const obj = await c.env.RECEIPTS.get(cand);
      if (obj) {
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "private, max-age=86400");
        if (!headers.get("Content-Type")) {
          headers.set("Content-Type", "image/jpeg");
        }
        return new Response(obj.body, { headers });
      }
    }
  }

  // Handbooks / large files may be multipart in D1
  for (const cand of candidates) {
    try {
      const blob = await getD1BlobChunked(c.env.DB, cand);
      if (blob) {
        const isImage = blob.contentType.startsWith("image/");
        if (isImage) {
          const res = imageResponse(blob.bytes, blob.contentType);
          if (res.status === 200) return res;
        }
        return new Response(blob.bytes, {
          headers: {
            "Content-Type": blob.contentType,
            "Cache-Control": "private, max-age=3600",
            "Content-Length": String(blob.bytes.byteLength),
            "Content-Disposition": blob.contentType.includes("pdf")
              ? "inline"
              : "attachment",
          },
        });
      }
    } catch {
      /* try next */
    }
  }

  // Part photos + receipts (check both blob tables + key variants)
  for (const table of ["receipt_blobs", "part_image_blobs"] as const) {
    try {
      for (const cand of candidates) {
        const row = await c.env.DB.prepare(
          `SELECT content_type, data FROM ${table} WHERE key = ?`
        )
          .bind(cand)
          .first<{ content_type: string; data: unknown }>();
        if (row?.data != null) {
          const ct = row.content_type || "image/jpeg";
          if (ct.startsWith("multipart/")) continue; // handled above
          if (ct.startsWith("image/") || ct.includes("jpeg") || ct.includes("png")) {
            const res = imageResponse(row.data, ct);
            if (res.status === 200) return res;
          } else {
            const bytes = blobToUint8Array(row.data);
            if (bytes?.byteLength) {
              return new Response(bytes, {
                headers: {
                  "Content-Type": ct,
                  "Cache-Control": "private, max-age=3600",
                  "Content-Length": String(bytes.byteLength),
                },
              });
            }
          }
        }
      }
    } catch {
      /* try next table */
    }
  }
  return c.json({ error: "Not found" }, 404);
});

// Alerts
api.get("/alerts", requireRoles(ROLE_PERMS.viewAlerts), async (c) => {
  const status = c.req.query("status") || "open";
  const driverVids = await getDriverVehicleIds(c.env.DB, c.get("user"));
  const sc = driverVids !== null ? sqlInIds("a.vehicle_id", driverVids) : null;
  const rows = await c.env.DB.prepare(
    `SELECT a.*, v.unit_number, f.odometer, f.fuel_date, f.receipt_key, f.gallons, f.total_cost,
            e.name as employee_name
     FROM mileage_alerts a
     JOIN vehicles v ON v.id = a.vehicle_id
     JOIN fuel_entries f ON f.id = a.fuel_entry_id
     JOIN employees e ON e.id = f.employee_id
     WHERE a.status = ?${sc?.clause || ""}
     ORDER BY
       CAST(v.unit_number AS INTEGER),
       v.unit_number COLLATE NOCASE,
       f.fuel_date ASC,
       f.odometer ASC,
       CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       a.id ASC`
  )
    .bind(status, ...(sc?.binds || []))
    .all();
  return c.json({ alerts: rows.results });
});

api.post("/alerts/:id/ack", requireRoles(ROLE_PERMS.manageAlerts), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ note?: string; status?: "acknowledged" | "dismissed" }>();
  const user = c.get("user");
  const status = body.status || "acknowledged";
  await c.env.DB.prepare(
    `UPDATE mileage_alerts SET status = ?, acknowledged_by_user_id = ?,
     acknowledged_at = datetime('now'), acknowledge_note = ? WHERE id = ?`
  )
    .bind(status, user.id, body.note || null, id)
    .run();
  await writeAudit(c.env.DB, user, "ack", "mileage_alert", id, `${status} alert`);
  const alert = await c.env.DB.prepare("SELECT * FROM mileage_alerts WHERE id = ?").bind(id).first();
  return c.json({ alert });
});

/**
 * Void a duplicate / bad fuel receipt from an alert:
 * deletes the fuel entry (alerts cascade) and resets vehicle odometer from remaining logs.
 */
api.post("/alerts/:id/void-fuel", requireRoles(ROLE_PERMS.manageAlerts), async (c) => {
  const id = Number(c.req.param("id"));
  const user = c.get("user");
  const body = await c.req.json<{ note?: string }>().catch(() => ({} as { note?: string }));
  const alert = await c.env.DB.prepare(
    `SELECT a.id, a.fuel_entry_id, a.vehicle_id, a.alert_type, a.message,
            v.unit_number, f.fuel_date, f.odometer, f.gallons, f.total_cost
     FROM mileage_alerts a
     JOIN vehicles v ON v.id = a.vehicle_id
     JOIN fuel_entries f ON f.id = a.fuel_entry_id
     WHERE a.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      fuel_entry_id: number;
      vehicle_id: number;
      alert_type: string;
      message: string;
      unit_number: string;
      fuel_date: string;
      odometer: number;
      gallons: number | null;
      total_cost: number | null;
    }>();
  if (!alert) return c.json({ error: "Alert not found" }, 404);

  const fuelId = alert.fuel_entry_id;
  const vehicleId = alert.vehicle_id;
  const note = (body.note || "").trim();

  await c.env.DB.prepare(`DELETE FROM fuel_entries WHERE id = ?`).bind(fuelId).run();

  // Recalculate vehicle odometer from remaining fuel logs (or clear if none)
  const maxOdo = await c.env.DB.prepare(
    `SELECT MAX(odometer) as m FROM fuel_entries WHERE vehicle_id = ?`
  )
    .bind(vehicleId)
    .first<{ m: number | null }>();
  await c.env.DB.prepare(
    `UPDATE vehicles SET current_odometer = ?, updated_at = datetime('now') WHERE id = ?`
  )
    .bind(maxOdo?.m ?? null, vehicleId)
    .run();

  await writeAudit(
    c.env.DB,
    user,
    "void",
    "fuel_entry",
    fuelId,
    `Voided from alert #${id} · Unit ${alert.unit_number} · ${alert.fuel_date} · ${alert.odometer} mi${
      note ? ` · ${note}` : ""
    }`
  );

  return c.json({
    ok: true,
    voided_fuel_entry_id: fuelId,
    vehicle_id: vehicleId,
    current_odometer: maxOdo?.m ?? null,
  });
});

// Issues
api.get("/issues", async (c) => {
  const status = c.req.query("status");
  const report = c.req.query("report");
  /** YYYY-MM-DD — completed work finished that calendar day (local shop date string) */
  const completedOn = (c.req.query("completed_on") || "").slice(0, 10);
  const completedFrom = (c.req.query("completed_from") || "").slice(0, 10);
  const completedTo = (c.req.query("completed_to") || "").slice(0, 10);
  let sql = `SELECT i.*, v.unit_number, v.assigned_driver, u.display_name as reporter_name,
      uc.display_name as tech_confirmed_by_name,
      cb.display_name as completed_by_name
    FROM vehicle_issues i
    JOIN vehicles v ON v.id = i.vehicle_id
    JOIN users u ON u.id = i.reported_by_user_id
    LEFT JOIN users uc ON uc.id = i.tech_confirmed_by_user_id
    LEFT JOIN users cb ON cb.id = i.completed_by_user_id
    WHERE 1=1`;
  const binds: unknown[] = [];
  if (report === "schedule") {
    sql += " AND i.status IN ('open','scheduled','in_progress')";
  } else if (report === "needs_schedule") {
    // New tech requests waiting for shop to book a day
    sql += " AND i.status = 'open'";
  } else if (report === "completed_day" || completedOn || completedFrom || completedTo) {
    sql += " AND i.status = 'completed'";
    if (completedOn) {
      sql += " AND date(i.completed_at) = date(?)";
      binds.push(completedOn);
    } else {
      if (completedFrom) {
        sql += " AND date(i.completed_at) >= date(?)";
        binds.push(completedFrom);
      }
      if (completedTo) {
        sql += " AND date(i.completed_at) <= date(?)";
        binds.push(completedTo);
      }
      // Default: today if no range (completed_day report with no date)
      if (!completedFrom && !completedTo && report === "completed_day") {
        sql += " AND date(i.completed_at) = date('now')";
      }
    }
  } else if (status) {
    sql += " AND i.status = ?";
    binds.push(status);
  }
  const driverVids = await getDriverVehicleIds(c.env.DB, c.get("user"));
  if (driverVids !== null) {
    const sc = sqlInIds("i.vehicle_id", driverVids);
    sql += sc.clause;
    binds.push(...sc.binds);
  }
  const isCompletedReport =
    report === "completed_day" || Boolean(completedOn || completedFrom || completedTo);
  if (isCompletedReport) {
    sql += " ORDER BY i.completed_at DESC, i.id DESC";
  } else {
    // Unscheduled open first, then emergencies, then severity, newest
    sql += ` ORDER BY
    CASE WHEN i.status = 'open' THEN 0 WHEN i.status = 'scheduled' THEN 1 WHEN i.status = 'in_progress' THEN 2 ELSE 3 END,
    CASE WHEN IFNULL(i.is_emergency,0) = 1 THEN 0 ELSE 1 END,
    CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
    i.created_at DESC`;
  }
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  const issues = rows.results || [];
  const needsSchedule = issues.filter(
    (r) => String((r as { status?: string }).status || "") === "open"
  ).length;
  return c.json({ issues, needs_schedule: needsSchedule });
});

api.post("/issues", requireRoles(ROLE_PERMS.reportIssues), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    vehicle_id: number;
    title?: string;
    description?: string;
    severity?: string;
    photo_key?: string;
    issue_category?: string;
    is_emergency?: boolean;
    /** Mechanic logs shop work (no driver report / no tech appointment confirm) */
    shop_work?: boolean;
    origin?: string;
    status?: string;
    mechanic_diagnosis?: string | null;
    work_performed?: string | null;
    parts_used?: string | null;
    labor_hours?: number | string | null;
    completion_notes?: string | null;
    schedule_notes?: string | null;
    record_oil_change?: boolean | number;
    oil_odometer?: number | string | null;
    oil_interval_miles?: number | string | null;
  }>();
  if (!body.vehicle_id) {
    return c.json({ error: "vehicle_id required" }, 400);
  }

  const isShopWork =
    body.shop_work === true ||
    body.origin === "shop" ||
    String(body.origin || "").toLowerCase() === "shop";
  const canManageShop = (ROLE_PERMS.manageIssues as string[]).includes(user.role);

  // ——— Shop-originated work order (mechanic logs work done / in progress) ———
  if (isShopWork) {
    if (!canManageShop) {
      return c.json({ error: "Only shop staff can log shop work" }, 403);
    }
    const statusRaw = String(body.status || "completed").toLowerCase();
    const status =
      statusRaw === "in_progress" || statusRaw === "completed" || statusRaw === "open"
        ? statusRaw
        : "completed";
    const concerns = String(body.mechanic_diagnosis || "").trim();
    const workPerf = String(body.work_performed || "").trim();
    const problemFound = String(body.completion_notes || "").trim();
    const title =
      body.title?.trim() ||
      (concerns
        ? concerns.split(/\s*[·|]\s*/).filter(Boolean).slice(0, 3).join(" · ")
        : "") ||
      catalogEntry(body.issue_category)?.label ||
      "";
    if (!title) {
      return c.json(
        { error: "Enter work title or select vehicle / tech concerns" },
        400
      );
    }
    if (status === "completed") {
      if (!concerns && !problemFound) {
        return c.json(
          { error: "Check vehicle / tech concerns and/or enter problem found" },
          400
        );
      }
      if (!workPerf) {
        return c.json(
          { error: "Enter diagnostics and/or work performed before completing" },
          400
        );
      }
    }
    const severity = body.severity || "medium";
    const labor =
      body.labor_hours === "" || body.labor_hours == null || body.labor_hours === undefined
        ? null
        : Number(body.labor_hours);
    const laborBind = labor != null && Number.isFinite(labor) ? labor : null;

    const isCompleted = status === "completed";
    const result = await c.env.DB.prepare(
      `INSERT INTO vehicle_issues
        (vehicle_id, reported_by_user_id, severity, title, description, photo_key,
         issue_category, is_emergency, status, schedule_notes, completion_notes,
         mechanic_diagnosis, work_performed, parts_used, labor_hours,
         diagnosed_by_user_id, completed_by_user_id, completed_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, 'shop')`
    )
      .bind(
        body.vehicle_id,
        user.id,
        severity,
        title,
        body.description || null,
        body.photo_key || null,
        body.issue_category || null,
        status,
        body.schedule_notes || null,
        problemFound || null,
        concerns || null,
        workPerf || null,
        body.parts_used || null,
        laborBind,
        user.id,
        isCompleted ? user.id : null,
        isCompleted ? 1 : 0
      )
      .run();
    const id = result.meta.last_row_id as number;

    // Oil change tracking when shop logs completed oil work
    const diagnosisText = concerns;
    const recordOil =
      body.record_oil_change === true ||
      body.record_oil_change === 1 ||
      diagnosisText === "Oil change" ||
      diagnosisText.split(/\s*[·|]\s*/).includes("Oil change");
    if (status === "completed" && recordOil) {
      const odo =
        body.oil_odometer != null && body.oil_odometer !== ""
          ? Number(body.oil_odometer)
          : null;
      const defaultInterval = Number(
        await getSetting(c.env.DB, "oil_change_interval_miles", "5000")
      );
      const interval =
        body.oil_interval_miles != null ? Number(body.oil_interval_miles) : defaultInterval;
      const nextDue = odo != null ? odo + interval : null;
      await c.env.DB.prepare(
        `INSERT INTO service_records
          (vehicle_id, service_type, service_date, odometer, interval_miles, next_due_odometer, performed_by_user_id, notes)
         VALUES (?, 'oil_change', date('now'), ?, ?, ?, ?, ?)`
      )
        .bind(
          body.vehicle_id,
          odo,
          interval,
          nextDue,
          user.id,
          workPerf || problemFound || "Oil change"
        )
        .run();
      if (odo != null) {
        await c.env.DB.prepare(
          `UPDATE vehicles SET current_odometer = CASE
             WHEN current_odometer IS NULL OR current_odometer < ? THEN ?
             ELSE current_odometer END, updated_at = datetime('now') WHERE id = ?`
        )
          .bind(odo, odo, body.vehicle_id)
          .run();
      }
      await c.env.DB.prepare(
        `UPDATE vehicle_issues SET issue_category = COALESCE(issue_category, 'oil_change'),
         updated_at = datetime('now') WHERE id = ?`
      )
        .bind(id)
        .run();
    }

    // Unit in bay → out of service
    if (status === "in_progress") {
      const open = await c.env.DB.prepare(
        `SELECT id FROM downtime_events WHERE vehicle_id = ? AND ended_at IS NULL LIMIT 1`
      )
        .bind(body.vehicle_id)
        .first();
      if (!open) {
        await c.env.DB.prepare(
          `INSERT INTO downtime_events (vehicle_id, issue_id, reason, started_at, started_by_user_id, notes)
           VALUES (?, ?, ?, datetime('now'), ?, ?)`
        )
          .bind(
            body.vehicle_id,
            id,
            title,
            user.id,
            body.schedule_notes || problemFound || null
          )
          .run();
        await c.env.DB.prepare(
          `UPDATE vehicles SET status = 'out_of_service', updated_at = datetime('now') WHERE id = ?`
        )
          .bind(body.vehicle_id)
          .run();
      }
    }

    const unit = await c.env.DB.prepare("SELECT unit_number FROM vehicles WHERE id = ?")
      .bind(body.vehicle_id)
      .first<{ unit_number: string }>();
    const unitNo = unit?.unit_number || "?";

    // Supervisors / office see completed shop work day-to-day (not a "needs schedule" alert)
    if (status === "completed") {
      const watchers = await usersByRoles(c.env.DB, [
        "supervisor",
        "admin",
        "office",
      ]);
      const notifyIds = watchers.filter((uid) => uid !== user.id);
      if (notifyIds.length) {
        await notifyUsers(
          c.env.DB,
          notifyIds,
          "shop_work_logged",
          `Shop work done · Unit ${unitNo} · ${title.slice(0, 80)}`,
          `${user.display_name} logged completed shop work. Open Repairs → Done today.`,
          { type: "issue", id }
        );
      }
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "vehicle_issue",
      id,
      `Shop work (${status}): ${title}`
    );

    const issue = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?")
      .bind(id)
      .first();
    return c.json(
      {
        issue,
        shop_work: true,
        message:
          status === "completed"
            ? "Shop work logged as completed."
            : status === "in_progress"
              ? "Shop work started — unit marked out of service."
              : "Shop work ticket created.",
      },
      201
    );
  }

  // ——— Driver / field report (existing flow) ———
  const cat = catalogEntry(body.issue_category);
  const title =
    body.title?.trim() ||
    cat?.label ||
    "";
  if (!title) {
    return c.json({ error: "Pick an issue type or enter a title" }, 400);
  }
  const driverVids = await getDriverVehicleIds(c.env.DB, user);
  if (!assertDriverVehicleAccess(driverVids, body.vehicle_id)) {
    return c.json({ error: "You can only report issues for your assigned vehicle" }, 403);
  }

  const isEmergency = Boolean(body.is_emergency || cat?.emergency);
  const severity =
    body.severity || (isEmergency ? "critical" : cat?.severity) || "medium";

  // De-dupe: same reporter + vehicle + open emergency/same title within 5 min
  // (stops double-taps while phone push was slow from creating many tickets)
  const recentDup = await c.env.DB.prepare(
    `SELECT * FROM vehicle_issues
     WHERE reported_by_user_id = ?
       AND vehicle_id = ?
       AND status IN ('open','scheduled','in_progress')
       AND created_at >= datetime('now', '-5 minutes')
       AND (
         (? = 1 AND is_emergency = 1)
         OR (COALESCE(issue_category,'') = COALESCE(?, '') AND title = ?)
       )
     ORDER BY id DESC
     LIMIT 1`
  )
    .bind(
      user.id,
      body.vehicle_id,
      isEmergency ? 1 : 0,
      body.issue_category || null,
      title
    )
    .first();
  if (recentDup) {
    return c.json({
      issue: recentDup,
      emergency: isEmergency,
      duplicate: true,
      message: isEmergency
        ? "Emergency already reported — shop still has it in the app. Do not create a new ticket."
        : "Same request already submitted — open tickets are on the shop board.",
    });
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO vehicle_issues
      (vehicle_id, reported_by_user_id, severity, title, description, photo_key,
       issue_category, is_emergency, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'driver')`
  )
    .bind(
      body.vehicle_id,
      user.id,
      severity,
      title,
      body.description || null,
      body.photo_key || null,
      body.issue_category || null,
      isEmergency ? 1 : 0
    )
    .run();
  const id = result.meta.last_row_id as number;

  const unit = await c.env.DB.prepare("SELECT unit_number FROM vehicles WHERE id = ?")
    .bind(body.vehicle_id)
    .first<{ unit_number: string }>();

  // Individuals only: fleet manager (Chuck) + owner (Chris) + the requester
  const coreIds = await coreFleetNotifyIds(c.env.DB);
  const techs = [...new Set([...coreIds, user.id])];
  const unitNoEarly = unit?.unit_number || "?";
  const detailLine = (body.description || "").trim().slice(0, 160);
  const headline =
    detailLine && (body.issue_category === "other" || !cat?.label)
      ? detailLine
      : title;
  const alertBody =
    detailLine ||
    (isEmergency
      ? "Driver reported an emergency. Open Repairs in the app to schedule."
      : "Needs scheduling on the shop board — open Repairs in Field App.");
  const kind = isEmergency ? "flat_emergency" : "repair_request";
  const nTitle = isEmergency
    ? `EMERGENCY · Unit ${unitNoEarly} · ${headline}`
    : `Needs schedule · Unit ${unitNoEarly} · ${headline}`;
  await notifyAndSms(c.env, c.env.DB, techs, {
    kind,
    title: nTitle,
    body: alertBody,
    entity: { type: "issue", id },
    sms: shortSms(
      isEmergency
        ? `TA EMERGENCY unit ${unitNoEarly}: ${headline}. From ${user.display_name}. Open Repairs.`
        : `TA: Unit ${unitNoEarly} needs shop schedule · ${headline}. From ${user.display_name}.`
    ),
    excludeUserId: null,
    fromUserId: user.id,
    smsContext: `${kind}:${id}`,
  });

  await writeAudit(
    c.env.DB,
    user,
    "create",
    "vehicle_issue",
    id,
    isEmergency ? `EMERGENCY: ${title}` : `Issue: ${title}`
  );

  const base = (c.env.APP_BASE_URL || new URL(c.req.url).origin).replace(/\/$/, "");
  const unitNo = unit?.unit_number || "?";

  // Background: Discord + optional SMS to shop, plus nearby-driver in-app/SMS for emergencies
  const fanOutJob = alertFleetIncident(c.env, c.env.DB, {
    fromUserId: user.id,
    fromName: user.display_name,
    unitNumber: unitNo,
    vehicleId: body.vehicle_id,
    issueId: id,
    title,
    description: body.description,
    isEmergency,
    appBaseUrl: base,
  }).catch(() => null);

  scheduleWaitUntil(c, fanOutJob);

  const issue = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first();
  return c.json(
    {
      issue,
      emergency: isEmergency,
      notified_user_ids: techs,
      message: isEmergency
        ? "Emergency dispatched — shop notified in the app."
        : "Repair request submitted — shop notified.",
    },
    201
  );
});

api.get("/issues/common", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  const days = Number(c.req.query("days") || "90");
  const rows = await c.env.DB.prepare(
    `SELECT COALESCE(issue_category, 'uncategorized') as category,
            COUNT(*) as count,
            SUM(CASE WHEN is_emergency = 1 THEN 1 ELSE 0 END) as emergencies
     FROM vehicle_issues
     WHERE created_at >= datetime('now', ?)
     GROUP BY COALESCE(issue_category, 'uncategorized')
     ORDER BY count DESC
     LIMIT 30`
  )
    .bind(`-${Math.max(7, Math.min(days, 365))} days`)
    .all();
  return c.json({ common: rows.results, days });
});

api.patch("/issues/:id", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first<{
    id: number;
    vehicle_id: number;
    status: string;
    title: string;
    scheduled_date: string | null;
    schedule_notes: string | null;
    reported_by_user_id: number | null;
    mechanic_diagnosis: string | null;
  }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  const user = c.get("user");
  const body = await c.req.json<Record<string, unknown>>();
  const fields = [
    "severity",
    "title",
    "description",
    "status",
    "scheduled_date",
    "schedule_notes",
    "completion_notes",
    "photo_key",
    "issue_category",
    "mechanic_diagnosis",
    "work_performed",
    "parts_used",
    "labor_hours",
  ] as const;
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      values.push(body[f] === "" ? null : body[f]);
    }
  }
  if (body.is_emergency !== undefined) {
    sets.push("is_emergency = ?");
    values.push(body.is_emergency ? 1 : 0);
  }
  if (
    body.mechanic_diagnosis !== undefined ||
    body.work_performed !== undefined ||
    body.parts_used !== undefined
  ) {
    sets.push("diagnosed_by_user_id = ?");
    values.push(user.id);
  }
  if (body.status === "completed") {
    sets.push("completed_at = datetime('now')");
    sets.push("completed_by_user_id = ?");
    values.push(user.id);
  }
  // Optional: log oil change when completing shop work
  const recordOil = body.record_oil_change === true || body.record_oil_change === 1;
  if (!sets.length && !recordOil) return c.json({ error: "No fields" }, 400);
  // Preview next status/date so we can reset tech confirmation on re-schedule
  const nextStatusPreview =
    body.status !== undefined ? String(body.status) : before.status;
  const nextDatePreview =
    body.scheduled_date !== undefined
      ? body.scheduled_date === "" || body.scheduled_date == null
        ? null
        : String(body.scheduled_date).slice(0, 10)
      : (before.scheduled_date || "").slice(0, 10) || null;
  const prevDatePreview = (before.scheduled_date || "").slice(0, 10) || null;
  const scheduleNeedsConfirm =
    nextStatusPreview === "scheduled" &&
    (before.status !== "scheduled" || prevDatePreview !== nextDatePreview);
  if (scheduleNeedsConfirm) {
    sets.push("tech_confirm_status = 'pending'");
    sets.push("tech_confirmed_at = NULL");
    sets.push("tech_confirmed_by_user_id = NULL");
    sets.push("tech_confirm_note = NULL");
  }

  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    values.push(id);
    await c.env.DB.prepare(`UPDATE vehicle_issues SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }
  const after = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first<{
    id: number;
    vehicle_id: number;
    status: string;
    title: string;
    scheduled_date: string | null;
    schedule_notes: string | null;
    reported_by_user_id: number | null;
  }>();

  const diagnosisText = String(body.mechanic_diagnosis || before.mechanic_diagnosis || "");
  if (
    recordOil ||
    diagnosisText === "Oil change" ||
    diagnosisText.split(/\s*[·|]\s*/).includes("Oil change")
  ) {
    const odo =
      body.oil_odometer != null && body.oil_odometer !== ""
        ? Number(body.oil_odometer)
        : null;
    const defaultInterval = Number(await getSetting(c.env.DB, "oil_change_interval_miles", "5000"));
    const interval = body.oil_interval_miles != null ? Number(body.oil_interval_miles) : defaultInterval;
    const nextDue = odo != null ? odo + interval : null;
    await c.env.DB.prepare(
      `INSERT INTO service_records
        (vehicle_id, service_type, service_date, odometer, interval_miles, next_due_odometer, performed_by_user_id, notes)
       VALUES (?, 'oil_change', date('now'), ?, ?, ?, ?, ?)`
    )
      .bind(
        before.vehicle_id,
        odo,
        interval,
        nextDue,
        user.id,
        body.work_performed || body.completion_notes || "Oil change"
      )
      .run();
    if (odo != null) {
      await c.env.DB.prepare(
        `UPDATE vehicles SET current_odometer = CASE
           WHEN current_odometer IS NULL OR current_odometer < ? THEN ?
           ELSE current_odometer END, updated_at = datetime('now') WHERE id = ?`
      )
        .bind(odo, odo, before.vehicle_id)
        .run();
    }
    await c.env.DB.prepare(
      `UPDATE vehicle_issues SET issue_category = COALESCE(issue_category, 'oil_change'),
       updated_at = datetime('now') WHERE id = ?`
    )
      .bind(id)
      .run();
  }

  // Downtime / out-of-service: only when the van is actually in the shop (in progress).
  // Booking a future schedule must NOT mark the unit down — tech still drives until then.
  const nextStatus = String((after as { status?: string } | null)?.status || body.status || before.status);
  if (nextStatus === "in_progress" && before.status !== "in_progress") {
    const open = await c.env.DB.prepare(
      `SELECT id FROM downtime_events WHERE vehicle_id = ? AND ended_at IS NULL LIMIT 1`
    )
      .bind(before.vehicle_id)
      .first();
    if (!open) {
      await c.env.DB.prepare(
        `INSERT INTO downtime_events (vehicle_id, issue_id, reason, started_at, started_by_user_id, notes)
         VALUES (?, ?, ?, datetime('now'), ?, ?)`
      )
        .bind(
          before.vehicle_id,
          id,
          before.title,
          user.id,
          body.schedule_notes || body.completion_notes || null
        )
        .run();
      await c.env.DB.prepare(
        `UPDATE vehicles SET status = 'out_of_service', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(before.vehicle_id)
        .run();
    }
  }
  if (nextStatus === "completed" || nextStatus === "cancelled") {
    await c.env.DB.prepare(
      `UPDATE downtime_events SET ended_at = datetime('now'), ended_by_user_id = ?
       WHERE vehicle_id = ? AND issue_id = ? AND ended_at IS NULL`
    )
      .bind(user.id, before.vehicle_id, id)
      .run();
    // Return vehicle to active if no other open downtime
    const stillDown = await c.env.DB.prepare(
      `SELECT id FROM downtime_events WHERE vehicle_id = ? AND ended_at IS NULL LIMIT 1`
    )
      .bind(before.vehicle_id)
      .first();
    if (!stillDown) {
      await c.env.DB.prepare(
        `UPDATE vehicles SET status = 'active', updated_at = datetime('now') WHERE id = ?`
      )
        .bind(before.vehicle_id)
        .run();
    }
  }

  // Tell the tech / assigned driver when the shop books, changes, finishes, or cancels work
  let fieldNotified = 0;
  let fieldNotifyWarning: string | null = null;
  const afterRow = after as {
    status: string;
    scheduled_date: string | null;
    schedule_notes: string | null;
    title: string;
    reported_by_user_id: number | null;
  } | null;
  if (afterRow) {
    const prevDate = (before.scheduled_date || "").slice(0, 10);
    const nextDate = (afterRow.scheduled_date || "").slice(0, 10);
    const becameScheduled =
      afterRow.status === "scheduled" &&
      (before.status !== "scheduled" || prevDate !== nextDate);
    const becameInProgress =
      afterRow.status === "in_progress" && before.status !== "in_progress";
    const becameCompleted =
      afterRow.status === "completed" && before.status !== "completed";
    const becameCancelled =
      afterRow.status === "cancelled" && before.status !== "cancelled";

    if (becameScheduled || becameInProgress || becameCompleted || becameCancelled) {
      const unit = await c.env.DB.prepare("SELECT unit_number FROM vehicles WHERE id = ?")
        .bind(before.vehicle_id)
        .first<{ unit_number: string }>();
      const unitNo = unit?.unit_number || "?";
      const notes = (afterRow.schedule_notes || "").trim();
      let kind = "repair_update";
      let title = `Repair update · Unit ${unitNo}`;
      let detail = afterRow.title;

      if (becameScheduled) {
        kind = "repair_scheduled";
        title = nextDate
          ? `Bring unit ${unitNo} to shop · ${nextDate}`
          : `Unit ${unitNo} scheduled for shop`;
        detail = [
          afterRow.title,
          nextDate ? `Shop date: ${nextDate}` : null,
          notes || null,
          "Open the app → Repairs for details.",
        ]
          .filter(Boolean)
          .join(" · ");
      } else if (becameInProgress) {
        kind = "repair_in_progress";
        title = `Unit ${unitNo} is in the shop`;
        detail = `${afterRow.title}${notes ? ` · ${notes}` : ""}`;
      } else if (becameCompleted) {
        kind = "repair_completed";
        title = `Unit ${unitNo} repair complete`;
        detail = afterRow.title;
      } else if (becameCancelled) {
        kind = "repair_cancelled";
        title = `Shop job cancelled · Unit ${unitNo}`;
        detail = [afterRow.title, notes || null].filter(Boolean).join(" · ");
      }

      const fieldIds = await userIdsForIssue(c.env.DB, {
        vehicleId: before.vehicle_id,
        reportedByUserId: afterRow.reported_by_user_id ?? before.reported_by_user_id,
        excludeUserId: user.id,
      });
      // Tech on the unit + Chris (in the know). Actor (often Chuck) excluded below.
      const coreIds = await coreFleetNotifyIds(c.env.DB);
      const notifyIds = [...new Set([...fieldIds, ...coreIds])];
      if (notifyIds.length) {
        // Personal SMS — individuals on this job, not fleet-wide role groups
        let smsText: string | null = null;
        if (becameScheduled) {
          smsText = shortSms(
            nextDate
              ? `TA: Bring unit ${unitNo} to shop on ${nextDate}. ${afterRow.title}${notes ? ` · ${notes}` : ""}. Open app to CONFIRM.`
              : `TA: Unit ${unitNo} scheduled for shop. ${afterRow.title}${notes ? ` · ${notes}` : ""}. Open app to CONFIRM.`
          );
        } else if (becameCancelled) {
          smsText = shortSms(`TA: Shop job cancelled for unit ${unitNo}. ${afterRow.title}`);
        } else if (becameCompleted) {
          smsText = shortSms(`TA: Unit ${unitNo} repair complete. ${afterRow.title}`);
        } else if (becameInProgress) {
          smsText = shortSms(`TA: Unit ${unitNo} is in the shop. ${afterRow.title}`);
        }
        const r = await notifyAndSms(c.env, c.env.DB, notifyIds, {
          kind,
          title,
          body: detail,
          entity: { type: "issue", id },
          sms: smsText,
          excludeUserId: user.id,
          fromUserId: user.id,
          smsContext: `${kind}:${id}:${nextDate || afterRow.status}`,
        });
        fieldNotified = r.notified;
      } else if (becameScheduled) {
        fieldNotifyWarning =
          "Scheduled, but no Field App user is linked to this unit (assigned driver / reporter). Call or text them manually, and fix vehicle assignment under Vehicles.";
      }
    }
  }

  await writeAudit(c.env.DB, user, "update", "vehicle_issue", id, "Updated issue", before, after);
  return c.json({
    issue: after,
    field_notified: fieldNotified,
    field_notify_warning: fieldNotifyWarning,
  });
});

/**
 * Tech confirms or declines a shop appointment (accountability).
 * Allowed for users linked to the unit (assigned driver / reporter).
 */
api.post("/issues/:id/confirm-schedule", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ action?: string; note?: string }>().catch(() => ({}));
  const action = (body.action || "").toLowerCase();
  if (action !== "confirm" && action !== "decline") {
    return c.json({ error: "action must be confirm or decline" }, 400);
  }
  const note = (body.note || "").trim();
  if (action === "decline" && !note) {
    return c.json({ error: "Add a short reason when you can’t make the appointment." }, 400);
  }

  const issue = await c.env.DB.prepare(
    `SELECT i.*, v.unit_number
     FROM vehicle_issues i
     JOIN vehicles v ON v.id = i.vehicle_id
     WHERE i.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      vehicle_id: number;
      status: string;
      title: string;
      scheduled_date: string | null;
      schedule_notes: string | null;
      reported_by_user_id: number | null;
      unit_number: string;
      tech_confirm_status: string | null;
    }>();
  if (!issue) return c.json({ error: "Not found" }, 404);
  if (issue.status !== "scheduled") {
    return c.json({ error: "Only scheduled shop appointments can be confirmed." }, 400);
  }

  // Shop roles can always act; field techs only if linked to the unit
  const shopRoles = ["admin", "mechanic", "office"];
  if (!shopRoles.includes(user.role)) {
    const allowed = await userIdsForIssue(c.env.DB, {
      vehicleId: issue.vehicle_id,
      reportedByUserId: issue.reported_by_user_id,
    });
    if (!allowed.includes(user.id)) {
      return c.json({ error: "This appointment is not for your unit." }, 403);
    }
  }

  const status = action === "confirm" ? "confirmed" : "declined";
  try {
    await c.env.DB.prepare(
      `UPDATE vehicle_issues SET
         tech_confirm_status = ?,
         tech_confirmed_at = datetime('now'),
         tech_confirmed_by_user_id = ?,
         tech_confirm_note = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(status, user.id, note || null, id)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column|tech_confirm/i.test(msg)) {
      return c.json(
        { error: "Run migration 062_issue_schedule_confirm.sql to enable confirmations." },
        503
      );
    }
    throw e;
  }

  const unitNo = issue.unit_number || "?";
  const when = (issue.scheduled_date || "").slice(0, 10) || "TBD";
  await writeAudit(
    c.env.DB,
    user,
    "update",
    "vehicle_issue",
    id,
    action === "confirm"
      ? `Tech confirmed shop appointment unit ${unitNo} · ${when}`
      : `Tech declined shop appointment unit ${unitNo} · ${when}: ${note}`
  );

  // Decline is actionable — notify fleet manager + owner only (not whole shop group)
  if (action === "decline") {
    const shopIds = await coreFleetNotifyIds(c.env.DB);
    await notifyAndSms(c.env, c.env.DB, shopIds, {
      kind: "repair_confirm_declined",
      title: `Tech can’t make shop date · Unit ${unitNo}`,
      body: `${user.display_name} declined ${when}: ${note} · ${issue.title}`,
      entity: { type: "issue", id },
      sms: shortSms(
        `TA: ${user.display_name} can’t bring unit ${unitNo} on ${when}. Reason: ${note}`
      ),
      excludeUserId: user.id,
      fromUserId: user.id,
      smsContext: `repair_declined:${id}:${when}`,
    });
  }

  const row = await c.env.DB.prepare(
    `SELECT i.*, v.unit_number, v.assigned_driver, u.display_name as reporter_name,
            uc.display_name as tech_confirmed_by_name
     FROM vehicle_issues i
     JOIN vehicles v ON v.id = i.vehicle_id
     JOIN users u ON u.id = i.reported_by_user_id
     LEFT JOIN users uc ON uc.id = i.tech_confirmed_by_user_id
     WHERE i.id = ?`
  )
    .bind(id)
    .first();

  return c.json({
    ok: true,
    tech_confirm_status: status,
    issue: row,
  });
});

// ——— Service records (oil changes) ———
api.get("/service", requireRoles([...ROLE_PERMS.manageIssues, "driver"] as Role[]), async (c) => {
  const vehicleId = c.req.query("vehicle_id");
  const type = c.req.query("type") || "oil_change";
  const driverVids = await getDriverVehicleIds(c.env.DB, c.get("user"));
  let sql = `SELECT s.*, v.unit_number, v.current_odometer, u.display_name as performed_by_name
    FROM service_records s
    JOIN vehicles v ON v.id = s.vehicle_id
    LEFT JOIN users u ON u.id = s.performed_by_user_id
    WHERE s.service_type = ?`;
  const binds: unknown[] = [type];
  if (vehicleId) {
    sql += " AND s.vehicle_id = ?";
    binds.push(Number(vehicleId));
  }
  if (driverVids !== null) {
    const sc = sqlInIds("s.vehicle_id", driverVids);
    sql += sc.clause;
    binds.push(...sc.binds);
  }
  sql += " ORDER BY s.service_date DESC, s.id DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ records: rows.results });
});

api.get("/service/due", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  // Latest oil change per vehicle vs current odometer
  const rows = await c.env.DB.prepare(
    `SELECT v.id as vehicle_id, v.unit_number, v.current_odometer, v.assigned_driver,
       s.service_date as last_service_date, s.odometer as last_service_odometer,
       s.interval_miles, s.next_due_odometer, s.next_due_date,
       CASE
         -- Only after first oil change is logged — no due flag until tracking starts
         WHEN s.id IS NULL THEN 0
         WHEN s.next_due_odometer IS NOT NULL AND v.current_odometer IS NOT NULL
              AND v.current_odometer >= s.next_due_odometer THEN 1
         WHEN s.next_due_odometer IS NOT NULL AND v.current_odometer IS NOT NULL
              AND v.current_odometer >= s.next_due_odometer - 500 THEN 1
         ELSE 0
       END as due_soon
     FROM vehicles v
     LEFT JOIN service_records s ON s.id = (
       SELECT s2.id FROM service_records s2
       WHERE s2.vehicle_id = v.id AND s2.service_type = 'oil_change'
       ORDER BY s2.service_date DESC, s2.id DESC LIMIT 1
     )
     WHERE v.status != 'retired'
     ORDER BY due_soon DESC, v.unit_number`
  ).all();
  return c.json({ vehicles: rows.results });
});

api.post("/service", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    vehicle_id: number;
    service_type?: string;
    service_date: string;
    odometer?: number | null;
    interval_miles?: number;
    notes?: string;
  }>();
  if (!body.vehicle_id || !body.service_date) {
    return c.json({ error: "vehicle_id and service_date required" }, 400);
  }
  const defaultInterval = Number(await getSetting(c.env.DB, "oil_change_interval_miles", "5000"));
  const interval = body.interval_miles ?? defaultInterval;
  const odo = body.odometer != null ? Number(body.odometer) : null;
  const nextDue = odo != null ? odo + interval : null;

  const result = await c.env.DB.prepare(
    `INSERT INTO service_records
      (vehicle_id, service_type, service_date, odometer, interval_miles, next_due_odometer, performed_by_user_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.vehicle_id,
      body.service_type || "oil_change",
      body.service_date,
      odo,
      interval,
      nextDue,
      user.id,
      body.notes || null
    )
    .run();

  if (odo != null) {
    await c.env.DB.prepare(
      `UPDATE vehicles SET current_odometer = CASE
         WHEN current_odometer IS NULL OR current_odometer < ? THEN ?
         ELSE current_odometer END, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(odo, odo, body.vehicle_id)
      .run();
  }

  const id = result.meta.last_row_id;
  await writeAudit(
    c.env.DB,
    user,
    "create",
    "service_record",
    id,
    `Oil change unit ${body.vehicle_id} @ ${odo ?? "?"} mi — next ~${nextDue ?? "?"}`
  );
  // Close any open auto oil-change jobs for this unit
  await c.env.DB.prepare(
    `UPDATE vehicle_issues SET status = 'completed', completed_at = datetime('now'),
     completed_by_user_id = ?, work_performed = COALESCE(work_performed, 'Oil change completed'),
     updated_at = datetime('now')
     WHERE vehicle_id = ? AND issue_category = 'oil_change'
       AND status IN ('open','scheduled','in_progress')`
  )
    .bind(user.id, body.vehicle_id)
    .run();

  const row = await c.env.DB.prepare(
    `SELECT s.*, v.unit_number FROM service_records s
     JOIN vehicles v ON v.id = s.vehicle_id WHERE s.id = ?`
  )
    .bind(id)
    .first();
  return c.json({ record: row }, 201);
});

/** Mechanic adjusts next oil due mileage / interval on the latest service record. */
api.patch("/service/:id", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM service_records WHERE id = ?")
    .bind(id)
    .first<{
      id: number;
      vehicle_id: number;
      odometer: number | null;
      interval_miles: number;
      next_due_odometer: number | null;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    interval_miles?: number;
    next_due_odometer?: number | null;
    notes?: string;
  }>();
  let interval = body.interval_miles ?? before.interval_miles;
  let nextDue =
    body.next_due_odometer !== undefined
      ? body.next_due_odometer
      : body.interval_miles != null && before.odometer != null
        ? before.odometer + body.interval_miles
        : before.next_due_odometer;

  await c.env.DB.prepare(
    `UPDATE service_records SET interval_miles = ?, next_due_odometer = ?,
     notes = COALESCE(?, notes) WHERE id = ?`
  )
    .bind(interval, nextDue, body.notes !== undefined ? body.notes : null, id)
    .run();

  // If mechanic pushed next due into the future, cancel open oil-due tickets
  const veh = await c.env.DB.prepare("SELECT current_odometer FROM vehicles WHERE id = ?")
    .bind(before.vehicle_id)
    .first<{ current_odometer: number | null }>();
  if (nextDue != null && veh?.current_odometer != null && veh.current_odometer < nextDue) {
    await c.env.DB.prepare(
      `UPDATE vehicle_issues SET status = 'cancelled', updated_at = datetime('now'),
       completion_notes = 'Rescheduled by mechanic'
       WHERE vehicle_id = ? AND issue_category = 'oil_change'
         AND status IN ('open','scheduled','in_progress')`
    )
      .bind(before.vehicle_id)
      .run();
  }

  const after = await c.env.DB.prepare(
    `SELECT s.*, v.unit_number FROM service_records s
     JOIN vehicles v ON v.id = s.vehicle_id WHERE s.id = ?`
  )
    .bind(id)
    .first();
  await writeAudit(c.env.DB, c.get("user"), "update", "service_record", id, "Adjusted oil schedule");
  return c.json({ record: after });
});

// ——— In-app notifications ———
api.get("/notifications", async (c) => {
  const user = c.get("user");
  // Light-touch: weekly checks + shop bring-in today + aging ops items
  try {
    await notifyWeeklyChecksDue(c.env.DB);
  } catch {
    /* optional */
  }
  try {
    await notifyShopBringInsToday(c.env.DB, c.env);
  } catch {
    /* optional */
  }
  try {
    await notifyOpsActionItems(c.env.DB);
  } catch {
    /* optional */
  }
  // Exclude legacy team-chat alerts (messaging UI removed)
  const rows = await c.env.DB.prepare(
    `SELECT * FROM notifications WHERE user_id = ?
       AND kind NOT LIKE 'message%'
     ORDER BY created_at DESC LIMIT 50`
  )
    .bind(user.id)
    .all();
  const unread = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM notifications
     WHERE user_id = ? AND read_at IS NULL AND kind NOT LIKE 'message%'`
  )
    .bind(user.id)
    .first<{ c: number }>();
  return c.json({ notifications: rows.results, unread: unread?.c ?? 0 });
});

api.post("/notifications/read", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ id?: number; all?: boolean }>();
  if (body.all) {
    await c.env.DB.prepare(
      `UPDATE notifications SET read_at = datetime('now')
       WHERE user_id = ? AND read_at IS NULL`
    )
      .bind(user.id)
      .run();
  } else if (body.id) {
    await markNotificationRead(c.env.DB, user, body.id);
  } else {
    return c.json({ error: "id or all required" }, 400);
  }
  return c.json({ ok: true });
});

api.post("/notifications/weekly-remind", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  const n = await notifyWeeklyChecksDue(c.env.DB);
  return c.json({ created: n });
});

api.post("/notifications/shop-bring-in-remind", requireRoles(ROLE_PERMS.manageIssues), async (c) => {
  const n = await notifyShopBringInsToday(c.env.DB, c.env);
  return c.json({ created: n });
});

/** Office TV wallboard — one payload for glance view (auto-refresh client). */
api.get(
  "/tv-board",
  requireRoles(["admin", "office", "viewer", "mechanic", "supervisor"] as Role[]),
  async (c) => {
  const today = (() => {
    try {
      return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
    } catch {
      return new Date().toISOString().slice(0, 10);
    }
  })();

  const shopToday = await c.env.DB.prepare(
    `SELECT i.id, i.title, i.status, i.severity, i.scheduled_date, i.schedule_notes,
            i.is_emergency, v.unit_number, v.assigned_driver, u.display_name as reporter_name
     FROM vehicle_issues i
     JOIN vehicles v ON v.id = i.vehicle_id
     LEFT JOIN users u ON u.id = i.reported_by_user_id
     WHERE i.status IN ('scheduled', 'in_progress')
       AND (
         i.status = 'in_progress'
         OR (i.scheduled_date IS NOT NULL AND substr(i.scheduled_date, 1, 10) = ?)
       )
     ORDER BY
       CASE WHEN i.status = 'in_progress' THEN 0 ELSE 1 END,
       CASE WHEN IFNULL(i.is_emergency,0) = 1 THEN 0 ELSE 1 END,
       i.scheduled_date IS NULL, i.scheduled_date, i.id
     LIMIT 40`
  )
    .bind(today)
    .all();

  const needsSchedule = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicle_issues WHERE status = 'open'`
  ).first<{ c: number }>();

  const emergencies = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicle_issues
     WHERE status IN ('open','scheduled','in_progress')
       AND (IFNULL(is_emergency,0) = 1 OR severity = 'critical')`
  ).first<{ c: number }>();

  const oos = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicles WHERE status = 'out_of_service'`
  ).first<{ c: number }>();

  const weeklyDue = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicles v
     WHERE v.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM inspections i
         WHERE i.vehicle_id = v.id AND i.inspection_date >= date('now', '-7 days')
       )`
  ).first<{ c: number }>();

  let warranties = 0;
  let pickups = 0;
  let dropoffs = 0;
  let vendorRuns = 0;
  try {
    warranties = await countWarrantyNeedsAttention(c.env.DB);
  } catch {
    /* optional */
  }
  try {
    const p = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM part_pickup_tickets WHERE status IN ('open','partial')`
    ).first<{ c: number }>();
    pickups = p?.c ?? 0;
  } catch {
    /* optional */
  }
  try {
    const d = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM parts_dropoffs WHERE status = 'waiting'`
    ).first<{ c: number }>();
    dropoffs = d?.c ?? 0;
  } catch {
    /* optional */
  }
  try {
    const vr = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM vendor_runs WHERE status IN ('open','waiting','ready')`
    ).first<{ c: number }>();
    vendorRuns = vr?.c ?? 0;
  } catch {
    /* optional */
  }

  return c.json({
    generated_at: new Date().toISOString(),
    shop_date: today,
    company: "Total Assurance A/C & Heating",
    shop_today: shopToday.results || [],
    counts: {
      emergencies: emergencies?.c ?? 0,
      needs_schedule: needsSchedule?.c ?? 0,
      out_of_service: oos?.c ?? 0,
      weekly_checks_due: weeklyDue?.c ?? 0,
      open_warranties: warranties,
      pickups_waiting: pickups,
      parts_dropoffs: dropoffs,
      vendor_runs: vendorRuns,
    },
  });
});

// ——— Company reviews board (Google highlights + team celebration) ———
const DEFAULT_GOOGLE_REVIEWS_URL = "https://share.google/p9PJud1fI4iSmPCpq";

api.get("/reviews", async (c) => {
  const googleUrl =
    (await getSetting(c.env.DB, "google_reviews_url", DEFAULT_GOOGLE_REVIEWS_URL)) ||
    DEFAULT_GOOGLE_REVIEWS_URL;
  try {
    const rows = await c.env.DB.prepare(
      `SELECT r.id, r.author_name, r.rating, r.review_text, r.tech_mentioned, r.review_date,
              r.source_url, r.created_at, r.posted_by_user_id, u.display_name as posted_by_name
       FROM company_reviews r
       LEFT JOIN users u ON u.id = r.posted_by_user_id
       WHERE r.active = 1
       ORDER BY datetime(r.created_at) DESC
       LIMIT 100`
    ).all();
    return c.json({
      reviews: rows.results || [],
      google_reviews_url: googleUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        reviews: [],
        google_reviews_url: googleUrl,
        error: "Run migration 031_company_reviews.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/reviews", requireRoles(["admin", "office", "supervisor"]), async (c) => {
  const admin = c.get("user");
  const body = await c.req.json<{
    author_name?: string;
    rating?: number;
    review_text?: string;
    tech_mentioned?: string;
    review_date?: string;
    source_url?: string;
    notify?: boolean;
  }>();
  const text = (body.review_text || "").trim();
  if (!text) return c.json({ error: "Review text is required" }, 400);
  if (text.length > 4000) return c.json({ error: "Review text is too long" }, 400);
  let rating: number | null = null;
  if (body.rating != null && String(body.rating).trim() !== "") {
    const n = Number(body.rating);
    if (!Number.isFinite(n) || n < 1 || n > 5) {
      return c.json({ error: "Rating must be 1–5 stars" }, 400);
    }
    rating = Math.round(n);
  }
  const googleUrl =
    (await getSetting(c.env.DB, "google_reviews_url", DEFAULT_GOOGLE_REVIEWS_URL)) ||
    DEFAULT_GOOGLE_REVIEWS_URL;
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO company_reviews (
         author_name, rating, review_text, tech_mentioned, review_date, source_url, posted_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        body.author_name?.trim() || null,
        rating,
        text,
        body.tech_mentioned?.trim() || null,
        body.review_date?.trim() || null,
        body.source_url?.trim() || googleUrl,
        admin.id
      )
      .run();
    const id = Number(result.meta.last_row_id);
    await writeAudit(
      c.env.DB,
      admin,
      "create",
      "review",
      id,
      `Posted company review${body.tech_mentioned ? ` · ${body.tech_mentioned}` : ""}`
    );

    // Notify whole team so everyone can celebrate (default on)
    if (body.notify !== false) {
      const all = await c.env.DB.prepare(`SELECT id FROM users WHERE active = 1`)
        .all<{ id: number }>()
        .catch(() => ({ results: [] as { id: number }[] }));
      const ids = (all.results || []).map((r) => r.id).filter((uid) => uid !== admin.id);
      const stars = rating ? `${"★".repeat(rating)}${"☆".repeat(5 - rating)} ` : "";
      const who = body.tech_mentioned?.trim()
        ? ` · shout-out: ${body.tech_mentioned.trim()}`
        : "";
      const preview = text.length > 120 ? `${text.slice(0, 117)}…` : text;
      await notifyUsers(
        c.env.DB,
        ids,
        "company_review",
        `${stars}New Google review${who}`,
        preview,
        { type: "review", id }
      );
    }

    const row = await c.env.DB.prepare(
      `SELECT r.id, r.author_name, r.rating, r.review_text, r.tech_mentioned, r.review_date,
              r.source_url, r.created_at, r.posted_by_user_id, u.display_name as posted_by_name
       FROM company_reviews r
       LEFT JOIN users u ON u.id = r.posted_by_user_id
       WHERE r.id = ?`
    )
      .bind(id)
      .first();
    return c.json({ review: row }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 031_company_reviews.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

api.delete("/reviews/:id", requireRoles(["admin"]), async (c) => {
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  try {
    await c.env.DB.prepare(
      `UPDATE company_reviews SET active = 0 WHERE id = ?`
    )
      .bind(id)
      .run();
    await writeAudit(c.env.DB, c.get("user"), "delete", "review", id, "Hid company review");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});


// ——— In-app messenger (threaded conversations + thumbs-up acks) ———

type MsgConvRow = {
  id: number;
  subject: string;
  is_team: number;
  created_by_user_id: number;
  last_message_at: string;
  created_at: string;
};

/**
 * Backfill pre-thread messages into conversations.
 * Keep batches tiny — large backfills timed out D1 and made the app hang on open.
 */
async function backfillMessageConversations(db: D1Database, limit = 8): Promise<void> {
  try {
    const orphan = await db
      .prepare(
        `SELECT id, from_user_id, to_user_id, body, created_at
         FROM app_messages
         WHERE conversation_id IS NULL
         ORDER BY id ASC
         LIMIT ?`
      )
      .bind(Math.min(20, Math.max(1, limit)))
      .all<{
        id: number;
        from_user_id: number;
        to_user_id: number | null;
        body: string;
        created_at: string;
      }>();
    for (const m of orphan.results || []) {
      const subj =
        m.body.length > 48 ? `${m.body.slice(0, 48).trim()}…` : m.body.trim() || "Message";
      const isTeam = m.to_user_id == null ? 1 : 0;
      const cr = await db
        .prepare(
          `INSERT INTO app_conversations (subject, is_team, created_by_user_id, last_message_at, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(subj, isTeam, m.from_user_id, m.created_at, m.created_at)
        .run();
      const cid = Number(cr.meta.last_row_id);
      await db
        .prepare(`UPDATE app_messages SET conversation_id = ? WHERE id = ?`)
        .bind(cid, m.id)
        .run();
      await db
        .prepare(
          `INSERT OR IGNORE INTO app_conversation_members (conversation_id, user_id) VALUES (?, ?)`
        )
        .bind(cid, m.from_user_id)
        .run();
      if (m.to_user_id) {
        await db
          .prepare(
            `INSERT OR IGNORE INTO app_conversation_members (conversation_id, user_id) VALUES (?, ?)`
          )
          .bind(cid, m.to_user_id)
          .run();
      }
    }
  } catch {
    /* tables may not exist yet */
  }
}

async function userCanAccessConversation(
  db: D1Database,
  userId: number,
  convId: number
): Promise<MsgConvRow | null> {
  const conv = await db
    .prepare(`SELECT * FROM app_conversations WHERE id = ?`)
    .bind(convId)
    .first<MsgConvRow>();
  if (!conv) return null;
  if (conv.is_team) return conv;
  const mem = await db
    .prepare(
      `SELECT 1 as ok FROM app_conversation_members WHERE conversation_id = ? AND user_id = ?`
    )
    .bind(convId, userId)
    .first<{ ok: number }>();
  return mem ? conv : null;
}

async function countUnreadMessages(db: D1Database, userId: number): Promise<number> {
  // Fast path: direct to-user + team broadcasts (no member-table scan)
  try {
    const unread = await db
      .prepare(
        `SELECT COUNT(*) as c FROM app_messages m
         WHERE m.from_user_id != ?
           AND (m.to_user_id = ? OR m.to_user_id IS NULL)
           AND NOT EXISTS (
             SELECT 1 FROM app_message_reads r WHERE r.message_id = m.id AND r.user_id = ?
           )`
      )
      .bind(userId, userId, userId)
      .first<{ c: number }>();
    return unread?.c ?? 0;
  } catch {
    return 0;
  }
}

api.get("/messages", async (c) => {
  const user = c.get("user");
  const peek = c.req.query("peek") === "1" || c.req.query("light") === "1";
  const limit = peek
    ? Math.min(12, Math.max(1, Number(c.req.query("limit") || "5")))
    : Math.min(100, Math.max(20, Number(c.req.query("limit") || "50")));
  const sinceId = Number(c.req.query("since_id") || "0");
  try {
    // Never backfill on peek/poll — that was freezing the whole app on open
    if (!peek) {
      await backfillMessageConversations(c.env.DB, 8);
    }

    // Lightweight poll for toast / badge (no acks, no conversation join)
    if (peek) {
      let sql = `SELECT m.id, m.from_user_id, m.to_user_id, m.body, m.created_at, m.conversation_id,
                        fu.display_name as from_name
                 FROM app_messages m
                 JOIN users fu ON fu.id = m.from_user_id
                 WHERE (m.from_user_id = ? OR m.to_user_id = ? OR m.to_user_id IS NULL)`;
      const binds: (string | number)[] = [user.id, user.id];
      if (sinceId > 0) {
        sql += ` AND m.id > ?`;
        binds.push(sinceId);
      }
      sql += ` ORDER BY m.id DESC LIMIT ?`;
      binds.push(limit);
      const rows = await c.env.DB.prepare(sql).bind(...binds).all();
      const unread = await countUnreadMessages(c.env.DB, user.id);
      const maxRow = await c.env.DB.prepare(`SELECT MAX(id) as max_id FROM app_messages`).first<{
        max_id: number | null;
      }>();
      return c.json({
        messages: rows.results || [],
        unread,
        max_id: maxRow?.max_id ?? 0,
      });
    }

    let sql = `SELECT m.*, fu.display_name as from_name, tu.display_name as to_name,
              (SELECT 1 FROM app_message_reads r WHERE r.message_id = m.id AND r.user_id = ?) as is_read,
              (SELECT COUNT(*) FROM app_message_acks a WHERE a.message_id = m.id) as ack_count,
              (SELECT 1 FROM app_message_acks a WHERE a.message_id = m.id AND a.user_id = ?) as i_acked,
              c.subject as conversation_subject
       FROM app_messages m
       JOIN users fu ON fu.id = m.from_user_id
       LEFT JOIN users tu ON tu.id = m.to_user_id
       LEFT JOIN app_conversations c ON c.id = m.conversation_id
       WHERE (m.from_user_id = ?
          OR m.to_user_id = ?
          OR m.to_user_id IS NULL)`;
    const binds: (string | number)[] = [user.id, user.id, user.id, user.id];
    if (sinceId > 0) {
      sql += ` AND m.id > ?`;
      binds.push(sinceId);
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    binds.push(limit);
    const rows = await c.env.DB.prepare(sql).bind(...binds).all();
    const unread = await countUnreadMessages(c.env.DB, user.id);
    const maxRow = await c.env.DB.prepare(`SELECT MAX(id) as max_id FROM app_messages`).first<{
      max_id: number | null;
    }>();
    return c.json({
      messages: rows.results || [],
      unread,
      max_id: maxRow?.max_id ?? 0,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ messages: [], unread: 0, max_id: 0, error: "Run migration 024 / 032" });
    }
    if (/timeout|storage operation/i.test(msg)) {
      return c.json({ messages: [], unread: 0, max_id: 0, error: "Database busy" });
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/messages/conversations", async (c) => {
  const user = c.get("user");
  try {
    await backfillMessageConversations(c.env.DB, 8);
    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.subject, c.is_team, c.created_by_user_id, c.last_message_at, c.created_at,
              (SELECT body FROM app_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_body,
              (SELECT fu.display_name FROM app_messages m
                 JOIN users fu ON fu.id = m.from_user_id
               WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_from_name,
              (SELECT m.from_user_id FROM app_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) as last_from_id,
              (SELECT COUNT(*) FROM app_messages m WHERE m.conversation_id = c.id) as message_count,
              (SELECT COUNT(*) FROM app_messages m
               WHERE m.conversation_id = c.id
                 AND m.from_user_id != ?
                 AND NOT EXISTS (
                   SELECT 1 FROM app_message_reads r WHERE r.message_id = m.id AND r.user_id = ?
                 )) as unread,
              (SELECT u.display_name FROM app_conversation_members cm
                 JOIN users u ON u.id = cm.user_id
               WHERE cm.conversation_id = c.id AND cm.user_id != ?
               LIMIT 1) as peer_name,
              (SELECT cm.user_id FROM app_conversation_members cm
               WHERE cm.conversation_id = c.id AND cm.user_id != ?
               LIMIT 1) as peer_id
       FROM app_conversations c
       WHERE c.is_team = 1
          OR EXISTS (
            SELECT 1 FROM app_conversation_members cm
            WHERE cm.conversation_id = c.id AND cm.user_id = ?
          )
       ORDER BY c.last_message_at DESC
       LIMIT 100`
    )
      .bind(user.id, user.id, user.id, user.id, user.id)
      .all();
    const unread = await countUnreadMessages(c.env.DB, user.id);
    return c.json({ conversations: rows.results || [], unread });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        conversations: [],
        unread: 0,
        error: "Run migration 032_message_conversations.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/messages/conversations/:id", async (c) => {
  const user = c.get("user");
  const convId = Number(c.req.param("id"));
  if (!convId) return c.json({ error: "Invalid conversation" }, 400);
  try {
    await backfillMessageConversations(c.env.DB);
    const conv = await userCanAccessConversation(c.env.DB, user.id, convId);
    if (!conv) return c.json({ error: "Conversation not found" }, 404);

    const msgs = await c.env.DB.prepare(
      `SELECT m.id, m.from_user_id, m.to_user_id, m.body, m.created_at, m.conversation_id,
              fu.display_name as from_name,
              (SELECT 1 FROM app_message_reads r WHERE r.message_id = m.id AND r.user_id = ?) as is_read,
              (SELECT COUNT(*) FROM app_message_acks a WHERE a.message_id = m.id) as ack_count,
              (SELECT 1 FROM app_message_acks a WHERE a.message_id = m.id AND a.user_id = ?) as i_acked
       FROM app_messages m
       JOIN users fu ON fu.id = m.from_user_id
       WHERE m.conversation_id = ?
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT 500`
    )
      .bind(user.id, user.id, convId)
      .all();

    const ackRows = await c.env.DB.prepare(
      `SELECT a.message_id, a.user_id, u.display_name
       FROM app_message_acks a
       JOIN users u ON u.id = a.user_id
       JOIN app_messages m ON m.id = a.message_id
       WHERE m.conversation_id = ?
       ORDER BY a.created_at ASC`
    )
      .bind(convId)
      .all<{ message_id: number; user_id: number; display_name: string }>();

    const ackersByMsg = new Map<number, { user_id: number; display_name: string }[]>();
    for (const a of ackRows.results || []) {
      const list = ackersByMsg.get(a.message_id) || [];
      list.push({ user_id: a.user_id, display_name: a.display_name });
      ackersByMsg.set(a.message_id, list);
    }

    const messages = (msgs.results || []).map((m: Record<string, unknown>) => ({
      ...m,
      id: Number(m.id),
      from_user_id: Number(m.from_user_id),
      ackers: ackersByMsg.get(Number(m.id)) || [],
    }));

    let peer_name: string | null = null;
    let peer_id: number | null = null;
    if (!conv.is_team) {
      const peer = await c.env.DB.prepare(
        `SELECT u.id, u.display_name FROM app_conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id = ? AND cm.user_id != ?
         LIMIT 1`
      )
        .bind(convId, user.id)
        .first<{ id: number; display_name: string }>();
      peer_name = peer?.display_name || null;
      peer_id = peer?.id ?? null;
    }

    // Mark conversation messages as read for this user
    for (const m of messages) {
      if (m.from_user_id === user.id) continue;
      await c.env.DB.prepare(
        `INSERT OR IGNORE INTO app_message_reads (message_id, user_id) VALUES (?, ?)`
      )
        .bind(m.id, user.id)
        .run();
    }

    return c.json({
      conversation: {
        ...conv,
        peer_name,
        peer_id,
      },
      messages,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 032_message_conversations.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/messages/users", async (c) => {
  const me = c.get("user");
  const rows = await c.env.DB.prepare(
    `SELECT id, display_name, role, IFNULL(is_warehouse, 0) as is_warehouse
     FROM users WHERE active = 1 AND id != ?
     ORDER BY display_name`
  )
    .bind(me.id)
    .all();
  // Map warehouse flag for UI
  const users = (rows.results || []).map((u: Record<string, unknown>) => ({
    id: u.id,
    display_name: u.display_name,
    role: u.is_warehouse ? "warehouse" : u.role,
  }));
  return c.json({ users });
});

/** In-app team chat UI removed — warranties + alerts remain. */
api.post("/messages", async (c) => {
  return c.json(
    {
      error:
        "Messaging has been turned off in the Field App. Use notifications, warranties, and alerts instead.",
    },
    410
  );
});

/** Thumbs-up / "got it" confirmation on a message */
api.post("/messages/:id/ack", async (c) => {
  return c.json({ error: "Messaging has been turned off." }, 410);
});

api.post("/messages/read", async (c) => {
  return c.json({ error: "Messaging has been turned off." }, 410);
});

api.delete("/messages/conversations/:id", async (c) => {
  return c.json({ error: "Messaging has been turned off." }, 410);
});

// ——— Warranty claims ———
/**
 * Warranty log #: W + MM + YY + "-" + monthly sequence
 * e.g. W0726-001 (July 2026, 1st that month) → W0726-002 …
 * August resets: W0826-001
 */
async function nextWarrantyLogNumber(db: D1Database): Promise<string> {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear() % 100).padStart(2, "0");
  const prefix = `W${mm}${yy}-`;
  const last = await db
    .prepare(
      `SELECT log_number FROM warranty_claims WHERE log_number LIKE ? ORDER BY log_number DESC LIMIT 1`
    )
    .bind(`${prefix}%`)
    .first<{ log_number: string }>();
  let seq = 1;
  if (last?.log_number) {
    const n = Number(last.log_number.slice(prefix.length));
    if (Number.isFinite(n) && n >= 0) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

function warrantyParseTs(raw: string): Date {
  return new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + (raw.endsWith("Z") ? "" : "Z"));
}

function warrantyDaysOpen(droppedOffAt: string, processedAt: string | null): number {
  const start = warrantyParseTs(droppedOffAt);
  const end = processedAt ? warrantyParseTs(processedAt) : new Date();
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

/** Weekdays (Mon–Fri) from the day after `fromIso` through today (America/Chicago noon steps). */
function warrantyWorkingDaysSince(fromIso: string | null | undefined): number {
  if (!fromIso) return 0;
  const start = warrantyParseTs(fromIso);
  if (Number.isNaN(start.getTime())) return 0;
  const d = new Date(start);
  d.setUTCHours(12, 0, 0, 0);
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  let days = 0;
  while (d < today) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay(); // 0 Sun … 6 Sat — close enough for D1 UTC-stored timestamps
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

const WARRANTY_OPEN_STATUSES = `('dropped_off','claim_submitted','return_to_vendor','delivered')`;
const WARRANTY_SUBMITTED_PIPELINE = new Set([
  "claim_submitted",
  "return_to_vendor",
  "delivered",
]);

/**
 * Focus count: dropped-off parts still need a claim filed.
 * Submitted claims are quiet until 3 working days after submit, then they need approve/reject.
 */
function warrantyNeedsAttention(row: {
  status: string;
  claim_submitted_at?: string | null;
  dropped_off_at?: string | null;
}): boolean {
  const st = String(row.status || "");
  if (st === "dropped_off") return true;
  if (!WARRANTY_SUBMITTED_PIPELINE.has(st)) return false;
  const since =
    warrantyWorkingDaysSince(row.claim_submitted_at) ||
    warrantyWorkingDaysSince(row.dropped_off_at);
  return since >= 3;
}

async function countWarrantyNeedsAttention(db: D1Database): Promise<number> {
  try {
    const rows = await db
      .prepare(
        `SELECT status, claim_submitted_at, dropped_off_at FROM warranty_claims
         WHERE status IN ${WARRANTY_OPEN_STATUSES}`
      )
      .all<{
        status: string;
        claim_submitted_at: string | null;
        dropped_off_at: string | null;
      }>();
    return (rows.results || []).filter(warrantyNeedsAttention).length;
  } catch {
    return 0;
  }
}

/** Normalize equipment serial for duplicate matching (ignore spaces/dashes/case). */
function normalizeWarrantySerial(serial: string): string {
  return String(serial || "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_.]/g, "");
}

/** Digits-only core — catches OCR noise like 203936EN3V vs 2039363V. */
function warrantySerialDigits(serial: string): string {
  return normalizeWarrantySerial(serial).replace(/\D/g, "");
}

function warrantySerialsLookSame(a: string, b: string): boolean {
  const na = normalizeWarrantySerial(a);
  const nb = normalizeWarrantySerial(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // One contains the other (short OCR truncations), min length 6
  if (na.length >= 6 && nb.length >= 6 && (na.includes(nb) || nb.includes(na))) return true;
  const da = warrantySerialDigits(a);
  const db = warrantySerialDigits(b);
  // Same digit core after letter noise (min 6 digits)
  if (da.length >= 6 && da === db) return true;
  return false;
}

type WarrantySerialDup = {
  id: number;
  log_number: string;
  part_name: string;
  model_number: string | null;
  serial_number: string | null;
  status: string;
  dropped_off_at: string;
  service_address: string | null;
};

async function findWarrantySerialDuplicates(
  db: D1Database,
  serial: string,
  withinDays = 30
): Promise<WarrantySerialDup[]> {
  const norm = normalizeWarrantySerial(serial);
  if (!norm || norm.length < 4) return [];
  const rows = await db
    .prepare(
      `SELECT id, log_number, part_name, model_number, serial_number, status,
              dropped_off_at, service_address
       FROM warranty_claims
       WHERE dropped_off_at >= datetime('now', ?)
         AND serial_number IS NOT NULL
         AND trim(serial_number) != ''
       ORDER BY dropped_off_at DESC
       LIMIT 120`
    )
    .bind(`-${Math.max(1, withinDays)} days`)
    .all<WarrantySerialDup>();
  return (rows.results || []).filter((r) =>
    warrantySerialsLookSame(String(r.serial_number || ""), serial)
  );
}

api.get("/warranties/check-duplicate", async (c) => {
  const serial = (c.req.query("serial") || "").trim();
  if (!serial) return c.json({ error: "serial required" }, 400);
  try {
    const duplicates = await findWarrantySerialDuplicates(c.env.DB, serial, 30);
    return c.json({
      duplicate: duplicates.length > 0,
      within_days: 30,
      serial_normalized: normalizeWarrantySerial(serial),
      matches: duplicates.map((d) => ({
        id: d.id,
        log_number: d.log_number,
        part_name: d.part_name,
        model_number: d.model_number,
        serial_number: d.serial_number,
        status: d.status,
        dropped_off_at: d.dropped_off_at,
        service_address: d.service_address,
      })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ duplicate: false, matches: [] });
    return c.json({ error: msg }, 500);
  }
});

api.get("/warranties", async (c) => {
  const status = (c.req.query("status") || "").trim();
  try {
    let sql = `SELECT w.*,
        du.display_name as dropped_off_by_name,
        pu.display_name as processed_by_name,
        su.display_name as claim_submitted_by_name
       FROM warranty_claims w
       LEFT JOIN users du ON du.id = w.dropped_off_by_user_id
       LEFT JOIN users pu ON pu.id = w.processed_by_user_id
       LEFT JOIN users su ON su.id = w.claim_submitted_by_user_id`;
    const binds: unknown[] = [];
    const OPEN_WARRANTY = WARRANTY_OPEN_STATUSES;
    const q = (c.req.query("q") || "").trim().toLowerCase();
    // Text query searches ALL statuses so typing "005" finds W0726-005 even if approved.
    // Without q, honor open / vendor / decided tabs.
    if (!q) {
      if (status === "open") {
        sql += ` WHERE w.status IN ${OPEN_WARRANTY}`;
      } else if (status === "dropped" || status === "dropped_off") {
        sql += ` WHERE w.status = 'dropped_off'`;
      } else if (status === "submitted" || status === "claim_submitted") {
        sql += ` WHERE w.status IN ('claim_submitted','return_to_vendor','delivered')`;
      } else if (status === "vendor" || status === "vendor_waiting" || status === "waiting_vendor") {
        sql += ` WHERE w.status IN ('return_to_vendor','delivered')`;
      } else if (status === "decided" || status === "closed") {
        sql += ` WHERE w.status IN ('approved','rejected','not_warranty')`;
      } else if (status) {
        const mapped =
          status === "processed" ? "approved" : status === "cancelled" ? "rejected" : status;
        sql += ` WHERE w.status = ?`;
        binds.push(mapped);
      }
    } else {
      // Match log #, address, part fields, vendor, RMA, tracking, notes
      const whereParts = [
        `lower(w.log_number) LIKE ?`,
        `lower(w.part_name) LIKE ?`,
        `lower(COALESCE(w.part_code,'')) LIKE ?`,
        `lower(COALESCE(w.model_number,'')) LIKE ?`,
        `lower(COALESCE(w.serial_number,'')) LIKE ?`,
        `lower(COALESCE(w.customer_name,'')) LIKE ?`,
        `lower(COALESCE(w.vendor_name,'')) LIKE ?`,
        `lower(COALESCE(w.service_address,'')) LIKE ?`,
        `lower(COALESCE(w.notes,'')) LIKE ?`,
        `lower(COALESCE(w.rma_number,'')) LIKE ?`,
        `lower(COALESCE(w.tracking_number,'')) LIKE ?`,
      ];
      // Also match if user types full log without hyphens: w0726005 vs W0726-005
      const compact = q.replace(/[^a-z0-9]/g, "");
      if (compact && compact !== q) {
        whereParts.push(
          `lower(replace(replace(w.log_number, '-', ''), ' ', '')) LIKE ?`
        );
      }
      sql += ` WHERE (${whereParts.join(" OR ")})`;
      const like = `%${q}%`;
      binds.push(like, like, like, like, like, like, like, like, like, like, like);
      if (compact && compact !== q) binds.push(`%${compact}%`);
    }
    sql += ` ORDER BY
      CASE w.status
        WHEN 'dropped_off' THEN 0
        WHEN 'claim_submitted' THEN 1
        WHEN 'return_to_vendor' THEN 2
        WHEN 'delivered' THEN 3
        WHEN 'approved' THEN 4
        WHEN 'rejected' THEN 5
        WHEN 'not_warranty' THEN 6
        ELSE 7
      END,
      w.dropped_off_at ASC
      LIMIT 200`;
    const rows = await c.env.DB.prepare(sql)
      .bind(...binds)
      .all();
    const isOpenW = (s: string) =>
      s === "dropped_off" ||
      s === "claim_submitted" ||
      s === "return_to_vendor" ||
      s === "delivered";
    const list = (rows.results || []).map((r: Record<string, unknown>) => {
      const st = String(r.status);
      const days = warrantyDaysOpen(
        String(r.dropped_off_at),
        r.processed_at ? String(r.processed_at) : null
      );
      const open = isOpenW(st);
      const submittedAt = r.claim_submitted_at ? String(r.claim_submitted_at) : null;
      const workingSinceSubmit = WARRANTY_SUBMITTED_PIPELINE.has(st)
        ? warrantyWorkingDaysSince(submittedAt) || warrantyWorkingDaysSince(String(r.dropped_off_at))
        : 0;
      const needsAttention = warrantyNeedsAttention({
        status: st,
        claim_submitted_at: submittedAt,
        dropped_off_at: r.dropped_off_at ? String(r.dropped_off_at) : null,
      });
      // Dropped off: age from drop-off. Submitted pipeline: quiet until 3 working days, then approval aging.
      const overdue =
        st === "dropped_off"
          ? days >= 7
          : WARRANTY_SUBMITTED_PIPELINE.has(st)
            ? workingSinceSubmit >= 3
            : false;
      const urgent =
        st === "dropped_off"
          ? days >= 14
          : WARRANTY_SUBMITTED_PIPELINE.has(st)
            ? workingSinceSubmit >= 5
            : false;
      return {
        ...r,
        days_open: days,
        working_days_since_submit: workingSinceSubmit,
        needs_attention: needsAttention,
        overdue,
        urgent,
      };
    });
    const openCount = list.filter((r: { status: string }) => isOpenW(String(r.status))).length;
    const attentionCount = list.filter(
      (r: { needs_attention?: boolean }) => r.needs_attention
    ).length;
    return c.json({
      warranties: list,
      open_count: openCount,
      attention_count: attentionCount,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ warranties: [], open_count: 0, attention_count: 0 });
    if (/no such column.*claim_submitted_by/i.test(msg)) {
      return c.json({
        warranties: [],
        open_count: 0,
        attention_count: 0,
        error: "Run migration 074_warranty_claim_submitted_by.sql on D1",
      }, 500);
    }
    return c.json({ error: msg }, 500);
  }
});

/** Save warranty photo into R2 or receipt_blobs; returns storage key. */
async function saveWarrantyPhoto(
  env: Env,
  file: File,
  folder:
    | "warranty-dropoffs"
    | "warranty-nameplates"
    | "warranty-compressor" = "warranty-dropoffs"
): Promise<string> {
  const maxBytes = env.RECEIPTS ? 10 * 1024 * 1024 : 900 * 1024;
  if (file.size > maxBytes) {
    throw new Error(
      env.RECEIPTS
        ? "Max 10MB photo"
        : "Photo too large (max ~900KB). Take a slightly smaller picture."
    );
  }
  const ext = receiptExt(file);
  const contentType = receiptContentType(file, ext);
  const key = `${folder}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
  const buf = await file.arrayBuffer();
  if (env.RECEIPTS) {
    await env.RECEIPTS.put(key, buf, { httpMetadata: { contentType } });
    return key;
  }
  await env.DB.prepare(
    `INSERT INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
  )
    .bind(key, contentType, new Uint8Array(buf), buf.byteLength)
    .run();
  return key;
}

async function saveWarrantyDropoffPhoto(env: Env, file: File): Promise<string> {
  return saveWarrantyPhoto(env, file, "warranty-dropoffs");
}

api.post("/warranties", async (c) => {
  const user = c.get("user");
  const ct = c.req.header("content-type") || "";

  // Prefer multipart (fields + photos) so offline queue keeps them together
  let partName = "";
  let partCode: string | null = null;
  let partId: number | null = null;
  let modelNumber: string | null = null;
  let serialNumber: string | null = null;
  let serviceAddress: string | null = null;
  let customerName: string | null = null;
  let vendorName: string | null = null;
  let notes: string | null = null;
  let needsVendorReturn = false;
  let photoKey = "";
  let nameplateKey = "";
  let confirmDuplicate = false;
  let compressorSealsOk = false;
  let oldCompressorPhotoKey = "";
  let newCompressorPhotoKey = "";
  let oldCompressorSerial: string | null = null;
  let newCompressorSerial: string | null = null;
  let ocrFeedback: {
    raw_text?: string;
    ocr?: OcrFieldSnapshot;
    final?: OcrFieldSnapshot;
  } | null = null;

  function looksLikeCompressor(name: string): boolean {
    const n = name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/\bcompressors?\b/.test(n)) return true;
    if (/\bcomp\b/.test(n) && !/\bcompartment\b|\bcomplete\b|\bcompany\b/.test(n)) return true;
    return false;
  }

  try {
    if (ct.includes("multipart/form-data")) {
      const form = await c.req.formData();
      partName = String(form.get("part_name") || "").trim();
      partCode = String(form.get("part_code") || "").trim() || null;
      const pid = form.get("part_id");
      partId = pid && String(pid) ? Number(pid) : null;
      modelNumber = String(form.get("model_number") || "").trim() || null;
      serialNumber = String(form.get("serial_number") || "").trim() || null;
      serviceAddress = String(form.get("service_address") || "").trim() || null;
      customerName = String(form.get("customer_name") || "").trim() || null;
      vendorName = String(form.get("vendor_name") || "").trim() || null;
      notes = String(form.get("notes") || "").trim() || null;
      needsVendorReturn =
        form.get("needs_vendor_return") === "1" ||
        form.get("needs_vendor_return") === "true";
      confirmDuplicate =
        form.get("confirm_duplicate") === "1" ||
        form.get("confirm_duplicate") === "true";
      compressorSealsOk =
        form.get("compressor_seals_ok") === "1" ||
        form.get("compressor_seals_ok") === "true";
      oldCompressorSerial = String(form.get("old_compressor_serial") || "").trim() || null;
      newCompressorSerial = String(form.get("new_compressor_serial") || "").trim() || null;
      const file = form.get("photo") || form.get("file");
      if (file instanceof File && file.size > 0) {
        photoKey = await saveWarrantyPhoto(c.env, file, "warranty-dropoffs");
      } else {
        photoKey = String(form.get("dropoff_photo_key") || "").trim();
      }
      const nameplate = form.get("nameplate") || form.get("nameplate_photo");
      if (nameplate instanceof File && nameplate.size > 0) {
        nameplateKey = await saveWarrantyPhoto(c.env, nameplate, "warranty-nameplates");
      } else {
        nameplateKey = String(form.get("nameplate_photo_key") || "").trim();
      }
      const oldComp = form.get("old_compressor_photo");
      if (oldComp instanceof File && oldComp.size > 0) {
        oldCompressorPhotoKey = await saveWarrantyPhoto(c.env, oldComp, "warranty-compressor");
      } else {
        oldCompressorPhotoKey = String(form.get("old_compressor_photo_key") || "").trim();
      }
      const newComp = form.get("new_compressor_photo");
      if (newComp instanceof File && newComp.size > 0) {
        newCompressorPhotoKey = await saveWarrantyPhoto(c.env, newComp, "warranty-compressor");
      } else {
        newCompressorPhotoKey = String(form.get("new_compressor_photo_key") || "").trim();
      }
      const fbRaw = form.get("ocr_feedback");
      if (typeof fbRaw === "string" && fbRaw.trim()) {
        try {
          ocrFeedback = JSON.parse(fbRaw) as typeof ocrFeedback;
        } catch {
          ocrFeedback = null;
        }
      }
    } else {
      const body = await c.req.json<{
        part_name?: string;
        part_code?: string;
        part_id?: number;
        model_number?: string;
        serial_number?: string;
        service_address?: string;
        customer_name?: string;
        vendor_name?: string;
        notes?: string;
        needs_vendor_return?: boolean;
        confirm_duplicate?: boolean;
        dropoff_photo_key?: string;
        nameplate_photo_key?: string;
        ocr_feedback?: {
          raw_text?: string;
          ocr?: OcrFieldSnapshot;
          final?: OcrFieldSnapshot;
        };
      }>();
      partName = (body.part_name || "").trim();
      partCode = body.part_code?.trim() || null;
      partId = body.part_id || null;
      modelNumber = body.model_number?.trim() || null;
      serialNumber = body.serial_number?.trim() || null;
      serviceAddress = body.service_address?.trim() || null;
      customerName = body.customer_name?.trim() || null;
      vendorName = body.vendor_name?.trim() || null;
      notes = body.notes?.trim() || null;
      needsVendorReturn = !!body.needs_vendor_return;
      confirmDuplicate = !!body.confirm_duplicate;
      compressorSealsOk = !!(body as { compressor_seals_ok?: boolean }).compressor_seals_ok;
      oldCompressorSerial =
        (body as { old_compressor_serial?: string }).old_compressor_serial?.trim() || null;
      newCompressorSerial =
        (body as { new_compressor_serial?: string }).new_compressor_serial?.trim() || null;
      photoKey = (body.dropoff_photo_key || "").trim();
      nameplateKey = (body.nameplate_photo_key || "").trim();
      oldCompressorPhotoKey =
        (body as { old_compressor_photo_key?: string }).old_compressor_photo_key?.trim() || "";
      newCompressorPhotoKey =
        (body as { new_compressor_photo_key?: string }).new_compressor_photo_key?.trim() || "";
      ocrFeedback = body.ocr_feedback || null;
    }

    if (!partName) return c.json({ error: "Part name is required" }, 400);
    if (!modelNumber) {
      return c.json(
        {
          error:
            "Equipment model # is required — from the unit the part was removed from (not the failed part).",
        },
        400
      );
    }
    if (!serialNumber) {
      return c.json(
        {
          error:
            "Equipment serial # is required — from the unit the part was removed from (not the failed part).",
        },
        400
      );
    }
    if (!photoKey) {
      return c.json(
        {
          error:
            "Photo required: take a picture of where you left the warranty part so warehouse can find it.",
        },
        400
      );
    }

    const isCompressor = looksLikeCompressor(partName);
    if (isCompressor) {
      if (!compressorSealsOk) {
        return c.json(
          {
            error:
              "Compressors must have seals intact — vendors reject leaking / unsealed compressors. Confirm seals are sealed before drop-off.",
          },
          400
        );
      }
      if (!oldCompressorPhotoKey) {
        return c.json(
          {
            error:
              "Compressor warranty needs a photo of the OLD compressor serial number (failed unit).",
          },
          400
        );
      }
      if (!newCompressorPhotoKey) {
        return c.json(
          {
            error:
              "Compressor warranty needs a photo of the NEW compressor serial number (replacement).",
          },
          400
        );
      }
    }

    // Same equipment serial within 30 days → require explicit confirm (stops accidental doubles)
    if (!confirmDuplicate) {
      try {
        const dups = await findWarrantySerialDuplicates(c.env.DB, serialNumber, 30);
        if (dups.length > 0) {
          return c.json(
            {
              error: "duplicate_serial",
              message:
                "This equipment serial already has a warranty logged in the last 30 days. Confirm if this is a new claim.",
              within_days: 30,
              matches: dups.map((d) => ({
                id: d.id,
                log_number: d.log_number,
                part_name: d.part_name,
                model_number: d.model_number,
                serial_number: d.serial_number,
                status: d.status,
                dropped_off_at: d.dropped_off_at,
                service_address: d.service_address,
              })),
            },
            409
          );
        }
      } catch {
        /* table optional / don't block drop-off on check failure */
      }
    }

    const logNumber = await nextWarrantyLogNumber(c.env.DB);
    let r;
    try {
      r = await c.env.DB.prepare(
        `INSERT INTO warranty_claims (
           log_number, status, part_id, part_code, part_name, model_number, serial_number,
           service_address, customer_name, vendor_name, notes, needs_vendor_return,
           dropoff_photo_key, nameplate_photo_key, dropped_off_by_user_id, dropped_off_at,
           compressor_seals_ok, old_compressor_photo_key, new_compressor_photo_key,
           old_compressor_serial, new_compressor_serial
         ) VALUES (?, 'dropped_off', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?)`
      )
        .bind(
          logNumber,
          partId,
          partCode,
          partName,
          modelNumber,
          serialNumber,
          serviceAddress,
          customerName,
          vendorName,
          notes,
          needsVendorReturn ? 1 : 0,
          photoKey,
          nameplateKey || null,
          user.id,
          isCompressor ? (compressorSealsOk ? 1 : 0) : null,
          isCompressor ? oldCompressorPhotoKey || null : null,
          isCompressor ? newCompressorPhotoKey || null : null,
          isCompressor ? oldCompressorSerial : null,
          isCompressor ? newCompressorSerial : null
        )
        .run();
    } catch (colErr) {
      const msg = colErr instanceof Error ? colErr.message : String(colErr);
      // Fallback without compressor columns (migration 076) or nameplate
      if (/compressor_|no such column/i.test(msg) && !/nameplate_photo/i.test(msg)) {
        r = await c.env.DB.prepare(
          `INSERT INTO warranty_claims (
             log_number, status, part_id, part_code, part_name, model_number, serial_number,
             service_address, customer_name, vendor_name, notes, needs_vendor_return,
             dropoff_photo_key, nameplate_photo_key, dropped_off_by_user_id, dropped_off_at
           ) VALUES (?, 'dropped_off', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
          .bind(
            logNumber,
            partId,
            partCode,
            partName,
            modelNumber,
            serialNumber,
            serviceAddress,
            customerName,
            vendorName,
            notes,
            needsVendorReturn ? 1 : 0,
            photoKey,
            nameplateKey || null,
            user.id
          )
          .run();
      } else if (/nameplate_photo|no such column/i.test(msg)) {
        r = await c.env.DB.prepare(
          `INSERT INTO warranty_claims (
             log_number, status, part_id, part_code, part_name, model_number, serial_number,
             service_address, customer_name, vendor_name, notes, needs_vendor_return,
             dropoff_photo_key, dropped_off_by_user_id, dropped_off_at
           ) VALUES (?, 'dropped_off', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
          .bind(
            logNumber,
            partId,
            partCode,
            partName,
            modelNumber,
            serialNumber,
            serviceAddress,
            customerName,
            vendorName,
            notes,
            needsVendorReturn ? 1 : 0,
            photoKey,
            user.id
          )
          .run();
      } else if (/dropoff_photo|no such column/i.test(msg)) {
        r = await c.env.DB.prepare(
          `INSERT INTO warranty_claims (
             log_number, status, part_id, part_code, part_name, model_number, serial_number,
             service_address, customer_name, vendor_name, notes, needs_vendor_return,
             dropped_off_by_user_id, dropped_off_at
           ) VALUES (?, 'dropped_off', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
          .bind(
            logNumber,
            partId,
            partCode,
            partName,
            modelNumber,
            serialNumber,
            serviceAddress,
            customerName,
            vendorName,
            notes,
            needsVendorReturn ? 1 : 0,
            user.id
          )
          .run();
      } else {
        throw colErr;
      }
    }
    const id = r.meta.last_row_id;

    // Learn nameplate OCR corrections (model / serial)
    if (ocrFeedback?.ocr && ocrFeedback?.final) {
      try {
        const ocrSnap = { ...ocrFeedback.ocr, store_number: "nameplate" };
        const finSnap = { ...ocrFeedback.final, store_number: "nameplate" };
        await recordOcrFeedback(
          c.env.DB,
          user.id,
          ocrFeedback.raw_text || null,
          ocrSnap,
          finSnap
        );
      } catch {
        /* learning best-effort */
      }
    }

    const targets = await usersByRoles(c.env.DB, ["admin", "warehouse"]);
    await notifyUsers(
      c.env.DB,
      targets,
      "warranty_dropoff",
      `Warranty drop-off ${logNumber}`,
      `WRITE ON BOX: ${logNumber} · ${partName} · Model ${modelNumber} · S/N ${serialNumber} · by ${user.display_name}` +
        (needsVendorReturn ? " · NEEDS VENDOR RETURN" : "") +
        " · photo attached",
      { type: "warranty", id }
    );
    await writeAudit(
      c.env.DB,
      user,
      "create",
      "warranty",
      id,
      `Warranty ${logNumber} dropped off (model ${modelNumber} S/N ${serialNumber})`
    );
    const row = await c.env.DB.prepare(`SELECT * FROM warranty_claims WHERE id = ?`).bind(id).first();
    return c.json({
      ok: true,
      warranty: row,
      write_on_box: logNumber,
      instruction: `Write this warranty log number on the box: ${logNumber}`,
      log_format: "WMMYY-###",
    }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Create failed" }, 500);
  }
});

api.patch("/warranties/:id", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    status?: string;
    notes?: string;
    /** Append a dated status update (does not wipe prior notes). */
    append_note?: string;
    needs_vendor_return?: boolean;
    vendor_name?: string;
    service_address?: string | null;
    claim_submitted?: boolean;
    rma_number?: string | null;
    credit_amount?: number | string | null;
    tracking_number?: string | null;
  }>();
  const before = await c.env.DB.prepare(`SELECT * FROM warranty_claims WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      log_number: string;
      status: string;
      notes: string | null;
      dropped_off_by_user_id: number | null;
      part_name: string;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  // Field can only update notes on own drop-offs; warehouse/admin process claims
  const canProcess =
    user.role === "admin" ||
    user.role === "warehouse" ||
    user.role === "office" ||
    user.role === "mechanic";
  const canNote =
    canProcess ||
    (before.dropped_off_by_user_id != null && before.dropped_off_by_user_id === user.id);

  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];

  // Status updates for the team: append keeps history (e.g. "Working with Lennox…")
  if (body.append_note !== undefined) {
    if (!canNote) return c.json({ error: "Not allowed to add notes on this claim" }, 403);
    const text = body.append_note.trim();
    if (!text) return c.json({ error: "Note cannot be empty" }, 400);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const who = (user.display_name || "Office").trim();
    const block = `[${stamp} · ${who}]\n${text}`;
    const prior = (before.notes || "").trim();
    const next = prior ? `${prior}\n\n${block}` : block;
    sets.push("notes = ?");
    vals.push(next);
  } else if (body.notes !== undefined) {
    if (!canNote) return c.json({ error: "Not allowed to edit notes on this claim" }, 403);
    sets.push("notes = ?");
    vals.push(body.notes?.trim() || null);
  }
  if (body.vendor_name !== undefined && canProcess) {
    sets.push("vendor_name = ?");
    vals.push(body.vendor_name?.trim() || null);
  }
  if (body.service_address !== undefined && canProcess) {
    sets.push("service_address = ?");
    vals.push(body.service_address?.toString().trim() || null);
  }
  if (body.needs_vendor_return !== undefined && canProcess) {
    sets.push("needs_vendor_return = ?");
    vals.push(body.needs_vendor_return ? 1 : 0);
  }
  // Vendor return / credit details (optional columns — ignore if migration not applied)
  if (body.rma_number !== undefined && canProcess) {
    sets.push("rma_number = ?");
    vals.push(body.rma_number?.toString().trim() || null);
  }
  if (body.tracking_number !== undefined && canProcess) {
    sets.push("tracking_number = ?");
    vals.push(body.tracking_number?.toString().trim() || null);
  }
  if (body.credit_amount !== undefined && canProcess) {
    const raw = body.credit_amount;
    const n =
      raw === "" || raw == null ? null : Number(raw);
    if (n != null && !Number.isFinite(n)) {
      return c.json({ error: "Credit amount must be a number" }, 400);
    }
    sets.push("credit_amount = ?");
    vals.push(n);
  }

  let newStatus = before.status;
  if (body.status && canProcess) {
    // Normalize legacy client values only (return_to_vendor is a real open status)
    let next = body.status;
    if (next === "processed") next = "approved";
    if (next === "cancelled") next = "rejected";
    // Aliases for "not really a warranty / part going to another job"
    if (
      next === "not_a_warranty" ||
      next === "sent_to_job" ||
      next === "repurposed" ||
      next === "used_on_job"
    ) {
      next = "not_warranty";
    }
    const allowed = [
      "dropped_off",
      "claim_submitted",
      "return_to_vendor",
      "delivered",
      "approved",
      "rejected",
      "not_warranty",
    ];
    if (!allowed.includes(next)) return c.json({ error: "Invalid status" }, 400);
    newStatus = next;
    sets.push("status = ?");
    vals.push(next);
    if (next === "claim_submitted") {
      sets.push("claim_submitted_at = COALESCE(claim_submitted_at, datetime('now'))");
      sets.push("claim_submitted_by_user_id = COALESCE(claim_submitted_by_user_id, ?)");
      vals.push(user.id);
    }
    if (next === "return_to_vendor") {
      sets.push("needs_vendor_return = 1");
      sets.push("shipped_by_user_id = COALESCE(shipped_by_user_id, ?)");
      vals.push(user.id);
    }
    // Closing outcomes — set processed_at so it leaves open / aging lists
    if (next === "approved" || next === "rejected" || next === "not_warranty") {
      sets.push("processed_at = datetime('now')");
      sets.push("processed_by_user_id = ?");
      vals.push(user.id);
    }
  } else if (body.claim_submitted && canProcess) {
    newStatus = "claim_submitted";
    sets.push("status = 'claim_submitted'");
    sets.push("claim_submitted_at = COALESCE(claim_submitted_at, datetime('now'))");
    sets.push("claim_submitted_by_user_id = COALESCE(claim_submitted_by_user_id, ?)");
    vals.push(user.id);
  }

  if (sets.length <= 1) return c.json({ error: "Nothing to update" }, 400);
  vals.push(id);
  try {
    await c.env.DB.prepare(`UPDATE warranty_claims SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...vals)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Retry without vendor-credit columns if migration 041 not applied
    if (/no such column|rma_number|credit_amount|tracking|shipped_by|claim_submitted_by/i.test(msg)) {
      const safeSets = sets.filter(
        (s) =>
          !/rma_number|credit_amount|tracking_number|shipped_by_user_id|claim_submitted_by_user_id/.test(s)
      );
      const safeVals = vals.slice(0, -1);
      // rebuild vals without vendor fields is hard — simpler fall back message
      return c.json(
        {
          error:
            "Run migration 041_warranty_vendor_credit.sql for RMA / credit / tracking fields, or update status only.",
        },
        400
      );
    }
    throw e;
  }

  // Notify the tech who dropped it off — in-app + personal SMS (not all employees)
  if (
    before.dropped_off_by_user_id &&
    before.dropped_off_by_user_id !== user.id
  ) {
    const statusChanged = newStatus !== before.status;
    const noteAppended = Boolean(body.append_note?.trim());
    if (statusChanged || noteAppended) {
      const statusLabel: Record<string, string> = {
        dropped_off: "dropped off",
        claim_submitted: "claim submitted",
        return_to_vendor: "return to vendor",
        delivered: "delivered",
        approved: "approved",
        rejected: "rejected",
        not_warranty: "not a warranty",
      };
      const kind = statusChanged
        ? newStatus === "approved"
          ? "warranty_approved"
          : newStatus === "rejected"
            ? "warranty_rejected"
            : newStatus === "not_warranty"
              ? "warranty_not_warranty"
              : "warranty_update"
        : "warranty_update";
      const title = statusChanged
        ? `Warranty ${before.log_number} · ${statusLabel[newStatus] || newStatus}`
        : `Warranty ${before.log_number} update`;
      const noteBit = body.append_note?.trim()
        ? body.append_note.trim().slice(0, 120)
        : null;
      const detail = [
        before.part_name,
        statusChanged ? `Status: ${statusLabel[newStatus] || newStatus}` : null,
        noteBit,
      ]
        .filter(Boolean)
        .join(" · ");
      const smsText = shortSms(
        statusChanged
          ? `TA: Warranty ${before.log_number} is now ${statusLabel[newStatus] || newStatus}. ${before.part_name}${noteBit ? ` · ${noteBit}` : ""}`
          : `TA: Warranty ${before.log_number} update: ${noteBit || before.part_name}`
      );
      await notifyAndSms(c.env, c.env.DB, [before.dropped_off_by_user_id], {
        kind,
        title,
        body: detail,
        entity: { type: "warranty", id },
        sms: smsText,
        excludeUserId: user.id,
        fromUserId: user.id,
        smsContext: statusChanged
          ? `warranty:${id}:${newStatus}`
          : `warranty_note:${id}:${Date.now()}`,
      });
    }
  }

  await writeAudit(c.env.DB, user, "update", "warranty", id, `Warranty ${before.log_number} → ${newStatus}`);
  const row = await c.env.DB.prepare(`SELECT * FROM warranty_claims WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, warranty: row });
});

// ——— Employee handbook (upload + acknowledge) ———
api.get("/handbook", async (c) => {
  const user = c.get("user");
  try {
    const book = await c.env.DB.prepare(
      `SELECT h.*, u.display_name as uploaded_by_name
       FROM employee_handbooks h
       LEFT JOIN users u ON u.id = h.uploaded_by_user_id
       WHERE h.active = 1
       ORDER BY h.created_at DESC
       LIMIT 1`
    ).first<{
      id: number;
      title: string;
      version_label: string | null;
      file_key: string;
      content_type: string;
      file_size: number | null;
      created_at: string;
      uploaded_by_name: string | null;
    }>();
    if (!book) {
      return c.json({ handbook: null, acknowledged: false, pending: false });
    }
    const ack = await c.env.DB.prepare(
      `SELECT acknowledged_at, ack_name FROM handbook_acknowledgments
       WHERE handbook_id = ? AND user_id = ?`
    )
      .bind(book.id, user.id)
      .first<{ acknowledged_at: string; ack_name: string | null }>();
    return c.json({
      handbook: book,
      acknowledged: !!ack,
      acknowledged_at: ack?.acknowledged_at || null,
      ack_name: ack?.ack_name || null,
      pending: !ack,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ handbook: null, acknowledged: false, pending: false });
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/handbook/status", requireRoles(["admin", "office", "viewer"]), async (c) => {
  try {
    const book = await c.env.DB.prepare(
      `SELECT id, title, version_label, created_at FROM employee_handbooks
       WHERE active = 1 ORDER BY created_at DESC LIMIT 1`
    ).first<{ id: number; title: string; version_label: string | null; created_at: string }>();
    if (!book) return c.json({ handbook: null, acks: [], users: [] });

    const users = await c.env.DB.prepare(
      `SELECT id, display_name, role FROM users WHERE active = 1 ORDER BY display_name`
    ).all<{ id: number; display_name: string; role: string }>();
    const acks = await c.env.DB.prepare(
      `SELECT a.user_id, a.acknowledged_at, a.ack_name, u.display_name
       FROM handbook_acknowledgments a
       JOIN users u ON u.id = a.user_id
       WHERE a.handbook_id = ?`
    )
      .bind(book.id)
      .all();
    const ackByUser = new Map(
      (acks.results || []).map((a: { user_id: number }) => [a.user_id, a])
    );
    const roster = (users.results || [])
      .map((u) => ({
        ...u,
        acknowledged: ackByUser.has(u.id),
        acknowledged_at: (ackByUser.get(u.id) as { acknowledged_at?: string } | undefined)
          ?.acknowledged_at,
      }))
      // Pending first so office can chase who still needs to sign
      .sort((a, b) => {
        if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
        return a.display_name.localeCompare(b.display_name, undefined, {
          sensitivity: "base",
        });
      });
    return c.json({ handbook: book, roster });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ handbook: null, roster: [] });
    return c.json({ error: msg }, 500);
  }
});

api.post("/handbook", requireRoles(["admin", "office", "supervisor"]), async (c) => {
  const user = c.get("user");
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) {
      return c.json({ error: "PDF or document file required" }, 400);
    }
    const title = String(form.get("title") || "Employee Handbook").trim() || "Employee Handbook";
    const version = String(form.get("version_label") || "").trim() || null;
    const notes = String(form.get("notes") || "").trim() || null;

    // R2: up to 25MB. Without R2: chunked D1 storage up to 20MB (was ~900KB single-row limit).
    const maxBytes = c.env.RECEIPTS ? 25 * 1024 * 1024 : D1_HANDBOOK_MAX;
    if (file.size > maxBytes) {
      return c.json(
        {
          error: c.env.RECEIPTS
            ? "File too large (max 25MB)"
            : `File too large (max ${Math.round(D1_HANDBOOK_MAX / (1024 * 1024))}MB). Compress the PDF or enable R2 storage in Cloudflare.`,
        },
        400
      );
    }

    const name = (file.name || "handbook.pdf").toLowerCase();
    const isPdf = file.type.includes("pdf") || name.endsWith(".pdf");
    const contentType = isPdf
      ? "application/pdf"
      : file.type || "application/octet-stream";
    const ext = isPdf
      ? "pdf"
      : name.includes(".")
        ? name.split(".").pop()?.replace(/[^a-z0-9]/g, "") || "bin"
        : "bin";
    const key = `handbooks/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (c.env.RECEIPTS) {
      await c.env.RECEIPTS.put(key, buf, {
        httpMetadata: { contentType },
      });
    } else {
      try {
        await putD1BlobChunked(c.env.DB, key, contentType, bytes);
      } catch (storeErr) {
        const sm = storeErr instanceof Error ? storeErr.message : String(storeErr);
        return c.json(
          {
            error: `Could not store handbook (${sm.slice(0, 140)}). Try a smaller PDF or enable R2.`,
          },
          500
        );
      }
    }

    // Deactivate prior versions (new upload becomes the one to acknowledge)
    await c.env.DB.prepare(`UPDATE employee_handbooks SET active = 0 WHERE active = 1`).run();
    const r = await c.env.DB.prepare(
      `INSERT INTO employee_handbooks (
         title, version_label, file_key, content_type, file_size, active,
         uploaded_by_user_id, notes
       ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
    )
      .bind(title, version, key, contentType, file.size, user.id, notes)
      .run();
    const id = Number(r.meta.last_row_id);

    // Notify all active staff they need to re-ack
    const all = await c.env.DB.prepare(`SELECT id FROM users WHERE active = 1`).all<{ id: number }>();
    await notifyUsers(
      c.env.DB,
      (all.results || []).map((u) => u.id).filter((id) => id !== user.id),
      "handbook_new",
      "New employee handbook",
      `${title}${version ? ` (${version})` : ""} — please read and acknowledge in the app.`,
      { type: "handbook", id }
    );
    await writeAudit(c.env.DB, user, "create", "handbook", id, `Uploaded handbook ${title}`);
    return c.json({ ok: true, id, file_key: key }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 028_employee_handbook.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/handbook/acknowledge", async (c) => {
  const user = c.get("user");
  let body: { handbook_id?: number; ack_name?: string; confirmed?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    let bookId = Number(body.handbook_id) || 0;
    if (!bookId) {
      const book = await c.env.DB.prepare(
        `SELECT id FROM employee_handbooks WHERE active = 1 ORDER BY created_at DESC LIMIT 1`
      ).first<{ id: number }>();
      bookId = book?.id || 0;
    }
    if (!bookId) return c.json({ error: "No handbook to acknowledge" }, 400);

    // Already acknowledged — leave first stamp (no re-ack / no self-clear)
    const existing = await c.env.DB.prepare(
      `SELECT acknowledged_at, ack_name FROM handbook_acknowledgments
       WHERE handbook_id = ? AND user_id = ?`
    )
      .bind(bookId, user.id)
      .first<{ acknowledged_at: string; ack_name: string | null }>();
    if (existing) {
      return c.json({
        ok: true,
        already: true,
        acknowledged_at: existing.acknowledged_at,
        ack_name: existing.ack_name,
      });
    }

    if (body.confirmed === false) {
      return c.json({ error: "Confirm that you have read the handbook" }, 400);
    }
    const name = (body.ack_name || user.display_name || user.username || "Staff").trim();

    await c.env.DB.prepare(
      `INSERT INTO handbook_acknowledgments (handbook_id, user_id, acknowledged_at, ack_name)
       VALUES (?, ?, datetime('now'), ?)`
    )
      .bind(bookId, user.id, name)
      .run();

    await writeAudit(
      c.env.DB,
      user,
      "update",
      "handbook",
      bookId,
      `Acknowledged handbook as “${name}”`
    );
    return c.json({ ok: true, already: false });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Acknowledge failed" }, 500);
  }
});

// ——— New hire onboarding blanks (official W-4 / I-9, admin-replaceable) ———
const ONBOARDING_DEFAULTS: Record<
  "w4" | "i9",
  { version_label: string; static_path: string }
> = {
  w4: { version_label: "2026", static_path: "/onboarding/w4.pdf" },
  i9: { version_label: "Expires 05/31/2027", static_path: "/onboarding/i9.pdf" },
};

async function ensureOnboardingFormsTable(db: D1Database) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS onboarding_forms (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT NOT NULL UNIQUE CHECK (kind IN ('w4', 'i9')),
         version_label TEXT,
         file_key TEXT NOT NULL,
         content_type TEXT NOT NULL DEFAULT 'application/pdf',
         file_size INTEGER,
         uploaded_by_user_id INTEGER REFERENCES users(id),
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
}

api.get(
  "/onboarding/forms",
  requireRoles(["admin", "office", "supervisor"] as Role[]),
  async (c) => {
    try {
      await ensureOnboardingFormsTable(c.env.DB);
    } catch {
      /* continue with static defaults */
    }
    const out: Record<
      string,
      { kind: string; version_label: string; url: string; source: string; updated_at: string | null }
    > = {};
    for (const kind of ["w4", "i9"] as const) {
      const def = ONBOARDING_DEFAULTS[kind];
      let row: {
        version_label: string | null;
        file_key: string;
        updated_at: string;
      } | null = null;
      try {
        row = await c.env.DB.prepare(
          `SELECT version_label, file_key, updated_at FROM onboarding_forms WHERE kind = ?`
        )
          .bind(kind)
          .first();
      } catch {
        row = null;
      }
      if (row?.file_key) {
        out[kind] = {
          kind,
          version_label: row.version_label || def.version_label,
          url: `/api/uploads/${encodeURIComponent(row.file_key)}`,
          source: "upload",
          updated_at: row.updated_at,
        };
      } else {
        out[kind] = {
          kind,
          version_label: def.version_label,
          url: def.static_path,
          source: "bundled",
          updated_at: null,
        };
      }
    }
    return c.json({ forms: out });
  }
);

api.post(
  "/onboarding/forms/:kind",
  requireRoles(["admin", "office"] as Role[]),
  async (c) => {
    const user = c.get("user");
    const kind = c.req.param("kind") as "w4" | "i9";
    if (kind !== "w4" && kind !== "i9") {
      return c.json({ error: "kind must be w4 or i9" }, 400);
    }
    try {
      await ensureOnboardingFormsTable(c.env.DB);
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof File) || !file.size) {
        return c.json({ error: "PDF file required" }, 400);
      }
      const name = (file.name || "").toLowerCase();
      if (!file.type.includes("pdf") && !name.endsWith(".pdf")) {
        return c.json({ error: "PDF only" }, 400);
      }
      if (file.size > 15 * 1024 * 1024) {
        return c.json({ error: "File too large (max 15MB)" }, 400);
      }
      const version =
        String(form.get("version_label") || "").trim() ||
        ONBOARDING_DEFAULTS[kind].version_label;
      const key = `onboarding/${kind}-${Date.now()}.pdf`;
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (c.env.RECEIPTS) {
        await c.env.RECEIPTS.put(key, buf, {
          httpMetadata: { contentType: "application/pdf" },
        });
      } else {
        await putD1BlobChunked(c.env.DB, key, "application/pdf", bytes);
      }
      await c.env.DB.prepare(
        `INSERT INTO onboarding_forms (kind, version_label, file_key, content_type, file_size, uploaded_by_user_id, updated_at)
         VALUES (?, ?, ?, 'application/pdf', ?, ?, datetime('now'))
         ON CONFLICT(kind) DO UPDATE SET
           version_label = excluded.version_label,
           file_key = excluded.file_key,
           content_type = excluded.content_type,
           file_size = excluded.file_size,
           uploaded_by_user_id = excluded.uploaded_by_user_id,
           updated_at = datetime('now')`
      )
        .bind(kind, version, key, file.size, user.id)
        .run();
      await writeAudit(
        c.env.DB,
        user,
        "update",
        "onboarding_form",
        0,
        `Replaced onboarding ${kind.toUpperCase()} (${version})`
      );
      return c.json({
        ok: true,
        kind,
        version_label: version,
        url: `/api/uploads/${encodeURIComponent(key)}`,
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Upload failed" }, 500);
    }
  }
);

/** Admin only: clear someone's acknowledgment (staff cannot undo their own). */
api.delete(
  "/handbook/acknowledgments/:userId",
  requireRoles(["admin"]),
  async (c) => {
    const admin = c.get("user");
    const userId = Number(c.req.param("userId"));
    if (!userId) return c.json({ error: "userId required" }, 400);
    try {
      const book = await c.env.DB.prepare(
        `SELECT id, title FROM employee_handbooks WHERE active = 1 ORDER BY created_at DESC LIMIT 1`
      ).first<{ id: number; title: string }>();
      if (!book) return c.json({ error: "No active handbook" }, 404);

      const before = await c.env.DB.prepare(
        `SELECT user_id, ack_name, acknowledged_at FROM handbook_acknowledgments
         WHERE handbook_id = ? AND user_id = ?`
      )
        .bind(book.id, userId)
        .first();
      if (!before) return c.json({ error: "No acknowledgment on file for that user" }, 404);

      await c.env.DB.prepare(
        `DELETE FROM handbook_acknowledgments WHERE handbook_id = ? AND user_id = ?`
      )
        .bind(book.id, userId)
        .run();

      await writeAudit(
        c.env.DB,
        admin,
        "delete",
        "handbook",
        book.id,
        `Admin cleared handbook ack for user #${userId}`
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Could not clear" }, 500);
    }
  }
);

// ——— SMS (Twilio) ———
api.get("/sms/status", async (c) => {
  const me = c.get("user");
  const shop = await getSetting(c.env.DB, "shop_sms_phone", "");
  const mechanic = await getSetting(c.env.DB, "mechanic_sms_phone", "");
  const office = await getSetting(c.env.DB, "office_sms_phone", "");
  const discord = await getSetting(c.env.DB, "discord_webhook_url", "");
  const canSeeShop = ["admin", "office", "mechanic", "supervisor"].includes(me.role);
  return c.json({
    configured: smsConfigured(c.env),
    shop_phone_set: Boolean(normalizePhone(shop)),
    shop_phone: canSeeShop ? shop : undefined,
    mechanic_phone: canSeeShop ? mechanic : undefined,
    office_phone: canSeeShop ? office : undefined,
    free_alerts: {
      discord: Boolean(discord.trim()),
      in_app: true,
    },
  });
});

/** Shop line for driver texts / emergency SMS — admin, office, or mechanic can update */
api.put("/sms/shop-phone", requireRoles(["admin", "office", "mechanic", "supervisor"] as Role[]), async (c) => {
  const body = await c.req.json<{ phone?: string }>();
  const phone = (body.phone || "").trim();
  await setSetting(c.env.DB, "shop_sms_phone", phone);
  await writeAudit(c.env.DB, c.get("user"), "update", "settings", "shop_sms_phone", "Updated shop SMS number");
  return c.json({ ok: true, shop_phone: phone, normalized: normalizePhone(phone) });
});

/**
 * Admin role contact lines: shop, mechanic, office.
 * Used for SMS on emergencies and as driver text targets.
 */
api.put("/sms/role-phones", requireRoles(["admin"] as Role[]), async (c) => {
  const body = await c.req.json<{
    shop_phone?: string;
    mechanic_phone?: string;
    office_phone?: string;
  }>();
  if (body.shop_phone !== undefined) {
    await setSetting(c.env.DB, "shop_sms_phone", body.shop_phone.trim());
  }
  if (body.mechanic_phone !== undefined) {
    await setSetting(c.env.DB, "mechanic_sms_phone", body.mechanic_phone.trim());
  }
  if (body.office_phone !== undefined) {
    await setSetting(c.env.DB, "office_sms_phone", body.office_phone.trim());
  }
  await writeAudit(
    c.env.DB,
    c.get("user"),
    "update",
    "settings",
    "role_phones",
    "Updated shop / mechanic / office SMS numbers"
  );
  return c.json({
    ok: true,
    shop_phone: await getSetting(c.env.DB, "shop_sms_phone", ""),
    mechanic_phone: await getSetting(c.env.DB, "mechanic_sms_phone", ""),
    office_phone: await getSetting(c.env.DB, "office_sms_phone", ""),
  });
});

/** Optional Discord webhook for office alerts (admin/office/mechanic) */
api.put("/alerts/channels", requireRoles(["admin", "office", "mechanic", "supervisor"] as Role[]), async (c) => {
  const body = await c.req.json<{
    discord_webhook_url?: string;
  }>();
  if (body.discord_webhook_url !== undefined) {
    await setSetting(c.env.DB, "discord_webhook_url", body.discord_webhook_url.trim());
  }
  await writeAudit(c.env.DB, c.get("user"), "update", "settings", "alert_channels", "Updated alert channels");
  return c.json({ ok: true });
});

/** Contacts the current user can text (drivers for shop; shop for drivers). */
api.get("/sms/contacts", async (c) => {
  const me = c.get("user");
  const contacts: Array<{
    user_id: number | null;
    name: string;
    phone: string;
    role: string;
    unit_number?: string | null;
  }> = [];

  if (me.role === "driver") {
    const roleLines: Array<{ key: string; name: string; role: string }> = [
      { key: "shop_sms_phone", name: "Shop line", role: "shop" },
      { key: "mechanic_sms_phone", name: "Mechanic", role: "mechanic" },
      { key: "office_sms_phone", name: "Office", role: "office" },
    ];
    const seenPhones = new Set<string>();
    for (const line of roleLines) {
      const raw = await getSetting(c.env.DB, line.key, "");
      const n = normalizePhone(raw);
      if (!n || seenPhones.has(n)) continue;
      seenPhones.add(n);
      contacts.push({
        user_id: null,
        name: line.name,
        phone: n,
        role: line.role,
      });
    }
    // Also list individual shop-side users with phones
    const mechs = await c.env.DB.prepare(
      `SELECT id, display_name, phone, role FROM users
       WHERE active = 1 AND role IN ('mechanic','admin','office')
         AND phone IS NOT NULL AND TRIM(phone) != ''
       ORDER BY role, display_name`
    ).all<{ id: number; display_name: string; phone: string; role: string }>();
    for (const m of mechs.results || []) {
      const n = normalizePhone(m.phone);
      if (!n || seenPhones.has(n)) continue;
      seenPhones.add(n);
      contacts.push({
        user_id: m.id,
        name: m.display_name,
        phone: n,
        role: m.role,
      });
    }
  } else if (["mechanic", "admin", "office", "supervisor"].includes(me.role)) {
    // Admin: everyone with a phone (so you can text yourself). Shop roles: drivers only.
    const roleFilter =
      me.role === "admin"
        ? `u.active = 1 AND u.phone IS NOT NULL AND TRIM(u.phone) != ''`
        : `u.active = 1 AND u.role = 'driver' AND u.phone IS NOT NULL AND TRIM(u.phone) != ''`;
    const drivers = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.phone, u.role, u.employee_id, e.name as employee_name
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       WHERE ${roleFilter}
       ORDER BY u.display_name`
    ).all<{
      id: number;
      display_name: string;
      phone: string;
      role: string;
      employee_id: number | null;
      employee_name: string | null;
    }>();

    const vehicles = await c.env.DB.prepare(
      `SELECT unit_number, assigned_driver FROM vehicles WHERE status != 'retired' AND assigned_driver IS NOT NULL`
    ).all<{ unit_number: string; assigned_driver: string }>();

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/\(.*?\)/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    for (const d of drivers.results || []) {
      const n = normalizePhone(d.phone);
      if (!n) continue;
      const names = [d.display_name, d.employee_name].filter(Boolean).map((x) => norm(String(x)));
      let unit: string | null = null;
      for (const v of vehicles.results || []) {
        const ad = norm(v.assigned_driver || "");
        if (names.some((nm) => nm && (ad === nm || ad.includes(nm) || nm.includes(ad)))) {
          unit = v.unit_number;
          break;
        }
      }
      contacts.push({
        user_id: d.id,
        name: d.display_name,
        phone: n,
        role: d.role,
        unit_number: unit,
      });
    }
  }

  return c.json({
    configured: smsConfigured(c.env),
    contacts,
  });
});

/** Manual “Send a text” from Settings — admin only. Automated alerts still use sendSms(). */
api.post("/sms/send", async (c) => {
  const me = c.get("user");
  if (me.role !== "admin") {
    return c.json({ error: "Only admin can send texts from Settings" }, 403);
  }
  const body = await c.req.json<{
    to_user_id?: number;
    to_phone?: string;
    message: string;
    context?: string;
  }>();
  const message = (body.message || "").trim();
  if (!message) return c.json({ error: "Message required" }, 400);

  let toPhone: string | null = null;
  let toUserId: number | null = null;

  if (body.to_user_id) {
    const target = await c.env.DB.prepare(
      "SELECT id, phone, role, display_name FROM users WHERE id = ? AND active = 1"
    )
      .bind(body.to_user_id)
      .first<{ id: number; phone: string | null; role: string; display_name: string }>();
    if (!target?.phone) {
      return c.json({ error: "That person has no phone number on file" }, 400);
    }
    toPhone = normalizePhone(target.phone);
    toUserId = target.id;
  } else if (body.to_phone) {
    toPhone = normalizePhone(body.to_phone);
  }

  if (!toPhone) return c.json({ error: "Valid destination phone required" }, 400);

  const prefix = `TA Fleet (${me.display_name}): `;
  const full = `${prefix}${message}`.slice(0, 1500);
  const sent = await sendSms(c.env, toPhone, full);
  await logSms(c.env.DB, {
    from_user_id: me.id,
    to_user_id: toUserId,
    to_phone: toPhone,
    body: full,
    status: sent.ok ? "sent" : "failed",
    provider_sid: sent.ok ? sent.sid : null,
    error: sent.ok ? null : sent.error,
    context: body.context || "manual",
  });

  if (!sent.ok) return c.json({ error: sent.error }, 502);
  await writeAudit(c.env.DB, me, "sms", "sms", null, `SMS to ${toPhone}`);
  return c.json({ ok: true, sid: sent.sid });
});

/**
 * One-tap SMS health check: texts the signed-in user's phone on file.
 * Returns Twilio success/error so Settings can show what went wrong.
 */
api.post("/sms/test", async (c) => {
  const me = c.get("user");
  if (!smsConfigured(c.env)) {
    return c.json(
      {
        ok: false,
        error:
          "SMS is not set up. Add Twilio secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_MESSAGING_SERVICE_SID (or TWILIO_FROM_NUMBER as fallback).",
      },
      503
    );
  }
  const row = await c.env.DB.prepare(
    "SELECT phone FROM users WHERE id = ? AND active = 1"
  )
    .bind(me.id)
    .first<{ phone: string | null }>();
  const toPhone = normalizePhone(row?.phone || me.phone || null);
  if (!toPhone) {
    return c.json(
      {
        ok: false,
        error:
          "Save your mobile number under SMS account notifications first, then try again.",
      },
      400
    );
  }
  const when = new Date().toLocaleString("en-US", {
    dateStyle: "short",
    timeStyle: "short",
  });
  const full = `TA Fleet test: SMS is working for ${me.display_name}. Sent ${when}. Reply STOP to opt out.`.slice(
    0,
    1500
  );
  const sent = await sendSms(c.env, toPhone, full);
  await logSms(c.env.DB, {
    from_user_id: me.id,
    to_user_id: me.id,
    to_phone: toPhone,
    body: full,
    status: sent.ok ? "sent" : "failed",
    provider_sid: sent.ok ? sent.sid : null,
    error: sent.ok ? null : sent.error,
    context: "sms_test",
  });
  if (!sent.ok) {
    return c.json({ ok: false, error: sent.error, to_phone: toPhone }, 502);
  }
  await writeAudit(c.env.DB, me, "sms", "sms", null, `SMS test to ${toPhone}`);
  return c.json({
    ok: true,
    sid: sent.sid,
    to_phone: toPhone,
    sender_mode: sent.sender_mode,
    messaging_service_sid:
      sent.sender_mode === "messaging_service"
        ? (c.env.TWILIO_MESSAGING_SERVICE_SID || "").trim() || null
        : null,
  });
});

/**
 * Admin: verify Messaging Service sender pool + A2P campaign link using Worker Twilio secrets.
 * Does not expose auth tokens. Used to confirm *6925 is on MG… and campaign CM… is linked.
 */
api.get("/sms/sender-check", requireRoles(["admin"] as Role[]), async (c) => {
  const accountSid = (c.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = (c.env.TWILIO_AUTH_TOKEN || "").trim();
  const mg = (c.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  const fromFallback = (c.env.TWILIO_FROM_NUMBER || "").trim();
  const expectMg = "MG88e9c097fbaf5b638d4db74c770c4b77";
  const expectCm = "CM3700899ea0f3826c3d97051b83ee0ebc";
  const expectFromDigits = "13614466925";

  if (!accountSid || !token) {
    return c.json({ ok: false, error: "Twilio Account SID / Auth Token missing" }, 503);
  }
  if (!mg) {
    return c.json({
      ok: false,
      error: "TWILIO_MESSAGING_SERVICE_SID is empty — sends would use From fallback",
      from_fallback_last4: fromFallback.replace(/\D/g, "").slice(-4) || null,
    }, 503);
  }

  const auth = btoa(`${accountSid}:${token}`);
  const headers = { Authorization: `Basic ${auth}` };
  const digits = (p: string) => String(p || "").replace(/\D/g, "");

  const svcRes = await fetch(`https://messaging.twilio.com/v1/Services/${mg}`, { headers });
  const svc = (await svcRes.json()) as {
    sid?: string;
    friendly_name?: string;
    message?: string;
  };

  const pnRes = await fetch(
    `https://messaging.twilio.com/v1/Services/${mg}/PhoneNumbers?PageSize=50`,
    { headers }
  );
  const pn = (await pnRes.json()) as {
    phone_numbers?: Array<{ phone_number?: string }>;
    message?: string;
  };
  const pool = pn.phone_numbers || [];
  const poolLast4 = pool.map((p) => digits(p.phone_number || "").slice(-4));
  const has6925 = pool.some((p) => digits(p.phone_number || "").endsWith("6925"));
  const has3688 = pool.some((p) => digits(p.phone_number || "").endsWith("3688"));

  const cmRes = await fetch(
    `https://messaging.twilio.com/v1/Services/${mg}/UsAppToPerson/${expectCm}`,
    { headers }
  );
  const cm = (await cmRes.json()) as {
    sid?: string;
    campaign_status?: string;
    status?: string;
    message?: string;
  };

  const sendPath =
    mg
      ? "MessagingServiceSid only (From not sent)"
      : "From fallback only";

  return c.json({
    ok: svcRes.ok && has6925 && cmRes.ok && cm.sid === expectCm,
    send_path: sendPath,
    messaging_service: {
      configured: mg,
      matches_expected: mg === expectMg,
      http: svcRes.status,
      sid: svc.sid || null,
      friendly_name: svc.friendly_name || null,
      error: svc.message || null,
    },
    sender_pool: {
      count: pool.length,
      last4: poolLast4,
      has_6925: has6925,
      has_3688: has3688,
      expect_digits_last4: expectFromDigits.slice(-4),
    },
    campaign: {
      expect_sid: expectCm,
      http: cmRes.status,
      sid: cm.sid || null,
      status: cm.campaign_status || cm.status || null,
      linked: cm.sid === expectCm,
      error: cm.message || null,
    },
    from_fallback_last4: fromFallback.replace(/\D/g, "").slice(-4) || null,
    from_fallback_is_6925: digits(fromFallback).endsWith("6925"),
  });
});

/** Recent SMS attempts — admin / office / mechanic for troubleshooting */
api.get("/sms/log", requireRoles(["admin", "office", "mechanic", "supervisor"] as Role[]), async (c) => {
  const limit = Math.min(100, Math.max(10, Number(c.req.query("limit") || "40")));
  const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, from_user_id, to_user_id, to_phone, body, status, provider_sid, error, context, created_at
       FROM sms_log
       ORDER BY id DESC
       LIMIT ?`
    )
      .bind(limit)
      .all<{
        id: number;
        from_user_id: number | null;
        to_user_id: number | null;
        to_phone: string;
        body: string;
        status: string;
        provider_sid: string | null;
        error: string | null;
        context: string | null;
        created_at: string;
      }>();
    let log = rows.results || [];

    // Optionally ask Twilio for final delivery on recent SIDs (queued/sent ≠ on the phone)
    if (refresh && smsConfigured(c.env)) {
      const toCheck = log
        .filter(
          (r) =>
            r.provider_sid &&
            /^SM/i.test(r.provider_sid) &&
            !["delivered", "undelivered", "failed"].includes(String(r.status || "").toLowerCase())
        )
        .slice(0, 8);
      for (const row of toCheck) {
        const looked = await fetchTwilioMessageStatus(c.env, row.provider_sid!);
        if (!looked.ok) continue;
        const mapped = applyTwilioStatusToLog(looked.message);
        await c.env.DB.prepare(
          `UPDATE sms_log SET status = ?, error = ? WHERE id = ?`
        )
          .bind(mapped.status, mapped.error, row.id)
          .run();
        row.status = mapped.status;
        row.error = mapped.error;
        (row as { twilio_status?: string }).twilio_status = looked.message.status;
        (row as { twilio_from?: string | null }).twilio_from = looked.message.from;
      }
      // Re-read so UI gets updated rows
      const again = await c.env.DB.prepare(
        `SELECT id, from_user_id, to_user_id, to_phone, body, status, provider_sid, error, context, created_at
         FROM sms_log ORDER BY id DESC LIMIT ?`
      )
        .bind(limit)
        .all();
      log = (again.results || []) as typeof log;
    }

    const fromMasked = (() => {
      const n = normalizePhone(c.env.TWILIO_FROM_NUMBER || "");
      if (!n || n.length < 6) return null;
      return `${n.slice(0, 2)}***${n.slice(-4)}`;
    })();
    const messagingService = (c.env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
    const messagingMasked = messagingService
      ? `${messagingService.slice(0, 4)}…${messagingService.slice(-4)}`
      : null;

    return c.json({
      configured: smsConfigured(c.env),
      from_masked: fromMasked,
      messaging_service_masked: messagingMasked,
      using_messaging_service: Boolean(messagingService),
      log,
    });
  } catch {
    return c.json({ configured: smsConfigured(c.env), log: [], error: "sms_log table missing" });
  }
});

/** Refresh one SMS row’s delivery status from Twilio by log id or message SID */
api.post("/sms/refresh-status", requireRoles(["admin", "office", "mechanic", "supervisor"] as Role[]), async (c) => {
  const body = await c.req.json<{ id?: number; sid?: string }>().catch(() => ({} as { id?: number; sid?: string }));
  let sid = (body.sid || "").trim();
  let logId = body.id ? Number(body.id) : null;
  if (!sid && logId) {
    const row = await c.env.DB.prepare(
      `SELECT id, provider_sid FROM sms_log WHERE id = ?`
    )
      .bind(logId)
      .first<{ id: number; provider_sid: string | null }>();
    sid = row?.provider_sid || "";
  }
  if (!sid) return c.json({ error: "id or sid required" }, 400);
  const looked = await fetchTwilioMessageStatus(c.env, sid);
  if (!looked.ok) return c.json({ error: looked.error }, 502);
  const mapped = applyTwilioStatusToLog(looked.message);
  if (logId) {
    await c.env.DB.prepare(`UPDATE sms_log SET status = ?, error = ? WHERE id = ?`)
      .bind(mapped.status, mapped.error, logId)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE sms_log SET status = ?, error = ? WHERE provider_sid = ?`
    )
      .bind(mapped.status, mapped.error, sid)
      .run();
  }
  return c.json({
    ok: true,
    twilio: looked.message,
    status: mapped.status,
    error: mapped.error,
  });
});

// Inspections + weekly vehicle checks
api.get("/inspections", async (c) => {
  const driverVids = await getDriverVehicleIds(c.env.DB, c.get("user"));
  const sc = driverVids !== null ? sqlInIds("i.vehicle_id", driverVids) : null;
  const rows = await c.env.DB.prepare(
    `SELECT i.*, v.unit_number, u.display_name as inspector_name
     FROM inspections i
     JOIN vehicles v ON v.id = i.vehicle_id
     JOIN users u ON u.id = i.inspector_user_id
     WHERE 1=1${sc?.clause || ""}
     ORDER BY i.inspection_date DESC, i.id DESC LIMIT 200`
  )
    .bind(...(sc?.binds || []))
    .all();
  return c.json({ inspections: rows.results });
});

/** Weekly status for all active units (drivers: assigned only). */
api.get("/inspections/weekly-status", async (c) => {
  const me = c.get("user");
  const driverVids = await getDriverVehicleIds(c.env.DB, me);

  let sql = `
    SELECT v.id as vehicle_id, v.unit_number, v.assigned_driver, v.status,
      (SELECT MAX(i.inspection_date) FROM inspections i WHERE i.vehicle_id = v.id) as last_check_date,
      (SELECT overall_status FROM inspections i WHERE i.vehicle_id = v.id
         ORDER BY i.inspection_date DESC, i.id DESC LIMIT 1) as last_status,
      CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM inspections i
          WHERE i.vehicle_id = v.id AND i.inspection_date >= date('now', '-7 days')
        ) THEN 1 ELSE 0
      END as due,
      (SELECT COUNT(*) FROM vehicle_issues vi
        WHERE vi.vehicle_id = v.id AND vi.status IN ('open','scheduled','in_progress')
      ) as open_repairs
    FROM vehicles v
    WHERE v.status != 'retired'`;
  const binds: unknown[] = [];
  if (driverVids !== null) {
    const sc = sqlInIds("v.id", driverVids);
    sql += sc.clause;
    binds.push(...sc.binds);
  }
  // Down / repairs first, then weekly-due, then unit number
  sql += ` ORDER BY
    CASE WHEN v.status = 'out_of_service' THEN 0 ELSE 1 END,
    CASE WHEN open_repairs > 0 THEN 0 ELSE 1 END,
    due DESC,
    v.unit_number`;
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ vehicles: rows.results, week_days: 7 });
});

api.post("/inspections", requireRoles(ROLE_PERMS.reportIssues), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    vehicle_id: number;
    inspection_date?: string;
    odometer?: number | null;
    overall_status: string;
    checklist?: Record<string, string>;
    notes?: string | null;
    create_issue_on_fail?: boolean;
  }>();
  if (!body.vehicle_id || !body.overall_status) {
    return c.json({ error: "vehicle_id and overall_status required" }, 400);
  }
  const driverVids = await getDriverVehicleIds(c.env.DB, user);
  if (!assertDriverVehicleAccess(driverVids, body.vehicle_id)) {
    return c.json({ error: "You can only check your assigned vehicle" }, 403);
  }
  if (!["pass", "pass_with_notes", "fail"].includes(body.overall_status)) {
    return c.json({ error: "overall_status must be pass, pass_with_notes, or fail" }, 400);
  }
  // Open a shop ticket when problems are reported; never for a clean pass.
  // create_issue_on_fail defaults to true for non-pass (client may omit it).
  let createdIssueId: number | null = null;
  const hasProblems =
    body.overall_status === "fail" || body.overall_status === "pass_with_notes";
  const shouldOpenIssue =
    hasProblems && body.create_issue_on_fail !== false && body.overall_status !== "pass";
  if (shouldOpenIssue && body.overall_status === "fail") {
    const fails = Object.entries(body.checklist || {})
      .filter(([, v]) => v === "fail" || v === "attention")
      .map(([k]) => k);
    const title = `Weekly check issue — ${fails.slice(0, 3).join(", ") || body.notes?.slice(0, 40) || "see notes"}`;
    const issue = await c.env.DB.prepare(
      `INSERT INTO vehicle_issues (vehicle_id, reported_by_user_id, severity, title, description, status)
       VALUES (?, ?, 'high', ?, ?, 'open')`
    )
      .bind(
        body.vehicle_id,
        user.id,
        title,
        body.notes || JSON.stringify(body.checklist || {})
      )
      .run();
    createdIssueId = issue.meta.last_row_id as number;
  } else if (shouldOpenIssue && body.overall_status === "pass_with_notes") {
    // Needs-repair / attention — always open a shop ticket (notes preferred)
    const note = (body.notes || "").trim();
    const badItems = Object.entries(body.checklist || {})
      .filter(([, v]) => v === "fail" || v === "attention")
      .map(([k]) => k.replace(/_/g, " "));
    const desc =
      note ||
      (badItems.length ? `Items needing attention: ${badItems.join(", ")}` : "Weekly check — needs repair");
    const title = note
      ? `Weekly check — ${note.slice(0, 48)}${note.length > 48 ? "…" : ""}`
      : `Weekly check — needs repair${badItems.length ? ` (${badItems.slice(0, 2).join(", ")})` : ""}`;
    const issue = await c.env.DB.prepare(
      `INSERT INTO vehicle_issues (vehicle_id, reported_by_user_id, severity, title, description, status)
       VALUES (?, ?, 'medium', ?, ?, 'open')`
    )
      .bind(body.vehicle_id, user.id, title, desc)
      .run();
    createdIssueId = issue.meta.last_row_id as number;
  }
  const result = await c.env.DB.prepare(
    `INSERT INTO inspections
      (vehicle_id, inspector_user_id, inspection_date, odometer, overall_status, checklist_json, notes, created_issue_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.vehicle_id,
      user.id,
      body.inspection_date || new Date().toISOString().slice(0, 10),
      body.odometer ?? null,
      body.overall_status,
      JSON.stringify(body.checklist || {}),
      body.notes || null,
      createdIssueId
    )
    .run();
  const id = result.meta.last_row_id;
  await writeAudit(c.env.DB, user, "create", "inspection", id, `Inspection ${body.overall_status}`);
  const row = await c.env.DB.prepare("SELECT * FROM inspections WHERE id = ?").bind(id).first();
  return c.json({ inspection: row, created_issue_id: createdIssueId }, 201);
});

// Downtime
api.get("/downtime", requireRoles(ROLE_PERMS.viewReports), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.*, v.unit_number, i.title as issue_title,
            su.display_name as started_by_name, eu.display_name as ended_by_name,
            CASE
              WHEN d.ended_at IS NULL THEN (julianday('now') - julianday(d.started_at)) * 24
              ELSE (julianday(d.ended_at) - julianday(d.started_at)) * 24
            END as hours_down
     FROM downtime_events d
     JOIN vehicles v ON v.id = d.vehicle_id
     LEFT JOIN vehicle_issues i ON i.id = d.issue_id
     LEFT JOIN users su ON su.id = d.started_by_user_id
     LEFT JOIN users eu ON eu.id = d.ended_by_user_id
     ORDER BY d.started_at DESC LIMIT 300`
  ).all();
  return c.json({ events: rows.results });
});

api.get("/downtime/summary", requireRoles(ROLE_PERMS.viewReports), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT v.id as vehicle_id, v.unit_number,
       (SELECT COUNT(*) FROM downtime_events d WHERE d.vehicle_id = v.id AND d.ended_at IS NULL) as open_events,
       (SELECT COUNT(*) FROM downtime_events d WHERE d.vehicle_id = v.id AND d.ended_at IS NULL) as currently_down,
       COALESCE((
         SELECT SUM(
           CASE
             WHEN d.ended_at IS NULL AND d.started_at >= datetime('now', '-30 days')
               THEN (julianday('now') - julianday(d.started_at)) * 24
             WHEN d.ended_at IS NOT NULL AND d.started_at >= datetime('now', '-30 days')
               THEN (julianday(d.ended_at) - julianday(d.started_at)) * 24
             ELSE 0
           END
         ) FROM downtime_events d WHERE d.vehicle_id = v.id
       ), 0) as total_hours_30d
     FROM vehicles v
     WHERE v.status != 'retired'
     ORDER BY currently_down DESC, total_hours_30d DESC, v.unit_number`
  ).all();
  return c.json({ summary: rows.results });
});

// Users admin
api.get("/users", requireRoles(ROLE_PERMS.browseAdmin), async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.email, u.username, u.display_name, u.role, u.employee_id, u.phone,
              u.must_change_password, u.auth_provider, u.active, u.created_at,
              u.manager_user_id, m.display_name as manager_name,
              CASE WHEN u.password_hash IS NOT NULL AND TRIM(u.password_hash) != '' THEN 1 ELSE 0 END as has_password
       FROM users u
       LEFT JOIN users m ON m.id = u.manager_user_id
       ORDER BY u.display_name`
    ).all();
    // Attach open invite expiry when available (migration 030)
    let inviteByUser = new Map<number, string>();
    try {
      const invites = await c.env.DB.prepare(
        `SELECT user_id, MAX(expires_at) as expires_at
         FROM invite_tokens
         WHERE used_at IS NULL AND expires_at > datetime('now')
         GROUP BY user_id`
      ).all<{ user_id: number; expires_at: string }>();
      for (const r of invites.results || []) {
        inviteByUser.set(Number(r.user_id), String(r.expires_at));
      }
    } catch {
      /* invite table optional */
    }
    const users = (rows.results || []).map((u: Record<string, unknown>) => {
      const id = Number(u.id);
      const exp = inviteByUser.get(id) || null;
      const hasPw = Number(u.has_password) === 1;
      return {
        ...u,
        has_password: hasPw ? 1 : 0,
        invite_pending: exp || (!hasPw && Number(u.must_change_password) === 1) ? 1 : 0,
        invite_expires_at: exp,
      };
    });
    return c.json({ users });
  } catch {
    // Pre-migration 018 fallback
    const rows = await c.env.DB.prepare(
      `SELECT id, email, username, display_name, role, employee_id, phone,
              must_change_password, auth_provider, active, created_at
       FROM users ORDER BY display_name`
    ).all();
    return c.json({ users: rows.results });
  }
});

api.post("/users", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const body = await c.req.json<{
    display_name: string;
    username?: string;
    email?: string;
    password?: string;
    phone?: string;
    role: Role;
    employee_id?: number;
    manager_user_id?: number | null;
  }>();
  if (!body.display_name?.trim() || !body.role) {
    return c.json({ error: "display_name and role required" }, 400);
  }
  const username = body.username?.trim().toLowerCase() || null;
  if (!username) {
    return c.json({ error: "Username (login) is required" }, 400);
  }
  // Optional password only if admin insists; default is invite link (no temp password)
  const explicitPassword = body.password?.trim() || "";
  let passwordHash: string | null = null;
  let passwordSalt: string | null = null;
  if (explicitPassword) {
    if (explicitPassword.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }
    const p = await hashPassword(explicitPassword);
    passwordHash = p.hash;
    passwordSalt = p.salt;
  }
  const managerId =
    body.manager_user_id != null && Number(body.manager_user_id) > 0
      ? Number(body.manager_user_id)
      : null;
  const mapped = dbRoleFor(body.role as Role);
  const admin = c.get("user");
  try {
    let result;
    try {
      result = await c.env.DB.prepare(
        `INSERT INTO users (
           email, username, display_name, password_hash, password_salt, role,
           employee_id, phone, must_change_password, auth_provider, active, manager_user_id, is_warehouse
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'password', 1, ?, ?)`
      )
        .bind(
          body.email?.trim() || null,
          username,
          body.display_name.trim(),
          passwordHash,
          passwordSalt,
          mapped.role,
          body.employee_id ?? null,
          body.phone?.trim() || null,
          explicitPassword ? 0 : 1,
          managerId,
          mapped.is_warehouse
        )
        .run();
    } catch {
      try {
        result = await c.env.DB.prepare(
          `INSERT INTO users (
             email, username, display_name, password_hash, password_salt, role,
             employee_id, phone, must_change_password, auth_provider, active, manager_user_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'password', 1, ?)`
        )
          .bind(
            body.email?.trim() || null,
            username,
            body.display_name.trim(),
            passwordHash,
            passwordSalt,
            mapped.role,
            body.employee_id ?? null,
            body.phone?.trim() || null,
            explicitPassword ? 0 : 1,
            managerId
          )
          .run();
      } catch {
        result = await c.env.DB.prepare(
          `INSERT INTO users (
             email, username, display_name, password_hash, password_salt, role,
             employee_id, phone, must_change_password, auth_provider, active
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'password', 1)`
        )
          .bind(
            body.email?.trim() || null,
            username,
            body.display_name.trim(),
            passwordHash,
            passwordSalt,
            mapped.role,
            body.employee_id ?? null,
            body.phone?.trim() || null,
            explicitPassword ? 0 : 1
          )
          .run();
      }
    }
    const id = Number(result.meta.last_row_id);
    if (body.phone?.trim() && body.employee_id) {
      await c.env.DB.prepare(
        "UPDATE employees SET phone = ?, updated_at = datetime('now') WHERE id = ?"
      )
        .bind(body.phone.trim(), body.employee_id)
        .run();
    }

    let invite: { token: string; expires_at: string; invite_path: string } | null = null;
    if (!explicitPassword) {
      try {
        invite = await issueInviteToken(c.env.DB, {
          userId: id,
          username,
          createdByUserId: admin.id,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no such table/i.test(msg)) {
          return c.json(
            {
              error:
                "User created but invites need migration 030_invite_tokens.sql. Or set a password manually.",
            },
            503
          );
        }
        throw e;
      }
    }

    await writeAudit(
      c.env.DB,
      admin,
      "create",
      "user",
      id,
      `Created user ${body.display_name} (${body.role})${invite ? " · invite link" : ""}`
    );
    const row = await c.env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
    const base = new URL(c.req.url).origin;
    return c.json(
      {
        user: row ? toPublicUser(row) : null,
        invite_path: invite?.invite_path || null,
        invite_url: invite ? `${base}${invite.invite_path}` : null,
        expires_at: invite?.expires_at || null,
        temporary_password: explicitPassword || null,
      },
      201
    );
  } catch {
    return c.json({ error: "Could not create user (duplicate email/username?)" }, 400);
  }
});

api.patch("/users/:id", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
  const sets: string[] = [];
  const values: unknown[] = [];
  let newUsername: string | null = null;

  if (body.role !== undefined) {
    const mapped = dbRoleFor(String(body.role) as Role);
    sets.push("role = ?");
    values.push(mapped.role);
    sets.push("is_warehouse = ?");
    values.push(mapped.is_warehouse);
  }
  for (const f of ["display_name", "email", "username", "employee_id", "phone"] as const) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      let val = body[f] === "" ? null : body[f];
      if (f === "username" && typeof val === "string") {
        val = val.trim().toLowerCase();
        if (!val) return c.json({ error: "Username cannot be empty" }, 400);
        if (!/^[a-z0-9._-]{2,40}$/.test(val)) {
          return c.json(
            { error: "Username: 2–40 chars, letters/numbers . _ - only" },
            400
          );
        }
        newUsername = val;
      }
      values.push(val);
    }
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    values.push(body.active ? 1 : 0);
  }
  if (body.password && typeof body.password === "string") {
    const p = await hashPassword(body.password);
    sets.push("password_hash = ?", "password_salt = ?", "must_change_password = 1");
    values.push(p.hash, p.salt);
    sets.push(
      "auth_provider = CASE WHEN auth_provider = 'google' THEN 'both' ELSE COALESCE(auth_provider, 'password') END"
    );
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);

  // Duplicate username check
  if (newUsername) {
    const clash = await c.env.DB.prepare(
      `SELECT id FROM users WHERE lower(username) = ? AND id != ?`
    )
      .bind(newUsername, id)
      .first();
    if (clash) return c.json({ error: `Username @${newUsername} is already taken` }, 400);
  }

  sets.push("updated_at = datetime('now')");
  values.push(id);
  try {
    await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/unique|constraint/i.test(msg)) {
      return c.json({ error: "Username or email already in use" }, 400);
    }
    throw e;
  }
  // Keep open invite tokens in sync with corrected username (so join page matches)
  if (newUsername) {
    try {
      await c.env.DB.prepare(
        `UPDATE invite_tokens SET username = ?
         WHERE user_id = ? AND used_at IS NULL`
      )
        .bind(newUsername, id)
        .run();
    } catch {
      /* optional table */
    }
  }
  // Invalidate sessions on password reset or deactivate
  if (body.password || body.active === false || body.active === 0) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  }
  const after = await c.env.DB.prepare(
    `SELECT id, email, username, display_name, role, employee_id, phone,
            must_change_password, auth_provider, active, created_at FROM users WHERE id = ?`
  )
    .bind(id)
    .first();
  await writeAudit(
    c.env.DB,
    c.get("user"),
    body.password ? "password_reset" : "update",
    "user",
    id,
    body.password
      ? "Password reset by admin"
      : newUsername
        ? `Updated user (username → @${newUsername})`
        : "Updated user",
    before,
    after
  );
  return c.json({ user: after });
});

/** Issue a fresh join link so the user can set their own password (preferred). */
api.post("/users/:id/invite", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const id = Number(c.req.param("id"));
  const admin = c.get("user");
  const body = await c.req
    .json<{ username?: string; display_name?: string }>()
    .catch(() => ({} as { username?: string; display_name?: string }));

  const before = await c.env.DB.prepare(
    `SELECT id, username, display_name, active FROM users WHERE id = ?`
  )
    .bind(id)
    .first<{ id: number; username: string | null; display_name: string; active: number }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (!before.active) return c.json({ error: "Reactivate the user before inviting" }, 400);

  // Optional: fix username / display name in the same step as resending invite
  let username = (before.username || "").trim().toLowerCase();
  const wantUser = body.username?.trim().toLowerCase();
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (wantUser && wantUser !== username) {
    if (!/^[a-z0-9._-]{2,40}$/.test(wantUser)) {
      return c.json({ error: "Username: 2–40 chars, letters/numbers . _ - only" }, 400);
    }
    const clash = await c.env.DB.prepare(
      `SELECT id FROM users WHERE lower(username) = ? AND id != ?`
    )
      .bind(wantUser, id)
      .first();
    if (clash) return c.json({ error: `Username @${wantUser} is already taken` }, 400);
    sets.push("username = ?");
    vals.push(wantUser);
    username = wantUser;
  }
  if (body.display_name?.trim()) {
    sets.push("display_name = ?");
    vals.push(body.display_name.trim());
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    try {
      await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...vals)
        .run();
    } catch {
      return c.json({ error: "Could not update username (already taken?)" }, 400);
    }
  }

  if (!username) {
    return c.json({ error: "User needs a username before you can send an invite link" }, 400);
  }
  try {
    // Clear password so they must use the invite (optional hard lock)
    await c.env.DB.prepare(
      `UPDATE users SET password_hash = NULL, password_salt = NULL, must_change_password = 1,
       updated_at = datetime('now') WHERE id = ?`
    )
      .bind(id)
      .run();
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    const invite = await issueInviteToken(c.env.DB, {
      userId: id,
      username,
      createdByUserId: admin.id,
    });
    await writeAudit(
      c.env.DB,
      admin,
      "password_reset",
      "user",
      id,
      `Invite link issued for ${username}`
    );
    const base = new URL(c.req.url).origin;
    return c.json({
      ok: true,
      invite_path: invite.invite_path,
      invite_url: `${base}${invite.invite_path}`,
      expires_at: invite.expires_at,
      username,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 030_invite_tokens.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/users/:id/reset-password", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ password?: string; invite?: boolean }>().catch(() => ({} as { password?: string; invite?: boolean }));
  // Default: issue invite link (no temp password). Pass password only if admin sets one.
  if (!body.password?.trim() || body.invite) {
    // Re-use invite endpoint logic
    const admin = c.get("user");
    const before = await c.env.DB.prepare(
      `SELECT id, username, display_name, active FROM users WHERE id = ?`
    )
      .bind(id)
      .first<{ id: number; username: string | null; display_name: string; active: number }>();
    if (!before) return c.json({ error: "Not found" }, 404);
    if (!before.username?.trim()) {
      return c.json({ error: "User needs a username for an invite link" }, 400);
    }
    await c.env.DB.prepare(
      `UPDATE users SET password_hash = NULL, password_salt = NULL, must_change_password = 1,
       updated_at = datetime('now') WHERE id = ?`
    )
      .bind(id)
      .run();
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
    const invite = await issueInviteToken(c.env.DB, {
      userId: id,
      username: before.username,
      createdByUserId: admin.id,
    });
    await writeAudit(c.env.DB, admin, "password_reset", "user", id, `Invite link for password setup`);
    const base = new URL(c.req.url).origin;
    return c.json({
      ok: true,
      invite_path: invite.invite_path,
      invite_url: `${base}${invite.invite_path}`,
      expires_at: invite.expires_at,
      username: before.username,
    });
  }
  const password = body.password!.trim();
  if (password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const before = await c.env.DB.prepare("SELECT id, username, display_name FROM users WHERE id = ?")
    .bind(id)
    .first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const p = await hashPassword(password);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 1,
     auth_provider = CASE WHEN auth_provider = 'google' THEN 'both' ELSE COALESCE(auth_provider, 'password') END,
     updated_at = datetime('now') WHERE id = ?`
  )
    .bind(p.hash, p.salt, id)
    .run();
  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  await writeAudit(
    c.env.DB,
    c.get("user"),
    "password_reset",
    "user",
    id,
    `Password reset for ${(before as { display_name: string }).display_name}`
  );
  return c.json({ ok: true, temporary_password: password });
});

// Warehouse cameras — in-app snapshots via NVR ISAPI (no user login to NVR)
// Office / warehouse / admin only — not field drivers
function canViewWarehouseCameras(u: { role: string; is_warehouse?: boolean }): boolean {
  if (u.is_warehouse) return true;
  return (
    u.role === "admin" ||
    u.role === "office" ||
    u.role === "warehouse" ||
    u.role === "supervisor"
  );
}

api.get("/warehouse-cameras/config", async (c) => {
  const me = c.get("user");
  if (!canViewWarehouseCameras(me)) {
    return c.json({ error: "Security cameras are for office and warehouse only" }, 403);
  }
  const { buildCameraTiles, resolveWyzeCameras } = await import("./nvrProxy");
  const { nvr, cameras } = await buildCameraTiles(c.env, c.env.DB);
  const wyze = await resolveWyzeCameras(c.env.DB);
  return c.json({
    configured: nvr.configured,
    nvr_base_url: nvr.baseUrl || "",
    nvr_user: nvr.user,
    /** Password never returned — only whether set */
    nvr_pass_set: Boolean(nvr.pass),
    /** Legacy NVR-only list (kept for older clients) */
    channels: nvr.channels,
    /** Unified wall: NVR + Wyze */
    cameras,
    wyze_cameras: wyze,
    reachable_hint: nvr.reachableHint,
    /** True when URL looks like shop LAN (needs Cloudflare Tunnel) */
    needs_tunnel: /192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(nvr.baseUrl),
  });
});

api.put(
  "/warehouse-cameras/config",
  requireRoles(["admin"] as Role[]),
  async (c) => {
    const body = await c.req.json<{
      nvr_base_url?: string;
      nvr_user?: string;
      nvr_pass?: string;
      channels?: { id: number; label: string; enabled?: boolean }[];
      wyze_cameras?: {
        id: string;
        label: string;
        rtsp_path?: string;
        enabled?: boolean;
      }[];
    }>();
    if (body.nvr_base_url !== undefined) {
      let url = (body.nvr_base_url || "").trim().replace(/\/+$/, "");
      if (url && !/^https?:\/\//i.test(url)) {
        return c.json({ error: "URL must start with http:// or https://" }, 400);
      }
      await setSetting(c.env.DB, "warehouse_nvr_url", url);
    }
    if (body.nvr_user !== undefined) {
      await setSetting(c.env.DB, "warehouse_nvr_user", (body.nvr_user || "admin").trim());
    }
    if (body.nvr_pass !== undefined && body.nvr_pass !== "") {
      // Empty string means "leave unchanged"
      await setSetting(c.env.DB, "warehouse_nvr_pass", body.nvr_pass);
    }
    if (body.channels) {
      await setSetting(c.env.DB, "warehouse_nvr_channels", JSON.stringify(body.channels));
    }
    if (body.wyze_cameras) {
      const cleaned = body.wyze_cameras
        .filter((w) => w && w.id)
        .map((w) => ({
          id: String(w.id).trim(),
          label: String(w.label || w.id).trim(),
          rtsp_path: String(w.rtsp_path || w.id).trim(),
          enabled: w.enabled !== false,
        }));
      await setSetting(c.env.DB, "warehouse_wyze_cameras", JSON.stringify(cleaned));
    }
    await writeAudit(
      c.env.DB,
      c.get("user"),
      "update",
      "settings",
      "warehouse_nvr",
      "Updated security camera / NVR / Wyze settings"
    );
    return c.json({ ok: true });
  }
);

/** JPEG snapshot — key is nvr channel id or wyze:id / bare wyze id */
api.get("/warehouse-cameras/snapshot/:cameraKey", async (c) => {
  const me = c.get("user");
  if (!canViewWarehouseCameras(me)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  const rawKey = decodeURIComponent(c.req.param("cameraKey") || "");
  const {
    resolveNvrConfig,
    fetchNvrSnapshot,
    fetchWyzeSnapshot,
    parseCameraKey,
  } = await import("./nvrProxy");
  const parsed = parseCameraKey(rawKey);
  if (!parsed) {
    return c.json({ error: "Invalid camera key" }, 400);
  }
  const cfg = await resolveNvrConfig(c.env, c.env.DB);
  if (!cfg.configured) {
    return c.json(
      {
        error:
          "Cameras not configured yet. Contact admin to set up the NVR tunnel.",
      },
      503
    );
  }
  if (/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(cfg.baseUrl)) {
    return c.json(
      {
        error:
          "NVR is only on shop Wi‑Fi (192.168…). Cloud cannot reach it — the always-on tunnel on the shop PC must be running.",
      },
      503
    );
  }
  try {
    if (parsed.source === "wyze") {
      const snap = await fetchWyzeSnapshot(cfg.baseUrl, parsed.id);
      if (!snap.ok) {
        return c.json({ error: snap.error }, snap.status === 401 ? 401 : 502);
      }
      return new Response(snap.bytes, {
        status: 200,
        headers: {
          "Content-Type": snap.contentType,
          "Cache-Control": "no-store, no-cache, must-revalidate",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const channelId = Number(parsed.id);
    const snap = await fetchNvrSnapshot(cfg.baseUrl, cfg.user, cfg.pass, channelId, true);
    if (!snap.ok) {
      return c.json({ error: snap.error }, snap.status === 401 ? 401 : 502);
    }
    return new Response(snap.bytes, {
      status: 200,
      headers: {
        "Content-Type": snap.contentType,
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : "Camera proxy failed",
      },
      502
    );
  }
});

/** Search recorded segments for a channel + time range (ISO UTC) — legacy direct ISAPI */
api.get("/warehouse-cameras/search", async (c) => {
  const me = c.get("user");
  if (!canViewWarehouseCameras(me)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  const channelId = Number(c.req.query("channel") || "0");
  const start = new Date(c.req.query("start") || "");
  const end = new Date(c.req.query("end") || "");
  const { resolveNvrConfig, searchNvrRecordings } = await import("./nvrProxy");
  const cfg = await resolveNvrConfig(c.env, c.env.DB);
  if (!cfg.configured) {
    return c.json({ error: "Cameras not configured" }, 503);
  }
  if (/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(cfg.baseUrl)) {
    return c.json({ error: "NVR tunnel not configured (shop LAN only URL)" }, 503);
  }
  // Cap search window to 6 hours
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    end <= start ||
    end.getTime() - start.getTime() > 6 * 3600 * 1000
  ) {
    return c.json({ error: "Provide start & end (ISO). Max range 6 hours." }, 400);
  }
  const result = await searchNvrRecordings(
    cfg.baseUrl,
    cfg.user,
    cfg.pass,
    channelId,
    start,
    end
  );
  if (!result.ok) {
    return c.json({ error: result.error }, result.status === 401 ? 401 : 502);
  }
  return c.json({
    ok: true,
    channelId,
    start: start.toISOString(),
    end: end.toISOString(),
    segments: result.segments.map((s) => ({
      start: s.start,
      end: s.end,
      trackId: s.trackId,
    })),
  });
});

/**
 * Motion clips near a time — for emergency clip picker UI.
 * Uses shop media proxy (same search as playback), so list times match what plays.
 * Query: key=nvr:1|wyze:id (or channel / cam), around=ISO, padMin=60 (max 360)
 */
api.get("/warehouse-cameras/segments", async (c) => {
  const me = c.get("user");
  if (!canViewWarehouseCameras(me)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  const keyRaw =
    (c.req.query("key") || "").trim() ||
    (c.req.query("cam") ? `wyze:${c.req.query("cam")}` : "") ||
    (c.req.query("channel") || "").trim();
  const around = new Date(c.req.query("around") || c.req.query("start") || "");
  let padMin = Number(c.req.query("padMin") || "60");
  if (!Number.isFinite(padMin) || padMin < 5) padMin = 60;
  padMin = Math.min(360, padMin);
  const {
    resolveNvrConfig,
    fetchNvrSegmentsList,
    fetchWyzeSegmentsList,
    parseCameraKey,
  } = await import("./nvrProxy");
  const cfg = await resolveNvrConfig(c.env, c.env.DB);
  if (!cfg.configured) {
    return c.json({ error: "Cameras not configured" }, 503);
  }
  if (/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(cfg.baseUrl)) {
    return c.json({ error: "NVR tunnel not configured" }, 503);
  }
  if (Number.isNaN(around.getTime())) {
    return c.json({ error: "Provide around=ISO time" }, 400);
  }
  const parsed = parseCameraKey(keyRaw);
  if (!parsed) {
    return c.json({ error: "Provide channel, key, or cam" }, 400);
  }
  try {
    if (parsed.source === "wyze") {
      const result = await fetchWyzeSegmentsList(cfg.baseUrl, parsed.id, around, padMin);
      if (!result.ok) {
        return c.json({ error: result.error }, result.status === 404 ? 404 : 502);
      }
      return c.json({
        ok: true,
        key: `wyze:${parsed.id}`,
        around: result.around,
        padMin: result.padMin,
        nearestIndex: result.nearestIndex,
        nearestGapSec: result.nearestGapSec,
        segments: result.segments,
      });
    }
    const channelId = Number(parsed.id);
    const result = await fetchNvrSegmentsList(cfg.baseUrl, channelId, around, padMin);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status === 404 ? 404 : 502);
    }
    return c.json({
      ok: true,
      key: `nvr:${channelId}`,
      around: result.around,
      padMin: result.padMin,
      nearestIndex: result.nearestIndex,
      nearestGapSec: result.nearestGapSec,
      segments: result.segments,
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Segments search failed" },
      502
    );
  }
});

/**
 * Browser-playable MP4 clip (proxied through shop media proxy + ffmpeg).
 * Query: channel (NVR) OR key=wyze:id OR cam=wyzeId, start, end (ISO UTC).
 * Max 30 minutes per request.
 */
api.get("/warehouse-cameras/clip", async (c) => {
  const me = c.get("user");
  if (!canViewWarehouseCameras(me)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  const keyRaw =
    (c.req.query("key") || "").trim() ||
    (c.req.query("cam") ? `wyze:${c.req.query("cam")}` : "") ||
    (c.req.query("channel") || "").trim();
  const start = new Date(c.req.query("start") || "");
  let end = new Date(c.req.query("end") || "");
  const modeRaw = (c.req.query("mode") || "at").toLowerCase();
  const mode = modeRaw === "prev" || modeRaw === "next" ? modeRaw : "at";
  const { resolveNvrConfig, fetchNvrClipMp4, fetchWyzeClipMp4, parseCameraKey } =
    await import("./nvrProxy");
  const cfg = await resolveNvrConfig(c.env, c.env.DB);
  if (!cfg.configured) {
    return c.json({ error: "Cameras not configured" }, 503);
  }
  if (/192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(cfg.baseUrl)) {
    return c.json({ error: "NVR tunnel not configured" }, 503);
  }
  if (Number.isNaN(start.getTime())) {
    return c.json({ error: "Invalid start time" }, 400);
  }
  if (Number.isNaN(end.getTime()) || end <= start) {
    end = new Date(start.getTime() + 150 * 1000);
  }
  // Max 30 minutes per request (client uses 2.5 min blocks)
  if (end.getTime() - start.getTime() > 30 * 60 * 1000) {
    end = new Date(start.getTime() + 30 * 60 * 1000);
  }
  const parsed = parseCameraKey(keyRaw);
  if (!parsed) {
    return c.json({ error: "Provide channel, key, or cam" }, 400);
  }
  try {
    if (parsed.source === "wyze") {
      const clip = await fetchWyzeClipMp4(cfg.baseUrl, parsed.id, start, end);
      if (!clip.ok) {
        return c.json({ error: clip.error }, clip.status === 404 ? 404 : 502);
      }
      return new Response(clip.bytes, {
        status: 200,
        headers: {
          "Content-Type": clip.contentType || "video/mp4",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const channelId = Number(parsed.id);
    const clip = await fetchNvrClipMp4(cfg.baseUrl, channelId, start, end, mode);
    if (!clip.ok) {
      return c.json({ error: clip.error }, clip.status === 404 ? 404 : 502);
    }
    return new Response(clip.bytes, {
      status: 200,
      headers: {
        "Content-Type": clip.contentType || "video/mp4",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Expose-Headers":
          "X-Clip-Start, X-Clip-End, X-Clip-Mode, X-Clip-Gap-Sec",
        ...(clip.clipStart ? { "X-Clip-Start": clip.clipStart } : {}),
        ...(clip.clipEnd ? { "X-Clip-End": clip.clipEnd } : {}),
        "X-Clip-Mode": clip.mode || mode,
        "X-Clip-Gap-Sec": String(clip.gapSec || 0),
      },
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Clip failed" },
      502
    );
  }
});

/** Admin diagnostic — why live wall is blank */
api.get("/warehouse-cameras/diagnose", async (c) => {
  const me = c.get("user");
  if (!canViewWarehouseCameras(me)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  const { resolveNvrConfig, fetchNvrSnapshot } = await import("./nvrProxy");
  const cfg = await resolveNvrConfig(c.env, c.env.DB);
  const steps: { ok: boolean; label: string; detail?: string }[] = [];

  steps.push({
    ok: Boolean(cfg.baseUrl),
    label: "NVR URL saved",
    detail: cfg.baseUrl || "Missing — open Setup and save a URL",
  });
  steps.push({
    ok: Boolean(cfg.user),
    label: "NVR username saved",
    detail: cfg.user || "Missing",
  });
  steps.push({
    ok: Boolean(cfg.pass),
    label: "NVR password saved",
    detail: cfg.pass ? "Set" : "Missing — enter password in Setup",
  });

  const isLan = /192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(cfg.baseUrl);
  steps.push({
    ok: !isLan && Boolean(cfg.baseUrl),
    label: "URL reachable from cloud (not only shop LAN)",
    detail: isLan
      ? `${cfg.baseUrl} is private. Use router port forwarding to the NVR (always on — no PC), then set URL to https://YOUR.PUBLIC.IP:PORT (e.g. :8443).`
      : cfg.baseUrl
        ? "Looks public — will try a test snapshot"
        : "No URL",
  });

  let test: { ok: boolean; error?: string } = { ok: false };
  if (cfg.configured && !isLan) {
    // Clear detail of failure modes for support
    try {
      const base = cfg.baseUrl.replace(/\/+$/, "");
      // Probe with LAN-style Host (fixes many WAN 403/1003 cases)
      const probe = await fetch(`${base}/ISAPI/Streaming/channels/101/picture`, {
        method: "GET",
        headers: {
          Accept: "image/jpeg",
          "User-Agent": "Mozilla/5.0 FieldApp-Diagnose",
          Host: "192.168.1.111",
        },
      });
      const www = probe.headers.get("WWW-Authenticate") || "(none)";
      const probeBody = (await probe.text()).replace(/\s+/g, " ").slice(0, 120);
      steps.push({
        ok: probe.status === 401 || probe.ok || (probe.status === 403 && /digest/i.test(www)),
        label: "NVR answers snapshot URL (Host: 192.168.1.111)",
        detail: `HTTP ${probe.status}; WWW-Authenticate: ${www.slice(0, 100)}; body: ${probeBody || "(empty)"}`,
      });
    } catch (e) {
      steps.push({
        ok: false,
        label: "NVR answers snapshot URL",
        detail: e instanceof Error ? e.message : "fetch failed",
      });
    }

    const snap = await fetchNvrSnapshot(cfg.baseUrl, cfg.user, cfg.pass, 1, true);
    test = snap.ok ? { ok: true } : { ok: false, error: snap.error };
    steps.push({
      ok: snap.ok,
      label: "Test snapshot camera 1",
      detail: snap.ok ? `OK (${snap.bytes.byteLength} bytes)` : snap.error,
    });
  } else if (cfg.configured && isLan) {
    steps.push({
      ok: false,
      label: "Test snapshot camera 1",
      detail: "Skipped — fix public URL first",
    });
  }

  return c.json({
    ok: steps.every((s) => s.ok),
    steps,
    configured: cfg.configured,
    needs_tunnel: isLan,
    channels: cfg.channels,
    test,
  });
});

// Settings
api.get("/settings", requireRoles(ROLE_PERMS.browseAdmin), async (c) => {
  const rows = await c.env.DB.prepare("SELECT key, value FROM settings").all();
  const map: Record<string, string> = {};
  for (const r of rows.results as { key: string; value: string }[]) {
    map[r.key] = r.value;
  }
  return c.json({ settings: map });
});

api.put("/settings", requireRoles(ROLE_PERMS.manageSettings), async (c) => {
  const body = await c.req.json<Record<string, string>>();
  for (const [k, v] of Object.entries(body)) {
    await setSetting(c.env.DB, k, String(v));
  }
  await writeAudit(c.env.DB, c.get("user"), "update", "settings", null, "Updated settings", null, body);
  return c.json({ ok: true });
});

// Audit
api.get("/audit", requireRoles(ROLE_PERMS.viewAudit), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200`
  ).all();
  return c.json({ logs: rows.results });
});

// ——— Inventory (admin/office beta — not shown to drivers until ready) ———

api.get("/inventory/locations", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    await ensureStockLocations(c.env.DB);
  } catch {
    return c.json({ error: "Inventory tables missing. Run migration 015_inventory.sql" }, 503);
  }
  try {
    const rows = await c.env.DB.prepare(
      `SELECT l.*, v.unit_number
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.active = 1
       ORDER BY CASE l.type
                  WHEN 'warehouse' THEN 0
                  WHEN 'attic' THEN 1
                  ELSE 2
                END,
                COALESCE(l.sort_order, 0),
                CASE COALESCE(l.zone, '')
                  WHEN 'main' THEN 0
                  WHEN 'overhead' THEN 1
                  WHEN 'attic' THEN 2
                  ELSE 3
                END,
                l.name`
    ).all();
    return c.json({ locations: rows.results || [] });
  } catch {
    const rows = await c.env.DB.prepare(
      `SELECT l.*, v.unit_number
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.active = 1
       ORDER BY CASE l.type WHEN 'warehouse' THEN 0 WHEN 'attic' THEN 1 ELSE 2 END, l.name`
    ).all();
    return c.json({ locations: rows.results || [] });
  }
});

/** Create a named warehouse section (shelf, overhead, attic rack…). */
api.post("/inventory/locations", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const body = await c.req.json<{
    name?: string;
    zone?: string;
    type?: "warehouse" | "attic";
    notes?: string | null;
    sort_order?: number;
  }>();
  try {
    await ensureStockLocations(c.env.DB);
    const loc = await createWarehouseSection(c.env.DB, {
      name: body.name || "",
      zone: body.zone,
      type: body.type,
      notes: body.notes,
      sort_order: body.sort_order,
    });
    await writeAudit(
      c.env.DB,
      c.get("user"),
      "create",
      "stock_locations",
      loc.id,
      `Section ${loc.name} (${loc.zone || loc.type})`
    );
    return c.json({ ok: true, location: loc });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not create section";
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 015_inventory.sql" }, 503);
    }
    return c.json({ error: msg }, 400);
  }
});

/** Rename / rezone a warehouse section. */
api.patch(
  "/inventory/locations/:id",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      name?: string;
      zone?: string;
      notes?: string | null;
      sort_order?: number;
      active?: boolean | number;
    }>();
    const loc = await c.env.DB.prepare(
      `SELECT id, type, name FROM stock_locations WHERE id = ?`
    )
      .bind(id)
      .first<{ id: number; type: string; name: string }>();
    if (!loc) return c.json({ error: "Not found" }, 404);
    if (loc.type === "vehicle") {
      return c.json({ error: "Edit truck locations via Vehicles" }, 400);
    }
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) return c.json({ error: "name required" }, 400);
      sets.push("name = ?");
      binds.push(name);
    }
    if (body.zone !== undefined) {
      const z = String(body.zone).toLowerCase().trim();
      sets.push("zone = ?");
      binds.push(z || "main");
      if (z === "attic") {
        sets.push("type = 'attic'");
      } else if (body.zone) {
        sets.push("type = 'warehouse'");
      }
    }
    if (body.notes !== undefined) {
      sets.push("notes = ?");
      binds.push(body.notes?.trim() || null);
    }
    if (body.sort_order !== undefined) {
      sets.push("sort_order = ?");
      binds.push(Number(body.sort_order) || 0);
    }
    if (body.active !== undefined) {
      sets.push("active = ?");
      binds.push(body.active === false || body.active === 0 ? 0 : 1);
    }
    if (!sets.length) return c.json({ error: "Nothing to update" }, 400);
    try {
      binds.push(id);
      await c.env.DB.prepare(
        `UPDATE stock_locations SET ${sets.join(", ")} WHERE id = ?`
      )
        .bind(...binds)
        .run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such column/i.test(msg)) {
        return c.json(
          { error: "Run migration 029_warehouse_sections.sql for zones/notes" },
          503
        );
      }
      return c.json({ error: msg }, 400);
    }
    await writeAudit(
      c.env.DB,
      c.get("user"),
      "update",
      "stock_locations",
      id,
      `Updated section ${loc.name}`
    );
    const updated = await c.env.DB.prepare(`SELECT * FROM stock_locations WHERE id = ?`)
      .bind(id)
      .first();
    return c.json({ ok: true, location: updated });
  }
);

/** Deactivate a warehouse section (soft). */
api.delete(
  "/inventory/locations/:id",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    try {
      await deactivateWarehouseSection(c.env.DB, id);
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "delete",
        "stock_locations",
        id,
        `Deactivated warehouse section ${id}`
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Failed" }, 400);
    }
  }
);

/**
 * Split search into tokens so "pvc 90" matches "PVC 3/4 90".
 * Every token must appear in code, name, category, or vendor (AND).
 */
function partSearchTokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[/\\|,;:_+\-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 1)
    .slice(0, 8);
}

function appendPartTokenFilters(
  sql: string,
  binds: unknown[],
  tokens: string[],
  cols: { code: string; name: string; category?: string; vendor?: string }
): string {
  for (const t of tokens) {
    const like = `%${t}%`;
    const parts = [
      `${cols.code} LIKE ?`,
      `${cols.name} LIKE ?`,
    ];
    binds.push(like, like);
    if (cols.category) {
      parts.push(`${cols.category} LIKE ?`);
      binds.push(like);
    }
    if (cols.vendor) {
      parts.push(`${cols.vendor} LIKE ?`);
      binds.push(like);
    }
    sql += ` AND (${parts.join(" OR ")})`;
  }
  return sql;
}

api.get("/inventory/parts", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    // Do NOT call ensureStockLocations here — it was slowing every search.
    // Locations are ensured on /inventory/locations only.
    const q = (c.req.query("q") || "").trim();
    const tokens = partSearchTokens(q);
    // Slim list — skip huge description_text so responses stay JSON and fast
    const limit = Math.min(5000, Math.max(10, Number(c.req.query("limit") || "50")));
    // Correlated total_qty only evaluates for the LIMIT rows (faster than full balances GROUP BY)
    let sql = `SELECT p.id, p.external_st_id, p.code, p.name, p.category, p.cost, p.price,
        p.unit_of_measure, p.is_inventory, p.active, p.primary_vendor, p.image_url,
        p.min_qty, p.max_qty, p.truck_stock, p.home_location_id,
        hl.name as home_location_name, hl.zone as home_zone, hl.type as home_type,
        COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = p.id), 0) as total_qty
       FROM parts p
       LEFT JOIN stock_locations hl ON hl.id = p.home_location_id
       WHERE p.active = 1`;
    const binds: unknown[] = [];
    if (tokens.length) {
      sql = appendPartTokenFilters(sql, binds, tokens, {
        code: "lower(p.code)",
        name: "lower(p.name)",
        category: "lower(IFNULL(p.category,''))",
        vendor: "lower(IFNULL(p.primary_vendor,''))",
      });
    }
    // Prefer names/codes that start with the first token (typeahead feel)
    if (tokens.length) {
      const t0 = tokens[0];
      sql += ` ORDER BY
        CASE
          WHEN lower(p.name) LIKE ? THEN 0
          WHEN lower(p.code) LIKE ? THEN 1
          WHEN lower(p.name) LIKE ? THEN 2
          WHEN lower(p.code) LIKE ? THEN 3
          ELSE 4
        END,
        p.name
        LIMIT ?`;
      binds.push(`${t0}%`, `${t0}%`, `%${t0}%`, `%${t0}%`, limit);
    } else {
      sql += ` ORDER BY p.name LIMIT ?`;
      binds.push(limit);
    }
    try {
      const rows = await c.env.DB.prepare(sql).bind(...binds).all();
      return c.json({ parts: rows.results || [], tokens });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such column|no such table/i.test(msg)) {
        // Fallback without home_location / aggregate join (pre-029 or empty balances)
        let sql2 = `SELECT p.id, p.code, p.name, p.category, p.cost, p.primary_vendor, p.image_url,
            COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = p.id), 0) as total_qty
           FROM parts p WHERE p.active = 1`;
        const binds2: unknown[] = [];
        if (tokens.length) {
          sql2 = appendPartTokenFilters(sql2, binds2, tokens, {
            code: "lower(p.code)",
            name: "lower(p.name)",
            category: "lower(IFNULL(p.category,''))",
            vendor: "lower(IFNULL(p.primary_vendor,''))",
          });
        }
        sql2 += ` ORDER BY p.name LIMIT ?`;
        binds2.push(limit);
        const rows = await c.env.DB.prepare(sql2).bind(...binds2).all();
        return c.json({ parts: rows.results || [], tokens });
      }
      console.error("inventory/parts", msg);
      return c.json({ error: `Could not load parts: ${msg.slice(0, 120)}` }, 500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("inventory/parts fatal", msg);
    return c.json({ error: `Could not load parts: ${msg.slice(0, 120)}` }, 500);
  }
});

/**
 * Printable warehouse directory: every active part + linked package barcodes.
 * Sorted by our part name (e.g. "3/4 SOFT COPPER"), not vendor SKU.
 * Used for a binder/folder sheet when boxes are missing labels.
 */
api.get("/inventory/parts/barcode-directory", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    let rows: {
      results?: Array<{
        id: number;
        code: string;
        name: string;
        primary_vendor: string | null;
        linked_barcodes: string | null;
      }>;
    };
    try {
      rows = await c.env.DB.prepare(
        `SELECT p.id, p.code, p.name, p.primary_vendor,
           (SELECT GROUP_CONCAT(pb.barcode, ' · ')
            FROM part_barcodes pb WHERE pb.part_id = p.id) as linked_barcodes
         FROM parts p
         WHERE p.active = 1
         ORDER BY lower(trim(p.name)), lower(trim(p.code))`
      ).all();
    } catch {
      // Migration 042 not applied — still list parts for printing
      rows = await c.env.DB.prepare(
        `SELECT p.id, p.code, p.name, p.primary_vendor, NULL as linked_barcodes
         FROM parts p
         WHERE p.active = 1
         ORDER BY lower(trim(p.name)), lower(trim(p.code))`
      ).all();
    }
    // Natural sort so "1/4…", "3/8…", "3/4 SOFT COPPER" order correctly for warehouse
    const parts = (rows.results || [])
      .map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        primary_vendor: r.primary_vendor,
        barcodes: r.linked_barcodes
          ? String(r.linked_barcodes)
              .split(/\s*·\s*/)
              .map((s) => s.trim())
              .filter(Boolean)
          : ([] as string[]),
      }))
      .sort((a, b) => {
        const an = (a.name || "").trim();
        const bn = (b.name || "").trim();
        const byName = an.localeCompare(bn, undefined, {
          numeric: true,
          sensitivity: "base",
        });
        if (byName !== 0) return byName;
        return (a.code || "").localeCompare(b.code || "", undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
    return c.json({ parts, count: parts.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});

/** Normalize scanned payload to a bare code string. */
function normalizeScanCode(code: string): string {
  let raw = (code || "").trim();
  if (raw.includes("part:")) raw = raw.split("part:").pop() || raw;
  if (raw.includes("code=")) {
    try {
      raw = decodeURIComponent(raw.split("code=").pop() || raw);
    } catch {
      /* keep */
    }
  }
  return raw.trim();
}

/** Lookup part by barcode / code / QR payload for scan UI (before /parts/:id). */
api.get("/inventory/parts/lookup", async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!code) return c.json({ error: "code required" }, 400);
  const raw = normalizeScanCode(code);
  const tokens = partSearchTokens(raw);
  try {
    // Linked package/vendor barcodes first (migration 042)
    try {
      const byBarcode = await c.env.DB.prepare(
        `SELECT p.id, p.code, p.name, p.image_url, p.primary_vendor, p.cost,
           COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = p.id), 0) as total_qty
         FROM part_barcodes pb
         JOIN parts p ON p.id = pb.part_id AND p.active = 1
         WHERE lower(pb.barcode) = lower(?)
         LIMIT 5`
      )
        .bind(raw)
        .all();
      if ((byBarcode.results || []).length) {
        return c.json({ parts: byBarcode.results || [], query: raw, tokens, matched: "barcode" });
      }
    } catch {
      /* table optional until migration 042 */
    }

    // Exact / prefix catalog part number
    const exact = await c.env.DB.prepare(
      `SELECT id, code, name, image_url, primary_vendor, cost,
         COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = parts.id), 0) as total_qty
       FROM parts WHERE active = 1 AND (
         lower(code) = lower(?) OR lower(code) LIKE lower(?)
       ) ORDER BY CASE WHEN lower(code) = lower(?) THEN 0 ELSE 1 END, name LIMIT 15`
    )
      .bind(raw, `${raw}%`, raw)
      .all();
    if ((exact.results || []).length) {
      return c.json({ parts: exact.results || [], query: raw, tokens, matched: "code" });
    }
    // Multi-token name/code search (e.g. "pvc 90" → PVC 3/4 90)
    let sql = `SELECT id, code, name, image_url, primary_vendor, cost,
         COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = parts.id), 0) as total_qty
       FROM parts WHERE active = 1`;
    const binds: unknown[] = [];
    if (tokens.length) {
      sql = appendPartTokenFilters(sql, binds, tokens, {
        code: "lower(code)",
        name: "lower(name)",
      });
    } else {
      sql += ` AND (lower(code) LIKE ? OR lower(name) LIKE ?)`;
      const like = `%${raw.toLowerCase()}%`;
      binds.push(like, like);
    }
    sql += ` ORDER BY name LIMIT 15`;
    const row = await c.env.DB.prepare(sql).bind(...binds).all();
    return c.json({ parts: row.results || [], query: raw, tokens });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Lookup failed" }, 500);
  }
});

/** All part codes for import de-dupe (must be registered before /parts/:id). */
api.get("/inventory/parts/codes", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    const rows = await c.env.DB.prepare(
      `SELECT code, external_st_id FROM parts WHERE active = 1`
    ).all<{ code: string; external_st_id: string | null }>();
    const codes = (rows.results || []).map((r) => String(r.code || "").trim().toLowerCase()).filter(Boolean);
    const external_ids = (rows.results || [])
      .map((r) => (r.external_st_id != null ? String(r.external_st_id).trim() : ""))
      .filter(Boolean);
    return c.json({ codes, external_ids, count: codes.length });
  } catch {
    return c.json({ codes: [], external_ids: [], count: 0 });
  }
});

// ——— ServiceTitan API (admin) ———

api.get("/integrations/servicetitan/status", requireRoles(ROLE_PERMS.browseAdmin), async (c) => {
  const configured = await stConfigured(c.env, c.env.DB);
  const tenant = (await getSetting(c.env.DB, "st_tenant_id", "")).trim() || c.env.ST_TENANT_ID || "";
  const hasClient =
    Boolean((await getSetting(c.env.DB, "st_client_id", "")).trim() || c.env.ST_CLIENT_ID);
  const hasSecret =
    Boolean((await getSetting(c.env.DB, "st_client_secret", "")).trim() || c.env.ST_CLIENT_SECRET);
  const hasAppKey =
    Boolean((await getSetting(c.env.DB, "st_app_key", "")).trim() || c.env.ST_APP_KEY);
  const last = await getSetting(c.env.DB, "st_last_status", "");
  return c.json({
    configured,
    tenant_id: tenant || null,
    has_client_id: hasClient,
    has_client_secret: hasSecret,
    has_app_key: hasAppKey,
    last_status: last || null,
  });
});

api.put("/integrations/servicetitan/credentials", requireRoles(["admin"] as Role[]), async (c) => {
  const body = await c.req.json<{
    tenant_id?: string;
    client_id?: string;
    client_secret?: string;
    app_key?: string;
  }>();
  if (body.tenant_id !== undefined) {
    await setSetting(c.env.DB, "st_tenant_id", body.tenant_id.trim());
  }
  if (body.client_id !== undefined) {
    await setSetting(c.env.DB, "st_client_id", body.client_id.trim());
  }
  if (body.client_secret !== undefined && body.client_secret.trim()) {
    // Empty string means "leave unchanged" when editing
    await setSetting(c.env.DB, "st_client_secret", body.client_secret.trim());
  }
  if (body.app_key !== undefined) {
    await setSetting(c.env.DB, "st_app_key", body.app_key.trim());
  }
  // Clear token cache so new credentials are used
  await setSetting(c.env.DB, "st_token_cache", "");
  await writeAudit(
    c.env.DB,
    c.get("user"),
    "update",
    "settings",
    "servicetitan",
    "Updated ServiceTitan API credentials"
  );
  return c.json({ ok: true });
});

api.post("/integrations/servicetitan/test", requireRoles(["admin"] as Role[]), async (c) => {
  const r = await testStConnection(c.env, c.env.DB);
  let imageTest = "";
  if (r.ok) {
    try {
      const creds = await loadStCredentials(c.env, c.env.DB);
      const sample = await c.env.DB.prepare(
        `SELECT image_url FROM parts WHERE image_url LIKE 'Images/%' LIMIT 1`
      ).first<{ image_url: string }>();
      if (creds && sample?.image_url) {
        const dl = await downloadStPricebookImage(c.env, c.env.DB, creds, sample.image_url);
        imageTest = dl.ok
          ? ` Image OK (${Math.round(dl.buf.byteLength / 1024)}KB).`
          : ` Image fail: ${dl.detail.slice(0, 120)}`;
      } else {
        imageTest = " No sample Images/ path in catalog to test.";
      }
    } catch (e) {
      imageTest = ` Image test error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
    }
  }
  const detail = r.detail + imageTest;
  await setSetting(
    c.env.DB,
    "st_last_status",
    `${new Date().toISOString()} | ${r.ok ? "ok" : "fail"} | ${detail.slice(0, 400)}`
  );
  return c.json({ ...r, detail });
});

/** Pull photos from ServiceTitan for parts that have external_st_id. */
api.post("/inventory/sync-images", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  if (!(await stConfigured(c.env, c.env.DB))) {
    return c.json(
      {
        error:
          "ServiceTitan API not configured. Admin → ServiceTitan: add Tenant ID, Client ID, Secret, App Key.",
      },
      503
    );
  }
  const body = (await c.req
    .json<{ limit?: number; only_missing?: boolean }>()
    .catch(() => ({}))) as { limit?: number; only_missing?: boolean };
  const result = await syncAllPartImages(c.env, c.env.DB, {
    limit: body.limit,
    onlyMissing: body.only_missing !== false,
  });
  await setSetting(
    c.env.DB,
    "st_last_status",
    `${new Date().toISOString()} | sync images: ${result.saved}/${result.attempted} saved, ${result.failed} failed`
  );
  await writeAudit(
    c.env.DB,
    c.get("user"),
    "import",
    "parts",
    null,
    `ST image sync: ${result.saved} saved / ${result.attempted} attempted`
  );
  return c.json({ ok: true, ...result });
});

/** Sync one part's photo from ServiceTitan (by external_st_id). */
api.post(
  "/inventory/parts/:id/sync-image",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    const part = await c.env.DB.prepare(
      `SELECT id, name, external_st_id, image_url FROM parts WHERE id = ?`
    )
      .bind(id)
      .first<{ id: number; name: string; external_st_id: string | null; image_url: string | null }>();
    if (!part) return c.json({ error: "Not found" }, 404);
    if (!part.external_st_id) {
      return c.json(
        { error: "This part has no ServiceTitan Id. Re-import from pricebook (Id column)." },
        400
      );
    }
    if (!(await stConfigured(c.env, c.env.DB))) {
      return c.json({ error: "ServiceTitan API not configured (Admin → ServiceTitan)." }, 503);
    }
    const r = await syncMaterialImageToPart(
      c.env,
      c.env.DB,
      part.id,
      String(part.external_st_id),
      part.image_url
    );
    const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
    return c.json({ ...r, part: updated });
  }
);

/**
 * Promote cached ST media (st-media/Images/...) into permanent part-images/{id}.ext
 * and point parts.image_url at /api/uploads/... so thumbs stay after ST path loads once.
 */
async function promoteStMediaToPermanent(
  db: D1Database,
  opts?: { limit?: number }
): Promise<{ promoted: number; details: string[] }> {
  const limit = Math.min(40, Math.max(1, opts?.limit ?? 20));
  let promoted = 0;
  const details: string[] = [];

  // Keys only first — avoid loading many BLOBs into one response
  let keys: { key: string; content_type: string; size: number }[] = [];
  try {
    const r = await db
      .prepare(
        `SELECT key, content_type, size FROM part_image_blobs
         WHERE key LIKE 'st-media/Images/%' OR key LIKE 'st-media/Pricebook/%'
         ORDER BY key LIMIT ?`
      )
      .bind(limit)
      .all<{ key: string; content_type: string; size: number }>();
    keys = r.results || [];
  } catch {
    return { promoted: 0, details: ["part_image_blobs unavailable"] };
  }

  for (const meta of keys) {
    if (meta.size != null && meta.size < 40) continue;
    const stPath = meta.key.replace(/^st-media\//, "");
    // Skip if no part still pointing at ST path (already permanent)
    const parts = await db
      .prepare(`SELECT id FROM parts WHERE image_url = ? LIMIT 10`)
      .bind(stPath)
      .all<{ id: number }>();
    const list = parts.results || [];
    if (!list.length) continue;

    let row: { content_type: string; data: ArrayBuffer; size: number } | null = null;
    try {
      row = await db
        .prepare(`SELECT content_type, data, size FROM part_image_blobs WHERE key = ?`)
        .bind(meta.key)
        .first<{ content_type: string; data: ArrayBuffer; size: number }>();
    } catch {
      continue;
    }
    if (!row?.data) continue;

    const ct = (row.content_type || meta.content_type || "image/jpeg").toLowerCase();
    const ext = ct.includes("png")
      ? "png"
      : ct.includes("webp")
        ? "webp"
        : ct.includes("gif")
          ? "gif"
          : "jpg";
    const bytes =
      row.data instanceof ArrayBuffer
        ? new Uint8Array(row.data)
        : new Uint8Array(row.data as ArrayBuffer);

    for (const p of list) {
      const newKey = `part-images/${p.id}.${ext}`;
      const imageUrl = `/api/uploads/${newKey}`;
      try {
        await db
          .prepare(
            `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
          )
          .bind(newKey, row.content_type || "image/jpeg", bytes, bytes.byteLength)
          .run();
        await db
          .prepare(
            `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
          )
          .bind(newKey, row.content_type || "image/jpeg", bytes, bytes.byteLength)
          .run();
        await db
          .prepare(`UPDATE parts SET image_url = ?, updated_at = datetime('now') WHERE id = ?`)
          .bind(imageUrl, p.id)
          .run();
        promoted++;
        details.push(`#${p.id}`);
      } catch (e) {
        details.push(`#${p.id} fail`);
      }
    }
  }
  return { promoted, details: details.slice(0, 20) };
}

/**
 * Serve part photos:
 * - Cached uploads / prior fetches in part_image_blobs or receipt_blobs
 * - Relative ST Image1 paths tried against configured base URLs
 */
api.get("/inventory/media", async (c) => {
  const path = (c.req.query("path") || "").trim().replace(/^\/+/, "");
  if (!path || path.includes("..")) return c.json({ error: "Not found" }, 404);
  // Normalize so cache keys match imports (decode once if double-encoded)
  let normalized = path;
  try {
    if (/%2f/i.test(path)) normalized = decodeURIComponent(path);
  } catch {
    normalized = path;
  }
  const cacheKey = `st-media/${normalized}`;

  // 1) Local blob cache (permanent once downloaded)
  for (const table of ["part_image_blobs", "receipt_blobs"] as const) {
    try {
      const row = await c.env.DB.prepare(
        `SELECT content_type, data, size FROM ${table} WHERE key = ?`
      )
        .bind(cacheKey)
        .first<{ content_type: string; data: unknown; size: number }>();
      if (row?.data != null && (row.size == null || row.size > 40)) {
        // Fire-and-forget promote so list uses /api/uploads next time
        try {
          c.executionCtx.waitUntil(
            promoteStMediaToPermanent(c.env.DB, { limit: 5 }).catch(() => null)
          );
        } catch {
          /* no waitUntil in some contexts */
        }
        const img = imageResponse(
          row.data,
          row.content_type || "image/jpeg",
          "public, max-age=604800"
        );
        if (img.status === 200) return img;
      }
    } catch {
      /* table may not exist */
    }
  }

  // 2) Absolute URL already stored as path
  if (/^https?:\/\//i.test(path)) {
    try {
      const res = await fetch(path, { redirect: "follow" });
      if (res.ok) {
        const buf = await res.arrayBuffer();
        const ct = res.headers.get("content-type") || "image/jpeg";
        try {
          await c.env.DB.prepare(
            `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
          )
            .bind(cacheKey, ct, new Uint8Array(buf), buf.byteLength)
            .run();
        } catch {
          /* cache optional */
        }
        return imageResponse(buf, ct, "public, max-age=86400");
      }
    } catch {
      /* fall through */
    }
  }

  // 3) ServiceTitan Pricebook Images API: GET .../images?path=Images/Material/...
  if (normalized.startsWith("Images/") || normalized.startsWith("Pricebook/")) {
    try {
      if (await stConfigured(c.env, c.env.DB)) {
        const creds = await loadStCredentials(c.env, c.env.DB);
        if (creds) {
          const dl = await downloadStPricebookImage(c.env, c.env.DB, creds, normalized);
          if (dl.ok) {
            const bytes = new Uint8Array(dl.buf);
            try {
              await c.env.DB.prepare(
                `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
              )
                .bind(cacheKey, dl.contentType, bytes, bytes.byteLength)
                .run();
            } catch {
              /* cache optional */
            }
            // Permanent: attach to every part that uses this ST path
            try {
              const matched = await c.env.DB.prepare(
                `SELECT id FROM parts WHERE image_url = ? LIMIT 30`
              )
                .bind(normalized)
                .all<{ id: number }>();
              const ext = dl.contentType.includes("png")
                ? "png"
                : dl.contentType.includes("webp")
                  ? "webp"
                  : "jpg";
              for (const p of matched.results || []) {
                const newKey = `part-images/${p.id}.${ext}`;
                try {
                  await c.env.DB.prepare(
                    `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
                  )
                    .bind(newKey, dl.contentType, bytes, bytes.byteLength)
                    .run();
                  await c.env.DB.prepare(
                    `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
                  )
                    .bind(newKey, dl.contentType, bytes, bytes.byteLength)
                    .run();
                  await c.env.DB.prepare(
                    `UPDATE parts SET image_url = ?, updated_at = datetime('now') WHERE id = ?`
                  )
                    .bind(`/api/uploads/${newKey}`, p.id)
                    .run();
                } catch {
                  /* next part */
                }
              }
            } catch {
              /* promote optional */
            }
            return imageResponse(dl.buf, dl.contentType, "public, max-age=604800");
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  // 4) Public CDN bases (usually 403 for tenant images)
  const custom = (await getSetting(c.env.DB, "st_image_base_url", "")).trim().replace(/\/$/, "");
  const bases = [custom, "https://static.servicetitan.com", "https://attachments.servicetitan.com"].filter(
    Boolean
  ) as string[];

  for (const base of bases) {
    const url = `${base}/${path.replace(/^\//, "")}`;
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { Accept: "image/*,*/*" },
      });
      const ct = res.headers.get("content-type") || "";
      if (res.ok && ct.startsWith("image/")) {
        const buf = await res.arrayBuffer();
        try {
          await c.env.DB.prepare(
            `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
          )
            .bind(cacheKey, ct, new Uint8Array(buf), buf.byteLength)
            .run();
        } catch {
          /* optional */
        }
        return imageResponse(buf, ct, "public, max-age=86400");
      }
    } catch {
      /* try next base */
    }
  }

  return c.json({ error: "Image not available" }, 404);
});

/**
 * Promote already-downloaded ST media into permanent /api/uploads URLs.
 * Safe to call repeatedly — only touches parts still on Images/ paths with cache.
 */
api.post(
  "/inventory/persist-images",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const body = await c.req.json<{ limit?: number }>().catch(() => ({} as { limit?: number }));
    const r = await promoteStMediaToPermanent(c.env.DB, { limit: body.limit ?? 60 });
    return c.json({ ok: true, ...r });
  }
);

/** Upload / replace product photo for a part (fills the thumbnail). */
api.post("/inventory/parts/:id/image", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const part = await c.env.DB.prepare(`SELECT id, name FROM parts WHERE id = ?`).bind(id).first<{
    id: number;
    name: string;
  }>();
  if (!part) return c.json({ error: "Not found" }, 404);

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  const maxBytes = 900 * 1024;
  if (file.size > maxBytes) {
    return c.json({ error: "Photo too large (max ~900KB). Use a smaller picture." }, 400);
  }

  const ext = receiptExt(file);
  const contentType = receiptContentType(file, ext);
  const key = `part-images/${id}.${ext}`;
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  try {
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
    )
      .bind(key, contentType, bytes, bytes.byteLength)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      // fallback to receipt_blobs
      try {
        await c.env.DB.prepare(
          `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
        )
          .bind(key, contentType, bytes, bytes.byteLength)
          .run();
      } catch {
        return c.json(
          { error: "Image storage missing. Run migration 022_part_images_blob.sql" },
          503
        );
      }
    } else {
      return c.json({ error: `Could not save photo: ${msg.slice(0, 100)}` }, 500);
    }
  }

  const imageUrl = `/api/uploads/${key}`;
  try {
    await c.env.DB.prepare(
      `UPDATE parts SET image_url = ?, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(imageUrl, id)
      .run();
  } catch {
    return c.json({ error: "Run migration 019_part_image.sql for image_url column" }, 503);
  }

  // Also serve via /api/uploads/*
  try {
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
    )
      .bind(key, contentType, bytes, bytes.byteLength)
      .run();
  } catch {
    /* ok if already in part_image_blobs only */
  }

  const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
  await writeAudit(c.env.DB, c.get("user"), "update", "parts", id, `Photo for ${part.name}`);
  return c.json({ ok: true, image_url: imageUrl, part: updated });
});

/**
 * Full catalog + every vendor quote for ST Materials export.
 * Vendors/part #s added in-app appear as `{Vendor}[Vendor] Part #` / Price / Primary columns.
 */
api.get("/inventory/export", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    await ensureStockLocations(c.env.DB);
  } catch {
    return c.json({ error: "Inventory tables missing" }, 503);
  }
  const parts = await c.env.DB.prepare(
    `SELECT * FROM parts WHERE active = 1 ORDER BY name LIMIT 5000`
  ).all();
  let vendorRows: Array<{
    part_id: number;
    vendor_name: string;
    vendor_part_number: string | null;
    cost: number | null;
    available: number;
    notes: string | null;
  }> = [];
  try {
    const v = await c.env.DB.prepare(
      `SELECT part_id, vendor_name, vendor_part_number, cost, available, notes FROM part_vendors`
    ).all<{
      part_id: number;
      vendor_name: string;
      vendor_part_number: string | null;
      cost: number | null;
      available: number;
      notes: string | null;
    }>();
    vendorRows = v.results || [];
  } catch {
    vendorRows = [];
  }
  const byPart = new Map<number, typeof vendorRows>();
  for (const vr of vendorRows) {
    if (!byPart.has(vr.part_id)) byPart.set(vr.part_id, []);
    byPart.get(vr.part_id)!.push(vr);
  }
  const out = (parts.results || []).map((p) => {
    const row = p as Record<string, unknown>;
    const id = Number(row.id);
    const vendors = (byPart.get(id) || []).map((vr) => ({
      vendor_name: vr.vendor_name,
      vendor_part_number: vr.vendor_part_number,
      cost: vr.cost,
      available: vr.available,
      is_primary:
        row.primary_vendor != null &&
        String(row.primary_vendor).trim().toLowerCase() === vr.vendor_name.trim().toLowerCase(),
      notes: vr.notes,
    }));
    return { ...row, vendors };
  });
  const vendorNames = [
    ...new Set(vendorRows.map((v) => v.vendor_name.trim()).filter(Boolean)),
  ].sort((a, b) => a.localeCompare(b));
  return c.json({
    parts: out,
    vendor_names: vendorNames,
    count: out.length,
    exported_at: new Date().toISOString(),
  });
});

api.get("/inventory/parts/:id", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const part = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first<{
    id: number;
    home_location_id?: number | null;
    [key: string]: unknown;
  }>();
  if (!part) return c.json({ error: "Not found" }, 404);
  // Locations + qty + effective min/max (location override or part default)
  // is_home / is_overstock help UI label home bin vs extra warehouse stock
  let balances: { results?: unknown[] };
  try {
    balances = await c.env.DB.prepare(
      `SELECT COALESCE(b.qty, 0) as qty, b.updated_at, l.id as location_id, l.type,
              l.name as location_name, l.vehicle_id, v.unit_number,
              l.zone, l.notes as location_notes,
              COALESCE(ll.min_qty, p.min_qty) as min_qty,
              COALESCE(ll.max_qty, p.max_qty) as max_qty,
              ll.min_qty as loc_min_qty,
              ll.max_qty as loc_max_qty,
              CASE WHEN p.home_location_id IS NOT NULL AND l.id = p.home_location_id THEN 1 ELSE 0 END as is_home,
              CASE
                WHEN l.type = 'vehicle' THEN 0
                WHEN p.home_location_id IS NOT NULL AND l.id = p.home_location_id THEN 0
                WHEN COALESCE(b.qty, 0) > 0 AND l.type IN ('warehouse', 'attic') THEN 1
                ELSE 0
              END as is_overstock
       FROM stock_locations l
       CROSS JOIN parts p
       LEFT JOIN stock_balances b ON b.location_id = l.id AND b.part_id = p.id
       LEFT JOIN stock_location_levels ll ON ll.location_id = l.id AND ll.part_id = p.id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.active = 1 AND p.id = ?
       ORDER BY
         CASE WHEN p.home_location_id IS NOT NULL AND l.id = p.home_location_id THEN 0 ELSE 1 END,
         CASE l.type WHEN 'warehouse' THEN 0 WHEN 'attic' THEN 1 ELSE 2 END,
         COALESCE(l.sort_order, 0),
         COALESCE(b.qty, 0) DESC, l.name`
    )
      .bind(id)
      .all();
  } catch {
    balances = await c.env.DB.prepare(
      `SELECT COALESCE(b.qty, 0) as qty, b.updated_at, l.id as location_id, l.type,
              l.name as location_name, l.vehicle_id, v.unit_number
       FROM stock_locations l
       LEFT JOIN stock_balances b ON b.location_id = l.id AND b.part_id = ?
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.active = 1
       ORDER BY CASE l.type WHEN 'warehouse' THEN 0 WHEN 'attic' THEN 1 ELSE 2 END,
                COALESCE(b.qty, 0) DESC, l.name`
    )
      .bind(id)
      .all();
  }
  let vendors: unknown[] = [];
  try {
    const v = await c.env.DB.prepare(
      `SELECT * FROM part_vendors WHERE part_id = ?
       ORDER BY available DESC,
         CASE WHEN cost IS NULL THEN 1 ELSE 0 END,
         cost ASC, vendor_name ASC`
    )
      .bind(id)
      .all();
    vendors = v.results || [];
  } catch {
    vendors = [];
  }
  let barcodes: unknown[] = [];
  try {
    const b = await c.env.DB.prepare(
      `SELECT id, barcode, label, created_at FROM part_barcodes
       WHERE part_id = ? ORDER BY created_at DESC`
    )
      .bind(id)
      .all();
    barcodes = b.results || [];
  } catch {
    barcodes = [];
  }
  return c.json({ part, balances: balances.results || [], vendors, barcodes });
});

/** List / add barcodes for a part (package UPC, vendor sticker, etc.). */
api.get("/inventory/parts/:id/barcodes", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const rows = await c.env.DB.prepare(
      `SELECT id, barcode, label, created_at FROM part_barcodes
       WHERE part_id = ? ORDER BY created_at DESC`
    )
      .bind(id)
      .all();
    return c.json({ barcodes: rows.results || [] });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ barcodes: [], error: "Run migration 042_part_barcodes.sql" });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/inventory/parts/:id/barcodes", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const user = c.get("user");
  const part = await c.env.DB.prepare(`SELECT id, code, name FROM parts WHERE id = ? AND active = 1`)
    .bind(id)
    .first<{ id: number; code: string; name: string }>();
  if (!part) return c.json({ error: "Part not found" }, 404);

  const body = await c.req.json<{ barcode?: string; label?: string | null }>().catch(() => ({}));
  const barcode = normalizeScanCode(String(body.barcode || ""));
  if (!barcode || barcode.length < 3) {
    return c.json({ error: "Scan or enter a barcode (at least 3 characters)" }, 400);
  }
  const label = body.label?.trim() || null;

  // Already this part's barcode?
  try {
    const existing = await c.env.DB.prepare(
      `SELECT id, part_id FROM part_barcodes WHERE lower(barcode) = lower(?)`
    )
      .bind(barcode)
      .first<{ id: number; part_id: number }>();
    if (existing) {
      if (existing.part_id === id) {
        return c.json({ ok: true, already: true, barcode });
      }
      const other = await c.env.DB.prepare(`SELECT code, name FROM parts WHERE id = ?`)
        .bind(existing.part_id)
        .first<{ code: string; name: string }>();
      return c.json(
        {
          error: `Barcode already linked to ${other?.code || "another part"}${
            other?.name ? ` (${other.name})` : ""
          }`,
        },
        409
      );
    }
    await c.env.DB.prepare(
      `INSERT INTO part_barcodes (part_id, barcode, label, created_by_user_id)
       VALUES (?, ?, ?, ?)`
    )
      .bind(id, barcode, label, user.id)
      .run();
    await writeAudit(
      c.env.DB,
      user,
      "update",
      "part",
      id,
      `Linked barcode ${barcode} → ${part.code}`
    );
    const rows = await c.env.DB.prepare(
      `SELECT id, barcode, label, created_at FROM part_barcodes
       WHERE part_id = ? ORDER BY created_at DESC`
    )
      .bind(id)
      .all();
    return c.json({ ok: true, barcodes: rows.results || [] }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 042_part_barcodes.sql" }, 503);
    }
    if (/unique/i.test(msg)) {
      return c.json({ error: "That barcode is already linked to a part" }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

api.delete(
  "/inventory/parts/:id/barcodes/:barcodeId",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    const barcodeId = Number(c.req.param("barcodeId"));
    const user = c.get("user");
    try {
      const row = await c.env.DB.prepare(
        `SELECT id, barcode FROM part_barcodes WHERE id = ? AND part_id = ?`
      )
        .bind(barcodeId, id)
        .first<{ id: number; barcode: string }>();
      if (!row) return c.json({ error: "Barcode not found on this part" }, 404);
      await c.env.DB.prepare(`DELETE FROM part_barcodes WHERE id = ?`).bind(barcodeId).run();
      await writeAudit(
        c.env.DB,
        user,
        "update",
        "part",
        id,
        `Removed barcode ${row.barcode}`
      );
      return c.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 042_part_barcodes.sql" }, 503);
      }
      return c.json({ error: msg }, 500);
    }
  }
);

/** Add/update a vendor quote; default vendor becomes cheapest available. */
api.post("/inventory/parts/:id/vendors", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const part = await c.env.DB.prepare(`SELECT id, code FROM parts WHERE id = ?`).bind(id).first<{
    id: number;
    code: string;
  }>();
  if (!part) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    vendor_name: string;
    vendor_part_number?: string | null;
    cost?: number | null;
    available?: boolean | number;
    notes?: string | null;
  }>();
  if (!body.vendor_name?.trim()) return c.json({ error: "vendor_name required" }, 400);
  try {
    const vendor = await upsertPartVendor(c.env.DB, id, body);
    const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
    await writeAudit(
      c.env.DB,
      c.get("user"),
      "update",
      "part_vendors",
      id,
      `${part.code}: vendor ${body.vendor_name.trim()} cost=${body.cost ?? "—"} avail=${body.available !== false ? 1 : 0}`
    );
    return c.json({ ok: true, vendor, part: updated });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Vendor save failed";
    if (/part_vendors|no such table/i.test(msg)) {
      return c.json({ error: "Run migration 017_part_vendors.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

api.patch(
  "/inventory/parts/:id/vendors/:vendorId",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    const vendorId = Number(c.req.param("vendorId"));
    const existing = await c.env.DB.prepare(
      `SELECT * FROM part_vendors WHERE id = ? AND part_id = ?`
    )
      .bind(vendorId, id)
      .first<{
        id: number;
        vendor_name: string;
        vendor_part_number: string | null;
        cost: number | null;
        available: number;
        notes: string | null;
      }>();
    if (!existing) return c.json({ error: "Vendor row not found" }, 404);
    const body = await c.req.json<{
      vendor_name?: string;
      vendor_part_number?: string | null;
      cost?: number | null;
      available?: boolean | number;
      notes?: string | null;
    }>();
    try {
      const vendor = await upsertPartVendor(c.env.DB, id, {
        vendor_name: body.vendor_name?.trim() || existing.vendor_name,
        vendor_part_number:
          body.vendor_part_number !== undefined
            ? body.vendor_part_number
            : existing.vendor_part_number,
        cost: body.cost !== undefined ? body.cost : existing.cost,
        available: body.available !== undefined ? body.available : existing.available,
        notes: body.notes !== undefined ? body.notes : existing.notes,
      });
      // If renamed, remove old unique row
      if (body.vendor_name?.trim() && body.vendor_name.trim() !== existing.vendor_name) {
        await c.env.DB.prepare(`DELETE FROM part_vendors WHERE id = ? AND part_id = ?`)
          .bind(vendorId, id)
          .run();
        await applyDefaultVendor(c.env.DB, id);
      }
      const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
      return c.json({ ok: true, vendor, part: updated });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Update failed" }, 500);
    }
  }
);

api.delete(
  "/inventory/parts/:id/vendors/:vendorId",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    const vendorId = Number(c.req.param("vendorId"));
    try {
      await deletePartVendor(c.env.DB, id, vendorId);
      const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
      return c.json({ ok: true, part: updated });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Delete failed" }, 500);
    }
  }
);

/** Recompute default vendor from current quotes (cheapest available). */
api.post(
  "/inventory/parts/:id/vendors/refresh-default",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    try {
      const best = await applyDefaultVendor(c.env.DB, id);
      const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
      return c.json({ ok: true, default: best, part: updated });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Refresh failed" }, 500);
    }
  }
);

/**
 * Import Materials rows from ST pricebook (JSON).
 * mode=insert_only (default for approve flow): never insert a duplicate code / ST id; skip exists.
 * mode=upsert: update existing catalog fields (still no qty wipe).
 */
api.post("/inventory/parts/import", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  try {
    await ensureStockLocations(c.env.DB);
  } catch {
    return c.json({ error: "Inventory tables missing. Run migration 015_inventory.sql" }, 503);
  }
  let body: { parts?: PartImportRow[]; mode?: "insert_only" | "upsert" };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parts = body.parts || [];
  if (!parts.length) return c.json({ error: "parts[] required" }, 400);
  // Keep batches small so Worker/D1 finish before timeout (client sends ~40)
  if (parts.length > 100) {
    return c.json({ error: "Max 100 parts per batch. Client should send smaller chunks." }, 400);
  }

  const mode = body.mode === "upsert" ? "upsert" : "insert_only";
  try {
    const result = await importParts(c.env.DB, parts, { mode });
    try {
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "import",
        "parts",
        null,
        `Import ${mode}: ${parts.length} rows (+${result.inserted} / ~${result.updated} / skip ${result.skipped})`
      );
    } catch {
      /* audit optional */
    }
    const count = await c.env.DB.prepare(`SELECT COUNT(*) as c FROM parts`).first<{ c: number }>();
    // Trim results payload for mobile clients
    const slimResults = (result.results || []).map((r) => ({
      code: r.code,
      id: r.id,
      status: r.status,
    }));
    return c.json({
      ok: true,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      duplicates: result.duplicates,
      errors: result.errors,
      mode,
      total_parts: count?.c ?? 0,
      results: slimResults,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("parts/import failed", msg);
    return c.json(
      {
        error: `Import failed: ${msg.slice(0, 200)}. Already-saved parts stay in catalog — Submit again to continue.`,
      },
      500
    );
  }
});

/** Set absolute qty at a location (cycle count / initial stock). */
api.post("/inventory/stock/set", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    part_id: number;
    location_id: number;
    qty: number;
    notes?: string;
  }>();
  if (!body.part_id || !body.location_id || body.qty == null || Number.isNaN(Number(body.qty))) {
    return c.json({ error: "part_id, location_id, qty required" }, 400);
  }
  try {
    await setStockQty(
      c.env.DB,
      Number(body.part_id),
      Number(body.location_id),
      Number(body.qty),
      user.id,
      body.notes || null
    );
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Stock update failed — run migration 015?" },
      500
    );
  }
  await writeAudit(
    c.env.DB,
    user,
    "update",
    "stock",
    body.part_id,
    `Set qty=${body.qty} @ location ${body.location_id}`
  );
  return c.json({ ok: true });
});

/** Add/remove qty (positive = receive, negative = issue). */
api.post("/inventory/stock/adjust", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    part_id: number;
    location_id: number;
    delta: number;
    reason?: string;
    notes?: string;
  }>();
  if (!body.part_id || !body.location_id || body.delta == null || Number(body.delta) === 0) {
    return c.json({ error: "part_id, location_id, non-zero delta required" }, 400);
  }
  try {
    const qty = await adjustStockQty(
      c.env.DB,
      Number(body.part_id),
      Number(body.location_id),
      Number(body.delta),
      user.id,
      body.reason || "adjust",
      body.notes || null
    );
    return c.json({ ok: true, qty });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Adjust failed" }, 500);
  }
});

// ——— Part pickup requests (scan → approve ownership) ———
async function nextPickupNumber(db: D1Database): Promise<string> {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `P-${day}-`;
  const last = await db
    .prepare(
      `SELECT request_number FROM part_pickups WHERE request_number LIKE ? ORDER BY request_number DESC LIMIT 1`
    )
    .bind(`${prefix}%`)
    .first<{ request_number: string }>();
  let seq = 1;
  if (last?.request_number) {
    const n = Number(last.request_number.slice(prefix.length));
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

api.get("/inventory/pickups", async (c) => {
  const status = (c.req.query("status") || "open").trim();
  const q = (c.req.query("q") || "").trim().toLowerCase();
  try {
    const binds: unknown[] = [];
    let sql = `SELECT p.*,
        ru.display_name as requested_by_name,
        fu.display_name as for_user_name,
        pu.display_name as picked_up_by_name,
        hu.display_name as handed_to_name,
        ho.display_name as handed_over_by_name,
        l.name as dest_name, v.unit_number as dest_unit
       FROM part_pickups p
       LEFT JOIN users ru ON ru.id = p.requested_by_user_id
       LEFT JOIN users fu ON fu.id = p.for_user_id
       LEFT JOIN users pu ON pu.id = p.picked_up_by_user_id
       LEFT JOIN users hu ON hu.id = p.handed_to_user_id
       LEFT JOIN users ho ON ho.id = p.handed_over_by_user_id
       LEFT JOIN stock_locations l ON l.id = p.destination_location_id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id`;
    const where: string[] = [];

    // history / log = completed transfers only (for warranty vendor search)
    if (status === "open") {
      where.push(`p.status IN ('open','ready')`);
    } else if (status === "history" || status === "log" || status === "picked_up") {
      where.push(`p.status = 'picked_up'`);
    } else if (status && status !== "all") {
      where.push(`p.status = ?`);
      binds.push(status);
    }

    if (q) {
      // Match request #, notes, people, truck, or any part line code/name/vendor
      where.push(`(
        lower(p.request_number) LIKE ? OR
        lower(COALESCE(p.notes,'')) LIKE ? OR
        lower(COALESCE(ru.display_name,'')) LIKE ? OR
        lower(COALESCE(fu.display_name,'')) LIKE ? OR
        lower(COALESCE(hu.display_name,'')) LIKE ? OR
        lower(COALESCE(l.name,'')) LIKE ? OR
        lower(COALESCE(v.unit_number,'')) LIKE ? OR
        EXISTS (
          SELECT 1 FROM part_pickup_lines pl
          JOIN parts pt ON pt.id = pl.part_id
          WHERE pl.pickup_id = p.id AND (
            lower(pt.code) LIKE ? OR lower(pt.name) LIKE ? OR
            lower(COALESCE(pt.primary_vendor,'')) LIKE ?
          )
        )
      )`);
      const like = `%${q}%`;
      binds.push(like, like, like, like, like, like, like, like, like, like);
    }

    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    // History: newest completed first; open: oldest first-ish then created
    if (status === "history" || status === "log" || status === "picked_up") {
      sql += ` ORDER BY COALESCE(p.picked_up_at, p.created_at) DESC LIMIT 200`;
    } else {
      sql += ` ORDER BY p.created_at DESC LIMIT 100`;
    }

    const rows = await c.env.DB.prepare(sql).bind(...binds).all();
    const pickups = [];
    for (const p of rows.results || []) {
      let lines: { results?: unknown[] };
      try {
        lines = await c.env.DB.prepare(
          `SELECT pl.*, pt.code, pt.name, pt.image_url, pt.primary_vendor
           FROM part_pickup_lines pl
           JOIN parts pt ON pt.id = pl.part_id
           WHERE pl.pickup_id = ?
           ORDER BY pl.id`
        )
          .bind((p as { id: number }).id)
          .all();
      } catch {
        lines = await c.env.DB.prepare(
          `SELECT pl.*, pt.code, pt.name, pt.image_url
           FROM part_pickup_lines pl
           JOIN parts pt ON pt.id = pl.part_id
           WHERE pl.pickup_id = ?
           ORDER BY pl.id`
        )
          .bind((p as { id: number }).id)
          .all();
      }
      pickups.push({ ...p, lines: lines.results || [] });
    }
    return c.json({ pickups, query: q || null, status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ pickups: [] });
    // Fallback without new custody columns
    if (/handed_to|no such column/i.test(msg)) {
      const rows = await c.env.DB.prepare(
        `SELECT p.*, ru.display_name as requested_by_name
         FROM part_pickups p
         LEFT JOIN users ru ON ru.id = p.requested_by_user_id
         ORDER BY p.created_at DESC LIMIT 100`
      ).all();
      return c.json({ pickups: rows.results || [] });
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Where did we buy a part for this job? Search by service address (or street fragment).
 * Pulls warranties + vendor-run will-calls + receipt notes so warehouse can find the vendor.
 */
api.get("/inventory/purchase-log", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) {
    return c.json({ error: "Type at least 2 characters of the address or street name" }, 400);
  }
  const tokens = q
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (!tokens.length) {
    return c.json({ error: "Type a street name or address" }, 400);
  }

  const likeAll = (cols: string[]) => {
    // Every token must appear in at least one of the columns (AND across tokens)
    const parts: string[] = [];
    const binds: string[] = [];
    for (const t of tokens) {
      const orCols = cols.map((c) => `lower(COALESCE(${c},'')) LIKE ?`).join(" OR ");
      parts.push(`(${orCols})`);
      for (let i = 0; i < cols.length; i++) binds.push(`%${t}%`);
    }
    return { sql: parts.join(" AND "), binds };
  };

  const results: {
    warranties: unknown[];
    vendor_runs: unknown[];
    receipts: unknown[];
    catalog_hints: unknown[];
    pickups: unknown[];
  } = { warranties: [], vendor_runs: [], receipts: [], catalog_hints: [], pickups: [] };

  try {
    const w = likeAll([
      "service_address",
      "customer_name",
      "part_name",
      "part_code",
      "vendor_name",
      "notes",
      "log_number",
    ]);
    const rows = await c.env.DB.prepare(
      `SELECT id, log_number, status, part_name, part_code, vendor_name, service_address,
              customer_name, model_number, serial_number, notes, dropped_off_at, rma_number
       FROM warranty_claims
       WHERE ${w.sql}
       ORDER BY dropped_off_at DESC
       LIMIT 40`
    )
      .bind(...w.binds)
      .all();
    results.warranties = rows.results || [];
  } catch {
    /* optional */
  }

  try {
    const v = likeAll([
      "job_address",
      "job_number",
      "customer_name",
      "part_name",
      "part_code",
      "vendor_name",
      "notes",
    ]);
    const rows = await c.env.DB.prepare(
      `SELECT id, status, vendor_name, part_name, part_code, qty, job_number, job_address,
              customer_name, notes, needed_for_date, created_at, picked_at
       FROM vendor_run_lines
       WHERE ${v.sql}
       ORDER BY created_at DESC
       LIMIT 40`
    )
      .bind(...v.binds)
      .all();
    results.vendor_runs = rows.results || [];
  } catch {
    /* optional */
  }

  try {
    const r = likeAll(["notes", "vendor_name", "invoice_number"]);
    const rows = await c.env.DB.prepare(
      `SELECT id, vendor_name, invoice_number, purchase_date, total_cost, notes, purchase_kind, created_at
       FROM parts_purchase_receipts
       WHERE ${r.sql}
       ORDER BY created_at DESC
       LIMIT 20`
    )
      .bind(...r.binds)
      .all();
    results.receipts = rows.results || [];
  } catch {
    /* optional */
  }

  // Completed pickup / issue log (parts transferred to trucks)
  try {
    const like = `%${q.toLowerCase()}%`;
    const rows = await c.env.DB.prepare(
      `SELECT p.id, p.request_number, p.status, p.notes, p.picked_up_at, p.created_at,
              fu.display_name as for_user_name,
              hu.display_name as handed_to_name,
              l.name as dest_name, v.unit_number as dest_unit
       FROM part_pickups p
       LEFT JOIN users fu ON fu.id = p.for_user_id
       LEFT JOIN users hu ON hu.id = p.handed_to_user_id
       LEFT JOIN stock_locations l ON l.id = p.destination_location_id
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE p.status = 'picked_up' AND (
         lower(p.request_number) LIKE ? OR
         lower(COALESCE(p.notes,'')) LIKE ? OR
         lower(COALESCE(fu.display_name,'')) LIKE ? OR
         lower(COALESCE(hu.display_name,'')) LIKE ? OR
         lower(COALESCE(l.name,'')) LIKE ? OR
         lower(COALESCE(v.unit_number,'')) LIKE ? OR
         EXISTS (
           SELECT 1 FROM part_pickup_lines pl
           JOIN parts pt ON pt.id = pl.part_id
           WHERE pl.pickup_id = p.id AND (
             lower(pt.code) LIKE ? OR lower(pt.name) LIKE ? OR
             lower(COALESCE(pt.primary_vendor,'')) LIKE ?
           )
         )
       )
       ORDER BY COALESCE(p.picked_up_at, p.created_at) DESC
       LIMIT 30`
    )
      .bind(like, like, like, like, like, like, like, like, like)
      .all();
    const pickupsOut = [];
    for (const p of rows.results || []) {
      const lines = await c.env.DB.prepare(
        `SELECT pl.qty, pt.code, pt.name, pt.primary_vendor
         FROM part_pickup_lines pl
         JOIN parts pt ON pt.id = pl.part_id
         WHERE pl.pickup_id = ?
         ORDER BY pl.id`
      )
        .bind((p as { id: number }).id)
        .all();
      pickupsOut.push({ ...p, lines: lines.results || [] });
    }
    (results as { pickups?: unknown[] }).pickups = pickupsOut;
  } catch {
    (results as { pickups?: unknown[] }).pickups = [];
  }

  // Catalog: if query looks like a part code, show primary vendor
  try {
    const codeLike = `%${tokens.join("%")}%`;
    const parts = await c.env.DB.prepare(
      `SELECT id, code, name, primary_vendor, cost
       FROM parts
       WHERE active = 1 AND (
         lower(code) LIKE lower(?) OR lower(name) LIKE lower(?)
       )
       ORDER BY
         CASE WHEN lower(code) LIKE lower(?) THEN 0 ELSE 1 END,
         name
       LIMIT 15`
    )
      .bind(`%${q}%`, `%${q}%`, `${tokens[0]}%`)
      .all();
    results.catalog_hints = parts.results || [];
  } catch {
    /* optional */
  }

  // Also pull primary vendors for part codes found in warranty/vendor-run hits
  try {
    const codes = new Set<string>();
    for (const row of results.warranties as Array<{ part_code?: string | null; part_name?: string }>) {
      if (row.part_code?.trim()) codes.add(row.part_code.trim());
    }
    for (const row of results.vendor_runs as Array<{ part_code?: string | null }>) {
      if (row.part_code?.trim()) codes.add(row.part_code.trim());
    }
    if (codes.size) {
      const list = [...codes].slice(0, 20);
      const ph = list.map(() => "?").join(",");
      const cat = await c.env.DB.prepare(
        `SELECT id, code, name, primary_vendor, cost FROM parts
         WHERE active = 1 AND lower(code) IN (${list.map(() => "lower(?)").join(",")})
         LIMIT 20`
      )
        .bind(...list)
        .all();
      const existing = new Set(
        (results.catalog_hints as Array<{ code: string }>).map((x) => x.code?.toLowerCase())
      );
      for (const p of cat.results || []) {
        const code = String((p as { code: string }).code || "").toLowerCase();
        if (!existing.has(code)) {
          (results.catalog_hints as unknown[]).push(p);
          existing.add(code);
        }
      }
      void ph;
    }
  } catch {
    /* optional */
  }

  const total =
    results.warranties.length +
    results.vendor_runs.length +
    results.receipts.length +
    results.catalog_hints.length +
    results.pickups.length;

  return c.json({
    query: q,
    tokens,
    total,
    ...results,
  });
});

/** Resolve vehicle stock location from unit # / name / truck:id scan. */
async function resolveTruckLocation(
  db: D1Database,
  code: string
): Promise<{ id: number; name: string; unit_number: string | null } | null> {
  let raw = (code || "").trim();
  if (!raw) return null;
  if (/^truck:/i.test(raw)) {
    const id = Number(raw.split(":")[1]);
    if (id > 0) {
      const row = await db
        .prepare(
          `SELECT l.id, l.name, v.unit_number
           FROM stock_locations l
           LEFT JOIN vehicles v ON v.id = l.vehicle_id
           WHERE l.id = ? AND l.type = 'vehicle' AND l.active = 1`
        )
        .bind(id)
        .first<{ id: number; name: string; unit_number: string | null }>();
      return row || null;
    }
  }
  // Normalize "Unit 001" / "unit-1" / "001"
  const compact = raw
    .toLowerCase()
    .replace(/^unit[\s\-#]*/i, "")
    .replace(/[^a-z0-9]/g, "");
  const rows = await db
    .prepare(
      `SELECT l.id, l.name, v.unit_number
       FROM stock_locations l
       LEFT JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.type = 'vehicle' AND l.active = 1`
    )
    .all<{ id: number; name: string; unit_number: string | null }>();
  for (const r of rows.results || []) {
    const u = (r.unit_number || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const n = (r.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      (u && (u === compact || raw.toLowerCase() === (r.unit_number || "").toLowerCase())) ||
      (n && (n === compact || n.includes(compact) || compact.includes(n)))
    ) {
      return r;
    }
    // leading-zero tolerant: 1 matches 001
    if (u && compact && Number(u) === Number(compact) && Number.isFinite(Number(compact))) {
      return r;
    }
  }
  return null;
}

api.get("/inventory/locations/lookup", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  const code = (c.req.query("code") || "").trim();
  if (!code) return c.json({ error: "code required" }, 400);
  try {
    const truck = await resolveTruckLocation(c.env.DB, code);
    if (!truck) return c.json({ locations: [], query: code });
    return c.json({
      locations: [
        {
          id: truck.id,
          type: "vehicle",
          name: truck.name,
          unit_number: truck.unit_number,
          label: truck.unit_number ? `Unit ${truck.unit_number}` : truck.name,
        },
      ],
      query: code,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Lookup failed" }, 500);
  }
});

api.post("/inventory/pickups", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    for_user_id?: number | null;
    destination_location_id?: number | null;
    notes?: string;
    /** Warehouse: stage parts for a tech (ready for truck scan) */
    stage_for_tech?: boolean;
    lines?: Array<{ part_id: number; qty: number; from_location_id?: number }>;
  }>();
  const lines = body.lines || [];
  if (!lines.length) return c.json({ error: "Add at least one part (scan or type code)" }, 400);

  const forUserId = body.for_user_id ? Number(body.for_user_id) : null;
  const stageForTech =
    !!body.stage_for_tech && roleAtLeast(user.role, ROLE_PERMS.manageInventory);
  if (stageForTech && !forUserId) {
    return c.json({ error: "Select the tech these parts are for" }, 400);
  }

  try {
    const reqNo = await nextPickupNumber(c.env.DB);
    const wh = await c.env.DB.prepare(
      `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`
    ).first<{ id: number }>();

    // Staged issues start as ready (handed to tech); normal pickups start open
    const initialStatus = stageForTech ? "ready" : "open";
    const r = await c.env.DB.prepare(
      `INSERT INTO part_pickups (
         request_number, status, requested_by_user_id, for_user_id,
         destination_location_id, notes, created_at,
         handed_to_user_id, handed_over_by_user_id, handed_over_at, ready_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?)`
    )
      .bind(
        reqNo,
        initialStatus,
        user.id,
        forUserId,
        body.destination_location_id || null,
        body.notes?.trim() || null,
        stageForTech ? forUserId : null,
        stageForTech ? user.id : null,
        stageForTech ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
        stageForTech ? new Date().toISOString().slice(0, 19).replace("T", " ") : null
      )
      .run();
    const pid = Number(r.meta.last_row_id);
    for (const line of lines) {
      if (!line.part_id || !(line.qty > 0)) continue;
      await c.env.DB.prepare(
        `INSERT INTO part_pickup_lines (pickup_id, part_id, qty, from_location_id, scanned)
         VALUES (?, ?, ?, ?, 1)`
      )
        .bind(pid, line.part_id, line.qty, line.from_location_id || wh?.id || null)
        .run();
    }

    if (stageForTech && forUserId) {
      const tech = await c.env.DB.prepare(
        `SELECT display_name FROM users WHERE id = ?`
      )
        .bind(forUserId)
        .first<{ display_name: string }>();
      await notifyAndSms(c.env, c.env.DB, [forUserId], {
        kind: "pickup_handoff",
        title: `Parts staged for you · ${reqNo}`,
        body: `${user.display_name} issued ${lines.length} line(s). Stock moves when warehouse scans your truck.`,
        entity: { type: "pickup", id: pid },
        sms: shortSms(
          `TA: Parts ready for you (${reqNo}). ${user.display_name} staged ${lines.length} line(s) — open the app to finish.`
        ),
        excludeUserId: user.id,
        fromUserId: user.id,
        smsContext: `pickup_staged:${pid}`,
      });
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "pickup",
        pid,
        `Issue staged ${reqNo} for ${tech?.display_name || forUserId}`
      );
      return c.json(
        {
          ok: true,
          id: pid,
          request_number: reqNo,
          status: "ready",
          staged: true,
          for_user_id: forUserId,
        },
        201
      );
    }

    // Notify warehouse
    const targets = await usersByRoles(c.env.DB, ["admin", "warehouse"]);
    await notifyUsers(
      c.env.DB,
      targets.filter((id) => id !== user.id),
      "pickup_request",
      `Pickup ${reqNo}`,
      `${user.display_name} requested ${lines.length} part line(s)`,
      { type: "pickup", id: pid }
    );
    if (forUserId && forUserId !== user.id) {
      await notifyAndSms(c.env, c.env.DB, [forUserId], {
        kind: "pickup_request",
        title: `Parts ready for you · ${reqNo}`,
        body: `${user.display_name} set up a pickup list for you.`,
        entity: { type: "pickup", id: pid },
        sms: shortSms(
          `TA: Parts list for you (${reqNo}). ${user.display_name} set it up — check the app.`
        ),
        excludeUserId: user.id,
        fromUserId: user.id,
        smsContext: `pickup_for_you:${pid}`,
      });
    }
    return c.json({ ok: true, id: pid, request_number: reqNo, status: "open" }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Create failed";
    // Fallback if custody columns missing
    if (/no such column|handed/i.test(msg)) {
      try {
        const reqNo = await nextPickupNumber(c.env.DB);
        const wh = await c.env.DB.prepare(
          `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`
        ).first<{ id: number }>();
        const r = await c.env.DB.prepare(
          `INSERT INTO part_pickups (
             request_number, status, requested_by_user_id, for_user_id,
             destination_location_id, notes, created_at
           ) VALUES (?, 'open', ?, ?, ?, ?, datetime('now'))`
        )
          .bind(
            reqNo,
            user.id,
            forUserId,
            body.destination_location_id || null,
            body.notes?.trim() || null
          )
          .run();
        const pid = Number(r.meta.last_row_id);
        for (const line of lines) {
          if (!line.part_id || !(line.qty > 0)) continue;
          await c.env.DB.prepare(
            `INSERT INTO part_pickup_lines (pickup_id, part_id, qty, from_location_id, scanned)
             VALUES (?, ?, ?, ?, 1)`
          )
            .bind(pid, line.part_id, line.qty, line.from_location_id || wh?.id || null)
            .run();
        }
        return c.json({ ok: true, id: pid, request_number: reqNo, status: "open" }, 201);
      } catch (e2) {
        return c.json({ error: e2 instanceof Error ? e2.message : msg }, 500);
      }
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Step 1 — Warehouse hands parts to a person (custody starts).
 * Does not move stock yet; receiver is now accountable until truck is set.
 */
api.post(
  "/inventory/pickups/:id/hand-over",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{ handed_to_user_id?: number }>();
    const handedToId = Number(body.handed_to_user_id);
    if (!handedToId || handedToId <= 0) {
      return c.json(
        { error: "Who did you hand the parts to? Select the person receiving them." },
        400
      );
    }

    const receiver = await c.env.DB.prepare(
      `SELECT id, display_name FROM users WHERE id = ? AND active = 1`
    )
      .bind(handedToId)
      .first<{ id: number; display_name: string }>();
    if (!receiver) return c.json({ error: "Receiver not found" }, 400);

    const pickup = await c.env.DB.prepare(`SELECT * FROM part_pickups WHERE id = ?`)
      .bind(id)
      .first<{
        id: number;
        request_number: string;
        status: string;
        requested_by_user_id: number;
      }>();
    if (!pickup) return c.json({ error: "Not found" }, 404);
    if (pickup.status === "picked_up") return c.json({ error: "Already completed" }, 400);
    if (pickup.status === "cancelled") return c.json({ error: "Cancelled" }, 400);

    try {
      await c.env.DB.prepare(
        `UPDATE part_pickups SET
           status = 'ready',
           handed_to_user_id = ?,
           handed_over_by_user_id = ?,
           handed_over_at = datetime('now'),
           for_user_id = COALESCE(for_user_id, ?),
           ready_at = COALESCE(ready_at, datetime('now')),
           updated_at = datetime('now')
         WHERE id = ?`
      )
        .bind(handedToId, user.id, handedToId, id)
        .run();
    } catch (e) {
      return c.json(
        {
          error:
            e instanceof Error
              ? e.message
              : "Could not record handoff (custody columns missing?)",
        },
        500
      );
    }

    const note = `Custody ${pickup.request_number}: ${user.display_name} handed parts to ${receiver.display_name} (awaiting truck)`;
    const handoffIds = [handedToId, pickup.requested_by_user_id].filter(
      (x, i, a) => !!x && x !== user.id && a.indexOf(x) === i
    ) as number[];
    await notifyAndSms(c.env, c.env.DB, handoffIds, {
      kind: "pickup_handoff",
      title: `Parts in your custody · ${pickup.request_number}`,
      body: `${user.display_name} handed you parts. Choose which truck stock they go on to finish.`,
      entity: { type: "pickup", id },
      sms: shortSms(
        `TA: Parts handed to you (${pickup.request_number}). Open the app to put them on your truck.`
      ),
      excludeUserId: user.id,
      fromUserId: user.id,
      smsContext: `pickup_handoff:${id}`,
    });
    await writeAudit(c.env.DB, user, "update", "pickup", id, note);

    return c.json({
      ok: true,
      status: "ready",
      custody: {
        handed_over_by: user.display_name,
        handed_to: receiver.display_name,
      },
    });
  }
);

/**
 * Step 2 — Receiver (or warehouse with them) puts parts on a truck and stock moves.
 * Also supports one-shot at the counter: warehouse can send handed_to_user_id + truck together when still open.
 */
api.post("/inventory/pickups/:id/complete", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    handed_to_user_id?: number;
    destination_location_id?: number;
    /** Scan unit # / truck barcode instead of selecting from list */
    truck_code?: string;
  }>();

  let destLocId = Number(body.destination_location_id) || 0;
  if ((!destLocId || destLocId <= 0) && body.truck_code?.trim()) {
    const truck = await resolveTruckLocation(c.env.DB, body.truck_code.trim());
    if (!truck) {
      return c.json(
        {
          error: `No truck matched “${body.truck_code.trim()}”. Scan unit number (e.g. 001) or pick the truck.`,
        },
        400
      );
    }
    destLocId = truck.id;
  }
  if (!destLocId || destLocId <= 0) {
    return c.json(
      {
        error:
          "Which truck? Select the unit or scan the truck barcode / unit number.",
      },
      400
    );
  }

  const pickup = await c.env.DB.prepare(`SELECT * FROM part_pickups WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      request_number: string;
      status: string;
      requested_by_user_id: number;
      for_user_id: number | null;
      destination_location_id: number | null;
      handed_to_user_id: number | null;
      handed_over_by_user_id: number | null;
    }>();
  if (!pickup) return c.json({ error: "Not found" }, 404);
  if (pickup.status === "picked_up") return c.json({ error: "Already picked up" }, 400);
  if (pickup.status === "cancelled") return c.json({ error: "Cancelled" }, 400);

  const isWarehouse = roleAtLeast(user.role, ROLE_PERMS.manageInventory);
  let handedToId = Number(pickup.handed_to_user_id || 0);
  let handedOverById = Number(pickup.handed_over_by_user_id || 0);

  // One-shot at counter: warehouse supplies receiver + truck together
  if ((!handedToId || pickup.status === "open") && body.handed_to_user_id) {
    if (!isWarehouse) {
      return c.json(
        { error: "Only warehouse can record who received the parts." },
        403
      );
    }
    handedToId = Number(body.handed_to_user_id);
    handedOverById = user.id;
  }

  if (!handedToId || handedToId <= 0) {
    return c.json(
      {
        error:
          "Warehouse must first record who received the parts (Handed to), then choose the truck.",
      },
      400
    );
  }

  // Receiver of custody, or warehouse, may finish onto truck
  const isReceiver = user.id === handedToId;
  if (!isWarehouse && !isReceiver) {
    return c.json(
      {
        error:
          "Only the person who received the parts (or warehouse) can put them on a truck.",
      },
      403
    );
  }

  const receiver = await c.env.DB.prepare(
    `SELECT id, display_name FROM users WHERE id = ? AND active = 1`
  )
    .bind(handedToId)
    .first<{ id: number; display_name: string }>();
  if (!receiver) return c.json({ error: "Receiver not found" }, 400);

  const handedBy = handedOverById
    ? await c.env.DB.prepare(`SELECT display_name FROM users WHERE id = ?`)
        .bind(handedOverById)
        .first<{ display_name: string }>()
    : null;

  const dest = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.type, v.unit_number
     FROM stock_locations l
     LEFT JOIN vehicles v ON v.id = l.vehicle_id
     WHERE l.id = ? AND l.active = 1`
  )
    .bind(destLocId)
    .first<{ id: number; name: string; type: string; unit_number: string | null }>();
  if (!dest) return c.json({ error: "Truck / location not found" }, 400);

  const wh = await c.env.DB.prepare(
    `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`
  ).first<{ id: number }>();
  if (!wh) return c.json({ error: "No warehouse location" }, 400);

  const lines = await c.env.DB.prepare(
    `SELECT * FROM part_pickup_lines WHERE pickup_id = ?`
  )
    .bind(id)
    .all<{ part_id: number; qty: number; from_location_id: number | null }>();

  const truckLabel = dest.unit_number ? `Unit ${dest.unit_number}` : dest.name;
  const handedByName = handedBy?.display_name || user.display_name;
  const custodyNote = `Handoff ${pickup.request_number}: ${handedByName} → ${receiver.display_name} → ${truckLabel}`;

  const errors: string[] = [];
  for (const line of lines.results || []) {
    try {
      await transferStock(
        c.env.DB,
        line.part_id,
        line.from_location_id || wh.id,
        destLocId,
        line.qty,
        user.id,
        custodyNote
      );
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length && errors.length === (lines.results || []).length) {
    return c.json({ error: errors[0] || "Transfer failed" }, 400);
  }

  try {
    await c.env.DB.prepare(
      `UPDATE part_pickups SET
         status = 'picked_up',
         destination_location_id = ?,
         handed_to_user_id = ?,
         handed_over_by_user_id = COALESCE(handed_over_by_user_id, ?),
         handed_over_at = COALESCE(handed_over_at, datetime('now')),
         picked_up_at = datetime('now'),
         picked_up_by_user_id = ?,
         for_user_id = COALESCE(for_user_id, ?),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(destLocId, handedToId, handedOverById || user.id, user.id, handedToId, id)
      .run();
  } catch {
    await c.env.DB.prepare(
      `UPDATE part_pickups SET status = 'picked_up', picked_up_at = datetime('now'),
       picked_up_by_user_id = ?, destination_location_id = ?, updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(user.id, destLocId, id)
      .run();
  }

  const notifyIds = [
    pickup.requested_by_user_id,
    pickup.for_user_id,
    handedToId,
    handedOverById,
  ].filter((x): x is number => !!x && x !== user.id);

  await notifyUsers(
    c.env.DB,
    [...new Set(notifyIds)],
    "pickup_complete",
    `Custody locked · ${pickup.request_number}`,
    `${handedByName} gave parts to ${receiver.display_name}. On truck: ${truckLabel}.`,
    { type: "pickup", id }
  );

  await writeAudit(c.env.DB, user, "update", "pickup", id, custodyNote);
  return c.json({
    ok: true,
    custody: {
      handed_over_by: handedByName,
      handed_to: receiver.display_name,
      truck: truckLabel,
    },
    partial_errors: errors.length ? errors : undefined,
  });
});

// ——— Part pickup / vendor will-call ("parts ready at supply house") ———
// Field App owns this list. ST job # / address are optional free-text for now.

/** Local calendar date YYYY-MM-DD (avoids UTC day-shift from toISOString). */
function localIsoDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseNeededForDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  const s = String(v).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function defaultVendorRunSource(role: string): "office" | "tech" | "warehouse" | "other" {
  if (role === "office") return "office";
  if (role === "warehouse") return "warehouse";
  if (role === "driver" || role === "mechanic") return "tech";
  return "other";
}

/**
 * Open lines still on the Waiting list (any ready date).
 * Future-dated items stay counted so warehouse is never shown “0” while work is open.
 * The driver run sheet still filters to “ready today” only.
 */
async function countPartPickupWaiting(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) as c
         FROM part_pickup_ticket_lines l
         WHERE l.status IN ('pending','not_ready','partial')`
      )
      .first<{ c: number }>();
    let n = row?.c ?? 0;
    // Tickets with no lines yet still count as open work
    const openEmpty = await db
      .prepare(
        `SELECT COUNT(*) as c FROM part_pickup_tickets t
         WHERE t.status IN ('open','partial')
           AND NOT EXISTS (SELECT 1 FROM part_pickup_ticket_lines l WHERE l.ticket_id = t.id)`
      )
      .first<{ c: number }>();
    n += openEmpty?.c ?? 0;
    return n;
  } catch {
    /* fall through to legacy */
  }
  try {
    const legacy = await db
      .prepare(`SELECT COUNT(*) as c FROM vendor_run_lines WHERE status = 'waiting'`)
      .first<{ c: number }>();
    return legacy?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Ready for a warehouse stop *today* (needed_for_date null or ≤ today). */
async function countPartPickupReadyToday(db: D1Database): Promise<number> {
  const today = localIsoDate();
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) as c
         FROM part_pickup_ticket_lines l
         JOIN part_pickup_tickets t ON t.id = l.ticket_id
         WHERE l.status IN ('pending','not_ready','partial')
           AND (t.needed_for_date IS NULL OR t.needed_for_date <= ?)`
      )
      .bind(today)
      .first<{ c: number }>();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

async function refreshPartPickupTicketStatus(db: D1Database, ticketId: number): Promise<void> {
  const lines = await db
    .prepare(`SELECT status FROM part_pickup_ticket_lines WHERE ticket_id = ?`)
    .bind(ticketId)
    .all<{ status: string }>();
  const list = lines.results || [];
  if (!list.length) {
    await db
      .prepare(
        `UPDATE part_pickup_tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?`
      )
      .bind(ticketId)
      .run();
    return;
  }
  const pending = list.filter((l) =>
    ["pending", "not_ready", "partial"].includes(l.status)
  ).length;
  const picked = list.filter((l) => l.status === "picked").length;
  const allCancelled =
    list.length > 0 && list.every((l) => l.status === "cancelled");
  let status = "open";
  if (pending === 0) {
    // All closed — fully cancelled tickets vs finished pickups
    status = allCancelled ? "cancelled" : "done";
  } else if (picked > 0 || list.some((l) => l.status === "partial")) {
    status = "partial";
  }
  await db
    .prepare(
      `UPDATE part_pickup_tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .bind(status, ticketId)
    .run();
}

/** Fast badge poll — waiting = all open; ready_today = go pick now */
api.get("/inventory/vendor-runs/count", async (c) => {
  const waiting = await countPartPickupWaiting(c.env.DB);
  const ready_today = await countPartPickupReadyToday(c.env.DB);
  return c.json({ waiting, ready_today });
});

api.get("/inventory/part-pickups/count", async (c) => {
  const waiting = await countPartPickupWaiting(c.env.DB);
  const ready_today = await countPartPickupReadyToday(c.env.DB);
  return c.json({ waiting, ready_today });
});

/** List pickup tickets grouped by vendor (open / all). */
api.get("/inventory/part-pickups", async (c) => {
  const status = (c.req.query("status") || "open").trim();
  try {
    const waiting = await countPartPickupWaiting(c.env.DB);
    const ready_today = await countPartPickupReadyToday(c.env.DB);
    let sql = `SELECT t.*,
        u.display_name as logged_by_name,
        (SELECT COUNT(*) FROM part_pickup_ticket_lines l WHERE l.ticket_id = t.id) as line_count,
        (SELECT COUNT(*) FROM part_pickup_ticket_lines l
          WHERE l.ticket_id = t.id AND l.status IN ('pending','not_ready','partial')) as open_lines,
        (SELECT COUNT(*) FROM part_pickup_ticket_lines l
          WHERE l.ticket_id = t.id AND l.status = 'picked') as picked_lines
       FROM part_pickup_tickets t
       LEFT JOIN users u ON u.id = t.logged_by_user_id`;
    if (status === "open" || status === "waiting") {
      // Anything still needing pickup stays listed — even if ticket status is out of date.
      // Items leave only when every line is picked or not needed (no open lines left).
      sql += ` WHERE (
        t.status IN ('open','partial')
        OR EXISTS (
          SELECT 1 FROM part_pickup_ticket_lines l
          WHERE l.ticket_id = t.id
            AND l.status IN ('pending','not_ready','partial')
        )
      )`;
    } else if (status === "done" || status === "history") {
      // Fully resolved only (no remaining open lines)
      sql += ` WHERE t.status IN ('done','cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM part_pickup_ticket_lines l
          WHERE l.ticket_id = t.id
            AND l.status IN ('pending','not_ready','partial')
        )`;
    } else if (status !== "all") {
      sql += ` WHERE t.status = ?`;
    }
    // History: newest finished pickups first. Open: ready-today / date, then vendor.
    if (status === "done" || status === "history") {
      sql += ` ORDER BY t.updated_at DESC, t.id DESC LIMIT 100`;
    } else {
      sql += ` ORDER BY
        CASE t.status WHEN 'open' THEN 0 WHEN 'partial' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
        t.needed_for_date IS NULL, t.needed_for_date ASC,
        lower(t.vendor_name), t.id DESC
        LIMIT 100`;
    }
    // open / waiting / done / history / all build WHERE without ? placeholders
    const tickets =
      status === "all" ||
      status === "open" ||
      status === "waiting" ||
      status === "done" ||
      status === "history"
        ? await c.env.DB.prepare(sql).all()
        : await c.env.DB.prepare(sql).bind(status).all();

    const today = localIsoDate();
    const list = [];
    for (const t of tickets.results || []) {
      const tid = Number((t as { id: number }).id);
      const needed = (t as { needed_for_date?: string | null }).needed_for_date || null;
      const ready_to_pick = !needed || needed <= today;
      let lines = await c.env.DB.prepare(
        `SELECT l.*, ru.display_name as resolved_by_name
         FROM part_pickup_ticket_lines l
         LEFT JOIN users ru ON ru.id = l.resolved_by_user_id
         WHERE l.ticket_id = ?
         ORDER BY l.line_no ASC, l.id ASC`
      )
        .bind(tid)
        .all();
      // Heal open tickets that somehow have zero lines — otherwise warehouse has no "Picked up" button
      const ticketStatus = String((t as { status?: string }).status || "");
      if (
        (!lines.results || lines.results.length === 0) &&
        (ticketStatus === "open" || ticketStatus === "partial")
      ) {
        const fallbackName =
          String((t as { notes?: string | null }).notes || "").trim() ||
          String((t as { vendor_name?: string }).vendor_name || "Part").trim() + " part";
        try {
          await c.env.DB.prepare(
            `INSERT INTO part_pickup_ticket_lines (
               ticket_id, line_no, part_id, part_code, part_name, qty_requested, status
             ) VALUES (?, 1, NULL, NULL, ?, 1, 'pending')`
          )
            .bind(tid, fallbackName.slice(0, 200))
            .run();
          lines = await c.env.DB.prepare(
            `SELECT l.*, ru.display_name as resolved_by_name
             FROM part_pickup_ticket_lines l
             LEFT JOIN users ru ON ru.id = l.resolved_by_user_id
             WHERE l.ticket_id = ?
             ORDER BY l.line_no ASC, l.id ASC`
          )
            .bind(tid)
            .all();
        } catch {
          /* ignore heal failure */
        }
      }
      list.push({
        ...t,
        ready_to_pick,
        lines: lines.results || [],
      });
    }

    // Vendor names for autocomplete — one entry per place (case-insensitive)
    const vendorNameByKey = new Map<string, string>();
    function addVendorSuggestion(raw: string | null | undefined) {
      const cleaned = canonicalizePartsStoreName(String(raw || "")) || String(raw || "").trim();
      if (!cleaned) return;
      const key = vendorNameKey(cleaned);
      if (!key) return;
      const prev = vendorNameByKey.get(key);
      vendorNameByKey.set(key, prev ? preferVendorSpelling(prev, cleaned) : cleaned);
    }
    try {
      const vn = await c.env.DB.prepare(
        `SELECT DISTINCT vendor_name as name FROM (
           SELECT vendor_name FROM part_pickup_tickets
           UNION SELECT vendor_name FROM vendor_run_lines
           UNION SELECT vendor_name FROM part_vendors
         ) WHERE name IS NOT NULL AND trim(name) != ''
         ORDER BY lower(name) LIMIT 200`
      ).all<{ name: string }>();
      for (const r of vn.results || []) addVendorSuggestion(r.name);
    } catch {
      try {
        const vn = await c.env.DB.prepare(
          `SELECT DISTINCT vendor_name as name FROM part_pickup_tickets
           WHERE vendor_name IS NOT NULL ORDER BY lower(vendor_name) LIMIT 120`
        ).all<{ name: string }>();
        for (const r of vn.results || []) addVendorSuggestion(r.name);
      } catch {
        /* ignore */
      }
    }
    const vendorNames = [...vendorNameByKey.values()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );

    // Group tickets by vendor for chips — "AutoZone" and "autozone" are one chip
    type TicketRow = (typeof list)[number];
    /** Latest activity: line resolved_at, else ticket updated_at / created_at */
    function ticketActivityMs(t: TicketRow): number {
      let best = 0;
      const bump = (raw: string | null | undefined) => {
        if (!raw) return;
        const ms = Date.parse(String(raw).includes("T") ? String(raw) : String(raw).replace(" ", "T") + "Z");
        if (Number.isFinite(ms) && ms > best) best = ms;
      };
      bump((t as { updated_at?: string }).updated_at);
      bump((t as { created_at?: string }).created_at);
      for (const line of (t as { lines?: Array<{ resolved_at?: string | null }> }).lines || []) {
        bump(line.resolved_at);
      }
      return best;
    }
    const byVendor = new Map<string, { vendor_name: string; tickets: TicketRow[] }>();
    for (const t of list) {
      const raw = String((t as { vendor_name: string }).vendor_name || "Unknown").trim() || "Unknown";
      // Key from canonical name so "carrier" and "Carrier - Part being delivered…"
      // both land under one "Carrier Enterprise" chip (not two identical labels).
      const display = canonicalizePartsStoreName(raw) || raw;
      const key = vendorNameKey(display) || vendorNameKey(raw) || "unknown";
      const existing = byVendor.get(key);
      if (!existing) {
        byVendor.set(key, { vendor_name: display, tickets: [t] });
      } else {
        existing.vendor_name = preferVendorSpelling(existing.vendor_name, display);
        existing.tickets.push(t);
      }
    }
    const historyMode = status === "done" || status === "history";
    const vendors = [...byVendor.values()]
      .map((g) => {
        const tickets = [...g.tickets].sort((a, b) => {
          if (historyMode) return ticketActivityMs(b) - ticketActivityMs(a);
          // Open list: keep ready-today first, then by needed date / id
          const ar = (a as { ready_to_pick?: boolean }).ready_to_pick !== false ? 0 : 1;
          const br = (b as { ready_to_pick?: boolean }).ready_to_pick !== false ? 0 : 1;
          if (ar !== br) return ar - br;
          return Number((b as { id: number }).id) - Number((a as { id: number }).id);
        });
        const latestMs = tickets.reduce((m, t) => Math.max(m, ticketActivityMs(t)), 0);
        return {
          vendor_name: g.vendor_name,
          waiting: tickets.reduce(
            (s, tk) => s + (Number((tk as { open_lines?: number }).open_lines) || 0),
            0
          ),
          tickets,
          _latestMs: latestMs,
        };
      })
      .sort((a, b) => {
        if (historyMode) return (b._latestMs || 0) - (a._latestMs || 0);
        return a.vendor_name.localeCompare(b.vendor_name, undefined, { sensitivity: "base" });
      })
      .map(({ _latestMs: _drop, ...rest }) => rest);

    return c.json({
      tickets: list,
      vendors,
      vendor_names: vendorNames,
      waiting,
      ready_today,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        tickets: [],
        vendors: [],
        vendor_names: [],
        waiting: 0,
        ready_today: 0,
        error: "Run migration 035_part_pickup_tickets.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Create a pickup ticket — part description + address.
 * Office/admin may set contact_name (who to ask about the item) — stored in purchase_order.
 */
api.post("/inventory/part-pickups", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    part_description?: string;
    job_address?: string;
    /** Who to contact for questions (office/admin entry) */
    contact_name?: string | null;
    contact_user_id?: number | null;
    vendor_name?: string;
    /** First day the part is ready to pick (future = do not go yet). */
    needed_for_date?: string | null;
    purchase_order?: string | null;
    notes?: string | null;
    parts?: Array<{ part_name?: string | null; part_code?: string | null }>;
    source?: "office" | "tech" | "warehouse" | "other";
  }>();

  const description = (
    body.part_description ||
    body.parts?.[0]?.part_name ||
    body.parts?.[0]?.part_code ||
    ""
  ).trim();
  const address = (body.job_address || body.notes || "").trim();

  if (!description || description.length < 2) {
    return c.json({ error: "Describe the part that needs to be picked up." }, 400);
  }
  if (!address || address.length < 3) {
    return c.json({ error: "Enter the address this part is needed for." }, 400);
  }

  const vendorRaw = (body.vendor_name || "").trim();
  if (!vendorRaw || vendorRaw.length < 2) {
    return c.json(
      { error: "Enter the store / vendor where the part is waiting (e.g. Gemaire, Johnstone)." },
      400
    );
  }
  // Merge "autozone" / "AutoZone" into one spelling used elsewhere
  const vendor = await resolvePickupVendorName(c.env.DB, vendorRaw);
  if (!vendor || vendor.length < 2) {
    return c.json(
      { error: "Enter the store / vendor where the part is waiting (e.g. Gemaire, Johnstone)." },
      400
    );
  }

  const isOfficeEntry = user.role === "admin" || user.role === "office" || user.role === "supervisor";
  let contactName = (body.contact_name || "").trim() || null;
  const contactUserId =
    body.contact_user_id != null && Number(body.contact_user_id) > 0
      ? Number(body.contact_user_id)
      : null;
  if (contactUserId && !contactName) {
    const cu = await c.env.DB.prepare(
      `SELECT display_name FROM users WHERE id = ? AND active = 1`
    )
      .bind(contactUserId)
      .first<{ display_name: string }>();
    contactName = cu?.display_name?.trim() || null;
  }
  // Office/admin logging for someone else — require a contact so warehouse knows who to call
  if (isOfficeEntry && !contactName) {
    return c.json(
      {
        error:
          "Select who this is for (contact person) so warehouse knows who to ask about the part.",
      },
      400
    );
  }
  // Field techs logging themselves — contact defaults to them
  if (!contactName) contactName = user.display_name || null;

  // Ready date: default today (pick now). Future date = stays on list but not on today's run.
  const needed = parseNeededForDate(body.needed_for_date) || localIsoDate();
  const source = body.source || defaultVendorRunSource(user.role);
  // purchase_order column repurposed as contact person label for these simple tickets
  const contactStored = contactName;
  const today = localIsoDate();
  const isFuture = needed > today;

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO part_pickup_tickets (
         vendor_name, needed_for_date, purchase_order, notes, qty_unknown, expected_parts,
         status, logged_by_user_id, source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, 1, 'open', ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(vendor, needed, contactStored, address, user.id, source)
      .run();
    const ticketId = Number(ins.meta.last_row_id);

    try {
      await c.env.DB.prepare(
        `INSERT INTO part_pickup_ticket_lines (
           ticket_id, line_no, part_id, part_code, part_name, qty_requested, status
         ) VALUES (?, 1, NULL, NULL, ?, 1, 'pending')`
      )
        .bind(ticketId, description)
        .run();
    } catch (lineErr) {
      // Don't leave an empty ticket with no pick button — roll back ticket
      try {
        await c.env.DB.prepare(`DELETE FROM part_pickup_tickets WHERE id = ?`)
          .bind(ticketId)
          .run();
      } catch {
        /* ignore */
      }
      throw lineErr;
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "part_pickup",
      ticketId,
      `Pickup request · ${vendor} · ${description.slice(0, 80)} · for ${address.slice(0, 40)} · contact ${contactStored || "—"}`
    );

    const bg = (async () => {
      try {
        // Always notify warehouse/office/admin — even when ready date is in the future
        const notifyIds = await usersByRoles(c.env.DB, ["warehouse", "office", "admin", "supervisor"]);
        const whenBit = isFuture
          ? ` · ready ${needed} (not today)`
          : ` · ready today`;
        await notifyUsers(
          c.env.DB,
          notifyIds.filter((uid) => uid !== user.id).slice(0, 40),
          "vendor_run",
          `Part pickup · ${vendor.slice(0, 40)}`,
          `${description.slice(0, 70)} · for ${address.slice(0, 40)}${whenBit}${
            contactStored ? ` · contact ${contactStored}` : ""
          } — ${user.display_name}`,
          { type: "part_pickup", id: ticketId }
        );
      } catch {
        /* ignore */
      }
    })();
    scheduleWaitUntil(c, bg);

    return c.json({
      ok: true,
      id: ticketId,
      contact_name: contactStored,
      needed_for_date: needed,
      ready_to_pick: !isFuture,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 035_part_pickup_tickets.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Update part description / address / ready date.
 * Owner, office, warehouse, or admin may edit open tickets so details stay accurate.
 * Warehouse still marks picked / not ready via resolve.
 */
api.put("/inventory/part-pickups/:id/lines", async (c) => {
  const user = c.get("user");
  const ticketId = Number(c.req.param("id"));
  const body = await c.req.json<{
    lines?: Array<{
      id: number;
      part_code?: string | null;
      part_name?: string | null;
      part_id?: number | null;
      qty_requested?: number;
    }>;
    job_address?: string | null;
    needed_for_date?: string | null;
    part_description?: string | null;
    add_lines?: number;
  }>();

  try {
    const ticket = await c.env.DB.prepare(
      `SELECT id, status, logged_by_user_id FROM part_pickup_tickets WHERE id = ?`
    )
      .bind(ticketId)
      .first<{ id: number; status: string; logged_by_user_id: number | null }>();
    if (!ticket) return c.json({ error: "Ticket not found" }, 404);
    if (ticket.status === "done" || ticket.status === "cancelled") {
      return c.json({ error: "Ticket is closed" }, 400);
    }

    const isOwner = ticket.logged_by_user_id != null && ticket.logged_by_user_id === user.id;
    const isStaff = ["admin", "office", "warehouse", "supervisor"].includes(user.role);
    if (!isOwner && !isStaff) {
      return c.json(
        {
          error:
            "Only the person who logged this request (or office/warehouse) can change the description, address, or ready date.",
        },
        403
      );
    }

    if (body.add_lines && body.add_lines > 0) {
      return c.json({ error: "Cannot add lines to this request." }, 400);
    }

    const ticketSets: string[] = ["updated_at = datetime('now')"];
    const ticketVals: unknown[] = [];

    if (body.job_address != null) {
      const addr = String(body.job_address).trim();
      if (addr.length >= 3) {
        ticketSets.push("notes = ?");
        ticketVals.push(addr);
      }
    }

    if (body.needed_for_date !== undefined) {
      const needed = parseNeededForDate(body.needed_for_date);
      ticketSets.push("needed_for_date = ?");
      ticketVals.push(needed);
    }

    if (ticketSets.length > 1) {
      ticketVals.push(ticketId);
      await c.env.DB.prepare(
        `UPDATE part_pickup_tickets SET ${ticketSets.join(", ")} WHERE id = ?`
      )
        .bind(...ticketVals)
        .run();
    }

    // Single-field description convenience (updates first open line if no line id given)
    const bulkDesc =
      body.part_description != null ? String(body.part_description).trim() : "";
    if (bulkDesc.length >= 2 && (!body.lines || !body.lines.length)) {
      await c.env.DB.prepare(
        `UPDATE part_pickup_ticket_lines SET part_name = ?
         WHERE ticket_id = ? AND status IN ('pending','not_ready','partial')
         AND id = (
           SELECT id FROM part_pickup_ticket_lines
           WHERE ticket_id = ? AND status IN ('pending','not_ready','partial')
           ORDER BY line_no ASC, id ASC LIMIT 1
         )`
      )
        .bind(bulkDesc, ticketId, ticketId)
        .run();
    }

    let linesUpdated = 0;
    for (const line of body.lines || []) {
      if (!line.id) continue;
      const name = line.part_name != null ? String(line.part_name).trim() || null : null;
      if (!name || name.length < 2) continue;
      // Allow update on any still-open line (not only pending — was blocking description edits)
      const r = await c.env.DB.prepare(
        `UPDATE part_pickup_ticket_lines SET part_name = ?
         WHERE id = ? AND ticket_id = ?
           AND status IN ('pending','not_ready','partial')`
      )
        .bind(name, line.id, ticketId)
        .run();
      linesUpdated += Number(r.meta.changes) || 0;
    }

    if (
      linesUpdated === 0 &&
      (body.lines || []).some((l) => l.part_name && String(l.part_name).trim().length >= 2) &&
      bulkDesc.length < 2
    ) {
      // Fall back: if line ids were wrong/stale, still try primary open line
      const firstName = String(
        (body.lines || []).find((l) => l.part_name && String(l.part_name).trim().length >= 2)
          ?.part_name || ""
      ).trim();
      if (firstName) {
        await c.env.DB.prepare(
          `UPDATE part_pickup_ticket_lines SET part_name = ?
           WHERE ticket_id = ? AND status IN ('pending','not_ready','partial')
           AND id = (
             SELECT id FROM part_pickup_ticket_lines
             WHERE ticket_id = ? AND status IN ('pending','not_ready','partial')
             ORDER BY line_no ASC, id ASC LIMIT 1
           )`
        )
          .bind(firstName, ticketId, ticketId)
          .run();
      }
    }

    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Update failed" }, 500);
  }
});

/**
 * Resolve a line at the counter:
 * status: picked | not_ready | partial | cancelled | pending
 * qty_received required for partial; optional for picked (defaults to requested)
 *
 * "cancelled" = no longer needed (order cancelled / wrong part / job killed).
 * Counter (warehouse / office / admin / supervisor / mechanic-fleet) can mark picked.
 * Field drivers can mark Not needed only.
 */
api.post("/inventory/part-pickups/lines/:lineId/resolve", async (c) => {
  const user = c.get("user");
  const canCounter = ["admin", "warehouse", "office", "supervisor", "mechanic"].includes(user.role);
  const canNotNeeded = canCounter || user.role === "driver";
  if (!canNotNeeded) {
    return c.json({ error: "You cannot update pickup status" }, 403);
  }
  const lineId = Number(c.req.param("lineId"));
  const body = await c.req.json<{
    status?: string;
    qty_received?: number | null;
    notes?: string | null;
    receive_stock?: boolean;
  }>();
  const status = String(body.status || "").trim();
  if (!["picked", "not_ready", "partial", "cancelled", "pending"].includes(status)) {
    return c.json(
      { error: "Status must be picked, not_ready, partial, cancelled, or pending" },
      400
    );
  }
  if (!canCounter && status !== "cancelled") {
    return c.json(
      {
        error:
          "Field can mark parts as Not needed only. Warehouse marks picked / not ready at the counter.",
      },
      403
    );
  }

  const notesIn = body.notes != null ? String(body.notes).trim() : "";
  if (status === "cancelled" && notesIn.length < 3) {
    return c.json(
      { error: "Explain why this part is not needed (job cancelled, wrong part, etc.)" },
      400
    );
  }

  try {
    const line = await c.env.DB.prepare(
      `SELECT l.*, t.vendor_name, t.purchase_order, t.logged_by_user_id
       FROM part_pickup_ticket_lines l
       JOIN part_pickup_tickets t ON t.id = l.ticket_id
       WHERE l.id = ?`
    )
      .bind(lineId)
      .first<{
        id: number;
        ticket_id: number;
        part_id: number | null;
        part_name: string | null;
        part_code: string | null;
        qty_requested: number;
        vendor_name: string;
        purchase_order: string | null;
        logged_by_user_id: number | null;
      }>();
    if (!line) return c.json({ error: "Line not found" }, 404);

    let qtyRecv: number | null = null;
    if (status === "picked") {
      qtyRecv =
        body.qty_received != null && Number.isFinite(Number(body.qty_received))
          ? Number(body.qty_received)
          : Number(line.qty_requested) || 1;
    } else if (status === "partial") {
      if (body.qty_received == null || !Number.isFinite(Number(body.qty_received))) {
        return c.json({ error: "Enter how many you actually received" }, 400);
      }
      qtyRecv = Number(body.qty_received);
      if (qtyRecv < 0) return c.json({ error: "Received qty cannot be negative" }, 400);
    } else if (status === "pending" || status === "not_ready" || status === "cancelled") {
      qtyRecv = null;
    }

    await c.env.DB.prepare(
      `UPDATE part_pickup_ticket_lines SET
         status = ?,
         qty_received = ?,
         notes = COALESCE(?, notes),
         resolved_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END,
         resolved_by_user_id = CASE WHEN ? = 'pending' THEN NULL ELSE ? END
       WHERE id = ?`
    )
      .bind(
        status,
        qtyRecv,
        notesIn || null,
        status,
        status,
        user.id,
        lineId
      )
      .run();

    // Optional stock receive when fully or partially picked and catalog-linked
    if (
      (status === "picked" || status === "partial") &&
      body.receive_stock !== false &&
      line.part_id &&
      qtyRecv != null &&
      qtyRecv > 0
    ) {
      try {
        await ensureStockLocations(c.env.DB);
        const wh = await c.env.DB.prepare(
          `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1
           ORDER BY sort_order, id LIMIT 1`
        ).first<{ id: number }>();
        if (wh) {
          await adjustStockQty(
            c.env.DB,
            line.part_id,
            wh.id,
            qtyRecv,
            user.id,
            "vendor_pickup",
            `Part pickup ticket #${line.ticket_id} · ${line.vendor_name}`
          );
        }
      } catch {
        /* non-fatal */
      }
    }

    await refreshPartPickupTicketStatus(c.env.DB, line.ticket_id);

    const label = line.part_name || line.part_code || `Line ${lineId}`;
    const statusLabel =
      status === "cancelled"
        ? "Not needed"
        : status === "not_ready"
          ? "Not ready"
          : status === "picked"
            ? "Picked up"
            : status === "partial"
              ? "Partial"
              : status.replace("_", " ");

    await writeAudit(
      c.env.DB,
      user,
      "update",
      "part_pickup",
      line.ticket_id,
      `${statusLabel} · ${line.vendor_name} · ${label}${
        qtyRecv != null ? ` · qty ${qtyRecv}` : ""
      }${notesIn ? ` · ${notesIn.slice(0, 60)}` : ""} — by ${user.display_name}`
    );

    // Notify requester in background — SMS only when their part arrives (or partial/not ready)
    if (line.logged_by_user_id && line.logged_by_user_id !== user.id) {
      const title = `${statusLabel} · ${line.vendor_name}`;
      const detail = `${label}${qtyRecv != null ? ` · got ${qtyRecv}` : ""}${
        body.notes ? ` · ${String(body.notes).trim()}` : ""
      } — ${user.display_name}`;
      // Text when the part shows up (or partial / not ready so they know the status)
      const smsOn =
        status === "picked" || status === "partial" || status === "not_ready";
      const smsText = smsOn
        ? shortSms(
            status === "picked"
              ? `TA: Your part is in · ${line.vendor_name}: ${label}${qtyRecv != null ? ` (qty ${qtyRecv})` : ""}. Open app for details.`
              : status === "partial"
                ? `TA: Partial pickup · ${line.vendor_name}: ${label}${qtyRecv != null ? ` · got ${qtyRecv}` : ""}.`
                : `TA: Not ready yet · ${line.vendor_name}: ${label}. We'll update when it arrives.`
          )
        : null;
      scheduleWaitUntil(
        c,
        notifyAndSms(c.env, c.env.DB, [line.logged_by_user_id], {
          kind: "vendor_run",
          title,
          body: detail,
          entity: { type: "part_pickup", id: line.ticket_id },
          sms: smsText,
          excludeUserId: user.id,
          fromUserId: user.id,
          smsContext: `vendor_run:${lineId}:${status}`,
        }).catch(() => {
          /* non-fatal */
        })
      );
    }

    // Reminder for the person who picked up: record where parts were left at the office
    if (status === "picked" || status === "partial") {
      scheduleWaitUntil(
        c,
        (async () => {
          try {
            const existing = await c.env.DB.prepare(
              `SELECT id FROM notifications
               WHERE user_id = ? AND kind = 'parts_place_reminder'
                 AND entity_type = 'part_pickup' AND entity_id = ?
                 AND read_at IS NULL
               LIMIT 1`
            )
              .bind(user.id, String(line.ticket_id))
              .first<{ id: number }>();
            if (existing) return;
            await notifyUsers(
              c.env.DB,
              [user.id],
              "parts_place_reminder",
              `Where did you put the ${line.vendor_name} parts?`,
              `${label}${qtyRecv != null ? ` · qty ${qtyRecv}` : ""} — when you're back at the office, open Parts drop-off and record where you left them (counter, cage, shelf, truck…).`,
              { type: "part_pickup", id: line.ticket_id }
            );
          } catch {
            /* non-fatal */
          }
        })()
      );
    }

    return c.json({
      ok: true,
      line_id: lineId,
      status,
      qty_received: qtyRecv,
      ticket_id: line.ticket_id,
      resolved_by: user.display_name,
      resolved_at: status === "pending" ? null : new Date().toISOString(),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 035_part_pickup_tickets.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

// ——— Parts drop-off (brought to shop from vendor, ready to put away / issue) ———

let partsDropoffTablesReady = false;
async function ensurePartsDropoffTables(db: D1Database): Promise<void> {
  if (partsDropoffTablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS parts_dropoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_name TEXT NOT NULL,
      part_summary TEXT NOT NULL,
      for_unit TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'waiting',
      dropped_by_user_id INTEGER,
      received_by_user_id INTEGER,
      received_at TEXT,
      source TEXT NOT NULL DEFAULT 'tech',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parts_dropoffs_status ON parts_dropoffs(status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS parts_dropoff_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dropoff_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL DEFAULT 1,
      part_code TEXT,
      part_name TEXT,
      qty REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parts_dropoff_lines_dropoff ON parts_dropoff_lines(dropoff_id, line_no)`,
    `ALTER TABLE parts_dropoffs ADD COLUMN pickup_ticket_id INTEGER`,
    `ALTER TABLE parts_dropoffs ADD COLUMN pickup_line_id INTEGER`,
    `CREATE INDEX IF NOT EXISTS idx_parts_dropoffs_pickup_line ON parts_dropoffs(pickup_line_id)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists / already has column */
    }
  }
  partsDropoffTablesReady = true;
}

async function countPartsDropoffWaiting(db: D1Database): Promise<number> {
  try {
    await ensurePartsDropoffTables(db);
    const row = await db
      .prepare(`SELECT COUNT(*) as c FROM parts_dropoffs WHERE status = 'waiting'`)
      .first<{ c: number }>();
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

api.get("/inventory/parts-dropoffs/count", async (c) => {
  const waiting = await countPartsDropoffWaiting(c.env.DB);
  return c.json({ waiting });
});

/**
 * Parts the current user marked picked up recently but never logged "where placed"
 * (Brought to shop / drop-off). Used so they can finish after returning to the office.
 */
api.get("/inventory/parts-dropoffs/pending-placement", async (c) => {
  const user = c.get("user");
  await ensurePartsDropoffTables(c.env.DB);
  try {
    const rows = await c.env.DB.prepare(
      `SELECT l.id as line_id, l.ticket_id, l.part_name, l.part_code, l.qty_received,
              l.qty_requested, l.resolved_at, t.vendor_name, t.purchase_order, t.notes as ticket_notes
       FROM part_pickup_ticket_lines l
       JOIN part_pickup_tickets t ON t.id = l.ticket_id
       WHERE l.status IN ('picked', 'partial')
         AND l.resolved_by_user_id = ?
         AND l.resolved_at IS NOT NULL
         AND l.resolved_at >= datetime('now', '-3 days')
         AND NOT EXISTS (
           SELECT 1 FROM parts_dropoffs d
           WHERE d.status != 'cancelled'
             AND (
               d.pickup_line_id = l.id
               OR (
                 d.pickup_line_id IS NULL
                 AND d.dropped_by_user_id = l.resolved_by_user_id
                 AND lower(trim(d.vendor_name)) = lower(trim(t.vendor_name))
                 AND d.created_at >= datetime(l.resolved_at, '-2 hours')
               )
             )
         )
       ORDER BY l.resolved_at DESC
       LIMIT 40`
    )
      .bind(user.id)
      .all<{
        line_id: number;
        ticket_id: number;
        part_name: string | null;
        part_code: string | null;
        qty_received: number | null;
        qty_requested: number | null;
        resolved_at: string;
        vendor_name: string;
        purchase_order: string | null;
        ticket_notes: string | null;
      }>();

    const pending = (rows.results || []).map((r) => ({
      line_id: r.line_id,
      ticket_id: r.ticket_id,
      vendor_name: r.vendor_name,
      part_name: r.part_name || r.part_code || "Parts",
      part_code: r.part_code,
      qty: r.qty_received ?? r.qty_requested ?? 1,
      resolved_at: r.resolved_at,
      purchase_order: r.purchase_order,
      ticket_notes: r.ticket_notes,
    }));

    // Ensure an unread reminder exists so the bell shows something actionable
    for (const p of pending.slice(0, 10)) {
      try {
        const existing = await c.env.DB.prepare(
          `SELECT id FROM notifications
           WHERE user_id = ? AND kind = 'parts_place_reminder'
             AND entity_type = 'part_pickup' AND entity_id = ?
             AND read_at IS NULL
           LIMIT 1`
        )
          .bind(user.id, String(p.ticket_id))
          .first();
        if (!existing) {
          await notifyUsers(
            c.env.DB,
            [user.id],
            "parts_place_reminder",
            `Where did you put the ${p.vendor_name} parts?`,
            `${p.part_name} · open Brought to shop and record where you left them.`,
            { type: "part_pickup", id: p.ticket_id }
          );
        }
      } catch {
        /* ignore */
      }
    }

    return c.json({ pending, count: pending.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ pending: [], count: 0, error: "Pickup tables not ready" });
    }
    return c.json({ pending: [], count: 0, error: msg }, 500);
  }
});

/** List drop-offs: waiting (default) | received | all */
api.get("/inventory/parts-dropoffs", async (c) => {
  await ensurePartsDropoffTables(c.env.DB);
  const status = (c.req.query("status") || "waiting").toLowerCase();
  try {
    let where = "WHERE 1=1";
    if (status === "waiting" || status === "open") {
      where = "WHERE d.status = 'waiting'";
    } else if (status === "received" || status === "done") {
      where = "WHERE d.status = 'received'";
    } else if (status === "cancelled") {
      where = "WHERE d.status = 'cancelled'";
    }
    // else all
    const rows = await c.env.DB.prepare(
      `SELECT d.*,
          du.display_name as dropped_by_name,
          ru.display_name as received_by_name
       FROM parts_dropoffs d
       LEFT JOIN users du ON du.id = d.dropped_by_user_id
       LEFT JOIN users ru ON ru.id = d.received_by_user_id
       ${where}
       ORDER BY
         CASE d.status WHEN 'waiting' THEN 0 WHEN 'received' THEN 1 ELSE 2 END,
         d.created_at DESC
       LIMIT 80`
    ).all();

    const list = [];
    for (const r of rows.results || []) {
      const id = Number((r as { id: number }).id);
      let lines: unknown[] = [];
      try {
        const lr = await c.env.DB.prepare(
          `SELECT * FROM parts_dropoff_lines WHERE dropoff_id = ? ORDER BY line_no, id`
        )
          .bind(id)
          .all();
        lines = lr.results || [];
      } catch {
        lines = [];
      }
      list.push({ ...r, lines });
    }

    const waiting = await countPartsDropoffWaiting(c.env.DB);
    return c.json({ dropoffs: list, waiting });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        dropoffs: [],
        waiting: 0,
        error: "Run migration 044_parts_dropoffs.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Employee brought parts from a vendor to the shop.
 * Body: vendor_name, part_summary (or parts[]), for_unit?, notes?, source?
 */
api.post("/inventory/parts-dropoffs", async (c) => {
  const user = c.get("user");
  await ensurePartsDropoffTables(c.env.DB);
  const body = await c.req.json<{
    vendor_name?: string;
    part_summary?: string | null;
    for_unit?: string | null;
    notes?: string | null;
    parts?: Array<{ part_code?: string | null; part_name?: string | null; qty?: number }>;
    source?: "office" | "tech" | "warehouse" | "other";
    pickup_ticket_id?: number | null;
    pickup_line_id?: number | null;
  }>();

  const vendor = (body.vendor_name || "").trim();
  if (!vendor) return c.json({ error: "Vendor name is required" }, 400);
  const pickupTicketId = Number(body.pickup_ticket_id) || null;
  const pickupLineId = Number(body.pickup_line_id) || null;

  const partsIn = body.parts || [];
  let summary = (body.part_summary || "").trim();
  if (!summary && partsIn.length) {
    summary = partsIn
      .map((p) => {
        const label = (p.part_name || p.part_code || "Part").trim();
        const q = Number(p.qty);
        return Number.isFinite(q) && q !== 1 ? `${q}× ${label}` : label;
      })
      .filter(Boolean)
      .join(", ");
  }
  if (!summary || summary.length < 2) {
    return c.json({ error: "What parts did you drop off? Add a short description or part lines." }, 400);
  }

  const forUnit = (body.for_unit || "").trim() || null;
  const notes = (body.notes || "").trim() || null;
  const source = body.source || defaultVendorRunSource(user.role);

  try {
    let ins;
    try {
      ins = await c.env.DB.prepare(
        `INSERT INTO parts_dropoffs (
           vendor_name, part_summary, for_unit, notes, status,
           dropped_by_user_id, source, pickup_ticket_id, pickup_line_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(
          vendor,
          summary,
          forUnit,
          notes,
          user.id,
          source,
          pickupTicketId,
          pickupLineId
        )
        .run();
    } catch {
      // Older schema without pickup link columns
      ins = await c.env.DB.prepare(
        `INSERT INTO parts_dropoffs (
           vendor_name, part_summary, for_unit, notes, status,
           dropped_by_user_id, source, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'waiting', ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(vendor, summary, forUnit, notes, user.id, source)
        .run();
    }
    const dropoffId = Number(ins.meta.last_row_id);

    let lineNo = 1;
    for (const p of partsIn.slice(0, 40)) {
      const code = (p.part_code || "").trim() || null;
      const name = (p.part_name || "").trim() || null;
      if (!code && !name) continue;
      const qty = Number(p.qty);
      await c.env.DB.prepare(
        `INSERT INTO parts_dropoff_lines (dropoff_id, line_no, part_code, part_name, qty)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(dropoffId, lineNo++, code, name, Number.isFinite(qty) && qty > 0 ? qty : 1)
        .run();
    }

    // Notify warehouse / admin so they can put away or issue
    try {
      const targets = await usersByRoles(c.env.DB, ["admin", "warehouse"]);
      scheduleWaitUntil(
        c,
        notifyUsers(
          c.env.DB,
          targets.filter((id) => id !== user.id),
          "parts_dropoff",
          `Parts at shop · ${vendor}`,
          `${summary}${forUnit ? ` · unit ${forUnit}` : ""}${notes ? ` · ${notes.slice(0, 80)}` : ""} — dropped by ${user.display_name}`,
          { type: "parts_dropoff", id: dropoffId }
        ).catch(() => {
          /* non-fatal */
        })
      );
    } catch {
      /* optional */
    }

    // Clear this user's "where did you put the parts?" reminders for this vendor (or all open)
    try {
      await c.env.DB.prepare(
        `UPDATE notifications SET read_at = datetime('now')
         WHERE user_id = ? AND kind = 'parts_place_reminder' AND read_at IS NULL`
      )
        .bind(user.id)
        .run();
    } catch {
      /* optional */
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "parts_dropoff",
      dropoffId,
      `Drop-off ${vendor}: ${summary.slice(0, 80)}${notes ? ` · ${notes.slice(0, 40)}` : ""}`
    );

    const row = await c.env.DB.prepare(
      `SELECT d.*, u.display_name as dropped_by_name
       FROM parts_dropoffs d
       LEFT JOIN users u ON u.id = d.dropped_by_user_id
       WHERE d.id = ?`
    )
      .bind(dropoffId)
      .first();

    return c.json({ ok: true, dropoff: row }, 201);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 500);
  }
});

/** Warehouse marks drop-off received (put away / ready to issue). */
api.post("/inventory/parts-dropoffs/:id/receive", async (c) => {
  const user = c.get("user");
  if (!["admin", "warehouse", "office", "supervisor"].includes(user.role)) {
    return c.json({ error: "Warehouse / office marks drop-offs received" }, 403);
  }
  await ensurePartsDropoffTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ notes?: string | null }>().catch(() => ({} as { notes?: string }));

  const before = await c.env.DB.prepare(`SELECT * FROM parts_dropoffs WHERE id = ?`)
    .bind(id)
    .first<{ id: number; status: string; dropped_by_user_id: number | null; vendor_name: string; part_summary: string }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status === "received") return c.json({ error: "Already marked received" }, 400);
  if (before.status === "cancelled") return c.json({ error: "This drop-off was cancelled" }, 400);

  const extra = (body.notes || "").trim();
  await c.env.DB.prepare(
    `UPDATE parts_dropoffs SET
       status = 'received',
       received_by_user_id = ?,
       received_at = datetime('now'),
       notes = CASE WHEN ? != '' THEN trim(COALESCE(notes,'') || CASE WHEN notes IS NOT NULL AND notes != '' THEN ' | ' ELSE '' END || ?) ELSE notes END,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(user.id, extra, extra, id)
    .run();

  if (before.dropped_by_user_id && before.dropped_by_user_id !== user.id) {
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        [before.dropped_by_user_id],
        "parts_dropoff",
        `Drop-off received · ${before.vendor_name}`,
        `${before.part_summary} — ${user.display_name} has it at the shop`,
        { type: "parts_dropoff", id }
      ).catch(() => {
        /* ignore */
      })
    );
  }

  await writeAudit(c.env.DB, user, "update", "parts_dropoff", id, "Marked received at shop");
  const row = await c.env.DB.prepare(`SELECT * FROM parts_dropoffs WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, dropoff: row });
});

api.post("/inventory/parts-dropoffs/:id/cancel", async (c) => {
  const user = c.get("user");
  await ensurePartsDropoffTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));
  const before = await c.env.DB.prepare(`SELECT * FROM parts_dropoffs WHERE id = ?`)
    .bind(id)
    .first<{ id: number; status: string; dropped_by_user_id: number | null }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status !== "waiting") return c.json({ error: "Only waiting drop-offs can be cancelled" }, 400);

  const isOwner = before.dropped_by_user_id === user.id;
  const canManage = ["admin", "warehouse", "office", "supervisor"].includes(user.role);
  if (!isOwner && !canManage) {
    return c.json({ error: "Only the person who logged it, or warehouse, can cancel" }, 403);
  }

  const reason = (body.reason || "").trim();
  await c.env.DB.prepare(
    `UPDATE parts_dropoffs SET
       status = 'cancelled',
       notes = CASE WHEN ? != '' THEN trim(COALESCE(notes,'') || CASE WHEN notes IS NOT NULL AND notes != '' THEN ' | ' ELSE '' END || 'Cancelled: ' || ?) ELSE notes END,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(reason, reason, id)
    .run();

  await writeAudit(c.env.DB, user, "update", "parts_dropoff", id, "Cancelled drop-off");
  return c.json({ ok: true });
});

// Legacy list still works for old data (read-only helper via part-pickups is primary)
api.get("/inventory/vendor-runs", async (c) => {
  // Proxy shape expected by older clients: redirect semantics via same ticket list flattened
  try {
    const waiting = await countPartPickupWaiting(c.env.DB);
    const tickets = await c.env.DB.prepare(
      `SELECT t.*, u.display_name as logged_by_name
       FROM part_pickup_tickets t
       LEFT JOIN users u ON u.id = t.logged_by_user_id
       WHERE t.status IN ('open','partial')
       ORDER BY t.id DESC LIMIT 80`
    ).all();
    const flat: Record<string, unknown>[] = [];
    for (const t of tickets.results || []) {
      const tid = Number((t as { id: number }).id);
      const lines = await c.env.DB.prepare(
        `SELECT * FROM part_pickup_ticket_lines WHERE ticket_id = ? ORDER BY line_no`
      )
        .bind(tid)
        .all();
      for (const l of lines.results || []) {
        const line = l as Record<string, unknown>;
        flat.push({
          id: line.id,
          status:
            line.status === "picked"
              ? "picked"
              : line.status === "cancelled"
                ? "cancelled"
                : "waiting",
          vendor_name: (t as { vendor_name: string }).vendor_name,
          part_name: line.part_name || "Part TBD",
          part_code: line.part_code,
          qty: line.qty_requested,
          needed_for_date: (t as { needed_for_date: string }).needed_for_date,
          job_address: (t as { purchase_order: string }).purchase_order,
          notes: line.notes || (t as { notes: string }).notes,
          logged_by_name: (t as { logged_by_name: string }).logged_by_name,
          ticket_id: tid,
          line_status: line.status,
        });
      }
    }
    const byVendor = new Map<string, typeof flat>();
    for (const line of flat) {
      const key = String(line.vendor_name || "?");
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(line);
    }
    return c.json({
      vendors: [...byVendor.entries()].map(([vendor_name, lines]) => ({
        vendor_name,
        waiting: lines.filter((l) => l.status === "waiting").length,
        lines,
      })),
      vendor_names: [],
      waiting,
      lines: flat,
    });
  } catch {
    return c.json({ vendors: [], vendor_names: [], waiting: 0, lines: [] });
  }
});

api.patch("/inventory/pickups/:id", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    status?: string;
    destination_location_id?: number | null;
    for_user_id?: number | null;
    notes?: string;
  }>();
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  if (body.status) {
    sets.push("status = ?");
    vals.push(body.status);
    if (body.status === "ready") sets.push("ready_at = datetime('now')");
  }
  if (body.destination_location_id !== undefined) {
    sets.push("destination_location_id = ?");
    vals.push(body.destination_location_id);
  }
  if (body.for_user_id !== undefined) {
    sets.push("for_user_id = ?");
    vals.push(body.for_user_id);
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?");
    vals.push(body.notes);
  }
  vals.push(id);
  await c.env.DB.prepare(`UPDATE part_pickups SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...vals)
    .run();
  return c.json({ ok: true });
});

// ——— Company assets (bottles, ladders, tools) — outside pricebook ———

async function driverLocationIds(
  db: D1Database,
  user: PublicUser
): Promise<number[] | null> {
  const vids = await getDriverVehicleIds(db, user);
  if (vids === null) return null; // unrestricted
  if (!vids.length) return [];
  const locs = await db
    .prepare(
      `SELECT id FROM stock_locations WHERE type = 'vehicle' AND active = 1 AND vehicle_id IN (${vids
        .map(() => "?")
        .join(",")})`
    )
    .bind(...vids)
    .all<{ id: number }>();
  return (locs.results || []).map((r) => r.id);
}

api.get("/assets/bottles/summary", requireRoles(ROLE_PERMS.viewCompanyAssets), async (c) => {
  try {
    const user = c.get("user");
    const data = await bottleSummary(c.env.DB);
    // Field: only their truck rows
    if (user.role === "driver") {
      const locIds = await driverLocationIds(c.env.DB, user);
      if (locIds) {
        data.matrix = data.matrix.filter((m) => locIds.includes(m.location_id));
        // Recompute totals from visible rows only
        const totals = new Map<number, { full: number; empty: number }>();
        for (const row of data.matrix) {
          for (const b of row.bottles) {
            const t = totals.get(b.bottle_type_id) || { full: 0, empty: 0 };
            t.full += b.full_qty;
            t.empty += b.empty_qty;
            totals.set(b.bottle_type_id, t);
          }
        }
        data.types = data.types.map((t) => {
          const x = totals.get(t.id) || { full: 0, empty: 0 };
          return {
            ...t,
            full_total: x.full,
            empty_total: x.empty,
            total: x.full + x.empty,
          };
        });
      }
    }
    return c.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ types: [], matrix: [], error: "Run migration 026_company_assets" });
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/assets/bottles/events", requireRoles(ROLE_PERMS.viewCompanyAssets), async (c) => {
  try {
    const limit = Math.min(Number(c.req.query("limit") || 50), 200);
    const events = await listBottleEvents(c.env.DB, limit);
    return c.json({ events });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ events: [] });
    return c.json({ error: msg }, 500);
  }
});

api.post(
  "/assets/bottles/set",
  requireRoles(ROLE_PERMS.manageCompanyAssets),
  async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      location_id: number;
      bottle_type_id: number;
      full_qty: number;
      empty_qty: number;
      notes?: string;
    }>();
    try {
      await ensureCompanyAssets(c.env.DB);
      await setBottleCounts(
        c.env.DB,
        user.id,
        Number(body.location_id),
        Number(body.bottle_type_id),
        Math.floor(Number(body.full_qty) || 0),
        Math.floor(Number(body.empty_qty) || 0),
        body.notes
      );
      await writeAudit(
        c.env.DB,
        user,
        "update",
        "bottle",
        body.bottle_type_id,
        `Set bottles loc ${body.location_id}: ${body.full_qty} full / ${body.empty_qty} empty`
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Set failed" }, 400);
    }
  }
);

api.post(
  "/assets/bottles/adjust",
  requireRoles(ROLE_PERMS.manageCompanyAssets),
  async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      location_id: number;
      bottle_type_id: number;
      full_delta?: number;
      empty_delta?: number;
      notes?: string;
    }>();
    try {
      await ensureCompanyAssets(c.env.DB);
      const r = await adjustBottleCounts(
        c.env.DB,
        user.id,
        Number(body.location_id),
        Number(body.bottle_type_id),
        Math.floor(Number(body.full_delta) || 0),
        Math.floor(Number(body.empty_delta) || 0),
        body.notes
      );
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Adjust failed" }, 400);
    }
  }
);

api.post(
  "/assets/bottles/swap",
  requireRoles(ROLE_PERMS.manageCompanyAssets),
  async (c) => {
    const user = c.get("user");
    const body = await c.req.json<{
      truck_location_id: number;
      tech_user_id?: number | null;
      notes?: string;
      lines: Array<{ bottle_type_id: number; empty_in?: number; full_out?: number }>;
    }>();
    try {
      await ensureCompanyAssets(c.env.DB);
      await swapBottles(
        c.env.DB,
        user.id,
        Number(body.truck_location_id),
        (body.lines || []).map((l) => ({
          bottle_type_id: Number(l.bottle_type_id),
          empty_in: Math.floor(Number(l.empty_in) || 0),
          full_out: Math.floor(Number(l.full_out) || 0),
        })),
        body.tech_user_id || null,
        body.notes
      );
      await writeAudit(
        c.env.DB,
        user,
        "update",
        "bottle_swap",
        body.truck_location_id,
        `Bottle swap truck loc ${body.truck_location_id}`
      );
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Swap failed" }, 400);
    }
  }
);

api.get("/assets", requireRoles(ROLE_PERMS.viewCompanyAssets), async (c) => {
  try {
    await ensureCompanyAssets(c.env.DB);
    const user = c.get("user");
    const category = c.req.query("category") || undefined;
    const status = c.req.query("status") || undefined;
    const q = c.req.query("q") || undefined;
    const needs = c.req.query("needs_attention") === "1";
    const locationId = c.req.query("location_id")
      ? Number(c.req.query("location_id"))
      : undefined;
    const mine = c.req.query("mine") === "1";

    let locationIds: number[] | undefined;
    if (user.role === "driver" || mine) {
      const ids = await driverLocationIds(c.env.DB, user);
      if (ids !== null) {
        if (!ids.length) return c.json({ assets: [] });
        locationIds = ids;
      }
    }

    const assets = await listAssets(c.env.DB, {
      category,
      status,
      location_id: locationId,
      location_ids: locationIds,
      q,
      needs_attention: needs,
    });
    return c.json({ assets });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ assets: [] });
    return c.json({ error: msg }, 500);
  }
});

api.get("/assets/by-truck/:vehicleId", requireRoles(ROLE_PERMS.viewCompanyAssets), async (c) => {
  const user = c.get("user");
  const vehicleId = Number(c.req.param("vehicleId"));
  try {
    if (user.role === "driver") {
      await assertDriverVehicleAccess(c.env.DB, user, vehicleId);
    }
    const data = await truckAssetsBundle(c.env.DB, vehicleId);
    return c.json(data);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 400);
  }
});

api.get("/assets/:id", requireRoles(ROLE_PERMS.viewCompanyAssets), async (c) => {
  const id = Number(c.req.param("id"));
  try {
    const data = await getAsset(c.env.DB, id);
    if (!data) return c.json({ error: "Not found" }, 404);
    const user = c.get("user");
    if (user.role === "driver") {
      const locIds = await driverLocationIds(c.env.DB, user);
      const locId = data.asset.location_id as number | null;
      if (locIds !== null && (locId == null || !locIds.includes(locId))) {
        return c.json({ error: "Not your truck's equipment" }, 403);
      }
    }
    return c.json(data);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

api.post("/assets", requireRoles(ROLE_PERMS.manageCompanyAssets), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    name: string;
    category: AssetCategory;
    asset_tag?: string;
    subcategory?: string;
    serial_number?: string;
    manufacturer?: string;
    model?: string;
    location_id?: number;
    condition?: AssetCondition;
    condition_notes?: string;
    notes?: string;
    issued_to_user_id?: number;
  }>();
  try {
    await ensureCompanyAssets(c.env.DB);
    const id = await createAsset(c.env.DB, user.id, body);
    await writeAudit(c.env.DB, user, "create", "company_asset", id, `Created ${body.category}: ${body.name}`);
    return c.json({ ok: true, id }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Create failed" }, 400);
  }
});

api.patch("/assets/:id", requireRoles(ROLE_PERMS.manageCompanyAssets), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<Record<string, unknown>>();
  try {
    await updateAssetMeta(c.env.DB, id, body);
    if (body.status) {
      await c.env.DB.prepare(
        `INSERT INTO company_asset_events (asset_id, event_type, condition_after, notes, created_by_user_id)
         VALUES (?, 'status', ?, ?, ?)`
      )
        .bind(id, body.condition || null, `Status → ${body.status}`, user.id)
        .run();
    }
    await writeAudit(c.env.DB, user, "update", "company_asset", id, "Updated asset");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Update failed" }, 400);
  }
});

api.post("/assets/:id/issue", requireRoles(ROLE_PERMS.manageCompanyAssets), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    location_id?: number | null;
    condition: string;
    notes?: string;
    issued_to_user_id?: number | null;
    issued_at?: string | null;
  }>();
  if (!body.condition || !isValidCondition(body.condition)) {
    return c.json({ error: "Valid condition required on checkout" }, 400);
  }
  if (!body.location_id && !body.issued_to_user_id) {
    return c.json({ error: "Pick a person and/or truck to check out to" }, 400);
  }
  try {
    await issueAsset(
      c.env.DB,
      user.id,
      id,
      body.location_id ? Number(body.location_id) : null,
      body.condition as AssetCondition,
      body.notes,
      body.issued_to_user_id ? Number(body.issued_to_user_id) : null,
      body.issued_at || null
    );
    await writeAudit(c.env.DB, user, "update", "company_asset", id, "Checked out asset");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Checkout failed" }, 400);
  }
});

api.post("/assets/:id/return", requireRoles(ROLE_PERMS.manageCompanyAssets), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    condition: string;
    notes?: string;
    returned_at?: string | null;
  }>();
  if (!body.condition || !isValidCondition(body.condition)) {
    return c.json({ error: "Valid condition required on return" }, 400);
  }
  try {
    await returnAsset(
      c.env.DB,
      user.id,
      id,
      body.condition as AssetCondition,
      body.notes,
      body.returned_at || null
    );
    await writeAudit(c.env.DB, user, "update", "company_asset", id, "Returned asset to warehouse");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Return failed" }, 400);
  }
});

api.post("/assets/:id/transfer", requireRoles(ROLE_PERMS.manageCompanyAssets), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    location_id: number;
    notes?: string;
    issued_to_user_id?: number;
  }>();
  if (!body.location_id) return c.json({ error: "location_id required" }, 400);
  try {
    await transferAsset(
      c.env.DB,
      user.id,
      id,
      Number(body.location_id),
      body.notes,
      body.issued_to_user_id || null
    );
    await writeAudit(c.env.DB, user, "update", "company_asset", id, "Transferred asset");
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Transfer failed" }, 400);
  }
});

/** Condition / damage — warehouse anywhere; field only on their truck gear */
api.post("/assets/:id/condition", requireRoles(ROLE_PERMS.viewCompanyAssets), async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    condition: string;
    notes?: string;
    is_damage?: boolean;
  }>();
  if (!body.condition || !isValidCondition(body.condition)) {
    return c.json({ error: "Valid condition required" }, 400);
  }
  if (!body.notes?.trim()) {
    return c.json({ error: "Notes required (what is wrong / current state)" }, 400);
  }
  try {
    const data = await getAsset(c.env.DB, id);
    if (!data) return c.json({ error: "Not found" }, 404);

    const canManage = roleAtLeast(user.role, ROLE_PERMS.manageCompanyAssets);
    if (!canManage) {
      const locIds = await driverLocationIds(c.env.DB, user);
      const locId = data.asset.location_id as number | null;
      if (locIds === null) {
        /* mechanic — allow condition report */
      } else if (locId == null || !locIds.includes(locId)) {
        return c.json({ error: "You can only report condition on your truck's equipment" }, 403);
      }
    }

    await updateAssetCondition(
      c.env.DB,
      user.id,
      id,
      body.condition as AssetCondition,
      body.notes,
      !!body.is_damage
    );

    const bad = ["poor", "damaged", "out_of_service"].includes(body.condition);
    if (bad) {
      const targets = await usersByRoles(c.env.DB, ["admin", "warehouse"]);
      await notifyUsers(
        c.env.DB,
        targets.filter((x) => x !== user.id),
        "asset_damage",
        `Equipment condition: ${data.asset.name}`,
        `${user.display_name} set condition to ${body.condition}. ${body.notes}`,
        { type: "asset", id }
      );
    }

    await writeAudit(
      c.env.DB,
      user,
      "update",
      "company_asset",
      id,
      `Condition → ${body.condition}`
    );
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 400);
  }
});

/** Warehouse → truck (or any location → location) transfer. */
api.post("/inventory/stock/transfer", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    part_id: number;
    from_location_id: number;
    to_location_id: number;
    qty: number;
    notes?: string;
  }>();
  if (
    !body.part_id ||
    !body.from_location_id ||
    !body.to_location_id ||
    body.qty == null ||
    Number(body.qty) <= 0
  ) {
    return c.json({ error: "part_id, from_location_id, to_location_id, qty > 0 required" }, 400);
  }
  try {
    const r = await transferStock(
      c.env.DB,
      Number(body.part_id),
      Number(body.from_location_id),
      Number(body.to_location_id),
      Number(body.qty),
      user.id,
      body.notes || null
    );
    await writeAudit(
      c.env.DB,
      user,
      "update",
      "parts",
      body.part_id,
      `Transfer ${body.qty} loc ${body.from_location_id} → ${body.to_location_id}`
    );
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Transfer failed" }, 400);
  }
});

/** Create / update a material in ServiceTitan from our part row. */
api.post(
  "/inventory/parts/:id/push-st",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    const id = Number(c.req.param("id"));
    const part = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first<{
      id: number;
      code: string;
      name: string;
      description_text: string | null;
      cost: number | null;
      price: number | null;
      unit_of_measure: string | null;
      external_st_id: string | null;
      active: number;
    }>();
    if (!part) return c.json({ error: "Not found" }, 404);
    if (!(await stConfigured(c.env, c.env.DB))) {
      return c.json({ error: "ServiceTitan not configured (Admin → ServiceTitan)" }, 503);
    }
    try {
      const r = await createStMaterial(c.env, c.env.DB, {
        code: part.code,
        name: part.name,
        description: part.description_text,
        cost: part.cost,
        price: part.price,
        unitOfMeasure: part.unit_of_measure,
        externalId: part.external_st_id,
        active: part.active !== 0,
      });
      if (r.st_id) {
        await c.env.DB.prepare(
          `UPDATE parts SET external_st_id = ?, updated_at = datetime('now') WHERE id = ?`
        )
          .bind(String(r.st_id), id)
          .run();
      }
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "update",
        "parts",
        id,
        `Pushed to ServiceTitan material ${r.st_id || "?"}`
      );
      const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
      return c.json({ ok: true, ...r, part: updated });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "ST push failed" }, 500);
    }
  }
);

/** Deduct truck stock from recent ST job material usage (best-effort). */
api.post(
  "/inventory/sync-st-usage",
  requireRoles(ROLE_PERMS.manageInventory),
  async (c) => {
    if (!(await stConfigured(c.env, c.env.DB))) {
      return c.json({ error: "ServiceTitan not configured" }, 503);
    }
    try {
      const r = await applyStUsageDeductions(c.env, c.env.DB);
      await setSetting(
        c.env.DB,
        "st_last_status",
        `${new Date().toISOString()} | usage sync: ${r.deducted} lines, ${r.skipped} skipped`
      );
      return c.json({ ok: true, ...r });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "Usage sync failed" }, 500);
    }
  }
);

api.get("/inventory/summary", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  // Lightweight counts only — no ensureStockLocations (was slow on every page open)
  try {
    const [parts, locs, lines] = await Promise.all([
      c.env.DB.prepare(`SELECT COUNT(*) as c FROM parts WHERE active = 1`).first<{ c: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM stock_locations WHERE active = 1`
      ).first<{ c: number }>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM stock_balances WHERE qty > 0`
      ).first<{ c: number }>(),
    ]);
    let needsOrder = 0;
    try {
      // Faster low-stock count via join aggregate
      const low = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM parts p
         LEFT JOIN (
           SELECT part_id, SUM(qty) as tq FROM stock_balances GROUP BY part_id
         ) s ON s.part_id = p.id
         WHERE p.active = 1 AND p.min_qty IS NOT NULL
           AND COALESCE(s.tq, 0) < p.min_qty`
      ).first<{ c: number }>();
      needsOrder = low?.c ?? 0;
    } catch {
      needsOrder = 0;
    }
    return c.json({
      parts: parts?.c ?? 0,
      locations: locs?.c ?? 0,
      lines_with_stock: lines?.c ?? 0,
      needs_order: needsOrder,
      ready: true,
    });
  } catch {
    return c.json({
      parts: 0,
      locations: 0,
      lines_with_stock: 0,
      needs_order: 0,
      ready: false,
    });
  }
});

/** Per-location min/max (truck-specific stocking). Admin + warehouse only. */
api.put(
  "/inventory/parts/:id/location-levels",
  requireRoles(ROLE_PERMS.manageInventoryLevels),
  async (c) => {
    const partId = Number(c.req.param("id"));
    const body = await c.req.json<{
      location_id: number;
      min_qty?: number | null;
      max_qty?: number | null;
    }>();
    if (!body.location_id) return c.json({ error: "location_id required" }, 400);
    const part = await c.env.DB.prepare(`SELECT id, code FROM parts WHERE id = ?`)
      .bind(partId)
      .first<{ id: number; code: string }>();
    if (!part) return c.json({ error: "Not found" }, 404);
    try {
      await updateLocationLevels(
        c.env.DB,
        partId,
        Number(body.location_id),
        body.min_qty,
        body.max_qty
      );
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "update",
        "parts",
        partId,
        `Location levels loc=${body.location_id} min=${body.min_qty ?? "—"} max=${body.max_qty ?? "—"}`
      );
      return c.json({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/stock_location_levels|no such table/i.test(msg)) {
        return c.json({ error: "Run migration 023_warehouse_location_levels.sql" }, 503);
      }
      return c.json({ error: msg }, 400);
    }
  }
);

// ——— Truck stock counts (tech fills sheet; warehouse applies to inventory) ———

async function loadTruckCountSheet(db: D1Database, id: number) {
  const count = await db
    .prepare(
      `SELECT c.*, v.unit_number, v.year, v.make, v.model, v.assigned_driver,
              l.name as location_name,
              cu.display_name as created_by_name,
              du.display_name as counted_by_name,
              au.display_name as applied_by_name
       FROM truck_stock_counts c
       JOIN vehicles v ON v.id = c.vehicle_id
       LEFT JOIN stock_locations l ON l.id = c.location_id
       LEFT JOIN users cu ON cu.id = c.created_by_user_id
       LEFT JOIN users du ON du.id = c.counted_by_user_id
       LEFT JOIN users au ON au.id = c.applied_by_user_id
       WHERE c.id = ?`
    )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!count) return null;
  const lines = await db
    .prepare(
      `SELECT * FROM truck_stock_count_lines WHERE count_id = ?
       ORDER BY sort_order ASC, part_name ASC`
    )
    .bind(id)
    .all();
  return { count, lines: lines.results || [] };
}

api.get("/inventory/truck-counts", async (c) => {
  const user = c.get("user");
  const status = (c.req.query("status") || "open").trim();
  try {
    let sql = `SELECT c.id, c.vehicle_id, c.location_id, c.status, c.signed_name, c.signed_at,
        c.accuracy_confirmed, c.created_at, c.submitted_at, c.applied_at,
        v.unit_number, v.assigned_driver,
        (SELECT COUNT(*) FROM truck_stock_count_lines tl WHERE tl.count_id = c.id) as line_count,
        (SELECT COUNT(*) FROM truck_stock_count_lines tl
          WHERE tl.count_id = c.id AND tl.not_needed = 1) as not_needed_count,
        (SELECT COUNT(*) FROM truck_stock_count_lines tl
          WHERE tl.count_id = c.id AND tl.counted_qty IS NULL AND IFNULL(tl.not_needed,0) = 0) as blank_count,
        cu.display_name as created_by_name,
        du.display_name as counted_by_name
       FROM truck_stock_counts c
       JOIN vehicles v ON v.id = c.vehicle_id
       LEFT JOIN users cu ON cu.id = c.created_by_user_id
       LEFT JOIN users du ON du.id = c.counted_by_user_id
       WHERE 1=1`;
    const binds: unknown[] = [];
    if (status === "active") {
      sql += ` AND c.status IN ('open','submitted')`;
    } else if (status && status !== "all") {
      sql += ` AND c.status = ?`;
      binds.push(status);
    }
    // Drivers only see sheets for their assigned units
    if (user.role === "driver") {
      const vids = await getDriverVehicleIds(c.env.DB, user);
      if (!vids || !vids.length) {
        return c.json({ counts: [], open: 0 });
      }
      const ph = vids.map(() => "?").join(",");
      sql += ` AND c.vehicle_id IN (${ph})`;
      binds.push(...vids);
    }
    sql += ` ORDER BY
      CASE c.status WHEN 'open' THEN 0 WHEN 'submitted' THEN 1 WHEN 'applied' THEN 2 ELSE 3 END,
      v.unit_number
      LIMIT 200`;
    const rows = await c.env.DB.prepare(sql).bind(...binds).all();
    const openRow = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM truck_stock_counts WHERE status IN ('open','submitted')`
    ).first<{ c: number }>();
    return c.json({ counts: rows.results || [], open: openRow?.c ?? 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ counts: [], open: 0, error: "Run migration 034_truck_stock_counts.sql" });
    }
    return c.json({ error: msg }, 500);
  }
});

api.get("/inventory/truck-counts/:id", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  try {
    const sheet = await loadTruckCountSheet(c.env.DB, id);
    if (!sheet) return c.json({ error: "Not found" }, 404);
    if (user.role === "driver") {
      const vids = await getDriverVehicleIds(c.env.DB, user);
      const vid = Number(sheet.count.vehicle_id);
      if (!vids || !vids.includes(vid)) {
        return c.json({ error: "Not your truck" }, 403);
      }
    }
    return c.json(sheet);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 034_truck_stock_counts.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

/** Create count sheet(s) for one unit or all active trucks with truck-stock parts. */
api.post("/inventory/truck-counts", async (c) => {
  const user = c.get("user");
  if (!["admin", "warehouse", "office", "supervisor"].includes(user.role)) {
    return c.json({ error: "Only warehouse, office, or admin can open truck count sheets" }, 403);
  }
  const body = await c.req.json<{ vehicle_id?: number; all_active?: boolean }>().catch(() => ({}));
  try {
    await ensureStockLocations(c.env.DB);
    let vehicleIds: number[] = [];
    if (body.all_active) {
      const rows = await c.env.DB.prepare(
        `SELECT id FROM vehicles WHERE status = 'active' ORDER BY unit_number`
      ).all<{ id: number }>();
      vehicleIds = (rows.results || []).map((r) => r.id);
    } else if (body.vehicle_id) {
      vehicleIds = [Number(body.vehicle_id)];
    } else {
      return c.json({ error: "Pick a vehicle or all_active" }, 400);
    }

    const parts = await c.env.DB.prepare(
      `SELECT id, code, name FROM parts
       WHERE active = 1 AND IFNULL(truck_stock, 0) = 1
       ORDER BY name LIMIT 2000`
    ).all<{ id: number; code: string; name: string }>();
    const partList = parts.results || [];
    if (!partList.length) {
      return c.json({ error: "No truck-stock parts in catalog yet. Mark parts as truck stock first." }, 400);
    }

    const created: number[] = [];
    const skipped: string[] = [];

    for (const vid of vehicleIds) {
      const v = await c.env.DB.prepare(
        `SELECT id, unit_number FROM vehicles WHERE id = ? AND status != 'retired'`
      )
        .bind(vid)
        .first<{ id: number; unit_number: string }>();
      if (!v) continue;

      // One open sheet per truck at a time
      const existing = await c.env.DB.prepare(
        `SELECT id FROM truck_stock_counts WHERE vehicle_id = ? AND status IN ('open','submitted') LIMIT 1`
      )
        .bind(vid)
        .first<{ id: number }>();
      if (existing) {
        skipped.push(v.unit_number);
        continue;
      }

      const locId = await ensureVehicleStockLocation(c.env.DB, vid, v.unit_number, {
        seedTruckParts: true,
      });
      if (!locId) {
        skipped.push(v.unit_number);
        continue;
      }
      const ins = await c.env.DB.prepare(
        `INSERT INTO truck_stock_counts (vehicle_id, location_id, status, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, 'open', ?, datetime('now'), datetime('now'))`
      )
        .bind(vid, locId, user.id)
        .run();
      const cid = Number(ins.meta.last_row_id);

      let sort = 0;
      for (const p of partList) {
        const bal = await c.env.DB.prepare(
          `SELECT qty FROM stock_balances WHERE location_id = ? AND part_id = ?`
        )
          .bind(locId, p.id)
          .first<{ qty: number }>();
        const systemQty = bal?.qty ?? 0;
        await c.env.DB.prepare(
          `INSERT INTO truck_stock_count_lines
            (count_id, part_id, part_code, part_name, system_qty, counted_qty, not_needed, sort_order)
           VALUES (?, ?, ?, ?, ?, NULL, 0, ?)`
        )
          .bind(cid, p.id, p.code, p.name, systemQty, sort++)
          .run();
      }
      created.push(cid);
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "truck_stock_count",
      created[0] || null,
      `Opened ${created.length} truck count sheet(s)`
    );
    return c.json({ ok: true, created_ids: created, skipped_units: skipped });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 034_truck_stock_counts.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

/** Save line counts (tech / office / warehouse). */
api.put("/inventory/truck-counts/:id/lines", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);
  const body = await c.req.json<{
    lines?: Array<{
      id: number;
      counted_qty?: number | null;
      not_needed?: boolean | number;
      notes?: string | null;
    }>;
  }>();
  const lines = body.lines || [];
  if (!lines.length) return c.json({ error: "No lines to save" }, 400);

  try {
    const sheet = await c.env.DB.prepare(`SELECT * FROM truck_stock_counts WHERE id = ?`)
      .bind(id)
      .first<{ id: number; status: string; vehicle_id: number }>();
    if (!sheet) return c.json({ error: "Not found" }, 404);
    if (sheet.status !== "open" && sheet.status !== "submitted") {
      return c.json({ error: `Sheet is ${sheet.status} — cannot edit` }, 400);
    }
    // submitted sheets: warehouse can still tweak before apply; techs only edit open
    if (user.role === "driver") {
      if (sheet.status !== "open") {
        return c.json({ error: "Already submitted — ask warehouse to reopen if needed" }, 403);
      }
      const vids = await getDriverVehicleIds(c.env.DB, user);
      if (!vids?.includes(sheet.vehicle_id)) {
        return c.json({ error: "Not your truck" }, 403);
      }
    }

    for (const line of lines) {
      if (!line.id) continue;
      const notNeeded = line.not_needed === true || line.not_needed === 1 ? 1 : 0;
      let qty = line.counted_qty;
      if (notNeeded) qty = 0;
      if (qty != null && (!Number.isFinite(Number(qty)) || Number(qty) < 0)) {
        return c.json({ error: "Counts must be 0 or more" }, 400);
      }
      await c.env.DB.prepare(
        `UPDATE truck_stock_count_lines SET
           counted_qty = ?,
           not_needed = ?,
           notes = COALESCE(?, notes)
         WHERE id = ? AND count_id = ?`
      )
        .bind(
          qty == null ? null : Number(qty),
          notNeeded,
          line.notes != null ? String(line.notes).trim() || null : null,
          line.id,
          id
        )
        .run();
    }

    await c.env.DB.prepare(
      `UPDATE truck_stock_counts SET
         counted_by_user_id = COALESCE(counted_by_user_id, ?),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(user.id, id)
      .run();

    // If was submitted and warehouse edits, leave submitted; tech edit stays open
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Save failed" }, 500);
  }
});

/** Tech / office signs and submits for warehouse. */
api.post("/inventory/truck-counts/:id/submit", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    signed_name?: string;
    accuracy_confirmed?: boolean;
    notes?: string | null;
  }>();
  const signedName = (body.signed_name || "").trim();
  if (!signedName || signedName.length < 2) {
    return c.json({ error: "Type your name to sign" }, 400);
  }
  if (!body.accuracy_confirmed) {
    return c.json({ error: "Check the box confirming the count is accurate" }, 400);
  }

  try {
    const sheet = await c.env.DB.prepare(`SELECT * FROM truck_stock_counts WHERE id = ?`)
      .bind(id)
      .first<{ id: number; status: string; vehicle_id: number }>();
    if (!sheet) return c.json({ error: "Not found" }, 404);
    if (sheet.status !== "open") {
      return c.json({ error: `Already ${sheet.status}` }, 400);
    }
    if (user.role === "driver") {
      const vids = await getDriverVehicleIds(c.env.DB, user);
      if (!vids?.includes(sheet.vehicle_id)) {
        return c.json({ error: "Not your truck" }, 403);
      }
    }

    const blank = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM truck_stock_count_lines
       WHERE count_id = ? AND counted_qty IS NULL AND IFNULL(not_needed,0) = 0`
    )
      .bind(id)
      .first<{ c: number }>();
    if ((blank?.c ?? 0) > 0) {
      return c.json(
        {
          error: `${blank?.c} part(s) still blank — enter a count or check “Don’t need on truck”`,
        },
        400
      );
    }

    await c.env.DB.prepare(
      `UPDATE truck_stock_counts SET
         status = 'submitted',
         signed_name = ?,
         signed_at = datetime('now'),
         accuracy_confirmed = 1,
         counted_by_user_id = ?,
         notes = COALESCE(?, notes),
         submitted_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(signedName, user.id, body.notes?.trim() || null, id)
      .run();

    const notifyIds = await usersByRoles(c.env.DB, ["warehouse", "admin", "office"]);
    const unit = await c.env.DB.prepare(`SELECT unit_number FROM vehicles WHERE id = ?`)
      .bind(sheet.vehicle_id)
      .first<{ unit_number: string }>();
    await notifyUsers(
      c.env.DB,
      notifyIds.filter((uid) => uid !== user.id),
      "truck_stock_count",
      `Truck stock count · unit ${unit?.unit_number || sheet.vehicle_id}`,
      `Signed by ${signedName} — ready for warehouse to apply`,
      { type: "truck_stock_count", id }
    );

    await writeAudit(c.env.DB, user, "update", "truck_stock_count", id, `Submitted by ${signedName}`);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Submit failed" }, 500);
  }
});

/** Warehouse applies submitted (or open) counts into truck stock balances. */
api.post("/inventory/truck-counts/:id/apply", async (c) => {
  const user = c.get("user");
  if (!["admin", "warehouse", "office", "supervisor"].includes(user.role)) {
    return c.json({ error: "Only warehouse, office, or admin can apply counts" }, 403);
  }
  const id = Number(c.req.param("id"));
  try {
    const sheet = await c.env.DB.prepare(`SELECT * FROM truck_stock_counts WHERE id = ?`)
      .bind(id)
      .first<{
        id: number;
        status: string;
        vehicle_id: number;
        location_id: number;
        signed_name: string | null;
      }>();
    if (!sheet) return c.json({ error: "Not found" }, 404);
    if (sheet.status === "applied") return c.json({ error: "Already applied" }, 400);
    if (sheet.status === "cancelled") return c.json({ error: "Cancelled" }, 400);

    const lines = await c.env.DB.prepare(
      `SELECT * FROM truck_stock_count_lines WHERE count_id = ?`
    )
      .bind(id)
      .all<{
        id: number;
        part_id: number;
        part_name: string;
        counted_qty: number | null;
        not_needed: number;
      }>();

    let applied = 0;
    for (const line of lines.results || []) {
      const notNeeded = !!line.not_needed;
      if (line.counted_qty == null && !notNeeded) {
        return c.json({ error: `Still blank: ${line.part_name}` }, 400);
      }
      const qty = notNeeded ? 0 : Number(line.counted_qty) || 0;
      await setStockQty(
        c.env.DB,
        line.part_id,
        sheet.location_id,
        qty,
        user.id,
        notNeeded
          ? `Truck count #${id}: not needed on truck`
          : `Truck count #${id}: counted ${qty}${sheet.signed_name ? ` · signed ${sheet.signed_name}` : ""}`
      );
      applied++;
    }

    await c.env.DB.prepare(
      `UPDATE truck_stock_counts SET
         status = 'applied',
         applied_at = datetime('now'),
         applied_by_user_id = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(user.id, id)
      .run();

    await writeAudit(c.env.DB, user, "update", "truck_stock_count", id, `Applied ${applied} lines`);
    return c.json({ ok: true, applied });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Apply failed" }, 500);
  }
});

api.post("/inventory/truck-counts/:id/reopen", async (c) => {
  const user = c.get("user");
  if (!["admin", "warehouse", "office", "supervisor"].includes(user.role)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  const id = Number(c.req.param("id"));
  try {
    const sheet = await c.env.DB.prepare(`SELECT status FROM truck_stock_counts WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    if (!sheet) return c.json({ error: "Not found" }, 404);
    if (sheet.status === "applied") {
      return c.json({ error: "Already applied — open a new count sheet instead" }, 400);
    }
    await c.env.DB.prepare(
      `UPDATE truck_stock_counts SET
         status = 'open',
         signed_name = NULL,
         signed_at = NULL,
         accuracy_confirmed = 0,
         submitted_at = NULL,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(id)
      .run();
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Reopen failed" }, 500);
  }
});

/**
 * Combined low-stock: warehouse orders + truck stage list (print for pickup).
 */
api.get("/inventory/low-stock-report", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    await ensureStockLocations(c.env.DB);
    const report = await lowStockReport(c.env.DB);
    return c.json({ ok: true, ...report });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/stock_location_levels|no such table/i.test(msg)) {
      // Table optional — still run without location overrides
      return c.json({ ok: true, warehouse: [], trucks: [], error: msg });
    }
    return c.json({ error: msg }, 500);
  }
});

/** Parts at or below low (min_qty), with suggested order qty up to high (max_qty). */
api.get("/inventory/reorder", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  try {
    await ensureStockLocations(c.env.DB);
  } catch {
    return c.json({ error: "Inventory tables missing. Run migration 015_inventory.sql" }, 503);
  }
  const vendorFilter = (c.req.query("vendor") || "").trim();
  let sql = `SELECT p.id, p.code, p.name, p.category, p.cost, p.unit_of_measure,
      p.primary_vendor, p.min_qty, p.max_qty,
      COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = p.id), 0) as total_qty
     FROM parts p
     WHERE p.active = 1 AND p.min_qty IS NOT NULL
       AND COALESCE((SELECT SUM(b.qty) FROM stock_balances b WHERE b.part_id = p.id), 0) < p.min_qty`;
  const binds: unknown[] = [];
  if (vendorFilter) {
    sql += ` AND IFNULL(p.primary_vendor,'') LIKE ?`;
    binds.push(`%${vendorFilter}%`);
  }
  sql += ` ORDER BY IFNULL(p.primary_vendor, 'zzz'), p.name LIMIT 500`;
  try {
    const rows = await c.env.DB.prepare(sql).bind(...binds).all<{
      id: number;
      code: string;
      name: string;
      category: string | null;
      cost: number | null;
      unit_of_measure: string | null;
      primary_vendor: string | null;
      min_qty: number | null;
      max_qty: number | null;
      total_qty: number;
    }>();
    const items = (rows.results || []).map((r) => {
      const onHand = Number(r.total_qty) || 0;
      const orderQty = suggestedOrderQty(onHand, r.min_qty, r.max_qty);
      const unitCost = r.cost != null ? Number(r.cost) : null;
      return {
        ...r,
        total_qty: onHand,
        order_qty: orderQty,
        est_cost: unitCost != null ? unitCost * orderQty : null,
      };
    });
    return c.json({ items, generated_at: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Reorder query failed";
    if (/min_qty|no such column/i.test(msg)) {
      return c.json({ error: "Run migration 016_inventory_minmax.sql for min/max levels" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

/** Set low/high, truck-stock, and/or home warehouse section on a part. */
api.patch("/inventory/parts/:id", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    min_qty?: number | null;
    max_qty?: number | null;
    truck_stock?: boolean | number;
    home_location_id?: number | null;
  }>();
  const part = await c.env.DB.prepare(`SELECT id, code FROM parts WHERE id = ?`).bind(id).first<{
    id: number;
    code: string;
  }>();
  if (!part) return c.json({ error: "Not found" }, 404);

  try {
    if (body.min_qty !== undefined || body.max_qty !== undefined) {
      const u = c.get("user");
      if (!ROLE_PERMS.manageInventoryLevels.includes(u.role)) {
        return c.json({ error: "Only admin or warehouse can change min/max levels" }, 403);
      }
      await updatePartLevels(c.env.DB, id, body.min_qty, body.max_qty);
    }
    if (body.truck_stock !== undefined) {
      const on = body.truck_stock === true || body.truck_stock === 1;
      await setPartTruckStock(c.env.DB, id, on);
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "update",
        "parts",
        id,
        `Truck stock ${on ? "ON" : "OFF"} for ${part.code}`
      );
    }
    if (body.home_location_id !== undefined) {
      const homeId =
        body.home_location_id == null || body.home_location_id === ("" as unknown)
          ? null
          : Number(body.home_location_id);
      if (homeId != null && !Number.isFinite(homeId)) {
        return c.json({ error: "home_location_id invalid" }, 400);
      }
      if (homeId != null) {
        const loc = await c.env.DB.prepare(
          `SELECT id, type FROM stock_locations WHERE id = ? AND active = 1`
        )
          .bind(homeId)
          .first<{ id: number; type: string }>();
        if (!loc) return c.json({ error: "Home location not found" }, 400);
        if (loc.type === "vehicle") {
          return c.json({ error: "Home location must be a warehouse section (not a truck)" }, 400);
        }
      }
      try {
        await c.env.DB.prepare(
          `UPDATE parts SET home_location_id = ?, updated_at = datetime('now') WHERE id = ?`
        )
          .bind(homeId, id)
          .run();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/no such column/i.test(msg)) {
          return c.json({ error: "Run migration 029_warehouse_sections.sql" }, 503);
        }
        throw e;
      }
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "update",
        "parts",
        id,
        `Home location ${homeId ?? "cleared"} for ${part.code}`
      );
    } else if (
      (body.min_qty !== undefined || body.max_qty !== undefined) &&
      body.truck_stock === undefined
    ) {
      await writeAudit(
        c.env.DB,
        c.get("user"),
        "update",
        "parts",
        id,
        `Levels ${part.code}: min=${body.min_qty ?? "—"} max=${body.max_qty ?? "—"}`
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Update failed";
    if (/min_qty|truck_stock|home_location|no such column/i.test(msg)) {
      return c.json(
        {
          error: msg.includes("021")
            ? msg
            : msg.includes("029")
              ? msg
              : "Run inventory migrations (016/021/029)",
        },
        503
      );
    }
    return c.json({ error: msg }, 500);
  }

  const updated = await c.env.DB.prepare(`SELECT * FROM parts WHERE id = ?`).bind(id).first();
  return c.json({ ok: true, part: updated });
});

/**
 * Delete (deactivate) a part from this app and optionally the ServiceTitan pricebook.
 * ST cannot hard-delete materials; we deactivate them so they leave active pricebook use.
 */
api.delete("/inventory/parts/:id", requireRoles(ROLE_PERMS.manageInventory), async (c) => {
  const id = Number(c.req.param("id"));
  const deactivateSt =
    c.req.query("st") !== "0" && c.req.query("st") !== "false";

  try {
    const removed = await softDeletePart(c.env.DB, id);
    let st: { ok: boolean; detail: string } | null = null;

    if (deactivateSt && removed.external_st_id) {
      if (await stConfigured(c.env, c.env.DB)) {
        try {
          st = await deactivateStMaterial(c.env, c.env.DB, removed.external_st_id);
        } catch (e) {
          st = {
            ok: false,
            detail: e instanceof Error ? e.message : "ST deactivate failed",
          };
        }
      } else {
        st = {
          ok: false,
          detail: "ServiceTitan not configured — removed from app only",
        };
      }
    } else if (deactivateSt && !removed.external_st_id) {
      st = {
        ok: true,
        detail: "No ServiceTitan id on this part — app only",
      };
    }

    await writeAudit(
      c.env.DB,
      c.get("user"),
      "delete",
      "parts",
      id,
      `Deleted ${removed.code}${st ? ` | ST: ${st.detail}` : ""}`
    );

    return c.json({
      ok: true,
      code: removed.code,
      name: removed.name,
      st,
      message:
        st?.ok === false
          ? `Removed “${removed.name}” from this app. ServiceTitan: ${st.detail}`
          : `Removed “${removed.name}” from this app` +
            (deactivateSt && removed.external_st_id
              ? " and deactivated in ServiceTitan pricebook"
              : ""),
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Delete failed" }, 400);
  }
});

/** Recent stock movements (who changed what). */
api.get("/inventory/movements", requireRoles(ROLE_PERMS.viewInventory), async (c) => {
  const limit = Math.min(100, Math.max(10, Number(c.req.query("limit") || "40")));
  const partId = c.req.query("part_id");
  try {
    let sql = `SELECT m.id, m.part_id, m.from_location_id, m.to_location_id, m.qty, m.reason,
        m.notes, m.created_at, m.created_by_user_id,
        p.code as part_code, p.name as part_name,
        u.display_name as user_name,
        fl.name as from_name, tl.name as to_name
       FROM stock_movements m
       JOIN parts p ON p.id = m.part_id
       LEFT JOIN users u ON u.id = m.created_by_user_id
       LEFT JOIN stock_locations fl ON fl.id = m.from_location_id
       LEFT JOIN stock_locations tl ON tl.id = m.to_location_id`;
    const binds: unknown[] = [];
    if (partId) {
      sql += ` WHERE m.part_id = ?`;
      binds.push(Number(partId));
    }
    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    binds.push(limit);
    const rows = await c.env.DB.prepare(sql).bind(...binds).all();
    return c.json({ movements: rows.results || [] });
  } catch {
    return c.json({ movements: [] });
  }
});

// Reports CSV
api.get("/reports/fuel.csv", requireRoles(ROLE_PERMS.viewReports), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT f.fuel_date, v.unit_number, e.name as employee, f.odometer, f.gallons, f.total_cost, f.station_notes, u.display_name as entered_by
     FROM fuel_entries f
     JOIN vehicles v ON v.id = f.vehicle_id
     JOIN employees e ON e.id = f.employee_id
     JOIN users u ON u.id = f.entered_by_user_id
     ORDER BY f.fuel_date DESC`
  ).all<{
    fuel_date: string;
    unit_number: string;
    employee: string;
    odometer: number;
    gallons: number | null;
    total_cost: number | null;
    station_notes: string | null;
    entered_by: string;
  }>();

  const header = "fuel_date,unit_number,employee,odometer,gallons,total_cost,station_notes,entered_by\n";
  const lines = (rows.results || [])
    .map((r) =>
      [r.fuel_date, r.unit_number, r.employee, r.odometer, r.gallons ?? "", r.total_cost ?? "", csvEscape(r.station_notes), r.entered_by]
        .join(",")
    )
    .join("\n");
  return new Response(header + lines, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="fuel-report.csv"',
    },
  });
});

api.get("/reports/issues.csv", requireRoles(ROLE_PERMS.viewReports), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT i.id, v.unit_number, v.assigned_driver, i.status, i.severity, i.title,
            i.scheduled_date, i.created_at, u.display_name as reporter,
            i.is_emergency, i.completion_notes
     FROM vehicle_issues i
     JOIN vehicles v ON v.id = i.vehicle_id
     LEFT JOIN users u ON u.id = i.reported_by_user_id
     ORDER BY i.created_at DESC
     LIMIT 2000`
  ).all<{
    id: number;
    unit_number: string;
    assigned_driver: string | null;
    status: string;
    severity: string;
    title: string;
    scheduled_date: string | null;
    created_at: string;
    reporter: string | null;
    is_emergency: number | null;
    completion_notes: string | null;
  }>();

  const header =
    "id,unit_number,assigned_driver,status,severity,title,scheduled_date,created_at,reporter,is_emergency,completion_notes\n";
  const lines = (rows.results || [])
    .map((r) =>
      [
        r.id,
        r.unit_number,
        csvEscape(r.assigned_driver),
        r.status,
        r.severity,
        csvEscape(r.title),
        r.scheduled_date || "",
        r.created_at,
        csvEscape(r.reporter),
        r.is_emergency ? 1 : 0,
        csvEscape(r.completion_notes),
      ].join(",")
    )
    .join("\n");
  return new Response(header + lines, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": 'attachment; filename="repairs-report.csv"',
    },
  });
});

function csvEscape(v: string | null): string {
  if (!v) return "";
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// ——— Time off requests (employee → manager approval) ———

let timeOffTablesReady = false;
async function ensureTimeOffTables(db: D1Database): Promise<void> {
  if (timeOffTablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS time_off_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manager_user_id INTEGER,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      request_type TEXT NOT NULL DEFAULT 'pto',
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      manager_remarks TEXT,
      decided_by_user_id INTEGER,
      decided_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_time_off_user ON time_off_requests(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_time_off_manager ON time_off_requests(manager_user_id, status, start_date)`,
    `CREATE INDEX IF NOT EXISTS idx_time_off_status ON time_off_requests(status, start_date)`,
    `ALTER TABLE time_off_requests ADD COLUMN usage_status TEXT`,
    `ALTER TABLE time_off_requests ADD COLUMN hours_deducted REAL`,
    `ALTER TABLE time_off_requests ADD COLUMN hours_actual REAL`,
    `ALTER TABLE time_off_requests ADD COLUMN usage_confirmed_at TEXT`,
    `ALTER TABLE time_off_requests ADD COLUMN usage_confirmed_by_user_id INTEGER`,
    `ALTER TABLE time_off_requests ADD COLUMN usage_note TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_time_off_usage ON time_off_requests(usage_status, start_date)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  timeOffTablesReady = true;
}

const TIME_OFF_TYPES = new Set(["pto", "sick", "personal", "unpaid", "other"]);

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function timeOffTypeLabel(t: string): string {
  const map: Record<string, string> = {
    pto: "PTO / vacation",
    sick: "Sick",
    personal: "Personal",
    unpaid: "Unpaid",
    other: "Other",
  };
  return map[t] || t;
}

/** Who can decide for this request: assigned manager, or admin/office. */
function canDecideTimeOff(
  actor: { id: number; role: string },
  req: { manager_user_id: number | null }
): boolean {
  if (actor.role === "admin" || actor.role === "office" || actor.role === "supervisor")
    return true;
  if (req.manager_user_id != null && Number(req.manager_user_id) === actor.id) return true;
  return false;
}

api.get("/time-off/pending-count", async (c) => {
  const user = c.get("user");
  await ensureTimeOffTables(c.env.DB);
  try {
    let n = 0;
    if (user.role === "admin" || user.role === "office" || user.role === "supervisor") {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM time_off_requests WHERE status = 'pending'`
      ).first<{ c: number }>();
      n = row?.c ?? 0;
    } else {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM time_off_requests
         WHERE status = 'pending' AND manager_user_id = ?`
      )
        .bind(user.id)
        .first<{ c: number }>();
      n = row?.c ?? 0;
    }
    return c.json({ pending: n });
  } catch {
    return c.json({ pending: 0 });
  }
});

/**
 * List time-off requests.
 * ?view=mine (default) | approvals | all
 * approvals = pending (and recent decided) for managers
 */
api.get("/time-off", async (c) => {
  const user = c.get("user");
  await ensureTimeOffTables(c.env.DB);
  const view = (c.req.query("view") || "mine").toLowerCase();
  try {
    let sql = `SELECT r.*,
        u.display_name as employee_name,
        m.display_name as manager_name,
        d.display_name as decided_by_name
       FROM time_off_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users m ON m.id = r.manager_user_id
       LEFT JOIN users d ON d.id = r.decided_by_user_id`;
    const binds: unknown[] = [];

    if (view === "approvals") {
      if (user.role === "admin" || user.role === "office" || user.role === "supervisor") {
        sql += ` WHERE r.status = 'pending' OR (
          r.status IN ('approved','declined') AND date(r.decided_at) >= date('now', '-60 days')
        )`;
      } else {
        // Direct reports + any request assigned to this manager
        sql += ` WHERE r.manager_user_id = ?
          AND (r.status = 'pending' OR (
            r.status IN ('approved','declined') AND date(r.decided_at) >= date('now', '-60 days')
          ))`;
        binds.push(user.id);
      }
      sql += ` ORDER BY
        CASE r.status WHEN 'pending' THEN 0 ELSE 1 END,
        r.start_date ASC, r.id DESC LIMIT 100`;
    } else if (view === "all" && (user.role === "admin" || user.role === "office" || user.role === "supervisor")) {
      sql += ` ORDER BY r.created_at DESC LIMIT 150`;
    } else {
      // mine
      sql += ` WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 80`;
      binds.push(user.id);
    }

    const rows = await c.env.DB.prepare(sql).bind(...binds).all();
    let pendingForMe = 0;
    if (user.role === "admin" || user.role === "office" || user.role === "supervisor") {
      const p = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM time_off_requests WHERE status = 'pending'`
      ).first<{ c: number }>();
      pendingForMe = p?.c ?? 0;
    } else {
      const p = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM time_off_requests
         WHERE status = 'pending' AND manager_user_id = ?`
      )
        .bind(user.id)
        .first<{ c: number }>();
      pendingForMe = p?.c ?? 0;
    }

    // Am I anyone's manager?
    let isManager = user.role === "admin" || user.role === "office" || user.role === "supervisor";
    if (!isManager) {
      try {
        const m = await c.env.DB.prepare(
          `SELECT COUNT(*) as c FROM users WHERE manager_user_id = ? AND active = 1`
        )
          .bind(user.id)
          .first<{ c: number }>();
        isManager = (m?.c ?? 0) > 0 || pendingForMe > 0;
      } catch {
        /* column optional on old DB */
      }
    }

    return c.json({
      requests: rows.results || [],
      pending_for_me: pendingForMe,
      is_manager: isManager,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        requests: [],
        pending_for_me: 0,
        is_manager: false,
        error: "Run migration 045_time_off_requests.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/time-off", async (c) => {
  const user = c.get("user");
  await ensureTimeOffTables(c.env.DB);
  const body = await c.req.json<{
    start_date?: string;
    end_date?: string;
    request_type?: string;
    reason?: string | null;
  }>();

  const start = (body.start_date || "").trim();
  const end = (body.end_date || "").trim() || start;
  if (!isIsoDate(start) || !isIsoDate(end)) {
    return c.json({ error: "Start and end dates are required (YYYY-MM-DD)" }, 400);
  }
  if (end < start) {
    return c.json({ error: "End date cannot be before start date" }, 400);
  }
  const requestType = (body.request_type || "pto").trim().toLowerCase();
  if (!TIME_OFF_TYPES.has(requestType)) {
    return c.json({ error: "Invalid request type" }, 400);
  }
  const reason = (body.reason || "").trim() || null;
  const hoursNeeded = hoursForDateRange(start, end, 8);

  // Failsafe: vacation/sick can only be requested up to available bank
  // (balance minus other pending requests of the same bank). Unpaid/other stay open.
  if (requestType === "pto" || requestType === "sick") {
    await ensurePtoTables(c.env.DB);
    const urow = await c.env.DB.prepare(`SELECT employee_id FROM users WHERE id = ?`)
      .bind(user.id)
      .first<{ employee_id: number | null }>();
    const empId = urow?.employee_id ? Number(urow.employee_id) : null;
    if (!empId) {
      return c.json(
        {
          error:
            "Your login is not linked to an employee record, so vacation/sick can’t be requested. Ask office to link you in People.",
        },
        400
      );
    }
    if (empId) {
      const asOf = ptoLocalIsoDate();
      const emp = await c.env.DB.prepare(
        `SELECT id, name, active, hire_date, birthday_md FROM employees WHERE id = ?`
      )
        .bind(empId)
        .first<EmployeePtoProfile>();
      if (emp?.hire_date) await applyDueAnniversary(c.env.DB, empId, emp.hire_date, asOf);
      const bal = await c.env.DB.prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
        .bind(empId)
        .first<{
          vacation_entitlement_hours: number;
          vacation_used_hours: number;
          sick_entitlement_hours: number;
          sick_used_hours: number;
        }>();
      const vacBal =
        Number(bal?.vacation_entitlement_hours ?? 0) - Number(bal?.vacation_used_hours ?? 0);
      const sickBal =
        Number(bal?.sick_entitlement_hours ?? 0) - Number(bal?.sick_used_hours ?? 0);
      const bankKind = requestType === "sick" ? "sick" : "vacation";
      const balance = bankKind === "sick" ? sickBal : vacBal;

      // Pending same-bank requests already spoken for
      const pendingType = requestType === "sick" ? "sick" : "pto";
      const pendingRows = await c.env.DB.prepare(
        `SELECT start_date, end_date FROM time_off_requests
         WHERE user_id = ? AND status = 'pending' AND request_type = ?`
      )
        .bind(user.id, pendingType)
        .all<{ start_date: string; end_date: string }>();
      let pendingHours = 0;
      for (const r of pendingRows.results || []) {
        pendingHours += hoursForDateRange(r.start_date, r.end_date, 8);
      }
      const available = balance - pendingHours;
      if (hoursNeeded > available + 1e-9) {
        const label = bankKind === "sick" ? "sick" : "vacation";
        return c.json(
          {
            error: `Not enough ${label} hours. This request needs ${hoursNeeded}h; you have ${Math.max(0, Math.round(available * 10) / 10)}h available${
              pendingHours > 0 ? ` (${pendingHours}h already in pending requests)` : ""
            }.`,
            hours_needed: hoursNeeded,
            hours_available: Math.max(0, available),
            balance,
            pending_hours: pendingHours,
          },
          400
        );
      }
    }
  }

  // Resolve manager from users.manager_user_id; fall back to first active admin
  let managerId: number | null = null;
  try {
    const me = await c.env.DB.prepare(
      `SELECT manager_user_id FROM users WHERE id = ?`
    )
      .bind(user.id)
      .first<{ manager_user_id: number | null }>();
    if (me?.manager_user_id) managerId = Number(me.manager_user_id);
  } catch {
    /* column may be missing on very old DB */
  }
  if (!managerId) {
    const admin = await c.env.DB.prepare(
      `SELECT id FROM users WHERE active = 1 AND role = 'admin' ORDER BY id LIMIT 1`
    ).first<{ id: number }>();
    managerId = admin?.id ?? null;
  }

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO time_off_requests (
         user_id, manager_user_id, start_date, end_date, request_type, reason,
         status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
    )
      .bind(user.id, managerId, start, end, requestType, reason)
      .run();
    const id = Number(ins.meta.last_row_id);

    const range =
      start === end ? start : `${start} → ${end}`;
    const label = timeOffTypeLabel(requestType);

    // Notify manager (+ admins if manager missing)
    const notifyIds = new Set<number>();
    if (managerId) notifyIds.add(managerId);
    else {
      const admins = await usersByRoles(c.env.DB, ["admin", "office", "supervisor"]);
      for (const a of admins) notifyIds.add(a);
    }
    notifyIds.delete(user.id);

    if (notifyIds.size) {
      scheduleWaitUntil(
        c,
        notifyUsers(
          c.env.DB,
          [...notifyIds],
          "time_off_request",
          `Time off request · ${user.display_name}`,
          `${label} · ${range}${reason ? ` · ${reason.slice(0, 80)}` : ""}`,
          { type: "time_off", id }
        ).catch(() => {
          /* non-fatal */
        })
      );
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "time_off_request",
      id,
      `${label} ${range}`
    );

    const row = await c.env.DB.prepare(
      `SELECT r.*, u.display_name as employee_name, m.display_name as manager_name
       FROM time_off_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users m ON m.id = r.manager_user_id
       WHERE r.id = ?`
    )
      .bind(id)
      .first();

    return c.json({ ok: true, request: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

api.post("/time-off/:id/decide", async (c) => {
  const user = c.get("user");
  await ensureTimeOffTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    decision?: "approved" | "declined";
    remarks?: string | null;
    /** Optional override; default = 8h × calendar days in range */
    hours?: number | null;
  }>();
  const decision = body.decision;
  if (decision !== "approved" && decision !== "declined") {
    return c.json({ error: "decision must be approved or declined" }, 400);
  }
  const remarks = (body.remarks || "").trim() || null;

  const before = await c.env.DB.prepare(`SELECT * FROM time_off_requests WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      manager_user_id: number | null;
      status: string;
      start_date: string;
      end_date: string;
      request_type: string;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status !== "pending") {
    return c.json({ error: "This request was already decided or cancelled" }, 400);
  }
  if (!canDecideTimeOff(user, before)) {
    return c.json({ error: "Only the employee’s manager (or office/admin) can decide" }, 403);
  }

  const hoursOverride =
    body.hours != null && Number.isFinite(Number(body.hours))
      ? Math.max(0, Number(body.hours))
      : null;

  const range =
    before.start_date === before.end_date
      ? before.start_date
      : `${before.start_date} → ${before.end_date}`;
  const typeLabel = timeOffTypeLabel(before.request_type);
  const decisionLabel = decision === "approved" ? "Approved" : "Declined";

  // Pre-check bank BEFORE marking approved (failsafe — no overdraw)
  let approveEmpId: number | null = null;
  let approveHours = 0;
  let approveKind: PtoKind | null = null;
  if (decision === "approved") {
    approveKind =
      before.request_type === "pto"
        ? "vacation"
        : before.request_type === "sick"
          ? "sick"
          : null;
    if (approveKind) {
      await ensurePtoTables(c.env.DB);
      const urow = await c.env.DB.prepare(`SELECT employee_id FROM users WHERE id = ?`)
        .bind(before.user_id)
        .first<{ employee_id: number | null }>();
      approveEmpId = urow?.employee_id ? Number(urow.employee_id) : null;
      if (!approveEmpId) {
        return c.json(
          {
            error:
              "Cannot approve — employee login is not linked to People, so banks can’t be updated. Link them first or decline.",
          },
          400
        );
      }
      approveHours =
        hoursOverride ?? hoursForDateRange(before.start_date, before.end_date, 8);
      if (approveHours > 0) {
        const empRow = await c.env.DB.prepare(
          `SELECT id, name, active, hire_date, birthday_md FROM employees WHERE id = ?`
        )
          .bind(approveEmpId)
          .first<EmployeePtoProfile>();
        if (empRow?.hire_date) {
          await applyDueAnniversary(c.env.DB, approveEmpId, empRow.hire_date);
        }
        const curBal = await c.env.DB.prepare(
          `SELECT vacation_entitlement_hours, vacation_used_hours,
                  sick_entitlement_hours, sick_used_hours
           FROM pto_balances WHERE employee_id = ?`
        )
          .bind(approveEmpId)
          .first<{
            vacation_entitlement_hours: number;
            vacation_used_hours: number;
            sick_entitlement_hours: number;
            sick_used_hours: number;
          }>();
        const vacLeft =
          Number(curBal?.vacation_entitlement_hours ?? 0) -
          Number(curBal?.vacation_used_hours ?? 0);
        const sickLeft =
          Number(curBal?.sick_entitlement_hours ?? 0) -
          Number(curBal?.sick_used_hours ?? 0);
        const left = approveKind === "sick" ? sickLeft : vacLeft;
        if (approveHours > left + 1e-9) {
          return c.json(
            {
              error: `Cannot approve — only ${Math.max(0, Math.round(left * 10) / 10)}h ${approveKind} left; this request needs ${approveHours}h. Decline it or have them shorten the dates.`,
            },
            400
          );
        }
      }
    }
  }

  await c.env.DB.prepare(
    `UPDATE time_off_requests SET
       status = ?,
       manager_remarks = ?,
       decided_by_user_id = ?,
       decided_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(decision, remarks, user.id, id)
    .run();

  let ptoNote: string | null = null;
  if (decision === "approved" && approveKind && approveEmpId && approveHours > 0) {
    try {
      const bal = await deductForApprovedRequest(c.env.DB, {
        employee_id: approveEmpId,
        kind: approveKind,
        hours: approveHours,
        entry_date: before.start_date,
        time_off_request_id: id,
        note: `${typeLabel} ${range}`,
        created_by_user_id: user.id,
      });
      ptoNote =
        approveKind === "vacation"
          ? `Deducted ${approveHours}h vacation → balance ${bal.vacation_balance}h`
          : `Deducted ${approveHours}h sick → balance ${bal.sick_balance}h`;
      try {
        await c.env.DB.prepare(
          `UPDATE time_off_requests SET
             usage_status = 'pending_confirm',
             hours_deducted = ?,
             hours_actual = NULL,
             usage_confirmed_at = NULL,
             usage_confirmed_by_user_id = NULL,
             usage_note = NULL
           WHERE id = ?`
        )
          .bind(approveHours, id)
          .run();
      } catch {
        /* usage columns optional until migration */
      }
    } catch {
      /* deduct best-effort after status write */
    }
  }

  scheduleWaitUntil(
    c,
    notifyAndSms(c.env, c.env.DB, [before.user_id], {
      kind: "time_off_decision",
      title: `Time off ${decisionLabel.toLowerCase()} · ${typeLabel}`,
      body: `${range}${remarks ? ` · Manager: ${remarks}` : ` · by ${user.display_name}`}`,
      entity: { type: "time_off", id },
      sms: shortSms(
        `TA: Your ${typeLabel} (${range}) was ${decisionLabel.toLowerCase()}${
          remarks ? ` · ${remarks.slice(0, 80)}` : ""
        }.`
      ),
      fromUserId: user.id,
      smsContext: `time_off_decision:${id}:${decision}`,
    }).catch(() => {
      /* non-fatal */
    })
  );

  await writeAudit(
    c.env.DB,
    user,
    "update",
    "time_off_request",
    id,
    `${decisionLabel} · ${typeLabel} ${range}${ptoNote ? ` · ${ptoNote}` : ""}`
  );

  const row = await c.env.DB.prepare(
    `SELECT r.*, u.display_name as employee_name, m.display_name as manager_name,
            d.display_name as decided_by_name
     FROM time_off_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN users m ON m.id = r.manager_user_id
     LEFT JOIN users d ON d.id = r.decided_by_user_id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  return c.json({ ok: true, request: row, pto: ptoNote });
});

/** My vacation/sick balances (auto-applies due anniversary). */
api.get("/time-off/balances/me", async (c) => {
  const me = c.get("user");
  await ensurePtoTables(c.env.DB);
  const asOf = ptoLocalIsoDate();
  await applyDueAnniversariesAll(c.env.DB, asOf).catch(() => 0);
  if (!me.employee_id) {
    return c.json({
      linked: false,
      vacation_balance: null,
      sick_balance: null,
      message: "No employee roster link — ask office to link your login to an employee.",
    });
  }
  const emp = await c.env.DB.prepare(
    `SELECT id, name, active, hire_date, birthday_md FROM employees WHERE id = ?`
  )
    .bind(me.employee_id)
    .first<EmployeePtoProfile>();
  if (!emp) return c.json({ linked: false, vacation_balance: null, sick_balance: null });
  if (emp.hire_date) await applyDueAnniversary(c.env.DB, emp.id, emp.hire_date, asOf);
  const bal = await c.env.DB.prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
    .bind(emp.id)
    .first();
  return c.json({
    linked: true,
    as_of: asOf,
    ...boardRowFrom(emp, bal as never, asOf),
  });
});

/** Office PTO board — sheet-style roster with balances (negatives allowed). */
api.get("/time-off/board", requireRoles(["admin", "office", "supervisor"] as Role[]), async (c) => {
  await ensurePtoTables(c.env.DB);
  const asOf = ptoLocalIsoDate();
  await applyDueAnniversariesAll(c.env.DB, asOf);
  const emps = await c.env.DB.prepare(
    `SELECT id, name, active, hire_date, birthday_md FROM employees WHERE active = 1 ORDER BY name`
  ).all<EmployeePtoProfile>();
  const bals = await c.env.DB.prepare(`SELECT * FROM pto_balances`).all();
  const byId = new Map(
    (bals.results || []).map((b: { employee_id: number }) => [b.employee_id, b])
  );
  const rows = (emps.results || []).map((e) =>
    boardRowFrom(e, (byId.get(e.id) as never) || null, asOf)
  );
  return c.json({ as_of: asOf, rows });
});

/** Birthdays + anniversaries in the next ~45 days. */
api.get("/time-off/upcoming", requireRoles(["admin", "office", "supervisor"] as Role[]), async (c) => {
  await ensurePtoTables(c.env.DB);
  const asOf = ptoLocalIsoDate();
  const emps = await c.env.DB.prepare(
    `SELECT id, name, active, hire_date, birthday_md FROM employees WHERE active = 1`
  ).all<EmployeePtoProfile>();
  return c.json({
    as_of: asOf,
    events: upcomingRecognition(emps.results || [], asOf),
  });
});

/** Printable usage / request report for disputes. */
api.get("/time-off/report", requireRoles(["admin", "office", "supervisor"] as Role[]), async (c) => {
  await ensurePtoTables(c.env.DB);
  const employeeId = Number(c.req.query("employee_id") || "0");
  const from = (c.req.query("from") || "").trim();
  const to = (c.req.query("to") || "").trim();
  if (!employeeId) return c.json({ error: "employee_id required" }, 400);

  const emp = await c.env.DB.prepare(
    `SELECT id, name, hire_date, birthday_md FROM employees WHERE id = ?`
  )
    .bind(employeeId)
    .first();
  if (!emp) return c.json({ error: "Employee not found" }, 404);

  let reqSql = `SELECT r.*, u.display_name as employee_name, d.display_name as decided_by_name
     FROM time_off_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN users d ON d.id = r.decided_by_user_id
     WHERE u.employee_id = ? AND r.status = 'approved'`;
  const binds: (string | number)[] = [employeeId];
  if (from) {
    reqSql += ` AND r.end_date >= ?`;
    binds.push(from);
  }
  if (to) {
    reqSql += ` AND r.start_date <= ?`;
    binds.push(to);
  }
  // Oldest → newest so Print report reads chronologically from anniversary start.
  reqSql += ` ORDER BY r.start_date ASC, r.id ASC`;
  const requests = await c.env.DB.prepare(reqSql)
    .bind(...binds)
    .all();

  let ledSql = `SELECT * FROM pto_ledger WHERE employee_id = ?`;
  const ledBinds: (string | number)[] = [employeeId];
  if (from) {
    ledSql += ` AND entry_date >= ?`;
    ledBinds.push(from);
  }
  if (to) {
    ledSql += ` AND entry_date <= ?`;
    ledBinds.push(to);
  }
  ledSql += ` ORDER BY entry_date ASC, id ASC LIMIT 500`;
  const ledger = await c.env.DB.prepare(ledSql)
    .bind(...ledBinds)
    .all();

  const asOf = ptoLocalIsoDate();
  if ((emp as { hire_date?: string }).hire_date) {
    await applyDueAnniversary(
      c.env.DB,
      employeeId,
      (emp as { hire_date: string }).hire_date,
      asOf
    );
  }
  const bal = await c.env.DB.prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
    .bind(employeeId)
    .first();

  return c.json({
    employee: emp,
    as_of: asOf,
    balance: bal
      ? boardRowFrom(emp as EmployeePtoProfile, bal as never, asOf)
      : null,
    approved_requests: requests.results || [],
    ledger: ledger.results || [],
  });
});

/** Manual balance adjust (office) — can create negatives. */
api.post(
  "/time-off/manual-adjust",
  requireRoles(["admin", "office"] as Role[]),
  async (c) => {
    const me = c.get("user");
    await ensurePtoTables(c.env.DB);
    const body = await c.req.json<{
      employee_id?: number;
      kind?: PtoKind;
      /** Positive = add to used (use more); negative = credit / restore hours */
      hours?: number;
      note?: string;
      entry_date?: string;
    }>();
    const empId = Number(body.employee_id || 0);
    const kind = body.kind === "sick" ? "sick" : body.kind === "vacation" ? "vacation" : null;
    const hours = Number(body.hours);
    if (!empId || !kind || !Number.isFinite(hours) || hours === 0) {
      return c.json({ error: "employee_id, kind (vacation|sick), and non-zero hours required" }, 400);
    }
    const note = (body.note || "").trim();
    if (!note) return c.json({ error: "Note required for manual adjustments" }, 400);
    const entryDate = (body.entry_date || "").trim() || ptoLocalIsoDate();

    const emp = await c.env.DB.prepare(
      `SELECT id, name, active, hire_date, birthday_md FROM employees WHERE id = ?`
    )
      .bind(empId)
      .first<EmployeePtoProfile>();
    if (!emp) return c.json({ error: "Employee not found" }, 404);
    if (emp.hire_date) await applyDueAnniversary(c.env.DB, emp.id, emp.hire_date);

    let bal = await c.env.DB.prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
      .bind(empId)
      .first<{
        vacation_entitlement_hours: number;
        vacation_used_hours: number;
        sick_entitlement_hours: number;
        sick_used_hours: number;
        last_anniversary_applied: string | null;
      }>();
    if (!bal) {
      await c.env.DB.prepare(
        `INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours,
          sick_entitlement_hours, sick_used_hours, updated_at)
         VALUES (?, 0, 0, 0, 0, datetime('now'))`
      )
        .bind(empId)
        .run();
      bal = {
        vacation_entitlement_hours: 0,
        vacation_used_hours: 0,
        sick_entitlement_hours: 0,
        sick_used_hours: 0,
        last_anniversary_applied: null,
      };
    }
    const vacUsed =
      Number(bal.vacation_used_hours) + (kind === "vacation" ? hours : 0);
    const sickUsed = Number(bal.sick_used_hours) + (kind === "sick" ? hours : 0);
    await c.env.DB.prepare(
      `UPDATE pto_balances SET
         vacation_used_hours = ?, sick_used_hours = ?, updated_at = datetime('now')
       WHERE employee_id = ?`
    )
      .bind(vacUsed, sickUsed, empId)
      .run();
    await writePtoLedger(c.env.DB, {
      employee_id: empId,
      entry_date: entryDate,
      kind,
      hours,
      source: "manual",
      note,
      created_by_user_id: me.id,
    });
    await writeAudit(
      c.env.DB,
      me,
      "update",
      "pto_balance",
      empId,
      `Manual ${kind} ${hours > 0 ? "+" : ""}${hours}h used · ${note}`
    );
    const after = await c.env.DB.prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
      .bind(empId)
      .first();
    return c.json({
      ok: true,
      row: boardRowFrom(emp, after as never, ptoLocalIsoDate()),
    });
  }
);

/**
 * Pay-week checklist: approved PTO/sick overlapping a date range.
 * Office confirms they actually took the time (or restores if they came in).
 */
api.get(
  "/time-off/payroll-check",
  requireRoles(["admin", "office", "supervisor"] as Role[]),
  async (c) => {
    await ensureTimeOffTables(c.env.DB);
    await ensurePtoTables(c.env.DB);
    const from = (c.req.query("from") || "").trim();
    const to = (c.req.query("to") || "").trim();
    if (!isIsoDate(from) || !isIsoDate(to) || to < from) {
      return c.json({ error: "from and to (YYYY-MM-DD) required" }, 400);
    }

    let rows: Array<Record<string, unknown>> = [];
    try {
      const q = await c.env.DB.prepare(
        `SELECT r.*, u.display_name as employee_name, u.employee_id,
                d.display_name as decided_by_name,
                e.name as roster_name
         FROM time_off_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users d ON d.id = r.decided_by_user_id
         LEFT JOIN employees e ON e.id = u.employee_id
         WHERE r.status = 'approved'
           AND r.request_type IN ('pto', 'sick')
           AND r.start_date <= ?
           AND r.end_date >= ?
         ORDER BY r.start_date ASC, r.id ASC`
      )
        .bind(to, from)
        .all();
      rows = (q.results || []) as Array<Record<string, unknown>>;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such column/i.test(msg)) {
        const q = await c.env.DB.prepare(
          `SELECT r.*, u.display_name as employee_name, u.employee_id,
                  d.display_name as decided_by_name,
                  e.name as roster_name
           FROM time_off_requests r
           JOIN users u ON u.id = r.user_id
           LEFT JOIN users d ON d.id = r.decided_by_user_id
           LEFT JOIN employees e ON e.id = u.employee_id
           WHERE r.status = 'approved'
             AND r.request_type IN ('pto', 'sick')
             AND r.start_date <= ?
             AND r.end_date >= ?
           ORDER BY r.start_date ASC, r.id ASC`
        )
          .bind(to, from)
          .all();
        rows = (q.results || []) as Array<Record<string, unknown>>;
      } else {
        throw e;
      }
    }

    const pending = rows.filter(
      (r) =>
        !r.usage_status ||
        r.usage_status === "pending_confirm" ||
        r.usage_status === null
    ).length;

    return c.json({
      from,
      to,
      pending_confirm: pending,
      items: rows.map((r) => {
        const start = String(r.start_date);
        const end = String(r.end_date);
        const type = String(r.request_type);
        const deducted =
          r.hours_deducted != null && Number.isFinite(Number(r.hours_deducted))
            ? Number(r.hours_deducted)
            : hoursForDateRange(start, end, 8);
        return {
          id: Number(r.id),
          employee_name: String(r.roster_name || r.employee_name || "Employee"),
          employee_id: r.employee_id != null ? Number(r.employee_id) : null,
          user_id: Number(r.user_id),
          request_type: type,
          type_label: timeOffTypeLabel(type),
          start_date: start,
          end_date: end,
          hours_deducted: deducted,
          hours_actual:
            r.hours_actual != null && Number.isFinite(Number(r.hours_actual))
              ? Number(r.hours_actual)
              : null,
          usage_status: (r.usage_status as string) || "pending_confirm",
          usage_note: (r.usage_note as string) || null,
          usage_confirmed_at: (r.usage_confirmed_at as string) || null,
          decided_by_name: (r.decided_by_name as string) || null,
          reason: (r.reason as string) || null,
          bank_linked: r.employee_id != null && Number(r.employee_id) > 0,
        };
      }),
    });
  }
);

/**
 * Payroll confirm: taken (no change) / partial (credit difference) / not_taken (full restore).
 */
api.post(
  "/time-off/:id/confirm-usage",
  requireRoles(["admin", "office"] as Role[]),
  async (c) => {
    const me = c.get("user");
    await ensureTimeOffTables(c.env.DB);
    await ensurePtoTables(c.env.DB);
    const id = Number(c.req.param("id"));
    const body = await c.req.json<{
      action?: "taken" | "partial" | "not_taken";
      hours_actual?: number | null;
      note?: string | null;
    }>();
    const action = body.action;
    if (action !== "taken" && action !== "partial" && action !== "not_taken") {
      return c.json({ error: "action must be taken, partial, or not_taken" }, 400);
    }
    const note = (body.note || "").trim();

    const before = await c.env.DB.prepare(`SELECT * FROM time_off_requests WHERE id = ?`)
      .bind(id)
      .first<{
        id: number;
        user_id: number;
        status: string;
        request_type: string;
        start_date: string;
        end_date: string;
        hours_deducted: number | null;
        hours_actual: number | null;
        usage_status: string | null;
      }>();
    if (!before) return c.json({ error: "Not found" }, 404);
    if (before.status !== "approved") {
      return c.json({ error: "Only approved requests can be confirmed for payroll" }, 400);
    }
    if (before.request_type !== "pto" && before.request_type !== "sick") {
      return c.json({ error: "Only PTO and sick affect banks" }, 400);
    }

    const kind: PtoKind = before.request_type === "sick" ? "sick" : "vacation";
    const deducted =
      before.hours_deducted != null && Number.isFinite(Number(before.hours_deducted))
        ? Number(before.hours_deducted)
        : hoursForDateRange(before.start_date, before.end_date, 8);

    const urow = await c.env.DB.prepare(`SELECT employee_id FROM users WHERE id = ?`)
      .bind(before.user_id)
      .first<{ employee_id: number | null }>();
    const empId = urow?.employee_id ? Number(urow.employee_id) : null;

    let hoursActual = deducted;
    let creditBack = 0;
    let nextStatus: string = action === "taken" ? "taken" : action === "partial" ? "partial" : "not_taken";

    if (action === "taken") {
      hoursActual = deducted;
      creditBack = 0;
    } else if (action === "not_taken") {
      hoursActual = 0;
      creditBack = deducted;
      if (!note) {
        return c.json({ error: "Add a short note when restoring (they came in)" }, 400);
      }
    } else {
      const actual = Number(body.hours_actual);
      if (!Number.isFinite(actual) || actual < 0 || actual > deducted) {
        return c.json(
          { error: `hours_actual must be between 0 and ${deducted} (hours already deducted)` },
          400
        );
      }
      if (actual === deducted) {
        nextStatus = "taken";
        hoursActual = deducted;
        creditBack = 0;
      } else if (actual === 0) {
        nextStatus = "not_taken";
        hoursActual = 0;
        creditBack = deducted;
      } else {
        hoursActual = actual;
        creditBack = deducted - actual;
      }
      if (creditBack > 0 && !note) {
        return c.json({ error: "Add a short note for partial / restore" }, 400);
      }
    }

    // Already confirmed with same outcome — idempotent
    if (
      before.usage_status === nextStatus &&
      before.hours_actual != null &&
      Number(before.hours_actual) === hoursActual
    ) {
      return c.json({ ok: true, unchanged: true });
    }

    // If previously confirmed with a different actual, only allow from pending/null
    // or re-confirm by adjusting credit relative to current hours_actual
    const prevActual =
      before.hours_actual != null && Number.isFinite(Number(before.hours_actual))
        ? Number(before.hours_actual)
        : before.usage_status === "taken" || before.usage_status === "partial" || before.usage_status === "not_taken"
          ? Number(before.hours_actual ?? deducted)
          : deducted;
    // Net credit needed now = (prev stuck hours) - (new stuck hours)
    // At first confirm from pending, prev stuck = deducted, so credit = deducted - hoursActual (= creditBack)
    const alreadyConfirmed =
      before.usage_status === "taken" ||
      before.usage_status === "partial" ||
      before.usage_status === "not_taken";
    const netCredit = alreadyConfirmed ? prevActual - hoursActual : creditBack;

    if (empId && netCredit !== 0) {
      let bal = await c.env.DB.prepare(`SELECT * FROM pto_balances WHERE employee_id = ?`)
        .bind(empId)
        .first<{
          vacation_entitlement_hours: number;
          vacation_used_hours: number;
          sick_entitlement_hours: number;
          sick_used_hours: number;
          last_anniversary_applied: string | null;
        }>();
      if (!bal) {
        await c.env.DB.prepare(
          `INSERT INTO pto_balances (employee_id, vacation_entitlement_hours, vacation_used_hours,
            sick_entitlement_hours, sick_used_hours, updated_at)
           VALUES (?, 0, 0, 0, 0, datetime('now'))`
        )
          .bind(empId)
          .run();
        bal = {
          vacation_entitlement_hours: 0,
          vacation_used_hours: 0,
          sick_entitlement_hours: 0,
          sick_used_hours: 0,
          last_anniversary_applied: null,
        };
      }
      // netCredit > 0 means restore (reduce used); < 0 means use more
      const deltaUsed = -netCredit;
      const vacUsed =
        Number(bal.vacation_used_hours) + (kind === "vacation" ? deltaUsed : 0);
      const sickUsed =
        Number(bal.sick_used_hours) + (kind === "sick" ? deltaUsed : 0);
      await c.env.DB.prepare(
        `UPDATE pto_balances SET
           vacation_used_hours = ?, sick_used_hours = ?, updated_at = datetime('now')
         WHERE employee_id = ?`
      )
        .bind(vacUsed, sickUsed, empId)
        .run();
      await writePtoLedger(c.env.DB, {
        employee_id: empId,
        entry_date: before.start_date,
        kind,
        hours: deltaUsed,
        source: "manual",
        time_off_request_id: id,
        note:
          note ||
          (nextStatus === "not_taken"
            ? "Payroll: came in — restored deducted hours"
            : nextStatus === "partial"
              ? `Payroll: partial — kept ${hoursActual}h of ${deducted}h`
              : "Payroll confirm"),
        created_by_user_id: me.id,
      });
    }

    await c.env.DB.prepare(
      `UPDATE time_off_requests SET
         usage_status = ?,
         hours_deducted = ?,
         hours_actual = ?,
         usage_confirmed_at = datetime('now'),
         usage_confirmed_by_user_id = ?,
         usage_note = ?,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(
        nextStatus,
        deducted,
        hoursActual,
        me.id,
        note || null,
        id
      )
      .run();

    await writeAudit(
      c.env.DB,
      me,
      "update",
      "time_off_request",
      id,
      `Payroll usage ${nextStatus} · ${hoursActual}h of ${deducted}h${note ? ` · ${note}` : ""}`
    );

    return c.json({
      ok: true,
      usage_status: nextStatus,
      hours_deducted: deducted,
      hours_actual: hoursActual,
      bank_adjusted: Boolean(empId && netCredit !== 0),
    });
  }
);

/**
 * One-time / safe re-import of hire dates, birthdays, and current banks from sheet snapshot.
 * Does not delete your Google Sheet. Idempotent per employee name match.
 */
api.post(
  "/time-off/import-sheet",
  requireRoles(["admin"] as Role[]),
  async (c) => {
    const me = c.get("user");
    await ensurePtoTables(c.env.DB);
    const body = await c.req.json<{
      rows?: Array<{
        name: string;
        hire_date?: string;
        birthday?: string;
        vacation_entitlement?: number;
        vacation_used?: number;
        sick_entitlement?: number;
        sick_used?: number;
      }>;
    }>();
    const rows = body.rows || [];
    if (!rows.length) return c.json({ error: "rows required" }, 400);

    const aliases: Record<string, string> = {
      "abelardo herrera": "abel herrera",
      "adam m bosquez": "adam bosquez",
      "arin r ramirez": "arin ramirez",
      "bianca m ramirez": "bianca ramirez",
      "charles dickerson": "chuck dickerson",
      "christopher e miller": "chris miller",
      "christopher r marroquin": "chris marroquin",
      "geovany montes": "geo montes",
      "humberto ortiz": "beto ortiz",
      "jaden de la garza": "jaden delagarza",
      "jared lurch esquivel": "lurch esquivel",
      "john j alvarado": "john alvarado",
      "justin d lyles": "justin lyles",
      "kai g woodruff": "kai woodruff",
      "kelsie m gomez": "kelsie gomez",
      "kenneth marroquin jr": "speedy marroquin",
      "kirk crumbly": "kirk crumbley",
      "marcus t tovar": "marcus tovar",
      "michael casarez": "mike casarez",
      "nathaniel torres": "nate torres",
      "omar j camacho": "omar camacho",
      "roberto f gonzalez": "robert gonzalez",
      "warren t engle": "warren engle",
    };
    const normPerson = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\b[a-z]\b/g, " ") // drop middle initials
        .replace(/\s+/g, " ")
        .trim();

    const allEmps = await c.env.DB.prepare(
      `SELECT id, name FROM employees WHERE active = 1`
    ).all<{ id: number; name: string }>();
    const byNorm = new Map<string, { id: number; name: string }[]>();
    for (const e of allEmps.results || []) {
      const k = normPerson(e.name);
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k)!.push(e);
    }

    let updated = 0;
    let skipped = 0;
    const unmatched: string[] = [];
    for (const r of rows) {
      const name = String(r.name || "").trim();
      if (!name) continue;
      const alias = aliases[name.toLowerCase()] || aliases[normPerson(name)];
      const want = normPerson(alias || name);
      let hits = byNorm.get(want) || [];
      if (!hits.length) {
        // last-name + first-token match
        const parts = want.split(" ").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        const first = parts[0] || "";
        hits = (allEmps.results || []).filter((e) => {
          const p = normPerson(e.name).split(" ");
          return p[0] === first && p[p.length - 1] === last;
        });
      }
      if (hits.length === 1) {
        await applyImportRow(c.env.DB, hits[0].id, r, me.id);
        updated += 1;
      } else {
        unmatched.push(name);
        skipped += 1;
      }
    }
    await writeAudit(
      c.env.DB,
      me,
      "update",
      "pto_balance",
      null,
      `PTO sheet import · ${updated} updated · ${skipped} unmatched`
    );
    return c.json({ ok: true, updated, skipped, unmatched });
  }
);

/**
 * Import Time Off Log rows into pto_ledger for Print report history.
 * Does NOT change balances (Employees sheet / board remains source of truth for banks).
 * Idempotent: replaces prior "Sheet log · …" import rows.
 */
api.post(
  "/time-off/import-log",
  requireRoles(["admin"] as Role[]),
  async (c) => {
    const me = c.get("user");
    await ensurePtoTables(c.env.DB);
    const body = await c.req.json<{
      rows?: Array<{
        date_used: string;
        name: string;
        vacation_used?: number;
        sick_used?: number;
        approved_by?: string;
        notes?: string;
      }>;
      replace?: boolean;
    }>();
    const rows = body.rows || [];
    if (!rows.length) return c.json({ error: "rows required" }, 400);

    const aliases: Record<string, string> = {
      "abelardo herrera": "abel herrera",
      "adam m bosquez": "adam bosquez",
      "arin r ramirez": "arin ramirez",
      "bianca m ramirez": "bianca ramirez",
      "charles dickerson": "chuck dickerson",
      "christopher e miller": "chris miller",
      "christopher r marroquin": "chris marroquin",
      "geovany montes": "geo montes",
      "humberto ortiz": "beto ortiz",
      "jaden de la garza": "jaden delagarza",
      "jared lurch esquivel": "lurch esquivel",
      "john j alvarado": "john alvarado",
      "justin d lyles": "justin lyles",
      "kai g woodruff": "kai woodruff",
      "kelsie m gomez": "kelsie gomez",
      "kenneth marroquin jr": "speedy marroquin",
      "kirk crumbly": "kirk crumbley",
      "marcus t tovar": "marcus tovar",
      "michael casarez": "mike casarez",
      "nathaniel torres": "nate torres",
      "omar j camacho": "omar camacho",
      "roberto f gonzalez": "robert gonzalez",
      "warren t engle": "warren engle",
    };
    const normPerson = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\b[a-z]\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const allEmps = await c.env.DB.prepare(
      `SELECT id, name FROM employees WHERE active = 1`
    ).all<{ id: number; name: string }>();
    const byNorm = new Map<string, { id: number; name: string }[]>();
    for (const e of allEmps.results || []) {
      const k = normPerson(e.name);
      if (!byNorm.has(k)) byNorm.set(k, []);
      byNorm.get(k)!.push(e);
    }

    const matchEmp = (name: string): { id: number; name: string } | null => {
      const alias = aliases[name.toLowerCase()] || aliases[normPerson(name)];
      const want = normPerson(alias || name);
      let hits = byNorm.get(want) || [];
      if (!hits.length) {
        const parts = want.split(" ").filter(Boolean);
        const last = parts[parts.length - 1] || "";
        const first = parts[0] || "";
        hits = (allEmps.results || []).filter((e) => {
          const p = normPerson(e.name).split(" ");
          return p[0] === first && p[p.length - 1] === last;
        });
      }
      return hits.length === 1 ? hits[0] : null;
    };

    if (body.replace !== false) {
      await c.env.DB.prepare(
        `DELETE FROM pto_ledger WHERE source = 'import' AND note LIKE 'Sheet log%'`
      ).run();
    }

    let inserted = 0;
    let skipped = 0;
    const unmatched: string[] = [];
    const unmatchedSeen = new Set<string>();

    for (const r of rows) {
      const name = String(r.name || "").trim();
      if (!name) continue;
      const emp = matchEmp(name);
      if (!emp) {
        if (!unmatchedSeen.has(name)) {
          unmatchedSeen.add(name);
          unmatched.push(name);
        }
        skipped += 1;
        continue;
      }
      let iso = parseFlexibleDate(r.date_used);
      if (!iso) {
        const bare = String(r.date_used || "").trim().match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
        if (bare) {
          iso = `2026-${String(Number(bare[1])).padStart(2, "0")}-${String(Number(bare[2])).padStart(2, "0")}`;
        }
      }
      if (!iso) {
        skipped += 1;
        continue;
      }
      const vac = Number(r.vacation_used || 0);
      const sick = Number(r.sick_used || 0);
      const noteBase = [
        "Sheet log",
        (r.notes || "").trim() || "usage",
        (r.approved_by || "").trim() ? `by ${(r.approved_by || "").trim()}` : "",
      ]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 240);
      if (Number.isFinite(vac) && vac !== 0) {
        await writePtoLedger(c.env.DB, {
          employee_id: emp.id,
          entry_date: iso,
          kind: "vacation",
          hours: vac,
          source: "import",
          note: noteBase,
          created_by_user_id: me.id,
        });
        inserted += 1;
      }
      if (Number.isFinite(sick) && sick !== 0) {
        await writePtoLedger(c.env.DB, {
          employee_id: emp.id,
          entry_date: iso,
          kind: "sick",
          hours: sick,
          source: "import",
          note: noteBase,
          created_by_user_id: me.id,
        });
        inserted += 1;
      }
    }

    await writeAudit(
      c.env.DB,
      me,
      "update",
      "pto_ledger",
      null,
      `PTO log import · ${inserted} ledger rows · ${skipped} skipped · unmatched ${unmatched.length}`
    );
    return c.json({ ok: true, inserted, skipped, unmatched });
  }
);

async function applyImportRow(
  db: D1Database,
  employeeId: number,
  r: {
    hire_date?: string;
    birthday?: string;
    vacation_entitlement?: number;
    vacation_used?: number;
    sick_entitlement?: number;
    sick_used?: number;
  },
  byUserId: number
): Promise<void> {
  const hire = parseFlexibleDate(r.hire_date);
  const bday = normalizeBirthdayMd(r.birthday);
  if (hire || bday) {
    await db
      .prepare(
        `UPDATE employees SET
           hire_date = COALESCE(?, hire_date),
           birthday_md = COALESCE(?, birthday_md),
           updated_at = datetime('now')
         WHERE id = ?`
      )
      .bind(hire, bday, employeeId)
      .run();
  }
  const vacEnt = Number(r.vacation_entitlement ?? 0) || 0;
  const vacUsed = Number(r.vacation_used ?? 0) || 0;
  const sickEnt = Number(r.sick_entitlement ?? 0) || 0;
  const sickUsed = Number(r.sick_used ?? 0) || 0;
  const asOf = ptoLocalIsoDate();
  const emp = await db
    .prepare(`SELECT hire_date FROM employees WHERE id = ?`)
    .bind(employeeId)
    .first<{ hire_date: string | null }>();
  const lastAnn =
    emp?.hire_date && completedYearsOfService(emp.hire_date, asOf) >= 1
      ? lastAnniversary(emp.hire_date, asOf)
      : null;
  await db
    .prepare(
      `INSERT INTO pto_balances (
         employee_id, vacation_entitlement_hours, vacation_used_hours,
         sick_entitlement_hours, sick_used_hours, last_anniversary_applied, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(employee_id) DO UPDATE SET
         vacation_entitlement_hours = excluded.vacation_entitlement_hours,
         vacation_used_hours = excluded.vacation_used_hours,
         sick_entitlement_hours = excluded.sick_entitlement_hours,
         sick_used_hours = excluded.sick_used_hours,
         last_anniversary_applied = COALESCE(excluded.last_anniversary_applied, pto_balances.last_anniversary_applied),
         updated_at = datetime('now')`
    )
    .bind(employeeId, vacEnt, vacUsed, sickEnt, sickUsed, lastAnn)
    .run();
  // Balances only — usage history comes from /time-off/import-log (Time Off Log sheet).
  void byUserId;
}

api.post("/time-off/:id/cancel", async (c) => {
  const user = c.get("user");
  await ensureTimeOffTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare(`SELECT * FROM time_off_requests WHERE id = ?`)
    .bind(id)
    .first<{ id: number; user_id: number; status: string; manager_user_id: number | null }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status !== "pending") {
    return c.json({ error: "Only pending requests can be cancelled" }, 400);
  }
  const isOwner = before.user_id === user.id;
  const isAdmin = user.role === "admin" || user.role === "office" || user.role === "supervisor";
  if (!isOwner && !isAdmin) {
    return c.json({ error: "Only you (or office/admin) can cancel this request" }, 403);
  }

  await c.env.DB.prepare(
    `UPDATE time_off_requests SET
       status = 'cancelled',
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(id)
    .run();

  if (before.manager_user_id && before.manager_user_id !== user.id) {
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        [before.manager_user_id],
        "time_off_request",
        `Time off cancelled · ${user.display_name}`,
        "Employee withdrew a pending request",
        { type: "time_off", id }
      ).catch(() => {
        /* ignore */
      })
    );
  }

  await writeAudit(c.env.DB, user, "update", "time_off_request", id, "Cancelled");
  return c.json({ ok: true });
});

// ——— Tool loan requests (employee → office only, company-use only) ———
// After approval: pending_order → ordered → arrived → paperwork_signed

/** Minimum weekly payroll deduction for tool loans (even if 10% of balance is less). */
const TOOL_LOAN_MIN_WEEKLY_PAYMENT = 50;

/** Part fulfillment after loan is approved (ends when signed loan paperwork is on file). */
type ToolLoanPartStatus =
  | "pending_order"
  | "ordered"
  | "arrived"
  | "paperwork_signed";

let toolLoanTablesReady = false;
async function ensureToolLoanTables(db: D1Database): Promise<void> {
  if (toolLoanTablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS tool_loan_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      manager_user_id INTEGER,
      item_name TEXT NOT NULL,
      item_url TEXT NOT NULL,
      amount REAL NOT NULL,
      weekly_pay REAL NOT NULL,
      purpose TEXT NOT NULL,
      disclaimer_accepted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending_office',
      manager_remarks TEXT,
      office_remarks TEXT,
      manager_decided_by_user_id INTEGER,
      manager_decided_at TEXT,
      office_decided_by_user_id INTEGER,
      office_decided_at TEXT,
      part_status TEXT,
      ordered_at TEXT,
      arrived_at TEXT,
      part_note TEXT,
      paperwork_signed_at TEXT,
      paperwork_note TEXT,
      paperwork_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_loan_user ON tool_loan_requests(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tool_loan_status ON tool_loan_requests(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tool_loan_manager ON tool_loan_requests(manager_user_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_tool_loan_part ON tool_loan_requests(part_status, status)`,
    // Legacy: manager step removed — open manager-queue items go to office
    `UPDATE tool_loan_requests SET status = 'pending_office', updated_at = datetime('now')
     WHERE status = 'pending_manager'`,
    // Fulfillment columns (existing DBs created before 047 / 065)
    `ALTER TABLE tool_loan_requests ADD COLUMN part_status TEXT`,
    `ALTER TABLE tool_loan_requests ADD COLUMN ordered_at TEXT`,
    `ALTER TABLE tool_loan_requests ADD COLUMN arrived_at TEXT`,
    `ALTER TABLE tool_loan_requests ADD COLUMN part_note TEXT`,
    `ALTER TABLE tool_loan_requests ADD COLUMN paperwork_signed_at TEXT`,
    `ALTER TABLE tool_loan_requests ADD COLUMN paperwork_note TEXT`,
    `ALTER TABLE tool_loan_requests ADD COLUMN paperwork_key TEXT`,
    // Approved loans with no part track yet start as "waiting to order"
    `UPDATE tool_loan_requests SET part_status = 'pending_order', updated_at = datetime('now')
     WHERE status = 'approved' AND (part_status IS NULL OR part_status = '')`,
    // Many requests can share one payroll charge (bundled low-amount purchases)
    `CREATE TABLE IF NOT EXISTS tool_loan_charge_links (
      charge_id INTEGER NOT NULL,
      request_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (charge_id, request_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_tool_loan_charge_links_request
      ON tool_loan_charge_links(request_id)`,
    `INSERT OR IGNORE INTO tool_loan_charge_links (charge_id, request_id)
      SELECT id, tool_loan_request_id FROM tool_loan_charges
      WHERE tool_loan_request_id IS NOT NULL AND IFNULL(voided, 0) = 0`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists / no-op */
    }
  }
  toolLoanTablesReady = true;
}

/** Link request(s) ↔ payroll charge (many requests may share one charge). */
async function linkRequestsToCharge(
  db: D1Database,
  chargeId: number,
  requestIds: number[]
): Promise<void> {
  const ids = [...new Set(requestIds.filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return;
  // Keep legacy single FK as the first/primary request if empty
  await db
    .prepare(
      `UPDATE tool_loan_charges
       SET tool_loan_request_id = COALESCE(tool_loan_request_id, ?)
       WHERE id = ? AND IFNULL(voided, 0) = 0`
    )
    .bind(ids[0], chargeId)
    .run();
  for (const rid of ids) {
    try {
      await db
        .prepare(
          `INSERT OR IGNORE INTO tool_loan_charge_links (charge_id, request_id)
           VALUES (?, ?)`
        )
        .bind(chargeId, rid)
        .run();
    } catch {
      /* ignore */
    }
  }
}

function isOfficeRole(role: string): boolean {
  return role === "admin" || role === "office" || role === "supervisor";
}

// Money ledger (charges / payments / payroll export) — office & admin
registerToolLoanLedger(api);

/**
 * Inline ledger GETs — self-contained so the owner report always works even if
 * the toolLoanLedger module path has issues on a given deploy.
 */
async function toolLoanBalanceRows(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT p.id as person_id, p.user_id, p.display_name, p.weekly_deduction, p.status, p.notes,
        COALESCE(ch.total_charged, 0) as total_charged,
        COALESCE(py.total_paid, 0) as total_paid
       FROM tool_loan_people p
       LEFT JOIN (
         SELECT person_id, SUM(amount) as total_charged
         FROM tool_loan_charges WHERE IFNULL(voided, 0) = 0 GROUP BY person_id
       ) ch ON ch.person_id = p.id
       LEFT JOIN (
         SELECT person_id, SUM(amount) as total_paid
         FROM tool_loan_payments WHERE IFNULL(voided, 0) = 0 GROUP BY person_id
       ) py ON py.person_id = p.id
       ORDER BY p.display_name`
    )
    .all<{
      person_id: number;
      user_id: number | null;
      display_name: string;
      weekly_deduction: number | null;
      status: string;
      notes: string | null;
      total_charged: number;
      total_paid: number;
    }>();
  return (rows.results || []).map((r) => {
    const charged = Number(r.total_charged) || 0;
    const paid = Number(r.total_paid) || 0;
    const balance = Math.round((charged - paid) * 100) / 100;
    const autoWeekly =
      balance > 0 ? Math.min(balance, Math.max(50, Math.round(balance * 0.1 * 100) / 100)) : 0;
    const weekly =
      r.weekly_deduction != null && r.weekly_deduction > 0
        ? Math.min(r.weekly_deduction, Math.max(balance, 0))
        : autoWeekly;
    return {
      person_id: r.person_id,
      user_id: r.user_id,
      display_name: r.display_name,
      weekly_deduction: r.weekly_deduction,
      status: r.status,
      notes: r.notes,
      total_charged: charged,
      total_paid: paid,
      balance,
      suggested_weekly: weekly,
      /** Amount to deduct this payroll week (for owner sheet) */
      weekly_this_week: Math.round(Math.min(weekly, Math.max(balance, 0)) * 100) / 100,
    };
  });
}

api.get("/tool-loan-ledger/health", async (c) => {
  const user = c.get("user");
  try {
    const people = await c.env.DB.prepare(`SELECT COUNT(*) as c FROM tool_loan_people`).first<{
      c: number;
    }>();
    const charges = await c.env.DB.prepare(`SELECT COUNT(*) as c FROM tool_loan_charges`).first<{
      c: number;
    }>();
    const payments = await c.env.DB.prepare(`SELECT COUNT(*) as c FROM tool_loan_payments`).first<{
      c: number;
    }>();
    return c.json({
      ok: true,
      role: user.role,
      people: people?.c ?? 0,
      charges: charges?.c ?? 0,
      payments: payments?.c ?? 0,
      t: Date.now(),
    });
  } catch (e) {
    return c.json({
      ok: false,
      role: user.role,
      error: e instanceof Error ? e.message : String(e),
      t: Date.now(),
    });
  }
});

/** Owner-ready report: same columns as the old Google Sheet summary, cleaner layout. */
api.get("/tool-loan-ledger/owner-report", async (c) => {
  const user = c.get("user");
  if (!isOfficeRole(user.role)) return c.json({ error: "Office or admin only" }, 403);
  try {
    const includeZero = c.req.query("include_zero") === "1";
    const weekOf = (c.req.query("week_of") || new Date().toISOString().slice(0, 10)).slice(0, 10);
    // Payroll sheet: only people who can be deducted this week (not former/left)
    let rows = (await toolLoanBalanceRows(c.env.DB)).filter((r) => r.status !== "former");
    if (!includeZero) rows = rows.filter((r) => r.balance > 0.009);
    const totalBalance = rows.reduce((s, r) => s + r.balance, 0);
    const totalWeekly = rows.reduce((s, r) => s + r.weekly_this_week, 0);
    return c.json({
      company: "Total Assurance A/C & Heating",
      title: "Tool Loan Payroll Deduction Report",
      week_of: weekOf,
      generated_at: new Date().toISOString(),
      prepared_by: user.display_name,
      columns: ["Employee Name", "Amount Owed", "Weekly Deduction"],
      lines: rows.map((r) => ({
        person_id: r.person_id,
        employee_name: r.display_name,
        total_loan_amount: r.total_charged,
        total_amount_paid: r.total_paid,
        remaining_balance: r.balance,
        weekly_deduction: r.weekly_this_week,
        status: r.status,
      })),
      totals: {
        total_loan_amount: 0,
        total_amount_paid: 0,
        remaining_balance: Math.round(totalBalance * 100) / 100,
        weekly_deduction: Math.round(totalWeekly * 100) / 100,
        employee_count: rows.length,
      },
      policy_note:
        "Weekly deduction = 10% of remaining balance, minimum $50 (e.g. $600 → $60/week). Former employees excluded (balances remain on file).",
    });
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "Owner report failed" },
      500
    );
  }
});

/** Alias used by the ledger UI (same data as owner-report + full people list). */
api.get("/tool-loan-ledger/summary", async (c) => {
  const user = c.get("user");
  if (!isOfficeRole(user.role)) return c.json({ error: "Office or admin only" }, 403);
  try {
    const includeZero = c.req.query("include_zero") === "1";
    // Always treat week_of as the pay Friday (snap mid-week dates forward)
    const weekOfRaw = (c.req.query("week_of") || "").slice(0, 10);
    const weekOf = weekOfRaw ? toPayFriday(weekOfRaw) : toPayFriday();
    // Mon–Fri window so a Wed apply still counts for this Friday's paycheck
    const [wy, wm, wd] = weekOf.split("-").map(Number);
    const weekMonDate = new Date(wy, wm - 1, wd - 4, 12, 0, 0, 0);
    const weekMon = `${weekMonDate.getFullYear()}-${String(weekMonDate.getMonth() + 1).padStart(2, "0")}-${String(weekMonDate.getDate()).padStart(2, "0")}`;

    let rows = await toolLoanBalanceRows(c.env.DB);
    const all = rows;
    if (!includeZero) rows = rows.filter((r) => Math.abs(r.balance) > 0.009);
    const open = all.filter((r) => r.balance > 0.009);
    const totalOwed = open.reduce((s, r) => s + r.balance, 0);

    // Last bulk / payroll deduction run (by pay Friday date)
    const lastRun = await c.env.DB.prepare(
      `SELECT payment_date,
              MAX(created_at) as applied_at,
              COUNT(*) as employee_count,
              ROUND(SUM(amount), 2) as total_amount
       FROM tool_loan_payments
       WHERE payment_type = 'payroll'
         AND IFNULL(voided, 0) = 0
         AND (
           note LIKE 'Payroll week of %'
           OR note LIKE 'Payroll deduction for Friday %'
           OR note LIKE 'Weekly payroll%'
         )
       GROUP BY payment_date
       ORDER BY payment_date DESC
       LIMIT 1`
    ).first<{
      payment_date: string;
      applied_at: string;
      employee_count: number;
      total_amount: number;
    }>();

    // Fallback: any latest payroll payments grouped by date
    const lastRunFallback =
      lastRun ||
      (await c.env.DB.prepare(
        `SELECT payment_date,
                MAX(created_at) as applied_at,
                COUNT(*) as employee_count,
                ROUND(SUM(amount), 2) as total_amount
         FROM tool_loan_payments
         WHERE payment_type = 'payroll' AND IFNULL(voided, 0) = 0
         GROUP BY payment_date
         ORDER BY payment_date DESC
         LIMIT 1`
      ).first<{
        payment_date: string;
        applied_at: string;
        employee_count: number;
        total_amount: number;
      }>());

    // Per-person last payroll payment date
    const lastByPerson = await c.env.DB.prepare(
      `SELECT person_id,
              MAX(payment_date) as last_payroll_date,
              MAX(created_at) as last_payroll_at
       FROM tool_loan_payments
       WHERE payment_type = 'payroll' AND IFNULL(voided, 0) = 0
       GROUP BY person_id`
    ).all<{
      person_id: number;
      last_payroll_date: string;
      last_payroll_at: string;
    }>();
    const lastMap = new Map(
      (lastByPerson.results || []).map((r) => [
        r.person_id,
        {
          last_payroll_date: r.last_payroll_date,
          last_payroll_at: r.last_payroll_at,
        },
      ])
    );

    // Who already has a payroll payment this pay week (Mon → Friday paycheck)
    const alreadyForWeek = new Map<number, { amount: number; applied_at: string }>();
    let weekAlreadyCount = 0;
    let weekAlreadyTotal = 0;
    const weekPays = await c.env.DB.prepare(
      `SELECT person_id,
              ROUND(SUM(amount), 2) as amount,
              MAX(created_at) as applied_at
       FROM tool_loan_payments
       WHERE payment_type = 'payroll'
         AND IFNULL(voided, 0) = 0
         AND payment_date >= ?
         AND payment_date <= ?
       GROUP BY person_id`
    )
      .bind(weekMon, weekOf)
      .all<{ person_id: number; amount: number; applied_at: string }>();
    for (const r of weekPays.results || []) {
      alreadyForWeek.set(r.person_id, {
        amount: Number(r.amount) || 0,
        applied_at: r.applied_at,
      });
      weekAlreadyCount += 1;
      weekAlreadyTotal += Number(r.amount) || 0;
    }

    const people = rows.map((r) => {
      const last = lastMap.get(r.person_id);
      const weekPay = alreadyForWeek.get(r.person_id);
      return {
        ...r,
        last_payroll_date: last?.last_payroll_date ?? null,
        last_payroll_at: last?.last_payroll_at ?? null,
        already_deducted_for_week: Boolean(weekPay),
        week_deducted_amount: weekPay?.amount ?? null,
        week_deducted_at: weekPay?.applied_at ?? null,
      };
    });

    return c.json({
      people,
      open_count: open.length,
      total_owed: Math.round(totalOwed * 100) / 100,
      last_payroll_run: lastRunFallback
        ? {
            payment_date: String(lastRunFallback.payment_date).slice(0, 10),
            applied_at: lastRunFallback.applied_at,
            employee_count: Number(lastRunFallback.employee_count) || 0,
            total_amount: Number(lastRunFallback.total_amount) || 0,
          }
        : null,
      selected_week: {
        payment_date: weekOf,
        already_applied: weekAlreadyCount > 0,
        employee_count: weekAlreadyCount,
        total_amount: Math.round(weekAlreadyTotal * 100) / 100,
      },
    });
  } catch (e) {
    return c.json(
      { error: `Ledger summary failed: ${e instanceof Error ? e.message : String(e)}` },
      500
    );
  }
});

api.get("/tool-loan-ledger/payroll-week", async (c) => {
  const user = c.get("user");
  if (!isOfficeRole(user.role)) return c.json({ error: "Office or admin only" }, 403);
  try {
    const weekOf = (c.req.query("week_of") || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const rows = (await toolLoanBalanceRows(c.env.DB)).filter(
      (r) => r.status !== "former" && r.balance > 0.009
    );
    const lines = rows.map((r) => ({
      person_id: r.person_id,
      display_name: r.display_name,
      status: r.status,
      balance: r.balance,
      total_charged: r.total_charged,
      total_paid: r.total_paid,
      weekly_deduction: r.weekly_this_week,
      weekly_deduction_setting: r.weekly_deduction,
    }));
    const totalDeduct = lines.reduce((s, l) => s + l.weekly_deduction, 0);
    return c.json({
      week_of: weekOf,
      lines,
      total_deduction: Math.round(totalDeduct * 100) / 100,
      count: lines.length,
    });
  } catch (e) {
    return c.json(
      { error: `Payroll sheet failed: ${e instanceof Error ? e.message : String(e)}` },
      500
    );
  }
});

/**
 * Server-rendered HTML for owner print — does not depend on React state.
 * Open in a new tab; cookies are sent same-origin so auth works.
 */
api.get("/tool-loan-ledger/owner-report-print", async (c) => {
  const user = c.get("user");
  if (!isOfficeRole(user.role)) {
    return c.html(
      `<!DOCTYPE html><html><body><p>Office or admin only.</p></body></html>`,
      403
    );
  }
  try {
    const includeZero = c.req.query("include_zero") === "1";
    const weekOf = (c.req.query("week_of") || new Date().toISOString().slice(0, 10)).slice(0, 10);
    // Payroll print: current employees only (hide former — e.g. Willie, Valdez)
    let rows = (await toolLoanBalanceRows(c.env.DB)).filter((r) => r.status !== "former");
    if (!includeZero) rows = rows.filter((r) => r.balance > 0.009);

    const money = (n: number) =>
      n.toLocaleString("en-US", { style: "currency", currency: "USD" });
    const esc = (s: string) =>
      s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

    const totalBal = rows.reduce((s, r) => s + r.balance, 0);
    const totalWeek = rows.reduce((s, r) => s + r.weekly_this_week, 0);

    const weekLabel = (() => {
      try {
        return new Date(weekOf + "T12:00:00").toLocaleDateString("en-US", {
          weekday: "short",
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      } catch {
        return weekOf;
      }
    })();

    // Preferred full wordmark for white / print backgrounds
    const origin = new URL(c.req.url).origin;
    const logoUrl = `${origin}/logo-print.jpg`;

    const bodyRows =
      rows.length === 0
        ? `<tr><td colspan="3" style="text-align:center;padding:28px;color:#64748b">No open balances for current employees.</td></tr>`
        : rows
            .map(
              (r, i) => `<tr class="${i % 2 === 0 ? "row-even" : "row-odd"}">
        <td class="name">${esc(r.display_name)}</td>
        <td class="num owed"><strong>${money(r.balance)}</strong></td>
        <td class="num weekly"><strong>${money(r.weekly_this_week)}</strong></td>
      </tr>`
            )
            .join("");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tool Loan Payroll — ${esc(weekOf)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #0f172a;
      margin: 0.5in 0.55in;
      font-size: 13px;
      line-height: 1.4;
      background: #fff;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1.25rem;
      padding-bottom: 0.95rem;
      margin-bottom: 1rem;
      border-bottom: 3px solid #0c1f4a;
    }
    .brand { min-width: 0; flex: 1; }
    .logo {
      height: 58px;
      width: auto;
      max-width: min(340px, 100%);
      object-fit: contain;
      display: block;
      margin-bottom: 0.45rem;
    }
    .brand .sub {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: #0c1f4a;
      letter-spacing: -0.01em;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem 1.25rem;
      font-size: 11px;
      text-align: right;
      flex-shrink: 0;
    }
    .meta div { display: flex; flex-direction: column; gap: 2px; min-width: 5.5rem; }
    .meta span {
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: #64748b;
      font-size: 9px;
      font-weight: 700;
    }
    .meta strong { font-size: 12px; color: #0f172a; font-weight: 600; }
    .summary-bar {
      display: flex;
      gap: 0.75rem;
      margin: 0 0 0.9rem;
    }
    .summary-bar .box {
      flex: 1;
      border: 1px solid #d5dee8;
      border-radius: 8px;
      padding: 0.7rem 0.9rem;
      background: #f8fafc;
    }
    .summary-bar .box.accent {
      background: #fff5f5;
      border-color: #f5c2c2;
    }
    .summary-bar .label {
      display: block;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #64748b;
      margin-bottom: 0.15rem;
    }
    .summary-bar .value {
      font-size: 1.3rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #0c1f4a;
    }
    .summary-bar .accent .value { color: #b91c1c; }
    .note {
      color: #64748b;
      font-size: 11px;
      margin: 0 0 12px;
      line-height: 1.45;
    }
    /* Clear grid lines so payroll can check off each person safely */
    table {
      width: 100%;
      border-collapse: collapse;
      border: 2px solid #0c1f4a;
    }
    th {
      text-align: left;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #0c1f4a;
      border: 1px solid #0c1f4a;
      padding: 10px 10px;
      background: #e8eef6;
    }
    th.num { text-align: right; }
    td {
      padding: 12px 10px;
      border: 1px solid #94a3b8;
      vertical-align: middle;
    }
    tr.row-even td { background: #ffffff; }
    tr.row-odd td { background: #f1f5f9; }
    td.name { font-weight: 700; font-size: 13.5px; }
    .num {
      text-align: right;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      font-size: 13.5px;
    }
    .owed { color: #0f172a; }
    .weekly {
      background: #fff1f1 !important;
      color: #991b1b;
    }
    tfoot td {
      border: 2px solid #0c1f4a;
      font-weight: 800;
      padding: 12px 10px;
      background: #e8eef6 !important;
      font-size: 13.5px;
    }
    .foot {
      margin-top: 16px;
      padding-top: 10px;
      border-top: 1px solid #cbd5e1;
      font-size: 10px;
      color: #64748b;
    }
    .noprint { margin: 0 0 14px; }
    .noprint button {
      font: inherit;
      padding: 10px 16px;
      border-radius: 999px;
      border: none;
      background: #0c1f4a;
      color: #fff;
      cursor: pointer;
      font-weight: 700;
    }
    @media print {
      .noprint { display: none !important; }
      body { margin: 0.4in 0.45in; }
      table, th, td, tr.row-odd td, tr.row-even td, .weekly, .summary-bar .box, thead th, tfoot td {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }
    }
    @page { margin: 0.4in; size: letter; }
  </style>
</head>
<body>
  <div class="noprint"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <div class="head">
    <div class="brand">
      <img class="logo" src="${esc(logoUrl)}" alt="Total Assurance A/C &amp; Heating"
        onerror="this.onerror=null;this.src='${esc(origin)}/logo-light.png'" />
      <p class="sub">Tool Loan Payroll Deduction Report</p>
    </div>
    <div class="meta">
      <div><span>Week of</span><strong>${esc(weekLabel)}</strong></div>
      <div><span>Prepared</span><strong>${esc(new Date().toLocaleString())}</strong></div>
      <div><span>By</span><strong>${esc(user.display_name || "Office")}</strong></div>
    </div>
  </div>
  <div class="summary-bar">
    <div class="box">
      <span class="label">Employees</span>
      <span class="value">${rows.length}</span>
    </div>
    <div class="box">
      <span class="label">Total amount owed</span>
      <span class="value">${money(totalBal)}</span>
    </div>
    <div class="box accent">
      <span class="label">Total this week&apos;s deduction</span>
      <span class="value">${money(totalWeek)}</span>
    </div>
  </div>
  <p class="note">Use each row for one person only — lines separate employees so deductions are not mixed. Amount owed is remaining balance; weekly deduction is what to take this paycheck (10% of balance, min $50).</p>
  <table>
    <thead>
      <tr>
        <th>Employee Name</th>
        <th class="num">Amount Owed</th>
        <th class="num">Weekly Deduction</th>
      </tr>
    </thead>
    <tbody>${bodyRows}</tbody>
    <tfoot>
      <tr>
        <td>Totals (${rows.length})</td>
        <td class="num">${money(totalBal)}</td>
        <td class="num weekly">${money(totalWeek)}</td>
      </tr>
    </tfoot>
  </table>
  <p class="foot">Confidential — for payroll use only · Total Assurance A/C &amp; Heating · Week of ${esc(weekOf)}</p>
  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.focus(); window.print(); }, 450);
    });
  </script>
</body>
</html>`;
    return c.html(html);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.html(
      `<!DOCTYPE html><html><body><p>Report failed: ${msg.replace(/</g, "")}</p></body></html>`,
      500
    );
  }
});

api.get("/tool-loans/pending-count", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  try {
    if (!isOfficeRole(user.role)) {
      return c.json({ pending: 0 });
    }
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM tool_loan_requests
       WHERE status IN ('pending_office', 'pending_manager')`
    ).first<{ c: number }>();
    return c.json({ pending: row?.c ?? 0 });
  } catch {
    return c.json({ pending: 0 });
  }
});

/**
 * ?view=mine | approvals
 * approvals = office/admin queue + recent history
 */
api.get("/tool-loans", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  const view = (c.req.query("view") || "mine").toLowerCase();
  const isApprover = isOfficeRole(user.role);
  try {
    let sql = `SELECT r.*,
        u.display_name as employee_name,
        m.display_name as manager_name,
        md.display_name as manager_decided_by_name,
        od.display_name as office_decided_by_name
       FROM tool_loan_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users m ON m.id = r.manager_user_id
       LEFT JOIN users md ON md.id = r.manager_decided_by_user_id
       LEFT JOIN users od ON od.id = r.office_decided_by_user_id`;
    const binds: unknown[] = [];

    if (view === "approvals") {
      if (!isApprover) {
        return c.json({
          requests: [],
          pending_for_me: 0,
          is_approver: false,
          min_weekly_payment: TOOL_LOAN_MIN_WEEKLY_PAYMENT,
          repayment_percent: 10,
        });
      }
      // Open approvals + approved loans still tracking order/arrival/paperwork + recent closed
      sql += ` WHERE (
            r.status IN ('pending_office', 'pending_manager')
            OR (r.status = 'approved' AND COALESCE(r.part_status, 'pending_order') IN (
              'pending_order', 'ordered', 'arrived'
            ))
            OR (r.status IN ('approved', 'declined')
              AND date(COALESCE(r.office_decided_at, r.updated_at)) >= date('now', '-90 days'))
          )`;
      sql += ` ORDER BY
        CASE
          WHEN r.status IN ('pending_office', 'pending_manager') THEN 0
          WHEN r.status = 'approved' AND COALESCE(r.part_status, 'pending_order') = 'pending_order' THEN 1
          WHEN r.status = 'approved' AND r.part_status = 'ordered' THEN 2
          WHEN r.status = 'approved' AND r.part_status = 'arrived' THEN 3
          ELSE 4 END,
        r.created_at DESC LIMIT 150`;
    } else {
      sql += ` WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 80`;
      binds.push(user.id);
    }

    const rows = await c.env.DB.prepare(sql).bind(...binds).all();

    let pendingForMe = 0;
    if (isApprover) {
      const p = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM tool_loan_requests
         WHERE status IN ('pending_office', 'pending_manager')`
      ).first<{ c: number }>();
      pendingForMe = p?.c ?? 0;
    }

    // Employee-facing balance for accurate weekly estimate (policy formula only — never office override)
    let ledgerBalance = 0;
    let ledgerPersonName: string | null = null;
    if (view !== "approvals") {
      const bal = await ledgerBalanceForUserId(c.env.DB, user.id);
      ledgerBalance = Math.max(0, bal.balance);
      ledgerPersonName = bal.display_name;
    }

    return c.json({
      requests: rows.results || [],
      pending_for_me: pendingForMe,
      is_approver: isApprover,
      min_weekly_payment: TOOL_LOAN_MIN_WEEKLY_PAYMENT,
      repayment_percent: 10,
      current_balance: ledgerBalance,
      ledger_person_name: ledgerPersonName,
      // Who the app thinks you are (should match ledger name for correct balance)
      account_display_name: user.display_name,
      // Projected weekly if they add $0 more (existing balance only)
      current_weekly: policyWeeklyDeduction(ledgerBalance),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        requests: [],
        pending_for_me: 0,
        is_approver: false,
        min_weekly_payment: TOOL_LOAN_MIN_WEEKLY_PAYMENT,
        repayment_percent: 10,
        current_balance: 0,
        current_weekly: 0,
        ledger_person_name: null,
        account_display_name: null,
        error: "Run migration 046_tool_loan_requests.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/tool-loans", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  const body = await c.req.json<{
    item_name?: string;
    item_url?: string;
    amount?: number;
    purpose?: string;
    disclaimer_accepted?: boolean;
  }>();

  const itemName = (body.item_name || "").trim();
  const itemUrl = (body.item_url || "").trim();
  const purpose = (body.purpose || "").trim();
  const amount = Number(body.amount);

  if (!itemName || itemName.length < 2) {
    return c.json({ error: "Tool / part name is required" }, 400);
  }
  // item_url is optional free text (store name, partial link, full URL, or blank) — never require http(s)
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ error: "Enter a valid loan amount" }, 400);
  }
  if (!purpose || purpose.length < 2) {
    return c.json(
      {
        error:
          "Describe how this tool helps your company field work (required — loans are for job use only).",
      },
      400
    );
  }
  if (body.disclaimer_accepted !== true) {
    return c.json(
      {
        error:
          "You must accept the tool loan terms (10% of loan weekly, $50 minimum — e.g. $600 → $60/week; total loans ≤ weekly pay; company field tools only).",
      },
      400
    );
  }

  // manager_user_id kept for schema/history only — not used for approval routing
  let managerId: number | null = null;
  try {
    const me = await c.env.DB.prepare(`SELECT manager_user_id FROM users WHERE id = ?`)
      .bind(user.id)
      .first<{ manager_user_id: number | null }>();
    if (me?.manager_user_id) managerId = Number(me.manager_user_id);
  } catch {
    /* optional */
  }

  try {
    // weekly_pay column kept for schema compat; office already knows pay — not collected from employee
    const ins = await c.env.DB.prepare(
      `INSERT INTO tool_loan_requests (
         user_id, manager_user_id, item_name, item_url, amount, weekly_pay, purpose,
         disclaimer_accepted, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?, 1, 'pending_office', datetime('now'), datetime('now'))`
    )
      .bind(user.id, managerId, itemName, itemUrl || "", amount, purpose)
      .run();
    const id = Number(ins.meta.last_row_id);

    const office = await usersByRoles(c.env.DB, ["admin", "office", "supervisor"]);
    const notifyIds = office.filter((uid) => uid !== user.id);

    if (notifyIds.length) {
      scheduleWaitUntil(
        c,
        notifyUsers(
          c.env.DB,
          notifyIds,
          "tool_loan_request",
          `Tool loan request · ${user.display_name}`,
          `${itemName} · $${amount.toFixed(2)} — needs office approval`,
          { type: "tool_loan", id }
        ).catch(() => {
          /* non-fatal */
        })
      );
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "tool_loan_request",
      id,
      `${itemName} · $${amount.toFixed(2)}`
    );

    const row = await c.env.DB.prepare(
      `SELECT r.*, u.display_name as employee_name, m.display_name as manager_name
       FROM tool_loan_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users m ON m.id = r.manager_user_id
       WHERE r.id = ?`
    )
      .bind(id)
      .first();

    return c.json({
      ok: true,
      request: row,
      min_weekly_payment: TOOL_LOAN_MIN_WEEKLY_PAYMENT,
      repayment_percent: 10,
    }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * Office/admin decision only.
 * Body: decision = approved | declined, remarks?
 * pending_office (or legacy pending_manager) → approved | declined
 */
api.post("/tool-loans/:id/decide", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    decision?: "approved" | "declined";
    remarks?: string | null;
  }>();
  const decision = body.decision;
  if (decision !== "approved" && decision !== "declined") {
    return c.json({ error: "decision must be approved or declined" }, 400);
  }
  const remarks = (body.remarks || "").trim() || null;

  if (!isOfficeRole(user.role)) {
    return c.json({ error: "Only office or admin can approve tool loan requests" }, 403);
  }

  const before = await c.env.DB.prepare(`SELECT * FROM tool_loan_requests WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      manager_user_id: number | null;
      status: string;
      item_name: string;
      amount: number;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  if (before.status === "approved" || before.status === "declined" || before.status === "cancelled") {
    return c.json({ error: "This request is already closed" }, 400);
  }

  // Accept legacy pending_manager as office queue
  if (before.status !== "pending_office" && before.status !== "pending_manager") {
    return c.json({ error: "This request cannot be decided in its current status" }, 400);
  }

  const nextStatus = decision === "approved" ? "approved" : "declined";
  if (nextStatus === "approved") {
    await c.env.DB.prepare(
      `UPDATE tool_loan_requests SET
         status = 'approved',
         office_remarks = ?,
         office_decided_by_user_id = ?,
         office_decided_at = datetime('now'),
         part_status = 'pending_order',
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(remarks, user.id, id)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE tool_loan_requests SET
         status = 'declined',
         office_remarks = ?,
         office_decided_by_user_id = ?,
         office_decided_at = datetime('now'),
         part_status = NULL,
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(remarks, user.id, id)
      .run();
  }

  const decisionLabel = nextStatus === "approved" ? "Approved" : "Declined";
  const decisionBody =
    nextStatus === "approved"
      ? `$${Number(before.amount).toFixed(2)} · Loan approved — we'll order the part next${
          remarks ? ` · ${remarks}` : ""
        }`
      : `$${Number(before.amount).toFixed(2)}${
          remarks ? ` · Remarks: ${remarks}` : ` · by ${user.display_name}`
        }`;
  scheduleWaitUntil(
    c,
    notifyAndSms(c.env, c.env.DB, [before.user_id], {
      kind: "tool_loan_decision",
      title: `Tool loan ${decisionLabel.toLowerCase()} · ${before.item_name}`,
      body: decisionBody,
      entity: { type: "tool_loan", id },
      sms: shortSms(
        `TA: Your tool loan for ${before.item_name} was ${decisionLabel.toLowerCase()}${
          remarks ? ` · ${remarks.slice(0, 80)}` : ""
        }.`
      ),
      fromUserId: user.id,
      smsContext: `tool_loan_decision:${id}:${nextStatus}`,
    }).catch(() => {
      /* ignore */
    })
  );

  await writeAudit(
    c.env.DB,
    user,
    "update",
    "tool_loan_request",
    id,
    `${nextStatus} · ${before.item_name}`
  );

  const row = await c.env.DB.prepare(
    `SELECT r.*, u.display_name as employee_name, m.display_name as manager_name
     FROM tool_loan_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN users m ON m.id = r.manager_user_id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  return c.json({ ok: true, request: row });
});

/** Default sales tax for new tool loan charges (Texas-style; office can override in UI). */
const TOOL_LOAN_DEFAULT_TAX_RATE = 8.25;

/**
 * Office: match a tool loan request's employee to *recent* payroll ledger loans only.
 * Used when marking paperwork signed so office can link the correct charge (or create one + tax).
 */
api.get("/tool-loans/:id/ledger-match", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  if (!isOfficeRole(user.role)) {
    return c.json({ error: "Only office or admin can view ledger match" }, 403);
  }
  const id = Number(c.req.param("id"));
  if (!id) return c.json({ error: "Invalid id" }, 400);

  const req = await c.env.DB.prepare(
    `SELECT r.id, r.user_id, r.item_name, r.amount, r.purpose, r.status, r.part_status,
            r.created_at, r.arrived_at, u.display_name as employee_name
     FROM tool_loan_requests r
     JOIN users u ON u.id = r.user_id
     WHERE r.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      item_name: string;
      amount: number;
      purpose: string;
      status: string;
      part_status: string | null;
      created_at: string;
      arrived_at: string | null;
      employee_name: string;
    }>();
  if (!req) return c.json({ error: "Not found" }, 404);

  const bal = await ledgerBalanceForUserId(c.env.DB, req.user_id);
  const target = Math.round(Number(req.amount) * 100) / 100;
  // Only recent charges — no months-old history for matching a new purchase
  const recentDays = 45;
  let charges: {
    id: number;
    description: string;
    charge_date: string;
    amount: number;
    created_at: string;
    amount_match: boolean;
    already_linked: boolean;
    tool_loan_request_id: number | null;
  }[] = [];

  if (bal.person_id) {
    const ch = await c.env.DB.prepare(
      `SELECT id, description, charge_date, amount, created_at, tool_loan_request_id
       FROM tool_loan_charges
       WHERE person_id = ?
         AND IFNULL(voided, 0) = 0
         AND date(charge_date) >= date('now', ?)
       ORDER BY
         CASE WHEN abs(amount - ?) < 0.02 THEN 0 ELSE 1 END,
         charge_date DESC,
         id DESC
       LIMIT 8`
    )
      .bind(bal.person_id, `-${recentDays} days`, target)
      .all<{
        id: number;
        description: string;
        charge_date: string;
        amount: number;
        created_at: string;
        tool_loan_request_id: number | null;
      }>();

    // Which requests already share each charge (multi-item bundles)
    const linkRows = await c.env.DB.prepare(
      `SELECT l.charge_id, l.request_id, r.item_name, r.amount
       FROM tool_loan_charge_links l
       JOIN tool_loan_requests r ON r.id = l.request_id
       WHERE l.charge_id IN (
         SELECT id FROM tool_loan_charges
         WHERE person_id = ? AND IFNULL(voided, 0) = 0
           AND date(charge_date) >= date('now', ?)
       )`
    )
      .bind(bal.person_id, `-${recentDays} days`)
      .all<{
        charge_id: number;
        request_id: number;
        item_name: string;
        amount: number;
      }>();
    const linksByCharge = new Map<
      number,
      { request_id: number; item_name: string; amount: number }[]
    >();
    for (const row of linkRows.results || []) {
      const list = linksByCharge.get(row.charge_id) || [];
      list.push({
        request_id: row.request_id,
        item_name: row.item_name,
        amount: row.amount,
      });
      linksByCharge.set(row.charge_id, list);
    }

    charges = (ch.results || []).map((row) => {
      const amt = Math.round(Number(row.amount) * 100) / 100;
      const linkedReqs = linksByCharge.get(row.id) || [];
      // Legacy FK only
      if (
        !linkedReqs.length &&
        row.tool_loan_request_id &&
        Number(row.tool_loan_request_id) > 0
      ) {
        linkedReqs.push({
          request_id: Number(row.tool_loan_request_id),
          item_name: "",
          amount: 0,
        });
      }
      const linkedIds = linkedReqs.map((x) => x.request_id);
      const thisLinked = linkedIds.includes(id);
      return {
        ...row,
        tool_loan_request_id: Number(row.tool_loan_request_id) || null,
        amount_match: Math.abs(amt - target) < 0.02,
        // Charge can host many requests — only "already" if this request is on it
        already_linked: thisLinked,
        linked_request_ids: linkedIds,
        linked_items: linkedReqs
          .filter((x) => x.item_name)
          .map((x) => ({ id: x.request_id, item_name: x.item_name, amount: x.amount })),
      };
    });
  }

  // Other open items for same employee that can share one payroll charge
  const siblingOpen = await c.env.DB.prepare(
    `SELECT id, item_name, item_url, amount, part_status, created_at, arrived_at
     FROM tool_loan_requests
     WHERE user_id = ?
       AND id != ?
       AND status = 'approved'
       AND COALESCE(part_status, 'pending_order') IN (
         'pending_order', 'ordered', 'arrived'
       )
     ORDER BY created_at DESC
     LIMIT 20`
  )
    .bind(req.user_id, id)
    .all();

  const pretax = target;
  const taxRate = TOOL_LOAN_DEFAULT_TAX_RATE;
  const taxAmount = Math.round(pretax * (taxRate / 100) * 100) / 100;
  const totalWithTax = Math.round((pretax + taxAmount) * 100) / 100;

  return c.json({
    request: {
      id: req.id,
      user_id: req.user_id,
      employee_name: req.employee_name,
      item_name: req.item_name,
      amount: req.amount,
      purpose: req.purpose,
      status: req.status,
      part_status: req.part_status,
      created_at: req.created_at,
    },
    ledger: bal.person_id
      ? {
          person_id: bal.person_id,
          display_name: bal.display_name,
          balance: bal.balance,
          matched: true,
        }
      : {
          person_id: null,
          display_name: null,
          balance: 0,
          matched: false,
        },
    charges,
    bundle_candidates: siblingOpen.results || [],
    recent_days: recentDays,
    tax_defaults: {
      pretax_amount: pretax,
      tax_rate: taxRate,
      tax_amount: taxAmount,
      total_with_tax: totalWithTax,
    },
  });
});

/**
 * Office updates part fulfillment after approval.
 * Body: part_status = ordered | arrived | paperwork_signed, note?, paperwork_key?
 * For paperwork_signed also accepts:
 *   linked_charge_id — link an existing recent ledger charge
 *   create_charge — { pretax_amount, tax_rate } create payroll charge with tax included
 * Flow: pending_order → ordered → arrived → paperwork_signed
 */
api.post("/tool-loans/:id/part-status", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  if (!isOfficeRole(user.role)) {
    return c.json({ error: "Only office or admin can update part status" }, 403);
  }
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    part_status?: ToolLoanPartStatus;
    note?: string | null;
    paperwork_key?: string | null;
    linked_charge_id?: number | null;
    /** Extra request ids to mark signed + link to the same charge (bundled purchases). */
    also_request_ids?: number[];
    create_charge?: {
      pretax_amount?: number | string;
      tax_rate?: number | string;
      total_amount?: number | string;
      description?: string;
    } | null;
  }>();
  const next = body.part_status;
  if (
    next !== "ordered" &&
    next !== "arrived" &&
    next !== "pending_order" &&
    next !== "paperwork_signed"
  ) {
    return c.json(
      {
        error:
          "part_status must be pending_order, ordered, arrived, or paperwork_signed",
      },
      400
    );
  }
  const note = (body.note || "").trim() || null;
  const paperworkKeyRaw = (body.paperwork_key || "").trim() || null;
  if (
    paperworkKeyRaw &&
    !/^(tool-loan-paperwork|fuel-receipts|parts-receipts)\//i.test(paperworkKeyRaw)
  ) {
    return c.json({ error: "Invalid paperwork attachment key" }, 400);
  }

  const before = await c.env.DB.prepare(`SELECT * FROM tool_loan_requests WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      status: string;
      item_name: string;
      amount: number;
      part_status: string | null;
      ordered_at: string | null;
      arrived_at: string | null;
      part_note: string | null;
      paperwork_signed_at: string | null;
      paperwork_note: string | null;
      paperwork_key: string | null;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status !== "approved") {
    return c.json({ error: "Part status can only be updated after the loan is approved" }, 400);
  }

  const cur = (before.part_status || "pending_order") as ToolLoanPartStatus;
  // Block moving backward along the fulfillment track
  const rank: Record<ToolLoanPartStatus, number> = {
    pending_order: 0,
    ordered: 1,
    arrived: 2,
    paperwork_signed: 3,
  };
  if (rank[next] < rank[cur]) {
    return c.json({ error: "Cannot move part status backward" }, 400);
  }
  if (next === "paperwork_signed" && rank[cur] < rank.arrived && cur !== "paperwork_signed") {
    // Allow if somehow already has arrived_at, else require arrived first
    if (!before.arrived_at) {
      return c.json(
        { error: "Mark the part arrived before recording signed paperwork" },
        400
      );
    }
  }

  let orderedAt = before.ordered_at;
  let arrivedAt = before.arrived_at;
  let paperworkSignedAt = before.paperwork_signed_at;
  if (next === "ordered" && !orderedAt) orderedAt = new Date().toISOString();
  if (next === "arrived" || next === "paperwork_signed") {
    if (!orderedAt) orderedAt = new Date().toISOString();
    if (!arrivedAt) arrivedAt = new Date().toISOString();
  }
  if (next === "paperwork_signed" && !paperworkSignedAt) {
    paperworkSignedAt = new Date().toISOString();
  }

  // Notes: part tracking note vs paperwork note
  let partNote = before.part_note;
  let paperworkNote = before.paperwork_note;
  let paperworkKey = before.paperwork_key;
  /** Set when paperwork is linked to / creates a payroll charge */
  let linkedChargeId: number | null = null;

  if (next === "paperwork_signed") {
    if (note !== null) paperworkNote = note;
    if (paperworkKeyRaw) paperworkKey = paperworkKeyRaw;

    const wantsCreate = Boolean(body.create_charge);
    const linkId = Number(body.linked_charge_id) || 0;

    if (wantsCreate && linkId) {
      return c.json(
        { error: "Choose either an existing loan or create a new one — not both" },
        400
      );
    }

    // Resolve / create payroll person for this employee
    const bal = await ledgerBalanceForUserId(c.env.DB, before.user_id);
    let personId = bal.person_id;

    if (wantsCreate || linkId) {
      if (!personId) {
        // Create ledger person linked to app user
        const urow = await c.env.DB.prepare(
          `SELECT id, display_name FROM users WHERE id = ?`
        )
          .bind(before.user_id)
          .first<{ id: number; display_name: string }>();
        const name =
          (urow?.display_name || "").trim() || `User ${before.user_id}`;
        try {
          const ins = await c.env.DB.prepare(
            `INSERT INTO tool_loan_people (user_id, display_name, weekly_deduction, status, notes)
             VALUES (?, ?, NULL, 'active', 'Created from tool loan paperwork')`
          )
            .bind(before.user_id, name)
            .run();
          personId = Number(ins.meta.last_row_id);
        } catch {
          // Race: person may already exist for this user_id
          const again = await ledgerBalanceForUserId(c.env.DB, before.user_id);
          personId = again.person_id;
        }
      }
      if (!personId) {
        return c.json({ error: "Could not create or find payroll ledger person" }, 500);
      }
    }

    // Other requests to bundle onto the same charge (same employee only)
    const alsoIds = Array.isArray(body.also_request_ids)
      ? body.also_request_ids.map((n) => Number(n)).filter((n) => n > 0 && n !== id)
      : [];
    let alsoValid: number[] = [];
    if (alsoIds.length) {
      const ph = alsoIds.map(() => "?").join(",");
      const sib = await c.env.DB.prepare(
        `SELECT id FROM tool_loan_requests
         WHERE id IN (${ph})
           AND user_id = ?
           AND status = 'approved'
           AND COALESCE(part_status, 'pending_order') IN (
             'pending_order', 'ordered', 'arrived', 'paperwork_signed'
           )`
      )
        .bind(...alsoIds, before.user_id)
        .all<{ id: number }>();
      alsoValid = (sib.results || []).map((r) => r.id);
    }
    const allRequestIds = [id, ...alsoValid];

    if (linkId) {
      const ch = await c.env.DB.prepare(
        `SELECT id, person_id, description, amount, charge_date, tool_loan_request_id
         FROM tool_loan_charges
         WHERE id = ? AND IFNULL(voided, 0) = 0`
      )
        .bind(linkId)
        .first<{
          id: number;
          person_id: number;
          description: string;
          amount: number;
          charge_date: string;
          tool_loan_request_id: number | null;
        }>();
      if (!ch) return c.json({ error: "Selected ledger charge not found" }, 404);
      if (personId && ch.person_id !== personId) {
        const bal2 = await ledgerBalanceForUserId(c.env.DB, before.user_id);
        if (bal2.person_id && ch.person_id !== bal2.person_id) {
          return c.json(
            { error: "That charge belongs to a different employee on the ledger" },
            400
          );
        }
      }
      // Multi-item: one charge can link many requests
      await linkRequestsToCharge(c.env.DB, linkId, allRequestIds);
      linkedChargeId = linkId;
      if (!paperworkNote) {
        const extra =
          alsoValid.length > 0 ? ` · +${alsoValid.length} more item(s)` : "";
        paperworkNote = `Linked ledger #${linkId}: ${ch.description} · $${Number(
          ch.amount
        ).toFixed(2)} · ${String(ch.charge_date).slice(0, 10)}${extra}`;
      }
    } else if (wantsCreate && body.create_charge) {
      const pretaxRaw = Number(body.create_charge.pretax_amount);
      const taxRateRaw = Number(body.create_charge.tax_rate);
      const pretax =
        Number.isFinite(pretaxRaw) && pretaxRaw > 0
          ? Math.round(pretaxRaw * 100) / 100
          : Math.round(Number(before.amount) * 100) / 100;
      const taxRate =
        Number.isFinite(taxRateRaw) && taxRateRaw >= 0
          ? Math.round(taxRateRaw * 1000) / 1000
          : TOOL_LOAN_DEFAULT_TAX_RATE;
      const taxAmt = Math.round(pretax * (taxRate / 100) * 100) / 100;
      let total = Math.round((pretax + taxAmt) * 100) / 100;
      const totalOverride = Number(body.create_charge.total_amount);
      if (Number.isFinite(totalOverride) && totalOverride > 0) {
        total = Math.round(totalOverride * 100) / 100;
      }
      if (total <= 0) {
        return c.json({ error: "Charge total must be positive" }, 400);
      }
      const descBase =
        (body.create_charge.description || "").trim() ||
        before.item_name ||
        "Tool purchase / loan";
      const desc =
        taxRate > 0
          ? `${descBase} (pre-tax $${pretax.toFixed(2)} + ${taxRate}% tax $${taxAmt.toFixed(
              2
            )} = $${total.toFixed(2)})`
          : descBase;
      const chargeDate = new Date().toISOString().slice(0, 10);
      const ins = await c.env.DB.prepare(
        `INSERT INTO tool_loan_charges
           (person_id, description, charge_date, amount, source, tool_loan_request_id, created_by_user_id)
         VALUES (?, ?, ?, ?, 'manual', ?, ?)`
      )
        .bind(personId, desc, chargeDate, total, id, user.id)
        .run();
      linkedChargeId = Number(ins.meta.last_row_id);
      await linkRequestsToCharge(c.env.DB, linkedChargeId, allRequestIds);
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "tool_loan_charge",
        String(linkedChargeId),
        `From paperwork · request #${id}${
          alsoValid.length ? ` +${alsoValid.length} more` : ""
        } · $${total} (tax ${taxRate}%)`
      );
      if (!paperworkNote) {
        paperworkNote = `Created ledger #${linkedChargeId}: ${desc}`;
      }
    }

    // Mark bundled sibling requests as paperwork_signed too
    if (alsoValid.length && next === "paperwork_signed") {
      const nowIso = paperworkSignedAt || new Date().toISOString();
      for (const rid of alsoValid) {
        await c.env.DB.prepare(
          `UPDATE tool_loan_requests SET
             part_status = 'paperwork_signed',
             ordered_at = COALESCE(ordered_at, ?),
             arrived_at = COALESCE(arrived_at, ?),
             paperwork_signed_at = COALESCE(paperwork_signed_at, ?),
             paperwork_note = COALESCE(?, paperwork_note),
             paperwork_key = COALESCE(?, paperwork_key),
             updated_at = datetime('now')
           WHERE id = ? AND status = 'approved'`
        )
          .bind(
            orderedAt || nowIso,
            arrivedAt || nowIso,
            nowIso,
            paperworkNote,
            paperworkKey,
            rid
          )
          .run();
      }
    }
  } else if (note !== null) {
    partNote = note;
  }

  await c.env.DB.prepare(
    `UPDATE tool_loan_requests SET
       part_status = ?,
       ordered_at = ?,
       arrived_at = ?,
       part_note = ?,
       paperwork_signed_at = ?,
       paperwork_note = ?,
       paperwork_key = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(
      next,
      orderedAt,
      arrivedAt,
      partNote,
      paperworkSignedAt,
      paperworkNote,
      paperworkKey,
      id
    )
    .run();

  if (next !== cur) {
    const title =
      next === "ordered"
        ? `Tool ordered · ${before.item_name}`
        : next === "arrived"
          ? `Tool arrived · ${before.item_name}`
          : next === "paperwork_signed"
            ? `Loan paperwork signed · ${before.item_name}`
            : `Tool loan update · ${before.item_name}`;
    const detail =
      next === "ordered"
        ? `Your tool loan part has been ordered${partNote ? ` · ${partNote}` : ""}`
        : next === "arrived"
          ? `Your tool loan part has arrived and is ready${partNote ? ` · ${partNote}` : ""}`
          : next === "paperwork_signed"
            ? `Tool loan paperwork is signed and on file${
                paperworkNote ? ` · ${paperworkNote}` : ""
              }`
            : "Status updated";
    scheduleWaitUntil(
      c,
      notifyAndSms(c.env, c.env.DB, [before.user_id], {
        kind: "tool_loan_part",
        title,
        body: detail,
        entity: { type: "tool_loan", id },
        sms: shortSms(`TA: ${title}${detail ? ` · ${detail.slice(0, 100)}` : ""}`),
        fromUserId: user.id,
        smsContext: `tool_loan_part:${id}:${next}`,
      }).catch(() => {
        /* ignore */
      })
    );
  }

  await writeAudit(
    c.env.DB,
    user,
    "update",
    "tool_loan_request",
    id,
    `part_status=${next} · ${before.item_name}${
      paperworkKey ? ` · paperwork=${paperworkKey}` : ""
    }${linkedChargeId ? ` · charge=#${linkedChargeId}` : ""}`
  );

  const row = await c.env.DB.prepare(
    `SELECT r.*, u.display_name as employee_name, m.display_name as manager_name
     FROM tool_loan_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN users m ON m.id = r.manager_user_id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  return c.json({
    ok: true,
    request: row,
    linked_charge_id: linkedChargeId,
  });
});

api.post("/tool-loans/:id/cancel", async (c) => {
  const user = c.get("user");
  await ensureToolLoanTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare(`SELECT * FROM tool_loan_requests WHERE id = ?`)
    .bind(id)
    .first<{ id: number; user_id: number; status: string; manager_user_id: number | null }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status !== "pending_manager" && before.status !== "pending_office") {
    return c.json({ error: "Only open requests can be cancelled" }, 400);
  }
  const isOwner = before.user_id === user.id;
  if (!isOwner && !isOfficeRole(user.role)) {
    return c.json({ error: "Only you (or office/admin) can cancel this request" }, 403);
  }

  await c.env.DB.prepare(
    `UPDATE tool_loan_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();

  await writeAudit(c.env.DB, user, "update", "tool_loan_request", id, "Cancelled");
  return c.json({ ok: true });
});

// ——— Parts order hub (mechanic order tracking; vendors open externally) ———

const PARTS_ORDER_VENDORS = {
  autozone: {
    id: "autozone" as const,
    label: "AutoZone Pro",
    url: "https://www.autozonepro.com",
  },
  firstcall: {
    id: "firstcall" as const,
    label: "First Call Online",
    url: "https://www.firstcallonline.com/",
  },
};

type PartsOrderStatus = "needed" | "ordered" | "arriving" | "received" | "cancelled";
type PartsOrderVendorPref = "autozone" | "firstcall" | "either" | "other";

let partsOrderTablesReady = false;
async function ensurePartsOrderTables(db: D1Database): Promise<void> {
  if (partsOrderTablesReady) return;
  const stmts = [
    `CREATE TABLE IF NOT EXISTS parts_order_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      vehicle_label TEXT,
      issue_id INTEGER,
      part_description TEXT NOT NULL,
      part_number TEXT,
      vendor_preference TEXT NOT NULL DEFAULT 'either',
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'needed',
      ordered_from TEXT,
      order_note TEXT,
      ordered_at TEXT,
      arriving_at TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parts_order_user ON parts_order_requests(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_parts_order_status ON parts_order_requests(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_parts_order_issue ON parts_order_requests(issue_id)`,
  ];
  for (const sql of stmts) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  partsOrderTablesReady = true;
}

function canUsePartsOrderHub(role: string): boolean {
  return (
    role === "admin" ||
    role === "office" ||
    role === "mechanic" ||
    role === "warehouse" ||
    role === "viewer"
  );
}

function canManageAllPartsOrders(role: string): boolean {
  return (
    role === "admin" ||
    role === "office" ||
    role === "warehouse" ||
    role === "mechanic" ||
    role === "supervisor"
  );
}

api.get("/parts-orders/vendors", async (c) => {
  return c.json({
    vendors: [
      PARTS_ORDER_VENDORS.autozone,
      PARTS_ORDER_VENDORS.firstcall,
    ],
  });
});

api.get("/parts-orders/pending-count", async (c) => {
  const user = c.get("user");
  if (!canUsePartsOrderHub(user.role)) return c.json({ pending: 0 });
  await ensurePartsOrderTables(c.env.DB);
  try {
    if (user.role === "viewer") return c.json({ pending: 0 });
    // Open work: still needed / ordered / arriving (not done)
    if (user.role === "mechanic") {
      const row = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM parts_order_requests
         WHERE user_id = ? AND status IN ('needed', 'ordered', 'arriving')`
      )
        .bind(user.id)
        .first<{ c: number }>();
      return c.json({ pending: row?.c ?? 0 });
    }
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM parts_order_requests
       WHERE status IN ('needed', 'ordered', 'arriving')`
    ).first<{ c: number }>();
    return c.json({ pending: row?.c ?? 0 });
  } catch {
    return c.json({ pending: 0 });
  }
});

/**
 * ?view=mine | open | all
 * open = needed/ordered/arriving (shop board)
 */
api.get("/parts-orders", async (c) => {
  const user = c.get("user");
  if (!canUsePartsOrderHub(user.role)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  await ensurePartsOrderTables(c.env.DB);
  const view = (c.req.query("view") || "open").toLowerCase();
  const vehicleId = Number(c.req.query("vehicle_id") || 0);
  const issueId = Number(c.req.query("issue_id") || 0);
  try {
    let sql = `SELECT r.*,
        u.display_name as requested_by_name,
        v.unit_number as vehicle_unit
       FROM parts_order_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id`;
    const binds: unknown[] = [];
    const where: string[] = [];

    if (view === "mine") {
      where.push(`r.user_id = ?`);
      binds.push(user.id);
    } else if (view === "open") {
      where.push(`r.status IN ('needed', 'ordered', 'arriving')`);
    } else if (view === "vehicle") {
      // Open + recent closed for one unit (shop job panel)
      where.push(
        `(r.status IN ('needed', 'ordered', 'arriving')
          OR date(COALESCE(r.received_at, r.updated_at, r.created_at)) >= date('now', '-90 days'))`
      );
    } else {
      // all — last 90 days closed + all open
      where.push(
        `(r.status IN ('needed', 'ordered', 'arriving')
          OR date(COALESCE(r.received_at, r.updated_at, r.created_at)) >= date('now', '-90 days'))`
      );
    }

    if (vehicleId > 0) {
      where.push(`r.vehicle_id = ?`);
      binds.push(vehicleId);
    }
    if (issueId > 0) {
      where.push(`(r.issue_id = ? OR r.issue_id IS NULL)`);
      binds.push(issueId);
    }

    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;

    sql += ` ORDER BY
      CASE r.status
        WHEN 'needed' THEN 0
        WHEN 'ordered' THEN 1
        WHEN 'arriving' THEN 2
        WHEN 'received' THEN 3
        ELSE 4 END,
      r.created_at DESC LIMIT 150`;

    const rows = await c.env.DB.prepare(sql).bind(...binds).all();

    let pending = 0;
    if (user.role === "mechanic") {
      const p = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM parts_order_requests
         WHERE user_id = ? AND status IN ('needed', 'ordered', 'arriving')`
      )
        .bind(user.id)
        .first<{ c: number }>();
      pending = p?.c ?? 0;
    } else if (user.role !== "viewer") {
      const p = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM parts_order_requests
         WHERE status IN ('needed', 'ordered', 'arriving')`
      ).first<{ c: number }>();
      pending = p?.c ?? 0;
    }

    return c.json({
      requests: rows.results || [],
      pending,
      vendors: [PARTS_ORDER_VENDORS.autozone, PARTS_ORDER_VENDORS.firstcall],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        requests: [],
        pending: 0,
        vendors: [PARTS_ORDER_VENDORS.autozone, PARTS_ORDER_VENDORS.firstcall],
        error: "Run migration 048_parts_order_requests.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/parts-orders", async (c) => {
  const user = c.get("user");
  if (!canUsePartsOrderHub(user.role) || user.role === "viewer") {
    return c.json({ error: "Not allowed to create parts orders" }, 403);
  }
  await ensurePartsOrderTables(c.env.DB);
  const body = await c.req.json<{
    part_description?: string;
    part_number?: string;
    vehicle_id?: number | null;
    vehicle_label?: string;
    issue_id?: number | null;
    vendor_preference?: PartsOrderVendorPref;
    notes?: string;
  }>();

  const partDescription = (body.part_description || "").trim();
  if (!partDescription || partDescription.length < 2) {
    return c.json({ error: "Describe the part you need" }, 400);
  }
  const partNumber = (body.part_number || "").trim() || null;
  const vehicleLabel = (body.vehicle_label || "").trim() || null;
  const vehicleId =
    body.vehicle_id != null && Number(body.vehicle_id) > 0 ? Number(body.vehicle_id) : null;
  const issueId =
    body.issue_id != null && Number(body.issue_id) > 0 ? Number(body.issue_id) : null;
  const prefRaw = (body.vendor_preference || "either").toLowerCase();
  const vendorPref: PartsOrderVendorPref =
    prefRaw === "autozone" ||
    prefRaw === "firstcall" ||
    prefRaw === "other" ||
    prefRaw === "either"
      ? prefRaw
      : "either";
  const notes = (body.notes || "").trim() || null;

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO parts_order_requests (
         user_id, vehicle_id, vehicle_label, issue_id, part_description, part_number,
         vendor_preference, notes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'needed', datetime('now'), datetime('now'))`
    )
      .bind(
        user.id,
        vehicleId,
        vehicleLabel,
        issueId,
        partDescription,
        partNumber,
        vendorPref,
        notes
      )
      .run();
    const id = Number(ins.meta.last_row_id);

    // Notify warehouse + office/admin (not the requester)
    const notifyIds = new Set<number>();
    for (const uid of await usersByRoles(c.env.DB, ["admin", "office", "warehouse", "supervisor"])) {
      notifyIds.add(uid);
    }
    notifyIds.delete(user.id);
    if (notifyIds.size) {
      scheduleWaitUntil(
        c,
        notifyUsers(
          c.env.DB,
          [...notifyIds],
          "parts_order_request",
          `Parts order needed · ${user.display_name}`,
          `${partDescription.slice(0, 100)}${
            vehicleLabel || vehicleId ? ` · ${vehicleLabel || `vehicle #${vehicleId}`}` : ""
          }`,
          { type: "parts_order", id }
        ).catch(() => {
          /* non-fatal */
        })
      );
    }

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "parts_order_request",
      id,
      partDescription.slice(0, 120)
    );

    const row = await c.env.DB.prepare(
      `SELECT r.*, u.display_name as requested_by_name,
          v.unit_number as vehicle_unit
       FROM parts_order_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = ?`
    )
      .bind(id)
      .first();

    return c.json({ ok: true, request: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * Advance / set status.
 * Body: status = ordered | arriving | received | needed | cancelled
 *       ordered_from? = autozone | firstcall | other
 *       order_note?
 */
api.post("/parts-orders/:id/status", async (c) => {
  const user = c.get("user");
  if (!canManageAllPartsOrders(user.role)) {
    return c.json({ error: "Not allowed" }, 403);
  }
  await ensurePartsOrderTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    status?: PartsOrderStatus;
    ordered_from?: string | null;
    order_note?: string | null;
  }>();
  const next = body.status;
  const allowed: PartsOrderStatus[] = [
    "needed",
    "ordered",
    "arriving",
    "received",
    "cancelled",
  ];
  if (!next || !allowed.includes(next)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const before = await c.env.DB.prepare(`SELECT * FROM parts_order_requests WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      status: string;
      part_description: string;
      ordered_from: string | null;
      order_note: string | null;
      ordered_at: string | null;
      arriving_at: string | null;
      received_at: string | null;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  // Mechanics can update any open shop order; cancel only own or admin/office
  if (next === "cancelled") {
    const isOwner = before.user_id === user.id;
    if (!isOwner && user.role !== "admin" && user.role !== "office") {
      return c.json({ error: "Only the requester or office/admin can cancel" }, 403);
    }
  }

  let orderedFrom = before.ordered_from;
  if (body.ordered_from === "autozone" || body.ordered_from === "firstcall" || body.ordered_from === "other") {
    orderedFrom = body.ordered_from;
  } else if (next === "ordered" && !orderedFrom) {
    orderedFrom = "other";
  }

  const orderNote =
    body.order_note !== undefined
      ? (body.order_note || "").trim() || null
      : before.order_note;

  let orderedAt = before.ordered_at;
  let arrivingAt = before.arriving_at;
  let receivedAt = before.received_at;
  const nowIso = new Date().toISOString();
  if (next === "ordered" && !orderedAt) orderedAt = nowIso;
  if (next === "arriving") {
    if (!orderedAt) orderedAt = nowIso;
    if (!arrivingAt) arrivingAt = nowIso;
  }
  if (next === "received") {
    if (!orderedAt) orderedAt = nowIso;
    if (!receivedAt) receivedAt = nowIso;
  }

  await c.env.DB.prepare(
    `UPDATE parts_order_requests SET
       status = ?,
       ordered_from = ?,
       order_note = ?,
       ordered_at = ?,
       arriving_at = ?,
       received_at = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(next, orderedFrom, orderNote, orderedAt, arrivingAt, receivedAt, id)
    .run();

  // Notify requester on progress (if someone else updated)
  if (before.user_id !== user.id && next !== before.status) {
    const label =
      next === "ordered"
        ? "ordered"
        : next === "arriving"
          ? "on the way / arriving"
          : next === "received"
            ? "received"
            : next === "cancelled"
              ? "cancelled"
              : next;
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        [before.user_id],
        "parts_order_status",
        `Parts order ${label} · ${before.part_description.slice(0, 60)}`,
        orderNote
          ? orderNote.slice(0, 120)
          : `Updated by ${user.display_name}`,
        { type: "parts_order", id }
      ).catch(() => {
        /* ignore */
      })
    );
  }

  // When mechanic marks ordered, ping warehouse
  if (next === "ordered" && before.status === "needed") {
    const ids = new Set(
      await usersByRoles(c.env.DB, ["admin", "office", "warehouse", "supervisor"])
    );
    ids.delete(user.id);
    if (ids.size) {
      scheduleWaitUntil(
        c,
        notifyUsers(
          c.env.DB,
          [...ids],
          "parts_order_status",
          `Parts ordered · ${before.part_description.slice(0, 60)}`,
          `${user.display_name}${orderedFrom ? ` via ${orderedFrom}` : ""}${
            orderNote ? ` · ${orderNote.slice(0, 80)}` : ""
          }`,
          { type: "parts_order", id }
        ).catch(() => {
          /* ignore */
        })
      );
    }
  }

  await writeAudit(
    c.env.DB,
    user,
    "update",
    "parts_order_request",
    id,
    `${before.status}→${next}`
  );

  const row = await c.env.DB.prepare(
    `SELECT r.*, u.display_name as requested_by_name,
        v.unit_number as vehicle_unit
     FROM parts_order_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN vehicles v ON v.id = r.vehicle_id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  return c.json({ ok: true, request: row });
});

api.post("/parts-orders/:id/cancel", async (c) => {
  const user = c.get("user");
  await ensurePartsOrderTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare(`SELECT * FROM parts_order_requests WHERE id = ?`)
    .bind(id)
    .first<{ id: number; user_id: number; status: string }>();
  if (!before) return c.json({ error: "Not found" }, 404);
  if (before.status === "received" || before.status === "cancelled") {
    return c.json({ error: "Already closed" }, 400);
  }
  const isOwner = before.user_id === user.id;
  if (!isOwner && user.role !== "admin" && user.role !== "office") {
    return c.json({ error: "Only the requester or office/admin can cancel" }, 403);
  }
  await c.env.DB.prepare(
    `UPDATE parts_order_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
  )
    .bind(id)
    .run();
  await writeAudit(c.env.DB, user, "update", "parts_order_request", id, "Cancelled");
  return c.json({ ok: true });
});

// ——— Field parts delivery runs (accountability when tech needs materials brought out) ———

const PARTS_RUN_REASONS = [
  { id: "forgot_load", label: "Forgot to load from the shop" },
  { id: "stock_out", label: "Used the last one / truck stock empty" },
  { id: "wrong_part", label: "Wrong part was loaded" },
  { id: "scope_changed", label: "Job needs changed mid-call" },
  { id: "unknown_need", label: "Didn’t know it would be needed" },
  { id: "other", label: "Other" },
] as const;

type PartsRunReason = (typeof PARTS_RUN_REASONS)[number]["id"];
type PartsRunStatus = "requested" | "en_route" | "delivered" | "cancelled";

let partsRunTablesReady = false;
async function ensurePartsRunTables(db: D1Database): Promise<void> {
  if (partsRunTablesReady) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS parts_run_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vehicle_id INTEGER,
      vehicle_label TEXT,
      job_address TEXT,
      part_needed TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      reason_detail TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'requested',
      delivery_notes TEXT,
      delivered_by_user_id INTEGER,
      delivered_at TEXT,
      inventory_transferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parts_run_user ON parts_run_requests(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_parts_run_status ON parts_run_requests(status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS parts_run_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      line_no INTEGER NOT NULL DEFAULT 1,
      part_id INTEGER,
      part_code TEXT,
      part_name TEXT NOT NULL,
      qty REAL NOT NULL DEFAULT 1,
      transferred INTEGER NOT NULL DEFAULT 0,
      transfer_note TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parts_run_lines_run ON parts_run_lines(run_id, line_no)`,
    `ALTER TABLE parts_run_requests ADD COLUMN inventory_transferred INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  partsRunTablesReady = true;
}

async function resolvePartByCode(
  db: D1Database,
  code: string
): Promise<{ id: number; code: string; name: string } | null> {
  const c = code.trim();
  if (!c) return null;
  const row = await db
    .prepare(
      `SELECT id, code, name FROM parts
       WHERE active = 1 AND (upper(code) = upper(?) OR upper(code) = upper(?))
       LIMIT 1`
    )
    .bind(c, c.replace(/\s+/g, ""))
    .first<{ id: number; code: string; name: string }>();
  if (row) return row;
  return db
    .prepare(
      `SELECT id, code, name FROM parts
       WHERE active = 1 AND upper(code) LIKE upper(?)
       ORDER BY length(code) ASC LIMIT 1`
    )
    .bind(c + "%")
    .first<{ id: number; code: string; name: string }>();
}

async function loadPartsRunLines(db: D1Database, runId: number) {
  try {
    const rows = await db
      .prepare(
        `SELECT * FROM parts_run_lines WHERE run_id = ? ORDER BY line_no, id`
      )
      .bind(runId)
      .all();
    return rows.results || [];
  } catch {
    return [];
  }
}

/** Attach lines to run rows for API responses */
async function withPartsRunLines<T extends { id: number }>(
  db: D1Database,
  runs: T[]
): Promise<(T & { lines: unknown[] })[]> {
  const out: (T & { lines: unknown[] })[] = [];
  for (const r of runs) {
    out.push({ ...r, lines: await loadPartsRunLines(db, r.id) });
  }
  return out;
}

/**
 * Move stock warehouse → truck (or issue from warehouse) for a delivered parts run.
 */
async function transferPartsRunInventory(
  db: D1Database,
  run: {
    id: number;
    user_id: number;
    vehicle_id: number | null;
    part_needed: string;
  },
  actorUserId: number,
  techName: string
): Promise<{ transferred: number; errors: string[] }> {
  await ensureStockLocations(db);
  const wh = await db
    .prepare(
      `SELECT id FROM stock_locations WHERE type = 'warehouse' AND active = 1 LIMIT 1`
    )
    .first<{ id: number }>();
  if (!wh) {
    return { transferred: 0, errors: ["No warehouse location configured"] };
  }

  let destLocId: number | null = null;
  let destLabel = `tech ${techName}`;
  if (run.vehicle_id) {
    const v = await db
      .prepare(`SELECT id, unit_number FROM vehicles WHERE id = ?`)
      .bind(run.vehicle_id)
      .first<{ id: number; unit_number: string }>();
    if (v) {
      destLocId = await ensureVehicleStockLocation(db, v.id, v.unit_number, {
        seedTruckParts: false,
      });
      destLabel = `Unit ${v.unit_number}`;
    }
  }

  const lines = (await loadPartsRunLines(db, run.id)) as Array<{
    id: number;
    part_id: number | null;
    part_code: string | null;
    part_name: string;
    qty: number;
    transferred: number;
  }>;

  const errors: string[] = [];
  let transferred = 0;
  const note = `Parts run #${run.id}: ${techName} · ${run.part_needed.slice(0, 60)} → ${destLabel}`;

  for (const line of lines) {
    if (line.transferred) {
      transferred += 1;
      continue;
    }
    let partId = line.part_id ? Number(line.part_id) : 0;
    if (!partId && line.part_code) {
      const hit = await resolvePartByCode(db, line.part_code);
      if (hit) {
        partId = hit.id;
        await db
          .prepare(`UPDATE parts_run_lines SET part_id = ? WHERE id = ?`)
          .bind(partId, line.id)
          .run();
      }
    }
    if (!partId) {
      errors.push(
        `${line.part_code || line.part_name}: not found in inventory catalog (add part # or skip transfer)`
      );
      await db
        .prepare(
          `UPDATE parts_run_lines SET transfer_note = ? WHERE id = ?`
        )
        .bind("No catalog match", line.id)
        .run();
      continue;
    }
    const qty = Math.max(0.01, Number(line.qty) || 1);
    try {
      if (destLocId) {
        await transferStock(db, partId, wh.id, destLocId, qty, actorUserId, note);
      } else {
        // No truck — issue out of warehouse (still documents custody leave)
        await adjustStockQty(
          db,
          partId,
          wh.id,
          -qty,
          actorUserId,
          "issue",
          note
        );
      }
      await db
        .prepare(
          `UPDATE parts_run_lines SET transferred = 1, transfer_note = ?, part_id = ? WHERE id = ?`
        )
        .bind(destLocId ? `→ ${destLabel}` : "issued from warehouse", partId, line.id)
        .run();
      transferred += 1;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${line.part_code || line.part_name}: ${msg}`);
      await db
        .prepare(`UPDATE parts_run_lines SET transfer_note = ? WHERE id = ?`)
        .bind(msg.slice(0, 200), line.id)
        .run();
    }
  }

  if (transferred > 0) {
    try {
      await db
        .prepare(
          `UPDATE parts_run_requests SET inventory_transferred = 1, updated_at = datetime('now') WHERE id = ?`
        )
        .bind(run.id)
        .run();
    } catch {
      /* column may be missing on very old */
    }
  }

  return { transferred, errors };
}

function isPartsRunDispatcher(role: string): boolean {
  return (
    role === "admin" ||
    role === "office" ||
    role === "warehouse" ||
    role === "mechanic"
  );
}

function partsRunReasonLabel(code: string): string {
  return PARTS_RUN_REASONS.find((r) => r.id === code)?.label || code;
}

api.get("/parts-runs/reasons", async (c) => {
  return c.json({ reasons: PARTS_RUN_REASONS });
});

api.get("/parts-runs/pending-count", async (c) => {
  const user = c.get("user");
  await ensurePartsRunTables(c.env.DB);
  try {
    if (!isPartsRunDispatcher(user.role)) {
      return c.json({ pending: 0 });
    }
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM parts_run_requests WHERE status IN ('requested', 'en_route')`
    ).first<{ c: number }>();
    return c.json({ pending: row?.c ?? 0 });
  } catch {
    return c.json({ pending: 0 });
  }
});

/**
 * ?view=mine | open | report
 * report = office accountability summary + recent log
 */
api.get("/parts-runs", async (c) => {
  const user = c.get("user");
  await ensurePartsRunTables(c.env.DB);
  const view = (c.req.query("view") || "mine").toLowerCase();

  try {
    if (view === "report") {
      if (!isPartsRunDispatcher(user.role) && user.role !== "viewer") {
        return c.json({ error: "Not allowed" }, 403);
      }
      const days = Math.min(365, Math.max(7, Number(c.req.query("days") || 90)));
      const summary = await c.env.DB.prepare(
        `SELECT r.user_id, u.display_name as employee_name,
            COUNT(*) as request_count,
            SUM(CASE WHEN r.status = 'delivered' THEN 1 ELSE 0 END) as delivered_count,
            MAX(r.created_at) as last_request_at
         FROM parts_run_requests r
         JOIN users u ON u.id = r.user_id
         WHERE date(r.created_at) >= date('now', ?)
           AND r.status != 'cancelled'
         GROUP BY r.user_id
         ORDER BY request_count DESC, last_request_at DESC
         LIMIT 80`
      )
        .bind(`-${days} days`)
        .all();

      const recent = await c.env.DB.prepare(
        `SELECT r.*, u.display_name as employee_name,
            d.display_name as delivered_by_name,
            v.unit_number as vehicle_unit
         FROM parts_run_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users d ON d.id = r.delivered_by_user_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
         WHERE date(r.created_at) >= date('now', ?)
         ORDER BY r.created_at DESC LIMIT 100`
      )
        .bind(`-${days} days`)
        .all();

      const recentWithLines = await withPartsRunLines(
        c.env.DB,
        (recent.results || []) as { id: number }[]
      );
      return c.json({
        days,
        summary: summary.results || [],
        requests: recentWithLines,
        reasons: PARTS_RUN_REASONS,
      });
    }

    if (view === "open") {
      if (!isPartsRunDispatcher(user.role) && user.role !== "viewer") {
        return c.json({ error: "Not allowed" }, 403);
      }
      const rows = await c.env.DB.prepare(
        `SELECT r.*, u.display_name as employee_name,
            d.display_name as delivered_by_name,
            v.unit_number as vehicle_unit
         FROM parts_run_requests r
         JOIN users u ON u.id = r.user_id
         LEFT JOIN users d ON d.id = r.delivered_by_user_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
         WHERE r.status IN ('requested', 'en_route')
         ORDER BY
           CASE r.status WHEN 'requested' THEN 0 ELSE 1 END,
           r.created_at ASC
         LIMIT 80`
      ).all();
      const withLines = await withPartsRunLines(
        c.env.DB,
        (rows.results || []) as { id: number }[]
      );
      return c.json({
        requests: withLines,
        reasons: PARTS_RUN_REASONS,
        is_dispatcher: isPartsRunDispatcher(user.role),
      });
    }

    // mine — personal log + counts
    const mine = await c.env.DB.prepare(
      `SELECT r.*, v.unit_number as vehicle_unit,
          d.display_name as delivered_by_name
       FROM parts_run_requests r
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       LEFT JOIN users d ON d.id = r.delivered_by_user_id
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC LIMIT 60`
    )
      .bind(user.id)
      .all();

    const stats = await c.env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN date(created_at) >= date('now', '-30 days') AND status != 'cancelled' THEN 1 ELSE 0 END) as last_30,
         SUM(CASE WHEN date(created_at) >= date('now', '-90 days') AND status != 'cancelled' THEN 1 ELSE 0 END) as last_90,
         SUM(CASE WHEN status IN ('requested','en_route') THEN 1 ELSE 0 END) as open_count
       FROM parts_run_requests WHERE user_id = ?`
    )
      .bind(user.id)
      .first<{
        total: number;
        last_30: number;
        last_90: number;
        open_count: number;
      }>();

    const mineWithLines = await withPartsRunLines(
      c.env.DB,
      (mine.results || []) as { id: number }[]
    );

    return c.json({
      requests: mineWithLines,
      reasons: PARTS_RUN_REASONS,
      stats: {
        total: stats?.total ?? 0,
        last_30: stats?.last_30 ?? 0,
        last_90: stats?.last_90 ?? 0,
        open_count: stats?.open_count ?? 0,
      },
      is_dispatcher: isPartsRunDispatcher(user.role),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        requests: [],
        summary: [],
        reasons: PARTS_RUN_REASONS,
        stats: { total: 0, last_30: 0, last_90: 0, open_count: 0 },
        error: "Run migration 050_parts_run_requests.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/parts-runs", async (c) => {
  const user = c.get("user");
  await ensurePartsRunTables(c.env.DB);
  const body = await c.req.json<{
    /** What they need brought out (plain description) */
    part_needed?: string;
    /** Why it wasn’t already on the truck (plain text) */
    reason_detail?: string;
    /** Free-text reason also accepted as "why" for older clients */
    why_not_on_truck?: string;
    job_address?: string;
    reason_code?: string;
    vehicle_id?: number | null;
    vehicle_label?: string;
  }>();

  const partNeeded = (body.part_needed || "").trim();
  const reasonDetail = (body.reason_detail || body.why_not_on_truck || "").trim();
  const jobAddress = (body.job_address || "").trim();
  // Keep a reason_code for older rows/reports; free-text lives in reason_detail
  const reasonCode = "other";

  if (!partNeeded || partNeeded.length < 3) {
    return c.json({ error: "Describe what you need delivered." }, 400);
  }
  if (!reasonDetail || reasonDetail.length < 5) {
    return c.json({ error: "Say why it wasn’t already on the truck." }, 400);
  }
  if (!jobAddress || jobAddress.length < 5) {
    return c.json({ error: "Enter the address where the parts need to go." }, 400);
  }

  const vehicleId =
    body.vehicle_id != null && Number(body.vehicle_id) > 0 ? Number(body.vehicle_id) : null;
  const vehicleLabel = (body.vehicle_label || "").trim() || null;

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO parts_run_requests (
         user_id, vehicle_id, vehicle_label, job_address, part_needed,
         reason_code, reason_detail, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', datetime('now'), datetime('now'))`
    )
      .bind(user.id, vehicleId, vehicleLabel, jobAddress, partNeeded, reasonCode, reasonDetail)
      .run();
    const id = Number(ins.meta.last_row_id);

    const notifyIds = await usersByRoles(c.env.DB, [
      "admin",
      "office",
      "warehouse",
      "mechanic",
    ]);
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        notifyIds.filter((uid) => uid !== user.id),
        "parts_run_request",
        `Parts delivery needed · ${user.display_name}`,
        `${partNeeded.slice(0, 80)} · ${jobAddress.slice(0, 60)}`,
        { type: "parts_run", id }
      ).catch(() => {
        /* non-fatal */
      })
    );

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "parts_run_request",
      id,
      `${partNeeded.slice(0, 80)} · ${jobAddress.slice(0, 40)}`
    );

    const row = await c.env.DB.prepare(
      `SELECT r.*, u.display_name as employee_name, v.unit_number as vehicle_unit
       FROM parts_run_requests r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN vehicles v ON v.id = r.vehicle_id
       WHERE r.id = ?`
    )
      .bind(id)
      .first();

    return c.json({ ok: true, request: { ...row, lines: [] } }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

api.post("/parts-runs/:id/status", async (c) => {
  const user = c.get("user");
  await ensurePartsRunTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    status?: PartsRunStatus;
    delivery_notes?: string | null;
    /** When delivering: transfer warehouse stock to truck (default true) */
    transfer_inventory?: boolean;
  }>();
  const next = body.status;
  if (
    next !== "requested" &&
    next !== "en_route" &&
    next !== "delivered" &&
    next !== "cancelled"
  ) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const before = await c.env.DB.prepare(`SELECT * FROM parts_run_requests WHERE id = ?`)
    .bind(id)
    .first<{
      id: number;
      user_id: number;
      vehicle_id: number | null;
      status: string;
      part_needed: string;
    }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  if (next === "cancelled") {
    if (before.user_id !== user.id && !isPartsRunDispatcher(user.role)) {
      return c.json({ error: "Only you or warehouse/office can cancel" }, 403);
    }
  } else if (!isPartsRunDispatcher(user.role)) {
    return c.json({ error: "Only warehouse, shop, or office can update delivery status" }, 403);
  }

  const notes =
    body.delivery_notes !== undefined
      ? (body.delivery_notes || "").trim() || null
      : null;

  let inventoryResult: { transferred: number; errors: string[] } | null = null;

  if (next === "delivered") {
    await c.env.DB.prepare(
      `UPDATE parts_run_requests SET
         status = 'delivered',
         delivery_notes = COALESCE(?, delivery_notes),
         delivered_by_user_id = ?,
         delivered_at = datetime('now'),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(notes, user.id, id)
      .run();

    // Live inventory: warehouse → truck / issue when marked delivered
    const doTransfer = body.transfer_inventory !== false;
    if (doTransfer) {
      const tech = await c.env.DB.prepare(
        `SELECT display_name FROM users WHERE id = ?`
      )
        .bind(before.user_id)
        .first<{ display_name: string }>();
      inventoryResult = await transferPartsRunInventory(
        c.env.DB,
        before,
        user.id,
        tech?.display_name || `user ${before.user_id}`
      );
    }
  } else if (next === "en_route") {
    await c.env.DB.prepare(
      `UPDATE parts_run_requests SET
         status = 'en_route',
         delivery_notes = COALESCE(?, delivery_notes),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(notes, id)
      .run();
  } else if (next === "cancelled") {
    await c.env.DB.prepare(
      `UPDATE parts_run_requests SET
         status = 'cancelled',
         delivery_notes = COALESCE(?, delivery_notes),
         updated_at = datetime('now')
       WHERE id = ?`
    )
      .bind(notes, id)
      .run();
  } else {
    await c.env.DB.prepare(
      `UPDATE parts_run_requests SET status = 'requested', updated_at = datetime('now') WHERE id = ?`
    )
      .bind(id)
      .run();
  }

  if (before.user_id !== user.id && (next === "en_route" || next === "delivered")) {
    const invNote =
      inventoryResult && inventoryResult.transferred
        ? ` · stock moved to truck (${inventoryResult.transferred} line${inventoryResult.transferred === 1 ? "" : "s"})`
        : "";
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        [before.user_id],
        "parts_run_status",
        next === "en_route"
          ? `Parts are on the way · ${before.part_needed.slice(0, 50)}`
          : `Parts delivered · ${before.part_needed.slice(0, 50)}`,
        (notes || `Updated by ${user.display_name}`) + invNote,
        { type: "parts_run", id }
      ).catch(() => {
        /* ignore */
      })
    );
  }

  await writeAudit(
    c.env.DB,
    user,
    "update",
    "parts_run_request",
    id,
    inventoryResult
      ? `${next} · inv ${inventoryResult.transferred} ok${inventoryResult.errors.length ? ` · ${inventoryResult.errors.length} err` : ""}`
      : next
  );

  const row = await c.env.DB.prepare(
    `SELECT r.*, u.display_name as employee_name,
        d.display_name as delivered_by_name,
        v.unit_number as vehicle_unit
     FROM parts_run_requests r
     JOIN users u ON u.id = r.user_id
     LEFT JOIN users d ON d.id = r.delivered_by_user_id
     LEFT JOIN vehicles v ON v.id = r.vehicle_id
     WHERE r.id = ?`
  )
    .bind(id)
    .first();

  const lines = await loadPartsRunLines(c.env.DB, id);
  return c.json({
    ok: true,
    request: { ...row, lines },
    inventory: inventoryResult,
  });
});

// ——— App feedback / suggestions (everyone can submit; office/admin review) ———

let appFeedbackTablesReady = false;
async function ensureAppFeedbackTables(db: D1Database): Promise<void> {
  if (appFeedbackTablesReady) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS app_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL DEFAULT 'suggestion',
      message TEXT NOT NULL,
      page_context TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      admin_note TEXT,
      reviewed_by_user_id INTEGER,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_app_feedback_status ON app_feedback(status, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_app_feedback_user ON app_feedback(user_id, created_at DESC)`,
  ]) {
    try {
      await db.prepare(sql).run();
    } catch {
      /* exists */
    }
  }
  appFeedbackTablesReady = true;
}

const FEEDBACK_CATEGORIES = new Set(["suggestion", "bug", "praise", "other"]);
const FEEDBACK_STATUSES = new Set(["new", "reviewed", "done", "dismissed"]);

function isFeedbackReviewer(role: string): boolean {
  return role === "admin" || role === "office" || role === "supervisor";
}

api.get("/feedback/pending-count", async (c) => {
  const user = c.get("user");
  await ensureAppFeedbackTables(c.env.DB);
  if (!isFeedbackReviewer(user.role)) return c.json({ pending: 0 });
  try {
    const row = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM app_feedback WHERE status = 'new'`
    ).first<{ c: number }>();
    return c.json({ pending: row?.c ?? 0 });
  } catch {
    return c.json({ pending: 0 });
  }
});

api.get("/feedback", async (c) => {
  const user = c.get("user");
  await ensureAppFeedbackTables(c.env.DB);
  const view = (c.req.query("view") || "mine").toLowerCase();

  try {
    if (view === "inbox" || view === "all") {
      if (!isFeedbackReviewer(user.role)) {
        return c.json({ error: "Office or admin only" }, 403);
      }
      const status = (c.req.query("status") || "open").toLowerCase();
      let sql = `SELECT f.*, u.display_name as employee_name, u.role as employee_role,
          r.display_name as reviewed_by_name
         FROM app_feedback f
         JOIN users u ON u.id = f.user_id
         LEFT JOIN users r ON r.id = f.reviewed_by_user_id`;
      if (status === "open" || status === "new") {
        sql += ` WHERE f.status = 'new'`;
      } else if (status === "active") {
        sql += ` WHERE f.status IN ('new','reviewed')`;
      } else if (status !== "all") {
        sql += ` WHERE f.status = ?`;
      }
      sql += ` ORDER BY
        CASE f.status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
        f.created_at DESC
        LIMIT 150`;
      const rows =
        status === "all" || status === "open" || status === "new" || status === "active"
          ? await c.env.DB.prepare(sql).all()
          : await c.env.DB.prepare(sql).bind(status).all();
      const pending = await c.env.DB.prepare(
        `SELECT COUNT(*) as c FROM app_feedback WHERE status = 'new'`
      ).first<{ c: number }>();
      return c.json({
        items: rows.results || [],
        pending: pending?.c ?? 0,
        is_reviewer: true,
      });
    }

    // mine
    const mine = await c.env.DB.prepare(
      `SELECT f.*, r.display_name as reviewed_by_name
       FROM app_feedback f
       LEFT JOIN users r ON r.id = f.reviewed_by_user_id
       WHERE f.user_id = ?
       ORDER BY f.created_at DESC LIMIT 40`
    )
      .bind(user.id)
      .all();
    return c.json({
      items: mine.results || [],
      is_reviewer: isFeedbackReviewer(user.role),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        items: [],
        pending: 0,
        error: "Run migration 053_app_feedback.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

api.post("/feedback", async (c) => {
  const user = c.get("user");
  await ensureAppFeedbackTables(c.env.DB);
  const body = await c.req.json<{
    message?: string;
    category?: string;
    page_context?: string | null;
  }>();

  const message = (body.message || "").trim();
  if (message.length < 8) {
    return c.json(
      { error: "Please write a bit more so we understand your suggestion (a short sentence is fine)." },
      400
    );
  }
  if (message.length > 4000) {
    return c.json({ error: "Keep feedback under 4000 characters." }, 400);
  }

  let category = (body.category || "suggestion").trim().toLowerCase();
  if (!FEEDBACK_CATEGORIES.has(category)) category = "suggestion";
  const pageContext = (body.page_context || "").trim().slice(0, 200) || null;

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO app_feedback (user_id, category, message, page_context, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'new', datetime('now'), datetime('now'))`
    )
      .bind(user.id, category, message, pageContext)
      .run();
    const id = Number(ins.meta.last_row_id);

    const reviewers = await usersByRoles(c.env.DB, ["admin", "office", "supervisor"]);
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        reviewers.filter((uid) => uid !== user.id),
        "app_feedback",
        `App feedback · ${user.display_name}`,
        message.slice(0, 160),
        { type: "app_feedback", id }
      ).catch(() => {
        /* non-fatal */
      })
    );

    await writeAudit(c.env.DB, user, "create", "app_feedback", id, category);

    const row = await c.env.DB.prepare(`SELECT * FROM app_feedback WHERE id = ?`)
      .bind(id)
      .first();
    return c.json({ ok: true, item: row }, 201);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

api.patch("/feedback/:id", async (c) => {
  const user = c.get("user");
  if (!isFeedbackReviewer(user.role)) {
    return c.json({ error: "Office or admin only" }, 403);
  }
  await ensureAppFeedbackTables(c.env.DB);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{
    status?: string;
    admin_note?: string | null;
  }>();

  const before = await c.env.DB.prepare(`SELECT * FROM app_feedback WHERE id = ?`)
    .bind(id)
    .first<{ id: number; user_id: number; status: string }>();
  if (!before) return c.json({ error: "Not found" }, 404);

  const nextStatus = body.status != null ? String(body.status).trim().toLowerCase() : null;
  if (nextStatus && !FEEDBACK_STATUSES.has(nextStatus)) {
    return c.json({ error: "Invalid status" }, 400);
  }

  const sets: string[] = ["updated_at = datetime('now')"];
  const binds: unknown[] = [];
  if (nextStatus) {
    sets.push("status = ?");
    binds.push(nextStatus);
    if (nextStatus !== "new") {
      sets.push("reviewed_by_user_id = ?");
      binds.push(user.id);
      sets.push("reviewed_at = datetime('now')");
    }
  }
  if (body.admin_note !== undefined) {
    sets.push("admin_note = ?");
    binds.push(body.admin_note === null || body.admin_note === "" ? null : String(body.admin_note).trim());
  }
  binds.push(id);

  await c.env.DB.prepare(`UPDATE app_feedback SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();

  // Optional: thank the employee when marked done
  if (nextStatus === "done" && before.user_id !== user.id) {
    scheduleWaitUntil(
      c,
      notifyUsers(
        c.env.DB,
        [before.user_id],
        "app_feedback_update",
        "Thanks for your app feedback",
        "We reviewed your suggestion. Keep the ideas coming.",
        { type: "app_feedback", id }
      ).catch(() => {
        /* non-fatal */
      })
    );
  }

  await writeAudit(c.env.DB, user, "update", "app_feedback", id, nextStatus || "note");
  const row = await c.env.DB.prepare(
    `SELECT f.*, u.display_name as employee_name, r.display_name as reviewed_by_name
     FROM app_feedback f
     JOIN users u ON u.id = f.user_id
     LEFT JOIN users r ON r.id = f.reviewed_by_user_id
     WHERE f.id = ?`
  )
    .bind(id)
    .first();
  return c.json({ ok: true, item: row });
});



app.route("/api", api);

// SPA fallback via assets binding — never cache HTML so phones always get the latest shell
app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!c.env.ASSETS) {
    return c.text("Frontend not built. Run npm run build.", 404);
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const path = new URL(c.req.url).pathname;
  const ct = res.headers.get("Content-Type") || "";
  const headers = new Headers(res.headers);
  const isAsset = path.startsWith("/assets/");
  const isHtml =
    ct.includes("text/html") ||
    path === "/" ||
    path.endsWith(".html") ||
    path.endsWith(".webmanifest");

  if (isHtml) {
    // Critical: installed PWAs / CF edge were stuck on old HTML after deploys
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    // Cloudflare respects CDN-Cache-Control for edge; without it, CF-Cache-Status: HIT can serve stale HTML
    headers.set("CDN-Cache-Control", "no-store");
    headers.set("Cloudflare-CDN-Cache-Control", "no-store");
    headers.set("Pragma", "no-cache");
    headers.set("Expires", "0");
    headers.set("Surrogate-Control", "no-store");
  } else if (isAsset) {
    // Hashed bundles can be cached forever
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
});

// Explicit Workers entry so ExecutionContext is always passed into Hono
// (needed for waitUntil / background alert fan-out).
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  /** Morning shop bring-in reminders + weekly checks + PTO anniversary grants. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          await notifyShopBringInsToday(env.DB, env);
        } catch {
          /* best-effort */
        }
        try {
          await notifyWeeklyChecksDue(env.DB);
        } catch {
          /* best-effort */
        }
        try {
          await notifyOpsActionItems(env.DB);
        } catch {
          /* best-effort */
        }
        try {
          await applyDueAnniversariesAll(env.DB);
        } catch {
          /* best-effort PTO anniversary refresh */
        }
      })()
    );
  },
};
