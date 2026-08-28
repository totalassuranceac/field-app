/**
 * ServiceTitan API v2 client (OAuth2 client credentials).
 * Used for pricebook material photos and future sync.
 *
 * Credentials (env secrets preferred, or Admin settings):
 *   ST_TENANT_ID, ST_CLIENT_ID, ST_CLIENT_SECRET, ST_APP_KEY
 */

import type { Env } from "./types";
import { getSetting, setSetting } from "./audit";

const AUTH_URL = "https://auth.servicetitan.io/connect/token";
const API_BASE = "https://api.servicetitan.io";

export type StCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  appKey: string;
};

export async function loadStCredentials(env: Env, db: D1Database): Promise<StCredentials | null> {
  const tenantId =
    (env.ST_TENANT_ID || "").trim() || (await getSetting(db, "st_tenant_id", "")).trim();
  const clientId =
    (env.ST_CLIENT_ID || "").trim() || (await getSetting(db, "st_client_id", "")).trim();
  const clientSecret =
    (env.ST_CLIENT_SECRET || "").trim() || (await getSetting(db, "st_client_secret", "")).trim();
  const appKey = (env.ST_APP_KEY || "").trim() || (await getSetting(db, "st_app_key", "")).trim();
  if (!tenantId || !clientId || !clientSecret || !appKey) return null;
  return { tenantId, clientId, clientSecret, appKey };
}

export async function stConfigured(env: Env, db: D1Database): Promise<boolean> {
  return Boolean(await loadStCredentials(env, db));
}

type TokenCache = { access_token: string; expires_at: number };

async function getAccessToken(env: Env, db: D1Database, creds: StCredentials): Promise<string> {
  const raw = await getSetting(db, "st_token_cache", "");
  if (raw) {
    try {
      const cached = JSON.parse(raw) as TokenCache;
      if (cached.access_token && cached.expires_at > Date.now() + 60_000) {
        return cached.access_token;
      }
    } catch {
      /* refresh */
    }
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ServiceTitan auth failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("ServiceTitan auth: no access_token");
  const expiresIn = Number(data.expires_in) || 900;
  await setSetting(
    db,
    "st_token_cache",
    JSON.stringify({
      access_token: data.access_token,
      expires_at: Date.now() + expiresIn * 1000,
    } satisfies TokenCache)
  );
  return data.access_token;
}

async function stFetch(
  env: Env,
  db: D1Database,
  creds: StCredentials,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const token = await getAccessToken(env, db, creds);
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const extra = init?.headers;
  const merged: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": creds.appKey,
    Accept: "application/json",
  };
  if (extra && typeof extra === "object" && !(extra instanceof Headers)) {
    Object.assign(merged, extra as Record<string, string>);
  } else if (extra instanceof Headers) {
    extra.forEach((v, k) => {
      merged[k] = v;
    });
  }
  return fetch(url, {
    ...init,
    headers: merged,
  });
}

