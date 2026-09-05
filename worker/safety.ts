/**
 * Private Safety training API — topics, video, stamped completions.
 * No rankings / scores / public lists.
 */

import type { Hono } from "hono";
import type { Env, PublicUser, Variables } from "./types";
import { writeAudit } from "./audit";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

function isSafetyAdmin(user: PublicUser): boolean {
  return user.role === "admin";
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
      const rows = await c.env.DB.prepare(
        admin
          ? `SELECT t.*,
               (SELECT COUNT(*) FROM safety_completions c WHERE c.topic_id = t.id) as completion_count,
               (SELECT COUNT(*) FROM safety_completions c
                WHERE c.topic_id = t.id AND c.user_id = ?) as my_completion_count
             FROM safety_topics t
             ORDER BY t.active DESC, t.sort_order ASC, t.id ASC`
          : `SELECT t.*,
               (SELECT COUNT(*) FROM safety_completions c
                WHERE c.topic_id = t.id AND c.user_id = ?) as my_completion_count
             FROM safety_topics t
             WHERE t.active = 1
             ORDER BY t.sort_order ASC, t.id ASC`
      )
        .bind(user.id)
        .all();
      return c.json({
        topics: rows.results || [],
        is_admin: admin,
        note: "Safety is not live until Chris deploys.",
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no such table/i.test(msg)) {
        return c.json({
          topics: [],
          is_admin: admin,
          error: "Run migration 081_safety.sql on D1",
          note: "Safety is not live until Chris deploys.",
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
        note: "Safety is not live until Chris deploys.",
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
      const ct = c.req.header("content-type") || "";
      let title = "Untitled safety topic";
      let body = "";
      let videoUrl: string | null = null;
      let videoKey: string | null = null;
      let sortOrder = 0;
      let active = 1;

      if (ct.includes("multipart/form-data")) {
        const form = await c.req.formData();
        title = String(form.get("title") || title).trim() || title;
        body = String(form.get("body") || "").trim();
        videoUrl = String(form.get("video_url") || "").trim() || null;
        sortOrder = Number(form.get("sort_order") || 0) || 0;
        active = form.get("active") === "0" || form.get("active") === "false" ? 0 : 1;
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
        };
        title = String(j.title || title).trim() || title;
        body = String(j.body || "").trim();
        videoUrl = j.video_url != null ? String(j.video_url).trim() || null : null;
        sortOrder = Number(j.sort_order || 0) || 0;
        active = j.active === false || j.active === 0 ? 0 : 1;
      }

      const r = await c.env.DB.prepare(
        `INSERT INTO safety_topics (
           title, body, video_url, video_file_key, sort_order, active,
           created_by_user_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
      )
        .bind(title, body || null, videoUrl, videoKey, sortOrder, active, user.id)
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
        note: "Safety is not live until Chris deploys.",
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
      const body = (await c.req.json()) as {
        topic_id?: number;
        video_opened?: boolean;
        retake?: boolean;
        for_user_id?: number;
      };
      const topicId = Number(body.topic_id || 0);
      if (!topicId) return c.json({ error: "topic_id required" }, 400);
      if (!body.video_opened) {
        return c.json(
          { error: "Open or play the video before marking complete." },
          400
        );
      }

      const topic = (await c.env.DB.prepare(`SELECT * FROM safety_topics WHERE id = ?`)
        .bind(topicId)
        .first()) as { id: number; title: string; active: number } | null;
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

      if (!isRetake) {
        const existing = await c.env.DB.prepare(
          `SELECT id FROM safety_completions WHERE topic_id = ? AND user_id = ? LIMIT 1`
        )
          .bind(topicId, targetUserId)
          .first();
        if (existing) {
          return c.json(
            {
              error: "already_completed",
              message:
                "Already stamped for this topic. Admin can record a retake (adds a new history row).",
            },
            409
          );
        }
      }

      const r = await c.env.DB.prepare(
        `INSERT INTO safety_completions (
           topic_id, user_id, completed_at, stamped_by_user_id, is_retake
         ) VALUES (?, ?, datetime('now'), ?, ?)`
      )
        .bind(topicId, targetUserId, user.id, isRetake ? 1 : 0)
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
}
