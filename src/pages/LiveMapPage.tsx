import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";

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

interface TrackingHealth {
  stale_hours: number;
  counts: {
    not_reporting: number;
    stale_or_offline: number;
    dashcam_policy: number;
    equipment_manual: number;
    unmatched_devices: number;
    total: number;
  };
  issues: TrackingIssue[];
  expected_trackers: number;
  live_matched: number;
}

interface LiveResponse {
  fetched_at: string;
  positions: LivePosition[];
  providers: {
    onestep: { ok: boolean; count: number; error?: string; configured: boolean };
    verizon: { ok: boolean; count: number; error?: string; configured: boolean };
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
        const color = p.provider === "onestep" ? "#1a6b4f" : "#175cd3";
        const moving = typeof p.speed_mph === "number" && p.speed_mph > 3;
        const label = String(p.unit_number || p.name || "?").slice(0, 4);
        const icon = L.divIcon({
          className: "fleet-marker",
          html: `<div class="fleet-pin" style="background:${color};${
            moving ? "box-shadow:0 0 0 3px #c9a227;" : ""
          }">${escapeHtml(label)}</div>`,
          iconSize: [32, 32],
          iconAnchor: [16, 16],
        });

        const marker = L.marker([p.lat, p.lng], { icon });
        const title = p.unit_number
          ? `Unit ${p.unit_number}${p.driver_name ? ` · ${p.driver_name}` : ""}`
          : p.driver_name || p.name || "Vehicle";
        const phone = (p.phone || "").trim();
        const phoneDigits = phone.replace(/[^\d+]/g, "");
        marker.bindPopup(
          `<div class="fleet-popup">
            <strong>${escapeHtml(p.unit_number ? `Unit ${p.unit_number}` : p.name || "Vehicle")}</strong><br/>
            <span>${providerLabel(p.provider)}</span><br/>
            ${p.driver_name ? `Tech: ${escapeHtml(p.driver_name)}<br/>` : ""}
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

  // Create map once
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init once
  }, []);

  // Re-draw markers when filter / tech search / data changes
  useEffect(() => {
    if (!mapReady || !data) return;
    syncMarkers(filtered);
  }, [filter, techSearch, mapReady, data, filtered, syncMarkers]);

  // Always auto-refresh every 30s
  useEffect(() => {
    if (!mapReady) return;
    const id = window.setInterval(() => {
      loadPositions(false);
    }, 30_000);
    return () => window.clearInterval(id);
  }, [mapReady, loadPositions]);

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
              {os.count} units
            </span>
          ) : (
            <span className="badge danger">error</span>
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
            to know their number.
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
                  className={`live-vehicle-row ${selected?.id === p.id ? "selected" : ""}`}
                >
                  <button
                    type="button"
                    className="live-vehicle-select"
                    onClick={() => focusPosition(p)}
                  >
                    <div className="live-vehicle-top">
                      <strong>
                        {p.unit_number ? `Unit ${p.unit_number}` : p.name || "Vehicle"}
                      </strong>
                      <span className={`badge ${p.provider === "onestep" ? "ok" : "info"}`}>
                        {providerLabel(p.provider)}
                      </span>
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
