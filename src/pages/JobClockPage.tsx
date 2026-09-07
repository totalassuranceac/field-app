import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, OfflineQueuedError, can } from "../api";
import { useAuth } from "../auth";

type ClockStep = "dispatch" | "arrive" | "complete";

type JobClockState = {
  dispatch_at: string | null;
  arrive_at: string | null;
  complete_at: string | null;
  next_step: ClockStep | null;
  sync_status: "queued" | "synced" | "error" | null;
};

type TodayJob = {
  st_job_id: string;
  st_appointment_id: string | null;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  window_start: string | null;
  window_end: string | null;
  st_appointment_status: string | null;
  clock: JobClockState;
};

type TodayJobsResponse = {
  configured: boolean;
  st_write_enabled: boolean;
  technician_id: number | null;
  today: string;
  jobs: TodayJob[];
  message?: string;
};

const STEPS: Array<{ id: ClockStep; label: string; hint: string }> = [
  { id: "dispatch", label: "Dispatch", hint: "Rolling to the job" },
  { id: "arrive", label: "Arrive", hint: "On site" },
  { id: "complete", label: "Complete", hint: "Done for this stop" },
];

const ACTIVE_KEY = "ta-job-clock-active";
const PHASE1_LABEL = "Saved on phone — ServiceTitan sync coming";

function jobKey(j: TodayJob): string {
  return j.st_appointment_id || j.st_job_id;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return iso.slice(11, 16) || iso;
    return d.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago",
    });
  } catch {
    return iso;
  }
}

function formatWindow(start: string | null, end: string | null): string {
  if (!start && !end) return "Time window not listed";
  const a = formatWhen(start);
  const b = formatWhen(end);
  if (a && b) return `${a} – ${b}`;
  return a || b;
}

