import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, OfflineQueuedError, can } from "../api";
import { useAuth } from "../auth";
import { EquipmentSnap } from "../components/EquipmentSnap";
import { JobBriefCard } from "../components/JobBriefCard";
import { PartsUsedPanel } from "../components/PartsUsedPanel";
import { WrapUpCard } from "../components/WrapUpCard";
import { usualAboutLine } from "../jobDurations";

type ClockStep = "dispatch" | "arrive" | "complete";

type JobClockState = {
  dispatch_at: string | null;
  arrive_at: string | null;
  complete_at: string | null;
  next_step: ClockStep | null;
  sync_status: "queued" | "synced" | "error" | null;
  sync_error?: string | null;
  st_step?: ClockStep | null;
  st_status?: string | null;
  /** Null means this stop is finished. Missing (undefined) falls back to next_step. */
  effective_next_step?: ClockStep | null;
};

type PermitGateInfo = {
  required: boolean;
  ready: boolean;
  status: string | null;
  source: string;
  message: string | null;
  job_type: string | null;
};

type TodayJob = {
  st_job_id: string;
  st_appointment_id: string | null;
  job_number: string | null;
  customer_name: string | null;
  customer_phone?: string | null;
  address: string | null;
  address_source?: string | null;
  window_start: string | null;
  window_end: string | null;
  st_appointment_status: string | null;
  job_type?: string | null;
  note?: string | null;
  access_code?: string | null;
  invoice_customer_name?: string | null;
  business_unit?: string | null;
  last_visit_on?: string | null;
  permit?: PermitGateInfo | null;
  clock: JobClockState;
  job_notes?: { code: string; level: string; text: string }[];
};

type ShopSession = {
  id: number;
  kind: "shop" | "office";
  clock_in_at: string;
  clock_out_at: string | null;
  open: boolean;
  st_timesheet_write: false;
};

type TodayJobsResponse = {
  configured: boolean;
  st_write_enabled: boolean;
  technician_id: number | null;
  today: string;
  jobs: TodayJob[];
  message?: string;
  shop_session?: ShopSession | null;
};

const STEPS: Array<{ id: ClockStep; doneLabel: string; nextLabel: string }> = [
  { id: "dispatch", doneLabel: "Dispatched", nextLabel: "Tap when you leave for this job" },
  { id: "arrive", doneLabel: "Arrived", nextLabel: "Tap when you arrive" },
  { id: "complete", doneLabel: "Finished", nextLabel: "Tap when you finish" },
];

const ACTIVE_KEY = "ta-job-clock-active";
const PHASE1_LABEL = "Saved on Field App - do not use ServiceTitan Time Clock";

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
  if (a && b) return `${a} - ${b}`;
  return a || b;
}

function jobBlockLabel(job: TodayJob): string {
  const customer = String(job.customer_name || "").trim();
  const street = String(job.address || "").split(",")[0].trim();
  const streetOk = street && street !== "Address not in ServiceTitan" && street !== "Earlier visit";
  if (customer && customer !== "Open job" && streetOk) return `${customer} - ${street}`;
  if (customer && customer !== "Open job") return customer;
  if (streetOk) return street;
  if (job.job_number) return `job ${job.job_number}`;
  return "that job";
}

function billToName(job: TodayJob): string | null {
  const bill = String(job.invoice_customer_name || "").trim();
  const site = String(job.customer_name || "").trim();
  if (!bill) return null;
  if (site && bill.toLowerCase() === site.toLowerCase()) return null;
  return bill;
}

function typeBuLine(job: TodayJob): string | null {
  const type = String(job.job_type || "").trim();
  const unit = String(job.business_unit || "").trim();
  if (type && unit) return `${type} \u00B7 ${unit}`;
  return type || unit || null;
}

function formatVisitDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });
}

