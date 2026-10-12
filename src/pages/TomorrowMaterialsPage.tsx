import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

type Line = { id: number; description: string; qty: number };
type RequestRow = {
  id: number;
  appointment_date: string;
  address_text: string;
  job_id: string | null;
  tech_names_text: string | null;
  status: "needed" | "ordered" | "ready" | "cancelled";
  requester_name?: string | null;
  lines?: Line[];
};
type Tech = { id: number; name: string };

function tomorrowIso(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1, 12)).toISOString().slice(0, 10);
}

function statusLabel(s: RequestRow["status"]): string {
  if (s === "needed") return "Needed";
  if (s === "ordered") return "Ordered";
  if (s === "ready") return "Parts ready";
  return s;
}

function orderForShopHref(partName: string): string {
  const name = partName.trim();
  if (!name) return "/parts-orders";
  return `/parts-orders?part=${encodeURIComponent(name)}`;
}

export function PullTomorrowHome() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    void api<{ open_count?: number; requests?: RequestRow[] }>(
      `/materials/tomorrow?date=${encodeURIComponent(tomorrowIso())}`
    )
      .then((d) => {
        const open = (d.requests || []).filter(
          (r) => r.status === "needed" || r.status === "ordered"
        ).length;
        setCount(open);
      })
      .catch(() => setCount(0));
  }, []);
  const hot = (count || 0) > 0;
  return (
    <Link
      to="/tomorrow-materials"
      className={`office-action${hot ? " primary" : ""}`}
      style={hot ? { outline: "2px solid #b42318" } : undefined}
    >
      <span>
        <strong>Pull for tomorrow{hot ? ` (${count})` : ""}</strong>
        <span className="office-action-hint">{hot ? `${count} to pull` : "All clear"}</span>
      </span>
    </Link>
  );
}

