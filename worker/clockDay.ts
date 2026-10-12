/**
 * Day clock-out. Closes the day on Field App only.
 * Never closes a job and never changes punch times.
 */

import { dayBoardCacheKey, readDayBoardCache, type DayBoardResponse } from "./dayBoard";
import {
  chicagoYmd,
  foldOpenJobSessions,
  stillClockedInMessage,
  type JobClockPunch,
} from "./clockinNudgePlan";

export type OpenJobBlock = {
  apptId: string;
  jobId: string;
  jobLabel: string;
  message: string;
};

let dayTableReady = false;

export async function ensureDayClockTable(db: D1Database): Promise<void> {
  if (dayTableReady) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS fa_day_clock (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         user_id INTEGER NOT NULL,
         clock_out_at TEXT NOT NULL,
         chicago_day TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_fa_day_clock_user
       ON fa_day_clock (user_id, clock_out_at DESC)`
    )
    .run();
  dayTableReady = true;
}

function labelFromBoard(
  payload: DayBoardResponse | null,
  apptId: string,
  jobId: string
): string {
  if (!payload) return "";
  for (const row of payload.rows || []) {
    for (const job of row.jobs || []) {
      const appt = String(job.st_appointment_id || "");
      const jid = String(job.st_job_id || "");
      if ((apptId && appt === apptId) || (jobId && jid === jobId)) {
        const customer = String(job.customer_name || "").trim();
        const street = String(job.address || "").split(",")[0].trim();
        if (customer && street) return `${customer} - ${street}`.slice(0, 80);
        return (customer || street || "").slice(0, 80);
      }
    }
  }
  return "";
}

/** Open En route / Arrived session for this person, if any. Read only. */
export async function openJobClockBlock(
  db: D1Database,
  userId: number
): Promise<OpenJobBlock | null> {
  if (!(Number(userId) > 0)) return null;
  let punches: JobClockPunch[] = [];
  try {
    const rows = await db
      .prepare(
        `SELECT id, st_appointment_id, st_job_id, step
         FROM job_clock_events
         WHERE user_id = ?
         ORDER BY id ASC`
      )
      .bind(userId)
      .all<{
        id: number;
        st_appointment_id: string | null;
        st_job_id: string | null;
        step: string;
      }>();
    punches = (rows.results || []).map((row) => ({
      id: Number(row.id),
      userId,
      apptId: row.st_appointment_id,
      jobId: row.st_job_id,
      step: row.step,
    }));
  } catch {
    return null;
  }
  const open = foldOpenJobSessions(punches)
    .filter((row) => row.open)
    .sort((a, b) => a.lastId - b.lastId);
  const session = open[open.length - 1];
  if (!session) return null;
  let board: DayBoardResponse | null = null;
  try {
    const hit = await readDayBoardCache(
      db,
      dayBoardCacheKey(chicagoYmd(Date.now()), "office", 0),
      20 * 60 * 60 * 1000
    );
    board = hit?.payload || null;
  } catch {
    board = null;
  }
  const fromBoard = labelFromBoard(board, session.apptId, session.jobId);
  const jobLabel = fromBoard || (session.jobId ? `job ${session.jobId}` : "that job");
  return {
    apptId: session.apptId,
    jobId: session.jobId,
    jobLabel,
    message: stillClockedInMessage(jobLabel),
  };
}

export async function recordDayClockOut(
  db: D1Database,
  userId: number,
  clientTs?: string | null
): Promise<{ clock_out_at: string; chicago_day: string } | null> {
  if (!(Number(userId) > 0)) return null;
  await ensureDayClockTable(db);
  const clockOutAt = (clientTs && String(clientTs).trim()) || new Date().toISOString();
  const day = chicagoYmd(Date.parse(clockOutAt) || Date.now());
  await db
    .prepare(
      `INSERT INTO fa_day_clock (user_id, clock_out_at, chicago_day)
       VALUES (?, ?, ?)`
    )
    .bind(userId, clockOutAt, day)
    .run();
  return { clock_out_at: clockOutAt, chicago_day: day };
}
