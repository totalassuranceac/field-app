import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { isPersonalVehicleUnit, type Vehicle } from "./VehiclesPage";

type Filter = "all" | "expired" | "expiring" | "equipment";

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** N/A = skip. Only missing / not_working need shop attention. */
function gpsOk(v: Vehicle): boolean {
  const status = v.gps_status || "n/a";
  return status !== "not_working" && status !== "missing";
}

function camOk(v: Vehicle): boolean {
  return v.dash_cam_status !== "not_working" && v.dash_cam_status !== "missing";
}

function equipmentGood(v: Vehicle): boolean {
  // Good when both are working; N/A on either side is fine (don't schedule)
  return camOk(v) && gpsOk(v);
}

function worstStatus(v: Vehicle, soonDays: number): "ok" | "warn" | "bad" {
  // Texas: registration sticker + insurance (no state inspection sticker)
  const dates = [v.registration_expires, v.insurance_expires];
  let worst: "ok" | "warn" | "bad" = "ok";
  for (const d of dates) {
    const days = daysUntil(d);
    if (days == null) continue;
    if (days < 0) worst = "bad";
    else if (days <= soonDays && worst !== "bad") worst = "warn";
  }
  if (!equipmentGood(v)) {
    // Missing or broken cam/GPS — schedule installs / repairs
    worst = "bad";
  }
  if (v.status === "out_of_service") worst = worst === "bad" ? "bad" : "warn";
  return worst;
}