export function TomorrowMaterialsPage() {
  const { user } = useAuth();
  const canOrder =
    user?.role === "admin" || user?.role === "warehouse" || Boolean(user?.is_warehouse);
  const canCreate =
    canOrder ||
    user?.role === "office" ||
    user?.role === "supervisor" ||
    user?.role === "admin";
  const [date, setDate] = useState(tomorrowIso);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [techs, setTechs] = useState<Tech[]>([]);
  const [filter, setFilter] = useState<"all" | "needed" | "ordered">("all");
  const [error, setError] = useState("");
  const [shelfNote, setShelfNote] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [orderNote, setOrderNote] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [address, setAddress] = useState("");
  const [techIds, setTechIds] = useState<number[]>([]);
  const [desc, setDesc] = useState("");
  const [qty, setQty] = useState("1");
  const [extraLines, setExtraLines] = useState<Array<{ description: string; qty: number }>>([]);
  const [saving, setSaving] = useState(false);
  const [suggest, setSuggest] = useState<
    Array<{ pickup_id: number; address: string; part_summary: string; picked_at: string | null }>
  >([]);
  const [dismissedAddr, setDismissedAddr] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ requests?: RequestRow[] }>(
      `/materials/tomorrow?date=${encodeURIComponent(date)}`
    );
    setRequests(res.requests || []);
  }, [date]);

  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : "Could not load"));
  }, [load]);

  useEffect(() => {
    if (!canCreate) return;
    void api<{ techs: Tech[] }>("/materials/techs")
      .then((r) => setTechs(r.techs || []))
      .catch(() => setTechs([]));
  }, [canCreate]);

  useEffect(() => {
    const trimmed = address.trim();
    if (!showForm || trimmed.length < 8 || trimmed.toLowerCase() === dismissedAddr) {
      setSuggest([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api<{ matches: typeof suggest }>(
        `/materials/suggest-from-pickups?address=${encodeURIComponent(trimmed)}`
      )
        .then((r) => setSuggest(r.matches || []))
        .catch(() => setSuggest([]));
    }, 400);
    return () => window.clearTimeout(t);
  }, [address, showForm, dismissedAddr]);

  const rows = useMemo(() => {
    return requests.filter((r) => {
      if (filter === "needed") return r.status === "needed";
      if (filter === "ordered") return r.status === "ordered";
      return true;
    });
  }, [requests, filter]);

  async function partsReady(id: number) {
    setBusyId(id);
    setError("");
    try {
      const res = await api<{ shelf?: Array<{ note?: string }> }>(
        `/materials/requests/${id}/parts-ready`,
        { method: "POST", body: "{}" }
      );
      const notes = (res.shelf || []).map((line) => line.note || "").filter(Boolean);
      setShelfNote(notes.join(" ") || "Marked ready.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark ready");
    } finally {
      setBusyId(null);
    }
  }

  async function order(id: number) {
    setBusyId(id);
    setError("");
    try {
      await api(`/materials/requests/${id}/order`, {
        method: "POST",
        body: JSON.stringify({ note: orderNote.trim() || null }),
      });
      setOrderNote("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark ordered");
    } finally {
      setBusyId(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = address.trim();
    if (trimmed.toLowerCase() !== dismissedAddr && suggest.length === 0) {
      try {
        const r = await api<{ matches: typeof suggest }>(
          `/materials/suggest-from-pickups?address=${encodeURIComponent(trimmed)}`
        );
        if ((r.matches || []).length) {
          setSuggest(r.matches);
          return;
        }
      } catch {
        /* still allow save */
      }
    }
    setSaving(true);
    setError("");
    try {
      await api("/materials/requests", {
        method: "POST",
        body: JSON.stringify({
          appointment_date: date,
          address_text: address.trim(),
          tech_user_ids: techIds,
          lines: [
            { description: desc.trim(), qty: Number(qty) || 1 },
            ...extraLines,
          ].filter((l) => l.description.trim().length >= 2),
        }),
      });
      setAddress("");
      setDesc("");
      setQty("1");
      setExtraLines([]);
      setSuggest([]);
      setTechIds([]);
      setShowForm(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Pull for tomorrow</h1>
          <p className="muted">
            Pull, bag, label (address + date), Next Day shelf, tap Parts ready. {date}
          </p>
        </div>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </header>
      <p className="toolbar" style={{ marginTop: 0 }}>
        <Link className="btn secondary btn-sm" to="/part-pickup">
          Will-call
        </Link>
        <Link className="btn secondary btn-sm" to="/parts-orders">
          Order for shop
        </Link>
      </p>
      {error ? <div className="error">{error}</div> : null}
      {shelfNote ? <div className="success">{shelfNote}</div> : null}
      {canCreate ? (
        <div className="toolbar" style={{ marginBottom: "0.65rem" }}>
          <button type="button" className="btn" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "Close form" : "New pull request"}
          </button>
        </div>
      ) : null}
      {showForm ? (
        <form className="card form" onSubmit={(e) => void submit(e)} style={{ marginBottom: "0.75rem" }}>
          <label>
            Address
            <input value={address} onChange={(e) => setAddress(e.target.value)} required minLength={4} />
          </label>
          <label>
            Tech doing the job
            <select
              value=""
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id > 0 && !techIds.includes(id)) setTechIds((ids) => [...ids, id]);
              }}
            >
              <option value="">Technicians and lead installers</option>
              {techs
                .filter((t) => !techIds.includes(t.id))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
          {techIds.length > 0 ? (
            <div className="toolbar">
              {techIds.map((id) => {
                const name = techs.find((t) => t.id === id)?.name || `Tech ${id}`;
                return (
                  <button
                    key={id}
                    type="button"
                    className="chip"
                    onClick={() => setTechIds((ids) => ids.filter((x) => x !== id))}
                  >
                    {name} x
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="muted" style={{ marginTop: 0 }}>
              Pick at least one technician or lead installer.
            </p>
          )}
          <div className="form row">
            <label style={{ flex: "1 1 12rem" }}>
              Materials to pull
              <input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="6 filters 16x25x1"
                required
                minLength={2}
              />
            </label>
            <label style={{ flex: "0 0 5rem" }}>
              Qty
              <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" />
            </label>
          </div>
          {extraLines.map((l, i) => (
            <div key={`${l.description}-${i}`} className="muted">
              {l.qty} x {l.description}
            </div>
          ))}
          {suggest.length > 0 ? (
            <div className="card" style={{ marginTop: "0.5rem" }}>
              <strong>Add recent pickup?</strong>
              {suggest.map((m) => (
                <div key={m.pickup_id} style={{ marginTop: "0.45rem" }}>
                  <div>
                    {m.address} - {m.part_summary}
                    {m.picked_at ? ` - ${String(m.picked_at).slice(0, 10)}` : ""}
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const line = { description: m.part_summary, qty: 1 };
                      if (!desc.trim()) setDesc(m.part_summary);
                      else setExtraLines((rows) => [...rows, line]);
                      setSuggest((rows) => rows.filter((x) => x.pickup_id !== m.pickup_id));
                    }}
                  >
                    Add to list
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn secondary btn-sm"
                onClick={() => {
                  setDismissedAddr(address.trim().toLowerCase());
                  setSuggest([]);
                }}
              >
                No thanks
              </button>
            </div>
          ) : null}
          <button className="btn" type="submit" disabled={saving || techIds.length < 1}>
            {saving ? "Saving..." : "Submit"}
          </button>
        </form>
      ) : null}
      <div className="filters" style={{ marginBottom: "0.75rem" }}>
        {(
          [
            ["all", "All"],
            ["needed", "Needed"],
            ["ordered", "Ordered"],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`chip ${filter === k ? "active" : ""}`}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {!rows.length ? <div className="card muted">Nothing to pull for this date.</div> : null}
      {rows.map((r) => (
        <article key={r.id} className="card" style={{ marginBottom: "0.65rem" }}>
          <strong>{r.address_text}</strong>
          <div className="muted">
            {r.tech_names_text || "Tech"} - {r.requester_name || "Office"} - {statusLabel(r.status)}
          </div>
          <ul style={{ margin: "0.4rem 0", paddingLeft: "1.1rem" }}>
            {(r.lines || []).map((l) => (
              <li key={l.id}>
                {l.qty} x {l.description}
                <span className="toolbar" style={{ marginTop: "0.25rem" }}>
                  <Link className="btn secondary btn-sm" to="/part-pickup">
                    Will-call
                  </Link>
                  <Link className="btn secondary btn-sm" to={orderForShopHref(l.description || "")}>
                    Order for shop
                  </Link>
                </span>
              </li>
            ))}
          </ul>
          {r.status === "needed" || r.status === "ordered" ? (
            canOrder ? (
              <div className="toolbar">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busyId === r.id}
                  onClick={() => void partsReady(r.id)}
                >
                  Parts ready
                </button>
                {r.status !== "ordered" ? (
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={busyId === r.id}
                    onClick={() => void order(r.id)}
                  >
                    Order
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="muted">Waiting on warehouse.</p>
            )
          ) : (
            <p className="muted">Ready to load.</p>
          )}
        </article>
      ))}
      {canOrder ? (
        <label className="muted" style={{ display: "block", marginTop: "0.5rem" }}>
          Note for next Order (optional)
          <input value={orderNote} onChange={(e) => setOrderNote(e.target.value)} placeholder="Short stock" />
        </label>
      ) : (
        <p className="muted">Order is warehouse only.</p>
      )}
    </div>
  );
}
