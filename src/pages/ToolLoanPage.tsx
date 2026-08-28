import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type LoanStatus =
  | "pending_manager"
  | "pending_office"
  | "approved"
  | "declined"
  | "cancelled";

type PartStatus =
  | "pending_order"
  | "ordered"
  | "arrived"
  | "paperwork_signed"
  | null;

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
  paperwork_signed_at?: string | null;
  paperwork_note?: string | null;
  paperwork_key?: string | null;
  created_at: string;
  employee_name?: string | null;
  manager_name?: string | null;
  manager_decided_by_name?: string | null;
  office_decided_by_name?: string | null;
}

const MIN_WEEKLY_PAYMENT = 50;
const REPAYMENT_PERCENT = 10;

/**
 * Open the payroll acknowledgment form and trigger print.
 * Pass a window opened synchronously on click so browsers don't block after await.
 */
function openChargeAgreementPrint(
  chargeId: number,
  preexisting?: Window | null
): Window | null {
  const url = `/api/tool-loan-ledger/charges/${chargeId}/print-agreement`;
  const w =
    preexisting && !preexisting.closed
      ? preexisting
      : window.open("about:blank", "_blank");
  if (w == null) return null;
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
    w.location.href = url;
    return w;
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
  return w;
}

const DISCLAIMER = `Tool loan terms (Total Assurance):

• Weekly payroll deduction = 10% of your remaining balance (including this loan), with a $50 minimum.
• Example: $600 total owed → $60 per week. $400 total owed → $50 per week (minimum applies).
• Bigger total balance means bigger weekly payments until paid off.
• Open tool loans must not exceed a typical week’s pay (office has your pay on file).
• Loans are only for tools needed for company field work — not personal spending.
• The company is not a bank. Request only what you need for the job.`;

/** Policy weekly payroll deduction: max($50, 10% of balance), never more than remaining. */
function weeklyPaymentEstimate(totalBalance: number): number {
  if (!Number.isFinite(totalBalance) || totalBalance <= 0) return 0;
  const b = Math.round(totalBalance * 100) / 100;
  return Math.min(b, Math.max(b * (REPAYMENT_PERCENT / 100), MIN_WEEKLY_PAYMENT));
}

function moneyFmt(n: number): string {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
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
  if (ps === "paperwork_signed") return "Paperwork signed";
  return "";
}

function partRank(ps: PartStatus): number {
  if (ps === "pending_order") return 0;
  if (ps === "ordered") return 1;
  if (ps === "arrived") return 2;
  if (ps === "paperwork_signed") return 3;
  return -1;
}

function paperworkHref(key: string | null | undefined): string | null {
  if (!key || !key.trim()) return null;
  return `/api/uploads/${key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/")}`;
}

/** Default sales tax used to check whether payroll loan includes tax. */
const DEFAULT_TAX_CHECK_RATE = 8.25;

type AmountCheckLevel = "ok" | "warn" | "bad" | "neutral";

type AmountCheck = {
  level: AmountCheckLevel;
  title: string;
  detail: string;
};

/**
 * Payroll loan should usually be pretax + tax. Flag missing tax or odd totals.
 */
