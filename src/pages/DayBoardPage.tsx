import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type DayBoardJob = {
  st_appointment_id: string;
  st_job_id: string | null;
  job_number: string | null;
  address: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  job_type: string | null;
  window_start: string | null;
  window_end: string | null;
  status: string | null;
  is_done: boolean;
  is_off?: boolean;
  ink?: "st" | "board";
  note: string | null;
};

type DayBoardPto = {
  request_id: number;
  label: string;
  start_date: string;
  end_date: string;
};

type DayBoardTechRow = {
  user_id: number | null;
  display_name: string;
  st_technician_id: number | null;
  is_self: boolean;
  crew?: "service" | "install";
  jobs: DayBoardJob[];
  pto: DayBoardPto[];
};

type DayBoardResponse = {
  date: string;
  timezone: string;
  view: "office" | "self";
  st_write_enabled: boolean;
  rows: DayBoardTechRow[];
  message?: string;
  error?: string;
};

function todayIso(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return utc.toISOString().slice(0, 10);
}

function formatWindow(start: string | null, end: string | null): string {
  const fmt = (iso: string) => {
    try {
      const d = new Date(iso);
      if (!Number.isFinite(d.getTime())) return "";
      return d.toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Chicago",
      });
    } catch {
      return "";
    }
  };
  const a = start ? fmt(start) : "";
  const b = end ? fmt(end) : "";
  if (a && b) return `${a}–${b}`;
  return a || b || "";
}

function parseLooseDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // M/D/YYYY or M-D-YYYY
  const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(t);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    const mo = String(Number(m[1])).padStart(2, "0");
    const d = String(Number(m[2])).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  const lower = t.toLowerCase();
  if (lower === "today") return todayIso();
  if (lower === "tomorrow") return shiftIso(todayIso(), 1);
  if (lower === "yesterday") return shiftIso(todayIso(), -1);
  return null;
}

