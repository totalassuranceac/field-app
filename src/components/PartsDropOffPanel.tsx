import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
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

  const [vendor, setVendor] = useState("");
  const [summary, setSummary] = useState("");
  const [forUnit, setForUnit] = useState("");
  const [notes, setNotes] = useState("");
  const [partSlots, setPartSlots] = useState<{ code: string; name: string; qty: string }[]>([
    { code: "", name: "", qty: "1" },
  ]);

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
    <div className={`vendor-run-panel parts-dropoff-panel${compact ? " is-compact" : ""}`}>
      {!compact && (
        <div className="page-header vendor-run-page-head">
          <div>
            <h2 style={{ margin: 0 }}>Parts drop-off</h2>
            <p style={{ margin: "0.25rem 0 0" }}>
              Picked up parts from a vendor while you were out? Log them here so warehouse knows
              they’re <strong>at the shop</strong> and ready to put away or issue to a truck.
              {" "}
              Still at the vendor? Use <Link to="/part-pickup">Part pickup</Link> instead.
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
              All recent
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
        <form className="card form vendor-run-form" onSubmit={submit}>
          <h3 style={{ marginTop: 0 }}>I brought parts to the shop</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.85rem" }}>
            Use this after you pick up at Carrier, Lennox, ACE, etc. and leave the parts at the
            warehouse counter (or anywhere warehouse can grab them).
          </p>
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
            What’s in the drop-off?{" "}
            <span className="muted">(required if you don’t fill part lines)</span>
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="e.g. TXV, 2 ton blower motor, or 3/4 soft copper"
            />
          </label>
          <label>
            For unit / job <span className="muted">(optional)</span>
            <input
              value={forUnit}
              onChange={(e) => setForUnit(e.target.value)}
              placeholder="Unit 012 · job address · ticket #"
            />
          </label>

          <div className="pp-lines-edit">
            <div className="pp-lines-edit-head">
              <strong style={{ fontSize: "0.9rem" }}>Part lines (optional)</strong>
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
              <div key={i} className="pp-line-fields" style={{ marginBottom: "0.35rem" }}>
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

          <label>
            Notes <span className="muted">(where you left them, etc.)</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="On the counter by the door · in the cage…"
            />
          </label>

          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Saving…" : "Log drop-off at shop"}
            </button>
          </div>
        </form>
      )}

      <div className="vendor-run-list">
        {!list.length ? (
          <div className="card muted">
            {filter === "waiting"
              ? "Nothing waiting at the shop. Log a drop-off when you bring parts in."
              : "No recent drop-offs."}
          </div>
        ) : (
          list.map((d) => (
            <article key={d.id} className={`card parts-dropoff-card st-${d.status}`}>
              <div className="parts-dropoff-card-head">
                <div>
                  <strong className="parts-dropoff-vendor">{d.vendor_name}</strong>
                  <span className={`pp-status-pill st-${d.status === "waiting" ? "pending" : d.status === "received" ? "picked" : "cancelled"}`}>
                    {d.status === "waiting"
                      ? "At shop"
                      : d.status === "received"
                        ? "Received"
                        : "Cancelled"}
                  </span>
                </div>
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  {String(d.created_at).replace("T", " ").slice(0, 16)}
                  {d.dropped_by_name ? ` · ${d.dropped_by_name}` : ""}
                </span>
              </div>
              <p className="parts-dropoff-summary">{d.part_summary}</p>
              {(d.for_unit || d.notes) && (
                <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
                  {[d.for_unit ? `For: ${d.for_unit}` : null, d.notes].filter(Boolean).join(" · ")}
                </p>
              )}
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
                <p className="muted" style={{ margin: "0.4rem 0 0", fontSize: "0.8rem" }}>
                  Received by {d.received_by_name}
                  {d.received_at
                    ? ` · ${String(d.received_at).replace("T", " ").slice(0, 16)}`
                    : ""}
                </p>
              )}
              {d.status === "waiting" && (
                <div className="toolbar" style={{ marginTop: "0.65rem" }}>
                  {canReceive && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={actingId === d.id}
                      onClick={() => void markReceived(d.id)}
                    >
                      {actingId === d.id ? "Saving…" : "Received · ready to issue"}
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
            </article>
          ))
        )}
      </div>
    </div>
  );
}
