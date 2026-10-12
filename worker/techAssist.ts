/**
 * Tech assist routes: settings, job brief, equipment snaps, wrap-up notes.
 * ServiceTitan is read-only. No SMS.
 */
import { getSetting, setSetting, writeAudit } from "./audit";
import { ROLE_PERMS, roleAtLeast } from "./auth";
import { decodeEquipment } from "./equipmentDecode";
import { getTodaysJobsForUser } from "./jobClock";
import { recordOcrFeedback, type OcrFieldSnapshot } from "./ocrLearn";
import { buildTechBrief, normAddr, saveBriefAi, tableExists } from "./techBrief";
import { runTechAi } from "./techAi";
import { splitWrapupSmart, wrapupCopyText, type Wrapup } from "./wrapupPlan";
import type { Env, PublicUser } from "./types";

const NOT_READY = "Run migration 113_tech_assist.sql (after Chris says Y).";
const ROLES = ["outdoor", "indoor", "furnace", "air_handler", "package", "unknown"] as const;
const SEE = Array.from(new Set([...ROLE_PERMS.useJobClock, ...ROLE_PERMS.viewDayBoard]));

type Ctx = {
  env: Env;
  get: (key: "user") => PublicUser;
  req: {
    param: (name: string) => string;
    query: (name: string) => string | undefined;
    json: <T>() => Promise<T>;
  };
  json: (body: unknown, status?: number) => Response;
};

function clip(s: unknown, max: number): string {
  return String(s || "").replace(/[^\x20-\x7E\n]/g, " ").trim().slice(0, max);
}

function solderIds(raw: string): number[] {
  const ids = String(raw || "").split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
  return ids.length ? ids : [339591774, 336193175];
}

function isOffice(user: PublicUser): boolean {
  return user.role === "admin" || user.role === "office" || user.role === "supervisor";
}

export async function canSeeJob(c: Ctx, user: PublicUser, stJobId: string): Promise<true | Response> {
  const id = String(stJobId || "").trim();
  if (!id) return c.json({ error: "Job id required" }, 400);
  if (user.role !== "driver" && roleAtLeast(user.role, ROLE_PERMS.viewDayBoard)) return true;
  if (roleAtLeast(user.role, ROLE_PERMS.useJobClock)) {
    try {
      const today = await getTodaysJobsForUser(c.env, c.env.DB, user);
      const ok = (today.jobs || []).some((job) => String(job.st_job_id) === id);
      if (ok) return true;
    } catch {
      /* fall through */
    }
    return c.json({ error: "Not your job today." }, 403);
  }
  return c.json({ error: "Not allowed" }, 403);
}

function deny(c: Ctx, roles: string[]): Response | null {
  const user = c.get("user");
  if (!user) return c.json({ error: "Sign in" }, 401);
  if (!roleAtLeast(user.role, roles as never)) return c.json({ error: "Not allowed" }, 403);
  return null;
}

function pack(list: string[] | undefined): string {
  return (list || []).map((s) => clip(s, 200)).filter((s) => s.length >= 3).slice(0, 6).join("\n");
}

function unpack(s: string | null | undefined): string[] {
  return String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
}

type WrapRow = {
  id: number;
  st_job_id: string;
  user_id: number;
  raw_text: string;
  found_text: string | null;
  did_text: string | null;
  recommend_text: string | null;
  parts_text: string | null;
  split_by: string;
  input: string;
  copied_at: string | null;
  created_at: string;
  updated_at: string;
};

function publicWrap(row: WrapRow) {
  const result: Wrapup = {
    found: unpack(row.found_text),
    did: unpack(row.did_text),
    recommend: unpack(row.recommend_text),
    parts: unpack(row.parts_text),
  };
  return { ...row, ...result, copy_text: wrapupCopyText(result) };
}

