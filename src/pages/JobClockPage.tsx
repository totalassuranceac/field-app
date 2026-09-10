import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, can, OfflineQueuedError } from "../api";
import { useAuth } from "../auth";

type ClockStep = "dispatch" | "arrive" | "complete";

type ClockState = {
  dispatch_at: string | null;
  arrive_at: string | null;
  complete_at: string | null;
  next_step: ClockStep | null;
  sync_status: string | null;
  sync_error?: string | null;
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
  job_type: string | null;
  permit?: {
    required: boolean;
    ready: boolean;
    status?: string | null;
    source?: string | null;
    message?: string | null;
    job_type?: string | null;
  } | null;
  clock: ClockState;
};

type TodayPayload = {
  configured: boolean;
  technician_id: number | null;
  today?: string;
  jobs: TodayJob[];
  message?: string;
  shop_session?: {
    id: number;
    kind: string;
    clock_in_at: string;
    clock_out_at: string | null;
    open: boolean;
  } | null;
};

const STEPS: { id: ClockStep; label: string; hint: string }[] = [
  { id: "dispatch", label: "Dispatch", hint: "Rolling to the job" },
  { id: "arrive", label: "Arrive", hint: "On site" },
  { id: "complete", label: "Complete", hint: "Done for this stop" },
];

const ACTIVE_KEY = "ta-job-clock-active";
const SAVED_LABEL = "Saved on Field App - do not use ServiceTitan Time Clock";

function jobKey(j: TodayJob): string {
  return j.st_appointment_id || j.st_job_id;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return Number.isFinite(d.getTime())
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })
      : iso.slice(11, 16) || iso;
  } catch {
    return iso;
  }
}

function windowLabel(start: string | null, end: string | null): string {
  if (!start && !end) return "Time window not listed";
  const a = fmtTime(start);
  const b = fmtTime(end);
  if (a && b) return `${a} – ${b}`;
  return a || b;
}

function addressLine(job: TodayJob): string {
  const raw = String(job.address || "").trim();
  if (raw) return raw;
  return "Address not in ServiceTitan";
}

