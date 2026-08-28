import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

export interface LivePosition {
  id: string;
  provider: "onestep" | "verizon";
  name: string;
  driver_name: string | null;
  /** Field App user/employee phone when matched */
  phone?: string | null;
  lat: number;
  lng: number;
  speed_mph: number | null;
  heading: number | null;
  status: string | null;
  address: string | null;
  last_update: string | null;
  vehicle_id: number | null;
  unit_number: string | null;
  plate: string | null;
  online: boolean | null;
  vehicle_status?: string | null;
  out_of_service?: boolean;
}

interface TrackingIssue {
  code: string;
  severity: "bad" | "warn" | string;
  message: string;
  vehicle_id: number | null;
  unit_number: string | null;
  provider?: string | null;
  detail?: string | null;
}

interface CoverageRow {
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  status: string;
  gps_tracker: string | null;
  coverage: "on_map" | "missing" | "no_gps_assigned";
  reason: string;
  provider?: string | null;
}

interface TrackingHealth {
  stale_hours: number;
  counts: {
    not_reporting: number;
    stale_or_offline: number;
    dashcam_policy: number;
    equipment_manual: number;
    unmatched_devices: number;
    total: number;
    missing_from_map?: number;
    on_map?: number;
    no_gps_assigned?: number;
  };
  issues: TrackingIssue[];
  expected_trackers: number;
  live_matched: number;
  coverage?: CoverageRow[];
}

interface ProviderDeviceSummary {
  id: string;
  name: string;
  online: boolean | null;
  has_position: boolean;
  unit_number: string | null;
  vehicle_id: number | null;
}

interface ProviderStatus {
  ok: boolean;
  count: number;
  error?: string;
  configured: boolean;
  total_devices?: number;
  without_position?: number;
  devices?: ProviderDeviceSummary[];
}

interface LiveResponse {
  fetched_at: string;
  positions: LivePosition[];
  providers: {
    onestep: ProviderStatus;
    verizon: ProviderStatus;
  };
  tracking?: TrackingHealth | null;
  error?: string;
}

type Filter = "all" | "onestep" | "verizon";

// Leaflet loaded from CDN
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LType = any;

function providerLabel(p: "onestep" | "verizon") {
  return p === "onestep" ? "OneStep" : "Verizon";
}

function formatTime(iso: string | null) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

/** Open phone Maps / Google Maps with turn-by-turn to these coordinates. */
function openMapsToCoords(lat: number, lng: number, label?: string | null) {
  const dest = `${lat},${lng}`;
  const name = (label || "").trim();
  // Google Maps directions — opens app on most phones, browser on desktop
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}${
    name ? `&destination_place_id=&travelmode=driving` : "&travelmode=driving"
  }`;
  // Prefer native map handlers when available (iOS Safari / Android)
  const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
  const url = isApple
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(dest)}${
        name ? `&q=${encodeURIComponent(name)}` : ""
      }`
    : gmaps;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Dial tech from Field App phone record. */
function callPhone(phone: string) {
  const digits = phone.replace(/[^\d+]/g, "");
  if (!digits) return;
  window.location.href = `tel:${digits}`;
}

function positionTitle(p: LivePosition) {
  return p.unit_number
    ? `Unit ${p.unit_number}${p.driver_name ? ` · ${p.driver_name}` : ""}`
    : p.driver_name || p.name || "Vehicle";
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
    script.onerror = () => reject(new Error("Could not load map library (network/CDN blocked)"));
    document.head.appendChild(script);
  });
}

