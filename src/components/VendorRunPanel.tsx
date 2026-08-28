import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
  resolved_at?: string | null;
  resolved_by_user_id?: number | null;
  resolved_by_name?: string | null;
}

interface Ticket {
  id: number;
  vendor_name: string;
  needed_for_date: string | null;
  /** Contact person (who to ask about the part) for simple tickets */
  purchase_order: string | null;
  notes: string | null;
  qty_unknown: number;
  expected_parts: number | null;
  status: string;
  logged_by_user_id?: number | null;
  logged_by_name?: string | null;
  source: string;
  created_at: string;
  line_count?: number;
  open_lines?: number;
  picked_lines?: number;
  /** Server: ready for warehouse run today (needed_for_date is null or ≤ today) */
  ready_to_pick?: boolean;
  lines: TicketLine[];
}

function localTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isTicketReadyToPick(t: { needed_for_date?: string | null; ready_to_pick?: boolean }): boolean {
  if (typeof t.ready_to_pick === "boolean") return t.ready_to_pick;
  const needed = (t.needed_for_date || "").trim();
  if (!needed) return true;
  return needed <= localTodayIso();
}

function formatReadyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.includes("T") ? iso : `${iso}T12:00:00`);
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

/** Compact local-looking stamp for audit rows (DB stores "YYYY-MM-DD HH:MM:SS"). */
function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = String(iso).replace("T", " ").slice(0, 16);
  try {
    const d = new Date(s.includes(" ") ? s.replace(" ", "T") : s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return s;
  }
}

interface StaffOption {
  /** user id if from users list; otherwise 0 for employee-only */
  id: number;
  display_name: string;
  role?: string;
}

interface VendorGroup {
  vendor_name: string;
  waiting: number;
  tickets: Ticket[];
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

/** Required reason when dropping a part from the pickup list. */
function askNotNeededReason(label: string): string | null {
  let draft = "";
  for (;;) {
    const raw = window.prompt(
      `Why is this not needed?\n\n${label}\n\nRequired — e.g. job cancelled, wrong part, ordered by mistake`,
      draft
    );
    if (raw === null) return null;
    const reason = raw.trim();
    if (reason.length >= 3) return reason;
    window.alert("Please type a short reason (at least a few words).");
    draft = raw;
  }
}

/**
 * Part pickup request: vendor + part description + address + ready date.
 * Owner / office / warehouse can edit description anytime while open.
 * Future ready dates stay on the list but off the driver's today run sheet.
 */
export function VendorRunPanel({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const focusTicketId = Number(searchParams.get("ticket") || "") || null;
  /** Counter actions: pick / not ready / partial */
  const canResolve =
    user?.role === "admin" ||
    user?.role === "warehouse" ||
    user?.role === "office" ||
    user?.role === "mechanic" ||
    user?.role === "supervisor";
  /** Drop a part that is no longer needed (field + warehouse) */
  const canNotNeeded =
    canResolve || user?.role === "driver" || user?.role === "mechanic";

  const [filter, setFilter] = useState<"open" | "history" | "all">("open");
  const [groups, setGroups] = useState<VendorGroup[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [waiting, setWaiting] = useState(0);
  const [readyToday, setReadyToday] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  /** Which line is mid-resolve — only that button disables (not the whole page). */
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedTicket, setExpandedTicket] = useState<Record<number, boolean>>({});
  /** Full easy-read run sheet for drivers (will it fit in the truck?) */
  const [showRunSheet, setShowRunSheet] = useState(false);
  const [runSheetFocus, setRunSheetFocus] = useState<string | null>(null);
  const focusHandled = useRef<number | null>(null);

  const listRef = useRef<HTMLDivElement>(null);

  // Create form — vendor + description + address (+ contact for office/admin)
  const [vendor, setVendor] = useState("");
  const [partDescription, setPartDescription] = useState("");
  const [jobAddress, setJobAddress] = useState("");
  const [contactUserId, setContactUserId] = useState("");
  const [contactName, setContactName] = useState("");
  /** First day warehouse should pick it up (future = on list but not for today's run). */
  const [readyDate, setReadyDate] = useState(() => localTodayIso());
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [vendorNames, setVendorNames] = useState<string[]>([]);

  const isOfficeEntry = user?.role === "admin" || user?.role === "office";
  const canEditAny =
    user?.role === "admin" || user?.role === "office" || user?.role === "warehouse";

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
      ready_today?: number;
      error?: string;
    }>(
      `/inventory/part-pickups?status=${
        filter === "open" ? "open" : filter === "history" ? "history" : "all"
      }`
    );
    setGroups(d.vendors || []);
    setTickets(d.tickets || []);
    if (d.vendor_names?.length) setVendorNames(d.vendor_names);
    setWaiting(d.waiting || 0);
    setReadyToday(d.ready_today ?? d.waiting ?? 0);
    if (d.error) setError(d.error);
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [load]);

