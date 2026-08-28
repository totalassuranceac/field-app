/**
 * LTS / Hikvision-style NVR snapshot proxy (ISAPI).
 * Credentials stay on the server — Field App users never log into the NVR.
 *
 * NVR must be reachable from Cloudflare (port forward or tunnel).
 * Plain 192.168.x.x is NOT reachable from the Worker without a public path.
 */
import { createHash } from "node:crypto";
import type { Env } from "./types";
import { getSetting } from "./audit";

export type NvrChannel = { id: number; label: string; enabled?: boolean };

/** Unified tile for Security cameras (NVR channel or Wyze). */
export type CamTile = {
  key: string;
  source: "nvr" | "wyze";
  id: string;
  label: string;
  enabled: boolean;
  /** Wyze RTSP stream name on the bridge (when source=wyze) */
  rtsp_path?: string;
};

export type WyzeCamConfig = {
  id: string;
  label: string;
  rtsp_path: string;
  enabled?: boolean;
};

/**
 * Wyze tiles stay off by default until Bridge is installed on the shop PC.
 * Enabling them with no Bridge used to spawn hung ffmpeg and freeze NVR too.
 * Turn on via PUT /warehouse-cameras/config { wyze_cameras: [...] enabled:true }
 * after install-wyze-bridge.ps1 succeeds.
 */
const DEFAULT_WYZE_CAMERAS: WyzeCamConfig[] = [
  { id: "warehouse", label: "Warehouse", rtsp_path: "warehouse", enabled: false },
  { id: "autoshop", label: "Autoshop", rtsp_path: "autoshop", enabled: false },
  { id: "autoshop-2", label: "Autoshop 2", rtsp_path: "autoshop-2", enabled: false },
];

export async function resolveWyzeCameras(db: D1Database): Promise<WyzeCamConfig[]> {
  try {
    const raw = await getSetting(db, "warehouse_wyze_cameras", "");
    if (raw) {
      const parsed = JSON.parse(raw) as WyzeCamConfig[];
      if (Array.isArray(parsed) && parsed.length) {
        return parsed
          .filter((c) => c && c.id)
          .map((c) => ({
            id: String(c.id).trim(),
            label: String(c.label || c.id).trim(),
            rtsp_path: String(c.rtsp_path || c.id).trim(),
            enabled: c.enabled !== false,
          }));
      }
    }
  } catch {
    /* defaults */
  }
  return DEFAULT_WYZE_CAMERAS.map((c) => ({ ...c }));
}

export async function buildCameraTiles(
  env: Env,
  db: D1Database
): Promise<{ nvr: Awaited<ReturnType<typeof resolveNvrConfig>>; cameras: CamTile[] }> {
  const nvr = await resolveNvrConfig(env, db);
  const cameras: CamTile[] = [];
  for (const ch of nvr.channels) {
    if (ch.enabled === false) continue;
    cameras.push({
      key: `nvr:${ch.id}`,
      source: "nvr",
      id: String(ch.id),
      label: ch.label || `Camera ${ch.id}`,
      enabled: true,
    });
  }
  const wyze = await resolveWyzeCameras(db);
  for (const w of wyze) {
    if (w.enabled === false) continue;
    cameras.push({
      key: `wyze:${w.id}`,
      source: "wyze",
      id: w.id,
      label: w.label,
      enabled: true,
      rtsp_path: w.rtsp_path,
    });
  }
  return { nvr, cameras };
}

export function parseCameraKey(
  raw: string
): { source: "nvr" | "wyze"; id: string } | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("wyze:")) {
    const id = s.slice(5).trim();
    return id ? { source: "wyze", id } : null;
  }
  if (s.startsWith("nvr:")) {
    const id = s.slice(4).trim();
    return id ? { source: "nvr", id } : null;
  }
  // Legacy numeric channel
  if (/^\d+$/.test(s)) return { source: "nvr", id: s };
  // Bare wyze id
  return { source: "wyze", id: s };
}

