import { FormEvent, useEffect, useMemo, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

interface Vehicle {
  id: number;
  unit_number: string;
  assigned_driver?: string | null;
}

interface WeeklyRow {
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  status: string;
  last_check_date: string | null;
  last_status: string | null;
  due: number;
  open_repairs: number;
}

interface Inspection {
  id: number;
  vehicle_id: number;
  unit_number: string;
  inspector_name: string;
  inspection_date: string;
  odometer: number | null;
  overall_status: string;
  notes: string | null;
  created_issue_id: number | null;
  created_at: string;
}

const CHECK_ITEMS = [
  { key: "tires", label: "Tires / tread / pressure" },
  { key: "lights", label: "Lights / signals / hazards" },
  { key: "brakes", label: "Brakes / parking brake" },
  { key: "fluids", label: "Oil / coolant / washer fluid" },
  { key: "body", label: "Body damage / glass" },
  { key: "interior", label: "Interior / seatbelts" },
  { key: "dash_cam", label: "Dash cam working" },
  { key: "gps", label: "GPS unit present / powered" },
  { key: "registration", label: "Registration / inspection stickers current" },
  { key: "tools", label: "Tools / ladder / equipment secure" },
];

/** Last check as MM/YY, or N/A if never checked */
function formatCheckWhen(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (m) return `${m[2]}/${m[1].slice(2)}`;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "Never";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  return `${mm}/${yy}`;
}

type StatusTone = "good" | "repair" | "down";

/** Green = working, yellow = needs attention / due, red = down */
function unitStatus(w: WeeklyRow): { tone: StatusTone; label: string; detail: string } {
  if (w.status === "out_of_service") {
    return { tone: "down", label: "Down", detail: "Out of service" };
  }
  if (w.last_status === "fail") {
    return { tone: "down", label: "Down", detail: "Failed last check" };
  }
  if ((w.open_repairs && w.open_repairs > 0) || w.last_status === "pass_with_notes") {
    return { tone: "repair", label: "Repair", detail: "Has open issues" };
  }
  if (w.due || !w.last_check_date) {
    return {
      tone: "repair",
      label: "Due",
      detail: w.last_check_date ? "Weekly check due" : "Never checked — do it now",
    };
  }
  if (w.last_status === "pass" || !w.last_status) {
    return { tone: "good", label: "Good", detail: "Working order" };
  }
  return { tone: "repair", label: "Check", detail: "Needs a check" };
}

function normName(s: string | null | undefined): string {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isMyUnit(
  w: WeeklyRow,
  user: { display_name?: string | null } | null
): boolean {
  if (!user) return false;
  const ad = normName(w.assigned_driver);
  const me = normName(user.display_name);
  if (!ad || !me) return false;
  return ad === me || ad.includes(me) || me.includes(ad);
}

export function InspectionsPage() {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [weekly, setWeekly] = useState<WeeklyRow[]>([]);
  const [list, setList] = useState<Inspection[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<"full" | "ok" | "issue">("full");

  const [vehicleId, setVehicleId] = useState("");
  const [odometer, setOdometer] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [checks, setChecks] = useState<Record<string, string>>(
    Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"]))
  );

  /** Collapsible sections — keep the page clean */
  const [recentOpen, setRecentOpen] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);

  const canCheck = can(user, "reportIssues");
  const isField = user?.role === "driver" || user?.role === "mechanic";

  async function load() {
    const [v, i, w] = await Promise.all([
      api<{ vehicles: Vehicle[] }>("/vehicles?filter=active"),
      api<{ inspections: Inspection[] }>("/inspections"),
      api<{ vehicles: WeeklyRow[] }>("/inspections/weekly-status"),
    ]);
    setVehicles(v.vehicles);
    setList(i.inspections);
    setWeekly(w.vehicles);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  function openQuick(vehicleIdNum: number, kind: "ok" | "issue") {
    setVehicleId(String(vehicleIdNum));
    setMode(kind);
    setNotes("");
    // Issue flow is notes-first; full checklist only for "full" mode
    setChecks(Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"])));
    setDate(new Date().toISOString().slice(0, 10));
    setShow(true);
  }

  function overallFromChecks(): "pass" | "pass_with_notes" | "fail" {
    if (mode === "ok") return "pass";
    if (mode === "issue") return "pass_with_notes";
    const vals = Object.values(checks);
    if (vals.some((v) => v === "fail")) return "fail";
    if (vals.some((v) => v === "attention") || notes.trim()) return "pass_with_notes";
    return "pass";
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    try {
      const overall = overallFromChecks();
      // Ticket only when problems found — never for a clean "all good" check
      const openTicket = overall !== "pass";
      const checklist =
        mode === "ok"
          ? Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"]))
          : mode === "issue"
            ? { reported: "attention" }
            : checks;
      const res = await api<{ created_issue_id: number | null }>("/inspections", {
        method: "POST",
        body: JSON.stringify({
          vehicle_id: Number(vehicleId),
          inspection_date: date,
          odometer: odometer === "" ? null : Number(odometer),
          overall_status: overall,
          checklist,
          notes: notes || null,
          create_issue_on_fail: openTicket,
        }),
      });
      if (overall === "pass") {
        setOk("Saved — van marked in working order for this week. No shop ticket.");
      } else if (res.created_issue_id) {
        setOk(`Saved. Repair ticket #${res.created_issue_id} opened for the shop.`);
      } else {
        setOk("Weekly check saved with notes.");
      }
      setShow(false);
      setMode("full");
      setNotes("");
      setOdometer("");
      setChecks(Object.fromEntries(CHECK_ITEMS.map((c) => [c.key, "ok"])));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  const groups = useMemo(() => {
    const mine: WeeklyRow[] = [];
    const needsCheck: WeeklyRow[] = [];
    const done: WeeklyRow[] = [];
    for (const w of weekly) {
      if (isMyUnit(w, user)) {
        mine.push(w);
        continue;
      }
      const st = unitStatus(w);
      if (st.tone !== "good" || w.due || !w.last_check_date) {
        needsCheck.push(w);
      } else {
        done.push(w);
      }
    }
    // Mine that also need a check rise first within mine
    mine.sort((a, b) => {
      const ad = unitStatus(a).tone === "good" && !a.due ? 1 : 0;
      const bd = unitStatus(b).tone === "good" && !b.due ? 1 : 0;
      return ad - bd || a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true });
    });
    const sortUnits = (a: WeeklyRow, b: WeeklyRow) =>
      a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true });
    needsCheck.sort(sortUnits);
    done.sort(sortUnits);
    return { mine, needsCheck, done };
  }, [weekly, user]);

  function renderUnitCard(w: WeeklyRow, opts?: { featured?: boolean }) {
    const st = unitStatus(w);
    const when = formatCheckWhen(w.last_check_date);
    const featured = opts?.featured;
    return (
      <article
        key={w.vehicle_id}
        className={`weekly-card tone-${st.tone}${featured ? " is-featured" : ""}`}
      >
        <div className="weekly-card-main">
          <div className="weekly-card-id">
            <strong className="weekly-unit">Unit {w.unit_number}</strong>
            <span className="weekly-driver muted">
              {w.assigned_driver || "Unassigned"}
              {featured ? " · your van" : ""}
            </span>
          </div>
          <div className="weekly-card-meta">
            <span className={`weekly-status-pill tone-${st.tone}`} title={st.detail}>
              {st.label}
            </span>
            <span className="weekly-when" title="Last weekly check">
              Last check: {when}
            </span>
          </div>
        </div>

        {canCheck && (
          <div className="weekly-card-actions no-print">
            <button
              className="weekly-act good"
              type="button"
              onClick={() => openQuick(w.vehicle_id, "ok")}
            >
              <span className="weekly-act-title">All good</span>
              <span className="weekly-act-hint">Van is working</span>
            </button>
            <button
              className="weekly-act issue"
              type="button"
              onClick={() => openQuick(w.vehicle_id, "issue")}
            >
              <span className="weekly-act-title">Needs repair</span>
              <span className="weekly-act-hint">Something’s wrong</span>
            </button>
          </div>
        )}
      </article>
    );
  }

  return (
    <div className="weekly-page">
      <div className="page-header">
        <div>
          <h1>Weekly checks</h1>
          <p className="weekly-lead">
            Check your van once a week. Pick one button — that’s it.
          </p>
        </div>
        {canCheck && !isField && (
          <button
            className="btn secondary no-print"
            type="button"
            style={{ padding: "0.35rem 0.65rem", fontSize: "0.82rem" }}
            onClick={() => {
              setMode("full");
              setShow(true);
            }}
          >
            Full checklist
          </button>
        )}
      </div>

      {error && <div className="error">{error}</div>}
      {ok && <div className="success">{ok}</div>}

      <div className="weekly-howto card" role="note">
        <div className="weekly-howto-step">
          <span className="weekly-howto-num good" aria-hidden>
            ✓
          </span>
          <div>
            <strong>All good</strong>
            <p>Van is in working order — lights, tires, fluids, cam, GPS all fine.</p>
          </div>
        </div>
        <div className="weekly-howto-step">
          <span className="weekly-howto-num repair" aria-hidden>
            !
          </span>
          <div>
            <strong>Needs repair</strong>
            <p>Something is wrong or worn. Describe it — a shop ticket is opened for you.</p>
          </div>
        </div>
      </div>

      {/* Your unit(s) first for field staff */}
      {groups.mine.length > 0 && (
        <section className="weekly-section" aria-label="Your van">
          <h2 className="weekly-section-title">
            {groups.mine.length === 1 ? "Your van" : "Your vans"}
          </h2>
          <div className="weekly-list">{groups.mine.map((w) => renderUnitCard(w, { featured: true }))}</div>
        </section>
      )}

      {/* Units that still need attention */}
      {groups.needsCheck.length > 0 && (
        <section className="weekly-section" aria-label="Need a check">
          {/* Field techs with a personal van: other vans stay collapsed so the page stays simple */}
          {isField && groups.mine.length > 0 ? (
            <>
              <button
                type="button"
                className="weekly-collapse-toggle"
                aria-expanded={otherOpen}
                onClick={() => setOtherOpen((o) => !o)}
              >
                <span>
                  Other vans that need a check
                  <span className="weekly-section-count soft">{groups.needsCheck.length}</span>
                </span>
                <span className="weekly-chevron" aria-hidden>
                  {otherOpen ? "▾" : "▸"}
                </span>
              </button>
              {otherOpen && (
                <div className="weekly-list">
                  {groups.needsCheck.map((w) => renderUnitCard(w))}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="weekly-section-head">
                <h2 className="weekly-section-title">Vans that need a check</h2>
                <span className="weekly-section-count">{groups.needsCheck.length}</span>
              </div>
              <div className="weekly-list">
                {groups.needsCheck.map((w) => renderUnitCard(w))}
              </div>
            </>
          )}
        </section>
      )}

      {/* Already good — collapsible */}
      {groups.done.length > 0 && (
        <section className="weekly-section weekly-section-muted">
          <button
            type="button"
            className="weekly-collapse-toggle"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((o) => !o)}
          >
            <span>
              Already checked this week
              <span className="weekly-section-count soft">{groups.done.length}</span>
            </span>
            <span className="weekly-chevron" aria-hidden>
              {doneOpen ? "▾" : "▸"}
            </span>
          </button>
          {doneOpen && (
            <div className="weekly-list">{groups.done.map((w) => renderUnitCard(w))}</div>
          )}
        </section>
      )}

      {!weekly.length && <div className="empty card">No vehicles to show.</div>}

      {/* Recent history — collapsible, closed by default */}
      <section className="card weekly-recent">
        <button
          type="button"
          className="weekly-collapse-toggle"
          aria-expanded={recentOpen}
          onClick={() => setRecentOpen((o) => !o)}
        >
          <span>
            Recent checks
            {list.length > 0 && (
              <span className="weekly-section-count soft">{Math.min(list.length, 12)}</span>
            )}
          </span>
          <span className="weekly-chevron" aria-hidden>
            {recentOpen ? "▾" : "▸"}
          </span>
        </button>
        {recentOpen &&
          (!list.length ? (
            <div className="empty">No checks yet.</div>
          ) : (
            <ul className="weekly-recent-list">
              {list.slice(0, 12).map((i) => {
                const tone: StatusTone =
                  i.overall_status === "fail"
                    ? "down"
                    : i.overall_status === "pass_with_notes"
                      ? "repair"
                      : "good";
                return (
                  <li key={i.id} className="weekly-recent-row">
                    <span className={`weekly-status-pill sm tone-${tone}`}>
                      {tone === "good" ? "Good" : tone === "down" ? "Down" : "Repair"}
                    </span>
                    <div className="weekly-recent-meta">
                      <strong>Unit {i.unit_number}</strong>
                      <span className="muted">
                        {formatCheckWhen(i.inspection_date)} · {i.inspector_name}
                        {i.notes ? ` · ${i.notes.slice(0, 40)}` : ""}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ))}
      </section>

      {canCheck && isField && (
        <p className="weekly-advanced muted">
          <button
            type="button"
            className="linkish"
            onClick={() => {
              setMode("full");
              setShow(true);
            }}
          >
            Open full item-by-item checklist
          </button>
        </p>
      )}

      {show && (
        <div className="modal-backdrop" onClick={() => setShow(false)}>
          <div className="modal weekly-modal" onClick={(e) => e.stopPropagation()}>
            <h2>
              {mode === "ok"
                ? "Confirm: all good"
                : mode === "issue"
                  ? "Report: needs repair"
                  : "Full inspection checklist"}
            </h2>
            {mode === "ok" && (
              <p className="weekly-modal-lead">
                You’re saying this van is in working order for the week.
              </p>
            )}
            {mode === "issue" && (
              <p className="weekly-modal-lead">
                Describe what’s wrong. We’ll open a shop ticket so it gets fixed.
              </p>
            )}
            <form className="form" onSubmit={onSubmit}>
              <label>
                Vehicle
                <select
                  value={vehicleId}
                  onChange={(e) => setVehicleId(e.target.value)}
                  required
                >
                  <option value="">Select…</option>
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.unit_number}
                      {v.assigned_driver ? ` — ${v.assigned_driver}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form row">
                <label>
                  Date
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    required
                  />
                </label>
                <label>
                  Odometer (optional)
                  <input
                    type="number"
                    value={odometer}
                    onChange={(e) => setOdometer(e.target.value)}
                    inputMode="decimal"
                  />
                </label>
              </div>

              {mode === "full" && (
                <div className="checklist">
                  {CHECK_ITEMS.map((c) => (
                    <div className="checklist-item" key={c.key}>
                      <div style={{ flex: 1 }}>
                        <strong>{c.label}</strong>
                      </div>
                      <select
                        value={checks[c.key]}
                        onChange={(e) => setChecks({ ...checks, [c.key]: e.target.value })}
                      >
                        <option value="ok">OK</option>
                        <option value="attention">Attention</option>
                        <option value="fail">Fail</option>
                      </select>
                    </div>
                  ))}
                </div>
              )}

              <label>
                {mode === "ok" ? "Notes (optional)" : "What’s wrong?"}
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  required={mode === "issue"}
                  rows={mode === "issue" ? 4 : 2}
                  placeholder={
                    mode === "issue"
                      ? "Example: Right brake light out, noticed this morning"
                      : mode === "full"
                        ? "Describe problems if anything needs attention"
                        : "Optional note"
                  }
                />
              </label>

              {mode === "issue" && (
                <p className="muted" style={{ margin: 0, fontSize: "0.82rem" }}>
                  A shop repair ticket opens automatically when you save.
                </p>
              )}

              <div className="toolbar">
                <button className="btn" type="submit">
                  {mode === "ok"
                    ? "Save — all good"
                    : mode === "issue"
                      ? "Save — needs repair"
                      : "Submit check"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setShow(false);
                    setMode("full");
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
