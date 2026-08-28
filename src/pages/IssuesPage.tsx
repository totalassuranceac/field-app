import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { ShopJobPartsPanel } from "../components/ShopJobPartsPanel";
import { VehicleQuickPick, type VehicleMatch } from "../components/VehicleQuickPick";
import {
  DRIVER_ISSUE_OPTIONS,
  SHOP_CONCERN_OPTIONS,
  driverIssueLabel,
  joinShopConcerns,
  packWorkPerformed,
  parseShopConcerns,
  unpackWorkPerformed,
} from "../issueCatalog";
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
  completed_at?: string | null;
  completed_by_user_id?: number | null;
  completed_by_name?: string | null;
  /** driver = tech report; shop = mechanic logged work */
  origin?: string | null;
  /** pending | confirmed | declined — tech appointment accountability */
  tech_confirm_status?: string | null;
  tech_confirmed_at?: string | null;
  tech_confirmed_by_user_id?: number | null;
  tech_confirmed_by_name?: string | null;
  tech_confirm_note?: string | null;
}

function todayIsoDate(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatPrintWhen(raw: string | null | undefined): string {
  if (!raw) return "—";
  const s = String(raw).replace("T", " ").slice(0, 16);
  return s || "—";
}

function formatPrintDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
  /** Mechanic logs work they did without a driver ticket */
  const [showShopLog, setShowShopLog] = useState(false);
  const [manage, setManage] = useState<Issue | null>(null);

  const [vehicleId, setVehicleId] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [isEmergency, setIsEmergency] = useState(false);

  /** Calendar day for “Done today / by date” supervisor view */
  const [completedDay, setCompletedDay] = useState(todayIsoDate);

  // Shop log form (create completed / in_progress work order)
  const [sVehicleId, setSVehicleId] = useState("");
  const [sStatus, setSStatus] = useState<"completed" | "in_progress">("completed");
  const [sConcerns, setSConcerns] = useState<string[]>([]);
  const [sProblemFound, setSProblemFound] = useState("");
  const [sDiagnostics, setSDiagnostics] = useState("");
  const [sWork, setSWork] = useState("");
  const [sParts, setSParts] = useState("");
  const [sLabor, setSLabor] = useState("");
  const [sOilOdo, setSOilOdo] = useState("");
  const [sOilInterval, setSOilInterval] = useState("5000");

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
  /** Receipts on file for soft prompt when completing */
  const [jobReceiptCount, setJobReceiptCount] = useState(0);
  /** After complete — offer unit parts history + tech receipt print */
  const [postComplete, setPostComplete] = useState<{
    vehicleId: number;
    unitNumber: string;
    issue: Issue | null;
  } | null>(null);
  /** What browser print should show: open work order (default) vs tech receipt / day log */
  const [printTarget, setPrintTarget] = useState<
    null | { kind: "receipt"; issue: Issue } | { kind: "day-log" }
  >(null);
  const [confirmBusyId, setConfirmBusyId] = useState<number | null>(null);
  const [declineId, setDeclineId] = useState<number | null>(null);
  const [declineNote, setDeclineNote] = useState("");

  async function load() {
    // Deep-link always loads the shop board so the target ticket is present
    const deepId = searchParams.get("id");
    let q = "";
    if (deepId) {
      q = "?report=schedule";
    } else if (filter === "active" || filter === "today") {
      q = "?report=schedule";
    } else if (filter === "done_day") {
      const day = completedDay || todayIsoDate();
      q = `?report=completed_day&completed_on=${encodeURIComponent(day)}`;
    } else if (filter === "all") {
      q = "";
    } else {
      q = `?status=${filter}`;
    }
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
  }, [filter, completedDay]);

  useEffect(() => {
    const opt = DRIVER_ISSUE_OPTIONS.find((o) => o.value === category);
    if (opt?.emergency) setIsEmergency(true);
  }, [category]);

  // Body classes drive which print layout is visible (work order vs tech receipt vs day log)
  useEffect(() => {
    const clsReceipt = "print-shop-receipt";
    const clsDay = "print-shop-day-log";
    document.body.classList.remove(clsReceipt, clsDay);
    if (printTarget?.kind === "receipt") document.body.classList.add(clsReceipt);
    if (printTarget?.kind === "day-log") document.body.classList.add(clsDay);
    return () => {
      document.body.classList.remove(clsReceipt, clsDay);
    };
  }, [printTarget]);

  useEffect(() => {
    function onAfterPrint() {
      setPrintTarget(null);
    }
    window.addEventListener("afterprint", onAfterPrint);
    return () => window.removeEventListener("afterprint", onAfterPrint);
  }, []);

  function runPrint(
    target: { kind: "receipt"; issue: Issue } | { kind: "day-log" } | null
  ) {
    setPrintTarget(target);
    // Wait for body class + print DOM to paint
    window.setTimeout(() => {
      window.print();
    }, 80);
  }

  function printTechReceipt(issue: Issue) {
    runPrint({ kind: "receipt", issue });
  }

  function printCompletedDayLog() {
    runPrint({ kind: "day-log" });
  }

  function printOpenWorkOrder() {
    setPrintTarget(null);
    window.setTimeout(() => window.print(), 40);
  }

  function resetShopLogForm() {
    setSVehicleId("");
    setSStatus("completed");
    setSConcerns([]);
    setSProblemFound("");
    setSDiagnostics("");
    setSWork("");
    setSParts("");
    setSLabor("");
    setSOilOdo("");
    setSOilInterval("5000");
  }

  function openShopLog() {
    resetShopLogForm();
    setShowShopLog(true);
    setError("");
    setOk("");
  }

  function toggleShopConcern(label: string) {
    setSConcerns((prev) => {
      if (prev.includes(label)) return prev.filter((x) => x !== label);
      return [...prev, label];
    });
  }

  const shopLogIsOil = sConcerns.includes("Oil change");

  async function createShopWork(e: FormEvent) {
    e.preventDefault();
    if (submitLock.current || submitting) return;
    setError("");
    setOk("");
    if (!sVehicleId) {
      setError("Pick the unit you worked on.");
      return;
    }
    if (sStatus === "completed") {
      if (!sConcerns.length && !sProblemFound.trim()) {
        setError("Check vehicle / tech concerns and/or enter problem found.");
        return;
      }
      if (!sWork.trim() && !sDiagnostics.trim()) {
        setError("Enter diagnostics/troubleshooting and/or work performed.");
        return;
      }
    }
    if (sStatus === "completed" && shopLogIsOil) {
      if (!sOilOdo.trim() || !Number.isFinite(Number(sOilOdo)) || Number(sOilOdo) < 0) {
        setError("Enter the odometer reading at this oil change.");
        return;
      }
    }

    const title =
      joinShopConcerns(sConcerns) ||
      sProblemFound.trim().slice(0, 80) ||
      "Shop work";

    submitLock.current = true;
    setSubmitting(true);
    try {
      const res = await api<{ message?: string; issue?: { id: number } }>("/issues", {
        method: "POST",
        body: JSON.stringify({
          shop_work: true,
          vehicle_id: Number(sVehicleId),
          status: sStatus,
          title,
          mechanic_diagnosis: joinShopConcerns(sConcerns) || null,
          completion_notes: sProblemFound.trim() || null,
          work_performed: packWorkPerformed(sDiagnostics, sWork),
          parts_used: sParts.trim() || null,
          labor_hours: sLabor === "" ? null : Number(sLabor),
          record_oil_change: sStatus === "completed" && shopLogIsOil,
          oil_odometer:
            sStatus === "completed" && shopLogIsOil ? Number(sOilOdo) : null,
          oil_interval_miles:
            sStatus === "completed" && shopLogIsOil
              ? Number(sOilInterval) || 5000
              : null,
        }),
      });
      const vid = Number(sVehicleId);
      const unit =
        vehicles.find((v) => v.id === vid)?.unit_number || String(vid);
      setShowShopLog(false);
      resetShopLogForm();
      setOk(res.message || "Shop work logged.");
      if (sStatus === "completed") {
        const snap: Issue = {
          id: res.issue?.id ?? 0,
          vehicle_id: vid,
          unit_number: unit,
          assigned_driver:
            vehicles.find((v) => v.id === vid)?.assigned_driver || null,
          reporter_name: user?.display_name || "Shop",
          severity: "medium",
          title,
          description: null,
          status: "completed",
          scheduled_date: null,
          schedule_notes: null,
          completion_notes: sProblemFound.trim() || null,
          issue_category: null,
          is_emergency: 0,
          mechanic_diagnosis: joinShopConcerns(sConcerns) || null,
          work_performed: packWorkPerformed(sDiagnostics, sWork),
          parts_used: sParts.trim() || null,
          labor_hours: sLabor === "" ? null : Number(sLabor),
          created_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          completed_by_name: user?.display_name || null,
          origin: "shop",
        };
        setPostComplete({ vehicleId: vid, unitNumber: unit, issue: snap });
        // useEffect on filter/completedDay reloads the day list
        setCompletedDay(todayIsoDate());
        setFilter("done_day");
      } else {
        setFilter("in_progress");
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to log shop work");
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

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
    const issueTitle = opt?.label || category;

    submitLock.current = true;
    setSubmitting(true);
    try {
      const res = await api<{
        message?: string;
        emergency?: boolean;
        duplicate?: boolean;
        notified_user_ids?: number[];
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

      setShowNew(false);
      setCategory("");
      setDescription("");
      setIsEmergency(false);

      const baseMsg =
        res.message ||
        (emergency
          ? "Emergency dispatched — shop notified."
          : "Repair request submitted — shop notified.");
      setOk(baseMsg.replace(/\s*Sending phone push…?\s*$/i, "").trim());
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
    setJobReceiptCount(0);
    setPostComplete(null);
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

  // Deep-link from in-app notification: /issues?id=28
  // Shop → open manage panel; tech → scroll to ticket (confirm appointment)
  useEffect(() => {
    const raw = searchParams.get("id");
    if (!raw || !issues.length) return;
    const id = Number(raw);
    if (!Number.isFinite(id)) return;
    const hit = issues.find((i) => i.id === id);
    if (!hit) return;
    if (canShop) {
      openManage(hit);
    } else {
      window.setTimeout(() => {
        document.getElementById(`issue-${id}`)?.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }, 80);
    }
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
      // Soft prompt — don't block complete if no receipt
      if (jobReceiptCount === 0) {
        const go = window.confirm(
          `No parts receipts uploaded for unit ${manage.unit_number} on this job.\n\nComplete anyway? (You can still add receipts later under Parts receipts.)`
        );
        if (!go) return;
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
      const vehicleIdDone = manage.vehicle_id;
      const unitDone = manage.unit_number;
      const result = await api<{
        field_notified?: number;
        field_notify_warning?: string | null;
      }>(`/issues/${manage.id}`, {
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
      const n = result.field_notified ?? 0;
      const notifyBit =
        n > 0
          ? ` Notified ${n} person${n === 1 ? "" : "s"} on the unit (app inbox).`
          : "";
      const statusOk: Record<string, string> = {
        open: "Saved — still open / waiting.",
        scheduled: mDate
          ? `Scheduled for ${mDate}.${notifyBit || " (No app user linked — call the tech.)"}`
          : `Marked scheduled.${notifyBit}`,
        in_progress: `Marked in progress — unit is out of service in the app.${notifyBit}`,
        completed: didOil && oilOdo
          ? `Job complete. Oil tracking — next ~${(Number(oilOdo) + (Number(oilInterval) || 5000)).toLocaleString()} mi.${notifyBit}`
          : `Job marked complete.${notifyBit}`,
        cancelled: `Job cancelled.${notifyBit}`,
      };
      if (result.field_notify_warning) {
        setError(result.field_notify_warning);
        setOk(statusOk[mStatus] || "Repair record saved.");
      } else {
        setOk(statusOk[mStatus] || "Repair record saved.");
      }
      if (mStatus === "completed" && vehicleIdDone && manage) {
        const snap: Issue = {
          ...manage,
          status: "completed",
          mechanic_diagnosis: joinShopConcerns(mConcerns) || null,
          completion_notes: mProblemFound.trim() || null,
          work_performed: packWorkPerformed(mDiagnostics, mWork),
          parts_used: mParts || null,
          labor_hours: mLabor === "" ? null : Number(mLabor),
          completed_at: new Date().toISOString(),
          completed_by_name: user?.display_name || manage.completed_by_name || null,
        };
        setPostComplete({
          vehicleId: vehicleIdDone,
          unitNumber: unitDone,
          issue: snap,
        });
      } else {
        setPostComplete(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function confirmSchedule(issueId: number, action: "confirm" | "decline", note?: string) {
    setError("");
    setOk("");
    setConfirmBusyId(issueId);
    try {
      await api(`/issues/${issueId}/confirm-schedule`, {
        method: "POST",
        body: JSON.stringify({ action, note: note || undefined }),
      });
      setDeclineId(null);
      setDeclineNote("");
      setOk(
        action === "confirm"
          ? "Appointment confirmed — shop can see you accepted."
          : "Decline sent to the shop. They will reschedule."
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update appointment");
    } finally {
      setConfirmBusyId(null);
    }
  }

  function confirmBadge(i: Issue) {
    if (i.status !== "scheduled") return null;
    const st = i.tech_confirm_status || "pending";
    if (st === "confirmed") {
      const who = i.tech_confirmed_by_name || "Tech";
      const when = i.tech_confirmed_at
        ? String(i.tech_confirmed_at).slice(0, 16).replace("T", " ")
        : "";
      return (
        <span className="log-item-badge confirm-badge is-confirmed" title={when || undefined}>
          Confirmed{i.tech_confirmed_by_name ? ` · ${who}` : ""}
        </span>
      );
    }
    if (st === "declined") {
      return (
        <span
          className="log-item-badge confirm-badge is-declined"
          title={i.tech_confirm_note || undefined}
        >
          Declined{i.tech_confirm_note ? `: ${i.tech_confirm_note.slice(0, 40)}` : ""}
        </span>
      );
    }
    return (
      <span className="log-item-badge confirm-badge is-pending log-item-badge-needs">
        Awaiting confirm
      </span>
    );
  }

  function renderIssueRow(i: Issue, opts?: { scheduleCta?: boolean }) {
    const head = issueHeadline(i);
    const shopNote = i.work_performed || "";
    const when = i.scheduled_date || String(i.created_at || "").slice(0, 10) || "—";
    const needsTechConfirm =
      i.status === "scheduled" &&
      (i.tech_confirm_status === "pending" ||
        !i.tech_confirm_status ||
        i.tech_confirm_status === "declined");
    // Drivers always; admin can confirm when testing their own unit; shop still uses badges
    const showConfirmCta =
      i.status === "scheduled" &&
      (isDriver || user?.role === "admin" || user?.role === "office");
    return (
      <li
        key={i.id}
        className={`shop-unit-issue st-${i.status}${i.is_emergency ? " is-emergency" : ""}`}
        id={`issue-${i.id}`}
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
          {i.origin === "shop" && (
            <span className="log-item-badge" title="Mechanic logged this work (no driver ticket)">
              Shop logged
            </span>
          )}
          {confirmBadge(i)}
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
        {!isDriver && i.parts_used && (
          <div className="shop-unit-issue-meta">
            <span className="muted">Parts: </span>
            {i.parts_used}
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
          {i.status === "completed" ? (
            <>
              Completed
              {i.completed_by_name ? ` by ${i.completed_by_name}` : ""}
              {i.completed_at
                ? ` · ${String(i.completed_at).slice(0, 16).replace("T", " ")}`
                : ""}
              {i.origin === "shop" ? " · shop-origin" : i.reporter_name ? ` · reported by ${i.reporter_name}` : ""}
              {i.labor_hours != null ? ` · ${i.labor_hours}h labor` : ""}
            </>
          ) : (
            <>
              Reported by {i.reporter_name} · {i.severity} · {when}
            </>
          )}
        </div>
        {i.status === "scheduled" && i.schedule_notes && (
          <div className="shop-unit-issue-meta">
            <span className="muted">Shop notes: </span>
            {i.schedule_notes}
          </div>
        )}
        {showConfirmCta && (
          <div className="schedule-confirm-box no-print">
            {i.tech_confirm_status === "confirmed" ? (
              <p className="schedule-confirm-ok">
                You confirmed this shop appointment
                {i.tech_confirmed_at
                  ? ` · ${String(i.tech_confirmed_at).slice(0, 16).replace("T", " ")}`
                  : ""}
                .
              </p>
            ) : (
              <>
                <p className="schedule-confirm-prompt">
                  <strong>Confirm you’ll bring unit {i.unit_number}</strong>
                  {i.scheduled_date ? ` on ${String(i.scheduled_date).slice(0, 10)}` : ""}?
                  This records that you saw the appointment.
                </p>
                <div className="log-item-actions">
                  <button
                    type="button"
                    className="btn primary btn-sm"
                    disabled={confirmBusyId === i.id}
                    onClick={() => void confirmSchedule(i.id, "confirm")}
                  >
                    {confirmBusyId === i.id ? "Saving…" : "Confirm appointment"}
                  </button>
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={confirmBusyId === i.id}
                    onClick={() => {
                      setDeclineId(i.id);
                      setDeclineNote("");
                    }}
                  >
                    Can’t make it
                  </button>
                </div>
                {declineId === i.id && (
                  <div className="schedule-decline-form">
                    <label>
                      Why can’t you make it? (shop will see this)
                      <textarea
                        value={declineNote}
                        onChange={(e) => setDeclineNote(e.target.value)}
                        rows={2}
                        placeholder="e.g. On a job until 4pm · PTO · unit not with me"
                      />
                    </label>
                    <div className="log-item-actions">
                      <button
                        type="button"
                        className="btn primary btn-sm"
                        disabled={confirmBusyId === i.id || !declineNote.trim()}
                        onClick={() => void confirmSchedule(i.id, "decline", declineNote.trim())}
                      >
                        Send decline
                      </button>
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        onClick={() => setDeclineId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {canShop && (
          <div className="log-item-actions no-print">
            <button className="btn btn-sm" type="button" onClick={() => openManage(i)}>
              {i.status === "open" || opts?.scheduleCta ? "Schedule / shop work" : "Shop work"}
            </button>
            {i.status === "completed" && (
              <button
                className="btn secondary btn-sm"
                type="button"
                onClick={() => printTechReceipt(i)}
              >
                Print tech receipt
              </button>
            )}
            {needsTechConfirm && i.status === "scheduled" && (
              <span className="muted" style={{ fontSize: "0.82rem", alignSelf: "center" }}>
                Tech has not confirmed yet
              </span>
            )}
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

  const receiptIssue =
    printTarget?.kind === "receipt" ? printTarget.issue : null;
  const receiptUnpacked = unpackWorkPerformed(receiptIssue?.work_performed);

  return (
    <div className="issues-page">
      <div className="shop-screen">
      <div className="page-header">
        <div>
          <h1>
            {isDriver
              ? "Report a problem"
              : "Shop board"}
          </h1>
          <p>
            {isDriver
              ? "Tell us what’s wrong — pick from the list. Flat tires go out as emergency. When the shop books a day, you’ll get an alert to bring the unit in."
              : "Needs scheduling first. Book a date and the tech is notified. Mark In progress when the van is in the bay. Log shop work yourself when you fix something without a driver ticket. Supervisors: Done today shows completed work by day. After a job, print a tech receipt for the driver."}
          </p>
        </div>
        <div className="toolbar no-print">
          {canShop && (
            <button className="btn btn-sm" type="button" onClick={openShopLog}>
              Log shop work
            </button>
          )}
          {can(user, "reportIssues") && !isOffice && (
            <button className="btn secondary btn-sm" type="button" onClick={() => setShowNew(true)}>
              {isDriver ? "New request" : "Report issue"}
            </button>
          )}
          {canShop && (
            <Link className="btn secondary btn-sm" to="/parts-orders">
              Order parts
            </Link>
          )}
          {canShop && (
            <button className="btn secondary btn-sm" type="button" onClick={printOpenWorkOrder}>
              Print work order
            </button>
          )}
          {canShop && filter === "done_day" && issues.length > 0 && (
            <button className="btn secondary btn-sm" type="button" onClick={printCompletedDayLog}>
              Print day log
            </button>
          )}
        </div>
      </div>

      {postComplete && canShop && (
        <div className="shop-post-complete card no-print" role="status">
          <div>
            <strong>Unit {postComplete.unitNumber} job finished</strong>
            <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.88rem" }}>
              Print a receipt for the tech, or review parts costs for this unit.
            </p>
          </div>
          <div className="toolbar">
            {postComplete.issue && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => printTechReceipt(postComplete.issue!)}
              >
                Print tech receipt
              </button>
            )}
            <Link
              className="btn secondary btn-sm"
              to={`/parts-receipts?vehicle=${postComplete.vehicleId}`}
            >
              Unit parts history
            </Link>
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={() => setPostComplete(null)}
            >
              Dismiss
            </button>
          </div>
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
              ["done_day", "Done today"],
              ["open", `Needs schedule${needsSchedule.length ? ` (${needsSchedule.length})` : ""}`],
              ["scheduled", "Scheduled"],
              ["in_progress", "In progress"],
              ["completed", "All completed"],
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

      {canShop && filter === "done_day" && (
        <div className="card no-print" style={{ marginBottom: "1rem" }}>
          <div
            className="toolbar"
            style={{ flexWrap: "wrap", gap: "0.75rem", alignItems: "flex-end" }}
          >
            <label style={{ margin: 0 }}>
              Completed on
              <input
                type="date"
                value={completedDay}
                onChange={(e) => setCompletedDay(e.target.value || todayIsoDate())}
                style={{ display: "block", marginTop: "0.25rem" }}
              />
            </label>
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={() => setCompletedDay(todayIsoDate())}
            >
              Today
            </button>
            {issues.length > 0 && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={printCompletedDayLog}
              >
                Print day log
              </button>
            )}
            <p className="muted" style={{ margin: 0, fontSize: "0.88rem", flex: "1 1 12rem" }}>
              Day-to-day shop work for supervisors — unit, what was done, who logged it. Print a
              single tech receipt on each job, or print the full day log.
            </p>
          </div>
        </div>
      )}

      {canShop && filter === "done_day" ? (
        <div className="shop-unit-list">
          {(() => {
            if (!issues.length) {
              return (
                <div className="muted empty">
                  No completed shop work on {completedDay}. Change the date or use{" "}
                  <strong>Log shop work</strong> when you finish a job without a driver ticket.
                </div>
              );
            }
            return groupIssuesByVehicle(issues).map((g) =>
              renderVehicleGroup(g, { defaultOpen: true, scheduleCta: false })
            );
          })()}
        </div>
      ) : canShop && filter === "today" ? (
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

      {showShopLog && canShop && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!submitting) setShowShopLog(false);
          }}
        >
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>Log shop work</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Record work you did in the shop without a driver repair request. No tech appointment
              confirm. Supervisors see it under <strong>Done today</strong>.
            </p>
            <form className="form" onSubmit={createShopWork}>
              <VehicleQuickPick
                value={sVehicleId}
                vehicles={vehicles as VehicleMatch[]}
                onChange={(id) => {
                  setSVehicleId(id);
                  const veh = vehicles.find((v) => String(v.id) === String(id));
                  if (veh?.current_odometer != null) {
                    setSOilOdo(String(veh.current_odometer));
                  }
                }}
                required
                disabled={submitting}
                label="Unit worked on"
                placeholder="Type plate or unit #…"
              />
              <label>
                Status
                <select
                  value={sStatus}
                  onChange={(e) =>
                    setSStatus(e.target.value === "in_progress" ? "in_progress" : "completed")
                  }
                  disabled={submitting}
                >
                  <option value="completed">Completed — job done</option>
                  <option value="in_progress">In progress — unit in the bay now</option>
                </select>
              </label>
              {sStatus === "in_progress" && (
                <div className="info-banner" role="status">
                  Marks the unit out of service until you complete the job from the shop board.
                </div>
              )}
              <div className="shop-concerns-block">
                <label className="shop-concerns-label" htmlFor="shop-log-concerns-summary">
                  Vehicle issues / tech concerns
                  {sStatus === "completed" ? " *" : ""}
                </label>
                <details className="shop-concerns-dropdown">
                  <summary id="shop-log-concerns-summary" className="shop-concerns-summary">
                    <span className="shop-concerns-summary-text">
                      {sConcerns.length === 0
                        ? "Select concerns…"
                        : sConcerns.length === 1
                          ? sConcerns[0]
                          : `${sConcerns.length} selected`}
                    </span>
                    <span className="shop-concerns-summary-meta muted">
                      {sConcerns.length > 0 ? "tap to edit" : "check all that apply"}
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
                      const on = sConcerns.includes(label);
                      return (
                        <li key={label}>
                          <label className={`shop-concern-row${on ? " is-on" : ""}`}>
                            <span className="shop-concern-row-label">{label}</span>
                            <input
                              type="checkbox"
                              className="shop-concern-row-check"
                              checked={on}
                              onChange={() => toggleShopConcern(label)}
                              disabled={submitting}
                            />
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </details>
                {sConcerns.length > 1 && (
                  <p className="shop-concerns-picks muted" aria-live="polite">
                    {sConcerns.join(" · ")}
                  </p>
                )}
              </div>
              <label>
                Problem found{sStatus === "completed" ? " *" : ""}
                <textarea
                  value={sProblemFound}
                  onChange={(e) => setSProblemFound(e.target.value)}
                  rows={2}
                  placeholder="What was wrong"
                  disabled={submitting}
                />
              </label>
              <label>
                Diagnostics / troubleshooting
                <textarea
                  value={sDiagnostics}
                  onChange={(e) => setSDiagnostics(e.target.value)}
                  rows={2}
                  placeholder="Tests, codes, findings"
                  disabled={submitting}
                />
              </label>
              <label>
                Work performed{sStatus === "completed" ? " *" : ""}
                <textarea
                  value={sWork}
                  onChange={(e) => setSWork(e.target.value)}
                  rows={sStatus === "completed" ? 3 : 2}
                  placeholder="What you did"
                  disabled={submitting}
                  required={sStatus === "completed"}
                />
              </label>
              <label>
                Parts used
                <textarea
                  value={sParts}
                  onChange={(e) => setSParts(e.target.value)}
                  rows={2}
                  placeholder="Part #s, description"
                  disabled={submitting}
                />
              </label>
              <label>
                Labor hours
                <input
                  type="number"
                  min={0}
                  step={0.25}
                  value={sLabor}
                  onChange={(e) => setSLabor(e.target.value)}
                  disabled={submitting}
                  placeholder="e.g. 1.5"
                />
              </label>
              {sStatus === "completed" && shopLogIsOil && (
                <>
                  <label>
                    Odometer at oil change *
                    <input
                      type="number"
                      min={0}
                      value={sOilOdo}
                      onChange={(e) => setSOilOdo(e.target.value)}
                      required
                      disabled={submitting}
                    />
                  </label>
                  <label>
                    Interval (miles)
                    <input
                      type="number"
                      min={1000}
                      step={500}
                      value={sOilInterval}
                      onChange={(e) => setSOilInterval(e.target.value)}
                      disabled={submitting}
                    />
                  </label>
                </>
              )}
              {submitting && (
                <div className="info-banner" role="status" aria-live="polite">
                  Saving shop work…
                </div>
              )}
              <div className="toolbar">
                <button className="btn" type="submit" disabled={submitting}>
                  {submitting
                    ? "Saving…"
                    : sStatus === "completed"
                      ? "Log completed work"
                      : "Start in-progress job"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={submitting}
                  onClick={() => setShowShopLog(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
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
              <VehicleQuickPick
                value={vehicleId}
                vehicles={vehicles as VehicleMatch[]}
                onChange={(id) => setVehicleId(id)}
                required
                disabled={submitting}
                label="License plate or unit #"
                placeholder="Type plate to find the unit…"
              />
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
                  away in the app (and SMS if Twilio is set up).
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
            {manage.status === "scheduled" && (
              <p className="schedule-confirm-manage" style={{ marginTop: 0 }}>
                <strong>Tech confirm: </strong>
                {manage.tech_confirm_status === "confirmed" ? (
                  <span className="confirm-text-ok">
                    Confirmed
                    {manage.tech_confirmed_by_name ? ` by ${manage.tech_confirmed_by_name}` : ""}
                    {manage.tech_confirmed_at
                      ? ` · ${String(manage.tech_confirmed_at).slice(0, 16).replace("T", " ")}`
                      : ""}
                  </span>
                ) : manage.tech_confirm_status === "declined" ? (
                  <span className="confirm-text-bad">
                    Declined
                    {manage.tech_confirm_note ? ` — ${manage.tech_confirm_note}` : ""}
                  </span>
                ) : (
                  <span className="confirm-text-pending">Awaiting tech confirmation</span>
                )}
              </p>
            )}
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
                  (manage.assigned_driver || manage.reporter_name
                    ? `Set the day the van comes in. Alert goes to: ${[
                        manage.assigned_driver
                          ? `driver “${manage.assigned_driver}”`
                          : null,
                        manage.reporter_name
                          ? `reporter “${manage.reporter_name}”`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" + ")}. Truck stays on the road until you mark In progress.`
                    : "Set the day the van comes in. No assigned driver on this unit — after save, call the tech and set the driver under Vehicles.")}
                {mStatus === "in_progress" &&
                  "Unit is in the shop now — marks it out of service. Log concerns and diagnostics as you go — finish details on complete."}
                {mStatus === "completed" &&
                  "Record what was wrong, what you fixed, and upload parts receipts for this unit before you complete. Tech gets a done alert."}
                {mStatus === "cancelled" &&
                  "This job will leave the active board. Enter why — the tech is notified so they don’t still bring it in."}
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
                      <ShopJobPartsPanel
                        vehicleId={manage.vehicle_id}
                        unitNumber={manage.unit_number}
                        issueId={manage.id}
                        issueTitle={manage.title}
                        showReceipts
                        onReceiptCount={setJobReceiptCount}
                      />
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
                      <ShopJobPartsPanel
                        vehicleId={manage.vehicle_id}
                        unitNumber={manage.unit_number}
                        issueId={manage.id}
                        issueTitle={manage.title}
                        showReceipts
                        onReceiptCount={setJobReceiptCount}
                      />
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
                {mStatus !== "completed" && mStatus !== "in_progress" && (
                  <Link
                    className="btn secondary"
                    to={`/parts-orders?vehicle=${manage.vehicle_id}&unit=${encodeURIComponent(
                      manage.unit_number || ""
                    )}&issue=${manage.id}&desc=${encodeURIComponent(
                      (manage.title || manage.description || "").slice(0, 80)
                    )}`}
                  >
                    Order parts for unit
                  </Link>
                )}
                <button className="btn secondary" type="button" onClick={() => setManage(null)}>
                  Close
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      </div>
      {/* end shop-screen */}

      {/* Print: tech work-completed receipt (hand to driver) */}
      {canShop && receiptIssue && (
        <div className="print-only shop-print-receipt" aria-hidden>
          <header className="shop-receipt-header">
            <div>
              <p className="shop-receipt-brand">Total Assurance · Fleet shop</p>
              <h1>Work completed receipt</h1>
              <p className="shop-receipt-sub">For the technician / unit operator</p>
            </div>
            <div className="shop-receipt-meta">
              <div>
                <span className="shop-receipt-k">Job #</span> {receiptIssue.id || "—"}
              </div>
              <div>
                <span className="shop-receipt-k">Printed</span> {printPrintedOn}
              </div>
            </div>
          </header>

          <section className="shop-receipt-unit">
            <div className="shop-receipt-unit-main">
              <span className="shop-receipt-unit-label">Unit</span>
              <strong className="shop-receipt-unit-num">{receiptIssue.unit_number}</strong>
            </div>
            <div className="shop-receipt-grid">
              <div>
                <span className="shop-receipt-k">Assigned driver</span>
                <div>{receiptIssue.assigned_driver?.trim() || "—"}</div>
              </div>
              <div>
                <span className="shop-receipt-k">Completed</span>
                <div>{formatPrintWhen(receiptIssue.completed_at)}</div>
              </div>
              <div>
                <span className="shop-receipt-k">Completed by</span>
                <div>
                  {receiptIssue.completed_by_name || user?.display_name || "Shop"}
                </div>
              </div>
              <div>
                <span className="shop-receipt-k">Source</span>
                <div>
                  {receiptIssue.origin === "shop"
                    ? "Shop logged (no driver ticket)"
                    : `Reported by ${receiptIssue.reporter_name || "—"}`}
                </div>
              </div>
            </div>
          </section>

          <section className="shop-receipt-block">
            <h2>Reported / title</h2>
            <p>{receiptIssue.title}</p>
            {receiptIssue.description ? (
              <p className="shop-receipt-muted">
                <strong>Tech said:</strong> {receiptIssue.description}
              </p>
            ) : null}
          </section>

          {receiptIssue.mechanic_diagnosis ? (
            <section className="shop-receipt-block">
              <h2>Vehicle / tech concerns</h2>
              <p>{receiptIssue.mechanic_diagnosis}</p>
            </section>
          ) : null}

          {receiptIssue.completion_notes ? (
            <section className="shop-receipt-block">
              <h2>Problem found</h2>
              <p className="shop-receipt-pre">{receiptIssue.completion_notes}</p>
            </section>
          ) : null}

          {(receiptUnpacked.diagnostics || receiptUnpacked.work) && (
            <section className="shop-receipt-block">
              {receiptUnpacked.diagnostics ? (
                <>
                  <h2>Diagnostics / troubleshooting</h2>
                  <p className="shop-receipt-pre">{receiptUnpacked.diagnostics}</p>
                </>
              ) : null}
              {receiptUnpacked.work ? (
                <>
                  <h2>Work performed</h2>
                  <p className="shop-receipt-pre">{receiptUnpacked.work}</p>
                </>
              ) : null}
            </section>
          )}

          {!receiptUnpacked.diagnostics &&
            !receiptUnpacked.work &&
            receiptIssue.work_performed && (
              <section className="shop-receipt-block">
                <h2>Work performed</h2>
                <p className="shop-receipt-pre">{receiptIssue.work_performed}</p>
              </section>
            )}

          <section className="shop-receipt-block shop-receipt-parts">
            <div className="shop-receipt-grid">
              <div>
                <span className="shop-receipt-k">Parts used</span>
                <p className="shop-receipt-pre">
                  {receiptIssue.parts_used?.trim() || "— none listed —"}
                </p>
              </div>
              <div>
                <span className="shop-receipt-k">Labor hours</span>
                <p>
                  {receiptIssue.labor_hours != null &&
                  receiptIssue.labor_hours !== undefined
                    ? String(receiptIssue.labor_hours)
                    : "—"}
                </p>
              </div>
            </div>
          </section>

          <footer className="shop-receipt-sign">
            <div className="shop-receipt-sign-line">
              <span>Mechanic sign / print</span>
              <span className="shop-receipt-line" />
            </div>
            <div className="shop-receipt-sign-line">
              <span>Tech received unit</span>
              <span className="shop-receipt-line" />
            </div>
            <div className="shop-receipt-sign-line">
              <span>Date / time</span>
              <span className="shop-receipt-line" />
            </div>
            <p className="shop-receipt-foot-note">
              Keep this slip with the unit paperwork. Shop copy is on file in Field App →
              Repairs → Done today.
            </p>
          </footer>
        </div>
      )}

      {/* Print: completed work day log (supervisors / shop) */}
      {canShop && (
        <div className="print-only shop-print-day-log" aria-hidden>
          <header className="shop-print-header">
            <h1>Shop work completed log</h1>
            <p>
              {formatPrintDay(completedDay)} · printed {printPrintedOn}
              {issues.filter((i) => i.status === "completed").length
                ? ` · ${issues.filter((i) => i.status === "completed").length} job${
                    issues.filter((i) => i.status === "completed").length === 1
                      ? ""
                      : "s"
                  }`
                : ""}
            </p>
            <p className="shop-print-cover-note">
              Day-to-day completed shop work for supervisors and office. One line per job.
            </p>
          </header>
          {(() => {
            const done = issues.filter((i) => i.status === "completed");
            if (!done.length) {
              return <p>No completed jobs on this date.</p>;
            }
            return (
              <table className="shop-print-day-table">
                <thead>
                  <tr>
                    <th className="col-time">When</th>
                    <th className="col-unit">Unit</th>
                    <th className="col-driver">Driver</th>
                    <th>Work completed</th>
                    <th className="col-who">By</th>
                  </tr>
                </thead>
                <tbody>
                  {done.map((i) => {
                    const up = unpackWorkPerformed(i.work_performed);
                    const workLine =
                      up.work ||
                      up.diagnostics ||
                      i.work_performed ||
                      i.completion_notes ||
                      i.title;
                    return (
                      <tr key={i.id}>
                        <td className="col-time">
                          {formatPrintWhen(i.completed_at).slice(11) ||
                            formatPrintWhen(i.completed_at)}
                        </td>
                        <td className="col-unit">
                          <strong>{i.unit_number}</strong>
                          {i.origin === "shop" ? (
                            <div className="shop-print-day-tag">shop</div>
                          ) : null}
                        </td>
                        <td className="col-driver">
                          {i.assigned_driver?.trim() || "—"}
                        </td>
                        <td>
                          <div className="shop-print-issue-main">
                            {i.mechanic_diagnosis || i.title}
                          </div>
                          <div className="shop-print-issue-sub">
                            {workLine && workLine.length > 220
                              ? `${workLine.slice(0, 220)}…`
                              : workLine}
                          </div>
                          {i.parts_used ? (
                            <div className="shop-print-index-st">Parts: {i.parts_used}</div>
                          ) : null}
                          {i.labor_hours != null ? (
                            <div className="shop-print-index-st">
                              Labor: {i.labor_hours}h
                            </div>
                          ) : null}
                        </td>
                        <td className="col-who">
                          {i.completed_by_name || i.reporter_name || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })()}
          <footer className="shop-print-unit-foot">
            Reviewed by: ________________ · Date: ________
          </footer>
        </div>
      )}

      {/* Print: open work order list by unit */}
      {canShop && (
        <div className="print-only shop-print-worklist" aria-hidden>
          <header className="shop-print-header">
            <h1>Shop work order</h1>
            <p>
              Printed {printPrintedOn}
              {printByVehicle.length
                ? ` · ${printByVehicle.length} unit${
                    printByVehicle.length === 1 ? "" : "s"
                  } · ${
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
              All issues listed by unit number (numerical order). Continuous pages — not one
              sheet per vehicle.
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
                    <td className="col-driver">{g.assigned_driver?.trim() || "—"}</td>
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
    </div>
  );
}