function addressLine(job: TodayJob): string {
  const raw = String(job.address || "").trim();
  if (raw) return raw;
  // Only after worker invoice/CRM enrich failed - ST truly has no street.
  return "Address not in ServiceTitan";
}

function stepRank(step: ClockStep | null | undefined): number {
  if (step === "dispatch") return 1;
  if (step === "arrive") return 2;
  if (step === "complete") return 3;
  return 0;
}

function localRank(clock: JobClockState): number {
  if (clock.complete_at) return 3;
  if (clock.arrive_at) return 2;
  if (clock.dispatch_at) return 1;
  return 0;
}

function effectiveFromClock(clock: JobClockState): ClockStep | null {
  const done = Math.max(localRank(clock), stepRank(clock.st_step));
  if (done >= 3) return null;
  if (done === 2) return "complete";
  if (done === 1) return "arrive";
  return "dispatch";
}

/** Explicit null is finished. Only a missing field falls back to the local next step. */
function shownNext(clock: JobClockState): ClockStep | null {
  if (clock.effective_next_step !== undefined) return clock.effective_next_step;
  return clock.next_step;
}

function localTapAt(clock: JobClockState, id: ClockStep): string | null {
  if (id === "dispatch") return clock.dispatch_at;
  if (id === "arrive") return clock.arrive_at;
  return clock.complete_at;
}

function stepIsDone(clock: JobClockState, id: ClockStep): boolean {
  if (localTapAt(clock, id)) return true;
  return stepRank(clock.st_step) >= stepRank(id);
}

function pickerStreet(job: TodayJob): string {
  const raw = String(job.address || "").trim();
  if (!raw) return "Address not in ServiceTitan";
  const street = raw.split(" - ")[0].split(",")[0].trim();
  return street || raw;
}

function pickerState(job: TodayJob): "Done" | "In progress" | "Next" {
  if (shownNext(job.clock) == null) return "Done";
  if (
    job.clock.dispatch_at ||
    job.clock.arrive_at ||
    job.clock.complete_at ||
    job.clock.st_step
  ) {
    return "In progress";
  }
  return "Next";
}

function pickerLine(job: TodayJob): string {
  const when = formatWhen(job.window_start) || "No time";
  return `${when} - ${pickerStreet(job)} - ${pickerState(job)}`;
}