  /**
   * Inbox deep-link ?ticket=12 — open Waiting first; if already picked, switch to
   * Picked/done (or All) so the request is still findable from the notification.
   */
  useEffect(() => {
    if (!focusTicketId) return;
    if (focusHandled.current === focusTicketId) return;

    let cancelled = false;
    (async () => {
      try {
        const findIn = async (status: string) => {
          const d = await api<{
            vendors?: VendorGroup[];
            tickets?: Ticket[];
            waiting?: number;
          }>(`/inventory/part-pickups?status=${status}`);
          const list = d.tickets || [];
          const hit = list.find((t) => t.id === focusTicketId);
          return { d, hit };
        };

        // Prefer open list
        let { d, hit } = await findIn("open");
        let nextFilter: "open" | "history" | "all" = "open";
        if (!hit) {
          ({ d, hit } = await findIn("history"));
          nextFilter = "history";
        }
        if (!hit) {
          ({ d, hit } = await findIn("all"));
          nextFilter = "all";
        }
        if (cancelled) return;

        if (!hit) {
          setError(
            `Pickup request #${focusTicketId} was not found. It may have been removed from the system.`
          );
          focusHandled.current = focusTicketId;
          return;
        }

        setFilter(nextFilter);
        setGroups(d.vendors || []);
        setTickets(d.tickets || []);
        setWaiting(d.waiting || 0);
        setExpanded((p) => ({ ...p, [hit!.vendor_name]: true }));
        setExpandedTicket((p) => ({ ...p, [hit!.id]: true })); // force open when deep-linked

        const openish = (hit.lines || []).some((l) =>
          ["pending", "not_ready", "partial"].includes(l.status)
        );
        if (openish) {
          setOk(
            `Opened request #${hit.id} · ${hit.vendor_name} — still on the Waiting list.`
          );
        } else {
          const st =
            hit.status === "cancelled"
              ? "Not needed"
              : hit.status === "done"
                ? "Picked / done"
                : hit.status;
          setOk(
            `This request is already closed (${st}). Expand it below — use “Put back on Waiting list” if it still needs pickup.`
          );
        }

        focusHandled.current = focusTicketId;
        // Drop query after focus so refresh doesn’t re-jump forever
        const next = new URLSearchParams(searchParams);
        // keep ticket briefly for shareable URL; clear after scroll
        window.setTimeout(() => {
          next.delete("ticket");
          setSearchParams(next, { replace: true });
        }, 800);
        window.setTimeout(() => {
          document
            .getElementById(`pp-ticket-${hit!.id}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 120);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not open that pickup request");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // Only re-run when the deep-link id changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTicketId]);

  useEffect(() => {
    if (!isOfficeEntry) return;
    // Employees list is available to office; users list is admin-only
    void api<{ employees?: Array<{ id: number; name: string; active?: number }> }>(
      "/employees"
    )
      .then((r) => {
        const list = (r.employees || [])
          .filter((e) => e.name?.trim())
          .map((e) => ({
            id: e.id,
            display_name: e.name.trim(),
          }))
          .sort((a, b) => a.display_name.localeCompare(b.display_name));
        setStaff(list);
      })
      .catch(() => {
        /* free-text contact still works */
      });
  }, [isOfficeEntry]);

  function scrollToList() {
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /**
   * All open vendor stops for the "Stops needed" / parts list.
   * Includes future-ready items (e.g. Carrier arrives later) so warehouse always sees them.
   * Ready-today lines sort first within each company.
   */
  const runSheet = useMemo(() => {
    return groups
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
          ready: boolean;
        }> = [];
        for (const t of g.tickets) {
          const ticketNote = (t.notes || "").trim() || null;
          const ready = isTicketReadyToPick(t);
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
              name: name || (code ? code : "Part description pending"),
              po: null,
              needed: t.needed_for_date,
              notes: lineNote || ticketNote,
              status: l.status,
              ready,
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
              ready,
            });
          }
        }
        // Ready today first, then later arrivals — never hide future items
        lines.sort(
          (a, b) =>
            Number(b.ready) - Number(a.ready) ||
            b.qty - a.qty ||
            a.name.localeCompare(b.name)
        );
        const readyLines = lines.filter((l) => l.ready);
        const laterLines = lines.filter((l) => !l.ready);
        const pieceCount = lines.reduce(
          (s, l) => s + (typeof l.qty === "number" && Number.isFinite(l.qty) ? l.qty : 0),
          0
        );
        const readyPieceCount = readyLines.reduce(
          (s, l) => s + (typeof l.qty === "number" && Number.isFinite(l.qty) ? l.qty : 0),
          0
        );
        return {
          vendor_name: g.vendor_name,
          waiting: lines.length,
          laterCount: laterLines.length,
          readyCount: readyLines.length,
          lines,
          pieceCount,
          readyPieceCount,
          allLater: lines.length > 0 && readyLines.length === 0,
        };
      })
      .filter((g) => g.lines.length > 0)
      // Ready-today stops first, then later-only vendors (still listed)
      .sort(
        (a, b) =>
          Number(a.allLater) - Number(b.allLater) ||
          b.readyPieceCount - a.readyPieceCount ||
          b.pieceCount - a.pieceCount ||
          a.vendor_name.localeCompare(b.vendor_name)
      );
  }, [groups]);

  const runSheetTotalPieces = useMemo(
    () => runSheet.reduce((s, g) => s + g.pieceCount, 0),
    [runSheet]
  );
  const runSheetLaterStops = useMemo(
    () => runSheet.filter((g) => g.laterCount > 0).length,
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
      const vend = vendor.trim();
      const desc = partDescription.trim();
      const addr = jobAddress.trim();
      if (vend.length < 2) throw new Error("Enter the store / vendor where the part is waiting.");
      if (desc.length < 2) throw new Error("Describe the part that needs to be picked up.");
      if (addr.length < 3) throw new Error("Enter the address this part is needed for.");
      let contact = contactName.trim();
      const eid = contactUserId ? Number(contactUserId) : null;
      if (eid && staff.length) {
        const hit = staff.find((s) => s.id === eid);
        if (hit) contact = hit.display_name;
      }
      if (isOfficeEntry && !contact) {
        throw new Error("Select who this is for (contact) so warehouse knows who to ask.");
      }
      const ready = readyDate.trim() || localTodayIso();
      const r = await api<{ ready_to_pick?: boolean; needed_for_date?: string }>(
        "/inventory/part-pickups",
        {
          method: "POST",
          body: JSON.stringify({
            vendor_name: vend,
            part_description: desc,
            job_address: addr,
            contact_name: contact || undefined,
            needed_for_date: ready,
            source: defaultSource,
          }),
        }
      );
      const later = r.ready_to_pick === false;
      setOk(
        later
          ? `Saved — arrives ${formatReadyDate(r.needed_for_date || ready)}. On the list for planning, not on today's driver run sheet.`
          : "Part pickup request submitted — ready for pickup."
      );
      setVendor("");
      setPartDescription("");
      setJobAddress("");
      setContactUserId("");
      setContactName("");
      setReadyDate(localTodayIso());
      setShowForm(false);
      await load();
      window.dispatchEvent(new CustomEvent("vendor-runs-changed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function saveOwnerDetails(
    ticketId: number,
    payload: {
      lineId: number;
      part_name: string;
      job_address: string;
      needed_for_date: string;
    }
  ) {
    await api(`/inventory/part-pickups/${ticketId}/lines`, {
      method: "PUT",
      body: JSON.stringify({
        job_address: payload.job_address,
        needed_for_date: payload.needed_for_date || null,
        part_description: payload.part_name,
        lines: [{ id: payload.lineId, part_name: payload.part_name }],
      }),
    });
  }

  /** Instant UI update so Picked / Not needed feels instant even if reload is slow. */
  function applyLineLocally(
    lineId: number,
    status: LineStatus,
    qtyReceived?: number | null,
    notes?: string | null
  ) {
    const patchLine = (line: TicketLine): TicketLine => {
      if (line.id !== lineId) return line;
      return {
        ...line,
        status,
        qty_received:
          status === "picked"
            ? qtyReceived != null
              ? qtyReceived
              : line.qty_requested
            : status === "partial"
              ? qtyReceived ?? line.qty_received
              : status === "pending" || status === "not_ready" || status === "cancelled"
                ? status === "cancelled"
                  ? line.qty_received
                  : null
                : line.qty_received,
        notes: notes != null && notes !== "" ? notes : line.notes,
      };
    };
    const openish = (s: string) => ["pending", "not_ready", "partial"].includes(s);

    setTickets((prev) =>
      prev.map((t) => ({
        ...t,
        lines: (t.lines || []).map(patchLine),
      }))
    );

    setGroups((prev) =>
      prev
        .map((g) => {
          const tickets = g.tickets.map((t) => {
            const lines = (t.lines || []).map(patchLine);
            const open_lines = lines.filter((l) => openish(l.status)).length;
            const picked_lines = lines.filter((l) => l.status === "picked").length;
            let ticketStatus = t.status;
            if (lines.length && open_lines === 0) {
              ticketStatus = lines.every((l) => l.status === "cancelled")
                ? "cancelled"
                : "done";
            } else if (picked_lines > 0 || lines.some((l) => l.status === "partial")) {
              ticketStatus = "partial";
            } else {
              ticketStatus = "open";
            }
            return {
              ...t,
              lines,
              open_lines,
              picked_lines,
              status: ticketStatus,
            };
          });
          // Open list keeps any ticket that still has lines needing pickup
          const keep =
            filter === "all"
              ? tickets
              : filter === "history"
                ? tickets.filter(
                    (t) =>
                      (t.status === "done" || t.status === "cancelled") &&
                      !(t.lines || []).some((l) => openish(l.status))
                  )
                : tickets.filter(
                    (t) =>
                      t.status === "open" ||
                      t.status === "partial" ||
                      (t.lines || []).some((l) => openish(l.status))
                  );
          const waiting = keep.reduce(
            (s, t) => s + (t.lines || []).filter((l) => openish(l.status)).length,
            0
          );
          return { ...g, tickets: keep, waiting };
        })
        .filter((g) =>
          filter === "open" || filter === "history" ? g.tickets.length > 0 : true
        )
    );

    setWaiting((w) => {
      // Recompute from groups after patch is messy in one step — load() will correct
      return Math.max(0, w - (status === "picked" || status === "cancelled" ? 1 : 0));
    });
  }

  function findLineContext(lineId: number): {
    ticket: Ticket;
    line: TicketLine;
  } | null {
    const search = (list: Ticket[]) => {
      for (const t of list) {
        const line = (t.lines || []).find((l) => l.id === lineId);
        if (line) return { ticket: t, line };
      }
      return null;
    };
    return search(tickets) || search(groups.flatMap((g) => g.tickets)) || null;
  }

  async function resolveLine(
    lineId: number,
    status: LineStatus,
    qtyReceived?: number | null,
    notes?: string
  ) {
    setResolvingId(lineId);
    setError("");
    setOk("");
    const ctx = findLineContext(lineId);
    // Optimistic — UI updates immediately so counter doesn't wait on network
    applyLineLocally(lineId, status, qtyReceived, notes || null);
    try {
      await api(`/inventory/part-pickups/lines/${lineId}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          status,
          qty_received: qtyReceived ?? null,
          notes: notes || null,
          receive_stock: status === "picked" || status === "partial",
        }),
        timeoutMs: 15_000,
      });
      setOk(
        status === "picked"
          ? "Marked picked up — you’ll get a reminder to record where you placed the parts when back at the office."
          : status === "not_ready"
            ? "Marked not ready at vendor."
            : status === "partial"
              ? "Marked partial pickup — you’ll get a reminder to record where you placed the parts when back at the office."
              : status === "cancelled"
                ? "Marked not needed — off the pickup list."
                : "Updated."
      );
      window.dispatchEvent(new CustomEvent("vendor-runs-changed"));
      if (status === "picked" || status === "partial") {
        window.dispatchEvent(new CustomEvent("notifications-changed"));
      }
      // Refresh in background — never leave the button hung on this
      void load().catch(() => {
        /* optimistic state already applied */
      });
      // After pick: auto-open Brought to shop with this part selected / prefilled
      if (status === "picked" || status === "partial") {
        const params = new URLSearchParams();
        if (ctx) {
          params.set("vendor", ctx.ticket.vendor_name || "");
          const part =
            (ctx.line.part_name || ctx.line.part_code || "").trim() || "Parts from vendor";
          params.set("part", part);
          if (ctx.ticket.notes?.trim()) params.set("address", ctx.ticket.notes.trim());
          if (ctx.ticket.purchase_order?.trim()) {
            params.set("contact", ctx.ticket.purchase_order.trim());
          }
          params.set("pickup_id", String(ctx.ticket.id));
          params.set("line_id", String(ctx.line.id));
          if (qtyReceived != null && Number.isFinite(qtyReceived)) {
            params.set("qty", String(qtyReceived));
          } else if (ctx.line.qty_requested) {
            params.set("qty", String(ctx.line.qty_requested));
          }
        }
        params.set("from", "pickup");
        navigate(`/parts-dropoff?${params.toString()}`);
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed — try again");
      // Pull truth from server after failure
      void load().catch(() => {
        /* ignore */
      });
    } finally {
      setResolvingId(null);
    }
  }

  return (
    <div className={`vendor-run-panel${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="page-header vendor-run-page-head">
          <div>
            <h2 style={{ margin: 0 }}>Part pickup request</h2>
            <p className="page-header-sub">
              Stay on <strong>Waiting</strong> until <strong>Picked up</strong> or{" "}
              <strong>Not needed</strong>. Later ready dates stay listed, off today&apos;s run.
            </p>
          </div>
          <div className="vendor-run-toolbar">
            <button
              type="button"
              className={`btn btn-sm vendor-waiting-btn${filter === "open" ? " primary" : ""}`}
              onClick={() => openWaitingList()}
              title={
                waiting > readyToday
                  ? `${readyToday} ready today · ${waiting - readyToday} arriving later (still on list)`
                  : `${waiting} open pickup${waiting === 1 ? "" : "s"}`
              }
            >
              Waiting
              <span className={`vendor-waiting-count${waiting > 0 ? " is-hot" : ""}`}>
                {waiting}
              </span>
            </button>
            <button
              type="button"
              className={`btn ghost btn-sm${filter === "history" ? " primary" : ""}`}
              onClick={() => {
                setFilter("history");
                setShowForm(false);
              }}
              title="History of who requested and who picked up — put back if needed"
            >
              History
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
              {showForm ? "Hide form" : "New pickup request"}
            </button>
          </div>
        </div>
      )}

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {/* Stops needed — every open vendor including future-ready (e.g. Carrier arrives later) */}
      {(runSheet.length > 0 || groups.some((g) => g.waiting > 0)) && (
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
              {runSheetLaterStops > 0
                ? ` · ${runSheetLaterStops} with later arrival`
                : ""}
              {" "}
              — all open pickups (later arrivals marked)
            </p>
          </button>
          <div className="vendor-run-chips" role="list">
            {runSheet.map((g) => (
              <button
                key={g.vendor_name}
                type="button"
                className={`vendor-run-chip${
                  runSheetFocus === g.vendor_name || expanded[g.vendor_name] ? " is-open" : ""
                }${g.allLater ? " is-later" : ""}`}
                onClick={() => openRunSheet(g.vendor_name)}
                title={
                  g.allLater
                    ? `${g.vendor_name}: arrives later (still needs pickup)`
                    : `${g.pieceCount} piece(s) at ${g.vendor_name}${
                        g.laterCount ? ` · ${g.laterCount} later` : ""
                      }`
                }
              >
                <span className="vendor-run-chip-name">{g.vendor_name}</span>
                <span className="vendor-run-chip-n">
                  {g.pieceCount > 0 ? g.pieceCount : g.waiting}
                </span>
                {g.allLater ? (
                  <span className="vendor-run-chip-later">later</span>
                ) : g.laterCount > 0 ? (
                  <span className="vendor-run-chip-later">+{g.laterCount}</span>
                ) : null}
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
                  Qty × part by company — ready today first; later arrivals stay listed so nothing
                  is missed
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
                      <h3>
                        {g.vendor_name}
                        {g.allLater ? (
                          <span className="vendor-run-sheet-later-tag"> arrives later</span>
                        ) : null}
                      </h3>
                      <span className="vendor-run-sheet-tally">
                        {g.pieceCount > 0
                          ? `${g.pieceCount} pc${g.pieceCount === 1 ? "" : "s"}`
                          : `${g.lines.length} line${g.lines.length === 1 ? "" : "s"}`}
                        {g.laterCount > 0 && g.readyCount > 0
                          ? ` · ${g.laterCount} later`
                          : ""}
                      </span>
                    </header>
                    <ul className="vendor-run-sheet-parts">
                      {g.lines.map((l) => (
                        <li
                          key={l.key}
                          className={`vendor-run-sheet-part${l.qty >= 3 ? " is-bulk" : ""}${
                            !l.ready ? " is-later" : ""
                          }`}
                        >
                          <span className="vendor-run-sheet-qty" title="Quantity">
                            {l.qty}×
                          </span>
                          <span className="vendor-run-sheet-detail">
                            <strong className="vendor-run-sheet-name">
                              {l.name || "Part"}
                            </strong>
                            {!l.ready ? (
                              <span className="vendor-run-sheet-arrives">
                                Arrives {formatReadyDate(l.needed) || "later"} · not today
                              </span>
                            ) : null}
                            {l.code && l.code !== "—" && l.code !== l.name ? (
                              <span className="vendor-run-sheet-code">{l.code}</span>
                            ) : null}
                            {(l.po || l.notes) && (
                              <span className="muted vendor-run-sheet-meta">
                                {[l.po || null, l.notes].filter(Boolean).join(" · ")}
                              </span>
                            )}
                            {l.lineId != null && canResolve && (
                              <span className="vendor-run-sheet-actions">
                                <button
                                  type="button"
                                  className="btn btn-sm"
                                  disabled={resolvingId === l.lineId || busy}
                                  onClick={() => {
                                    const laterNote = !l.ready
                                      ? "\n\nNote: ready date is still in the future — only mark picked up if you already have it."
                                      : "";
                                    if (
                                      !window.confirm(
                                        `Mark “${l.name}” as picked up?\n\nIt leaves Waiting. Use Picked / done → Put back if this was a mistake.${laterNote}`
                                      )
                                    ) {
                                      return;
                                    }
                                    void resolveLine(l.lineId!, "picked");
                                  }}
                                >
                                  {resolvingId === l.lineId ? "Saving…" : "Picked up"}
                                </button>
                              </span>
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
              <p className="muted" style={{ margin: "0.5rem 0 0", fontSize: "0.8rem", width: "100%" }}>
                To mark something Not needed, open the full request below — keeps accidental taps
                from dropping parts.
              </p>
            </div>
          </div>
        </div>
      )}

      {showForm && (
        <form className="card vendor-run-form" onSubmit={submitTicket}>
          <p className="muted vendor-run-form-hint">
            Tell warehouse where to get the part, what it is, and where it needs to go.
            {isOfficeEntry
              ? " As office/admin, also pick who to contact if we need more info."
              : ""}
          </p>
          <label>
            Store / vendor *{" "}
            <span className="muted">(where to pick it up)</span>
            <input
              list="part-pickup-vendors"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              required
              minLength={2}
              placeholder="Gemaire, Johnstone, Lennox, Ferguson…"
              autoFocus
              autoComplete="off"
            />
            <datalist id="part-pickup-vendors">
              {vendorNames.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <label>
            Part description *
            <textarea
              value={partDescription}
              onChange={(e) => setPartDescription(e.target.value)}
              required
              rows={2}
              minLength={2}
              placeholder="e.g. 3-ton contactor, 50 ft 3/8 copper, TXV for unit…"
            />
          </label>
          <label>
            Address it&apos;s needed for *
            <input
              value={jobAddress}
              onChange={(e) => setJobAddress(e.target.value)}
              required
              minLength={3}
              placeholder="Job site address or clear meetup location"
              autoComplete="street-address"
            />
          </label>
          <label>
            Ready to pick on *
            <input
              type="date"
              value={readyDate}
              onChange={(e) => setReadyDate(e.target.value)}
              required
            />
            <span className="muted" style={{ fontSize: "0.8rem", fontWeight: 500 }}>
              Today = on the driver run sheet now. Future date (e.g. when vendor says it arrives) =
              stays on the list but driver is not sent today.
            </span>
          </label>
          {isOfficeEntry && (
            <>
              <label>
                Contact person *{" "}
                <span className="muted">(who to call if we need more info)</span>
                <select
                  value={contactUserId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setContactUserId(id);
                    if (id) {
                      const hit = staff.find((s) => String(s.id) === id);
                      if (hit) setContactName(hit.display_name);
                    } else {
                      setContactName("");
                    }
                  }}
                  required={!contactName.trim()}
                >
                  <option value="">Select employee…</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Or type contact name
                <input
                  value={contactName}
                  onChange={(e) => {
                    setContactName(e.target.value);
                    if (e.target.value.trim()) setContactUserId("");
                  }}
                  placeholder="If not in the list above"
                />
              </label>
            </>
          )}
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Submit pickup request"}
          </button>
        </form>
      )}

      <div className="vendor-run-groups" ref={listRef} id="part-pickup-list">
        {!tickets.length && (
          <div className="card muted">
            {filter === "open"
              ? "Nothing waiting for pickup. Use New pickup request — set Ready to pick on a future day if it is still arriving."
              : filter === "history"
                ? "No closed pickups yet. History shows who requested each part and who marked it picked up."
                : "No recent pickup requests."}
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
                    currentUserId={user?.id ?? null}
                    canEdit={
                      canEditAny ||
                      (t.logged_by_user_id != null && t.logged_by_user_id === user?.id)
                    }
                    canResolve={canResolve}
                    canNotNeeded={canNotNeeded}
                    busy={busy}
                    resolvingId={resolvingId}
                    expanded={expandedTicket[t.id] === true}
                    onToggle={() =>
                      setExpandedTicket((p) => ({
                        ...p,
                        [t.id]: !(p[t.id] === true),
                      }))
                    }
                    onResolve={resolveLine}
                    onPlaceParts={(line) => {
                      const params = new URLSearchParams();
                      params.set("from", "pickup");
                      params.set("vendor", t.vendor_name || "");
                      const part =
                        (line.part_name || line.part_code || "").trim() || "Parts from vendor";
                      params.set("part", part);
                      if (t.notes?.trim()) params.set("address", t.notes.trim());
                      if (t.purchase_order?.trim()) params.set("contact", t.purchase_order.trim());
                      params.set("pickup_id", String(t.id));
                      params.set("line_id", String(line.id));
                      if (line.qty_received != null && Number.isFinite(line.qty_received)) {
                        params.set("qty", String(line.qty_received));
                      } else if (line.qty_requested) {
                        params.set("qty", String(line.qty_requested));
                      }
                      navigate(`/parts-dropoff?${params.toString()}`);
                    }}
                    onSaveOwner={async (payload) => {
                      setBusy(true);
                      setError("");
                      try {
                        await saveOwnerDetails(t.id, payload);
                        setOk("Request updated — description, address, and ready date saved.");
                        await load();
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "Save failed");
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

type TicketCardProps = {
  ticket: Ticket;
  currentUserId: number | null;
  /** Owner / office / warehouse / admin may edit description, address, ready date */
  canEdit: boolean;
  canResolve: boolean;
  canNotNeeded: boolean;
  busy: boolean;
  resolvingId: number | null;
  expanded: boolean;
  onToggle: () => void;
  onResolve: (
    lineId: number,
    status: LineStatus,
    qtyReceived?: number | null,
    notes?: string
  ) => Promise<void>;
  onPlaceParts: (line: TicketLine) => void;
  onSaveOwner: (payload: {
    lineId: number;
    part_name: string;
    job_address: string;
    needed_for_date: string;
  }) => Promise<void>;
};

function TicketCard({
  ticket: t,
  currentUserId,
  canEdit,
  canResolve,
  canNotNeeded,
  busy,
  resolvingId,
  expanded,
  onToggle,
  onResolve,
  onPlaceParts,
  onSaveOwner,
}: TicketCardProps) {
  const primaryLine = t.lines[0];
  const partText =
    (primaryLine?.part_name || primaryLine?.part_code || "").trim() ||
    t.lines
      .map((l) => l.part_name || l.part_code)
      .filter(Boolean)
      .join("; ") ||
    "Part";
  const addressText = (t.notes || "").trim();
  /** Contact for questions (office-entered); purchase_order column holds the name */
  const contactText = (t.purchase_order || "").trim();
  const ready = isTicketReadyToPick(t);
  const readyLabel = formatReadyDate(t.needed_for_date);
  /** Lines this user picked (or partial) — can log where parts were left */
  const myPlacedLines = t.lines.filter(
    (l) =>
      (l.status === "picked" || l.status === "partial") &&
      currentUserId != null &&
      l.resolved_by_user_id === currentUserId
  );
  const primaryMyPlace = myPlacedLines[0] || null;

  const [editDesc, setEditDesc] = useState(partText);
  const [editAddr, setEditAddr] = useState(addressText);
  const [editReady, setEditReady] = useState(
    (t.needed_for_date || "").slice(0, 10) || localTodayIso()
  );
  const [partialQty, setPartialQty] = useState<Record<number, string>>({});

  useEffect(() => {
    setEditDesc(partText);
    setEditAddr(addressText);
    setEditReady((t.needed_for_date || "").slice(0, 10) || localTodayIso());
  }, [partText, addressText, t.needed_for_date, t.id]);

  const openCount = t.lines.filter((l) =>
    ["pending", "not_ready", "partial"].includes(l.status)
  ).length;
  const canEditText =
    canEdit &&
    t.lines.some((l) => l.status === "pending" || l.status === "not_ready" || l.status === "partial");

  const primaryOpen =
    primaryLine &&
    ["pending", "not_ready", "partial"].includes(primaryLine.status)
      ? primaryLine
      : t.lines.find((l) => ["pending", "not_ready", "partial"].includes(l.status)) ||
        null;

  return (
    <div
      id={`pp-ticket-${t.id}`}
      className={`pp-ticket${ready ? "" : " pp-ticket-later"}`}
    >
      <div className="pp-ticket-row">
        <button type="button" className="pp-ticket-head" onClick={onToggle}>
          <span className="pp-ticket-main">
            <span className="pp-ticket-title-line">
              <span className="pp-ticket-chevron" aria-hidden>
                {expanded ? "▾" : "▸"}
              </span>
              <strong>{partText}</strong>
              <span className={`pp-ticket-badge st-${t.status}`}>
                {t.status}
                {openCount > 0 ? ` · ${openCount}` : ""}
              </span>
              {!ready && readyLabel ? (
                <span className="pp-arrives-pill">Arrives {readyLabel}</span>
              ) : null}
            </span>
            <span className="muted pp-ticket-meta">
              {addressText || ""}
              {contactText ? `${addressText ? " · " : ""}contact ${contactText}` : ""}
              {t.logged_by_name
                ? `${addressText || contactText ? " · " : ""}req ${t.logged_by_name}`
                : ""}
              {(() => {
                const picked = t.lines.find(
                  (l) => l.status === "picked" && (l.resolved_by_name || l.resolved_at)
                );
                if (!picked) return "";
                return ` · picked ${picked.resolved_by_name || "someone"}${
                  picked.resolved_at ? ` ${formatStamp(picked.resolved_at)}` : ""
                }`;
              })()}
            </span>
          </span>
        </button>
        {canResolve && primaryOpen && (
          <div className="pp-ticket-quick-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || resolvingId === primaryOpen.id}
              onClick={() => {
                if (
                  !window.confirm(
                    `Mark “${partText}” as picked up?\n\nNext you’ll choose where you’re dropping it off at the shop.`
                  )
                ) {
                  return;
                }
                void onResolve(primaryOpen.id, "picked");
              }}
            >
              {resolvingId === primaryOpen.id ? "…" : "Picked up"}
            </button>
          </div>
        )}
        {!primaryOpen && primaryMyPlace && (
          <div className="pp-ticket-quick-actions">
            <button
              type="button"
              className="btn primary btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                onPlaceParts(primaryMyPlace);
              }}
              title="Record where you left these parts at the shop"
            >
              Where placed?
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="pp-ticket-body">
          {/* Always-visible who-did-what trail */}
          <div className="pp-activity" aria-label="Activity log">
            <div className="pp-activity-title">Activity</div>
            <ul className="pp-activity-list">
              <li>
                <span className="pp-activity-when">{formatStamp(t.created_at) || "—"}</span>
                <span className="pp-activity-what">
                  Requested by <strong>{t.logged_by_name || "Unknown"}</strong>
                  {contactText && contactText !== t.logged_by_name
                    ? ` · contact ${contactText}`
                    : ""}
                  {addressText ? ` · for ${addressText}` : ""}
                </span>
              </li>
              {t.lines
                .filter((l) => l.status !== "pending" || l.resolved_at || l.resolved_by_name)
                .map((l) => {
                  const who = l.resolved_by_name || "Someone";
                  const when = formatStamp(l.resolved_at);
                  const what =
                    l.status === "picked"
                      ? "Picked up"
                      : l.status === "cancelled"
                        ? "Marked not needed"
                        : l.status === "not_ready"
                          ? "Marked not ready"
                          : l.status === "partial"
                            ? "Partial pickup"
                            : statusLabel(l.status);
                  const part =
                    (l.part_name || l.part_code || "").trim() || `Line ${l.line_no}`;
                  return (
                    <li key={`act-${l.id}-${l.status}-${l.resolved_at || ""}`}>
                      <span className="pp-activity-when">{when || "—"}</span>
                      <span className="pp-activity-what">
                        {what} by <strong>{who}</strong>
                        {l.qty_received != null ? ` · qty ${l.qty_received}` : ""}
                        {` · ${part}`}
                        {l.status === "cancelled" && l.notes ? ` · ${l.notes}` : ""}
                      </span>
                    </li>
                  );
                })}
              {!t.lines.some((l) => l.status === "picked" || l.status === "cancelled" || l.status === "not_ready" || l.status === "partial") && (
                <li className="pp-activity-pending">
                  <span className="pp-activity-when">Now</span>
                  <span className="pp-activity-what muted">Waiting for warehouse pickup</span>
                </li>
              )}
            </ul>
          </div>

          {canEditText && primaryLine ? (
            <div className="pp-owner-edit" style={{ marginBottom: "0.75rem" }}>
              <label>
                Part description
                <textarea
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  rows={2}
                />
              </label>
              <label>
                Address needed for
                <input value={editAddr} onChange={(e) => setEditAddr(e.target.value)} />
              </label>
              <label>
                Ready to pick on
                <input
                  type="date"
                  value={editReady}
                  onChange={(e) => setEditReady(e.target.value)}
                />
                <span className="muted" style={{ fontSize: "0.78rem", fontWeight: 500 }}>
                  Future date keeps it on the list but off the driver&apos;s today run.
                </span>
              </label>
              <button
                type="button"
                className="btn secondary btn-sm"
                disabled={busy || editDesc.trim().length < 2}
                onClick={() =>
                  void onSaveOwner({
                    lineId: primaryLine.id,
                    part_name: editDesc.trim(),
                    job_address: editAddr.trim(),
                    needed_for_date: editReady.trim() || localTodayIso(),
                  })
                }
              >
                Save changes
              </button>
            </div>
          ) : (
            <div className="pp-readonly" style={{ marginBottom: "0.45rem" }}>
              <p style={{ margin: 0, fontWeight: 600 }}>{partText}</p>
              {addressText ? (
                <p className="muted" style={{ margin: "0.15rem 0 0" }}>
                  Needed for: {addressText}
                </p>
              ) : null}
              {t.needed_for_date ? (
                <p style={{ margin: "0.15rem 0 0", fontWeight: 600 }}>
                  {ready ? "Ready to pick" : "Arrives"}: {readyLabel}
                  {!ready ? " (not on today's run)" : ""}
                </p>
              ) : null}
              {!canEdit && openCount > 0 && (
                <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.78rem" }}>
                  Ask office/warehouse to update the description or ready date.
                </p>
              )}
            </div>
          )}

          <ul className="pp-lines">
            {t.lines.length === 0 && (t.status === "open" || t.status === "partial") && (
              <li className="pp-line st-pending">
                <div className="pp-line-top">
                  <span className="pp-status-pill st-pending">Still pending</span>
                </div>
                <p className="muted" style={{ margin: "0.25rem 0", fontSize: "0.85rem" }}>
                  No line was saved on this request (refresh the page to auto-fix). Use the buttons
                  after refresh, or expand and save a description.
                </p>
              </li>
            )}
            {t.lines.map((line) => {
              const locked = line.status === "picked" || line.status === "cancelled";
              const label =
                (line.part_name || line.part_code || "").trim() || `Line #${line.line_no}`;
              return (
                <li key={line.id} className={`pp-line st-${line.status}`}>
                  <div className="pp-line-top">
                    <span className={`pp-status-pill st-${line.status}`}>
                      {statusLabel(line.status)}
                      {line.qty_received != null ? ` · ${line.qty_received}` : ""}
                    </span>
                    {locked && (line.resolved_by_name || line.resolved_at) ? (
                      <span className="muted pp-line-who">
                        {line.resolved_by_name || "Someone"}
                        {line.resolved_at ? ` · ${formatStamp(line.resolved_at)}` : ""}
                      </span>
                    ) : null}
                  </div>
                  {line.status === "cancelled" && line.notes ? (
                    <p className="pp-cancel-reason muted">Why: {line.notes}</p>
                  ) : null}
                  {!locked && (
                    <div className="pp-line-actions">
                      {canResolve && (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={busy || resolvingId === line.id}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Mark “${label}” as picked up?\n\nIt will leave the Waiting list. You can put it back later from Picked / done if this was a mistake.`
                                )
                              ) {
                                return;
                              }
                              void onResolve(line.id, "picked");
                            }}
                          >
                            {resolvingId === line.id ? "Saving…" : "Picked up"}
                          </button>
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            disabled={busy || resolvingId === line.id}
                            onClick={() => void onResolve(line.id, "not_ready")}
                          >
                            Not ready
                          </button>
                          <span className="pp-partial">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              placeholder="Got"
                              className="pp-partial-qty"
                              value={partialQty[line.id] || ""}
                              onChange={(e) =>
                                setPartialQty((p) => ({ ...p, [line.id]: e.target.value }))
                              }
                            />
                            <button
                              type="button"
                              className="btn ghost btn-sm"
                              disabled={busy || resolvingId === line.id || !partialQty[line.id]}
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
                          disabled={busy || resolvingId === line.id}
                          title="Drop this part — you’ll type why"
                          onClick={() => {
                            const reason = askNotNeededReason(label);
                            if (!reason) return;
                            void onResolve(line.id, "cancelled", null, reason);
                          }}
                        >
                          Not needed
                        </button>
                      )}
                    </div>
                  )}
                  {locked && (line.status === "picked" || line.status === "partial") && (
                    <div className="pp-line-actions">
                      {currentUserId != null &&
                        line.resolved_by_user_id === currentUserId && (
                          <button
                            type="button"
                            className="btn primary btn-sm"
                            onClick={() => onPlaceParts(line)}
                            title="Say where you left these parts at the office/shop"
                          >
                            Where placed?
                          </button>
                        )}
                      {canResolve && (
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={busy || resolvingId === line.id}
                          title="Put this back on the Waiting list if it was closed by mistake"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Put “${label}” back on the Waiting list?\n\nUse this if it was marked picked or not needed by mistake and still needs pickup.`
                              )
                            ) {
                              return;
                            }
                            void onResolve(line.id, "pending");
                          }}
                        >
                          {resolvingId === line.id ? "Saving…" : "Put back on Waiting list"}
                        </button>
                      )}
                    </div>
                  )}
                  {locked &&
                    line.status === "cancelled" &&
                    canResolve && (
                      <div className="pp-line-actions">
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={busy || resolvingId === line.id}
                          title="Put this back on the Waiting list if it was closed by mistake"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Put “${label}” back on the Waiting list?\n\nUse this if it was marked picked or not needed by mistake and still needs pickup.`
                              )
                            ) {
                              return;
                            }
                            void onResolve(line.id, "pending");
                          }}
                        >
                          {resolvingId === line.id ? "Saving…" : "Put back on Waiting list"}
                        </button>
                      </div>
                    )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
