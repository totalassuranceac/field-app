import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { ShopJobPartsPanel } from "../components/ShopJobPartsPanel";
import { PhotoCapture } from "../components/PhotoCapture";
import { TruckProblemCard } from "../components/TruckProblemCard";
import { compressPhoto } from "../lib/compressPhoto";

type Tab = "queue" | "vehicles" | "board" | "settings";

type QueueRow = {
  id: number;
  vehicle_id: number;
  unit_number: string;
  year?: number | null;
  make?: string | null;
  model?: string | null;
  title: string;
  severity: string;
  status: string;
  kind?: string | null;
  pm_code?: string | null;
  due_reason?: string | null;
  truck_down?: number;
  reporter_name?: string;
  reported_ct?: string;
  current_stage?: string;
  stage_days?: number;
  open_days?: number;
  age_tone?: string;
  chip_new?: boolean;
  stage_sub?: string;
  reliable_odometer?: { miles?: number | null; confidence?: string } | number | null;
};

type Config = {
  ready: boolean;
  can: { view: boolean; work: boolean; pm: boolean; board: boolean; report: boolean; settings: boolean };
};

function odoText(row: QueueRow): string {
  const o = row.reliable_odometer;
  if (o && typeof o === "object") return o.miles ? `${Number(o.miles).toLocaleString()} mi (${o.confidence || ""})` : "";
  if (typeof o === "number") return `${o.toLocaleString()} mi`;
  return "";
}

