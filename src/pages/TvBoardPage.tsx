import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import type { LivePosition } from "./LiveMapPage";

type ShopJob = {
  id: number;
  title: string;
  status: string;
  severity: string;
  scheduled_date: string | null;
  schedule_notes: string | null;
  is_emergency?: number;
  unit_number: string;
  assigned_driver: string | null;
  reporter_name: string | null;
};

type TvBoard = {
  generated_at: string;
  shop_date: string;
  company: string;
  shop_today: ShopJob[];
  counts: {
    emergencies: number;
    needs_schedule: number;
    out_of_service: number;
    weekly_checks_due: number;
    open_warranties: number;
    pickups_waiting: number;
    parts_dropoffs: number;
    vendor_runs: number;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LType = any;

function clockNow(): string {
  return new Date().toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toneCount(n: number): "ok" | "warn" | "bad" {
  if (n >= 5) return "bad";
  if (n >= 1) return "warn";
  return "ok";
}

function isValidCoord(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function ensureLeaflet(): Promise<LType> {
  return new Promise((resolve, reject) => {
    const w = window as Window & { L?: LType };
    if (w.L) {
      resolve(w.L);
      return;
    }
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      link.crossOrigin = "";
      document.head.appendChild(link);
    }
    const existing = document.getElementById("leaflet-js") as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener("load", () => {
        if (w.L) resolve(w.L);
        else reject(new Error("Leaflet failed to load"));
      });
      existing.addEventListener("error", () => reject(new Error("Leaflet script error")));
      return;
    }
    const script = document.createElement("script");
    script.id = "leaflet-js";
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.async = true;
    script.onload = () => {
      if (w.L) resolve(w.L);
      else reject(new Error("Leaflet failed to load"));
    };
    script.onerror = () => reject(new Error("Could not load map library"));
    document.head.appendChild(script);
  });
}

type FleetRosterRow = {
  unit: string;
  tech: string;
  color: string;
  moving: boolean;
};

/** Prefer first name for glanceable TV list (Abel from Abel Garcia). */
function shortTechName(full: string | null | undefined): string {
  const t = (full || "").trim();
  if (!t) return "—";
  // "Last, First" → First
  if (t.includes(",")) {
    const parts = t.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts[1].split(/\s+/)[0] || parts[1];
  }
  return t.split(/\s+/)[0] || t;
}

function buildRoster(positions: LivePosition[]): FleetRosterRow[] {
  const rows = positions.map((p) => {
    const unit = String(p.unit_number || p.name || "?").trim();
    const tech = shortTechName(p.driver_name);
    const color = p.provider === "onestep" ? "#1a6b4f" : "#175cd3";
    const moving = typeof p.speed_mph === "number" && p.speed_mph > 3;
    return { unit, tech, color, moving };
  });
  rows.sort((a, b) =>
    a.unit.localeCompare(b.unit, undefined, { numeric: true, sensitivity: "base" })
  );
  return rows;
}

/** Compact live map for the office TV — same GPS feed as Live map, auto-refresh. */
function TvLiveMap({
  onRoster,
}: {
  onRoster?: (rows: FleetRosterRow[]) => void;
}) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LType | null>(null);
  const layerRef = useRef<LType | null>(null);
  const LRef = useRef<LType | null>(null);
  const onRosterRef = useRef(onRoster);
  onRosterRef.current = onRoster;
  const [mapReady, setMapReady] = useState(false);
  const [count, setCount] = useState(0);
  const [mapError, setMapError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  const syncMarkers = useCallback((positions: LivePosition[]) => {
    const L = LRef.current;
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!L || !layer || !map) return;

    layer.clearLayers();
    const bounds: [number, number][] = [];

    for (const p of positions) {
      if (!isValidCoord(p.lat, p.lng)) continue;
      const color = p.provider === "onestep" ? "#1a6b4f" : "#175cd3";
      const moving = typeof p.speed_mph === "number" && p.speed_mph > 3;
      const label = String(p.unit_number || p.name || "?").slice(0, 5);
      const icon = L.divIcon({
        className: "fleet-marker",
        html: `<div class="fleet-pin tv-fleet-pin" style="background:${color};${
          moving ? "box-shadow:0 0 0 3px #c9a227;" : ""
        }">${escapeHtml(label)}</div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
      });
      const marker = L.marker([p.lat, p.lng], { icon });
      const title = p.unit_number
        ? `Unit ${p.unit_number}${p.driver_name ? ` · ${p.driver_name}` : ""}`
        : p.driver_name || p.name || "Vehicle";
      marker.bindPopup(
        `<div class="fleet-popup">
          <strong>${escapeHtml(title)}</strong><br/>
          ${p.address ? `${escapeHtml(p.address)}<br/>` : ""}
          Speed: ${p.speed_mph != null ? `${Math.round(Number(p.speed_mph))} mph` : "—"}
        </div>`
      );
      marker.addTo(layer);
      bounds.push([p.lat, p.lng]);
    }

    if (bounds.length === 1) {
      map.setView(bounds[0], 13);
    } else if (bounds.length > 1) {
      map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 });
    }
  }, []);

  const loadPositions = useCallback(
    async (refresh = false) => {
      try {
        const res = await api<{
          positions?: LivePosition[];
          fetched_at?: string;
        }>(`/live/positions${refresh ? "?refresh=1" : ""}`, { timeoutMs: 45_000 });
        const positions = (Array.isArray(res.positions) ? res.positions : []).filter((p) =>
          isValidCoord(p.lat, p.lng)
        );
        setCount(positions.length);
        setUpdatedAt(res.fetched_at || new Date().toISOString());
        setMapError("");
        onRosterRef.current?.(buildRoster(positions));
        if (mapRef.current) syncMarkers(positions);
      } catch (e) {
        setMapError(e instanceof Error ? e.message : "Could not load GPS");
      }
    },
    [syncMarkers]
  );

  useEffect(() => {
    let cancelled = false;
    let mapInstance: LType | null = null;

    (async () => {
      try {
        const L = await ensureLeaflet();
        if (cancelled || !mapDivRef.current || mapRef.current) return;
        LRef.current = L;
        mapInstance = L.map(mapDivRef.current, {
          zoomControl: true,
          attributionControl: true,
        }).setView([27.75, -97.4], 11);

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(mapInstance);

        const layer = L.layerGroup().addTo(mapInstance);
        mapRef.current = mapInstance;
        layerRef.current = layer;
        setMapReady(true);

        setTimeout(() => {
          try {
            mapInstance?.invalidateSize();
          } catch {
            /* ignore */
          }
        }, 150);

        await loadPositions(true);
        setTimeout(() => {
          try {
            mapInstance?.invalidateSize();
          } catch {
            /* ignore */
          }
        }, 400);
      } catch (e) {
        if (!cancelled) {
          setMapError(e instanceof Error ? e.message : "Map failed to load");
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        if (mapInstance) mapInstance.remove();
        else if (mapRef.current) mapRef.current.remove();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      layerRef.current = null;
      LRef.current = null;
    };
  }, [loadPositions]);

  useEffect(() => {
    if (!mapReady) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadPositions(false);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [mapReady, loadPositions]);

  // Resize map when board layout settles
  useEffect(() => {
    if (!mapReady) return;
    const onResize = () => {
      try {
        mapRef.current?.invalidateSize();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    const t = window.setTimeout(onResize, 500);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
    };
  }, [mapReady]);

  return (
    <section className="tv-panel tv-map-panel">
      <h2>
        Live fleet map
        <span className="tv-panel-count">{count}</span>
      </h2>
      <p className="tv-map-meta muted">
        {mapError
          ? mapError
          : updatedAt
            ? `GPS updated ${new Date(updatedAt).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })} · refreshes every 30s`
            : "Loading GPS…"}
      </p>
      <div className="tv-map-wrap">
        <div ref={mapDivRef} className="tv-map-canvas" />
        {!mapReady && !mapError && <div className="tv-map-loading">Starting map…</div>}
      </div>
    </section>
  );
}

/**
 * Full-screen office wallboard for a TV — no nav chrome.
 * Open on a signed-in office/admin account and leave the browser full-screen (F11).
 */
export function TvBoardPage() {
  const { user } = useAuth();
  const role = user?.role || "";
  const allowed =
    role === "admin" || role === "office" || role === "viewer" || role === "mechanic";

  const [data, setData] = useState<TvBoard | null>(null);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(clockNow);
  const [loading, setLoading] = useState(true);
  /** Unit → tech from live GPS (same feed as map) */
  const [fleetRoster, setFleetRoster] = useState<FleetRosterRow[]>([]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const d = await api<TvBoard>("/tv-board", { timeoutMs: 25_000 });
      setData(d);
      setError("");
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "Could not load board");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    void load();
    const poll = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, 45_000);
    const tick = window.setInterval(() => setClock(clockNow()), 15_000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
    };
  }, [allowed, load]);

  if (!allowed) {
    return (
      <div className="tv-board tv-board-gate">
        <h1>Office TV board</h1>
        <p>Office, admin, mechanic, or viewer login required.</p>
        <Link to="/">Back home</Link>
      </div>
    );
  }

  const c = data?.counts;
  const jobs = data?.shop_today || [];
  const inShop = jobs.filter((j) => j.status === "in_progress");
  const scheduled = jobs.filter((j) => j.status === "scheduled");

  return (
    <div className="tv-board">
      <header className="tv-board-header">
        <div className="tv-board-brand">
          <img
            src="/logo-light.png"
            alt="Total Assurance A/C & Heating"
            className="tv-board-logo"
          />
          <div className="tv-board-titles">
            <h1 className="tv-board-title">Operations board</h1>
            <p className="tv-board-sub">
              Shop date {data?.shop_date || "—"} · board 45s · map 30s
            </p>
          </div>
        </div>
        <div className="tv-board-clock" aria-live="polite">
          {clock}
        </div>
      </header>

      {error && <div className="tv-board-error">{error}</div>}
      {loading && !data && <p className="tv-board-loading">Loading…</p>}

      <div className="tv-board-kpis">
        <div className={`tv-kpi tone-${toneCount(c?.emergencies ?? 0)}`}>
          <span className="tv-kpi-n">{c?.emergencies ?? "—"}</span>
          <span className="tv-kpi-l">Emergencies / critical</span>
        </div>
        <div className={`tv-kpi tone-${toneCount(c?.needs_schedule ?? 0)}`}>
          <span className="tv-kpi-n">{c?.needs_schedule ?? "—"}</span>
          <span className="tv-kpi-l">Need schedule</span>
        </div>
        <div className={`tv-kpi tone-${toneCount(c?.out_of_service ?? 0)}`}>
          <span className="tv-kpi-n">{c?.out_of_service ?? "—"}</span>
          <span className="tv-kpi-l">Out of service</span>
        </div>
        <div className={`tv-kpi tone-${toneCount(c?.weekly_checks_due ?? 0)}`}>
          <span className="tv-kpi-n">{c?.weekly_checks_due ?? "—"}</span>
          <span className="tv-kpi-l">Weekly checks due</span>
        </div>
        <div className={`tv-kpi tone-${toneCount(c?.pickups_waiting ?? 0)}`}>
          <span className="tv-kpi-n">{c?.pickups_waiting ?? "—"}</span>
          <span className="tv-kpi-l">Parts pickup</span>
        </div>
        <div className={`tv-kpi tone-${toneCount(c?.open_warranties ?? 0)}`}>
          <span className="tv-kpi-n" title="Dropped off + submitted claims aging 3+ working days">
            {c?.open_warranties ?? "—"}
          </span>
          <span className="tv-kpi-l">Open warranties</span>
        </div>
        <div className={`tv-kpi tone-${toneCount(c?.parts_dropoffs ?? 0)}`}>
          <span className="tv-kpi-n">{c?.parts_dropoffs ?? "—"}</span>
          <span className="tv-kpi-l">Parts at shop</span>
        </div>
      </div>

      <div className="tv-board-main">
        <TvLiveMap onRoster={setFleetRoster} />

        {/* Unit → tech (replaces old “In the shop now” slot) */}
        <section className="tv-panel tv-roster-panel">
          <h2>
            Who&apos;s out
            <span className="tv-panel-count">{fleetRoster.length}</span>
          </h2>
          {fleetRoster.length === 0 ? (
            <p className="tv-empty">No units on the map yet.</p>
          ) : (
            <ul className="tv-roster-list">
              {fleetRoster.map((row) => (
                <li key={`${row.unit}-${row.tech}`} className="tv-roster-row">
                  <span
                    className="tv-roster-dot"
                    style={{ background: row.color }}
                    title={row.moving ? "Moving" : "Stopped / idle"}
                  />
                  <strong className="tv-roster-unit">{row.unit}</strong>
                  <span className="tv-roster-sep">–</span>
                  <span className="tv-roster-tech">{row.tech}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Bring in today on top, In the shop now below */}
        <div className="tv-board-shop-stack">
          <section className="tv-panel">
            <h2>
              Bring in today
              <span className="tv-panel-count">{scheduled.length}</span>
            </h2>
            {scheduled.length === 0 ? (
              <p className="tv-empty">Nothing scheduled for today.</p>
            ) : (
              <ul className="tv-job-list">
                {scheduled.map((j) => (
                  <li
                    key={j.id}
                    className={`tv-job${j.is_emergency || j.severity === "critical" ? " is-hot" : ""}`}
                  >
                    <div className="tv-job-unit">Unit {j.unit_number}</div>
                    <div className="tv-job-title">{j.title}</div>
                    <div className="tv-job-meta">
                      {j.assigned_driver || j.reporter_name || "—"}
                      {j.schedule_notes ? ` · ${j.schedule_notes}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="tv-panel">
            <h2>
              In the shop now
              <span className="tv-panel-count">{inShop.length}</span>
            </h2>
            {inShop.length === 0 ? (
              <p className="tv-empty">No units marked in progress.</p>
            ) : (
              <ul className="tv-job-list">
                {inShop.map((j) => (
                  <li
                    key={j.id}
                    className={`tv-job${j.is_emergency || j.severity === "critical" ? " is-hot" : ""}`}
                  >
                    <div className="tv-job-unit">Unit {j.unit_number}</div>
                    <div className="tv-job-title">{j.title}</div>
                    <div className="tv-job-meta">
                      {j.assigned_driver || j.reporter_name || "—"}
                      {j.schedule_notes ? ` · ${j.schedule_notes}` : ""}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <footer className="tv-board-footer">
        <span>
          Board update{" "}
          {data?.generated_at
            ? new Date(data.generated_at).toLocaleTimeString(undefined, {
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
              })
            : "—"}
        </span>
        <Link className="tv-board-exit" to="/">
          Exit board
        </Link>
      </footer>
    </div>
  );
}
