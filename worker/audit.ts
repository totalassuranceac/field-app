import type { Env, PublicUser } from "./types";

export async function writeAudit(
  db: D1Database,
  user: PublicUser | null,
  action: string,
  entityType: string,
  entityId: string | number | null,
  summary: string,
  before?: unknown,
  after?: unknown
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (user_id, user_display, action, entity_type, entity_id, summary, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      user?.id ?? null,
      user?.display_name ?? "system",
      action,
      entityType,
      entityId != null ? String(entityId) : null,
      summary,
      before != null ? JSON.stringify(before) : null,
      after != null ? JSON.stringify(after) : null
    )
    .run();
}

export async function getSetting(db: D1Database, key: string, fallback: string): Promise<string> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? fallback;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .bind(key, value)
    .run();
}

export type _Env = Env;
