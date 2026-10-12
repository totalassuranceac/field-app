import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type MoveRow = {
  id: number;
  source_kind: string;
  source_id: number | null;
  undo_of_log_id: number | null;
  part_label: string;
  from_name: string | null;
  to_name: string | null;
  qty: number;
  from_before: number | null;
  from_after: number | null;
  to_before: number | null;
  to_after: number | null;
  status: string;
  flag_text: string | null;
  user_name: string | null;
  created_at: string;
};

type MoveList = {
  rows: MoveRow[];
  short_count: number;
  flagged_count: number;
};

function statusText(status: string): string {
  if (status === "moved") return "Moved";
  if (status === "blocked_short") return "Short";
  if (status === "clamped") return "Flagged";
  if (status === "undone") return "Undone";
  if (status === "undo") return "Undo";
  return status;
}

function sourceText(row: MoveRow): string {
  if (row.source_kind === "parts_run" && row.source_id) return `Parts run #${row.source_id}`;
  if (row.source_kind === "undo" && row.undo_of_log_id) return `Undo of #${row.undo_of_log_id}`;
  if (row.source_kind === "adjust") return "Manual adjust";
  return row.source_kind;
}

function side(before: number | null, after: number | null): string {
  if (before == null && after == null) return "";
  return `${before ?? "—"} -> ${after ?? "—"}`;
}

export function StockMovesPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const canView = can(user, "viewInventory");
  const canUndo = can(user, "manageInventory");
  const [status, setStatus] = useState("");
  const partFromUrl = (searchParams.get("part") || searchParams.get("q") || "").trim();
  const [part, setPart] = useState(partFromUrl);
  const [data, setData] = useState<MoveList>({ rows: [], short_count: 0, flagged_count: 0 });
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!canView) return;
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (part.trim()) params.set("part", part.trim());
    const q = params.toString();
    const d = await api<MoveList>(`/inventory/stock-moves${q ? `?${q}` : ""}`);
    setData({
      rows: d.rows || [],
      short_count: d.short_count || 0,
      flagged_count: d.flagged_count || 0,
    });
  }, [canView, status, part]);

  useEffect(() => {
    if (!searchParams.has("part") && !searchParams.has("q")) return;
    setPart((searchParams.get("part") || searchParams.get("q") || "").trim());
  }, [searchParams]);

  useEffect(() => {
    if (!canView) return;
    setError("");
    void load().catch((e) => setError(e instanceof Error ? e.message : "Could not load"));
  }, [load, canView]);

  const shownRows = useMemo(() => {
    const q = part.trim().toLowerCase();
    if (!q) return data.rows;
    return data.rows.filter((row) => {
      const label = (row.part_label || "").toLowerCase();
      if (label.includes(q)) return true;
      // Numeric part ids are already applied by the stock-moves query.
      return /^\d+$/.test(q);
    });
  }, [data.rows, part]);

  async function undo(id: number) {
    setBusyId(id);
    setError("");
    try {
      await api(`/inventory/stock-moves/${id}/undo`, { method: "POST", body: "{}" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Undo failed");
    } finally {
      setBusyId(null);
    }
  }

  async function downloadCsv() {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (part.trim()) params.set("part", part.trim());
    const q = params.toString();
    const res = await fetch(`/api/inventory/stock-moves.csv${q ? `?${q}` : ""}`, { credentials: "include" });
    if (!res.ok) {
      setError("Could not export");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "stock-moves.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!canView) {
    return (
      <div className="page">
        <h1>Stock moves</h1>
        <p>You are not allowed to view stock moves.</p>
      </div>
    );
  }

  return (
    <div className="page stock-moves-page">
      <div className="page-header">
        <div>
          <h1>Stock moves</h1>
          <p className="muted">Field App counts only. Each move keeps the before and after.</p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {data.short_count > 0 && (
        <p className="stock-move-banner">
          {data.short_count} short {data.short_count === 1 ? "move needs" : "moves need"} a count fix
        </p>
      )}
      {data.flagged_count > 0 && (
        <p className="stock-move-banner flagged">
          {data.flagged_count} flagged {data.flagged_count === 1 ? "adjust" : "adjusts"} stopped at 0
        </p>
      )}
      <div className="filters no-print">
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="moved">Moved</option>
            <option value="short">Short</option>
            <option value="flagged">Flagged</option>
            <option value="undone">Undone</option>
            <option value="undo">Undo</option>
          </select>
        </label>
        <label>
          Part
          <input value={part} onChange={(e) => setPart(e.target.value)} placeholder="Name, code, or id" />
        </label>
        <button type="button" className="btn secondary btn-sm" onClick={() => void downloadCsv()}>
          CSV
        </button>
      </div>
      {!shownRows.length ? (
        <div className="card muted">No stock moves yet.</div>
      ) : (
        <div className="card stock-move-table-wrap">
          <table className="stock-move-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Part</th>
                <th>From -&gt; to</th>
                <th>Qty</th>
                <th>From</th>
                <th>To</th>
                <th>Status</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row) => (
                <tr
                  key={row.id}
                  className={
                    row.status === "blocked_short"
                      ? "stock-move-short"
                      : row.status === "clamped"
                        ? "stock-move-flagged"
                        : ""
                  }
                >
                  <td>{row.created_at}</td>
                  <td>{row.user_name || ""}</td>
                  <td>{row.part_label}</td>
                  <td>
                    {row.from_name || "—"} -&gt; {row.to_name || "—"}
                  </td>
                  <td>{row.qty}</td>
                  <td>{side(row.from_before, row.from_after)}</td>
                  <td>{side(row.to_before, row.to_after)}</td>
                  <td>
                    {statusText(row.status)}
                    {row.flag_text ? <div className="muted">{row.flag_text}</div> : null}
                  </td>
                  <td>{sourceText(row)}</td>
                  <td>
                    {canUndo && row.status === "moved" && (
                      <button
                        type="button"
                        className="btn secondary btn-sm"
                        disabled={busyId === row.id}
                        onClick={() => void undo(row.id)}
                      >
                        Undo
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
