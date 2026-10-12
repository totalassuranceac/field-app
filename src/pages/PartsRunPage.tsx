import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type RunStatus = "requested" | "en_route" | "delivered" | "cancelled";

interface PartsRun {
  id: number;
  user_id: number;
  vehicle_id: number | null;
  vehicle_label: string | null;
  job_address: string | null;
  part_needed: string;
  reason_code: string;
  reason_detail: string;
  status: RunStatus | string;
  delivery_notes: string | null;
  created_at: string;
  delivered_at: string | null;
  employee_name?: string | null;
  delivered_by_name?: string | null;
  vehicle_unit?: string | null;
  lines?: PartsRunLine[];
  inventory_transferred?: number;
}

interface PartsRunLine {
  id: number;
  part_id: number | null;
  part_code: string | null;
  part_name: string;
  qty: number;
  transferred: number;
  transfer_note: string | null;
  warehouse_qty?: number | null;
}

interface PartHit {
  id: number;
  code: string;
  name: string;
  warehouse_qty?: number | null;
}

interface InventoryResult {
  transferred: number;
  blocked?: { part: string; have: number; need: number }[];
  errors?: string[];
}

interface SummaryRow {
  user_id: number;
  employee_name: string;
  request_count: number;
  delivered_count: number;
  last_request_at: string | null;
}

interface MyStats {
  total: number;
  last_30: number;
  last_90: number;
  open_count: number;
}

function statusLabel(s: string): string {
  if (s === "requested") return "Requested";
  if (s === "en_route") return "On the way";
  if (s === "delivered") return "Delivered";
  if (s === "cancelled") return "Cancelled";
  return s;
}

