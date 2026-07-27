import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { CollapsibleSection, LogItem, LogList } from "../components/CollapsibleLog";

type Tab = "bottles" | "equipment" | "add";

interface BottleType {
  id: number;
  code: string;
  name: string;
  full_total: number;
  empty_total: number;
  total: number;
}

interface BottleCell {
  bottle_type_id: number;
  code: string;
  name: string;
  full_qty: number;
  empty_qty: number;
}

interface MatrixRow {
  location_id: number;
  location_name: string;
  location_type: string;
  unit_number: string | null;
  vehicle_id: number | null;
  bottles: BottleCell[];
}

interface Peer {
  id: number;
  display_name: string;
  role: string;
}

interface Asset {
  id: number;
  asset_tag?: string | null;
  name: string;
  category: string;
  subcategory?: string | null;
  serial_number?: string | null;
  status: string;
  condition: string;
  condition_date?: string | null;
  condition_notes?: string | null;
  issued_at?: string | null;
  issued_to_name?: string | null;
  location_name?: string | null;
  unit_number?: string | null;
  location_id?: number | null;
  notes?: string | null;
}

interface AssetEvent {
  id: number;
  event_type: string;
  condition_before?: string | null;
  condition_after?: string | null;
  notes?: string | null;
  created_at: string;
  created_by_name?: string | null;
  from_unit?: string | null;
  to_unit?: string | null;
  from_location_name?: string | null;
  to_location_name?: string | null;
}

const CONDITIONS = [
  "excellent",
  "good",
  "fair",
  "poor",
  "damaged",
  "out_of_service",
] as const;

const CATEGORIES = [
  { value: "ladder", label: "Ladder" },
  { value: "dolly", label: "Dolly" },
  { value: "tool", label: "Tool" },
  { value: "other", label: "Other" },
];

function conditionClass(c: string): string {
  if (c === "excellent" || c === "good") return "cond-ok";
  if (c === "fair") return "cond-warn";
  return "cond-bad";
}

function locLabel(unit: string | null | undefined, name: string | null | undefined): string {
  if (unit) return `Unit ${unit}`;
  return name || "—";
}

