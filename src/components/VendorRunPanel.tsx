import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type LineStatus = "pending" | "picked" | "not_ready" | "partial" | "cancelled";

interface TicketLine {
  id: number;
  line_no: number;
  part_id: number | null;
  part_code: string | null;
  part_name: string | null;
  qty_requested: number;
  qty_received: number | null;
  status: LineStatus;
  notes: string | null;
  resolved_by_name?: string | null;
}

interface Ticket {
  id: number;
  vendor_name: string;
  needed_for_date: string | null;
  purchase_order: string | null;
  notes: string | null;
  qty_unknown: number;
  expected_parts: number | null;
  status: string;
  logged_by_name?: string | null;
  source: string;
  created_at: string;
  line_count?: number;
  open_lines?: number;
  picked_lines?: number;
  lines: TicketLine[];
}

interface VendorGroup {
  vendor_name: string;
  waiting: number;
  tickets: Ticket[];
}

function tomorrowLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const LINE_STATUSES: { value: LineStatus; label: string }[] = [
  { value: "picked", label: "Picked up" },
  { value: "not_ready", label: "Not ready" },
  { value: "partial", label: "Partial" },
  { value: "cancelled", label: "Not needed" },
  { value: "pending", label: "Still pending" },
];

function statusLabel(s: string): string {
  return LINE_STATUSES.find((x) => x.value === s)?.label || s;
}

/**
 * Part pickup tickets: vendor + PO + how many parts → blank lines for part #s.
 * Warehouse marks each line picked / not ready / partial.
 */
