/**
 * Done today: read what the app already recorded. Extras need migration 112.
 * No SMS. No AI binding.
 */
import { getSetting, setSetting, writeAudit } from "./audit";
import { chicagoYmd } from "./clockinNudgePlan";
import { splitChecklist } from "./doneTodayAi";
import { dayBoundsUtc, inChicagoDay, mergeItems, splitExtras, type DoneItem } from "./doneTodayPlan";
import { fleetPeople } from "./fleetShop";
import { plainAuditSummary } from "./utf8Mojibake";
import { ROLE_PERMS, roleAtLeast } from "./auth";
import type { PublicUser } from "./types";

const NOT_READY = "Run migration 112_done_today.sql (after Chris says Y).";
let readyCache = false;

export async function doneTodayReady(db: D1Database): Promise<boolean> {
  if (readyCache) return true;
  try {
    const row = await db
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'done_today_extras'`)
      .first<{ ok: number }>();
    if (row?.ok) readyCache = true;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

type Ctx = {
  env: { DB: D1Database; AI?: { run: (model: string, input: { prompt: string }) => Promise<unknown> } };
  get: (key: "user") => PublicUser;
  req: {
    param: (name: string) => string;
    query: (name: string) => string | undefined;
    json: <T>() => Promise<T>;
  };
  json: (body: unknown, status?: number) => Response;
};

async function q(db: D1Database, sql: string, binds: unknown[]): Promise<Record<string, unknown>[]> {
  const rows = await db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
  return rows.results || [];
}

function item(partial: DoneItem): DoneItem {
  return partial;
}

async function collect(db: D1Database, userId: number, day: string): Promise<{ items: DoneItem[]; skipped: string[] }> {
  const [start, end] = dayBoundsUtc(day);
  const skipped: string[] = [];
  const items: DoneItem[] = [];
  const run = async (key: string, sql: string, toItem: (row: Record<string, unknown>) => DoneItem | null) => {
    try {
      const rows = await q(db, sql, [start, end, userId]);
      for (const row of rows) {
        const next = toItem(row);
        if (next && inChicagoDay(next.at, day)) items.push(next);
      }
    } catch {
      skipped.push(key);
    }
  };
  const span = `replace(substr(%TS%, 1, 19), 'T', ' ') >= ? AND replace(substr(%TS%, 1, 19), 'T', ' ') < ?`;
  const where = (ts: string) => span.replace(/%TS%/g, ts);

  await run(
    "pickup",
    `SELECT l.id, l.part_name, t.vendor_name, l.resolved_at
     FROM part_pickup_ticket_lines l
     JOIN part_pickup_tickets t ON t.id = l.ticket_id
     WHERE l.status IN ('picked','partial') AND l.voided_at IS NULL
       AND ${where("l.resolved_at")} AND l.resolved_by_user_id = ?`,
    (r) => item({
      at: String(r.resolved_at),
      text: `Picked up ${r.part_name || "part"} at ${r.vendor_name || "vendor"}`,
      kind: "pickup",
      source: "part_pickup",
      entity_type: "part_pickup",
      entity_id: r.id as number,
      link: "/part-pickup",
    })
  );
  await run(
    "vendor_run",
    `SELECT id, vendor_name, created_at FROM part_pickup_tickets
     WHERE ${where("created_at")} AND logged_by_user_id = ?`,
    (r) => item({
      at: String(r.created_at),
      text: `Logged vendor run: ${r.vendor_name || "vendor"}`,
      kind: "vendor_run",
      source: "part_pickup_ticket",
      entity_type: "part_pickup_ticket",
      entity_id: r.id as number,
      link: "/part-pickup",
    })
  );
  await run(
    "legacy_vendor",
    `SELECT id, picked_at FROM vendor_run_lines WHERE ${where("picked_at")} AND picked_by_user_id = ?`,
    (r) => item({ at: String(r.picked_at), text: "Picked up part (old vendor run)", kind: "pickup", source: "vendor_run_line", entity_type: "vendor_run_line", entity_id: r.id as number })
  );
  await run(
    "dropoff",
    `SELECT id, created_at FROM parts_dropoffs WHERE ${where("created_at")} AND dropped_by_user_id = ?`,
    (r) => item({ at: String(r.created_at), text: "Part drop-off logged", kind: "dropoff", source: "parts_dropoff", entity_type: "parts_dropoff", entity_id: r.id as number })
  );
  await run(
    "dropoff_received",
    `SELECT id, received_at FROM parts_dropoffs WHERE ${where("received_at")} AND received_by_user_id = ?`,
    (r) => item({ at: String(r.received_at), text: "Received drop-off", kind: "dropoff", source: "parts_dropoff", entity_type: "parts_dropoff", entity_id: r.id as number })
  );
  await run(
    "warranty_drop",
    `SELECT id, log_number, part_name, dropped_off_at FROM warranty_claims WHERE ${where("dropped_off_at")} AND dropped_off_by_user_id = ?`,
    (r) => item({
      at: String(r.dropped_off_at),
      text: `Warranty drop-off ${r.log_number || ""} ${r.part_name || ""}`.trim(),
      kind: "warranty",
      source: "warranty",
      entity_type: "warranty",
      entity_id: r.id as number,
      link: `/warranties?q=${encodeURIComponent(String(r.log_number || ""))}`,
    })
  );
  await run(
    "warranty_processed",
    `SELECT id, log_number, processed_at FROM warranty_claims WHERE ${where("processed_at")} AND processed_by_user_id = ?`,
    (r) => item({
      at: String(r.processed_at),
      text: `Warranty processed ${r.log_number || ""}`.trim(),
      kind: "warranty",
      source: "warranty",
      entity_type: "warranty",
      entity_id: r.id as number,
      link: `/warranties?q=${encodeURIComponent(String(r.log_number || ""))}`,
    })
  );
  await run(
    "handoff",
    `SELECT id, log_number, rep_name, recorded_at, correction_reason FROM vendor_handoffs
     WHERE ${where("recorded_at")} AND handed_by_user_id = ?`,
    (r) => item({
      at: String(r.recorded_at),
      text: `${r.correction_reason ? "Vendor hand-off corrected" : "Vendor hand-off signed"}: ${r.log_number || ""} to ${r.rep_name || ""}`.trim(),
      kind: "handoff",
      source: "vendor_handoff",
      entity_type: "vendor_handoff",
      entity_id: r.id as number,
    })
  );
  await run(
    "delivery_received",
    `SELECT id, received_at FROM part_deliveries WHERE voided_at IS NULL AND ${where("received_at")} AND received_by_user_id = ?`,
    (r) => item({ at: String(r.received_at), text: "Delivery received", kind: "delivery", source: "part_delivery", entity_type: "part_delivery", entity_id: r.id as number })
  );
  await run(
    "delivery_picked",
    `SELECT id, picked_up_at FROM part_deliveries WHERE voided_at IS NULL AND ${where("picked_up_at")} AND picked_up_by_user_id = ?`,
    (r) => item({ at: String(r.picked_up_at), text: "Delivery picked up", kind: "delivery", source: "part_delivery", entity_type: "part_delivery", entity_id: r.id as number })
  );
  await run(
    "parts_receipt",
    `SELECT id, vendor_name, total_amount, created_at FROM parts_purchase_receipts WHERE ${where("created_at")} AND purchased_by_user_id = ?`,
    (r) => item({
      at: String(r.created_at),
      text: `Parts receipt: ${r.vendor_name || "vendor"} $${Number(r.total_amount || 0).toFixed(2)}`,
      kind: "receipt",
      source: "parts_purchase",
      entity_type: "parts_purchase",
      entity_id: r.id as number,
      link: "/parts-receipts",
    })
  );
  await run(
    "dump",
    `SELECT id, ticket_number, created_at FROM dump_runs WHERE ${where("created_at")} AND logged_by_user_id = ?`,
    (r) => item({
      at: String(r.created_at),
      text: `Dump run ${r.ticket_number || ""}`.trim(),
      kind: "dump",
      source: "dump_run",
      entity_type: "dump_run",
      entity_id: r.id as number,
      link: "/dump-runs",
    })
  );
  await run(
    "fuel",
    `SELECT f.id, f.gallons, f.created_at, v.unit_number
     FROM fuel_entries f LEFT JOIN vehicles v ON v.id = f.vehicle_id
     WHERE ${where("f.created_at")} AND f.entered_by_user_id = ?`,
    (r) => item({
      at: String(r.created_at),
      text: `Fuel: Unit ${r.unit_number || "?"} ${r.gallons || "?"} gal`,
      kind: "fuel",
      source: "fuel",
      entity_type: "fuel_entry",
      entity_id: r.id as number,
      link: "/fuel",
    })
  );
  await run(
    "wo_stage",
    `SELECT e.issue_id, e.stage, e.at, i.title, v.unit_number
     FROM fleet_wo_stage_events e
     JOIN vehicle_issues i ON i.id = e.issue_id
     LEFT JOIN vehicles v ON v.id = i.vehicle_id
     WHERE e.stage IN ('started','paused','resumed','done','cancelled') AND ${where("e.at")} AND e.actor_user_id = ?`,
    (r) => item({
      at: String(r.at),
      text: r.stage === "done" ? `Finished WO #${r.issue_id}` : `${r.stage} WO #${r.issue_id}`,
      kind: r.stage === "done" ? "wo_done" : r.stage === "paused" ? "wo_pause" : r.stage === "resumed" ? "wo_resume" : "wo_start",
      source: "fleet_wo",
      issue_id: Number(r.issue_id),
      entity_type: "vehicle_issue",
      entity_id: r.issue_id as number,
      link: `/fleet-shop?wo=${r.issue_id}`,
    })
  );
  await run(
    "wrench",
    `SELECT id, issue_id, entry_type, category, started_at, ended_at
     FROM fleet_wrench_segments
     WHERE ${where("COALESCE(ended_at, started_at)")} AND user_id = ?`,
    (r) => {
      const a = Date.parse(String(r.started_at).includes("T") ? String(r.started_at) : String(r.started_at).replace(" ", "T") + "Z");
      const b = r.ended_at ? Date.parse(String(r.ended_at).includes("T") ? String(r.ended_at) : String(r.ended_at).replace(" ", "T") + "Z") : a;
      const mins = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 60000)) : 0;
      if (r.entry_type === "shop") {
        return item({
          at: String(r.ended_at || r.started_at),
          text: `Shop time: ${String(r.category || "shop").replace(/_/g, " ")}`,
          kind: "shop_time",
          source: "fleet_segment",
          wo_minutes: mins,
          entity_type: "fleet_segment",
          entity_id: r.id as number,
        });
      }
      return item({
        at: String(r.ended_at || r.started_at),
        text: `WO #${r.issue_id}`,
        kind: "wo_start",
        source: "fleet_segment",
        issue_id: Number(r.issue_id),
        wo_minutes: mins,
        entity_type: "vehicle_issue",
        entity_id: r.issue_id as number,
        link: `/fleet-shop?wo=${r.issue_id}`,
      });
    }
  );
  await run(
    "repair_done",
    `SELECT id, completed_at FROM vehicle_issues WHERE ${where("completed_at")} AND completed_by_user_id = ?`,
    (r) => item({
      at: String(r.completed_at),
      text: `Completed repair #${r.id}`,
      kind: "repair",
      source: "vehicle_issue",
      issue_id: Number(r.id),
      entity_type: "vehicle_issue",
      entity_id: r.id as number,
      link: `/fleet-shop?wo=${r.id}`,
    })
  );
  await run(
    "oil",
    `SELECT s.id, s.created_at, v.unit_number FROM service_records s
     LEFT JOIN vehicles v ON v.id = s.vehicle_id
     WHERE s.service_type = 'oil_change' AND ${where("s.created_at")} AND s.performed_by_user_id = ?`,
    (r) => item({ at: String(r.created_at), text: `Oil change Unit ${r.unit_number || ""}`.trim(), kind: "service", source: "service_record", entity_type: "service_record", entity_id: r.id as number })
  );
  await run(
    "audit",
    `SELECT id, action, entity_type, entity_id, summary, created_at FROM audit_logs
     WHERE action IN ('create','update','void')
       AND entity_type NOT IN ('user','sms','session','view_as')
       AND ${where("created_at")} AND user_id = ?`,
    (r) => {
      if (r.action === "void" && r.entity_type === "fuel_entry") return null;
      const summary = plainAuditSummary(String(r.summary || `${r.action} ${r.entity_type}`));
      return item({
        at: String(r.created_at),
        text: summary || `${r.action} ${r.entity_type}`,
        kind: "audit",
        source: "audit",
        entity_type: String(r.entity_type || ""),
        entity_id: r.entity_id as string,
      });
    }
  );

  let header: string | null = null;
  try {
    const clocks = await q(
      db,
      `SELECT clock_in_at, clock_out_at FROM fa_time_sessions
       WHERE kind = 'shop' AND user_id = ? AND ${where("clock_in_at")}`,
      [userId, start, end]
    );
    if (clocks[0]) {
      const inn = clocks[0].clock_in_at ? String(clocks[0].clock_in_at) : "";
      const out = clocks[0].clock_out_at ? String(clocks[0].clock_out_at) : "";
      header = out ? `Clocked in ${inn} - out ${out}` : `Clocked in ${inn}`;
    }
  } catch {
    skipped.push("clock");
  }
  return { items: mergeItems(items), skipped, header } as { items: DoneItem[]; skipped: string[]; header?: string | null };
}

