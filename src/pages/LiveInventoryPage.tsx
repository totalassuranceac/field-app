import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import { BarcodeScanButton } from "../components/BarcodeScan";

type Tab = "count" | "restock" | "adjust" | "match" | "report";

type Loc = {
  id: number;
  type: string;
  name: string;
  zone?: string | null;
  sort_order?: number | null;
  unit_number?: string | null;
  assigned_driver?: string | null;
  counted_by_name?: string | null;
  live: boolean;
};

type PartHit = {
  id: number;
  code: string | null;
  name: string;
  home_name?: string | null;
  home_zone?: string | null;
  home_type?: string | null;
};
type CountLine = { part_id: number; qty: number; code: string | null; name: string };
type PendingUse = {
  id: number;
  qty: number;
  job_ref: string | null;
  other_text: string | null;
  code: string | null;
  name: string | null;
  user_name: string | null;
};
type RestockLine = {
  id: number;
  qty: number;
  pulled: number;
  short_qty: number;
  parts_order_id: number | null;
  other_text?: string | null;
  code: string | null;
  name: string | null;
  home_name?: string | null;
  home_zone?: string | null;
  home_type?: string | null;
};
type Restock = {
  id: number;
  usage_date: string;
  status: string;
  unit_number: string;
  assigned_driver?: string | null;
  lines: RestockLine[];
};
type MatchRow = {
  id: number;
  other_text: string | null;
  photo_key: string | null;
  qty: number;
  job_ref: string | null;
  unit_number: string | null;
  user_name: string | null;
  status?: string | null;
};

function qtyText(n: unknown): string {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return String(Math.round(x * 1000) / 1000);
}

const LAST_SECTION_KEY = "ta-live-inv-section";

function withUnitOnce(name: string, unit?: string | null): string {
  const n = String(name || "").trim();
  const u = String(unit || "").trim();
  if (!u) return n;
  const low = n.toLowerCase();
  const token = u.toLowerCase();
  if (low === token || low === `unit ${token}` || low.endsWith(` ${token}`)) return n;
  return n ? `${n} ${u}` : `Unit ${u}`;
}

function locLabel(l: Loc): string {
  const who = l.assigned_driver ? ` (${l.assigned_driver})` : "";
  return `${withUnitOnce(l.name, l.unit_number)}${who}`;
}

function areaLabel(zone?: string | null, type?: string | null): string {
  const z = (zone || "").toLowerCase();
  if (z === "overhead") return "Overhead";
  if (z === "attic" || type === "attic") return "Attic";
  if (z === "main") return "Main floor";
  if (z === "other") return "Other";
  if (type === "warehouse") return "Warehouse";
  return "";
}

function homeText(name?: string | null, zone?: string | null, type?: string | null): string {
  const section = String(name || "").trim();
  if (!section) return "";
  const area = areaLabel(zone, type);
  return area ? `Home: ${section} · ${area}` : `Home: ${section}`;
}

function zoneRank(zone?: string | null): number {
  const z = (zone || "").toLowerCase();
  if (z === "main") return 0;
  if (z === "overhead") return 1;
  if (z === "attic") return 2;
  return 3;
}

function compareSections(a: Loc, b: Loc): number {
  const so = Number(a.sort_order || 0) - Number(b.sort_order || 0);
  if (so) return so;
  const zr = zoneRank(a.zone) - zoneRank(b.zone);
  if (zr) return zr;
  return a.name.localeCompare(b.name);
}

function sectionOption(l: Loc): string {
  const area = areaLabel(l.zone, l.type);
  return area ? `${l.name} · ${area}` : l.name;
}