export function VendorRunPanel({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  /** Counter actions: pick / not ready / partial */
  const canResolve =
    user?.role === "admin" || user?.role === "warehouse" || user?.role === "office";
  /** Drop a part that is no longer needed (field + warehouse) */
  const canNotNeeded =
    canResolve || user?.role === "driver" || user?.role === "mechanic";

  const [filter, setFilter] = useState<"open" | "all">("open");
  const [groups, setGroups] = useState<VendorGroup[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [vendorNames, setVendorNames] = useState<string[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedTicket, setExpandedTicket] = useState<Record<number, boolean>>({});
  /** Full easy-read run sheet for drivers (will it fit in the truck?) */
  const [showRunSheet, setShowRunSheet] = useState(false);
  const [runSheetFocus, setRunSheetFocus] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  // Create form
  const [vendor, setVendor] = useState("");
  const [needed, setNeeded] = useState(tomorrowLocal);
  const [po, setPo] = useState("");
  const [notes, setNotes] = useState("");
  const [partCount, setPartCount] = useState("1");
  const [qtyUnknown, setQtyUnknown] = useState(false);
  const [partSlots, setPartSlots] = useState<{ code: string; name: string; qty: string }[]>([
    { code: "", name: "", qty: "1" },
  ]);

  const defaultSource = useMemo(() => {
    const r = user?.role;
    if (r === "driver" || r === "mechanic") return "tech";
    if (r === "warehouse") return "warehouse";
    if (r === "office") return "office";
    return "other";
  }, [user?.role]);

  const load = useCallback(async () => {
    const d = await api<{
      vendors: VendorGroup[];
      tickets: Ticket[];
      vendor_names?: string[];
      waiting: number;
      error?: string;
    }>(`/inventory/part-pickups?status=${filter === "open" ? "open" : "all"}`);
    setGroups(d.vendors || []);
    setTickets(d.tickets || []);
    if (d.vendor_names?.length) setVendorNames(d.vendor_names);
    setWaiting(d.waiting || 0);
    if (d.error) setError(d.error);
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [load]);

  useEffect(() => {
    if (qtyUnknown) return;
    const n = Math.min(40, Math.max(1, Math.floor(Number(partCount) || 1)));
    setPartSlots((prev) => {
      if (prev.length === n) return prev;
      if (prev.length < n) {
        return [
          ...prev,
          ...Array.from({ length: n - prev.length }, () => ({
            code: "",
            name: "",
            qty: "1",
          })),
        ];
      }
      return prev.slice(0, n);
    });
  }, [partCount, qtyUnknown]);

  function scrollToList() {
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** Flat vendor → open lines for a glanceable pickup sheet (will it fit?) */
  const runSheet = useMemo(() => {
    return groups
      .filter((g) => g.waiting > 0)
      .map((g) => {
        const lines: Array<{
          key: string;
          lineId: number | null;
          ticketId: number;
          qty: number;
          code: string;
          name: string;
          po: string | null;
          needed: string | null;
          notes: string | null;
          status: string;
        }> = [];
        for (const t of g.tickets) {
          const ticketNote = (t.notes || "").trim() || null;
          for (const l of t.lines || []) {
            if (!["pending", "not_ready", "partial"].includes(l.status)) continue;
            const code = (l.part_code || "").trim();
            const name = (l.part_name || "").trim();
            const lineNote = (l.notes || "").trim();
            lines.push({
              key: `${t.id}-${l.id}`,
              lineId: l.id,
              ticketId: t.id,
              qty: Number(l.qty_requested) || 1,
              code: code || "—",
              name: name || (code ? code : "Part # not filled in yet"),
              po: t.purchase_order,
              needed: t.needed_for_date,
              notes: lineNote || ticketNote,
              status: l.status,
            });
          }
          // Ticket with no lines yet but still waiting
          if (!(t.lines || []).length && (t.status === "open" || t.status === "partial")) {
            const n = t.expected_parts || t.qty_unknown ? "?" : 1;
            lines.push({
              key: `t-${t.id}`,
              lineId: null,
              ticketId: t.id,
              qty: typeof n === "number" ? n : 1,
              code: "—",
              name: t.qty_unknown
                ? "Parts TBD (count unknown)"
                : `${t.expected_parts || "?"} part(s) — numbers not entered yet`,
              po: t.purchase_order,
              needed: t.needed_for_date,
              notes: ticketNote,
              status: "pending",
            });
          }
        }
        // Biggest pieces first — driver scans for bulk/fit first
        lines.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
        const pieceCount = lines.reduce(
          (s, l) => s + (typeof l.qty === "number" && Number.isFinite(l.qty) ? l.qty : 0),
          0
        );
        return {
          vendor_name: g.vendor_name,
          waiting: g.waiting,
          lines,
          pieceCount,
        };
      })
      .filter((g) => g.lines.length > 0 || g.waiting > 0)
      // Busiest stop first
      .sort((a, b) => b.pieceCount - a.pieceCount || a.vendor_name.localeCompare(b.vendor_name));
  }, [groups]);

  const runSheetTotalPieces = useMemo(
    () => runSheet.reduce((s, g) => s + g.pieceCount, 0),
    [runSheet]
  );

  const runSheetVisible = useMemo(() => {
    if (!runSheetFocus) return runSheet;
    return runSheet.filter((g) => g.vendor_name === runSheetFocus);
  }, [runSheet, runSheetFocus]);

  function openRunSheet(vendor?: string) {
    setFilter("open");
    setRunSheetFocus(vendor || null);
    setShowRunSheet(true);
  }

  function closeRunSheet() {
    setShowRunSheet(false);
    setRunSheetFocus(null);
  }

  // Lock body scroll + Esc while run sheet is open
  useEffect(() => {
    if (!showRunSheet) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRunSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [showRunSheet]);

  function openWaitingList() {
    setFilter("open");
    setShowForm(false);
    const next: Record<string, boolean> = {};
    for (const g of groups) next[g.vendor_name] = true;
    setExpanded(next);
    window.setTimeout(scrollToList, 50);
  }

  async function submitTicket(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const parts = qtyUnknown
        ? []
        : partSlots.map((s) => ({
            part_code: s.code.trim() || null,
            part_name: s.name.trim() || null,
            qty_requested: Number(s.qty) > 0 ? Number(s.qty) : 1,
          }));
      await api("/inventory/part-pickups", {
        method: "POST",
        body: JSON.stringify({
          vendor_name: vendor.trim(),
          needed_for_date: needed || tomorrowLocal(),
          purchase_order: po.trim() || null,
          notes: notes.trim() || null,
          qty_unknown: qtyUnknown,
          part_count: qtyUnknown ? undefined : Math.max(1, Math.floor(Number(partCount) || 1)),
          parts,
          source: defaultSource,
        }),
      });
      setOk("Added to part pickup list.");
      setVendor("");
      setPo("");
      setNotes("");
      setPartCount("1");
      setQtyUnknown(false);
      setPartSlots([{ code: "", name: "", qty: "1" }]);
      setShowForm(false);
      await load();
      window.dispatchEvent(new CustomEvent("vendor-runs-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function saveLineDetails(ticketId: number, lines: TicketLine[], drafts: Record<number, { code: string; name: string; qty: string }>) {
    await api(`/inventory/part-pickups/${ticketId}/lines`, {
      method: "PUT",
      body: JSON.stringify({
        lines: lines.map((l) => {
          const d = drafts[l.id];
          return {
            id: l.id,
            part_code: d?.code ?? l.part_code,
            part_name: d?.name ?? l.part_name,
            qty_requested: d?.qty ? Number(d.qty) : l.qty_requested,
          };
        }),
      }),
    });
  }

  async function resolveLine(
    lineId: number,
    status: LineStatus,
    qtyReceived?: number | null,
    notes?: string
  ) {
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api(`/inventory/part-pickups/lines/${lineId}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          status,
          qty_received: qtyReceived ?? null,
          notes: notes || null,
          receive_stock: status === "picked" || status === "partial",
        }),
      });
      setOk(
        status === "picked"
          ? "Marked picked up."
          : status === "not_ready"
            ? "Marked not ready at vendor."
            : status === "partial"
              ? "Marked partial pickup."
              : status === "cancelled"
                ? "Marked not needed — off the pickup list."
                : "Updated."
      );
      await load();
      window.dispatchEvent(new CustomEvent("vendor-runs-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`vendor-run-panel${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="page-header vendor-run-page-head">
          <div>
            <h2 style={{ margin: 0 }}>Part pickup</h2>
            <p style={{ margin: "0.25rem 0 0" }}>
              Log vendor parts. Counter: Picked / Not ready / Partial. Drop a line with{" "}
              <strong>Not needed</strong>.
            </p>
          </div>
          <div className="vendor-run-toolbar">
            <button
              type="button"
              className={`btn btn-sm vendor-waiting-btn${filter === "open" ? " primary" : ""}`}
              onClick={() => openWaitingList()}
            >
              Waiting
              <span className={`vendor-waiting-count${waiting > 0 ? " is-hot" : ""}`}>
                {waiting}
              </span>
            </button>
            <button
              type="button"
              className={`btn ghost btn-sm${filter === "all" ? " primary" : ""}`}
              onClick={() => {
                setFilter("all");
                setShowForm(false);
              }}
            >
              All recent
            </button>
            <button type="button" className="btn ghost btn-sm" onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Hide form" : "Log parts ready"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {/* Stops needed — tap for full easy-read company parts list */}
      {groups.some((g) => g.waiting > 0) && (
        <div className="vendor-run-summary card" aria-label="Vendors with open pickups">
          <button
            type="button"
            className="vendor-run-summary-open"
            onClick={() => openRunSheet()}
          >
            <div className="vendor-run-summary-label">
              Stops needed
              <span className="vendor-run-summary-cta">Tap for company parts list →</span>
            </div>
            <p className="muted vendor-run-summary-sub">
              {runSheet.length} compan{runSheet.length === 1 ? "y" : "ies"}
              {runSheetTotalPieces > 0
                ? ` · ~${runSheetTotalPieces} piece${runSheetTotalPieces === 1 ? "" : "s"}`
                : ""}
              {" "}
              — quick list to check if it fits your vehicle
            </p>
          </button>
          <div className="vendor-run-chips" role="list">
            {runSheet.map((g) => (
              <button
                key={g.vendor_name}
                type="button"
                className={`vendor-run-chip${
                  runSheetFocus === g.vendor_name || expanded[g.vendor_name] ? " is-open" : ""
                }`}
                onClick={() => openRunSheet(g.vendor_name)}
                title={`${g.pieceCount} piece(s) at ${g.vendor_name}`}
              >
                <span className="vendor-run-chip-name">{g.vendor_name}</span>
                <span className="vendor-run-chip-n">
                  {g.pieceCount > 0 ? g.pieceCount : g.waiting}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showRunSheet && (
        <div
          className="vendor-run-sheet-overlay no-print"
          role="dialog"
          aria-modal="true"
          aria-label="Pickup run sheet"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeRunSheet();
          }}
        >
          <div className="vendor-run-sheet card">
            <div className="vendor-run-sheet-head">
              <div>
                <h2 className="vendor-run-sheet-title">What&apos;s being picked up</h2>
                <p className="vendor-run-sheet-sub vendor-run-sheet-hero">
                  <strong>
                    {runSheetFocus
                      ? runSheetVisible[0]?.vendor_name || runSheetFocus
                      : `${runSheet.length} stop${runSheet.length === 1 ? "" : "s"}`}
                  </strong>
                  {runSheetVisible.reduce((s, g) => s + g.pieceCount, 0) > 0 && (
                    <span>
                      {" "}
                      ·{" "}
                      {runSheetVisible.reduce((s, g) => s + g.pieceCount, 0)} piece
                      {runSheetVisible.reduce((s, g) => s + g.pieceCount, 0) === 1 ? "" : "s"}
                    </span>
                  )}
                </p>
                <p className="muted vendor-run-sheet-sub">
                  Qty × part by company — check load before you leave
                </p>
              </div>
              <button type="button" className="btn secondary btn-sm" onClick={closeRunSheet}>
                Close
              </button>
            </div>

            {!runSheet.length ? (
              <p className="muted vendor-run-sheet-empty">Nothing waiting right now.</p>
            ) : (
              <div className="vendor-run-sheet-body">
                {/* Company jump strip — no hunting */}
                {!runSheetFocus && runSheet.length > 1 && (
                  <nav className="vendor-run-sheet-toc" aria-label="Companies">
                    {runSheet.map((g) => (
                      <a
                        key={g.vendor_name}
                        className="vendor-run-sheet-toc-chip"
                        href={`#run-sheet-${encodeURIComponent(g.vendor_name)}`}
                        onClick={(e) => {
                          e.preventDefault();
                          document
                            .getElementById(`run-sheet-${g.vendor_name}`)
                            ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        }}
                      >
                        <span className="vendor-run-sheet-toc-name">{g.vendor_name}</span>
                        <span className="vendor-run-sheet-toc-n">{g.pieceCount || g.lines.length}</span>
                      </a>
                    ))}
                  </nav>
                )}

                {runSheetVisible.map((g) => (
                  <section
                    key={g.vendor_name}
                    id={`run-sheet-${g.vendor_name}`}
                    className="vendor-run-sheet-vendor"
                  >
                    <header className="vendor-run-sheet-vendor-head">
                      <h3>{g.vendor_name}</h3>
                      <span className="vendor-run-sheet-tally">
                        {g.pieceCount > 0
                          ? `${g.pieceCount} pc${g.pieceCount === 1 ? "" : "s"}`
                          : `${g.lines.length} line${g.lines.length === 1 ? "" : "s"}`}
                      </span>
                    </header>
                    <ul className="vendor-run-sheet-parts">
                      {g.lines.map((l) => (
                        <li
                          key={l.key}
                          className={`vendor-run-sheet-part${l.qty >= 3 ? " is-bulk" : ""}`}
                        >
                          <span className="vendor-run-sheet-qty" title="Quantity">
                            {l.qty}×
                          </span>
                          <span className="vendor-run-sheet-detail">
                            <strong className="vendor-run-sheet-name">
                              {l.name || "Part"}
                            </strong>
                            {l.code && l.code !== "—" && l.code !== l.name ? (
                              <span className="vendor-run-sheet-code">{l.code}</span>
                            ) : null}
                            {(l.po || l.needed || l.notes) && (
                              <span className="muted vendor-run-sheet-meta">
                                {[
                                  l.po || null,
                                  l.needed ? `need ${l.needed}` : null,
                                  l.notes,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </span>
                            )}
                            {canNotNeeded && l.lineId != null && (
                              <button
                                type="button"
                                className="btn secondary btn-sm pp-not-needed-btn vendor-run-sheet-drop"
                                disabled={busy}
                                onClick={() => {
                                  const reason = window.prompt(
                                    `Mark as not needed?\n\n${l.qty}× ${l.name || "Part"}\n\nDrops it off the pickup list.\nOptional reason:`,
                                    ""
                                  );
                                  if (reason === null) return;
                                  void resolveLine(
                                    l.lineId!,
                                    "cancelled",
                                    null,
                                    reason.trim() || "Not needed"
                                  );
                                }}
                              >
                                Not needed
                              </button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {runSheetFocus && runSheet.length > 1 && (
                  <button
                    type="button"
                    className="btn ghost btn-sm vendor-run-sheet-show-all"
                    onClick={() => setRunSheetFocus(null)}
                  >
                    Show all companies ({runSheet.length})
                  </button>
                )}
              </div>
            )}

            <div className="vendor-run-sheet-foot">
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  closeRunSheet();
                  if (runSheetFocus) {
                    setExpanded((p) => ({ ...p, [runSheetFocus]: true }));
                  }
                  window.setTimeout(scrollToList, 40);
                }}
              >
                Open full tickets
              </button>
              <button type="button" className="btn" onClick={closeRunSheet}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form className="card vendor-run-form" onSubmit={submitTicket}>
          <p className="muted vendor-run-form-hint">
            Enter vendor and how many different parts. We create one line per part for part numbers.
          </p>
          <div className="vendor-run-form-grid">
            <label>
              Vendor
              <input
                list="vendor-run-vendors"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Gemaire, Johnstone, Lennox…"
                required
              />
              <datalist id="vendor-run-vendors">
                {vendorNames.map((n) => (
                  <option key={n} value={n} />
                ))}
              </datalist>
            </label>
            <label>
              Date needed
              <input type="date" value={needed} onChange={(e) => setNeeded(e.target.value)} />
            </label>
            <label>
              Purchase order / address
              <input
                value={po}
                onChange={(e) => setPo(e.target.value)}
                placeholder="PO # or job address"
              />
            </label>
          </div>

          <label className="pp-qty-unknown">
            <input
              type="checkbox"
              checked={qtyUnknown}
              onChange={(e) => setQtyUnknown(e.target.checked)}
            />
            <span>Don&apos;t know how many parts yet (add lines later)</span>
          </label>

          {!qtyUnknown && (
            <label className="pp-part-count-label">
              How many parts on this ticket?
              <input
                type="number"
                min={1}
                max={40}
                step={1}
                value={partCount}
                onChange={(e) => setPartCount(e.target.value)}
                required
              />
            </label>
          )}

          {!qtyUnknown && partSlots.length > 0 && (
            <div className="pp-part-slots">
              <div className="pp-part-slots-head">
                <span>Part #</span>
                <span>Description</span>
                <span>Qty</span>
              </div>
              {partSlots.map((slot, i) => (
                <div key={i} className="pp-part-slot-row">
                  <span className="pp-line-no">{i + 1}</span>
                  <input
                    placeholder="Part #"
                    value={slot.code}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPartSlots((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, code: v } : r))
                      );
                    }}
                  />
                  <input
                    placeholder="Description"
                    value={slot.name}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPartSlots((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, name: v } : r))
                      );
                    }}
                  />
                  <input
                    type="number"
                    min={0.01}
                    step="any"
                    className="pp-slot-qty"
                    title="Qty for this part"
                    value={slot.qty}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPartSlots((rows) =>
                        rows.map((r, j) => (j === i ? { ...r, qty: v } : r))
                      );
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          <label>
            Notes
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Will-call name, counter, special instructions…"
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add to pickup list"}
          </button>
        </form>
      )}

      <div className="vendor-run-groups" ref={listRef} id="part-pickup-list">
        {!tickets.length && (
          <div className="card muted">
            {filter === "open"
              ? "Nothing waiting. Log parts ready when a vendor calls."
              : "No recent tickets."}
          </div>
        )}

        {groups.map((g) => {
          const isOpen = expanded[g.vendor_name] ?? g.waiting > 0;
          return (
            <section
              key={g.vendor_name}
              className={`card vendor-run-vendor${isOpen ? " is-expanded" : ""}`}
            >
              <button
                type="button"
                className="vendor-run-vendor-toggle"
                aria-expanded={isOpen}
                onClick={() =>
                  setExpanded((p) => ({ ...p, [g.vendor_name]: !isOpen }))
                }
              >
                <span className="vendor-run-vendor-title">
                  <span className="vendor-run-chevron" aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <strong className="vendor-run-vendor-name">{g.vendor_name}</strong>
                  <span className={`vendor-run-count-pill${g.waiting > 0 ? " is-hot" : ""}`}>
                    {g.waiting}
                  </span>
                </span>
                <span className="muted vendor-run-toggle-hint">
                  {g.tickets.length} ticket{g.tickets.length === 1 ? "" : "s"}
                </span>
              </button>

              {isOpen &&
                g.tickets.map((t) => (
                  <TicketCard
                    key={t.id}
                    ticket={t}
                    canResolve={canResolve}
                    canNotNeeded={canNotNeeded}
                    busy={busy}
                    expanded={!!expandedTicket[t.id] || t.status === "open" || t.status === "partial"}
                    onToggle={() =>
                      setExpandedTicket((p) => ({ ...p, [t.id]: !p[t.id] }))
                    }
                    onResolve={resolveLine}
                    onCancelOpen={() => void cancelOpenLinesOnTicket(t)}
                    onSaveDetails={async (drafts) => {
                      setBusy(true);
                      setError("");
                      try {
                        await saveLineDetails(t.id, t.lines, drafts);
                        setOk("Part details saved.");
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Save failed");
                      } finally {
                        setBusy(false);
                      }
                    }}
                    onAddLine={async () => {
                      setBusy(true);
                      try {
                        await api(`/inventory/part-pickups/${t.id}/lines`, {
                          method: "PUT",
                          body: JSON.stringify({ add_lines: 1 }),
                        });
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Could not add line");
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function TicketCard({
  ticket: t,
  canResolve,
  canNotNeeded,
  busy,
  expanded,
  onToggle,
  onResolve,
  onCancelOpen,
  onSaveDetails,
  onAddLine,
}: {
  ticket: Ticket;
  canResolve: boolean;
  canNotNeeded: boolean;
  busy: boolean;
  expanded: boolean;
  onToggle: () => void;
  onResolve: (
    lineId: number,
    status: LineStatus,
    qtyReceived?: number | null,
    notes?: string
  ) => Promise<void>;
  onCancelOpen: () => void;
  onSaveDetails: (
    drafts: Record<number, { code: string; name: string; qty: string }>
  ) => Promise<void>;
  onAddLine: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<number, { code: string; name: string; qty: string }>>(
    () => {
      const d: Record<number, { code: string; name: string; qty: string }> = {};
      for (const l of t.lines) {
        d[l.id] = {
          code: l.part_code || "",
          name: l.part_name || "",
          qty: String(l.qty_requested ?? 1),
        };
      }
      return d;
    }
  );
  const [partialQty, setPartialQty] = useState<Record<number, string>>({});

  useEffect(() => {
    const d: Record<number, { code: string; name: string; qty: string }> = {};
    for (const l of t.lines) {
      d[l.id] = {
        code: l.part_code || "",
        name: l.part_name || "",
        qty: String(l.qty_requested ?? 1),
      };
    }
    setDrafts(d);
  }, [t.lines]);

  const openCount = t.lines.filter((l) =>
    ["pending", "not_ready", "partial"].includes(l.status)
  ).length;

  return (
    <div className="pp-ticket">
      <button type="button" className="pp-ticket-head" onClick={onToggle}>
        <span>
          <strong>
            {t.purchase_order || "No PO / address"}
          </strong>
          <span className="muted pp-ticket-meta">
            {" "}
            · need {t.needed_for_date || "—"}
            {t.qty_unknown ? " · qty TBD" : ` · ${t.lines.length || t.expected_parts || "?"} parts`}
            {t.logged_by_name ? ` · ${t.logged_by_name}` : ""}
          </span>
        </span>
        <span className={`pp-ticket-badge st-${t.status}`}>
          {t.status}
          {openCount > 0 ? ` · ${openCount} open` : ""}
        </span>
      </button>

      {expanded && (
        <div className="pp-ticket-body">
          {canNotNeeded && openCount > 0 && (
            <p className="pp-not-needed-hint">
              Part no longer needed? Use the red-tinted <strong>Not needed</strong> button on that
              line (or all open parts below).
            </p>
          )}
          {t.notes ? <p className="muted pp-ticket-notes">{t.notes}</p> : null}

          {!t.lines.length && (
            <p className="muted">
              No part lines yet.
              {canResolve || true ? (
                <button type="button" className="btn ghost btn-sm" disabled={busy} onClick={() => void onAddLine()}>
                  Add a part line
                </button>
              ) : null}
            </p>
          )}

          <ul className="pp-lines">
            {t.lines.map((line) => {
              const d = drafts[line.id] || { code: "", name: "", qty: "1" };
              const needsDetail = !line.part_code && !line.part_name;
              return (
                <li key={line.id} className={`pp-line st-${line.status}`}>
                  <div className="pp-line-num">#{line.line_no}</div>
                  <div className="pp-line-fields">
                    <input
                      className="pp-code"
                      placeholder="Part #"
                      value={d.code}
                      disabled={line.status === "picked" || line.status === "cancelled"}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [line.id]: { ...d, code: e.target.value },
                        }))
                      }
                    />
                    <input
                      className="pp-name"
                      placeholder={needsDetail ? "Part description" : "Description"}
                      value={d.name}
                      disabled={line.status === "picked" || line.status === "cancelled"}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [line.id]: { ...d, name: e.target.value },
                        }))
                      }
                    />
                    <input
                      className="pp-qty"
                      type="number"
                      min={0}
                      step="any"
                      title="Qty requested"
                      value={d.qty}
                      disabled={line.status === "picked" || line.status === "cancelled"}
                      onChange={(e) =>
                        setDrafts((prev) => ({
                          ...prev,
                          [line.id]: { ...d, qty: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="pp-line-status">
                    <span className={`pp-status-pill st-${line.status}`}>
                      {statusLabel(line.status)}
                      {line.qty_received != null ? ` · got ${line.qty_received}` : ""}
                    </span>
                  </div>
                  {line.status !== "picked" && line.status !== "cancelled" && (
                    <div className="pp-line-actions">
                      {canResolve && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy}
                            onClick={() => void onResolve(line.id, "picked")}
                          >
                            Picked up
                          </button>
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            disabled={busy}
                            onClick={() => void onResolve(line.id, "not_ready")}
                          >
                            Not ready
                          </button>
                          <span className="pp-partial">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              placeholder="Got #"
                              className="pp-partial-qty"
                              value={partialQty[line.id] || ""}
                              onChange={(e) =>
                                setPartialQty((p) => ({ ...p, [line.id]: e.target.value }))
                              }
                            />
                            <button
                              type="button"
                              className="btn ghost btn-sm"
                              disabled={busy || !partialQty[line.id]}
                              onClick={() =>
                                void onResolve(line.id, "partial", Number(partialQty[line.id]))
                              }
                            >
                              Partial
                            </button>
                          </span>
                        </>
                      )}
                      {canNotNeeded && (
                        <button
                          type="button"
                          className="btn secondary btn-sm pp-not-needed-btn"
                          disabled={busy}
                          title="Order cancelled, wrong part, or job no longer needs this"
                          onClick={() => {
                            const label =
                              (drafts[line.id]?.name || line.part_name || "").trim() ||
                              (drafts[line.id]?.code || line.part_code || "").trim() ||
                              `Line #${line.line_no}`;
                            const reason = window.prompt(
                              `Mark as not needed?\n\n${label}\n\nThis drops it off the pickup list.\nOptional reason:`,
                              ""
                            );
                            if (reason === null) return;
                            void onResolve(
                              line.id,
                              "cancelled",
                              null,
                              reason.trim() || "Not needed"
                            );
                          }}
                        >
                          Not needed
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="pp-ticket-actions">
            {canResolve && (
              <>
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  disabled={busy}
                  onClick={() => void onSaveDetails(drafts)}
                >
                  Save part details
                </button>
                <button
                  type="button"
                  className="btn ghost btn-sm"
                  disabled={busy}
                  onClick={() => void onAddLine()}
                >
                  + Part line
                </button>
              </>
            )}
            {canNotNeeded && openCount > 0 && (
              <button
                type="button"
                className="btn ghost btn-sm pp-not-needed-btn"
                disabled={busy}
                onClick={onCancelOpen}
              >
                Not needed — all open parts
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
