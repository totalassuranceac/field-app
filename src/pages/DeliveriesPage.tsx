import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { BarcodeScanButton } from "../components/BarcodeScan";
import { LogItem, LogList } from "../components/CollapsibleLog";
import { PHOTO_TIPS, PhotoCapture } from "../components/PhotoCapture";
import { ageLabel, fmtCt, fmtYmd, progressSteps, smsPreview, statusLabel } from "../deliveriesView";

async function compressPhoto(file: File, maxBytes = 850_000): Promise<File> {
  if (file.size <= maxBytes && /jpe?g/i.test(file.type || file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const maxW = 1600;
    const scale = bmp.width > maxW ? maxW / bmp.width : 1;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    let quality = 0.82;
    let blob: Blob | null = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", quality));
    while (blob && blob.size > maxBytes && quality > 0.45) {
      quality -= 0.1;
      blob = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", quality));
    }
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

type Access = {
  can_view: boolean;
  can_receive: boolean;
  can_schedule: boolean;
  can_pickup: boolean;
  can_manage: boolean;
};

type Spot = { id: number; label: string; active: number };
type Line = { description: string; qty: number; part_code?: string | null };
type Ev = { id: number; event_type: string; note: string | null; created_at: string; actor_name: string | null };
type WLink = { id: number; log_number: string; why: string };
type Delivery = {
  id: number;
  received_at: string;
  received_by_name: string | null;
  vendor_name: string | null;
  po_number: string | null;
  job_kind: string;
  job_number: string | null;
  customer_name: string | null;
  job_address: string | null;
  spot_label: string;
  note: string | null;
  status: string;
  scheduled_for: string | null;
  scheduled_at: string | null;
  scheduled_by_name: string | null;
  picked_up_at: string | null;
  picked_up_by_name: string | null;
  picked_up_logged_by_name: string | null;
  void_reason: string | null;
  photo_url: string | null;
  age_days: number;
  overdue: boolean;
  target: string;
  lines: Line[];
  events: Ev[];
  warranty_links: WLink[];
};

type LocHit = {
  location_id: number;
  customer_id: number | null;
  customer_name: string | null;
  address: string;
  unit: string | null;
};
type JobHit = {
  job_id: number;
  job_number: string | null;
  status: string | null;
  appointment_start: string | null;
};
type Person = { id: number; display_name: string };

const EVENT_LABEL: Record<string, string> = {
  received: "Received",
  scheduled: "Scheduled",
  unscheduled: "Unscheduled",
  picked_up: "Picked up",
  undo_pickup: "Undo pickup",
  spot_moved: "Spot moved",
  voided: "Voided",
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}

function DeliveryProgress({ d }: { d: Delivery }) {
  const steps = progressSteps(d);
  return (
    <div className="tool-loan-progress" aria-label="Delivery progress">
      <ol className="tool-loan-steps">
        {steps.map((s, i) => (
          <li key={s.key} className={`tool-loan-step${s.done ? " is-done" : ""}${s.active ? " is-active" : ""}`}>
            <span className="tool-loan-step-dot" aria-hidden />
            <span className="tool-loan-step-label">{s.label}</span>
            {s.when ? <span className="tool-loan-step-when">{s.when}</span> : null}
            {i < steps.length - 1 ? <span className="tool-loan-step-line" aria-hidden /> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DeliveryCard({
  d,
  access,
  meId,
  meName,
  spots,
  defaultOpen,
  onDone,
}: {
  d: Delivery;
  access: Access | null;
  meId: number;
  meName: string;
  spots: Spot[];
  defaultOpen: boolean;
  onDone: (message: string, failed?: boolean) => void;
}) {
  const open = d.status === "received" || d.status === "scheduled";
  const canPickup = Boolean(access?.can_pickup) && open;
  const canSchedule = Boolean(access?.can_schedule) && open;
  const canManage = Boolean(access?.can_manage) && open;
  const canUndo = Boolean(access?.can_manage) && d.status === "picked_up";
  const canVoid = Boolean(access?.can_receive) && open;
  const [busy, setBusy] = useState(false);
  const [pickupOpen, setPickupOpen] = useState(false);
  const [someone, setSomeone] = useState(false);
  const [pickerId, setPickerId] = useState(meId);
  const [pickerName, setPickerName] = useState(meName);
  const [whoQ, setWhoQ] = useState("");
  const [whoHits, setWhoHits] = useState<Person[]>([]);
  const [schedDate, setSchedDate] = useState(d.scheduled_for || "");
  const [moveSpot, setMoveSpot] = useState(String(spots[0]?.id || ""));
  const [moveNew, setMoveNew] = useState("");

  useEffect(() => {
    if (!someone || whoQ.trim().length < 2) {
      setWhoHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api<{ users: Person[] }>(`/deliveries/people?q=${encodeURIComponent(whoQ.trim())}`)
        .then((res) => setWhoHits(res.users || []))
        .catch(() => setWhoHits([]));
    }, 300);
    return () => window.clearTimeout(t);
  }, [someone, whoQ]);

  async function run(path: string, body?: unknown, okMsg = "Saved."): Promise<void> {
    setBusy(true);
    try {
      await api(path, body === undefined ? { method: "POST" } : { method: "POST", body: JSON.stringify(body) });
      onDone(okMsg, false);
    } catch (e) {
      onDone(errText(e), true);
    } finally {
      setBusy(false);
    }
  }

  const tone = d.overdue ? "overdue" : d.status === "picked_up" ? "done" : d.status === "voided" ? "bad" : undefined;

  return (
    <LogItem
      defaultOpen={defaultOpen}
      tone={tone}
      summary={
        <span className="deliveries-summary">
          <span>
            {d.target} - {d.spot_label}
          </span>
          <span className="chip">{statusLabel(d.status)}</span>
          <span>{ageLabel(d.age_days)}</span>
          {d.overdue ? <span className="deliveries-age-overdue">! Over 7 days</span> : null}
        </span>
      }
    >
      <DeliveryProgress d={d} />
      <dl className="deliveries-facts">
        <dt>Received</dt>
        <dd>
          {fmtCt(d.received_at)}
          {d.received_by_name ? ` by ${d.received_by_name}` : ""}
        </dd>
        {d.vendor_name ? (
          <>
            <dt>Vendor</dt>
            <dd>{d.vendor_name}</dd>
          </>
        ) : null}
        {d.po_number ? (
          <>
            <dt>PO</dt>
            <dd>{d.po_number}</dd>
          </>
        ) : null}
        <dt>Job</dt>
        <dd>
          {d.job_kind === "stock" ? "No job / stock" : d.customer_name || d.target}
          {d.job_address ? ` - ${d.job_address}` : ""}
        </dd>
        <dt>Items</dt>
        <dd>
          {(d.lines || []).map((ln) => (
            <div key={`${ln.description}-${ln.qty}`}>
              {ln.qty} x {ln.description}
            </div>
          ))}
        </dd>
        <dt>Staged at</dt>
        <dd>{d.spot_label}</dd>
        {d.scheduled_for || d.scheduled_at ? (
          <>
            <dt>Scheduled</dt>
            <dd>
              {d.scheduled_for ? fmtYmd(d.scheduled_for) : fmtCt(d.scheduled_at)}
              {d.scheduled_by_name ? ` by ${d.scheduled_by_name}` : ""}
            </dd>
          </>
        ) : null}
        {d.picked_up_at ? (
          <>
            <dt>Picked up</dt>
            <dd>
              {fmtCt(d.picked_up_at)}
              {d.picked_up_by_name ? ` by ${d.picked_up_by_name}` : ""}
              {d.picked_up_logged_by_name && d.picked_up_logged_by_name !== d.picked_up_by_name
                ? ` (logged by ${d.picked_up_logged_by_name})`
                : ""}
            </dd>
          </>
        ) : null}
        {d.note ? (
          <>
            <dt>Note</dt>
            <dd>{d.note}</dd>
          </>
        ) : null}
        {d.void_reason ? (
          <>
            <dt>Void</dt>
            <dd>{d.void_reason}</dd>
          </>
        ) : null}
      </dl>
      {d.photo_url ? (
        <p className="deliveries-photo">
          <a href={d.photo_url} target="_blank" rel="noreferrer">
            <img src={d.photo_url} alt="Delivery label photo" loading="lazy" />
          </a>
        </p>
      ) : null}
      {(d.warranty_links || []).length ? (
        <p>
          {d.warranty_links.map((w) => (
            <a
              key={w.id}
              className="chip deliveries-warranty-chip"
              href={`/warranties?q=${encodeURIComponent(w.log_number)}`}
            >
              Warranty {w.log_number}
            </a>
          ))}
        </p>
      ) : null}
      {(d.events || []).length ? (
        <ul className="deliveries-hint">
          {d.events.map((ev) => (
            <li key={ev.id}>
              {fmtCt(ev.created_at)} - {ev.actor_name || "Someone"} - {EVENT_LABEL[ev.event_type] || ev.event_type}
              {ev.note ? ` - ${ev.note}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="log-item-actions">
        {canPickup ? (
          pickupOpen ? (
            <div>
              <label>
                Who took it{" "}
                <select
                  value={someone ? "other" : "me"}
                  onChange={(e) => {
                    const other = e.target.value === "other";
                    setSomeone(other);
                    if (!other) {
                      setPickerId(meId);
                      setPickerName(meName);
                    }
                  }}
                >
                  <option value="me">Me ({meName})</option>
                  <option value="other">Someone else</option>
                </select>
              </label>
              {someone ? (
                <div>
                  <input
                    value={whoQ}
                    onChange={(e) => setWhoQ(e.target.value)}
                    placeholder="Search a name"
                    aria-label="Search who took it"
                  />
                  {whoHits.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={p.id === pickerId ? "chip active" : "chip"}
                      onClick={() => {
                        setPickerId(p.id);
                        setPickerName(p.display_name);
                      }}
                    >
                      {p.display_name}
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || (someone && pickerId === meId)}
                onClick={() => {
                  void run(`/deliveries/${d.id}/picked-up`, { picked_up_by_user_id: pickerId }, "Marked picked up.");
                }}
              >
                Confirm picked up
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setPickupOpen(true)}>
              Picked up
            </button>
          )
        ) : null}
        {canSchedule ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(`/deliveries/${d.id}/schedule`, { scheduled_for: schedDate || null }, "Marked scheduled.");
            }}
          >
            <label>
              Schedule date{" "}
              <input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-sm" disabled={busy}>
              Mark scheduled
            </button>
            {d.status === "scheduled" ? (
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  void run(`/deliveries/${d.id}/unschedule`, undefined, "Unscheduled.");
                }}
              >
                Un-schedule
              </button>
            ) : null}
          </form>
        ) : null}
        {canManage ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const body =
                moveSpot === "new" ? { new_spot_label: moveNew } : { spot_id: Number(moveSpot) };
              void run(`/deliveries/${d.id}/spot`, body, "Spot updated.");
            }}
          >
            <label>
              Move spot{" "}
              <select value={moveSpot} onChange={(e) => setMoveSpot(e.target.value)}>
                {spots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
                <option value="new">+ New spot...</option>
              </select>
            </label>
            {moveSpot === "new" ? (
              <input value={moveNew} onChange={(e) => setMoveNew(e.target.value)} placeholder="New spot name" />
            ) : null}
            <button type="submit" className="btn btn-sm" disabled={busy}>
              Move spot
            </button>
          </form>
        ) : null}
        {canUndo ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("Undo this pickup?")) return;
              void run(`/deliveries/${d.id}/undo-pickup`, undefined, "Pickup undone.");
            }}
          >
            Undo pickup
          </button>
        ) : null}
        {canVoid ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => {
              const reason = window.prompt("Say why this delivery is void");
              if (reason == null) return;
              void run(`/deliveries/${d.id}/void`, { reason }, "Voided.");
            }}
          >
            Void
          </button>
        ) : null}
      </div>
    </LogItem>
  );
}

export function DeliveriesPage() {
  const { user } = useAuth();
  const params = new URLSearchParams(window.location.search);
  const [focusId, setFocusId] = useState(params.get("id") || "");
  const [access, setAccess] = useState<Access | null>(null);
  const [view, setView] = useState<"open" | "picked" | "all">("open");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [rows, setRows] = useState<Delivery[]>([]);
  const [reloadAt, setReloadAt] = useState(0);
  const [spots, setSpots] = useState<Spot[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [token, setToken] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [po, setPo] = useState("");
  const [vendor, setVendor] = useState("");
  const [jobKind, setJobKind] = useState<"job" | "stock">("job");
  const [locQ, setLocQ] = useState("");
  const [locHits, setLocHits] = useState<LocHit[]>([]);
  const [locError, setLocError] = useState("");
  const [jobs, setJobs] = useState<JobHit[]>([]);
  const [typedJob, setTypedJob] = useState(false);
  const [jobNumber, setJobNumber] = useState("");
  const [customer, setCustomer] = useState("");
  const [address, setAddress] = useState("");
  const [stJobId, setStJobId] = useState("");
  const [stLocationId, setStLocationId] = useState<number | null>(null);
  const [items, setItems] = useState<{ description: string; qty: string }[]>([{ description: "", qty: "1" }]);
  const [spotId, setSpotId] = useState("");
  const [newSpot, setNewSpot] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const flags: Access = {
    can_view: can(user, "viewDeliveries"),
    can_receive: can(user, "receiveDeliveries") && Boolean(access?.can_receive),
    can_schedule: can(user, "scheduleDeliveries") && Boolean(access?.can_schedule),
    can_pickup: can(user, "pickupDeliveries") && Boolean(access?.can_pickup),
    can_manage: can(user, "manageDeliveries") && Boolean(access?.can_manage),
  };
  const canReceive = flags.can_receive;

  useEffect(() => {
    const t = window.setTimeout(() => setQDebounced(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    void api<Access>("/deliveries/access")
      .then((a) => setAccess(a))
      .catch((e) => setError(errText(e)));
  }, []);

  function loadSpots() {
    void api<{ spots: Spot[] }>("/deliveries/spots")
      .then((res) => {
        const list = res.spots || [];
        setSpots(list);
        setSpotId((cur) => cur || (list[0] ? String(list[0].id) : ""));
      })
      .catch(() => setSpots([]));
  }

  useEffect(() => {
    loadSpots();
  }, []);

  useEffect(() => {
    const query = new URLSearchParams();
    if (focusId) query.set("id", focusId);
    else query.set("view", view);
    if (qDebounced.length >= 2) query.set("q", qDebounced);
    void api<{ deliveries: Delivery[] }>(`/deliveries?${query.toString()}`)
      .then((res) => setRows(res.deliveries || []))
      .catch((e) => setError(errText(e)));
  }, [view, qDebounced, focusId, reloadAt]);

  useEffect(() => {
    if (jobKind !== "job" || typedJob || locQ.trim().length < 2) {
      setLocHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api<{ hits?: LocHit[]; error?: string }>(`/deliveries/st/locations?q=${encodeURIComponent(locQ.trim())}`)
        .then((res) => {
          setLocHits(res.hits || []);
          setLocError(res.error || (res.hits && res.hits.length ? "" : ""));
          if (res.error) setTypedJob(true);
        })
        .catch((e) => {
          setLocError(errText(e));
          setTypedJob(true);
        });
    }, 400);
    return () => window.clearTimeout(t);
  }, [locQ, jobKind, typedJob]);

  const vendors = useMemo(() => {
    const names = new Set<string>();
    for (const row of rows) if (row.vendor_name) names.add(row.vendor_name);
    return [...names].sort();
  }, [rows]);

  function resetForm() {
    setPhoto(null);
    setPo("");
    setVendor("");
    setJobKind("job");
    setLocQ("");
    setLocHits([]);
    setJobs([]);
    setTypedJob(false);
    setJobNumber("");
    setCustomer("");
    setAddress("");
    setStJobId("");
    setStLocationId(null);
    setItems([{ description: "", qty: "1" }]);
    setNewSpot("");
    setNote("");
    setToken("");
    setShowForm(false);
  }

  function previewTarget(): string {
    if (jobKind === "stock") return "stock (no job)";
    const num = jobNumber.replace(/^#+/, "").trim();
    const cust = customer.trim();
    const addr = address.trim();
    if (num && cust) return `job #${num} / ${cust}`;
    if (cust) return cust;
    if (addr) return addr;
    if (num) return `job #${num}`;
    return "job";
  }

  function chosenSpotLabel(): string {
    if (spotId === "new") return newSpot.trim();
    return spots.find((s) => String(s.id) === spotId)?.label || "";
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    const poTrim = po.trim();
    if (!photo && !poTrim) {
      setError("Add a photo of the label/slip or the PO.");
      return;
    }
    if (poTrim.length > 40) {
      setError("PO is too long.");
      return;
    }
    if (jobKind === "job" && !jobNumber.trim() && !stJobId && !customer.trim()) {
      setError("Pick the job, or choose No job / stock.");
      return;
    }
    if (spotId === "new") {
      if (newSpot.trim().length < 3) {
        setError("Name the spot (3-60 letters).");
        return;
      }
    } else if (!spotId) {
      setError("Pick where it is staged.");
      return;
    }
    const lines = items
      .filter((ln) => ln.description.trim().length > 0)
      .map((ln) => ({ description: ln.description, qty: ln.qty }));
    if (!lines.length) {
      setError("Add at least one item.");
      return;
    }
    setBusy(true);
    try {
      let photoKey: string | null = null;
      if (photo) {
        const compressed = await compressPhoto(photo);
        const fd = new FormData();
        fd.append("file", compressed);
        fd.append("folder", "part-deliveries");
        const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });
        photoKey = up.key || null;
      }
      await api("/deliveries", {
        method: "POST",
        body: JSON.stringify({
          vendor_name: vendor,
          po_number: poTrim,
          photo_key: photoKey,
          job_kind: jobKind,
          st_job_id: jobKind === "job" ? stJobId || null : null,
          job_number: jobKind === "job" ? jobNumber.replace(/^#+/, "").trim() : null,
          customer_name: jobKind === "job" ? customer : null,
          job_address: jobKind === "job" ? address : null,
          st_location_id: stLocationId,
          spot_id: spotId === "new" ? null : Number(spotId),
          new_spot_label: spotId === "new" ? newSpot.trim() : null,
          lines,
          note,
          client_token: token,
        }),
      });
      setOk(`Saved. Office notified: ${smsPreview(previewTarget(), chosenSpotLabel())}`);
      setReloadAt((n) => n + 1);
      resetForm();
      loadSpots();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!user || !can(user, "viewDeliveries")) {
    return <p>Deliveries is not available for your role.</p>;
  }

  return (
    <div className="msg-page">
      <h1>Parts received</h1>
      <p className="muted">Parts in, where they are staged, and who picked them up.</p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {ok ? <p className="muted">{ok}</p> : null}
      {canReceive ? (
        <p>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (showForm) {
                setShowForm(false);
                return;
              }
              setToken(crypto.randomUUID());
              setShowForm(true);
              setError("");
            }}
          >
            Receive delivery
          </button>
        </p>
      ) : null}
      {showForm && canReceive ? (
        <form className="form" onSubmit={(e) => void save(e)}>
          <PhotoCapture
            alignPaper
            sheetOnly
            label="Label / packing slip photo"
            tip={PHOTO_TIPS.receipt}
            onPick={setPhoto}
          />
          <label>
            PO #
            <input value={po} onChange={(e) => setPo(e.target.value)} />
          </label>
          <BarcodeScanButton label="Scan PO" onCode={(code) => setPo(code)} disabled={busy} />
          <p className="deliveries-hint">Photo or PO is required.</p>
          <label>
            Vendor
            <input value={vendor} onChange={(e) => setVendor(e.target.value)} list="delivery-vendors" />
          </label>
          <datalist id="delivery-vendors">
            {vendors.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <div>
            <button
              type="button"
              className={jobKind === "job" ? "chip active" : "chip"}
              onClick={() => setJobKind("job")}
            >
              Customer job
            </button>
            <button
              type="button"
              className={jobKind === "stock" ? "chip active" : "chip"}
              onClick={() => setJobKind("stock")}
            >
              No job / stock
            </button>
          </div>
          {jobKind === "job" ? (
            <div>
              {!typedJob ? (
                <>
                  <label>
                    Customer or address
                    <input value={locQ} onChange={(e) => setLocQ(e.target.value)} />
                  </label>
                  {locError ? <p className="deliveries-hint">{locError}</p> : null}
                  {locHits.map((hit) => (
                    <button
                      key={`${hit.location_id}-${hit.unit || ""}`}
                      type="button"
                      className="chip"
                      onClick={() => {
                        setCustomer(hit.customer_name || "");
                        setAddress(hit.unit ? `${hit.address} ${hit.unit}` : hit.address);
                        setStLocationId(hit.location_id);
                        setJobs([]);
                        void api<{ jobs?: JobHit[]; error?: string }>(
                          `/deliveries/st/jobs?location_id=${hit.location_id}&customer_id=${hit.customer_id || 0}`
                        )
                          .then((res) => {
                            setJobs(res.jobs || []);
                            if (res.error) {
                              setLocError(res.error);
                              setTypedJob(true);
                            }
                          })
                          .catch((err) => {
                            setLocError(errText(err));
                            setTypedJob(true);
                          });
                      }}
                    >
                      {hit.customer_name || "Customer"} - {hit.address}
                      {hit.unit ? ` ${hit.unit}` : ""}
                    </button>
                  ))}
                  {jobs.map((job) => (
                    <button
                      key={job.job_id}
                      type="button"
                      className="chip"
                      onClick={() => {
                        setStJobId(String(job.job_id));
                        setJobNumber(String(job.job_number || "").replace(/^#+/, ""));
                      }}
                    >
                      job #{String(job.job_number || job.job_id).replace(/^#+/, "")} - {job.status || "open"} -{" "}
                      {fmtCt(job.appointment_start)}
                    </button>
                  ))}
                  <p>
                    <button type="button" className="btn btn-sm" onClick={() => setTypedJob(true)}>
                      Type job # instead
                    </button>
                  </p>
                </>
              ) : (
                <>
                  <label>
                    Job #
                    <input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} />
                  </label>
                  <label>
                    Customer
                    <input value={customer} onChange={(e) => setCustomer(e.target.value)} />
                  </label>
                  <p className="deliveries-hint">Not checked against ServiceTitan.</p>
                </>
              )}
            </div>
          ) : null}
          <div>
            {items.map((ln, i) => (
              <div key={i}>
                <input
                  aria-label={`Item ${i + 1}`}
                  value={ln.description}
                  onChange={(e) =>
                    setItems((rowsNow) => rowsNow.map((row, idx) => (idx === i ? { ...row, description: e.target.value } : row)))
                  }
                  placeholder="Item"
                />
                <input
                  aria-label={`Qty ${i + 1}`}
                  value={ln.qty}
                  onChange={(e) =>
                    setItems((rowsNow) => rowsNow.map((row, idx) => (idx === i ? { ...row, qty: e.target.value } : row)))
                  }
                  inputMode="decimal"
                />
                {items.length > 1 ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setItems((rowsNow) => rowsNow.filter((_, idx) => idx !== i))}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            ))}
            {items.length < 30 ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setItems((rowsNow) => [...rowsNow, { description: "", qty: "1" }])}
              >
                + Add item
              </button>
            ) : null}
          </div>
          <label>
            Staging spot
            <select
              value={spotId}
              onChange={(e) => setSpotId(e.target.value)}
              required
            >
              <option value="">Pick a spot</option>
              {spots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
              <option value="new">+ New spot...</option>
            </select>
          </label>
          {spotId === "new" ? (
            <input value={newSpot} onChange={(e) => setNewSpot(e.target.value)} placeholder="New spot name" />
          ) : null}
          <p className="deliveries-hint">Small parts go to the office by Kelsie's desk.</p>
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </button>
        </form>
      ) : null}
      <div>
        {(
          [
            ["open", "Not picked up"],
            ["picked", "Picked up"],
            ["all", "All"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={view === key && !focusId ? "chip active" : "chip"}
            onClick={() => {
              setFocusId("");
              setView(key);
            }}
          >
            {label}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search job, customer, PO, vendor, spot"
          aria-label="Search deliveries"
        />
      </div>
      {focusId ? (
        <p className="deliveries-hint">
          Opened from the inbox.{" "}
          <button type="button" className="btn btn-sm" onClick={() => setFocusId("")}>
            Show the list
          </button>
        </p>
      ) : null}
      <LogList empty="No deliveries here.">
        {rows.map((d) => (
          <DeliveryCard
            key={d.id}
            d={d}
            access={flags}
            meId={user.id}
            meName={user.display_name}
            spots={spots}
            defaultOpen={Boolean(focusId) && String(d.id) === focusId}
            onDone={(message, failed) => {
              if (!message) return;
              if (failed) {
                setError(message);
                return;
              }
              setOk(message);
              setError("");
              setReloadAt((n) => n + 1);
            }}
          />
        ))}
      </LogList>
    </div>
  );
}
