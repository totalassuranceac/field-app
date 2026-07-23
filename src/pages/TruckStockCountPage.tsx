import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

interface CountSummary {
  id: number;
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  status: string;
  line_count: number;
  not_needed_count: number;
  blank_count: number;
  signed_name: string | null;
  submitted_at: string | null;
  created_at: string;
  created_by_name?: string | null;
  counted_by_name?: string | null;
}

interface CountLine {
  id: number;
  part_id: number;
  part_code: string | null;
  part_name: string;
  system_qty: number;
  counted_qty: number | null;
  not_needed: number;
  notes: string | null;
}

interface CountDetail {
  id: number;
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  year?: string | null;
  make?: string | null;
  model?: string | null;
  status: string;
  signed_name: string | null;
  signed_at: string | null;
  accuracy_confirmed: number;
  notes: string | null;
  created_by_name?: string | null;
  counted_by_name?: string | null;
  applied_by_name?: string | null;
  submitted_at?: string | null;
  applied_at?: string | null;
}

interface VehicleOpt {
  id: number;
  unit_number: string;
  assigned_driver?: string | null;
}

type LineDraft = {
  counted_qty: string;
  not_needed: boolean;
  notes: string;
};

function statusLabel(s: string): string {
  if (s === "open") return "Open — fill count";
  if (s === "submitted") return "Submitted — warehouse apply";
  if (s === "applied") return "Applied to stock";
  if (s === "cancelled") return "Cancelled";
  return s;
}

/**
 * Initial truck stock counts: techs fill on phone; office/warehouse can help;
 * warehouse applies numbers into inventory for replenishment.
 */