/** JPEG from shop proxy: /fieldapp/wyze/snapshot?cam= */
export async function fetchWyzeSnapshot(
  baseUrl: string,
  camId: string
): Promise<
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status?: number }
> {
  if (!baseUrl) return { ok: false, error: "Camera tunnel not configured" };
  const base = baseUrl.replace(/\/+$/, "");
  const url = `${base}/fieldapp/wyze/snapshot?cam=${encodeURIComponent(camId)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "image/jpeg,*/*", "User-Agent": "FieldApp-Wyze/1.0" },
      redirect: "follow",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      let msg = t.replace(/\s+/g, " ").slice(0, 220);
      try {
        const j = JSON.parse(t) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* keep */
      }
      // Old media proxy / bare NVR returns HTML 404 for /fieldapp/wyze/*
      if (
        res.status === 404 ||
        /Document Error|Access Error|Not Found|Can't open URL/i.test(msg) ||
        /<!DOCTYPE|<html/i.test(t)
      ) {
        msg =
          "Wyze path not on shop PC yet. Update nvr-media-proxy.mjs and start Wyze Bridge (install-wyze-bridge.ps1), then restart the media proxy.";
      }
      return {
        ok: false,
        status: res.status,
        error: msg || `Wyze snapshot failed (${res.status})`,
      };
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 200) return { ok: false, error: "Empty Wyze snapshot" };
    const u8 = new Uint8Array(bytes);
    // JPEG magic FF D8 — reject HTML/JSON mistaken for images
    if (!(u8[0] === 0xff && u8[1] === 0xd8)) {
      const head = new TextDecoder().decode(u8.slice(0, 80));
      if (/<!DOCTYPE|<html|Document Error|Not Found/i.test(head)) {
        return {
          ok: false,
          status: 502,
          error:
            "Wyze path not on shop PC yet. Update nvr-media-proxy.mjs and start Wyze Bridge, then restart the media proxy.",
        };
      }
      return {
        ok: false,
        error:
          "Wyze snapshot was not JPEG — shop media proxy may be outdated or Wyze Bridge is offline.",
      };
    }
    return {
      ok: true,
      bytes,
      contentType: res.headers.get("Content-Type") || "image/jpeg",
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? e.message
          : "Wyze proxy unreachable — is the tunnel + Wyze Bridge running?",
    };
  }
}

/** MP4 clip from shop proxy ring-buffer or near-live capture */
export async function fetchWyzeClipMp4(
  baseUrl: string,
  camId: string,
  start: Date,
  end: Date
): Promise<
  | { ok: true; bytes: ArrayBuffer; contentType: string }
  | { ok: false; error: string; status?: number }
> {
  if (!baseUrl) return { ok: false, error: "Camera tunnel not configured" };
  const base = baseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    cam: camId,
    start: start.toISOString(),
    end: end.toISOString(),
  });
  const url = `${base}/fieldapp/wyze/clip?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "video/mp4,*/*", "User-Agent": "FieldApp-Wyze/1.0" },
      redirect: "follow",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      let msg = t.replace(/\s+/g, " ").slice(0, 260);
      try {
        const j = JSON.parse(t) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* keep */
      }
      return {
        ok: false,
        status: res.status,
        error: msg || `Wyze clip failed (${res.status})`,
      };
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 500) return { ok: false, error: "Empty Wyze clip" };
    return { ok: true, bytes, contentType: "video/mp4" };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? e.message
          : "Wyze clip proxy unreachable — is the tunnel + media proxy running?",
    };
  }
}

/** MD5 for HTTP Digest (nodejs_compat on Workers). */
function md5(str: string): string {
  return createHash("md5").update(str, "utf8").digest("hex");
}

function sha256(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

/** Short-lived session cache (Worker isolate memory). */
const sessionCache = new Map<string, { cookie: string; exp: number }>();

function parseDigestChallenge(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = header.match(/^Digest\s+(.+)$/i);
  if (!m) return out;
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1]))) {
    out[x[1]] = x[2] ?? x[3] ?? "";
  }
  return out;
}

function buildDigestAuth(
  challenge: Record<string, string>,
  user: string,
  pass: string,
  method: string,
  uri: string
): string {
  const realm = challenge.realm || "";
  const nonce = challenge.nonce || "";
  // qop may be `auth` or `auth,auth-int` — use first token only
  let qop = (challenge.qop || "").split(",")[0]?.trim().replace(/"/g, "") || "";
  if (qop && qop !== "auth" && qop !== "auth-int") qop = "auth";
  const opaque = challenge.opaque;
  const algorithm = (challenge.algorithm || "MD5").split(",")[0].trim();
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uri}`);
  const nc = "00000001";
  const cnonce = md5(`${Date.now()}-${Math.random()}`);
  let response: string;
  if (qop) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  // Hikvision is picky: omit empty opaque; quote algorithm value like the challenge
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", algorithm="${algorithm}", response="${response}"`;
  if (qop) h += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) h += `, opaque="${opaque}"`;
  return h;
}

