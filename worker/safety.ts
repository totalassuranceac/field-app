/**
 * Private Safety training API — topics, video, stamped completions.
 * No rankings / scores / public lists.
 */

import type { Hono } from "hono";
import type { Env, PublicUser, Variables } from "./types";
import { writeAudit } from "./audit";
import { ROLE_PERMS, roleAtLeast } from "./auth";
import { ensureSafetyLibrary } from "./safetyContent";
import {
  TRACK_LABEL,
  forNewHireFlag,
  levelFor,
  parseAudiences,
  safetyDue,
  safetyTrack,
  type SafetyTrack,
} from "../src/safetyAssign";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function isSafetyAdmin(user: PublicUser): boolean {
  return user.role === "admin";
}

async function safetyProfile(
  db: D1Database,
  user: PublicUser
): Promise<{ track: SafetyTrack; track_label: string; position_title: string | null }> {
  let position: string | null = null;
  let warehouse = user.role === "warehouse" || user.is_warehouse === true;
  try {
    const row = await db
      .prepare(
        `SELECT position_title, COALESCE(is_warehouse, 0) AS is_warehouse
         FROM users WHERE id = ?`
      )
      .bind(user.id)
      .first<{ position_title?: string | null; is_warehouse?: number }>();
    if (row) {
      const title = String(row.position_title || "").trim();
      position = title || null;
      if (Number(row.is_warehouse) === 1) warehouse = true;
    }
  } catch {
    /* Older databases have no position_title yet. Role still picks the job. */
  }
  const track = safetyTrack({
    role: user.role,
    is_warehouse: warehouse,
    position_title: position,
  });
  return { track, track_label: TRACK_LABEL[track], position_title: position };
}

async function saveSafetyVideo(
  env: Env,
  file: File
): Promise<{ key: string }> {
  const maxBytes = env.RECEIPTS ? 100 * 1024 * 1024 : 900 * 1024;
  if (file.size > maxBytes) {
    throw new Error(
      env.RECEIPTS
        ? "Video too large (max 100MB on R2)"
        : "Video too large for D1 blob storage — paste a video URL instead, or enable R2."
    );
  }
  const buf = await file.arrayBuffer();
  const ext =
    (file.name || "").split(".").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") ||
    "mp4";
  const key = `safety-videos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const contentType = file.type || "video/mp4";
  if (env.RECEIPTS) {
    await env.RECEIPTS.put(key, buf, { httpMetadata: { contentType } });
  } else {
    // Tiny files only without R2 — prefer a video URL for real training clips
    await env.DB.prepare(
      `INSERT INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
    )
      .bind(key, contentType, new Uint8Array(buf), buf.byteLength)
      .run();
  }
  return { key };
}

