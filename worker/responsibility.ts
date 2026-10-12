/**
 * Signed company-card and company-vehicle responsibility forms.
 * The stored shown_text is the wording the employee signed.
 */

import type { Hono } from "hono";
import type { Env, PublicUser, Variables } from "./types";
import { writeAudit } from "./audit";
import { getDriverHomeVehicleIds } from "./auth";
import {
  CARD_FORM_VERSION,
  VEHICLE_FORM_VERSION,
  cardShownText,
  cardUseLabel,
  isCardUse,
  vehicleShownText,
} from "../src/responsibilityCopy";

type App = Hono<{ Bindings: Env; Variables: Variables }>;

type Person = {
  id: number;
  display_name: string;
  username: string;
  role: string;
  employee_id: number | null;
  active: number;
};

type AckRow = {
  id: number;
  kind: string;
  user_id: number;
  employee_id: number | null;
  status: string;
  card_last4: string | null;
  card_use: string | null;
  vehicle_label: string | null;
  shown_text: string | null;
  form_version: string | null;
  signer_name: string | null;
  signature_key: string | null;
  signed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  created_at: string;
};

const CREATE_SQL = `CREATE TABLE IF NOT EXISTS responsibility_acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  employee_id INTEGER,
  status TEXT NOT NULL DEFAULT 'needed',
  card_last4 TEXT,
  card_use TEXT,
  vehicle_label TEXT,
  shown_text TEXT,
  form_version TEXT,
  signer_name TEXT,
  signature_key TEXT,
  signed_at TEXT,
  voided_at TEXT,
  voided_by_user_id INTEGER,
  void_reason TEXT,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

let ready: Promise<void> | null = null;

function ensureResponsibility(db: D1Database): Promise<void> {
  if (!ready) {
    ready = (async () => {
      try {
        await db.prepare(CREATE_SQL).run();
        await db
          .prepare(
            `CREATE INDEX IF NOT EXISTS idx_responsibility_user
             ON responsibility_acks(user_id, kind, status)`
          )
          .run();
      } catch (err) {
        ready = null;
        throw err;
      }
    })();
  }
  return ready;
}

function canViewOthers(user: PublicUser): boolean {
  return user.role === "admin" || user.role === "office" || user.role === "supervisor";
}

function canVoid(user: PublicUser): boolean {
  return user.role === "admin" || user.role === "office";
}

function signatureUrl(key: string | null | undefined): string | null {
  const clean = String(key || "").trim();
  if (!clean) return null;
  return `/api/uploads/${clean}`;
}

function personName(person: { display_name?: string | null; username?: string | null }): string {
  return String(person.display_name || person.username || "").trim();
}

async function loadPerson(db: D1Database, id: number): Promise<Person | null> {
  const row = await db
    .prepare(
      `SELECT id, display_name, username, role, employee_id, active
       FROM users WHERE id = ?`
    )
    .bind(id)
    .first<Person>();
  return row || null;
}

async function assignedUnits(db: D1Database, person: Person): Promise<string[]> {
  const units = new Set<string>();
  if (person.employee_id) {
    try {
      const rows = await db
        .prepare(
          `SELECT unit_number FROM vehicles
           WHERE status != 'retired'
             AND (assigned_employee_id = ? OR helper_employee_id = ?)`
        )
        .bind(person.employee_id, person.employee_id)
        .all<{ unit_number: string | null }>();
      for (const row of rows.results || []) {
        const unit = String(row.unit_number || "").trim();
        if (unit) units.add(unit);
      }
    } catch {
      try {
        const rows = await db
          .prepare(
            `SELECT unit_number FROM vehicles
             WHERE status != 'retired' AND assigned_employee_id = ?`
          )
          .bind(person.employee_id)
          .all<{ unit_number: string | null }>();
        for (const row of rows.results || []) {
          const unit = String(row.unit_number || "").trim();
          if (unit) units.add(unit);
        }
      } catch {
        /* assignment columns are optional on older databases */
      }
    }
  }
  if (person.role === "driver") {
    try {
      const ids = await getDriverHomeVehicleIds(db, person as unknown as PublicUser);
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const rows = await db
          .prepare(`SELECT unit_number FROM vehicles WHERE id IN (${placeholders})`)
          .bind(...ids)
          .all<{ unit_number: string | null }>();
        for (const row of rows.results || []) {
          const unit = String(row.unit_number || "").trim();
          if (unit) units.add(unit);
        }
      }
    } catch {
      /* name match is optional */
    }
  }
  return [...units];
}

function vehicleLabelFor(units: string[]): string {
  return units.length ? units.join(", ") : "Company vehicles I am assigned to drive";
}

async function rowsFor(db: D1Database, userId: number): Promise<AckRow[]> {
  const listed = await db
    .prepare(
      `SELECT id, kind, user_id, employee_id, status, card_last4, card_use, vehicle_label,
              shown_text, form_version, signer_name, signature_key, signed_at, voided_at,
              void_reason, created_at
       FROM responsibility_acks
       WHERE user_id = ? AND status != 'void'
       ORDER BY id DESC`
    )
    .bind(userId)
    .all<AckRow>();
  return listed.results || [];
}

function currentVehicle(rows: AckRow[]): AckRow | null {
  return (
    rows.find(
      (row) =>
        row.kind === "vehicle" &&
        row.status === "signed" &&
        row.form_version === VEHICLE_FORM_VERSION &&
        !row.voided_at
    ) || null
  );
}

function publicAck(row: AckRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    card_last4: row.card_last4 || null,
    card_use: row.card_use || null,
    card_use_label: cardUseLabel(row.card_use || ""),
    vehicle_label: row.vehicle_label || null,
    shown_text: row.shown_text || "",
    form_version: row.form_version || null,
    signer_name: row.signer_name || null,
    signed_at: row.signed_at || null,
    signature_url: signatureUrl(row.signature_key),
    created_at: row.created_at,
  };
}

async function saveSignature(env: Env, file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const key = `responsibility-acks/${Date.now()}-${crypto.randomUUID()}.png`;
  if (env.RECEIPTS) {
    await env.RECEIPTS.put(key, buf, { httpMetadata: { contentType: "image/png" } });
    return key;
  }
  await env.DB.prepare(
    `INSERT INTO receipt_blobs (key, content_type, data, size) VALUES (?, ?, ?, ?)`
  )
    .bind(key, "image/png", new Uint8Array(buf), buf.byteLength)
    .run();
  return key;
}

export function registerResponsibilityRoutes(api: App) {
  api.get("/responsibility/status", async (c) => {
    await ensureResponsibility(c.env.DB);
    const user = c.get("user");
    const requested = Number(c.req.query("user_id") || 0);
    const targetId = requested > 0 ? requested : user.id;
    if (targetId !== user.id && !canViewOthers(user)) {
      return c.json({ error: "You can open your own forms." }, 403);
    }
    const person = await loadPerson(c.env.DB, targetId);
    if (!person) return c.json({ error: "Employee login not found." }, 404);

    const units = await assignedUnits(c.env.DB, person);
    const rows = await rowsFor(c.env.DB, person.id);
    const signedVehicle = currentVehicle(rows);
    const neededVehicle = rows.find((row) => row.kind === "vehicle" && row.status === "needed") || null;
    const drives =
      person.role === "driver" ||
      person.role === "mechanic" ||
      units.length > 0 ||
      Boolean(neededVehicle);
    const cards = rows.filter((row) => row.kind === "card").map(publicAck);

    let roster: {
      vehicle_missing: { user_id: number; name: string; role: string }[];
      cards_waiting: { id: number; user_id: number; name: string; card_last4: string | null; card_use_label: string }[];
    } | null = null;
    if (targetId === user.id && canViewOthers(user)) {
      const drivers = await c.env.DB.prepare(
        `SELECT u.id, u.display_name, u.role
         FROM users u
         WHERE u.active = 1 AND u.role IN ('driver', 'mechanic')
           AND NOT EXISTS (
             SELECT 1 FROM responsibility_acks a
             WHERE a.user_id = u.id AND a.kind = 'vehicle' AND a.status = 'signed'
               AND a.form_version = ? AND a.voided_at IS NULL
           )
         ORDER BY u.display_name COLLATE NOCASE`
      )
        .bind(VEHICLE_FORM_VERSION)
        .all<{ id: number; display_name: string; role: string }>();
      const asked = await c.env.DB.prepare(
        `SELECT u.id, u.display_name, u.role
         FROM responsibility_acks a
         JOIN users u ON u.id = a.user_id
         WHERE a.kind = 'vehicle' AND a.status = 'needed' AND u.active = 1
         ORDER BY u.display_name COLLATE NOCASE`
      ).all<{ id: number; display_name: string; role: string }>();
      const seen = new Set<number>();
      const vehicleMissing: { user_id: number; name: string; role: string }[] = [];
      for (const row of [...(drivers.results || []), ...(asked.results || [])]) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        vehicleMissing.push({
          user_id: row.id,
          name: row.display_name || "Employee",
          role: row.role,
        });
      }
      const waiting = await c.env.DB.prepare(
        `SELECT a.id, a.user_id, a.card_last4, a.card_use, u.display_name
         FROM responsibility_acks a
         JOIN users u ON u.id = a.user_id
         WHERE a.kind = 'card' AND a.status = 'needed' AND u.active = 1
         ORDER BY u.display_name COLLATE NOCASE, a.id`
      ).all<{
        id: number;
        user_id: number;
        card_last4: string | null;
        card_use: string | null;
        display_name: string;
      }>();
      roster = {
        vehicle_missing: vehicleMissing,
        cards_waiting: (waiting.results || []).map((row) => ({
          id: row.id,
          user_id: row.user_id,
          name: row.display_name || "Employee",
          card_last4: row.card_last4 || null,
          card_use_label: cardUseLabel(row.card_use || ""),
        })),
      };
    }

    return c.json({
      self: targetId === user.id,
      can_assign: canViewOthers(user) && targetId !== user.id,
      can_void: canVoid(user),
      person: {
        user_id: person.id,
        name: personName(person) || "Employee",
        role: person.role,
        employee_id: person.employee_id,
        active: person.active === 1,
      },
      vehicle: {
        required: drives,
        status: signedVehicle ? "signed" : drives ? "needed" : "none",
        label: signedVehicle?.vehicle_label || vehicleLabelFor(units),
        form_version: VEHICLE_FORM_VERSION,
        ack: signedVehicle ? publicAck(signedVehicle) : neededVehicle ? publicAck(neededVehicle) : null,
      },
      cards,
      card_version: CARD_FORM_VERSION,
      roster,
    });
  });

  api.post("/responsibility/expect", async (c) => {
    await ensureResponsibility(c.env.DB);
    const user = c.get("user");
    if (!canViewOthers(user)) return c.json({ error: "Office access required." }, 403);
    const body = await c.req.json<{
      user_id?: number;
      kind?: string;
      card_last4?: string;
      card_use?: string;
    }>();
    const targetId = Number(body.user_id || 0);
    const person = await loadPerson(c.env.DB, targetId);
    if (!person || person.active !== 1) return c.json({ error: "Choose an active employee login." }, 400);
    const kind = String(body.kind || "");
    if (kind === "card") {
      const last4 = String(body.card_last4 || "").replace(/\D/g, "");
      if (last4.length !== 4) return c.json({ error: "Enter the last 4 digits of the company card." }, 400);
      const cardUse = String(body.card_use || "");
      if (!isCardUse(cardUse)) return c.json({ error: "Choose what this card is used for." }, 400);
      const signed = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'card' AND status = 'signed'
           AND card_last4 = ? AND form_version = ? AND voided_at IS NULL`
      )
        .bind(person.id, last4, CARD_FORM_VERSION)
        .first<{ id: number }>();
      if (signed) return c.json({ error: "This card is already signed." }, 409);
      const pending = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'card' AND status = 'needed' AND card_last4 = ?`
      )
        .bind(person.id, last4)
        .first<{ id: number }>();
      if (!pending) {
        await c.env.DB.prepare(
          `INSERT INTO responsibility_acks (
             kind, user_id, employee_id, status, card_last4, card_use, form_version, created_by_user_id
           ) VALUES ('card', ?, ?, 'needed', ?, ?, ?, ?)`
        )
          .bind(person.id, person.employee_id, last4, cardUse, CARD_FORM_VERSION, user.id)
          .run();
      }
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "responsibility_ack",
        person.id,
        `Asked ${personName(person)} to sign for card ending ${last4}`
      );
      return c.json({ ok: true });
    }
    if (kind === "vehicle") {
      const signed = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'vehicle' AND status = 'signed'
           AND form_version = ? AND voided_at IS NULL`
      )
        .bind(person.id, VEHICLE_FORM_VERSION)
        .first<{ id: number }>();
      if (signed) return c.json({ error: "The vehicle form is already signed." }, 409);
      const pending = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'vehicle' AND status = 'needed'`
      )
        .bind(person.id)
        .first<{ id: number }>();
      if (!pending) {
        const units = await assignedUnits(c.env.DB, person);
        await c.env.DB.prepare(
          `INSERT INTO responsibility_acks (
             kind, user_id, employee_id, status, vehicle_label, form_version, created_by_user_id
           ) VALUES ('vehicle', ?, ?, 'needed', ?, ?, ?)`
        )
          .bind(person.id, person.employee_id, vehicleLabelFor(units), VEHICLE_FORM_VERSION, user.id)
          .run();
      }
      await writeAudit(
        c.env.DB,
        user,
        "create",
        "responsibility_ack",
        person.id,
        `Asked ${personName(person)} to sign the company vehicle form`
      );
      return c.json({ ok: true });
    }
    return c.json({ error: "Choose card or vehicle." }, 400);
  });

  api.post("/responsibility/sign", async (c) => {
    await ensureResponsibility(c.env.DB);
    const user = c.get("user");
    if (c.get("viewAsUserId") != null) {
      return c.json({ error: "Exit view-as before signing." }, 403);
    }
    const form = await c.req.formData();
    if (String(form.get("read_confirmed") || "") !== "1") {
      return c.json({ error: "Confirm that you read each line." }, 400);
    }
    const kind = String(form.get("kind") || "");
    const sig = form.get("signature");
    if (!(sig instanceof File) || sig.size < 200) {
      return c.json({ error: "Sign in the box with your finger." }, 400);
    }
    if (sig.size > 800_000) return c.json({ error: "Signature file is too large." }, 400);
    const person = await loadPerson(c.env.DB, user.id);
    if (!person || person.active !== 1) return c.json({ error: "This login cannot sign." }, 403);
    const name = personName(person);
    if (!name) return c.json({ error: "Your account needs a name before you can sign." }, 400);

    let cardLast4: string | null = null;
    let cardUse: string | null = null;
    let vehicleLabel: string | null = null;
    let shown = "";
    let version = "";
    if (kind === "card") {
      cardLast4 = String(form.get("card_last4") || "").replace(/\D/g, "");
      if (cardLast4.length !== 4) {
        return c.json({ error: "Enter the last 4 digits of the company card." }, 400);
      }
      cardUse = String(form.get("card_use") || "");
      if (!isCardUse(cardUse)) return c.json({ error: "Choose what this card is used for." }, 400);
      version = CARD_FORM_VERSION;
      shown = cardShownText({ name, last4: cardLast4, useLabel: cardUseLabel(cardUse) });
      const existing = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'card' AND status = 'signed'
           AND card_last4 = ? AND form_version = ? AND voided_at IS NULL`
      )
        .bind(person.id, cardLast4, version)
        .first<{ id: number }>();
      if (existing) return c.json({ error: "Already signed for this card." }, 409);
    } else if (kind === "vehicle") {
      const units = await assignedUnits(c.env.DB, person);
      vehicleLabel = vehicleLabelFor(units);
      version = VEHICLE_FORM_VERSION;
      shown = vehicleShownText({ name, vehicleLabel });
      const existing = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'vehicle' AND status = 'signed'
           AND form_version = ? AND voided_at IS NULL`
      )
        .bind(person.id, version)
        .first<{ id: number }>();
      if (existing) return c.json({ error: "Already signed for company vehicles." }, 409);
    } else {
      return c.json({ error: "Choose card or vehicle." }, 400);
    }

    let key = "";
    try {
      key = await saveSignature(c.env, sig);
    } catch {
      return c.json({ error: "Could not save the signature. Try again." }, 500);
    }
    const signedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    let neededId: number | null = null;
    if (kind === "card") {
      const needed = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'card' AND status = 'needed'
           AND (card_last4 = ? OR card_last4 IS NULL OR trim(card_last4) = '')
         ORDER BY id DESC LIMIT 1`
      )
        .bind(person.id, cardLast4)
        .first<{ id: number }>();
      neededId = needed?.id ?? null;
    } else {
      const needed = await c.env.DB.prepare(
        `SELECT id FROM responsibility_acks
         WHERE user_id = ? AND kind = 'vehicle' AND status = 'needed'
         ORDER BY id DESC LIMIT 1`
      )
        .bind(person.id)
        .first<{ id: number }>();
      neededId = needed?.id ?? null;
    }

    if (neededId) {
      await c.env.DB.prepare(
        `UPDATE responsibility_acks
         SET status = 'signed', card_last4 = ?, card_use = ?, vehicle_label = ?,
             shown_text = ?, form_version = ?, signer_name = ?, signature_key = ?,
             signed_at = ?, employee_id = ?
         WHERE id = ?`
      )
        .bind(
          cardLast4,
          cardUse,
          vehicleLabel,
          shown,
          version,
          name,
          key,
          signedAt,
          person.employee_id,
          neededId
        )
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO responsibility_acks (
           kind, user_id, employee_id, status, card_last4, card_use, vehicle_label,
           shown_text, form_version, signer_name, signature_key, signed_at, created_by_user_id
         ) VALUES (?, ?, ?, 'signed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          kind,
          person.id,
          person.employee_id,
          cardLast4,
          cardUse,
          vehicleLabel,
          shown,
          version,
          name,
          key,
          signedAt,
          person.id
        )
        .run();
    }
    await writeAudit(
      c.env.DB,
      user,
      "create",
      "responsibility_ack",
      person.id,
      kind === "card"
        ? `Signed company card ending ${cardLast4}`
        : "Signed company vehicle form"
    );
    return c.json({ ok: true });
  });

  api.post("/responsibility/:id/void", async (c) => {
    await ensureResponsibility(c.env.DB);
    const user = c.get("user");
    if (!canVoid(user)) return c.json({ error: "Office access required to clear a signature." }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id) || id <= 0) return c.json({ error: "Form not found." }, 404);
    const body = await c.req.json<{ reason?: string }>();
    const reason = String(body.reason || "").trim();
    if (reason.length < 8) {
      return c.json({ error: "Say why this signature is being cleared (at least 8 characters)." }, 400);
    }
    const before = await c.env.DB.prepare(
      `SELECT id, user_id, kind, status, card_last4 FROM responsibility_acks WHERE id = ?`
    )
      .bind(id)
      .first<{ id: number; user_id: number; kind: string; status: string; card_last4: string | null }>();
    if (!before || before.status === "void") return c.json({ error: "Form not found." }, 404);
    const voidedAt = new Date().toISOString().slice(0, 19).replace("T", " ");
    await c.env.DB.prepare(
      `UPDATE responsibility_acks
       SET status = 'void', voided_at = ?, voided_by_user_id = ?, void_reason = ?
       WHERE id = ?`
    )
      .bind(voidedAt, user.id, reason.slice(0, 400), id)
      .run();
    await writeAudit(
      c.env.DB,
      user,
      "update",
      "responsibility_ack",
      before.user_id,
      `Cleared ${before.kind} signature${before.card_last4 ? ` ending ${before.card_last4}` : ""}. ${reason.slice(0, 120)}`
    );
    return c.json({ ok: true });
  });
}