/** Public GET helper for other modules (jobs, job-types, etc.). Read-only callers. */
export async function stApiGet(
  env: Env,
  db: D1Database,
  path: string
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const creds = await loadStCredentials(env, db);
  if (!creds) {
    return { ok: false, status: 503, json: null, text: "ServiceTitan not configured" };
  }
  const res = await stFetch(env, db, creds, path, { method: "GET" });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

export async function stTenantId(env: Env, db: D1Database): Promise<string | null> {
  const creds = await loadStCredentials(env, db);
  return creds?.tenantId || null;
}

function sniffImageType(buf: ArrayBuffer, fallbackPath: string, headerCt: string): string | null {
  const ct = (headerCt || "").toLowerCase().split(";")[0].trim();
  const u8 = new Uint8Array(buf.slice(0, 12));
  const isJpeg = u8[0] === 0xff && u8[1] === 0xd8;
  const isPng = u8[0] === 0x89 && u8[1] === 0x50;
  const isGif = u8[0] === 0x47 && u8[1] === 0x49;
  const isWebp = u8[0] === 0x52 && u8[1] === 0x49 && u8[8] === 0x57;
  if (isPng) return "image/png";
  if (isJpeg) return "image/jpeg";
  if (isGif) return "image/gif";
  if (isWebp) return "image/webp";
  if (ct.startsWith("image/")) return ct;
  // last resort by extension
  const guessed = guessImageType(fallbackPath);
  if (buf.byteLength > 200 && /\.(png|jpe?g|webp|gif)$/i.test(fallbackPath)) return guessed;
  return null;
}

/**
 * Download a pricebook image by relative path (Images/Material/...).
 * ST requires: GET /pricebook/v2/tenant/{id}/images?path=...
 *
 * Important: Cloudflare Workers often forward Authorization onto Azure blob
 * redirects, which makes Azure return 400 XML. We follow redirects manually
 * and drop auth headers on the second hop.
 */
export async function downloadStPricebookImage(
  env: Env,
  db: D1Database,
  creds: StCredentials,
  imagePath: string
): Promise<{ ok: true; buf: ArrayBuffer; contentType: string } | { ok: false; detail: string }> {
  const pathParam = imagePath.trim().replace(/^\/+/, "");
  if (!pathParam) return { ok: false, detail: "Empty image path" };

  const token = await getAccessToken(env, db, creds);
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "ST-App-Key": creds.appKey,
    Accept: "image/*,application/octet-stream,*/*",
  };

  // Prefer simple query string (encode once)
  const primaryUrl = `${API_BASE}/pricebook/v2/tenant/${encodeURIComponent(
    creds.tenantId
  )}/images?path=${encodeURIComponent(pathParam)}`;

  const attempts: string[] = [primaryUrl];

  const errors: string[] = [];

  for (const startUrl of attempts) {
    try {
      // Manual redirect so we can strip auth on Azure hop
      let res = await fetch(startUrl, {
        method: "GET",
        headers: authHeaders,
        redirect: "manual",
      });

      // Follow up to 5 redirects without Authorization (Azure SAS URLs reject extra auth → 400)
      let hops = 0;
      while (res.status >= 300 && res.status < 400 && hops < 5) {
        const loc = res.headers.get("Location") || res.headers.get("location");
        if (!loc) break;
        const next = new URL(loc, startUrl).toString();
        hops++;
        res = await fetch(next, {
          method: "GET",
          headers: { Accept: "image/*,application/octet-stream,*/*" },
          redirect: "manual",
        });
      }

      // Some runtimes still auto-resolve; handle final body
      if (res.status >= 300 && res.status < 400) {
        errors.push(`redirect-loop status=${res.status}`);
        continue;
      }

      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        errors.push(`${res.status} ${body.slice(0, 80).replace(/\s+/g, " ")}`);
        continue;
      }

      const buf = await res.arrayBuffer();
      if (buf.byteLength < 50) {
        errors.push(`too-small ${buf.byteLength}`);
        continue;
      }

      // If ST returned JSON error with 200 (rare)
      if (ct.includes("json") || ct.includes("problem")) {
        errors.push(`json-body ${new TextDecoder().decode(buf.slice(0, 80))}`);
        continue;
      }

      const contentType = sniffImageType(buf, pathParam, ct);
      if (!contentType) {
        errors.push(`not-image ct=${ct || "none"} n=${buf.byteLength}`);
        continue;
      }

      return { ok: true, buf, contentType };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  // Fallback: allow runtime default redirect follow (Node-style) without reusing failed hop state
  try {
    const res = await fetch(primaryUrl, {
      method: "GET",
      headers: authHeaders,
      redirect: "follow",
    });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const contentType = sniffImageType(buf, pathParam, res.headers.get("content-type") || "");
      if (contentType && buf.byteLength >= 50) {
        return { ok: true, buf, contentType };
      }
    } else {
      const body = await res.text().catch(() => "");
      errors.push(`follow ${res.status} ${body.slice(0, 60)}`);
    }
  } catch (e) {
    errors.push(`follow ${e instanceof Error ? e.message : String(e)}`);
  }

  return {
    ok: false,
    detail: `Image download failed for ${pathParam.slice(0, 40)}… (${errors.slice(0, 2).join(" | ")})`,
  };
}