export function registerSafetyRoutes(api: App): void {
  // ——— Topics ———
  api.get("/safety/topics", async (c) => {
    const user = c.get("user") as PublicUser;
    const admin = isSafetyAdmin(user);
    try {
      await ensureSafetyLibrary(c.env.DB);
      const rows = await c.env.DB.prepare(
        admin
          ? `SELECT t.*,
               (SELECT COUNT(*) FROM safety_completions c WHERE c.topic_id = t.id) as completion_count,
               (SELECT COUNT(*) FROM safety_completions c
                WHERE c.topic_id = t.id AND c.user_id = ?) as my_completion_count,
               (SELECT c.completed_at FROM safety_completions c
                WHERE c.topic_id = t.id AND c.user_id = ?
                ORDER BY c.completed_at DESC, c.id DESC LIMIT 1) as my_completed_at
             FROM safety_topics t
             ORDER BY t.active DESC, t.sort_order ASC, t.id ASC`
          : `SELECT t.*,
               (SELECT COUNT(*) FROM safety_completions c
                WHERE c.topic_id = t.id AND c.user_id = ?) as my_completion_count,
               (SELECT c.completed_at FROM safety_completions c
                WHERE c.topic_id = t.id AND c.user_id = ?
                ORDER BY c.completed_at DESC, c.id DESC LIMIT 1) as my_completed_at
             FROM safety_topics t
             WHERE t.active = 1
             ORDER BY t.sort_order ASC, t.id ASC`
      )
        .bind(user.id, user.id)
        .all();
      const profile = await safetyProfile(c.env.DB, user);
      return c.json({
        topics: rows.results || [],
        is_admin: admin,
        my_track: profile.track,
        my_track_label: profile.track_label,
        position_title: profile.position_title,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({
          topics: [],
          is_admin: admin,
          error: "Run migration 081_safety.sql on D1",
        });
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.get("/safety/topics/:id", async (c) => {
    const user = c.get("user") as PublicUser;
    const id = Number(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid id" }, 400);
    try {
      await ensureSafetyLibrary(c.env.DB);
      const topic = await c.env.DB.prepare(
        `SELECT * FROM safety_topics WHERE id = ?`
      )
        .bind(id)
        .first();
      if (!topic) return c.json({ error: "Not found" }, 404);
      if (!isSafetyAdmin(user) && !Number((topic as { active?: number }).active)) {
        return c.json({ error: "Not found" }, 404);
      }
      const mine = await c.env.DB.prepare(
        `SELECT c.*, u.display_name as user_name, s.display_name as stamped_by_name
         FROM safety_completions c
         LEFT JOIN users u ON u.id = c.user_id
         LEFT JOIN users s ON s.id = c.stamped_by_user_id
         WHERE c.topic_id = ? AND c.user_id = ?
         ORDER BY c.completed_at DESC`
      )
        .bind(id, user.id)
        .all();
      return c.json({
        topic,
        my_completions: mine.results || [],
        is_admin: isSafetyAdmin(user),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 081_safety.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/safety/topics", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!isSafetyAdmin(user)) return c.json({ error: "Admin only" }, 403);
    try {
      await ensureSafetyLibrary(c.env.DB);
      const ct = c.req.header("content-type") || "";
      let title = "Untitled safety topic";
      let body = "";
      let videoUrl: string | null = null;
      let videoKey: string | null = null;
      let sortOrder = 0;
      let active = 1;
      let category: string | null = null;
      let forNewHire = 0;
      let audiences: string | null = null;

      if (ct.includes("multipart/form-data")) {
        const form = await c.req.formData();
        title = String(form.get("title") || title).trim() || title;
        body = String(form.get("body") || "").trim();
        videoUrl = String(form.get("video_url") || "").trim() || null;
        sortOrder = Number(form.get("sort_order") || 0) || 0;
        active = form.get("active") === "0" || form.get("active") === "false" ? 0 : 1;
        category = String(form.get("category") || "").trim() || null;
        forNewHire = form.get("for_new_hire") === "1" || form.get("for_new_hire") === "true" ? 1 : 0;
        if (form.has("audiences")) {
          audiences = String(form.get("audiences") || "").trim() || "{}";
          forNewHire = forNewHireFlag(parseAudiences(audiences));
        }
        const file = form.get("video_file") || form.get("file");
        if (file instanceof File && file.size > 0) {
          const saved = await saveSafetyVideo(c.env, file);
          videoKey = saved.key;
        }
      } else {
        const j = (await c.req.json()) as {
          title?: string;
          body?: string;
          video_url?: string | null;
          sort_order?: number;
          active?: boolean | number;
          category?: string | null;
          for_new_hire?: boolean | number;
          audiences?: string | null;
        };
        title = String(j.title || title).trim() || title;
        body = String(j.body || "").trim();
        videoUrl = j.video_url != null ? String(j.video_url).trim() || null : null;
        sortOrder = Number(j.sort_order || 0) || 0;
        active = j.active === false || j.active === 0 ? 0 : 1;
        category = j.category != null ? String(j.category).trim() || null : null;
        forNewHire = j.for_new_hire === true || j.for_new_hire === 1 ? 1 : 0;
        if (j.audiences !== undefined) {
          audiences = j.audiences != null ? String(j.audiences).trim() || "{}" : "{}";
          forNewHire = forNewHireFlag(parseAudiences(audiences));
        }
      }

      const r = await c.env.DB.prepare(
        `INSERT INTO safety_topics (
           title, body, video_url, video_file_key, sort_order, active,
           created_by_user_id, created_at, updated_at, category, for_new_hire, audiences
         ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?, ?, ?)`
      )
        .bind(title, body || null, videoUrl, videoKey, sortOrder, active, user.id, category, forNewHire, audiences)
        .run();
      const id = Number(r.meta.last_row_id);
      await writeAudit(c.env.DB, user, "create", "safety_topic", id, `Safety topic: ${title}`);
      const topic = await c.env.DB.prepare(`SELECT * FROM safety_topics WHERE id = ?`)
        .bind(id)
        .first();
      return c.json({ ok: true, topic }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 081_safety.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.patch("/safety/topics/:id", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!isSafetyAdmin(user)) return c.json({ error: "Admin only" }, 403);
    const id = Number(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid id" }, 400);
    try {
      await ensureSafetyLibrary(c.env.DB);
      const before = await c.env.DB.prepare(`SELECT * FROM safety_topics WHERE id = ?`)
        .bind(id)
        .first();
      if (!before) return c.json({ error: "Not found" }, 404);

      const ct = c.req.header("content-type") || "";
      const sets: string[] = ["updated_at = datetime('now')"];
      const vals: unknown[] = [];

      if (ct.includes("multipart/form-data")) {
        const form = await c.req.formData();
        if (form.has("title")) {
          sets.push("title = ?");
          vals.push(String(form.get("title") || "").trim() || "Untitled safety topic");
        }
        if (form.has("body")) {
          sets.push("body = ?");
          vals.push(String(form.get("body") || "").trim() || null);
        }
        if (form.has("video_url")) {
          sets.push("video_url = ?");
          vals.push(String(form.get("video_url") || "").trim() || null);
        }
        if (form.has("sort_order")) {
          sets.push("sort_order = ?");
          vals.push(Number(form.get("sort_order") || 0) || 0);
        }
        if (form.has("active")) {
          sets.push("active = ?");
          vals.push(form.get("active") === "0" || form.get("active") === "false" ? 0 : 1);
        }
        if (form.has("category")) {
          sets.push("category = ?");
          vals.push(String(form.get("category") || "").trim() || null);
        }
        if (form.has("for_new_hire")) {
          sets.push("for_new_hire = ?");
          vals.push(form.get("for_new_hire") === "1" || form.get("for_new_hire") === "true" ? 1 : 0);
        }
        if (form.has("audiences")) {
          const audiences = String(form.get("audiences") || "").trim() || "{}";
          sets.push("audiences = ?");
          vals.push(audiences);
          sets.push("for_new_hire = ?");
          vals.push(forNewHireFlag(parseAudiences(audiences)));
        }
        const file = form.get("video_file") || form.get("file");
        if (file instanceof File && file.size > 0) {
          const saved = await saveSafetyVideo(c.env, file);
          sets.push("video_file_key = ?");
          vals.push(saved.key);
        }
      } else {
        const j = (await c.req.json()) as {
          title?: string;
          body?: string | null;
          video_url?: string | null;
          sort_order?: number;
          active?: boolean | number;
          archive?: boolean;
          category?: string | null;
          for_new_hire?: boolean | number;
          audiences?: string | null;
        };
        if (j.title !== undefined) {
          sets.push("title = ?");
          vals.push(String(j.title || "").trim() || "Untitled safety topic");
        }
        if (j.body !== undefined) {
          sets.push("body = ?");
          vals.push(j.body != null ? String(j.body).trim() || null : null);
        }
        if (j.video_url !== undefined) {
          sets.push("video_url = ?");
          vals.push(j.video_url != null ? String(j.video_url).trim() || null : null);
        }
        if (j.sort_order !== undefined) {
          sets.push("sort_order = ?");
          vals.push(Number(j.sort_order) || 0);
        }
        if (j.archive === true) {
          sets.push("active = 0");
        } else if (j.active !== undefined) {
          sets.push("active = ?");
          vals.push(j.active === false || j.active === 0 ? 0 : 1);
        }
        if (j.category !== undefined) {
          sets.push("category = ?");
          vals.push(j.category != null ? String(j.category).trim() || null : null);
        }
        if (j.for_new_hire !== undefined) {
          sets.push("for_new_hire = ?");
          vals.push(j.for_new_hire === true || j.for_new_hire === 1 ? 1 : 0);
        }
        if (j.audiences !== undefined) {
          const audiences = j.audiences != null ? String(j.audiences).trim() || "{}" : "{}";
          sets.push("audiences = ?");
          vals.push(audiences);
          sets.push("for_new_hire = ?");
          vals.push(forNewHireFlag(parseAudiences(audiences)));
        }
      }

      if (sets.length <= 1) return c.json({ error: "Nothing to update" }, 400);
      vals.push(id);
      await c.env.DB.prepare(`UPDATE safety_topics SET ${sets.join(", ")} WHERE id = ?`)
        .bind(...vals)
        .run();
      await writeAudit(c.env.DB, user, "update", "safety_topic", id, `Safety topic #${id}`);
      const topic = await c.env.DB.prepare(`SELECT * FROM safety_topics WHERE id = ?`)
        .bind(id)
        .first();
      return c.json({ ok: true, topic });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 081_safety.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  // ——— Completions (append-only stamps) ———
  api.get("/safety/completions", async (c) => {
    const user = c.get("user") as PublicUser;
    const admin = isSafetyAdmin(user);
    const topicId = Number(c.req.query("topic_id") || "") || null;
    const personId = Number(c.req.query("user_id") || "") || null;
    const from = (c.req.query("from") || "").trim() || null;
    const to = (c.req.query("to") || "").trim() || null;
    try {
      let sql = `SELECT c.*, t.title as topic_title,
          u.display_name as user_name,
          s.display_name as stamped_by_name
         FROM safety_completions c
         JOIN safety_topics t ON t.id = c.topic_id
         JOIN users u ON u.id = c.user_id
         LEFT JOIN users s ON s.id = c.stamped_by_user_id
         WHERE 1=1`;
      const binds: unknown[] = [];
      if (!admin) {
        sql += ` AND c.user_id = ?`;
        binds.push(user.id);
      } else if (personId) {
        sql += ` AND c.user_id = ?`;
        binds.push(personId);
      }
      if (topicId) {
        sql += ` AND c.topic_id = ?`;
        binds.push(topicId);
      }
      if (from) {
        sql += ` AND date(c.completed_at) >= date(?)`;
        binds.push(from);
      }
      if (to) {
        sql += ` AND date(c.completed_at) <= date(?)`;
        binds.push(to);
      }
      sql += ` ORDER BY c.completed_at DESC LIMIT 500`;
      const rows = await c.env.DB.prepare(sql).bind(...binds).all();
      return c.json({
        completions: rows.results || [],
        is_admin: admin,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({
          completions: [],
          is_admin: admin,
          error: "Run migration 081_safety.sql on D1",
        });
      }
      return c.json({ error: msg }, 500);
    }
  });

  api.post("/safety/completions", async (c) => {
    const user = c.get("user") as PublicUser;
    try {
      await ensureSafetyLibrary(c.env.DB);
      const body = (await c.req.json()) as {
        topic_id?: number;
        video_opened?: boolean;
        read_confirmed?: boolean;
        retake?: boolean;
        for_user_id?: number;
      };
      const topicId = Number(body.topic_id || 0);
      if (!topicId) return c.json({ error: "topic_id required" }, 400);

      const topic = (await c.env.DB.prepare(`SELECT * FROM safety_topics WHERE id = ?`)
        .bind(topicId)
        .first()) as {
        id: number;
        title: string;
        body?: string | null;
        active: number;
        video_url?: string | null;
        video_file_key?: string | null;
      } | null;
      if (!topic) return c.json({ error: "Topic not found" }, 404);
      if (!topic.active && !isSafetyAdmin(user)) {
        return c.json({ error: "Topic is archived" }, 400);
      }

      let targetUserId = user.id;
      let isRetake = false;
      if (body.retake || body.for_user_id) {
        if (!isSafetyAdmin(user)) {
          return c.json({ error: "Only admin can record a retake for someone" }, 403);
        }
        if (body.for_user_id) targetUserId = Number(body.for_user_id);
        isRetake = true;
      }

      const hasVideo = Boolean(
        String(topic.video_url || "").trim() || String(topic.video_file_key || "").trim()
      );
      let attestation = "Read it and will follow it on the job.";
      if (!isRetake) {
        if (hasVideo && !body.video_opened) {
          return c.json(
            { error: "Open or play the video before marking complete." },
            400
          );
        }
        if (!hasVideo && !body.read_confirmed) {
          return c.json(
            { error: "Confirm you read this and will follow it on the job." },
            400
          );
        }
        if (hasVideo) attestation = "Opened the training video.";
      } else {
        attestation = "Admin retake.";
      }

      let refresher = false;
      if (!isRetake) {
        const existing = await c.env.DB.prepare(
          `SELECT id, completed_at FROM safety_completions
           WHERE topic_id = ? AND user_id = ?
           ORDER BY completed_at DESC, id DESC LIMIT 1`
        )
          .bind(topicId, targetUserId)
          .first<{ id: number; completed_at: string }>();
        if (existing) {
          const due = safetyDue(existing.completed_at);
          if (due.status !== "due_soon" && due.status !== "overdue") {
            return c.json(
              {
                error: "already_completed",
                message: due.due_on
                  ? `Already current. Refresh opens before ${due.due_on}.`
                  : "Already stamped for this topic. Admin can record a retake (adds a new history row).",
              },
              409
            );
          }
          refresher = true;
          attestation = hasVideo
            ? "Refresher. Opened the training video."
            : "Refresher. Read it and will follow it on the job.";
        }
      }

      const shownText = [topic.title, topic.body || ""]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 8000);
      const r = await c.env.DB.prepare(
        `INSERT INTO safety_completions (
           topic_id, user_id, completed_at, stamped_by_user_id, is_retake, notes, shown_text
         ) VALUES (?, ?, datetime('now'), ?, ?, ?, ?)`
      )
        .bind(topicId, targetUserId, user.id, isRetake || refresher ? 1 : 0, attestation, shownText || null)
        .run();
      const id = Number(r.meta.last_row_id);
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "safety_completion",
        id,
        `Safety complete · topic #${topicId} · user #${targetUserId}${isRetake ? " (retake)" : ""}`
      );
      const row = await c.env.DB.prepare(
        `SELECT c.*, t.title as topic_title, u.display_name as user_name
         FROM safety_completions c
         JOIN safety_topics t ON t.id = c.topic_id
         JOIN users u ON u.id = c.user_id
         WHERE c.id = ?`
      )
        .bind(id)
        .first();
      return c.json({ ok: true, completion: row }, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 081_safety.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });

  // Read-only team grid. No texts, email, or pushes.
  api.get("/safety/status", async (c) => {
    const user = c.get("user") as PublicUser;
    if (!roleAtLeast(user.role, ROLE_PERMS.viewSafetyStatus)) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const topicSql = `SELECT id, title, COALESCE(for_new_hire, 0) AS for_new_hire, audiences
      FROM safety_topics WHERE active = 1 ORDER BY sort_order ASC, id ASC`;
    const stampSql = `SELECT user_id, topic_id, completed_at, is_retake
      FROM (
        SELECT c.user_id AS user_id,
               c.topic_id AS topic_id,
               c.completed_at AS completed_at,
               c.is_retake AS is_retake,
               ROW_NUMBER() OVER (
                 PARTITION BY c.user_id, c.topic_id
                 ORDER BY c.completed_at DESC, c.id DESC
               ) AS rn
        FROM safety_completions c
        INNER JOIN safety_topics t ON t.id = c.topic_id AND t.active = 1
      ) AS ranked
      WHERE rn = 1`;
    const userSqlWithTitle = `SELECT id, display_name,
        CASE WHEN COALESCE(is_warehouse, 0) = 1 THEN 'warehouse' ELSE role END AS role,
        position_title
      FROM users
      WHERE active = 1
      ORDER BY display_name COLLATE NOCASE, id`;
    const userSqlPlain = `SELECT id, display_name,
        CASE WHEN COALESCE(is_warehouse, 0) = 1 THEN 'warehouse' ELSE role END AS role
      FROM users
      WHERE active = 1
      ORDER BY display_name COLLATE NOCASE, id`;

    async function load(includeTitle: boolean) {
      const userSql = includeTitle ? userSqlWithTitle : userSqlPlain;
      const [topics, people, stamps] = await c.env.DB.batch([
        c.env.DB.prepare(topicSql),
        c.env.DB.prepare(userSql),
        c.env.DB.prepare(stampSql),
      ]);
      return {
        topics: topics.results || [],
        users: (people.results || []).map((raw) => {
          const row = raw as {
            id: number;
            display_name?: string | null;
            role?: string | null;
            position_title?: string | null;
          };
          return {
            id: Number(row.id),
            display_name: String(row.display_name || "").trim() || `User #${row.id}`,
            role: String(row.role || ""),
            position_title:
              row.position_title != null && String(row.position_title).trim()
                ? String(row.position_title).trim()
                : null,
          };
        }),
        stamps: stamps.results || [],
      };
    }

    try {
      await ensureSafetyLibrary(c.env.DB);
      try {
        return c.json(await load(true));
      } catch (inner) {
        const innerMsg = inner instanceof Error ? inner.message : String(inner);
        if (!/no such column/i.test(innerMsg)) throw inner;
        return c.json(await load(false));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({
          topics: [],
          users: [],
          stamps: [],
          error: "Run migration 081_safety.sql on D1",
        });
      }
      return c.json({ error: msg }, 500);
    }
  });

  /** Essentials for this person's job, then a refresher when a stamp is inside 30 days of its year. */
  api.get("/safety/new-hire", async (c) => {
    const user = c.get("user") as PublicUser;
    const empty = {
      mode: "clear" as const,
      done: 0,
      total: 0,
      next_id: null,
      next_title: null,
      track: null,
      track_label: null,
      due_on: null,
      last_taken: null,
    };
    try {
      await ensureSafetyLibrary(c.env.DB);
      const profile = await safetyProfile(c.env.DB, user);
      const rows = await c.env.DB.prepare(
        `SELECT t.id, t.title, t.sort_order, t.audiences,
            (SELECT c.completed_at FROM safety_completions c
             WHERE c.topic_id = t.id AND c.user_id = ?
             ORDER BY c.completed_at DESC, c.id DESC LIMIT 1) AS last_taken
         FROM safety_topics t
         WHERE t.active = 1
         ORDER BY t.sort_order ASC, t.id ASC`
      )
        .bind(user.id)
        .all<{
          id: number;
          title: string;
          sort_order: number;
          audiences: string | null;
          last_taken: string | null;
        }>();
      const assigned = (rows.results || [])
        .map((topic) => ({
          ...topic,
          level: levelFor(parseAudiences(topic.audiences), profile.track),
          due: safetyDue(topic.last_taken),
        }))
        .filter((topic) => topic.level);
      const essentials = assigned.filter((topic) => topic.level === "essential");
      const open = essentials.filter(
        (topic) => topic.due.status === "none" || topic.due.status === "overdue"
      );
      if (open.length) {
        const covered = essentials.length - open.length;
        return c.json({
          mode: "essentials",
          done: covered,
          total: essentials.length,
          next_id: Number(open[0].id),
          next_title: String(open[0].title || ""),
          track: profile.track,
          track_label: profile.track_label,
          due_on: open[0].due.due_on,
          last_taken: open[0].due.last_taken,
        });
      }
      const refresh = assigned
        .filter((topic) => topic.due.status === "due_soon" || topic.due.status === "overdue")
        .sort((a, b) => String(a.due.due_on || "").localeCompare(String(b.due.due_on || "")));
      if (refresh.length) {
        return c.json({
          mode: "refresh",
          done: essentials.length,
          total: essentials.length,
          next_id: Number(refresh[0].id),
          next_title: String(refresh[0].title || ""),
          track: profile.track,
          track_label: profile.track_label,
          due_on: refresh[0].due.due_on,
          last_taken: refresh[0].due.last_taken,
        });
      }
      return c.json({
        ...empty,
        mode: "clear",
        done: essentials.length,
        total: essentials.length,
        track: profile.track,
        track_label: profile.track_label,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg) || /no such column/i.test(msg)) {
        return c.json(empty);
      }
      return c.json({ error: msg }, 500);
    }
  });

  /** Printable training file for one employee. Self, or office / supervisor / admin. */
  api.get("/safety/file", async (c) => {
    const user = c.get("user") as PublicUser;
    const requestedUser = Number(c.req.query("user_id") || "") || null;
    const requestedEmployee = Number(c.req.query("employee_id") || "") || null;
    const canSeeOthers = roleAtLeast(user.role, ROLE_PERMS.viewSafetyStatus);
    try {
      await ensureSafetyLibrary(c.env.DB);
      let targetId = user.id;
      if (requestedUser && requestedUser !== user.id) {
        if (!canSeeOthers) return c.json({ error: "Forbidden" }, 403);
        targetId = requestedUser;
      } else if (requestedEmployee && requestedEmployee !== user.employee_id) {
        if (!canSeeOthers) return c.json({ error: "Forbidden" }, 403);
        const linked = await c.env.DB.prepare(
          `SELECT id FROM users WHERE employee_id = ? ORDER BY active DESC, id LIMIT 1`
        )
          .bind(requestedEmployee)
          .first<{ id: number }>();
        if (!linked) {
          let emp: {
            id: number;
            name?: string | null;
            hire_date?: string | null;
            position_title?: string | null;
          } | null = null;
          try {
            emp = await c.env.DB.prepare(
              `SELECT id, name, hire_date, position_title FROM employees WHERE id = ?`
            )
              .bind(requestedEmployee)
              .first();
          } catch {
            emp = await c.env.DB.prepare(`SELECT id, name FROM employees WHERE id = ?`)
              .bind(requestedEmployee)
              .first();
          }
          return c.json({
            person: emp
              ? {
                  user_id: null,
                  employee_id: Number(emp.id),
                  name: String(emp.name || "Employee"),
                  role: null,
                  position_title: emp.position_title || null,
                  hire_date: emp.hire_date || null,
                  track: null,
                  track_label: null,
                }
              : null,
            courses: [],
            history: [],
            note: "No Field App login is linked, so there are no stamps yet.",
          });
        }
        targetId = Number(linked.id);
      }

      type PersonRow = {
        user_id: number;
        display_name?: string | null;
        public_role?: string | null;
        is_warehouse?: number | null;
        user_title?: string | null;
        employee_id?: number | null;
        employee_name?: string | null;
        hire_date?: string | null;
        employee_title?: string | null;
      };
      let person: PersonRow | null = null;
      try {
        person = await c.env.DB.prepare(
          `SELECT u.id AS user_id, u.display_name,
              CASE WHEN COALESCE(u.is_warehouse, 0) = 1 THEN 'warehouse' ELSE u.role END AS public_role,
              COALESCE(u.is_warehouse, 0) AS is_warehouse,
              u.position_title AS user_title,
              u.employee_id,
              e.name AS employee_name,
              e.hire_date,
              e.position_title AS employee_title
           FROM users u
           LEFT JOIN employees e ON e.id = u.employee_id
           WHERE u.id = ?`
        )
          .bind(targetId)
          .first<PersonRow>();
      } catch {
        person = await c.env.DB.prepare(
          `SELECT u.id AS user_id, u.display_name, u.role AS public_role, u.employee_id
           FROM users u WHERE u.id = ?`
        )
          .bind(targetId)
          .first<PersonRow>();
      }
      if (!person) return c.json({ error: "Person not found" }, 404);

      const position =
        String(person.user_title || person.employee_title || "").trim() || null;
      const track = safetyTrack({
        role: person.public_role,
        is_warehouse: person.is_warehouse,
        position_title: position,
      });
      const topics = await c.env.DB.prepare(
        `SELECT id, title, category, sort_order, audiences
         FROM safety_topics WHERE active = 1
         ORDER BY sort_order ASC, id ASC`
      ).all<{
        id: number;
        title: string;
        category: string | null;
        sort_order: number;
        audiences: string | null;
      }>();
      const stamps = await c.env.DB.prepare(
        `SELECT c.id, c.topic_id, c.completed_at, c.is_retake, c.notes, t.title AS topic_title
         FROM safety_completions c
         JOIN safety_topics t ON t.id = c.topic_id
         WHERE c.user_id = ?
         ORDER BY c.completed_at DESC, c.id DESC
         LIMIT 300`
      )
        .bind(targetId)
        .all<{
          id: number;
          topic_id: number;
          completed_at: string;
          is_retake: number;
          notes: string | null;
          topic_title: string;
        }>();
      const latest = new Map<number, string>();
      for (const stamp of stamps.results || []) {
        if (!latest.has(Number(stamp.topic_id))) {
          latest.set(Number(stamp.topic_id), stamp.completed_at);
        }
      }
      const courses = (topics.results || [])
        .map((topic) => {
          const level = levelFor(parseAudiences(topic.audiences), track);
          if (!level) return null;
          const due = safetyDue(latest.get(Number(topic.id)) || null);
          return {
            id: Number(topic.id),
            title: topic.title,
            category: topic.category,
            sort_order: Number(topic.sort_order) || 0,
            level,
            last_taken: due.last_taken,
            due_on: due.due_on,
            refresh_on: due.refresh_on,
            status: due.status,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row != null)
        .sort((a, b) => {
          if (a.level !== b.level) return a.level === "essential" ? -1 : 1;
          return a.sort_order - b.sort_order || a.id - b.id;
        });

      return c.json({
        person: {
          user_id: Number(person.user_id),
          employee_id: person.employee_id != null ? Number(person.employee_id) : null,
          name: String(person.employee_name || person.display_name || "Employee"),
          role: person.public_role || null,
          position_title: position,
          hire_date: person.hire_date || null,
          track,
          track_label: TRACK_LABEL[track],
        },
        courses,
        history: (stamps.results || []).map((stamp) => ({
          id: Number(stamp.id),
          topic_id: Number(stamp.topic_id),
          topic_title: stamp.topic_title,
          completed_at: stamp.completed_at,
          is_retake: Number(stamp.is_retake) === 1,
          notes: stamp.notes || null,
        })),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({ error: "Run migration 081_safety.sql on D1" }, 500);
      }
      return c.json({ error: msg }, 500);
    }
  });
}
