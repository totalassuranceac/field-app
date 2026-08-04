import { FormEvent, useCallback, useEffect, useState } from "react";
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
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [fromPickup, setFromPickup] = useState(false);

  const [vendor, setVendor] = useState("");
  const [summary, setSummary] = useState("");
  const [forUnit, setForUnit] = useState("");
  const [notes, setNotes] = useState("");
  const [partSlots, setPartSlots] = useState<{ code: string; name: string; qty: string }[]>([
    { code: "", name: "", qty: "1" },
  ]);

  // Prefill from Part pickup "Picked up" → drop-off handoff
  useEffect(() => {
    const from = searchParams.get("from");
    const v = (searchParams.get("vendor") || "").trim();
    const part = (searchParams.get("part") || "").trim();
    const address = (searchParams.get("address") || "").trim();
    const contact = (searchParams.get("contact") || "").trim();
    const qty = (searchParams.get("qty") || "1").trim() || "1";
    if (from !== "pickup" && !v && !part) return;

    if (v) setVendor(v);
    if (part) {
      setSummary(part);
      setPartSlots([{ code: "", name: part, qty }]);
    }
    const noteBits = [
      address ? `Job / address: ${address}` : "",
      contact ? `Contact: ${contact}` : "",
      "Dropped after vendor pickup",
    ].filter(Boolean);
    setNotes(noteBits.join(" · "));
    setShowForm(true);
    setFromPickup(true);
    setOk(
      part
        ? `Picked up selected: ${part}. Confirm where you’re dropping it off, then save.`
        : "Picked up — confirm drop-off details, then save."
    );

    // Clear query so a refresh doesn’t re-apply forever
    const next = new URLSearchParams(searchParams);
    ["from", "vendor", "part", "address", "contact", "qty", "pickup_id", "line_id"].forEach((k) =>
      next.delete(k)
    );
    setSearchParams(next, { replace: true });
    window.setTimeout(() => {
      document.getElementById("dropoff-form")?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 80);
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
    const d = await api<{
      dropoffs: Dropoff[];
      waiting?: number;
      error?: string;
    }>(`/inventory/parts-dropoffs?status=${filter === "waiting" ? "waiting" : "all"}`);
    setList(d.dropoffs || []);
    setWaiting(d.waiting ?? 0);
    if (d.error) setError(d.error);
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
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
        }),
      });
      setOk("Logged — warehouse can see these parts are at the shop.");
      setVendor("");
      setSummary("");
      setForUnit("");
      setNotes("");
      setPartSlots([{ code: "", name: "", qty: "1" }]);
      setShowForm(false);
      setFilter("waiting");
      await load();
      window.dispatchEvent(new CustomEvent("parts-dropoffs-changed"));
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
              Log vendor parts left at the shop ·{" "}
              <Link to="/part-pickup">Still at the store?</Link>
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

      {showForm && (
        <form
          className={`card form vendor-run-form dense-form${fromPickup ? " parts-dropoff-from-pickup" : ""}`}
          onSubmit={submit}
          id="dropoff-form"
        >
          <h3 className="dense-form-title">
            {fromPickup ? "Where are you dropping this off?" : "Log drop-off"}
          </h3>
          <div className="dense-form-grid">
            <label>
              Vendor
              <input
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Carrier, Lennox, ACE…"
                required
                list="parts-dropoff-vendors"
              />
              <datalist id="parts-dropoff-vendors">
                <option value="Carrier" />
                <option value="Lennox" />
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
              Unit / job <span className="muted">(opt.)</span>
              <input
                value={forUnit}
                onChange={(e) => setForUnit(e.target.value)}
                placeholder="Unit 012 · address"
              />
            </label>
            <label>
              Where left <span className="muted">(opt.)</span>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Counter · cage…"
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
          list.map((d) => (
            <article key={d.id} className={`card parts-dropoff-card st-${d.status}`}>
              <div className="parts-dropoff-card-head">
                <div className="parts-dropoff-card-title">
                  <strong className="parts-dropoff-vendor">{d.vendor_name}</strong>
                  <span
                    className={`pp-status-pill st-${
                      d.status === "waiting"
                        ? "pending"
                        : d.status === "received"
                          ? "picked"
                          : "cancelled"
                    }`}
                  >
                    {d.status === "waiting"
                      ? "At shop"
                      : d.status === "received"
                        ? "Received"
                        : "Cancelled"}
                  </span>
                  <span className="muted parts-dropoff-when">
                    {String(d.created_at).replace("T", " ").slice(5, 16)}
                    {d.dropped_by_name ? ` · ${d.dropped_by_name}` : ""}
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
              </div>
              <p className="parts-dropoff-summary">
                {d.part_summary}
                {(d.for_unit || d.notes) && (
                  <span className="muted parts-dropoff-meta">
                    {" · "}
                    {[d.for_unit ? `For ${d.for_unit}` : null, d.notes]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </p>
              {d.lines && d.lines.length > 0 && (
                <ul className="parts-dropoff-lines">
                  {d.lines.map((l) => (
                    <li key={l.id}>
                      <span className="parts-dropoff-qty">{l.qty}×</span>{" "}
                      {l.part_name || l.part_code || "Part"}
                      {l.part_code && l.part_name ? (
                        <span className="muted"> · {l.part_code}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {d.status === "received" && d.received_by_name && (
                <p className="muted parts-dropoff-received">
                  By {d.received_by_name}
                  {d.received_at
                    ? ` · ${String(d.received_at).replace("T", " ").slice(5, 16)}`
                    : ""}
                </p>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
}
