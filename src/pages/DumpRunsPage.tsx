import { FormEvent, useEffect, useState } from "react";
import { api, OfflineQueuedError, can } from "../api";
import { useAuth } from "../auth";
import { PhotoCapture, PHOTO_TIPS } from "../components/PhotoCapture";
import {
  ocrDumpTicketImage,
  loadOcrHints,
  clearOcrHintsCache,
  type DumpTicketParseResult,
  type OcrHints,
} from "../dumpTicketOcr";

interface DumpRun {
  id: number;
  dump_date: string;
  net_weight_lbs: number;
  total_amount: number;
  notes: string | null;
  receipt_key: string;
  logged_by_name?: string | null;
  created_at: string;
}

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
    let blob: Blob | null = await new Promise((res) =>
      canvas.toBlob((b) => res(b), "image/jpeg", quality)
    );
    while (blob && blob.size > maxBytes && quality > 0.45) {
      quality -= 0.1;
      blob = await new Promise((res) => canvas.toBlob((b) => res(b), "image/jpeg", quality));
    }
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", {
      type: "image/jpeg",
    });
  } catch {
    return file;
  }
}

function money(n: number) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function DumpRunsPage() {
  const { user } = useAuth();
  const canLog = can(user, "logDumpRuns");
  const canView = can(user, "viewDumpRuns") || canLog;

  const [dumps, setDumps] = useState<DumpRun[]>([]);
  const [hints, setHints] = useState<OcrHints | null>(null);
  const [dumpDate, setDumpDate] = useState(todayIso());
  const [weight, setWeight] = useState("");
  const [total, setTotal] = useState("");
  const [notes, setNotes] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [ocrNote, setOcrNote] = useState("");
  const [lastOcr, setLastOcr] = useState<DumpTicketParseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [edit, setEdit] = useState<DumpRun | null>(null);
  const [eDate, setEDate] = useState("");
  const [eWeight, setEWeight] = useState("");
  const [eTotal, setETotal] = useState("");
  const [eNotes, setENotes] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  async function load() {
    const d = await api<{ dumps: DumpRun[] }>("/dump-runs");
    setDumps(d.dumps || []);
  }

  function openEdit(d: DumpRun) {
    setEdit(d);
    setEDate(d.dump_date || todayIso());
    setEWeight(String(d.net_weight_lbs ?? ""));
    setETotal(String(d.total_amount ?? ""));
    setENotes(d.notes || "");
    setError("");
    setOk("");
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!edit) return;
    if (!eDate) {
      setError("Date is required.");
      return;
    }
    if (!eWeight.trim() || !Number.isFinite(Number(eWeight)) || Number(eWeight) < 0) {
      setError("Enter net weight in pounds.");
      return;
    }
    if (Number(eWeight) > 80000) {
      setError("Net weight looks too high — check the ticket (OCR sometimes glues two numbers).");
      return;
    }
    if (!eTotal.trim() || !Number.isFinite(Number(eTotal)) || Number(eTotal) < 0) {
      setError("Enter the ticket total.");
      return;
    }
    setEditBusy(true);
    setError("");
    try {
      await api(`/dump-runs/${edit.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          dump_date: eDate,
          net_weight_lbs: Number(eWeight),
          total_amount: Number(eTotal),
          notes: eNotes.trim() || null,
        }),
      });
      setOk("Dump run corrected — app learned from this fix.");
      setEdit(null);
      clearOcrHintsCache();
      try {
        const h = await loadOcrHints((path) => api(path));
        setHints(h);
      } catch {
        /* optional */
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save correction");
    } finally {
      setEditBusy(false);
    }
  }

  useEffect(() => {
    if (!canView) return;
    load().catch((e) => setError(e instanceof Error ? e.message : "Could not load dump runs"));
    if (canLog) {
      loadOcrHints((path) => api(path)).then(setHints).catch(() => {});
    }
  }, [canView, canLog]);

  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [preview]);

  function onPhotoPick(file: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setPhotoFile(file);
    setPreview(file ? URL.createObjectURL(file) : null);
    setOcrNote("");
    setLastOcr(null);
    if (file) void runOcr(file);
  }

  async function runOcr(file: File) {
    setScanning(true);
    setOcrNote("Reading dump ticket…");
    try {
      const parsed = await ocrDumpTicketImage(file, hints);
      setLastOcr(parsed);
      if (parsed.dump_date) setDumpDate(parsed.dump_date);
      if (parsed.net_weight_lbs != null && !weight.trim()) {
        setWeight(String(parsed.net_weight_lbs));
      }
      if (parsed.total_amount != null && !total.trim()) {
        setTotal(String(parsed.total_amount));
      }
      const filled = [
        parsed.net_weight_lbs != null && "weight",
        parsed.total_amount != null && "total",
        parsed.dump_date && "date",
      ].filter(Boolean);
      if (filled.length) {
        setOcrNote(
          `Read from photo (${parsed.confidence}): ${filled.join(", ")}. Check & fix if needed.`
        );
      } else {
        setOcrNote("Couldn’t auto-read this ticket — enter weight and total, then save with the photo.");
      }
    } catch {
      setOcrNote("OCR unavailable — enter the fields manually and save with the photo.");
    } finally {
      setScanning(false);
    }
  }

  function resetForm() {
    setDumpDate(todayIso());
    setWeight("");
    setTotal("");
    setNotes("");
    onPhotoPick(null);
    setOcrNote("");
    setLastOcr(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!photoFile) {
      setError("Photo of the dump ticket is required.");
      return;
    }
    if (!dumpDate) {
      setError("Date is required.");
      return;
    }
    if (!weight.trim() || !Number.isFinite(Number(weight)) || Number(weight) < 0) {
      setError("Enter net weight in pounds.");
      return;
    }
    if (!total.trim() || !Number.isFinite(Number(total)) || Number(total) < 0) {
      setError("Enter the ticket total.");
      return;
    }

    setBusy(true);
    setError("");
    setOk("");
    try {
      const compressed = await compressPhoto(photoFile);
      const fd = new FormData();
      fd.append("file", compressed);
      fd.append("folder", "dump-runs");
      const up = await api<{ key: string }>("/uploads/receipt", { method: "POST", body: fd });

      const weightN = Number(weight);
      const totalN = Number(total);
      // Always send feedback so corrections teach label locations even when OCR missed
      const ocr_feedback = {
        raw_text: lastOcr?.raw_text || "",
        ocr: {
          store_number: "dump",
          fuel_date: lastOcr?.dump_date ?? null,
          gallons: lastOcr?.net_weight_lbs ?? null,
          total_cost: lastOcr?.total_amount ?? null,
        },
        final: {
          store_number: "dump",
          fuel_date: dumpDate,
          gallons: weightN,
          total_cost: totalN,
        },
      };

      await api("/dump-runs", {
        method: "POST",
        body: JSON.stringify({
          dump_date: dumpDate,
          net_weight_lbs: weightN,
          total_amount: totalN,
          notes: notes.trim() || null,
          receipt_key: up.key,
          ocr_feedback,
        }),
      });
      setOk("Dump run logged — app learned your corrections for the next ticket.");
      clearOcrHintsCache();
      try {
        const h = await loadOcrHints((path) => api(path));
        setHints(h);
      } catch {
        /* optional */
      }
      resetForm();
      await load();
    } catch (err) {
      if (err instanceof OfflineQueuedError) {
        setOk("Saved offline — will upload when you have signal.");
        resetForm();
      } else {
        setError(err instanceof Error ? err.message : "Could not save dump run");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!canView) {
    return (
      <div className="card">
        <h1>Dump runs</h1>
        <p className="muted">Only warehouse, mechanic, and admin can view dump logs.</p>
      </div>
    );
  }

  const monthTotal = dumps
    .filter((d) => (d.dump_date || "").startsWith(todayIso().slice(0, 7)))
    .reduce((s, d) => s + (Number(d.total_amount) || 0), 0);
  const monthWeight = dumps
    .filter((d) => (d.dump_date || "").startsWith(todayIso().slice(0, 7)))
    .reduce((s, d) => s + (Number(d.net_weight_lbs) || 0), 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dump runs</h1>
          <p>
            Log landfill / transfer station tickets — photo the receipt, confirm net weight and
            total. The app learns from your fixes so the next photo fills more fields.
          </p>
        </div>
      </div>

      {ok && <div className="success" style={{ marginBottom: "1rem" }}>{ok}</div>}
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      {(monthTotal > 0 || monthWeight > 0) && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <strong>This month</strong>
          <p className="muted" style={{ margin: "0.25rem 0 0" }}>
            {monthWeight.toLocaleString()} lbs · {money(monthTotal)}
          </p>
        </div>
      )}

      {canLog && (
        <div className="card" style={{ marginBottom: "1.25rem" }}>
          <h2 style={{ marginTop: 0 }}>Log a dump</h2>
          <form className="form" onSubmit={submit}>
            <PhotoCapture
              required
              label="Dump ticket photo *"
              hint={scanning ? "Reading ticket…" : "Photo the full scale ticket / receipt."}
              tip={PHOTO_TIPS.receipt}
              previewUrl={preview}
              onPick={(f) => onPhotoPick(f)}
              onClear={() => onPhotoPick(null)}
              disabled={busy || scanning}
            />
            {scanning && (
              <div className="info-banner" role="status">
                Reading ticket…
              </div>
            )}
            {ocrNote && !scanning && (
              <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
                {ocrNote}
              </p>
            )}
            <label>
              Dump date
              <input
                type="date"
                value={dumpDate}
                onChange={(e) => setDumpDate(e.target.value)}
                required
                disabled={busy}
              />
            </label>
            <label>
              Net weight (lbs)
              <input
                type="number"
                min={0}
                step="any"
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                required
                disabled={busy}
                placeholder="e.g. 8420"
              />
            </label>
            <label>
              Total amount ($)
              <input
                type="number"
                min={0}
                step="0.01"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                required
                disabled={busy}
                placeholder="e.g. 126.50"
              />
            </label>
            <label>
              Notes (optional)
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                disabled={busy}
                placeholder="Site, truck, anything useful"
              />
            </label>
            <div className="toolbar">
              <button className="btn" type="submit" disabled={busy || scanning}>
                {busy ? "Saving…" : "Save dump run"}
              </button>
              <button
                className="btn secondary"
                type="button"
                disabled={busy}
                onClick={resetForm}
              >
                Clear
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recent dumps</h2>
        <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
          Tap a row to view the ticket photo and fix weight or total if OCR got it wrong.
        </p>
        {!dumps.length ? (
          <p className="muted">No dump runs logged yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Net lbs</th>
                  <th>Total</th>
                  <th>By</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {dumps.map((d) => {
                  const weird = Number(d.net_weight_lbs) > 80000;
                  return (
                    <tr
                      key={d.id}
                      className={weird ? "row-selected" : undefined}
                      style={{ cursor: canLog ? "pointer" : undefined }}
                      onClick={() => {
                        if (canLog) openEdit(d);
                      }}
                    >
                      <td>{d.dump_date}</td>
                      <td>
                        {Number(d.net_weight_lbs).toLocaleString()}
                        {weird ? (
                          <span className="badge critical" style={{ marginLeft: "0.35rem" }}>
                            Check
                          </span>
                        ) : null}
                      </td>
                      <td>{money(Number(d.total_amount))}</td>
                      <td className="muted">{d.logged_by_name || "—"}</td>
                      <td className="no-print" onClick={(ev) => ev.stopPropagation()}>
                        {canLog ? (
                          <button
                            type="button"
                            className="btn secondary btn-sm"
                            onClick={() => openEdit(d)}
                          >
                            View / fix
                          </button>
                        ) : d.receipt_key ? (
                          <a
                            href={`/api/uploads/${encodeURIComponent(d.receipt_key)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Photo
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {edit && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!editBusy) setEdit(null);
          }}
        >
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>Dump ticket · {edit.dump_date}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              Check the photo and correct weight or total. Saving teaches the app for next time.
            </p>
            {edit.receipt_key ? (
              <div style={{ marginBottom: "1rem", textAlign: "center" }}>
                <a
                  href={`/api/uploads/${encodeURIComponent(edit.receipt_key)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`/api/uploads/${encodeURIComponent(edit.receipt_key)}`}
                    alt="Dump ticket"
                    style={{
                      maxWidth: "100%",
                      maxHeight: "280px",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                    }}
                  />
                </a>
                <p className="muted" style={{ fontSize: "0.82rem", margin: "0.35rem 0 0" }}>
                  Tap photo to open full size
                </p>
              </div>
            ) : (
              <p className="muted">No photo on file for this dump.</p>
            )}
            <form className="form" onSubmit={saveEdit}>
              <label>
                Dump date
                <input
                  type="date"
                  value={eDate}
                  onChange={(ev) => setEDate(ev.target.value)}
                  required
                  disabled={editBusy}
                />
              </label>
              <label>
                Net weight (lbs)
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={eWeight}
                  onChange={(ev) => setEWeight(ev.target.value)}
                  required
                  disabled={editBusy}
                />
              </label>
              <label>
                Total amount ($)
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={eTotal}
                  onChange={(ev) => setETotal(ev.target.value)}
                  required
                  disabled={editBusy}
                />
              </label>
              <label>
                Notes
                <textarea
                  value={eNotes}
                  onChange={(ev) => setENotes(ev.target.value)}
                  rows={2}
                  disabled={editBusy}
                />
              </label>
              <div className="toolbar">
                <button className="btn" type="submit" disabled={editBusy}>
                  {editBusy ? "Saving…" : "Save correction"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={editBusy}
                  onClick={() => setEdit(null)}
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