export function YardPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [soonDays, setSoonDays] = useState(30);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Vehicle | null>(null);
  const [form, setForm] = useState({
    registration_expires: "",
    insurance_expires: "",
    dash_cam_status: "n/a",
    cam_type: "",
    gps_status: "n/a",
    gps_tracker: "",
    insurance_card: "",
    notes: "",
  });
  async function load(f: Filter = filter) {
    const q = f === "all" ? "" : `?filter=${f}`;
    const data = await api<{ vehicles: Vehicle[]; expiring_soon_days: number }>(`/vehicles${q}`);
    setVehicles(data.vehicles);
    setSoonDays(data.expiring_soon_days || 30);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [filter]);

  const sorted = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    let list = [...vehicles];
    if (q) {
      list = list.filter((v) => {
        const unit = (v.unit_number || "").toLowerCase();
        const unitDigits = unit.replace(/\D/g, "");
        const driver = (v.assigned_driver || "").toLowerCase();
        const plate = (v.plate || "").toLowerCase();
        // Prefer unit number: "8", "008", "unit 8" all match
        if (unit.includes(q) || (qDigits && unitDigits.includes(qDigits))) return true;
        if (driver.includes(q) || plate.includes(q)) return true;
        return false;
      });
      // Exact / starts-with unit matches first when searching
      list.sort((a, b) => {
        const au = a.unit_number.toLowerCase();
        const bu = b.unit_number.toLowerCase();
        const aExact = au === q || au.replace(/\D/g, "") === qDigits ? 0 : au.startsWith(q) ? 1 : 2;
        const bExact = bu === q || bu.replace(/\D/g, "") === qDigits ? 0 : bu.startsWith(q) ? 1 : 2;
        return aExact - bExact || au.localeCompare(bu, undefined, { numeric: true });
      });
      return list;
    }
    return list.sort((a, b) => {
      const rank = { bad: 0, warn: 1, ok: 2 };
      return (
        rank[worstStatus(a, soonDays)] - rank[worstStatus(b, soonDays)] ||
        a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true })
      );
    });
  }, [vehicles, soonDays, search]);

  function openVehicle(v: Vehicle) {
    setSelected(v);
    setOk("");
    setError("");
    setForm({
      registration_expires: v.registration_expires || "",
      insurance_expires: v.insurance_expires || "",
      dash_cam_status: v.dash_cam_status,
      cam_type: (() => {
        const c = (v.cam_type || "").toLowerCase();
        if (/verizon/.test(c)) return "Verizon";
        if (c) return "Third-party";
        return "";
      })(),
      gps_status: v.gps_status === "unknown" || !v.gps_status ? "n/a" : v.gps_status,
      gps_tracker: (() => {
        const g = (v.gps_tracker || "").toLowerCase();
        if (/verizon/.test(g)) return "Verizon";
        if (/one\s*step|onestep/.test(g)) return "One Step";
        return v.gps_tracker || "";
      })(),
      insurance_card: v.insurance_card || "",
      notes: v.notes || "",
    });
  }

  function equipmentNeedsShop(status: string): boolean {
    return status === "not_working" || status === "missing";
  }

  async function createShopTicket(
    vehicleId: number,
    unit: string,
    kind: "dash_cam" | "gps",
    statusLabel: string,
    extra?: string
  ): Promise<"created" | "exists" | "error"> {
    try {
      const open = await api<{ issues: Array<{ vehicle_id: number; issue_category: string | null; status: string }> }>(
        "/issues?report=needs_schedule"
      ).catch(() => ({ issues: [] as Array<{ vehicle_id: number; issue_category: string | null; status: string }> }));
      const already = (open.issues || []).some(
        (i) =>
          i.vehicle_id === vehicleId &&
          i.issue_category === kind &&
          (i.status === "open" || i.status === "scheduled" || i.status === "in_progress")
      );
      // Also check full board in case already scheduled
      if (!already) {
        const board = await api<{
          issues: Array<{ vehicle_id: number; issue_category: string | null; status: string }>;
        }>("/issues?report=schedule").catch(() => ({ issues: [] as Array<{ vehicle_id: number; issue_category: string | null; status: string }> }));
        if (
          (board.issues || []).some(
            (i) =>
              i.vehicle_id === vehicleId &&
              i.issue_category === kind &&
              ["open", "scheduled", "in_progress"].includes(i.status)
          )
        ) {
          return "exists";
        }
      } else {
        return "exists";
      }

      const title =
        kind === "dash_cam"
          ? `Dash cam ${statusLabel.replace(/_/g, " ")}`
          : `GPS tracker ${statusLabel.replace(/_/g, " ")}`;
      const description = [
        `Found on yard walk · Unit ${unit}`,
        kind === "dash_cam"
          ? `Dash cam status: ${statusLabel.replace(/_/g, " ")}`
          : `GPS status: ${statusLabel.replace(/_/g, " ")}`,
        form.cam_type && kind === "dash_cam" ? `Cam type: ${form.cam_type}` : "",
        form.gps_tracker && kind === "gps" ? `GPS system: ${form.gps_tracker}` : "",
        extra?.trim() || "",
        form.notes?.trim() ? `Yard notes: ${form.notes.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await api("/issues", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: vehicleId,
          issue_category: kind,
          title,
          description,
          severity: "medium",
        }),
      });
      return "created";
    } catch {
      return "error";
    }
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!selected || !can(user, "manageVehicles")) return;
    setBusy(true);
    setError("");
    setOk("");
    const canCompliance = can(user, "manageVehicleCompliance");
    const personal = isPersonalVehicleUnit(selected.unit_number);
    const payload: Record<string, unknown> = {
      dash_cam_status: form.dash_cam_status,
      cam_type: form.cam_type || null,
      gps_status: form.gps_status,
      gps_tracker: form.gps_tracker || null,
      notes: form.notes,
    };
    if (canCompliance) {
      payload.registration_expires = form.registration_expires || null;
      payload.insurance_card = form.insurance_card || null;
      if (personal) {
        payload.insurance_expires = form.insurance_expires || null;
      } else if (form.insurance_expires) {
        // Updating insurance on a company unit from yard = fleet-wide plan
        payload.insurance_expires = form.insurance_expires;
      }
    }
    try {
      await api(`/vehicles/${selected.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      // Problems auto-go to shop board; working / n/a just save
      const shopNotes: string[] = [];
      if (can(user, "reportIssues")) {
        if (equipmentNeedsShop(form.dash_cam_status)) {
          const r = await createShopTicket(
            selected.id,
            selected.unit_number,
            "dash_cam",
            form.dash_cam_status
          );
          if (r === "created") shopNotes.push("dash cam → shop board");
          else if (r === "exists") shopNotes.push("dash cam already on shop board");
          else shopNotes.push("dash cam ticket failed");
        }
        if (equipmentNeedsShop(form.gps_status)) {
          const r = await createShopTicket(
            selected.id,
            selected.unit_number,
            "gps",
            form.gps_status
          );
          if (r === "created") shopNotes.push("GPS → shop board");
          else if (r === "exists") shopNotes.push("GPS already on shop board");
          else shopNotes.push("GPS ticket failed");
        }
      }

      setOk(
        shopNotes.length
          ? `Saved. ${shopNotes.join(" · ")}.`
          : "Yard update saved."
      );
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="yard-page">
      <div className="page-header yard-page-header">
        <div>
          <h1>Yard walk</h1>
          <p>
            Reg · insurance · cam · GPS. Not working or missing cam/GPS is saved to the{" "}
            <Link to="/issues">shop board</Link> automatically.
          </p>
        </div>
        <button className="btn secondary btn-sm no-print" onClick={() => window.print()}>
          Print
        </button>
      </div>
      {ok && <div className="success inv-flash no-print">{ok}</div>}
      {error && <div className="error inv-flash no-print">{error}</div>}

      <div className="filters yard-filters no-print">
        <label className="yard-search">
          <input
            type="search"
            inputMode="search"
            enterKeyHint="search"
            placeholder="Unit #…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
            aria-label="Find unit by number"
          />
          {search && (
            <button
              type="button"
              className="btn secondary btn-sm yard-search-clear"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </label>
        {(
          [
            ["all", "All"],
            ["expired", "Expired"],
            ["expiring", `≤${soonDays}d`],
            ["equipment", "Cam/GPS"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`chip chip-sm ${filter === k ? "active" : ""}`}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}

      {search.trim() && (
        <p className="muted no-print yard-search-hint">
          {sorted.length === 0
            ? `No unit matching “${search.trim()}”`
            : sorted.length === 1
              ? `1 unit · tap to open`
              : `${sorted.length} match “${search.trim()}”`}
        </p>
      )}

      <div className="yard-grid">
        {sorted.map((v) => {
          const status = worstStatus(v, soonDays);
          const vehicleLine = [v.year, v.make, v.model].filter(Boolean).join(" ") || "—";
          const camLabel =
            v.dash_cam_status === "n/a" ? "N/A" : v.dash_cam_status.replace(/_/g, " ");
          const gpsLabel =
            v.gps_status === "n/a" || !v.gps_status
              ? "N/A"
              : v.gps_status.replace(/_/g, " ");
          return (
            <button
              key={v.id}
              type="button"
              className={`yard-card status-${status}`}
              onClick={() => openVehicle(v)}
            >
              <div className="yard-card-top">
                <span className="unit">{v.unit_number}</span>
                <span
                  className={`badge badge-sm ${
                    status === "bad" ? "expired" : status === "warn" ? "expiring" : "ok"
                  }`}
                >
                  {status === "bad" ? "Attention" : status === "warn" ? "Soon" : "OK"}
                </span>
              </div>
              <div className="yard-card-driver muted">
                {v.assigned_driver || "Unassigned"}
              </div>
              <div className="yard-card-vehicle muted">
                {vehicleLine}
                {v.plate ? ` · ${v.plate}` : ""}
              </div>
              <div className="yard-card-badges">
                <span className={`badge badge-sm ${!camOk(v) ? "danger" : "ok"}`}>
                  Cam {camLabel}
                </span>
                <span className={`badge badge-sm ${!gpsOk(v) ? "danger" : "ok"}`}>
                  GPS {gpsLabel}
                  {v.gps_tracker ? ` · ${v.gps_tracker}` : ""}
                </span>
                {!camOk(v) && (
                  <span className="badge badge-sm danger">
                    {v.dash_cam_status === "missing" ? "Install cam" : "Fix cam"}
                  </span>
                )}
                {!gpsOk(v) && (
                  <span className="badge badge-sm danger">
                    {v.gps_status === "missing" ? "Install GPS" : "Fix GPS"}
                  </span>
                )}
              </div>
              <div className="yard-card-dates">
                <span>
                  <strong>Reg</strong> {v.registration_expires || "—"}
                  {dateHint(v.registration_expires, soonDays)}
                </span>
                <span>
                  <strong>Ins</strong> {v.insurance_expires || "—"}
                  {dateHint(v.insurance_expires, soonDays)}
                </span>
              </div>
            </button>
          );
        })}
      </div>
      {!sorted.length && <div className="empty">No vehicles match this filter.</div>}

      {selected && (
        <div className="modal-backdrop" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Unit {selected.unit_number}</h2>
            <p className="muted">
              {[selected.year, selected.make, selected.model].filter(Boolean).join(" ")} · {selected.plate}
            </p>
            {can(user, "manageVehicles") ? (
              <form className="form" onSubmit={save}>
                {can(user, "manageVehicleCompliance") ? (
                  <>
                    <label>
                      Registration sticker expires
                      <input
                        type="date"
                        value={form.registration_expires}
                        onChange={(e) =>
                          setForm({ ...form, registration_expires: e.target.value })
                        }
                      />
                    </label>
                    {isPersonalVehicleUnit(selected.unit_number) ? (
                      <label>
                        Insurance expires (personal policy)
                        <input
                          type="date"
                          value={form.insurance_expires}
                          onChange={(e) =>
                            setForm({ ...form, insurance_expires: e.target.value })
                          }
                        />
                      </label>
                    ) : (
                      <label>
                        Company fleet insurance expires
                        <input
                          type="date"
                          value={form.insurance_expires}
                          onChange={(e) =>
                            setForm({ ...form, insurance_expires: e.target.value })
                          }
                        />
                        <span className="muted" style={{ fontSize: "0.78rem" }}>
                          Shared plan for all company vans (not personal P-units).
                        </span>
                      </label>
                    )}
                    <label>
                      Insurance card on vehicle
                      <select
                        value={form.insurance_card}
                        onChange={(e) => setForm({ ...form, insurance_card: e.target.value })}
                      >
                        <option value="">—</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                        <option value="N/A">N/A</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <div className="muted" style={{ fontSize: "0.88rem", marginBottom: "0.5rem" }}>
                    <p style={{ margin: "0 0 0.25rem" }}>
                      Reg: <strong>{selected.registration_expires || "—"}</strong>
                      {" · "}
                      Ins: <strong>{selected.insurance_expires || "—"}</strong>
                      {isPersonalVehicleUnit(selected.unit_number)
                        ? " (personal)"
                        : " (fleet plan)"}
                    </p>
                    <p style={{ margin: 0 }}>Office or shop set registration / insurance dates.</p>
                  </div>
                )}
                <label>
                  Dash cam status
                  <select
                    value={form.dash_cam_status === "unknown" ? "n/a" : form.dash_cam_status}
                    onChange={(e) => setForm({ ...form, dash_cam_status: e.target.value })}
                  >
                    <option value="working">Working</option>
                    <option value="not_working">Not working</option>
                    <option value="missing">Missing</option>
                    <option value="n/a">N/A (no cam)</option>
                  </select>
                </label>
                {equipmentNeedsShop(form.dash_cam_status) && (
                  <p className="muted yard-auto-shop-hint">
                    Not working / missing → automatically added to the shop board when you save.
                  </p>
                )}
                <label>
                  Cam type
                  <select
                    value={form.cam_type}
                    onChange={(e) => setForm({ ...form, cam_type: e.target.value })}
                  >
                    <option value="">—</option>
                    <option value="Verizon">Verizon (monthly)</option>
                    <option value="Third-party">Third-party (no fee)</option>
                  </select>
                </label>
                <label>
                  GPS status
                  <select
                    value={form.gps_status === "unknown" ? "n/a" : form.gps_status}
                    onChange={(e) => setForm({ ...form, gps_status: e.target.value })}
                  >
                    <option value="working">Working</option>
                    <option value="not_working">Not working</option>
                    <option value="missing">Missing</option>
                    <option value="n/a">N/A (no paid tracker)</option>
                  </select>
                </label>
                {equipmentNeedsShop(form.gps_status) && (
                  <p className="muted yard-auto-shop-hint">
                    Not working / missing → automatically added to the shop board when you save.
                  </p>
                )}
                <label>
                  GPS system
                  <select
                    value={form.gps_tracker}
                    onChange={(e) => {
                      const gps_tracker = e.target.value;
                      let cam_type = form.cam_type;
                      if (gps_tracker === "Verizon" && !cam_type) cam_type = "Verizon";
                      if (gps_tracker === "One Step" && (!cam_type || cam_type === "Verizon")) {
                        cam_type = "Third-party";
                      }
                      setForm({ ...form, gps_tracker, cam_type });
                    }}
                  >
                    <option value="">— none / cancelled —</option>
                    <option value="One Step">One Step</option>
                    <option value="Verizon">Verizon</option>
                  </select>
                </label>
                {(form.gps_tracker === "Verizon" || form.gps_tracker === "One Step") && (
                  <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                    {form.gps_tracker === "Verizon"
                      ? "Verizon GPS → Verizon dash cam · must show on live map."
                      : "OneStep GPS → third-party cam (no monthly fee) · must show on live map."}
                  </p>
                )}
                <label>
                  Notes
                  <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </label>
                <div className="toolbar">
                  <button className="btn" type="submit" disabled={busy}>
                    {busy ? "Saving…" : "Save update"}
                  </button>
                  <button className="btn secondary" type="button" onClick={() => setSelected(null)}>
                    Close
                  </button>
                </div>
              </form>
            ) : (
              <div>
                <p>Registration: {selected.registration_expires || "—"}</p>
                <p>Insurance: {selected.insurance_expires || "—"}</p>
                <p>
                  Dash cam:{" "}
                  {selected.dash_cam_status === "n/a" ? "N/A" : selected.dash_cam_status}
                </p>
                <p>
                  GPS:{" "}
                  {selected.gps_status === "n/a" || !selected.gps_status
                    ? "N/A"
                    : selected.gps_status}{" "}
                  {selected.gps_tracker ? `(${selected.gps_tracker})` : ""}
                </p>
                <button className="btn secondary" type="button" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function dateHint(dateStr: string | null, soonDays: number) {
  const d = daysUntil(dateStr);
  if (d == null) return null;
  if (d < 0) return <span className="badge badge-sm expired">{Math.abs(d)}d late</span>;
  if (d <= soonDays) return <span className="badge badge-sm expiring">{d}d</span>;
  return null;
}