export function AssetsPage() {
  const { user } = useAuth();
  const canManage = can(user, "manageCompanyAssets");
  const canView = can(user, "viewCompanyAssets");
  const isField = user?.role === "driver";

  const [tab, setTab] = useState<Tab>(isField ? "equipment" : "bottles");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  // Bottles
  const [types, setTypes] = useState<BottleType[]>([]);
  const [matrix, setMatrix] = useState<MatrixRow[]>([]);
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);

  // Swap form
  const [swapTruck, setSwapTruck] = useState("");
  const [swapTech, setSwapTech] = useState("");
  const [swapNotes, setSwapNotes] = useState("");
  const [swapLines, setSwapLines] = useState<
    Record<number, { empty_in: string; full_out: string }>
  >({});

  // Set counts
  const [setLoc, setSetLoc] = useState("");
  const [setType, setSetType] = useState("");
  const [setFull, setSetFull] = useState("0");
  const [setEmpty, setSetEmpty] = useState("0");

  // Equipment
  const [assets, setAssets] = useState<Asset[]>([]);
  const [catFilter, setCatFilter] = useState("");
  const [needsOnly, setNeedsOnly] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Asset | null>(null);
  const [detailEvents, setDetailEvents] = useState<AssetEvent[]>([]);
  const [condVal, setCondVal] = useState("good");
  const [condNotes, setCondNotes] = useState("");
  const [issueLoc, setIssueLoc] = useState("");
  const [issueCond, setIssueCond] = useState("good");
  const [issueNotes, setIssueNotes] = useState("");
  const [issueUser, setIssueUser] = useState("");

  // Add form
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("ladder");
  const [newTag, setNewTag] = useState("");
  const [newSerial, setNewSerial] = useState("");
  const [newSub, setNewSub] = useState("");
  const [newCond, setNewCond] = useState("good");
  const [newLoc, setNewLoc] = useState("");
  const [newNotes, setNewNotes] = useState("");

  const trucks = useMemo(
    () => matrix.filter((m) => m.location_type === "vehicle"),
    [matrix]
  );
  const allLocs = useMemo(() => matrix, [matrix]);

  /** Equipment grouped by location for collapsible list */
  const equipmentByLocation = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; items: Asset[]; needs: number }
    >();
    for (const a of assets) {
      const key =
        a.location_id != null
          ? `loc-${a.location_id}`
          : a.unit_number
            ? `unit-${a.unit_number}`
            : a.location_name
              ? `name-${a.location_name}`
              : "unassigned";
      const label = locLabel(a.unit_number, a.location_name);
      const g = map.get(key) || { key, label, items: [], needs: 0 };
      g.items.push(a);
      if (
        a.condition === "damaged" ||
        a.condition === "poor" ||
        a.condition === "out_of_service" ||
        a.status === "repair" ||
        a.status === "missing"
      ) {
        g.needs += 1;
      }
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [assets]);

  const loadBottles = useCallback(async () => {
    const [sum, ev, users] = await Promise.all([
      api<{ types: BottleType[]; matrix: MatrixRow[] }>("/assets/bottles/summary"),
      api<{ events: Record<string, unknown>[] }>("/assets/bottles/events?limit=40").catch(
        () => ({ events: [] })
      ),
      api<{ users: Peer[] }>("/messages/users").catch(() => ({ users: [] as Peer[] })),
    ]);
    setTypes(sum.types || []);
    setMatrix(sum.matrix || []);
    setEvents(ev.events || []);
    setPeers(users.users || []);
    // seed swap lines
    const lines: Record<number, { empty_in: string; full_out: string }> = {};
    for (const t of sum.types || []) {
      lines[t.id] = { empty_in: "0", full_out: "0" };
    }
    setSwapLines((prev) => (Object.keys(prev).length ? prev : lines));
  }, []);

  const loadAssets = useCallback(async () => {
    const params = new URLSearchParams();
    if (isField) params.set("mine", "1");
    if (catFilter) params.set("category", catFilter);
    if (needsOnly) params.set("needs_attention", "1");
    if (q.trim()) params.set("q", q.trim());
    const d = await api<{ assets: Asset[] }>(`/assets?${params}`);
    setAssets(d.assets || []);
  }, [isField, catFilter, needsOnly, q]);

  const loadAll = useCallback(async () => {
    setError("");
    try {
      await Promise.all([loadBottles(), loadAssets()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [loadBottles, loadAssets]);

  useEffect(() => {
    if (canView) void loadAll();
  }, [canView, loadAll]);

  async function openDetail(a: Asset) {
    setSelected(a);
    setCondVal(a.condition || "good");
    setCondNotes("");
    setIssueLoc(String(a.location_id || ""));
    setIssueCond(a.condition || "good");
    setIssueNotes("");
    try {
      const d = await api<{ asset: Asset; events: AssetEvent[] }>(`/assets/${a.id}`);
      setSelected(d.asset as Asset);
      setDetailEvents(d.events || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load detail");
    }
  }

  async function doSwap(e: FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    if (!swapTruck) {
      setError("Select the truck doing the swap");
      return;
    }
    const lines = types
      .map((t) => ({
        bottle_type_id: t.id,
        empty_in: Number(swapLines[t.id]?.empty_in || 0),
        full_out: Number(swapLines[t.id]?.full_out || 0),
      }))
      .filter((l) => l.empty_in > 0 || l.full_out > 0);
    if (!lines.length) {
      setError("Enter empty-in and/or full-out for at least one gas type");
      return;
    }
    const truckName = trucks.find((t) => String(t.location_id) === swapTruck)?.location_name;
    const summary = lines
      .map((l) => {
        const name = types.find((t) => t.id === l.bottle_type_id)?.code;
        return `${name}: ${l.empty_in} empty in / ${l.full_out} full out`;
      })
      .join("\n");
    if (!confirm(`Confirm bottle swap for ${truckName}?\n\n${summary}`)) return;

    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/assets/bottles/swap", {
        method: "POST",
        body: JSON.stringify({
          truck_location_id: Number(swapTruck),
          tech_user_id: swapTech ? Number(swapTech) : null,
          notes: swapNotes || undefined,
          lines,
        }),
      });
      setOk("Swap recorded — bottle counts updated.");
      setSwapLines(
        Object.fromEntries(types.map((t) => [t.id, { empty_in: "0", full_out: "0" }]))
      );
      setSwapNotes("");
      await loadBottles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Swap failed");
    } finally {
      setBusy(false);
    }
  }

  async function doSetCounts(e: FormEvent) {
    e.preventDefault();
    if (!canManage || !setLoc || !setType) {
      setError("Select location and bottle type");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/assets/bottles/set", {
        method: "POST",
        body: JSON.stringify({
          location_id: Number(setLoc),
          bottle_type_id: Number(setType),
          full_qty: Number(setFull) || 0,
          empty_qty: Number(setEmpty) || 0,
        }),
      });
      setOk("Counts saved.");
      await loadBottles();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Set failed");
    } finally {
      setBusy(false);
    }
  }

  async function doCreateAsset(e: FormEvent) {
    e.preventDefault();
    if (!canManage) return;
    if (!newName.trim()) {
      setError("Name is required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/assets", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          category: newCat,
          asset_tag: newTag.trim() || undefined,
          serial_number: newSerial.trim() || undefined,
          subcategory: newSub.trim() || undefined,
          condition: newCond,
          location_id: newLoc ? Number(newLoc) : undefined,
          notes: newNotes.trim() || undefined,
        }),
      });
      setOk(`Added ${newName.trim()}`);
      setNewName("");
      setNewTag("");
      setNewSerial("");
      setNewSub("");
      setNewNotes("");
      setTab("equipment");
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setBusy(false);
    }
  }

  async function doCondition(isDamage: boolean) {
    if (!selected) return;
    if (!condNotes.trim()) {
      setError("Describe the condition / damage");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/assets/${selected.id}/condition`, {
        method: "POST",
        body: JSON.stringify({
          condition: condVal,
          notes: condNotes,
          is_damage: isDamage,
        }),
      });
      setOk("Condition recorded.");
      setCondNotes("");
      await openDetail(selected);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function doIssue() {
    if (!selected || !canManage) return;
    if (!issueLoc) {
      setError("Select truck / location");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/assets/${selected.id}/issue`, {
        method: "POST",
        body: JSON.stringify({
          location_id: Number(issueLoc),
          condition: issueCond,
          notes: issueNotes || undefined,
          issued_to_user_id: issueUser ? Number(issueUser) : undefined,
        }),
      });
      setOk("Issued to location.");
      await openDetail(selected);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Issue failed");
    } finally {
      setBusy(false);
    }
  }

  async function doReturn() {
    if (!selected || !canManage) return;
    if (!issueNotes.trim() && !issueCond) {
      setError("Set condition when returning");
      return;
    }
    if (!confirm(`Return ${selected.name} to warehouse in ${issueCond} condition?`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/assets/${selected.id}/return`, {
        method: "POST",
        body: JSON.stringify({
          condition: issueCond,
          notes: issueNotes || `Returned — condition ${issueCond}`,
        }),
      });
      setOk("Returned to warehouse.");
      await openDetail(selected);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Return failed");
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <div className="page">
        <div className="error">You do not have access to company assets.</div>
      </div>
    );
  }

  return (
    <div className="page assets-page">
      <div className="page-header no-print">
        <div>
          <h1>{isField ? "My truck gear" : "Company assets"}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {isField
              ? "Bottles and company equipment on your truck. Report damage when something is wrong."
              : "Gas bottles (full/empty counts) and company tools — ladders, dollies, and gear outside the pricebook."}
          </p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <div className="warranty-filters no-print">
        <button
          type="button"
          className={`inv-tab${tab === "bottles" ? " active" : ""}`}
          onClick={() => setTab("bottles")}
        >
          Bottles
        </button>
        <button
          type="button"
          className={`inv-tab${tab === "equipment" ? " active" : ""}`}
          onClick={() => setTab("equipment")}
        >
          Equipment
        </button>
        {canManage && (
          <button
            type="button"
            className={`inv-tab${tab === "add" ? " active" : ""}`}
            onClick={() => setTab("add")}
          >
            Add equipment
          </button>
        )}
      </div>

      {tab === "bottles" && (
        <>
          {/* Compact fleet totals */}
          <div className="bottle-totals-strip card">
            {types.map((t) => (
              <div key={t.id} className="bottle-total-chip" title={t.name}>
                <strong className="bottle-total-code">{t.code}</strong>
                <span className="full">{t.full_total}F</span>
                <span className="sep">·</span>
                <span className="empty">{t.empty_total}E</span>
                <span className="muted bottle-total-all">{t.total}</span>
              </div>
            ))}
            {!types.length && (
              <p className="muted" style={{ margin: 0 }}>
                No bottle types yet — run migration 026 or refresh.
              </p>
            )}
          </div>

          {canManage && (
            <CollapsibleSection
              title="Warehouse swap"
              hint="Empties in · fulls out"
              defaultOpen={false}
              className="bottle-tools-section"
            >
              <form className="asset-swap-form bottle-tool-form" onSubmit={doSwap}>
                <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.5rem" }}>
                  Tech brings empties → warehouse hands fulls to the truck.
                </p>
                <div className="inv-adjust-row">
                  <label style={{ flex: "1 1 9rem" }}>
                    Truck *
                    <select value={swapTruck} onChange={(e) => setSwapTruck(e.target.value)} required>
                      <option value="">Select unit…</option>
                      {trucks.map((t) => (
                        <option key={t.location_id} value={t.location_id}>
                          {t.location_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ flex: "1 1 9rem" }}>
                    Tech
                    <select value={swapTech} onChange={(e) => setSwapTech(e.target.value)}>
                      <option value="">Optional…</option>
                      {peers.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="asset-swap-lines bottle-swap-lines-compact">
                  {types.map((t) => (
                    <div key={t.id} className="asset-swap-line">
                      <strong>{t.code}</strong>
                      <label>
                        Empty in
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={swapLines[t.id]?.empty_in ?? "0"}
                          onChange={(e) =>
                            setSwapLines((prev) => ({
                              ...prev,
                              [t.id]: {
                                empty_in: e.target.value,
                                full_out: prev[t.id]?.full_out ?? "0",
                              },
                            }))
                          }
                        />
                      </label>
                      <label>
                        Full out
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={swapLines[t.id]?.full_out ?? "0"}
                          onChange={(e) =>
                            setSwapLines((prev) => ({
                              ...prev,
                              [t.id]: {
                                empty_in: prev[t.id]?.empty_in ?? "0",
                                full_out: e.target.value,
                              },
                            }))
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
                <label>
                  Notes
                  <input
                    value={swapNotes}
                    onChange={(e) => setSwapNotes(e.target.value)}
                    placeholder="optional"
                  />
                </label>
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Complete swap"}
                </button>
              </form>
            </CollapsibleSection>
          )}

          {canManage && (
            <CollapsibleSection
              title="Set counts"
              hint="Cycle count"
              defaultOpen={false}
              className="bottle-tools-section"
            >
              <form className="bottle-tool-form" onSubmit={doSetCounts}>
                <div className="inv-adjust-row">
                  <label style={{ flex: "1 1 8rem" }}>
                    Location
                    <select value={setLoc} onChange={(e) => setSetLoc(e.target.value)} required>
                      <option value="">Select…</option>
                      {allLocs.map((l) => (
                        <option key={l.location_id} value={l.location_id}>
                          {l.location_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ flex: "1 1 6rem" }}>
                    Gas
                    <select value={setType} onChange={(e) => setSetType(e.target.value)} required>
                      <option value="">Select…</option>
                      {types.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.code}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ flex: "0 0 4.5rem" }}>
                    Full
                    <input
                      type="number"
                      min={0}
                      value={setFull}
                      onChange={(e) => setSetFull(e.target.value)}
                    />
                  </label>
                  <label style={{ flex: "0 0 4.5rem" }}>
                    Empty
                    <input
                      type="number"
                      min={0}
                      value={setEmpty}
                      onChange={(e) => setSetEmpty(e.target.value)}
                    />
                  </label>
                </div>
                <button className="btn secondary" type="submit" disabled={busy}>
                  Save counts
                </button>
              </form>
            </CollapsibleSection>
          )}

          <CollapsibleSection
            title={isField ? "Your truck" : "By location"}
            count={matrix.length}
            hint={isField ? "Bottle counts on your unit" : "Tap to show trucks & warehouse"}
            defaultOpen={isField}
            className="bottle-tools-section bottle-locations-section"
          >
            {!matrix.length ? (
              <p className="muted" style={{ margin: 0 }}>
                No locations yet.
              </p>
            ) : (
              <div className="bottle-loc-list">
                {matrix.map((row) => {
                  const totalFull = row.bottles.reduce((s, b) => s + (b.full_qty || 0), 0);
                  const totalEmpty = row.bottles.reduce((s, b) => s + (b.empty_qty || 0), 0);
                  const locTotal = totalFull + totalEmpty;
                  return (
                    <details key={row.location_id} className="bottle-loc-details">
                      <summary className="bottle-loc-summary">
                        <span className="bottle-loc-chevron" aria-hidden />
                        <strong className="bottle-loc-name">{row.location_name}</strong>
                        <span className="bottle-loc-peek muted">
                          <span className="full">{totalFull}F</span>
                          <span className="sep">·</span>
                          <span className="empty">{totalEmpty}E</span>
                          <span className="bottle-loc-total">{locTotal}</span>
                        </span>
                      </summary>
                      <div className="bottle-loc-body">
                        {types.map((t) => {
                          const cell = row.bottles.find((b) => b.bottle_type_id === t.id);
                          const f = cell?.full_qty ?? 0;
                          const e = cell?.empty_qty ?? 0;
                          return (
                            <div key={t.id} className="bottle-loc-row">
                              <span className="bottle-loc-gas" title={t.name}>
                                {t.code}
                              </span>
                              <span className="bottle-loc-counts">
                                <span className="full">{f} full</span>
                                <span className="sep">·</span>
                                <span className="empty">{e} empty</span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </CollapsibleSection>

          {!isField && (
            <CollapsibleSection
              title="Recent bottle activity"
              count={events.length}
              hint="Swaps and count changes"
              defaultOpen={false}
            >
              <LogList empty="No swaps yet.">
                {events.slice(0, 20).map((ev) => (
                  <LogItem
                    key={String(ev.id)}
                    summary={
                      <>
                        <span className="log-item-badge">{String(ev.event_type)}</span>
                        <strong>{String(ev.bottle_code || "")}</strong>
                        <span className="log-item-meta">
                          {ev.event_type === "swap"
                            ? `${ev.empty_delta} empty in / ${ev.full_delta} full out`
                            : `Δ full ${ev.full_delta} / empty ${ev.empty_delta}`}
                          {ev.from_unit ? ` · Unit ${ev.from_unit}` : ""}
                        </span>
                      </>
                    }
                  >
                    {ev.tech_name ? <div>Tech: {String(ev.tech_name)}</div> : null}
                    <div className="muted">
                      {String(ev.created_by_name || "")} ·{" "}
                      {String(ev.created_at || "").replace("T", " ").slice(0, 16)}
                    </div>
                  </LogItem>
                ))}
              </LogList>
            </CollapsibleSection>
          )}
        </>
      )}

      {tab === "equipment" && (
        <>
          <div className="warranty-filters no-print" style={{ marginBottom: "0.75rem" }}>
            <select
              value={catFilter}
              onChange={(e) => setCatFilter(e.target.value)}
              aria-label="Category"
            >
              <option value="">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
            <label className="asset-check">
              <input
                type="checkbox"
                checked={needsOnly}
                onChange={(e) => setNeedsOnly(e.target.checked)}
              />
              Needs attention
            </label>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name / tag / serial"
              style={{ maxWidth: "14rem" }}
            />
            <button type="button" className="btn secondary" onClick={() => void loadAssets()}>
              Refresh
            </button>
          </div>

          <div className="asset-equip-layout">
            <CollapsibleSection
              title={isField ? "Your truck gear" : "By location"}
              count={assets.length}
              hint={
                isField
                  ? "Equipment on your unit"
                  : "Tap to show trucks & warehouse"
              }
              defaultOpen={isField || Boolean(selected) || needsOnly}
              className="bottle-tools-section"
            >
              <div className="asset-loc-list">
                {!assets.length ? (
                  <p className="muted empty" style={{ margin: 0 }}>
                    {isField
                      ? "No company equipment assigned to your truck yet."
                      : "No equipment yet — use Add equipment for ladders, dollies, tools."}
                  </p>
                ) : (
                  equipmentByLocation.map((group) => (
                    <details
                      key={group.key}
                      className="bottle-loc-details asset-loc-details"
                      open={
                        isField ||
                        group.items.some((a) => a.id === selected?.id) ||
                        (needsOnly && group.needs > 0)
                          ? true
                          : undefined
                      }
                    >
                      <summary className="bottle-loc-summary">
                        <span className="bottle-loc-chevron" aria-hidden />
                        <strong className="bottle-loc-name">{group.label}</strong>
                        <span className="bottle-loc-peek muted">
                          <span className="bottle-loc-total">{group.items.length}</span>
                          {group.needs > 0 ? (
                            <span className="asset-loc-needs">
                              {group.needs} need
                              {group.needs === 1 ? "s" : ""} attention
                            </span>
                          ) : null}
                        </span>
                      </summary>
                      <ul className="asset-list asset-list-in-loc">
                        {group.items.map((a) => (
                          <li key={a.id}>
                            <button
                              type="button"
                              className={`card asset-card cond-${conditionClass(a.condition)}${
                                selected?.id === a.id ? " selected" : ""
                              }`}
                              onClick={() => void openDetail(a)}
                            >
                              <div className="asset-card-top">
                                <strong>
                                  {a.asset_tag ? `${a.asset_tag} · ` : ""}
                                  {a.name}
                                </strong>
                                <span
                                  className={`asset-cond-badge ${conditionClass(a.condition)}`}
                                >
                                  {a.condition.replace("_", " ")}
                                </span>
                              </div>
                              <div className="muted" style={{ fontSize: "0.82rem" }}>
                                {a.category}
                                {a.subcategory ? ` · ${a.subcategory}` : ""}
                                {a.issued_at
                                  ? ` · issued ${String(a.issued_at).replace("T", " ").slice(0, 10)}`
                                  : ""}
                              </div>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))
                )}
              </div>
            </CollapsibleSection>

            {selected && (
              <div className="card asset-detail">
                <div className="asset-card-top">
                  <h3 style={{ margin: 0 }}>
                    {selected.asset_tag ? `${selected.asset_tag} · ` : ""}
                    {selected.name}
                  </h3>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => {
                      setSelected(null);
                      setDetailEvents([]);
                    }}
                  >
                    Close
                  </button>
                </div>
                <div className="warranty-meta custody-chain">
                  <div>
                    Category: <strong>{selected.category}</strong>
                    {selected.serial_number ? ` · SN ${selected.serial_number}` : ""}
                  </div>
                  <div>
                    Location:{" "}
                    <strong>{locLabel(selected.unit_number, selected.location_name)}</strong>
                  </div>
                  <div>
                    Condition:{" "}
                    <strong className={conditionClass(selected.condition)}>
                      {selected.condition.replace("_", " ")}
                    </strong>
                    {selected.condition_date ? ` · as of ${selected.condition_date}` : ""}
                  </div>
                  {selected.issued_at && (
                    <div>
                      Issued: {String(selected.issued_at).replace("T", " ").slice(0, 16)}
                      {selected.issued_to_name ? ` · ${selected.issued_to_name}` : ""}
                    </div>
                  )}
                  {selected.condition_notes && (
                    <div className="muted">{selected.condition_notes}</div>
                  )}
                </div>

                <h4 className="inv-section-title">Update condition</h4>
                <p className="muted" style={{ fontSize: "0.78rem", marginTop: 0 }}>
                  Log condition on issue/return or when damaged — builds the abuse trail.
                </p>
                <label>
                  Condition
                  <select value={condVal} onChange={(e) => setCondVal(e.target.value)}>
                    {CONDITIONS.map((c) => (
                      <option key={c} value={c}>
                        {c.replace("_", " ")}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Notes *
                  <textarea
                    value={condNotes}
                    onChange={(e) => setCondNotes(e.target.value)}
                    rows={2}
                    placeholder="e.g. bent foot, missing pad, cracked rung…"
                  />
                </label>
                <div className="inv-adjust-row" style={{ gap: "0.5rem" }}>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => void doCondition(false)}
                  >
                    Save condition
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void doCondition(true)}
                  >
                    Report damage
                  </button>
                </div>

                {canManage && (
                  <>
                    <h4 className="inv-section-title">Issue / return</h4>
                    <label>
                      Location (truck or warehouse)
                      <select value={issueLoc} onChange={(e) => setIssueLoc(e.target.value)}>
                        <option value="">Select…</option>
                        {allLocs.map((l) => (
                          <option key={l.location_id} value={l.location_id}>
                            {l.location_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Condition at issue/return
                      <select value={issueCond} onChange={(e) => setIssueCond(e.target.value)}>
                        {CONDITIONS.map((c) => (
                          <option key={c} value={c}>
                            {c.replace("_", " ")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Issued to (person)
                      <select value={issueUser} onChange={(e) => setIssueUser(e.target.value)}>
                        <option value="">Optional…</option>
                        {peers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.display_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Notes
                      <input
                        value={issueNotes}
                        onChange={(e) => setIssueNotes(e.target.value)}
                        placeholder="condition notes on issue/return"
                      />
                    </label>
                    <div className="inv-adjust-row" style={{ gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void doIssue()}
                      >
                        Issue to location
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => void doReturn()}
                      >
                        Return to warehouse
                      </button>
                    </div>
                  </>
                )}

                <CollapsibleSection
                  title="History (custody / condition)"
                  count={detailEvents.length}
                  defaultOpen={detailEvents.length > 0 && detailEvents.length <= 5}
                >
                  <LogList empty="No events yet.">
                    {detailEvents.map((ev) => (
                      <LogItem
                        key={ev.id}
                        tone={
                          ev.event_type === "damage" ||
                          ev.condition_after === "damaged" ||
                          ev.condition_after === "poor"
                            ? "bad"
                            : undefined
                        }
                        summary={
                          <>
                            <span className="log-item-badge">{ev.event_type}</span>
                            <span className="log-item-meta">
                              {ev.condition_before || ev.condition_after
                                ? `${ev.condition_before || "—"} → ${ev.condition_after || "—"}`
                                : ""}
                              {ev.to_unit
                                ? ` · Unit ${ev.to_unit}`
                                : ev.to_location_name
                                  ? ` · ${ev.to_location_name}`
                                  : ""}
                            </span>
                          </>
                        }
                      >
                        {ev.notes ? <div>{ev.notes}</div> : null}
                        <div className="muted">
                          {ev.created_by_name} ·{" "}
                          {String(ev.created_at).replace("T", " ").slice(0, 16)}
                        </div>
                      </LogItem>
                    ))}
                  </LogList>
                </CollapsibleSection>
              </div>
            )}
          </div>
        </>
      )}

      {tab === "add" && canManage && (
        <form className="card" onSubmit={doCreateAsset}>
          <h3 className="inv-section-title" style={{ marginTop: 0 }}>
            Add company equipment
          </h3>
          <p className="muted" style={{ fontSize: "0.82rem" }}>
            Ladders, dollies, and tools owned by Total Assurance — not in the ServiceTitan
            pricebook.
          </p>
          <label>
            Name *
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="28ft extension ladder"
              required
            />
          </label>
          <div className="inv-adjust-row">
            <label style={{ flex: "1 1 8rem" }}>
              Category *
              <select value={newCat} onChange={(e) => setNewCat(e.target.value)}>
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: "1 1 8rem" }}>
              Tag / ID
              <input
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="LAD-012"
              />
            </label>
            <label style={{ flex: "1 1 8rem" }}>
              Serial
              <input value={newSerial} onChange={(e) => setNewSerial(e.target.value)} />
            </label>
          </div>
          <div className="inv-adjust-row">
            <label style={{ flex: "1 1 8rem" }}>
              Subtype
              <input
                value={newSub}
                onChange={(e) => setNewSub(e.target.value)}
                placeholder="extension, step, platform…"
              />
            </label>
            <label style={{ flex: "1 1 8rem" }}>
              Starting location
              <select value={newLoc} onChange={(e) => setNewLoc(e.target.value)}>
                <option value="">Warehouse (default)</option>
                {allLocs.map((l) => (
                  <option key={l.location_id} value={l.location_id}>
                    {l.location_name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ flex: "1 1 8rem" }}>
              Condition
              <select value={newCond} onChange={(e) => setNewCond(e.target.value)}>
                {CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            Notes
            <input value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add equipment"}
          </button>
        </form>
      )}
    </div>
  );
}