export function JobClockPage() {
  const { user } = useAuth();
  const allowed = can(user, "useJobClock");
  const [payload, setPayload] = useState<TodayPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  });
  const [busyStep, setBusyStep] = useState<string | null>(null);
  const [shopBusy, setShopBusy] = useState(false);
  const [toast, setToast] = useState("");

  const reload = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setLoadError("");
    try {
      const data = await api<TodayPayload>("/jobs/today");
      setPayload(data);
      setActiveKey((prev) => {
        const keys = (data.jobs || []).map(jobKey);
        if (prev && keys.includes(prev)) return prev;
        const nextOpen = (data.jobs || []).find((j) => j.clock.next_step != null);
        const next = nextOpen ? jobKey(nextOpen) : keys[0] || null;
        try {
          if (next) sessionStorage.setItem(ACTIVE_KEY, next);
          else sessionStorage.removeItem(ACTIVE_KEY);
        } catch {
          /* ignore */
        }
        return next;
      });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load today's jobs");
      setPayload(null);
    } finally {
      setLoading(false);
    }
  }, [allowed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const active = useMemo(() => {
    if (!payload?.jobs?.length || !activeKey) return null;
    return payload.jobs.find((j) => jobKey(j) === activeKey) || null;
  }, [payload, activeKey]);

  function selectJob(job: TodayJob) {
    const key = jobKey(job);
    setActiveKey(key);
    try {
      sessionStorage.setItem(ACTIVE_KEY, key);
    } catch {
      /* ignore */
    }
  }

  async function setPermit(status: string) {
    if (!active || busyStep) return;
    setBusyStep("complete");
    setToast("");
    try {
      await api(`/install-permits/${encodeURIComponent(active.st_job_id)}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      setToast(`Permit set to ${status}`);
      await reload();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not set permit");
    } finally {
      setBusyStep(null);
    }
  }

  async function punch(step: ClockStep) {
    if (!active || busyStep || active.clock.next_step !== step) return;
    const clientTs = new Date().toISOString();
    setPayload((cur) =>
      cur
        ? {
            ...cur,
            jobs: cur.jobs.map((j) => {
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
          }
        : cur
    );
    setBusyStep(step);
    setToast("");
    try {
      const res = await api<{ clock?: ClockState; label?: string }>(`/clock/${step}`, {
        method: "POST",
        body: JSON.stringify({
          st_job_id: active.st_job_id,
          st_appointment_id: active.st_appointment_id,
          client_ts: clientTs,
          job_number: active.job_number,
          customer_name: active.customer_name,
          address: active.address,
        }),
      });
      if (res.clock) {
        setPayload((cur) =>
          cur
            ? {
                ...cur,
                jobs: cur.jobs.map((j) => (jobKey(j) === jobKey(active) ? { ...j, clock: res.clock! } : j)),
              }
            : cur
        );
      }
      setToast(res.label || SAVED_LABEL);
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        setToast(`${SAVED_LABEL} (will send when you have signal)`);
      } else {
        setToast(e instanceof Error ? e.message : "Could not save clock tap");
        void reload();
      }
    } finally {
      setBusyStep(null);
    }
  }

  async function retryStSync() {
    setBusyStep("retry");
    setToast("");
    try {
      const res = await api<{ synced?: number; failed?: number; errors?: string[] }>("/clock/retry", {
        method: "POST",
        body: JSON.stringify({}),
      });
      if ((res.synced || 0) > 0 && !(res.failed || 0)) {
        setToast("ServiceTitan sync caught up.");
      } else if (res.errors?.length) {
        setToast(res.errors[0]);
      } else {
        setToast("Retry finished. Reload if the red note is still there.");
      }
      await reload();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not retry ST sync");
    } finally {
      setBusyStep(null);
    }
  }

  async function shopPunch(dir: "in" | "out") {
    if (shopBusy || busyStep) return;
    const clientTs = new Date().toISOString();
    setShopBusy(true);
    setToast("");
    try {
      const res = await api<{ session?: TodayPayload["shop_session"]; label?: string }>(
        dir === "in" ? "/clock/shop/in" : "/clock/shop/out",
        {
          method: "POST",
          body: JSON.stringify(dir === "in" ? { kind: "shop", client_ts: clientTs } : { client_ts: clientTs }),
        }
      );
      if (res.session) {
        setPayload((cur) => (cur ? { ...cur, shop_session: res.session } : cur));
      }
      setToast(res.label || (dir === "in" ? "Shop/Office clocked in" : "Shop/Office clocked out"));
      await reload();
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        setToast("Saved offline — will sync when you have signal");
      } else {
        setToast(e instanceof Error ? e.message : "Could not save Shop/Office punch");
        void reload();
      }
    } finally {
      setShopBusy(false);
    }
  }

  const shopOpen = Boolean(payload?.shop_session?.open);

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
            One clock for today&apos;s jobs — Dispatch, Arrive, Complete. Skip the ServiceTitan Time Clock.
            {payload?.today ? ` — ${payload.today}` : ""}
          </p>
        </div>
        <button type="button" className="btn secondary" onClick={() => void reload()} disabled={loading}>
          {loading ? "Loading..." : "Reload"}
        </button>
      </header>

      <div className="job-clock-policy" role="note">
        <strong>Field App is your clock.</strong> Tap Dispatch → Arrive → Complete here. Do not use the
        ServiceTitan Time Clock for job time.
      </div>

      {toast && (
        <div className="job-clock-toast" role="status">
          {toast}
        </div>
      )}
      {loadError && (
        <div className="error" style={{ marginBottom: "0.85rem" }}>
          {loadError}
          <div style={{ marginTop: "0.5rem" }}>
            <button type="button" className="btn secondary" onClick={() => void reload()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {loading && !payload && <p className="muted">Loading today&apos;s jobs...</p>}

      {payload && !payload.configured && (
        <div className="empty-state job-clock-empty">
          <h2>ServiceTitan not connected</h2>
          <p>{payload.message || "Office can add credentials in Admin."}</p>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            You can still clock Shop/Office on Field App (no ST job).
          </p>
          {shopOpen ? (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={shopBusy || busyStep != null}
              onClick={() => void shopPunch("out")}
            >
              {shopBusy ? "Saving..." : "Clock out — Shop / Office"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={shopBusy || busyStep != null}
              onClick={() => void shopPunch("in")}
            >
              {shopBusy ? "Saving..." : "Shop / Office"}
            </button>
          )}
        </div>
      )}

      {payload && payload.configured && !payload.technician_id && (
        <div className="empty-state job-clock-empty">
          <h2>No technician linked</h2>
          <p>
            {payload.message ||
              "Your Field App login needs a ServiceTitan technician ID before Job Clock can load jobs."}
          </p>
          {can(user, "manageUsers") ? (
            <p>
              <Link to="/admin" className="btn primary">
                Link ST tech in People
              </Link>
            </p>
          ) : (
            <p className="muted">
              Ask office to open <strong>People</strong> → your login → set <strong>ST technician ID</strong>.
            </p>
          )}
          {shopOpen ? (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={shopBusy || busyStep != null}
              onClick={() => void shopPunch("out")}
            >
              {shopBusy ? "Saving..." : "Clock out — Shop / Office"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={shopBusy || busyStep != null}
              onClick={() => void shopPunch("in")}
            >
              {shopBusy ? "Saving..." : "Shop / Office"}
            </button>
          )}
        </div>
      )}

      {payload && payload.configured && payload.technician_id && !(payload.jobs || []).length && (
        <div className="empty-state job-clock-empty">
          <h2>No jobs today</h2>
          <p>{payload.message || "Nothing on your ServiceTitan schedule for today."}</p>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Working at the shop or office? Clock in here — no job required.
          </p>
          {shopOpen ? (
            <div className="job-clock-shop-panel">
              <p>
                <strong>Shop / Office</strong> clocked in {fmtTime(payload.shop_session?.clock_in_at)}
              </p>
              <button
                type="button"
                className="btn primary job-clock-shop-btn"
                disabled={shopBusy || busyStep != null}
                onClick={() => void shopPunch("out")}
              >
                {shopBusy ? "Saving..." : "Clock out — Shop / Office"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={shopBusy || busyStep != null}
              onClick={() => void shopPunch("in")}
            >
              {shopBusy ? "Saving..." : "Shop / Office"}
            </button>
          )}
        </div>
      )}

      {payload && payload.configured && payload.technician_id && (payload.jobs || []).length > 0 && shopOpen && (
        <div className="job-clock-shop-banner card" role="status">
          <strong>Shop / Office</strong> still clocked in ({fmtTime(payload.shop_session?.clock_in_at)}).
          <button
            type="button"
            className="btn secondary"
            style={{ marginLeft: "0.75rem" }}
            disabled={shopBusy || busyStep != null}
            onClick={() => void shopPunch("out")}
          >
            {shopBusy ? "Saving..." : "Clock out"}
          </button>
        </div>
      )}

      {payload && (payload.jobs || []).length > 0 && (
        <div className="job-clock-layout">
          <section className="job-clock-list" aria-label="Today's jobs">
            <h2 className="job-clock-section-title">Today</h2>
            <ul className="job-clock-job-list">
              {(payload.jobs || []).map((job) => {
                const key = jobKey(job);
                const selected = key === activeKey;
                const done = job.clock.next_step == null;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`job-clock-job-btn${selected ? " is-active" : ""}${done ? " is-done" : ""}`}
                      onClick={() => selectJob(job)}
                    >
                      <span className="job-clock-job-addr">{addressLine(job)}</span>
                      <span className="job-clock-job-cust">{job.customer_name || "Customer"}</span>
                      <span className="job-clock-job-num">
                        {job.job_number ? `#${job.job_number}` : `Job ${job.st_job_id}`}
                        {job.job_type ? (
                          <span className="muted job-clock-job-type"> · {job.job_type}</span>
                        ) : null}
                      </span>
                      <span className="muted job-clock-job-win">
                        {windowLabel(job.window_start, job.window_end)}
                        {done ? " — Done" : job.clock.dispatch_at ? " — In progress" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>

          {active && (
            <section className="job-clock-active card" aria-label="Active job clock">
              <p className="job-clock-address">{addressLine(active)}</p>
              <div className="job-clock-active-head">
                <h2>{active.job_number ? `Job #${active.job_number}` : `Job ${active.st_job_id}`}</h2>
                {active.st_appointment_status && (
                  <span className="muted">ST: {active.st_appointment_status}</span>
                )}
              </div>
              <p className="job-clock-customer">
                <strong>{active.customer_name || "Customer"}</strong>
                {active.job_type ? <span className="muted"> · {active.job_type}</span> : null}
              </p>
              <p className="muted">{windowLabel(active.window_start, active.window_end)}</p>

              {active.clock.sync_status === "error" && (
                <div className="job-clock-sync-error" role="alert">
                  <strong>ServiceTitan did not take this punch.</strong>
                  <div>{active.clock.sync_error || "Office can set the same step on the job in ST, then retry."}</div>
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ marginTop: 8 }}
                    disabled={busyStep != null}
                    onClick={() => void retryStSync()}
                  >
                    {busyStep === "retry" ? "Retrying..." : "Retry ST sync"}
                  </button>
                </div>
              )}

              {active.permit?.required && !active.permit.ready && (
                <div className="job-clock-permit-gate" role="alert">
                  <strong>Permit gate</strong>
                  {active.job_type || active.permit.job_type
                    ? ` (${active.job_type || active.permit.job_type})`
                    : ""}
                  : Complete is blocked until permit is on truck, on site, or N/A.
                  {active.permit.message ? <div style={{ marginTop: 4 }}>{active.permit.message}</div> : null}
                  {can(user, "manageInstallPermit") ? (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {["on_truck", "on_site", "na", "at_city", "missing"].map((s) => (
                        <button
                          key={s}
                          type="button"
                          className="btn secondary"
                          style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                          disabled={busyStep != null}
                          onClick={() => void setPermit(s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 4 }}>
                      Ask office to set permit status.
                    </div>
                  )}
                </div>
              )}

              <div className="job-clock-steps" role="group" aria-label="Clock steps">
                {STEPS.map((s) => {
                  const at =
                    s.id === "dispatch"
                      ? active.clock.dispatch_at
                      : s.id === "arrive"
                        ? active.clock.arrive_at
                        : active.clock.complete_at;
                  const isNext = active.clock.next_step === s.id;
                  const done = !!at;
                  const permitBlock = s.id === "complete" && !!active.permit?.required && !active.permit.ready;
                  const disabled = !isNext || busyStep != null || permitBlock;
                  return (
                    <div
                      key={s.id}
                      className={`job-clock-step${done ? " is-done" : ""}${isNext ? " is-next" : ""}`}
                    >
                      <button
                        type="button"
                        className={`btn job-clock-step-btn${isNext ? "" : " secondary"}`}
                        disabled={disabled}
                        onClick={() => void punch(s.id)}
                      >
                        {busyStep === s.id ? "Saving..." : s.label}
                      </button>
                      <span className="job-clock-step-meta">
                        {done ? (
                          <>
                            <span className="job-clock-check" aria-hidden>
                              ✓
                            </span>{" "}
                            {fmtTime(at)}
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
            </section>
          )}
        </div>
      )}
    </div>
  );
}
