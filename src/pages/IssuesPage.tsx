import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import {
  DRIVER_ISSUE_OPTIONS,
  SHOP_CONCERN_OPTIONS,
  driverIssueLabel,
  joinShopConcerns,
  packWorkPerformed,
  parseShopConcerns,
  unpackWorkPerformed,
} from "../issueCatalog";
import {
  buildIssuePush,
  publishNtfyFromClient,
  reportClientPushResult,
  type ClientPushPayload,
} from "../ntfyClient";
import type { Vehicle } from "./VehiclesPage";

/** What shop should read first — description for free-text "other" reports */
function issueHeadline(i: {
  title: string;
  description: string | null;
  issue_category: string | null;
}): string {
  const desc = (i.description || "").trim();
  if (desc && (i.issue_category === "other" || /other/i.test(i.title))) {
    return desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
  }
  if (desc && desc.length > 8 && desc.toLowerCase() !== i.title.toLowerCase()) {
    return `${i.title} — ${desc.length > 60 ? `${desc.slice(0, 60)}…` : desc}`;
  }
  return i.title;
}

interface Issue {
  id: number;
  vehicle_id: number;
  unit_number: string;
  /** Usual driver on the vehicle (for scheduling with the tech) */
  assigned_driver: string | null;
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

/** All open problems for one unit — shop board + print work list */
interface VehicleIssueGroup {
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  issues: Issue[];
  needsSchedule: number;
  hasEmergency: boolean;
}

const SEV_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function sortIssuesInGroup(a: Issue, b: Issue): number {
  const st = (s: string) =>
    s === "open" ? 0 : s === "scheduled" ? 1 : s === "in_progress" ? 2 : 3;
  return (
    st(a.status) - st(b.status) ||
    (b.is_emergency ? 1 : 0) - (a.is_emergency ? 1 : 0) ||
    (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9) ||
    String(b.created_at).localeCompare(String(a.created_at))
  );
}

/** Open without schedule for 3+ days */
function isStaleOpen(i: Issue): boolean {
  if (i.status !== "open") return false;
  const t = Date.parse(String(i.created_at || "").replace(" ", "T"));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > 3 * 24 * 60 * 60 * 1000;
}

function isScheduledToday(i: Issue): boolean {
  if (i.status !== "scheduled" && i.status !== "in_progress") return false;
  const d = (i.scheduled_date || "").slice(0, 10);
  if (!d) return i.status === "in_progress";
  const today = new Date().toISOString().slice(0, 10);
  return d === today || i.status === "in_progress";
}

function groupIssuesByVehicle(list: Issue[]): VehicleIssueGroup[] {
  const map = new Map<number, VehicleIssueGroup>();
  for (const i of list) {
    let g = map.get(i.vehicle_id);
    if (!g) {
      g = {
        vehicle_id: i.vehicle_id,
        unit_number: i.unit_number,
        assigned_driver: i.assigned_driver || null,
        issues: [],
        needsSchedule: 0,
        hasEmergency: false,
      };
      map.set(i.vehicle_id, g);
    }
    if (!g.assigned_driver && i.assigned_driver) {
      g.assigned_driver = i.assigned_driver;
    }
    g.issues.push(i);
    if (i.status === "open") g.needsSchedule += 1;
    if (i.is_emergency) g.hasEmergency = true;
  }
  for (const g of map.values()) {
    g.issues.sort(sortIssuesInGroup);
  }
  return [...map.values()].sort((a, b) => {
    if (a.hasEmergency !== b.hasEmergency) return a.hasEmergency ? -1 : 1;
    if ((a.needsSchedule > 0) !== (b.needsSchedule > 0)) {
      return a.needsSchedule > 0 ? -1 : 1;
    }
    return a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true });
  });
}

interface CommonRow {
  category: string;
  count: number;
  emergencies: number;
}

