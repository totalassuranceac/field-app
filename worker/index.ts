import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  clearSessionCookie,
  createSession,
  destroySession,
  ensureBootstrapAdmin,
  getSessionToken,
  getUserFromSession,
  googleConfigured,
  hashPassword,
  isGoogleEmailAllowed,
  ROLE_PERMS,
  roleAtLeast,
  sessionCookie,
  toPublicUser,
  verifyPassword,
} from "./auth";
import { getSetting, setSetting, writeAudit } from "./audit";
import { evaluateMileageAlerts, insertAlerts } from "./redflags";
import { getLivePositions } from "./gps";
import type { Env, PublicUser, Role, UserRow, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use("/api/*", cors({ origin: (o) => o || "*", credentials: true }));

app.use("/api/*", async (c, next) => {
  try {
    await ensureBootstrapAdmin(c.env);
  } catch {
    // DB may not be migrated yet
  }
  await next();
});

function isSecure(c: { req: { url: string } }): boolean {
  return new URL(c.req.url).protocol === "https:";
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
    app: c.env.APP_NAME || "Total Assurance Fleet",
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
  c.set("user", toPublicUser(user));
  await next();
});

// Dashboard
// Live GPS (OneStep + Verizon)
api.get("/live/positions", async (c) => {
  const force = c.req.query("refresh") === "1";
  try {
    const data = await getLivePositions(c.env, force);
    return c.json(data);
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
      },
      500
    );
  }
});

api.get("/dashboard", async (c) => {
  const openAlerts = await c.env.DB.prepare(
    "SELECT COUNT(*) as c FROM mileage_alerts WHERE status = 'open'"
  ).first<{ c: number }>();
  const openIssues = await c.env.DB.prepare(
    "SELECT COUNT(*) as c FROM vehicle_issues WHERE status IN ('open','scheduled','in_progress')"
  ).first<{ c: number }>();
  const soonDays = Number(await getSetting(c.env.DB, "expiring_soon_days", "30"));
  const expiring = await c.env.DB.prepare(
    `SELECT COUNT(*) as c FROM vehicles WHERE status = 'active' AND (
      (registration_expires IS NOT NULL AND registration_expires <= date('now', '+' || ? || ' days')) OR
      (inspection_expires IS NOT NULL AND inspection_expires <= date('now', '+' || ? || ' days'))
    )`
  )
    .bind(String(soonDays), String(soonDays))
    .first<{ c: number }>();
  const recentFuel = await c.env.DB.prepare(
    `SELECT f.*, e.name as employee_name, v.unit_number,
            u.display_name as entered_by_name
     FROM fuel_entries f
     JOIN employees e ON e.id = f.employee_id
     JOIN vehicles v ON v.id = f.vehicle_id
     JOIN users u ON u.id = f.entered_by_user_id
     ORDER BY f.created_at DESC LIMIT 8`
  ).all();
  const recentAlerts = await c.env.DB.prepare(
    `SELECT a.*, v.unit_number FROM mileage_alerts a
     JOIN vehicles v ON v.id = a.vehicle_id
     WHERE a.status = 'open' ORDER BY a.created_at DESC LIMIT 8`
  ).all();

  return c.json({
    stats: {
      open_alerts: openAlerts?.c ?? 0,
      open_issues: openIssues?.c ?? 0,
      expiring_soon: expiring?.c ?? 0,
    },
    recent_fuel: recentFuel.results,
    recent_alerts: recentAlerts.results,
  });
});

// Employees
api.get("/employees", requireRoles(ROLE_PERMS.viewFuel), async (c) => {
  const all = c.req.query("all") === "1";
  const rows = await c.env.DB.prepare(
    all
      ? "SELECT * FROM employees ORDER BY name"
      : "SELECT * FROM employees WHERE active = 1 ORDER BY name"
  ).all();
  return c.json({ employees: rows.results });
});

api.post("/employees", requireRoles(ROLE_PERMS.manageEmployees), async (c) => {
  const body = await c.req.json<{ name: string; notes?: string; phone?: string }>();
  if (!body.name?.trim()) return c.json({ error: "Name required" }, 400);
  const result = await c.env.DB.prepare(
    "INSERT INTO employees (name, phone, notes) VALUES (?, ?, ?)"
  )
    .bind(body.name.trim(), body.phone || null, body.notes || null)
    .run();
  const id = result.meta.last_row_id;
  await writeAudit(c.env.DB, c.get("user"), "create", "employee", id, `Created employee ${body.name}`);
  const emp = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  return c.json({ employee: emp }, 201);
});