export async function resolveNvrConfig(
  env: Env,
  db: D1Database
): Promise<{
  baseUrl: string;
  user: string;
  pass: string;
  channels: NvrChannel[];
  configured: boolean;
  reachableHint: string;
}> {
  const baseUrl = (
    env.WAREHOUSE_NVR_URL ||
    (await getSetting(db, "warehouse_nvr_url", "")) ||
    ""
  )
    .trim()
    .replace(/\/+$/, "");
  const user = (
    env.WAREHOUSE_NVR_USER ||
    (await getSetting(db, "warehouse_nvr_user", "admin")) ||
    "admin"
  ).trim();
  const pass = (
    env.WAREHOUSE_NVR_PASS ||
    (await getSetting(db, "warehouse_nvr_pass", "")) ||
    ""
  ).trim();

  let channels: NvrChannel[] = [];
  try {
    const raw = await getSetting(db, "warehouse_nvr_channels", "");
    if (raw) {
      const parsed = JSON.parse(raw) as NvrChannel[];
      if (Array.isArray(parsed)) channels = parsed.filter((c) => c && c.id > 0);
    }
  } catch {
    /* ignore */
  }
  if (!channels.length) {
    channels = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      label: `Camera ${i + 1}`,
      enabled: true,
    }));
  }

  const isPrivate =
    /^(https?:\/\/)?(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost|127\.)/i.test(
      baseUrl
    );

  return {
    baseUrl,
    user,
    pass,
    channels,
    configured: Boolean(baseUrl && user && pass),
    reachableHint: isPrivate
      ? "This is a shop-only address (192.168…). Use router port forwarding to your NVR (always on — no PC needed), then put https://YOUR.PUBLIC.IP:PORT in Setup. Or a Cloudflare Tunnel if you prefer."
      : "NVR URL looks reachable from the internet. Snapshots use saved credentials — no login in the app.",
  };
}

export async function fetchNvrSnapshot(
  baseUrl: string,
  user: string,
  pass: string,
  channelId: number,
  preferSub = true
): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false; error: string; status?: number }> {
  if (!baseUrl || !user || !pass) {
    return { ok: false, error: "NVR URL / user / password not configured" };
  }
  if (!Number.isFinite(channelId) || channelId < 1 || channelId > 64) {
    return { ok: false, error: "Invalid channel" };
  }

  const base = baseUrl.replace(/\/+$/, "");
  // Keep subrequests low (CF Worker limits) — browser-proven path is .../101/picture
  const streamId = `${channelId}01`;
  const path = `/ISAPI/Streaming/channels/${streamId}/picture`;
  const url = `${base}${path}`;
  // Port-forward only: some NVR firmwares want Host as LAN IP (else bare 403 / 1003).
  // Cloudflare Tunnel already rewrites Host at the origin — do NOT force Host there
  // (Workers also often strip Host overrides for third-party hostnames).
  const isTunnel = /trycloudflare\.com|cfargotunnel\.com|\.cloudflareaccess\.com/i.test(base);
  const isLan =
    /192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(base);
  const host = !isLan && !isTunnel ? "192.168.1.111" : undefined;

  // 1) Session (cached) + one snapshot
  const session = await obtainNvrSession(base, user, pass, host);
  if (session.ok) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: nvrCommonHeaders(
          {
            Cookie: session.cookie,
            SessionTag: session.sessionId || "",
          },
          host
        ),
        redirect: "follow",
      });
      const got = await readResult(res);
      if (got.ok) return got;
    } catch (e) {
      /* fall through */
    }
  }

  // 2) Digest then Basic (few subrequests)
  try {
    const result = await fetchWithNvrAuth(url, path, user, pass, host);
    if (result.ok) return result;
    // Retry once without Host override if Host caused issues
    if (host) {
      const result2 = await fetchWithNvrAuth(url, path, user, pass, undefined);
      if (result2.ok) return result2;
      return result2;
    }
    return result;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "NVR fetch failed",
    };
  }
}

/**
 * Hikvision/LTS session login — required by many firmwares for remote ISAPI.
 * Encodes password with SHA256 when isIrreversible is true (modern devices).
 */
