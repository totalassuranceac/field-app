import type { Env } from "./types";

export type GpsProvider = "onestep" | "verizon";

export interface LivePosition {
  id: string;
  provider: GpsProvider;
  name: string;
  driver_name: string | null;
  /** User phone from Field App (for Call on live map) */
  phone: string | null;
  lat: number;
  lng: number;
  speed_mph: number | null;
  heading: number | null;
  status: string | null;
  address: string | null;
  last_update: string | null;
  vehicle_id: number | null;
  unit_number: string | null;
  plate: string | null;
  online: boolean | null;
}

export interface LivePositionsResult {
  fetched_at: string;
  positions: LivePosition[];
  providers: {
    onestep: { ok: boolean; count: number; error?: string; configured: boolean };
    verizon: { ok: boolean; count: number; error?: string; configured: boolean };
  };
}

interface FleetVehicle {
  id: number;
  unit_number: string;
  plate: string | null;
  assigned_driver: string | null;
  gps_tracker: string | null;
}

// In-isolate caches (per Worker instance)
let oneStepCache: { token: string; cookies: string; expiresAt: number } | null = null;
let verizonCache: {
  accessToken: string;
  refreshToken?: string;
  cookies: string;
  expiresAt: number;
} | null = null;
let positionsCache: { at: number; data: LivePositionsResult } | null = null;

const POSITIONS_TTL_MS = 20_000;
const ONESTEP_TOKEN_TTL_MS = 10 * 60 * 1000;
const VERIZON_TOKEN_TTL_MS = 50 * 60 * 1000;

