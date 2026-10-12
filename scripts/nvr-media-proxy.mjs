/**
 * Local reverse proxy in front of the LTS NVR for the Field App tunnel.
 *
 * - Default: proxy all traffic to the NVR (ISAPI, web UI, snapshots).
 * - /fieldapp/clip: search + download recording, ffmpeg → browser MP4.
 *
 * Env / config (C:\ProgramData\TotalAssurance\nvr-tunnel\proxy-config.json):
 *   nvrBase, nvrUser, nvrPass, ffmpegPath, listenPort
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CONFIG_PATH =
  process.env.NVR_PROXY_CONFIG ||
  "C:\\ProgramData\\TotalAssurance\\nvr-tunnel\\proxy-config.json";

function loadConfig() {
  const defaults = {
    nvrBase: "http://192.168.1.111",
    nvrUser: "admin",
    nvrPass: "",
    ffmpegPath: "C:\\ProgramData\\TotalAssurance\\nvr-tunnel\\ffmpeg.exe",
    listenPort: 8791, // 8790 may be stuck on old process; config overrides
    maxClipSeconds: 1800, // 30 minutes
    /** Wyze Bridge RTSP base (docker-wyze-bridge default port 8554) */
    wyzeRtspBase: "rtsp://127.0.0.1:8554",
    /**
     * Continuous local ring-buffer for playback scrub.
     * Default OFF until Wyze Bridge is installed — ON with no bridge
     * spawns hung ffmpeg and freezes NVR snapshots too.
     */
    wyzeRecord: false,
    wyzeRecordDir:
      "C:\\ProgramData\\TotalAssurance\\nvr-tunnel\\wyze-record",
    wyzeRecordRetainHours: 72,
    /** Segment length matches Field App CLIP_SEC (2.5 min) */
    wyzeSegmentSec: 150,
    /**
     * Cameras on my.wyze.com — id is stable, rtspPath is Wyze Bridge stream name
     * (usually nickname lowercased; fix in config if bridge renames).
     */
    wyzeCameras: [
      { id: "warehouse", label: "Warehouse", rtspPath: "warehouse", enabled: true },
      { id: "autoshop", label: "Autoshop", rtspPath: "autoshop", enabled: true },
      { id: "autoshop-2", label: "Autoshop 2", rtspPath: "autoshop-2", enabled: true },
    ],
  };
  try {
    if (existsSync(CONFIG_PATH)) {
      // Strip UTF-8 BOM if PowerShell Set-Content -Encoding UTF8 wrote one
      let raw = readFileSync(CONFIG_PATH, "utf8");
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      const parsed = JSON.parse(raw);
      const merged = { ...defaults, ...parsed };
      // Merge default cameras if config omitted them
      if (!Array.isArray(parsed.wyzeCameras) || !parsed.wyzeCameras.length) {
        merged.wyzeCameras = defaults.wyzeCameras;
      }
      return merged;
    }
  } catch (e) {
    console.warn("loadConfig failed:", e instanceof Error ? e.message : e);
  }
  return defaults;
}

const cfg = loadConfig();
const NVR = cfg.nvrBase.replace(/\/+$/, "");
// Prefer NVR_PROXY_PORT env (lets us move ports when an old process is stuck)
const PORT = Number(process.env.NVR_PROXY_PORT || cfg.listenPort) || 8791;
console.log(`Config: ${CONFIG_PATH} port=${PORT} nvr=${NVR}`);
// Allow up to 30 minutes per clip (client loads 30-min blocks for scrubbing)
const MAX_SEC = Math.min(1800, Math.max(15, Number(cfg.maxClipSeconds) || 1800));

function md5(s) {
  return createHash("md5").update(s, "utf8").digest("hex");
}

function parseDigest(header) {
  const o = {};
  const m = (header || "").match(/^Digest\s+(.+)$/i);
  if (!m) return o;
  const re = /(\w+)=(?:"([^"]*)"|([^\s,]+))/g;
  let x;
  while ((x = re.exec(m[1]))) o[x[1]] = x[2] ?? x[3] ?? "";
  return o;
}

function buildDigest(challenge, user, pass, method, uriPath) {
  const realm = challenge.realm || "";
  const nonce = challenge.nonce || "";
  let qop = (challenge.qop || "").split(",")[0]?.trim() || "";
  if (qop && qop !== "auth" && qop !== "auth-int") qop = "auth";
  const ha1 = md5(`${user}:${realm}:${pass}`);
  const ha2 = md5(`${method}:${uriPath}`);
  const nc = "00000001";
  const cnonce = md5(`${Date.now()}-${Math.random()}`);
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uriPath}", algorithm="MD5", response="${response}"`;
  if (qop) h += `, qop="${qop}", nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) h += `, opaque="${challenge.opaque}"`;
  return h;
}

function nvrRequest(
  path,
  { method = "GET", body, headers = {}, timeoutMs = 60000, maxBytes = 0 } = {}
) {
  return new Promise((resolve, reject) => {
    const url = new URL(NVR + path);
    const lib = url.protocol === "https:" ? https : http;
    const bodyBuf = body
      ? Buffer.isBuffer(body)
        ? body
        : Buffer.from(String(body), "utf8")
      : null;
    const opts = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "User-Agent": "FieldApp-NvrProxy/1.0",
        Accept: "*/*",
        ...headers,
        ...(bodyBuf
          ? {
              "Content-Length": String(bodyBuf.length),
            }
          : {}),
      },
      timeout: timeoutMs,
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      let total = 0;
      let stopped = false;
      res.on("data", (c) => {
        if (stopped) return;
        chunks.push(c);
        total += c.length;
        // Stop reading after maxBytes (NVR often ignores short endtime and streams huge files)
        if (maxBytes > 0 && total >= maxBytes) {
          stopped = true;
          res.destroy();
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).subarray(0, maxBytes),
          });
        }
      });
      res.on("end", () => {
        if (stopped) return;
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", (e) => {
        if (stopped && total >= maxBytes) return;
        reject(e);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("NVR request timeout"));
    });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function nvrAuthFetch(path, opts = {}) {
  const method = opts.method || "GET";
  // Auth handshake without maxBytes so we get WWW-Authenticate cleanly
  const probeOpts = { ...opts, maxBytes: 0 };
  let res = await nvrRequest(path, probeOpts);
  if (res.status === 200 || (res.status >= 200 && res.status < 300)) {
    // Re-fetch with maxBytes if first response was OK but we need capped body for large downloads
    if (opts.maxBytes && res.body.length < 1000) {
      /* small ok body */
    }
    return res;
  }
  const www = res.headers["www-authenticate"] || "";
  if (/digest/i.test(www)) {
    const ch = parseDigest(Array.isArray(www) ? www[0] : www);
    const auth = buildDigest(ch, cfg.nvrUser, cfg.nvrPass, method, path.split("?")[0]);
    res = await nvrRequest(path, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: auth },
    });
    return res;
  }
  if (res.status === 401 || res.status === 403) {
    const basic = Buffer.from(`${cfg.nvrUser}:${cfg.nvrPass}`).toString("base64");
    res = await nvrRequest(path, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Basic ${basic}` },
    });
  }
  return res;
}