async function obtainNvrSession(
  baseUrl: string,
  user: string,
  pass: string,
  hostOverride?: string
): Promise<{ ok: true; cookie: string; sessionId?: string } | { ok: false; error: string }> {
  const cacheKey = `${baseUrl}|${user}|${pass}|${hostOverride || ""}`;
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) {
    return { ok: true, cookie: cached.cookie, sessionId: cached.cookie.replace(/^WebSession=/i, "") };
  }

  try {
    const capUrl = `${baseUrl}/ISAPI/Security/sessionLogin/capabilities?username=${encodeURIComponent(user)}`;
    const capRes = await fetch(capUrl, {
      method: "GET",
      headers: nvrCommonHeaders({ Accept: "application/xml,text/xml,*/*" }, hostOverride),
      redirect: "follow",
    });
    const capXml = await capRes.text();
    if (!capRes.ok && capRes.status !== 200) {
      // Some units return 401 with capabilities still in body; continue if XML looks valid
      if (!/<sessionID/i.test(capXml) && !/<SessionLoginCap/i.test(capXml)) {
        return {
          ok: false,
          error: `Session capabilities failed (${capRes.status}): ${capXml.replace(/\s+/g, " ").slice(0, 120)}`,
        };
      }
    }

    const sessionID =
      xmlTag(capXml, "sessionID") ||
      xmlTag(capXml, "sessionId") ||
      "";
    const challenge = xmlTag(capXml, "challenge") || "";
    const salt = xmlTag(capXml, "salt") || "";
    const iterations = Math.max(1, Number(xmlTag(capXml, "iterations") || "100") || 100);
    const isIrreversible =
      /true/i.test(xmlTag(capXml, "isIrreversible") || "") ||
      /true/i.test(xmlTag(capXml, "isIrreversible") || "");

    let encodedPassword = pass;
    if (isIrreversible || (challenge && salt)) {
      // Standard Hikvision irreversible password chain
      let enc = sha256(user + salt + pass);
      enc = sha256(enc + challenge);
      for (let i = 2; i < iterations; i++) {
        enc = sha256(enc);
      }
      encodedPassword = enc;
    }

    const loginBody = `<?xml version="1.0" encoding="UTF-8"?>
<SessionLogin>
  <userName>${escapeXml(user)}</userName>
  <password>${escapeXml(encodedPassword)}</password>
  <sessionID>${escapeXml(sessionID)}</sessionID>
  <isSessionIDValidLongTerm>false</isSessionIDValidLongTerm>
  <sessionIDVersion>2</sessionIDVersion>
</SessionLogin>`;

    const loginRes = await fetch(
      `${baseUrl}/ISAPI/Security/sessionLogin?timeStamp=${Date.now()}`,
      {
        method: "POST",
        headers: nvrCommonHeaders(
          {
            Accept: "application/xml,text/xml,*/*",
            "Content-Type": "application/xml; charset=UTF-8",
          },
          hostOverride
        ),
        body: loginBody,
        redirect: "follow",
      }
    );
    const loginXml = await loginRes.text();
    const setCookie = loginRes.headers.get("Set-Cookie") || "";
    const cookieFromHeader = setCookie.match(/WebSession=([^;,\s]+)/i)?.[1];
    const sessionFromBody =
      xmlTag(loginXml, "sessionID") || xmlTag(loginXml, "sessionId") || "";
    const sid = cookieFromHeader || sessionFromBody || sessionID;

    if (!loginRes.ok && !sid) {
      return {
        ok: false,
        error: `Session login failed (${loginRes.status}): ${loginXml.replace(/\s+/g, " ").slice(0, 160)}`,
      };
    }
    if (!sid) {
      return {
        ok: false,
        error: `Session login: no sessionID in response: ${loginXml.replace(/\s+/g, " ").slice(0, 160)}`,
      };
    }

    const cookie = `WebSession=${sid}`;
    sessionCache.set(cacheKey, { cookie, exp: Date.now() + 4 * 60 * 1000 });
    return { ok: true, cookie, sessionId: sid };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Session login network error",
    };
  }
}

function xmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i");
  const m = xml.match(re);
  return (m?.[1] || "").trim();
}

/**
 * When we reach the NVR via public IP:port, many LTS/Hikvision units return
 * bare 403 "error code: 1003" (no WWW-Authenticate) unless Host looks local.
 * Browser on LAN sends Host: 192.168.1.111 — match that.
 */
