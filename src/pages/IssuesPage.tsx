import { FormEvent, useEffect, useRef, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { DRIVER_ISSUE_OPTIONS, MECHANIC_DIAGNOSIS, driverIssueLabel } from "../issueCatalog";
import {
  buildIssuePush,
  publishNtfyFromClient,
  reportClientPushResult,
  type ClientPushPayload,
} from "../ntfyClient";
import type { Vehicle } from "./VehiclesPage";

interface Issue {
  id: number;
  vehicle_id: number;
  unit_number: string;
  reporter_name: string;
  severity: string;
  title: string;
  description: string | null;
  status: string;
  scheduled_date: string | null;
  schedule_notes: string | null;
  completion_notes: string | null;
  issue_category: string | null;
  is_emergency: number;
  mechanic_diagnosis: string | null;
  work_performed: string | null;
  parts_used: string | null;
  labor_hours: number | null;
  created_at: string;
}

interface CommonRow {
  category: string;
  count: number;
  emergencies: number;
}

export function IssuesPage() {
  const { user } = useAuth();
  const isDriver = user?.role === "driver";
  const isOffice = user?.role === "office";
  /** Full shop tools: mechanic/admin — not office (they only need the schedule view) */
  const isMechanic = can(user, "manageIssues") && !isOffice;
  const [issues, setIssues] = useState<Issue[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [common, setCommon] = useState<CommonRow[]>([]);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [manage, setManage] = useState<Issue | null>(null);

  const [vehicleId, setVehicleId] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [isEmergency, setIsEmergency] = useState(false);

  const [mStatus, setMStatus] = useState("scheduled");
  const [mDate, setMDate] = useState("");
  const [mNotes, setMNotes] = useState("");
  const [mDiagnosis, setMDiagnosis] = useState("");
  const [mWork, setMWork] = useState("");
  const [mParts, setMParts] = useState("");
  const [mLabor, setMLabor] = useState("");
  const [mCompletion, setMCompletion] = useState("");
  const [mSeverity, setMSeverity] = useState("medium");
  const [recordOil, setRecordOil] = useState(false);
  const [oilOdo, setOilOdo] = useState("");
  const [oilInterval, setOilInterval] = useState("5000");
  const [oilDue, setOilDue] = useState<
    Array<{
      vehicle_id: number;
      unit_number: string;
      current_odometer: number | null;
      next_due_odometer: number | null;
      due_soon: number;
      last_service_date: string | null;
    }>
  >([]);
  const [smsConfigured, setSmsConfigured] = useState(false);
  const [smsContacts, setSmsContacts] = useState<
    Array<{ user_id: number | null; name: string; phone: string; unit_number?: string | null }>
  >([]);
  const [smsTo, setSmsTo] = useState("");
  const [smsMsg, setSmsMsg] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** Sync lock — React state alone can miss double-taps before re-render */
  const submitLock = useRef(false);

  async function load() {
    const q = filter === "active" ? "?report=schedule" : filter === "all" ? "" : `?status=${filter}`;
    const [iss, vehs] = await Promise.all([
      api<{ issues: Issue[] }>(`/issues${q}`),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
    ]);
    setIssues(iss.issues);
    setVehicles(vehs.vehicles);
    if (isMechanic) {
      try {
        const c = await api<{ common: CommonRow[] }>("/issues/common?days=90");
        setCommon(c.common || []);
      } catch {
        setCommon([]);
      }
      try {
        const od = await api<{
          vehicles: Array<{
            vehicle_id: number;
            unit_number: string;
            current_odometer: number | null;
            next_due_odometer: number | null;
            due_soon: number;
            last_service_date: string | null;
          }>;
        }>("/service/due");
        setOilDue((od.vehicles || []).filter((v) => v.due_soon));
      } catch {
        setOilDue([]);
      }
      try {
        const s = await api<{
          configured: boolean;
          contacts: Array<{
            user_id: number | null;
            name: string;
            phone: string;
            unit_number?: string | null;
          }>;
        }>("/sms/contacts");
        setSmsConfigured(s.configured);
        setSmsContacts(s.contacts || []);
      } catch {
        setSmsConfigured(false);
        setSmsContacts([]);
      }
    }
  }

  async function sendShopText(e: FormEvent) {
    e.preventDefault();
    if (!smsMsg.trim() || !smsTo) return;
    setSmsBusy(true);
    setError("");
    try {
      const payload: { message: string; to_user_id?: number; to_phone?: string; context?: string } = {
        message: smsMsg.trim(),
        context: manage ? `issue:${manage.id}` : "shop_board",
      };
      if (smsTo.startsWith("u:")) payload.to_user_id = Number(smsTo.slice(2));
      else payload.to_phone = smsTo.slice(2);
      await api("/sms/send", { method: "POST", body: JSON.stringify(payload) });
      setSmsMsg("");
      setOk("Text sent to driver.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "SMS failed");
    } finally {
      setSmsBusy(false);
    }
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [filter]);

  useEffect(() => {
    const opt = DRIVER_ISSUE_OPTIONS.find((o) => o.value === category);
    if (opt?.emergency) setIsEmergency(true);
  }, [category]);

  async function createIssue(e: FormEvent) {
    e.preventDefault();
    // Hard lock: ignore double-taps / Enter while request in flight
    if (submitLock.current || submitting) return;
    setError("");
    setOk("");
    if (!category) {
      setError("Pick what seems wrong from the list.");
      return;
    }
    if (category === "other" && !description.trim()) {
      setError("Please describe the issue.");
      return;
    }
    if (!vehicleId) {
      setError("Pick your vehicle unit.");
      return;
    }
    const opt = DRIVER_ISSUE_OPTIONS.find((o) => o.value === category);
    const emergency = Boolean(isEmergency || opt?.emergency);
    const unitNumber =
      vehicles.find((v) => v.id === Number(vehicleId))?.unit_number || "?";
    const issueTitle = opt?.label || category;

    // Same path as Settings "Send test" — publish from THIS phone, immediately.
    // Do not wait for the API (server cannot reach ntfy reliably).
    const localPush = buildIssuePush({
      unitNumber,
      title: issueTitle,
      description,
      reporterName: user?.display_name,
      emergency,
    });

    submitLock.current = true;
    setSubmitting(true);
    try {
      // Save ticket first, then ONE phone push (never double-publish)
      const res = await api<{
        message?: string;
        emergency?: boolean;
        duplicate?: boolean;
        notified_user_ids?: number[];
        ntfy?: boolean;
        ntfy_detail?: string;
        client_push?: ClientPushPayload;
      }>("/issues", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          issue_category: category,
          title: issueTitle,
          description: description || null,
          is_emergency: emergency,
          severity: emergency ? "critical" : opt?.severity || "medium",
        }),
      });

      // Prefer server payload (correct topic); fall back to local. Exactly one publish.
      const payload = res.client_push || localPush;
      const push = await publishNtfyFromClient(payload);
      void reportClientPushResult(api, push);

      setShowNew(false);
      setCategory("");
      setDescription("");
      setIsEmergency(false);

      const baseMsg =
        res.message ||
        (emergency
          ? "Emergency dispatched — shop notified."
          : "Repair request submitted — shop notified.");
      const pushNote = push.ok
        ? " Phone push sent."
        : ` Phone push failed (${push.detail}). Shop still has it in the app.`;
      setOk(baseMsg.replace(/\s*Sending phone push…?\s*$/i, "").trim() + pushNote);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send — try again.");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  function openManage(issue: Issue) {
    setManage(issue);
    setMStatus(issue.status === "open" ? "scheduled" : issue.status);
    setMDate(issue.scheduled_date || "");
    setMNotes(issue.schedule_notes || "");
    setMDiagnosis(issue.mechanic_diagnosis || (issue.issue_category === "oil_change" ? "Oil change" : ""));
    setMWork(issue.work_performed || "");
    setMParts(issue.parts_used || "");
    setMLabor(issue.labor_hours != null ? String(issue.labor_hours) : "");
    setMCompletion(issue.completion_notes || "");
    setMSeverity(issue.severity);
    setRecordOil(issue.issue_category === "oil_change" || issue.title.toLowerCase().includes("oil change"));
    const veh = vehicles.find((v) => v.id === issue.vehicle_id);
    setOilOdo(
      veh?.current_odometer != null ? String(veh.current_odometer) : ""
    );
    setOilInterval("5000");
  }

  async function saveManage(e: FormEvent) {
    e.preventDefault();
    if (!manage) return;
    try {
      await api(`/issues/${manage.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: mStatus,
          scheduled_date: mDate || null,
          schedule_notes: mNotes || null,
          completion_notes: mCompletion || null,
          mechanic_diagnosis: mDiagnosis || null,
          work_performed: mWork || null,
          parts_used: mParts || null,
          labor_hours: mLabor === "" ? null : Number(mLabor),
          severity: mSeverity,
          record_oil_change: recordOil,
          oil_odometer: recordOil && oilOdo !== "" ? Number(oilOdo) : null,
          oil_interval_miles: recordOil ? Number(oilInterval) || 5000 : null,
        }),
      });
      setManage(null);
      setOk(
        recordOil && oilOdo
          ? `Saved. Next oil change ~${(Number(oilOdo) + (Number(oilInterval) || 5000)).toLocaleString()} mi.`
          : "Repair record saved."
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>
            {isDriver
              ? "Request a repair"
              : isOffice
                ? "Scheduled repairs"
                : "Repairs & shop board"}
          </h1>
          <p>
            {isDriver
              ? "Tell us what’s wrong — pick from the list. Flat tires go out as emergency."
              : isOffice
                ? "What’s open or booked for the shop — units that may be down."
                : "Triage driver requests, document real diagnosis, schedule & complete work."}
          </p>
        </div>
        <div className="toolbar no-print">
          {can(user, "reportIssues") && !isOffice && (
            <button className="btn" onClick={() => setShowNew(true)}>
              {isDriver ? "New request" : "Report issue"}
            </button>
          )}
          {isMechanic && (
            <button className="btn secondary" onClick={() => window.print()}>
              Print work list
            </button>
          )}
        </div>
      </div>

      {ok && <div className="success" style={{ marginBottom: "1rem" }}>{ok}</div>}
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {isMechanic && oilDue.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>Oil changes due (by mileage)</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
            Auto-tracked from the last oil change + interval. When fuel odometer hits the due
            mileage, a shop job is scheduled. Adjust interval when you complete the work.
          </p>
          <ul className="home-feed">
            {oilDue.slice(0, 8).map((v) => (
              <li key={v.vehicle_id}>
                <span className="home-feed-main">
                  <strong>Unit {v.unit_number}</strong>
                  {v.current_odometer != null ? ` · ${v.current_odometer.toLocaleString()} mi` : ""}
                </span>
                <span className="home-feed-meta">
                  Next due {v.next_due_odometer != null ? `${v.next_due_odometer.toLocaleString()} mi` : "—"}
                  {v.last_service_date ? ` · last ${v.last_service_date}` : " · no prior service on file"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isMechanic && common.length > 0 && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>Common problems (90 days)</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
            Repeated categories help spot fleet-wide issues (tires, batteries, etc.).
          </p>
          <div className="common-tags">
            {common.slice(0, 8).map((c) => (
              <span key={c.category} className="common-tag">
                <strong>{driverIssueLabel(c.category)}</strong>
                <span className="muted"> ×{c.count}</span>
                {c.emergencies > 0 && (
                  <span className="badge critical" style={{ marginLeft: "0.35rem" }}>
                    {c.emergencies} emerg.
                  </span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}

      {isMechanic && filter === "active" && (
        <div className="info-banner" style={{ marginBottom: "1rem" }}>
          <strong>Scheduled / in progress</strong> marks the unit out of service and starts downtime.
          Complete work to clear downtime. Use diagnosis + work performed for real shop tracking —
          drivers only pick a simple issue type.
        </div>
      )}

      <div className="filters no-print">
        {(isDriver
          ? [
              ["active", "Open for me"],
              ["completed", "Done"],
              ["all", "All"],
            ]
          : isOffice
            ? [
                ["active", "On the board"],
                ["scheduled", "Scheduled"],
                ["in_progress", "In progress"],
                ["completed", "Completed"],
              ]
            : [
                ["active", "Needs work"],
                ["open", "Open"],
                ["scheduled", "Scheduled"],
                ["in_progress", "In progress"],
                ["completed", "Completed"],
                ["all", "All"],
              ]
        ).map(([k, label]) => (
          <button
            key={k}
            className={`chip ${filter === k ? "active" : ""}`}
            onClick={() => setFilter(k)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      <LogList className="shop-board log-list" empty="No issues in this view.">
        {issues.map((i) => {
          const when = i.scheduled_date || i.created_at?.slice(0, 10) || "—";
          const shopNote = i.mechanic_diagnosis || i.work_performed || "";
          const tone = i.is_emergency
            ? "urgent"
            : i.severity === "critical" || i.severity === "high"
              ? "bad"
              : i.status === "completed"
                ? "done"
                : undefined;
          return (
            <LogItem
              key={i.id}
              tone={tone}
              defaultOpen={!!i.is_emergency}
              summary={
                <>
                  <strong>Unit {i.unit_number}</strong>
                  {!!i.is_emergency && <span className="log-item-badge">Emergency</span>}
                  <span className="log-item-badge">{i.status.replace(/_/g, " ")}</span>
                  <span className="log-item-meta">{i.title}</span>
                  <span className="log-item-meta">{when}</span>
                </>
              }
            >
              {i.issue_category && (
                <div className="muted">{driverIssueLabel(i.issue_category)}</div>
              )}
              {i.description && <div>{i.description}</div>}
              {!isDriver && shopNote && (
                <div>
                  <span className="muted">Shop notes: </span>
                  {shopNote}
                </div>
              )}
              <div className="muted">
                By {i.reporter_name} · {i.severity}
              </div>
              {isMechanic && (
                <div className="log-item-actions">
                  <button
                    className="btn no-print"
                    type="button"
                    onClick={() => openManage(i)}
                  >
                    Shop work
                  </button>
                </div>
              )}
            </LogItem>
          );
        })}
      </LogList>

      {showNew && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!submitting) setShowNew(false);
          }}
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{isDriver ? "What’s wrong?" : "Report vehicle issue"}</h2>
            <form className="form" onSubmit={createIssue}>
              <label>
                Vehicle
                <select
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  required
                  disabled={submitting}
                >
                  <option value="">Select…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.unit_number}
                      {v.assigned_driver ? ` — ${v.assigned_driver}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Most common issues
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  required
                  disabled={submitting}
                >
                  <option value="">Select…</option>
                  {DRIVER_ISSUE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.emergency ? "🚨 " : ""}
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              {(category === "flat_tire" || isEmergency) && (
                <div className="error" style={{ margin: 0 }}>
                  <strong>Emergency</strong> — this notifies the mechanic, office, and admin right
                  away (and free phone push if ntfy is set up).
                </div>
              )}
              <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={isEmergency}
                  onChange={(e) => setIsEmergency(e.target.checked)}
                  disabled={submitting}
                />
                This is an emergency (roadside / unsafe)
              </label>
              <label>
                {isDriver ? "Extra details (optional)" : "Description"}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={
                    isDriver
                      ? "Where are you? What happened? Any warning lights?"
                      : "Notes"
                  }
                  required={category === "other"}
                  disabled={submitting}
                />
              </label>
              {submitting && (
                <div className="info-banner" role="status" aria-live="polite">
                  {isEmergency || DRIVER_ISSUE_OPTIONS.find((o) => o.value === category)?.emergency
                    ? "Dispatching emergency — notifying mechanic and office…"
                    : "Sending request to the shop…"}
                </div>
              )}
              <div className="toolbar">
                <button
                  className={`btn${isEmergency || category === "flat_tire" ? " btn-emergency" : ""}`}
                  type="submit"
                  disabled={submitting}
                >
                  {submitting
                    ? isEmergency || category === "flat_tire"
                      ? "Dispatching emergency…"
                      : "Sending…"
                    : isEmergency || category === "flat_tire"
                      ? "Dispatch emergency"
                      : "Submit request"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={submitting}
                  onClick={() => setShowNew(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {manage && (
        <div className="modal-backdrop" onClick={() => setManage(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>
              Shop work · Unit {manage.unit_number}
            </h2>
            <p style={{ marginTop: 0 }}>
              <strong>Driver said:</strong> {manage.title}
              {manage.description ? ` — ${manage.description}` : ""}
            </p>
            {isMechanic && smsConfigured && smsContacts.length > 0 && (
              <form
                className="form"
                onSubmit={sendShopText}
                style={{
                  marginBottom: "1rem",
                  padding: "0.75rem",
                  borderRadius: 12,
                  border: "1px solid var(--line)",
                  background: "var(--bg)",
                }}
              >
                <strong style={{ fontSize: "0.9rem" }}>Text the driver</strong>
                <label>
                  To
                  <select value={smsTo} onChange={(e) => setSmsTo(e.target.value)} required>
                    <option value="">Select driver…</option>
                    {smsContacts.map((c, i) => (
                      <option
                        key={`${c.user_id ?? c.phone}-${i}`}
                        value={c.user_id ? `u:${c.user_id}` : `p:${c.phone}`}
                      >
                        {c.name}
                        {c.unit_number ? ` · ${c.unit_number}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Message
                  <input
                    value={smsMsg}
                    onChange={(e) => setSmsMsg(e.target.value)}
                    placeholder={`Re: unit ${manage.unit_number} — where are you?`}
                    required
                  />
                </label>
                <button className="btn secondary" type="submit" disabled={smsBusy}>
                  {smsBusy ? "Sending…" : "Send SMS"}
                </button>
              </form>
            )}
            <form className="form" onSubmit={saveManage}>
              <div className="form row">
                <label>
                  Status
                  <select value={mStatus} onChange={(e) => setMStatus(e.target.value)}>
                    <option value="open">open</option>
                    <option value="scheduled">scheduled</option>
                    <option value="in_progress">in_progress</option>
                    <option value="completed">completed</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>
                <label>
                  Severity
                  <select value={mSeverity} onChange={(e) => setMSeverity(e.target.value)}>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                    <option value="critical">critical</option>
                  </select>
                </label>
                <label>
                  Scheduled date
                  <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
                </label>
              </div>
              <label>
                Mechanic diagnosis (specific)
                <select value={mDiagnosis} onChange={(e) => setMDiagnosis(e.target.value)}>
                  <option value="">Select…</option>
                  {MECHANIC_DIAGNOSIS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Work performed
                <textarea
                  value={mWork}
                  onChange={(e) => setMWork(e.target.value)}
                  placeholder="What you actually fixed / tested"
                  required={mStatus === "completed"}
                />
              </label>
              <label>
                Parts used
                <textarea
                  value={mParts}
                  onChange={(e) => setMParts(e.target.value)}
                  placeholder="Part #s, qty, brand"
                />
              </label>
              <div className="form row">
                <label>
                  Labor hours
                  <input
                    type="number"
                    step="0.25"
                    value={mLabor}
                    onChange={(e) => setMLabor(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
              </div>
              <label>
                Schedule notes
                <textarea value={mNotes} onChange={(e) => setMNotes(e.target.value)} />
              </label>
              <label>
                Completion notes
                <textarea value={mCompletion} onChange={(e) => setMCompletion(e.target.value)} />
              </label>
              <div
                className="card"
                style={{ padding: "0.75rem", margin: 0, background: "var(--bg)" }}
              >
                <label style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="checkbox"
                    checked={recordOil}
                    onChange={(e) => setRecordOil(e.target.checked)}
                  />
                  Record oil change (tracks next service by miles)
                </label>
                {recordOil && (
                  <div className="form row" style={{ marginTop: "0.65rem" }}>
                    <label>
                      Odometer at oil change
                      <input
                        type="number"
                        value={oilOdo}
                        onChange={(e) => setOilOdo(e.target.value)}
                        required={recordOil}
                        inputMode="decimal"
                      />
                    </label>
                    <label>
                      Miles until next (adjust if needed)
                      <input
                        type="number"
                        value={oilInterval}
                        onChange={(e) => setOilInterval(e.target.value)}
                        required={recordOil}
                      />
                    </label>
                    {oilOdo && oilInterval && (
                      <p className="muted" style={{ margin: 0, gridColumn: "1 / -1" }}>
                        Next oil change auto-schedules around{" "}
                        <strong>
                          {(Number(oilOdo) + (Number(oilInterval) || 5000)).toLocaleString()} mi
                        </strong>
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="toolbar">
                <button className="btn" type="submit">
                  Save shop record
                </button>
                <button className="btn secondary" type="button" onClick={() => setManage(null)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