function readLastSection(): number {
  try {
    const n = Number(localStorage.getItem(LAST_SECTION_KEY) || "");
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeLastSection(id: number) {
  if (!id) return;
  try {
    localStorage.setItem(LAST_SECTION_KEY, String(id));
  } catch {
    /* storage can be blocked */
  }
}

function PartLines({ part }: { part: PartHit }) {
  const home = homeText(part.home_name, part.home_zone, part.home_type);
  return (
    <p>
      <strong>
        {part.code ? `${part.code} - ` : ""}
        {part.name}
      </strong>
      {home ? (
        <span className="muted" style={{ display: "block" }}>
          {home}
        </span>
      ) : null}
    </p>
  );
}

function PartSearch({
  disabled,
  onPick,
}: {
  disabled?: boolean;
  onPick: (part: PartHit) => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PartHit[]>([]);
  const [error, setError] = useState("");

  async function search(query: string) {
    const text = query.trim();
    setQ(text);
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

  async function withHome(hit: PartHit): Promise<PartHit> {
    if (hit.home_name) return hit;
    const q = String(hit.code || hit.name || "").trim();
    if (q.length < 2) return hit;
    try {
      const more = await api<{ parts: PartHit[] }>(`/inventory/live/parts?q=${encodeURIComponent(q)}`);
      const row = (more.parts || []).find((p) => p.id === hit.id);
      return row ? { ...hit, ...row } : hit;
    } catch {
      return hit;
    }
  }

  async function scan(code: string) {
    setError("");
    try {
      const res = await api<{ parts: PartHit[] }>(
        `/inventory/parts/lookup?code=${encodeURIComponent(code)}`
      );
      const hit = (res.parts || [])[0];
      if (!hit) {
        setError("No part found for that code.");
        setQ(code);
        return;
      }
      const full = await withHome(hit);
      onPick({
        id: full.id,
        code: full.code,
        name: full.name,
        home_name: full.home_name,
        home_zone: full.home_zone,
        home_type: full.home_type,
      });
      setQ(full.code || full.name || code);
      setHits([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lookup failed");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <BarcodeScanButton label="Scan" disabled={disabled} onCode={(code) => void scan(code)} />
        <input
          type="search"
          value={q}
          placeholder="Search part"
          disabled={disabled}
          onChange={(e) => void search(e.target.value)}
          style={{ flex: "1 1 160px" }}
        />
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {hits.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                className="btn secondary btn-sm"
                style={{ marginBottom: 4 }}
                onClick={() => {
                  onPick(h);
                  setHits([]);
                }}
              >
                <span style={{ display: "block" }}>
                  {h.code ? `${h.code} - ` : ""}
                  {h.name}
                </span>
                {homeText(h.home_name, h.home_zone, h.home_type) ? (
                  <span className="muted">{homeText(h.home_name, h.home_zone, h.home_type)}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function LiveInventoryPage() {
  const { user } = useAuth();
  const allowed = user?.role === "admin" || user?.role === "warehouse";
  const [tab, setTab] = useState<Tab>("count");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  const [locations, setLocations] = useState<Loc[]>([]);
  const [locationId, setLocationId] = useState(0);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [pendingUses, setPendingUses] = useState<PendingUse[]>([]);
  const [part, setPart] = useState<PartHit | null>(null);
  const [qty, setQty] = useState("");
  const [sectionId, setSectionId] = useState(0);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [sectionZone, setSectionZone] = useState<"main" | "overhead" | "attic" | "other">("main");

  const [restocks, setRestocks] = useState<Restock[]>([]);
  const [shorts, setShorts] = useState<Record<number, string>>({});
  const [usageQty, setUsageQty] = useState<Record<number, string>>({});

  const [reason, setReason] = useState("miscount");
  const [note, setNote] = useState("");

  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [matchPart, setMatchPart] = useState<Record<number, PartHit | null>>({});

  const [report, setReport] = useState<{
    locations: Loc[];
    on_hand: Record<string, unknown>[];
    usage: Record<string, unknown>[];
    open_requests: Record<string, unknown>[];
    unmatched: Record<string, unknown>[];
  } | null>(null);

  const loadLocations = useCallback(async () => {
    const res = await api<{ locations: Loc[] }>("/inventory/live/locations");
    const list = res.locations || [];
    setLocations(list);
    setLocationId((cur) => {
      if (cur && list.some((l) => l.id === cur)) return cur;
      const first = list.find((l) => !l.live) || list[0];
      return first?.id || 0;
    });
  }, []);

  const loadLines = useCallback(async (id: number) => {
    if (!id) {
      setLines([]);
      return;
    }
    const res = await api<{ lines: CountLine[]; pending?: PendingUse[] }>(
      `/inventory/live/count-lines?location_id=${id}`
    );
    setLines(res.lines || []);
    setPendingUses(res.pending || []);
  }, []);

  const loadRestocks = useCallback(async () => {
    const res = await api<{ restocks: Restock[] }>("/inventory/live/restocks");
    setRestocks(res.restocks || []);
  }, []);

  const loadMatches = useCallback(async () => {
    const res = await api<{ entries: MatchRow[] }>("/inventory/live/needs-match");
    setMatches(res.entries || []);
  }, []);

  const loadReport = useCallback(async () => {
    const res = await api<{
      locations: Loc[];
      on_hand: Record<string, unknown>[];
      usage: Record<string, unknown>[];
      open_requests: Record<string, unknown>[];
      unmatched: Record<string, unknown>[];
    }>("/inventory/live/report");
    setReport(res);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void loadLocations().catch((e) => setError(e instanceof Error ? e.message : "Could not load locations."));
  }, [allowed, loadLocations]);

  useEffect(() => {
    if (tab !== "adjust") return;
    setLocationId((cur) => {
      const curLoc = locations.find((l) => l.id === cur);
      if (curLoc?.live) return cur;
      return locations.find((l) => l.live)?.id || cur;
    });
  }, [tab, locations]);

  useEffect(() => {
    const ids = locations
      .filter((l) => l.type === "warehouse" || l.type === "attic")
      .slice()
      .sort(compareSections)
      .map((l) => l.id);
    if (!ids.length) return;
    setSectionId((cur) => {
      if (cur && ids.includes(cur)) return cur;
      const last = readLastSection();
      if (ids.includes(last)) return last;
      if (ids.includes(locationId)) return locationId;
      return ids[0];
    });
  }, [locations, locationId]);

  useEffect(() => {
    if (!allowed || tab !== "count") return;
    const loc = locations.find((l) => l.id === locationId);
    const id = loc && loc.type !== "vehicle" ? sectionId : locationId;
    if (!id) return;
    void loadLines(id).catch((e) => setError(e instanceof Error ? e.message : "Could not load the count."));
  }, [allowed, tab, locationId, sectionId, locations, loadLines]);

  useEffect(() => {
    if (!allowed) return;
    setError("");
    if (tab === "restock") {
      void loadRestocks().catch((e) => setError(e instanceof Error ? e.message : "Could not load restock."));
    } else if (tab === "match") {
      void loadMatches().catch((e) => setError(e instanceof Error ? e.message : "Could not load matches."));
    } else if (tab === "report") {
      void loadReport().catch((e) => setError(e instanceof Error ? e.message : "Could not load the report."));
    }
  }, [allowed, tab, loadRestocks, loadMatches, loadReport]);

  const selected = locations.find((l) => l.id === locationId) || null;
  const liveLocs = locations.filter((l) => l.live);
  const warehouseCount = Boolean(selected && selected.type !== "vehicle");
  const sections = locations
    .filter((l) => l.type === "warehouse" || l.type === "attic")
    .slice()
    .sort(compareSections);
  const sectionLoc = sections.find((l) => l.id === sectionId) || null;
  const countPlaceId = warehouseCount ? sectionId : locationId;
  const countPlaceLive = warehouseCount ? Boolean(sectionLoc?.live) : Boolean(selected?.live);

  async function postCount(moveHome?: boolean) {
    if (!selected || !part) return;
    await api("/inventory/live/count", {
      method: "POST",
      body: JSON.stringify({
        location_id: selected.id,
        part_id: part.id,
        qty,
        section_id: warehouseCount ? sectionId : null,
        ...(moveHome === undefined ? {} : { move_home: moveHome }),
      }),
    });
  }

  async function saveLine(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    setOk("");
    if (!selected) return;
    if (warehouseCount && !sectionId) {
      setError("Pick a section.");
      return;
    }
    if (countPlaceLive) {
      setError("This location is already live. Use Adjust for a mismatch.");
      return;
    }
    if (!part) {
      setError("Search a part, or scan it.");
      return;
    }
    setBusy(true);
    try {
      try {
        await postCount();
      } catch (e) {
        const data = e instanceof ApiError ? (e.data as { confirm_home?: boolean; section_name?: string }) : null;
        if (e instanceof ApiError && e.status === 409 && data?.confirm_home) {
          const yes = window.confirm(e.message || `Move home bin to ${data.section_name || "that section"}?`);
          await postCount(yes);
        } else {
          throw e;
        }
      }
      if (warehouseCount) writeLastSection(sectionId);
      setOk("Count saved.");
      setPart(null);
      setQty("");
      await loadLines(countPlaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the count.");
    } finally {
      setBusy(false);
    }
  }

  async function addSection() {
    const name = sectionName.trim();
    if (!name) {
      setError("Enter a section name.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await api<{ location: { id: number; name: string } }>("/inventory/locations", {
        method: "POST",
        body: JSON.stringify({
          name,
          zone: sectionZone,
          type: sectionZone === "attic" ? "attic" : "warehouse",
        }),
      });
      const id = Number(res.location?.id || 0);
      if (id) {
        setSectionId(id);
        writeLastSection(id);
      }
      setSectionName("");
      setAddingSection(false);
      setOk(`${name} added.`);
      await loadLocations();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add that section.");
    } finally {
      setBusy(false);
    }
  }

  async function goLive() {
    if (!countPlaceId) return;
    setError("");
    setOk("");
    setBusy(true);
    try {
      const res = await api<{ name?: string; pending_posted?: number }>(`/inventory/live/count/save`, {
        method: "POST",
        body: JSON.stringify({ location_id: countPlaceId }),
      });
      const n = Number(res.pending_posted || 0);
      const name = res.name || sectionLoc?.name || selected?.name || "";
      setOk(
        n > 0
          ? `${name} is live. ${n} pending parts used are on the history.`
          : `${name} is live.`
      );
      await loadLocations();
      await loadLines(countPlaceId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark this location live.");
    } finally {
      setBusy(false);
    }
  }

  async function pull(restockId: number, lineId: number, pulled: boolean) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/restocks/${restockId}/pull`, {
        method: "POST",
        body: JSON.stringify({ line_id: lineId, pulled }),
      });
      await loadRestocks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check off that line.");
    } finally {
      setBusy(false);
    }
  }

  async function markShort(restockId: number, line: RestockLine) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/restocks/${restockId}/short`, {
        method: "POST",
        body: JSON.stringify({ line_id: line.id, short_qty: shorts[line.id] ?? "" }),
      });
      setOk("Marked short. A part request is open. Don't call suppliers. Warehouse orders.");
      await loadRestocks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark that short.");
    } finally {
      setBusy(false);
    }
  }

  async function fill(restockId: number) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/restocks/${restockId}/fill`, { method: "POST", body: "{}" });
      setOk("Filled. Warehouse qty is down and the truck qty is up. The tech confirms the bin.");
      await loadRestocks();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not fill this truck.");
    } finally {
      setBusy(false);
    }
  }

  async function adjust(ev: FormEvent) {
    ev.preventDefault();
    setError("");
    setOk("");
    if (!selected?.live || !part) {
      setError("Pick a live location and a part.");
      return;
    }
    setBusy(true);
    try {
      await api("/inventory/live/adjust", {
        method: "POST",
        body: JSON.stringify({
          location_id: selected.id,
          part_id: part.id,
          qty,
          reason,
          note,
        }),
      });
      setOk("Qty updated. Logged with who and when. No alert.");
      setPart(null);
      setQty("");
      setNote("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not adjust qty.");
    } finally {
      setBusy(false);
    }
  }

  async function match(row: MatchRow) {
    const picked = matchPart[row.id];
    if (!picked) {
      setError("Search the real part first.");
      return;
    }
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/used/${row.id}/match`, {
        method: "POST",
        body: JSON.stringify({ part_id: picked.id }),
      });
      setOk("Matched. Qty is off the truck.");
      await loadMatches();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not match that part.");
    } finally {
      setBusy(false);
    }
  }

  async function editUsage(id: number, qtyRaw: string) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/used/${id}/edit`, {
        method: "POST",
        body: JSON.stringify({ qty: qtyRaw }),
      });
      setOk("Updated.");
      await loadReport();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update that entry.");
    } finally {
      setBusy(false);
    }
  }

  async function undoUsage(id: number) {
    setError("");
    setOk("");
    setBusy(true);
    try {
      await api(`/inventory/live/used/${id}/void`, { method: "POST", body: "{}" });
      setOk("Undone.");
      await loadReport();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not undo that entry.");
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <h1>Live inventory</h1>
        <p>Not allowed.</p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "count", label: "Count" },
    { id: "restock", label: "Restock" },
    { id: "adjust", label: "Adjust" },
    { id: "match", label: "Match" },
    { id: "report", label: "Report" },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Live inventory</h1>
          <p>
            This page counts and restocks. It is different from the truck stock count. The truck
            stock count is the van sheet.
          </p>
          <p>Count the warehouse first. Then count each truck with the tech here.</p>
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? "btn btn-sm" : "btn secondary btn-sm"}
            onClick={() => {
              setTab(t.id);
              setOk("");
              setError("");
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {tab === "count" && (
        <div className="card">
          <h2>Locations</h2>
          <ul style={{ listStyle: "none", padding: 0 }}>
            {locations.map((l) => (
              <li key={l.id}>
                {locLabel(l)} - {l.live ? "Live" : "Not counted yet"}
                {l.live && l.counted_by_name ? <span className="muted"> - {l.counted_by_name}</span> : null}
              </li>
            ))}
          </ul>
          <label className="muted" style={{ display: "block", marginTop: 8 }}>
            Count this location
            <select
              value={locationId || ""}
              onChange={(e) => {
                setLocationId(Number(e.target.value));
                setPart(null);
              }}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {locLabel(l)}
                  {l.live ? " - live" : " - not counted"}
                </option>
              ))}
            </select>
          </label>
          <p className="muted">Count what is on the truck now.</p>
          {warehouseCount && (
            <div style={{ marginTop: 8 }}>
              <label className="muted" style={{ display: "block" }}>
                Section
                <select
                  value={sectionId || ""}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setSectionId(id);
                    writeLastSection(id);
                  }}
                  style={{ display: "block", width: "100%", marginTop: 4 }}
                >
                  {sections.map((l) => (
                    <option key={l.id} value={l.id}>
                      {sectionOption(l)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn secondary btn-sm"
                style={{ marginTop: 8 }}
                disabled={busy}
                onClick={() => setAddingSection((open) => !open)}
              >
                + New section
              </button>
              {addingSection && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                  <input
                    value={sectionName}
                    placeholder="Section name"
                    maxLength={80}
                    disabled={busy}
                    onChange={(e) => setSectionName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addSection();
                      }
                    }}
                    style={{ flex: "1 1 140px" }}
                  />
                  <select
                    value={sectionZone}
                    disabled={busy}
                    onChange={(e) =>
                      setSectionZone(e.target.value as "main" | "overhead" | "attic" | "other")
                    }
                  >
                    <option value="main">Main floor</option>
                    <option value="overhead">Overhead</option>
                    <option value="attic">Attic</option>
                    <option value="other">Other</option>
                  </select>
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void addSection()}>
                    Add section
                  </button>
                </div>
              )}
            </div>
          )}
          {countPlaceLive ? (
            <p>This location is already live. Use Adjust for a mismatch.</p>
          ) : (
            <form onSubmit={(e) => void saveLine(e)} style={{ marginTop: 10 }}>
              <p className="muted">Saving a line stores the qty. Go live when this location is done.</p>
              <PartSearch disabled={busy} onPick={setPart} />
              {part && <PartLines part={part} />}
              <label className="muted" style={{ display: "block" }}>
                Qty on hand
                <input
                  inputMode="decimal"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  style={{ display: "block", width: 120, marginTop: 4 }}
                />
              </label>
              <button className="btn" type="submit" disabled={busy} style={{ marginTop: 8 }}>
                Save count
              </button>
            </form>
          )}
          {pendingUses.length > 0 && (
            <>
              <h3>Pending parts used</h3>
              <p className="muted">On the usage history and the restock list. Not taken off this count.</p>
              <ul>
                {pendingUses.map((row) => (
                  <li key={row.id}>
                    {row.code ? `${row.code} - ` : ""}
                    {row.name || row.other_text || "Part"} - qty {qtyText(row.qty)}
                    {row.job_ref ? ` - job ${row.job_ref}` : ""}
                    {row.user_name ? ` - ${row.user_name}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
          <h3>Counted so far</h3>
          {!lines.length && <p className="muted">No lines yet.</p>}
          <ul>
            {lines.map((line) => (
              <li key={line.part_id}>
                {line.code ? `${line.code} - ` : ""}
                {line.name}: {qtyText(line.qty)}
              </li>
            ))}
          </ul>
          {countPlaceId > 0 && !countPlaceLive && (
            <button type="button" className="btn" disabled={busy || !lines.length} onClick={() => void goLive()}>
              Save - this location goes live
            </button>
          )}
        </div>
      )}

      {tab === "restock" && (
        <div>
          <p className="muted">
            Check off what you pulled. Shorts opens a part request. Filled moves qty from the warehouse onto the truck.
            Don't call suppliers. Warehouse orders.
          </p>
          {!restocks.length && <div className="card muted">No restock lists yet.</div>}
          {restocks.map((r) => (
            <section key={r.id} className="card" style={{ marginBottom: 12 }}>
              <h2>
                Unit {r.unit_number} - {r.usage_date}
              </h2>
              <p className="muted">
                {r.assigned_driver || "No driver name"} - {r.status === "filled" ? "Filled - waiting on the tech" : r.status}
              </p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {(r.lines || []).map((line) => (
                  <li key={line.id} style={{ marginBottom: 10 }}>
                    <div>
                      {line.code ? `${line.code} - ` : ""}
                      {line.name || line.other_text || "Part"} - qty {qtyText(line.qty)}
                      {Number(line.short_qty) > 0 ? ` - short ${qtyText(line.short_qty)}` : ""}
                      {line.parts_order_id ? ` - request #${line.parts_order_id}` : ""}
                      {homeText(line.home_name, line.home_zone, line.home_type) ? (
                        <div className="muted">{homeText(line.home_name, line.home_zone, line.home_type)}</div>
                      ) : null}
                    </div>
                    {r.status === "open" && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 4 }}>
                        <label>
                          <input
                            type="checkbox"
                            checked={Number(line.pulled) === 1}
                            disabled={busy}
                            onChange={(e) => void pull(r.id, line.id, e.target.checked)}
                          />{" "}
                          Pulled
                        </label>
                        <input
                          inputMode="decimal"
                          placeholder="Short qty"
                          value={shorts[line.id] ?? ""}
                          onChange={(e) => setShorts((m) => ({ ...m, [line.id]: e.target.value }))}
                          style={{ width: 90 }}
                        />
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={busy}
                          onClick={() => void markShort(r.id, line)}
                        >
                          Shorts
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {r.status === "open" && (
                <button type="button" className="btn" disabled={busy} onClick={() => void fill(r.id)}>
                  Filled
                </button>
              )}
            </section>
          ))}
        </div>
      )}

      {tab === "adjust" && (
        <form className="card" onSubmit={(e) => void adjust(e)}>
          <p className="muted">
            Used not marked, damaged, miscount, or other. A note is required for Other. Logged with who and when. No alert.
          </p>
          {!liveLocs.length && <p>No location is live yet. Count it first.</p>}
          <label className="muted" style={{ display: "block" }}>
            Location
            <select
              value={selected?.live ? selected.id : liveLocs[0]?.id || ""}
              onChange={(e) => {
                setLocationId(Number(e.target.value));
                setPart(null);
              }}
              style={{ display: "block", width: "100%", marginTop: 4 }}
            >
              {liveLocs.map((l) => (
                <option key={l.id} value={l.id}>
                  {locLabel(l)}
                </option>
              ))}
            </select>
          </label>
          <div style={{ marginTop: 8 }}>
            <PartSearch disabled={busy || !liveLocs.length} onPick={setPart} />
          </div>
          {part && <PartLines part={part} />}
          <label className="muted" style={{ display: "block" }}>
            New qty
            <input
              inputMode="decimal"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              style={{ display: "block", width: 120, marginTop: 4 }}
            />
          </label>
          <label className="muted" style={{ display: "block", marginTop: 8 }}>
            Reason
            <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ display: "block", marginTop: 4 }}>
              <option value="used_not_marked">Used not marked</option>
              <option value="damaged">Damaged</option>
              <option value="miscount">Miscount</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="muted" style={{ display: "block", marginTop: 8 }}>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} style={{ display: "block", width: "100%", marginTop: 4 }} />
          </label>
          <button className="btn" type="submit" disabled={busy || !liveLocs.length} style={{ marginTop: 8 }}>
            Save adjustment
          </button>
        </form>
      )}

      {tab === "match" && (
        <div>
          {!matches.length && <div className="card muted">No Other parts waiting to match.</div>}
          {matches.map((row) => (
            <section key={row.id} className="card" style={{ marginBottom: 12 }}>
              <p>
                <strong>{row.other_text || "Other"}</strong> - qty {qtyText(row.qty)}
              </p>
              <p className="muted">
                {row.user_name || "Tech"} - unit {row.unit_number || "?"} - job {row.job_ref || "?"}
              </p>
              {row.status === "pending" && (
                <p className="muted">Truck is not counted yet. This stays on the history and does not come off the count.</p>
              )}
              {row.photo_key ? (
                <img src={`/api/uploads/${row.photo_key}`} alt="Other part" style={{ maxWidth: 220 }} />
              ) : (
                <p className="muted">No photo on file.</p>
              )}
              <PartSearch
                disabled={busy}
                onPick={(p) => setMatchPart((m) => ({ ...m, [row.id]: p }))}
              />
              {matchPart[row.id] && (
                <p>
                  Match to {matchPart[row.id]?.code ? `${matchPart[row.id]?.code} - ` : ""}
                  {matchPart[row.id]?.name}
                  {homeText(matchPart[row.id]?.home_name, matchPart[row.id]?.home_zone, matchPart[row.id]?.home_type) ? (
                    <span className="muted" style={{ display: "block" }}>
                      {homeText(matchPart[row.id]?.home_name, matchPart[row.id]?.home_zone, matchPart[row.id]?.home_type)}
                    </span>
                  ) : null}
                </p>
              )}
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void match(row)}>
                Match this part
              </button>
            </section>
          ))}
        </div>
      )}

      {tab === "report" && report && (
        <div>
          <section className="card" style={{ marginBottom: 12 }}>
            <h2>Locations</h2>
            <ul>
              {(report.locations || []).map((l) => (
                <li key={l.id}>
                  {locLabel(l)} - {l.live ? "Live" : "Not counted yet"}
                </li>
              ))}
            </ul>
          </section>
          <section className="card" style={{ marginBottom: 12 }}>
            <h2>On hand</h2>
            {!report.on_hand?.length && <p className="muted">No on-hand qty on live locations.</p>}
            <ul>
              {(report.on_hand || []).map((row, i) => (
                <li key={i}>
                  {withUnitOnce(String(row.location_name || ""), row.unit_number == null ? "" : String(row.unit_number))}
                  {" - "}
                  {String(row.code || "")} {String(row.part_name || "")} -{" "}
                  {qtyText(row.qty)}
                </li>
              ))}
            </ul>
          </section>
          <section className="card" style={{ marginBottom: 12 }}>
            <h2>Usage</h2>
            <p className="muted">Techs can change their own entry for 24 hours. After that, change it here.</p>
            {!report.usage?.length && <p className="muted">No parts used yet.</p>}
            <ul style={{ listStyle: "none", padding: 0 }}>
              {(report.usage || []).map((row) => {
                const id = Number(row.id);
                return (
                  <li key={id || String(row.job_ref)} style={{ marginBottom: 8 }}>
                    {String(row.usage_ymd || "")} - {String(row.tech || "")} - unit {String(row.unit_number || "")} - job{" "}
                    {String(row.job_ref || "")} - {String(row.part_name || row.other_text || "")} - {qtyText(row.qty)} -{" "}
                    {String(row.status || "")}
                    {id > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                        <input
                          inputMode="decimal"
                          value={usageQty[id] ?? qtyText(row.qty)}
                          onChange={(e) => setUsageQty((m) => ({ ...m, [id]: e.target.value }))}
                          style={{ width: 80 }}
                        />
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={busy}
                          onClick={() => void editUsage(id, usageQty[id] ?? qtyText(row.qty))}
                        >
                          Update qty
                        </button>
                        <button type="button" className="btn secondary btn-sm" disabled={busy} onClick={() => void undoUsage(id)}>
                          Undo
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="card" style={{ marginBottom: 12 }}>
            <h2>Open requests</h2>
            {!report.open_requests?.length && <p className="muted">No open part requests.</p>}
            <ul>
              {(report.open_requests || []).map((row) => (
                <li key={String(row.id)}>
                  #{String(row.id)} {String(row.part_description || "")} - {String(row.status || "")} - job{" "}
                  {String(row.job_ref || "")} - need {String(row.needed_by || "")} - {String(row.deliver_to || "")} -{" "}
                  {String(row.requested_by || "")}
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Unmatched arrivals</h2>
            {!report.unmatched?.length && <p className="muted">No unmatched arrivals.</p>}
            <ul>
              {(report.unmatched || []).map((row) => (
                <li key={String(row.id)}>
                  Unmatched arrival - {String(row.part_description || "")}
                  {row.vendor_name ? ` / ${String(row.vendor_name)}` : ""} - {String(row.po_number || "")}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
