import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { VehicleQuickPick, type VehicleMatch } from "../components/VehicleQuickPick";

type OrderStatus = "needed" | "ordered" | "arriving" | "received" | "cancelled";
type VendorPref = "autozone" | "firstcall" | "either" | "other";

interface PartsOrder {
  id: number;
  user_id: number;
  vehicle_id: number | null;
  vehicle_label: string | null;
  issue_id: number | null;
  part_description: string;
  part_number: string | null;
  vendor_preference: VendorPref;
  notes: string | null;
  status: OrderStatus;
  ordered_from: string | null;
  order_note: string | null;
  ordered_at: string | null;
  arriving_at: string | null;
  received_at: string | null;
  created_at: string;
  requested_by_name?: string | null;
  vehicle_unit?: string | null;
}

interface VendorLink {
  id: string;
  label: string;
  url: string;
}

type Vehicle = VehicleMatch;

const VENDOR_URLS: Record<string, string> = {
  autozone: "https://www.autozonepro.com",
  firstcall: "https://www.firstcallonline.com/",
};

/**
 * Clipboard copy must run in the same click turn (sync) — async + window.open
 * often fails, so Ctrl+V pastes nothing on the vendor site.
 */
function copyTextSync(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 1) Classic path — most reliable inside a button click
  try {
    const ta = document.createElement("textarea");
    ta.value = t;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.width = "1px";
    ta.style.height = "1px";
    ta.style.padding = "0";
    ta.style.border = "none";
    ta.style.outline = "none";
    ta.style.boxShadow = "none";
    ta.style.background = "transparent";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, t.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    /* continue */
  }
  // 2) Modern API (may require permission; try without await for best-effort)
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(t);
      // Can't know result sync — assume ok if API exists after execCommand failed
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function copyTextAsync(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  if (copyTextSync(t)) return true;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Best value for vendor vehicle lookup: plate first (what techs type), else VIN. */
function vehicleLookupText(v: {
  plate?: string | null;
  vin?: string | null;
  unit_number?: string | null;
}): { text: string; kind: "plate" | "vin" | "unit" | "" } {
  const plate = (v.plate || "").trim();
  if (plate) return { text: plate.replace(/\s+/g, "").toUpperCase(), kind: "plate" };
  const vin = (v.vin || "").trim();
  if (vin) return { text: vin.toUpperCase(), kind: "vin" };
  const unit = (v.unit_number || "").trim();
  if (unit) return { text: unit, kind: "unit" };
  return { text: "", kind: "" };
}

function ymmText(v: {
  year?: number | null;
  make?: string | null;
  model?: string | null;
}): string {
  return [v.year, v.make, v.model].filter(Boolean).join(" ");
}

function statusLabel(s: OrderStatus | string): string {
  if (s === "needed") return "Needed";
  if (s === "ordered") return "Ordered";
  if (s === "arriving") return "Arriving";
  if (s === "received") return "Received";
  if (s === "cancelled") return "Cancelled";
  return s;
}

function statusClass(s: string): string {
  if (s === "needed") return "needed";
  if (s === "ordered" || s === "arriving") return "in-flight";
  if (s === "received") return "done";
  return "closed";
}

function vendorLabel(id: string | null | undefined): string {
  if (id === "autozone") return "AutoZone Pro";
  if (id === "firstcall") return "First Call";
  if (id === "either") return "Either";
  if (id === "other") return "Other";
  return id || "";
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function unitLabel(r: PartsOrder): string {
  if (r.vehicle_unit) return `Unit ${r.vehicle_unit}`;
  if (r.vehicle_label) return r.vehicle_label;
  return "";
}

/**
 * Shop parts order desk: open AutoZone Pro / First Call, log what is needed,
 * track Needed → Ordered → Arriving → Received.
 */
export function PartsOrderPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<"open" | "mine" | "all">("open");
  const [list, setList] = useState<PartsOrder[]>([]);
  const [vendors, setVendors] = useState<VendorLink[]>([
    { id: "autozone", label: "AutoZone Pro", url: VENDOR_URLS.autozone },
    { id: "firstcall", label: "First Call Online", url: VENDOR_URLS.firstcall },
  ]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [selectedVehicle, setSelectedVehicle] = useState<VehicleMatch | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);

  const [partDescription, setPartDescription] = useState(
    () => searchParams.get("desc") || searchParams.get("part") || ""
  );
  const [partNumber, setPartNumber] = useState("");
  const [vehicleId, setVehicleId] = useState(() => searchParams.get("vehicle") || "");
  const [vehicleLabel, setVehicleLabel] = useState("");
  const [issueId] = useState(() => searchParams.get("issue") || "");
  const [vendorPref, setVendorPref] = useState<VendorPref>("either");
  const [notes, setNotes] = useState(() => searchParams.get("notes") || "");

  const [statusEditId, setStatusEditId] = useState<number | null>(null);
  const [statusNext, setStatusNext] = useState<OrderStatus>("ordered");
  const [orderedFrom, setOrderedFrom] = useState<"autozone" | "firstcall" | "other">("autozone");
  const [orderNote, setOrderNote] = useState("");

  const canEdit =
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "mechanic" ||
    user?.role === "warehouse";
  const canCreate = canEdit;

  const load = useCallback(async () => {
    setError("");
    try {
      const view = tab === "mine" ? "mine" : tab === "all" ? "all" : "open";
      const data = await api<{
        requests: PartsOrder[];
        vendors?: VendorLink[];
        error?: string;
      }>(`/parts-orders?view=${view}`);
      if (data.error) setError(data.error);
      setList(data.requests || []);
      if (data.vendors?.length) setVendors(data.vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load parts orders");
    }
  }, [tab]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canCreate) return;
    void api<{ vehicles: Vehicle[] }>("/vehicles?filter=active")
      .then((r) =>
        setVehicles(
          (r.vehicles || []).slice().sort((a, b) =>
            a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true })
          )
        )
      )
      .catch(() => {
        /* optional */
      });
  }, [canCreate]);

  // Prefill vehicle label from unit when linked from shop ticket
  useEffect(() => {
    const u = searchParams.get("unit");
    if (u && !vehicleLabel) setVehicleLabel(`Unit ${u}`);
  }, [searchParams, vehicleLabel]);

  // Resolve vehicle from deep-link / list when vehicles load
  useEffect(() => {
    if (!vehicleId || selectedVehicle) return;
    const hit = vehicles.find((v) => String(v.id) === vehicleId);
    if (hit) applySelectedVehicle(hit, { quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when list resolves id
  }, [vehicleId, vehicles, selectedVehicle]);

  /**
   * When a unit is chosen (plate match or dropdown), copy plate to clipboard
   * immediately so Open AutoZone / First Call is ready for Ctrl+V.
   */
  function applySelectedVehicle(
    v: VehicleMatch | null,
    opts?: { quiet?: boolean }
  ) {
    setSelectedVehicle(v);
    if (!v) {
      setVehicleId("");
      return;
    }
    setVehicleId(String(v.id));
    const bits = [
      v.unit_number ? `Unit ${v.unit_number}` : "",
      v.plate || "",
      [v.year, v.make, v.model].filter(Boolean).join(" "),
    ].filter(Boolean);
    setVehicleLabel(bits.join(" · "));

    const lu = vehicleLookupText(v);
    // Sync copy in the same gesture as selecting the vehicle (type/pick)
    if (lu.text) copyTextSync(lu.text);
  }

  /** Refresh clipboard on the same click as opening the vendor link (avoids popup block). */
  function prepareVendorOpen(v?: VehicleMatch | null) {
    setError("");
    const vehicle = v ?? selectedVehicle;
    const lu = vehicle ? vehicleLookupText(vehicle) : { text: "", kind: "" as const };
    if (lu.text) copyTextSync(lu.text);
  }

  function vendorHref(vendorId: "autozone" | "firstcall"): string {
    return VENDOR_URLS[vendorId] || vendors.find((x) => x.id === vendorId)?.url || "#";
  }

  function vehicleForOrder(r: PartsOrder): VehicleMatch | null {
    if (r.vehicle_id) {
      const hit = vehicles.find((v) => v.id === r.vehicle_id);
      if (hit) return hit;
      if (selectedVehicle && selectedVehicle.id === r.vehicle_id) return selectedVehicle;
    }
    // Recover plate from "Unit X · PLATE · …" label when possible
    const label = r.vehicle_label || "";
    const plateGuess = label.match(/\b([A-Z0-9]{5,8})\b/i);
    if (plateGuess) {
      return {
        id: r.vehicle_id || 0,
        unit_number: r.vehicle_unit || "",
        plate: plateGuess[1],
      };
    }
    return null;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/parts-orders", {
        method: "POST",
        body: JSON.stringify({
          part_description: partDescription.trim(),
          part_number: partNumber.trim() || null,
          vehicle_id: vehicleId ? Number(vehicleId) : null,
          vehicle_label: vehicleLabel.trim() || null,
          issue_id: issueId ? Number(issueId) : null,
          vendor_preference: vendorPref,
          notes: notes.trim() || null,
        }),
      });
      setOk("Saved — open a vendor site to search & order when ready.");
      setPartDescription("");
      setPartNumber("");
      setNotes("");
      setVendorPref("either");
      setShowForm(false);
      setTab("open");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  function openStatus(r: PartsOrder, next: OrderStatus) {
    setStatusEditId(r.id);
    setStatusNext(next);
    setOrderedFrom(
      r.ordered_from === "firstcall" || r.ordered_from === "other" || r.ordered_from === "autozone"
        ? r.ordered_from
        : r.vendor_preference === "firstcall"
          ? "firstcall"
          : "autozone"
    );
    setOrderNote(r.order_note || "");
  }

  async function submitStatus(e: FormEvent) {
    e.preventDefault();
    if (statusEditId == null) return;
    setActingId(statusEditId);
    setError("");
    try {
      await api(`/parts-orders/${statusEditId}/status`, {
        method: "POST",
        body: JSON.stringify({
          status: statusNext,
          ordered_from: statusNext === "ordered" || statusNext === "arriving" ? orderedFrom : null,
          order_note: orderNote.trim() || null,
        }),
      });
      setOk(`Marked ${statusLabel(statusNext).toLowerCase()}.`);
      setStatusEditId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setActingId(null);
    }
  }

  async function cancelOrder(id: number) {
    if (!window.confirm("Cancel this parts order?")) return;
    setActingId(id);
    try {
      await api(`/parts-orders/${id}/cancel`, { method: "POST", body: "{}" });
      setOk("Cancelled.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setActingId(null);
    }
  }

  async function copyText(text: string) {
    const okCopy = await copyTextAsync(text);
    setOk(
      okCopy
        ? "Copied — paste into the vendor site search."
        : "Copy not available — select the text manually."
    );
  }

  const openCount = useMemo(
    () => list.filter((r) => r.status === "needed" || r.status === "ordered" || r.status === "arriving").length,
    [list]
  );

  return (
    <div className="page parts-order-page">
      <div className="page-header">
        <div>
          <h1>Order for shop</h1>
          <p>Log what you need, then open AutoZone or First Call to order.</p>
        </div>
        {canCreate && (
          <button
            type="button"
            className="btn secondary btn-sm no-print"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? "Hide form" : "New order"}
          </button>
        )}
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {showForm && canCreate && (
        <form className="card form parts-order-form" onSubmit={submit}>
          <h2 style={{ marginTop: 0 }}>What do you need?</h2>
          {issueId ? (
            <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
              Linked to shop ticket #{issueId}
            </p>
          ) : null}
          <label>
            Part / description *
            <input
              value={partDescription}
              onChange={(e) => setPartDescription(e.target.value)}
              required
              placeholder="e.g. Alternator, serpentine belt, oil filter…"
              autoFocus
            />
          </label>
          <label>
            Part number <span className="muted">(if you have it)</span>
            <input
              value={partNumber}
              onChange={(e) => setPartNumber(e.target.value)}
              placeholder="Optional"
              autoComplete="off"
            />
          </label>
          <VehicleQuickPick
            value={vehicleId}
            vehicles={vehicles}
            onChange={(id, v) => {
              if (!id || !v) {
                setVehicleId("");
                setSelectedVehicle(null);
                return;
              }
              applySelectedVehicle(v);
            }}
            label="License plate or unit #"
            placeholder="Type plate or unit…"
          />
          {selectedVehicle && (
            <p className="muted" style={{ margin: "-0.25rem 0 0", fontSize: "0.85rem" }}>
              Unit {selectedVehicle.unit_number}
              {selectedVehicle.plate ? ` · ${selectedVehicle.plate}` : ""}
              {[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model]
                .filter(Boolean)
                .join(" ")
                ? ` · ${[selectedVehicle.year, selectedVehicle.make, selectedVehicle.model]
                    .filter(Boolean)
                    .join(" ")}`
                : ""}
            </p>
          )}
          <label>
            Free-text note if not in fleet
            <input
              value={vehicleLabel}
              onChange={(e) => setVehicleLabel(e.target.value)}
              placeholder="Shop truck, trailer, etc."
            />
          </label>
          <label>
            Prefer store
            <select
              value={vendorPref}
              onChange={(e) => setVendorPref(e.target.value as VendorPref)}
            >
              <option value="either">Either is fine</option>
              <option value="autozone">AutoZone</option>
              <option value="firstcall">First Call</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>
            Notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Engine, urgency…"
            />
          </label>
          <div className="toolbar parts-order-form-actions">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save to order list"}
            </button>
            <a
              className="btn secondary"
              href={vendorHref("autozone")}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => prepareVendorOpen(selectedVehicle)}
            >
              AutoZone
            </a>
            <a
              className="btn secondary"
              href={vendorHref("firstcall")}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => prepareVendorOpen(selectedVehicle)}
            >
              First Call
            </a>
          </div>
        </form>
      )}

      <div className="filters no-print" style={{ margin: "0.75rem 0" }}>
        <button
          type="button"
          className={`chip ${tab === "open" ? "active" : ""}`}
          onClick={() => setTab("open")}
        >
          Open{tab === "open" && openCount ? ` (${openCount})` : ""}
        </button>
        <button
          type="button"
          className={`chip ${tab === "mine" ? "active" : ""}`}
          onClick={() => setTab("mine")}
        >
          Mine
        </button>
        <button
          type="button"
          className={`chip ${tab === "all" ? "active" : ""}`}
          onClick={() => setTab("all")}
        >
          Recent
        </button>
      </div>

      <section className="parts-order-list">
        {!list.length ? (
          <div className="card muted">No parts orders here yet.</div>
        ) : (
          list.map((r) => {
            const copyPayload = [r.part_number, r.part_description, unitLabel(r), r.notes]
              .filter(Boolean)
              .join(" · ");
            return (
              <article key={r.id} className={`card parts-order-card st-${statusClass(r.status)}`}>
                <div className="parts-order-card-head">
                  <strong>{r.part_description}</strong>
                  <span className={`parts-order-status st-${statusClass(r.status)}`}>
                    {statusLabel(r.status)}
                  </span>
                </div>
                <p className="parts-order-meta muted">
                  {r.part_number ? <span>#{r.part_number} · </span> : null}
                  {unitLabel(r) ? <span>{unitLabel(r)} · </span> : null}
                  {r.requested_by_name ? <span>{r.requested_by_name} · </span> : null}
                  Pref: {vendorLabel(r.vendor_preference)}
                  {r.ordered_from ? ` · From ${vendorLabel(r.ordered_from)}` : ""}
                </p>
                {r.notes ? <p className="parts-order-notes">{r.notes}</p> : null}
                {r.order_note ? (
                  <p className="parts-order-notes">
                    <strong>Order note:</strong> {r.order_note}
                  </p>
                ) : null}
                <p className="parts-order-dates muted">
                  Added {formatWhen(r.created_at)}
                  {r.ordered_at ? ` · Ordered ${formatWhen(r.ordered_at)}` : ""}
                  {r.arriving_at ? ` · Arriving ${formatWhen(r.arriving_at)}` : ""}
                  {r.received_at ? ` · Received ${formatWhen(r.received_at)}` : ""}
                </p>

                <div className="parts-order-progress" aria-hidden>
                  {(["needed", "ordered", "arriving", "received"] as const).map((step, i, arr) => {
                    const order = ["needed", "ordered", "arriving", "received"];
                    const cur = order.indexOf(r.status);
                    const si = order.indexOf(step);
                    const done = r.status !== "cancelled" && cur >= si;
                    const active = r.status === step;
                    return (
                      <span
                        key={step}
                        className={`parts-order-pip${done ? " is-done" : ""}${
                          active ? " is-active" : ""
                        }`}
                      >
                        {statusLabel(step)}
                        {i < arr.length - 1 ? <span className="parts-order-pip-line" /> : null}
                      </span>
                    );
                  })}
                </div>

                {statusEditId === r.id ? (
                  <form className="form" onSubmit={submitStatus} style={{ marginTop: "0.55rem" }}>
                    <p style={{ margin: 0, fontWeight: 700 }}>
                      Mark as {statusLabel(statusNext).toLowerCase()}
                    </p>
                    {(statusNext === "ordered" || statusNext === "arriving") && (
                      <label>
                        Ordered from
                        <select
                          value={orderedFrom}
                          onChange={(e) =>
                            setOrderedFrom(e.target.value as "autozone" | "firstcall" | "other")
                          }
                        >
                          <option value="autozone">AutoZone Pro</option>
                          <option value="firstcall">First Call Online</option>
                          <option value="other">Other</option>
                        </select>
                      </label>
                    )}
                    <label>
                      Note <span className="muted">(invoice #, ETA, counter person…)</span>
                      <input
                        value={orderNote}
                        onChange={(e) => setOrderNote(e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                    <div className="toolbar">
                      <button className="btn btn-sm" type="submit" disabled={actingId === r.id}>
                        {actingId === r.id ? "Saving…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        onClick={() => setStatusEditId(null)}
                      >
                        Back
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="toolbar parts-order-actions">
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      onClick={() => void copyText(copyPayload)}
                    >
                      Copy part
                    </button>
                    <a
                      className="btn secondary btn-sm"
                      href={vendorHref("autozone")}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => prepareVendorOpen(vehicleForOrder(r))}
                    >
                      AutoZone
                    </a>
                    <a
                      className="btn secondary btn-sm"
                      href={vendorHref("firstcall")}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => prepareVendorOpen(vehicleForOrder(r))}
                    >
                      First Call
                    </a>
                    {canEdit && r.status === "needed" && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => openStatus(r, "ordered")}
                      >
                        Mark ordered
                      </button>
                    )}
                    {canEdit && (r.status === "needed" || r.status === "ordered") && (
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        onClick={() => openStatus(r, "arriving")}
                      >
                        Arriving
                      </button>
                    )}
                    {canEdit &&
                      (r.status === "needed" ||
                        r.status === "ordered" ||
                        r.status === "arriving") && (
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          onClick={() => openStatus(r, "received")}
                        >
                          Received
                        </button>
                      )}
                    {canEdit &&
                      r.status !== "received" &&
                      r.status !== "cancelled" &&
                      (r.user_id === user?.id ||
                        user?.role === "admin" ||
                        user?.role === "office") && (
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={actingId === r.id}
                          onClick={() => void cancelOrder(r.id)}
                        >
                          Cancel
                        </button>
                      )}
                  </div>
                )}
              </article>
            );
          })
        )}
      </section>
    </div>
  );
}