export async function testStConnection(
  env: Env,
  db: D1Database
): Promise<{ ok: boolean; detail: string }> {
  const creds = await loadStCredentials(env, db);
  if (!creds) {
    return {
      ok: false,
      detail:
        "Missing credentials. Need Tenant ID, Client ID, Client Secret, and App Key (Admin → ServiceTitan or wrangler secrets).",
    };
  }
  try {
    const token = await getAccessToken(env, db, creds);
    // Lightweight pricebook ping — materials list page 1
    const res = await stFetch(
      env,
      db,
      creds,
      `/pricebook/v2/tenant/${creds.tenantId}/materials?page=1&pageSize=1`,
      { method: "GET" }
    );
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        detail: `Token OK but materials API ${res.status}: ${text.slice(0, 180)}`,
      };
    }
    return {
      ok: true,
      detail: `Connected to tenant ${creds.tenantId}. Token length ${token.length}. Materials API OK.`,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Pull absolute image URL or relative path from a material API object. */
export function extractMaterialImageUrl(mat: Record<string, unknown>): string | null {
  // ST materials return defaultAssetUrl + assets[{ url, fileName, type }]
  const candidates: unknown[] = [
    mat.defaultAssetUrl,
    mat.image,
    mat.imageUrl,
    mat.primaryImage,
    mat.defaultImage,
    mat.displayImage,
  ];
  if (Array.isArray(mat.assets)) {
    // Prefer isDefault image asset
    const assets = mat.assets as Record<string, unknown>[];
    const def = assets.find(
      (a) => a && (a.isDefault === true || String(a.type || "").toLowerCase() === "image")
    );
    if (def) candidates.push(def);
    for (const a of assets) candidates.push(a);
  }
  if (Array.isArray(mat.images) && mat.images[0]) candidates.push(mat.images[0]);

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      const s = c.trim();
      if (
        /^https?:\/\//i.test(s) ||
        s.startsWith("Images/") ||
        s.startsWith("Pricebook/") ||
        /\.(png|jpe?g|webp|gif)$/i.test(s)
      ) {
        return s;
      }
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      // Prefer full relative path (url) over bare fileName
      for (const k of ["url", "Url", "href", "path", "alias", "fileName", "FileName"]) {
        const v = o[k];
        if (typeof v === "string" && v.trim()) {
          const s = v.trim();
          if (
            /^https?:\/\//i.test(s) ||
            s.startsWith("Images/") ||
            s.startsWith("Pricebook/") ||
            /\.(png|jpe?g|webp|gif)$/i.test(s)
          ) {
            return s;
          }
        }
      }
    }
  }
  if (mat.media && typeof mat.media === "object") {
    return extractMaterialImageUrl(mat.media as Record<string, unknown>);
  }
  return null;
}