export function IssuesPage() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const isDriver = user?.role === "driver";
  const isOffice = user?.role === "office";
  /** Shop tools: mechanic / admin (and office can schedule now) */
  const canShop = can(user, "manageIssues");
  const isMechanic = canShop && !isOffice;
  const [issues, setIssues] = useState<Issue[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [common, setCommon] = useState<CommonRow[]>([]);
  const [filter, setFilter] = useState(
    searchParams.get("tab") === "needs" ? "open" : "active"
  );
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
  /** Multi-select vehicle / tech concerns */
  const [mConcerns, setMConcerns] = useState<string[]>([]);
  const [mProblemFound, setMProblemFound] = useState("");
  const [mDiagnostics, setMDiagnostics] = useState("");
  const [mWork, setMWork] = useState("");
  const [mParts, setMParts] = useState("");
  const [mLabor, setMLabor] = useState("");
  const [mSeverity, setMSeverity] = useState("medium");
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
  /** Open + scheduled + in progress — always available for print work order */
  const [workList, setWorkList] = useState<Issue[]>([]);
  /** Sync lock — React state alone can miss double-taps before re-render */
  const submitLock = useRef(false);

  async function load() {
    // Deep-link always loads the shop board so the target ticket is present
    const deepId = searchParams.get("id");
    const q = deepId
      ? "?report=schedule"
      : filter === "active" || filter === "today"
        ? "?report=schedule"
        : filter === "all"
          ? ""
          : `?status=${filter}`;
    const useSchedule = q === "?report=schedule";
    const [iss, vehs, board] = await Promise.all([
      api<{ issues: Issue[]; needs_schedule?: number }>(`/issues${q}`),
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
      canShop && !useSchedule
        ? api<{ issues: Issue[] }>("/issues?report=schedule").catch(() => ({ issues: [] as Issue[] }))
        : Promise.resolve(null as { issues: Issue[] } | null),
    ]);
    setIssues(iss.issues);
    setVehicles(vehs.vehicles);
    if (canShop) {
      setWorkList(useSchedule ? iss.issues : board?.issues || []);
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

  const needsSchedule = useMemo(
    () => issues.filter((i) => i.status === "open"),
    [issues]
  );
  const onBoard = useMemo(
    () => issues.filter((i) => i.status === "scheduled" || i.status === "in_progress"),
    [issues]
  );
  /** Shop views: every problem under its unit (no split vehicles on the list) */
  const needsByVehicle = useMemo(
    () => groupIssuesByVehicle(needsSchedule),
    [needsSchedule]
  );
  const boardByVehicle = useMemo(() => groupIssuesByVehicle(onBoard), [onBoard]);
  const allByVehicle = useMemo(() => groupIssuesByVehicle(issues), [issues]);
  /** Print: units in numerical order (cover + one page each) */
  const printByVehicle = useMemo(() => {
    const groups = groupIssuesByVehicle(
      workList.filter((i) => ["open", "scheduled", "in_progress"].includes(i.status))
    );
    return groups.sort((a, b) =>
      a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true })
    );
  }, [workList]);

  const printPrintedOn = useMemo(() => {
    const d = new Date();
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [workList]);
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
    const concerns = parseShopConcerns(issue.mechanic_diagnosis);
    if (
      !concerns.length &&
      (issue.issue_category === "oil_change" || issue.title.toLowerCase().includes("oil"))
    ) {
      setMConcerns(["Oil change"]);
    } else {
      setMConcerns(concerns);
    }
    setMProblemFound(issue.completion_notes || "");
    const unpacked = unpackWorkPerformed(issue.work_performed);
    setMDiagnostics(unpacked.diagnostics);
    setMWork(unpacked.work);
    setMParts(issue.parts_used || "");
    setMLabor(issue.labor_hours != null ? String(issue.labor_hours) : "");
    setMSeverity(issue.severity);
    const veh = vehicles.find((v) => v.id === issue.vehicle_id);
    setOilOdo(veh?.current_odometer != null ? String(veh.current_odometer) : "");
    setOilInterval("5000");
  }

  const isOilChangeWork = mConcerns.includes("Oil change");

  function toggleConcern(label: string) {
    setMConcerns((prev) => {
      if (prev.includes(label)) return prev.filter((x) => x !== label);
      return [...prev, label];
    });
  }

  // Deep-link from in-app notification: /issues?id=28 → schedule that ticket
  useEffect(() => {
    const raw = searchParams.get("id");
    if (!raw || !issues.length || !canShop) return;
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    const hit = issues.find((i) => i.id === id);
    if (!hit) return;
    openManage(hit);
    const next = new URLSearchParams(searchParams);
    next.delete("id");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open once when list loads
  }, [issues, canShop]);

  async function saveManage(e: FormEvent) {
    e.preventDefault();
    if (!manage) return;
    setError("");

    if (mStatus === "scheduled" && !mDate.trim()) {
      setError("Pick a scheduled date for the shop visit.");
      return;
    }
    if (mStatus === "cancelled" && !mNotes.trim()) {
      setError("Add a short reason for cancelling this job.");
      return;
    }
    if (mStatus === "completed") {
      if (!mConcerns.length && !mProblemFound.trim()) {
        setError("Check vehicle / tech concerns and/or enter problem found.");
        return;
      }
      if (!mWork.trim() && !mDiagnostics.trim()) {
        setError("Enter diagnostics/troubleshooting and/or work performed.");
        return;
      }
    }
    // Oil mileage only when completing an oil change
    const didOil = mStatus === "completed" && isOilChangeWork;
    if (didOil) {
      if (!oilOdo.trim() || !Number.isFinite(Number(oilOdo)) || Number(oilOdo) < 0) {
        setError("Enter the odometer reading at this oil change.");
        return;
      }
    }

    try {
      await api(`/issues/${manage.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: mStatus,
          scheduled_date: mDate || null,
          schedule_notes: mNotes || null,
          completion_notes:
            mStatus === "completed" || mStatus === "in_progress"
              ? mProblemFound.trim() || null
              : manage.completion_notes || null,
          mechanic_diagnosis:
            mStatus === "completed" || mStatus === "in_progress"
              ? joinShopConcerns(mConcerns) || null
              : manage.mechanic_diagnosis || joinShopConcerns(mConcerns) || null,
          work_performed:
            mStatus === "completed" || mStatus === "in_progress"
              ? packWorkPerformed(mDiagnostics, mWork)
              : manage.work_performed || null,
          parts_used:
            mStatus === "completed" || mStatus === "in_progress"
              ? mParts || null
              : manage.parts_used || null,
          labor_hours:
            mStatus === "completed"
              ? mLabor === ""
                ? null
                : Number(mLabor)
              : manage.labor_hours,
          severity: mSeverity,
          record_oil_change: didOil,
          oil_odometer: didOil ? Number(oilOdo) : null,
          oil_interval_miles: didOil ? Number(oilInterval) || 5000 : null,
        }),
      });
      setManage(null);
      const statusOk: Record<string, string> = {
        open: "Saved — still open / waiting.",
        scheduled: mDate ? `Scheduled for ${mDate}.` : "Marked scheduled.",
        in_progress: "Marked in progress.",
        completed: didOil && oilOdo
          ? `Job complete. Oil tracking — next ~${(Number(oilOdo) + (Number(oilInterval) || 5000)).toLocaleString()} mi.`
          : "Job marked complete.",
        cancelled: "Job cancelled.",
      };
      setOk(statusOk[mStatus] || "Repair record saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  function renderIssueRow(i: Issue, opts?: { scheduleCta?: boolean }) {
    const head = issueHeadline(i);
    const shopNote = i.work_performed || "";
    const when = i.scheduled_date || String(i.created_at || "").slice(0, 10) || "—";
    return (
      <li
        key={i.id}
        className={`shop-unit-issue st-${i.status}${i.is_emergency ? " is-emergency" : ""}`}
      >
        <div className="shop-unit-issue-head">
          {!!i.is_emergency && <span className="log-item-badge">Emergency</span>}
          {i.status === "open" && (
            <span className="log-item-badge log-item-badge-needs">Needs schedule</span>
          )}
          {isStaleOpen(i) && (
            <span className="log-item-badge log-item-badge-needs" title="Open 3+ days">
              3+ days
            </span>
          )}
          {isScheduledToday(i) && (
            <span className="log-item-badge" title="On today's shop list">
              Today
            </span>
          )}
          <span className="log-item-badge">{i.status.replace(/_/g, " ")}</span>
          <span className="shop-unit-issue-title">{head}</span>
        </div>
        {i.issue_category && i.issue_category !== "other" && (
          <div className="muted shop-unit-issue-meta">{driverIssueLabel(i.issue_category)}</div>
        )}
        {i.description && (
          <div className="issue-desc-block">
            <strong>Tech said: </strong>
            {i.description}
          </div>
        )}
        {!isDriver && i.mechanic_diagnosis && (
          <div className="shop-unit-issue-meta">
            <span className="muted">Concerns: </span>
            {i.mechanic_diagnosis}
          </div>
        )}
        {!isDriver && i.completion_notes && (
          <div className="shop-unit-issue-meta">
            <span className="muted">Problem found: </span>
            {i.completion_notes}
          </div>
        )}
        {!isDriver && shopNote && (
          <div className="shop-unit-issue-meta">
            <span className="muted">Shop work: </span>
            {shopNote.length > 160 ? `${shopNote.slice(0, 160)}…` : shopNote}
          </div>
        )}
        <div className="muted shop-unit-issue-meta">
          {i.assigned_driver ? (
            <>
              <span className="shop-driver-inline">
                Driver: <strong>{i.assigned_driver}</strong>
              </span>
              {" · "}
            </>
          ) : null}
          Reported by {i.reporter_name} · {i.severity} · {when}
        </div>
        {canShop && (
          <div className="log-item-actions no-print">
            <button className="btn btn-sm" type="button" onClick={() => openManage(i)}>
              {i.status === "open" || opts?.scheduleCta ? "Schedule / shop work" : "Shop work"}
            </button>
          </div>
        )}
      </li>
    );
  }

  function renderVehicleGroup(
    g: VehicleIssueGroup,
    opts?: { defaultOpen?: boolean; scheduleCta?: boolean }
  ) {
    const open = opts?.defaultOpen ?? (g.needsSchedule > 0 || g.hasEmergency);
    const driverLabel = g.assigned_driver?.trim() || "No assigned driver";
    return (
      <details
        key={g.vehicle_id}
        className={`shop-unit-card${g.hasEmergency ? " is-emergency" : ""}${
          g.needsSchedule > 0 ? " needs-schedule" : ""
        }`}
        open={open || undefined}
      >
        <summary className="shop-unit-summary">
          <span className="shop-unit-title">
            <strong>Unit {g.unit_number}</strong>
            <span
              className={`shop-unit-driver${g.assigned_driver ? "" : " is-missing"}`}
              title="Assigned driver — who to schedule with"
            >
              {g.assigned_driver ? driverLabel : "Unassigned"}
            </span>
            <span className="shop-unit-count">
              {g.issues.length} problem{g.issues.length === 1 ? "" : "s"}
            </span>
            {g.hasEmergency && <span className="log-item-badge">Emergency</span>}
            {g.needsSchedule > 0 && (
              <span className="log-item-badge log-item-badge-needs">
                {g.needsSchedule} need schedule
              </span>
            )}
          </span>
          <span className="muted shop-unit-peek no-print">
            {g.assigned_driver ? `Driver: ${g.assigned_driver} · ` : ""}
            {g.issues
              .slice(0, 3)
              .map((i) => issueHeadline(i))
              .join(" · ")}
            {g.issues.length > 3 ? "…" : ""}
          </span>
        </summary>
        <ul className="shop-unit-issues">
          {g.issues.map((i) => renderIssueRow(i, { scheduleCta: opts?.scheduleCta }))}
        </ul>
      </details>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>
            {isDriver
              ? "Request a repair"
              : "Repairs & shop board"}
          </h1>
          <p>
            {isDriver
              ? "Tell us what’s wrong — pick from the list. Flat tires go out as emergency."
              : "New tech requests show under Needs scheduling. Book a date so the unit is on the shop board — all inside this app (no ntfy required)."}
          </p>
        </div>
        <div className="toolbar no-print">
          {can(user, "reportIssues") && !isOffice && (
            <button className="btn btn-sm" type="button" onClick={() => setShowNew(true)}>
              {isDriver ? "New request" : "Report issue"}
            </button>
          )}
          {canShop && (
            <button className="btn secondary btn-sm" type="button" onClick={() => window.print()}>
              Print work order
            </button>
          )}
        </div>
      </div>

      {/* Print: one continuous list — units numerical, all issues under each unit */}
      {canShop && (
        <div className="print-only shop-print-worklist" aria-hidden>
          <header className="shop-print-header">
            <h1>Shop work order</h1>
            <p>
              Printed {printPrintedOn}
              {printByVehicle.length
                ? ` · ${printByVehicle.length} unit${printByVehicle.length === 1 ? "" : "s"} · ${
                    workList.filter((i) =>
                      ["open", "scheduled", "in_progress"].includes(i.status)
                    ).length
                  } problem${
                    workList.filter((i) =>
                      ["open", "scheduled", "in_progress"].includes(i.status)
                    ).length === 1
                      ? ""
                      : "s"
                  }`
                : " · no open work"}
            </p>
            <p className="shop-print-cover-note">
              All issues listed by unit number (numerical order). Continuous pages — not one sheet
              per vehicle.
            </p>
          </header>
          {printByVehicle.length === 0 ? (
            <p>No open or scheduled repairs.</p>
          ) : (
            <table className="shop-print-index-table">
              <thead>
                <tr>
                  <th className="col-unit">Unit</th>
                  <th className="col-driver">Driver</th>
                  <th className="col-n">#</th>
                  <th>All issues for this vehicle</th>
                  <th className="col-flags">Status / flags</th>
                </tr>
              </thead>
              <tbody>
                {printByVehicle.map((g) => (
                  <tr key={g.vehicle_id}>
                    <td className="col-unit">
                      <strong>{g.unit_number}</strong>
                    </td>
                    <td className="col-driver">
                      {g.assigned_driver?.trim() || "—"}
                    </td>
                    <td className="col-n">{g.issues.length}</td>
                    <td>
                      <ol className="shop-print-index-problems">
                        {g.issues.map((i) => (
                          <li key={i.id}>
                            <span className="shop-print-issue-main">{issueHeadline(i)}</span>
                            {i.description &&
                              issueHeadline(i) !== i.description.trim() && (
                                <div className="shop-print-issue-sub">{i.description}</div>
                              )}
                            <span className="shop-print-index-st">
                              {i.status.replace(/_/g, " ")}
                              {i.scheduled_date ? ` · need ${i.scheduled_date}` : ""}
                              {i.is_emergency ? " · EMERGENCY" : ""}
                              {i.reporter_name ? ` · reported by ${i.reporter_name}` : ""}
                            </span>
                          </li>
                        ))}
                      </ol>
                    </td>
                    <td className="col-flags">
                      {g.hasEmergency ? "EMERGENCY" : ""}
                      {g.needsSchedule > 0
                        ? `${g.hasEmergency ? "\n" : ""}${g.needsSchedule} need schedule`
                        : g.hasEmergency
                          ? ""
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <footer className="shop-print-unit-foot">
            Mechanic: ________________ · Date: ________
          </footer>
        </div>
      )}

      {ok && <div className="success" style={{ marginBottom: "1rem" }}>{ok}</div>}
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {canShop && needsByVehicle.length > 0 && filter === "active" && (
        <div className="card issue-needs-card no-print" style={{ marginBottom: "1rem" }}>
          <h2 style={{ marginTop: 0 }}>
            Needs scheduling
            <span className="issue-needs-count">{needsSchedule.length}</span>
          </h2>
          <p className="muted no-print" style={{ marginTop: 0, fontSize: "0.88rem" }}>
            Grouped by unit — every open problem on that van is listed together. Schedule each line
            when you book the work.
          </p>
          <div className="shop-unit-list">
            {needsByVehicle.map((g) =>
              renderVehicleGroup(g, { defaultOpen: true, scheduleCta: true })
            )}
          </div>
        </div>
      )}

      {canShop && oilDue.length > 0 && (
        <div className="card no-print" style={{ marginBottom: "1rem" }}>
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

      {canShop && common.length > 0 && (
        <div className="card no-print" style={{ marginBottom: "1rem" }}>
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

      <div className="filters no-print">
        {(isDriver
          ? [
              ["active", "Open for me"],
              ["completed", "Done"],
              ["all", "All"],
            ]
          : [
              ["active", "Shop board"],
              ["today", "Today"],
              ["open", `Needs schedule${needsSchedule.length ? ` (${needsSchedule.length})` : ""}`],
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

      {canShop && filter === "today" ? (
        <div className="shop-unit-list">
          {(() => {
            const todayIssues = issues.filter(isScheduledToday);
            const groups = groupIssuesByVehicle(todayIssues);
            if (!groups.length) {
              return (
                <div className="muted empty">
                  Nothing scheduled for today. Use Needs schedule to book work.
                </div>
              );
            }
            return groups.map((g) =>
              renderVehicleGroup(g, { defaultOpen: true, scheduleCta: false })
            );
          })()}
        </div>
      ) : canShop && filter === "active" ? (
        <>
          {boardByVehicle.length > 0 && (
            <div className="card no-print" style={{ marginBottom: "1rem" }}>
              <h2 style={{ marginTop: 0 }}>Scheduled / in progress</h2>
              <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
                Booked work by unit — driver name shown so you can coordinate. Stale open tickets
                (3+ days) are flagged under Needs schedule.
              </p>
              <div className="shop-unit-list">
                {boardByVehicle.map((g) => renderVehicleGroup(g))}
              </div>
            </div>
          )}
          {!needsSchedule.length && !onBoard.length && (
            <div className="muted empty no-print">No open or scheduled repairs right now.</div>
          )}
        </>
      ) : isDriver ? (
        <LogList className="shop-board log-list" empty="No issues in this view.">
          {issues.map((i) => (
            <LogItem
              key={i.id}
              tone={i.is_emergency ? "urgent" : i.status === "open" ? "warn" : undefined}
              defaultOpen={i.status === "open"}
              summary={
                <>
                  <strong>Unit {i.unit_number}</strong>
                  <span className="log-item-badge">{i.status.replace(/_/g, " ")}</span>
                  <span className="log-item-meta">{issueHeadline(i)}</span>
                </>
              }
            >
              {i.description && <div className="issue-desc-block">{i.description}</div>}
              <div className="muted">
                {i.severity}
                {i.created_at
                  ? ` · ${String(i.created_at).replace("T", " ").slice(0, 16)}`
                  : ""}
              </div>
            </LogItem>
          ))}
        </LogList>
      ) : (
        <div className="shop-unit-list">
          {(() => {
            const groups =
              filter === "open"
                ? needsByVehicle
                : groupIssuesByVehicle(issues);
            if (!groups.length) {
              return <div className="muted empty">No issues in this view.</div>;
            }
            return groups.map((g) =>
              renderVehicleGroup(g, {
                defaultOpen: filter === "open" || g.needsSchedule > 0 || g.hasEmergency,
                scheduleCta: filter === "open",
              })
            );
          })()}
        </div>
      )}

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
            <p className="shop-manage-driver" style={{ marginTop: 0, marginBottom: "0.35rem" }}>
              <strong>Assigned driver:</strong>{" "}
              {manage.assigned_driver?.trim() || (
                <span className="muted">None on file — check Vehicles</span>
              )}
            </p>
            <p style={{ marginTop: 0 }}>
              <strong>Reported:</strong> {manage.title}
              {manage.description ? ` — ${manage.description}` : ""}
              {manage.reporter_name ? (
                <span className="muted"> · by {manage.reporter_name}</span>
              ) : null}
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
                    <option value="open">Open — not booked yet</option>
                    <option value="scheduled">Scheduled — shop date set</option>
                    <option value="in_progress">In progress — working on it</option>
                    <option value="completed">Completed — job done</option>
                    <option value="cancelled">Cancelled — not doing this</option>
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
              </div>

              <p className="shop-status-hint muted">
                {mStatus === "open" &&
                  "Keep open if the unit isn’t booked. Add a note if you’re waiting on the tech or parts."}
                {mStatus === "scheduled" &&
                  "Set the day the van comes in. You can fill diagnosis when work starts or when done."}
                {mStatus === "in_progress" &&
                  "Unit is in the shop. Log concerns and diagnostics as you go — finish details on complete."}
                {mStatus === "completed" &&
                  "Record what was wrong, what you tested, and what you fixed. Required for the work history."}
                {mStatus === "cancelled" &&
                  "This job will leave the active board. Enter why it was cancelled."}
              </p>

              {/* Book / wait */}
              {(mStatus === "open" || mStatus === "scheduled") && (
                <>
                  {mStatus === "scheduled" && (
                    <label>
                      Scheduled date *
                      <input
                        type="date"
                        value={mDate}
                        onChange={(e) => setMDate(e.target.value)}
                        required
                      />
                    </label>
                  )}
                  <label>
                    {mStatus === "open" ? "Notes" : "Schedule notes"}
                    <textarea
                      value={mNotes}
                      onChange={(e) => setMNotes(e.target.value)}
                      placeholder={
                        mStatus === "open"
                          ? "Waiting on tech, parts, or more info…"
                          : "Bring unit in AM, parts on order, bay notes…"
                      }
                      rows={2}
                    />
                  </label>
                </>
              )}

              {/* Cancel */}
              {mStatus === "cancelled" && (
                <label>
                  Reason cancelled *
                  <textarea
                    value={mNotes}
                    onChange={(e) => setMNotes(e.target.value)}
                    placeholder="Duplicate, fixed by tech, not needed, wrong unit…"
                    rows={3}
                    required
                  />
                </label>
              )}

              {/* Working or finishing */}
              {(mStatus === "in_progress" || mStatus === "completed") && (
                <>
                  {mStatus === "in_progress" && (
                    <label>
                      Scheduled date
                      <input
                        type="date"
                        value={mDate}
                        onChange={(e) => setMDate(e.target.value)}
                      />
                    </label>
                  )}
                  <div className="shop-concerns-block">
                    <label className="shop-concerns-label" htmlFor="shop-concerns-summary">
                      Vehicle issues / tech concerns
                      {mStatus === "completed" ? " *" : ""}
                    </label>
                    <details className="shop-concerns-dropdown">
                      <summary id="shop-concerns-summary" className="shop-concerns-summary">
                        <span className="shop-concerns-summary-text">
                          {mConcerns.length === 0
                            ? "Select concerns…"
                            : mConcerns.length === 1
                              ? mConcerns[0]
                              : `${mConcerns.length} selected`}
                        </span>
                        <span className="shop-concerns-summary-meta muted">
                          {mConcerns.length > 0 ? "tap to edit" : "check all that apply"}
                          <span className="shop-concerns-chevron" aria-hidden>
                            ▾
                          </span>
                        </span>
                      </summary>
                      <ul
                        className="shop-concerns-list"
                        role="group"
                        aria-label="Vehicle issues and concerns"
                      >
                        {SHOP_CONCERN_OPTIONS.map((label) => {
                          const on = mConcerns.includes(label);
                          return (
                            <li key={label}>
                              <label className={`shop-concern-row${on ? " is-on" : ""}`}>
                                <span className="shop-concern-row-label">{label}</span>
                                <input
                                  type="checkbox"
                                  className="shop-concern-row-check"
                                  checked={on}
                                  onChange={() => toggleConcern(label)}
                                />
                              </label>
                            </li>
                          );
                        })}
                      </ul>
                    </details>
                    {mConcerns.length > 1 && (
                      <p className="shop-concerns-picks muted" aria-live="polite">
                        {mConcerns.join(" · ")}
                      </p>
                    )}
                  </div>
                  <label>
                    Problem found
                    {mStatus === "completed" ? " *" : ""}
                    <textarea
                      value={mProblemFound}
                      onChange={(e) => setMProblemFound(e.target.value)}
                      placeholder="What was actually wrong…"
                      rows={2}
                      required={mStatus === "completed"}
                    />
                  </label>
                  <label>
                    Diagnostics / troubleshooting
                    <textarea
                      value={mDiagnostics}
                      onChange={(e) => setMDiagnostics(e.target.value)}
                      placeholder="Tests run, readings, steps to isolate the fault…"
                      rows={mStatus === "completed" ? 3 : 2}
                    />
                  </label>
                  {mStatus === "completed" && (
                    <>
                      <label>
                        Work performed *
                        <textarea
                          value={mWork}
                          onChange={(e) => setMWork(e.target.value)}
                          placeholder="What you fixed, replaced, or adjusted…"
                          rows={3}
                          required
                        />
                      </label>
                      <label>
                        Parts used
                        <textarea
                          value={mParts}
                          onChange={(e) => setMParts(e.target.value)}
                          placeholder="Part #s, qty, brand"
                          rows={2}
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
                    </>
                  )}
                  {mStatus === "in_progress" && (
                    <>
                      <label>
                        Parts on order / used so far
                        <textarea
                          value={mParts}
                          onChange={(e) => setMParts(e.target.value)}
                          placeholder="Optional — parts ordered or already used"
                          rows={2}
                        />
                      </label>
                      <label>
                        Shop notes
                        <textarea
                          value={mNotes}
                          onChange={(e) => setMNotes(e.target.value)}
                          placeholder="Waiting on part, coming back tomorrow…"
                          rows={2}
                        />
                      </label>
                    </>
                  )}
                  {mStatus === "completed" && isOilChangeWork && (
                    <div className="card shop-oil-block">
                      <strong className="shop-oil-title">Oil change mileage</strong>
                      <p className="muted shop-oil-hint">
                        Tracking starts with this oil change. Enter the odometer now.
                      </p>
                      <div className="form row" style={{ marginTop: "0.45rem" }}>
                        <label>
                          Odometer at oil change *
                          <input
                            type="number"
                            value={oilOdo}
                            onChange={(e) => setOilOdo(e.target.value)}
                            required
                            inputMode="decimal"
                            min={0}
                            placeholder="Miles on the truck now"
                          />
                        </label>
                        <label>
                          Miles until next
                          <input
                            type="number"
                            value={oilInterval}
                            onChange={(e) => setOilInterval(e.target.value)}
                            min={500}
                            step={100}
                          />
                        </label>
                        {oilOdo && oilInterval && (
                          <p className="muted" style={{ margin: 0, gridColumn: "1 / -1" }}>
                            Next oil change around{" "}
                            <strong>
                              {(
                                Number(oilOdo) + (Number(oilInterval) || 5000)
                              ).toLocaleString()}{" "}
                              mi
                            </strong>
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="toolbar">
                <button className="btn" type="submit">
                  {mStatus === "open" && "Save as open"}
                  {mStatus === "scheduled" && "Save schedule"}
                  {mStatus === "in_progress" && "Update in progress"}
                  {mStatus === "completed" && "Complete job"}
                  {mStatus === "cancelled" && "Cancel job"}
                </button>
                <button className="btn secondary" type="button" onClick={() => setManage(null)}>
                  Close
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
