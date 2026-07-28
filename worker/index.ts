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
  notifyOpsActionItems,
  notifyUsers,
  notifyWeeklyChecksDue,
  usersByRoles,
} from "./notifications";
import { logSms, normalizePhone, sendSms, smsConfigured } from "./sms";
import {
  alertFleetIncident,
  fanOutAlert,
  sendDiscord,
  type AlertPayload,
} from "./alertChannels";
import { getOcrHints, recordOcrFeedback, type OcrFieldSnapshot } from "./ocrLearn";
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
  // Never block API (or login) if bootstrap/DB is slow
  try {
    await Promise.race([
      ensureBootstrapAdmin(c.env),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
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
 * Fire-and-forget (void p) is killed by Cloudflare when the response finishes —
 * that was why emergency push never ran after we moved ntfy off the request path.
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

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>();
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return c.json({ error: "Username and password required" }, 400);

  const user = await c.env.DB.prepare(
    `SELECT * FROM users WHERE (username = ? OR email = ?) AND active = 1`
  )
    .bind(username, username)
    .first<UserRow>();

  if (!user || !user.password_hash || !user.password_salt) {
    return c.json({ error: "Invalid credentials" }, 401);
  }
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
    if (username !== String(row.username).toLowerCase()) {
      return c.json(
        { error: "Username does not match. Use the exact username your admin gave you." },
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
        path.endsWith("/auth/change-password");
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
api.get("/live/positions", async (c) => {
  const force = c.req.query("refresh") === "1";
  try {
    const data = await getLivePositions(c.env, force);
    const staleHours = Number(await getSetting(c.env.DB, "gps_stale_hours", "6"));
    const vrows = await c.env.DB.prepare(
      `SELECT id, unit_number, status, gps_tracker, gps_status, dash_cam_status, cam_type
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
api.get("/tracking/health", async (c) => {
  try {
    const staleHours = Number(await getSetting(c.env.DB, "gps_stale_hours", "6"));
    const data = await getLivePositions(c.env, c.req.query("refresh") === "1");
    const vrows = await c.env.DB.prepare(
      `SELECT id, unit_number, status, gps_tracker, gps_status, dash_cam_status, cam_type
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
    `SELECT i.id, i.title, i.status, i.scheduled_date, i.severity, v.unit_number
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
        `SELECT id, unit_number, status, gps_tracker, gps_status, dash_cam_status, cam_type
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
    const w = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM warranty_claims
       WHERE status IN ('dropped_off','claim_submitted','return_to_vendor','delivered')`
    ).first<{ c: number }>();
    openWarranties = w?.c ?? 0;
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
    const vr = await c.env.DB.prepare(
      `SELECT COUNT(*) as c FROM vendor_run_lines WHERE status = 'waiting'`
    ).first<{ c: number }>();
    openVendorRuns = vr?.c ?? 0;
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
  // gas_card_last4 = most-used card on their fuel history (drivers have their own gas cards)
  const rows = await c.env.DB.prepare(
    all
      ? `SELECT e.*,
          (SELECT f.card_last4 FROM fuel_entries f
           WHERE f.employee_id = e.id
             AND f.card_last4 IS NOT NULL AND length(trim(f.card_last4)) = 4
           GROUP BY f.card_last4
           ORDER BY COUNT(*) DESC, MAX(f.id) DESC
           LIMIT 1) as gas_card_last4
         FROM employees e
         ORDER BY e.name`
      : `SELECT e.*,
          (SELECT f.card_last4 FROM fuel_entries f
           WHERE f.employee_id = e.id
             AND f.card_last4 IS NOT NULL AND length(trim(f.card_last4)) = 4
           GROUP BY f.card_last4
           ORDER BY COUNT(*) DESC, MAX(f.id) DESC
           LIMIT 1) as gas_card_last4
         FROM employees e
         WHERE e.active = 1
         ORDER BY e.name`
  ).all();
  return c.json({ employees: rows.results });
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
    /** Skip match warning and create anyway */
    force?: boolean;
    /** After create, link this existing user login to the new employee */
    link_user_id?: number | null;
  }>();
  if (!body.name?.trim()) return c.json({ error: "Name required" }, 400);
  const name = body.name.trim();
  const phone = body.phone?.trim() || null;

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

  const result = await c.env.DB.prepare(
    "INSERT INTO employees (name, phone, notes) VALUES (?, ?, ?)"
  )
    .bind(name, phone, body.notes || null)
    .run();
  const id = Number(result.meta.last_row_id);

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
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    name?: string;
    notes?: string;
    phone?: string;
    active?: boolean;
    rides_with_employee_id?: number | null;
  }>();

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
      // Keep link one-way primary: clear others pointing at this person incorrectly is optional
      // If partner set, also set partner's rides_with back to this person when empty? Keep one-way only.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such column/i.test(msg)) {
        return c.json({ error: "Run migration 036_crew_vehicle_assign.sql" }, 503);
      }
      throw e;
    }
  }

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
  const after = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  await writeAudit(c.env.DB, c.get("user"), "update", "employee", id, "Updated employee", before, after);
  return c.json({ employee: after });
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
    if (empId || helperId) {
      const ids = [empId, helperId].filter((x): x is number => x != null);
      if (ids.length) {
        const ph = ids.map(() => "?").join(",");
        await c.env.DB.prepare(
          `UPDATE vehicles SET
             assigned_employee_id = CASE WHEN assigned_employee_id IN (${ph}) THEN NULL ELSE assigned_employee_id END,
             helper_employee_id = CASE WHEN helper_employee_id IN (${ph}) THEN NULL ELSE helper_employee_id END,
             assigned_driver = CASE
               WHEN assigned_employee_id IN (${ph}) OR helper_employee_id IN (${ph}) THEN NULL
               ELSE assigned_driver
             END,
             updated_at = datetime('now')
           WHERE id != ? AND status != 'retired'`
        )
          .bind(...ids, ...ids, ...ids, ...ids, vehicleId)
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
        ? `Cleared assignment on unit ${vehicle.unit_number}`
        : `Assigned ${driverName} → unit ${vehicle.unit_number}`
    );

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
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO vehicles (
        unit_number, plate, year, make, model, vin, status, current_odometer,
        assigned_driver, phone, insurance_card,
        dash_cam_status, cam_type, gps_tracker,
        registration_expires, inspection_expires,
        insurance_expires, modifications, notes, gps_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        unit,
        body.plate || null,
        body.year || null,
        body.make || null,
        body.model || null,
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
        body.gps_status || "n/a"
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
  ] as const;

  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      if (f === "insurance_expires" && !personal) continue;
      sets.push(`${f} = ?`);
      values.push(body[f] === "" ? null : body[f]);
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

  const result = await c.env.DB.prepare(
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

// ——— Parts purchase receipts (company card / vendor invoice photos) ———

api.get("/parts-purchases", requireRoles(ROLE_PERMS.viewPartsPurchase), async (c) => {
  const user = c.get("user");
  const mine = c.req.query("mine") === "1";
  try {
    let sql = `SELECT p.*, u.display_name as purchased_by_name
       FROM parts_purchase_receipts p
       LEFT JOIN users u ON u.id = p.purchased_by_user_id`;
    const binds: unknown[] = [];
    if (mine || user.role === "driver") {
      sql += ` WHERE p.purchased_by_user_id = ?`;
      binds.push(user.id);
    }
    sql += ` ORDER BY p.created_at DESC LIMIT 100`;
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

/** Vendor name suggestions for datalist (part_vendors + recent tickets + prior receipts). */
api.get("/parts-purchases/vendors", requireRoles(ROLE_PERMS.logPartsPurchase), async (c) => {
  const names = new Set<string>();
  try {
    const a = await c.env.DB.prepare(
      `SELECT DISTINCT vendor_name as n FROM part_vendors WHERE vendor_name IS NOT NULL AND trim(vendor_name) != '' LIMIT 80`
    ).all<{ n: string }>();
    for (const r of a.results || []) if (r.n) names.add(r.n.trim());
  } catch {
    /* table may not exist */
  }
  try {
    const b = await c.env.DB.prepare(
      `SELECT DISTINCT vendor_name as n FROM part_pickup_tickets WHERE vendor_name IS NOT NULL AND trim(vendor_name) != '' ORDER BY id DESC LIMIT 40`
    ).all<{ n: string }>();
    for (const r of b.results || []) if (r.n) names.add(r.n.trim());
  } catch {
    /* optional */
  }
  try {
    const c2 = await c.env.DB.prepare(
      `SELECT DISTINCT vendor_name as n FROM parts_purchase_receipts WHERE vendor_name IS NOT NULL ORDER BY id DESC LIMIT 40`
    ).all<{ n: string }>();
    for (const r of c2.results || []) if (r.n) names.add(r.n.trim());
  } catch {
    /* optional */
  }
  return c.json({ vendors: [...names].sort((x, y) => x.localeCompare(y)).slice(0, 120) });
});

api.post("/parts-purchases", requireRoles(ROLE_PERMS.logPartsPurchase), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    purchase_kind?: "vendor" | "other";
    vendor_name?: string;
    invoice_number?: string;
    purchase_date?: string;
    total_cost?: number | null;
    card_last4?: string;
    notes?: string;
    receipt_key?: string;
    ocr_feedback?: {
      raw_text?: string;
      ocr?: OcrFieldSnapshot;
      final?: OcrFieldSnapshot;
    };
  }>();

  const vendorName = (body.vendor_name || "").trim();
  const receiptKey = (body.receipt_key || "").trim();
  if (!vendorName) return c.json({ error: "Vendor / store name is required" }, 400);
  if (!receiptKey) {
    return c.json({ error: "Receipt photo is required. Take a picture of the invoice or packing slip." }, 400);
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

  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO parts_purchase_receipts (
         purchased_by_user_id, purchase_kind, vendor_name, invoice_number,
         purchase_date, total_cost, card_last4, notes, receipt_key, ocr_raw
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        body.ocr_feedback?.raw_text ? body.ocr_feedback.raw_text.slice(0, 8000) : null
      )
      .run();

    const id = Number(r.meta.last_row_id);
    const row = await c.env.DB.prepare(
      `SELECT p.*, u.display_name as purchased_by_name
       FROM parts_purchase_receipts p
       LEFT JOIN users u ON u.id = p.purchased_by_user_id
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

    await writeAudit(
      c.env.DB,
      user,
      "create",
      "parts_purchase",
      id,
      `${kind}: ${vendorName}${invoice ? ` inv ${invoice}` : ""}`,
      null,
      row
    );

    // Notify office/warehouse for visibility
    try {
      const targets = await usersByRoles(c.env.DB, ["admin", "office", "warehouse"]);
      await notifyUsers(
        c.env.DB,
        targets.filter((tid) => tid !== user.id),
        "parts_purchase",
        "Parts receipt submitted",
        `${user.display_name || "Tech"}: ${vendorName}${invoice ? ` · inv ${invoice}` : ""}${total != null ? ` · $${total.toFixed(2)}` : ""}`,
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
    "warranty-dropoffs",
    "warranty-nameplates",
    "asset-photos",
    "issue-photos",
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
    `SELECT a.*, v.unit_number, f.odometer, f.fuel_date, e.name as employee_name
     FROM mileage_alerts a
     JOIN vehicles v ON v.id = a.vehicle_id
     JOIN fuel_entries f ON f.id = a.fuel_entry_id
     JOIN employees e ON e.id = f.employee_id
     WHERE a.status = ?${sc?.clause || ""}
     ORDER BY
       CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       a.created_at DESC`
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

// Issues
api.get("/issues", async (c) => {
  const status = c.req.query("status");
  const report = c.req.query("report");
  let sql = `SELECT i.*, v.unit_number, u.display_name as reporter_name
    FROM vehicle_issues i
    JOIN vehicles v ON v.id = i.vehicle_id
    JOIN users u ON u.id = i.reported_by_user_id WHERE 1=1`;
  const binds: unknown[] = [];
  if (report === "schedule") {
    sql += " AND i.status IN ('open','scheduled','in_progress')";
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
  sql += " ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at DESC";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ issues: rows.results });
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
  }>();
  if (!body.vehicle_id) {
    return c.json({ error: "vehicle_id required" }, 400);
  }
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
    // Still hand client_push so a second intentional tap can re-ping phones
    // without creating another ticket (shop may have missed the first push).
    const unitDup = await c.env.DB.prepare("SELECT unit_number FROM vehicles WHERE id = ?")
      .bind(body.vehicle_id)
      .first<{ unit_number: string }>();
    const unitNoDup = unitDup?.unit_number || "?";
    const ntfyTopicDup =
      ((await getSetting(c.env.DB, "ntfy_topic", "totalassurance")) || "totalassurance").trim() ||
      "totalassurance";
    let ntfyServerDup =
      ((await getSetting(c.env.DB, "ntfy_server", "https://ntfy.sh")) || "https://ntfy.sh")
        .trim()
        .replace(/\/$/, "") || "https://ntfy.sh";
    if (!/^https?:\/\//i.test(ntfyServerDup)) ntfyServerDup = `https://${ntfyServerDup}`;
    const shortDup = (body.description || "").trim().slice(0, 120);
    return c.json({
      issue: recentDup,
      emergency: isEmergency,
      duplicate: true,
      ntfy: false,
      ntfy_retrying: false,
      client_push: {
        server: ntfyServerDup,
        topic: ntfyTopicDup,
        title: isEmergency
          ? `EMERGENCY Unit ${unitNoDup}: ${title}`
          : `Repair Unit ${unitNoDup}: ${title}`,
        message: [
          `From: ${user.display_name}`,
          shortDup || (isEmergency ? "Needs help now — open the fleet app." : "New shop request."),
          "(re-notify — same open request)",
        ].join("\n"),
        priority: isEmergency ? 5 : 4,
        tags: isEmergency ? ["rotating_light", "exclamation"] : ["wrench"],
      },
      message: isEmergency
        ? "Emergency already reported — re-sending phone push. Do not create a new ticket."
        : "Same request already submitted — re-sending phone push.",
    });
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO vehicle_issues
      (vehicle_id, reported_by_user_id, severity, title, description, photo_key,
       issue_category, is_emergency)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

  // In-app first (fast) — mechanics / office / admin always get a notification row
  const notifyRoles = ["mechanic", "admin", "office"] as string[];
  const techs = await usersByRoles(c.env.DB, notifyRoles);
  const alertBody =
    body.description ||
    (isEmergency
      ? "Driver reported an emergency (e.g. flat). Open Notifications / Repairs now."
      : "New driver repair request — open Repairs in the app.");
  await notifyUsers(
    c.env.DB,
    techs,
    isEmergency ? "flat_emergency" : "repair_request",
    isEmergency
      ? `EMERGENCY · Unit ${unit?.unit_number || "?"} · ${title}`
      : `Repair request · Unit ${unit?.unit_number || "?"} · ${title}`,
    alertBody,
    { type: "vehicle_issue", id }
  );

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
  const shortDesc = (body.description || "").trim().slice(0, 120);

  // Phone push payload (same channel as Settings → Send test)
  const pushPayload: AlertPayload = {
    title: isEmergency
      ? `EMERGENCY Unit ${unitNo}: ${title}`
      : `Repair Unit ${unitNo}: ${title}`,
    body: [
      `From: ${user.display_name}`,
      shortDesc ||
        (isEmergency ? "Needs help now — open the fleet app." : "New shop request."),
      isEmergency
        ? "Open Notifications / Repairs in Field App ASAP."
        : "Open Repairs & shop board.",
    ].join("\n"),
    priority: isEmergency ? "urgent" : "high",
    tags: isEmergency ? ["rotating_light", "exclamation"] : ["wrench"],
  };

  // Phone push: ONE notification only.
  // Driver's browser publishes to ntfy (reliable). Server does NOT also push the
  // same alert — that was causing 2–3 duplicate phone buzzes (client + worker
  // retry + nearby/no-GPS fan-out all hit the same topic).
  const ntfyTopic =
    ((await getSetting(c.env.DB, "ntfy_topic", "totalassurance")) || "totalassurance").trim() ||
    "totalassurance";
  let ntfyServer =
    ((await getSetting(c.env.DB, "ntfy_server", "https://ntfy.sh")) || "https://ntfy.sh")
      .trim()
      .replace(/\/$/, "") || "https://ntfy.sh";
  if (!/^https?:\/\//i.test(ntfyServer)) ntfyServer = `https://${ntfyServer}`;

  const clientPush = {
    server: ntfyServer,
    topic: ntfyTopic,
    title: pushPayload.title,
    message: pushPayload.body,
    priority: isEmergency ? 5 : 4,
    tags: pushPayload.tags || [],
  };

  // Background: nearby-driver in-app alerts only (no extra ntfy — same topic = dupes)
  const nearbyJob = alertFleetIncident(c.env, c.env.DB, {
    fromUserId: user.id,
    fromName: user.display_name,
    unitNumber: unitNo,
    vehicleId: body.vehicle_id,
    issueId: id,
    title,
    description: body.description,
    isEmergency,
    appBaseUrl: base,
    skipMainPush: true,
    skipNtfy: true,
  }).catch(() => null);

  // Optional Discord only (not ntfy) so office chat still gets a line without double phone push
  const discordOnlyJob = sendDiscord(c.env.DB, pushPayload).catch(() => null);

  scheduleWaitUntil(c, nearbyJob);
  scheduleWaitUntil(c, discordOnlyJob);

  const issue = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first();
  return c.json(
    {
      issue,
      emergency: isEmergency,
      notified_user_ids: techs,
      /** Browser publishes exactly once — server will not ntfy the same alert */
      client_push: clientPush,
      ntfy: false,
      ntfy_retrying: false,
      ntfy_detail: "client_push_only",
      message: isEmergency
        ? "Emergency dispatched — shop notified in the app. Sending phone push…"
        : "Repair request submitted — shop notified. Sending phone push…",
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
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    values.push(id);
    await c.env.DB.prepare(`UPDATE vehicle_issues SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();
  }
  const after = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first();

  if (recordOil || body.mechanic_diagnosis === "Oil change") {
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

  // Downtime accountability when work starts / ends
  const nextStatus = String(body.status || before.status);
  if (
    (nextStatus === "in_progress" || nextStatus === "scheduled") &&
    before.status !== "in_progress" &&
    before.status !== "scheduled"
  ) {
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
        .bind(before.vehicle_id, id, before.title, user.id, body.schedule_notes || null)
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

  await writeAudit(c.env.DB, user, "update", "vehicle_issue", id, "Updated issue", before, after);
  return c.json({ issue: after });
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
         WHEN s.next_due_odometer IS NOT NULL AND v.current_odometer IS NOT NULL
              AND v.current_odometer >= s.next_due_odometer THEN 1
         WHEN s.next_due_odometer IS NOT NULL AND v.current_odometer IS NOT NULL
              AND v.current_odometer >= s.next_due_odometer - 500 THEN 1
         WHEN s.id IS NULL THEN 1
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
  // Light-touch: weekly checks + aging warranties / pickups / equipment
  try {
    await notifyWeeklyChecksDue(c.env.DB);
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

api.post("/reviews", requireRoles(["admin", "office"]), async (c) => {
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

function warrantyDaysOpen(droppedOffAt: string, processedAt: string | null): number {
  const start = new Date(droppedOffAt.includes("T") ? droppedOffAt : droppedOffAt.replace(" ", "T") + "Z");
  const end = processedAt
    ? new Date(processedAt.includes("T") ? processedAt : processedAt.replace(" ", "T") + "Z")
    : new Date();
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)));
}

api.get("/warranties", async (c) => {
  const status = (c.req.query("status") || "").trim();
  try {
    let sql = `SELECT w.*,
        du.display_name as dropped_off_by_name,
        pu.display_name as processed_by_name
       FROM warranty_claims w
       LEFT JOIN users du ON du.id = w.dropped_off_by_user_id
       LEFT JOIN users pu ON pu.id = w.processed_by_user_id`;
    const binds: unknown[] = [];
    const OPEN_WARRANTY = `('dropped_off','claim_submitted','return_to_vendor','delivered')`;
    const q = (c.req.query("q") || "").trim().toLowerCase();
    // Text query searches ALL statuses so typing "005" finds W0726-005 even if approved.
    // Without q, honor open / vendor / decided tabs.
    if (!q) {
      if (status === "open") {
        sql += ` WHERE w.status IN ${OPEN_WARRANTY}`;
      } else if (status === "vendor" || status === "vendor_waiting" || status === "waiting_vendor") {
        sql += ` WHERE w.status IN ('return_to_vendor','delivered')`;
      } else if (status === "decided" || status === "closed") {
        sql += ` WHERE w.status IN ('approved','rejected')`;
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
        ELSE 6
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
      const days = warrantyDaysOpen(String(r.dropped_off_at), r.processed_at ? String(r.processed_at) : null);
      const open = isOpenW(String(r.status));
      return {
        ...r,
        days_open: days,
        overdue: open && days >= 7,
        urgent: open && days >= 14,
      };
    });
    const openCount = list.filter((r: { status: string }) => isOpenW(String(r.status))).length;
    return c.json({ warranties: list, open_count: openCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ warranties: [], open_count: 0 });
    return c.json({ error: msg }, 500);
  }
});

/** Save warranty photo into R2 or receipt_blobs; returns storage key. */
async function saveWarrantyPhoto(
  env: Env,
  file: File,
  folder: "warranty-dropoffs" | "warranty-nameplates" = "warranty-dropoffs"
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
  let ocrFeedback: {
    raw_text?: string;
    ocr?: OcrFieldSnapshot;
    final?: OcrFieldSnapshot;
  } | null = null;

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
      photoKey = (body.dropoff_photo_key || "").trim();
      nameplateKey = (body.nameplate_photo_key || "").trim();
      ocrFeedback = body.ocr_feedback || null;
    }

    if (!partName) return c.json({ error: "Part name is required" }, 400);
    if (!modelNumber) {
      return c.json(
        { error: "Unit model number is required (from the unit the part was removed from)." },
        400
      );
    }
    if (!serialNumber) {
      return c.json(
        { error: "Unit serial number is required (from the unit the part was removed from)." },
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

    const logNumber = await nextWarrantyLogNumber(c.env.DB);
    let r;
    try {
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
    } catch (colErr) {
      const msg = colErr instanceof Error ? colErr.message : String(colErr);
      // Fallback without nameplate column (migration 038 not applied yet)
      if (/nameplate_photo|no such column/i.test(msg)) {
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
    needs_vendor_return?: boolean;
    vendor_name?: string;
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

  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];

  if (body.notes !== undefined) {
    sets.push("notes = ?");
    vals.push(body.notes?.trim() || null);
  }
  if (body.vendor_name !== undefined && canProcess) {
    sets.push("vendor_name = ?");
    vals.push(body.vendor_name?.trim() || null);
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
    const allowed = [
      "dropped_off",
      "claim_submitted",
      "return_to_vendor",
      "delivered",
      "approved",
      "rejected",
    ];
    if (!allowed.includes(next)) return c.json({ error: "Invalid status" }, 400);
    newStatus = next;
    sets.push("status = ?");
    vals.push(next);
    if (next === "claim_submitted") {
      sets.push("claim_submitted_at = COALESCE(claim_submitted_at, datetime('now'))");
    }
    if (next === "return_to_vendor") {
      sets.push("needs_vendor_return = 1");
      sets.push("shipped_by_user_id = COALESCE(shipped_by_user_id, ?)");
      vals.push(user.id);
    }
    // Credit decision closes the claim — only then set processed_at
    if (next === "approved" || next === "rejected") {
      sets.push("processed_at = datetime('now')");
      sets.push("processed_by_user_id = ?");
      vals.push(user.id);
    }
  } else if (body.claim_submitted && canProcess) {
    newStatus = "claim_submitted";
    sets.push("status = 'claim_submitted'");
    sets.push("claim_submitted_at = COALESCE(claim_submitted_at, datetime('now'))");
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
    if (/no such column|rma_number|credit_amount|tracking|shipped_by/i.test(msg)) {
      const safeSets = sets.filter(
        (s) =>
          !/rma_number|credit_amount|tracking_number|shipped_by_user_id/.test(s)
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

  if (newStatus === "approved" && before.dropped_off_by_user_id) {
    await notifyUsers(
      c.env.DB,
      [before.dropped_off_by_user_id],
      "warranty_approved",
      `Warranty ${before.log_number} approved`,
      `${before.part_name} claim was approved.`,
      { type: "warranty", id }
    );
  }
  if (newStatus === "rejected" && before.dropped_off_by_user_id) {
    await notifyUsers(
      c.env.DB,
      [before.dropped_off_by_user_id],
      "warranty_rejected",
      `Warranty ${before.log_number} rejected`,
      `${before.part_name} claim was rejected.`,
      { type: "warranty", id }
    );
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
    const roster = (users.results || []).map((u) => ({
      ...u,
      acknowledged: ackByUser.has(u.id),
      acknowledged_at: (ackByUser.get(u.id) as { acknowledged_at?: string } | undefined)
        ?.acknowledged_at,
    }));
    return c.json({ handbook: book, roster });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) return c.json({ handbook: null, roster: [] });
    return c.json({ error: msg }, 500);
  }
});

api.post("/handbook", requireRoles(["admin", "office"]), async (c) => {
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
  const { DEFAULT_NTFY_TOPIC } = await import("./alertChannels");
  let ntfyTopic = (await getSetting(c.env.DB, "ntfy_topic", DEFAULT_NTFY_TOPIC)).trim();
  // Always have a simple default ready so phones can subscribe immediately
  if (!ntfyTopic) {
    ntfyTopic = DEFAULT_NTFY_TOPIC;
    await setSetting(c.env.DB, "ntfy_topic", DEFAULT_NTFY_TOPIC);
  }
  const ntfyServer = await getSetting(c.env.DB, "ntfy_server", "https://ntfy.sh");
  const discord = await getSetting(c.env.DB, "discord_webhook_url", "");
  const canSeeShop = ["admin", "office", "mechanic"].includes(me.role);
  const lastNtfy = canSeeShop
    ? await getSetting(c.env.DB, "last_ntfy_status", "")
    : "";
  return c.json({
    configured: smsConfigured(c.env),
    shop_phone_set: Boolean(normalizePhone(shop)),
    shop_phone: canSeeShop ? shop : undefined,
    mechanic_phone: canSeeShop ? mechanic : undefined,
    office_phone: canSeeShop ? office : undefined,
    free_alerts: {
      ntfy: true,
      ntfy_topic: canSeeShop ? ntfyTopic : DEFAULT_NTFY_TOPIC,
      ntfy_server: canSeeShop ? ntfyServer || "https://ntfy.sh" : undefined,
      discord: Boolean(discord.trim()),
      in_app: true,
      /** One word everyone types in the ntfy app */
      subscribe_word: ntfyTopic || DEFAULT_NTFY_TOPIC,
      last_ntfy_status: lastNtfy || undefined,
    },
  });
});

/** Shop line for driver texts / emergency SMS — admin, office, or mechanic can update */
api.put("/sms/shop-phone", requireRoles(["admin", "office", "mechanic"] as Role[]), async (c) => {
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

/** Free alert channels: ntfy push + Discord webhook (admin/office/mechanic) */
api.put("/alerts/channels", requireRoles(["admin", "office", "mechanic"] as Role[]), async (c) => {
  const body = await c.req.json<{
    ntfy_topic?: string;
    ntfy_server?: string;
    ntfy_token?: string;
    discord_webhook_url?: string;
  }>();
  if (body.ntfy_topic !== undefined) {
    await setSetting(c.env.DB, "ntfy_topic", body.ntfy_topic.trim());
  }
  if (body.ntfy_server !== undefined) {
    await setSetting(c.env.DB, "ntfy_server", body.ntfy_server.trim() || "https://ntfy.sh");
  }
  if (body.ntfy_token !== undefined) {
    await setSetting(c.env.DB, "ntfy_token", body.ntfy_token.trim());
  }
  if (body.discord_webhook_url !== undefined) {
    await setSetting(c.env.DB, "discord_webhook_url", body.discord_webhook_url.trim());
  }
  await writeAudit(c.env.DB, c.get("user"), "update", "settings", "alert_channels", "Updated free alert channels");
  return c.json({ ok: true });
});

/**
 * Diagnostic test push — admin test channel only (totalassurance-admin).
 * Real emergencies stay on the fleet topic (totalassurance) so the mechanic is not buzzed.
 */
api.post("/alerts/test", requireRoles(["admin", "office", "mechanic"] as Role[]), async (c) => {
  const me = c.get("user");
  const { DEFAULT_NTFY_TOPIC, NTFY_ADMIN_TEST_TOPIC } = await import("./alertChannels");

  const fleetTopic =
    ((await getSetting(c.env.DB, "ntfy_topic", DEFAULT_NTFY_TOPIC)) || DEFAULT_NTFY_TOPIC).trim() ||
    DEFAULT_NTFY_TOPIC;
  const testTopic = NTFY_ADMIN_TEST_TOPIC;
  let server =
    ((await getSetting(c.env.DB, "ntfy_server", "https://ntfy.sh")) || "https://ntfy.sh")
      .trim()
      .replace(/\/$/, "") || "https://ntfy.sh";
  if (!/^https?:\/\//i.test(server)) server = `https://${server}`;

  const title = "TA Fleet admin test";
  const body = `Admin test from ${me.display_name}. Topic: ${testTopic}. Fleet “${fleetTopic}” is NOT notified (mechanic stays quiet).`;

  const clientPush = {
    server,
    topic: testTopic,
    title,
    message: body,
    priority: 5,
    tags: ["rotating_light", "warning"],
  };

  let serverNtfy = false;
  let details: string[] = [];
  try {
    const r = await fanOutAlert(
      c.env,
      c.env.DB,
      {
        title,
        body,
        priority: "urgent",
        tags: ["rotating_light", "warning"],
      },
      {
        fromUserId: me.id,
        context: "test_alert",
        ntfyAttempts: 1,
        ntfyTopic: testTopic,
        skipDiscord: true,
      }
    );
    serverNtfy = r.ntfy;
    details = r.details || [];
  } catch (e) {
    details = [e instanceof Error ? e.message : "server push error"];
  }

  return c.json({
    ok: true,
    ntfy: serverNtfy,
    client_push: clientPush,
    test_topic: testTopic,
    fleet_topic: fleetTopic,
    admin_topic: testTopic,
    discord: false,
    sms: 0,
    details,
    hint: `Test → “${testTopic}” only. Subscribe to that word in ntfy for quiet tests. Fleet “${fleetTopic}” is for real emergencies.`,
  });
});

/** Client reports whether browser-side ntfy publish succeeded (diagnostics). */
api.post("/alerts/client-push-result", async (c) => {
  const body = await c.req.json<{ ok?: boolean; detail?: string }>().catch(() => ({}));
  const detail = String(body.detail || (body.ok ? "client ok" : "client fail")).slice(0, 280);
  await setSetting(
    c.env.DB,
    "last_ntfy_status",
    `${new Date().toISOString()} | client: ${body.ok ? "ok" : "fail"} — ${detail}`
  );
  return c.json({ ok: true });
});

/** Per-role ntfy checklist (channels + setup steps) with “I already have this” acks. */
api.get("/alerts/my-subscriptions", async (c) => {
  const me = c.get("user");
  const { buildSubscriptionList } = await import("./ntfySubscriptions");
  const list = await buildSubscriptionList(c.env.DB, me.id, me.role);
  return c.json({
    role: me.role,
    ...list,
    note:
      "ntfy uses a shared word (channel), not your phone number. Everyone who must get fleet pushes needs the same fleet channel.",
  });
});

api.post("/alerts/my-subscriptions/ack", async (c) => {
  const me = c.get("user");
  const body = await c.req.json<{ id?: string; done?: boolean }>().catch(() => ({}));
  const id = (body.id || "").trim();
  if (!id) return c.json({ error: "id required" }, 400);

  const {
    defsForRole,
    loadAcks,
    saveAcks,
    buildSubscriptionList,
  } = await import("./ntfySubscriptions");
  const allowed = new Set(defsForRole(me.role).map((d) => d.id));
  if (!allowed.has(id)) return c.json({ error: "Not required for your role" }, 400);

  const acks = await loadAcks(c.env.DB, me.id);
  const markDone = body.done !== false;
  if (markDone) {
    acks[id] = new Date().toISOString();
  } else {
    delete acks[id];
  }
  await saveAcks(c.env.DB, me.id, acks);
  const list = await buildSubscriptionList(c.env.DB, me.id, me.role);
  return c.json({ ok: true, ...list });
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
  } else if (["mechanic", "admin", "office"].includes(me.role)) {
    const drivers = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.phone, u.role, u.employee_id, e.name as employee_name
       FROM users u
       LEFT JOIN employees e ON e.id = u.employee_id
       WHERE u.active = 1 AND u.role = 'driver'
         AND u.phone IS NOT NULL AND TRIM(u.phone) != ''
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
        role: "driver",
        unit_number: unit,
      });
    }
  }

  return c.json({
    configured: smsConfigured(c.env),
    contacts,
  });
});

api.post("/sms/send", async (c) => {
  const me = c.get("user");
  if (!["driver", "mechanic", "admin", "office"].includes(me.role)) {
    return c.json({ error: "Not allowed to send SMS" }, 403);
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
    // Drivers may only text shop/mechanic roles
    if (me.role === "driver" && !["mechanic", "admin", "office"].includes(target.role)) {
      return c.json({ error: "You can only text the shop / mechanic" }, 403);
    }
    // Mechanic / office text drivers; admin can text anyone with a phone on file
    if (["mechanic", "office"].includes(me.role) && target.role !== "driver") {
      return c.json({ error: "Shop can text drivers who have a phone on file" }, 403);
    }
    toPhone = normalizePhone(target.phone);
    toUserId = target.id;
  } else if (body.to_phone) {
    // Drivers texting shop number from settings
    if (me.role === "driver") {
      const shop = await getSetting(c.env.DB, "shop_sms_phone", "");
      const shopN = normalizePhone(shop);
      const want = normalizePhone(body.to_phone);
      if (!shopN || want !== shopN) {
        return c.json({ error: "Drivers can only text the configured shop number" }, 403);
      }
      toPhone = shopN;
    } else if (["admin", "office", "mechanic"].includes(me.role)) {
      toPhone = normalizePhone(body.to_phone);
    }
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
  let createdIssueId: number | null = null;
  const shouldOpenIssue =
    body.create_issue_on_fail !== false &&
    (body.overall_status === "fail" || body.overall_status === "pass_with_notes");
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
  } else if (
    body.create_issue_on_fail !== false &&
    body.overall_status === "pass_with_notes" &&
    body.notes?.trim()
  ) {
    // Attention items with notes still open a lower-severity ticket
    const issue = await c.env.DB.prepare(
      `INSERT INTO vehicle_issues (vehicle_id, reported_by_user_id, severity, title, description, status)
       VALUES (?, ?, 'medium', ?, ?, 'open')`
    )
      .bind(
        body.vehicle_id,
        user.id,
        `Weekly check note — unit check`,
        body.notes.trim()
      )
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
 * Printable warehouse directory: every active part # + linked package barcodes.
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
         ORDER BY lower(p.code), p.name`
      ).all();
    } catch {
      // Migration 042 not applied — still list part numbers for printing
      rows = await c.env.DB.prepare(
        `SELECT p.id, p.code, p.name, p.primary_vendor, NULL as linked_barcodes
         FROM parts p
         WHERE p.active = 1
         ORDER BY lower(p.code), p.name`
      ).all();
    }
    const parts = (rows.results || []).map((r) => ({
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
    }));
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
      await notifyUsers(
        c.env.DB,
        [forUserId],
        "pickup_handoff",
        `Parts staged for you · ${reqNo}`,
        `${user.display_name} issued ${lines.length} line(s). Stock moves when warehouse scans your truck.`,
        { type: "pickup", id: pid }
      );
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
      await notifyUsers(
        c.env.DB,
        [forUserId],
        "pickup_request",
        `Parts ready for you · ${reqNo}`,
        `${user.display_name} set up a pickup list for you.`,
        { type: "pickup", id: pid }
      );
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
    await notifyUsers(
      c.env.DB,
      [handedToId, pickup.requested_by_user_id].filter(
        (x, i, a) => !!x && x !== user.id && a.indexOf(x) === i
      ),
      "pickup_handoff",
      `Parts in your custody · ${pickup.request_number}`,
      `${user.display_name} handed you parts. Choose which truck stock they go on to finish.`,
      { type: "pickup", id }
    );
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

function tomorrowIsoDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function defaultVendorRunSource(role: string): "office" | "tech" | "warehouse" | "other" {
  if (role === "office") return "office";
  if (role === "warehouse") return "warehouse";
  if (role === "driver" || role === "mechanic") return "tech";
  return "other";
}

/** Lines still needing action at the vendor (pending / not ready / partial). */
async function countPartPickupWaiting(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) as c FROM part_pickup_ticket_lines
         WHERE status IN ('pending','not_ready','partial')`
      )
      .first<{ c: number }>();
    let n = row?.c ?? 0;
    // Tickets marked qty unknown with no lines yet still count as 1 open ticket
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

/** Fast badge poll */
api.get("/inventory/vendor-runs/count", async (c) => {
  const waiting = await countPartPickupWaiting(c.env.DB);
  return c.json({ waiting });
});

api.get("/inventory/part-pickups/count", async (c) => {
  const waiting = await countPartPickupWaiting(c.env.DB);
  return c.json({ waiting });
});

/** List pickup tickets grouped by vendor (open / all). */
api.get("/inventory/part-pickups", async (c) => {
  const status = (c.req.query("status") || "open").trim();
  try {
    const waiting = await countPartPickupWaiting(c.env.DB);
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
      sql += ` WHERE t.status IN ('open','partial')`;
    } else if (status === "done") {
      sql += ` WHERE t.status IN ('done','cancelled')`;
    } else if (status !== "all") {
      sql += ` WHERE t.status = ?`;
    }
    sql += ` ORDER BY
      CASE t.status WHEN 'open' THEN 0 WHEN 'partial' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
      lower(t.vendor_name), t.needed_for_date IS NULL, t.needed_for_date ASC, t.id DESC
      LIMIT 100`;
    const tickets =
      status === "all" || status === "open" || status === "waiting" || status === "done"
        ? await c.env.DB.prepare(sql).all()
        : await c.env.DB.prepare(sql).bind(status).all();

    const list = [];
    for (const t of tickets.results || []) {
      const tid = Number((t as { id: number }).id);
      const lines = await c.env.DB.prepare(
        `SELECT l.*, ru.display_name as resolved_by_name
         FROM part_pickup_ticket_lines l
         LEFT JOIN users ru ON ru.id = l.resolved_by_user_id
         WHERE l.ticket_id = ?
         ORDER BY l.line_no ASC, l.id ASC`
      )
        .bind(tid)
        .all();
      list.push({ ...t, lines: lines.results || [] });
    }

    // Vendor names for autocomplete
    let vendorNames: string[] = [];
    try {
      const vn = await c.env.DB.prepare(
        `SELECT DISTINCT vendor_name as name FROM (
           SELECT vendor_name FROM part_pickup_tickets
           UNION SELECT vendor_name FROM vendor_run_lines
           UNION SELECT vendor_name FROM part_vendors
         ) WHERE name IS NOT NULL AND trim(name) != ''
         ORDER BY lower(name) LIMIT 100`
      ).all<{ name: string }>();
      vendorNames = (vn.results || []).map((r) => r.name);
    } catch {
      try {
        const vn = await c.env.DB.prepare(
          `SELECT DISTINCT vendor_name as name FROM part_pickup_tickets
           WHERE vendor_name IS NOT NULL ORDER BY lower(vendor_name) LIMIT 80`
        ).all<{ name: string }>();
        vendorNames = (vn.results || []).map((r) => r.name);
      } catch {
        vendorNames = [];
      }
    }

    // Group tickets by vendor for chips
    const byVendor = new Map<string, typeof list>();
    for (const t of list) {
      const key = String((t as { vendor_name: string }).vendor_name || "Unknown").trim();
      if (!byVendor.has(key)) byVendor.set(key, []);
      byVendor.get(key)!.push(t);
    }
    const vendors = [...byVendor.entries()]
      .map(([vendor_name, tickets]) => ({
        vendor_name,
        waiting: tickets.reduce(
          (s, tk) => s + (Number((tk as { open_lines?: number }).open_lines) || 0),
          0
        ),
        tickets,
      }))
      .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));

    return c.json({
      tickets: list,
      vendors,
      vendor_names: vendorNames,
      waiting,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({
        tickets: [],
        vendors: [],
        vendor_names: [],
        waiting: 0,
        error: "Run migration 035_part_pickup_tickets.sql",
      });
    }
    return c.json({ error: msg }, 500);
  }
});

/**
 * Create a pickup ticket.
 * Body: vendor_name, needed_for_date, purchase_order, notes,
 *       qty_unknown?, part_count? (creates empty lines), parts?: [{part_code, part_name, qty_requested}]
 */
api.post("/inventory/part-pickups", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    vendor_name?: string;
    needed_for_date?: string | null;
    purchase_order?: string | null;
    notes?: string | null;
    qty_unknown?: boolean;
    part_count?: number;
    parts?: Array<{
      part_id?: number | null;
      part_code?: string | null;
      part_name?: string | null;
      qty_requested?: number;
    }>;
    source?: "office" | "tech" | "warehouse" | "other";
  }>();

  const vendor = (body.vendor_name || "").trim();
  if (!vendor) return c.json({ error: "Vendor is required" }, 400);

  let needed = (body.needed_for_date || "").trim() || tomorrowIsoDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(needed)) needed = tomorrowIsoDate();

  const qtyUnknown = body.qty_unknown === true;
  const partsIn = body.parts || [];
  let partCount = Number(body.part_count);
  if (!qtyUnknown) {
    if (partsIn.length > 0) partCount = partsIn.length;
    if (!Number.isFinite(partCount) || partCount < 1) {
      return c.json({ error: "How many parts? Enter a number or check “Don’t know yet”" }, 400);
    }
    if (partCount > 40) return c.json({ error: "Max 40 parts per ticket" }, 400);
  } else {
    partCount = partsIn.length > 0 ? partsIn.length : 0;
  }

  const source = body.source || defaultVendorRunSource(user.role);
  const po = (body.purchase_order || "").trim() || null;
  const notes = (body.notes || "").trim() || null;

  try {
    const ins = await c.env.DB.prepare(
      `INSERT INTO part_pickup_tickets (
         vendor_name, needed_for_date, purchase_order, notes, qty_unknown, expected_parts,
         status, logged_by_user_id, source, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, datetime('now'), datetime('now'))`
    )
      .bind(vendor, needed, po, notes, qtyUnknown ? 1 : 0, partCount || null, user.id, source)
      .run();
    const ticketId = Number(ins.meta.last_row_id);

    const slots = qtyUnknown && !partsIn.length ? 0 : Math.max(partCount, partsIn.length);
    for (let i = 0; i < slots; i++) {
      const p = partsIn[i] || {};
      let partId = p.part_id ? Number(p.part_id) : null;
      let partCode = (p.part_code || "").trim() || null;
      let partName = (p.part_name || "").trim() || null;
      if (partId) {
        try {
          const row = await c.env.DB.prepare(`SELECT id, code, name FROM parts WHERE id = ?`)
            .bind(partId)
            .first<{ id: number; code: string; name: string }>();
          if (row) {
            partCode = row.code;
            if (!partName) partName = row.name;
          }
        } catch {
          partId = null;
        }
      }
      const qtyReq = Number(p.qty_requested);
      await c.env.DB.prepare(
        `INSERT INTO part_pickup_ticket_lines (
           ticket_id, line_no, part_id, part_code, part_name, qty_requested, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`
      )
        .bind(
          ticketId,
          i + 1,
          partId,
          partCode,
          partName,
          Number.isFinite(qtyReq) && qtyReq > 0 ? qtyReq : 1
        )
        .run();
    }

    const bg = (async () => {
      try {
        const notifyIds = await usersByRoles(c.env.DB, ["warehouse", "office", "admin"]);
        await notifyUsers(
          c.env.DB,
          notifyIds.filter((uid) => uid !== user.id).slice(0, 40),
          "vendor_run",
          `Part pickup · ${vendor}`,
          `${qtyUnknown ? "Parts TBD" : `${partCount} part(s)`}${po ? ` · ${po}` : ""} · need ${needed} — ${user.display_name}`,
          { type: "part_pickup", id: ticketId }
        );
      } catch {
        /* ignore */
      }
    })();
    scheduleWaitUntil(c, bg);

    return c.json({ ok: true, id: ticketId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 035_part_pickup_tickets.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
});

/** Update part # / name on lines (office fills details). */
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
    add_lines?: number;
  }>();

  try {
    const ticket = await c.env.DB.prepare(`SELECT id, status FROM part_pickup_tickets WHERE id = ?`)
      .bind(ticketId)
      .first<{ id: number; status: string }>();
    if (!ticket) return c.json({ error: "Ticket not found" }, 404);
    if (ticket.status === "done" || ticket.status === "cancelled") {
      return c.json({ error: "Ticket is closed" }, 400);
    }

    if (body.add_lines && body.add_lines > 0) {
      const maxLine = await c.env.DB.prepare(
        `SELECT COALESCE(MAX(line_no),0) as m FROM part_pickup_ticket_lines WHERE ticket_id = ?`
      )
        .bind(ticketId)
        .first<{ m: number }>();
      let n = Number(maxLine?.m) || 0;
      const add = Math.min(20, Math.floor(body.add_lines));
      for (let i = 0; i < add; i++) {
        n++;
        await c.env.DB.prepare(
          `INSERT INTO part_pickup_ticket_lines (ticket_id, line_no, qty_requested, status)
           VALUES (?, ?, 1, 'pending')`
        )
          .bind(ticketId, n)
          .run();
      }
    }

    for (const line of body.lines || []) {
      if (!line.id) continue;
      await c.env.DB.prepare(
        `UPDATE part_pickup_ticket_lines SET
           part_id = COALESCE(?, part_id),
           part_code = COALESCE(?, part_code),
           part_name = COALESCE(?, part_name),
           qty_requested = COALESCE(?, qty_requested)
         WHERE id = ? AND ticket_id = ?`
      )
        .bind(
          line.part_id ?? null,
          line.part_code != null ? String(line.part_code).trim() || null : null,
          line.part_name != null ? String(line.part_name).trim() || null : null,
          line.qty_requested != null && Number.isFinite(Number(line.qty_requested))
            ? Number(line.qty_requested)
            : null,
          line.id,
          ticketId
        )
        .run();
    }

    await c.env.DB.prepare(
      `UPDATE part_pickup_tickets SET updated_at = datetime('now') WHERE id = ?`
    )
      .bind(ticketId)
      .run();
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
 * Warehouse/office/admin can set any status; field (driver/mechanic) can only mark not needed.
 */
api.post("/inventory/part-pickups/lines/:lineId/resolve", async (c) => {
  const user = c.get("user");
  const canCounter = ["admin", "warehouse", "office"].includes(user.role);
  const canNotNeeded = canCounter || ["driver", "mechanic"].includes(user.role);
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

    if (line.logged_by_user_id && line.logged_by_user_id !== user.id) {
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
      await notifyUsers(
        c.env.DB,
        [line.logged_by_user_id],
        "vendor_run",
        `${statusLabel} · ${line.vendor_name}`,
        `${label}${qtyRecv != null ? ` · got ${qtyRecv}` : ""}${
          body.notes ? ` · ${String(body.notes).trim()}` : ""
        } — ${user.display_name}`,
        { type: "part_pickup", id: line.ticket_id }
      );
    }

    return c.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such table/i.test(msg)) {
      return c.json({ error: "Run migration 035_part_pickup_tickets.sql" }, 503);
    }
    return c.json({ error: msg }, 500);
  }
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
  if (!["admin", "warehouse", "office"].includes(user.role)) {
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
  if (!["admin", "warehouse", "office"].includes(user.role)) {
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
  if (!["admin", "warehouse", "office"].includes(user.role)) {
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

function csvEscape(v: string | null): string {
  if (!v) return "";
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

app.route("/api", api);

// SPA fallback via assets binding
app.all("*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("Frontend not built. Run npm run build.", 404);
});

// Explicit Workers entry so ExecutionContext is always passed into Hono
// (needed for waitUntil / background ntfy retries).
export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
};