function nvrCommonHeaders(
  extra?: Record<string, string>,
  hostOverride?: string
): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "image/jpeg,image/*,*/*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Connection: "keep-alive",
    ...(extra || {}),
  };
  if (hostOverride) {
    h.Host = hostOverride;
  }
  return h;
}

function localHostCandidates(publicUrl: string): string[] {
  // Prefer classic NVR LAN host; also try without forcing Host
  const out = ["192.168.1.111", "192.168.1.111:80"];
  try {
    const u = new URL(publicUrl);
    // If admin set a hostname, try that too
    if (u.hostname && !/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) {
      out.unshift(u.hostname);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function isJpegBytes(bytes: ArrayBuffer): boolean {
  const u8 = new Uint8Array(bytes);
  return u8.length > 2 && u8[0] === 0xff && u8[1] === 0xd8;
}

async function readResult(
  res: Response
): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false; error: string; status?: number }> {
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const short = t.replace(/\s+/g, " ").slice(0, 200);
    return {
      ok: false,
      status: res.status,
      error:
        res.status === 401
          ? "NVR rejected username/password"
          : res.status === 404
            ? "Channel not found"
            : `NVR error ${res.status}${short ? `: ${short}` : ""}`,
    };
  }
  const ct = res.headers.get("Content-Type") || "image/jpeg";
  if (ct.includes("xml") || ct.includes("html") || ct.includes("json")) {
    const t = await res.text();
    return {
      ok: false,
      status: 502,
      error: `NVR returned non-image: ${t.replace(/\s+/g, " ").slice(0, 160)}`,
    };
  }
  const bytes = await res.arrayBuffer();
  if (!bytes.byteLength) return { ok: false, error: "Empty image from NVR" };
  if (!isJpegBytes(bytes) && bytes.byteLength < 800) {
    const head = new TextDecoder().decode(new Uint8Array(bytes).slice(0, 200));
    if (/error|statusCode|Forbidden|401|403/i.test(head)) {
      return { ok: false, status: 403, error: `NVR error body: ${head.slice(0, 120)}` };
    }
  }
  return { ok: true, bytes, contentType: ct.split(";")[0] || "image/jpeg" };
}

/**
 * LTS/Hikvision WEB auth is usually Digest. Browsers handle the challenge correctly;
 * we must too (correct MD5 + Digest header). Also try Basic and URL-embedded credentials.
 */
/** Lean auth: probe → one Digest → one Basic (max ~3 subrequests). */
async function fetchWithNvrAuth(
  url: string,
  uriPath: string,
  user: string,
  pass: string,
  hostOverride?: string
): Promise<{ ok: true; bytes: ArrayBuffer; contentType: string } | { ok: false; error: string; status?: number }> {
  // 1) Probe for challenge
  let res = await fetch(url, {
    method: "GET",
    headers: nvrCommonHeaders(undefined, hostOverride),
    redirect: "follow",
  });
  if (res.ok) return readResult(res);

  const www =
    res.headers.get("WWW-Authenticate") ||
    res.headers.get("www-authenticate") ||
    "";
  await res.arrayBuffer().catch(() => null);

  // 2) Digest (one attempt with path URI)
  if (/digest/i.test(www)) {
    const challenge = parseDigestChallenge(www);
    const auth = buildDigestAuth(challenge, user, pass, "GET", uriPath);
    res = await fetch(url, {
      method: "GET",
      headers: nvrCommonHeaders({ Authorization: auth }, hostOverride),
      redirect: "follow",
    });
    if (res.ok) return readResult(res);
    await res.arrayBuffer().catch(() => null);
  }

  // 3) Basic (digest/basic WEB setting)
  res = await fetch(url, {
    method: "GET",
    headers: nvrCommonHeaders(
      { Authorization: `Basic ${btoa(`${user}:${pass}`)}` },
      hostOverride
    ),
    redirect: "follow",
  });
  if (res.ok) return readResult(res);

  const t = await res.text().catch(() => "");
  const short = t.replace(/\s+/g, " ").slice(0, 200);
  return {
    ok: false,
    status: res.status,
    error:
      res.status === 401
        ? "NVR rejected username/password"
        : res.status === 403 && !/digest/i.test(www)
          ? `NVR 403 no auth challenge: ${short || "error 1003"}. Try Host override / session login.`
          : `NVR error ${res.status}${short ? `: ${short}` : ""}`,
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function nvrHostOverride(baseUrl: string): string | undefined {
  const base = baseUrl.replace(/\/+$/, "");
  const isTunnel = /trycloudflare\.com|cfargotunnel\.com|\.cloudflareaccess\.com/i.test(base);
  const isLan =
    /192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|localhost/i.test(base);
  return !isLan && !isTunnel ? "192.168.1.111" : undefined;
}

function utcIsoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export type NvrRecordingSegment = {
  start: string;
  end: string;
  trackId: string;
  playbackURI: string;
};

/**
 * Search NVR for recorded segments on a channel (ISAPI ContentMgmt/search).
 */
export async function searchNvrRecordings(
  baseUrl: string,
  user: string,
  pass: string,
  channelId: number,
  start: Date,
  end: Date
): Promise<
  | { ok: true; segments: NvrRecordingSegment[] }
  | { ok: false; error: string; status?: number }
> {
  if (!baseUrl || !user || !pass) {
    return { ok: false, error: "NVR not configured" };
  }
  if (!Number.isFinite(channelId) || channelId < 1 || channelId > 64) {
    return { ok: false, error: "Invalid channel" };
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { ok: false, error: "Invalid time range" };
  }

  const base = baseUrl.replace(/\/+$/, "");
  const host = nvrHostOverride(base);
  const trackId = `${channelId}01`;
  const path = "/ISAPI/ContentMgmt/search";
  const searchId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `s-${Date.now()}`;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>${searchId}</searchID>
  <trackList><trackID>${trackId}</trackID></trackList>
  <timeSpanList><timeSpan>
    <startTime>${utcIsoZ(start)}</startTime>
    <endTime>${utcIsoZ(end)}</endTime>
  </timeSpan></timeSpanList>
  <maxResults>50</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;

  try {
    // Prefer session cookie when available
    const session = await obtainNvrSession(base, user, pass, host);
    let res: Response;
    if (session.ok) {
      res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: nvrCommonHeaders(
          {
            Accept: "application/xml,text/xml,*/*",
            "Content-Type": "application/xml; charset=UTF-8",
            Cookie: session.cookie,
            SessionTag: session.sessionId || "",
          },
          host
        ),
        body,
        redirect: "follow",
      });
    } else {
      // Digest probe + POST
      const probe = await fetch(`${base}${path}`, {
        method: "POST",
        headers: nvrCommonHeaders(
          {
            Accept: "application/xml",
            "Content-Type": "application/xml; charset=UTF-8",
          },
          host
        ),
        body,
        redirect: "follow",
      });
      if (probe.ok) {
        res = probe;
      } else {
        const www =
          probe.headers.get("WWW-Authenticate") ||
          probe.headers.get("www-authenticate") ||
          "";
        await probe.arrayBuffer().catch(() => null);
        if (/digest/i.test(www)) {
          const challenge = parseDigestChallenge(www);
          const auth = buildDigestAuth(challenge, user, pass, "POST", path);
          res = await fetch(`${base}${path}`, {
            method: "POST",
            headers: nvrCommonHeaders(
              {
                Accept: "application/xml",
                "Content-Type": "application/xml; charset=UTF-8",
                Authorization: auth,
              },
              host
            ),
            body,
            redirect: "follow",
          });
        } else {
          res = await fetch(`${base}${path}`, {
            method: "POST",
            headers: nvrCommonHeaders(
              {
                Accept: "application/xml",
                "Content-Type": "application/xml; charset=UTF-8",
                Authorization: `Basic ${btoa(`${user}:${pass}`)}`,
              },
              host
            ),
            body,
            redirect: "follow",
          });
        }
      }
    }

    const xml = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: `NVR search error ${res.status}: ${xml.replace(/\s+/g, " ").slice(0, 160)}`,
      };
    }

    const segments: NvrRecordingSegment[] = [];
    const re = /<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const block = m[1];
      const playbackURI = (xmlTag(block, "playbackURI") || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
      const segStart = xmlTag(block, "startTime");
      const segEnd = xmlTag(block, "endTime");
      const tid = xmlTag(block, "trackID") || trackId;
      if (playbackURI && segStart && segEnd) {
        segments.push({
          start: segStart,
          end: segEnd,
          trackId: tid,
          playbackURI,
        });
      }
    }

    if (!segments.length) {
      const statusStr = xmlTag(xml, "responseStatusStrg") || "";
      if (/NO MATCHES/i.test(statusStr) || /numOfMatches>0</i.test(xml) === false) {
        return { ok: true, segments: [] };
      }
    }
    return { ok: true, segments };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "NVR search failed",
    };
  }
}

