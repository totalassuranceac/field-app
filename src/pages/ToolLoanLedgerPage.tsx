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
  const [detail, setDetail] = useState<{
    person: PersonSummary;
    charges: Charge[];
    payments: Payment[];
  } | null>(null);

  const [chargeDesc, setChargeDesc] = useState("");
  const [chargeDate, setChargeDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [chargeAmt, setChargeAmt] = useState("");

  const [payDate, setPayDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payAmt, setPayAmt] = useState("");
  const [payType, setPayType] = useState<"payroll" | "spiff" | "other">("payroll");
  const [payNote, setPayNote] = useState("");

  const [weeklyEdit, setWeeklyEdit] = useState("");
  const [report, setReport] = useState<OwnerReport | null>(null);

  /** Payroll week: bulk deduct everyone checked, with optional amount overrides. */
  const [payrollWeekDate, setPayrollWeekDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [weekDeductAmounts, setWeekDeductAmounts] = useState<Record<number, string>>(
    {}
  );
  /** When false, that person is skipped by the bulk button. */
  const [weekInclude, setWeekInclude] = useState<Record<number, boolean>>({});

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
        // New people default to included; keep user's unchecks
        if (prev[p.person_id] === undefined) next[p.person_id] = true;
      }
      return next;
    });
  }

  const loadAll = useCallback(async () => {
    setError("");
    setLoading(true);
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

      const [summary, owner] = await Promise.all([
        api<{
          people: PersonSummary[];
          open_count: number;
          total_owed: number;
          error?: string;
        }>("/tool-loan-ledger/summary", { timeoutMs: 30_000 }),
        api<OwnerReport>("/tool-loan-ledger/owner-report", { timeoutMs: 30_000 }),
      ]);

      if (summary.error) throw new Error(summary.error);
      const list = summary.people || [];
      setPeople(list);
      setOpenCount(summary.open_count || 0);
      setTotalOwed(summary.total_owed || 0);
      setReport(owner);
      seedWeekAmounts(list);
      setOk("");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not load ledger";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

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

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const openPeople = useMemo(
    () => people.filter((p) => p.balance > 0.009),
    [people]
  );

  async function addCharge(e: FormEvent) {
    e.preventDefault();
    if (!selectedId) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/tool-loan-ledger/charges", {
        method: "POST",
        body: JSON.stringify({
          person_id: selectedId,
          description: chargeDesc.trim(),
          charge_date: chargeDate,
          amount: Number(chargeAmt),
        }),
      });
      setChargeDesc("");
      setChargeAmt("");
      setOk("Charge added.");
      await loadDetail(selectedId);
      await loadAll();
    } catch (err) {
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
      });
      setPayAmt("");
      setPayNote("");
      setOk(payType === "spiff" ? "Spiff payment recorded." : "Payroll payment recorded.");
      await loadDetail(selectedId);
      await loadAll();
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

  const weekPayrollPreview = useMemo(() => {
    let count = 0;
    let total = 0;
    let skipped = 0;
    for (const p of payrollCandidates) {
      if (weekInclude[p.person_id] === false) {
        skipped += 1;
        continue;
      }
      const n = Number(weekDeductAmounts[p.person_id]);
      if (!Number.isFinite(n) || n <= 0) continue;
      count += 1;
      total += Math.min(n, p.balance);
    }
    return { count, total: Math.round(total * 100) / 100, skipped };
  }, [payrollCandidates, weekDeductAmounts, weekInclude]);

  const allChecked =
    payrollCandidates.length > 0 &&
    payrollCandidates.every((p) => weekInclude[p.person_id] !== false);

  function setPersonWeekAmount(personId: number, value: string) {
    setWeekDeductAmounts((prev) => ({ ...prev, [personId]: value }));
  }

  function setPersonIncluded(personId: number, included: boolean) {
    setWeekInclude((prev) => ({ ...prev, [personId]: included }));
  }

  function setAllIncluded(included: boolean) {
    const next: Record<number, boolean> = {};
    for (const p of payrollCandidates) next[p.person_id] = included;
    setWeekInclude(next);
  }

  function fillSuggestedAmounts() {
    const nextAmt: Record<number, string> = {};
    const nextInc: Record<number, boolean> = {};
    for (const p of payrollCandidates) {
      const amt = suggestedWeekAmount(p);
      nextAmt[p.person_id] = amt > 0 ? amt.toFixed(2) : "";
      nextInc[p.person_id] = true;
    }
    setWeekDeductAmounts(nextAmt);
    setWeekInclude(nextInc);
  }

  function clearWeekAmounts() {
    const next: Record<number, string> = {};
    for (const p of payrollCandidates) next[p.person_id] = "";
    setWeekDeductAmounts(next);
  }

  /**
   * One-click bulk: records payroll payments for every checked person
   * using their amount (suggested by default, editable per row).
   */
  async function recordWeeklyPayroll() {
    const lines: { person_id: number; name: string; amount: number }[] = [];
    for (const p of payrollCandidates) {
      if (weekInclude[p.person_id] === false) continue;
      const n = Number(weekDeductAmounts[p.person_id]);
      if (!Number.isFinite(n) || n <= 0) continue;
      const amount = Math.round(Math.min(n, p.balance) * 100) / 100;
      if (amount <= 0) continue;
      lines.push({ person_id: p.person_id, name: p.display_name, amount });
    }
    if (!lines.length) {
      setError(
        "No one is ready to deduct. Check at least one person and enter an amount greater than $0 (or use Reset to policy amounts)."
      );
      return;
    }
    if (!payrollWeekDate) {
      setError("Choose the payroll week date.");
      return;
    }
    const total = lines.reduce((s, l) => s + l.amount, 0);
    const skipped = payrollCandidates.filter((p) => weekInclude[p.person_id] === false).length;
    const skipNote =
      skipped > 0 ? `\n${skipped} person${skipped === 1 ? "" : "s"} unchecked (skipped).` : "";
    const okConfirm = window.confirm(
      `Apply bulk weekly deductions for ${lines.length} employee${lines.length === 1 ? "" : "s"} totaling $${total.toFixed(2)} (week of ${payrollWeekDate})?${skipNote}\n\nThis records a payroll payment on each checked person's ledger.`
    );
    if (!okConfirm) return;

    setBusy(true);
    setError("");
    setOk("");
    try {
      let recorded = 0;
      for (const line of lines) {
        await api("/tool-loan-ledger/payments", {
          method: "POST",
          body: JSON.stringify({
            person_id: line.person_id,
            payment_date: payrollWeekDate,
            amount: line.amount,
            payment_type: "payroll",
            note: `Payroll week of ${payrollWeekDate}`,
          }),
        });
        recorded += 1;
      }
      // Uncheck + clear amounts so a second click cannot double-post
      clearWeekAmounts();
      setAllIncluded(false);
      if (selectedId) await loadDetail(selectedId);
      await loadAll();
      setOk(
        `Bulk deducted ${recorded} employee${recorded === 1 ? "" : "s"} for week of ${payrollWeekDate}. Balances updated — open anyone for payment history.`
      );
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
    const url = "/api/tool-loan-ledger/owner-report-print";
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
      <header className="page-header no-print" style={{ marginBottom: "1rem" }}>
        <div>
          <h1 style={{ marginBottom: "0.25rem" }}>Tool loan payroll</h1>
          <p className="muted" style={{ margin: 0 }}>
            Office only · Who owes what · print for owner ·{" "}
            <strong>enter weekly deductions</strong> each paycheck ·{" "}
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
      {loading && (
        <p className="muted no-print">Loading ledger…</p>
      )}

      {/* ——— OWNER REPORT (print hero) ——— */}
      <section className="card owner-report-card" id="owner-payroll-report">
        <div className="owner-report-letterhead">
          <div className="owner-report-brand">
            <div className="owner-report-logo-mark" aria-hidden>
              TA
            </div>
            <div>
              <div className="owner-report-company">Total Assurance A/C &amp; Heating</div>
              <div className="owner-report-subtitle">Tool Loan Payroll Deduction Report</div>
            </div>
          </div>
          <div className="owner-report-meta">
            <div>
              <span className="owner-meta-label">Week of</span>
              <strong>{report ? formatWeekLabel(report.week_of) : "—"}</strong>
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
            <span className="owner-kpi-label">Employees to deduct</span>
            <strong>{ownerTotals.employee_count || openCount}</strong>
          </div>
          <div className="owner-kpi">
            <span className="owner-kpi-label">Total remaining</span>
            <strong>{money(ownerTotals.remaining_balance || totalOwed)}</strong>
          </div>
          <div className="owner-kpi owner-kpi-accent">
            <span className="owner-kpi-label">This week&apos;s deductions</span>
            <strong>{money(ownerTotals.weekly_deduction)}</strong>
          </div>
        </div>

        <div className="owner-report-actions no-print">
          <p className="muted" style={{ margin: 0, fontSize: "0.88rem", flex: "1 1 12rem" }}>
            Suggested amounts only. To post them all at once, use{" "}
            <a href="#record-weekly-payroll">Bulk weekly payroll deductions</a> below.
          </p>
          <div className="owner-report-btns" style={{ marginLeft: "auto" }}>
            <button type="button" className="btn secondary" disabled={loading} onClick={() => void loadAll()}>
              Refresh
            </button>
            <button type="button" className="btn primary" onClick={printWeeklyReport}>
              Print weekly report
            </button>
          </div>
        </div>

        <p className="owner-report-policy muted">
          {report?.policy_note ||
            "Weekly deduction = 10% of remaining balance, minimum $50 (e.g. $600 → $60/week)."}
        </p>

        <div className="table-wrap owner-report-table-wrap">
          <table className="data-table owner-report-table">
            <thead>
              <tr>
                <th>Employee Name</th>
                <th className="num">Amount Owed</th>
                <th className="num">Weekly Deduction</th>
              </tr>
            </thead>
            <tbody>
              {ownerLines.map((l) => (
                <tr key={l.person_id}>
                  <td>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => setSelectedId(l.person_id)}
                    >
                      {l.employee_name}
                    </button>
                  </td>
                  <td className="num">
                    <strong>{money(l.remaining_balance)}</strong>
                  </td>
                  <td className="num owner-weekly-cell">
                    <strong>{money(l.weekly_deduction)}</strong>
                  </td>
                </tr>
              ))}
              {!loading && !ownerLines.length && (
                <tr>
                  <td colSpan={3} className="muted" style={{ textAlign: "center", padding: "1.5rem" }}>
                    No open balances for current employees.
                  </td>
                </tr>
              )}
            </tbody>
            {ownerLines.length > 0 && (
              <tfoot>
                <tr className="owner-totals-row">
                  <td>
                    <strong>Totals ({ownerTotals.employee_count})</strong>
                  </td>
                  <td className="num">
                    <strong>{money(ownerTotals.remaining_balance)}</strong>
                  </td>
                  <td className="num owner-weekly-cell">
                    <strong>{money(ownerTotals.weekly_deduction)}</strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      {/* ——— BULK WEEKLY DEDUCTIONS ——— */}
      <section className="card weekly-payroll-entry no-print" id="record-weekly-payroll">
        <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>
          Bulk weekly payroll deductions
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Everyone is <strong>checked</strong> with their weekly amount filled in. Uncheck anyone
          who should skip this week, or change their amount if they need a different takeout. One
          button applies all checked people as trackable payroll payments.
        </p>

        <div className="weekly-payroll-toolbar">
          <label>
            Payroll week date
            <input
              type="date"
              required
              value={payrollWeekDate}
              onChange={(e) => setPayrollWeekDate(e.target.value)}
            />
          </label>
          <div className="weekly-payroll-toolbar-btns">
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || loading || !payrollCandidates.length}
              onClick={() => setAllIncluded(true)}
            >
              Check all
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || loading || !payrollCandidates.length}
              onClick={() => setAllIncluded(false)}
            >
              Uncheck all
            </button>
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || loading}
              onClick={fillSuggestedAmounts}
            >
              Reset to policy amounts
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="data-table weekly-payroll-table">
            <thead>
              <tr>
                <th className="weekly-include-col">
                  <label className="weekly-include-all" title="Include all in bulk deduct">
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
                <th>Employee</th>
                <th className="num">Balance owed</th>
                <th className="num">Suggested</th>
                <th className="num">Amount this week ($)</th>
              </tr>
            </thead>
            <tbody>
              {payrollCandidates.map((p) => {
                const suggested = suggestedWeekAmount(p);
                const included = weekInclude[p.person_id] !== false;
                return (
                  <tr
                    key={p.person_id}
                    className={included ? undefined : "weekly-row-skipped"}
                  >
                    <td className="weekly-include-col">
                      <input
                        type="checkbox"
                        checked={included}
                        disabled={busy}
                        onChange={(e) => setPersonIncluded(p.person_id, e.target.checked)}
                        aria-label={`Include ${p.display_name} in bulk deduct`}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setSelectedId(p.person_id)}
                      >
                        {p.display_name}
                      </button>
                      {!included && (
                        <span className="weekly-skip-badge"> skipped</span>
                      )}
                    </td>
                    <td className="num">{money(p.balance)}</td>
                    <td className="num muted">{money(suggested)}</td>
                    <td className="num">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        max={p.balance}
                        className="weekly-deduct-input"
                        value={weekDeductAmounts[p.person_id] ?? ""}
                        onChange={(e) => setPersonWeekAmount(p.person_id, e.target.value)}
                        placeholder="0.00"
                        disabled={!included || busy}
                        aria-label={`Deduction for ${p.display_name}`}
                      />
                    </td>
                  </tr>
                );
              })}
              {!loading && !payrollCandidates.length && (
                <tr>
                  <td colSpan={5} className="muted" style={{ textAlign: "center", padding: "1.25rem" }}>
                    No open balances for current employees.
                  </td>
                </tr>
              )}
            </tbody>
            {payrollCandidates.length > 0 && (
              <tfoot>
                <tr className="owner-totals-row">
                  <td colSpan={2}>
                    <strong>
                      {weekPayrollPreview.count} will be deducted
                      {weekPayrollPreview.skipped > 0
                        ? ` · ${weekPayrollPreview.skipped} skipped`
                        : ""}
                    </strong>
                  </td>
                  <td />
                  <td />
                  <td className="num">
                    <strong>{money(weekPayrollPreview.total)}</strong>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="weekly-payroll-actions">
          <button
            type="button"
            className="btn primary weekly-bulk-btn"
            disabled={busy || loading || weekPayrollPreview.count === 0}
            onClick={() => void recordWeeklyPayroll()}
          >
            {busy
              ? "Applying bulk deductions…"
              : `Apply bulk weekly deductions (${weekPayrollPreview.count}) · ${money(weekPayrollPreview.total)}`}
          </button>
          <p className="muted" style={{ margin: 0, fontSize: "0.85rem", flex: "1 1 14rem" }}>
            Uncheck to skip someone. Edit the amount column only when one person needs a different
            takeout. After apply, open a person for full payment history.
          </p>
        </div>
      </section>

      <div
        className="tool-loan-ledger-grid no-print"
        style={{
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "minmax(0, 1fr)",
        }}
      >
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: "1.1rem" }}>Balances (open)</h2>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Charged</th>
                  <th>Paid</th>
                  <th>Balance</th>
                  <th>Weekly</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {openPeople.map((p) => (
                  <tr
                    key={p.person_id}
                    className={selectedId === p.person_id ? "is-selected" : undefined}
                  >
                    <td>
                      {p.display_name}
                      {p.status === "former" && (
                        <span className="muted" style={{ display: "block", fontSize: "0.8rem" }}>
                          former · no app login
                        </span>
                      )}
                    </td>
                    <td>{money(p.total_charged)}</td>
                    <td>{money(p.total_paid)}</td>
                    <td>
                      <strong className={p.balance > 0 ? "text-warn" : undefined}>
                        {money(p.balance)}
                      </strong>
                    </td>
                    <td>
                      {money(p.suggested_weekly || p.weekly_this_week || 0)}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn secondary small"
                        onClick={() => setSelectedId(p.person_id)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {detail && (
          <section className="card">
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "0.75rem",
                flexWrap: "wrap",
              }}
            >
              <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>
                {detail.person.display_name}
              </h2>
              <button type="button" className="btn secondary small" onClick={() => setSelectedId(null)}>
                Close
              </button>
            </div>
            <p style={{ marginTop: 0 }}>
              Balance{" "}
              <strong style={{ fontSize: "1.25rem" }}>{money(detail.person.balance)}</strong>
              <span className="muted">
                {" "}
                · charged {money(detail.person.total_charged)} · paid{" "}
                {money(detail.person.total_paid)} · {detail.person.status}
              </span>
            </p>

            <div className="person-default-weekly">
              <label>
                Default weekly amount (owner report)
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={weeklyEdit}
                  onChange={(e) => setWeeklyEdit(e.target.value)}
                  placeholder="Blank = policy (10% / min $50)"
                />
              </label>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void saveWeekly()}>
                Save default
              </button>
            </div>
            <p className="muted" style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
              Optional override for the <strong>suggested</strong> amount on the owner report and
              in &quot;Fill policy amounts&quot;. This does <strong>not</strong> record a payment —
              use <a href="#record-weekly-payroll">Record this week&apos;s payroll deductions</a>{" "}
              above to log what was actually taken each week. Leave blank for standard policy (
              <strong>10% of remaining, min $50</strong>).
            </p>

            <hr style={{ margin: "1.25rem 0", border: 0, borderTop: "1px solid var(--border, #ddd)" }} />

            <h3 style={{ fontSize: "1rem" }}>Add charge (loan / purchase)</h3>
            <form onSubmit={addCharge} className="stack-form">
              <label>
                Description
                <input
                  required
                  value={chargeDesc}
                  onChange={(e) => setChargeDesc(e.target.value)}
                  placeholder="Tool or Balance Carried Over"
                />
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
                <label>
                  Date
                  <input
                    type="date"
                    required
                    value={chargeDate}
                    onChange={(e) => setChargeDate(e.target.value)}
                  />
                </label>
                <label>
                  Amount
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={chargeAmt}
                    onChange={(e) => setChargeAmt(e.target.value)}
                  />
                </label>
              </div>
              <button type="submit" className="btn primary" disabled={busy}>
                Add charge
              </button>
            </form>

            <h3 style={{ fontSize: "1rem", marginTop: "1.25rem" }}>Add payment</h3>
            <form onSubmit={addPayment} className="stack-form">
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
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
                    onChange={(e) => setPayType(e.target.value as "payroll" | "spiff" | "other")}
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

            <h3 style={{ fontSize: "1rem", marginTop: "1.5rem" }}>Charges</h3>
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              History is permanent — no void buttons (prevents accidents).
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.charges.map((c) => (
                    <tr key={c.id} className={c.voided ? "muted" : undefined}>
                      <td>{c.charge_date?.slice(0, 10)}</td>
                      <td>
                        {c.description}
                        {c.voided ? " (voided)" : ""}
                      </td>
                      <td>{money(Number(c.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 style={{ fontSize: "1rem", marginTop: "1.25rem" }}>Payments (trackable history)</h3>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Note</th>
                    <th className="num">Amount</th>
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
                    </tr>
                  ))}
                  {!detail.payments.length && (
                    <tr>
                      <td colSpan={4} className="muted" style={{ textAlign: "center" }}>
                        No payments yet — record weekly payroll above or add a payment here.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