export function JobClockPage() {
  const { user } = useAuth();
  const allowed = can(user, "useJobClock");
  const [searchParams] = useSearchParams();
  const apptFromUrl = (searchParams.get("appt") || "").trim();
  const arriveBtnRef = useRef<HTMLButtonElement | null>(null);
  const finishBtnRef = useRef<HTMLButtonElement | null>(null);

  const [data, setData] = useState<TodayJobsResponse | null>(null);
  const [assistOn, setAssistOn] = useState(true);
  const [aiOn, setAiOn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  });
  const [busyStep, setBusyStep] = useState<ClockStep | "retry" | null>(null);
  const busyStepRef = useRef<ClockStep | "retry" | null>(null);
  busyStepRef.current = busyStep;
  const loadGen = useRef(0);
  const [busyShop, setBusyShop] = useState(false);
  const [busyDay, setBusyDay] = useState(false);
  const [serverBlock, setServerBlock] = useState<{ apptId: string; jobLabel: string } | null>(null);
  const [toast, setToast] = useState("");
  const [partsGate, setPartsGate] = useState({ ready: true, hold: false });
  const onPartsGate = useCallback((gate: { ready: boolean; hold: boolean }) => {
    setPartsGate((prev) => (prev.ready === gate.ready && prev.hold === gate.hold ? prev : gate));
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!allowed) return;
    const silent = opts?.silent === true;
    if (silent && busyStepRef.current != null) return;
    if (!silent) {
      loadGen.current += 1;
      setLoading(true);
      setError("");
    }
    const gen = loadGen.current;
    try {
      const res = await api<TodayJobsResponse>("/jobs/today");
      if (silent && (busyStepRef.current != null || gen !== loadGen.current)) return;
      setData(res);
      if (silent) setError("");
      const jobs = res.jobs || [];
      const linked = apptFromUrl
        ? jobs.find((j) => j.st_appointment_id === apptFromUrl || jobKey(j) === apptFromUrl)
        : undefined;
      if (!silent && apptFromUrl && jobs.length && !linked) {
        setToast("That appointment is not on today's clock list.");
      }
      setActiveKey((prev) => {
        if (linked) {
          const key = jobKey(linked);
          try {
            sessionStorage.setItem(ACTIVE_KEY, key);
          } catch {
            /* ignore */
          }
          return key;
        }
        const keys = jobs.map(jobKey);
        if (prev && keys.includes(prev)) return prev;
        // Prefer first job that still has a next tap (ST ahead counts).
        const open = jobs.find((j) => shownNext(j.clock) != null);
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
      if (!silent) {
        setError(e instanceof Error ? e.message : "Could not load today's jobs");
        setData(null);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [allowed, apptFromUrl]);

  useEffect(() => {
    if (!allowed) return;
    api<{ tech_assist?: boolean; ai_enabled?: boolean }>("/tech/config")
      .then((d) => {
        setAssistOn(d.tech_assist !== false);
        setAiOn(Boolean(d.ai_enabled));
      })
      .catch(() => {
        setAssistOn(true);
      });
  }, [allowed]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!allowed) return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (busyStepRef.current != null) return;
      void load({ silent: true });
    };
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", tick);
    const timer = window.setInterval(tick, 120000);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", tick);
      window.clearInterval(timer);
    };
  }, [allowed, load]);

  const active = useMemo(() => {
    if (!data?.jobs?.length || !activeKey) return null;
    return data.jobs.find((j) => jobKey(j) === activeKey) || null;
  }, [data, activeKey]);

  const blockingJob = useMemo(() => {
    return (
      (data?.jobs || []).find(
        (job) => job.clock.next_step === "arrive" || job.clock.next_step === "complete"
      ) || null
    );
  }, [data]);

  const focusFinish = (searchParams.get("step") || "") === "complete";
  const deepArrive = Boolean(
    apptFromUrl &&
      active &&
      (active.st_appointment_id === apptFromUrl || jobKey(active) === apptFromUrl)
  );

  useEffect(() => {
    const btn = focusFinish ? finishBtnRef.current : deepArrive ? arriveBtnRef.current : null;
    if (!btn) return;
    btn.scrollIntoView({ block: "center" });
    const step = btn.parentElement;
    if (btn.disabled && step) step.focus();
    else btn.focus();
  }, [deepArrive, focusFinish, active]);

  function selectJob(j: TodayJob) {
    const key = jobKey(j);
    setActiveKey(key);
    try {
      sessionStorage.setItem(ACTIVE_KEY, key);
    } catch {
      /* ignore */
    }
  }

  async function setPermitStatus(status: string) {
    if (!active || busyStep) return;
    setBusyStep("complete");
    setToast("");
    try {
      await api(`/install-permits/${encodeURIComponent(active.st_job_id)}`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      setToast(`Permit set to ${status}`);
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not set permit");
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
      await load();
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Could not retry ST sync");
    } finally {
      setBusyStep(null);
    }
  }

  async function tapStep(step: ClockStep) {
    if (!active || busyStep) return;
    if (shownNext(active.clock) !== step) return;
    if (step === "complete") {
      if (!partsGate.ready) {
        setToast("Parts list is still loading.");
        return;
      }
      if (partsGate.hold) {
        setToast("Save the parts on this stop, or tap No parts on this stop.");
        return;
      }
    }
    busyStepRef.current = step;
    loadGen.current += 1;

    const clientTs = new Date().toISOString();
    // Optimistic UI - never block the tech on network
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
          clock.effective_next_step = effectiveFromClock(clock);
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
          job_number: active.job_number,
          customer_name: active.customer_name,
          address: active.address,
        }),
      });
      if (res.clock) {
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            jobs: prev.jobs.map((j) => {
              if (jobKey(j) !== jobKey(active)) return j;
              const incoming = res.clock!;
              const clock: JobClockState = {
                ...j.clock,
                ...incoming,
                st_step: incoming.st_step ?? j.clock.st_step ?? null,
                st_status: incoming.st_status ?? j.clock.st_status ?? null,
              };
              clock.effective_next_step = effectiveFromClock(clock);
              return { ...j, clock };
            }),
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
      busyStepRef.current = null;
      setBusyStep(null);
    }
  }


  function noteClockBlock(e: unknown): boolean {
    if (!(e instanceof ApiError)) return false;
    const data = e.data as { appt_id?: string; job_label?: string } | undefined;
    if (data?.appt_id) {
      setServerBlock({
        apptId: String(data.appt_id),
        jobLabel: String(data.job_label || "that job"),
      });
    }
    setToast(e.message);
    return true;
  }

  async function clockShop(action: "in" | "out") {
    if (busyShop || busyDay || busyStep) return;
    if (action === "out" && blockingJob) return;
    const clientTs = new Date().toISOString();
    setBusyShop(true);
    setToast("");
    try {
      const res = await api<{
        ok: boolean;
        session?: ShopSession;
        label?: string;
        error?: string;
      }>(action === "in" ? "/clock/shop/in" : "/clock/shop/out", {
        method: "POST",
        body: JSON.stringify(
          action === "in"
            ? { kind: "shop", client_ts: clientTs }
            : { client_ts: clientTs }
        ),
      });
      if (res.session) {
        setData((prev) => (prev ? { ...prev, shop_session: res.session! } : prev));
      }
      setToast(res.label || (action === "in" ? "Shop/Office clocked in" : "Shop/Office clocked out"));
      await load();
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        setToast("Saved offline - will sync when you have signal");
      } else if (noteClockBlock(e)) {
        void load();
      } else {
        setToast(e instanceof Error ? e.message : "Could not save Shop/Office punch");
        void load();
      }
    } finally {
      setBusyShop(false);
    }
  }

  async function clockDayOut() {
    if (busyShop || busyDay || busyStep || blockingJob) return;
    const clientTs = new Date().toISOString();
    setBusyDay(true);
    setToast("");
    try {
      const res = await api<{ ok: boolean; label?: string }>("/clock/day/out", {
        method: "POST",
        body: JSON.stringify({ client_ts: clientTs }),
      });
      setServerBlock(null);
      setToast(res.label || "Clocked out for the day");
      await load();
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        setToast("Saved offline - will sync when you have signal");
      } else if (noteClockBlock(e)) {
        void load();
      } else {
        setToast(e instanceof Error ? e.message : "Could not clock out for the day");
        void load();
      }
    } finally {
      setBusyDay(false);
    }
  }

  const nextId = active ? shownNext(active.clock) : null;
  const nextMeta = STEPS.find((s) => s.id === nextId) || null;
  const permitBlocksFinish =
    nextId === "complete" && Boolean(active?.permit?.required && !active?.permit?.ready);
  const highlightNext =
    (nextId === "complete" && focusFinish) || (nextId === "arrive" && deepArrive && !focusFinish);

  const shopOpen = Boolean(data?.shop_session?.open);

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Clock in / out</h1>
          <p className="muted">Field techs use this page for Dispatch {"\u2192"} Arrive {"\u2192"} Complete.</p>
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
          <h1>Clock in / out</h1>
          <p className="muted">
            Tap the big button at each stop: leave, arrive, finish.
            {data?.today ? ` - ${data.today}` : ""}
          </p>
        </div>
        <button type="button" className="btn secondary" onClick={() => void load()} disabled={loading}>
          {loading ? "Loading..." : "Reload"}
        </button>
      </header>

      <div className="job-clock-policy" role="note">
        <strong>Field App is your clock.</strong> Tap the big button at each stop: leave, arrive, finish.
      </div>
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

      {data ? (
        <div className="card" style={{ marginBottom: "0.85rem", padding: "0.85rem 1rem" }}>
          <button
            type="button"
            className="btn primary"
            disabled={busyDay || busyShop || busyStep != null || !!blockingJob}
            onClick={() => void clockDayOut()}
          >
            {busyDay ? "Saving..." : "Clock out for the day"}
          </button>
          {blockingJob ? (
            <p style={{ margin: "0.55rem 0 0" }}>
              You're still clocked into{" "}
              <Link
                to={`/clock?appt=${encodeURIComponent(jobKey(blockingJob))}&step=complete`}
                onClick={() => selectJob(blockingJob)}
              >
                {jobBlockLabel(blockingJob)}
              </Link>
              . Tap Done or Pause on that job first.
            </p>
          ) : serverBlock ? (
            <p style={{ margin: "0.55rem 0 0" }}>
              You're still clocked into{" "}
              <Link to={`/clock?appt=${encodeURIComponent(serverBlock.apptId)}&step=complete`}>
                {serverBlock.jobLabel}
              </Link>
              . Tap Done or Pause on that job first.
            </p>
          ) : null}
        </div>
      ) : null}

      {loading && !data && <p className="muted">Loading today's jobs...</p>}

      {data && !data.configured && (
        <div className="empty-state job-clock-empty">
          <h2>ServiceTitan not connected</h2>
          <p>{data.message || "Office can add credentials in Admin."}</p>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            You can still clock Shop/Office on Field App (no ST job).
          </p>
          {shopOpen ? (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={busyShop || busyDay || busyStep != null || !!blockingJob}
              onClick={() => void clockShop("out")}
            >
              {busyShop ? "Saving..." : "Clock out - Shop / Office"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={busyShop || busyDay || busyStep != null}
              onClick={() => void clockShop("in")}
            >
              {busyShop ? "Saving..." : "Shop / Office"}
            </button>
          )}
        </div>
      )}

      {data && data.configured && !data.technician_id && (
        <div className="empty-state job-clock-empty">
          <h2>No technician linked</h2>
          <p>
            {data.message ||
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
              Ask office to open <strong>People</strong> {"\u2192"} your login {"\u2192"} set{" "}
              <strong>ST technician ID</strong>.
            </p>
          )}
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            Still need to clock Shop/Office time? Use the button below (no ST job created).
          </p>
          {shopOpen ? (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={busyShop || busyDay || busyStep != null || !!blockingJob}
              onClick={() => void clockShop("out")}
            >
              {busyShop ? "Saving..." : "Clock out - Shop / Office"}
            </button>
          ) : (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={busyShop || busyDay || busyStep != null}
              onClick={() => void clockShop("in")}
            >
              {busyShop ? "Saving..." : "Shop / Office"}
            </button>
          )}
        </div>
      )}

      {data && data.configured && data.technician_id && !(data.jobs || []).length && (
        <div className="empty-state job-clock-empty">
          <h2>No jobs today</h2>
          <p>{data.message || "Nothing on your ServiceTitan schedule for today."}</p>
          <p className="muted" style={{ marginTop: "0.5rem" }}>
            Working at the shop or office? Clock in here - no job required.
          </p>
          {shopOpen ? (
            <div className="job-clock-shop-panel">
              <p>
                <strong>Shop / Office</strong> clocked in{" "}
                {formatWhen(data.shop_session?.clock_in_at)}
              </p>
              <button
                type="button"
                className="btn primary job-clock-shop-btn"
                disabled={busyShop || busyDay || busyStep != null || !!blockingJob}
                onClick={() => void clockShop("out")}
              >
                {busyShop ? "Saving..." : "Clock out - Shop / Office"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn primary job-clock-shop-btn"
              disabled={busyShop || busyDay || busyStep != null}
              onClick={() => void clockShop("in")}
            >
              {busyShop ? "Saving..." : "Shop / Office"}
            </button>
          )}
          <p className="muted" style={{ marginTop: "0.65rem", fontSize: "0.85rem" }}>
            Field App only for now - does not create a ServiceTitan job.
          </p>
        </div>
      )}


      {data && data.configured && data.technician_id && (data.jobs || []).length > 0 && shopOpen && (
        <div className="job-clock-shop-banner card" role="status">
          <strong>Shop / Office</strong> still clocked in ({formatWhen(data.shop_session?.clock_in_at)}).
          <button
            type="button"
            className="btn secondary"
            style={{ marginLeft: "0.75rem" }}
            disabled={busyShop || busyDay || busyStep != null || !!blockingJob}
            onClick={() => void clockShop("out")}
          >
            {busyShop ? "Saving..." : "Clock out"}
          </button>
        </div>
      )}

      {data && (data.jobs || []).length > 0 && (
        <div className={`job-clock-layout${(data.jobs || []).length > 1 ? "" : " is-single"}`}>
          {(data.jobs || []).length > 1 && (
          <section className="job-clock-list" aria-label="Today's jobs">
            <h2 className="job-clock-section-title">Today</h2>
            <ul className="job-clock-job-list">
              {(data.jobs || []).map((j) => {
                const key = jobKey(j);
                const isActive = key === activeKey;
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={`job-clock-job-btn${isActive ? " is-active" : ""}`}
                      onClick={() => selectJob(j)}
                    >
                      {pickerLine(j)}
                      {(j.job_notes || []).some((n) => n.code === "SOLDER") ? (
                        <span className="job-note-chip">SOLDER</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
          )}

          {active && (
            <section className="job-clock-active card" aria-label="Active job clock">
              <p className="job-clock-address">{addressLine(active)}</p>
              <p className="muted">{formatWindow(active.window_start, active.window_end)}</p>
              <p className="job-clock-customer">
                <strong>{active.customer_name || "Customer name not in ServiceTitan"}</strong>
              </p>
              {billToName(active) ? (
                <p className="muted job-clock-bill-to">Bill to: {billToName(active)}</p>
              ) : null}
              {active.last_visit_on && formatVisitDate(active.last_visit_on) ? (
                <p className="muted job-clock-last-visit">
                  Last visit: {formatVisitDate(active.last_visit_on)}
                </p>
              ) : null}
              {active.customer_phone ? (
                <p className="job-clock-phone">
                  <a href={`tel:${active.customer_phone.replace(/[^\d+]/g, "")}`}>{active.customer_phone}</a>
                </p>
              ) : null}
              {active.access_code ? (
                <p className="job-clock-access">
                  <strong>Gate / entry:</strong> {active.access_code}
                </p>
              ) : null}
              {assistOn
                ? (active.job_notes || []).map((n) => (
                    <div key={n.code} className={`job-note job-note-${n.level}`} role="note">
                      <strong>{n.level === "bring" ? "Bring:" : n.level === "heads_up" ? "Heads up:" : "Talk:"}</strong> {n.text}
                    </div>
                  ))
                : null}
              {typeBuLine(active) ? (
                <p className="muted job-clock-type-line">{typeBuLine(active)}</p>
              ) : null}
              {usualAboutLine(active.job_type) ? (
                <p className="muted job-clock-usual">{usualAboutLine(active.job_type)}</p>
              ) : null}
              {active.job_number ? (
                <p className="muted job-clock-type-line">#{active.job_number}</p>
              ) : null}
              {active.note ? (
                <p className="job-clock-note">{active.note}</p>
              ) : null}

              {(active.clock.st_status || active.st_appointment_status) ? (
                <p>
                  <span className="job-clock-st-pill">
                    ServiceTitan: {active.clock.st_status || active.st_appointment_status}
                  </span>
                </p>
              ) : null}
              {STEPS.some((s) => stepIsDone(active.clock, s.id)) ? (
                <ul className="job-clock-done-list">
                  {STEPS.filter((s) => stepIsDone(active.clock, s.id)).map((s) => {
                    const tapped = localTapAt(active.clock, s.id);
                    return (
                      <li key={s.id} className="job-clock-done-row">
                        {"\u2713"} {s.doneLabel}
                        {tapped ? ` ${formatWhen(tapped)}` : " (in ServiceTitan)"}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {active.permit?.required && !active.permit.ready && (
                <div className="job-clock-permit-gate" role="alert" style={{
                  marginBottom: "0.75rem",
                  padding: "0.65rem 0.75rem",
                  borderRadius: 8,
                  background: "#fef3c7",
                  border: "1px solid #f59e0b",
                  color: "#78350f",
                  fontSize: "0.92rem",
                }}>
                  <strong>Permit gate</strong>
                  {active.job_type || active.permit.job_type
                    ? ` (${active.job_type || active.permit.job_type})`
                    : ""}
                  : Complete is blocked until permit is on truck, on site, or N/A.
                  {active.permit.message ? (
                    <div style={{ marginTop: 4 }}>{active.permit.message}</div>
                  ) : null}
                  {can(user, "manageInstallPermit") ? (
                    <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {(["on_truck", "on_site", "na", "at_city", "missing"] as const).map((st) => (
                        <button
                          key={st}
                          type="button"
                          className="btn secondary"
                          style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                          disabled={busyStep != null}
                          onClick={() => void setPermitStatus(st)}
                        >
                          {st}
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
              {active.permit?.required && active.permit.ready && (
                <p className="muted" style={{ marginBottom: "0.5rem" }}>
                  Permit OK ({active.permit.status || "ready"}
                  {active.permit.source ? ` via ${active.permit.source}` : ""}).
                </p>
              )}
              {assistOn && active.st_job_id ? (
                <>
                  <JobBriefCard stJobId={active.st_job_id} aiEnabled={aiOn} />
                  <EquipmentSnap stJobId={active.st_job_id} />
                  {stepIsDone(active.clock, "arrive") ? <WrapUpCard stJobId={active.st_job_id} /> : null}
                </>
              ) : null}
              <PartsUsedPanel
                ask={nextId === "complete"}
                onGate={onPartsGate}
                jobRef={String(active.job_number || active.st_job_id || "").replace(/^#/, "")}
                appointmentId={active.st_appointment_id}
              />
              {nextMeta && nextId ? (
                <div
                  tabIndex={highlightNext ? -1 : undefined}
                  style={
                    highlightNext
                      ? { outline: "2px solid var(--ink)", outlineOffset: 3, borderRadius: 8 }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    ref={
                      nextId === "arrive" ? arriveBtnRef : nextId === "complete" ? finishBtnRef : undefined
                    }
                    id={
                      nextId === "arrive"
                        ? "job-clock-arrive"
                        : nextId === "complete"
                          ? "job-clock-finish"
                          : undefined
                    }
                    className="btn primary job-clock-next-btn"
                    disabled={busyStep != null || permitBlocksFinish}
                    onClick={() => void tapStep(nextId)}
                  >
                    {busyStep === nextId ? "Saving..." : nextMeta.nextLabel}
                  </button>
                </div>
              ) : (
                <p className="job-clock-done-row">Done for this stop</p>
              )}
              {active.clock.sync_status === "error" && (
                <div className="job-clock-sync-error" role="alert">
                  <strong>ServiceTitan did not take this punch.</strong>
                  <div>
                    {active.clock.sync_error ||
                      "Office can set the same step on the job in ST, then retry."}
                  </div>
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