function utcIso(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
/**
 * LTS/Hikvision often stores/search times as NVR *local wall clock* with a trailing Z
 * (not true UTC). Shop PC is America/Chicago — use local parts, not toISOString().
 */
function nvrLocalIso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}Z`;
}
function hikTime(d) {
  // Download URI tokens: same local-as-Z convention
  return nvrLocalIso(d).replace(/[-:]/g, "");
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Parse NVR time strings. LTS labels local wall clock with trailing Z — do NOT use Date.parse
 * (that treats Z as UTC and shifts Central by 5–6 hours).
 */
function parseNvrTime(s) {
  const m = String(s || "").match(
    /(\d{4})-?(\d{2})-?(\d{2})[T ](\d{2}):?(\d{2}):?(\d{2})/
  );
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : NaN;
  }
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function parseSearchMatches(xml) {
  const matches = [];
  const re = /<searchMatchItem>([\s\S]*?)<\/searchMatchItem>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const playbackURI = (block.match(/<playbackURI>([^<]+)<\/playbackURI>/i)?.[1] || "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    const segStart = block.match(/<startTime>([^<]+)<\/startTime>/i)?.[1] || "";
    const segEnd = block.match(/<endTime>([^<]+)<\/endTime>/i)?.[1] || "";
    if (playbackURI) {
      matches.push({
        playbackURI,
        segStart,
        segEnd,
        segStartMs: parseNvrTime(segStart),
        segEndMs: parseNvrTime(segEnd),
      });
    }
  }
  return matches;
}

async function searchOnce(trackId, searchStart, searchEnd, timeFmt) {
  const fmt = timeFmt === "utc" ? utcIso : nvrLocalIso;
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>${randomUUID()}</searchID>
  <trackList><trackID>${trackId}</trackID></trackList>
  <timeSpanList><timeSpan>
    <startTime>${fmt(searchStart)}</startTime>
    <endTime>${fmt(searchEnd)}</endTime>
  </timeSpan></timeSpanList>
  <maxResults>80</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
  const res = await nvrAuthFetch("/ISAPI/ContentMgmt/search", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/xml" },
    timeoutMs: 60000,
  });
  const xml = res.body.toString("utf8");
  if (res.status !== 200) {
    return { ok: false, error: `Search failed (${res.status})`, xml, matches: [] };
  }
  return { ok: true, matches: parseSearchMatches(xml), xml };
}

/**
 * @param {"at"|"prev"|"next"} mode
 *  - at: clip covering / nearest to [start,end]
 *  - prev: motion segment that ends just before `start` (rewind chain)
 *  - next: motion segment that starts just after `end` (forward chain)
 */
async function searchPlaybackUri(channelId, start, end, mode = "at") {
  // Hikvision main stream track is {channel}01 (ch1 → 101). Bare channel IDs are invalid on this NVR.
  const trackIds = [`${channelId}01`, `${channelId}02`];
  // Motion-only NVRs store short clips — search wide, then download the actual segment.
  const windows = [
    { padMin: 30, label: "±30m" },
    { padMin: 120, label: "±2h" },
    { padMin: 360, label: "±6h" },
  ];
  // Prefer local-as-Z first (LTS/Hik), then true UTC
  const formats = ["local", "utc"];

  let lastXml = "";
  const modeNorm = mode === "prev" || mode === "next" ? mode : "at";

  for (const trackId of trackIds) {
    for (const fmt of formats) {
      for (const w of windows) {
        const searchStart = new Date(start.getTime() - w.padMin * 60 * 1000);
        const searchEnd = new Date(end.getTime() + w.padMin * 60 * 1000);
        try {
          const r = await searchOnce(trackId, searchStart, searchEnd, fmt);
          lastXml = r.xml || lastXml;
          if (!r.ok || !r.matches.length) continue;

          const reqStart = start.getTime();
          const reqEnd = end.getTime();
          const withMs = r.matches.filter(
            (x) => Number.isFinite(x.segStartMs) && Number.isFinite(x.segEndMs)
          );
          if (!withMs.length) continue;

          let pick = null;
          if (modeNorm === "prev") {
            // Immediate previous motion clip: ends at/before the current clip start
            const earlier = withMs.filter((x) => x.segEndMs <= reqStart + 1500);
            if (earlier.length) {
              earlier.sort((a, b) => b.segEndMs - a.segEndMs);
              pick = earlier[0];
            }
          } else if (modeNorm === "next") {
            const later = withMs.filter((x) => x.segStartMs >= reqEnd - 1500);
            if (later.length) {
              later.sort((a, b) => a.segStartMs - b.segStartMs);
              pick = later[0];
            }
          }

          if (!pick) {
            // Prefer segment overlapping requested window
            pick =
              withMs.find((x) => x.segStartMs <= reqEnd && x.segEndMs >= reqStart) ||
              withMs
                .slice()
                .sort(
                  (a, b) =>
                    Math.abs(a.segStartMs - reqStart) - Math.abs(b.segStartMs - reqStart)
                )[0] ||
              r.matches[0];
          }

          // For prev/next always play the full motion segment (capped)
          let dlStart = start;
          let dlEnd = end;
          if (Number.isFinite(pick.segStartMs) && Number.isFinite(pick.segEndMs)) {
            if (modeNorm === "prev" || modeNorm === "next") {
              dlStart = new Date(pick.segStartMs);
              dlEnd = new Date(
                Math.min(pick.segEndMs, pick.segStartMs + Math.max(end - start, 180000))
              );
            } else {
              const overlapStart = Math.max(reqStart, pick.segStartMs);
              const overlapEnd = Math.min(reqEnd, pick.segEndMs);
              if (overlapEnd > overlapStart + 500) {
                dlStart = new Date(overlapStart);
                dlEnd = new Date(overlapEnd);
              } else {
                // Motion event near requested time — play that event (cap length)
                dlStart = new Date(pick.segStartMs);
                dlEnd = new Date(
                  Math.min(pick.segEndMs, pick.segStartMs + Math.max(end - start, 150000))
                );
              }
            }
          }

          const gapSec =
            modeNorm === "prev" && Number.isFinite(pick.segEndMs)
              ? Math.max(0, Math.round((reqStart - pick.segEndMs) / 1000))
              : modeNorm === "next" && Number.isFinite(pick.segStartMs)
                ? Math.max(0, Math.round((pick.segStartMs - reqEnd) / 1000))
                : 0;

          console.log(
            `search hit mode=${modeNorm} track=${trackId} fmt=${fmt} window=${w.label} segs=${r.matches.length} dl=${nvrLocalIso(dlStart)}..${nvrLocalIso(dlEnd)} gapSec=${gapSec}`
          );
          return {
            ok: true,
            ...pick,
            matches: r.matches,
            trackId,
            timeFmt: fmt,
            dlStart,
            dlEnd,
            gapSec,
            mode: modeNorm,
          };
        } catch (e) {
          console.warn("search attempt failed", trackId, fmt, w.label, e.message || e);
        }
      }
    }
  }

  return {
    ok: false,
    error:
      modeNorm === "prev"
        ? "No earlier recording on this camera (motion gap or start of day)."
        : modeNorm === "next"
          ? "No later recording on this camera yet."
          : "No recording found near that time on this camera. This NVR records short motion clips — try a few minutes earlier or later, or when something was moving in view.",
    xml: lastXml,
  };
}

/**
 * List motion clips near a time (for Field App emergency clip picker).
 * Uses the same local-as-Z search that clip download uses.
 */
async function listNvrSegmentsNear(channelId, around, padMin = 60) {
  const trackIds = [`${channelId}01`, `${channelId}02`];
  const formats = ["local", "utc"];
  const aroundMs = around.getTime();
  const searchStart = new Date(aroundMs - padMin * 60 * 1000);
  const searchEnd = new Date(aroundMs + padMin * 60 * 1000);
  let best = [];
  let lastErr = "";

  for (const trackId of trackIds) {
    for (const fmt of formats) {
      try {
        const r = await searchOnce(trackId, searchStart, searchEnd, fmt);
        if (!r.ok) {
          lastErr = r.error || lastErr;
          continue;
        }
        const withMs = (r.matches || []).filter(
          (x) => Number.isFinite(x.segStartMs) && Number.isFinite(x.segEndMs)
        );
        if (withMs.length > best.length) best = withMs;
        // Prefer first successful track with matches
        if (best.length) break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    if (best.length) break;
  }

  // Dedupe by start second
  const byKey = new Map();
  for (const m of best) {
    const key = String(Math.round(m.segStartMs / 1000));
    const prev = byKey.get(key);
    if (!prev || m.segEndMs > prev.segEndMs) byKey.set(key, m);
  }
  const segs = [...byKey.values()].sort((a, b) => a.segStartMs - b.segStartMs);

  let nearestIndex = -1;
  let nearestDist = Infinity;
  segs.forEach((s, i) => {
    const overlapping = aroundMs >= s.segStartMs && aroundMs <= s.segEndMs;
    const dist = overlapping
      ? 0
      : Math.min(Math.abs(s.segStartMs - aroundMs), Math.abs(s.segEndMs - aroundMs));
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  });

  return {
    ok: true,
    channelId,
    around: around.toISOString(),
    padMin,
    nearestIndex,
    nearestGapSec: nearestIndex >= 0 ? Math.round(nearestDist / 1000) : null,
    segments: segs.map((s) => ({
      start: new Date(s.segStartMs).toISOString(),
      end: new Date(s.segEndMs).toISOString(),
      durationSec: Math.max(1, Math.round((s.segEndMs - s.segStartMs) / 1000)),
    })),
    error: segs.length ? undefined : lastErr || undefined,
  };
}

async function handleSegments(req, res, url) {
  try {
    const channelId = Number(url.searchParams.get("channel") || "0");
    const aroundRaw = url.searchParams.get("around") || url.searchParams.get("start") || "";
    let padMin = Number(url.searchParams.get("padMin") || "60");
    if (!Number.isFinite(padMin) || padMin < 5) padMin = 60;
    padMin = Math.min(360, padMin); // max ±6h
    const around = new Date(aroundRaw);
    if (!Number.isFinite(channelId) || channelId < 1 || channelId > 64) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid channel" }));
      return;
    }
    if (Number.isNaN(around.getTime())) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid around time (use ISO)" }));
      return;
    }
    if (!cfg.nvrPass) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "NVR password not set in proxy-config.json" }));
      return;
    }
    const result = await listNvrSegmentsNear(channelId, around, padMin);
    console.log(
      `segments ch=${channelId} around=${around.toISOString()} pad=${padMin}m count=${result.segments.length} nearest=${result.nearestIndex}`
    );
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Segments search failed",
      })
    );
  }
}

async function handleWyzeSegments(req, res, url) {
  try {
    const camId = (url.searchParams.get("cam") || "").trim();
    const aroundRaw = url.searchParams.get("around") || url.searchParams.get("start") || "";
    let padMin = Number(url.searchParams.get("padMin") || "60");
    if (!Number.isFinite(padMin) || padMin < 5) padMin = 60;
    padMin = Math.min(360, padMin);
    const around = new Date(aroundRaw || Date.now());
    if (!camId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing cam" }));
      return;
    }
    if (Number.isNaN(around.getTime())) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid around time" }));
      return;
    }
    const aroundMs = around.getTime();
    const lo = aroundMs - padMin * 60 * 1000;
    const hi = aroundMs + padMin * 60 * 1000;
    const segs = listWyzeSegments(camId).filter((s) => s.endMs > lo && s.startMs < hi);
    let nearestIndex = -1;
    let nearestDist = Infinity;
    segs.forEach((s, i) => {
      const overlapping = aroundMs >= s.startMs && aroundMs <= s.endMs;
      const dist = overlapping
        ? 0
        : Math.min(Math.abs(s.startMs - aroundMs), Math.abs(s.endMs - aroundMs));
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = i;
      }
    });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        ok: true,
        cam: camId,
        around: around.toISOString(),
        padMin,
        nearestIndex,
        nearestGapSec: nearestIndex >= 0 ? Math.round(nearestDist / 1000) : null,
        segments: segs.map((s) => ({
          start: new Date(s.startMs).toISOString(),
          end: new Date(s.endMs).toISOString(),
          durationSec: Math.max(1, Math.round((s.endMs - s.startMs) / 1000)),
        })),
      })
    );
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Wyze segments failed",
      })
    );
  }
}

function clampUri(playbackURI, start, end) {
  let uri = playbackURI;
  if (/starttime=/i.test(uri)) {
    uri = uri.replace(/starttime=[^&]+/i, `starttime=${hikTime(start)}`);
  } else {
    uri += (uri.includes("?") ? "&" : "?") + `starttime=${hikTime(start)}`;
  }
  if (/endtime=/i.test(uri)) {
    uri = uri.replace(/endtime=[^&]+/i, `endtime=${hikTime(end)}`);
  } else {
    uri += `&endtime=${hikTime(end)}`;
  }
  // Keep name= if present (required by this NVR); drop size so partial download is allowed
  uri = uri.replace(/&size=\d+/i, "");
  // Prefer LAN host in RTSP so NVR understands it
  uri = uri.replace(/rtsp:\/\/[^/]+/i, "rtsp://192.168.1.111");
  return uri;
}

/** Parse Hikvision time token 20260806T195500Z → Date */
function parseHikTime(tok) {
  const m = String(tok || "").match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
}

/**
 * How many source bytes we need so ffmpeg can produce `durationSec` of video.
 * Small caps (~50MB) only demuxed ~1 minute — that caused the 0:58 player bug.
 */
function estimateBytesForDuration(playbackURI, durationSec) {
  const sizeM = playbackURI.match(/[?&]size=(\d+)/i);
  const st = playbackURI.match(/starttime=([^&]+)/i)?.[1];
  const et = playbackURI.match(/endtime=([^&]+)/i)?.[1];
  const t0 = parseHikTime(st);
  const t1 = parseHikTime(et);
  if (sizeM && t0 && t1 && t1 > t0) {
    const segSec = Math.max(1, (t1.getTime() - t0.getTime()) / 1000);
    const size = Number(sizeM[1]);
    // 30% headroom for keyframe/align
    return Math.ceil((size / segSec) * durationSec * 1.35);
  }
  // ~70 MB/min observed on this NVR main stream
  return Math.ceil(durationSec * (70 * 1024 * 1024) / 60);
}

/**
 * ISAPI download + convert. Byte budget is sized for the requested duration
 * (cutting early is what produced ~58s clips).
 */
async function downloadImkh(playbackURI, maxBytes) {
  const esc = escapeXml(playbackURI);
  const body = `<?xml version="1.0" encoding="UTF-8"?><downloadRequest><playbackURI>${esc}</playbackURI></downloadRequest>`;
  const res = await nvrAuthFetch("/ISAPI/ContentMgmt/download", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/xml" },
    // Allow long transfer for multi-minute clips (~1GB/min worst case is rare; 70MB/min typical)
    timeoutMs: Math.max(180000, Math.ceil(maxBytes / (2 * 1024 * 1024)) * 1000),
    maxBytes,
  });
  if (res.status !== 200 && res.status !== 0) {
    const head = res.body.toString("utf8").slice(0, 120);
    if (res.body.length < 1000 && /error|statusCode|xml/i.test(head)) {
      return {
        ok: false,
        error: `Download failed (${res.status}): ${head}`,
      };
    }
  }
  let buf = res.body;
  if (buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
  if (buf.length < 1000) {
    return { ok: false, error: `Clip too small (${buf.length} bytes)` };
  }
  if (buf[0] === 0x3c /* < */) {
    return {
      ok: false,
      error: `NVR error: ${buf.toString("utf8").replace(/\s+/g, " ").slice(0, 160)}`,
    };
  }
  return { ok: true, bytes: buf };
}

function ffmpegFileToMp4(inputPath, durationSec) {
  return new Promise((resolve, reject) => {
    const ff = cfg.ffmpegPath;
    if (!existsSync(ff)) {
      reject(new Error(`ffmpeg not found at ${ff}`));
      return;
    }
    const outPath = `${inputPath}.mp4`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      inputPath,
      "-t",
      String(durationSec),
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      outPath,
    ];
    const proc = spawn(ff, args, { windowsHide: true });
    const errChunks = [];
    proc.stderr.on("data", (c) => errChunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        try {
          if (existsSync(outPath)) unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `ffmpeg exit ${code}: ${Buffer.concat(errChunks).toString("utf8").slice(0, 300)}`
          )
        );
        return;
      }
      try {
        const buf = readFileSync(outPath);
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        resolve(buf);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not read converted mp4"));
      }
    });
  });
}

async function handleClip(req, res, url) {
  try {
    const channelId = Number(url.searchParams.get("channel") || "1");
    const startRaw = url.searchParams.get("start") || "";
    const endRaw = url.searchParams.get("end") || "";
    const modeRaw = (url.searchParams.get("mode") || "at").toLowerCase();
    const mode = modeRaw === "prev" || modeRaw === "next" ? modeRaw : "at";
    const start = new Date(startRaw);
    let end = endRaw ? new Date(endRaw) : new Date(start.getTime() + 5 * 60 * 1000);
    if (!Number.isFinite(channelId) || channelId < 1 || channelId > 64) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid channel" }));
      return;
    }
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid start/end time (use ISO UTC)" }));
      return;
    }
    // Minimum 2.5 minutes (client default); max MAX_SEC
    if (end <= start) end = new Date(start.getTime() + 150 * 1000);
    let durSec = Math.round((end - start) / 1000);
    if (durSec < 150) {
      durSec = 150;
      end = new Date(start.getTime() + durSec * 1000);
    }
    durSec = Math.min(MAX_SEC, durSec);
    end = new Date(start.getTime() + durSec * 1000);

    if (!cfg.nvrPass) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "NVR password not set in proxy-config.json" }));
      return;
    }

    // Clips use ISAPI ContentMgmt download (live uses RTSP when :554 open, else snap-pump)
    const found = await searchPlaybackUri(channelId, start, end, mode);
    if (!found.ok) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: found.error || "No recording for that time" }));
      return;
    }
    // Use segment-aligned download window (motion clips are often only seconds long)
    const dlStart = found.dlStart instanceof Date ? found.dlStart : start;
    let dlEnd = found.dlEnd instanceof Date ? found.dlEnd : end;
    if (dlEnd <= dlStart) dlEnd = new Date(dlStart.getTime() + 30 * 1000);
    let clipSec = Math.round((dlEnd - dlStart) / 1000);
    clipSec = Math.max(5, Math.min(MAX_SEC, clipSec));
    dlEnd = new Date(dlStart.getTime() + clipSec * 1000);

    const uri = clampUri(found.playbackURI, dlStart, dlEnd);
    const needBytes = Math.min(
      1500 * 1024 * 1024,
      Math.max(
        32 * 1024 * 1024,
        estimateBytesForDuration(found.playbackURI, Math.max(clipSec, 30))
      )
    );
    console.log(
      `clip ch=${channelId} dur=${clipSec}s needBytes=${Math.round(needBytes / 1024 / 1024)}MB uriStart=${nvrLocalIso(dlStart)}`
    );
    const dl = await downloadImkh(uri, needBytes);
    if (!dl.ok) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: dl.error || "Download failed" }));
      return;
    }
    const dir = join(tmpdir(), "ta-nvr-clips");
    mkdirSync(dir, { recursive: true });
    const inFile = join(dir, `in-${Date.now()}.bin`);
    writeFileSync(inFile, dl.bytes);
    let mp4;
    try {
      mp4 = await ffmpegFileToMp4(inFile, clipSec);
    } finally {
      try {
        unlinkSync(inFile);
      } catch {
        /* ignore */
      }
    }

    if (!mp4 || mp4.length < 500) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Converted clip was empty" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(mp4.length),
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers":
        "X-Clip-Seconds, X-Clip-Start, X-Clip-End, X-Clip-Mode, X-Clip-Gap-Sec",
      "X-Clip-Seconds": String(clipSec),
      // ISO UTC so the Field App can chain prev/next segments accurately
      "X-Clip-Start": dlStart.toISOString(),
      "X-Clip-End": dlEnd.toISOString(),
      "X-Clip-Mode": mode,
      "X-Clip-Gap-Sec": String(found.gapSec || 0),
    });
    res.end(mp4);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : "Clip failed" }));
  }
}

function proxyToNvr(req, res) {
  const target = new URL(req.url || "/", NVR);
  const lib = target.protocol === "https:" ? https : http;
  const headers = { ...req.headers, host: target.host };
  delete headers["host"];
  headers.host = new URL(NVR).host;

  const preq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (pres) => {
      // Allow Field App to embed if ever needed
      const outHeaders = { ...pres.headers };
      delete outHeaders["x-frame-options"];
      delete outHeaders["content-security-policy"];
      res.writeHead(pres.statusCode || 502, outHeaders);
      pres.pipe(res);
    }
  );
  preq.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("NVR proxy error: " + e.message);
  });
  req.pipe(preq);
}

// ─── Wyze (via Docker Wyze Bridge RTSP + local ring-buffer) ─────────────────

const WYZE_RTSP = String(cfg.wyzeRtspBase || "rtsp://127.0.0.1:8554").replace(/\/+$/, "");
// Only true when config explicitly enables recording (default false)
const WYZE_RECORD = Boolean(cfg.wyzeRecord === true || cfg.wyzeRecord === "true");
const WYZE_DIR = String(
  cfg.wyzeRecordDir || "C:\\ProgramData\\TotalAssurance\\nvr-tunnel\\wyze-record"
);
const WYZE_RETAIN_H = Math.max(6, Math.min(168, Number(cfg.wyzeRecordRetainHours) || 72));
const WYZE_SEG_SEC = Math.max(60, Math.min(600, Number(cfg.wyzeSegmentSec) || 150));
const WYZE_CAMS = (Array.isArray(cfg.wyzeCameras) ? cfg.wyzeCameras : []).filter(
  (c) => c && c.id && c.enabled !== false
);

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const wyzeRecordProcs = new Map();
/** Cap concurrent Wyze ffmpeg snapshot jobs so NVR stays responsive */
let wyzeSnapInFlight = 0;
const WYZE_SNAP_MAX = 6;
/**
 * Concurrent LIVE streams (NVR + Wyze combined) — opening many tiles must not melt the shop PC.
 * Per-source caps + a global ceiling.
 */
let wyzeLiveInFlight = 0;
let nvrLiveInFlight = 0;
const WYZE_LIVE_MAX = 3;
const NVR_LIVE_MAX = 3;
const LIVE_MAX = 4;

function liveBusyPayload() {
  return {
    error: "Live busy - close other live cameras and retry",
    liveInFlight: wyzeLiveInFlight + nvrLiveInFlight,
    liveMax: LIVE_MAX,
    nvrLiveInFlight,
    nvrLiveMax: NVR_LIVE_MAX,
    wyzeLiveInFlight,
    wyzeLiveMax: WYZE_LIVE_MAX,
  };
}

function canStartWyzeLive() {
  return (
    wyzeLiveInFlight < WYZE_LIVE_MAX &&
    wyzeLiveInFlight + nvrLiveInFlight < LIVE_MAX
  );
}

function canStartNvrLive() {
  return (
    nvrLiveInFlight < NVR_LIVE_MAX &&
    wyzeLiveInFlight + nvrLiveInFlight < LIVE_MAX
  );
}

function wyzeCamById(id) {
  const key = String(id || "").trim().toLowerCase();
  return WYZE_CAMS.find((c) => String(c.id).toLowerCase() === key) || null;
}

function wyzeRtspUrl(cam) {
  const path = String(cam.rtspPath || cam.id || "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  return `${WYZE_RTSP}/${path}`;
}

/** Quick TCP check — is Wyze Bridge RTSP port open? */
function probeWyzeBridge(timeoutMs = 800) {
  return new Promise((resolve) => {
    let host = "127.0.0.1";
    let port = 8554;
    try {
      const u = new URL(WYZE_RTSP.replace(/^rtsp/i, "http"));
      host = u.hostname || host;
      port = Number(u.port) || 8554;
    } catch {
      /* defaults */
    }
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

function wyzeCamDir(camId) {
  return join(WYZE_DIR, String(camId).replace(/[^a-zA-Z0-9_-]/g, "_"));
}

/** List recorded segments for a cam: { startMs, endMs, path } */
function listWyzeSegments(camId) {
  const dir = wyzeCamDir(camId);
  if (!existsSync(dir)) return [];
  const out = [];
  try {
    for (const name of readdirSync(dir)) {
      // {startUnix}.mp4
      const m = name.match(/^(\d{10,13})\.mp4$/i);
      if (!m) continue;
      const startMs = Number(m[1]) < 1e12 ? Number(m[1]) * 1000 : Number(m[1]);
      const full = join(dir, name);
      let durMs = WYZE_SEG_SEC * 1000;
      try {
        // Prefer sidecar duration if present
        const side = full + ".json";
        if (existsSync(side)) {
          const meta = JSON.parse(readFileSync(side, "utf8"));
          if (meta.durationSec) durMs = Number(meta.durationSec) * 1000;
        } else {
          const st = statSync(full);
          // Rough: tiny files = short/aborted
          if (st.size < 50_000) durMs = 15_000;
        }
      } catch {
        /* keep default */
      }
      out.push({ startMs, endMs: startMs + durMs, path: full });
    }
  } catch {
    return [];
  }
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

function purgeOldWyzeRecordings() {
  const cutoff = Date.now() - WYZE_RETAIN_H * 3600 * 1000;
  for (const cam of WYZE_CAMS) {
    for (const seg of listWyzeSegments(cam.id)) {
      if (seg.endMs < cutoff) {
        try {
          unlinkSync(seg.path);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(seg.path + ".json");
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function ffmpegGrabJpeg(rtspUrl, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ff = cfg.ffmpegPath;
    if (!existsSync(ff)) {
      reject(new Error(`ffmpeg not found at ${ff}`));
      return;
    }
    const outPath = join(tmpdir(), `wyze-snap-${randomUUID()}.jpg`);
    // Short RTSP timeouts so a missing bridge cannot hang the whole proxy
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "3000000", // microseconds (3s) — ffmpeg RTSP socket
      "-rw_timeout",
      "3000000",
      "-y",
      "-i",
      rtspUrl,
      "-frames:v",
      "1",
      "-q:v",
      "5",
      outPath,
    ];
    const proc = spawn(ff, args, { windowsHide: true });
    const errChunks = [];
    const killTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    proc.stderr.on("data", (c) => errChunks.push(c));
    proc.on("error", (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0 || !existsSync(outPath)) {
        reject(
          new Error(
            `Wyze snapshot failed (${code}): ${Buffer.concat(errChunks).toString("utf8").slice(0, 200) || "no frame — is Wyze Bridge running?"}`
          )
        );
        return;
      }
      try {
        const buf = readFileSync(outPath);
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        if (buf.length < 200) reject(new Error("Empty JPEG from Wyze stream"));
        else resolve(buf);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not read snapshot"));
      }
    });
  });
}

/** Grab a live RTSP window as MP4 (near-live fallback when no recording yet). */
function ffmpegLiveClip(rtspUrl, durationSec) {
  return new Promise((resolve, reject) => {
    const ff = cfg.ffmpegPath;
    if (!existsSync(ff)) {
      reject(new Error(`ffmpeg not found at ${ff}`));
      return;
    }
    const outPath = join(tmpdir(), `wyze-live-${randomUUID()}.mp4`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-y",
      "-i",
      rtspUrl,
      "-t",
      String(Math.max(5, Math.min(300, durationSec))),
      "-vf",
      "scale='min(1280,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      outPath,
    ];
    const proc = spawn(ff, args, { windowsHide: true });
    const errChunks = [];
    const killTimer = setTimeout(
      () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      },
      Math.max(60_000, durationSec * 3000)
    );
    proc.stderr.on("data", (c) => errChunks.push(c));
    proc.on("error", (e) => {
      clearTimeout(killTimer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      if (code !== 0 || !existsSync(outPath)) {
        reject(
          new Error(
            `Live capture failed (${code}): ${Buffer.concat(errChunks).toString("utf8").slice(0, 220)}`
          )
        );
        return;
      }
      try {
        const buf = readFileSync(outPath);
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        resolve(buf);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not read live clip"));
      }
    });
  });
}

function ffmpegCutFile(inputPath, startOffsetSec, durationSec) {
  return new Promise((resolve, reject) => {
    const ff = cfg.ffmpegPath;
    const outPath = join(tmpdir(), `wyze-cut-${randomUUID()}.mp4`);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(Math.max(0, startOffsetSec)),
      "-i",
      inputPath,
      "-t",
      String(Math.max(1, durationSec)),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "28",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      outPath,
    ];
    const proc = spawn(ff, args, { windowsHide: true });
    const errChunks = [];
    proc.stderr.on("data", (c) => errChunks.push(c));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0 || !existsSync(outPath)) {
        reject(
          new Error(
            `Cut failed (${code}): ${Buffer.concat(errChunks).toString("utf8").slice(0, 200)}`
          )
        );
        return;
      }
      try {
        const buf = readFileSync(outPath);
        try {
          unlinkSync(outPath);
        } catch {
          /* ignore */
        }
        resolve(buf);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Could not read cut clip"));
      }
    });
  });
}

/**
 * Record one segment then recurse (ring buffer). Restarts automatically if stream drops.
 */
function startWyzeRecorder(cam) {
  if (!WYZE_RECORD) return;
  const id = String(cam.id);
  if (wyzeRecordProcs.has(id)) return;
  const ff = cfg.ffmpegPath;
  if (!existsSync(ff)) {
    console.warn("Wyze record: ffmpeg missing");
    return;
  }
  // Don't spawn endless hung ffmpeg when bridge is down
  probeWyzeBridge(1000).then((up) => {
    if (!up) {
      console.warn(`Wyze record skip ${id}: bridge not listening on RTSP`);
      setTimeout(() => startWyzeRecorder(cam), 60_000);
      return;
    }
    const dir = wyzeCamDir(id);
    mkdirSync(dir, { recursive: true });
    const startMs = Date.now();
    const outFile = join(dir, `${Math.floor(startMs / 1000)}.mp4`);
    const rtsp = wyzeRtspUrl(cam);
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "5000000",
      "-rw_timeout",
      "5000000",
      "-y",
      "-i",
      rtsp,
      "-t",
      String(WYZE_SEG_SEC),
      "-vf",
      "scale='min(960,iw)':-2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-movflags",
      "+faststart",
      outFile,
    ];
    console.log(`Wyze record start cam=${id} → ${outFile}`);
    const proc = spawn(ff, args, { windowsHide: true });
    wyzeRecordProcs.set(id, proc);
    proc.on("error", (e) => {
      console.warn(`Wyze record error ${id}:`, e.message);
      wyzeRecordProcs.delete(id);
      setTimeout(() => startWyzeRecorder(cam), 30_000);
    });
    proc.on("close", (code) => {
      wyzeRecordProcs.delete(id);
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      try {
        if (existsSync(outFile)) {
          writeFileSync(
            outFile + ".json",
            JSON.stringify({ startMs, durationSec: Math.max(1, elapsed), code })
          );
        }
      } catch {
        /* ignore */
      }
      // Longer backoff when ffmpeg fails (bridge down / bad path)
      const delay = code === 0 ? 500 : 30_000;
      setTimeout(() => startWyzeRecorder(cam), delay);
    });
  });
}

function startAllWyzeRecorders() {
  if (!WYZE_RECORD || !WYZE_CAMS.length) {
    console.log("Wyze record: disabled (set wyzeRecord:true after Bridge is up)");
    return;
  }
  mkdirSync(WYZE_DIR, { recursive: true });
  for (const cam of WYZE_CAMS) startWyzeRecorder(cam);
  // Purge old files hourly
  setInterval(purgeOldWyzeRecordings, 60 * 60 * 1000);
  setTimeout(purgeOldWyzeRecordings, 30_000);
  console.log(
    `Wyze record: ${WYZE_CAMS.length} cam(s), ${WYZE_SEG_SEC}s segments, retain ${WYZE_RETAIN_H}h → ${WYZE_DIR}`
  );
}

/**
 * Continuous LIVE for NVR channels.
 * Preference: RTSP (ffmpeg MJPEG) → ISAPI httpPreview → snapshot-pump MJPEG.
 * RTSP :554 is often CLOSED on this LTS — enable it on the NVR for best quality.
 * GET /fieldapp/nvr/live?channel=1
 */
function nvrRtspUrl(channel) {
  const host = (() => {
    try {
      return new URL(NVR).hostname || "192.168.1.111";
    } catch {
      return "192.168.1.111";
    }
  })();
  const track = `${Number(channel)}01`;
  const user = encodeURIComponent(String(cfg.nvrUser || "admin"));
  const pass = encodeURIComponent(String(cfg.nvrPass || ""));
  return `rtsp://${user}:${pass}@${host}:554/Streaming/Channels/${track}`;
}