function dayOrToday(raw: string | undefined): string | { error: string } {
  const today = chicagoYmd(Date.now());
  const day = (raw || today).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Bad day" };
  const [ys, ms, ds] = today.split("-").map(Number);
  const [y, m, d] = day.split("-").map(Number);
  const diff = Math.round((Date.UTC(ys, ms - 1, ds) - Date.UTC(y, m - 1, d)) / 86400000);
  if (diff < 0 || diff > 31) return { error: "Pick today or one of the last 31 days" };
  return day;
}

async function extrasFor(db: D1Database, userId: number, day: string) {
  if (!(await doneTodayReady(db))) return [];
  const rows = await db
    .prepare(`SELECT id, body, input, split_by, created_at FROM done_today_extras WHERE user_id = ? AND day_ct = ? AND removed_at IS NULL ORDER BY id`)
    .bind(userId, day)
    .all();
  return rows.results || [];
}

export function mountDoneToday(api: {
  get: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  post: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  put: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
  delete: (path: string, handler: (c: Ctx) => Promise<Response>) => void;
}): void {
  api.get("/done-today/config", async (c) => {
    const user = c.get("user");
    const ready = await doneTodayReady(c.env.DB);
    const people = await fleetPeople(c.env.DB).catch(() => ({ chuck_user_id: null, speedy_user_id: null }));
    const ai = await getSetting(c.env.DB, "done_today_ai", "0").catch(() => "0");
    return c.json({
      ready,
      can_view_all: roleAtLeast(user.role, ROLE_PERMS.viewDoneTodayAll),
      ai_enabled: ai === "1" && Boolean(c.env.AI),
      ai_setting: ai === "1",
      people_first: [people.chuck_user_id, people.speedy_user_id].filter((id): id is number => Boolean(id)),
    });
  });

  api.get("/done-today", async (c) => {
    const picked = dayOrToday(c.req.query("day"));
    if (typeof picked !== "string") return c.json({ error: picked.error }, 400);
    const user = c.get("user");
    const ready = await doneTodayReady(c.env.DB);
    const bag = await collect(c.env.DB, user.id, picked);
    return c.json({
      day: picked,
      ready,
      header: (bag as { header?: string | null }).header || null,
      items: bag.items,
      extras: await extrasFor(c.env.DB, user.id, picked),
      skipped: bag.skipped,
      note: "Filled in automatically from what you did in the app.",
    });
  });

  api.get("/done-today/people", async (c) => {
    const user = c.get("user");
    if (!roleAtLeast(user.role, ROLE_PERMS.viewDoneTodayAll)) return c.json({ error: "Not allowed" }, 403);
    const picked = dayOrToday(c.req.query("day"));
    if (typeof picked !== "string") return c.json({ error: picked.error }, 400);
    const people = await c.env.DB.prepare(`SELECT id, display_name, username, role FROM users WHERE active = 1 ORDER BY display_name`).all<{ id: number; display_name: string; username: string | null; role: string }>();
    const first = await fleetPeople(c.env.DB).catch(() => ({ chuck_user_id: null, speedy_user_id: null }));
    const ranked = [];
    for (const person of people.results || []) {
      const bag = await collect(c.env.DB, person.id, picked);
      if (!bag.items.length) continue;
      ranked.push({ ...person, count: bag.items.length, first_at: bag.items[0]?.time_ct || null, last_at: bag.items[bag.items.length - 1]?.time_ct || null });
    }
    ranked.sort((a, b) => {
      const rank = (id: number) => (id === first.chuck_user_id ? 0 : id === first.speedy_user_id ? 1 : 2);
      const d = rank(a.id) - rank(b.id);
      if (d) return d;
      return b.count - a.count;
    });
    return c.json({ day: picked, people: ranked });
  });

  api.get("/done-today/user/:id", async (c) => {
    const user = c.get("user");
    if (!roleAtLeast(user.role, ROLE_PERMS.viewDoneTodayAll)) return c.json({ error: "Not allowed" }, 403);
    const picked = dayOrToday(c.req.query("day"));
    if (typeof picked !== "string") return c.json({ error: picked.error }, 400);
    const id = Number(c.req.param("id"));
    const bag = await collect(c.env.DB, id, picked);
    return c.json({ day: picked, user_id: id, read_only: true, header: (bag as { header?: string | null }).header || null, items: bag.items, extras: await extrasFor(c.env.DB, id, picked) });
  });

  api.post("/done-today/extras/preview", async (c) => {
    const body = await c.req.json<{ text?: string; input?: string }>();
    const setting = await getSetting(c.env.DB, "done_today_ai", "0").catch(() => "0");
    const split = await splitChecklist(String(body.text || ""), { ai: c.env.AI || null, setting });
    return c.json({ lines: split.lines.length ? split.lines : splitExtras(String(body.text || "")), split_by: split.split_by, input: body.input === "spoken" ? "spoken" : "typed" });
  });

  api.post("/done-today/extras", async (c) => {
    if (!(await doneTodayReady(c.env.DB))) return c.json({ error: NOT_READY }, 503);
    const user = c.get("user");
    const body = await c.req.json<{ lines?: string[]; input?: string; split_by?: string; batch_uuid?: string; day?: string }>();
    const picked = dayOrToday(body.day || chicagoYmd(Date.now()));
    if (typeof picked !== "string") return c.json({ error: picked.error }, 400);
    const lines = (body.lines || []).map((l) => String(l || "").trim()).filter((l) => l.length >= 1 && l.length <= 200).slice(0, 10);
    if (!lines.length) return c.json({ error: "Add at least one line" }, 400);
    const count = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM done_today_extras WHERE user_id = ? AND day_ct = ? AND removed_at IS NULL`).bind(user.id, picked).first<{ n: number }>();
    if ((count?.n || 0) + lines.length > 40) return c.json({ error: "40 extra lines is the daily limit" }, 400);
    const input = body.input === "spoken" ? "spoken" : "typed";
    const splitBy = body.split_by === "ai" || body.split_by === "rules" ? body.split_by : "none";
    for (const line of lines) {
      await c.env.DB
        .prepare(`INSERT INTO done_today_extras (user_id, day_ct, body, input, split_by, batch_uuid) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(user.id, picked, line, input, splitBy, body.batch_uuid || null)
        .run();
    }
    return c.json({ ok: true, saved: lines.length }, 201);
  });

  api.put("/done-today/settings", async (c) => {
    const user = c.get("user");
    if (!roleAtLeast(user.role, ["admin"])) return c.json({ error: "Not allowed" }, 403);
    const body = await c.req.json<{ done_today_ai?: boolean }>();
    if (typeof body.done_today_ai === "boolean") {
      const value = body.done_today_ai ? "1" : "0";
      await setSetting(c.env.DB, "done_today_ai", value);
      await writeAudit(c.env.DB, user, "update", "setting", "done_today_ai", `done_today_ai=${value}`);
    }
    return c.json({ ok: true, ai_enabled: false });
  });

  api.delete("/done-today/extras/:id", async (c) => {
    if (!(await doneTodayReady(c.env.DB))) return c.json({ error: NOT_READY }, 503);
    const user = c.get("user");
    const row = await c.env.DB.prepare(`SELECT id, user_id, day_ct FROM done_today_extras WHERE id = ?`).bind(Number(c.req.param("id"))).first<{ id: number; user_id: number; day_ct: string }>();
    if (!row) return c.json({ error: "Not found" }, 404);
    if (row.user_id !== user.id) return c.json({ error: "Not allowed" }, 403);
    if (row.day_ct !== chicagoYmd(Date.now())) return c.json({ error: "Only today's extra lines can be removed" }, 400);
    await c.env.DB.prepare(`UPDATE done_today_extras SET removed_at = datetime('now') WHERE id = ?`).bind(row.id).run();
    return c.json({ ok: true });
  });
}
