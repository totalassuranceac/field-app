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
  /** Fleet vehicle status from Field App (active / out_of_service / …) */
  vehicle_status?: string | null;
  /** True when unit is out of service — still on map for accountability */
  out_of_service?: boolean;
}

export interface ProviderDeviceSummary {
  id: string;
  name: string;
  online: boolean | null;
  has_position: boolean;
  unit_number: string | null;
  vehicle_id: number | null;
}

export interface ProviderStatus {
  ok: boolean;
  count: number;
  error?: string;
  configured: boolean;
  /** Devices returned by the provider API (before coord filter) */
  total_devices?: number;
  /** Devices skipped because they have no lat/lng yet */
  without_position?: number;
  /** Full inventory visible to the login (for ops / new-tracker checks) */
  devices?: ProviderDeviceSummary[];
}

export interface LivePositionsResult {
  fetched_at: string;
  positions: LivePosition[];
  providers: {
    onestep: ProviderStatus;
    verizon: ProviderStatus;
  };
}

interface FleetVehicle {
  id: number;
  unit_number: string;
  plate: string | null;
  assigned_driver: string | null;
  gps_tracker: string | null;
  status: string | null;
  last_lat?: number | null;
  last_lng?: number | null;
  last_gps_at?: string | null;
}

/** Default yard pin when an out-of-service unit has no last GPS (Corpus Christi shop area) */
const DEFAULT_YARD_LAT = 27.8006;
const DEFAULT_YARD_LNG = -97.3964;

function isOutOfService(status: string | null | undefined): boolean {
  return (status || "").toLowerCase().replace(/\s+/g, "_") === "out_of_service";
}