/** TCP probe NVR RTSP port — fail fast when closed (common on this LTS). */
function probeNvrRtsp(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let host = "192.168.1.111";
    try {
      host = new URL(NVR).hostname || host;
    } catch {
      /* defaults */
    }
    const sock = net.connect({ host, port: 554 });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on("connect", () => finish(true));
    sock.on("timeout", () => finish(false));
    sock.on("error", () => finish(false));
  });
}

function writeLiveMjpegHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
    "Cache-Control": "no-cache, no-store",
    Connection: "close",
    "X-Accel-Buffering": "no",
  });
}

/**
 * Pipe ffmpeg RTSP → multipart MJPEG. Resolves true if stream started (first bytes),
 * false if connect/fail within failMs (caller should try next method).
 */
function startFfmpegLiveMjpeg(req, res, rtspUrl, { failMs = 2000, logTag = "live" } = {}) {
  return new Promise((resolve) => {
    const ff = cfg.ffmpegPath;
    if (!existsSync(ff)) {
      resolve({ ok: false, error: `ffmpeg not found at ${ff}` });
      return;
    }
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-rtsp_transport",
      "tcp",
      "-timeout",
      "2000000", // 2s (microseconds) — hard fail when RTSP closed/hung
      "-rw_timeout",
      "2000000",
      "-i",
      rtspUrl,
      "-an",
      "-f",
      "mpjpeg",
      "-q:v",
      "7",
      "-r",
      "8",
      "pipe:1",
    ];
    let proc = null;
    let closed = false;
    let started = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (proc) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        proc = null;
      }
    };
    try {
      proc = spawn(ff, args, { windowsHide: true });
    } catch (e) {
      finish({
        ok: false,
        error: e instanceof Error ? e.message : "Could not start live ffmpeg",
      });
      return;
    }

    const failTimer = setTimeout(() => {
      if (started) return;
      cleanup();
      finish({ ok: false, error: `RTSP connect timed out (${failMs}ms)` });
    }, failMs);

    proc.stdout.on("data", (chunk) => {
      if (closed) return;
      if (!started) {
        started = true;
        clearTimeout(failTimer);
        try {
          writeLiveMjpegHeaders(res);
        } catch {
          cleanup();
          finish({ ok: false, error: "Could not write response headers" });
          return;
        }
        finish({ ok: true, cleanup, proc });
        console.log(`${logTag} method=rtsp`);
      }
      if (res.writableEnded) {
        cleanup();
        return;
      }
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    });
    proc.stderr.on("data", () => {
      /* swallow */
    });
    proc.on("error", () => {
      if (!started) {
        clearTimeout(failTimer);
        cleanup();
        finish({ ok: false, error: "ffmpeg process error" });
      } else {
        cleanup();
      }
    });
    proc.on("close", () => {
      clearTimeout(failTimer);
      if (!started) {
        cleanup();
        finish({ ok: false, error: "RTSP stream ended before first frame" });
        return;
      }
      cleanup();
      try {
        if (!res.writableEnded) res.end();
      } catch {
        /* ignore */
      }
    });
    const onClientGone = () => {
      cleanup();
      if (!started) {
        clearTimeout(failTimer);
        finish({ ok: false, error: "client disconnected" });
      }
    };
    req.on("close", onClientGone);
    res.on("close", onClientGone);
  });
}