async function cacheImageBlob(
  db: D1Database,
  key: string,
  contentType: string,
  data: ArrayBuffer
): Promise<void> {
  const bytes = new Uint8Array(data);
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
      )
      .bind(key, contentType, bytes, bytes.byteLength)
      .run();
  } catch {
    try {
      await db
        .prepare(
          `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
        )
        .bind(key, contentType, bytes, bytes.byteLength)
        .run();
    } catch {
      /* storage optional */
    }
  }
}

/**
 * Download image bytes for a material (by ST id) and attach to our part row.
 * Returns local /api/uploads URL when stored.
 * existingPath: skip material lookup when we already have Images/... from pricebook import.
 */
export async function syncMaterialImageToPart(
  env: Env,
  db: D1Database,
  partId: number,
  stMaterialId: string,
  existingPath?: string | null
): Promise<{ ok: boolean; image_url?: string; detail: string }> {
  const creds = await loadStCredentials(env, db);
  if (!creds) return { ok: false, detail: "ServiceTitan not configured" };

  let imageRef: string | null = null;
  const existing = (existingPath || "").trim();
  if (
    existing.startsWith("Images/") ||
    existing.startsWith("Pricebook/") ||
    (existing.includes("/") && /\.(png|jpe?g|webp|gif)$/i.test(existing))
  ) {
    imageRef = existing;
  }

  // 1) Material detail for path if needed
  if (!imageRef) {
    const matRes = await stFetch(
      env,
      db,
      creds,
      `/pricebook/v2/tenant/${creds.tenantId}/materials/${stMaterialId}`
    );
    const matText = await matRes.text();
    if (!matRes.ok) {
      return {
        ok: false,
        detail: `Material ${stMaterialId}: ${matRes.status} ${matText.slice(0, 120)}`,
      };
    }
    let mat: Record<string, unknown>;
    try {
      mat = JSON.parse(matText) as Record<string, unknown>;
    } catch {
      return { ok: false, detail: "Invalid material JSON from ServiceTitan" };
    }
    imageRef = extractMaterialImageUrl(mat);
  }

  if (!imageRef) {
    return { ok: false, detail: `No image on material ${stMaterialId} in ServiceTitan API` };
  }

  // 2) Download via confirmed Pricebook Images API
  let buf: ArrayBuffer | null = null;
  let contentType = "image/jpeg";
  let downloadDetail = "";

  if (/^https?:\/\//i.test(imageRef)) {
    try {
      const imgRes = await fetch(imageRef, {
        headers: {
          Authorization: `Bearer ${await getAccessToken(env, db, creds)}`,
          "ST-App-Key": creds.appKey,
          Accept: "image/*,*/*",
        },
        redirect: "follow",
      });
      if (imgRes.ok) {
        contentType = imgRes.headers.get("content-type") || contentType;
        buf = await imgRes.arrayBuffer();
      } else {
        downloadDetail = `HTTP image ${imgRes.status}`;
      }
    } catch (e) {
      downloadDetail = e instanceof Error ? e.message : String(e);
    }
  }

  if (!buf) {
    const dl = await downloadStPricebookImage(env, db, creds, imageRef);
    if (dl.ok) {
      buf = dl.buf;
      contentType = dl.contentType;
    } else {
      downloadDetail = dl.detail;
    }
  }

  if (!buf || buf.byteLength < 50) {
    await db
      .prepare(`UPDATE parts SET image_url = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(imageRef, partId)
      .run();
    return {
      ok: false,
      detail: downloadDetail || `Could not download “${imageRef.slice(0, 50)}”`,
      image_url: imageRef,
    };
  }

  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : contentType.includes("gif")
        ? "gif"
        : "jpg";
  const key = `part-images/${partId}.${ext}`;
  const bytes = new Uint8Array(buf);

  // Always store permanently in both blob tables so thumbs survive without a second step
  let stored = false;
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO part_image_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
      )
      .bind(key, contentType, bytes, bytes.byteLength)
      .run();
    stored = true;
  } catch {
    /* table may not exist */
  }
  try {
    await db
      .prepare(
        `INSERT OR REPLACE INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
      )
      .bind(key, contentType, bytes, bytes.byteLength)
      .run();
    stored = true;
  } catch {
    /* optional second table */
  }
  if (!stored) {
    return {
      ok: false,
      detail: "Downloaded photo but could not save permanently (blob tables missing?)",
    };
  }

  const imageUrl = `/api/uploads/${key}`;
  await db
    .prepare(`UPDATE parts SET image_url = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(imageUrl, partId)
    .run();

  return {
    ok: true,
    image_url: imageUrl,
    detail: `Photo saved permanently (${Math.round(buf.byteLength / 1024)}KB)`,
  };
}

function guessImageType(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * Sync photos for all active parts that have external_st_id (ST material id).
 * Caps work per call for Worker time limits.
 */
export async function syncAllPartImages(
  env: Env,
  db: D1Database,
  opts?: { limit?: number; onlyMissing?: boolean }
): Promise<{
  attempted: number;
  saved: number;
  failed: number;
  details: string[];
}> {
  // Smaller batches — each image is a separate ST download + D1 write
  const limit = Math.min(25, Math.max(1, opts?.limit ?? 15));
  const onlyMissing = opts?.onlyMissing !== false;
  let sql = `SELECT id, external_st_id, name, image_url FROM parts
             WHERE active = 1 AND external_st_id IS NOT NULL AND TRIM(external_st_id) != ''`;
  if (onlyMissing) {
    sql += ` AND (image_url IS NULL OR image_url = '' OR image_url LIKE 'Images/%' OR image_url LIKE 'Pricebook/%')`;
  }
  sql += ` ORDER BY name LIMIT ?`;

  const rows = await db
    .prepare(sql)
    .bind(limit)
    .all<{ id: number; external_st_id: string; name: string; image_url: string | null }>();

  let saved = 0;
  let failed = 0;
  const details: string[] = [];
  const list = rows.results || [];

  for (const row of list) {
    try {
      const r = await syncMaterialImageToPart(
        env,
        db,
        row.id,
        String(row.external_st_id).trim(),
        row.image_url
      );
      if (r.ok) {
        saved++;
        details.push(`OK ${row.name}`);
      } else {
        failed++;
        details.push(`${row.name}: ${r.detail}`);
      }
    } catch (e) {
      failed++;
      details.push(`${row.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { attempted: list.length, saved, failed, details: details.slice(0, 12) };
}

/**
 * Deactivate a material in the ServiceTitan pricebook.
 * ST does not hard-delete pricebook items (history); active=false hides them from use.
 */
export async function deactivateStMaterial(
  env: Env,
  db: D1Database,
  stMaterialId: string | number
): Promise<{ ok: boolean; detail: string }> {
  const creds = await loadStCredentials(env, db);
  if (!creds) throw new Error("ServiceTitan not configured");
  const id = String(stMaterialId).trim();
  if (!id) throw new Error("Missing ServiceTitan material id");

  const res = await stFetch(
    env,
    db,
    creds,
    `/pricebook/v2/tenant/${creds.tenantId}/materials/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: false }),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    // Some tenants use PUT or require more fields — try once more with active only via known shape
    if (res.status === 404) {
      return { ok: false, detail: `ST material ${id} not found (may already be removed)` };
    }
    throw new Error(`ST deactivate material ${res.status}: ${text.slice(0, 200)}`);
  }
  return { ok: true, detail: `Deactivated ST material ${id}` };
}

/** Create a pricebook material in ServiceTitan (or update if st id known). */
export async function createStMaterial(
  env: Env,
  db: D1Database,
  input: {
    code: string;
    name: string;
    description?: string | null;
    cost?: number | null;
    price?: number | null;
    unitOfMeasure?: string | null;
    externalId?: string | null;
    active?: boolean;
  }
): Promise<{ st_id: string | number | null; created: boolean; detail: string }> {
  const creds = await loadStCredentials(env, db);
  if (!creds) throw new Error("ServiceTitan not configured");

  const body: Record<string, unknown> = {
    code: input.code,
    displayName: input.name,
    description: input.description || "",
    cost: input.cost != null && Number.isFinite(Number(input.cost)) ? Number(input.cost) : 0,
    price: input.price != null && Number.isFinite(Number(input.price)) ? Number(input.price) : 0,
    isInventory: true,
    active: input.active !== false,
  };
  if (input.unitOfMeasure) body.unitOfMeasure = input.unitOfMeasure;

  const existingId = input.externalId && String(input.externalId).trim();
  if (existingId) {
    const res = await stFetch(
      env,
      db,
      creds,
      `/pricebook/v2/tenant/${creds.tenantId}/materials/${existingId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ST update material ${res.status}: ${text.slice(0, 180)}`);
    }
    return { st_id: existingId, created: false, detail: "Updated material in ServiceTitan" };
  }

  const res = await stFetch(
    env,
    db,
    creds,
    `/pricebook/v2/tenant/${creds.tenantId}/materials`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ST create material ${res.status}: ${text.slice(0, 180)}`);
  }
  let stId: string | number | null = null;
  try {
    const j = JSON.parse(text) as { id?: number | string };
    stId = j.id ?? null;
  } catch {
    /* ignore */
  }
  return {
    st_id: stId,
    created: true,
    detail: stId ? `Created ST material ${stId}` : "Created material in ServiceTitan",
  };
}

/**
 * Best-effort: pull recent installed/job materials from ST and deduct truck stock
 * for matching external_st_id parts. Tracks last watermark in settings.
 *
 * Full vehicle mapping needs technician→unit data from ST; we deduct from warehouse
 * first when truck is unknown (audited as st-usage).
 */
export async function applyStUsageDeductions(
  env: Env,
  db: D1Database
): Promise<{ deducted: number; skipped: number; details: string[] }> {
  const creds = await loadStCredentials(env, db);
  if (!creds) throw new Error("ServiceTitan not configured");

  // Watermark — only process after this ISO time
  const since =
    (await getSetting(db, "st_usage_since", "")).trim() ||
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Try common export / installed material endpoints (tenant-dependent availability)
  const tryPaths = [
    `/inventory/v2/tenant/${creds.tenantId}/export/transactions?from=${encodeURIComponent(since)}&pageSize=50`,
    `/pricebook/v2/tenant/${creds.tenantId}/materials?modifiedOnOrAfter=${encodeURIComponent(since)}&pageSize=1`,
  ];

  let sampleOk = false;
  for (const p of tryPaths) {
    try {
      const res = await stFetch(env, db, creds, p);
      if (res.ok) {
        sampleOk = true;
        break;
      }
    } catch {
      /* next */
    }
  }

  // Without a reliable job-materials feed, mark watermark and return guidance
  if (!sampleOk) {
    await setSetting(db, "st_usage_since", new Date().toISOString());
    return {
      deducted: 0,
      skipped: 0,
      details: [
        "ST job-material feed not available for this tenant yet. Use warehouse Issue-to-truck for now; full auto-deduct needs Jobs/Installed Equipment API scope.",
      ],
    };
  }

  // Placeholder path until Jobs materials scope is confirmed: no silent wrong deducts
  await setSetting(db, "st_usage_since", new Date().toISOString());
  return {
    deducted: 0,
    skipped: 0,
    details: [
      `API reachable. Auto truck deduct from ST invoices/jobs will activate when Jobs materials scope is enabled. Watermark set (${since.slice(0, 10)}…).`,
    ],
  };
}