function normalizeName(s: string | null | undefined): string {
  return (s || "")
    .toLowerCase()
    .replace(/^[-x\s]+/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchVehicle(
  label: string,
  vehicles: FleetVehicle[],
  preferredProvider?: string
): FleetVehicle | null {
  const n = normalizeName(label);
  if (!n) return null;

  const pool = preferredProvider
    ? vehicles.filter((v) =>
        (v.gps_tracker || "").toLowerCase().includes(preferredProvider.toLowerCase())
      )
    : vehicles;
  const search = pool.length ? pool : vehicles;

  // Exact unit number
  const byUnit = search.find((v) => normalizeName(v.unit_number) === n);
  if (byUnit) return byUnit;

  // Unit embedded in name (e.g. "Old Van - 008")
  for (const v of search) {
    const unit = normalizeName(v.unit_number);
    if (unit && (n === unit || n.endsWith(` ${unit}`) || n.includes(` ${unit} `) || n.startsWith(`${unit} `))) {
      return v;
    }
  }

  // Driver name contains / contained
  let best: FleetVehicle | null = null;
  let bestScore = 0;
  for (const v of search) {
    const d = normalizeName(v.assigned_driver);
    if (!d) continue;
    if (d === n) return v;
    // "Herrera Abel" vs "Abel Herrera"
    const dParts = new Set(d.split(" "));
    const nParts = n.split(" ");
    const overlap = nParts.filter((p) => p.length > 2 && dParts.has(p)).length;
    if (overlap >= 2 && overlap > bestScore) {
      best = v;
      bestScore = overlap;
    } else if (overlap === 1 && nParts.some((p) => p.length > 3 && d.includes(p)) && overlap >= bestScore) {
      if (n.includes(d) || d.includes(n.split(" ")[0] || "")) {
        best = v;
        bestScore = Math.max(bestScore, 1);
      }
    }
  }
  return best;
}

function parseSetCookies(res: Response): string[] {
  // Workers may expose getSetCookie
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeCookieJar(jar: Record<string, string>, setCookies: string[]) {
  for (const raw of setCookies) {
    const part = raw.split(";")[0];
    const eq = part.indexOf("=");
    if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function fetchText(
  url: string,
  init: RequestInit & { jar?: Record<string, string> } = {}
): Promise<{ res: Response; body: string }> {
  const headers = new Headers(init.headers || {});
  if (init.jar) headers.set("Cookie", cookieHeader(init.jar));
  if (!headers.has("User-Agent")) {
    headers.set(
      "User-Agent",
      "Mozilla/5.0 (compatible; TotalAssuranceFleet/1.0; +https://totalassurance.workers.dev)"
    );
  }
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  if (init.jar) mergeCookieJar(init.jar, parseSetCookies(res));
  const body = await res.text();
  return { res, body };
}

async function followRedirects(
  startUrl: string,
  jar: Record<string, string>,
  max = 12
): Promise<{ url: string; res: Response; body: string }> {
  let url = startUrl;
  let last = await fetchText(url, { jar });
  let hops = 0;
  while (
    last.res.status >= 300 &&
    last.res.status < 400 &&
    last.res.headers.get("location") &&
    hops < max
  ) {
    hops++;
    const loc = last.res.headers.get("location")!;
    url = loc.startsWith("http") ? loc : new URL(loc, url).toString();
    last = await fetchText(url, { jar });
  }
  return { url, res: last.res, body: last.body };
}

// ---------- OneStep ----------
async function oneStepLogin(env: Env): Promise<{ token: string; cookies: string }> {
  if (oneStepCache && oneStepCache.expiresAt > Date.now()) {
    return { token: oneStepCache.token, cookies: oneStepCache.cookies };
  }
  const user = env.ONESTEP_USER?.trim();
  const pass = env.ONESTEP_PASS;
  if (!user || !pass) throw new Error("OneStep credentials not configured");

  const jar: Record<string, string> = {};
  const { res, body } = await fetchText("https://track.onestepgps.com/v3/api/auth", {
    method: "POST",
    jar,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      user_name: user.toLowerCase(),
      password: pass,
      keep: true,
      device_name: "Fleet Tracker",
      device_type: "server",
      device_vendor: "TotalAssurance",
      browser_name: "Worker",
      user_agent_string: "TotalAssuranceFleet/1.0",
    }),
  });
  if (!res.ok) {
    throw new Error(`OneStep login failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = JSON.parse(body) as { access_token: string };
  const cookies = cookieHeader(jar);
  oneStepCache = {
    token: data.access_token,
    cookies,
    expiresAt: Date.now() + ONESTEP_TOKEN_TTL_MS,
  };
  return { token: data.access_token, cookies };
}

async function fetchOneStepPositions(
  env: Env,
  vehicles: FleetVehicle[]
): Promise<{ positions: LivePosition[]; error?: string }> {
  if (!env.ONESTEP_USER || !env.ONESTEP_PASS) {
    return { positions: [] };
  }
  try {
    const { cookies } = await oneStepLogin(env);
    const url =
      "https://track.onestepgps.com/v3/api/public/device?latest_point=true&device_groups=true&include_visible_devices=true&limit=500";
    const { res, body } = await fetchText(url, {
      headers: {
        Accept: "application/json",
        Cookie: cookies,
      },
    });
    if (!res.ok) throw new Error(`OneStep devices ${res.status}: ${body.slice(0, 200)}`);
    const data = JSON.parse(body) as {
      result_list?: Array<{
        device_id: string;
        display_name: string;
        online?: boolean;
        latest_device_point?: {
          lat: number;
          lng: number;
          speed?: number;
          angle?: number;
          dt_tracker?: string;
          device_state?: string;
        };
      }>;
    };
    const list = data.result_list || [];
    const positions: LivePosition[] = [];
    for (const d of list) {
      const pt = d.latest_device_point;
      if (!pt || pt.lat == null || pt.lng == null) continue;
      const matched = matchVehicle(d.display_name, vehicles, "one");
      positions.push({
        id: `onestep:${d.device_id}`,
        provider: "onestep",
        name: d.display_name,
        // Prefer assigned tech name so map search finds the person on this unit
        driver_name: matched?.assigned_driver || d.display_name,
        phone: null,
        lat: pt.lat,
        lng: pt.lng,
        speed_mph: pt.speed != null ? Number(pt.speed) : null,
        heading: pt.angle != null ? Number(pt.angle) : null,
        status: pt.device_state || (d.online ? "online" : "offline"),
        address: null,
        last_update: pt.dt_tracker || null,
        vehicle_id: matched?.id ?? null,
        unit_number: matched?.unit_number ?? null,
        plate: matched?.plate ?? null,
        online: d.online ?? null,
      });
    }
    return { positions };
  } catch (e) {
    return { positions: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- Verizon Reveal ----------
function extractState(html: string): string | null {
  const m = html.match(/name="state"\s+value="([^"]+)"/);
  return m?.[1] ?? null;
}

function formBody(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

async function verizonLogin(env: Env): Promise<{ accessToken: string; cookies: string }> {
  if (verizonCache && verizonCache.expiresAt > Date.now()) {
    return { accessToken: verizonCache.accessToken, cookies: verizonCache.cookies };
  }

  const user = env.VERIZON_USER?.trim();
  const pass = env.VERIZON_PASS;
  if (!user || !pass) throw new Error("Verizon credentials not configured");

  const jar: Record<string, string> = {};
  const clientId = "kBC6iF5hjsNTKPqG4tsa15fRkLOEeUZP";

  // Start OIDC
  const loginStart = await fetchText("https://reveal.us.vzconnect.com/login.aspx", {
    jar,
    redirect: "manual",
  });
  const authorizeLoc = loginStart.res.headers.get("location");
  if (!authorizeLoc) throw new Error("Verizon: no authorize redirect");
  const authorizeUrl = authorizeLoc.startsWith("http")
    ? authorizeLoc
    : `https://reveal.us.vzconnect.com${authorizeLoc}`;

  let page = await followRedirects(authorizeUrl, jar);
  let state = extractState(page.body);
  if (!state) throw new Error("Verizon: missing login state");

  // Username
  const idPost = await fetchText("https://login.us.vzconnect.com/u/login/identifier", {
    method: "POST",
    jar,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://login.us.vzconnect.com",
    },
    body: formBody({
      state,
      username: user,
      "js-available": "true",
      "webauthn-available": "false",
      "is-brave": "false",
      "webauthn-platform-available": "false",
      action: "default",
    }),
    redirect: "manual",
  });
  let passLoc = idPost.res.headers.get("location");
  if (!passLoc) throw new Error("Verizon: password step not reached");
  if (!passLoc.startsWith("http")) passLoc = `https://login.us.vzconnect.com${passLoc}`;
  page = await followRedirects(passLoc, jar);
  state = extractState(page.body) || state;

  // Password
  const passPost = await fetchText("https://login.us.vzconnect.com/u/login/password", {
    method: "POST",
    jar,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://login.us.vzconnect.com",
    },
    body: formBody({
      state,
      username: user,
      password: pass,
      action: "default",
    }),
    redirect: "manual",
  });
  let resume = passPost.res.headers.get("location");
  if (!resume) throw new Error(`Verizon login failed: ${passPost.body.slice(0, 200)}`);
  if (!resume.startsWith("http")) resume = `https://login.us.vzconnect.com${resume}`;

  page = await followRedirects(resume, jar);
  const refreshMatch = page.body.match(/refresh_token['"]?\s*,\s*['"]([^'"]+)/);
  const refreshToken = refreshMatch?.[1];
  if (!refreshToken) {
    // still try bootstrap default.aspx
    page = await followRedirects("https://reveal.us.vzconnect.com/default.aspx?flow=code", jar);
  } else {
    await followRedirects("https://reveal.us.vzconnect.com/default.aspx?flow=code", jar);
  }

  if (!refreshToken) throw new Error("Verizon: no refresh_token after login");

  const tokenRes = await fetch("https://login.us.vzconnect.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });
  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`Verizon token exchange failed: ${tokenBody.slice(0, 200)}`);
  const tok = JSON.parse(tokenBody) as { access_token: string; expires_in?: number };

  const cookies = cookieHeader(jar);
  verizonCache = {
    accessToken: tok.access_token,
    refreshToken,
    cookies,
    expiresAt: Date.now() + Math.min(VERIZON_TOKEN_TTL_MS, (tok.expires_in || 3600) * 1000 - 60_000),
  };
  return { accessToken: tok.access_token, cookies };
}

async function fetchVerizonPositions(
  env: Env,
  vehicles: FleetVehicle[]
): Promise<{ positions: LivePosition[]; error?: string }> {
  if (!env.VERIZON_USER || !env.VERIZON_PASS) {
    return { positions: [] };
  }
  try {
    const { accessToken, cookies } = await verizonLogin(env);
    const { res, body } = await fetchText(
      "https://reveal.us.vzconnect.com/plot/Plot/GetVehiclePlotsForUserWithMetadata",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Cookie: cookies,
          "X-Request-Source": "LiveMap",
          Referer: "https://reveal.us.vzconnect.com/en-US/live-map/",
        },
      }
    );
    if (!res.ok) {
      // invalidate cache and surface error
      verizonCache = null;
      throw new Error(`Verizon plots ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = JSON.parse(body) as {
      Plots?: Array<{
        id: number;
        vnme?: string;
        dnme?: string;
        Coordinate?: { Latitude: number; Longitude: number };
        spd?: number;
        dir?: number;
        icncls?: string;
        ads?: string;
        tmeu?: string;
        tme?: string;
      }>;
    };
    const plots = data.Plots || [];
    const positions: LivePosition[] = [];
    for (const p of plots) {
      const lat = p.Coordinate?.Latitude;
      const lng = p.Coordinate?.Longitude;
      if (lat == null || lng == null) continue;
      const label = p.vnme || p.dnme || `Vehicle ${p.id}`;
      const matched =
        matchVehicle(label, vehicles, "verizon") ||
        matchVehicle(p.dnme || "", vehicles, "verizon") ||
        matchVehicle(label, vehicles);
      positions.push({
        id: `verizon:${p.id}`,
        provider: "verizon",
        name: label,
        driver_name: matched?.assigned_driver || p.dnme || null,
        phone: null,
        lat,
        lng,
        speed_mph: p.spd != null ? Number(p.spd) : null,
        heading: p.dir != null ? Number(p.dir) : null,
        status: p.icncls || null,
        address: p.ads || null,
        last_update: p.tmeu || p.tme || null,
        vehicle_id: matched?.id ?? null,
        unit_number: matched?.unit_number ?? null,
        plate: matched?.plate ?? null,
        online: null,
      });
    }
    return { positions };
  } catch (e) {
    return { positions: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Attach Field App user/employee phones so Live map can offer Call. */
async function attachDriverPhones(db: D1Database, positions: LivePosition[]): Promise<void> {
  if (!positions.length) return;
  try {
    type PhoneRow = {
      display_name: string;
      phone: string | null;
      employee_name: string | null;
      employee_phone: string | null;
    };
    let rows: PhoneRow[] = [];
    try {
      const r = await db
        .prepare(
          `SELECT u.display_name, u.phone, e.name as employee_name, e.phone as employee_phone
           FROM users u
           LEFT JOIN employees e ON e.id = u.employee_id
           WHERE u.active = 1`
        )
        .all<PhoneRow>();
      rows = r.results || [];
    } catch {
      const r = await db
        .prepare(`SELECT display_name, phone, NULL as employee_name, NULL as employee_phone
                  FROM users WHERE active = 1`)
        .all<PhoneRow>();
      rows = r.results || [];
    }

    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/\(.*?\)/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const byKey = new Map<string, string>();
    for (const u of rows) {
      const phone = (u.phone || u.employee_phone || "").trim();
      if (!phone) continue;
      for (const name of [u.display_name, u.employee_name].filter(Boolean) as string[]) {
        const key = norm(name);
        if (key) byKey.set(key, phone);
        // last name only
        const parts = key.split(" ").filter(Boolean);
        if (parts.length >= 2) {
          const last = parts[parts.length - 1];
          if (last.length >= 3 && !byKey.has(last)) byKey.set(last, phone);
        }
      }
    }

    for (const p of positions) {
      if (p.phone) continue;
      const candidates = [p.driver_name, p.name].filter(Boolean) as string[];
      for (const c of candidates) {
        const key = norm(c);
        if (byKey.has(key)) {
          p.phone = byKey.get(key) || null;
          break;
        }
        // partial: driver "Juan Perez" vs user "Juan"
        for (const [k, phone] of byKey) {
          if (key.includes(k) || k.includes(key)) {
            p.phone = phone;
            break;
          }
        }
        if (p.phone) break;
      }
    }
  } catch {
    /* phones optional */
  }
}

export async function getLivePositions(env: Env, force = false): Promise<LivePositionsResult> {
  if (!force && positionsCache && Date.now() - positionsCache.at < POSITIONS_TTL_MS) {
    return positionsCache.data;
  }

  const rows = await env.DB.prepare(
    `SELECT id, unit_number, plate, assigned_driver, gps_tracker FROM vehicles WHERE status != 'retired'`
  ).all<FleetVehicle>();
  const vehicles = rows.results || [];

  const onestepConfigured = Boolean(env.ONESTEP_USER && env.ONESTEP_PASS);
  const verizonConfigured = Boolean(env.VERIZON_USER && env.VERIZON_PASS);

  const [os, vz] = await Promise.all([
    fetchOneStepPositions(env, vehicles),
    fetchVerizonPositions(env, vehicles),
  ]);

  const positions = [...os.positions, ...vz.positions];
  await attachDriverPhones(env.DB, positions);

  const data: LivePositionsResult = {
    fetched_at: new Date().toISOString(),
    positions,
    providers: {
      onestep: {
        ok: !os.error,
        count: os.positions.length,
        error: os.error,
        configured: onestepConfigured,
      },
      verizon: {
        ok: !vz.error,
        count: vz.positions.length,
        error: vz.error,
        configured: verizonConfigured,
      },
    },
  };

  positionsCache = { at: Date.now(), data };
  return data;
}