/** One authenticated JPEG from ISAPI picture (used by snap-pump). */
async function nvrGrabPicture(channel, timeoutMs = 5000) {
  const track = `${Number(channel)}01`;
  const path = `/ISAPI/Streaming/channels/${track}/picture`;
  const res = await nvrAuthFetch(path, { timeoutMs, maxBytes: 2_000_000 });
  if (res.status !== 200) {
    const head = res.body.toString("utf8").slice(0, 120);
    throw new Error(`picture HTTP ${res.status}: ${head}`);
  }
  if (!res.body || res.body.length < 500) {
    throw new Error(`picture too small (${res.body?.length || 0} bytes)`);
  }
  // Reject XML/HTML error bodies
  if (res.body[0] === 0x3c /* < */) {
    throw new Error(`picture returned XML/HTML: ${res.body.toString("utf8").slice(0, 80)}`);
  }
  return res.body;
}

/**
 * Try common Hikvision/LTS ISAPI HTTP preview paths. Most firmwares 403 here;
 * if one returns multipart or a continuous body, pipe it. Otherwise false.
 */
async function tryNvrIsapiPreview(req, res, channel) {
  const track = `${Number(channel)}01`;
  const candidates = [
    `/ISAPI/Streaming/channels/${track}/httpPreview`,
    `/ISAPI/Streaming/channels/${track}/preview`,
    `/PSIA/Streaming/channels/${track}/httpPreview`,
  ];
  for (const path of candidates) {
    try {
      // Probe with a short capped fetch — continuous streams won't finish; we only
      // accept if we get an immediate JPEG or multipart header in the first chunk.
      const probe = await nvrAuthFetch(path, { timeoutMs: 2500, maxBytes: 64_000 });
      const ct = String(probe.headers["content-type"] || "").toLowerCase();
      if (probe.status !== 200) continue;
      if (ct.includes("multipart") || ct.includes("image/jpeg")) {
        // Not a true continuous pipe via nvrAuthFetch (buffered). Fall through to
        // snap-pump which reuses the working picture endpoint — more reliable.
        console.log(
          `nvr live ch=${channel} isapi probe ok path=${path} ct=${ct} (using snap-pump for continuous)`
        );
        return { ok: false, error: "isapi preview not streamable via buffered fetch", soft: true };
      }
    } catch {
      /* try next */
    }
  }
  return { ok: false, error: "ISAPI httpPreview not supported (403/missing on this firmware)" };
}

