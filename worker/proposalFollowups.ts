/**
 * Proposal / estimate follow-up queue.
 * Soft lock: NEVER auto-email — only READY drafts for manual tap-to-send.
 */

export type ProposalFollowupRow = {
  id: number;
  customer_name: string | null;
  job_address: string | null;
  title: string | null;
  notes: string | null;
  sent_at: string;
  followup_due_at: string;
  followup_day: 3 | 7;
  status: "scheduled" | "ready" | "sent" | "dismissed";
  draft_body: string | null;
  parent_id: number | null;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
};

export async function ensureProposalFollowupTables(db: D1Database): Promise<void> {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS proposal_followups (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         customer_name TEXT,
         job_address TEXT,
         title TEXT,
         notes TEXT,
         sent_at TEXT NOT NULL,
         followup_due_at TEXT NOT NULL,
         followup_day INTEGER NOT NULL,
         status TEXT NOT NULL DEFAULT 'scheduled',
         draft_body TEXT,
         parent_id INTEGER,
         created_by_user_id INTEGER,
         created_at TEXT NOT NULL DEFAULT (datetime('now')),
         updated_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  try {
    await db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_proposal_followups_due
         ON proposal_followups(status, followup_due_at)`
      )
      .run();
  } catch {
    /* ignore */
  }
}

function addDaysIso(isoDate: string, days: number): string {
  const base = isoDate.slice(0, 10);
  const ms = Date.parse(`${base}T12:00:00Z`);
  if (!Number.isFinite(ms)) return base;
  const d = new Date(ms + days * 86400000);
  return d.toISOString().slice(0, 10);
}

function chicagoToday(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function buildFollowupDraft(opts: {
  day: 3 | 7;
  customer_name?: string | null;
  job_address?: string | null;
  title?: string | null;
}): string {
  const who = (opts.customer_name || "there").trim() || "there";
  const where = (opts.job_address || "").trim();
  const what = (opts.title || "proposal").trim() || "proposal";
  if (opts.day === 3) {
    return `Hi ${who} - just checking in on the ${what}${
      where ? ` for ${where}` : ""
    }. Happy to answer questions or adjust anything. - Total Assurance`;
  }
  return `Hi ${who} - following up on the ${what}${
    where ? ` for ${where}` : ""
  }. Want to schedule a walkthrough or next step? - Total Assurance`;
}

/** Stamp a proposal as sent; create 3-day and 7-day scheduled follow-ups. */
export async function stampProposalSent(
  db: D1Database,
  opts: {
    customer_name?: string | null;
    job_address?: string | null;
    title?: string | null;
    notes?: string | null;
    sent_at?: string | null;
    created_by_user_id: number;
  }
): Promise<{ parent_id: number; followups: number[] }> {
  await ensureProposalFollowupTables(db);
  const sentAt = (opts.sent_at || chicagoToday()).slice(0, 10);
  const customer = (opts.customer_name || "").trim() || null;
  const address = (opts.job_address || "").trim() || null;
  const title = (opts.title || "").trim() || null;
  const notes = (opts.notes || "").trim() || null;

  const parent = await db
    .prepare(
      `INSERT INTO proposal_followups (
         customer_name, job_address, title, notes, sent_at, followup_due_at,
         followup_day, status, draft_body, parent_id, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, 3, 'sent', NULL, NULL, ?)`
    )
    .bind(customer, address, title, notes, sentAt, sentAt, opts.created_by_user_id)
    .run();
  const parentId = Number(parent.meta.last_row_id);

  const ids: number[] = [];
  for (const day of [3, 7] as const) {
    const due = addDaysIso(sentAt, day);
    const draft = buildFollowupDraft({ day, customer_name: customer, job_address: address, title });
    const status = due <= chicagoToday() ? "ready" : "scheduled";
    const ins = await db
      .prepare(
        `INSERT INTO proposal_followups (
           customer_name, job_address, title, notes, sent_at, followup_due_at,
           followup_day, status, draft_body, parent_id, created_by_user_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        customer,
        address,
        title,
        notes,
        sentAt,
        due,
        day,
        status,
        draft,
        parentId,
        opts.created_by_user_id
      )
      .run();
    ids.push(Number(ins.meta.last_row_id));
  }
  return { parent_id: parentId, followups: ids };
}

/** Promote due scheduled rows to ready (call on list). */
export async function promoteDueProposalFollowups(db: D1Database): Promise<number> {
  await ensureProposalFollowupTables(db);
  const today = chicagoToday();
  const r = await db
    .prepare(
      `UPDATE proposal_followups
       SET status = 'ready', updated_at = datetime('now')
       WHERE status = 'scheduled' AND followup_due_at <= ? AND parent_id IS NOT NULL`
    )
    .bind(today)
    .run();
  return Number(r.meta.changes || 0);
}
