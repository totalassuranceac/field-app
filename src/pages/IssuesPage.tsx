import { FormEvent, useEffect, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
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
  created_at: string;
}

export function IssuesPage() {
  const { user } = useAuth();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [manage, setManage] = useState<Issue | null>(null);

  const [vehicleId, setVehicleId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState("medium");

  const [mStatus, setMStatus] = useState("scheduled");
  const [mDate, setMDate] = useState("");
  const [mNotes, setMNotes] = useState("");
  const [mCompletion, setMCompletion] = useState("");

  async function load() {
    const q = filter === "active" ? "?report=schedule" : filter === "all" ? "" : `?status=${filter}`;
    const [iss, vehs] = await Promise.all([
      api<{ issues: Issue[] }>(`/issues${q}`),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
    ]);
    setIssues(iss.issues);
    setVehicles(vehs.vehicles);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [filter]);

  async function createIssue(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/issues", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          title,
          description,
          severity,
        }),
      });
      setShowNew(false);
      setTitle("");
      setDescription("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  function openManage(issue: Issue) {
    setManage(issue);
    setMStatus(issue.status === "open" ? "scheduled" : issue.status);
    setMDate(issue.scheduled_date || "");
    setMNotes(issue.schedule_notes || "");
    setMCompletion(issue.completion_notes || "");
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
        }),
      });
      setManage(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Repairs & scheduling</h1>
          <p>Fleet manager board — triage, schedule, and complete work with downtime tracking</p>
        </div>
        <div className="toolbar no-print">
          {can(user, "reportIssues") && (
            <button className="btn" onClick={() => setShowNew(true)}>
              Report issue
            </button>
          )}
          <button className="btn secondary" onClick={() => window.print()}>
            Print work list
          </button>
        </div>
      </div>

      {filter === "active" && (
        <div className="info-banner" style={{ marginBottom: "1rem" }}>
          When you move an issue to <strong>scheduled</strong> or <strong>in progress</strong>, the
          unit is marked out of service and downtime starts. Completing work ends the downtime clock.
        </div>
      )}

      <div className="filters no-print">
        {[
          ["active", "Needs work"],
          ["open", "Open"],
          ["scheduled", "Scheduled"],
          ["in_progress", "In progress"],
          ["completed", "Completed"],
          ["all", "All"],
        ].map(([k, label]) => (
          <button key={k} className={`chip ${filter === k ? "active" : ""}`} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      <div className="card">
        <h2 className="print-only">Vehicles needing scheduled / open work</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th>Severity</th>
                <th>Issue</th>
                <th>Status</th>
                <th>Scheduled</th>
                <th>Reporter</th>
                <th className="no-print"></th>
              </tr>
            </thead>
            <tbody>
              {issues.map((i) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.unit_number}</strong>
                  </td>
                  <td>
                    <span className={`badge ${i.severity === "critical" || i.severity === "high" ? "critical" : "info"}`}>
                      {i.severity}
                    </span>
                  </td>
                  <td>
                    <div>{i.title}</div>
                    {i.description && <div className="muted">{i.description}</div>}
                  </td>
                  <td>
                    <span className={`badge ${i.status}`}>{i.status}</span>
                  </td>
                  <td>{i.scheduled_date || "—"}</td>
                  <td>{i.reporter_name}</td>
                  <td className="no-print">
                    {can(user, "manageIssues") && (
                      <button className="btn secondary" onClick={() => openManage(i)}>
                        Manage
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!issues.length && <div className="empty">No issues in this view.</div>}
        </div>
      </div>

      {showNew && (
        <div className="modal-backdrop" onClick={() => setShowNew(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Report vehicle issue</h2>
            <form className="form" onSubmit={createIssue}>
              <label>
                Vehicle
                <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} required>
                  <option value="">Select…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.unit_number}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Severity
                <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="critical">critical</option>
                </select>
              </label>
              <label>
                Title
                <input value={title} onChange={(e) => setTitle(e.target.value)} required />
              </label>
              <label>
                Description
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
              </label>
              <div className="toolbar">
                <button className="btn" type="submit">
                  Submit
                </button>
                <button className="btn secondary" type="button" onClick={() => setShowNew(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {manage && (
        <div className="modal-backdrop" onClick={() => setManage(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              Manage · Unit {manage.unit_number}
            </h2>
            <p>
              <strong>{manage.title}</strong>
            </p>
            <form className="form" onSubmit={saveManage}>
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
                Scheduled date
                <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
              </label>
              <label>
                Schedule notes
                <textarea value={mNotes} onChange={(e) => setMNotes(e.target.value)} />
              </label>
              <label>
                Completion / parts notes
                <textarea value={mCompletion} onChange={(e) => setMCompletion(e.target.value)} />
              </label>
              <div className="toolbar">
                <button className="btn" type="submit">
                  Save
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