function statusClass(s: string): string {
  if (s === "requested") return "need";
  if (s === "en_route") return "going";
  if (s === "delivered") return "done";
  return "closed";
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

function PartsRunLines(props: {
  run: PartsRun;
  canEdit: boolean;
  busy: boolean;
  onAdd: (partId: number, qty: number) => void;
  onRemove: (lineId: number) => void;
}) {
  const { run, canEdit, busy, onAdd, onRemove } = props;
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PartHit[]>([]);
  const [qty, setQty] = useState("1");
  const [pick, setPick] = useState<PartHit | null>(null);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setHits([]);
      return;
    }
    let cancel = false;
    const timer = window.setTimeout(() => {
      void api<{ parts: PartHit[] }>(`/parts-runs/part-search?q=${encodeURIComponent(text)}`)
        .then((d) => {
          if (!cancel) setHits(d.parts || []);
        })
        .catch(() => {
          if (!cancel) setHits([]);
        });
    }, 250);
    return () => {
      cancel = true;
      window.clearTimeout(timer);
    };
  }, [q]);

  const lines = run.lines || [];
  return (
    <div className="parts-run-lines">
      {lines.length > 0 && (
        <ul className="parts-run-line-list">
          {lines.map((line) => (
            <li key={line.id}>
              <span>
                {line.part_code ? `${line.part_code} ` : ""}
                {line.part_name} × {line.qty}
                {line.part_id != null && (
                  <span className="muted"> Warehouse: {line.warehouse_qty ?? 0}</span>
                )}
                {line.transfer_note ? <span className="parts-run-line-note"> {line.transfer_note}</span> : null}
              </span>
              {canEdit && (
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  disabled={busy}
                  onClick={() => onRemove(line.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="parts-run-line-add">
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPick(null);
            }}
            placeholder="Search the catalog"
            aria-label="Search catalog parts"
          />
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="decimal"
            aria-label="Quantity"
            style={{ width: "4.5rem" }}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !pick}
            onClick={() => {
              const n = Number(qty);
              if (!pick || !(n > 0) || n > 999) return;
              onAdd(pick.id, n);
              setQ("");
              setPick(null);
              setHits([]);
              setQty("1");
            }}
          >
            Add line
          </button>
          {hits.length > 0 && !pick && (
            <ul className="parts-run-part-hits">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    onClick={() => {
                      setPick(hit);
                      setQ(`${hit.code} ${hit.name}`);
                      setHits([]);
                    }}
                  >
                    {hit.code} {hit.name}
                    <span className="muted"> Warehouse: {hit.warehouse_qty ?? 0}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Warehouse delivery request — three simple fields:
 * what they need, why it wasn’t on the truck, delivery address.
 */
export function PartsRunPage() {
  const { user } = useAuth();
  const isDispatcher =
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "warehouse" ||
    user?.role === "mechanic";
  const canReport = isDispatcher || user?.role === "viewer";

  const [tab, setTab] = useState<"request" | "mine" | "open" | "report">(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "open" || t === "mine" || t === "report" || t === "request") return t;
    return "request";
  });
  const [tabPicked, setTabPicked] = useState(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "open" || t === "mine" || t === "report" || t === "request";
  });
  const [mine, setMine] = useState<PartsRun[]>([]);
  const [open, setOpen] = useState<PartsRun[]>([]);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [reportLog, setReportLog] = useState<PartsRun[]>([]);
  const [stats, setStats] = useState<MyStats>({
    total: 0,
    last_30: 0,
    last_90: 0,
    open_count: 0,
  });
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);
  const [stockMovesOn, setStockMovesOn] = useState(false);
  const [deliverFor, setDeliverFor] = useState<number | null>(null);
  const [skipMove, setSkipMove] = useState(false);

  const [partNeeded, setPartNeeded] = useState("");
  const [whyNotOnTruck, setWhyNotOnTruck] = useState("");
  const [jobAddress, setJobAddress] = useState(
    () => new URLSearchParams(window.location.search).get("address") || ""
  );

  const loadMine = useCallback(async () => {
    const d = await api<{
      requests: PartsRun[];
      stats: MyStats;
    } & { stock_moves_enabled?: boolean }>("/parts-runs?view=mine");
    setMine(d.requests || []);
    if (d.stats) setStats(d.stats);
    if (typeof d.stock_moves_enabled === "boolean") setStockMovesOn(d.stock_moves_enabled);
  }, []);

  const loadOpen = useCallback(async () => {
    if (!isDispatcher && user?.role !== "viewer") return;
    const d = await api<{ requests: PartsRun[]; stock_moves_enabled?: boolean }>("/parts-runs?view=open");
    setOpen(d.requests || []);
    if (typeof d.stock_moves_enabled === "boolean") setStockMovesOn(d.stock_moves_enabled);
  }, [isDispatcher, user?.role]);

  const loadReport = useCallback(async () => {
    if (!canReport) return;
    const d = await api<{
      summary: SummaryRow[];
      requests: PartsRun[];
    }>("/parts-runs?view=report&days=90");
    setSummary(d.summary || []);
    setReportLog(d.requests || []);
  }, [canReport]);

  const canSeeOpen = isDispatcher || user?.role === "viewer";

  const refresh = useCallback(async () => {
    setError("");
    try {
      await loadMine();
      if (canSeeOpen) await loadOpen();
      if (tab === "report") await loadReport();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, [loadMine, loadOpen, loadReport, tab, canSeeOpen]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (tabPicked || !canSeeOpen) return;
    if (open.length > 0) setTab("open");
  }, [open.length, tabPicked, canSeeOpen]);

  function chooseTab(next: "request" | "mine" | "open" | "report") {
    setTabPicked(true);
    setTab(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const need = partNeeded.trim();
      const why = whyNotOnTruck.trim();
      const addr = jobAddress.trim();
      if (need.length < 3) throw new Error("Describe what you need delivered.");
      if (why.length < 5) throw new Error("Say why it wasn’t already on the truck.");
      if (addr.length < 5) throw new Error("Enter the address where the parts need to go.");

      await api("/parts-runs", {
        method: "POST",
        body: JSON.stringify({
          part_needed: need,
          reason_detail: why,
          job_address: addr,
        }),
      });
      setOk("Request sent — warehouse / shop will see it.");
      setPartNeeded("");
      setWhyNotOnTruck("");
      setJobAddress("");
      setTab("mine");
      await loadMine();
      if (isDispatcher) await loadOpen();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit");
    } finally {
      setBusy(false);
    }
  }

  function inventorySentence(inv: InventoryResult | null | undefined, fallback: string): string {
    if (!inv) return fallback;
    const blocked = inv.blocked || [];
    const bits = [`Moved ${inv.transferred}.`];
    if (blocked.length) {
      const b = blocked[0];
      bits.push(
        `Short: ${blocked.length} (warehouse shows ${b.have}, needs ${b.need}). Fix the count, then Retry move.`
      );
    }
    if (inv.errors && inv.errors.length) bits.push(inv.errors[0]);
    return bits.join(" ");
  }

  async function setStatus(id: number, status: RunStatus, transfer = false) {
    setActingId(id);
    setError("");
    try {
      const res = await api<{ inventory?: InventoryResult | null }>(`/parts-runs/${id}/status`, {
        method: "POST",
        body: JSON.stringify({
          status,
          transfer_inventory: status === "delivered" ? transfer : false,
        }),
      });
      setDeliverFor(null);
      setOk(
        status === "en_route"
          ? "Marked on the way."
          : status === "delivered"
            ? inventorySentence(res.inventory, "Marked delivered.")
            : status === "cancelled"
              ? "Cancelled."
              : "Updated."
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setActingId(null);
    }
  }

  async function retryMove(id: number) {
    setActingId(id);
    setError("");
    try {
      const res = await api<{ inventory?: InventoryResult }>(`/parts-runs/${id}/retry-move`, {
        method: "POST",
        body: "{}",
      });
      setOk(inventorySentence(res.inventory, "Retry finished."));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setActingId(null);
    }
  }

  async function addLine(runId: number, partId: number, qty: number) {
    setActingId(runId);
    setError("");
    try {
      await api(`/parts-runs/${runId}/lines`, {
        method: "POST",
        body: JSON.stringify({ part_id: partId, qty }),
      });
      setOk("Line added.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the line");
    } finally {
      setActingId(null);
    }
  }

  async function removeLine(runId: number, lineId: number) {
    setActingId(runId);
    setError("");
    try {
      await api(`/parts-runs/${runId}/lines/${lineId}`, { method: "DELETE" });
      setOk("Line removed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove the line");
    } finally {
      setActingId(null);
    }
  }

  function renderCard(r: PartsRun, opts?: { showEmployee?: boolean }) {
    const unmoved = (r.lines || []).filter((line) => line.part_id && !line.transferred).length;
    return (
      <article key={r.id} className={`card parts-run-card st-${statusClass(r.status)}`}>
        <div className="parts-run-card-head">
          <strong>
            {opts?.showEmployee && r.employee_name ? `${r.employee_name} · ` : ""}
            {r.part_needed}
          </strong>
          <span className={`parts-run-status st-${statusClass(r.status)}`}>
            {statusLabel(r.status)}
          </span>
        </div>
        <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.88rem" }}>
          {formatWhen(r.created_at)}
          {r.job_address ? ` · ${r.job_address}` : ""}
        </p>
        {r.reason_detail && (
          <p className="parts-run-detail" style={{ marginTop: "0.4rem" }}>
            <strong>Why not on truck:</strong> {r.reason_detail}
          </p>
        )}
        {r.delivered_by_name && (
          <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.82rem" }}>
            Delivered by {r.delivered_by_name}
            {r.delivered_at ? ` · ${formatWhen(r.delivered_at)}` : ""}
          </p>
        )}
        <PartsRunLines
          run={r}
          canEdit={
            (r.status === "requested" || r.status === "en_route") &&
            (isDispatcher || user?.id === r.user_id)
          }
          busy={actingId === r.id}
          onAdd={(partId, qty) => void addLine(r.id, partId, qty)}
          onRemove={(lineId) => void removeLine(r.id, lineId)}
        />
        {(r.status === "requested" || r.status === "en_route") && (
          <div className="toolbar" style={{ marginTop: "0.5rem" }}>
            {opts?.showEmployee && isDispatcher && r.status === "requested" && (
              <button
                type="button"
                className="btn btn-sm"
                disabled={actingId === r.id}
                onClick={() => void setStatus(r.id, "en_route")}
              >
                On the way
              </button>
            )}
            {opts?.showEmployee &&
              isDispatcher &&
              (r.status === "requested" || r.status === "en_route") && (
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  disabled={actingId === r.id}
                  onClick={() => {
                    if (stockMovesOn && unmoved > 0) {
                      setSkipMove(false);
                      setDeliverFor(r.id);
                    } else {
                      void setStatus(r.id, "delivered", false);
                    }
                  }}
                >
                  Delivered
                </button>
              )}
            <button
              type="button"
              className="btn secondary btn-sm"
              disabled={actingId === r.id}
              onClick={() => {
                if (window.confirm("Cancel this delivery request?")) {
                  void setStatus(r.id, "cancelled");
                }
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {deliverFor === r.id && (
          <div className="parts-run-deliver-confirm">
            <p>
              Moves {unmoved} {unmoved === 1 ? "part" : "parts"} from Warehouse
              {r.vehicle_unit ? ` to Unit ${r.vehicle_unit}` : ""}. Counts update in the Field App only
              (not ServiceTitan).
            </p>
            <label>
              <input
                type="checkbox"
                checked={skipMove}
                onChange={(e) => setSkipMove(e.target.checked)}
              />{" "}
              Don't move stock this time
            </label>
            <div className="toolbar">
              <button
                type="button"
                className="btn btn-sm"
                disabled={actingId === r.id}
                onClick={() => void setStatus(r.id, "delivered", !skipMove)}
              >
                Confirm delivered
              </button>
              <button type="button" className="btn secondary btn-sm" onClick={() => setDeliverFor(null)}>
                Back
              </button>
            </div>
          </div>
        )}
        {isDispatcher &&
          r.status === "delivered" &&
          (r.lines || []).some((line) => line.part_id && !line.transferred) && (
            <div className="toolbar" style={{ marginTop: "0.5rem" }}>
              <button
                type="button"
                className="btn btn-sm"
                disabled={actingId === r.id}
                onClick={() => void retryMove(r.id)}
              >
                Retry move
              </button>
            </div>
          )}
      </article>
    );
  }

  return (
    <div className="page parts-run-page">
      <div className="page-header">
        <div>
          <h1>Deliver to job</h1>
          <p>
            Need the warehouse to bring something out to a job? Tell us what you need, why it
            wasn’t on the truck, and the address.
          </p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <div className="parts-run-stats card">
        <div className="parts-run-stat">
          <span className="parts-run-stat-n">{stats.last_30}</span>
          <span className="parts-run-stat-l">Last 30 days</span>
        </div>
        <div className="parts-run-stat">
          <span className="parts-run-stat-n">{stats.last_90}</span>
          <span className="parts-run-stat-l">Last 90 days</span>
        </div>
        <div className="parts-run-stat">
          <span className="parts-run-stat-n">{stats.total}</span>
          <span className="parts-run-stat-l">All time</span>
        </div>
        {stats.open_count > 0 && (
          <div className="parts-run-stat">
            <span className="parts-run-stat-n">{stats.open_count}</span>
            <span className="parts-run-stat-l">Open now</span>
          </div>
        )}
      </div>

      <div className="filters no-print" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={`chip ${tab === "request" ? "active" : ""}`}
          onClick={() => chooseTab("request")}
        >
          New request
        </button>
        <button
          type="button"
          className={`chip ${tab === "mine" ? "active" : ""}`}
          onClick={() => chooseTab("mine")}
        >
          My log
        </button>
        {(isDispatcher || user?.role === "viewer") && (
          <button
            type="button"
            className={`chip ${tab === "open" ? "active" : ""}`}
            onClick={() => chooseTab("open")}
          >
            Open runs ({open.length})
          </button>
        )}
        {canReport && (
          <button
            type="button"
            className={`chip ${tab === "report" ? "active" : ""}`}
            onClick={() => chooseTab("report")}
          >
            Team log
          </button>
        )}
      </div>

      {tab === "request" && (
        <form className="card form parts-run-form" onSubmit={submit}>
          <h2 style={{ marginTop: 0 }}>New delivery request</h2>

          <label>
            What do you need? *
            <textarea
              value={partNeeded}
              onChange={(e) => setPartNeeded(e.target.value)}
              required
              rows={3}
              minLength={3}
              placeholder="Describe the part(s) or materials — e.g. 3/4&quot; TXV, 50 ft 3/8&quot; copper, contactor for outdoor unit…"
              autoFocus
            />
          </label>

          <label>
            Why wasn’t it on the truck? *
            <textarea
              value={whyNotOnTruck}
              onChange={(e) => setWhyNotOnTruck(e.target.value)}
              required
              rows={2}
              minLength={5}
              placeholder="e.g. Used the last one yesterday, job expanded, left shop in a hurry…"
            />
          </label>

          <label>
            Address / where it needs to go *
            <input
              value={jobAddress}
              onChange={(e) => setJobAddress(e.target.value)}
              required
              minLength={5}
              placeholder="Job site address or clear meetup location"
              autoComplete="street-address"
            />
          </label>

          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Submit request"}
            </button>
          </div>
        </form>
      )}

      {tab === "mine" && (
        <section className="parts-run-list">
          {!mine.length ? (
            <div className="card muted">No delivery requests yet.</div>
          ) : (
            mine.map((r) => renderCard(r))
          )}
        </section>
      )}

      {tab === "open" && (isDispatcher || user?.role === "viewer") && (
        <section className="parts-run-list">
          <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
            Active delivery requests — mark on the way / delivered when you leave.
          </p>
          {!open.length ? (
            <div className="card muted">No open delivery requests.</div>
          ) : (
            open.map((r) => renderCard(r, { showEmployee: true }))
          )}
        </section>
      )}

      {tab === "report" && canReport && (
        <section className="parts-run-report">
          <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
            Last 90 days — who needed deliveries most often (for stock planning).
          </p>

          <h2 className="parts-run-section-title">By person</h2>
          {!summary.length ? (
            <div className="card muted">No delivery requests in this period.</div>
          ) : (
            <div className="parts-run-summary-table card">
              <div className="parts-run-summary-row head">
                <span>Employee</span>
                <span>Requests</span>
                <span>Delivered</span>
                <span>Last</span>
              </div>
              {summary.map((s) => (
                <div key={s.user_id} className="parts-run-summary-row">
                  <span>
                    <strong>{s.employee_name}</strong>
                    {s.user_id === user?.id ? <span className="muted"> (you)</span> : null}
                  </span>
                  <span className="parts-run-count">{s.request_count}</span>
                  <span className="muted">{s.delivered_count}</span>
                  <span className="muted" style={{ fontSize: "0.8rem" }}>
                    {formatWhen(s.last_request_at)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <h2 className="parts-run-section-title" style={{ marginTop: "1.25rem" }}>
            Recent requests
          </h2>
          <div className="parts-run-list">
            {reportLog.slice(0, 40).map((r) => (
              <article key={r.id} className={`card parts-run-card st-${statusClass(r.status)}`}>
                <div className="parts-run-card-head">
                  <strong>
                    {r.employee_name} · {r.part_needed}
                  </strong>
                  <span className={`parts-run-status st-${statusClass(r.status)}`}>
                    {statusLabel(r.status)}
                  </span>
                </div>
                <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                  {formatWhen(r.created_at)}
                  {r.job_address ? ` · ${r.job_address}` : ""}
                </p>
                {r.reason_detail && <p className="parts-run-detail">{r.reason_detail}</p>}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
