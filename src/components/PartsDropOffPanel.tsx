import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

type DropoffStatus = "waiting" | "received" | "cancelled";

interface DropoffLine {
  id: number;
  line_no: number;
  part_code: string | null;
  part_name: string | null;
  qty: number;
}

interface Dropoff {
  id: number;
  vendor_name: string;
  part_summary: string;
  for_unit: string | null;
  notes: string | null;
  status: DropoffStatus;
  dropped_by_name?: string | null;
  received_by_name?: string | null;
  received_at?: string | null;
  created_at: string;
  lines?: DropoffLine[];
}

interface PendingPlacement {
  line_id: number;
  ticket_id: number;
  vendor_name: string;
  part_name: string;
  part_code: string | null;
  qty: number;
  resolved_at: string;
  purchase_order: string | null;
  ticket_notes: string | null;
}

/** Goodman 08-06-26  11:05a */
function formatVendorWhen(iso: string): string {
  try {
    const s = String(iso || "").replace("T", " ").trim();
    const datePart = s.slice(0, 10);
    const [y, m, day] = datePart.split("-");
    if (!y || !m || !day) return s.slice(0, 16);
    let hh = Number(s.slice(11, 13));
    const mm = s.slice(14, 16) || "00";
    if (!Number.isFinite(hh)) return `${m}-${day}-${y.slice(2)}`;
    const ampm = hh >= 12 ? "p" : "a";
    hh = hh % 12 || 12;
    return `${m}-${day}-${y.slice(2)}  ${hh}:${mm}${ampm}`;
  } catch {
    return String(iso || "").slice(0, 16);
  }
}

/** "1315 E Johnston Ave - TXV and Motor" for warehouse to label boxes */
function dropoffJobPartLine(d: Dropoff): string {
  const address = (d.for_unit || "").trim();
  let part = "";
  if (d.lines && d.lines.length > 0) {
    part = d.lines
      .map((l) => {
        const name = (l.part_name || l.part_code || "Part").trim();
        return l.qty && l.qty !== 1 ? `${l.qty}× ${name}` : name;
      })
      .join(", ");
  } else {
    part = (d.part_summary || "").trim();
  }
  if (address && part) return `${address} — ${part}`;
  return part || address || "Parts";
}

/**
 * Parts already picked up from a vendor and left at the shop —
 * warehouse sees them as ready to put away / issue to a truck.
 */