/**
 * Fetch a browser-playable MP4 clip from the shop media proxy
 * (cloudflared → local nvr-media-proxy → ffmpeg).
 * URL: {nvrBase}/fieldapp/clip?channel=&start=&end=
 */
export async function fetchNvrClipMp4(
  baseUrl: string,
  channelId: number,
  start: Date,
  end: Date,
  mode: "at" | "prev" | "next" = "at"
): Promise<
  | {
      ok: true;
      bytes: ArrayBuffer;
      contentType: string;
      clipStart?: string | null;
      clipEnd?: string | null;
      gapSec?: number;
      mode?: string;
    }
  | { ok: false; error: string; status?: number }
> {
  if (!baseUrl) return { ok: false, error: "NVR not configured" };
  if (!Number.isFinite(channelId) || channelId < 1 || channelId > 64) {
    return { ok: false, error: "Invalid channel" };
  }
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { ok: false, error: "Invalid time range" };
  }
  // Cap duration at 30 minutes (proxy also caps)
  const maxMs = 30 * 60 * 1000;
  if (end.getTime() - start.getTime() > maxMs) {
    end = new Date(start.getTime() + maxMs);
  }

  const base = baseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    channel: String(channelId),
    start: utcIsoZ(start),
    end: utcIsoZ(end),
    mode: mode === "prev" || mode === "next" ? mode : "at",
  });
  const url = `${base}/fieldapp/clip?${qs.toString()}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "video/mp4,*/*",
        "User-Agent": "FieldApp-Clip/1.0",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      let msg = t.replace(/\s+/g, " ").slice(0, 220);
      try {
        const j = JSON.parse(t) as { error?: string };
        if (j.error) msg = j.error;
      } catch {
        /* keep text */
      }
      return {
        ok: false,
        status: res.status,
        error:
          msg ||
          (res.status === 404
            ? "No recording for that time"
            : `Clip failed (${res.status})`),
      };
    }
    const ct = res.headers.get("Content-Type") || "video/mp4";
    if (ct.includes("json") || ct.includes("xml") || ct.includes("text")) {
      const t = await res.text();
      return {
        ok: false,
        status: 502,
        error: t.replace(/\s+/g, " ").slice(0, 200) || "Clip proxy returned non-video",
      };
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength < 500) {
      return { ok: false, error: "Empty clip from proxy" };
    }
    // ftyp / mp4 magic
    const u8 = new Uint8Array(bytes);
    const head = new TextDecoder().decode(u8.slice(0, 12));
    if (!head.includes("ftyp") && !(u8[4] === 0x66 && u8[5] === 0x74)) {
      // still allow if large enough binary
      if (bytes.byteLength < 2000) {
        return { ok: false, error: "Proxy did not return MP4 video" };
      }
    }
    const gapRaw = res.headers.get("X-Clip-Gap-Sec");
    return {
      ok: true,
      bytes,
      contentType: "video/mp4",
      clipStart: res.headers.get("X-Clip-Start"),
      clipEnd: res.headers.get("X-Clip-End"),
      gapSec: gapRaw != null && gapRaw !== "" ? Number(gapRaw) : 0,
      mode: res.headers.get("X-Clip-Mode") || mode,
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? e.message
          : "Clip proxy unreachable — is the NVR tunnel/media proxy running?",
    };
  }
}

export type NvrSegmentListItem = {
  start: string;
  end: string;
  durationSec: number;
};

/**
 * List motion clips near a time via shop media proxy (/fieldapp/segments).
 * Same search path as clip download (local-as-Z), so times match playback.
 */
export async function fetchNvrSegmentsList(
  baseUrl: string,
  channelId: number,
  around: Date,
  padMin = 60
): Promise<
  | {
      ok: true;
      around: string;
      padMin: number;
      nearestIndex: number;
      nearestGapSec: number | null;
      segments: NvrSegmentListItem[];
    }
  | { ok: false; error: string; status?: number }
> {
  if (!baseUrl) return { ok: false, error: "NVR not configured" };
  if (!Number.isFinite(channelId) || channelId < 1 || channelId > 64) {
    return { ok: false, error: "Invalid channel" };
  }
  if (Number.isNaN(around.getTime())) {
    return { ok: false, error: "Invalid around time" };
  }
  const pad = Math.min(360, Math.max(5, Number(padMin) || 60));
  const base = baseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    channel: String(channelId),
    around: utcIsoZ(around),
    padMin: String(pad),
  });
  const url = `${base}/fieldapp/segments?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "FieldApp-Segments/1.0",
      },
      redirect: "follow",
    });
    const text = await res.text();
    if (!res.ok) {
      let err = text.replace(/\s+/g, " ").slice(0, 200);
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) err = j.error;
      } catch {
        /* keep */
      }
      if (res.status === 404 && /Document Error|Can't open URL|<!DOCTYPE/i.test(text)) {
        return {
          ok: false,
          status: 404,
          error:
            "Shop camera proxy is outdated (no /fieldapp/segments). Update nvr-media-proxy on the NUC and restart it.",
        };
      }
      return { ok: false, status: res.status, error: err || `Segments failed (${res.status})` };
    }
    const data = JSON.parse(text) as {
      around?: string;
      padMin?: number;
      nearestIndex?: number;
      nearestGapSec?: number | null;
      segments?: NvrSegmentListItem[];
    };
    return {
      ok: true,
      around: data.around || around.toISOString(),
      padMin: data.padMin ?? pad,
      nearestIndex: typeof data.nearestIndex === "number" ? data.nearestIndex : -1,
      nearestGapSec:
        data.nearestGapSec == null || Number.isNaN(Number(data.nearestGapSec))
          ? null
          : Number(data.nearestGapSec),
      segments: Array.isArray(data.segments) ? data.segments : [],
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? e.message
          : "Segments proxy unreachable — is the NVR tunnel/media proxy running?",
    };
  }
}