function providerFromTracker(tracker: string | null | undefined): GpsProvider {
  const t = (tracker || "").toLowerCase();
  if (/verizon|reveal|vzw/.test(t)) return "verizon";
  return "onestep";
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

/**
 * Pool / warehouse labels (not a person). Kept on assigned_driver for map display
 * after clearing a tech — must not be used for GPS name-matching.
 */
export function isPoolDriverLabel(s: string | null | undefined): boolean {
  const t = (s || "").trim().toLowerCase();
  if (!t) return true;
  return /^(unassigned|warehouse(\s+truck)?|shop(\s+truck)?|pool|yard|spare|parts\s*truck)$/i.test(
    t
  );
}

/** Map list / popup label: assigned tech, pool label, or Unassigned — never raw GPS device name when matched. */
function mapDriverLabel(
  matched: FleetVehicle | null | undefined,
  unmatchedFallback: string | null
): string | null {
  if (!matched) return unmatchedFallback;
  const ad = (matched.assigned_driver || "").trim();
  return ad || null;
}

/** Split "Speedy Marroquin + Chuck Dickerson" into individual people. */
function driverNameParts(assigned: string | null | undefined): string[] {
  if (isPoolDriverLabel(assigned)) return [];
  const raw = normalizeName(assigned);
  if (!raw) return [];
  return raw
    .split(/\s*(?:\+|\/|&|,| and )\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
}

function matchVehicleInPool(label: string, search: FleetVehicle[]): FleetVehicle | null {
  const n = normalizeName(label);
  if (!n) return null;
  const nParts = n.split(" ").filter(Boolean);

  // Exact unit number
  const byUnit = search.find((v) => normalizeName(v.unit_number) === n);
  if (byUnit) return byUnit;

  // Compact unit match so Box2 matches "Box 2" / "Box 1" style labels
  const compactN = n.replace(/\s+/g, "");
  const byUnitCompact = search.find((v) => {
    const u = normalizeName(v.unit_number).replace(/\s+/g, "");
    return u.length > 0 && u === compactN;
  });
  if (byUnitCompact) return byUnitCompact;

  // Unit embedded in name (e.g. "Old Van - 008", "Unit 42")
  for (const v of search) {
    const unit = normalizeName(v.unit_number);
    if (!unit) continue;
    if (
      n === unit ||
      n.endsWith(` ${unit}`) ||
      n.includes(` ${unit} `) ||
      n.startsWith(`${unit} `) ||
      n.includes(`unit ${unit}`) ||
      n.endsWith(`-${unit}`) ||
      n.includes(`-${unit} `) ||
      n.includes(` ${unit}-`)
    ) {
      return v;
    }
  }

  // Driver name(s) — supports multi-driver units and nicknames (Chuck, Speedy, Chris)
  let best: FleetVehicle | null = null;
  let bestScore = 0;
  for (const v of search) {
    const people = driverNameParts(v.assigned_driver);
    if (!people.length) continue;

    for (const person of people) {
      if (person === n) return v;

      const dParts = person.split(" ").filter(Boolean);
      const dSet = new Set(dParts);
      const overlap = nParts.filter((p) => p.length > 2 && dSet.has(p)).length;

      // Full multi-token overlap
      if (overlap >= 2 && overlap > bestScore) {
        best = v;
        bestScore = overlap + 0.5;
        continue;
      }

      // Single distinctive name: "Speedy" ↔ "Speedy Marroquin", "Chuck" ↔ "Chuck Dickerson"
      for (const token of nParts) {
        if (token.length < 3) continue;
        if (dParts.includes(token) || person.includes(token)) {
          // Prefer longer / unique tokens (nicknames & last names)
          const score = token.length >= 5 ? 1.4 : 1.0;
          if (score > bestScore) {
            best = v;
            bestScore = score;
          }
        }
      }

      // Reverse: device "Chris Marroquin" vs vehicle "ChrisMarroquin" (no space)
      const compactPerson = person.replace(/\s+/g, "");
      const compactLabel = n.replace(/\s+/g, "");
      if (compactPerson && compactPerson === compactLabel) return v;
      if (
        compactPerson.length >= 5 &&
        compactLabel.length >= 5 &&
        (compactPerson.includes(compactLabel) || compactLabel.includes(compactPerson))
      ) {
        if (1.2 > bestScore) {
          best = v;
          bestScore = 1.2;
        }
      }
    }

    // Whole assigned string (legacy multi-driver line) — skip pool labels
    if (isPoolDriverLabel(v.assigned_driver)) continue;
    const whole = normalizeName(v.assigned_driver);
    if (whole && (whole.includes(n) || n.includes(whole.split(" ")[0] || ""))) {
      if (1.1 > bestScore) {
        best = v;
        bestScore = 1.1;
      }
    }
  }
  return best;
}

function matchVehicle(
  label: string,
  vehicles: FleetVehicle[],
  preferredProvider?: string
): FleetVehicle | null {
  if (!label?.trim()) return null;

  // Prefer vehicles already tagged for this GPS system, then fall back to all
  // (so new units without gps_tracker set still match)
  if (preferredProvider) {
    const preferred = vehicles.filter((v) =>
      (v.gps_tracker || "").toLowerCase().includes(preferredProvider.toLowerCase())
    );
    if (preferred.length) {
      const hit = matchVehicleInPool(label, preferred);
      if (hit) return hit;
    }
  }
  return matchVehicleInPool(label, vehicles);
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
  const data = JSON.parse(body) as { access_token?: string; token?: string };
  const accessToken = (data.access_token || data.token || "").trim();
  if (!accessToken) {
    throw new Error("OneStep login: no access_token in response");
  }
  // Session cookie jar from Set-Cookie + token cookie (portal uses both)
  jar.access_token = accessToken;
  const cookies = cookieHeader(jar);
  oneStepCache = {
    token: accessToken,
    cookies,
    expiresAt: Date.now() + ONESTEP_TOKEN_TTL_MS,
  };
  return { token: accessToken, cookies };
}

type OneStepDevice = {
  device_id: string;
  display_name?: string;
  name?: string;
  online?: boolean;
  active_state?: string;
  factory_id?: string;
  latest_device_point?: {
    lat?: number | string;
    lng?: number | string;
    latitude?: number | string;
    longitude?: number | string;
    speed?: number | string;
    angle?: number | string;
    dt_tracker?: string;
    device_state?: string;
  } | null;
};

function numCoord(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractPoint(d: OneStepDevice): {
  lat: number;
  lng: number;
  speed: number | null;
  angle: number | null;
  dt: string | null;
  state: string | null;
} | null {
  const pt = d.latest_device_point;
  if (!pt) return null;
  const lat = numCoord(pt.lat ?? pt.latitude);
  const lng = numCoord(pt.lng ?? pt.longitude);
  if (lat == null || lng == null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // OneStep sometimes returns 0,0 before first fix
  if (lat === 0 && lng === 0) return null;
  return {
    lat,
    lng,
    speed: numCoord(pt.speed),
    angle: numCoord(pt.angle),
    dt: pt.dt_tracker || null,
    state: pt.device_state || null,
  };
}

/**
 * Pull every device visible to the OneStep account.
 * New trackers appear automatically once they report a GPS fix — no app registration.
 */
async function fetchOneStepPositions(
  env: Env,
  vehicles: FleetVehicle[]
): Promise<{
  positions: LivePosition[];
  error?: string;
  total_devices?: number;
  without_position?: number;
  devices?: ProviderDeviceSummary[];
}> {
  if (!env.ONESTEP_USER || !env.ONESTEP_PASS) {
    return { positions: [] };
  }
  try {
    const { cookies } = await oneStepLogin(env);
    // OneStep public device API expects session cookies from /v3/api/auth — NOT Bearer API keys.
    // Sending Authorization: Bearer <access_token> returns 400 "Invalid API Key".
    const pageSize = 200;
    const maxPages = 25; // up to 5000 devices
    const byId = new Map<string, OneStepDevice>();

    for (let page = 0; page < maxPages; page++) {
      const offset = page * pageSize;
      // include_visible_devices: all devices the login can see (new units + shared groups)
      const url =
        `https://track.onestepgps.com/v3/api/public/device` +
        `?latest_point=true&device_groups=true&include_visible_devices=true` +
        `&limit=${pageSize}&offset=${offset}`;
      const { res, body } = await fetchText(url, {
        headers: {
          Accept: "application/json",
          Cookie: cookies,
        },
      });
      if (!res.ok) {
        // Retry once without offset (some accounts reject pagination params)
        if (page === 0 && offset === 0) {
          const fallbackUrl =
            "https://track.onestepgps.com/v3/api/public/device?latest_point=true&device_groups=true&include_visible_devices=true&limit=500";
          const retry = await fetchText(fallbackUrl, {
            headers: { Accept: "application/json", Cookie: cookies },
          });
          if (!retry.res.ok) {
            throw new Error(`OneStep devices ${retry.res.status}: ${retry.body.slice(0, 200)}`);
          }
          const retryData = JSON.parse(retry.body) as { result_list?: OneStepDevice[] };
          for (const d of retryData.result_list || []) {
            if (d?.device_id) byId.set(String(d.device_id), d);
          }
          break;
        }
        throw new Error(`OneStep devices ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = JSON.parse(body) as {
        result_list?: OneStepDevice[];
        total_count?: number;
      };
      const list = data.result_list || [];
      for (const d of list) {
        if (d?.device_id) byId.set(String(d.device_id), d);
      }
      // Stop when a short page means end of list
      if (list.length < pageSize) break;
      if (typeof data.total_count === "number" && byId.size >= data.total_count) break;
    }

    const positions: LivePosition[] = [];
    const devices: ProviderDeviceSummary[] = [];
    let withoutPosition = 0;
    for (const d of byId.values()) {
      const displayName = (d.display_name || d.name || `Device ${d.device_id}`).trim();
      // Prefer vehicles marked One Step, but always fall back to all units for matching
      const matched =
        matchVehicle(displayName, vehicles, "one") ||
        matchVehicle(displayName, vehicles) ||
        (d.factory_id ? matchVehicle(d.factory_id, vehicles) : null);
      const point = extractPoint(d);
      devices.push({
        id: String(d.device_id),
        name: displayName,
        online: d.online ?? null,
        has_position: Boolean(point),
        unit_number: matched?.unit_number ?? null,
        vehicle_id: matched?.id ?? null,
      });
      if (!point) {
        withoutPosition++;
        continue;
      }
      // Always plot — new OneStep devices need no app registration
      const oos = (matched?.status || "").toLowerCase() === "out_of_service";
      positions.push({
        id: `onestep:${d.device_id}`,
        provider: "onestep",
        name: displayName,
        // Matched units: tech or pool label only — empty = Unassigned (still on map).
        // Do not fall back to GPS device name (that looked like someone was assigned).
        driver_name: mapDriverLabel(matched, displayName),
        phone: null,
        lat: point.lat,
        lng: point.lng,
        speed_mph: point.speed,
        heading: point.angle,
        status: point.state || (d.online ? "online" : d.active_state || "offline"),
        address: null,
        last_update: point.dt,
        vehicle_id: matched?.id ?? null,
        unit_number: matched?.unit_number ?? null,
        plate: matched?.plate ?? null,
        online: d.online ?? null,
        vehicle_status: matched?.status ?? null,
        out_of_service: oos,
      });
    }
    // Stable sort for UI
    devices.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    return {
      positions,
      total_devices: byId.size,
      without_position: withoutPosition,
      devices,
    };
  } catch (e) {
    // Invalidate login cache so next poll retries auth (password rotate, etc.)
    oneStepCache = null;
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
      const oos = (matched?.status || "").toLowerCase() === "out_of_service";
      positions.push({
        id: `verizon:${p.id}`,
        provider: "verizon",
        name: label,
        driver_name: mapDriverLabel(matched, p.dnme || null),
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
        vehicle_status: matched?.status ?? null,
        out_of_service: oos,
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
      // Pool / warehouse trucks have no tech to call
      if (isPoolDriverLabel(p.driver_name)) continue;
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

/**
 * One unit must only appear once on the map.
 * Prefer the provider set on the vehicle record, then freshest last_update.
 */
function dedupePositionsByVehicle(
  positions: LivePosition[],
  vehicles: FleetVehicle[]
): LivePosition[] {
  const preferred = new Map<number, GpsProvider | null>();
  for (const v of vehicles) {
    const t = (v.gps_tracker || "").toLowerCase();
    if (/verizon|reveal|vzw/.test(t)) preferred.set(v.id, "verizon");
    else if (/one\s*step|onestep|1step/.test(t)) preferred.set(v.id, "onestep");
    else preferred.set(v.id, null);
  }

  const ageMs = (iso: string | null | undefined): number => {
    if (!iso) return Number.POSITIVE_INFINITY;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : Date.now() - t;
  };

  const byVehicle = new Map<number, LivePosition[]>();
  const unmatched: LivePosition[] = [];
  for (const p of positions) {
    if (p.vehicle_id == null) {
      unmatched.push(p);
      continue;
    }
    const arr = byVehicle.get(p.vehicle_id) || [];
    arr.push(p);
    byVehicle.set(p.vehicle_id, arr);
  }

  const deduped: LivePosition[] = [];
  for (const [vid, list] of byVehicle) {
    if (list.length === 1) {
      deduped.push(list[0]);
      continue;
    }
    const prefer = preferred.get(vid);
    let pick =
      (prefer && list.find((p) => p.provider === prefer)) ||
      list.slice().sort((a, b) => ageMs(a.last_update) - ageMs(b.last_update))[0];
    // If preferred provider exists but is much staler (>10m) than another, use fresher
    if (prefer) {
      const preferredPos = list.find((p) => p.provider === prefer);
      const freshest = list.slice().sort((a, b) => ageMs(a.last_update) - ageMs(b.last_update))[0];
      if (
        preferredPos &&
        freshest &&
        preferredPos.id !== freshest.id &&
        ageMs(preferredPos.last_update) - ageMs(freshest.last_update) > 10 * 60 * 1000
      ) {
        pick = freshest;
      } else if (preferredPos) {
        pick = preferredPos;
      }
    }
    deduped.push(pick);
  }

  // Unmatched devices: also collapse identical names at nearly same coords
  const seenUnmatched = new Set<string>();
  for (const p of unmatched) {
    const key = `${p.provider}:${normalizeName(p.name)}`;
    if (seenUnmatched.has(key)) continue;
    seenUnmatched.add(key);
    deduped.push(p);
  }
  return deduped;
}

/** Save last known coords whenever a real GPS fix is matched to a fleet unit. */
async function persistLastKnownGps(db: D1Database, positions: LivePosition[]): Promise<void> {
  for (const p of positions) {
    if (p.vehicle_id == null) continue;
    if (String(p.id).startsWith("oos:")) continue;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    if (p.lat === 0 && p.lng === 0) continue;
    try {
      await db
        .prepare(
          `UPDATE vehicles
           SET last_lat = ?, last_lng = ?, last_gps_at = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(p.lat, p.lng, p.last_update || new Date().toISOString(), p.vehicle_id)
        .run();
    } catch {
      /* columns may not exist until migration — ignore */
    }
  }
}

/**
 * Out-of-service units must stay visible (red) even if the tracker is off.
 * Prefer last known GPS; fall back to yard so they are still accounted for.
 */
function injectOutOfServicePins(
  vehicles: FleetVehicle[],
  positions: LivePosition[]
): LivePosition[] {
  const onMap = new Set<number>();
  for (const p of positions) {
    if (p.vehicle_id != null) onMap.add(p.vehicle_id);
  }

  const extra: LivePosition[] = [];
  for (const v of vehicles) {
    if (!isOutOfService(v.status)) continue;
    if (onMap.has(v.id)) continue;

    const hasLast =
      v.last_lat != null &&
      v.last_lng != null &&
      Number.isFinite(Number(v.last_lat)) &&
      Number.isFinite(Number(v.last_lng)) &&
      !(Number(v.last_lat) === 0 && Number(v.last_lng) === 0);

    const lat = hasLast ? Number(v.last_lat) : DEFAULT_YARD_LAT;
    const lng = hasLast ? Number(v.last_lng) : DEFAULT_YARD_LNG;
    const provider = providerFromTracker(v.gps_tracker);

    extra.push({
      id: `oos:${v.id}`,
      provider,
      name: `Unit ${v.unit_number}`,
      driver_name: v.assigned_driver || null,
      phone: null,
      lat,
      lng,
      speed_mph: 0,
      heading: null,
      status: "out_of_service",
      address: hasLast ? "Last known location" : "Yard (no GPS fix — out of service)",
      last_update: hasLast ? v.last_gps_at || null : null,
      vehicle_id: v.id,
      unit_number: v.unit_number,
      plate: v.plate,
      online: false,
      vehicle_status: v.status,
      out_of_service: true,
    });
  }
  return extra.length ? [...positions, ...extra] : positions;
}

export async function getLivePositions(env: Env, force = false): Promise<LivePositionsResult> {
  if (!force && positionsCache && Date.now() - positionsCache.at < POSITIONS_TTL_MS) {
    return positionsCache.data;
  }

  let vehicles: FleetVehicle[] = [];
  try {
    const rows = await env.DB.prepare(
      `SELECT id, unit_number, plate, assigned_driver, gps_tracker, status,
              last_lat, last_lng, last_gps_at
       FROM vehicles WHERE status != 'retired'`
    ).all<FleetVehicle>();
    vehicles = rows.results || [];
  } catch {
    // Pre-migration DBs without last_* columns
    const rows = await env.DB.prepare(
      `SELECT id, unit_number, plate, assigned_driver, gps_tracker, status
       FROM vehicles WHERE status != 'retired'`
    ).all<FleetVehicle>();
    vehicles = rows.results || [];
  }

  const onestepConfigured = Boolean(env.ONESTEP_USER && env.ONESTEP_PASS);
  const verizonConfigured = Boolean(env.VERIZON_USER && env.VERIZON_PASS);

  const [os, vz] = await Promise.all([
    fetchOneStepPositions(env, vehicles),
    fetchVerizonPositions(env, vehicles),
  ]);

  let positions = dedupePositionsByVehicle([...os.positions, ...vz.positions], vehicles);

  // Ensure live matches flag out_of_service even if status string varies
  for (const p of positions) {
    if (p.vehicle_id == null) continue;
    const v = vehicles.find((x) => x.id === p.vehicle_id);
    if (v && isOutOfService(v.status)) {
      p.out_of_service = true;
      p.vehicle_status = v.status;
    }
  }

  // Persist last known from real GPS (not synthetic oos: pins)
  await persistLastKnownGps(env.DB, positions);

  // Always show OOS units (red) — last known or yard fallback
  positions = injectOutOfServicePins(vehicles, positions);

  await attachDriverPhones(env.DB, positions);

  const data: LivePositionsResult = {
    fetched_at: new Date().toISOString(),
    positions,
    providers: {
      onestep: {
        ok: !os.error,
        count: positions.filter((p) => p.provider === "onestep" && !String(p.id).startsWith("oos:")).length,
        error: os.error,
        configured: onestepConfigured,
        total_devices: os.total_devices,
        without_position: os.without_position,
        devices: os.devices,
      },
      verizon: {
        ok: !vz.error,
        count: positions.filter((p) => p.provider === "verizon" && !String(p.id).startsWith("oos:")).length,
        error: vz.error,
        configured: verizonConfigured,
      },
    },
  };

  positionsCache = { at: Date.now(), data };
  return data;
}