api.patch("/employees/:id", requireRoles(ROLE_PERMS.manageEmployees), async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM employees WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ name?: string; notes?: string; phone?: string; active?: boolean }>();
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

// Vehicles
api.get("/vehicles", async (c) => {
  const filter = c.req.query("filter");
  const soonDays = Number(await getSetting(c.env.DB, "expiring_soon_days", "30"));
  let sql = "SELECT * FROM vehicles WHERE 1=1";
  const binds: string[] = [];

  if (filter === "active") sql += " AND status = 'active'";
  if (filter === "expired") {
    sql += ` AND status != 'retired' AND (
      (registration_expires IS NOT NULL AND registration_expires < date('now')) OR
      (inspection_expires IS NOT NULL AND inspection_expires < date('now')) OR
      (insurance_expires IS NOT NULL AND insurance_expires < date('now')) OR
      (emissions_expires IS NOT NULL AND emissions_expires < date('now'))
    )`;
  }
  if (filter === "expiring") {
    sql += ` AND status = 'active' AND (
      (registration_expires IS NOT NULL AND registration_expires <= date('now', '+' || ? || ' days') AND registration_expires >= date('now')) OR
      (inspection_expires IS NOT NULL AND inspection_expires <= date('now', '+' || ? || ' days') AND inspection_expires >= date('now'))
    )`;
    binds.push(String(soonDays), String(soonDays));
  }
  if (filter === "dash_cam") {
    sql += " AND dash_cam_status IN ('not_working','missing','unknown')";
  }
  sql += " ORDER BY unit_number";

  const stmt = c.env.DB.prepare(sql);
  const rows = binds.length ? await stmt.bind(...binds).all() : await stmt.all();
  return c.json({ vehicles: rows.results, expiring_soon_days: soonDays });
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
        insurance_expires, emissions_expires, modifications, notes
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
        body.dash_cam_status || "unknown",
        body.cam_type || null,
        body.gps_tracker || null,
        body.registration_expires || null,
        body.inspection_expires || null,
        body.insurance_expires || null,
        body.emissions_expires || null,
        body.modifications || null,
        body.notes || null
      )
      .run();
    const id = result.meta.last_row_id;
    await writeAudit(c.env.DB, c.get("user"), "create", "vehicle", id, `Created vehicle ${unit}`);
    const vehicle = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
    return c.json({ vehicle }, 201);
  } catch {
    return c.json({ error: "Could not create vehicle (duplicate unit?)" }, 400);
  }
});