export function LiveMapPage() {
  const { user } = useAuth();
  const allowed = can(user, "viewLiveMap");
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LType | null>(null);
  const layerRef = useRef<LType | null>(null);
  const LRef = useRef<LType | null>(null);
  const filterRef = useRef<Filter>("all");

  const [data, setData] = useState<LiveResponse | null>(null);
  const [error, setError] = useState("");
  const [mapError, setMapError] = useState("");
  const [loading, setLoading] = useState(true);
  const [mapReady, setMapReady] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [techSearch, setTechSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  filterRef.current = filter;

  const filtered = useMemo(() => {
    const positions = Array.isArray(data?.positions) ? data!.positions : [];
    const q = techSearch.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    return positions.filter((p) => {
      if (!isValidCoord(p.lat, p.lng)) return false;
      if (filter !== "all" && p.provider !== filter) return false;
      if (!q) return true;
      const driver = (p.driver_name || "").toLowerCase();
      const unit = (p.unit_number || "").toLowerCase();
      const unitDigits = unit.replace(/\D/g, "");
      const name = (p.name || "").toLowerCase();
      const plate = (p.plate || "").toLowerCase();
      // Tech name is primary; unit # / plate also work
      if (driver.includes(q)) return true;
      if (name.includes(q)) return true;
      if (unit.includes(q) || (qDigits && unitDigits.includes(qDigits))) return true;
      if (plate.includes(q)) return true;
      // First/last token match: "juan" → Juan Perez
      const tokens = driver.split(/[\s,./]+/).filter(Boolean);
      if (tokens.some((t) => t.startsWith(q) || q.startsWith(t))) return true;
      return false;
    });
  }, [data, filter, techSearch]);

  const syncMarkers = useCallback((positions: LivePosition[]) => {
    const L = LRef.current;
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!L || !layer || !map) return;

    try {
      layer.clearLayers();
      const bounds: [number, number][] = [];

      for (const p of positions) {
        if (!isValidCoord(p.lat, p.lng)) continue;
        const oos = Boolean(p.out_of_service);
        // Red = out of service (still accounted for); green/blue = active by provider
        const color = oos ? "#c53030" : p.provider === "onestep" ? "#1a6b4f" : "#175cd3";
        const moving = !oos && typeof p.speed_mph === "number" && p.speed_mph > 3;
        const label = String(p.unit_number || p.name || "?").slice(0, 4);
        const icon = L.divIcon({
          className: `fleet-marker${oos ? " is-oos" : ""}`,
          html: `<div class="fleet-pin" style="background:${color};${
            moving ? "box-shadow:0 0 0 3px #c9a227;" : ""
          }${oos ? "border:2px solid #fff;outline:1px solid #9b2c2c;" : ""}">${escapeHtml(label)}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        const marker = L.marker([p.lat, p.lng], { icon });
        const phone = (p.phone || "").trim();
        const phoneDigits = phone.replace(/[^\d+]/g, "");
        marker.bindPopup(
          `<div class="fleet-popup">
            <strong>${escapeHtml(p.unit_number ? `Unit ${p.unit_number}` : p.name || "Vehicle")}</strong>
            ${oos ? ` <span style="color:#c53030;font-weight:700">(OUT OF SERVICE)</span>` : ""}<br/>
            <span>${providerLabel(p.provider)}</span><br/>
            ${
              p.driver_name
                ? /^(unassigned|warehouse|shop|pool|yard|spare)/i.test(p.driver_name.trim())
                  ? `${escapeHtml(p.driver_name)}<br/>`
                  : `Tech: ${escapeHtml(p.driver_name)}<br/>`
                : `Unassigned<br/>`
            }
            ${p.address ? `${escapeHtml(p.address)}<br/>` : ""}
            Speed: ${p.speed_mph != null ? `${Math.round(Number(p.speed_mph))} mph` : "—"} ·
            ${escapeHtml(p.status || "—")}<br/>
            Updated: ${escapeHtml(formatTime(p.last_update))}<br/>
            <div class="fleet-popup-actions">
              <a class="fleet-popup-btn" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving" target="_blank" rel="noopener">Map</a>
              ${
                phoneDigits
                  ? `<a class="fleet-popup-btn fleet-popup-call" href="tel:${escapeHtml(phoneDigits)}">Call</a>`
                  : `<span class="muted" style="font-size:0.78rem">No phone on file</span>`
              }
            </div>
          </div>`
        );
        marker.on("click", () => {
          setSelectedId(p.id);
          // Select only — Map / Call are explicit actions (popup + list)
        });
        marker.addTo(layer);
        bounds.push([p.lat, p.lng]);
      }

      if (bounds.length === 1) {
        map.setView(bounds[0], 14);
      } else if (bounds.length > 1) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
      }
    } catch (e) {
      console.error("Marker sync failed", e);
      setMapError(e instanceof Error ? e.message : "Failed to place map markers");
    }
  }, []);

  const loadPositions = useCallback(
    async (refresh = false) => {
      try {
        setError("");
        const res = await api<LiveResponse>(`/live/positions${refresh ? "?refresh=1" : ""}`);
        // Normalize defensive shape
        const normalized: LiveResponse = {
          fetched_at: res.fetched_at || new Date().toISOString(),
          positions: Array.isArray(res.positions) ? res.positions : [],
          providers: {
            onestep: res.providers?.onestep || {
              ok: false,
              count: 0,
              configured: false,
            },
            verizon: res.providers?.verizon || {
              ok: false,
              count: 0,
              configured: false,
            },
          },
          tracking: res.tracking ?? null,
          error: res.error,
        };
        setData(normalized);

        // Markers re-sync via filter/techSearch effect once data lands
        if (mapRef.current) {
          /* effect handles filtered markers */
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load GPS positions");
      } finally {
        setLoading(false);
      }
    },
    [syncMarkers]
  );

  // Create map once (only when role is allowed)
  useEffect(() => {
    if (!allowed) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let mapInstance: LType | null = null;

    (async () => {
      try {
        const L = await ensureLeaflet();
        if (cancelled || !mapDivRef.current) return;

        // Avoid double-init
        if (mapRef.current) return;

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

        // Fix grey tiles when container size settles
        setTimeout(() => {
          try {
            mapInstance?.invalidateSize();
          } catch {
            /* ignore */
          }
        }, 100);

        await loadPositions(true);
      } catch (e) {
        if (!cancelled) {
          setMapError(e instanceof Error ? e.message : "Map failed to load");
          setLoading(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init once when allowed
  }, [allowed]);

  // Re-draw markers when filter / tech search / data changes
  useEffect(() => {
    if (!allowed || !mapReady || !data) return;
    syncMarkers(filtered);
  }, [allowed, filter, techSearch, mapReady, data, filtered, syncMarkers]);

  // Always auto-refresh every 30s
  useEffect(() => {
    if (!allowed || !mapReady) return;
    const id = window.setInterval(() => {
      loadPositions(false);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [allowed, mapReady, loadPositions]);

  function focusPosition(p: LivePosition) {
    if (!isValidCoord(p.lat, p.lng)) return;
    setSelectedId(p.id);
    try {
      mapRef.current?.setView([p.lat, p.lng], 15);
    } catch {
      /* ignore */
    }
  }

  const os = data?.providers?.onestep;
  const vz = data?.providers?.verizon;
  const coverage = data?.tracking?.coverage || [];
  const missingUnits = useMemo(
    () => coverage.filter((c) => c.coverage === "missing"),
    [coverage]
  );
  const noGpsUnits = useMemo(
    () => coverage.filter((c) => c.coverage === "no_gps_assigned"),
    [coverage]
  );
  const onMapUnits = useMemo(
    () => coverage.filter((c) => c.coverage === "on_map"),
    [coverage]
  );
  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) =>
        String(a.unit_number || a.name || "").localeCompare(String(b.unit_number || b.name || ""), undefined, {
          numeric: true,
        })
      ),
    [filtered]
  );

  // When search narrows to one tech, auto-select for Map / Call actions
  const selected = useMemo(() => {
    if (selectedId) {
      const hit = sorted.find((p) => p.id === selectedId);
      if (hit) return hit;
    }
    if (techSearch.trim() && sorted.length === 1) return sorted[0];
    return null;
  }, [selectedId, sorted, techSearch]);

  if (!allowed) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Live map</h2>
        <p className="error" style={{ marginBottom: "0.75rem" }}>
          Live map is for supervisors, warehouse, shop, and office — field techs do not see
          where others are.
        </p>
        <Link to="/" className="btn secondary">
          Back to home
        </Link>
      </div>
    );
  }

  return (
    <div className="live-page">
      <div className="page-header">
        <div>
          <h1>Live map</h1>
          <p>OneStep + Verizon GPS · updates every 30 seconds</p>
        </div>
      </div>

      {/* Provider toggles only — no “All GPS / Updated …” line */}
      <div className="live-status-bar card no-print" style={{ marginBottom: "0.55rem" }}>
        <button
          type="button"
          className={`live-status-item live-provider-toggle${
            filter === "onestep" ? " is-active" : ""
          }`}
          onClick={() => setFilter((f) => (f === "onestep" ? "all" : "onestep"))}
          aria-pressed={filter === "onestep"}
          title={
            filter === "onestep"
              ? "Showing OneStep only — tap again for all"
              : "Show only OneStep GPS"
          }
        >
          <strong>OneStep</strong>{" "}
          {!os ? (
            <span className="badge">…</span>
          ) : !os.configured ? (
            <span className="badge warning">not configured</span>
          ) : os.ok ? (
            <span className={`badge ${filter === "onestep" || filter === "all" ? "ok" : ""}`}>
              {os.count} on map
              {typeof os.without_position === "number" && os.without_position > 0
                ? ` · ${os.without_position} no GPS yet`
                : ""}
            </span>
          ) : (
            <span className="badge danger" title={os.error || "OneStep error"}>
              error
            </span>
          )}
        </button>
        <button
          type="button"
          className={`live-status-item live-provider-toggle${
            filter === "verizon" ? " is-active" : ""
          }`}
          onClick={() => setFilter((f) => (f === "verizon" ? "all" : "verizon"))}
          aria-pressed={filter === "verizon"}
          title={
            filter === "verizon"
              ? "Showing Verizon only — tap again for all"
              : "Show only Verizon GPS"
          }
        >
          <strong>Verizon</strong>{" "}
          {!vz ? (
            <span className="badge">…</span>
          ) : !vz.configured ? (
            <span className="badge warning">not configured</span>
          ) : vz.ok ? (
            <span className={`badge ${filter === "verizon" || filter === "all" ? "ok" : ""}`}>
              {vz.count} units
            </span>
          ) : (
            <span className="badge danger">error</span>
          )}
        </button>
        {os?.ok && typeof os.without_position === "number" && os.without_position > 0 && (
          <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", width: "100%" }}>
            New OneStep trackers appear here automatically once they report a GPS fix.{" "}
            {os.without_position} device{os.without_position === 1 ? "" : "s"} visible in OneStep but
            not on the map yet (no location / not powered on).
          </p>
        )}
        {os && !os.ok && os.error && (
          <p className="error" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem", width: "100%" }}>
            OneStep: {os.error}
          </p>
        )}
        {os?.ok && Array.isArray(os.devices) && os.devices.length > 0 && (
          <details className="live-onestep-devices" style={{ width: "100%", marginTop: "0.45rem" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.88rem" }}>
              All OneStep devices ({os.devices.length}) — new trackers auto-show when they have GPS
            </summary>
            <ul
              className="muted"
              style={{
                margin: "0.4rem 0 0",
                paddingLeft: "1.1rem",
                fontSize: "0.82rem",
                lineHeight: 1.45,
                maxHeight: "9rem",
                overflow: "auto",
              }}
            >
              {os.devices.map((d) => (
                <li key={d.id}>
                  <strong>{d.name}</strong>
                  {d.unit_number ? ` · Unit ${d.unit_number}` : " · not linked to a unit"}
                  {d.has_position ? " · on map" : " · no GPS fix yet"}
                  {d.online === false ? " · offline" : ""}
                </li>
              ))}
            </ul>
          </details>
        )}

        {coverage.length > 0 && (
          <div
            className="live-coverage-panel"
            style={{ width: "100%", marginTop: "0.55rem", fontSize: "0.88rem" }}
          >
            <p style={{ margin: "0 0 0.35rem", fontWeight: 700 }}>
              Fleet coverage:{" "}
              <span className="badge ok">{onMapUnits.length} on map</span>{" "}
              <span className={`badge ${missingUnits.length ? "danger" : ""}`}>
                {missingUnits.length} missing
              </span>{" "}
              <span className={`badge ${noGpsUnits.length ? "warning" : ""}`}>
                {noGpsUnits.length} no GPS system
              </span>
            </p>
            {missingUnits.length > 0 && (
              <details open style={{ marginBottom: "0.35rem" }}>
                <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--danger, #c53030)" }}>
                  Missing from live map ({missingUnits.length}) — expected to track
                </summary>
                <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", lineHeight: 1.45 }}>
                  {missingUnits.map((c) => (
                    <li key={c.vehicle_id}>
                      <strong>Unit {c.unit_number}</strong>
                      {c.assigned_driver ? ` · ${c.assigned_driver}` : ""}
                      {c.gps_tracker ? ` · ${c.gps_tracker}` : ""}
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {c.reason}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {noGpsUnits.length > 0 && (
              <details>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                  No GPS system assigned ({noGpsUnits.length}) — not expected on map yet
                </summary>
                <ul
                  className="muted"
                  style={{ margin: "0.35rem 0 0", paddingLeft: "1.1rem", lineHeight: 1.45 }}
                >
                  {noGpsUnits.map((c) => (
                    <li key={c.vehicle_id}>
                      <strong>Unit {c.unit_number}</strong>
                      {c.assigned_driver ? ` · ${c.assigned_driver}` : ""}
                      {c.status !== "active" ? ` · ${c.status}` : ""}
                    </li>
                  ))}
                </ul>
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
                  Set GPS system to One Step or Verizon on Trucks, and name the tracker so it
                  matches the unit or driver.
                </p>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Search + Map/Call sit ABOVE the map so no scroll is needed */}
      <div className="live-tech-search-bar live-tech-search-top card no-print">
        <label className="live-tech-search">
          <span className="sr-only">Find tech by name</span>
          <input
            type="search"
            value={techSearch}
            onChange={(e) => setTechSearch(e.target.value)}
            placeholder="Find tech by name…"
            autoComplete="off"
            enterKeyHint="search"
          />
          {techSearch.trim() && (
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={() => {
                setTechSearch("");
                setSelectedId(null);
              }}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </label>
        {techSearch.trim() && sorted.length === 0 && (
          <p className="muted live-search-hint">No unit matching “{techSearch.trim()}”</p>
        )}
        {selected && isValidCoord(selected.lat, selected.lng) && (
          <div className="live-tech-actions live-tech-actions-compact">
            <div className="live-tech-actions-who">
              <strong>
                {selected.driver_name ||
                  (selected.unit_number ? `Unit ${selected.unit_number}` : selected.name)}
              </strong>
              {selected.unit_number && selected.driver_name ? (
                <span className="muted"> · Unit {selected.unit_number}</span>
              ) : null}
            </div>
            <div className="live-tech-action-btns">
              <button
                type="button"
                className="btn"
                onClick={() =>
                  openMapsToCoords(selected.lat, selected.lng, positionTitle(selected))
                }
              >
                Map
              </button>
              <button
                type="button"
                className="btn secondary"
                disabled={!selected.phone?.trim()}
                title={
                  selected.phone?.trim()
                    ? `Call ${selected.phone}`
                    : "No phone on file for this tech"
                }
                onClick={() => {
                  if (selected.phone?.trim()) callPhone(selected.phone);
                }}
              >
                Call
              </button>
            </div>
            {!selected.phone?.trim() && (
              <p className="muted live-tech-phone-hint">
                No phone on file — add it under People.
              </p>
            )}
          </div>
        )}
      </div>

      {(error || mapError || os?.error || vz?.error) && (
        <div className="error" style={{ marginBottom: "0.75rem" }}>
          {mapError && <div>{mapError}</div>}
          {error && <div>{error}</div>}
          {os?.error && (
            <div>
              <strong>OneStep:</strong> {os.error}
            </div>
          )}
          {vz?.error && (
            <div>
              <strong>Verizon:</strong> {vz.error}
            </div>
          )}
        </div>
      )}

      <div className="live-layout">
        <div className="live-map-column">
          <div className="live-map-block card">
            <div className="live-map-wrap">
              {(loading || !mapReady) && !mapError && (
                <div className="live-map-overlay">
                  {loading ? "Loading GPS positions…" : "Starting map…"}
                </div>
              )}
              {mapError && (
                <div className="live-map-overlay" style={{ color: "var(--danger)" }}>
                  {mapError}
                </div>
              )}
              <div
                ref={mapDivRef}
                className="live-map"
                role="application"
                aria-label="Fleet live map"
              />
            </div>
          </div>
        </div>

        <div className="live-list card">
          <h2>
            Vehicles ({sorted.length})
            {techSearch.trim() ? (
              <span className="muted" style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                {" "}
                · filtered
              </span>
            ) : null}
          </h2>
          <p className="muted live-list-nav-hint no-print">
            Search or tap a tech, then choose <strong>Map</strong> or <strong>Call</strong> — no need
            to know their number. <span style={{ color: "#c53030", fontWeight: 600 }}>Red</span> =
            out of service (still tracked).
          </p>
          {!sorted.length && !loading && (
            <div className="empty">
              {error
                ? "Could not load positions."
                : techSearch.trim()
                  ? "No tech / unit matches that search."
                  : "No vehicles with GPS for this filter."}
            </div>
          )}
          <ul className="live-vehicle-list">
            {sorted.map((p) => (
              <li key={p.id}>
                <div
                  className={`live-vehicle-row ${selected?.id === p.id ? "selected" : ""}${
                    p.out_of_service ? " is-oos" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="live-vehicle-select"
                    onClick={() => focusPosition(p)}
                  >
                    <div className="live-vehicle-top">
                      <strong style={p.out_of_service ? { color: "#c53030" } : undefined}>
                        {p.unit_number ? `Unit ${p.unit_number}` : p.name || "Vehicle"}
                      </strong>
                      {p.out_of_service ? (
                        <span className="badge danger" title="Out of service — still on map for accountability">
                          Out of service
                        </span>
                      ) : (
                        <span className={`badge ${p.provider === "onestep" ? "ok" : "info"}`}>
                          {providerLabel(p.provider)}
                        </span>
                      )}
                    </div>
                    <div className="live-vehicle-driver">
                      {p.driver_name || "Unassigned"}
                      {typeof p.speed_mph === "number" && p.speed_mph > 0
                        ? ` · ${Math.round(p.speed_mph)} mph`
                        : " · stopped"}
                    </div>
                    {p.address && (
                      <div className="muted" style={{ fontSize: "0.8rem" }}>
                        {p.address}
                      </div>
                    )}
                  </button>
                  <div className="live-vehicle-row-actions">
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={!isValidCoord(p.lat, p.lng)}
                      onClick={() => {
                        focusPosition(p);
                        openMapsToCoords(p.lat, p.lng, positionTitle(p));
                      }}
                    >
                      Map
                    </button>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={!p.phone?.trim()}
                      title={p.phone?.trim() ? `Call ${p.phone}` : "No phone on file"}
                      onClick={() => {
                        focusPosition(p);
                        if (p.phone?.trim()) callPhone(p.phone);
                      }}
                    >
                      Call
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
