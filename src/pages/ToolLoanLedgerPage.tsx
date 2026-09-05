import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

type PersonSummary = {
  person_id: number;
  user_id: number | null;
  display_name: string;
  weekly_deduction: number | null;
  status: string;
  notes: string | null;
  total_charged: number;
  total_paid: number;
  balance: number;
  suggested_weekly: number;
  weekly_this_week?: number;
  last_payroll_date?: string | null;
  last_payroll_at?: string | null;
  already_deducted_for_week?: boolean;
  week_deducted_amount?: number | null;
  week_deducted_at?: string | null;
  /** Saved skip for this pay Friday (uncheck) — loan still open */
  skipped_this_week?: boolean;
};

type PayrollSkipPerson = {
  person_id: number;
  display_name: string;
};

type SelectedWeekStatus = {
  payment_date: string;
  already_applied: boolean;
  employee_count: number;
  total_amount: number;
};

type Charge = {
  id: number;
  description: string;
  charge_date: string;
  amount: number;
  source: string;
  voided: number;
};

type Payment = {
  id: number;
  payment_date: string;
  amount: number;
  payment_type: string;
  note: string | null;
  source: string;
  voided: number;
};

type OwnerLine = {
  person_id: number;
  employee_name: string;
  total_loan_amount: number;
  total_amount_paid: number;
  remaining_balance: number;
  weekly_deduction: number;
  status: string;
};

type OwnerReport = {
  company: string;
  title: string;
  week_of: string;
  generated_at: string;
  prepared_by: string;
  lines: OwnerLine[];
  totals: {
    total_loan_amount: number;
    total_amount_paid: number;
    remaining_balance: number;
    weekly_deduction: number;
    employee_count: number;
  };
  policy_note: string;
};