export function mountTechAssist(api: {
  get: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  post: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  put: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  patch: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  delete: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
}): void {
  api.get("/tech/config", async (c) => {
    const db = c.env.DB;
    const on = await getSetting(db, "tech_assist", "1").catch(() => "1");
    const ai = await getSetting(db, "tech_assist_ai", "0").catch(() => "0");
    return c.json({ tech_assist: on !== "0", ai_enabled: ai === "1" && Boolean(c.env.AI) });
  });

  api.get("/tech/settings", async (c) => {
    const blocked = deny(c, ["admin"]);
    if (blocked) return blocked;
    const db = c.env.DB;
    const [assist, ai, ids, age] = await Promise.all([
      getSetting(db, "tech_assist", "1"),
      getSetting(db, "tech_assist_ai", "0"),
      getSetting(db, "job_rule_solder_type_ids", "339591774,336193175"),
      getSetting(db, "job_rule_options_age_years", "12"),
    ]);
    return c.json({
      tech_assist: assist !== "0",
      tech_assist_ai: ai === "1",
      job_rule_solder_type_ids: ids,
      job_rule_options_age_years: age,
      ai_enabled: ai === "1" && Boolean(c.env.AI),
    });
  });

  api.put("/tech/settings", async (c) => {
    const blocked = deny(c, ["admin"]);
    if (blocked) return blocked;
    const user = c.get("user");
    const body = await c.req.json<{
      tech_assist?: boolean | string;
      tech_assist_ai?: boolean | string;
      job_rule_solder_type_ids?: string;
      job_rule_options_age_years?: string | number;
    }>();
    const db = c.env.DB;
    const assist = body.tech_assist === false || body.tech_assist === "0" ? "0" : "1";
    const ai = body.tech_assist_ai === true || body.tech_assist_ai === "1" ? "1" : "0";
    const ids = solderIds(String(body.job_rule_solder_type_ids || "339591774,336193175")).join(",");
    const ageN = Number(body.job_rule_options_age_years);
    const age = Number.isFinite(ageN) && ageN >= 1 && ageN <= 40 ? String(Math.round(ageN)) : "12";
    await setSetting(db, "tech_assist", assist);
    await setSetting(db, "tech_assist_ai", ai);
    await setSetting(db, "job_rule_solder_type_ids", ids);
    await setSetting(db, "job_rule_options_age_years", age);
    await writeAudit(db, user, "update", "setting", "tech_assist", `tech_assist=${assist} ai=${ai} solder=${ids} age=${age}`);
    return c.json({
      tech_assist: assist === "1",
      tech_assist_ai: ai === "1",
      job_rule_solder_type_ids: ids,
      job_rule_options_age_years: age,
      ai_enabled: ai === "1" && Boolean(c.env.AI),
    });
  });

  api.get("/tech/brief/:stJobId", async (c) => {
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const stJobId = c.req.param("stJobId");
    const seen = await canSeeJob(c, user, stJobId);
    if (seen !== true) return seen;
    const refresh = c.req.query("refresh") === "1";
    const brief = await buildTechBrief(c.env, c.env.DB, stJobId, {
      refresh,
      limitRefresh: user.role === "driver",
    });
    return c.json(brief);
  });

  api.post("/tech/brief/:stJobId/ai", async (c) => {
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const stJobId = c.req.param("stJobId");
    const seen = await canSeeJob(c, user, stJobId);
    if (seen !== true) return seen;
    const brief = await buildTechBrief(c.env, c.env.DB, stJobId, { refresh: false, limitRefresh: false });
    const facts = (brief.lines || []).join("\n").slice(0, 4000);
    const ai = await runTechAi(
      c.env,
      c.env.DB,
      "You brief an HVAC technician before a job. Rewrite these facts as 2 to 4 short spoken sentences. Use only the facts given. Do not add advice, prices, or anything not listed. Plain ASCII.",
      facts
    );
    if (!ai.ok) return c.json({ ...brief, ai_text: null, ai_reason: ai.reason });
    await saveBriefAi(c.env.DB, stJobId, ai.text, ai.model);
    return c.json({ ...brief, ai_text: ai.text, ai_model: ai.model });
  });

  api.get("/tech/equipment", async (c) => {
    if (!(await tableExists(c.env.DB, "tech_equipment_snaps"))) return c.json({ error: NOT_READY }, 503);
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const stJobId = (c.req.query("st_job_id") || "").trim();
    const locationId = (c.req.query("location_id") || "").trim();
    if (!stJobId && !locationId) return c.json({ error: "st_job_id or location_id required" }, 400);
    if (stJobId) {
      const seen = await canSeeJob(c, user, stJobId);
      if (seen !== true) return seen;
    } else if (user.role === "driver") {
      return c.json({ error: "Not your job today." }, 403);
    }
    const rows = stJobId
      ? await c.env.DB.prepare(
          `SELECT * FROM tech_equipment_snaps WHERE removed_at IS NULL AND st_job_id = ? ORDER BY created_at DESC`
        ).bind(stJobId).all()
      : await c.env.DB.prepare(
          `SELECT * FROM tech_equipment_snaps WHERE removed_at IS NULL AND st_location_id = ? ORDER BY created_at DESC`
        ).bind(locationId).all();
    return c.json({ equipment: rows.results || [] });
  });

  api.post("/tech/equipment", async (c) => {
    if (!(await tableExists(c.env.DB, "tech_equipment_snaps"))) return c.json({ error: NOT_READY }, 503);
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const body = await c.req.json<{
      st_job_id?: string;
      unit_role?: string;
      manufacturer?: string | null;
      model_number?: string | null;
      serial_number?: string | null;
      source?: string;
      raw_ocr?: string | null;
      ocr_feedback?: { raw_text?: string | null; ocr?: OcrFieldSnapshot; final?: OcrFieldSnapshot };
    }>();
    const stJobId = String(body.st_job_id || "").trim();
    const seen = await canSeeJob(c, user, stJobId);
    if (seen !== true) return seen;
    const role = String(body.unit_role || "unknown");
    if (!ROLES.includes(role as (typeof ROLES)[number])) return c.json({ error: "Pick a unit role" }, 400);
    const source = body.source === "ocr" ? "ocr" : body.source === "typed" ? "typed" : "";
    if (!source) return c.json({ error: "source must be ocr or typed" }, 400);
    const manufacturer = clip(body.manufacturer, 40) || null;
    const model = clip(body.model_number, 40) || null;
    const serial = clip(body.serial_number, 40) || null;
    if (!manufacturer && !model && !serial) return c.json({ error: "Enter a make, model, or serial" }, 400);
    const raw = clip(body.raw_ocr, 2000) || null;
    const decoded = decodeEquipment(manufacturer, model, serial);
    let locationId = "";
    let addressNorm = "";
    try {
      const today = await getTodaysJobsForUser(c.env, c.env.DB, user);
      const hit = (today.jobs || []).find((job) => String(job.st_job_id) === stJobId);
      if (hit?.address) addressNorm = normAddr(hit.address);
    } catch {
      /* location filled from ST below */
    }
    try {
      const { stApiGet, stTenantId } = await import("./servicetitan");
      const tenant = await stTenantId(c.env, c.env.DB);
      if (tenant) {
        const res = await stApiGet(c.env, c.env.DB, `/jpm/v2/tenant/${tenant}/jobs/${encodeURIComponent(stJobId)}`);
        const job = res.ok && res.json && typeof res.json === "object" ? (res.json as Record<string, unknown>) : null;
        if (job?.locationId != null) locationId = String(job.locationId);
        if (!addressNorm) {
          const { formatAddress } = await import("./jobClock");
          addressNorm = normAddr(formatAddress(job?.location) || formatAddress(job?.locationAddress) || "");
        }
      }
    } catch {
      /* text still saves */
    }
    const now = new Date().toISOString();
    const ins = await c.env.DB.prepare(
      `INSERT INTO tech_equipment_snaps (
         st_job_id, st_location_id, address_norm, unit_role, manufacturer, model_number, serial_number,
         mfg_year, mfg_month, tonnage, refrigerant_hint, decode_confidence, source, raw_ocr, created_by, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        stJobId,
        locationId || null,
        addressNorm || null,
        role,
        manufacturer,
        model,
        serial,
        decoded.mfg_year,
        decoded.mfg_month,
        decoded.tonnage,
        decoded.refrigerant_hint,
        decoded.confidence,
        source,
        raw,
        user.id,
        now
      )
      .run();
    const id = ins.meta.last_row_id;
    const fb = body.ocr_feedback;
    if (fb?.ocr && fb.final) {
      try {
        await recordOcrFeedback(
          c.env.DB,
          user.id,
          fb.raw_text || raw,
          { ...fb.ocr, store_number: "nameplate" },
          { ...fb.final, store_number: "nameplate" }
        );
      } catch {
        /* learning is best effort */
      }
    }
    const row = await c.env.DB.prepare(`SELECT * FROM tech_equipment_snaps WHERE id = ?`).bind(id).first();
    return c.json({ equipment: row }, 201);
  });

  api.delete("/tech/equipment/:id", async (c) => {
    if (!(await tableExists(c.env.DB, "tech_equipment_snaps"))) return c.json({ error: NOT_READY }, 503);
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const row = await c.env.DB.prepare(`SELECT id, created_by, removed_at FROM tech_equipment_snaps WHERE id = ?`)
      .bind(id)
      .first<{ id: number; created_by: number; removed_at: string | null }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!isOffice(user) && row.created_by !== user.id) return c.json({ error: "Not allowed" }, 403);
    if (!row.removed_at) {
      await c.env.DB.prepare(`UPDATE tech_equipment_snaps SET removed_at = ? WHERE id = ?`)
        .bind(new Date().toISOString(), id)
        .run();
    }
    return c.json({ ok: true });
  });

  api.get("/tech/wrapups", async (c) => {
    if (!(await tableExists(c.env.DB, "tech_job_wrapups"))) return c.json({ error: NOT_READY }, 503);
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const stJobId = (c.req.query("st_job_id") || "").trim();
    if (!stJobId) return c.json({ error: "st_job_id required" }, 400);
    const seen = await canSeeJob(c, user, stJobId);
    if (seen !== true) return seen;
    const rows = isOffice(user)
      ? await c.env.DB.prepare(`SELECT * FROM tech_job_wrapups WHERE st_job_id = ? ORDER BY created_at DESC`).bind(stJobId).all<WrapRow>()
      : await c.env.DB.prepare(`SELECT * FROM tech_job_wrapups WHERE st_job_id = ? AND user_id = ? ORDER BY created_at DESC`)
          .bind(stJobId, user.id)
          .all<WrapRow>();
    return c.json({ wrapups: (rows.results || []).map(publicWrap) });
  });

  api.post("/tech/wrapups", async (c) => {
    if (!(await tableExists(c.env.DB, "tech_job_wrapups"))) return c.json({ error: NOT_READY }, 503);
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const body = await c.req.json<{ st_job_id?: string; raw_text?: string; input?: string }>();
    const stJobId = String(body.st_job_id || "").trim();
    const seen = await canSeeJob(c, user, stJobId);
    if (seen !== true) return seen;
    const raw = clip(body.raw_text, 4000);
    if (raw.length < 3) return c.json({ error: "Type a note first" }, 400);
    const input = body.input === "spoken" ? "spoken" : "typed";
    const smart = await splitWrapupSmart(raw, (system, text) => runTechAi(c.env, c.env.DB, system, text));
    const now = new Date().toISOString();
    const ins = await c.env.DB.prepare(
      `INSERT INTO tech_job_wrapups (
         st_job_id, user_id, raw_text, found_text, did_text, recommend_text, parts_text, split_by, input, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        stJobId,
        user.id,
        raw,
        pack(smart.result.found),
        pack(smart.result.did),
        pack(smart.result.recommend),
        pack(smart.result.parts),
        smart.split_by,
        input,
        now,
        now
      )
      .run();
    const row = await c.env.DB.prepare(`SELECT * FROM tech_job_wrapups WHERE id = ?`).bind(ins.meta.last_row_id).first<WrapRow>();
    return c.json({ wrapup: row ? publicWrap(row) : null, split_by: smart.split_by }, 201);
  });

  api.patch("/tech/wrapups/:id", async (c) => {
    if (!(await tableExists(c.env.DB, "tech_job_wrapups"))) return c.json({ error: NOT_READY }, 503);
    const blocked = deny(c, SEE);
    if (blocked) return blocked;
    const user = c.get("user");
    const id = Number(c.req.param("id"));
    const row = await c.env.DB.prepare(`SELECT * FROM tech_job_wrapups WHERE id = ?`).bind(id).first<WrapRow>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (!isOffice(user) && row.user_id !== user.id) return c.json({ error: "Not allowed" }, 403);
    const body = await c.req.json<{
      found?: string[];
      did?: string[];
      recommend?: string[];
      parts?: string[];
      copied?: boolean;
    }>();
    const now = new Date().toISOString();
    const found = body.found ? pack(body.found) : row.found_text;
    const did = body.did ? pack(body.did) : row.did_text;
    const recommend = body.recommend ? pack(body.recommend) : row.recommend_text;
    const parts = body.parts ? pack(body.parts) : row.parts_text;
    const copied = body.copied ? now : row.copied_at;
    await c.env.DB.prepare(
      `UPDATE tech_job_wrapups
       SET found_text = ?, did_text = ?, recommend_text = ?, parts_text = ?, copied_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(found, did, recommend, parts, copied, now, id)
      .run();
    const next = await c.env.DB.prepare(`SELECT * FROM tech_job_wrapups WHERE id = ?`).bind(id).first<WrapRow>();
    return c.json({ wrapup: next ? publicWrap(next) : null });
  });
}