export function TruckStockCountPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get("id") || "0") || null;

  const isDriver = user?.role === "driver";
  const canManage =
    user?.role === "admin" ||
    user?.role === "warehouse" ||
    user?.role === "office" ||
    can(user, "manageInventory");

  const [list, setList] = useState<CountSummary[]>([]);
  const [filter, setFilter] = useState<"active" | "open" | "submitted" | "all">("active");
  const [vehicles, setVehicles] = useState<VehicleOpt[]>([]);
  const [pickVehicle, setPickVehicle] = useState("");
  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [drafts, setDrafts] = useState<Record<number, LineDraft>>({});
  const [signedName, setSignedName] = useState("");
  const [accuracy, setAccuracy] = useState(false);
  const [sheetNotes, setSheetNotes] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadList = useCallback(async () => {
    const d = await api<{ counts: CountSummary[] }>(
      `/inventory/truck-counts?status=${filter === "active" ? "active" : filter}`
    );
    setList(d.counts || []);
  }, [filter]);

  const loadSheet = useCallback(async (id: number) => {
    const d = await api<{ count: Record<string, unknown>; lines: CountLine[] }>(
      `/inventory/truck-counts/${id}`
    );
    const c = d.count || {};
    setDetail({
      id: Number(c.id),
      vehicle_id: Number(c.vehicle_id),
      unit_number: String(c.unit_number || ""),
      assigned_driver: (c.assigned_driver as string) || null,
      year: (c.year as string) || null,
      make: (c.make as string) || null,
      model: (c.model as string) || null,
      status: String(c.status || "open"),
      signed_name: (c.signed_name as string) || null,
      signed_at: (c.signed_at as string) || null,
      accuracy_confirmed: Number(c.accuracy_confirmed) || 0,
      notes: (c.notes as string) || null,
      created_by_name: (c.created_by_name as string) || null,
      counted_by_name: (c.counted_by_name as string) || null,
      applied_by_name: (c.applied_by_name as string) || null,
      submitted_at: (c.submitted_at as string) || null,
      applied_at: (c.applied_at as string) || null,
    });
    const ls = d.lines || [];
    setLines(ls);
    const next: Record<number, LineDraft> = {};
    for (const line of ls) {
      next[line.id] = {
        counted_qty:
          line.counted_qty != null && Number.isFinite(Number(line.counted_qty))
            ? String(line.counted_qty)
            : "",
        not_needed: !!line.not_needed,
        notes: line.notes || "",
      };
    }
    setDrafts(next);
    setSignedName((c.signed_name as string) || user?.display_name || "");
    setAccuracy(!!c.accuracy_confirmed);
    setSheetNotes((c.notes as string) || "");
  }, [user?.display_name]);

  useEffect(() => {
    setLoading(true);
    loadList()
      .catch((e) => setError(e instanceof Error ? e.message : "Load failed"))
      .finally(() => setLoading(false));
  }, [loadList]);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      setLines([]);
      return;
    }
    setLoading(true);
    setError("");
    loadSheet(openId)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not open sheet"))
      .finally(() => setLoading(false));
  }, [openId, loadSheet]);

  useEffect(() => {
    if (!canManage) return;
    api<VehicleOpt[] | { vehicles?: VehicleOpt[] }>("/vehicles?filter=active")
      .then((d) => {
        const list = Array.isArray(d) ? d : d.vehicles || [];
        setVehicles(
          list.map((v) => ({
            id: Number((v as VehicleOpt).id),
            unit_number: String((v as VehicleOpt).unit_number || ""),
            assigned_driver: (v as VehicleOpt).assigned_driver ?? null,
          }))
        );
      })
      .catch(() => {
        /* optional */
      });
  }, [canManage]);

  const filteredLines = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return lines;
    return lines.filter(
      (l) =>
        l.part_name.toLowerCase().includes(qq) ||
        (l.part_code || "").toLowerCase().includes(qq)
    );
  }, [lines, q]);

  const progress = useMemo(() => {
    let filled = 0;
    let notNeed = 0;
    for (const line of lines) {
      const d = drafts[line.id];
      if (!d) continue;
      if (d.not_needed) {
        notNeed++;
        filled++;
      } else if (d.counted_qty.trim() !== "" && Number.isFinite(Number(d.counted_qty))) {
        filled++;
      }
    }
    return { filled, total: lines.length, notNeed, blank: Math.max(0, lines.length - filled) };
  }, [lines, drafts]);

  const editable =
    detail &&
    (detail.status === "open" ||
      (detail.status === "submitted" && canManage && user?.role !== "driver"));

  function setDraft(lineId: number, patch: Partial<LineDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [lineId]: { ...prev[lineId], ...patch },
    }));
  }

  async function createSheet(all: boolean) {
    setBusy(true);
    setError("");
    setOk("");
    try {
      const body = all
        ? { all_active: true }
        : { vehicle_id: Number(pickVehicle) || null };
      if (!all && !body.vehicle_id) {
        setError("Select a truck first");
        setBusy(false);
        return;
      }
      const r = await api<{ created_ids: number[]; skipped_units?: string[] }>(
        "/inventory/truck-counts",
        { method: "POST", body: JSON.stringify(body) }
      );
      const n = r.created_ids?.length || 0;
      const skip = r.skipped_units?.length
        ? ` (already open: ${r.skipped_units.join(", ")})`
        : "";
      setOk(
        n
          ? `Opened ${n} truck stock sheet(s)${skip}. Techs can fill and sign.`
          : `No new sheets${skip || "."}`
      );
      await loadList();
      if (r.created_ids?.length === 1) setParams({ id: String(r.created_ids[0]) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create");
    } finally {
      setBusy(false);
    }
  }

  async function saveLines(): Promise<boolean> {
    if (!openId || !detail) return false;
    const payload = lines.map((line) => {
      const d = drafts[line.id] || { counted_qty: "", not_needed: false, notes: "" };
      const not_needed = d.not_needed;
      let counted_qty: number | null = null;
      if (not_needed) counted_qty = 0;
      else if (d.counted_qty.trim() !== "") counted_qty = Number(d.counted_qty);
      return {
        id: line.id,
        counted_qty,
        not_needed,
        notes: d.notes.trim() || null,
      };
    });
    await api(`/inventory/truck-counts/${openId}/lines`, {
      method: "PUT",
      body: JSON.stringify({ lines: payload }),
    });
    return true;
  }

  async function onSave(e?: FormEvent) {
    e?.preventDefault();
    if (!editable) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await saveLines();
      setOk("Saved.");
      await loadSheet(openId!);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!openId || !detail || detail.status !== "open") return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await saveLines();
      await api(`/inventory/truck-counts/${openId}/submit`, {
        method: "POST",
        body: JSON.stringify({
          signed_name: signedName.trim(),
          accuracy_confirmed: accuracy,
          notes: sheetNotes.trim() || null,
        }),
      });
      setOk("Submitted. Warehouse can apply this count to truck stock.");
      await loadSheet(openId);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function onApply() {
    if (!openId || !canManage) return;
    if (!confirm("Apply these counts to truck stock inventory?")) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await saveLines();
      const r = await api<{ applied: number }>(`/inventory/truck-counts/${openId}/apply`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOk(`Applied ${r.applied} parts to truck stock. Replenishment can use these numbers.`);
      await loadSheet(openId);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReopen() {
    if (!openId || !canManage) return;
    setBusy(true);
    setError("");
    try {
      await api(`/inventory/truck-counts/${openId}/reopen`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setOk("Reopened for editing.");
      await loadSheet(openId);
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reopen failed");
    } finally {
      setBusy(false);
    }
  }

  // ——— Detail form ———
  if (openId && detail) {
    const truckLabel = [
      detail.unit_number ? `Unit ${detail.unit_number}` : "Truck",
      [detail.year, detail.make, detail.model].filter(Boolean).join(" "),
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div className="tsc-page">
        <div className="page-header tsc-header">
          <div>
            <button
              type="button"
              className="btn ghost btn-sm"
              onClick={() => {
                setParams({});
                setOk("");
                setError("");
              }}
            >
              ← All sheets
            </button>
            <h1 style={{ margin: "0.4rem 0 0.15rem" }}>Truck stock count</h1>
            <p className="muted" style={{ margin: 0 }}>
              {truckLabel}
              {detail.assigned_driver ? ` · ${detail.assigned_driver}` : ""}
            </p>
            <p className="tsc-status-line">
              <span className={`tsc-status st-${detail.status}`}>{statusLabel(detail.status)}</span>
              <span className="muted">
                {progress.filled}/{progress.total} filled
                {progress.notNeed ? ` · ${progress.notNeed} not needed` : ""}
                {progress.blank ? ` · ${progress.blank} blank` : ""}
              </span>
            </p>
          </div>
        </div>

        {error && <div className="error inv-flash">{error}</div>}
        {ok && <div className="success inv-flash">{ok}</div>}

        <div className="tsc-legend card">
          <strong>How to fill</strong>
          <ul>
            <li>Count what is on the truck for each part — type the number.</li>
            <li>
              Check <em>Don&apos;t need</em> if you have no room or won&apos;t use it (warehouse
              will leave it off / at zero for this truck).
            </li>
            <li>Sign at the bottom when finished so warehouse can apply the count.</li>
          </ul>
        </div>

        <div className="tsc-search-bar">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter parts…"
            aria-label="Filter parts"
          />
        </div>

        <form
          className="tsc-form"
          onSubmit={detail.status === "open" ? onSubmit : (e) => void onSave(e)}
        >
          <div className="tsc-table-wrap">
            <table className="tsc-table">
              <thead>
                <tr>
                  <th className="tsc-col-part">Part</th>
                  <th className="tsc-col-qty">Count</th>
                  <th className="tsc-col-need">Don&apos;t need</th>
                </tr>
              </thead>
              <tbody>
                {filteredLines.map((line) => {
                  const d = drafts[line.id] || {
                    counted_qty: "",
                    not_needed: false,
                    notes: "",
                  };
                  return (
                    <tr
                      key={line.id}
                      className={`tsc-row${d.not_needed ? " is-not-needed" : ""}${
                        d.counted_qty !== "" || d.not_needed ? " is-filled" : ""
                      }`}
                    >
                      <td className="tsc-col-part">
                        <div className="tsc-part-name">{line.part_name}</div>
                        {line.part_code ? (
                          <div className="muted tsc-part-code">{line.part_code}</div>
                        ) : null}
                      </td>
                      <td className="tsc-col-qty">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="any"
                          className="tsc-qty-input"
                          disabled={!editable || d.not_needed}
                          value={d.not_needed ? "0" : d.counted_qty}
                          onChange={(e) =>
                            setDraft(line.id, { counted_qty: e.target.value, not_needed: false })
                          }
                          placeholder="—"
                          aria-label={`Count for ${line.part_name}`}
                        />
                      </td>
                      <td className="tsc-col-need">
                        <label className="tsc-need-check">
                          <input
                            type="checkbox"
                            disabled={!editable}
                            checked={d.not_needed}
                            onChange={(e) =>
                              setDraft(line.id, {
                                not_needed: e.target.checked,
                                counted_qty: e.target.checked ? "0" : d.counted_qty,
                              })
                            }
                          />
                          <span className="tsc-need-label">Skip</span>
                        </label>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!filteredLines.length && (
              <p className="muted" style={{ padding: "0.75rem" }}>
                No parts match that filter.
              </p>
            )}
          </div>

          {detail.status === "open" && (
            <div className="card tsc-sign-card">
              <h2>Sign-off</h2>
              <p className="muted">
                I counted this truck (or entered the tech&apos;s count) and the information is
                accurate to the best of my knowledge.
              </p>
              <label className="tsc-accuracy">
                <input
                  type="checkbox"
                  checked={accuracy}
                  onChange={(e) => setAccuracy(e.target.checked)}
                  required
                />
                <span>I confirm this count is accurate</span>
              </label>
              <label>
                Signature (type full name)
                <input
                  type="text"
                  value={signedName}
                  onChange={(e) => setSignedName(e.target.value)}
                  placeholder={user?.display_name || "Your name"}
                  required
                  autoComplete="name"
                />
              </label>
              <label>
                Notes (optional)
                <input
                  type="text"
                  value={sheetNotes}
                  onChange={(e) => setSheetNotes(e.target.value)}
                  placeholder="Missing bins, damaged packaging, …"
                />
              </label>
              <div className="tsc-actions">
                <button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => void onSave()}
                >
                  {busy ? "…" : "Save progress"}
                </button>
                <button className="btn" type="submit" disabled={busy || !accuracy}>
                  {busy ? "…" : "Submit signed count"}
                </button>
              </div>
            </div>
          )}

          {detail.status === "submitted" && (
            <div className="card tsc-sign-card">
              <h2>Submitted</h2>
              <p>
                Signed by <strong>{detail.signed_name}</strong>
                {detail.signed_at ? (
                  <span className="muted"> · {detail.signed_at.replace("T", " ").slice(0, 16)}</span>
                ) : null}
              </p>
              {canManage && (
                <div className="tsc-actions">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => void onSave()}
                  >
                    Save edits
                  </button>
                  <button type="button" className="btn ghost" disabled={busy} onClick={() => void onReopen()}>
                    Reopen for tech
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={() => void onApply()}>
                    Apply to truck stock
                  </button>
                </div>
              )}
            </div>
          )}

          {detail.status === "applied" && (
            <div className="card tsc-sign-card">
              <p>
                Applied
                {detail.applied_by_name ? ` by ${detail.applied_by_name}` : ""}
                {detail.applied_at
                  ? ` · ${detail.applied_at.replace("T", " ").slice(0, 16)}`
                  : ""}
                . Signed by {detail.signed_name || "—"}.
              </p>
            </div>
          )}

          {detail.status === "open" ? null : detail.status === "submitted" && !canManage ? (
            <p className="muted">Waiting for warehouse to apply this count.</p>
          ) : null}
        </form>
      </div>
    );
  }

  // ——— List ———
  return (
    <div className="tsc-page">
      <div className="page-header">
        <div>
          <h1>Truck stock counts</h1>
          <p>
            {isDriver
              ? "Open your unit’s sheet, count what’s on the truck, check Skip if you don’t need a part, then sign."
              : "Hand sheets to techs for the first full truck count. When they submit, apply to inventory so replenishment has a baseline."}
          </p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {canManage && (
        <div className="card tsc-create-card">
          <h2 style={{ marginTop: 0 }}>Open a sheet for techs</h2>
          <p className="muted">
            Loads every truck-stock catalog part onto a form. Techs enter counts; “Don&apos;t need”
            marks parts they refuse. You can fill or apply for them.
          </p>
          <div className="tsc-create-row">
            <label>
              One truck
              <select value={pickVehicle} onChange={(e) => setPickVehicle(e.target.value)}>
                <option value="">Select unit…</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    Unit {v.unit_number}
                    {v.assigned_driver ? ` · ${v.assigned_driver}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn"
              disabled={busy || !pickVehicle}
              onClick={() => void createSheet(false)}
            >
              Open sheet
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              onClick={() => {
                if (confirm("Open a count sheet for every active truck?")) void createSheet(true);
              }}
            >
              Open all active trucks
            </button>
          </div>
        </div>
      )}

      <div className="tsc-filter-bar">
        {(
          [
            ["active", "Open & submitted"],
            ["open", "Open"],
            ["submitted", "Submitted"],
            ["all", "All"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`btn ghost btn-sm${filter === k ? " primary" : ""}`}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && !list.length ? (
        <p className="muted">Loading…</p>
      ) : !list.length ? (
        <div className="card muted">
          {isDriver
            ? "No open truck stock sheets for your unit yet. Ask warehouse or office to open one."
            : "No sheets yet. Open one for a truck above."}
        </div>
      ) : (
        <ul className="tsc-list">
          {list.map((c) => (
            <li key={c.id}>
              <Link to={`/truck-stock?id=${c.id}`} className="tsc-list-card">
                <div className="tsc-list-top">
                  <strong>Unit {c.unit_number}</strong>
                  <span className={`tsc-status st-${c.status}`}>{c.status}</span>
                </div>
                <div className="muted tsc-list-meta">
                  {c.assigned_driver || "Unassigned"} · {c.line_count} parts
                  {c.blank_count > 0 ? ` · ${c.blank_count} blank` : ""}
                  {c.not_needed_count > 0 ? ` · ${c.not_needed_count} not needed` : ""}
                </div>
                {c.signed_name ? (
                  <div className="muted" style={{ fontSize: "0.8rem" }}>
                    Signed: {c.signed_name}
                  </div>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
