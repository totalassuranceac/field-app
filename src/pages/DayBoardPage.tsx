import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type DayBoardInk = "st" | "board";
type DayBoardCrew = "service" | "install";

type DayBoardJob = {
  id: string;
  job_id: number | null;
  appointment_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  address: string | null;
  job_type: string | null;
  note: string | null;
  start: string | null;
  end: string | null;
  window_start: string | null;
  window_end: string | null;
  status: string | null;
  is_done: boolean;
  is_off: boolean;
  ink: DayBoardInk;
};

type DayBoardTechRow = {
  st_id: number;
  display_name: string;
  first_name: string;
  crew: DayBoardCrew;
  pto: boolean;
  jobs: DayBoardJob[];
};

type DayBoardPayload = {
  date: string;
  timezone: string;
  rows: DayBoardTechRow[];
  error?: string;
};

const TZ = "America/Chicago";

function chicagoTodayIso(anchor = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(anchor);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days));
  return `${utc.getUTCFullYear()}-${String(utc.getUTCMonth() + 1).padStart(2, "0")}-${String(utc.getUTCDate()).padStart(2, "0")}`;
}

function formatDayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatHm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: d.getMinutes() ? "2-digit" : undefined,
  });
}

function formatWindow(job: DayBoardJob): string {
  const a = formatHm(job.window_start) || formatHm(job.start);
  const b = formatHm(job.window_end) || formatHm(job.end);
  if (a && b && a !== b) return `${a}–${b}`;
  return a || b || "";
}

function formatPhone(raw: string | null): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw.trim();
}

function jobMeta(job: DayBoardJob): string {
  const parts: string[] = [];
  if (job.job_type) parts.push(job.job_type);
  if (job.note && job.note !== job.job_type) parts.push(job.note);
  return parts.join(" · ");
}

function slotCount(rows: DayBoardTechRow[]): number {
  let max = 1;
  for (const row of rows) {
    const n = row.pto && !row.jobs.some((j) => !j.is_off) ? 1 : row.jobs.length;
    if (n > max) max = n;
  }
  return Math.max(1, max);
}

function JobSlot({ job }: { job: DayBoardJob }) {
  const addr = (job.address || job.customer_name || "").trim();
  const meta = jobMeta(job);
  const window = formatWindow(job);
  const phone = formatPhone(job.customer_phone);
  const off = job.is_off;
  const cls = [
    "day-board-slot",
    "is-filled",
    off ? "is-off" : "",
    !off && job.is_done ? "is-done" : "",
    job.ink === "board" ? "ink-board" : "ink-st",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {off ? (
        <div className="day-board-slot-off">OFF</div>
      ) : (
        <>
          {addr ? <div className="day-board-slot-addr">{addr}</div> : null}
          {meta ? <div className="day-board-slot-meta">{meta}</div> : null}
          {window ? <div className="day-board-slot-meta">{window}</div> : null}
          {phone ? <div className="day-board-slot-meta">{phone}</div> : null}
        </>
      )}
    </div>
  );
}

function EmptySlot() {
  return <div className="day-board-slot" />;
}

function PtoOffSlot() {
  return (
    <div className="day-board-slot is-filled is-off">
      <div className="day-board-slot-off">OFF</div>
    </div>
  );
}

function TechRow({ row, slots }: { row: DayBoardTechRow; slots: number }) {
  const ptoOnly = row.pto && !row.jobs.some((j) => !j.is_off);
  const cells: Array<"empty" | "pto" | DayBoardJob> = [];
  if (ptoOnly) {
    cells.push("pto");
  } else {
    for (const job of row.jobs) cells.push(job);
  }
  while (cells.length < slots) cells.push("empty");

  return (
    <div className="day-board-row">
      <div className="day-board-tech" title={row.display_name}>
        <span className="day-board-tech-name">{row.first_name}</span>
      </div>
      {cells.map((cell, i) => {
        if (cell === "empty") return <EmptySlot key={`${row.st_id}-e-${i}`} />;
        if (cell === "pto") return <PtoOffSlot key={`${row.st_id}-pto`} />;
        return <JobSlot key={`${row.st_id}-${cell.id}-${i}`} job={cell} />;
      })}
    </div>
  );
}

function CrewSection({
  label,
  rows,
}: {
  label: string;
  rows: DayBoardTechRow[];
}) {
  const slots = slotCount(rows);
  return (
    <section className="day-board-section">
      <div className="day-board-section-label">{label}</div>
      {rows.length === 0 ? (
        <p className="day-board-empty muted">No techs in this section.</p>
      ) : (
        <div className="day-board-sheet">
          {rows.map((row) => (
            <TechRow key={row.st_id} row={row} slots={slots} />
          ))}
        </div>
      )}
    </section>
  );
}

export function DayBoardPage() {
  const { user } = useAuth();
  const allowed = can(user, "viewDayBoard");
  const [date, setDate] = useState(chicagoTodayIso);
  const [data, setData] = useState<DayBoardPayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (day: string) => {
    setLoading(true);
    setError("");
    try {
      const payload = await api<DayBoardPayload>(
        `/day-board?date=${encodeURIComponent(day)}`,
        { timeoutMs: 45_000 }
      );
      setData(payload);
      if (payload.error) setError(payload.error);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load day board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    void load(date);
  }, [allowed, date, load]);

  const service = useMemo(
    () => (data?.rows || []).filter((r) => r.crew === "service"),
    [data]
  );
  const install = useMemo(
    () => (data?.rows || []).filter((r) => r.crew === "install"),
    [data]
  );

  if (!allowed) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Day board</h2>
        <p className="error" style={{ marginBottom: "0.75rem" }}>
          Day board is for office and supervisors — field techs do not see others&apos; jobs.
        </p>
        <Link to="/" className="btn secondary">
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="page day-board">
      <div className="page-header day-board-header">
        <div>
          <h1>Day board</h1>
          <p className="page-header-sub">{formatDayLabel(date)} · ServiceTitan (read-only)</p>
        </div>
        <div className="day-board-picker">
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={() => setDate((d) => shiftIsoDate(d, -1))}
          >
            Prev
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d{4}-\d{2}-\d{2}$/.test(v)) setDate(v);
            }}
            aria-label="Board date"
          />
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={() => setDate((d) => shiftIsoDate(d, 1))}
          >
            Next
          </button>
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={() => setDate(chicagoTodayIso())}
          >
            Today
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading}
            onClick={() => void load(date)}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? <div className="error day-board-error">{error}</div> : null}

      {loading && !data ? (
        <p className="muted">Loading ServiceTitan appointments…</p>
      ) : (
        <>
          <CrewSection label="Service" rows={service} />
          <CrewSection label="Install" rows={install} />
        </>
      )}
    </div>
  );
}
