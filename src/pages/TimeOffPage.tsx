import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

type TimeOffStatus = "pending" | "approved" | "declined" | "cancelled";
type TimeOffType = "pto" | "sick" | "personal" | "unpaid" | "other";

interface TimeOffRequest {
  id: number;
  user_id: number;
  manager_user_id: number | null;
  start_date: string;
  end_date: string;
  request_type: TimeOffType | string;
  reason: string | null;
  status: TimeOffStatus;
  manager_remarks: string | null;
  decided_at: string | null;
  created_at: string;
  employee_name?: string | null;
  manager_name?: string | null;
  decided_by_name?: string | null;
}

const TYPE_OPTIONS: { value: TimeOffType; label: string }[] = [
  { value: "pto", label: "PTO / vacation" },
  { value: "sick", label: "Sick" },
  { value: "personal", label: "Personal" },
  { value: "unpaid", label: "Unpaid" },
  { value: "other", label: "Other" },
];

function typeLabel(t: string): string {
  return TYPE_OPTIONS.find((x) => x.value === t)?.label || t;
}

function statusLabel(s: string): string {
  if (s === "pending") return "Pending";
  if (s === "approved") return "Approved";
  if (s === "declined") return "Declined";
  if (s === "cancelled") return "Cancelled";
  return s;
}