export function DayBoardPage() {
  const { user } = useAuth();
  const allowed = can(user, "viewDayBoard");
  const [date, setDate] = useState(todayIso);
  const [jump, setJump] = useState("");
  const [data, setData] = useState<DayBoardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (day: string) => {
    if (!allowed) return;
    setLoading(true);
    setError("");
    try {
      const res = await api<DayBoardResponse>(
        `/day-board?date=${encodeURIComponent(day)}`,
        { timeoutMs: 60_000 }
      );
      setData(res);
      if (res.date && res.date !== day) setDate(res.date);
      if (res.error && !(res.rows || []).length) setError(res.error);
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load day board");
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  function goJump(e?: FormEvent) {
    e?.preventDefault();
    const parsed = parseLooseDate(jump || date);
    if (!parsed) {
      setError("Type a date like 2026-09-10, 9/10/2026, today, or tomorrow.");
      return;
    }
    setJump("");
    setDate(parsed);
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Day board</h1>
        </header>
        <div className="empty-state">
          <p>Office and field techs only.</p>
          <Link to="/" className="btn secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const isOffice = data?.view === "office" || can(user, "viewOpsPerformance");

  return (
    <div className="page day-board-page">
      <header className="page-header">
        <div>
          <h1>Day board</h1>
          <p className="muted">
            {isOffice ? "All techs · live ServiceTitan" : "Your day · live ServiceTitan"}
            {" · "}
            sheet backup only when the app is down
          </p>
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={loading}
          onClick={() => void load(date)}
        >
          {loading ? "Loading…" : "Reload"}
        </button>
      </header>

      <div className="day-board-controls">
        <div className="day-board-nav">
          <button
            type="button"
            className="btn secondary"
            onClick={() => setDate((d) => shiftIso(d, -1))}
            aria-label="Previous day"
          >
            ‹
          </button>
          <input
            type="date"
            className="day-board-date"
            value={date}
            onChange={(e) => setDate(e.target.value || todayIso())}
            aria-label="Pick day"
          />
          <button
            type="button"
            className="btn secondary"
            onClick={() => setDate((d) => shiftIso(d, 1))}
            aria-label="Next day"
          >
            ›
          </button>
          <button type="button" className="btn secondary" onClick={() => setDate(todayIso())}>
            Today
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => setDate(shiftIso(todayIso(), 1))}
          >
            Tomorrow
          </button>
        </div>
        <form className="day-board-jump" onSubmit={goJump}>
          <label className="sr-only" htmlFor="day-board-jump-input">
            Jump to date
          </label>
          <input
            id="day-board-jump-input"
            type="text"
            inputMode="numeric"
            placeholder="Type date · today · tomorrow"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onBlur={() => {
              if (jump.trim()) goJump();
            }}
          />
          <button type="submit" className="btn">
            Go
          </button>
        </form>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: "0.75rem" }}>
          {error}
        </div>
      )}

      {data?.message && !error ? (
        <p className="muted day-board-msg">{data.message}</p>
      ) : null}

      {loading && !data ? <p className="muted">Loading board…</p> : null}

      {(() => {
        const all = data?.rows || [];
        const service = all.filter((r) => (r.crew || "service") !== "install");
        const install = all.filter((r) => r.crew === "install");
        const renderRows = (list: DayBoardTechRow[], label: string) => (
          <section className="day-board-section" aria-label={label}>
            <div className="day-board-section-label">{label}</div>
            <div className="day-board-sheet" role="table">
              <div className="day-board-sheet-scroll">
                {list.map((row) => {
                  const onPto = row.pto.length > 0;
                  const blocked = onPto && !row.jobs.length;
                  const first = row.display_name.split(/\s+/)[0] || row.display_name;
                  return (
                    <div
                      key={`${row.st_technician_id || "x"}-${row.user_id || row.display_name}`}
                      className={`day-board-row${row.is_self ? " is-self" : ""}${
                        blocked ? " is-pto-blocked" : ""
                      }`}
                      role="row"
                    >
                      <div
                        className="day-board-tech"
                        role="rowheader"
                        title={row.display_name}
                      >
                        <span className="day-board-tech-vert">{first}</span>
                        {onPto ? (
                          <span className="day-board-pto">
                            {row.pto.map((p) => p.label).join(" · ")}
                          </span>
                        ) : null}
                      </div>
                      <div className="day-board-jobs" role="cell">
                        {blocked ? (
                          <div className="day-board-cell is-off">
                            <span className="day-board-cell-main">
                              {row.pto.map((p) => p.label).join(" · ") || "OFF"}
                            </span>
                          </div>
                        ) : null}
                        {!row.jobs.length && !blocked ? (
                          <span className="day-board-empty muted">—</span>
                        ) : null}
                        {row.jobs.map((j) => {
                          const ink = j.ink === "board" ? "ink-board" : "ink-st";
                          return (
                            <div
                              key={j.st_appointment_id}
                              className={`day-board-cell ${ink}${
                                j.is_done ? " is-done" : ""
                              }${j.is_off ? " is-off" : ""}`}
                              title={[
                                j.customer_name,
                                j.status,
                                j.customer_phone,
                                j.note,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            >
                              <span className="day-board-cell-main">
                                {j.address ||
                                  j.customer_name ||
                                  `Job ${j.job_number || j.st_job_id || ""}`}
                              </span>
                              <span className="day-board-cell-meta">
                                {[
                                  j.job_type || j.note,
                                  formatWindow(j.window_start, j.window_end),
                                  j.customer_phone,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        );
        return (
          <>
            {service.length ? renderRows(service, "Service") : null}
            {install.length ? renderRows(install, "Install") : null}
          </>
        );
      })()}

      {!loading && data && !(data.rows || []).length ? (
        <div className="empty-state">
          <p>No techs or jobs for this day.</p>
        </div>
      ) : null}
    </div>
  );
}