api.patch("/vehicles/:id", requireRoles(ROLE_PERMS.manageVehicles), async (c) => {
  const id = Number(c.req.param("id"));
  const before = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<Record<string, unknown>>();
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
    "registration_expires",
    "inspection_expires",
    "insurance_expires",
    "emissions_expires",
    "modifications",
    "notes",
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
  await c.env.DB.prepare(`UPDATE vehicles SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  const after = await c.env.DB.prepare("SELECT * FROM vehicles WHERE id = ?").bind(id).first();
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
  sql += " ORDER BY f.fuel_date DESC, f.id DESC LIMIT 200";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();

  const totals = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(gallons),0) as gallons, COALESCE(SUM(total_cost),0) as total_cost, COUNT(*) as count
     FROM fuel_entries f WHERE 1=1
     ${from ? " AND f.fuel_date >= ?" : ""}
     ${to ? " AND f.fuel_date <= ?" : ""}
     ${vehicleId ? " AND f.vehicle_id = ?" : ""}
     ${employeeId ? " AND f.employee_id = ?" : ""}`
  )
    .bind(...binds)
    .first();

  return c.json({ entries: rows.results, totals });
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
    station_notes?: string;
    receipt_key?: string;
  }>();

  if (!body.vehicle_id || body.odometer == null || !body.fuel_date) {
    return c.json({ error: "vehicle_id, odometer, and fuel_date are required" }, 400);
  }

  let employeeId = body.employee_id;
  if (user.role === "driver") {
    if (user.employee_id) employeeId = user.employee_id;
    else if (!employeeId) return c.json({ error: "Link your user to an employee profile first" }, 400);
  }
  if (!employeeId) return c.json({ error: "employee_id required" }, 400);

  const result = await c.env.DB.prepare(
    `INSERT INTO fuel_entries
      (employee_id, vehicle_id, odometer, gallons, total_cost, fuel_date, station_notes, receipt_key, entered_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      employeeId,
      body.vehicle_id,
      body.odometer,
      body.gallons ?? null,
      body.total_cost ?? null,
      body.fuel_date,
      body.station_notes || null,
      body.receipt_key || null,
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

  const alerts = await evaluateMileageAlerts(c.env.DB, {
    id,
    vehicle_id: body.vehicle_id,
    employee_id: employeeId,
    odometer: body.odometer,
    fuel_date: body.fuel_date,
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

  const entry = await c.env.DB.prepare(
    `SELECT f.*, e.name as employee_name, v.unit_number FROM fuel_entries f
     JOIN employees e ON e.id = f.employee_id
     JOIN vehicles v ON v.id = f.vehicle_id WHERE f.id = ?`
  )
    .bind(id)
    .first();

  return c.json({ entry, alerts }, 201);
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

// Receipt upload
api.post("/uploads/receipt", requireRoles(ROLE_PERMS.logFuel), async (c) => {
  if (!c.env.RECEIPTS) {
    return c.json(
      {
        error:
          "Receipt storage is not configured yet. Enable R2 in Cloudflare and bind the RECEIPTS bucket.",
      },
      503
    );
  }
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  if (file.size > 10 * 1024 * 1024) return c.json({ error: "Max 10MB" }, 400);

  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "");
  const formFolder = form.get("folder");
  const folder =
    typeof formFolder === "string" && formFolder.replace(/[^a-z0-9/_-]/gi, "")
      ? formFolder.replace(/[^a-z0-9/_-]/gi, "")
      : "fuel-receipts";
  const key = `${folder}/${Date.now()}-${crypto.randomUUID()}.${ext || "jpg"}`;
  await c.env.RECEIPTS.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });
  return c.json({ key, folder });
});

api.get("/uploads/*", async (c) => {
  if (!c.env.RECEIPTS) return c.json({ error: "Receipt storage not configured" }, 503);
  // path is /api/uploads/<key...> when mounted under /api
  const full = new URL(c.req.url).pathname;
  const key = full.replace(/^\/api\/uploads\//, "");
  if (!key || key.includes("..")) return c.json({ error: "Not found" }, 404);
  const obj = await c.env.RECEIPTS.get(decodeURIComponent(key));
  if (!obj) return c.json({ error: "Not found" }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(obj.body, { headers });
});

// Alerts
api.get("/alerts", requireRoles(ROLE_PERMS.viewFuel), async (c) => {
  const status = c.req.query("status") || "open";
  const rows = await c.env.DB.prepare(
    `SELECT a.*, v.unit_number, f.odometer, f.fuel_date, e.name as employee_name
     FROM mileage_alerts a
     JOIN vehicles v ON v.id = a.vehicle_id
     JOIN fuel_entries f ON f.id = a.fuel_entry_id
     JOIN employees e ON e.id = f.employee_id
     WHERE a.status = ?
     ORDER BY
       CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
       a.created_at DESC`
  )
    .bind(status)
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
  sql += " ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, i.created_at DESC";
  const rows = await c.env.DB.prepare(sql).bind(...binds).all();
  return c.json({ issues: rows.results });
});

api.post("/issues", requireRoles(ROLE_PERMS.reportIssues), async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{
    vehicle_id: number;
    title: string;
    description?: string;
    severity?: string;
    photo_key?: string;
  }>();
  if (!body.vehicle_id || !body.title?.trim()) {
    return c.json({ error: "vehicle_id and title required" }, 400);
  }
  const result = await c.env.DB.prepare(
    `INSERT INTO vehicle_issues
      (vehicle_id, reported_by_user_id, severity, title, description, photo_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      body.vehicle_id,
      user.id,
      body.severity || "medium",
      body.title.trim(),
      body.description || null,
      body.photo_key || null
    )
    .run();
  const id = result.meta.last_row_id;
  await writeAudit(c.env.DB, user, "create", "vehicle_issue", id, `Issue: ${body.title}`);
  const issue = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first();
  return c.json({ issue }, 201);
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
  ] as const;
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const f of fields) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      values.push(body[f] === "" ? null : body[f]);
    }
  }
  if (body.status === "completed") {
    sets.push("completed_at = datetime('now')");
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await c.env.DB.prepare(`UPDATE vehicle_issues SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  const after = await c.env.DB.prepare("SELECT * FROM vehicle_issues WHERE id = ?").bind(id).first();

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

// Inspections
api.get("/inspections", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT i.*, v.unit_number, u.display_name as inspector_name
     FROM inspections i
     JOIN vehicles v ON v.id = i.vehicle_id
     JOIN users u ON u.id = i.inspector_user_id
     ORDER BY i.inspection_date DESC, i.id DESC LIMIT 200`
  ).all();
  return c.json({ inspections: rows.results });
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
  let createdIssueId: number | null = null;
  if (body.create_issue_on_fail !== false && body.overall_status === "fail") {
    const fails = Object.entries(body.checklist || {})
      .filter(([, v]) => v === "fail")
      .map(([k]) => k);
    const title = `Inspection fail — ${fails.slice(0, 3).join(", ") || "see notes"}`;
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
api.get("/users", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT id, email, username, display_name, role, employee_id, auth_provider, active, created_at
     FROM users ORDER BY display_name`
  ).all();
  return c.json({ users: rows.results });
});

api.post("/users", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const body = await c.req.json<{
    display_name: string;
    username?: string;
    email?: string;
    password?: string;
    role: Role;
    employee_id?: number;
  }>();
  if (!body.display_name?.trim() || !body.role) {
    return c.json({ error: "display_name and role required" }, 400);
  }
  let hash: string | null = null;
  let salt: string | null = null;
  if (body.password) {
    const p = await hashPassword(body.password);
    hash = p.hash;
    salt = p.salt;
  }
  try {
    const result = await c.env.DB.prepare(
      `INSERT INTO users (email, username, display_name, password_hash, password_salt, role, employee_id, auth_provider, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        body.email || null,
        body.username || null,
        body.display_name.trim(),
        hash,
        salt,
        body.role,
        body.employee_id ?? null,
        hash ? "password" : "google"
      )
      .run();
    const id = result.meta.last_row_id;
    await writeAudit(c.env.DB, c.get("user"), "create", "user", id, `Created user ${body.display_name}`);
    const user = await c.env.DB.prepare(
      `SELECT id, email, username, display_name, role, employee_id, auth_provider, active, created_at FROM users WHERE id = ?`
    )
      .bind(id)
      .first();
    return c.json({ user }, 201);
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

  for (const f of ["display_name", "email", "username", "role", "employee_id"] as const) {
    if (body[f] !== undefined) {
      sets.push(`${f} = ?`);
      values.push(body[f] === "" ? null : body[f]);
    }
  }
  if (body.active !== undefined) {
    sets.push("active = ?");
    values.push(body.active ? 1 : 0);
  }
  if (body.password && typeof body.password === "string") {
    const p = await hashPassword(body.password);
    sets.push("password_hash = ?", "password_salt = ?");
    values.push(p.hash, p.salt);
    sets.push(
      "auth_provider = CASE WHEN auth_provider = 'google' THEN 'both' ELSE COALESCE(auth_provider, 'password') END"
    );
  }
  if (!sets.length) return c.json({ error: "No fields" }, 400);
  sets.push("updated_at = datetime('now')");
  values.push(id);
  await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
  // Invalidate sessions on password reset
  if (body.password) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id).run();
  }
  const after = await c.env.DB.prepare(
    `SELECT id, email, username, display_name, role, employee_id, auth_provider, active, created_at FROM users WHERE id = ?`
  )
    .bind(id)
    .first();
  await writeAudit(
    c.env.DB,
    c.get("user"),
    body.password ? "password_reset" : "update",
    "user",
    id,
    body.password ? "Password reset by admin" : "Updated user",
    before,
    after
  );
  return c.json({ user: after });
});

api.post("/users/:id/reset-password", requireRoles(ROLE_PERMS.manageUsers), async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ password?: string }>();
  const password = body.password?.trim();
  if (!password || password.length < 8) {
    return c.json({ error: "Password must be at least 8 characters" }, 400);
  }
  const before = await c.env.DB.prepare("SELECT id, username, display_name FROM users WHERE id = ?")
    .bind(id)
    .first();
  if (!before) return c.json({ error: "Not found" }, 404);
  const p = await hashPassword(password);
  await c.env.DB.prepare(
    `UPDATE users SET password_hash = ?, password_salt = ?,
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
  return c.json({ ok: true });
});

// Settings
api.get("/settings", requireRoles(ROLE_PERMS.manageSettings), async (c) => {
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

export default app;