/** Snapshot-pump MJPEG: loop ISAPI picture ~3 fps into multipart (fallback when RTSP closed). */
async function startNvrSnapPump(req, res, channel) {
  // Verify first frame before committing headers
  let first;
  try {
    first = await nvrGrabPicture(channel, 6000);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "snapshot pump: first picture failed",
    };
  }

  let closed = false;
  const cleanup = () => {
    closed = true;
  };
  req.on("close", cleanup);
  res.on("close", cleanup);

  try {
    writeLiveMjpegHeaders(res);
  } catch (e) {
    cleanup();
    return {
      ok: false,
      error: e instanceof Error ? e.message : "could not write snap-pump headers",
    };
  }

  const writeFrame = (jpeg) => {
    if (closed || res.writableEnded) return false;
    try {
      res.write(`--ffmpeg\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write(`\r\n`);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  if (!writeFrame(first)) {
    cleanup();
    return { ok: false, error: "client gone before first snap-pump frame" };
  }
  console.log(`nvr live ch=${channel} method=snap-pump`);

  // ~3 fps — gentle on NVR + shop PC; continuous enough for live UX
  const intervalMs = 350;
  (async () => {
    while (!closed && !res.writableEnded) {
      const t0 = Date.now();
      try {
        const jpeg = await nvrGrabPicture(channel, 5000);
        if (!writeFrame(jpeg)) break;
      } catch (e) {
        // Transient picture blip — keep trying a few times then end
        console.warn(
          `nvr snap-pump ch=${channel} frame error:`,
          e instanceof Error ? e.message : e
        );
        await new Promise((r) => setTimeout(r, 800));
        if (closed) break;
        continue;
      }
      const elapsed = Date.now() - t0;
      const wait = Math.max(50, intervalMs - elapsed);
      await new Promise((r) => setTimeout(r, wait));
    }
    cleanup();
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  })();

  return { ok: true, cleanup };
}

async function handleNvrLive(req, res, url) {
  const channel = Number(
    url.searchParams.get("channel") || url.searchParams.get("ch") || ""
  );
  if (!Number.isFinite(channel) || channel < 1 || channel > 8) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid channel (use 1-8)" }));
    return;
  }
  if (!cfg.nvrPass) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "NVR password not set in proxy-config.json" }));
    return;
  }
  if (!canStartNvrLive()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(liveBusyPayload()));
    return;
  }

  nvrLiveInFlight += 1;
  let slotHeld = true;
  let streamCleanup = null;
  const releaseSlot = () => {
    if (!slotHeld) return;
    slotHeld = false;
    nvrLiveInFlight = Math.max(0, nvrLiveInFlight - 1);
    if (typeof streamCleanup === "function") {
      try {
        streamCleanup();
      } catch {
        /* ignore */
      }
      streamCleanup = null;
    }
  };
  req.on("close", releaseSlot);
  res.on("close", releaseSlot);

  const failures = [];

  // A1) RTSP — best quality when NVR :554 is open
  const rtspOpen = await probeNvrRtsp(1500);
  if (rtspOpen) {
    const rtsp = nvrRtspUrl(channel);
    const rtspResult = await startFfmpegLiveMjpeg(req, res, rtsp, {
      failMs: 2000,
      logTag: `nvr live ch=${channel}`,
    });
    if (rtspResult.ok) {
      streamCleanup = rtspResult.cleanup;
      console.log(
        `nvr live start ch=${channel} method=rtsp nvrLiveInFlight=${nvrLiveInFlight}`
      );
      return; // stream owns the response; releaseSlot on client close
    }
    failures.push({ method: "rtsp", error: rtspResult.error || "RTSP failed" });
  } else {
    failures.push({
      method: "rtsp",
      error: "NVR RTSP port 554 closed/unreachable — enable RTSP on NVR for best live",
    });
  }

  // A2) ISAPI preview (often unsupported) — probe only; continuous via snap-pump
  const isapi = await tryNvrIsapiPreview(req, res, channel);
  if (!isapi.ok && !isapi.soft) {
    failures.push({ method: "isapi", error: isapi.error || "ISAPI preview failed" });
  } else if (isapi.soft) {
    failures.push({ method: "isapi", error: isapi.error, note: "falling back to snap-pump" });
  }

  // A2/A3) Snapshot pump — reliable when RTSP closed (verified picture endpoint works)
  const pump = await startNvrSnapPump(req, res, channel);
  if (pump.ok) {
    streamCleanup = pump.cleanup;
    console.log(
      `nvr live start ch=${channel} method=snap-pump nvrLiveInFlight=${nvrLiveInFlight}`
    );
    return;
  }
  failures.push({ method: "snap-pump", error: pump.error || "snap-pump failed" });

  releaseSlot();
  if (!res.headersSent) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "NVR live failed — all methods exhausted",
        channel,
        failures,
      })
    );
  }
}

/**
 * Continuous LIVE MJPEG from Wyze Bridge RTSP (browser-friendly through tunnel).
 * GET /fieldapp/wyze/live?cam=warehouse
 */
async function handleWyzeLive(req, res, url) {
  const camId = url.searchParams.get("cam") || url.searchParams.get("id") || "";
  const cam = wyzeCamById(camId);
  if (!cam) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Unknown Wyze camera: ${camId}` }));
    return;
  }
  if (!canStartWyzeLive()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify(liveBusyPayload()));
    return;
  }
  const bridgeUp = await probeWyzeBridge(800);
  if (!bridgeUp) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          "Wyze Bridge not running (nothing on RTSP :8554). Install Docker + install-wyze-bridge.ps1",
      })
    );
    return;
  }
  const ff = cfg.ffmpegPath;
  if (!existsSync(ff)) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `ffmpeg not found at ${ff}` }));
    return;
  }

  const rtsp = wyzeRtspUrl(cam);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-rtsp_transport",
    "tcp",
    "-timeout",
    "5000000",
    "-rw_timeout",
    "5000000",
    "-i",
    rtsp,
    "-an",
    "-f",
    "mpjpeg", // multipart JPEG — works with <img src> + boundary=ffmpeg
    "-q:v",
    "7",
    "-r",
    "8",
    "pipe:1",
  ];

  wyzeLiveInFlight += 1;
  let closed = false;
  let proc = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    wyzeLiveInFlight = Math.max(0, wyzeLiveInFlight - 1);
    if (proc) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      proc = null;
    }
  };

  try {
    proc = spawn(ff, args, { windowsHide: true });
  } catch (e) {
    cleanup();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Could not start live ffmpeg",
      })
    );
    return;
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=ffmpeg",
    "Cache-Control": "no-cache, no-store",
    Connection: "close",
  });

  proc.stdout.on("data", (chunk) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(chunk);
    } catch {
      cleanup();
    }
  });
  proc.stderr.on("data", () => {
    /* swallow ffmpeg chatter */
  });
  proc.on("error", () => cleanup());
  proc.on("close", () => {
    cleanup();
    try {
      if (!res.writableEnded) res.end();
    } catch {
      /* ignore */
    }
  });
  req.on("close", cleanup);
  res.on("close", cleanup);
  console.log(
    `wyze live start cam=${cam.id} method=rtsp liveInFlight=${wyzeLiveInFlight} global=${wyzeLiveInFlight + nvrLiveInFlight}`
  );
}

