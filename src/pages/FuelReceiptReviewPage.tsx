import { FormEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { repairUtf8Mojibake } from "../lib/utf8Mojibake";

type OcrSnap = {
  fuel_date?: string | null;
  fuel_time?: string | null;
  gallons?: number | null;
  total_cost?: number | null;
  store_number?: string | null;
  card_last4?: string | null;
};

type ReviewEntry = {
  id: number;
  unit_number: string;
  employee_name: string;
  entered_by_name?: string | null;
  odometer: number;
  gallons: number | null;
  total_cost: number | null;
  fuel_date: string;
  fuel_time?: string | null;
  store_number?: string | null;
  card_last4?: string | null;
  station_notes?: string | null;
  receipt_key: string;
  created_at: string;
  ocr_needs_review?: number | null;
  ocr_reviewed_at?: string | null;
  reviewed_by_name?: string | null;
  ocr_raw_text?: string | null;
  ocr_payload?: {
    ocr?: OcrSnap | null;
    final?: OcrSnap | null;
    raw_text?: string | null;
    store_review_reason?: string | null;
  } | null;
};

function fmt(v: string | number | null | undefined): string {
  if (v == null || v === "") return "—";
  return String(v);
}

function ocrDiff(ocr: OcrSnap | null | undefined, field: keyof OcrSnap, current: string): boolean {
  if (!ocr) return false;
  const o = ocr[field];
  if (o == null || o === "") return false;
  return String(o).trim() !== current.trim();
}

export function FuelReceiptReviewPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const deepId = Number(params.get("id") || "0");
  const canReview = can(user, "editFuel");
  const [filter, setFilter] = useState<"needs" | "reviewed" | "all">(
    deepId > 0 ? "all" : "needs"
  );
  const [entries, setEntries] = useState<ReviewEntry[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<ReviewEntry | null>(null);
  /** Big receipt parked beside the form. Null means the photo stays in the card. */
  const [dock, setDock] = useState<{ x: number; y: number; w: number } | null>(null);
  const [photoBeside, setPhotoBeside] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [form, setForm] = useState({
    fuel_date: "",
    fuel_time: "",
    gallons: "",
    total_cost: "",
    store_number: "",
    card_last4: "",
    station_notes: "",
    odometer: "",
  });

  function fillForm(e: ReviewEntry) {
    setForm({
      fuel_date: e.fuel_date || "",
      fuel_time: e.fuel_time || "",
      gallons: e.gallons != null ? String(e.gallons) : "",
      total_cost: e.total_cost != null ? String(e.total_cost) : "",
      store_number: e.store_number || "",
      card_last4: e.card_last4 || "",
      station_notes: repairUtf8Mojibake(e.station_notes || ""),
      odometer: e.odometer != null ? String(e.odometer) : "",
    });
  }

  const load = useCallback(async () => {
    if (!canReview) return;
    setError("");
    try {
      const d = await api<{
        entries: ReviewEntry[];
        pending_count?: number;
        error?: string;
      }>(`/fuel/receipt-review?filter=${filter}&limit=60`);
      if (d.error) setError(d.error);
      let list = d.entries || [];
      setPending(d.pending_count ?? 0);

      // Deep-link from fuel log: ensure that entry is loaded and selected
      if (deepId > 0) {
        let hit = list.find((e) => e.id === deepId);
        if (!hit) {
          const one = await api<{ entries: ReviewEntry[] }>(
            `/fuel/receipt-review?filter=all&id=${deepId}&limit=1`
          );
          hit = (one.entries || [])[0];
          if (hit) list = [hit, ...list.filter((e) => e.id !== hit!.id)];
        }
        setEntries(list);
        if (hit) {
          setSelected(hit);
          fillForm(hit);
          setOk("");
        } else {
          setSelected(null);
          setError(`Fuel entry #${deepId} not found or has no receipt photo.`);
        }
      } else {
        setEntries(list);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [canReview, filter, deepId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dock && !photoBeside) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setDock(null);
        setPhotoBeside(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dock, photoBeside]);

  function parkReceipt() {
    const rect = formRef.current?.getBoundingClientRect();
    const space = rect ? rect.left - 16 : 0;
    if (space >= 300) {
      const w = Math.min(560, Math.max(320, space - 8));
      setPhotoBeside(false);
      setDock({ x: 8, y: 12, w });
      return;
    }
    setDock(null);
    setPhotoBeside(true);
  }

  function putPhotoBack() {
    setDock(null);
    setPhotoBeside(false);
  }

  function startDockDrag(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dock) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    const bar = e.currentTarget;
    bar.setPointerCapture(e.pointerId);
    const originX = dock.x;
    const originY = dock.y;
    const w = dock.w;
    const move = (ev: PointerEvent) => {
      const maxX = Math.max(8, window.innerWidth - w - 8);
      const maxY = Math.max(8, window.innerHeight - 120);
      setDock({
        w,
        x: Math.min(maxX, Math.max(8, originX + ev.clientX - e.clientX)),
        y: Math.min(maxY, Math.max(8, originY + ev.clientY - e.clientY)),
      });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function openEntry(e: ReviewEntry) {
    setSelected(e);
    setOk("");
    setError("");
    fillForm(e);
    setParams({ id: String(e.id) }, { replace: true });
  }

  function closeEntry() {
    setSelected(null);
    setDock(null);
    setPhotoBeside(false);
    if (params.has("id")) {
      setParams({}, { replace: true });
    }
  }

  async function saveReview(ev: FormEvent) {
    ev.preventDefault();
    if (!selected || !canReview) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      const res = await api<{ learned?: number }>(`/fuel/${selected.id}/ocr-review`, {
        method: "POST",
        body: JSON.stringify({
          fuel_date: form.fuel_date || null,
          fuel_time: form.fuel_time || null,
          gallons: form.gallons === "" ? null : Number(form.gallons),
          total_cost: form.total_cost === "" ? null : Number(form.total_cost),
          store_number: form.store_number || null,
          card_last4: form.card_last4 || null,
          station_notes: form.station_notes || null,
          odometer: form.odometer === "" ? null : Number(form.odometer),
          mark_reviewed: true,
        }),
      });
      setOk(
        res.learned
          ? `Verified. Taught OCR ${res.learned} field correction${res.learned === 1 ? "" : "s"}.`
          : "Verified and saved — values look correct (no new OCR diffs)."
      );
      closeEntry();
      // Stay on needs queue after clearing one
      setFilter("needs");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const queueGroups = useMemo(() => {
    const map = new Map<string, ReviewEntry[]>();
    for (const entry of entries) {
      const unit = (entry.unit_number || "").trim() || "Unknown";
      const rows = map.get(unit) || [];
      rows.push(entry);
      map.set(unit, rows);
    }
    return [...map.entries()]
      .map(([unit, rows]) => ({
        unit,
        rows: rows
          .slice()
          .sort(
            (a, b) =>
              String(a.created_at || a.fuel_date || "").localeCompare(
                String(b.created_at || b.fuel_date || "")
              ) || a.id - b.id
          ),
      }))
      .sort((a, b) => a.unit.localeCompare(b.unit, undefined, { numeric: true }));
  }, [entries]);

  if (!canReview) {
    return (
      <div className="page">
        <div className="error">Admin / office only — receipt OCR review.</div>
        <p>
          <Link to="/fuel">← Back to fuel log</Link>
        </p>
      </div>
    );
  }

  const ocr = selected?.ocr_payload?.ocr;

  return (
    <div className="page fuel-ocr-review-page">
      <div className="page-header">
        <div>
          <h1>Verify fuel</h1>
          <p>
            Open a receipt photo, correct any wrong fields, then <strong>Save &amp; verify</strong>.
            Corrections teach the app for the next scan.
            {pending > 0 ? (
              <>
                {" "}
                <strong>{pending}</strong> not yet verified.
              </>
            ) : (
              " All receipt photos have been verified."
            )}
          </p>
        </div>
        <div className="toolbar no-print">
          <Link className="btn secondary btn-sm" to="/fuel">
            Fuel log
          </Link>
          <button type="button" className="btn secondary btn-sm" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <div className="filters no-print" style={{ marginBottom: "0.75rem" }}>
        {(
          [
            ["needs", `Needs verify${pending ? ` (${pending})` : ""}`],
            ["reviewed", "Verified"],
            ["all", "All with photos"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`chip ${filter === k ? "active" : ""}`}
            onClick={() => {
              setFilter(k);
              closeEntry();
              setParams({}, { replace: true });
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="fuel-ocr-layout">
        <div className="fuel-ocr-list card">
          {!entries.length ? (
            <p className="muted" style={{ margin: 0 }}>
              {filter === "needs"
                ? "No unverified receipts — queue is clear."
                : "No receipts in this view."}
            </p>
          ) : (
            queueGroups.map((group) => (
              <div key={group.unit}>
                <p className="muted" style={{ margin: "0.65rem 0 0.2rem" }}>
                  Unit {group.unit}
                </p>
                <ul className="fuel-ocr-entry-list">
                  {group.rows.map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        className={`fuel-ocr-entry${selected?.id === e.id ? " is-selected" : ""}`}
                        onClick={() => openEntry(e)}
                      >
                        <strong>
                          Unit {e.unit_number}
                          {e.ocr_reviewed_at ? " · verified" : " · needs verify"}
                        </strong>
                        <span className="muted">
                          {e.fuel_date}
                          {e.gallons != null ? ` · ${e.gallons} gal` : ""}
                          {e.total_cost != null ? ` · $${Number(e.total_cost).toFixed(2)}` : ""}
                        </span>
                        <span className="muted fuel-ocr-entry-who">
                          {e.employee_name}
                          {e.entered_by_name ? ` · by ${e.entered_by_name}` : ""}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        {selected && (
          <div className={`fuel-ocr-detail card${photoBeside ? " is-photo-beside" : ""}`}>
            <div className="fuel-ocr-detail-head">
              <h2 style={{ margin: 0 }}>
                Unit {selected.unit_number} · #{selected.id}
              </h2>
              <button type="button" className="btn secondary btn-sm" onClick={closeEntry}>
                Close
              </button>
            </div>
            <p className="muted fuel-ocr-detail-meta" style={{ margin: "0.25rem 0 0.65rem", fontSize: "0.85rem" }}>
              {selected.employee_name} · submitted{" "}
              {String(selected.created_at).replace("T", " ").slice(0, 16)}
              {selected.reviewed_by_name
                ? ` · verified by ${selected.reviewed_by_name}`
                : " · not verified yet"}
            </p>

            {dock ? (
              <p className="muted" style={{ fontSize: "0.8rem", margin: "0 0 0.65rem" }}>
                Receipt is parked beside this form. Drag its top bar if you need it somewhere else.
              </p>
            ) : (
              <div className="fuel-ocr-photo-wrap">
                <button
                  type="button"
                  className="fuel-ocr-photo-btn"
                  onClick={parkReceipt}
                  aria-label="Enlarge receipt photo beside the form"
                  style={{
                    display: "block",
                    width: "100%",
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    cursor: "zoom-in",
                  }}
                >
                  <img
                    src={`/api/uploads/${encodeURIComponent(selected.receipt_key)}`}
                    alt={`Fuel receipt unit ${selected.unit_number}`}
                    className="fuel-ocr-photo"
                  />
                </button>
                <div className="toolbar" style={{ marginTop: "0.35rem" }}>
                  <p className="muted" style={{ fontSize: "0.75rem", margin: 0 }}>
                    {photoBeside
                      ? "Photo is beside the numbers. Scroll the picture if the receipt is long."
                      : "Tap the photo to open it beside the numbers. You can drag it."}
                  </p>
                  {photoBeside ? (
                    <button type="button" className="btn secondary btn-sm" onClick={putPhotoBack}>
                      Put photo back
                    </button>
                  ) : null}
                </div>
              </div>
            )}

            <div className="fuel-ocr-verify">

            {ocr && (
              <div className="fuel-ocr-readout">
                <h3 className="fuel-ocr-subhead">What the app originally read</h3>
                <ul className="fuel-ocr-ocr-list">
                  {(
                    [
                      ["Date", ocr.fuel_date],
                      ["Time", ocr.fuel_time],
                      ["Gallons", ocr.gallons],
                      ["Total $", ocr.total_cost],
                      ["Store", ocr.store_number],
                      ["Card ••", ocr.card_last4],
                    ] as const
                  ).map(([lab, val]) => (
                    <li key={lab}>
                      <span className="muted">{lab}</span> {fmt(val)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!ocr && (
              <p className="muted" style={{ fontSize: "0.85rem" }}>
                No OCR snapshot on file for this older entry — correct values from the photo still
                update the log (learning is best when OCR data was saved at upload).
              </p>
            )}

            <form className="form" onSubmit={saveReview} ref={formRef}>
              <h3 className="fuel-ocr-subhead">Correct / verify values</h3>
              <div className="form row">
                <label>
                  Fuel date
                  {ocrDiff(ocr, "fuel_date", form.fuel_date) && (
                    <span className="fuel-ocr-diff"> OCR: {fmt(ocr?.fuel_date)}</span>
                  )}
                  <input
                    type="date"
                    value={form.fuel_date}
                    onChange={(e) => setForm({ ...form, fuel_date: e.target.value })}
                  />
                </label>
                <label>
                  Fuel time
                  {ocrDiff(ocr, "fuel_time", form.fuel_time) && (
                    <span className="fuel-ocr-diff"> OCR: {fmt(ocr?.fuel_time)}</span>
                  )}
                  <input
                    type="time"
                    value={form.fuel_time}
                    onChange={(e) => setForm({ ...form, fuel_time: e.target.value })}
                  />
                </label>
                <label>
                  Gallons
                  {ocr &&
                    ocr.gallons != null &&
                    String(ocr.gallons) !== form.gallons && (
                      <span className="fuel-ocr-diff"> OCR: {fmt(ocr.gallons)}</span>
                    )}
                  <input
                    type="number"
                    step="any"
                    value={form.gallons}
                    onChange={(e) => setForm({ ...form, gallons: e.target.value })}
                  />
                </label>
                <label>
                  Total $
                  {ocr &&
                    ocr.total_cost != null &&
                    String(ocr.total_cost) !== form.total_cost && (
                      <span className="fuel-ocr-diff"> OCR: {fmt(ocr.total_cost)}</span>
                    )}
                  <input
                    type="number"
                    step="any"
                    value={form.total_cost}
                    onChange={(e) => setForm({ ...form, total_cost: e.target.value })}
                  />
                </label>
                <label>
                  Store #
                  {ocrDiff(ocr, "store_number", form.store_number) && (
                    <span className="fuel-ocr-diff"> OCR: {fmt(ocr?.store_number)}</span>
                  )}
                  <input
                    value={form.store_number}
                    onChange={(e) => setForm({ ...form, store_number: e.target.value })}
                  />
                  {selected?.ocr_payload?.store_review_reason ? (
                    <span className="fuel-ocr-diff">Store #: {selected.ocr_payload.store_review_reason}</span>
                  ) : null}
                </label>
                <label>
                  Card last 4
                  {ocrDiff(ocr, "card_last4", form.card_last4) && (
                    <span className="fuel-ocr-diff"> OCR: {fmt(ocr?.card_last4)}</span>
                  )}
                  <input
                    value={form.card_last4}
                    maxLength={4}
                    onChange={(e) => setForm({ ...form, card_last4: e.target.value })}
                  />
                </label>
                <label>
                  Odometer (tech-entered)
                  <input
                    type="number"
                    step="any"
                    value={form.odometer}
                    onChange={(e) => setForm({ ...form, odometer: e.target.value })}
                  />
                </label>
              </div>
              <label>
                Notes
                <input
                  value={form.station_notes}
                  onChange={(e) => setForm({ ...form, station_notes: e.target.value })}
                />
              </label>
              <div className="toolbar" style={{ marginTop: "0.65rem" }}>
                <button className="btn" type="submit" disabled={busy}>
                  {busy ? "Saving…" : "Save & verify · teach OCR"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy}
                  onClick={closeEntry}
                >
                  Cancel
                </button>
              </div>
              <p className="muted" style={{ fontSize: "0.78rem", margin: "0.5rem 0 0" }}>
                If everything matches the photo, still tap <strong>Save &amp; verify</strong> — that
                marks the receipt checked. Wrong fields you fix here train future scans.
              </p>
            </form>
            </div>
          </div>
        )}

        {!selected && (
          <div className="card muted" style={{ padding: "1rem" }}>
            <p style={{ margin: 0 }}>
              Select a receipt on the left — or open <Link to="/fuel">Fuel log</Link> → Recent
              entries → <strong>Review &amp; edit · verify</strong> on any stop with a photo.
            </p>
          </div>
        )}
      </div>

      {dock && selected ? (
        <div
          className="receipt-dock"
          style={{ left: dock.x, top: dock.y, width: dock.w, height: `calc(100dvh - ${dock.y + 8}px)` }}
          role="dialog"
          aria-label="Receipt photo"
        >
          <div className="receipt-dock-bar" onPointerDown={startDockDrag}>
            <strong>Receipt</strong>
            <span className="muted">Drag to move</span>
            <button type="button" className="btn secondary btn-sm" onClick={putPhotoBack}>
              Put back
            </button>
          </div>
          <div className="receipt-dock-scroll">
            <img
              src={`/api/uploads/${encodeURIComponent(selected.receipt_key)}`}
              alt={`Fuel receipt unit ${selected.unit_number}`}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
