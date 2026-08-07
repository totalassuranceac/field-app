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
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
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
  };
  try {
    if (existsSync(CONFIG_PATH)) {
      return { ...defaults, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
    }
  } catch {
    /* ignore */
  }
  return defaults;
}

const cfg = loadConfig();
const NVR = cfg.nvrBase.replace(/\/+$/, "");
const PORT = Number(cfg.listenPort) || 8790;
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
function hikTime(d) {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function searchPlaybackUri(channelId, start, end) {
  const trackId = `${channelId}01`;
  // Widen search a bit so we find the segment covering the window
  const searchStart = new Date(start.getTime() - 5 * 60 * 1000);
  const searchEnd = new Date(end.getTime() + 5 * 60 * 1000);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription>
  <searchID>${randomUUID()}</searchID>
  <trackList><trackID>${trackId}</trackID></trackList>
  <timeSpanList><timeSpan>
    <startTime>${utcIso(searchStart)}</startTime>
    <endTime>${utcIso(searchEnd)}</endTime>
  </timeSpan></timeSpanList>
  <maxResults>40</maxResults>
  <searchResultPostion>0</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
  const res = await nvrAuthFetch("/ISAPI/ContentMgmt/search", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/xml" },
    timeoutMs: 45000,
  });
  const xml = res.body.toString("utf8");
  if (res.status !== 200) {
    return { ok: false, error: `Search failed (${res.status})`, xml };
  }
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
    if (playbackURI) matches.push({ playbackURI, segStart, segEnd });
  }
  if (!matches.length) {
    return { ok: false, error: "No recording found for that time on this camera.", xml };
  }
  // Prefer segment that overlaps requested window
  const pick =
    matches.find((x) => {
      const a = Date.parse(x.segStart);
      const b = Date.parse(x.segEnd);
      return Number.isFinite(a) && Number.isFinite(b) && a <= end.getTime() && b >= start.getTime();
    }) || matches[0];
  return { ok: true, ...pick, matches };
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

    // ISAPI download sized for full duration (RTSP port is closed on this NVR)
    const found = await searchPlaybackUri(channelId, start, end);
    if (!found.ok) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: found.error || "No recording for that time" }));
      return;
    }
    const uri = clampUri(found.playbackURI, start, end);
    const needBytes = Math.min(
      1500 * 1024 * 1024,
      Math.max(320 * 1024 * 1024, estimateBytesForDuration(found.playbackURI, durSec))
    );
    console.log(
      `clip ch=${channelId} dur=${durSec}s needBytes=${Math.round(needBytes / 1024 / 1024)}MB`
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
      mp4 = await ffmpegFileToMp4(inFile, durSec);
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
      "X-Clip-Seconds": String(durSec),
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/fieldapp/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, nvr: NVR, ffmpeg: existsSync(cfg.ffmpegPath) }));
    return;
  }
  if (url.pathname === "/fieldapp/clip") {
    await handleClip(req, res, url);
    return;
  }
  proxyToNvr(req, res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`NVR media proxy on http://127.0.0.1:${PORT} -> ${NVR}`);
  console.log(`Clip: http://127.0.0.1:${PORT}/fieldapp/clip?channel=1&start=ISO&end=ISO`);
});
