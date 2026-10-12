import { FormEvent, useCallback, useEffect, useState } from "react";
import { api, ApiError, OfflineQueuedError } from "../api";
import { BarcodeScanButton } from "./BarcodeScan";

type Truck = { id: number; unit_number: string; live: boolean };
type PartHit = { id: number; code: string | null; name: string };
type UsedEntry = {
  id: number;
  part_id: number | null;
  other_text: string | null;
  photo_key: string | null;
  qty: number;
  status: string;
  code: string | null;
  name: string | null;
  can_edit: boolean;
};
type Restock = { id: number; unit_number?: string; usage_date: string; status: string };

function qtyText(n: unknown): string {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return String(Math.round(x * 1000) / 1000);
}

function savedNote(status: string | undefined, mode: "part" | "other"): string {
  if (status === "pending") return "Saved. It stays on the usage history. The count will not take it off.";
  if (mode === "other" || status === "needs_match") return "Saved. Warehouse will match this to a real part.";
  return "Saved. Taken off your truck.";
}

function newToken(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `used-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Parts used on the open job. A live truck comes off on-hand.
 * A truck that is not counted yet keeps the line as history. Go-live does not take it off the physical count.
 */
export function PartsUsedPanel({
  jobRef,
  appointmentId,
  ask = false,
  onGate,
}: {
  jobRef: string;
  appointmentId: string | null;
  ask?: boolean;
  onGate?: (gate: { ready: boolean; hold: boolean }) => void;
}) {
  const job = jobRef.trim();
  const [open, setOpen] = useState(false);
  const [trucks, setTrucks] = useState<Truck[]>([]);
  const [vehicleId, setVehicleId] = useState(0);
  const [mode, setMode] = useState<"part" | "other">("part");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PartHit[]>([]);
  const [part, setPart] = useState<PartHit | null>(null);
  const [qty, setQty] = useState("1");
  const [otherText, setOtherText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [entries, setEntries] = useState<UsedEntry[]>([]);
  const [restocks, setRestocks] = useState<Restock[]>([]);
  const [editQty, setEditQty] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [trucksLoaded, setTrucksLoaded] = useState(false);
  const [noParts, setNoParts] = useState(false);

  const loadEntries = useCallback(async () => {
    if (!job) return;
    const res = await api<{ entries: UsedEntry[] }>(
      `/inventory/live/used?job_ref=${encodeURIComponent(job)}`
    );
    setEntries(res.entries || []);
  }, [job]);

  const loadRestocks = useCallback(async () => {
    const res = await api<{ restocks: Restock[] }>("/inventory/live/restocks?mine=1");
    setRestocks(res.restocks || []);
  }, []);

  useEffect(() => {
    if (!job) return;
    let cancel = false;
    setTrucksLoaded(false);
    setNoParts(false);
    void (async () => {
      try {
        const res = await api<{ trucks: Truck[] }>("/inventory/live/my-truck");
        if (cancel) return;
        const list = res.trucks || [];
        setTrucks(list);
        if (list.length === 1) setVehicleId(list[0].id);
        else if (list.filter((t) => t.live).length === 1) {
          const only = list.find((t) => t.live);
          if (only) setVehicleId(only.id);
        }
      } catch (e) {
        if (!cancel) setError(e instanceof Error ? e.message : "Could not load your truck.");
      } finally {
        if (!cancel) setTrucksLoaded(true);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [job]);

  useEffect(() => {
    if (ask) setOpen(true);
  }, [ask]);

  useEffect(() => {
    if (!job) {
      onGate?.({ ready: true, hold: false });
      return;
    }
    onGate?.({
      ready: !ask || trucksLoaded,
      hold: Boolean(ask && trucksLoaded && trucks.length > 0 && entries.length === 0 && !noParts),
    });
  }, [job, ask, trucksLoaded, trucks.length, entries.length, noParts, onGate]);

  useEffect(() => {
    if (!job) return;
    void loadEntries().catch((e) => setError(e instanceof Error ? e.message : "Could not load parts used."));
    void loadRestocks().catch(() => {
      /* confirm banner is optional when the list fails */
    });
  }, [job, loadEntries, loadRestocks]);

  const chosen = trucks.find((t) => t.id === vehicleId) || null;

  async function search(query: string) {
    const text = query.trim();
    setQ(text);
    setPart(null);
    if (text.length < 2) {
      setHits([]);
      return;
    }
    try {
      const res = await api<{ parts: PartHit[] }>(`/inventory/live/parts?q=${encodeURIComponent(text)}`);
      setHits(res.parts || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    }
  }

  async function scan(code: string) {
    setError("");
    setOk("");
    setMode("part");
    try {
      const res = await api<{ parts: PartHit[] }>(
        `/inventory/parts/lookup?code=${encodeURIComponent(code)}`
      );
      const hit = (res.parts || [])[0];
      if (!hit) {
        setError("No part found for that code.");
        setQ(code);
        setHits([]);
        return;
      }
      setPart({ id: hit.id, code: hit.code, name: hit.name });
      setQ(hit.code || hit.name || code);
      setHits([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    }
  }

  function noteSaved(e: unknown): boolean {
    if (e instanceof OfflineQueuedError) {
      setError("");
      setOk(e.message);
      setPart(null);
      setOtherText("");
      setFile(null);
      setQty("1");
      setHits([]);
      return true;
    }
    setError(e instanceof Error ? e.message : "Could not save parts used.");
    return false;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    setOk("");
    if (!chosen) {
      setError(
        trucks.length
          ? "More than one truck is assigned to you. Pick the truck."
          : "No truck is assigned to you in Field App."
      );
      return;
    }
    const n = Number(qty);
    if (!Number.isFinite(n) || n <= 0) {
      setError("Enter a quantity.");
      return;
    }
    if (mode === "other" && otherText.trim().length < 2) {
      setError("Search a part, or describe Other.");
      return;
    }
    if (mode === "other" && !file) {
      setError("Other needs a photo.");
      return;
    }
    if (mode === "part" && !part) {
      setError("Search a part, or describe Other.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "other" && file) {
        const fd = new FormData();
        fd.set("other_text", otherText.trim());
        fd.set("qty", String(n));
        fd.set("job_ref", job);
        if (appointmentId) fd.set("st_appointment_id", appointmentId);
        fd.set("vehicle_id", String(chosen.id));
        fd.set("client_token", newToken());
        fd.set("file", file);
        const saved = await api<{ status?: string }>("/inventory/live/used", { method: "POST", body: fd });
        setOk(savedNote(saved.status, mode));
      } else if (part) {
        const saved = await api<{ status?: string }>("/inventory/live/used", {
          method: "POST",
          body: JSON.stringify({
            part_id: part.id,
            qty: n,
            job_ref: job,
            st_appointment_id: appointmentId,
            vehicle_id: chosen.id,
            client_token: newToken(),
          }),
        });
        setOk(savedNote(saved.status, mode));
      }
      setPart(null);
      setOtherText("");
      setFile(null);
      setQty("1");
      setHits([]);
      await loadEntries();
    } catch (e) {
      if (e instanceof ApiError && e.data && typeof e.data === "object") {
        const choices = (e.data as { choices?: Truck[] }).choices;
        if (choices?.length) setTrucks(choices);
      }
      if (!noteSaved(e)) {
        /* error already set */
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id: number) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/used/${id}/edit`, {
        method: "POST",
        body: JSON.stringify({ qty: editQty[id] }),
      });
      setOk("Updated.");
      await loadEntries();
    } catch (e) {
      noteSaved(e);
    } finally {
      setBusy(false);
    }
  }

  async function undo(id: number) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/used/${id}/void`, { method: "POST", body: "{}" });
      setOk("Undone.");
      await loadEntries();
    } catch (e) {
      noteSaved(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmBin(id: number) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/restocks/${id}/confirm`, { method: "POST", body: "{}" });
      setOk("Bin confirmed.");
      await loadRestocks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm the bin.");
    } finally {
      setBusy(false);
    }
  }

  if (!job) return null;

  return (
    <div className="card" style={{ marginBottom: "0.75rem" }}>
      {restocks.map((r) => (
        <div key={r.id} role="status" style={{ marginBottom: 8 }}>
          <strong>Restock is on your truck. Confirm the bin.</strong>
          <div className="muted">
            Unit {r.unit_number || ""} - {r.usage_date}
          </div>
          <button
            type="button"
            className="btn btn-sm"
            style={{ marginTop: 6 }}
            disabled={busy}
            onClick={() => void confirmBin(r.id)}
          >
            Confirm the bin
          </button>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide parts used" : `Parts used${entries.length ? ` (${entries.length})` : ""}`}
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {ask && (
            <p className="muted">
              Save what you used before you finish. If this stop used nothing, tap No parts on this stop.
            </p>
          )}
          {error && <div className="error inv-flash">{error}</div>}
          {ok && <div className="success inv-flash">{ok}</div>}
          {!trucks.length && (
            <p className="muted">No truck is assigned to you in Field App.</p>
          )}
          {chosen && !chosen.live && (
            <p className="muted">
              This truck is not counted yet. The part is saved for the restock list. The count stays what is on the truck.
            </p>
          )}
          {trucks.length > 1 && (
            <label className="muted" style={{ display: "block", marginBottom: 8 }}>
              Truck
              <select
                value={vehicleId || ""}
                onChange={(e) => setVehicleId(Number(e.target.value))}
                style={{ display: "block", marginTop: 4, width: "100%" }}
              >
                <option value="">Pick the truck</option>
                {trucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.unit_number}
                    {t.live ? "" : " - not counted yet"}
                  </option>
                ))}
              </select>
            </label>
          )}
          {chosen?.live && (
            <p className="muted">Comes off unit {chosen.unit_number}.</p>
          )}
          <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
            <button
              type="button"
              className={mode === "part" ? "btn btn-sm" : "btn secondary btn-sm"}
              onClick={() => setMode("part")}
            >
              Pricebook
            </button>
            <button
              type="button"
              className={mode === "other" ? "btn btn-sm" : "btn secondary btn-sm"}
              onClick={() => setMode("other")}
            >
              Other
            </button>
          </div>
          <form onSubmit={(e) => void submit(e)}>
            {mode === "part" ? (
              <>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  <BarcodeScanButton label="Scan" disabled={busy} onCode={(code) => void scan(code)} />
                  <input
                    type="search"
                    value={q}
                    placeholder="Search part"
                    onChange={(e) => void search(e.target.value)}
                    style={{ flex: "1 1 140px" }}
                  />
                </div>
                {part && (
                  <p>
                    <strong>{part.code ? `${part.code} - ` : ""}{part.name}</strong>
                  </p>
                )}
                {hits.length > 0 && !part && (
                  <ul style={{ listStyle: "none", padding: 0 }}>
                    {hits.map((h) => (
                      <li key={h.id}>
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          style={{ marginBottom: 4 }}
                          onClick={() => {
                            setPart(h);
                            setHits([]);
                          }}
                        >
                          {h.code ? `${h.code} - ` : ""}
                          {h.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <>
                <label className="muted" style={{ display: "block" }}>
                  What was it?
                  <input
                    value={otherText}
                    onChange={(e) => setOtherText(e.target.value)}
                    style={{ display: "block", width: "100%", marginTop: 4 }}
                  />
                </label>
                <label className="muted" style={{ display: "block", marginTop: 8 }}>
                  Photo (required)
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    style={{ display: "block", marginTop: 4 }}
                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                  />
                </label>
              </>
            )}
            <label className="muted" style={{ display: "block", marginTop: 8 }}>
              Qty
              <input
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                style={{ display: "block", width: 100, marginTop: 4 }}
              />
            </label>
            <button className="btn" type="submit" disabled={busy || !chosen} style={{ marginTop: 8 }}>
              {busy ? "Saving..." : "Save parts used"}
            </button>
            {ask && trucks.length > 0 && entries.length === 0 && (
              <button
                type="button"
                className="btn secondary"
                style={{ marginTop: 8, marginLeft: 8 }}
                disabled={busy}
                onClick={() => setNoParts(true)}
              >
                No parts on this stop
              </button>
            )}
            {noParts && entries.length === 0 && (
              <p className="muted">No parts on this stop. You can finish.</p>
            )}
          </form>
          <ul style={{ listStyle: "none", padding: 0, marginTop: 12 }}>
            {entries.map((row) => (
              <li key={row.id} style={{ marginBottom: 10 }}>
                <div>
                  {row.name || row.other_text || "Part"}{" "}
                  {row.code ? <span className="muted">{row.code}</span> : null}
                  {" - "}
                  {qtyText(row.qty)}
                  {row.status === "pending" ? (
                    <span className="muted"> - Saved. It stays on the usage history. The count will not take it off.</span>
                  ) : row.status === "needs_match" ? (
                    <span className="muted"> - Waiting for warehouse to match this.</span>
                  ) : null}
                </div>
                {row.photo_key ? (
                  <img
                    src={`/api/uploads/${row.photo_key}`}
                    alt="Part photo"
                    style={{ maxWidth: 160, marginTop: 4 }}
                  />
                ) : null}
                {row.can_edit ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                    <input
                      inputMode="decimal"
                      value={editQty[row.id] ?? qtyText(row.qty)}
                      onChange={(e) => setEditQty((m) => ({ ...m, [row.id]: e.target.value }))}
                      style={{ width: 80 }}
                    />
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={busy}
                      onClick={() => void saveEdit(row.id)}
                    >
                      Update qty
                    </button>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={busy}
                      onClick={() => void undo(row.id)}
                    >
                      Undo
                    </button>
                  </div>
                ) : (
                  <p className="muted">Warehouse can change this after 24 hours.</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