function assessChargeVsPurchases(
  chargeAmount: number,
  pretaxSum: number,
  taxRate = DEFAULT_TAX_CHECK_RATE
): AmountCheck {
  const charge = Math.round(Number(chargeAmount) * 100) / 100;
  const pretax = Math.round(Number(pretaxSum) * 100) / 100;
  if (!(charge > 0) || !(pretax > 0)) {
    return {
      level: "neutral",
      title: "Select a loan to check totals",
      detail: "",
    };
  }
  const rate = Number.isFinite(taxRate) && taxRate >= 0 ? taxRate : DEFAULT_TAX_CHECK_RATE;
  const taxAmt = Math.round(pretax * (rate / 100) * 100) / 100;
  const expectedTaxed = Math.round((pretax + taxAmt) * 100) / 100;
  const tol = Math.max(0.05, Math.round(pretax * 0.015 * 100) / 100);

  if (Math.abs(charge - expectedTaxed) <= tol) {
    return {
      level: "ok",
      title: "Totals look correct (tax included)",
      detail: `Payroll ${moneyFmt(charge)} ≈ pretax ${moneyFmt(pretax)} + ${rate}% tax (${moneyFmt(taxAmt)}).`,
    };
  }

  // Exact pretax match → almost certainly missing tax on the paperwork/payroll loan
  if (Math.abs(charge - pretax) <= tol) {
    return {
      level: "warn",
      title: "Tax may be missing on payroll loan",
      detail: `Payroll ${moneyFmt(charge)} matches pretax only. With ${rate}% tax it should be about ${moneyFmt(expectedTaxed)} (add ~${moneyFmt(taxAmt)} tax). Use Edit on the ledger charge or create a new loan with tax.`,
    };
  }

  // Charge between pretax and expected tax — partial tax or wrong rate
  if (charge > pretax + tol && charge < expectedTaxed - tol) {
    const implied = ((charge / pretax) - 1) * 100;
    return {
      level: "warn",
      title: "Tax may be incomplete",
      detail: `Payroll ${moneyFmt(charge)} is only ~${implied.toFixed(1)}% over pretax ${moneyFmt(pretax)}. At ${rate}% expect ${moneyFmt(expectedTaxed)}.`,
    };
  }

  // Implied tax rate in a reasonable band (5–12%) → green
  if (charge > pretax + tol) {
    const implied = ((charge / pretax) - 1) * 100;
    if (implied >= 5 && implied <= 12) {
      return {
        level: "ok",
        title: "Totals look correct (tax-like markup)",
        detail: `Payroll ${moneyFmt(charge)} is about ${implied.toFixed(2)}% above pretax ${moneyFmt(pretax)} — consistent with sales tax.`,
      };
    }
  }

  if (charge + tol < pretax) {
    return {
      level: "bad",
      title: "Payroll is less than purchase total",
      detail: `Payroll ${moneyFmt(charge)} is below pretax purchases ${moneyFmt(pretax)}. Check which items are included or fix the charge amount.`,
    };
  }

  return {
    level: "warn",
    title: "Amounts don't line up",
    detail: `Payroll ${moneyFmt(charge)} vs pretax purchases ${moneyFmt(pretax)} (with ${rate}% tax expect ~${moneyFmt(expectedTaxed)}). Confirm before signing.`,
  };
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

/** Visual step tracker: Requested → Approved → Ordered → Arrived → Paperwork */
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
  const rank = partRank(part);
  const paperHref = paperworkHref(r.paperwork_key);
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
      done: rank >= 1,
      active: part === "ordered",
      when: formatWhen(r.ordered_at),
    },
    {
      key: "arrived",
      label: "Arrived",
      done: rank >= 2,
      active: part === "arrived",
      when: formatWhen(r.arrived_at),
    },
    {
      key: "paperwork",
      label: "Paperwork",
      done: part === "paperwork_signed",
      active: part === "arrived",
      when: formatWhen(r.paperwork_signed_at),
    },
  ];

  return (
    <div className="tool-loan-progress" aria-label="Loan and part progress">
      <ol className="tool-loan-steps tool-loan-steps-5">
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
        <p className="tool-loan-progress-note">
          Part arrived{r.arrived_at ? ` on ${formatWhen(r.arrived_at)}` : ""} — waiting on signed
          loan paperwork.
        </p>
      )}
      {part === "paperwork_signed" && (
        <p className="tool-loan-progress-note is-ready">
          Paperwork signed{r.paperwork_signed_at ? ` on ${formatWhen(r.paperwork_signed_at)}` : ""} —
          loan complete.
        </p>
      )}
      {r.part_note && (
        <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
          Note: {r.part_note}
        </p>
      )}
      {(r.paperwork_note || paperHref) && (
        <div className="tool-loan-paperwork-block">
          {r.paperwork_note ? (
            <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              Paperwork note: {r.paperwork_note}
            </p>
          ) : null}
          {paperHref ? (
            <p style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
              <a href={paperHref} target="_blank" rel="noreferrer" className="tool-loan-paperwork-link">
                View signed loan paperwork
              </a>
            </p>
          ) : part === "paperwork_signed" ? (
            <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              Signed on file (no scan attached)
            </p>
          ) : null}
        </div>
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
  const [partNoteAction, setPartNoteAction] = useState<
    "ordered" | "arrived" | "paperwork_signed"
  >("ordered");
  const [partNote, setPartNote] = useState("");
  const [paperworkFile, setPaperworkFile] = useState<File | null>(null);
  /** null = none selected; number = link existing; "new" = create with tax */
  const [paperworkMode, setPaperworkMode] = useState<"link" | "new" | null>(null);
  const [selectedChargeId, setSelectedChargeId] = useState<number | null>(null);
  /** Other open requests for same employee to bundle onto one charge */
  const [bundleRequestIds, setBundleRequestIds] = useState<number[]>([]);
  const [createPretax, setCreatePretax] = useState("");
  const [createTaxRate, setCreateTaxRate] = useState(String(8.25));
  const [ledgerMatch, setLedgerMatch] = useState<{
    loading: boolean;
    error?: string;
    employee_name?: string;
    request_amount?: number;
    request_item?: string;
    recent_days?: number;
    ledger?: {
      person_id: number | null;
      display_name: string | null;
      balance: number;
      matched: boolean;
    };
    charges?: {
      id: number;
      description: string;
      charge_date: string;
      amount: number;
      amount_match: boolean;
      already_linked?: boolean;
      linked_items?: { id: number; item_name: string; amount: number }[];
    }[];
    bundle_candidates?: {
      id: number;
      item_name: string;
      item_url?: string;
      amount: number;
      part_status: string | null;
    }[];
    tax_defaults?: {
      pretax_amount: number;
      tax_rate: number;
      tax_amount: number;
      total_with_tax: number;
    };
  } | null>(null);
  /** What they already owe on the ledger (before this new request). */
  const [currentBalance, setCurrentBalance] = useState(0);
  const [ledgerPersonName, setLedgerPersonName] = useState<string | null>(null);

  const isOffice = user?.role === "admin" || user?.role === "office";

  const load = useCallback(async () => {
    setError("");
    try {
      const [m, a] = await Promise.all([
        api<{
          requests: ToolLoanRequest[];
          is_approver?: boolean;
          pending_for_me?: number;
          current_balance?: number;
          ledger_person_name?: string | null;
          account_display_name?: string | null;
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
      setCurrentBalance(Math.max(0, Number(m.current_balance) || 0));
      setLedgerPersonName(m.ledger_person_name || null);
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
  const newLoan = Number.isFinite(amountNum) && amountNum > 0 ? amountNum : 0;
  const projectedBalance = Math.round((currentBalance + newLoan) * 100) / 100;
  const estWeekly = newLoan > 0 ? weeklyPaymentEstimate(projectedBalance) : 0;
  const weeksEstimate =
    estWeekly > 0 && projectedBalance > 0
      ? Math.max(1, Math.ceil(projectedBalance / estWeekly - 1e-9))
      : 0;
  /** Current balance only (before any new request) — always show on Home of this page */
  const currentWeeklyOnly = weeklyPaymentEstimate(currentBalance);
  const currentWeeksLeft =
    currentWeeklyOnly > 0 && currentBalance > 0.009
      ? Math.max(1, Math.ceil(currentBalance / currentWeeklyOnly - 1e-9))
      : 0;

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

  function openPartStatus(
    r: ToolLoanRequest,
    action: "ordered" | "arrived" | "paperwork_signed"
  ) {
    setPartNoteId(r.id);
    setPartNoteAction(action);
    setPartNote(
      action === "paperwork_signed" ? r.paperwork_note || "" : r.part_note || ""
    );
    setPaperworkFile(null);
    setSelectedChargeId(null);
    setBundleRequestIds([]);
    setPaperworkMode(null);
    setLedgerMatch(null);
    if (action === "paperwork_signed") {
      setLedgerMatch({ loading: true });
      void (async () => {
        try {
          const data = await api<{
            request: { employee_name: string; amount: number; item_name: string };
            recent_days?: number;
            ledger: {
              person_id: number | null;
              display_name: string | null;
              balance: number;
              matched: boolean;
            };
            charges: {
              id: number;
              description: string;
              charge_date: string;
              amount: number;
              amount_match: boolean;
              already_linked?: boolean;
              linked_items?: { id: number; item_name: string; amount: number }[];
            }[];
            bundle_candidates?: {
              id: number;
              item_name: string;
              item_url?: string;
              amount: number;
              part_status: string | null;
            }[];
            tax_defaults?: {
              pretax_amount: number;
              tax_rate: number;
              tax_amount: number;
              total_with_tax: number;
            };
          }>(`/tool-loans/${r.id}/ledger-match`);
          const td = data.tax_defaults;
          setCreatePretax(
            String(td?.pretax_amount ?? (Number(r.amount) || 0))
          );
          setCreateTaxRate(String(td?.tax_rate ?? 8.25));
          // Prefer charge that already mentions this item, or amount match
          const itemKey = (r.item_name || "").toLowerCase().slice(0, 12);
          const match =
            (data.charges || []).find(
              (c) =>
                itemKey &&
                (c.description || "").toLowerCase().includes(itemKey) &&
                !c.already_linked
            ) ||
            (data.charges || []).find((c) => c.amount_match && !c.already_linked) ||
            (data.charges || []).find((c) => !c.already_linked) ||
            null;
          if (match) {
            setPaperworkMode("link");
            setSelectedChargeId(match.id);
            if (!r.paperwork_note) {
              setPartNote(
                `Linked: ${match.description} · ${moneyFmt(match.amount)} · ${formatWhen(match.charge_date)}`
              );
            }
          } else if (!(data.charges || []).length) {
            setPaperworkMode("new");
          }
          // Pre-check siblings whose names appear in the selected charge description
          const candidates = data.bundle_candidates || [];
          if (match && candidates.length) {
            const desc = (match.description || "").toLowerCase();
            const pre = candidates
              .filter((b) => {
                const words = (b.item_name || "")
                  .toLowerCase()
                  .split(/\s+/)
                  .filter((w) => w.length >= 4);
                return words.some((w) => desc.includes(w));
              })
              .map((b) => b.id);
            setBundleRequestIds(pre);
          }
          setLedgerMatch({
            loading: false,
            employee_name: data.request.employee_name,
            request_amount: data.request.amount,
            request_item: data.request.item_name,
            recent_days: data.recent_days ?? 45,
            ledger: data.ledger,
            charges: data.charges || [],
            bundle_candidates: candidates,
            tax_defaults: data.tax_defaults,
          });
        } catch (err) {
          setLedgerMatch({
            loading: false,
            error: err instanceof Error ? err.message : "Could not load employee loans",
          });
        }
      })();
    }
  }

  function pickLedgerCharge(c: {
    id: number;
    description: string;
    charge_date: string;
    amount: number;
  }) {
    setPaperworkMode("link");
    setSelectedChargeId(c.id);
    setPartNote(
      `Linked: ${c.description} · ${moneyFmt(c.amount)} · ${formatWhen(c.charge_date)}`
    );
  }

  const createTaxPreview = useMemo(() => {
    const pretax = Number(createPretax);
    const rate = Number(createTaxRate);
    if (!(pretax > 0) || !(rate >= 0)) {
      return { pretax: 0, rate: 0, tax: 0, total: 0 };
    }
    const tax = Math.round(pretax * (rate / 100) * 100) / 100;
    const total = Math.round((pretax + tax) * 100) / 100;
    return { pretax, rate, tax, total };
  }, [createPretax, createTaxRate]);

  /** Live amount check for selected charge + bundled items (or new loan + tax). */
  const linkAmountCheck = useMemo((): AmountCheck | null => {
    if (partNoteAction !== "paperwork_signed" || !ledgerMatch || ledgerMatch.loading) {
      return null;
    }
    const taxRate =
      Number(ledgerMatch.tax_defaults?.tax_rate) ||
      Number(createTaxRate) ||
      DEFAULT_TAX_CHECK_RATE;

    if (paperworkMode === "new") {
      if (!(createTaxPreview.total > 0)) {
        return {
          level: "neutral",
          title: "Enter pre-tax and tax %",
          detail: "New payroll loans should include sales tax so the employee pays tax through deductions.",
        };
      }
      if (createTaxPreview.rate <= 0) {
        return {
          level: "warn",
          title: "Tax rate is 0%",
          detail: "Loan paperwork should usually include sales tax. Set tax % (e.g. 8.25) unless this purchase is tax-exempt.",
        };
      }
      return {
        level: "ok",
        title: "New loan includes tax",
        detail: `Will charge ${moneyFmt(createTaxPreview.total)} (pretax ${moneyFmt(createTaxPreview.pretax)} + ${createTaxPreview.rate}% tax).`,
      };
    }

    if (paperworkMode !== "link" || !selectedChargeId) {
      return {
        level: "neutral",
        title: "Select a payroll loan to verify totals",
        detail: "Green = tax looks included · Yellow = check tax / item mix before signing.",
      };
    }

    const charge = (ledgerMatch.charges || []).find((c) => c.id === selectedChargeId);
    if (!charge) return null;

    const base = Number(ledgerMatch.request_amount) || 0;
    const bundled = (ledgerMatch.bundle_candidates || [])
      .filter((b) => bundleRequestIds.includes(b.id))
      .reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const pretaxSum = Math.round((base + bundled) * 100) / 100;

    return assessChargeVsPurchases(Number(charge.amount), pretaxSum, taxRate);
  }, [
    partNoteAction,
    ledgerMatch,
    paperworkMode,
    selectedChargeId,
    bundleRequestIds,
    createTaxPreview,
    createTaxRate,
  ]);

  async function submitPartStatus(e: FormEvent) {
    e.preventDefault();
    if (partNoteId == null) return;
    setActingId(partNoteId);
    setError("");

    let printWin: Window | null = null;
    const willPrintPaperwork =
      partNoteAction === "paperwork_signed" &&
      (paperworkMode === "new" || paperworkMode === "link");

    try {
      if (partNoteAction === "paperwork_signed") {
        if (paperworkMode === "link" && !selectedChargeId) {
          throw new Error("Select a recent ledger loan to link, or choose Create new loan.");
        }
        if (paperworkMode === "new") {
          if (!(createTaxPreview.total > 0)) {
            throw new Error("Enter a pre-tax amount (tax is added automatically).");
          }
        }
        if (paperworkMode !== "link" && paperworkMode !== "new") {
          throw new Error(
            "Link an existing recent loan, or create a new payroll charge with tax."
          );
        }
        // Failsafe: confirm when totals look wrong (missing tax / mismatch)
        if (
          linkAmountCheck &&
          (linkAmountCheck.level === "warn" || linkAmountCheck.level === "bad")
        ) {
          const okContinue = window.confirm(
            `${linkAmountCheck.title}\n\n${linkAmountCheck.detail}\n\nContinue linking anyway?`
          );
          if (!okContinue) {
            setActingId(null);
            return;
          }
        }
      }

      // Open print window NOW (same click, after validation) — browsers block after await
      if (willPrintPaperwork) {
        printWin = window.open("about:blank", "_blank");
        if (printWin == null) {
          setError(
            "Allow pop-ups for this site so the acknowledgment form can print automatically."
          );
        } else {
          try {
            printWin.document.write(
              `<!DOCTYPE html><html><body style="font-family:system-ui;padding:1.5rem">Saving… acknowledgment will print next.</body></html>`
            );
            printWin.document.close();
          } catch {
            /* ignore */
          }
        }
      }

      let paperworkKey: string | null = null;
      if (partNoteAction === "paperwork_signed" && paperworkFile) {
        const fd = new FormData();
        fd.append("file", paperworkFile);
        fd.append("folder", "tool-loan-paperwork");
        const up = await api<{ key: string }>("/uploads/receipt", {
          method: "POST",
          body: fd,
          timeoutMs: 60_000,
        });
        paperworkKey = up.key || null;
      }

      const body: Record<string, unknown> = {
        part_status: partNoteAction,
        note: partNote.trim() || null,
        paperwork_key: paperworkKey,
      };
      if (partNoteAction === "paperwork_signed") {
        if (bundleRequestIds.length) {
          body.also_request_ids = bundleRequestIds;
        }
        if (paperworkMode === "link" && selectedChargeId) {
          body.linked_charge_id = selectedChargeId;
        } else if (paperworkMode === "new") {
          const names = [
            ledgerMatch?.request_item || "Tool purchase",
            ...(ledgerMatch?.bundle_candidates || [])
              .filter((b) => bundleRequestIds.includes(b.id))
              .map((b) => b.item_name),
          ].filter(Boolean);
          body.create_charge = {
            pretax_amount: createTaxPreview.pretax,
            tax_rate: createTaxPreview.rate,
            total_amount: createTaxPreview.total,
            description: names.join(", "),
          };
        }
      }

      const res = await api<{
        ok?: boolean;
        linked_charge_id?: number | null;
      }>(`/tool-loans/${partNoteId}/part-status`, {
        method: "POST",
        body: JSON.stringify(body),
      });

      let msg =
        partNoteAction === "ordered"
          ? "Marked ordered — employee was notified."
          : partNoteAction === "arrived"
            ? "Marked arrived — next: get loan paperwork signed."
            : "Paperwork marked signed — loan complete.";
      if (partNoteAction === "paperwork_signed") {
        const printChargeId =
          paperworkMode === "new"
            ? res.linked_charge_id || null
            : selectedChargeId;
        if (paperworkMode === "new" && res.linked_charge_id) {
          msg = `Paperwork signed · new payroll charge #${res.linked_charge_id} for ${moneyFmt(
            createTaxPreview.total
          )} (includes tax).`;
        } else if (paperworkMode === "link" && selectedChargeId) {
          msg = `Paperwork signed · linked to ledger charge #${selectedChargeId}.`;
        }
        if (paperworkKey) msg += " Scan attached.";
        if (printChargeId) {
          const opened = openChargeAgreementPrint(printChargeId, printWin);
          if (opened) {
            msg += " Print dialog opened.";
          } else if (!printWin) {
            msg += " Allow pop-ups to auto-print the form (or use Form on the charge).";
          }
        } else {
          printWin?.close();
        }
      }
      setOk(msg);
      setPartNoteId(null);
      setPartNote("");
      setPaperworkFile(null);
      setSelectedChargeId(null);
      setBundleRequestIds([]);
      setPaperworkMode(null);
      setLedgerMatch(null);
      await load();
    } catch (err) {
      printWin?.close();
      setError(err instanceof Error ? err.message : "Could not update part status");
    } finally {
      setActingId(null);
    }
  }

  function toggleBundleRequest(rid: number) {
    setBundleRequestIds((prev) =>
      prev.includes(rid) ? prev.filter((x) => x !== rid) : [...prev, rid]
    );
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
      return ps === "pending_order" || ps === "ordered" || ps === "arrived";
    });
  }, [approvals, isOffice]);

  const recentClosed = useMemo(
    () =>
      approvals.filter((r) => {
        if (r.status === "declined" || r.status === "cancelled") return true;
        if (r.status === "approved" && effectivePartStatus(r) === "paperwork_signed") {
          return true;
        }
        return false;
      }),
    [approvals]
  );

  return (
    <div className="page tool-loan-page">
      <div className="page-header">
        <div>
          <h1>Tool loan request</h1>
          <p>
            Request a company tool loan for field work. Office approves, orders the part, marks
            arrival, then confirms signed loan paperwork so nothing slips through.
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

      {/* Always-visible balance — hard to miss, above form/lists */}
      {tab === "mine" && (
        <section
          className={`tool-loan-balance-hero card${currentBalance > 0.009 ? " has-balance" : " is-clear"}`}
          aria-label="Your tool loan balance"
        >
          <div className="tool-loan-balance-hero-label">
            Your tool loan balance
            {ledgerPersonName ? (
              <span className="tool-loan-balance-hero-who"> · {ledgerPersonName}</span>
            ) : null}
          </div>
          <div className="tool-loan-balance-hero-amount">
            {moneyFmt(currentBalance)}
          </div>
          {currentBalance > 0.009 ? (
            <div className="tool-loan-balance-hero-meta">
              <span>
                About <strong>{moneyFmt(currentWeeklyOnly)}</strong> / week from paycheck
              </span>
              {currentWeeksLeft > 0 ? (
                <span>
                  · ~{currentWeeksLeft} week{currentWeeksLeft === 1 ? "" : "s"} left if nothing
                  new is added
                </span>
              ) : null}
            </div>
          ) : (
            <p className="tool-loan-balance-hero-zero muted">
              You don&apos;t currently owe anything on tool loans.
            </p>
          )}
        </section>
      )}

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
              ? ` (${pendingForMe}${
                  needsFulfillment.length ? ` · ${needsFulfillment.length} open` : ""
                })`
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
                Weekly paycheck deduction = <strong>10% of your total balance owed</strong> (what
                you already owe + this new item), with a{" "}
                <strong>${MIN_WEEKLY_PAYMENT} minimum</strong>.
              </li>
              <li>
                Example: <strong>$600 total owed → $60/week</strong>. Under $500 still pays at least $
                {MIN_WEEKLY_PAYMENT}/week.
              </li>
              <li>
                <strong>Higher total balance = higher weekly payment</strong> until paid off. Only
                request what you need for company field work.
              </li>
              <li>
                Total open tool loans must not exceed a typical week’s pay (office has your pay on
                file).
              </li>
            </ul>
          </div>

          {currentBalance > 0.009 && (
            <p className="muted" style={{ marginTop: 0, fontSize: "0.9rem" }}>
              Any new loan adds to the <strong>{moneyFmt(currentBalance)}</strong> you already
              owe — weekly deduction updates below when you enter an amount.
            </p>
          )}

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
            <div
              className="tool-loan-weekly-preview"
              style={{
                margin: "-0.25rem 0 0.75rem",
                padding: "0.75rem 0.9rem",
                borderRadius: "10px",
                background: "rgba(225, 29, 46, 0.08)",
                border: "1px solid rgba(225, 29, 46, 0.2)",
              }}
            >
              <p style={{ margin: 0, fontWeight: 700 }}>
                Your weekly paycheck deduction: {moneyFmt(estWeekly)}
              </p>
              <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.88rem" }}>
                Based on total balance after this request:{" "}
                <strong>{moneyFmt(projectedBalance)}</strong>
                {currentBalance > 0.009
                  ? ` (${moneyFmt(currentBalance)} already owed + ${moneyFmt(newLoan)} new)`
                  : ` (this ${moneyFmt(newLoan)} request)`}
                .
                {estWeekly <= MIN_WEEKLY_PAYMENT + 0.001 && projectedBalance > MIN_WEEKLY_PAYMENT
                  ? ` Minimum ${moneyFmt(MIN_WEEKLY_PAYMENT)}/week applies.`
                  : ` That’s 10% of the total (min ${moneyFmt(MIN_WEEKLY_PAYMENT)}).`}
                {weeksEstimate > 0
                  ? ` About ${weeksEstimate} week${weeksEstimate === 1 ? "" : "s"} if nothing else is added.`
                  : ""}
              </p>
            </div>
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
              I understand my weekly deduction is 10% of my total tool loan balance (minimum $
              {MIN_WEEKLY_PAYMENT}/week), that a larger balance means larger weekly payments, that
              total open loans must not exceed my weekly pay, and that this is for company field
              tools only — not personal spending.
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
            After approval: Ordered → Arrived → Paperwork signed. Attach the signed loan form on
            the last step so you always have proof under the request.
          </p>
          {!needsFulfillment.length ? (
            <div className="card muted">
              No approved loans waiting on order, delivery, or signed paperwork.
            </div>
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
                      className={`form tool-loan-part-form${
                        partNoteAction === "paperwork_signed" ? " is-paperwork" : ""
                      }`}
                      onSubmit={submitPartStatus}
                    >
                      <p className="tool-loan-part-form-title">
                        {partNoteAction === "ordered"
                          ? "Mark ordered"
                          : partNoteAction === "arrived"
                            ? "Mark arrived"
                            : "Paperwork signed"}
                      </p>

                      {partNoteAction === "paperwork_signed" && (
                        <div className="tool-loan-ledger-match" aria-label="Link or create payroll loan">
                          {ledgerMatch?.loading && (
                            <p className="tool-loan-match-status muted">Loading recent loans…</p>
                          )}
                          {ledgerMatch?.error && (
                            <p className="tool-loan-match-status error">{ledgerMatch.error}</p>
                          )}
                          {ledgerMatch && !ledgerMatch.loading && !ledgerMatch.error && (
                            <>
                              <div className="tool-loan-match-bar">
                                <span className="tool-loan-match-who">
                                  <strong>
                                    {ledgerMatch.employee_name || r.employee_name || "Employee"}
                                  </strong>
                                  <span className="muted">
                                    {" "}
                                    · {ledgerMatch.request_item || r.item_name}{" "}
                                    {moneyFmt(Number(ledgerMatch.request_amount ?? r.amount))}
                                  </span>
                                </span>
                                {ledgerMatch.ledger?.matched ? (
                                  <span className="tool-loan-match-bal muted">
                                    Bal {moneyFmt(ledgerMatch.ledger.balance || 0)}
                                    {ledgerMatch.ledger.person_id ? (
                                      <>
                                        {" · "}
                                        <a
                                          href={`/tool-loan-ledger?person=${ledgerMatch.ledger.person_id}`}
                                          target="_blank"
                                          rel="noreferrer"
                                        >
                                          Ledger
                                        </a>
                                      </>
                                    ) : null}
                                  </span>
                                ) : (
                                  <span className="muted">New payroll person if created</span>
                                )}
                              </div>

                              {linkAmountCheck && linkAmountCheck.level !== "neutral" && (
                                <div
                                  className={`tool-loan-amount-check is-${linkAmountCheck.level}`}
                                  role="status"
                                >
                                  <strong>{linkAmountCheck.title}</strong>
                                  {linkAmountCheck.detail ? (
                                    <span>{linkAmountCheck.detail}</span>
                                  ) : null}
                                </div>
                              )}

                              <div className="tool-loan-pick-list" role="radiogroup" aria-label="Link loan">
                                {(ledgerMatch.charges || []).map((c) => {
                                  const title = (c.description || "Loan")
                                    .replace(/^Tool purchase \/ loan:\s*/i, "")
                                    .trim();
                                  const pretaxForRow =
                                    Math.round(
                                      ((Number(ledgerMatch.request_amount) || 0) +
                                        (ledgerMatch.bundle_candidates || [])
                                          .filter((b) => bundleRequestIds.includes(b.id))
                                          .reduce((s, b) => s + (Number(b.amount) || 0), 0)) *
                                        100
                                    ) / 100;
                                  const rowCheck = assessChargeVsPurchases(
                                    Number(c.amount),
                                    pretaxForRow,
                                    Number(ledgerMatch.tax_defaults?.tax_rate) ||
                                      DEFAULT_TAX_CHECK_RATE
                                  );
                                  const tone =
                                    rowCheck.level === "ok"
                                      ? "is-match-ok"
                                      : rowCheck.level === "warn" || rowCheck.level === "bad"
                                        ? "is-match-warn"
                                        : "";
                                  return (
                                    <label
                                      key={c.id}
                                      className={`tool-loan-pick${
                                        paperworkMode === "link" && selectedChargeId === c.id
                                          ? " is-selected"
                                          : ""
                                      } ${tone}`.trim()}
                                    >
                                      <input
                                        type="radio"
                                        className="tool-loan-pick-radio"
                                        name={`ledger-charge-${r.id}`}
                                        checked={
                                          paperworkMode === "link" && selectedChargeId === c.id
                                        }
                                        onChange={() => pickLedgerCharge(c)}
                                      />
                                      <span className="tool-loan-pick-body">
                                        <span className="tool-loan-pick-title" title={title}>
                                          {title || "Loan charge"}
                                        </span>
                                        <span className="tool-loan-pick-meta">
                                          {moneyFmt(c.amount)}
                                          <span aria-hidden>·</span>
                                          {formatWhen(c.charge_date)}
                                          {rowCheck.level === "ok" ? (
                                            <span className="tool-loan-pick-tag">tax ok</span>
                                          ) : null}
                                          {rowCheck.level === "warn" ? (
                                            <span className="tool-loan-pick-tag is-warn">
                                              check tax
                                            </span>
                                          ) : null}
                                          {rowCheck.level === "bad" ? (
                                            <span className="tool-loan-pick-tag is-bad">
                                              mismatch
                                            </span>
                                          ) : null}
                                          {c.already_linked ? (
                                            <span className="tool-loan-pick-tag is-muted">
                                              this item
                                            </span>
                                          ) : null}
                                          {(c.linked_items?.length || 0) > 0 ? (
                                            <span className="tool-loan-pick-tag is-muted">
                                              {c.linked_items!.length} item
                                              {c.linked_items!.length === 1 ? "" : "s"} linked
                                            </span>
                                          ) : null}
                                        </span>
                                      </span>
                                      <a
                                        className="tool-loan-pick-action"
                                        href={`/api/tool-loan-ledger/charges/${c.id}/print-agreement`}
                                        target="_blank"
                                        rel="noreferrer"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        Form
                                      </a>
                                    </label>
                                  );
                                })}

                                <label
                                  className={`tool-loan-pick tool-loan-pick-create${
                                    paperworkMode === "new" ? " is-selected" : ""
                                  }`}
                                >
                                  <input
                                    type="radio"
                                    className="tool-loan-pick-radio"
                                    name={`ledger-charge-${r.id}`}
                                    checked={paperworkMode === "new"}
                                    onChange={() => {
                                      setPaperworkMode("new");
                                      setSelectedChargeId(null);
                                      const item = ledgerMatch.request_item || r.item_name;
                                      const total =
                                        createTaxPreview.total ||
                                        Number(ledgerMatch.tax_defaults?.total_with_tax) ||
                                        0;
                                      setPartNote(
                                        `New payroll loan + tax: ${item} · ${moneyFmt(total)}`
                                      );
                                    }}
                                  />
                                  <span className="tool-loan-pick-body">
                                    <span className="tool-loan-pick-title">
                                      {(ledgerMatch.charges?.length || 0) > 0
                                        ? "Create new loan + tax"
                                        : "Create loan + tax"}
                                    </span>
                                    <span className="tool-loan-pick-meta muted">
                                      Pre-tax + sales tax on payroll
                                    </span>
                                  </span>
                                </label>
                              </div>

                              {(ledgerMatch.bundle_candidates?.length || 0) > 0 && (
                                <div className="tool-loan-bundle">
                                  <p className="tool-loan-bundle-title">
                                    Also include these purchases on the same payroll loan
                                  </p>
                                  <p className="muted tool-loan-bundle-hint">
                                    Use when one charge covers multiple low-amount items (different
                                    product links).
                                  </p>
                                  <ul className="tool-loan-bundle-list">
                                    {ledgerMatch.bundle_candidates!.map((b) => (
                                      <li key={b.id}>
                                        <label className="tool-loan-bundle-item">
                                          <input
                                            type="checkbox"
                                            checked={bundleRequestIds.includes(b.id)}
                                            onChange={() => toggleBundleRequest(b.id)}
                                          />
                                          <span>
                                            <strong>{b.item_name}</strong>
                                            <span className="muted">
                                              {" "}
                                              · {moneyFmt(b.amount)}
                                              {b.part_status ? ` · ${b.part_status}` : ""}
                                            </span>
                                            {b.item_url && isHttpLink(b.item_url) ? (
                                              <>
                                                {" · "}
                                                <a
                                                  href={b.item_url}
                                                  target="_blank"
                                                  rel="noreferrer"
                                                  onClick={(e) => e.stopPropagation()}
                                                >
                                                  link
                                                </a>
                                              </>
                                            ) : null}
                                          </span>
                                        </label>
                                      </li>
                                    ))}
                                  </ul>
                                  {bundleRequestIds.length > 0 ? (
                                    <p className="tool-loan-bundle-sum muted">
                                      This item + {bundleRequestIds.length} more ={" "}
                                      <strong>
                                        {moneyFmt(
                                          Number(r.amount) +
                                            ledgerMatch.bundle_candidates!
                                              .filter((b) => bundleRequestIds.includes(b.id))
                                              .reduce((s, b) => s + Number(b.amount || 0), 0)
                                        )}
                                      </strong>{" "}
                                      request total (payroll charge may already include tax)
                                    </p>
                                  ) : null}
                                </div>
                              )}

                              {paperworkMode === "new" && (
                                <div className="tool-loan-tax-row">
                                  <label>
                                    Pre-tax
                                    <input
                                      type="number"
                                      min="0.01"
                                      step="0.01"
                                      value={createPretax}
                                      onChange={(e) => {
                                        setCreatePretax(e.target.value);
                                        const p = Number(e.target.value);
                                        const rate = Number(createTaxRate) || 0;
                                        if (p > 0) {
                                          const tax = Math.round(p * (rate / 100) * 100) / 100;
                                          const total = Math.round((p + tax) * 100) / 100;
                                          setPartNote(
                                            `New payroll loan + tax: ${
                                              ledgerMatch.request_item || r.item_name
                                            } · ${moneyFmt(total)}`
                                          );
                                        }
                                      }}
                                    />
                                  </label>
                                  <label>
                                    Tax %
                                    <input
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      value={createTaxRate}
                                      onChange={(e) => {
                                        setCreateTaxRate(e.target.value);
                                        const p = Number(createPretax);
                                        const rate = Number(e.target.value) || 0;
                                        if (p > 0) {
                                          const tax = Math.round(p * (rate / 100) * 100) / 100;
                                          const total = Math.round((p + tax) * 100) / 100;
                                          setPartNote(
                                            `New payroll loan + tax: ${
                                              ledgerMatch.request_item || r.item_name
                                            } · ${moneyFmt(total)}`
                                          );
                                        }
                                      }}
                                    />
                                  </label>
                                  <div className="tool-loan-tax-total">
                                    <span className="muted">Tax {moneyFmt(createTaxPreview.tax)}</span>
                                    <strong>Total {moneyFmt(createTaxPreview.total)}</strong>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}

                      {partNoteAction !== "paperwork_signed" ? (
                        <label>
                          Note for employee{" "}
                          <span className="muted">(optional)</span>
                          <input
                            value={partNote}
                            onChange={(e) => setPartNote(e.target.value)}
                            placeholder="e.g. Amazon order #… / front desk"
                          />
                        </label>
                      ) : (
                        <div className="tool-loan-paperwork-extras">
                          <label className="tool-loan-file-label">
                            <span>Signed form</span>
                            <input
                              type="file"
                              accept="image/*,application/pdf"
                              onChange={(e) =>
                                setPaperworkFile(e.target.files?.[0] || null)
                              }
                            />
                            <span className="tool-loan-file-name muted">
                              {paperworkFile ? paperworkFile.name : "Optional photo/PDF"}
                            </span>
                          </label>
                          <details className="tool-loan-note-details">
                            <summary>Note</summary>
                            <input
                              value={partNote}
                              onChange={(e) => setPartNote(e.target.value)}
                              placeholder="Optional note"
                            />
                          </details>
                        </div>
                      )}
                      <div className="toolbar tool-loan-part-actions">
                        <button className="btn btn-sm" type="submit" disabled={actingId === r.id}>
                          {actingId === r.id
                            ? "Saving…"
                            : partNoteAction === "paperwork_signed"
                              ? paperworkMode === "new"
                                ? "Create + print form"
                                : "Link + print form"
                              : "Confirm"}
                        </button>
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          onClick={() => {
                            setPartNoteId(null);
                            setPaperworkFile(null);
                            setLedgerMatch(null);
                            setSelectedChargeId(null);
                            setPaperworkMode(null);
                          }}
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
                      {ps === "arrived" && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => openPartStatus(r, "paperwork_signed")}
                        >
                          Paperwork signed
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
