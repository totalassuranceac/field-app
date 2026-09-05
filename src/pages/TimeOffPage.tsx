import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

type TimeOffStatus = "pending" | "approved" | "declined" | "cancelled";
type TimeOffType = "pto" | "sick" | "personal" | "unpaid" | "other";
type TimeOffTab = "mine" | "approvals" | "board" | "upcoming" | "report" | "payroll";

type PayrollCheckItem = {
  id: number;
  employee_name: string;
  employee_id: number | null;
  user_id: number;
  request_type: string;
  type_label: string;
  start_date: string;
  end_date: string;
  hours_deducted: number;
  hours_actual: number | null;
  usage_status: string;
  usage_note: string | null;
  bank_linked: boolean;
  reason: string | null;
};

/** Chicago calendar parts for an Instant. */
function chicagoYmdParts(anchor = new Date()): {
  y: number;
  m: number;
  d: number;
  dayIdx: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(anchor);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const wd = get("weekday");
  const dayIdx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    dayIdx: dayIdx < 0 ? 0 : dayIdx,
  };
}

/**
 * Previous completed Sat→Fri pay week (America/Chicago).
 * Payroll is reviewed on Monday looking at last Sat–Fri.
 */
function previousSatFriPayWeek(anchor = new Date()): { from: string; to: string } {
  const { y, m, d, dayIdx } = chicagoYmdParts(anchor);
  // dayIdx: Sun=0 … Sat=6. Days since this week's Saturday:
  // Sat=0, Sun=1, Mon=2, … Fri=6
  const daysSinceSat = (dayIdx + 1) % 7;
  const noon = Date.UTC(y, m - 1, d, 12, 0, 0);
  // This week's Saturday
  const thisSat = new Date(noon - daysSinceSat * 86400000);
  // Previous week's Saturday / Friday
  const prevSat = new Date(thisSat.getTime() - 7 * 86400000);
  const prevFri = new Date(thisSat.getTime() - 1 * 86400000);
  const iso = (dt: Date) =>
    `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  return { from: iso(prevSat), to: iso(prevFri) };
}

function usageStatusLabel(s: string): string {
  if (s === "taken") return "Took it";
  if (s === "partial") return "Partial";
  if (s === "not_taken") return "Came in (restored)";
  return "Needs confirm";
}

type PtoBoardRow = {
  employee_id: number;
  name: string;
  hire_date: string | null;
  birthday_md: string | null;
  years_of_service: number;
  last_anniversary: string | null;
  next_anniversary: string | null;
  vacation_entitlement: number;
  vacation_used: number;
  vacation_balance: number;
  sick_entitlement: number;
  sick_used: number;
  sick_balance: number;
};

type UpcomingEvent = {
  employee_id: number;
  name: string;
  event_type: "birthday" | "anniversary";
  date: string;
  years_of_service?: number;
};

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
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function formatMdBirthday(md: string | null | undefined): string {
  if (!md) return "—";
  const [m, d] = md.split("-");
  if (!m || !d) return md;
  return `${Number(m)}/${Number(d)}`;
}

function formatDisplayDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

function overageParts(row: PtoBoardRow) {
  const vacOwe = row.vacation_balance < 0 ? Math.abs(row.vacation_balance) : 0;
  const sickOwe = row.sick_balance < 0 ? Math.abs(row.sick_balance) : 0;
  const totalOwe = vacOwe + sickOwe;
  const banks: string[] = [];
  if (vacOwe > 0) banks.push(`${vacOwe} hour${vacOwe === 1 ? "" : "s"} vacation`);
  if (sickOwe > 0) banks.push(`${sickOwe} hour${sickOwe === 1 ? "" : "s"} sick`);
  return { vacOwe, sickOwe, totalOwe, banks };
}

function OverageLetterhead({
  subtitle,
  preparedBy,
  preparedOn,
}: {
  subtitle: string;
  preparedBy: string;
  preparedOn: string;
}) {
  return (
    <header className="pto-overage-letterhead pto-print-letterhead">
      <div className="pto-print-brand">
        <img
          className="pto-print-wordmark"
          src="/logo-form-primary.png"
          alt="Total Assurance"
        />
        <div className="pto-print-subtitle">{subtitle}</div>
      </div>
      <div className="pto-print-meta">
        <div className="pto-print-meta-label">Document date</div>
        <div className="pto-print-meta-date">{formatDisplayDate(preparedOn)}</div>
        <div className="pto-print-meta-by">Prepared by {preparedBy}</div>
      </div>
    </header>
  );
}

function OverageOweSummary({
  vacOwe,
  sickOwe,
  totalOwe,
  label = "Hours owed",
}: {
  vacOwe: number;
  sickOwe: number;
  totalOwe: number;
  label?: string;
}) {
  return (
    <div className="pto-owe-strip" role="status">
      <div className="pto-owe-strip-main">
        <span className="pto-owe-strip-label">{label}</span>
        <strong className="pto-owe-amount pto-owe-strip-total">{totalOwe} hours</strong>
      </div>
      <span className="pto-owe-strip-detail">
        {[
          vacOwe ? `Vacation ${vacOwe}h` : null,
          sickOwe ? `Sick ${sickOwe}h` : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—"}
      </span>
    </div>
  );
}

/** Page 1 — hour breakdown so the employee sees exactly where they went over. */
function OverageBreakdownPage({
  row,
  preparedBy,
  preparedOn,
}: {
  row: PtoBoardRow;
  preparedBy: string;
  preparedOn: string;
}) {
  const { vacOwe, sickOwe, totalOwe } = overageParts(row);
  return (
    <div className="pto-overage-page pto-overage-page-breakdown">
      <OverageLetterhead
        subtitle="Page 1 of 2 · Balance & hours owed"
        preparedBy={preparedBy}
        preparedOn={preparedOn}
      />

      <h2 className="pto-print-doc-title">Time-off overage — hour breakdown</h2>
      <p className="pto-print-lead">
        Your vacation and sick banks as of <strong>{formatDisplayDate(preparedOn)}</strong>.
        Amounts in <strong className="pto-owe-amount">red</strong> are hours you currently owe.
      </p>

      <dl className="pto-overage-facts">
        <div>
          <dt>Employee</dt>
          <dd>{row.name}</dd>
        </div>
        <div>
          <dt>Hire date</dt>
          <dd>{row.hire_date ? formatDisplayDate(row.hire_date) : "—"}</dd>
        </div>
        <div>
          <dt>Years of service</dt>
          <dd>{row.years_of_service}</dd>
        </div>
        <div>
          <dt>Next anniversary</dt>
          <dd>{row.next_anniversary ? formatDisplayDate(row.next_anniversary) : "—"}</dd>
        </div>
      </dl>

      <OverageOweSummary vacOwe={vacOwe} sickOwe={sickOwe} totalOwe={totalOwe} />

      <table className="pto-board-table pto-overage-bal-table pto-print-table">
        <thead>
          <tr>
            <th>Bank</th>
            <th>Entitlement</th>
            <th>Used</th>
            <th>Balance</th>
            <th>Hours owed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Vacation</td>
            <td>{row.vacation_entitlement}h</td>
            <td>{row.vacation_used}h</td>
            <td className={row.vacation_balance < 0 ? "pto-owe-amount" : undefined}>
              {row.vacation_balance}h
            </td>
            <td>
              <strong className={vacOwe ? "pto-owe-amount" : undefined}>
                {vacOwe ? `${vacOwe}h` : "—"}
              </strong>
            </td>
          </tr>
          <tr>
            <td>Sick</td>
            <td>{row.sick_entitlement}h</td>
            <td>{row.sick_used}h</td>
            <td className={row.sick_balance < 0 ? "pto-owe-amount" : undefined}>
              {row.sick_balance}h
            </td>
            <td>
              <strong className={sickOwe ? "pto-owe-amount" : undefined}>
                {sickOwe ? `${sickOwe}h` : "—"}
              </strong>
            </td>
          </tr>
        </tbody>
      </table>

      <p className="pto-print-footnote">
        Entitlement = hours given this anniversary year · Used = hours taken · Balance =
        entitlement − used. Please review page 1, then sign the acknowledgment on page 2.
      </p>
    </div>
  );
}

/** Page 2 — employee + office acknowledgment (no blank dates to fill). */
function OverageSignPage({
  row,
  preparedBy,
  preparedOn,
}: {
  row: PtoBoardRow;
  preparedBy: string;
  preparedOn: string;
}) {
  const { vacOwe, sickOwe, totalOwe, banks } = overageParts(row);
  return (
    <div className="pto-overage-page pto-overage-page-sign">
      <OverageLetterhead
        subtitle="Page 2 of 2 · Employee acknowledgment"
        preparedBy={preparedBy}
        preparedOn={preparedOn}
      />

      <h2 className="pto-print-doc-title">Acknowledgment of time owed</h2>

      <OverageOweSummary
        vacOwe={vacOwe}
        sickOwe={sickOwe}
        totalOwe={totalOwe}
        label="Amount acknowledged"
      />

      <div className="pto-sign-panel">
        <p className="pto-sign-body">
          I, <strong>{row.name}</strong>, acknowledge that as of{" "}
          <strong>{formatDisplayDate(preparedOn)}</strong> I owe Total Assurance{" "}
          <strong className="pto-owe-amount">
            {banks.length ? banks.join(" and ") : `${totalOwe} hours`}
          </strong>{" "}
          (total <strong className="pto-owe-amount">{totalOwe} hours</strong>).
        </p>
        <p className="pto-sign-body">
          I used time beyond my current entitlement. I agree these owed hours will be{" "}
          <strong>deducted from my new vacation and/or sick time when it becomes available</strong>{" "}
          on my next hire-date anniversary
          {row.next_anniversary ? (
            <>
              {" "}
              (<strong>{formatDisplayDate(row.next_anniversary)}</strong>)
            </>
          ) : null}
          , or earlier if arranged with the office. I have reviewed the hour breakdown on page 1
          and had an opportunity to ask questions.
        </p>
      </div>

      <div className="pto-overage-signs">
        <div className="pto-overage-sign-block pto-overage-sign-employee">
          <div className="pto-overage-sign-caption">Employee acknowledgment</div>
          <div className="pto-overage-sign-line" aria-hidden="true" />
          <div className="pto-overage-sign-label">
            Signature — <strong>{row.name}</strong>
          </div>
          <div className="pto-overage-sign-hint">
            Signing confirms you have read and acknowledge this document dated{" "}
            {formatDisplayDate(preparedOn)}.
          </div>
        </div>
        <div className="pto-overage-sign-block pto-overage-sign-office">
          <div className="pto-overage-sign-caption">Office / manager witness</div>
          <div className="pto-overage-sign-line" aria-hidden="true" />
          <div className="pto-overage-sign-label">Signature — office received</div>
          <div className="pto-overage-sign-hint">
            Witness confirms the employee reviewed and signed this acknowledgment.
          </div>
        </div>
      </div>

      <p className="pto-print-footnote pto-print-file-note">
        File the signed original (both pages) in the employee personnel file. Document date and
        preparer are recorded above — no handwritten dates required.
      </p>
    </div>
  );
}

/** Standalone 2-page print packet (board “Print owe / sign-off”). */
function OverageAckForm({
  row,
  preparedBy,
  preparedOn,
}: {
  row: PtoBoardRow;
  preparedBy: string;
  preparedOn: string;
}) {
  return (
    <div className="pto-overage-form">
      <OverageBreakdownPage row={row} preparedBy={preparedBy} preparedOn={preparedOn} />
      <OverageSignPage row={row} preparedBy={preparedBy} preparedOn={preparedOn} />
    </div>
  );
}

/**
 * Request time off (everyone) and approve/decline (managers / office / admin).
 */
export function TimeOffPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TimeOffTab>("mine");
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

  const [myBalance, setMyBalance] = useState<PtoBoardRow | null>(null);
  const [boardRows, setBoardRows] = useState<PtoBoardRow[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingEvent[]>([]);
  const [reportEmpId, setReportEmpId] = useState("");
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportData, setReportData] = useState<{
    employee: { id: number; name: string };
    balance: PtoBoardRow | null;
    approved_requests: TimeOffRequest[];
    ledger: Array<{
      entry_date: string;
      kind: string;
      hours: number;
      source: string;
      note: string | null;
    }>;
  } | null>(null);
  /** Printable overage acknowledgment (employee signs they agree they used advance time) */
  const [overageForm, setOverageForm] = useState<PtoBoardRow | null>(null);

  const defaultWeek = useMemo(() => previousSatFriPayWeek(), []);
  const [payrollFrom, setPayrollFrom] = useState(defaultWeek.from);
  const [payrollTo, setPayrollTo] = useState(defaultWeek.to);
  const [payrollItems, setPayrollItems] = useState<PayrollCheckItem[]>([]);
  const [payrollPending, setPayrollPending] = useState(0);
  const [payrollBusy, setPayrollBusy] = useState(false);
  const [partialEditId, setPartialEditId] = useState<number | null>(null);
  const [partialHours, setPartialHours] = useState("");
  const [partialNote, setPartialNote] = useState("");

  const [adjustRow, setAdjustRow] = useState<PtoBoardRow | null>(null);
  const [adjustKind, setAdjustKind] = useState<"vacation" | "sick">("sick");
  const [adjustHours, setAdjustHours] = useState("");
  const [adjustNote, setAdjustNote] = useState("");
  /** Day the hours were actually used — required; not defaulted to today. */
  const [adjustUsedOn, setAdjustUsedOn] = useState("");
  const [adjustBusy, setAdjustBusy] = useState(false);

  function openManualAdjust(r: PtoBoardRow) {
    setAdjustRow(r);
    setAdjustKind(r.sick_balance < r.vacation_balance ? "sick" : "vacation");
    setAdjustHours("");
    setAdjustNote("");
    setAdjustUsedOn("");
  }

  const canSeeAllApprovals =
    user?.role === "admin" || user?.role === "office" || can(user, "manageUsers");
  const canSeeBoard =
    user?.role === "admin" || user?.role === "office" || user?.role === "supervisor";
  const canConfirmPayroll = user?.role === "admin" || user?.role === "office";

  const overRows = useMemo(
    () => boardRows.filter((r) => r.vacation_balance < 0 || r.sick_balance < 0),
    [boardRows]
  );

  function openOverageForm(row: PtoBoardRow) {
    setOverageForm(row);
    setTab("board");
    window.setTimeout(() => {
      document.getElementById("pto-overage-print")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 80);
  }

  async function printOverageForm(row: PtoBoardRow) {
    setOverageForm(row);
    setTab("board");
    document.body.classList.add("print-pto-overage");
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r()))
    );
    window.print();
  }

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, a, bal] = await Promise.all([
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
        api<PtoBoardRow & { linked?: boolean }>("/time-off/balances/me").catch(() => null),
      ]);
      if (m.error) setError(m.error);
      setMine(m.requests || []);
      setApprovals(a.requests || []);
      setIsManager(Boolean(m.is_manager || a.is_manager || canSeeAllApprovals));
      setPendingForMe(a.pending_for_me ?? m.pending_for_me ?? 0);
      setMyBalance(bal && bal.linked !== false && bal.employee_id ? bal : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load time-off");
    }
  }, [canSeeAllApprovals]);

  const loadBoard = useCallback(async () => {
    if (!canSeeBoard) return;
    try {
      const [b, u] = await Promise.all([
        api<{ rows: PtoBoardRow[] }>("/time-off/board"),
        api<{ events: UpcomingEvent[] }>("/time-off/upcoming"),
      ]);
      setBoardRows(b.rows || []);
      setUpcoming(u.events || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load PTO board");
    }
  }, [canSeeBoard]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab === "board" || tab === "upcoming" || tab === "report") void loadBoard();
    if (tab === "payroll" && canSeeBoard) void loadPayrollCheck();
  }, [tab, loadBoard, canSeeBoard]);

  // Deep-link from notification: open approvals if manager
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "approvals" && isManager) setTab("approvals");
    if (q.get("tab") === "board" && canSeeBoard) setTab("board");
    if (q.get("tab") === "payroll" && canSeeBoard) setTab("payroll");
  }, [isManager, canSeeBoard]);

  async function loadPayrollCheck(range?: { from: string; to: string }) {
    if (!canSeeBoard) return;
    const from = range?.from || payrollFrom;
    const to = range?.to || payrollTo;
    setPayrollBusy(true);
    setError("");
    try {
      const qs = new URLSearchParams({ from, to });
      const d = await api<{
        items: PayrollCheckItem[];
        pending_confirm: number;
      }>(`/time-off/payroll-check?${qs.toString()}`);
      setPayrollItems(d.items || []);
      setPayrollPending(d.pending_confirm || 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load payroll check");
    } finally {
      setPayrollBusy(false);
    }
  }

  async function confirmUsage(
    item: PayrollCheckItem,
    action: "taken" | "partial" | "not_taken",
    hoursActual?: number,
    note?: string
  ) {
    if (!canConfirmPayroll) {
      setError("Only office/admin can confirm payroll usage.");
      return;
    }
    setPayrollBusy(true);
    setError("");
    setOk("");
    try {
      await api(`/time-off/${item.id}/confirm-usage`, {
        method: "POST",
        body: JSON.stringify({
          action,
          hours_actual: hoursActual ?? null,
          note: note?.trim() || null,
        }),
      });
      setOk(
        action === "taken"
          ? `Marked took it · ${item.employee_name}`
          : action === "not_taken"
            ? `Restored hours · ${item.employee_name} came in`
            : `Partial hours saved · ${item.employee_name}`
      );
      setPartialEditId(null);
      setPartialHours("");
      setPartialNote("");
      await loadPayrollCheck();
      await loadBoard();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm usage");
    } finally {
      setPayrollBusy(false);
    }
  }

  async function submitManualAdjust(e: FormEvent) {
    e.preventDefault();
    if (!adjustRow || !canConfirmPayroll) return;
    const hours = Number(adjustHours);
    if (!Number.isFinite(hours) || hours === 0) {
      setError("Enter non-zero hours (positive = use more, negative = restore).");
      return;
    }
    const usedOn = adjustUsedOn.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(usedOn)) {
      setError("Pick the Used on date — the day those hours were actually used.");
      return;
    }
    if (!adjustNote.trim()) {
      setError("Note is required for manual adjustments.");
      return;
    }
    setAdjustBusy(true);
    setError("");
    setOk("");
    try {
      await api("/time-off/manual-adjust", {
        method: "POST",
        body: JSON.stringify({
          employee_id: adjustRow.employee_id,
          kind: adjustKind,
          hours,
          note: adjustNote.trim(),
          entry_date: usedOn,
        }),
      });
      const kindLabel = adjustKind === "sick" ? "sick" : "vacation";
      setOk(
        `Adjusted ${adjustRow.name}: ${hours > 0 ? "+" : ""}${hours}h ${kindLabel} · used on ${formatDisplayDate(usedOn)}`
      );
      setAdjustRow(null);
      setAdjustHours("");
      setAdjustNote("");
      setAdjustUsedOn("");
      await loadBoard();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Adjust failed");
    } finally {
      setAdjustBusy(false);
    }
  }

  useEffect(() => {
    function onAfterPrint() {
      document.body.classList.remove("print-pto-report");
      document.body.classList.remove("print-pto-overage");
    }
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("afterprint", onAfterPrint);
      document.body.classList.remove("print-pto-report");
      document.body.classList.remove("print-pto-overage");
    };
  }, []);

  type ReportPayload = {
    employee: { id: number; name: string };
    balance: PtoBoardRow | null;
    approved_requests: TimeOffRequest[];
    ledger: Array<{
      entry_date: string;
      kind: string;
      hours: number;
      source: string;
      note: string | null;
    }>;
  };

  /** Anniversary-year window: last anniversary (or hire date) → today. */
  function reportRangeForEmployee(empId: string): { from: string; to: string } {
    const row = boardRows.find((r) => String(r.employee_id) === empId);
    const to = todayIso();
    const from =
      (row?.last_anniversary && /^\d{4}-\d{2}-\d{2}$/.test(row.last_anniversary)
        ? row.last_anniversary
        : null) ||
      (row?.hire_date && /^\d{4}-\d{2}-\d{2}$/.test(row.hire_date) ? row.hire_date : null) ||
      to;
    return { from, to };
  }

  function applyReportDefaultsForEmployee(empId: string) {
    if (!empId) {
      setReportFrom("");
      setReportTo("");
      return { from: "", to: "" };
    }
    const range = reportRangeForEmployee(empId);
    setReportFrom(range.from);
    setReportTo(range.to);
    return range;
  }

  async function fetchReport(range?: {
    from?: string;
    to?: string;
  }): Promise<ReportPayload | null> {
    if (!reportEmpId) {
      setError("Pick an employee for the report.");
      return null;
    }
    const from = range?.from ?? reportFrom;
    const to = range?.to ?? reportTo;
    const qs = new URLSearchParams({ employee_id: reportEmpId });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return api<ReportPayload>(`/time-off/report?${qs.toString()}`);
  }

  async function loadReport() {
    setBusy(true);
    setError("");
    try {
      const d = await fetchReport();
      if (d) setReportData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load report");
    } finally {
      setBusy(false);
    }
  }

  /** One button: load the selected employee’s report, then open the print dialog. */
  async function printReport() {
    if (!reportEmpId) {
      setError("Pick an employee for the report.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      // Always refresh To = today; From = anniversary year start if empty
      const defaults = reportRangeForEmployee(reportEmpId);
      const from = reportFrom || defaults.from;
      const to = todayIso();
      setReportFrom(from);
      setReportTo(to);
      const d = await fetchReport({ from, to });
      if (!d) return;
      setReportData(d);
      document.body.classList.add("print-pto-report");
      // Let React paint the report before the print stylesheet runs
      await new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))
      );
      window.print();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not print report");
      document.body.classList.remove("print-pto-report");
    } finally {
      setBusy(false);
    }
  }

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

  /** Hours this form would request (8h × inclusive calendar days). */
  const formHoursNeeded = useMemo(() => {
    if (!startDate) return 0;
    const end = endDate || startDate;
    const a = Date.parse(startDate + "T12:00:00Z");
    const b = Date.parse(end + "T12:00:00Z");
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
    return (Math.round((b - a) / 86400000) + 1) * 8;
  }, [startDate, endDate]);

  const formBankGate = useMemo(() => {
    if (requestType !== "pto" && requestType !== "sick") {
      return { gated: false as const, available: null as number | null, ok: true };
    }
    if (!myBalance) {
      return { gated: true as const, available: null as number | null, ok: false };
    }
    const pendingSame = mine
      .filter((r) => r.status === "pending" && r.request_type === requestType)
      .reduce((sum, r) => {
        const a = Date.parse(r.start_date + "T12:00:00Z");
        const b = Date.parse(r.end_date + "T12:00:00Z");
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return sum;
        return sum + (Math.round((b - a) / 86400000) + 1) * 8;
      }, 0);
    const bal =
      requestType === "sick" ? myBalance.sick_balance : myBalance.vacation_balance;
    const available = bal - pendingSame;
    return {
      gated: true as const,
      available,
      pendingSame,
      ok: formHoursNeeded <= available + 1e-9,
      label: requestType === "sick" ? "sick" : "vacation",
    };
  }, [requestType, myBalance, mine, formHoursNeeded]);

  return (
    <div className="page time-off-page">
      <div className="page-header">
        <div>
          <h1>Time off</h1>
          <p>
            Request days off and track vacation &amp; sick balances
            {canSeeBoard ? " — office board and Adjust are here" : ""}. Vacation and sick
            requests can only be submitted for hours you still have available.
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
        {canSeeBoard && (
          <>
            <button
              type="button"
              className={`chip ${tab === "board" ? "active" : ""}`}
              onClick={() => setTab("board")}
            >
              PTO board
            </button>
            <button
              type="button"
              className={`chip ${tab === "upcoming" ? "active" : ""}`}
              onClick={() => setTab("upcoming")}
            >
              Birthdays / anniversaries
            </button>
            <button
              type="button"
              className={`chip ${tab === "payroll" ? "active" : ""}`}
              onClick={() => setTab("payroll")}
            >
              Payroll check
              {payrollPending ? ` (${payrollPending})` : ""}
            </button>
            <button
              type="button"
              className={`chip ${tab === "report" ? "active" : ""}`}
              onClick={() => setTab("report")}
            >
              Print report
            </button>
          </>
        )}
      </div>

      {tab === "mine" && myBalance && (
        <div className="card pto-my-balances" style={{ marginBottom: "0.85rem" }}>
          <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>My balances (hours)</h2>
          <div className="pto-balance-grid">
            <div>
              <span className="muted">Vacation</span>
              <strong
                className={myBalance.vacation_balance < 0 ? "pto-neg" : undefined}
                style={{ display: "block", fontSize: "1.35rem" }}
              >
                {myBalance.vacation_balance}
              </strong>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                {myBalance.vacation_used} used of {myBalance.vacation_entitlement}
              </span>
            </div>
            <div>
              <span className="muted">Sick</span>
              <strong
                className={myBalance.sick_balance < 0 ? "pto-neg" : undefined}
                style={{ display: "block", fontSize: "1.35rem" }}
              >
                {myBalance.sick_balance}
              </strong>
              <span className="muted" style={{ fontSize: "0.78rem" }}>
                {myBalance.sick_used} used of {myBalance.sick_entitlement}
              </span>
            </div>
          </div>
          {myBalance.next_anniversary && (
            <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem" }}>
              Next anniversary {myBalance.next_anniversary} — banks refresh automatically that day.
            </p>
          )}
        </div>
      )}

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
          {formBankGate.gated && (
            <p
              className={formBankGate.ok ? "muted" : "error"}
              style={{ margin: 0, fontSize: "0.85rem" }}
            >
              {myBalance == null
                ? "Vacation/sick requests need your login linked to People. Ask office to link you — unpaid leave can still be requested."
                : formBankGate.ok
                  ? `This request uses ${formHoursNeeded}h ${formBankGate.label}. Available: ${Math.max(0, Math.round((formBankGate.available || 0) * 10) / 10)}h${
                      (formBankGate.pendingSame || 0) > 0
                        ? ` (${formBankGate.pendingSame}h already pending)`
                        : ""
                    }.`
                  : `Not enough ${formBankGate.label} hours. Needs ${formHoursNeeded}h; available ${Math.max(0, Math.round((formBankGate.available || 0) * 10) / 10)}h${
                      (formBankGate.pendingSame || 0) > 0
                        ? ` (${formBankGate.pendingSame}h already pending)`
                        : ""
                    }. Use unpaid if you have no bank hours left.`}
            </p>
          )}
          <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
            Goes to your assigned manager
            {user?.role === "admin" || user?.role === "office"
              ? " (or office/admin if no manager is set)"
              : " in People / Admin. If none is set, office/admin is notified."}
            .
          </p>
          <div className="toolbar">
            <button
              className="btn"
              type="submit"
              disabled={busy || (formBankGate.gated && !formBankGate.ok)}
            >
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

      {tab === "board" && canSeeBoard && (
        <section className="pto-board">
          <div className="card" style={{ marginBottom: "0.75rem" }}>
            <div className="toolbar" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
              <button type="button" className="btn secondary btn-sm" onClick={() => void loadBoard()}>
                Refresh
              </button>
            </div>
            <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.82rem" }}>
              Balances can go negative (they owe hours). On each hire anniversary, vacation &amp; sick
              used reset automatically. When someone is over, use{" "}
              <strong>Print owe / sign-off</strong> below — they sign that owed hours come out of
              their next grant.
            </p>
            <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
              <strong>Rehire rule:</strong> mark leavers inactive in People (set last day). If they
              return after <strong>90+ days</strong>, PTO restarts from the rehire date (banks → 0
              until their new first anniversary). Under 90 days keeps prior hire date and banks.
            </p>
          </div>
          {overRows.length > 0 && (
            <div className="card no-print" style={{ marginBottom: "0.75rem" }}>
              <h3 style={{ marginTop: 0 }}>
                People over — hours owed ({overRows.length})
              </h3>
              <p className="muted" style={{ fontSize: "0.85rem", marginTop: 0 }}>
                Print a sign-off for each person. Keep the signed copy in their file — owed hours
                come out when new time grants on their anniversary.
              </p>
              <ul className="pto-over-list">
                {overRows.map((r) => {
                  const vacOwe = r.vacation_balance < 0 ? Math.abs(r.vacation_balance) : 0;
                  const sickOwe = r.sick_balance < 0 ? Math.abs(r.sick_balance) : 0;
                  return (
                    <li key={r.employee_id} className="pto-over-list-row">
                      <div>
                        <strong>{r.name}</strong>
                        <span className="muted" style={{ marginLeft: "0.5rem", fontSize: "0.85rem" }}>
                          {[
                            vacOwe ? `${vacOwe}h vacation owed` : null,
                            sickOwe ? `${sickOwe}h sick owed` : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                          {r.next_anniversary
                            ? ` · next grant ${formatDisplayDate(r.next_anniversary)}`
                            : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void printOverageForm(r)}
                      >
                        Print owe / sign-off
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="card pto-board-table-wrap no-print">
            {!boardRows.length ? (
              <p className="muted" style={{ margin: 0 }}>
                No employees on the board yet. Add hire dates in People.
              </p>
            ) : (
              <>
                {/* Desktop / tablet: compact table, sticky Adjust column */}
                <div className="pto-board-desktop">
                  <table className="pto-board-table pto-board-table-fit">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Hired</th>
                        <th>Yrs</th>
                        <th>Next anniv.</th>
                        <th>Vacation</th>
                        <th>Sick</th>
                        <th className="pto-board-actions-col">Adjust</th>
                      </tr>
                    </thead>
                    <tbody>
                      {boardRows.map((r) => {
                        const over = r.vacation_balance < 0 || r.sick_balance < 0;
                        return (
                          <tr key={r.employee_id} className={over ? "pto-row-over" : undefined}>
                            <td className="pto-board-name-cell">
                              <strong>{r.name}</strong>
                              {over ? (
                                <span className="badge danger" style={{ marginLeft: "0.35rem" }}>
                                  Over
                                </span>
                              ) : null}
                              {r.birthday_md ? (
                                <div className="muted pto-board-bday">Bday {r.birthday_md}</div>
                              ) : null}
                            </td>
                            <td>{r.hire_date || "—"}</td>
                            <td>{r.years_of_service}</td>
                            <td>{r.next_anniversary || "—"}</td>
                            <td
                              className={`pto-bank-cell${
                                r.vacation_balance < 0 ? " pto-neg" : ""
                              }`}
                            >
                              <span className="pto-bank-bal">
                                {r.vacation_balance}
                                <span className="muted"> / {r.vacation_entitlement}</span>
                              </span>
                              <span className="muted pto-bank-used">used {r.vacation_used}</span>
                            </td>
                            <td
                              className={`pto-bank-cell${r.sick_balance < 0 ? " pto-neg" : ""}`}
                            >
                              <span className="pto-bank-bal">
                                {r.sick_balance}
                                <span className="muted"> / {r.sick_entitlement}</span>
                              </span>
                              <span className="muted pto-bank-used">used {r.sick_used}</span>
                            </td>
                            <td className="pto-board-actions-col">
                              <div className="pto-board-actions">
                                {canConfirmPayroll ? (
                                  <button
                                    type="button"
                                    className="btn secondary btn-sm"
                                    onClick={() => openManualAdjust(r)}
                                  >
                                    Adjust
                                  </button>
                                ) : null}
                                {over ? (
                                  <button
                                    type="button"
                                    className="btn secondary btn-sm"
                                    onClick={() => void printOverageForm(r)}
                                    title="Print acknowledgment of hours owed"
                                  >
                                    Print owe
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Phone: one card per employee — no sideways scroll */}
                <ul className="pto-board-cards">
                  {boardRows.map((r) => {
                    const over = r.vacation_balance < 0 || r.sick_balance < 0;
                    return (
                      <li
                        key={r.employee_id}
                        className={`pto-board-card${over ? " is-over" : ""}`}
                      >
                        <div className="pto-board-card-head">
                          <div>
                            <strong>{r.name}</strong>
                            {over ? (
                              <span className="badge danger" style={{ marginLeft: "0.35rem" }}>
                                Over
                              </span>
                            ) : null}
                            <div className="muted pto-board-card-meta">
                              {[
                                r.hire_date ? `Hired ${r.hire_date}` : null,
                                `${r.years_of_service} yr`,
                                r.next_anniversary ? `Next ${r.next_anniversary}` : null,
                                r.birthday_md ? `Bday ${r.birthday_md}` : null,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                            </div>
                          </div>
                        </div>
                        <div className="pto-board-card-banks">
                          <div>
                            <span className="pto-board-card-label">Vacation</span>
                            <span className={r.vacation_balance < 0 ? "pto-neg" : undefined}>
                              {r.vacation_balance}
                              <span className="muted"> / {r.vacation_entitlement}</span>
                            </span>
                            <span className="muted"> · used {r.vacation_used}</span>
                          </div>
                          <div>
                            <span className="pto-board-card-label">Sick</span>
                            <span className={r.sick_balance < 0 ? "pto-neg" : undefined}>
                              {r.sick_balance}
                              <span className="muted"> / {r.sick_entitlement}</span>
                            </span>
                            <span className="muted"> · used {r.sick_used}</span>
                          </div>
                        </div>
                        <div className="pto-board-card-actions">
                          {canConfirmPayroll ? (
                            <button
                              type="button"
                              className="btn secondary btn-sm"
                              onClick={() => openManualAdjust(r)}
                            >
                              Adjust
                            </button>
                          ) : null}
                          {over ? (
                            <button
                              type="button"
                              className="btn secondary btn-sm"
                              onClick={() => void printOverageForm(r)}
                            >
                              Print owe / sign-off
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>

          {adjustRow && canConfirmPayroll && (
            <div className="card pto-adjust-form-card" style={{ marginTop: "0.75rem" }}>
              <h3 style={{ marginTop: 0 }}>Manual adjust · {adjustRow.name}</h3>
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                Positive hours = use more (deduct from bank). Negative = restore / credit.{" "}
                <strong>Used on</strong> is the day they were actually out — not today unless that
                is the day. Note required for the ledger.
              </p>
              <form className="form" onSubmit={(ev) => void submitManualAdjust(ev)}>
                <div className="form row">
                  <label>
                    Kind
                    <select
                      value={adjustKind}
                      onChange={(e) => setAdjustKind(e.target.value as "vacation" | "sick")}
                    >
                      <option value="vacation">Vacation</option>
                      <option value="sick">Sick</option>
                    </select>
                  </label>
                  <label>
                    Hours (+ use / − restore)
                    <input
                      type="number"
                      step="0.5"
                      value={adjustHours}
                      onChange={(e) => setAdjustHours(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Used on *
                    <input
                      type="date"
                      value={adjustUsedOn}
                      onChange={(e) => setAdjustUsedOn(e.target.value)}
                      required
                    />
                  </label>
                </div>
                <label>
                  Note
                  <input
                    value={adjustNote}
                    onChange={(e) => setAdjustNote(e.target.value)}
                    placeholder="e.g. Came in afternoon — restore 4h"
                    required
                  />
                </label>
                <div className="toolbar">
                  <button className="btn" type="submit" disabled={adjustBusy}>
                    {adjustBusy ? "Saving…" : "Save adjust"}
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => {
                      setAdjustRow(null);
                      setAdjustUsedOn("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}

          {overageForm && (
            <div className="card pto-overage-wrap" id="pto-overage-print">
              <div className="toolbar no-print" style={{ marginBottom: "0.75rem", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    document.body.classList.add("print-pto-overage");
                    window.print();
                  }}
                >
                  Print acknowledgment
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => {
                    document.body.classList.remove("print-pto-overage");
                    setOverageForm(null);
                  }}
                >
                  Close
                </button>
              </div>
              <OverageAckForm
                row={overageForm}
                preparedBy={user?.display_name || "Office"}
                preparedOn={todayIso()}
              />
            </div>
          )}
        </section>
      )}

      {tab === "payroll" && canSeeBoard && (
        <section className="pto-payroll-check">
          <div className="card" style={{ marginBottom: "0.75rem" }}>
            <h2 style={{ marginTop: 0 }}>Payroll check</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Approve already deducts vacation/sick. At payroll, confirm they actually stayed out — or
              restore hours if they came in. Opens on the <strong>previous Sat–Fri</strong> pay week
              (Central) automatically.
            </p>
            <div className="form row">
              <label>
                From
                <input
                  type="date"
                  value={payrollFrom}
                  onChange={(e) => setPayrollFrom(e.target.value)}
                />
              </label>
              <label>
                To
                <input
                  type="date"
                  value={payrollTo}
                  onChange={(e) => setPayrollTo(e.target.value)}
                />
              </label>
            </div>
            <div className="toolbar">
              <button
                type="button"
                className="btn"
                disabled={payrollBusy}
                onClick={() => void loadPayrollCheck()}
              >
                {payrollBusy ? "Loading…" : "Load week"}
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={payrollBusy}
                onClick={() => {
                  const w = previousSatFriPayWeek();
                  setPayrollFrom(w.from);
                  setPayrollTo(w.to);
                  void loadPayrollCheck(w);
                }}
              >
                Prior Sat–Fri
              </button>
            </div>
          </div>

          <div className="card">
            {!payrollItems.length ? (
              <p className="muted" style={{ margin: 0 }}>
                No approved PTO/sick in this range. Approve requests first, then reload.
              </p>
            ) : (
              <table className="pto-board-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Type</th>
                    <th>Dates</th>
                    <th>Hours</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {payrollItems.map((item) => {
                    const needs =
                      !item.usage_status ||
                      item.usage_status === "pending_confirm";
                    return (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.employee_name}</strong>
                          {!item.bank_linked ? (
                            <span className="badge danger" style={{ marginLeft: "0.35rem" }}>
                              No bank link
                            </span>
                          ) : null}
                        </td>
                        <td>{item.type_label}</td>
                        <td>{formatRange(item.start_date, item.end_date)}</td>
                        <td>
                          {item.hours_actual != null && item.hours_actual !== item.hours_deducted
                            ? `${item.hours_actual}h (was ${item.hours_deducted}h)`
                            : `${item.hours_deducted}h`}
                        </td>
                        <td>
                          <span className={`badge ${needs ? "warning" : "ok"}`}>
                            {usageStatusLabel(item.usage_status)}
                          </span>
                          {item.usage_note ? (
                            <div className="muted" style={{ fontSize: "0.75rem" }}>
                              {item.usage_note}
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {canConfirmPayroll ? (
                            partialEditId === item.id ? (
                              <div className="form" style={{ gap: "0.35rem", minWidth: "12rem" }}>
                                <label>
                                  Actual hours kept
                                  <input
                                    type="number"
                                    step="0.5"
                                    min={0}
                                    max={item.hours_deducted}
                                    value={partialHours}
                                    onChange={(e) => setPartialHours(e.target.value)}
                                  />
                                </label>
                                <label>
                                  Note
                                  <input
                                    value={partialNote}
                                    onChange={(e) => setPartialNote(e.target.value)}
                                    placeholder="Worked half day"
                                  />
                                </label>
                                <div className="toolbar" style={{ gap: "0.35rem" }}>
                                  <button
                                    type="button"
                                    className="btn btn-sm"
                                    disabled={payrollBusy}
                                    onClick={() =>
                                      void confirmUsage(
                                        item,
                                        "partial",
                                        Number(partialHours),
                                        partialNote
                                      )
                                    }
                                  >
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="btn secondary btn-sm"
                                    onClick={() => setPartialEditId(null)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <div className="toolbar" style={{ gap: "0.35rem", flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={payrollBusy || !needs}
                                  onClick={() => void confirmUsage(item, "taken")}
                                >
                                  Took it
                                </button>
                                <button
                                  type="button"
                                  className="btn secondary btn-sm"
                                  disabled={payrollBusy}
                                  onClick={() => {
                                    setPartialEditId(item.id);
                                    setPartialHours(String(item.hours_deducted / 2));
                                    setPartialNote("");
                                  }}
                                >
                                  Partial…
                                </button>
                                <button
                                  type="button"
                                  className="btn secondary btn-sm"
                                  disabled={payrollBusy}
                                  onClick={() => {
                                    const n = window.prompt(
                                      `Restore ${item.hours_deducted}h for ${item.employee_name} (they came in)? Add a short note:`,
                                      "Came in — restore hours"
                                    );
                                    if (n == null) return;
                                    if (!n.trim()) {
                                      setError("Note required when restoring hours.");
                                      return;
                                    }
                                    void confirmUsage(item, "not_taken", 0, n.trim());
                                  }}
                                >
                                  Came in — restore
                                </button>
                              </div>
                            )
                          ) : (
                            <span className="muted">View only</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}

      {tab === "upcoming" && canSeeBoard && (
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Upcoming birthdays &amp; anniversaries</h2>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Next ~45 days — recognize people on their special day.
          </p>
          {!upcoming.length ? (
            <p className="muted">No events in the next 45 days (need hire dates / birthdays on file).</p>
          ) : (
            <ul className="pto-upcoming-list">
              {upcoming.map((ev) => (
                <li key={`${ev.event_type}-${ev.employee_id}-${ev.date}`}>
                  <strong>{ev.date}</strong>
                  <span className={`badge ${ev.event_type === "birthday" ? "info" : "ok"}`}>
                    {ev.event_type === "birthday" ? "Birthday" : "Anniversary"}
                  </span>
                  <span>{ev.name}</span>
                  {ev.event_type === "anniversary" && ev.years_of_service != null ? (
                    <span className="muted"> · {ev.years_of_service} yrs</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === "report" && canSeeBoard && (
        <section className="pto-report">
          <div className="card no-print" style={{ marginBottom: "0.75rem" }}>
            <h2 style={{ marginTop: 0 }}>Printable usage report</h2>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              Pick an employee — <strong>From</strong> defaults to their last anniversary (or hire
              date), <strong>To</strong> to today. Print report uses that window. Adjust dates if
              needed.
            </p>
            <div className="form row">
              <label>
                Employee
                <select
                  value={reportEmpId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setReportEmpId(id);
                    setReportData(null);
                    applyReportDefaultsForEmployee(id);
                  }}
                >
                  <option value="">Select…</option>
                  {boardRows.map((r) => (
                    <option key={r.employee_id} value={String(r.employee_id)}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                From <span className="muted">(anniversary year)</span>
                <input type="date" value={reportFrom} onChange={(e) => setReportFrom(e.target.value)} />
              </label>
              <label>
                To <span className="muted">(today)</span>
                <input type="date" value={reportTo} onChange={(e) => setReportTo(e.target.value)} />
              </label>
            </div>
            <div className="toolbar">
              <button
                type="button"
                className="btn"
                disabled={busy || !reportEmpId}
                onClick={() => void printReport()}
              >
                {busy ? "Preparing…" : "Print report"}
              </button>
            </div>
          </div>
          {reportData && (
            <div className="card pto-report-print pto-print-doc">
              <header className="pto-print-letterhead pto-report-letterhead">
                <div className="pto-print-brand">
                  <img
                    className="pto-print-wordmark"
                    src="/logo-form-primary.png"
                    alt="Total Assurance"
                  />
                  <div className="pto-print-subtitle">
                    Time-off usage report
                    {reportFrom || reportTo
                      ? ` · ${reportFrom || "…"} → ${reportTo || todayIso()}`
                      : ""}
                  </div>
                </div>
                <div className="pto-print-meta">
                  <div className="pto-print-meta-label">Printed</div>
                  <div className="pto-print-meta-date">{formatDisplayDate(todayIso())}</div>
                  <div className="pto-print-meta-by">
                    {user?.display_name || "Office"}
                  </div>
                </div>
              </header>
              <h2 className="pto-print-doc-title">
                {reportData.employee.name}
              </h2>
              {reportData.balance && (
                <>
                  <p>
                    Vacation balance:{" "}
                    <strong
                      className={
                        reportData.balance.vacation_balance < 0 ? "pto-owe-amount" : undefined
                      }
                    >
                      {reportData.balance.vacation_balance}h
                    </strong>
                    {" · "}
                    Sick balance:{" "}
                    <strong
                      className={
                        reportData.balance.sick_balance < 0 ? "pto-owe-amount" : undefined
                      }
                    >
                      {reportData.balance.sick_balance}h
                    </strong>
                  </p>
                  {(reportData.balance.vacation_balance < 0 ||
                    reportData.balance.sick_balance < 0) && (
                    <div className="pto-owe-strip" role="status">
                      <div className="pto-owe-strip-main">
                        <span className="pto-owe-strip-label">Hours owed</span>
                        <strong className="pto-owe-amount pto-owe-strip-total">
                          {Math.abs(
                            Math.min(0, reportData.balance.vacation_balance) +
                              Math.min(0, reportData.balance.sick_balance)
                          )}{" "}
                          hours
                        </strong>
                      </div>
                      <span className="pto-owe-strip-detail">
                        {[
                          reportData.balance.vacation_balance < 0
                            ? `Vacation ${Math.abs(reportData.balance.vacation_balance)}h`
                            : null,
                          reportData.balance.sick_balance < 0
                            ? `Sick ${Math.abs(reportData.balance.sick_balance)}h`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  )}
                </>
              )}
              <h3 className="pto-report-section-title">Approved requests</h3>
              {!reportData.approved_requests.length ? (
                <p className="muted">None in range.</p>
              ) : (
                <table className="pto-board-table">
                  <thead>
                    <tr>
                      <th>Type</th>
                      <th>Dates</th>
                      <th>Approved by</th>
                      <th>Remarks</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.approved_requests.map((r) => (
                      <tr key={r.id}>
                        <td>{typeLabel(r.request_type)}</td>
                        <td>{formatRange(r.start_date, r.end_date)}</td>
                        <td>{r.decided_by_name || "—"}</td>
                        <td>{r.manager_remarks || r.reason || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <h3 className="pto-report-section-title">Ledger history</h3>
              {!reportData.ledger.length ? (
                <p className="muted">
                  No ledger rows in this date range. Clear the date filter and try again, or check
                  Adjust entries on the PTO board.
                </p>
              ) : (
                <table className="pto-board-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Kind</th>
                      <th>Hours</th>
                      <th>Source</th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reportData.ledger.map((l, i) => (
                      <tr key={`${l.entry_date}-${i}`}>
                        <td>{l.entry_date}</td>
                        <td>{l.kind}</td>
                        <td>{l.hours}</td>
                        <td>{l.source}</td>
                        <td>{l.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {reportData.balance &&
              (reportData.balance.vacation_balance < 0 ||
                reportData.balance.sick_balance < 0) ? (
                <div className="pto-report-overage-sign">
                  <p className="pto-report-overage-banner no-print">
                    <strong>Overage detected</strong> — print is 2 pages: (1) usage report above,
                    (2) employee + office acknowledgment below. No handwritten dates needed.
                  </p>
                  <OverageSignPage
                    row={reportData.balance}
                    preparedBy={user?.display_name || "Office"}
                    preparedOn={todayIso()}
                  />
                </div>
              ) : null}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