/** List Wyze ring-buffer segments near a time via shop media proxy. */
export async function fetchWyzeSegmentsList(
  baseUrl: string,
  camId: string,
  around: Date,
  padMin = 60
): Promise<
  | {
      ok: true;
      around: string;
      padMin: number;
      nearestIndex: number;
      nearestGapSec: number | null;
      segments: NvrSegmentListItem[];
    }
  | { ok: false; error: string; status?: number }
> {
  if (!baseUrl) return { ok: false, error: "NVR not configured" };
  if (!camId) return { ok: false, error: "Missing cam id" };
  if (Number.isNaN(around.getTime())) {
    return { ok: false, error: "Invalid around time" };
  }
  const pad = Math.min(360, Math.max(5, Number(padMin) || 60));
  const base = baseUrl.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    cam: camId,
    around: utcIsoZ(around),
    padMin: String(pad),
  });
  const url = `${base}/fieldapp/wyze/segments?${qs.toString()}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "FieldApp-Segments/1.0",
      },
      redirect: "follow",
    });
    const text = await res.text();
    if (!res.ok) {
      let err = text.replace(/\s+/g, " ").slice(0, 200);
      try {
        const j = JSON.parse(text) as { error?: string };
        if (j.error) err = j.error;
      } catch {
        /* keep */
      }
      if (res.status === 404 && /Document Error|Can't open URL|<!DOCTYPE/i.test(text)) {
        return {
          ok: false,
          status: 404,
          error:
            "Shop camera proxy is outdated. Update nvr-media-proxy on the NUC and restart it.",
        };
      }
      return { ok: false, status: res.status, error: err || `Wyze segments failed (${res.status})` };
    }
    const data = JSON.parse(text) as {
      around?: string;
      padMin?: number;
      nearestIndex?: number;
      nearestGapSec?: number | null;
      segments?: NvrSegmentListItem[];
    };
    return {
      ok: true,
      around: data.around || around.toISOString(),
      padMin: data.padMin ?? pad,
      nearestIndex: typeof data.nearestIndex === "number" ? data.nearestIndex : -1,
      nearestGapSec:
        data.nearestGapSec == null || Number.isNaN(Number(data.nearestGapSec))
          ? null
          : Number(data.nearestGapSec),
      segments: Array.isArray(data.segments) ? data.segments : [],
    };
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof Error
          ? e.message
          : "Wyze segments unreachable — is the media proxy running?",
    };
  }
}