async function handleWyzeSnapshot(req, res, url) {
  try {
    const camId = url.searchParams.get("cam") || url.searchParams.get("id") || "";
    const cam = wyzeCamById(camId);
    if (!cam) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown Wyze camera: ${camId}` }));
      return;
    }
    if (wyzeSnapInFlight >= WYZE_SNAP_MAX) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Wyze snapshot busy — try again" }));
      return;
    }
    const bridgeUp = await probeWyzeBridge(800);
    if (!bridgeUp) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "Wyze Bridge not running (nothing on RTSP :8554). Install Docker + install-wyze-bridge.ps1",
        })
      );
      return;
    }
    wyzeSnapInFlight += 1;
    let jpeg;
    try {
      jpeg = await ffmpegGrabJpeg(wyzeRtspUrl(cam), 8000);
    } finally {
      wyzeSnapInFlight -= 1;
    }
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": String(jpeg.length),
      "Cache-Control": "no-store",
    });
    res.end(jpeg);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error:
          e instanceof Error
            ? e.message
            : "Wyze snapshot failed — is Wyze Bridge running?",
      })
    );
  }
}

async function handleWyzeClip(req, res, url) {
  try {
    const camId = url.searchParams.get("cam") || url.searchParams.get("id") || "";
    const cam = wyzeCamById(camId);
    if (!cam) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown Wyze camera: ${camId}` }));
      return;
    }
    const start = new Date(url.searchParams.get("start") || "");
    let end = new Date(url.searchParams.get("end") || "");
    if (Number.isNaN(start.getTime())) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid start time" }));
      return;
    }
    if (Number.isNaN(end.getTime()) || end <= start) {
      end = new Date(start.getTime() + WYZE_SEG_SEC * 1000);
    }
    let durSec = Math.round((end - start) / 1000);
    durSec = Math.max(15, Math.min(MAX_SEC, durSec));
    end = new Date(start.getTime() + durSec * 1000);

    const segs = listWyzeSegments(cam.id).filter(
      (s) => s.endMs > start.getTime() && s.startMs < end.getTime()
    );

    let mp4;
    if (segs.length) {
      // Prefer the segment with the most overlap, then cut
      segs.sort((a, b) => {
        const oa = Math.min(a.endMs, end.getTime()) - Math.max(a.startMs, start.getTime());
        const ob = Math.min(b.endMs, end.getTime()) - Math.max(b.startMs, start.getTime());
        return ob - oa;
      });
      const best = segs[0];
      const offsetSec = Math.max(0, (start.getTime() - best.startMs) / 1000);
      const availSec = Math.max(1, (best.endMs - Math.max(best.startMs, start.getTime())) / 1000);
      const cutSec = Math.min(durSec, availSec);
      console.log(
        `wyze clip cam=${cam.id} from record offset=${offsetSec.toFixed(1)}s cut=${cutSec}s file=${best.path}`
      );
      mp4 = await ffmpegCutFile(best.path, offsetSec, cutSec);
    } else {
      // No local recording yet — only allow near-live capture
      const ageMs = Date.now() - start.getTime();
      if (ageMs > 10 * 60 * 1000) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "No Wyze recording for that time yet. Local ring-buffer starts after Wyze Bridge + media proxy run. Try a recent time (last few minutes) or wait for continuous recording to fill.",
          })
        );
        return;
      }
      console.log(`wyze clip cam=${cam.id} LIVE capture ${durSec}s`);
      mp4 = await ffmpegLiveClip(wyzeRtspUrl(cam), Math.min(durSec, 150));
    }

    if (!mp4 || mp4.length < 500) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty Wyze clip" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": String(mp4.length),
      "Cache-Control": "no-store",
    });
    res.end(mp4);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: e instanceof Error ? e.message : "Wyze clip failed",
      })
    );
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/fieldapp/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        nvr: NVR,
        ffmpeg: existsSync(cfg.ffmpegPath),
        live: {
          inFlight: wyzeLiveInFlight + nvrLiveInFlight,
          max: LIVE_MAX,
          nvrInFlight: nvrLiveInFlight,
          nvrMax: NVR_LIVE_MAX,
          wyzeInFlight: wyzeLiveInFlight,
          wyzeMax: WYZE_LIVE_MAX,
        },
        wyze: {
          rtspBase: WYZE_RTSP,
          record: WYZE_RECORD,
          cameras: WYZE_CAMS.map((c) => c.id),
          recording: [...wyzeRecordProcs.keys()],
        },
      })
    );
    return;
  }
  if (url.pathname === "/fieldapp/clip") {
    await handleClip(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/segments") {
    await handleSegments(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/nvr/live") {
    await handleNvrLive(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/wyze/snapshot") {
    await handleWyzeSnapshot(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/wyze/live") {
    await handleWyzeLive(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/wyze/clip") {
    await handleWyzeClip(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/wyze/segments") {
    await handleWyzeSegments(req, res, url);
    return;
  }
  if (url.pathname === "/fieldapp/wyze/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        rtspBase: WYZE_RTSP,
        record: WYZE_RECORD,
        retainHours: WYZE_RETAIN_H,
        segmentSec: WYZE_SEG_SEC,
        liveInFlight: wyzeLiveInFlight,
        liveMax: WYZE_LIVE_MAX,
        globalLiveInFlight: wyzeLiveInFlight + nvrLiveInFlight,
        globalLiveMax: LIVE_MAX,
        cameras: WYZE_CAMS.map((c) => ({
          id: c.id,
          label: c.label,
          rtspPath: c.rtspPath,
          recording: wyzeRecordProcs.has(String(c.id)),
          segments: listWyzeSegments(c.id).length,
        })),
      })
    );
    return;
  }
  proxyToNvr(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`NVR media proxy on http://127.0.0.1:${PORT} -> ${NVR}`);
  console.log(`Clip: http://127.0.0.1:${PORT}/fieldapp/clip?channel=1&start=ISO&end=ISO`);
  console.log(`Segments: http://127.0.0.1:${PORT}/fieldapp/segments?channel=1&around=ISO&padMin=60`);
  console.log(`NVR LIVE: http://127.0.0.1:${PORT}/fieldapp/nvr/live?channel=1 (RTSP→ISAPI→snap-pump)`);
  console.log(`Wyze: http://127.0.0.1:${PORT}/fieldapp/wyze/snapshot?cam=warehouse`);
  console.log(`Wyze LIVE: http://127.0.0.1:${PORT}/fieldapp/wyze/live?cam=warehouse`);
  console.log(`Live caps: global=${LIVE_MAX} nvr=${NVR_LIVE_MAX} wyze=${WYZE_LIVE_MAX}`);
  startAllWyzeRecorders();
});