export function PartsDropOffPanel({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const canReceive =
    user?.role === "admin" || user?.role === "warehouse" || user?.role === "office";

  const [filter, setFilter] = useState<"waiting" | "all">("waiting");
  const [list, setList] = useState<Dropoff[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [pending, setPending] = useState<PendingPlacement[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [fromPickup, setFromPickup] = useState(false);
  const [pickupTicketId, setPickupTicketId] = useState<number | null>(null);
  const [pickupLineId, setPickupLineId] = useState<number | null>(null);

  const [vendor, setVendor] = useState("");
  const [summary, setSummary] = useState("");
  const [forUnit, setForUnit] = useState("");
  const [notes, setNotes] = useState("");
  const [partSlots, setPartSlots] = useState<{ code: string; name: string; qty: string }[]>([
    { code: "", name: "", qty: "1" },
  ]);

  function startPlacement(opts: {
    vendor: string;
    part: string;
    qty?: string;
    ticketId?: number | null;
    lineId?: number | null;
    address?: string;
    contact?: string;
  }) {
    setVendor(opts.vendor);
    setSummary(opts.part);
    setPartSlots([
      {
        code: "",
        name: opts.part,
        qty: opts.qty || "1",
      },
    ]);
    setNotes("");
    // Job address goes on the drop-off so warehouse can label boxes by address
    setForUnit((opts.address || "").trim());
    setPickupTicketId(opts.ticketId ?? null);
    setPickupLineId(opts.lineId ?? null);
    setFromPickup(true);
    setShowForm(true);
    setOk(
      `Say where you placed the ${opts.vendor} parts (${opts.part}), then save.`
    );
    window.setTimeout(() => {
      document.getElementById("dropoff-form")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
      document.getElementById("dropoff-where-left")?.focus();
    }, 80);
  }

  // Prefill from Part pickup "Picked up" → drop-off handoff
  useEffect(() => {
    const from = searchParams.get("from");
    const v = (searchParams.get("vendor") || "").trim();
    const part = (searchParams.get("part") || "").trim();
    const address = (searchParams.get("address") || "").trim();
    const contact = (searchParams.get("contact") || "").trim();
    const qty = (searchParams.get("qty") || "1").trim() || "1";
    const ticketId = Number(searchParams.get("pickup_id")) || null;
    const lineId = Number(searchParams.get("line_id")) || null;
    if (from !== "pickup" && !v && !part) return;

    startPlacement({
      vendor: v,
      part: part || "Parts from vendor",
      qty,
      ticketId,
      lineId,
      address,
      contact,
    });

    // Clear query so a refresh doesn’t re-apply forever
    const next = new URLSearchParams(searchParams);
    ["from", "vendor", "part", "address", "contact", "qty", "pickup_id", "line_id"].forEach((k) =>
      next.delete(k)
    );
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const defaultSource =
    user?.role === "warehouse"
      ? "warehouse"
      : user?.role === "office"
        ? "office"
        : user?.role === "driver" || user?.role === "mechanic"
          ? "tech"
          : "other";

  const load = useCallback(async () => {
    const [d, p] = await Promise.all([
      api<{
        dropoffs: Dropoff[];
        waiting?: number;
        error?: string;
      }>(`/inventory/parts-dropoffs?status=${filter === "waiting" ? "waiting" : "all"}`),
      api<{ pending?: PendingPlacement[]; count?: number }>(
        "/inventory/parts-dropoffs/pending-placement"
      ).catch(() => ({ pending: [] as PendingPlacement[] })),
    ]);
    setList(d.dropoffs || []);
    setWaiting(d.waiting ?? 0);
    setPending(p.pending || []);
    if (d.error) setError(d.error);
    if ((p.pending || []).length) {
      window.dispatchEvent(new CustomEvent("notifications-changed"));
    }
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [load]);

  /** Group drop-offs by vendor for warehouse labeling (address — part under each store). */
  const vendorGroups = useMemo(() => {
    const map = new Map<
      string,
      { vendor: string; sortKey: string; items: Dropoff[] }
    >();
    for (const d of list) {
      const vendor = (d.vendor_name || "Unknown").trim() || "Unknown";
      const key = vendor.toLowerCase();
      let g = map.get(key);
      if (!g) {
        g = { vendor, sortKey: key, items: [] };
        map.set(key, g);
      }
      g.items.push(d);
    }
    const groups = [...map.values()];
    for (const g of groups) {
      g.items.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    }
    // Vendors ordered by earliest drop-off in the group (run order)
    groups.sort((a, b) => {
      const ta = a.items[0]?.created_at || "";
      const tb = b.items[0]?.created_at || "";
      return String(ta).localeCompare(String(tb));
    });
    return groups;
  }, [list]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (fromPickup && !notes.trim()) {
      setError("Say where you placed the parts (counter, cage, shelf, truck…), then save.");
      return;
    }
    if (fromPickup && !forUnit.trim()) {
      setError("Enter the job address so warehouse can write it on the boxes.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const parts = partSlots
        .map((s) => ({
          part_code: s.code.trim() || null,
          part_name: s.name.trim() || null,
          qty: Number(s.qty) > 0 ? Number(s.qty) : 1,
        }))
        .filter((p) => p.part_code || p.part_name);

      await api("/inventory/parts-dropoffs", {
        method: "POST",
        body: JSON.stringify({
          vendor_name: vendor.trim(),
          part_summary: summary.trim() || null,
          for_unit: forUnit.trim() || null,
          notes: notes.trim() || null,
          parts: parts.length ? parts : undefined,
          source: defaultSource,
          pickup_ticket_id: pickupTicketId,
          pickup_line_id: pickupLineId,
        }),
      });
      setOk("Logged — warehouse can see these parts and where you left them.");
      setVendor("");
      setSummary("");
      setForUnit("");
      setNotes("");
      setPartSlots([{ code: "", name: "", qty: "1" }]);
      setPickupTicketId(null);
      setPickupLineId(null);
      setShowForm(false);
      setFromPickup(false);
      setFilter("waiting");
      await load();
      window.dispatchEvent(new CustomEvent("parts-dropoffs-changed"));
      window.dispatchEvent(new CustomEvent("notifications-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function markReceived(id: number) {
    setActingId(id);
    setError("");
    setOk("");
    try {
      await api(`/inventory/parts-dropoffs/${id}/receive`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOk("Marked received — put away or issue to a truck next.");
      await load();
      window.dispatchEvent(new CustomEvent("parts-dropoffs-changed"));
      const issue = window.confirm(
        "Open Inventory to issue this part to a truck / put it in stock?"
      );
      if (issue) navigate("/inventory");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setActingId(null);
    }
  }

  async function cancelDropoff(id: number) {
    const reason = window.prompt("Why cancel this drop-off? (optional)") ?? "";
    if (reason === null) return;
    setActingId(id);
    setError("");
    try {
      await api(`/inventory/parts-dropoffs/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      setOk("Drop-off cancelled.");
      await load();
      window.dispatchEvent(new CustomEvent("parts-dropoffs-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className={`vendor-run-panel parts-dropoff-panel is-dense${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="page-header vendor-run-page-head">
          <div>
            <h2 style={{ margin: 0 }}>Brought to shop</h2>
            <p className="page-header-sub">
              Record where vendor parts are at the shop ·{" "}
              <Link to="/part-pickup">Still at the store?</Link>
              {pending.length > 0
                ? ` · ${pending.length} pickup${pending.length === 1 ? "" : "s"} need placement`
                : ""}
            </p>
          </div>
          <div className="vendor-run-toolbar">
            <button
              type="button"
              className={`btn btn-sm vendor-waiting-btn${filter === "waiting" ? " primary" : ""}`}
              onClick={() => setFilter("waiting")}
            >
              At shop
              <span className={`vendor-waiting-count${waiting > 0 ? " is-hot" : ""}`}>
                {waiting}
              </span>
            </button>
            <button
              type="button"
              className={`btn ghost btn-sm${filter === "all" ? " primary" : ""}`}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? "Hide form" : "Log drop-off"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {pending.length > 0 && (
        <div className="card parts-place-pending" style={{ marginBottom: "0.85rem" }}>
          <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>
            Need placement ({pending.length})
          </h3>
          <p className="muted" style={{ margin: "0 0 0.65rem", fontSize: "0.88rem" }}>
            You marked these picked up but haven&apos;t said where you left them yet. Tap one to
            finish.
          </p>
          <ul className="parts-place-pending-list" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {pending.map((p) => (
              <li
                key={p.line_id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0.5rem 0",
                  borderTop: "1px solid var(--border, #334155)",
                }}
              >
                <div style={{ minWidth: 0, flex: "1 1 12rem" }}>
                  <strong>{p.vendor_name}</strong>
                  <div className="muted" style={{ fontSize: "0.88rem" }}>
                    {p.qty > 1 ? `${p.qty}× ` : ""}
                    {p.part_name}
                    {p.resolved_at
                      ? ` · picked ${String(p.resolved_at).replace("T", " ").slice(0, 16)}`
                      : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn primary small"
                  onClick={() =>
                    startPlacement({
                      vendor: p.vendor_name,
                      part: p.part_name,
                      qty: String(p.qty || 1),
                      ticketId: p.ticket_id,
                      lineId: p.line_id,
                      address: p.ticket_notes || undefined,
                    })
                  }
                >
                  Where placed?
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showForm && (
        <form
          className={`card form vendor-run-form dense-form${fromPickup ? " parts-dropoff-from-pickup" : ""}`}
          onSubmit={submit}
          id="dropoff-form"
        >
          <h3 className="dense-form-title">
            {fromPickup ? "Where did you place the parts?" : "Log drop-off"}
          </h3>
          {fromPickup && (
            <p className="muted" style={{ margin: "0 0 0.65rem", fontSize: "0.88rem" }}>
              Required: counter, cage, shelf, truck, etc. — so warehouse can find them.
            </p>
          )}
          <div className="dense-form-grid">
            <label>
              Vendor
              <input
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Carrier, Lennox, Solar, ACE…"
                required
                list="parts-dropoff-vendors"
              />
              <datalist id="parts-dropoff-vendors">
                <option value="Carrier" />
                <option value="Lennox" />
                <option value="Solar" />
                <option value="Solar Supply" />
                <option value="ACE" />
                <option value="Johnstone" />
                <option value="Ferguson" />
              </datalist>
            </label>
            <label>
              What&apos;s in the drop-off?
              <input
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="TXV, blower motor, copper…"
              />
            </label>
            <label>
              Job address / unit *
              <input
                value={forUnit}
                onChange={(e) => setForUnit(e.target.value)}
                placeholder="1315 E Johnston Ave"
                required={fromPickup}
              />
            </label>
            <label>
              Where you placed them{fromPickup ? " *" : " "}
              {!fromPickup && <span className="muted">(opt.)</span>}
              <input
                id="dropoff-where-left"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Counter · cage · shelf · truck 12…"
                required={fromPickup}
              />
            </label>
          </div>

          <details className="dense-optional">
            <summary>Part lines (optional)</summary>
            <div className="pp-lines-edit">
              <div className="pp-lines-edit-head">
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  onClick={() =>
                    setPartSlots((p) => [...p, { code: "", name: "", qty: "1" }].slice(0, 20))
                  }
                >
                  + Line
                </button>
              </div>
              {partSlots.map((s, i) => (
                <div key={i} className="pp-line-fields">
                  <input
                    className="pp-code"
                    placeholder="Part #"
                    value={s.code}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPartSlots((prev) =>
                        prev.map((row, j) => (j === i ? { ...row, code: v } : row))
                      );
                    }}
                  />
                  <input
                    className="pp-name"
                    placeholder="Description"
                    value={s.name}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPartSlots((prev) =>
                        prev.map((row, j) => (j === i ? { ...row, name: v } : row))
                      );
                    }}
                  />
                  <input
                    className="pp-qty"
                    type="number"
                    min={0}
                    step="any"
                    title="Qty"
                    value={s.qty}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPartSlots((prev) =>
                        prev.map((row, j) => (j === i ? { ...row, qty: v } : row))
                      );
                    }}
                  />
                </div>
              ))}
            </div>
          </details>

          <div className="toolbar dense-toolbar">
            <button className="btn btn-sm" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Log drop-off at shop"}
            </button>
          </div>
        </form>
      )}

      <div className="vendor-run-list parts-dropoff-list">
        {!list.length ? (
          <div className="card muted dense-empty">
            {filter === "waiting"
              ? "Nothing at the shop yet."
              : "No recent drop-offs."}
          </div>
        ) : (
          vendorGroups.map((g) => {
            const when = formatVendorWhen(g.items[0]?.created_at || "");
            const waitingCount = g.items.filter((d) => d.status === "waiting").length;
            return (
              <section key={g.sortKey} className="card parts-dropoff-vendor-group">
                <header className="parts-dropoff-vendor-head">
                  <h3 className="parts-dropoff-vendor-title">
                    <span className="parts-dropoff-vendor-name">{g.vendor}</span>
                    <span className="parts-dropoff-vendor-when">{when}</span>
                  </h3>
                  {waitingCount > 0 && (
                    <span className="pp-status-pill st-pending">
                      {waitingCount} at shop
                    </span>
                  )}
                </header>
                <ul className="parts-dropoff-job-list">
                  {g.items.map((d) => (
                    <li key={d.id} className={`parts-dropoff-job-row st-${d.status}`}>
                      <div className="parts-dropoff-job-main">
                        <span className="parts-dropoff-job-line">
                          {dropoffJobPartLine(d)}
                        </span>
                        <span className="muted parts-dropoff-job-meta">
                          {d.notes ? `Left: ${d.notes}` : ""}
                          {d.dropped_by_name
                            ? `${d.notes ? " · " : ""}${d.dropped_by_name}`
                            : ""}
                          {d.status === "received" && d.received_by_name
                            ? ` · received ${d.received_by_name}`
                            : ""}
                          {d.status === "cancelled" ? " · cancelled" : ""}
                        </span>
                      </div>
                      {d.status === "waiting" && (
                        <div className="parts-dropoff-actions">
                          {canReceive && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              disabled={actingId === d.id}
                              onClick={() => void markReceived(d.id)}
                            >
                              {actingId === d.id ? "…" : "Received"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn secondary btn-sm"
                            disabled={actingId === d.id}
                            onClick={() => void cancelDropoff(d.id)}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}