function formatRange(start: string, end: string): string {
  if (start === end) return start;
  return `${start} → ${end}`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Request time off (everyone) and approve/decline (managers / office / admin).
 */
export function TimeOffPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"mine" | "approvals">("mine");
  const [mine, setMine] = useState<TimeOffRequest[]>([]);
  const [approvals, setApprovals] = useState<TimeOffRequest[]>([]);
  const [isManager, setIsManager] = useState(false);
  const [pendingForMe, setPendingForMe] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);

  const [startDate, setStartDate] = useState(todayIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [requestType, setRequestType] = useState<TimeOffType>("pto");
  const [reason, setReason] = useState("");

  const [decideId, setDecideId] = useState<number | null>(null);
  const [decideAction, setDecideAction] = useState<"approved" | "declined">("approved");
  const [remarks, setRemarks] = useState("");

  const canSeeAllApprovals =
    user?.role === "admin" || user?.role === "office" || can(user, "manageUsers");

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, a] = await Promise.all([
        api<{
          requests: TimeOffRequest[];
          is_manager?: boolean;
          pending_for_me?: number;
          error?: string;
        }>("/time-off?view=mine"),
        api<{
          requests: TimeOffRequest[];
          is_manager?: boolean;
          pending_for_me?: number;
        }>("/time-off?view=approvals").catch(() => ({
          requests: [] as TimeOffRequest[],
          is_manager: false,
          pending_for_me: 0,
        })),
      ]);
      if (m.error) setError(m.error);
      setMine(m.requests || []);
      setApprovals(a.requests || []);
      setIsManager(Boolean(m.is_manager || a.is_manager || canSeeAllApprovals));
      setPendingForMe(a.pending_for_me ?? m.pending_for_me ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load time-off");
    }
  }, [canSeeAllApprovals]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deep-link from notification: open approvals if manager
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "approvals" && isManager) setTab("approvals");
  }, [isManager]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/time-off", {
        method: "POST",
        body: JSON.stringify({
          start_date: startDate,
          end_date: endDate || startDate,
          request_type: requestType,
          reason: reason.trim() || null,
        }),
      });
      setOk("Request sent to your manager for approval.");
      setReason("");
      setShowForm(false);
      setTab("mine");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit");
    } finally {
      setBusy(false);
    }
  }

  async function cancelRequest(id: number) {
    if (!window.confirm("Cancel this pending time-off request?")) return;
    setActingId(id);
    setError("");
    try {
      await api(`/time-off/${id}/cancel`, { method: "POST", body: "{}" });
      setOk("Request cancelled.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActingId(null);
    }
  }

  function openDecide(r: TimeOffRequest, action: "approved" | "declined") {
    setDecideId(r.id);
    setDecideAction(action);
    setRemarks("");
  }

  async function submitDecision(e: FormEvent) {
    e.preventDefault();
    if (decideId == null) return;
    setActingId(decideId);
    setError("");
    setOk("");
    try {
      await api(`/time-off/${decideId}/decide`, {
        method: "POST",
        body: JSON.stringify({
          decision: decideAction,
          remarks: remarks.trim() || null,
        }),
      });
      setOk(
        decideAction === "approved"
          ? "Approved — employee was notified."
          : "Declined — employee was notified."
      );
      setDecideId(null);
      setRemarks("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save decision");
    } finally {
      setActingId(null);
    }
  }

  const pendingApprovals = useMemo(
    () => approvals.filter((r) => r.status === "pending"),
    [approvals]
  );
  const recentDecided = useMemo(
    () => approvals.filter((r) => r.status === "approved" || r.status === "declined"),
    [approvals]
  );

  return (
    <div className="page time-off-page">
      <div className="page-header">
        <div>
          <h1>Time off request</h1>
          <p>
            Request days off from the app. Your manager reviews and you’ll get a notification when
            they approve or decline{isManager ? " — use Approvals for your team" : ""}.
          </p>
        </div>
        <div className="toolbar no-print">
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Hide form" : "New request"}
          </button>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <div className="filters no-print" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={`chip ${tab === "mine" ? "active" : ""}`}
          onClick={() => setTab("mine")}
        >
          My requests
        </button>
        {isManager && (
          <button
            type="button"
            className={`chip ${tab === "approvals" ? "active" : ""}`}
            onClick={() => setTab("approvals")}
          >
            Approvals{pendingForMe ? ` (${pendingForMe})` : ""}
          </button>
        )}
      </div>

      {showForm && tab === "mine" && (
        <form className="card form" onSubmit={submit} style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>New time off request</h2>
          <div className="form row">
            <label>
              Type
              <select
                value={requestType}
                onChange={(e) => setRequestType(e.target.value as TimeOffType)}
              >
                {TYPE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Start date
              <input
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (endDate < e.target.value) setEndDate(e.target.value);
                }}
                required
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
              />
            </label>
          </div>
          <label>
            Reason / notes <span className="muted">(optional — helps your manager)</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g. Family trip · doctor appointment"
            />
          </label>
          <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
            Goes to your assigned manager
            {user?.role === "admin" || user?.role === "office"
              ? " (or office/admin if no manager is set)"
              : " in People / Admin. If none is set, office/admin is notified."}
            .
          </p>
          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Submit for approval"}
            </button>
          </div>
        </form>
      )}

      {tab === "mine" && (
        <section className="time-off-list">
          {!mine.length ? (
            <div className="card muted">No time-off requests yet. Use the form above to start one.</div>
          ) : (
            mine.map((r) => (
              <article key={r.id} className={`card time-off-card st-${r.status}`}>
                <div className="time-off-card-head">
                  <strong>{typeLabel(r.request_type)}</strong>
                  <span className={`time-off-status st-${r.status}`}>{statusLabel(r.status)}</span>
                </div>
                <p className="time-off-range">{formatRange(r.start_date, r.end_date)}</p>
                {r.reason && <p className="muted time-off-reason">{r.reason}</p>}
                {r.manager_name && (
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
                    Manager: {r.manager_name}
                  </p>
                )}
                {r.status !== "pending" && r.manager_remarks && (
                  <div className="time-off-remarks">
                    <strong>Manager remarks:</strong> {r.manager_remarks}
                  </div>
                )}
                {r.status === "pending" && (
                  <div className="toolbar" style={{ marginTop: "0.55rem" }}>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={actingId === r.id}
                      onClick={() => void cancelRequest(r.id)}
                    >
                      Cancel request
                    </button>
                  </div>
                )}
                <p className="muted" style={{ fontSize: "0.75rem", margin: "0.4rem 0 0" }}>
                  Submitted {String(r.created_at).replace("T", " ").slice(0, 16)}
                  {r.decided_at
                    ? ` · decided ${String(r.decided_at).replace("T", " ").slice(0, 16)}`
                    : ""}
                </p>
              </article>
            ))
          )}
        </section>
      )}

      {tab === "approvals" && isManager && (
        <section className="time-off-list">
          <h2 className="time-off-section-title">
            Waiting for you{pendingApprovals.length ? ` (${pendingApprovals.length})` : ""}
          </h2>
          {!pendingApprovals.length ? (
            <div className="card muted">No pending requests for your team.</div>
          ) : (
            pendingApprovals.map((r) => (
              <article key={r.id} className="card time-off-card st-pending">
                <div className="time-off-card-head">
                  <strong>{r.employee_name || "Employee"}</strong>
                  <span className="time-off-status st-pending">Pending</span>
                </div>
                <p className="time-off-range">
                  {typeLabel(r.request_type)} · {formatRange(r.start_date, r.end_date)}
                </p>
                {r.reason && <p className="muted time-off-reason">{r.reason}</p>}
                {decideId === r.id ? (
                  <form className="form" onSubmit={submitDecision} style={{ marginTop: "0.65rem" }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      {decideAction === "approved" ? "Approve" : "Decline"} this request
                    </p>
                    <label>
                      Remarks <span className="muted">(optional — employee will see this)</span>
                      <textarea
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        rows={2}
                        placeholder={
                          decideAction === "approved"
                            ? "e.g. Enjoy your time off — coverage noted"
                            : "e.g. Need coverage that week — can you shift dates?"
                        }
                      />
                    </label>
                    <div className="toolbar">
                      <button className="btn btn-sm" type="submit" disabled={actingId === r.id}>
                        {actingId === r.id
                          ? "Saving…"
                          : decideAction === "approved"
                            ? "Confirm approve"
                            : "Confirm decline"}
                      </button>
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        onClick={() => setDecideId(null)}
                      >
                        Back
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="toolbar" style={{ marginTop: "0.55rem" }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => openDecide(r, "approved")}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      onClick={() => openDecide(r, "declined")}
                    >
                      Decline
                    </button>
                  </div>
                )}
              </article>
            ))
          )}

          {recentDecided.length > 0 && (
            <>
              <h2 className="time-off-section-title" style={{ marginTop: "1.25rem" }}>
                Recently decided
              </h2>
              {recentDecided.map((r) => (
                <article key={r.id} className={`card time-off-card st-${r.status}`}>
                  <div className="time-off-card-head">
                    <strong>{r.employee_name || "Employee"}</strong>
                    <span className={`time-off-status st-${r.status}`}>
                      {statusLabel(r.status)}
                    </span>
                  </div>
                  <p className="time-off-range">
                    {typeLabel(r.request_type)} · {formatRange(r.start_date, r.end_date)}
                  </p>
                  {r.manager_remarks && (
                    <div className="time-off-remarks">
                      <strong>Remarks:</strong> {r.manager_remarks}
                    </div>
                  )}
                  <p className="muted" style={{ fontSize: "0.75rem", margin: "0.35rem 0 0" }}>
                    {r.decided_by_name ? `By ${r.decided_by_name}` : ""}
                    {r.decided_at
                      ? ` · ${String(r.decided_at).replace("T", " ").slice(0, 16)}`
                      : ""}
                  </p>
                </article>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}