export function FleetShopPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [tab, setTab] = useState<Tab>("queue");
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [timer, setTimer] = useState<{ issue_id?: number | null; entry_type?: string; category?: string | null; started_at?: string } | null>(null);
  const [clock, setClock] = useState<{ clock_in_at?: string } | null>(null);
  const [error, setError] = useState("");
  const [woId, setWoId] = useState<number | null>(() => {
    const q = new URLSearchParams(window.location.search).get("wo");
    return q ? Number(q) : null;
  });

  const work = Boolean(cfg?.can.work && can(user, "workFleetShop"));

  async function loadQueue() {
    const d = await api<{ queue: QueueRow[]; open_timer: typeof timer }>("/fleet-shop/queue");
    setQueue(d.queue || []);
    setTimer(d.open_timer || null);
  }

  useEffect(() => {
    api<Config>("/fleet-shop/config")
      .then((d) => {
        setCfg(d);
        if (can(user, "workFleetShop")) setTab("queue");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Fleet Shop is not ready"));
  }, [user]);

  useEffect(() => {
    if (!cfg?.ready) return;
    loadQueue().catch((e) => setError(e instanceof Error ? e.message : "Could not load the queue"));
    if (work) {
      api<{ session: { clock_in_at?: string } | null }>("/fleet-shop/clock")
        .then((d) => setClock(d.session))
        .catch(() => setClock(null));
    }
  }, [cfg?.ready, work]);

  useEffect(() => {
    const q = params.get("wo");
    if (q) setWoId(Number(q));
  }, [params]);

  if (cfg && !cfg.ready) {
    return <p className="muted">Fleet Shop: run migration 111 (after Chris says Y).</p>;
  }

  return (
    <div className="fs-page">
      <div className="fs-top">
        {work ? (
          <button
            type="button"
            className="fs-pill"
            onClick={() =>
              void api(clock ? "/fleet-shop/clock/out" : "/fleet-shop/clock/in", {
                method: "POST",
                body: JSON.stringify({ client_ts: new Date().toISOString() }),
              }).then(() =>
                api<{ session: { clock_in_at?: string } | null }>("/fleet-shop/clock").then((d) => setClock(d.session))
              )
            }
          >
            {clock?.clock_in_at ? `Clocked in ${clock.clock_in_at.slice(11, 16)}` : "Clock in"}
          </button>
        ) : null}
        {timer ? (
          <span className="fs-pill">
            {timer.entry_type === "shop"
              ? `Shop time - ${timer.category || "other"}`
              : `Working: WO #${timer.issue_id || ""}`}
            {work && timer.entry_type === "shop" ? (
              <button type="button" className="btn btn-sm" onClick={() => void api("/fleet-shop/shop-time/stop", { method: "POST", body: "{}" }).then(loadQueue)}>
                Stop
              </button>
            ) : null}
          </span>
        ) : null}
        {work ? (
          <>
            <NewWo onDone={() => void loadQueue()} />
            <ShopTime onDone={() => void loadQueue()} />
          </>
        ) : null}
        <Link className="btn secondary btn-sm" to="/fleet-shop/report">
          Truck problem
        </Link>
      </div>
      <div className="fs-tabs">
        <button type="button" className={tab === "queue" ? "is-on" : ""} onClick={() => setTab("queue")}>Queue</button>
        <button type="button" className={tab === "vehicles" ? "is-on" : ""} onClick={() => setTab("vehicles")}>Vehicles</button>
        {cfg?.can.board ? (
          <button type="button" className={tab === "board" ? "is-on" : ""} onClick={() => setTab("board")}>Board</button>
        ) : null}
        {cfg?.can.settings ? (
          <button type="button" className={tab === "settings" ? "is-on" : ""} onClick={() => setTab("settings")}>Settings</button>
        ) : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      {tab === "queue" ? (
        <ul className="fs-queue">
          {queue.map((row) => (
            <li key={row.id} className={`fs-qcard fs-sev-${row.severity || "medium"}`}>
              <button type="button" className="fs-qmain" onClick={() => { setWoId(row.id); setParams({ wo: String(row.id) }); }}>
                <div>
                  <strong>WO #{row.id} Unit {row.unit_number}</strong>
                  {row.chip_new ? <span className="fs-chip">New</span> : null}
                  {row.truck_down ? <span className="fs-chip">Down</span> : null}
                  {row.stage_sub ? <span className="fs-chip">{row.stage_sub}</span> : null}
                </div>
                <div>{row.title}</div>
                <div className={`fs-age ${row.age_tone || ""}`}>
                  Reported by {row.reporter_name || "shop"} {row.reported_ct || ""} - {row.current_stage || row.status} {row.stage_days ?? 0}d - open {row.open_days ?? 0}d
                  {row.kind === "pm" && row.due_reason ? ` - PM: ${row.due_reason}` : ""}
                </div>
              </button>
              {work ? (
                <div className="fs-qbtns">
                  {timer?.issue_id === row.id ? (
                    <button type="button" className="btn fs-pause" onClick={() => void api(`/fleet-shop/wo/${row.id}/pause`, { method: "POST", body: "{}" }).then(loadQueue)}>Pause</button>
                  ) : (
                    <button type="button" className="btn fs-start" onClick={() => void api(`/fleet-shop/wo/${row.id}/start`, { method: "POST", body: JSON.stringify({ client_uuid: crypto.randomUUID() }) }).then(loadQueue)}>Start</button>
                  )}
                  <button type="button" className="btn fs-done" onClick={() => { setWoId(row.id); }}>Done</button>
                </div>
              ) : null}
            </li>
          ))}
          {!queue.length ? <li className="muted">Queue is clear.</li> : null}
        </ul>
      ) : null}
      {tab === "vehicles" ? <VehiclesTab work={work} canPm={Boolean(cfg?.can.pm)} /> : null}
      {tab === "board" ? <BoardTab /> : null}
      {tab === "settings" ? <SettingsTab /> : null}
      {woId ? (
        <WoSheet
          id={woId}
          work={work}
          onClose={() => { setWoId(null); params.delete("wo"); setParams(params); void loadQueue(); }}
        />
      ) : null}
    </div>
  );
}

function NewWo({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [vehicleId, setVehicleId] = useState("");
  const [title, setTitle] = useState("");
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>+ Work order</button>;
  return (
    <form
      className="fs-inline"
      onSubmit={(e) => {
        e.preventDefault();
        void api("/fleet-shop/wo", { method: "POST", body: JSON.stringify({ vehicle_id: Number(vehicleId), title }) }).then(() => {
          setOpen(false);
          onDone();
        });
      }}
    >
      <input placeholder="Vehicle id" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} />
      <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button className="btn btn-sm" type="submit">Create</button>
    </form>
  );
}

function ShopTime({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("parts_run");
  if (!open) return <button type="button" className="btn secondary btn-sm" onClick={() => setOpen(true)}>Shop time</button>;
  return (
    <form
      className="fs-inline"
      onSubmit={(e) => {
        e.preventDefault();
        void api("/fleet-shop/shop-time/start", { method: "POST", body: JSON.stringify({ category }) }).then(() => {
          setOpen(false);
          onDone();
        });
      }}
    >
      <select value={category} onChange={(e) => setCategory(e.target.value)}>
        <option value="parts_run">parts run</option>
        <option value="shop_cleanup">shop cleanup</option>
        <option value="tool_upkeep">tool upkeep</option>
        <option value="other">other</option>
      </select>
      <button className="btn btn-sm" type="submit">Start</button>
    </form>
  );
}

function WoSheet({ id, work, onClose }: { id: number; work: boolean; onClose: () => void }) {
  const [row, setRow] = useState<Record<string, unknown> | null>(null);
  const [concern, setConcern] = useState("");
  const [cause, setCause] = useState("");
  const [correction, setCorrection] = useState("");
  const [part, setPart] = useState("");
  const [error, setError] = useState("");

  async function load() {
    const d = await api<{ issue: Record<string, unknown>; meta: Record<string, unknown> | null; timeline: unknown; parts: Array<Record<string, unknown>>; notes: unknown[]; segments: unknown[]; odometer: unknown }>(`/fleet-shop/wo/${id}`);
    setRow(d as unknown as Record<string, unknown>);
    const issue = d.issue || {};
    setConcern(String(issue.description || ""));
    setCause(String(issue.completion_notes || ""));
    setCorrection(String(issue.work_performed || ""));
  }

  useEffect(() => {
    load().catch((e) => setError(e instanceof Error ? e.message : "Could not open the work order"));
  }, [id]);

  const issue = (row?.issue || {}) as Record<string, unknown>;
  const meta = (row?.meta || {}) as Record<string, unknown>;
  const unit = String(issue.unit_number || "");
  const vehicleId = Number(issue.vehicle_id || 0);

  return (
    <div className="fs-sheet" role="dialog" aria-modal="true">
      <div className="fs-top">
        <button type="button" className="btn ghost btn-sm" onClick={onClose}>Close</button>
        <strong>WO #{id} - Unit {unit}</strong>
        <span className="muted">{String(issue.year || "")} {String(issue.make || "")} {String(issue.model || "")}</span>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="fs-body">
        <div className="fs-card">
          <strong>Driver report</strong>
          <p>
            {String(issue.reporter_name || "Shop")}
            {issue.title ? ` · ${String(issue.title)}` : ""}
          </p>
          {issue.description ? <p>{String(issue.description)}</p> : null}
        </div>
        <p className="muted">Step: {String((row as { current?: { stage?: string } } | null)?.current?.stage || issue.status || "")}</p>
        <label>Concern<textarea value={concern} onChange={(e) => setConcern(e.target.value)} /></label>
        <label>Cause<textarea value={cause} onChange={(e) => setCause(e.target.value)} /></label>
        <label>Correction<textarea value={correction} onChange={(e) => setCorrection(e.target.value)} /></label>
        {work ? (
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={() =>
              void api(`/fleet-shop/wo/${id}`, {
                method: "PATCH",
                body: JSON.stringify({ description: concern, completion_notes: cause, work_performed: correction }),
              }).then(load)
            }
          >
            Save text
          </button>
        ) : null}
        <label>
          Schedule
          <input
            type="date"
            disabled={!work}
            onChange={(e) => void api(`/fleet-shop/wo/${id}/schedule`, { method: "POST", body: JSON.stringify({ date: e.target.value || null }) })}
          />
        </label>
        <div>
          <strong>Parts</strong>
          {vehicleId ? (
            <ShopJobPartsPanel vehicleId={vehicleId} unitNumber={unit || String(vehicleId)} issueId={id} issueTitle={String(issue.title || "")} showReceipts={work} />
          ) : null}
          <Link className="btn secondary btn-sm" to={`/parts-orders?vehicle_id=${vehicleId}&issue_id=${id}&vehicle=${vehicleId}&issue=${id}`}>
            Order part
          </Link>
          {work ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void api(`/fleet-shop/wo/${id}/parts`, { method: "POST", body: JSON.stringify({ description: part, qty: 1, source: "bought" }) }).then(() => {
                  setPart("");
                  void load();
                });
              }}
            >
              <input value={part} onChange={(e) => setPart(e.target.value)} placeholder="Part used" />
              <button className="btn btn-sm" type="submit">Add part</button>
            </form>
          ) : null}
        </div>
        <PhotoAdd id={id} work={work} onDone={() => void load()} />
        {work ? (
          <div className="fs-qbtns">
            <button type="button" className="btn fs-start" onClick={() => void api(`/fleet-shop/wo/${id}/start`, { method: "POST", body: JSON.stringify({ client_uuid: crypto.randomUUID() }) }).then(load)}>Start</button>
            <button type="button" className="btn fs-pause" onClick={() => void api(`/fleet-shop/wo/${id}/pause`, { method: "POST", body: "{}" }).then(load)}>Pause</button>
            <button
              type="button"
              className="btn fs-done"
              onClick={() =>
                void api(`/fleet-shop/wo/${id}/done`, { method: "POST", body: JSON.stringify({ work_performed: correction }) })
                  .then(onClose)
                  .catch((e) => setError(e instanceof Error ? e.message : "Done failed"))
              }
            >
              Done
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                const reason = window.prompt("Cancel reason");
                if (!reason) return;
                void api(`/fleet-shop/wo/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }).then(onClose);
              }}
            >
              Cancel
            </button>
            <label>
              <input
                type="checkbox"
                checked={Number(meta.truck_down) === 1}
                onChange={(e) => void api(`/fleet-shop/wo/${id}`, { method: "PATCH", body: JSON.stringify({ truck_down: e.target.checked }) }).then(load)}
              />
              Truck down
            </label>
          </div>
        ) : null}
        <button type="button" className="btn secondary btn-sm" onClick={() => window.print()}>Print</button>
      </div>
    </div>
  );
}

function PhotoAdd({ id, work, onDone }: { id: number; work: boolean; onDone: () => void }) {
  const [stage, setStage] = useState("before");
  if (!work) return null;
  return (
    <div>
      <strong>Photos</strong>
      <select value={stage} onChange={(e) => setStage(e.target.value)}>
        <option value="before">before</option>
        <option value="during">during</option>
        <option value="after">after</option>
      </select>
      <PhotoCapture
        label="Add photo"
        onPick={(f) => {
          if (!f) return;
          void (async () => {
            const shot = await compressPhoto(f);
            const fd = new FormData();
            fd.set("file", shot);
            fd.set("folder", "issue-photos");
            const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });
            await api(`/fleet-shop/wo/${id}/photos`, { method: "POST", body: JSON.stringify({ photo_key: up.key, stage }) });
            onDone();
          })();
        }}
      />
    </div>
  );
}

function VehiclesTab({ work, canPm }: { work: boolean; canPm: boolean }) {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    api<{ vehicles: Array<Record<string, unknown>> }>("/fleet-shop/vehicles").then((d) => setRows(d.vehicles || [])).catch(() => setRows([]));
  }, []);
  useEffect(() => {
    if (!openId) return;
    api<Record<string, unknown>>(`/fleet-shop/vehicles/${openId}`).then(setDetail).catch(() => setDetail(null));
  }, [openId]);
  return (
    <div>
      <ul className="fs-queue">
        {rows.map((v) => (
          <li key={String(v.id)}>
            <button type="button" onClick={() => setOpenId(Number(v.id))}>
              Unit {String(v.unit_number)} {String((v.odometer as { confidence?: string } | undefined)?.confidence || "")}
            </button>
          </li>
        ))}
      </ul>
      {detail ? (
        <div className="fs-card">
          <h3>Unit record</h3>
          <pre className="fs-pre">{JSON.stringify(detail.odometer || detail, null, 2)}</pre>
          {work ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                void api(`/fleet-shop/vehicles/${openId}/odometer`, { method: "POST", body: JSON.stringify({ odometer: Number(fd.get("odo")) }) }).then(() => {
                  if (openId) api<Record<string, unknown>>(`/fleet-shop/vehicles/${openId}`).then(setDetail);
                });
              }}
            >
              <input name="odo" placeholder="Confirm dash reading" />
              <button className="btn btn-sm" type="submit">Confirm dash reading</button>
            </form>
          ) : null}
          {canPm ? <p className="muted">PM edits use the vehicle PM grid from this record.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function BoardTab() {
  const [day, setDay] = useState("");
  const [windowDays, setWindowDays] = useState(90);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    const q = new URLSearchParams();
    if (day) q.set("day", day);
    q.set("window", String(windowDays));
    api<Record<string, unknown>>(`/fleet-shop/board?${q}`).then(setData).catch(() => setData(null));
  }, [day, windowDays]);
  const hours = (data?.hours || []) as Array<{ user: { display_name: string }; clocked_h?: number; wrench_h?: number; shop_h?: number }>;
  return (
    <div>
      <label>Day <input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></label>
      <label>
        Window
        <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
          <option value={30}>30</option>
          <option value={90}>90</option>
          <option value={365}>365</option>
        </select>
      </label>
      <div className="fs-tiles">
        <div className="fs-tile">Open {(data?.open as unknown[] | undefined)?.length || 0}</div>
        <div className="fs-tile">Done today {(data?.done_today as unknown[] | undefined)?.length || 0}</div>
      </div>
      <ul>
        {hours.map((h) => (
          <li key={h.user.display_name}>
            {h.user.display_name}: clocked {h.clocked_h ?? 0} wrench {h.wrench_h ?? 0} shop {h.shop_h ?? 0}
          </li>
        ))}
      </ul>
      <p className="muted">{String(data?.footnote || "")}</p>
    </div>
  );
}

const AGE_KEYS = [
  "reported",
  "scheduled",
  "waiting_parts",
  "in_progress",
  "open_total",
  "step_report_scheduled",
  "step_part_ordered_received",
  "step_report_done",
] as const;

function SettingsTab() {
  const [pm, setPm] = useState(true);
  const [max, setMax] = useState("400");
  const [slack, setSlack] = useState("300");
  const [windowDays, setWindowDays] = useState("90");
  const [age, setAge] = useState<Record<string, [string, string]>>({
    reported: ["2", "5"],
    scheduled: ["3", "7"],
    waiting_parts: ["3", "7"],
    in_progress: ["2", "5"],
    open_total: ["7", "14"],
    step_report_scheduled: ["2", "5"],
    step_part_ordered_received: ["3", "7"],
    step_report_done: ["7", "14"],
  });
  const [msg, setMsg] = useState("");
  useEffect(() => {
    api<Record<string, string>>("/fleet-shop/settings").then((d) => {
      setPm(d.fleet_shop_pm_autogen !== "0");
      setMax(d.fleet_shop_odo_max_miles_per_day || "400");
      setSlack(d.fleet_shop_odo_slack_miles || "300");
      setWindowDays(d.fleet_shop_stats_window_days || "90");
      if (d.fleet_shop_age_days) {
        try {
          const parsed = JSON.parse(d.fleet_shop_age_days) as Record<string, [number, number]>;
          setAge((prev) => {
            const next = { ...prev };
            for (const key of AGE_KEYS) {
              const pair = parsed[key];
              if (pair) next[key] = [String(pair[0]), String(pair[1])];
            }
            return next;
          });
        } catch {
          /* keep defaults */
        }
      }
    }).catch(() => null);
  }, []);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        const age_days: Record<string, [number, number]> = {};
        for (const key of AGE_KEYS) age_days[key] = [Number(age[key][0]), Number(age[key][1])];
        void api("/fleet-shop/settings", {
          method: "PUT",
          body: JSON.stringify({
            fleet_shop_pm_autogen: pm ? "1" : "0",
            fleet_shop_odo_max_miles_per_day: max,
            fleet_shop_odo_slack_miles: slack,
            fleet_shop_stats_window_days: Number(windowDays),
            fleet_shop_age_days: age_days,
          }),
        }).then(() => setMsg("Saved."));
      }}
    >
      <label><input type="checkbox" checked={pm} onChange={(e) => setPm(e.target.checked)} /> PM auto-create</label>
      <label>Max miles per day <input value={max} onChange={(e) => setMax(e.target.value)} /></label>
      <label>Slack miles <input value={slack} onChange={(e) => setSlack(e.target.value)} /></label>
      <label>Stats window <input value={windowDays} onChange={(e) => setWindowDays(e.target.value)} /></label>
      {AGE_KEYS.map((key) => (
        <label key={key}>
          {key} amber / red
          <input
            value={age[key][0]}
            onChange={(e) => setAge({ ...age, [key]: [e.target.value, age[key][1]] })}
          />
          <input
            value={age[key][1]}
            onChange={(e) => setAge({ ...age, [key]: [age[key][0], e.target.value] })}
          />
        </label>
      ))}
      <button className="btn" type="submit">Save</button>
      {msg ? <p>{msg}</p> : null}
    </form>
  );
}

export function FleetShopReportPage() {
  return <TruckProblemCard />;
}