function money(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatWeekLabel(iso: string): string {
  try {
    const d = new Date(iso.includes("T") ? iso : iso + "T12:00:00");
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

/** Local YYYY-MM-DD (avoid UTC off-by-one on date-only values). */
function toYmdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Pay Friday for tool loan deductions.
 * Payroll is run Wed; guys are paid Fri — always post deductions to the upcoming Friday
 * (today if Friday, otherwise next Friday).
 */
function upcomingPayFriday(from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 12, 0, 0, 0);
  const day = d.getDay(); // 0=Sun … 5=Fri
  const add = (5 - day + 7) % 7;
  d.setDate(d.getDate() + add);
  return toYmdLocal(d);
}

function formatShortWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.includes("T") ? iso : iso + "T12:00:00");
    if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

/** Normalize names so "Chris Marroquin" matches across ledger / employee / logins. */
function normName(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compact key: "CharlesBeard" and "Charles Beard" → same (spaces stripped). */
function nameKey(s: string): string {
  return normName(s).replace(/\s+/g, "");
}

type PayrollTableRow = {
  key: string;
  person_id: number | null;
  user_id: number | null;
  display_name: string;
  balance: number;
  suggested: number;
  status: string;
};

type ActiveEmployee = {
  id: number;
  name: string;
  user_id: number | null;
};

export function ToolLoanLedgerPage() {
  const { user } = useAuth();
  const isOffice = user?.role === "admin" || user?.role === "office";

  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [totalOwed, setTotalOwed] = useState(0);
  const [openCount, setOpenCount] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** Active employee not yet on the ledger (first charge). */
  const [selectedOffLedger, setSelectedOffLedger] = useState<{
    key: string;
    display_name: string;
    user_id: number | null;
  } | null>(null);
  const [detail, setDetail] = useState<{
    person: PersonSummary;
    charges: Charge[];
    payments: Payment[];
  } | null>(null);

  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmt, setPayAmt] = useState("");
  const [payType, setPayType] = useState<"payroll" | "spiff" | "other">("payroll");
  const [payNote, setPayNote] = useState("");

  const [weeklyEdit, setWeeklyEdit] = useState("");
  const [report, setReport] = useState<OwnerReport | null>(null);

  /** All active company employees (payroll roster). */
  const [activeEmployees, setActiveEmployees] = useState<ActiveEmployee[]>([]);
  const [addEmployeeKey, setAddEmployeeKey] = useState(""); // "p:123" | "u:456" | "n:Name"
  const [addKind, setAddKind] = useState("tool_purchase");
  const [addReason, setAddReason] = useState("");
  const [addAmt, setAddAmt] = useState("");
  /** When checked, Amount is treated as pre-tax and 8.25% sales tax is added. */
  const [addIncludeTax, setAddIncludeTax] = useState(false);
  const ADD_TAX_RATE = 8.25;
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lastChargePrintId, setLastChargePrintId] = useState<number | null>(null);
  /** Optional: include $0 / not-yet-on-ledger active employees. */
  const [showZeroBalances, setShowZeroBalances] = useState(false);
  /** Correct amount on an existing charge (e.g. forgot tax). */
  const [editChargeId, setEditChargeId] = useState<number | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editPretax, setEditPretax] = useState("");
  const [editTaxRate, setEditTaxRate] = useState("8.25");
  const [editReason, setEditReason] = useState("");

  /** Payroll week: bulk deduct everyone checked, with optional amount overrides. */
  /** Always the pay Friday deductions hit the paycheck (not the Wed office run day). */
  const [payrollWeekDate, setPayrollWeekDate] = useState(() => upcomingPayFriday());
  const [weekDeductAmounts, setWeekDeductAmounts] = useState<Record<number, string>>(
    {}
  );
  /** When false, that person is skipped by the bulk button / removed from this Friday's report. */
  const [weekInclude, setWeekInclude] = useState<Record<number, boolean>>({});
  /** Persisted skips for the selected pay Friday (person_id → name). */
  const [weekSkips, setWeekSkips] = useState<PayrollSkipPerson[]>([]);
  /** Session-only hide for roster $0 rows with no person_id (key → true means hidden). */
  const [sessionHiddenKeys, setSessionHiddenKeys] = useState<Record<string, boolean>>({});
  const [selectedWeekStatus, setSelectedWeekStatus] = useState<SelectedWeekStatus | null>(
    null
  );

  function suggestedWeekAmount(p: PersonSummary): number {
    const raw =
      p.weekly_this_week ??
      p.suggested_weekly ??
      (p.balance > 0
        ? Math.min(p.balance, Math.max(50, Math.round(p.balance * 0.1 * 100) / 100))
        : 0);
    return Math.round(Math.min(Math.max(raw, 0), Math.max(p.balance, 0)) * 100) / 100;
  }

  function seedWeekAmounts(list: PersonSummary[]) {
    setWeekDeductAmounts((prev) => {
      const next: Record<number, string> = { ...prev };
      for (const p of list) {
        if (p.balance <= 0.009 || p.status === "former") {
          delete next[p.person_id];
          continue;
        }
        // Only seed people we have never shown yet (undefined).
        // Keep prior edits / post-save blanks so we don't risk double-post.
        if (prev[p.person_id] !== undefined) continue;
        const amt = suggestedWeekAmount(p);
        next[p.person_id] = amt > 0 ? amt.toFixed(2) : "";
      }
      return next;
    });
    setWeekInclude((prev) => {
      const next: Record<number, boolean> = { ...prev };
      for (const p of list) {
        if (p.balance <= 0.009 || p.status === "former") {
          delete next[p.person_id];
          continue;
        }
        // Saved skip or already deducted → stay unchecked; else new people default included
        if (p.skipped_this_week || p.already_deducted_for_week) {
          next[p.person_id] = false;
        } else if (prev[p.person_id] === undefined) {
          next[p.person_id] = true;
        }
      }
      return next;
    });
  }

  const loadAll = useCallback(async (opts?: { quiet?: boolean }) => {
    const quiet = !!opts?.quiet;
    if (!quiet) {
      setError("");
      setLoading(true);
    }
    try {
      const health = await api<{
        ok: boolean;
        people?: number;
        charges?: number;
        payments?: number;
        error?: string;
      }>("/tool-loan-ledger/health", { timeoutMs: 25_000 });

      if (!health.ok) {
        throw new Error(health.error || "Could not reach ledger database");
      }

      // include_zero=1 so $0 ledger people are available when the roster checkbox is on
      // week_of = pay Friday so we know who already had deductions this paycheck
      const payFriday = payrollWeekDate || upcomingPayFriday();
      const [summary, owner, pickerRes, empsRes] = await Promise.all([
        api<{
          people: PersonSummary[];
          open_count: number;
          total_owed: number;
          selected_week?: SelectedWeekStatus | null;
          payroll_skips?: PayrollSkipPerson[];
          payroll_skip_person_ids?: number[];
          error?: string;
        }>(
          `/tool-loan-ledger/summary?include_zero=1&week_of=${encodeURIComponent(payFriday)}`,
          { timeoutMs: 30_000 }
        ),
        api<OwnerReport>("/tool-loan-ledger/owner-report", { timeoutMs: 30_000 }),
        api<{
          active_employees?: ActiveEmployee[];
          users_not_on_ledger?: { id: number; display_name: string }[];
          people?: PersonSummary[];
        }>("/tool-loan-ledger/employee-picker", { timeoutMs: 25_000 }).catch(() => null),
        api<{ employees?: { id: number; name: string; active?: number }[] }>("/employees", {
          timeoutMs: 25_000,
        }).catch(() => null),
      ]);

      if (summary.error) throw new Error(summary.error);
      const list = summary.people || [];
      setPeople(list);
      setOpenCount(summary.open_count || 0);
      setTotalOwed(summary.total_owed || 0);
      setSelectedWeekStatus(summary.selected_week ?? null);
      setReport(owner);
      const skips =
        summary.payroll_skips ||
        (summary.payroll_skip_person_ids || []).map((id) => {
          const p = list.find((x) => x.person_id === id);
          return { person_id: id, display_name: p?.display_name || `Person #${id}` };
        });
      setWeekSkips(skips);
      seedWeekAmounts(list);
      // Honor saved skips + already deducted — do not reset manual unchecks on reload
      setWeekInclude((prev) => {
        const next = { ...prev };
        const skipIdSet = new Set(skips.map((s) => s.person_id));
        for (const p of list) {
          if (p.already_deducted_for_week || skipIdSet.has(p.person_id) || p.skipped_this_week) {
            next[p.person_id] = false;
          } else if (prev[p.person_id] === undefined && p.balance > 0.009) {
            next[p.person_id] = true;
          }
        }
        return next;
      });

      // Build full active roster from picker (preferred) and/or employees + app users
      const byName = new Map<string, ActiveEmployee>();
      const addRoster = (id: number, name: string, user_id: number | null) => {
        const n = normName(name);
        if (!n) return;
        const prev = byName.get(n);
        if (prev) {
          if (prev.user_id == null && user_id != null) prev.user_id = user_id;
          return;
        }
        byName.set(n, { id, name, user_id });
      };

      for (const e of pickerRes?.active_employees || []) {
        addRoster(e.id, e.name, e.user_id ?? null);
      }
      for (const e of empsRes?.employees || []) {
        if (e.active === 0) continue;
        addRoster(e.id, e.name, null);
      }
      // App users not on the ledger (covers techs who have a login but no employee row)
      let nextUserId = -1;
      for (const u of pickerRes?.users_not_on_ledger || []) {
        addRoster(nextUserId--, u.display_name, u.id);
      }
      // Also every active app user name from ledger people linkage is already covered
      const roster = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
      setActiveEmployees(roster);

      if (!quiet) setOk("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load ledger";
      if (quiet) throw e instanceof Error ? e : new Error(msg);
      setError(msg);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [payrollWeekDate]);

  const loadDetail = useCallback(async (id: number) => {
    setError("");
    try {
      const r = await api<{
        person: PersonSummary;
        charges: Charge[];
        payments: Payment[];
      }>(`/tool-loan-ledger/people/${id}`, { timeoutMs: 30_000 });
      setDetail(r);
      setWeeklyEdit(
        r.person.weekly_deduction != null ? String(r.person.weekly_deduction) : ""
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load person");
    }
  }, []);

  useEffect(() => {
    if (!isOffice) return;
    void loadAll();
  }, [isOffice, loadAll]);

  // Scope aggressive print CSS to this page only (see styles.css tool-loan print rules)
  useEffect(() => {
    document.body.classList.add("on-tool-loan-ledger");
    return () => document.body.classList.remove("on-tool-loan-ledger");
  }, []);

  // Deep-link from tool loan paperwork match: /tool-loan-ledger?person=123
  useEffect(() => {
    if (!isOffice) return;
    const q = new URLSearchParams(window.location.search);
    const pid = Number(q.get("person") || "");
    if (pid > 0) {
      setSelectedId(pid);
      setSelectedOffLedger(null);
      window.setTimeout(() => {
        document.getElementById("employee-ledger-detail")?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      }, 200);
    }
  }, [isOffice]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  function scrollToEmployeePanel() {
    window.setTimeout(() => {
      document.getElementById("employee-ledger-detail")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 50);
  }

  function selectPerson(personId: number) {
    setSelectedOffLedger(null);
    setSelectedId(personId);
    setAddEmployeeKey(`p:${personId}`);
    scrollToEmployeePanel();
  }

  function selectOffLedger(row: {
    display_name: string;
    user_id: number | null;
    key: string;
  }) {
    setSelectedId(null);
    setDetail(null);
    setSelectedOffLedger({
      key: row.key,
      display_name: row.display_name,
      user_id: row.user_id,
    });
    if (row.user_id != null) setAddEmployeeKey(`u:${row.user_id}`);
    else setAddEmployeeKey(`n:${row.display_name}`);
    scrollToEmployeePanel();
  }

  function clearEmployeeSelection() {
    setSelectedId(null);
    setSelectedOffLedger(null);
    setAddEmployeeKey("");
    setDetail(null);
  }

  /**
   * Open acknowledgment and auto-print.
   * Pass an already-opened window (from a sync click) so browsers don't block
   * print after an async charge save.
   */
  function openChargeAgreementPrint(
    chargeId: number,
    preexisting?: Window | null
  ) {
    setError("");
    const url = `/api/tool-loan-ledger/charges/${chargeId}/print-agreement`;
    const w = preexisting && !preexisting.closed ? preexisting : window.open("about:blank", "_blank");
    if (w == null) {
      setError(
        "Pop-up blocked — allow pop-ups for this site, then use Re-print last acknowledgment."
      );
      return;
    }
    try {
      w.opener = null;
    } catch {
      /* ignore */
    }
    try {
      w.document.open();
      w.document.write(
        `<!DOCTYPE html><html><body style="font-family:system-ui;padding:1.5rem">Preparing acknowledgment…</body></html>`
      );
      w.document.close();
    } catch {
      /* cross-origin / restricted — fall back to navigate */
      w.location.href = url;
      return;
    }
    void (async () => {
      try {
        const res = await fetch(url, { credentials: "include" });
        const html = await res.text();
        if (!res.ok) {
          w.document.open();
          w.document.write(html || `<p>Could not load form (${res.status}).</p>`);
          w.document.close();
          return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
        // HTML also auto-prints; call again after paint for reliability
        window.setTimeout(() => {
          try {
            w.focus();
            w.print();
          } catch {
            /* ignore */
          }
        }, 600);
      } catch {
        w.location.href = url;
      }
    })();
  }

  function openEditCharge(c: Charge) {
    setEditChargeId(c.id);
    setEditDesc(c.description || "");
    // If description already has tax breakdown, still start pretax from amount/1.0825 when rate 8.25
    const amt = Number(c.amount) || 0;
    const rate = 8.25;
    const pretaxGuess = Math.round((amt / (1 + rate / 100)) * 100) / 100;
    setEditPretax(String(pretaxGuess > 0 ? pretaxGuess : amt));
    setEditTaxRate(String(rate));
    setEditReason("Forgot to include sales tax");
    setError("");
    setOk("");
  }

  function closeEditCharge() {
    setEditChargeId(null);
    setEditDesc("");
    setEditPretax("");
    setEditTaxRate("8.25");
    setEditReason("");
  }

  const editTaxPreview = useMemo(() => {
    const pretax = Number(editPretax);
    const rate = Number(editTaxRate);
    if (!(pretax > 0) || !(rate >= 0)) return { pretax: 0, rate: 0, tax: 0, total: 0 };
    const tax = Math.round(pretax * (rate / 100) * 100) / 100;
    const total = Math.round((pretax + tax) * 100) / 100;
    return { pretax, rate, tax, total };
  }, [editPretax, editTaxRate]);

  const addTaxPreview = useMemo(() => {
    const pretax = Number(addAmt);
    if (!(pretax > 0)) return { pretax: 0, tax: 0, total: 0 };
    if (!addIncludeTax) return { pretax, tax: 0, total: pretax };
    const tax = Math.round(pretax * (ADD_TAX_RATE / 100) * 100) / 100;
    const total = Math.round((pretax + tax) * 100) / 100;
    return { pretax, tax, total };
  }, [addAmt, addIncludeTax]);

  async function saveEditCharge(e: FormEvent) {
    e.preventDefault();
    if (editChargeId == null) return;
    if (!(editTaxPreview.total > 0)) {
      setError("Enter a valid pre-tax amount (tax is added automatically).");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await api<{
        amount_before: number;
        amount_after: number;
        print_path?: string;
      }>(`/tool-loan-ledger/charges/${editChargeId}/amend`, {
        method: "POST",
        body: JSON.stringify({
          amount: editTaxPreview.total,
          pretax_amount: editTaxPreview.pretax,
          tax_rate: editTaxPreview.rate,
          description: editDesc.trim() || undefined,
          reason: editReason.trim() || "Corrected amount",
        }),
      });
      setOk(
        `Loan updated: ${money(res.amount_before)} → ${money(res.amount_after)} (tax included).`
      );
      const printId = editChargeId;
      closeEditCharge();
      if (selectedId) await loadDetail(selectedId);
      await loadAll({ quiet: true });
      if (window.confirm("Amount updated. Open the acknowledgment form to re-print for signature?")) {
        openChargeAgreementPrint(printId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update charge");
    } finally {
      setBusy(false);
    }
  }

  async function voidCharge(chargeId: number, description: string) {
    const reason = window.prompt(
      `Void this loan/charge?\n\n${description}\n\nTip: use Edit instead if you only need to fix the amount (e.g. add tax).\n\nOptional void reason:`,
      ""
    );
    if (reason === null) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api(`/tool-loan-ledger/charges/${chargeId}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      setOk("Charge voided — balance updated.");
      if (editChargeId === chargeId) closeEditCharge();
      if (selectedId) await loadDetail(selectedId);
      await loadAll({ quiet: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void charge");
    } finally {
      setBusy(false);
    }
  }

  async function voidPayment(paymentId: number, label: string) {
    const reason = window.prompt(
      `Void this payment?\n\n${label}\n\nOptional reason (shown in audit):`,
      ""
    );
    if (reason === null) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api(`/tool-loan-ledger/payments/${paymentId}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      });
      setOk("Payment voided — balance updated.");
      if (selectedId) await loadDetail(selectedId);
      await loadAll({ quiet: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void payment");
    } finally {
      setBusy(false);
    }
  }

  /** Direct office charge — no employee request / approval. */
  async function addOfficeCharge(e: FormEvent) {
    e.preventDefault();
    if (!addEmployeeKey) {
      setError("Select an employee.");
      return;
    }
    if (!addReason.trim()) {
      setError("Enter the reason for this charge (required for the acknowledgment form).");
      return;
    }
    const pretax = Number(addAmt);
    if (!Number.isFinite(pretax) || pretax <= 0) {
      setError("Enter a positive amount.");
      return;
    }
    const amount = addIncludeTax ? addTaxPreview.total : pretax;
    if (!(amount > 0)) {
      setError("Enter a positive amount.");
      return;
    }

    // Open print window NOW (same click) — after await, browsers often block pop-ups / auto-print
    const printWin = window.open("about:blank", "_blank");
    if (printWin == null) {
      setError(
        "Allow pop-ups for this site so the acknowledgment can print automatically after save."
      );
    } else {
      try {
        printWin.document.write(
          `<!DOCTYPE html><html><body style="font-family:system-ui;padding:1.5rem">Saving charge… acknowledgment will print next.</body></html>`
        );
        printWin.document.close();
      } catch {
        /* ignore */
      }
    }

    setBusy(true);
    setError("");
    setOk("");
    try {
      let reason = addReason.trim();
      if (addIncludeTax && addTaxPreview.tax > 0) {
        const breakdown = `Pretax ${money(addTaxPreview.pretax)} + ${ADD_TAX_RATE}% tax ${money(addTaxPreview.tax)} = ${money(addTaxPreview.total)}`;
        if (!/pretax|tax\s*%|\+\s*\d+(\.\d+)?%\s*tax/i.test(reason)) {
          reason = `${reason} · ${breakdown}`;
        }
      }
      const payload: Record<string, unknown> = {
        amount,
        charge_date: addDate,
        reason,
        charge_kind: addKind,
      };
      if (addIncludeTax) {
        payload.pretax_amount = addTaxPreview.pretax;
        payload.tax_rate = ADD_TAX_RATE;
      }
      if (addEmployeeKey.startsWith("p:")) {
        payload.person_id = Number(addEmployeeKey.slice(2));
      } else if (addEmployeeKey.startsWith("u:")) {
        payload.user_id = Number(addEmployeeKey.slice(2));
      } else if (addEmployeeKey.startsWith("n:")) {
        payload.display_name = addEmployeeKey.slice(2);
      } else {
        throw new Error("Select an employee from the list.");
      }

      // Charge save must not share the short mobile default timeout (12s) — D1 + audit can be slower.
      const res = await api<{
        id: number;
        person_id: number;
        display_name: string;
        balance_after: number;
        print_path?: string;
      }>("/tool-loan-ledger/charges", {
        method: "POST",
        body: JSON.stringify(payload),
        timeoutMs: 45_000,
      });

      setLastChargePrintId(res.id);
      setAddReason("");
      setAddAmt("");
      setAddIncludeTax(false);
      setSelectedOffLedger(null);
      setSelectedId(res.person_id);
      setAddEmployeeKey(`p:${res.person_id}`);
      setOk(
        `Charge of ${money(amount)} added for ${res.display_name}. New balance ${money(res.balance_after)}. Printing acknowledgment…`
      );
      // Print into the window opened on click (auto print dialog)
      openChargeAgreementPrint(res.id, printWin);
      // Refresh list quietly; never turn a saved charge into a red timeout banner
      try {
        await loadAll({ quiet: true });
        await loadDetail(res.person_id);
      } catch {
        setOk(
          `Charge of ${money(amount)} added for ${res.display_name}. New balance ${money(res.balance_after)}. List may need Refresh — charge is saved.`
        );
      }
    } catch (err) {
      try {
        printWin?.close();
      } catch {
        /* ignore */
      }
      setError(err instanceof Error ? err.message : "Charge failed");
    } finally {
      setBusy(false);
    }
  }

  async function addPayment(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/tool-loan-ledger/payments", {
        method: "POST",
        body: JSON.stringify({
          person_id: selectedId,
          payment_date: payDate,
          amount: Number(payAmt),
          payment_type: payType,
          note: payNote.trim() || undefined,
        }),
        timeoutMs: 45_000,
      });
      setPayAmt("");
      setPayNote("");
      setOk(payType === "spiff" ? "Spiff payment recorded." : "Payroll payment recorded.");
      try {
        await loadDetail(selectedId);
        await loadAll({ quiet: true });
      } catch {
        /* payment already saved */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Payment failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveWeekly() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      const v = weeklyEdit.trim() === "" ? null : Number(weeklyEdit);
      await api(`/tool-loan-ledger/people/${selectedId}`, {
        method: "PATCH",
        body: JSON.stringify({
          weekly_deduction: v != null && Number.isFinite(v) ? v : null,
        }),
      });
      setOk("Default weekly amount saved (used on the owner report).");
      await loadDetail(selectedId);
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const payrollCandidates = useMemo(
    () => people.filter((p) => p.status !== "former" && p.balance > 0.009),
    [people]
  );

  const skipIdSet = useMemo(
    () => new Set(weekSkips.map((s) => s.person_id)),
    [weekSkips]
  );

  const weekPayrollPreview = useMemo(() => {
    let count = 0;
    let total = 0;
    let skipped = 0;
    let already = 0;
    for (const p of payrollCandidates) {
      if (p.already_deducted_for_week) {
        already += 1;
        continue;
      }
      if (weekInclude[p.person_id] === false || skipIdSet.has(p.person_id)) {
        skipped += 1;
        continue;
      }
      const n = Number(weekDeductAmounts[p.person_id]);
      if (!Number.isFinite(n) || n <= 0) continue;
      count += 1;
      total += Math.min(n, p.balance);
    }
    return { count, total: Math.round(total * 100) / 100, skipped, already };
  }, [payrollCandidates, weekDeductAmounts, weekInclude, skipIdSet]);

  const allChecked =
    payrollCandidates.filter((p) => !p.already_deducted_for_week).length > 0 &&
    payrollCandidates
      .filter((p) => !p.already_deducted_for_week)
      .every((p) => weekInclude[p.person_id] !== false && !skipIdSet.has(p.person_id));

  function setPersonWeekAmount(personId: number, value: string) {
    setWeekDeductAmounts((prev) => ({ ...prev, [personId]: value }));
  }

  /**
   * Check = on this Friday's deduction report.
   * Uncheck with person_id = persist skip for this pay Friday only (loan stays open).
   * Roster-only rows (no person_id) use hideRosterRow instead.
   */
  async function setPersonIncluded(personId: number | null | undefined, included: boolean) {
    if (personId == null || !Number.isFinite(personId) || personId <= 0) return;
    const payFriday = payrollWeekDate || upcomingPayFriday();
    const person = people.find((p) => p.person_id === personId);
    const name = person?.display_name || `Person #${personId}`;

    // Optimistic UI
    setWeekInclude((prev) => ({ ...prev, [personId]: included }));
    if (!included) {
      setWeekSkips((prev) =>
        prev.some((s) => s.person_id === personId)
          ? prev
          : [...prev, { person_id: personId, display_name: name }].sort((a, b) =>
              a.display_name.localeCompare(b.display_name)
            )
      );
    } else {
      setWeekSkips((prev) => prev.filter((s) => s.person_id !== personId));
    }

    try {
      if (!included) {
        await api("/tool-loan-ledger/payroll-skips", {
          method: "POST",
          body: JSON.stringify({ person_id: personId, pay_friday: payFriday }),
        });
      } else {
        await api(
          `/tool-loan-ledger/payroll-skips?person_id=${personId}&pay_friday=${encodeURIComponent(payFriday)}`,
          { method: "DELETE" }
        );
      }
    } catch (e) {
      // Roll back optimistic state
      setWeekInclude((prev) => ({ ...prev, [personId]: !included }));
      if (!included) {
        setWeekSkips((prev) => prev.filter((s) => s.person_id !== personId));
      } else if (person) {
        setWeekSkips((prev) =>
          prev.some((s) => s.person_id === personId)
            ? prev
            : [...prev, { person_id: personId, display_name: name }]
        );
      }
      setError(e instanceof Error ? e.message : "Could not save skip for this Friday");
    }
  }

  function hideRosterRow(rowKey: string, hide: boolean) {
    setSessionHiddenKeys((prev) => {
      const next = { ...prev };
      if (hide) next[rowKey] = true;
      else delete next[rowKey];
      return next;
    });
  }

  function setAllIncluded(included: boolean) {
    const next: Record<number, boolean> = {};
    for (const p of payrollCandidates) {
      if (p.already_deducted_for_week) {
        next[p.person_id] = false;
        continue;
      }
      next[p.person_id] = included;
    }
    setWeekInclude(next);
    // Persist all skips / unskips for this Friday (best-effort batch)
    const payFriday = payrollWeekDate || upcomingPayFriday();
    void (async () => {
      try {
        if (!included) {
          const skips: PayrollSkipPerson[] = [];
          for (const p of payrollCandidates) {
            if (p.already_deducted_for_week) continue;
            await api("/tool-loan-ledger/payroll-skips", {
              method: "POST",
              body: JSON.stringify({ person_id: p.person_id, pay_friday: payFriday }),
            });
            skips.push({ person_id: p.person_id, display_name: p.display_name });
          }
          setWeekSkips(
            skips.sort((a, b) => a.display_name.localeCompare(b.display_name))
          );
        } else {
          for (const p of payrollCandidates) {
            if (p.already_deducted_for_week) continue;
            await api(
              `/tool-loan-ledger/payroll-skips?person_id=${p.person_id}&pay_friday=${encodeURIComponent(payFriday)}`,
              { method: "DELETE" }
            );
          }
          setWeekSkips([]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not update all skips");
        void loadAll({ quiet: true });
      }
    })();
  }

  function clearWeekAmounts() {
    const next: Record<number, string> = {};
    for (const p of payrollCandidates) next[p.person_id] = "";
    setWeekDeductAmounts(next);
  }

  /**
   * One-click bulk: records payroll payments for every checked person
   * using their amount (suggested by default, editable per row).
   * payment_date = pay Friday (paycheck day), not the Wed office run day.
   */
  async function recordWeeklyPayroll() {
    // Always snap to pay Friday so a Wed/Thu run still hits the Friday paycheck
    const payFriday = upcomingPayFriday(
      payrollWeekDate
        ? new Date(payrollWeekDate + "T12:00:00")
        : new Date()
    );
    if (payrollWeekDate !== payFriday) {
      setPayrollWeekDate(payFriday);
    }

    const alreadyIds = new Set(
      people.filter((p) => p.already_deducted_for_week).map((p) => p.person_id)
    );

    const lines: { person_id: number; name: string; amount: number }[] = [];
    const alreadySkipped: string[] = [];
    for (const p of payrollCandidates) {
      if (weekInclude[p.person_id] === false) continue;
      if (alreadyIds.has(p.person_id) || p.already_deducted_for_week) {
        alreadySkipped.push(p.display_name);
        continue;
      }
      const n = Number(weekDeductAmounts[p.person_id]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const amount = Math.round(Math.min(n, p.balance) * 100) / 100;
      if (amount <= 0) continue;
      lines.push({ person_id: p.person_id, name: p.display_name, amount });
    }
    if (!lines.length) {
      if (alreadySkipped.length) {
        setError(
          `Everyone checked already has a deduction for pay Friday ${formatShortWhen(payFriday)}. Nothing new to apply.`
        );
      } else {
        setError(
          "No one is ready to deduct. Check at least one person and enter an amount greater than $0 (or use Reset to policy amounts)."
        );
      }
      return;
    }
    if (!payFriday) {
      setError("Choose the pay Friday date.");
      return;
    }

    if (selectedWeekStatus?.already_applied && selectedWeekStatus.payment_date === payFriday) {
      const cont = window.confirm(
        `Deductions for pay Friday ${formatWeekLabel(payFriday)} were already applied (${selectedWeekStatus.employee_count} employees · ${money(selectedWeekStatus.total_amount)}).\n\nOnly people not yet deducted will be included (${lines.length}).\n\nContinue?`
      );
      if (!cont) return;
    }

    const total = lines.reduce((s, l) => s + l.amount, 0);
    const skipped = payrollCandidates.filter((p) => weekInclude[p.person_id] === false).length;
    const skipNote =
      skipped > 0 ? `\n${skipped} person${skipped === 1 ? "" : "s"} unchecked (skipped).` : "";
    const alreadyNote =
      alreadySkipped.length > 0
        ? `\n${alreadySkipped.length} already deducted this Friday (skipped): ${alreadySkipped.slice(0, 5).join(", ")}${alreadySkipped.length > 5 ? "…" : ""}`
        : "";
    const okConfirm = window.confirm(
      `Apply weekly deductions for ${lines.length} employee${lines.length === 1 ? "" : "s"} totaling $${total.toFixed(2)}?\n\nPay Friday (paycheck): ${formatWeekLabel(payFriday)}${skipNote}${alreadyNote}\n\nThis posts one payroll payment per person dated that Friday so it shows on the correct paycheck.`
    );
    if (!okConfirm) return;

    setBusy(true);
    setError("");
    setOk("");
    try {
      let recorded = 0;
      const failed: string[] = [];
      for (const line of lines) {
        try {
          await api("/tool-loan-ledger/payments", {
            method: "POST",
            body: JSON.stringify({
              person_id: line.person_id,
              payment_date: payFriday,
              amount: line.amount,
              payment_type: "payroll",
              note: `Payroll deduction for Friday ${payFriday}`,
              prevent_duplicate_week: true,
            }),
          });
          recorded += 1;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "failed";
          failed.push(`${line.name}: ${msg}`);
        }
      }
      // Uncheck + clear amounts so a second click cannot double-post
      clearWeekAmounts();
      setAllIncluded(false);
      if (selectedId) await loadDetail(selectedId);
      await loadAll();
      if (failed.length && recorded === 0) {
        setError(failed.slice(0, 3).join(" · "));
      } else {
        setOk(
          `Deducted ${recorded} employee${recorded === 1 ? "" : "s"} for pay Friday ${formatShortWhen(payFriday)}.${
            failed.length ? ` ${failed.length} skipped (already posted).` : ""
          } Balances updated.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record payroll deductions");
    } finally {
      setBusy(false);
    }
  }

  /** Payroll report: current employees only (exclude former — e.g. Willie, Valdez). */
  const ownerLines: OwnerLine[] = useMemo(() => {
    if (report?.lines?.length) return report.lines;
    const src = people.filter((p) => p.status !== "former" && p.balance > 0.009);
    return src.map((p) => ({
      person_id: p.person_id,
      employee_name: p.display_name,
      total_loan_amount: p.total_charged,
      total_amount_paid: p.total_paid,
      remaining_balance: p.balance,
      weekly_deduction:
        p.weekly_this_week ??
        p.suggested_weekly ??
        (p.balance > 0
          ? Math.min(p.balance, Math.max(50, Math.round(p.balance * 0.1 * 100) / 100))
          : 0),
      status: p.status,
    }));
  }, [report, people]);

  const ownerTotals = useMemo(() => {
    if (report?.lines?.length && report.totals) return report.totals;
    const total_loan_amount = ownerLines.reduce((s, l) => s + l.total_loan_amount, 0);
    const total_amount_paid = ownerLines.reduce((s, l) => s + l.total_amount_paid, 0);
    const remaining_balance = ownerLines.reduce((s, l) => s + l.remaining_balance, 0);
    const weekly_deduction = ownerLines.reduce((s, l) => s + l.weekly_deduction, 0);
    return {
      total_loan_amount: Math.round(total_loan_amount * 100) / 100,
      total_amount_paid: Math.round(total_amount_paid * 100) / 100,
      remaining_balance: Math.round(remaining_balance * 100) / 100,
      weekly_deduction: Math.round(weekly_deduction * 100) / 100,
      employee_count: ownerLines.length,
    };
  }, [report, ownerLines]);

  /**
   * Server builds the full HTML table from the database (same session cookie).
   * This never depends on React state — so print can't come out header-only.
   *
   * Note: do not pass "noopener" to window.open — modern browsers then return null
   * even when the tab opened, which falsely triggers a "pop-up blocked" message.
   */
  function printWeeklyReport() {
    setError("");
    const payFriday = payrollWeekDate || upcomingPayFriday();
    const q = new URLSearchParams();
    q.set("week_of", payFriday);
    if (showZeroBalances) q.set("include_zero", "1");
    const url = `/api/tool-loan-ledger/owner-report-print?${q.toString()}`;
    const w = window.open(url, "_blank");
    if (w == null) {
      setError("Pop-up blocked — allow pop-ups for this site, then try Print again.");
      return;
    }
    try {
      w.opener = null;
    } catch {
      /* ignore */
    }
  }

  function printEmployeeSheet() {
    if (!detail) return;
    setError("");
    const esc = (s: string) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const p = detail.person;
    const chargeRows =
      detail.charges.length === 0
        ? `<tr><td colspan="3" style="text-align:center;color:#64748b">No loans or charges.</td></tr>`
        : detail.charges
            .map((c) => {
              const voided = c.voided ? " (voided)" : "";
              return `<tr class="${c.voided ? "muted" : ""}">
          <td>${esc((c.charge_date || "").slice(0, 10))}</td>
          <td>${esc(c.description || "")}${voided}</td>
          <td class="num">${esc(money(Number(c.amount)))}</td>
        </tr>`;
            })
            .join("");
    const paymentRows =
      detail.payments.length === 0
        ? `<tr><td colspan="4" style="text-align:center;color:#64748b">No payments.</td></tr>`
        : detail.payments
            .map((pay) => {
              const voided = pay.voided ? " (voided)" : "";
              return `<tr class="${pay.voided ? "muted" : ""}">
          <td>${esc((pay.payment_date || "").slice(0, 10))}</td>
          <td>${esc(pay.payment_type || "")}${voided}</td>
          <td>${esc(pay.note || "—")}</td>
          <td class="num">${esc(money(Number(pay.amount)))}</td>
        </tr>`;
            })
            .join("");
    const printedAt = new Date().toLocaleString();
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tool loan ledger — ${esc(p.display_name)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      color: #0f172a;
      margin: 0.55in 0.6in;
      font-size: 13px;
      line-height: 1.4;
      background: #fff;
    }
    .noprint { margin: 0 0 12px; }
    .noprint button {
      font: inherit; padding: 10px 16px; border-radius: 999px; border: none;
      background: #0c1f4a; color: #fff; cursor: pointer; font-weight: 700;
    }
    h1 { margin: 0 0 0.25rem; font-size: 1.25rem; color: #0c1f4a; }
    .sub { color: #475569; font-size: 12px; margin: 0 0 0.85rem; }
    .meta {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;
      margin-bottom: 1rem;
    }
    .box {
      border: 1px solid #cbd5e1; border-radius: 8px; padding: 0.65rem 0.75rem; background: #f8fafc;
    }
    .box .label {
      font-size: 9px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #64748b;
    }
    .box .value { font-size: 1.1rem; font-weight: 800; margin-top: 2px; color: #0f172a; }
    h2 {
      margin: 1rem 0 0.4rem; font-size: 0.95rem; color: #0c1f4a;
      border-bottom: 2px solid #0c1f4a; padding-bottom: 0.25rem;
    }
    table { width: 100%; border-collapse: collapse; margin-bottom: 0.25rem; }
    th, td {
      border: 1px solid #94a3b8; padding: 0.4rem 0.5rem; text-align: left; vertical-align: top;
    }
    th {
      background: #e8eef6; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: #0c1f4a;
    }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    tr.muted td { color: #94a3b8; }
    .foot { margin-top: 1rem; font-size: 10px; color: #64748b; border-top: 1px solid #cbd5e1; padding-top: 0.5rem; }
    @media print {
      .noprint { display: none !important; }
      body { margin: 0.4in 0.5in; }
      th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }
    @page { margin: 0.45in; size: letter; }
  </style>
</head>
<body>
  <div class="noprint"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>
  <h1>Tool loan ledger — ${esc(p.display_name)}</h1>
  <p class="sub">Printed ${esc(printedAt)} · Total Assurance A/C &amp; Heating</p>
  <div class="meta">
    <div class="box"><div class="label">Balance</div><div class="value">${esc(money(p.balance))}</div></div>
    <div class="box"><div class="label">Total charged</div><div class="value">${esc(money(p.total_charged))}</div></div>
    <div class="box"><div class="label">Total paid</div><div class="value">${esc(money(p.total_paid))}</div></div>
  </div>
  <h2>Loans / charges</h2>
  <table>
    <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
    <tbody>${chargeRows}</tbody>
  </table>
  <h2>Payments</h2>
  <table>
    <thead><tr><th>Date</th><th>Type</th><th>Note</th><th class="num">Amount</th></tr></thead>
    <tbody>${paymentRows}</tbody>
  </table>
  <p class="foot">Confidential · employee tool loan file · ${esc(p.display_name)}</p>
  <script>
    window.addEventListener("load", function () {
      setTimeout(function () { window.focus(); window.print(); }, 350);
    });
  </script>
</body>
</html>`;
    const w = window.open("", "_blank");
    if (w == null) {
      setError("Pop-up blocked — allow pop-ups for this site, then try Print this employee again.");
      return;
    }
    try {
      w.opener = null;
    } catch {
      /* ignore */
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  /**
   * Deduction report: open balances only by default.
   * With roster checkbox: everyone who can receive a charge — $0 ledger + full active
   * employee/user roster — one row per person (deduped by name / user_id / first-name).
   */
  const payrollTableRows = useMemo((): PayrollTableRow[] => {
    const peopleById = new Map(people.map((p) => [p.person_id, p]));
    const rows: PayrollTableRow[] = ownerLines
      .filter((l) => l.remaining_balance > 0.009 && l.status !== "former")
      .filter((l) => {
        const p = peopleById.get(l.person_id);
        // Already deducted this Friday stays on the sheet with badge
        if (p?.already_deducted_for_week) return true;
        // Manual skip → off this Friday's deduction report (print + table)
        if (skipIdSet.has(l.person_id) || weekInclude[l.person_id] === false) return false;
        return true;
      })
      .map((l) => {
        const p = peopleById.get(l.person_id);
        return {
          key: `p:${l.person_id}`,
          person_id: l.person_id,
          user_id: p?.user_id ?? null,
          // Prefer full name from summary/people if owner report has a short import name
          display_name: p?.display_name || l.employee_name,
          balance: l.remaining_balance,
          suggested: l.weekly_deduction,
          status: l.status,
        };
      });

    if (!showZeroBalances) {
      return rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
    }

    const seenNames = new Set(rows.map((r) => normName(r.display_name)));
    const seenKeys = new Set(rows.map((r) => nameKey(r.display_name)).filter(Boolean));
    const seenUserIds = new Set(
      rows.map((r) => r.user_id).filter((id): id is number => id != null)
    );

    function alreadyListed(name: string, userId: number | null): boolean {
      const n = normName(name);
      const k = nameKey(name);
      if (!n) return true;
      // Exact / space-insensitive match ("CharlesBeard" ≈ "Charles Beard")
      if (seenNames.has(n) || (k && seenKeys.has(k))) return true;
      // Same app login already listed
      if (userId != null && seenUserIds.has(userId)) return true;
      /**
       * Only collapse short alias ↔ full name, e.g. "Bianca" vs "Bianca Ramirez".
       * Do NOT collapse "Chris Miller" with "Chris Marroquin" (same first name, different people).
       */
      const parts = n.split(" ").filter(Boolean);
      for (const existing of seenNames) {
        const eParts = existing.split(" ").filter(Boolean);
        if (eParts.length === 1 && parts.length > 1 && parts[0] === eParts[0]) return true;
        if (parts.length === 1 && eParts.length > 1 && eParts[0] === parts[0]) return true;
      }
      return false;
    }

    function markSeen(name: string, userId: number | null) {
      const n = normName(name);
      const k = nameKey(name);
      if (n) {
        seenNames.add(n);
        if (k) seenKeys.add(k);
      }
      if (userId != null) seenUserIds.add(userId);
    }

    // Paid-off / $0 people already on the ledger (summary loads with include_zero=1)
    for (const p of people) {
      if (p.status === "former") continue;
      if (p.balance > 0.009) continue;
      if (alreadyListed(p.display_name, p.user_id)) continue;
      markSeen(p.display_name, p.user_id);
      const key = `p:${p.person_id}`;
      if (sessionHiddenKeys[key]) continue;
      rows.push({
        key,
        person_id: p.person_id,
        user_id: p.user_id,
        display_name: p.display_name,
        balance: Math.max(0, p.balance),
        suggested: 0,
        status: p.status,
      });
    }

    // Full active payroll roster (employees + users not already listed)
    for (const e of activeEmployees) {
      if (alreadyListed(e.name, e.user_id)) continue;
      markSeen(e.name, e.user_id);
      const key = e.user_id != null ? `u:${e.user_id}` : `e:${e.id}`;
      if (sessionHiddenKeys[key]) continue;
      rows.push({
        key,
        person_id: null,
        user_id: e.user_id,
        display_name: e.name,
        balance: 0,
        suggested: 0,
        status: "active",
      });
    }

    return rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
  }, [
    ownerLines,
    people,
    showZeroBalances,
    activeEmployees,
    skipIdSet,
    weekInclude,
    sessionHiddenKeys,
  ]);

  /** Amount owed on the visible deduction sheet (excludes skipped this Friday). */
  const visibleOwedTotal = useMemo(() => {
    const sum = payrollTableRows
      .filter((r) => r.balance > 0.009)
      .reduce((s, r) => s + r.balance, 0);
    return Math.round(sum * 100) / 100;
  }, [payrollTableRows]);

  if (!isOffice) {
    return (
      <div className="page">
        <h1>Tool loan balances</h1>
        <p className="muted">Office and admin only.</p>
        <p>
          <Link to="/tool-loans">Back to tool loan requests</Link>
        </p>
      </div>
    );
  }

  return (
    <div className="page tool-loan-ledger">
      <header className="page-header no-print" style={{ marginBottom: "0.75rem" }}>
        <div>
          <h1 style={{ marginBottom: "0.15rem" }}>Tool loan payroll</h1>
          <p className="muted page-header-sub" style={{ margin: 0 }}>
            Payroll deduction report — open balances only · check names · edit weekly amounts ·{" "}
            <Link to="/tool-loans">Tool loan requests</Link>
          </p>
        </div>
      </header>

      {error && (
        <div className="banner error no-print" role="alert">
          {error}
        </div>
      )}
      {ok && (
        <div className="banner success no-print" role="status">
          {ok}
        </div>
      )}
      {loading && <p className="muted no-print">Loading ledger…</p>}

      <section className="card owner-report-card payroll-unified" id="owner-payroll-report">
        <div className="owner-report-letterhead">
          <div className="owner-report-brand">
            <img
              className="owner-report-logo"
              src="/logo-mark-transparent.png"
              alt=""
              aria-hidden
            />
            <div className="owner-report-subtitle">Tool Loan Payroll Deduction Report</div>
          </div>
          <div className="owner-report-meta">
            <div>
              <span className="owner-meta-label">Pay Friday</span>
              <strong className="no-print">
                <input
                  type="date"
                  value={payrollWeekDate}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (!raw) return;
                    // Always snap to the Friday of that week (paycheck day)
                    setPayrollWeekDate(
                      upcomingPayFriday(new Date(raw + "T12:00:00"))
                    );
                    // Roster $0 hides are session-only for the Friday being viewed
                    setSessionHiddenKeys({});
                  }}
                  className="payroll-week-input"
                  aria-label="Pay Friday — paycheck date for deductions"
                />
              </strong>
              <strong className="print-only">{formatWeekLabel(payrollWeekDate)}</strong>
              <div className="owner-meta-hint no-print muted">
                Always the Friday paycheck — apply once mid-week
              </div>
            </div>
            <div>
              <span className="owner-meta-label">Prepared</span>
              <strong>
                {report
                  ? new Date(report.generated_at).toLocaleString(undefined, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : "—"}
              </strong>
            </div>
            <div>
              <span className="owner-meta-label">By</span>
              <strong>{report?.prepared_by || user?.display_name || "—"}</strong>
            </div>
          </div>
        </div>

        <div className="owner-report-kpis no-print">
          <div className="owner-kpi">
            <span className="owner-kpi-label">
              {showZeroBalances ? "Names on list" : "Employees owing"}
            </span>
            <strong>{payrollTableRows.length || openCount}</strong>
          </div>
          <div className="owner-kpi">
            <span className="owner-kpi-label">Total amount owed</span>
            <strong>{money(visibleOwedTotal || ownerTotals.remaining_balance || totalOwed)}</strong>
          </div>
          <div className="owner-kpi owner-kpi-accent">
            <span className="owner-kpi-label">Total this week&apos;s deduction</span>
            <strong>{money(weekPayrollPreview.total)}</strong>
          </div>
        </div>

        <div className="owner-report-actions no-print payroll-unified-actions">
          <label
            className="balances-toggle show-zero-toggle"
            title="Show every active employee so you can add a charge even if they owe $0"
          >
            <input
              type="checkbox"
              checked={showZeroBalances}
              onChange={(e) => setShowZeroBalances(e.target.checked)}
            />
            <span>
              Include all active employees
              {showZeroBalances && activeEmployees.length > 0
                ? ` (${payrollTableRows.length} names)`
                : ""}
            </span>
          </label>
          <div className="owner-report-btns">
            <button type="button" className="btn secondary" disabled={loading} onClick={() => void loadAll()}>
              Refresh
            </button>
            <button type="button" className="btn secondary" onClick={printWeeklyReport}>
              Print report
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={
                busy ||
                loading ||
                weekPayrollPreview.count === 0 ||
                // Full week already done — block double-click until next week
                (Boolean(selectedWeekStatus?.already_applied) &&
                  weekPayrollPreview.count === 0)
              }
              onClick={() => void recordWeeklyPayroll()}
              title={
                selectedWeekStatus?.already_applied && weekPayrollPreview.count === 0
                  ? "Already applied for this pay Friday — wait until next week"
                  : selectedWeekStatus?.already_applied
                    ? "Some people still open — only undeducted will be included"
                    : "Post deductions dated on this Friday paycheck (once per week)"
              }
            >
              {busy
                ? "Applying…"
                : selectedWeekStatus?.already_applied && weekPayrollPreview.count === 0
                  ? "Already applied this week"
                  : selectedWeekStatus?.already_applied
                    ? `Apply remaining (${weekPayrollPreview.count}) · ${money(weekPayrollPreview.total)}`
                    : `Apply for Friday (${weekPayrollPreview.count}) · ${money(weekPayrollPreview.total)}`}
            </button>
          </div>
        </div>

        <div className="table-wrap owner-report-table-wrap weekly-payroll-table-wrap">
          <table className="data-table owner-report-table weekly-payroll-table payroll-unified-table">
            <thead>
              <tr>
                <th className="weekly-include-col no-print">
                  <label className="weekly-include-all" title="Include all">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      disabled={!payrollCandidates.length || busy}
                      onChange={(e) => setAllIncluded(e.target.checked)}
                      aria-label="Include all employees in bulk deduct"
                    />
                    <span className="sr-only">Include all</span>
                  </label>
                </th>
                <th>Employee Name</th>
                <th className="num">Amount Owed</th>
                <th className="num">Weekly Deduction</th>
              </tr>
            </thead>
            <tbody>
              {payrollTableRows.map((row) => {
                const person =
                  row.person_id != null
                    ? people.find((p) => p.person_id === row.person_id)
                    : undefined;
                const isZero = row.balance <= 0.009;
                const isRosterOnly = row.person_id == null;
                const suggested = !isZero && !isRosterOnly
                  ? person
                    ? suggestedWeekAmount(person)
                    : row.suggested
                  : 0;
                const included =
                  !isZero &&
                  !isRosterOnly &&
                  row.person_id != null &&
                  weekInclude[row.person_id] !== false &&
                  !skipIdSet.has(row.person_id);
                const isSelected =
                  row.person_id != null
                    ? selectedId === row.person_id
                    : selectedOffLedger?.key === row.key;
                return (
                  <tr
                    key={row.key}
                    className={
                      isSelected
                        ? "is-selected"
                        : isZero || isRosterOnly
                          ? "weekly-row-zero"
                          : !included
                            ? "weekly-row-skipped"
                            : undefined
                    }
                  >
                    <td className="weekly-include-col no-print">
                      {isRosterOnly || (isZero && row.person_id == null) ? (
                        <input
                          type="checkbox"
                          checked={!sessionHiddenKeys[row.key]}
                          disabled={busy}
                          onChange={(e) => hideRosterRow(row.key, !e.target.checked)}
                          aria-label={`Show ${row.display_name} on this list`}
                          title="Uncheck hides this $0 name for this session only"
                        />
                      ) : isZero ? (
                        <input
                          type="checkbox"
                          checked={!sessionHiddenKeys[row.key]}
                          disabled={busy}
                          onChange={(e) => hideRosterRow(row.key, !e.target.checked)}
                          aria-label={`Show ${row.display_name} on this list`}
                          title="Uncheck hides this $0 name for this session only"
                        />
                      ) : (
                        <input
                          type="checkbox"
                          checked={included && !person?.already_deducted_for_week}
                          disabled={busy || Boolean(person?.already_deducted_for_week)}
                          onChange={(e) =>
                            void setPersonIncluded(row.person_id, e.target.checked)
                          }
                          aria-label={
                            person?.already_deducted_for_week
                              ? `${row.display_name} already deducted this Friday`
                              : `Include ${row.display_name} in this Friday's deduction`
                          }
                        />
                      )}
                    </td>
                    <td className="weekly-name-cell">
                      <button
                        type="button"
                        className="weekly-name-btn"
                        onClick={() => {
                          if (row.person_id != null) selectPerson(row.person_id);
                          else
                            selectOffLedger({
                              key: row.key,
                              display_name: row.display_name,
                              user_id: row.user_id,
                            });
                        }}
                      >
                        {row.display_name}
                      </button>
                      {person?.already_deducted_for_week ? (
                        <span
                          className="weekly-skip-badge is-deducted"
                          title={
                            person.week_deducted_at
                              ? `Already deducted for this Friday · entered ${person.week_deducted_at}`
                              : "Already deducted for this pay Friday"
                          }
                        >
                          deducted {formatShortWhen(payrollWeekDate)}
                          {person.week_deducted_amount != null
                            ? ` · ${money(person.week_deducted_amount)}`
                            : ""}
                        </span>
                      ) : person?.last_payroll_date ? (
                        <span
                          className="weekly-last-deduct muted"
                          title={
                            person.last_payroll_at
                              ? `Last payroll deduction entered ${person.last_payroll_at}`
                              : undefined
                          }
                        >
                          last {formatShortWhen(person.last_payroll_date)}
                        </span>
                      ) : null}
                      {isZero || isRosterOnly ? (
                        <span className="weekly-skip-badge">$0</span>
                      ) : null}
                    </td>
                    <td className="num weekly-balance">
                      <strong>{money(row.balance)}</strong>
                    </td>
                    <td className="num weekly-amount-cell owner-weekly-cell">
                      {isZero || isRosterOnly || row.person_id == null ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          <span className="weekly-amount-wrap no-print">
                            <span className="weekly-amount-prefix" aria-hidden>
                              $
                            </span>
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              max={row.balance}
                              className="weekly-deduct-input"
                              value={weekDeductAmounts[row.person_id] ?? ""}
                              onChange={(e) =>
                                setPersonWeekAmount(row.person_id!, e.target.value)
                              }
                              placeholder={suggested > 0 ? suggested.toFixed(2) : "0.00"}
                              disabled={!included || busy}
                              aria-label={`Weekly deduction for ${row.display_name}`}
                            />
                          </span>
                          <span className="print-only">
                            {money(
                              Number(weekDeductAmounts[row.person_id]) > 0
                                ? Math.min(
                                    Number(weekDeductAmounts[row.person_id]),
                                    row.balance
                                  )
                                : suggested
                            )}
                          </span>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && !payrollTableRows.length && (
                <tr>
                  <td colSpan={4} className="muted weekly-empty">
                    No open balances — nothing to deduct this week.
                    {showZeroBalances
                      ? ""
                      : " Check “Include all active employees” for the full roster."}
                  </td>
                </tr>
              )}
            </tbody>
            {payrollTableRows.some((r) => r.balance > 0.009) && (
              <tfoot>
                <tr className="weekly-totals-row owner-totals-row">
                  <td className="no-print" />
                  <td>
                    <strong>
                      Totals ({weekPayrollPreview.count} selected
                      {weekSkips.length > 0
                        ? ` · ${weekSkips.length} skipped this Friday`
                        : ""}
                      )
                    </strong>
                  </td>
                  <td className="num">
                    <strong>{money(visibleOwedTotal)}</strong>
                  </td>
                  <td className="num owner-weekly-cell">
                    <strong className="weekly-total-amt">{money(weekPayrollPreview.total)}</strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {weekSkips.length > 0 ? (
          <div className="payroll-skipped-strip no-print" role="region" aria-label="Skipped this week">
            <div className="payroll-skipped-label">Skipped this week</div>
            <p className="muted payroll-skipped-hint">
              Off this pay Friday&apos;s sheet only — loan balance stays. Tap a name to put them
              back. Next Friday they return automatically.
            </p>
            <ul className="payroll-skipped-list">
              {weekSkips.map((s) => (
                <li key={s.person_id}>
                  <button
                    type="button"
                    className="btn ghost btn-sm payroll-skipped-chip"
                    disabled={busy}
                    onClick={() => void setPersonIncluded(s.person_id, true)}
                    title={`Put ${s.display_name} back on this Friday's deduction report`}
                  >
                    {s.display_name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {(detail || selectedOffLedger) && (
        <section className="card person-ledger-card" id="employee-ledger-detail">
          <div className="person-ledger-head no-print">
            <div>
              <h2 style={{ margin: 0 }}>
                {detail?.person.display_name || selectedOffLedger?.display_name}
              </h2>
              {detail ? (
                <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.88rem" }}>
                  Balance{" "}
                  <strong style={{ fontSize: "1.1rem" }}>{money(detail.person.balance)}</strong>
                  {" · "}
                  charged {money(detail.person.total_charged)} · paid{" "}
                  {money(detail.person.total_paid)}
                </p>
              ) : (
                <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.88rem" }}>
                  Not on the tool loan ledger yet — add their first loan/charge below.
                </p>
              )}
            </div>
            <div className="person-ledger-head-btns">
              {detail && (
                <button type="button" className="btn primary small" onClick={printEmployeeSheet}>
                  Print this employee
                </button>
              )}
              <button
                type="button"
                className="btn secondary small"
                onClick={clearEmployeeSelection}
              >
                Close
              </button>
            </div>
          </div>

          {detail && (
            <div className="print-only person-print-header">
              <strong>Tool loan ledger — {detail.person.display_name}</strong>
              <div>
                Balance {money(detail.person.balance)} · Charged{" "}
                {money(detail.person.total_charged)} · Paid {money(detail.person.total_paid)}
              </div>
              <div>Printed {new Date().toLocaleString()}</div>
            </div>
          )}

          {detail && (
            <div className="no-print person-default-weekly" style={{ marginTop: "0.75rem" }}>
              <label>
                Default weekly amount
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={weeklyEdit}
                  onChange={(e) => setWeeklyEdit(e.target.value)}
                  placeholder="Blank = policy (10% / min $50)"
                />
              </label>
              <button
                type="button"
                className="btn secondary small"
                disabled={busy}
                onClick={() => void saveWeekly()}
              >
                Save default
              </button>
            </div>
          )}

          <div className="no-print person-charge-panel">
            <h3>Add loan / charge</h3>
            <p className="muted" style={{ fontSize: "0.82rem", marginTop: 0 }}>
              No approval needed. After save, an acknowledgment form opens for signature.
            </p>
            <form
              onSubmit={(e) => {
                if (detail) setAddEmployeeKey(`p:${detail.person.person_id}`);
                else if (selectedOffLedger) {
                  if (selectedOffLedger.user_id != null) {
                    setAddEmployeeKey(`u:${selectedOffLedger.user_id}`);
                  } else {
                    setAddEmployeeKey(`n:${selectedOffLedger.display_name}`);
                  }
                }
                void addOfficeCharge(e);
              }}
              className="stack-form"
            >
              <label>
                Type
                <select value={addKind} onChange={(e) => setAddKind(e.target.value)}>
                  <option value="tool_purchase">Tool purchase / loan</option>
                  <option value="unapproved_card">Unapproved credit card charge</option>
                  <option value="balance_adjustment">Balance adjustment</option>
                  <option value="other">Other charge</option>
                </select>
              </label>
              <label>
                Reason / description
                <textarea
                  required
                  rows={2}
                  value={addReason}
                  onChange={(e) => setAddReason(e.target.value)}
                  placeholder="What was purchased and why"
                />
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.65rem", alignItems: "flex-end" }}>
                <label>
                  Date
                  <input
                    type="date"
                    required
                    value={addDate}
                    onChange={(e) => setAddDate(e.target.value)}
                  />
                </label>
                <label>
                  {addIncludeTax ? "Pre-tax amount ($)" : "Amount ($)"}
                  <input
                    type="number"
                    required
                    min="0.01"
                    step="0.01"
                    value={addAmt}
                    onChange={(e) => setAddAmt(e.target.value)}
                  />
                </label>
                <label className="tool-loan-add-tax-check" title={`Adds ${ADD_TAX_RATE}% sales tax to the amount`}>
                  <input
                    type="checkbox"
                    checked={addIncludeTax}
                    onChange={(e) => setAddIncludeTax(e.target.checked)}
                  />
                  <span>Add tax ({ADD_TAX_RATE}%)</span>
                </label>
              </div>
              {addIncludeTax && addTaxPreview.pretax > 0 ? (
                <p className="tool-loan-add-tax-preview muted">
                  Tax {money(addTaxPreview.tax)} ·{" "}
                  <strong>Total charged {money(addTaxPreview.total)}</strong>
                </p>
              ) : null}
              <div className="add-loan-charge-actions">
                <button type="submit" className="btn primary" disabled={busy}>
                  {busy
                    ? "Saving…"
                    : addIncludeTax && addTaxPreview.total > 0
                      ? `Add ${money(addTaxPreview.total)} (with tax) and print`
                      : "Add charge and print acknowledgment"}
                </button>
                {lastChargePrintId != null && (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => openChargeAgreementPrint(lastChargePrintId)}
                  >
                    Re-print last acknowledgment
                  </button>
                )}
              </div>
            </form>
          </div>

          {detail && (
            <>
              <div className="no-print" style={{ marginTop: "1rem" }}>
                <h3 style={{ fontSize: "1rem" }}>Add payment</h3>
                <form onSubmit={addPayment} className="stack-form">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "0.65rem" }}>
                    <label>
                      Date
                      <input
                        type="date"
                        required
                        value={payDate}
                        onChange={(e) => setPayDate(e.target.value)}
                      />
                    </label>
                    <label>
                      Amount
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={payAmt}
                        onChange={(e) => setPayAmt(e.target.value)}
                      />
                    </label>
                    <label>
                      Type
                      <select
                        value={payType}
                        onChange={(e) =>
                          setPayType(e.target.value as "payroll" | "spiff" | "other")
                        }
                      >
                        <option value="payroll">Payroll deduction</option>
                        <option value="spiff">Spiff</option>
                        <option value="other">Other</option>
                      </select>
                    </label>
                  </div>
                  <label>
                    Note (optional)
                    <input value={payNote} onChange={(e) => setPayNote(e.target.value)} />
                  </label>
                  <button type="submit" className="btn primary" disabled={busy}>
                    Add payment
                  </button>
                </form>
              </div>

              <h3 style={{ fontSize: "1rem", marginTop: "1.25rem" }}>Loans / charges</h3>
              <p className="muted no-print" style={{ fontSize: "0.82rem", margin: "0.15rem 0 0.45rem" }}>
                Click a loan to reprint · <strong>Edit</strong> to fix amount/tax ·{" "}
                <strong>Void</strong> only if entered by mistake.
              </p>
              {editChargeId != null && (
                <form
                  className="card form tool-loan-amend-form no-print"
                  onSubmit={saveEditCharge}
                  style={{ marginBottom: "0.75rem" }}
                >
                  <h4 style={{ margin: "0 0 0.4rem", fontSize: "0.95rem" }}>
                    Correct loan amount
                  </h4>
                  <p className="muted" style={{ margin: "0 0 0.55rem", fontSize: "0.82rem" }}>
                    Use this when tax was forgotten. Pre-tax + tax % → new payroll total. Same
                    loan stays on file (not voided).
                  </p>
                  <label>
                    Description
                    <input
                      value={editDesc}
                      onChange={(e) => setEditDesc(e.target.value)}
                      required
                    />
                  </label>
                  <div className="tool-loan-amend-grid">
                    <label>
                      Pre-tax
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        required
                        value={editPretax}
                        onChange={(e) => setEditPretax(e.target.value)}
                      />
                    </label>
                    <label>
                      Tax %
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={editTaxRate}
                        onChange={(e) => setEditTaxRate(e.target.value)}
                      />
                    </label>
                    <div className="tool-loan-amend-total">
                      <span className="muted">Tax {money(editTaxPreview.tax)}</span>
                      <strong>Total {money(editTaxPreview.total)}</strong>
                    </div>
                  </div>
                  <label>
                    Reason (audit)
                    <input
                      value={editReason}
                      onChange={(e) => setEditReason(e.target.value)}
                      placeholder="e.g. Forgot to include sales tax"
                    />
                  </label>
                  <div className="toolbar" style={{ marginTop: "0.35rem" }}>
                    <button type="submit" className="btn primary" disabled={busy}>
                      {busy ? "Saving…" : "Save corrected amount"}
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={closeEditCharge}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              )}
              <div className="table-wrap">
                <table className="data-table charge-history-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Description</th>
                      <th className="num">Amount</th>
                      <th className="no-print">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.charges.map((c) => {
                      const canAct = !c.voided;
                      return (
                        <tr
                          key={c.id}
                          className={
                            c.voided
                              ? "muted"
                              : editChargeId === c.id
                                ? "is-editing-charge"
                                : undefined
                          }
                        >
                          <td>{c.charge_date?.slice(0, 10)}</td>
                          <td>
                            {canAct ? (
                              <button
                                type="button"
                                className="charge-desc-link"
                                onClick={() => openChargeAgreementPrint(c.id)}
                              >
                                {c.description}
                              </button>
                            ) : (
                              <>
                                {c.description}
                                {" (voided)"}
                              </>
                            )}
                          </td>
                          <td className="num">{money(Number(c.amount))}</td>
                          <td className="no-print">
                            {canAct ? (
                              <div className="charge-row-actions">
                                <button
                                  type="button"
                                  className="btn secondary small"
                                  disabled={busy}
                                  onClick={() => openEditCharge(c)}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="btn secondary small"
                                  disabled={busy}
                                  onClick={() =>
                                    void voidCharge(
                                      c.id,
                                      `${c.description} · ${money(Number(c.amount))}`
                                    )
                                  }
                                >
                                  Void
                                </button>
                              </div>
                            ) : (
                              <span className="muted">voided</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {!detail.charges.length && (
                      <tr>
                        <td colSpan={4} className="muted" style={{ textAlign: "center" }}>
                          No loans or charges yet — add one above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <h3 style={{ fontSize: "1rem", marginTop: "1.1rem" }}>Payments</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Note</th>
                      <th className="num">Amount</th>
                      <th className="no-print"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.payments.map((p) => (
                      <tr key={p.id} className={p.voided ? "muted" : undefined}>
                        <td>{p.payment_date?.slice(0, 10)}</td>
                        <td>
                          {p.payment_type === "spiff" ? (
                            <span style={{ color: "#1d4ed8", fontWeight: 600 }}>spiff</span>
                          ) : (
                            p.payment_type
                          )}
                          {p.voided ? " (voided)" : ""}
                        </td>
                        <td className="muted" style={{ fontSize: "0.88rem" }}>
                          {p.note || "—"}
                        </td>
                        <td className="num">{money(Number(p.amount))}</td>
                        <td className="no-print">
                          {!p.voided ? (
                            <button
                              type="button"
                              className="btn secondary small"
                              disabled={busy}
                              onClick={() =>
                                void voidPayment(
                                  p.id,
                                  `${p.payment_type} · ${money(Number(p.amount))} · ${p.payment_date?.slice(0, 10) || ""}`
                                )
                              }
                            >
                              Void
                            </button>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {!detail.payments.length && (
                      <tr>
                        <td colSpan={5} className="muted" style={{ textAlign: "center" }}>
                          No payments yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {!detail && !selectedOffLedger && !loading && (
        <p className="muted no-print" style={{ fontSize: "0.9rem", marginTop: "0.5rem" }}>
          Click an employee name above to view their loans, add a charge, or print their sheet.
        </p>
      )}
    </div>
  );
}
