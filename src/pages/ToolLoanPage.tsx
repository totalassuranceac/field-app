import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type LoanStatus =
  | "pending_manager"
  | "pending_office"
  | "approved"
  | "declined"
  | "cancelled";

type PartStatus = "pending_order" | "ordered" | "arrived" | null;

interface ToolLoanRequest {
  id: number;
  user_id: number;
  manager_user_id: number | null;
  item_name: string;
  item_url: string;
  amount: number;
  purpose: string;
  status: LoanStatus;
  manager_remarks: string | null;
  office_remarks: string | null;
  part_status?: PartStatus;
  ordered_at?: string | null;
  arrived_at?: string | null;
  part_note?: string | null;
  created_at: string;
  employee_name?: string | null;
  manager_name?: string | null;
  manager_decided_by_name?: string | null;
  office_decided_by_name?: string | null;
}

const MIN_WEEKLY_PAYMENT = 50;
const REPAYMENT_PERCENT = 10;

const DISCLAIMER = `Tool loan terms (Total Assurance):

• We deduct 10% of the loan amount from your paycheck every week.
• Minimum weekly payment is $50, even if 10% of the loan is less than $50.
• The total balance of all your open tool loans must not exceed what you make in a typical week (office already has your pay on file).
• Loans are only for company-related tools that make field work easier — not personal use.
• Providing a product link helps office verify the item.`;

/** Estimated weekly payroll deduction for a loan amount */
function weeklyPaymentEstimate(loanAmount: number): number {
  if (!Number.isFinite(loanAmount) || loanAmount <= 0) return 0;
  return Math.max(loanAmount * (REPAYMENT_PERCENT / 100), MIN_WEEKLY_PAYMENT);
}

function statusLabel(s: string): string {
  if (s === "pending_manager" || s === "pending_office") return "Pending office";
  if (s === "approved") return "Approved";
  if (s === "declined") return "Declined";
  if (s === "cancelled") return "Cancelled";
  return s;
}

function statusClass(s: string): string {
  if (s === "pending_manager" || s === "pending_office") return "pending";
  return s;
}

function isPending(s: string): boolean {
  return s === "pending_manager" || s === "pending_office";
}

function effectivePartStatus(r: ToolLoanRequest): PartStatus {
  if (r.status !== "approved") return null;
  return (r.part_status as PartStatus) || "pending_order";
}

