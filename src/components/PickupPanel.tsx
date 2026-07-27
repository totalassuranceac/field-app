import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { LogItem, LogList } from "./CollapsibleLog";
import { BarcodeScanButton } from "./BarcodeScan";

interface Loc {
  id: number;
  type: string;
  name: string;
  unit_number?: string | null;
}

interface Peer {
  id: number;
  display_name: string;
  role: string;
}

interface ScanPart {
  id: number;
  code: string;
  name: string;
  total_qty?: number;
  image_url?: string | null;
}

interface Line {
  part_id: number;
  code: string;
  name: string;
  qty: number;
}

interface Pickup {
  id: number;
  request_number: string;
  status: string;
  requested_by_name?: string;
  for_user_name?: string | null;
  picked_up_by_name?: string | null;
  handed_to_name?: string | null;
  handed_over_by_name?: string | null;
  dest_name?: string | null;
  dest_unit?: string | null;
  destination_location_id?: number | null;
  for_user_id?: number | null;
  handed_to_user_id?: number | null;
  created_at: string;
  picked_up_at?: string | null;
  handed_over_at?: string | null;
  lines: Array<{
    id: number;
    part_id: number;
    qty: number;
    code: string;
    name: string;
  }>;
}

export function PickupPanel({
  locations,
  canManage,
}: {
  locations: Loc[];
  canManage: boolean;
}) {
  const { user } = useAuth();
  const scanRef = useRef<HTMLInputElement>(null);
  const [pickups, setPickups] = useState<Pickup[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [scan, setScan] = useState("");
  const [hits, setHits] = useState<ScanPart[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<"open" | "all">("open");
  /** Tech these parts are for (warehouse issue) */
  const [forTech, setForTech] = useState("");
  /** Per pickup: warehouse “handed to” choice */
  const [handTo, setHandTo] = useState<Record<number, string>>({});
  /** Per pickup: truck the receiver is putting stock on */
  const [handTruck, setHandTruck] = useState<Record<number, string>>({});
  /** Truck barcode scan field per pickup (or global when one selected) */
  const [truckScan, setTruckScan] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    const [p, u] = await Promise.all([
      api<{ pickups: Pickup[] }>(`/inventory/pickups?status=${filter}`),
      api<{ users: Peer[] }>("/messages/users").catch(() => ({ users: [] as Peer[] })),
    ]);
    setPickups(p.pickups || []);
    setPeers(u.users || []);
  }, [filter]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  useEffect(() => {
    scanRef.current?.focus();
  }, []);

  async function lookupAndAdd(code: string) {
    const q = code.trim();
    if (!q) return;
    setError("");
    try {
      const d = await api<{ parts: ScanPart[]; query: string }>(
        `/inventory/parts/lookup?code=${encodeURIComponent(q)}`
      );
      const list = d.parts || [];
      if (!list.length) {
        setError(`No part matched “${q}”`);
        setHits([]);
        return;
      }
      if (list.length === 1) {
        addLine(list[0], 1);
        setScan("");
        setHits([]);
        scanRef.current?.focus();
        return;
      }
      setHits(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    }
  }

  function addLine(p: ScanPart, qty: number) {
    setLines((prev) => {
      const i = prev.findIndex((l) => l.part_id === p.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = { ...next[i], qty: next[i].qty + qty };
        return next;
      }
      return [...prev, { part_id: p.id, code: p.code, name: p.name, qty }];
    });
    setOk(`Added ${p.code} — ${p.name}`);
  }

  function onScanKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void lookupAndAdd(scan);
    }
  }

  async function createPickup(e: FormEvent) {
    e.preventDefault();
    if (!lines.length) {
      setError("Scan or add at least one part.");
      return;
    }
    // Warehouse default: issue for a tech, then scan truck to transfer
    if (canManage && !forTech) {
      setError("Select the tech these parts are for, then save the issue.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const techId = forTech ? Number(forTech) : undefined;
      const r = await api<{
        request_number: string;
        staged?: boolean;
        status?: string;
      }>("/inventory/pickups", {
        method: "POST",
        body: JSON.stringify({
          notes: notes || undefined,
          for_user_id: techId || undefined,
          stage_for_tech: canManage && !!techId,
          lines: lines.map((l) => ({ part_id: l.part_id, qty: l.qty })),
        }),
      });
      const techName = peers.find((p) => String(p.id) === forTech)?.display_name;
      setOk(
        r.staged
          ? `Issue ${r.request_number} staged for ${techName || "tech"}. Scan their truck barcode (or unit #) below to move stock.`
          : `List ${r.request_number} saved. Warehouse records who received them, then truck is chosen.`
      );
      setLines([]);
      setScan("");
      setNotes("");
      if (canManage) setForTech("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create pickup");
    } finally {
      setBusy(false);
    }
  }

  /** Scan unit # / truck barcode → move all lines for this issue onto that vehicle. */
  async function completeByTruckScan(pickupId: number, code: string) {
    const raw = code.trim();
    if (!raw) {
      setError("Scan or type the truck unit number.");
      return;
    }
    const p = pickups.find((x) => x.id === pickupId);
    if (!p) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      // Resolve label for confirm (optional)
      let label = raw;
      try {
        const loc = await api<{
          locations: Array<{ id: number; label?: string; unit_number?: string | null }>;
        }>(`/inventory/locations/lookup?code=${encodeURIComponent(raw)}`);
        if (loc.locations?.[0]) {
          label =
            loc.locations[0].label ||
            (loc.locations[0].unit_number
              ? `Unit ${loc.locations[0].unit_number}`
              : raw);
        }
      } catch {
        /* complete endpoint will validate */
      }
      const person =
        p.handed_to_name ||
        p.for_user_name ||
        peers.find((x) => x.id === p.for_user_id)?.display_name ||
        "tech";
      if (
        !confirm(
          `Transfer ${p.request_number} to ${label}?\n\nTech: ${person}\n${(p.lines || []).length} part line(s) move from warehouse to that truck.`
        )
      ) {
        setBusy(false);
        return;
      }
      const body: Record<string, unknown> = { truck_code: raw };
      // Open lists need receiver; staged ready already has handed_to
      if (p.status === "open") {
        const toUser = Number(handTo[p.id] || p.for_user_id || 0);
        if (!toUser) {
          setError("Select who receives these parts (or stage the issue for a tech first).");
          setBusy(false);
          return;
        }
        body.handed_to_user_id = toUser;
      }
      const r = await api<{
        custody?: { handed_over_by: string; handed_to: string; truck: string };
      }>(`/inventory/pickups/${pickupId}/complete`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setOk(
        r.custody
          ? `Transferred to ${r.custody.truck}: ${r.custody.handed_to} · ${p.request_number}`
          : `Stock moved · ${p.request_number}`
      );
      setTruckScan((prev) => ({ ...prev, [pickupId]: "" }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Truck transfer failed");
    } finally {
      setBusy(false);
    }
  }

  /** Step 1: warehouse only — who received the parts (custody starts). */
  async function handOver(id: number) {
    if (!canManage) {
      setError("Only warehouse/admin can record who received the parts.");
      return;
    }
    const toUser = Number(handTo[id] || 0);
    if (!toUser) {
      setError("Select who you handed the parts to.");
      return;
    }
    const person = peers.find((p) => p.id === toUser)?.display_name || "receiver";
    if (
      !confirm(
        `Transfer custody to ${person}?\n\nThey become responsible until the parts are put on a truck.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{
        custody?: { handed_over_by: string; handed_to: string };
      }>(`/inventory/pickups/${id}/hand-over`, {
        method: "POST",
        body: JSON.stringify({ handed_to_user_id: toUser }),
      });
      setOk(
        r.custody
          ? `Custody with ${r.custody.handed_to} (from ${r.custody.handed_over_by}). Now choose which truck stock.`
          : "Handed over — receiver should choose the truck next."
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Handoff failed");
    } finally {
      setBusy(false);
    }
  }

  /** Step 2: receiver (or warehouse) puts parts on truck stock — stock moves. */
  async function putOnTruck(id: number, opts?: { oneShot?: boolean }) {
    const truck = Number(handTruck[id] || 0);
    if (!truck) {
      setError("Select which truck stock these parts are going on.");
      return;
    }
    const p = pickups.find((x) => x.id === id);
    const toUser = opts?.oneShot ? Number(handTo[id] || 0) : Number(p?.handed_to_user_id || 0);
    if (opts?.oneShot && !toUser) {
      setError("Select who you handed the parts to, then the truck.");
      return;
    }
    if (!canManage && user?.id !== (p?.handed_to_user_id || toUser)) {
      setError("Only the person who received the parts (or warehouse) can put them on a truck.");
      return;
    }

    const person =
      peers.find((x) => x.id === (toUser || p?.handed_to_user_id))?.display_name ||
      p?.handed_to_name ||
      "receiver";
    const unit = trucks.find((l) => l.id === truck);
    const unitLabel = unit?.unit_number ? `Unit ${unit.unit_number}` : unit?.name || "truck";
    if (
      !confirm(
        `Lock custody chain:\n\nHanded to: ${person}\nGoes on: ${unitLabel}\n\nStock moves to that truck. If parts go missing later, start with ${person} / ${unitLabel}.`
      )
    ) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body: Record<string, number> = { destination_location_id: truck };
      if (opts?.oneShot && toUser) body.handed_to_user_id = toUser;
      const r = await api<{
        custody?: { handed_over_by: string; handed_to: string; truck: string };
      }>(`/inventory/pickups/${id}/complete`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setOk(
        r.custody
          ? `Custody locked: ${r.custody.handed_over_by} → ${r.custody.handed_to} → ${r.custody.truck}.`
          : "Handoff complete — stock moved, custody recorded."
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Complete failed");
    } finally {
      setBusy(false);
    }
  }

  const trucks = locations.filter((l) => l.type === "vehicle");

  function canPutOnTruck(p: Pickup): boolean {
    if (canManage) return true;
    return !!user?.id && user.id === p.handed_to_user_id;
  }

  function statusLabel(status: string): string {
    if (status === "ready") return "ready for truck";
    return status.replace("_", " ");
  }

  return (
    <div className="pickup-panel">
      <div className="page-header no-print" style={{ marginBottom: "0.75rem" }}>
        <div>
          <h2 style={{ marginTop: 0 }}>
            {canManage ? "Issue to tech / truck" : "Pickup / transfer of custody"}
          </h2>
          <p style={{ margin: 0 }}>
            {canManage ? (
              <>
                Scan all parts for a tech → <strong>Stage issue</strong> → scan their{" "}
                <strong>truck unit barcode</strong> to move stock onto that vehicle.
              </>
            ) : (
              <>
                Scan parts → warehouse records who received them → choose truck stock.
              </>
            )}
          </p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <form className="card pickup-build" onSubmit={createPickup}>
        <h3 className="inv-section-title" style={{ marginTop: 0 }}>
          {canManage ? "1 · Issue parts for a tech" : "1 · Build list (scan parts)"}
        </h3>
        {canManage && (
          <label>
            Tech (parts go with them) *
            <select
              value={forTech}
              onChange={(e) => setForTech(e.target.value)}
              required
            >
              <option value="">Select tech…</option>
              {peers
                .filter((p) => p.role === "driver" || p.role === "mechanic" || p.role === "admin")
                .map((peer) => (
                  <option key={peer.id} value={peer.id}>
                    {peer.display_name}
                    {peer.role === "driver" ? " (field)" : ` (${peer.role})`}
                  </option>
                ))}
              {/* Fallback: all peers if filter empty */}
              {!peers.some((p) => p.role === "driver") &&
                peers.map((peer) => (
                  <option key={`all-${peer.id}`} value={peer.id}>
                    {peer.display_name} ({peer.role})
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Scan part barcode / type part #
          <input
            ref={scanRef}
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            onKeyDown={onScanKey}
            placeholder="Scan parts into this issue — Enter adds"
            autoComplete="off"
            enterKeyHint="search"
          />
        </label>
        <div className="pickup-scan-actions">
          <BarcodeScanButton
            disabled={busy}
            label="Scan part"
            onCode={(code) => {
              setScan(code);
              void lookupAndAdd(code);
            }}
          />
          <button
            type="button"
            className="btn secondary"
            disabled={busy || !scan.trim()}
            onClick={() => void lookupAndAdd(scan)}
          >
            Add typed code
          </button>
        </div>
        <p className="muted" style={{ fontSize: "0.78rem", margin: "0.25rem 0 0.5rem" }}>
          {canManage
            ? "Add every part for this tech’s job. When the pile is ready, stage the issue — then scan the truck to transfer stock."
            : "Use camera scan, a USB scanner + Enter, or type the part #."}
        </p>
        {hits.length > 1 && (
          <ul className="pickup-hits">
            {hits.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => {
                    addLine(p, 1);
                    setHits([]);
                    setScan("");
                    scanRef.current?.focus();
                  }}
                >
                  {p.code} — {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {lines.length > 0 && (
          <ul className="pickup-lines">
            {lines.map((l) => (
              <li key={l.part_id} className="pickup-line">
                <span>
                  <strong>{l.code}</strong> {l.name}
                </span>
                <input
                  type="number"
                  min={0.01}
                  step="any"
                  value={l.qty}
                  onChange={(e) => {
                    const q = Number(e.target.value) || 0;
                    setLines((prev) =>
                      prev.map((x) => (x.part_id === l.part_id ? { ...x, qty: q } : x))
                    );
                  }}
                  aria-label={`Qty ${l.code}`}
                />
                <button
                  type="button"
                  className="inv-vendor-remove"
                  aria-label="Remove"
                  onClick={() => setLines((prev) => prev.filter((x) => x.part_id !== l.part_id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <label>
          Note (optional)
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. job on Main St · ticket #"
          />
        </label>
        <p className="muted" style={{ fontSize: "0.8rem" }}>
          {canManage ? (
            <>
              Issued by <strong>{user?.display_name}</strong>. After staging, open the issue below
              and <strong>scan the truck unit #</strong> to move warehouse stock onto that vehicle.
            </>
          ) : (
            <>
              List by <strong>{user?.display_name}</strong>. Warehouse records handoff, then truck.
            </>
          )}
        </p>
        <button
          className="btn"
          type="submit"
          disabled={busy || !lines.length || (canManage && !forTech)}
        >
          {busy
            ? "Saving…"
            : canManage
              ? "Stage issue for tech"
              : "Save list — ready for handoff"}
        </button>
      </form>

      <div className="warranty-filters">
        <button
          type="button"
          className={`inv-tab${filter === "open" ? " active" : ""}`}
          onClick={() => setFilter("open")}
        >
          Open
        </button>
        <button
          type="button"
          className={`inv-tab${filter === "all" ? " active" : ""}`}
          onClick={() => setFilter("all")}
        >
          All
        </button>
      </div>

      <LogList className="pickup-list" empty="No open pickups.">
        {pickups.map((p) => {
          const receiverMode = p.status === "ready";
          const done = p.status === "picked_up";
          const showReceiverTruck = receiverMode && canPutOnTruck(p) && !canManage;
          const lineCount = (p.lines || []).length;
          const needsAction =
            ((p.status === "open" || p.status === "ready") && canManage) ||
            showReceiverTruck;

          return (
            <LogItem
              key={p.id}
              tone={done ? "done" : needsAction ? "warn" : undefined}
              defaultOpen={needsAction}
              summary={
                <>
                  <strong className="warranty-log">{p.request_number}</strong>
                  <span className="log-item-badge">{statusLabel(p.status)}</span>
                  <span className="log-item-meta">
                    {lineCount} part{lineCount === 1 ? "" : "s"}
                    {p.for_user_name
                      ? ` · for ${p.for_user_name}`
                      : p.handed_to_name
                        ? ` · ${p.handed_to_name}`
                        : p.requested_by_name
                          ? ` · ${p.requested_by_name}`
                          : ""}
                    {done && p.dest_unit
                      ? ` · Unit ${p.dest_unit}`
                      : done && p.dest_name
                        ? ` · ${p.dest_name}`
                        : ""}
                  </span>
                </>
              }
            >
              <div className="warranty-meta custody-chain">
                <div>
                  List by <strong>{p.requested_by_name || "—"}</strong>
                </div>
                {(receiverMode || done) && (
                  <div>
                    Handed by <strong>{p.handed_over_by_name || "warehouse"}</strong>
                    {" → "}
                    <strong>{p.handed_to_name || "—"}</strong>
                    {p.handed_over_at
                      ? ` · ${String(p.handed_over_at).replace("T", " ").slice(0, 16)}`
                      : ""}
                  </div>
                )}
                {done && (
                  <div>
                    On truck{" "}
                    <strong>
                      {p.dest_unit ? `Unit ${p.dest_unit}` : p.dest_name || "—"}
                    </strong>
                    {p.picked_up_at
                      ? ` · ${String(p.picked_up_at).replace("T", " ").slice(0, 16)}`
                      : ""}
                  </div>
                )}
              </div>
              <ul className="pickup-line-summary">
                {(p.lines || []).map((l) => (
                  <li key={l.id}>
                    {l.qty}× {l.code} — {l.name}
                  </li>
                ))}
              </ul>

              {done ? (
                <div className="pickup-custody-done">
                  Custody locked — if something is missing, start with{" "}
                  <strong>{p.handed_to_name || p.picked_up_by_name || "receiver"}</strong> / truck{" "}
                  <strong>{p.dest_unit ? `Unit ${p.dest_unit}` : p.dest_name}</strong>
                </div>
              ) : (p.status === "ready" || p.status === "open") &&
                (canManage || canPutOnTruck(p)) ? (
                <div className="pickup-truck-scan card" style={{ marginTop: "0.5rem" }}>
                  <h4 className="inv-section-title" style={{ margin: "0 0 0.35rem" }}>
                    {canManage ? "2 · Scan truck to transfer stock" : "Put on truck"}
                  </h4>
                  <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.45rem" }}>
                    Scan unit number barcode (e.g. <strong>001</strong>) or type it — all parts on
                    this issue move from warehouse to that truck.
                    {p.for_user_name || p.handed_to_name
                      ? ` Tech: ${p.handed_to_name || p.for_user_name}.`
                      : ""}
                  </p>
                  {p.status === "open" && canManage && (
                    <label style={{ display: "block", marginBottom: "0.45rem" }}>
                      Handed to *
                      <select
                        value={handTo[p.id] || (p.for_user_id ? String(p.for_user_id) : "")}
                        onChange={(e) =>
                          setHandTo((prev) => ({ ...prev, [p.id]: e.target.value }))
                        }
                      >
                        <option value="">Select person…</option>
                        {peers.map((peer) => (
                          <option key={peer.id} value={peer.id}>
                            {peer.display_name} ({peer.role})
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Truck unit # / barcode
                    <input
                      value={truckScan[p.id] || ""}
                      onChange={(e) =>
                        setTruckScan((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void completeByTruckScan(p.id, truckScan[p.id] || "");
                        }
                      }}
                      placeholder="Scan truck barcode or type 001"
                      autoComplete="off"
                      disabled={busy}
                    />
                  </label>
                  <div className="pickup-scan-actions" style={{ marginTop: "0.4rem" }}>
                    <BarcodeScanButton
                      disabled={busy}
                      label="Scan truck"
                      onCode={(code) => {
                        setTruckScan((prev) => ({ ...prev, [p.id]: code }));
                        void completeByTruckScan(p.id, code);
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || !(truckScan[p.id] || "").trim()}
                      onClick={() => void completeByTruckScan(p.id, truckScan[p.id] || "")}
                    >
                      Transfer to truck
                    </button>
                  </div>
                  <details className="pickup-oneshot" style={{ marginTop: "0.65rem" }}>
                    <summary className="muted" style={{ cursor: "pointer", fontSize: "0.82rem" }}>
                      Or pick truck from list
                    </summary>
                    <div className="inv-adjust-row" style={{ marginTop: "0.4rem" }}>
                      <label style={{ flex: "1 1 10rem" }}>
                        Goes on truck *
                        <select
                          value={handTruck[p.id] || ""}
                          onChange={(e) =>
                            setHandTruck((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                        >
                          <option value="">Select unit…</option>
                          {trucks.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.unit_number ? `Unit ${l.unit_number}` : l.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <p className="muted" style={{ fontSize: "0.78rem", margin: "0.25rem 0 0.45rem" }}>
                      Receiver tells you which truck; you lock both names + unit together.
                    </p>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() =>
                        void putOnTruck(p.id, {
                          oneShot: p.status === "open",
                        })
                      }
                    >
                      Move stock to selected truck
                    </button>
                  </details>
                </div>
              ) : showReceiverTruck ? (
                <div className="pickup-handoff-form">
                  <h4 className="inv-section-title" style={{ margin: "0.5rem 0 0.35rem" }}>
                    3 · Receiver: which truck stock?
                  </h4>
                  <p className="muted" style={{ fontSize: "0.82rem", margin: "0 0 0.4rem" }}>
                    Parts are with <strong>{p.handed_to_name || "you"}</strong>. Choose the truck
                    stock location they are going on — stock moves when you confirm.
                  </p>
                  <label style={{ display: "block", marginBottom: "0.45rem" }}>
                    Goes on truck *
                    <select
                      value={handTruck[p.id] || ""}
                      onChange={(e) =>
                        setHandTruck((prev) => ({ ...prev, [p.id]: e.target.value }))
                      }
                      required
                    >
                      <option value="">Select unit…</option>
                      {trucks.map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.unit_number ? `Unit ${l.unit_number}` : l.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void putOnTruck(p.id)}
                  >
                    Put on truck &amp; move stock
                  </button>
                </div>
              ) : p.status === "open" ? (
                <p className="muted inv-section-hint">
                  Waiting for warehouse to record who received these parts.
                </p>
              ) : (
                <p className="muted inv-section-hint">
                  Waiting for <strong>{p.handed_to_name || "receiver"}</strong> (or warehouse) to
                  choose which truck stock.
                </p>
              )}
            </LogItem>
          );
        })}
      </LogList>
    </div>
  );
}