export function JobClockPage() {
  const { user } = useAuth();
  const allowed = can(user, "useJobClock");

  const [data, setData] = useState<TodayJobsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  });
  const [busyStep, setBusyStep] = useState<ClockStep | null>(null);
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError("");
    try {
      const res = await api<TodayJobsResponse>("/jobs/today");
      setData(res);
      setActiveKey((prev) => {
        const keys = (res.jobs || []).map(jobKey);
        if (prev && keys.includes(prev)) return prev;
        // Prefer first incomplete job
        const open = (res.jobs || []).find((j) => j.clock.next_step != null);
        const next = open ? jobKey(open) : keys[0] || null;
        try {
          if (next) sessionStorage.setItem(ACTIVE_KEY, next);
          else sessionStorage.removeItem(ACTIVE_KEY);
        } catch {
          /* ignore */
        }
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load today’s jobs");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  const active = useMemo(() => {
    if (!data?.jobs?.length || !activeKey) return null;
    return data.jobs.find((j) => jobKey(j) === activeKey) || null;
  }, [data, activeKey]);

  function selectJob(j: TodayJob) {
    const key = jobKey(j);
    setActiveKey(key);
    try {
      sessionStorage.setItem(ACTIVE_KEY, key);
    } catch {
      /* ignore */
    }
  }

  async function tapStep(step: ClockStep) {
    if (!active || busyStep) return;
    if (active.clock.next_step !== step) return;

    const clientTs = new Date().toISOString();
    // Optimistic UI — never block the tech on network
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        jobs: prev.jobs.map((j) => {
          if (jobKey(j) !== jobKey(active)) return j;
          const clock = { ...j.clock, sync_status: "queued" as const };
          if (step === "dispatch") {
            clock.dispatch_at = clientTs;
            clock.next_step = "arrive";
          } else if (step === "arrive") {
            clock.arrive_at = clientTs;
            clock.next_step = "complete";
          } else {
            clock.complete_at = clientTs;
            clock.next_step = null;
          }
          return { ...j, clock };
        }),
      };
    });

    setBusyStep(step);
    setToast("");
    try {
      const res = await api<{
        ok: boolean;
        clock?: JobClockState;
        label?: string;
        deduped?: boolean;
      }>(`/clock/${step}`, {
        method: "POST",
        body: JSON.stringify({
          st_job_id: active.st_job_id,
          st_appointment_id: active.st_appointment_id,
          client_ts: clientTs,
        }),
      });
      if (res.clock) {
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            jobs: prev.jobs.map((j) =>
              jobKey(j) === jobKey(active) ? { ...j, clock: res.clock! } : j
            ),
          };
        });
      }
      setToast(res.label || PHASE1_LABEL);
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        setToast(`${PHASE1_LABEL} (will send when you have signal)`);
      } else {
        setToast(e instanceof Error ? e.message : "Could not save clock tap");
        // Reload authoritative state on hard failure
        void load();
      }
    } finally {
      setBusyStep(null);
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Job clock</h1>
          <p className="muted">Field techs use this page for Dispatch → Arrive → Complete.</p>
        </header>
        <div className="empty-state">
          <p>Your role does not use the job clock.</p>
          <Link to="/" className="btn secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page job-clock-page">
      <header className="page-header">
        <div>
          <h1>Job clock</h1>
          <p className="muted">
            One clock for today’s job — Dispatch, Arrive, Complete.
            {data?.today ? ` · ${data.today}` : ""}
          </p>
        </div>
        <button type="button" className="btn secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading…" : "Reload"}
        </button>
      </header>

      {toast && (
        <div className="job-clock-toast" role="status">
          {toast}
        </div>
      )}

      {error && (
        <div className="error" style={{ marginBottom: "0.85rem" }}>
          {error}
          <div style={{ marginTop: "0.5rem" }}>
            <button type="button" className="btn secondary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {loading && !data && <p className="muted">Loading today’s jobs…</p>}

      {data && !data.configured && (
        <div className="empty-state job-clock-empty">
          <h2>ServiceTitan not connected</h2>
          <p>{data.message || "Office can add credentials in Admin."}</p>
        </div>
      )}

      {data && data.configured && !data.technician_id && (
        <div className="empty-state job-clock-empty">
          <h2>No technician linked</h2>
          <p>
            {data.message ||
              "Ask office to set your ServiceTitan technician ID under People."}
          </p>
        </div>
      )}

      {data && data.configured && data.technician_id && !(data.jobs || []).length && (
        <div className="empty-state job-clock-empty">
          <h2>No jobs today</h2>
          <p>{data.message || "Nothing on your ServiceTitan schedule for today."}</p>
        </div>
      )}

      {data && (data.jobs || []).length > 0 && (
        <div className="job-clock-layout">
          <section className="job-clock-list" aria-label="Today’s jobs">
            <h2 className="job-clock-section-title">Today</h2>
            <ul className="job-clock-job-list">
              {(data.jobs || []).map((j) => {
                const key = jobKey(j);
                const isActive = key === activeKey;
                const done = j.clock.next_step == null;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`job-clock-job-btn${isActive ? " is-active" : ""}${
                        done ? " is-done" : ""
                      }`}
                      onClick={() => selectJob(j)}
                    >
                      <span className="job-clock-job-num">
                        {j.job_number ? `#${j.job_number}` : `Job ${j.st_job_id}`}
                      </span>
                      <span className="job-clock-job-cust">
                        {j.customer_name || "Customer"}
                      </span>
                      <span className="muted job-clock-job-win">
                        {formatWindow(j.window_start, j.window_end)}
                        {done ? " · Done" : j.clock.dispatch_at ? " · In progress" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {active && (
            <section className="job-clock-active card" aria-label="Active job clock">
              <div className="job-clock-active-head">
                <h2>
                  {active.job_number ? `Job #${active.job_number}` : `Job ${active.st_job_id}`}
                </h2>
                {active.st_appointment_status && (
                  <span className="muted">ST: {active.st_appointment_status}</span>
                )}
              </div>
              <p className="job-clock-customer">
                <strong>{active.customer_name || "Customer"}</strong>
              </p>
              {active.address && <p className="job-clock-address">{active.address}</p>}
              <p className="muted">{formatWindow(active.window_start, active.window_end)}</p>

              <div className="job-clock-steps" role="group" aria-label="Clock steps">
                {STEPS.map((s) => {
                  const ts =
                    s.id === "dispatch"
                      ? active.clock.dispatch_at
                      : s.id === "arrive"
                        ? active.clock.arrive_at
                        : active.clock.complete_at;
                  const isNext = active.clock.next_step === s.id;
                  const isDone = Boolean(ts);
                  const disabled = !isNext || busyStep != null;
                  return (
                    <div
                      key={s.id}
                      className={`job-clock-step${isDone ? " is-done" : ""}${
                        isNext ? " is-next" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className={`btn job-clock-step-btn${isNext ? "" : " secondary"}`}
                        disabled={disabled}
                        onClick={() => void tapStep(s.id)}
                      >
                        {busyStep === s.id ? "Saving…" : s.label}
                      </button>
                      <span className="job-clock-step-meta">
                        {isDone ? (
                          <>
                            <span className="job-clock-check" aria-hidden>
                              ✓
                            </span>{" "}
                            {formatWhen(ts)}
                          </>
                        ) : isNext ? (
                          s.hint
                        ) : (
                          <span className="muted">{s.hint}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              {(active.clock.sync_status === "queued" ||
                active.clock.dispatch_at ||
                active.clock.arrive_at ||
                active.clock.complete_at) && (
                <p className="job-clock-sync-note muted">{PHASE1_LABEL}</p>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