function partStatusLabel(ps: PartStatus): string {
  if (ps === "pending_order") return "Waiting to order";
  if (ps === "ordered") return "Ordered";
  if (ps === "arrived") return "Arrived";
  return "";
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** True only for real http(s) links — store names like "amazon" stay plain text. */
function isHttpLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function ProductLinkNote({ value }: { value: string }) {
  if (!value.trim()) {
    return (
      <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
        No product link provided
      </p>
    );
  }
  if (isHttpLink(value)) {
    return (
      <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
        <a href={value} target="_blank" rel="noreferrer">
          View product link
        </a>
      </p>
    );
  }
  return (
    <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
      Store / note: {value}
    </p>
  );
}

/** Visual step tracker: Requested → Approved → Ordered → Arrived */
function LoanProgress({ r }: { r: ToolLoanRequest }) {
  const declined = r.status === "declined";
  const cancelled = r.status === "cancelled";
  if (declined || cancelled) {
    return (
      <div className="tool-loan-progress tool-loan-progress-closed">
        <span className={`tool-loan-status st-${statusClass(r.status)}`}>{statusLabel(r.status)}</span>
        {r.office_remarks && (
          <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
            {r.office_remarks}
          </p>
        )}
      </div>
    );
  }

  const part = effectivePartStatus(r);
  const steps: { key: string; label: string; done: boolean; active: boolean; when?: string }[] = [
    {
      key: "requested",
      label: "Requested",
      done: true,
      active: isPending(r.status),
      when: formatWhen(r.created_at),
    },
    {
      key: "approved",
      label: "Approved",
      done: r.status === "approved",
      active: r.status === "approved" && part === "pending_order",
    },
    {
      key: "ordered",
      label: "Ordered",
      done: part === "ordered" || part === "arrived",
      active: part === "ordered",
      when: formatWhen(r.ordered_at),
    },
    {
      key: "arrived",
      label: "Arrived",
      done: part === "arrived",
      active: part === "arrived",
      when: formatWhen(r.arrived_at),
    },
  ];

  return (
    <div className="tool-loan-progress" aria-label="Loan and part progress">
      <ol className="tool-loan-steps">
        {steps.map((s, i) => (
          <li
            key={s.key}
            className={`tool-loan-step${s.done ? " is-done" : ""}${s.active ? " is-active" : ""}`}
          >
            <span className="tool-loan-step-dot" aria-hidden />
            <span className="tool-loan-step-label">{s.label}</span>
            {s.when ? <span className="tool-loan-step-when">{s.when}</span> : null}
            {i < steps.length - 1 ? <span className="tool-loan-step-line" aria-hidden /> : null}
          </li>
        ))}
      </ol>
      {r.status === "approved" && part === "pending_order" && (
        <p className="tool-loan-progress-note">Loan approved — office will order the part next.</p>
      )}
      {part === "ordered" && (
        <p className="tool-loan-progress-note">
          Part ordered{r.ordered_at ? ` on ${formatWhen(r.ordered_at)}` : ""}. Waiting for arrival.
        </p>
      )}
      {part === "arrived" && (
        <p className="tool-loan-progress-note is-ready">
          Part arrived{r.arrived_at ? ` on ${formatWhen(r.arrived_at)}` : ""} — ready for you.
        </p>
      )}
      {r.part_note && (
        <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
          Note: {r.part_note}
        </p>
      )}
    </div>
  );
}

/**
 * Company tool loan: employee request → office approval → order → arrival tracking.
 * Payroll: 10% of loan / week, minimum $50/week. Total open loans must not exceed weekly pay (office enforces).
 */
export function ToolLoanPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<"mine" | "approvals">("mine");
  const [mine, setMine] = useState<ToolLoanRequest[]>([]);
  const [approvals, setApprovals] = useState<ToolLoanRequest[]>([]);
  const [isApprover, setIsApprover] = useState(false);
  const [pendingForMe, setPendingForMe] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);

  const [itemName, setItemName] = useState("");
  const [itemUrl, setItemUrl] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [disclaimer, setDisclaimer] = useState(false);

  const [decideId, setDecideId] = useState<number | null>(null);
  const [decideAction, setDecideAction] = useState<"approved" | "declined">("approved");
  const [remarks, setRemarks] = useState("");

  const [partNoteId, setPartNoteId] = useState<number | null>(null);
  const [partNoteAction, setPartNoteAction] = useState<"ordered" | "arrived">("ordered");
  const [partNote, setPartNote] = useState("");

  const isOffice = user?.role === "admin" || user?.role === "office";

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, a] = await Promise.all([
        api<{
          requests: ToolLoanRequest[];
          is_approver?: boolean;
          pending_for_me?: number;
          error?: string;
        }>("/tool-loans?view=mine"),
        isOffice
          ? api<{
              requests: ToolLoanRequest[];
              is_approver?: boolean;
              pending_for_me?: number;
            }>("/tool-loans?view=approvals")
          : Promise.resolve({
              requests: [] as ToolLoanRequest[],
              is_approver: false,
              pending_for_me: 0,
            }),
      ]);
      if (m.error) setError(m.error);
      setMine(m.requests || []);
      setApprovals(a.requests || []);
      setIsApprover(Boolean(isOffice || a.is_approver));
      setPendingForMe(a.pending_for_me ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tool loans");
    }
  }, [isOffice]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("tab") === "approvals" && isApprover) setTab("approvals");
  }, [isApprover]);

  const amountNum = Number(amount);
  const estWeekly =
    Number.isFinite(amountNum) && amountNum > 0 ? weeklyPaymentEstimate(amountNum) : 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const amt = Number(amount);
      if (!disclaimer) {
        throw new Error("Please accept the tool loan terms to continue.");
      }
      if (!(amt > 0)) {
        throw new Error("Enter a valid loan amount.");
      }
      await api("/tool-loans", {
        method: "POST",
        body: JSON.stringify({
          item_name: itemName.trim(),
          item_url: itemUrl.trim(),
          amount: amt,
          purpose: purpose.trim(),
          disclaimer_accepted: true,
        }),
      });
      setOk("Tool loan request submitted — waiting on office approval.");
      setItemName("");
      setItemUrl("");
      setAmount("");
      setPurpose("");
      setDisclaimer(false);
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
    if (!window.confirm("Cancel this tool loan request?")) return;
    setActingId(id);
    try {
      await api(`/tool-loans/${id}/cancel`, { method: "POST", body: "{}" });
      setOk("Request cancelled.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActingId(null);
    }
  }

  function openDecide(r: ToolLoanRequest, action: "approved" | "declined") {
    setDecideId(r.id);
    setDecideAction(action);
    setRemarks("");
  }

  async function submitDecision(e: FormEvent) {
    e.preventDefault();
    if (decideId == null) return;
    setActingId(decideId);
    setError("");
    try {
      await api(`/tool-loans/${decideId}/decide`, {
        method: "POST",
        body: JSON.stringify({
          decision: decideAction,
          remarks: remarks.trim() || null,
        }),
      });
      setOk(
        decideAction === "approved"
          ? "Approved — employee can track order status. Mark Ordered when you place the order."
          : "Declined — employee was notified."
      );
      setDecideId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save decision");
    } finally {
      setActingId(null);
    }
  }

  function openPartStatus(r: ToolLoanRequest, action: "ordered" | "arrived") {
    setPartNoteId(r.id);
    setPartNoteAction(action);
    setPartNote(r.part_note || "");
  }

  async function submitPartStatus(e: FormEvent) {
    e.preventDefault();
    if (partNoteId == null) return;
    setActingId(partNoteId);
    setError("");
    try {
      await api(`/tool-loans/${partNoteId}/part-status`, {
        method: "POST",
        body: JSON.stringify({
          part_status: partNoteAction,
          note: partNote.trim() || null,
        }),
      });
      setOk(
        partNoteAction === "ordered"
          ? "Marked ordered — employee was notified."
          : "Marked arrived — employee was notified."
      );
      setPartNoteId(null);
      setPartNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update part status");
    } finally {
      setActingId(null);
    }
  }

  const actionable = useMemo(() => {
    if (!isOffice) return [];
    return approvals.filter((r) => isPending(r.status));
  }, [approvals, isOffice]);

  const needsFulfillment = useMemo(() => {
    if (!isOffice) return [];
    return approvals.filter((r) => {
      if (r.status !== "approved") return false;
      const ps = effectivePartStatus(r);
      return ps === "pending_order" || ps === "ordered";
    });
  }, [approvals, isOffice]);

  const recentClosed = useMemo(
    () =>
      approvals.filter((r) => {
        if (r.status === "declined" || r.status === "cancelled") return true;
        if (r.status === "approved" && effectivePartStatus(r) === "arrived") return true;
        return false;
      }),
    [approvals]
  );

  return (
    <div className="page tool-loan-page">
      <div className="page-header">
        <div>
          <h1>Tool Loan Request</h1>
          <p>
            Request a company tool loan for field work. Office approves, then you can track when
            the part is ordered and when it arrives.
          </p>
        </div>
        <button
          type="button"
          className="btn secondary btn-sm no-print"
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? "Hide form" : "New request"}
        </button>
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
        {isApprover && (
          <button
            type="button"
            className={`chip ${tab === "approvals" ? "active" : ""}`}
            onClick={() => setTab("approvals")}
          >
            Approvals
            {pendingForMe || needsFulfillment.length
              ? ` (${pendingForMe}${needsFulfillment.length ? ` · ${needsFulfillment.length} parts` : ""})`
              : ""}
          </button>
        )}
      </div>

      {showForm && tab === "mine" && (
        <form
          className="card form"
          onSubmit={submit}
          style={{ marginBottom: "1rem" }}
          noValidate
        >
          <h2 style={{ marginTop: 0 }}>New tool loan request</h2>

          <div className="tool-loan-disclaimer" role="note">
            <strong>Important — read before you submit</strong>
            <ul>
              <li>
                We deduct <strong>10% of the loan amount</strong> from your paycheck every week.
              </li>
              <li>
                <strong>Minimum weekly payment is ${MIN_WEEKLY_PAYMENT}</strong>, even if 10% of the
                loan is less than that.
              </li>
              <li>
                The <strong>total balance of all your open tool loans</strong> must not exceed what
                you make in a typical week (office already has your pay on file).
              </li>
              <li>
                Loans are for <strong>company-related tools</strong> that make field work easier —
                not personal use.
              </li>
            </ul>
          </div>

          <label>
            Tool / part name
            <input
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              required
              placeholder="e.g. Milwaukee M18 impact driver kit"
            />
          </label>
          <label>
            Product link or store name{" "}
            <span className="muted">(optional — preferred if you have a link)</span>
            <input
              type="text"
              name="product_link_optional"
              value={itemUrl}
              onChange={(e) => setItemUrl(e.target.value)}
              placeholder="Leave blank, or paste a link / store name"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </label>
          <label>
            Loan amount ($)
            <input
              type="number"
              min={1}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="Total amount to finance"
            />
          </label>
          {estWeekly > 0 && (
            <p className="muted" style={{ margin: "-0.35rem 0 0", fontSize: "0.85rem" }}>
              Estimated weekly paycheck deduction: <strong>${estWeekly.toFixed(2)}</strong>
              {" "}
              (10% of loan, or ${MIN_WEEKLY_PAYMENT} minimum — whichever is higher)
            </p>
          )}
          <label>
            How this helps your field work (required)
            <textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              required
              rows={3}
              placeholder="Company-related use only — e.g. install work on residential jobs, faster service calls"
            />
          </label>

          <label className="tool-loan-check">
            <input
              type="checkbox"
              checked={disclaimer}
              onChange={(e) => setDisclaimer(e.target.checked)}
              required
            />
            <span>
              I understand: 10% of the loan is deducted weekly (minimum ${MIN_WEEKLY_PAYMENT}/week);
              total open tool loan balances must not exceed my weekly pay; this is for company/field
              work only.
            </span>
          </label>

          <details className="tool-loan-terms-full">
            <summary>Full disclaimer text</summary>
            <pre className="tool-loan-terms-pre">{DISCLAIMER}</pre>
          </details>

          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy || !disclaimer}>
              {busy ? "Submitting…" : "Submit for office approval"}
            </button>
          </div>
        </form>
      )}

      {tab === "mine" && (
        <section className="tool-loan-list">
          {!mine.length ? (
            <div className="card muted">No tool loan requests yet.</div>
          ) : (
            mine.map((r) => (
              <article key={r.id} className={`card tool-loan-card st-${statusClass(r.status)}`}>
                <div className="tool-loan-card-head">
                  <strong>{r.item_name}</strong>
                  <span className={`tool-loan-status st-${statusClass(r.status)}`}>
                    {r.status === "approved"
                      ? partStatusLabel(effectivePartStatus(r)) || "Approved"
                      : statusLabel(r.status)}
                  </span>
                </div>
                <p className="tool-loan-amount">
                  ${Number(r.amount).toFixed(2)}
                  <span className="muted">
                    {" "}
                    · ~${weeklyPaymentEstimate(Number(r.amount)).toFixed(2)}/week deduction
                  </span>
                </p>
                <ProductLinkNote value={r.item_url || ""} />
                <p className="tool-loan-purpose">{r.purpose}</p>
                <LoanProgress r={r} />
                {r.office_remarks && (
                  <div className="tool-loan-remarks">
                    <strong>Office:</strong> {r.office_remarks}
                  </div>
                )}
                {isPending(r.status) && (
                  <div className="toolbar" style={{ marginTop: "0.5rem" }}>
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
              </article>
            ))
          )}
        </section>
      )}

      {tab === "approvals" && isApprover && (
        <section className="tool-loan-list">
          <h2 className="tool-loan-section-title">
            Needs office review{actionable.length ? ` (${actionable.length})` : ""}
          </h2>
          {!actionable.length ? (
            <div className="card muted">Nothing waiting for approval right now.</div>
          ) : (
            actionable.map((r) => (
              <article key={r.id} className="card tool-loan-card st-pending">
                <div className="tool-loan-card-head">
                  <strong>{r.employee_name || "Employee"}</strong>
                  <span className="tool-loan-status st-pending">{statusLabel(r.status)}</span>
                </div>
                <p className="tool-loan-amount">
                  {r.item_name} · ${Number(r.amount).toFixed(2)}
                </p>
                <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                  ~${weeklyPaymentEstimate(Number(r.amount)).toFixed(2)}/week deduction
                  {r.item_url ? (
                    isHttpLink(r.item_url) ? (
                      <>
                        {" · "}
                        <a href={r.item_url} target="_blank" rel="noreferrer">
                          Product link
                        </a>
                      </>
                    ) : (
                      <> · {r.item_url}</>
                    )
                  ) : (
                    " · no product link"
                  )}
                </p>
                <p className="tool-loan-purpose">{r.purpose}</p>

                {decideId === r.id ? (
                  <form className="form" onSubmit={submitDecision} style={{ marginTop: "0.65rem" }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      {decideAction === "approved" ? "Approve" : "Decline"} (office decision)
                    </p>
                    <label>
                      Remarks <span className="muted">(optional — employee may see this)</span>
                      <textarea
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        rows={2}
                        placeholder="Optional notes for the employee"
                      />
                    </label>
                    <div className="toolbar">
                      <button className="btn btn-sm" type="submit" disabled={actingId === r.id}>
                        {actingId === r.id ? "Saving…" : "Confirm"}
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

          <h2 className="tool-loan-section-title" style={{ marginTop: "1.25rem" }}>
            Parts to track{needsFulfillment.length ? ` (${needsFulfillment.length})` : ""}
          </h2>
          <p className="muted" style={{ margin: "-0.25rem 0 0.55rem", fontSize: "0.85rem" }}>
            After you approve a loan, mark Ordered when you place the order, then Arrived when it
            shows up — the employee sees the same status.
          </p>
          {!needsFulfillment.length ? (
            <div className="card muted">No approved parts waiting to be ordered or delivered.</div>
          ) : (
            needsFulfillment.map((r) => {
              const ps = effectivePartStatus(r);
              return (
                <article key={r.id} className="card tool-loan-card st-approved">
                  <div className="tool-loan-card-head">
                    <strong>
                      {r.employee_name || "Employee"} · {r.item_name}
                    </strong>
                    <span className="tool-loan-status st-approved">
                      {partStatusLabel(ps) || "Approved"}
                    </span>
                  </div>
                  <p className="tool-loan-amount">${Number(r.amount).toFixed(2)}</p>
                  <LoanProgress r={r} />
                  {r.item_url ? (
                    isHttpLink(r.item_url) ? (
                      <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                        <a href={r.item_url} target="_blank" rel="noreferrer">
                          Product link
                        </a>
                      </p>
                    ) : (
                      <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                        {r.item_url}
                      </p>
                    )
                  ) : null}

                  {partNoteId === r.id ? (
                    <form
                      className="form"
                      onSubmit={submitPartStatus}
                      style={{ marginTop: "0.65rem" }}
                    >
                      <p style={{ margin: 0, fontWeight: 700 }}>
                        Mark as {partNoteAction === "ordered" ? "Ordered" : "Arrived"}
                      </p>
                      <label>
                        Note for employee{" "}
                        <span className="muted">(optional — tracking #, vendor, pickup spot)</span>
                        <input
                          value={partNote}
                          onChange={(e) => setPartNote(e.target.value)}
                          placeholder="e.g. Amazon order #… / at shop front desk"
                        />
                      </label>
                      <div className="toolbar">
                        <button className="btn btn-sm" type="submit" disabled={actingId === r.id}>
                          {actingId === r.id ? "Saving…" : "Confirm"}
                        </button>
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          onClick={() => setPartNoteId(null)}
                        >
                          Back
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="toolbar" style={{ marginTop: "0.55rem" }}>
                      {ps === "pending_order" && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => openPartStatus(r, "ordered")}
                        >
                          Mark ordered
                        </button>
                      )}
                      {(ps === "pending_order" || ps === "ordered") && (
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          onClick={() => openPartStatus(r, "arrived")}
                        >
                          Mark arrived
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })
          )}

          {recentClosed.length > 0 && (
            <>
              <h2 className="tool-loan-section-title" style={{ marginTop: "1.25rem" }}>
                Recently closed
              </h2>
              {recentClosed.map((r) => (
                <article key={r.id} className={`card tool-loan-card st-${statusClass(r.status)}`}>
                  <div className="tool-loan-card-head">
                    <strong>
                      {r.employee_name || "Employee"} · {r.item_name}
                    </strong>
                    <span className={`tool-loan-status st-${statusClass(r.status)}`}>
                      {r.status === "approved"
                        ? partStatusLabel(effectivePartStatus(r)) || statusLabel(r.status)
                        : statusLabel(r.status)}
                    </span>
                  </div>
                  <p className="tool-loan-amount">${Number(r.amount).toFixed(2)}</p>
                  {r.status === "approved" && <LoanProgress r={r} />}
                  {r.office_remarks && (
                    <div className="tool-loan-remarks">
                      <strong>Office:</strong> {r.office_remarks}
                    </div>
                  )}
                </article>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}
