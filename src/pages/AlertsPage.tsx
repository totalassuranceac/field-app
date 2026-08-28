import { Fragment, useEffect, useMemo, useState } from "react";
import { api, can } from "../api";
import { useAuth } from "../auth";

interface Alert {
  id: number;
  unit_number: string;
  employee_name: string;
  odometer: number;
  fuel_date: string;
  alert_type: string;
  message: string;
  severity: string;
  status: string;
  receipt_key?: string | null;
  gallons?: number | null;
  total_cost?: number | null;
  fuel_entry_id?: number;
}

interface UnitGroup {
  unit_number: string;
  alerts: Alert[];
}

function typeLabel(t: string): string {
  return (t || "").replace(/_/g, " ");
}

function money(n: number | null | undefined) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function groupAlertsByUnit(list: Alert[]): UnitGroup[] {
  const map = new Map<string, Alert[]>();
  for (const a of list) {
    const key = a.unit_number || "?";
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(a);
  }
  return [...map.entries()]
    .map(([unit_number, alerts]) => ({ unit_number, alerts }))
    .sort((a, b) =>
      a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true, sensitivity: "base" })
    );
}

function buildUnitStory(alerts: Alert[]): string {
  if (!alerts.length) return "No alerts on file.";
  const lines = alerts.map(
    (a) =>
      `${a.fuel_date || "—"} · ${a.odometer.toLocaleString()} mi` +
      (a.employee_name ? ` · ${a.employee_name}` : "") +
      ` — ${a.message}`
  );
  const first = alerts[0];
  const last = alerts[alerts.length - 1];
  let summary = "";
  if (alerts.length >= 2 && first.odometer != null && last.odometer != null) {
    const delta = last.odometer - first.odometer;
    summary =
      delta < 0
        ? `Odometer decreased from ${first.odometer.toLocaleString()} mi (${first.fuel_date}) to ${last.odometer.toLocaleString()} mi (${last.fuel_date}).`
        : `Odometer went from ${first.odometer.toLocaleString()} mi (${first.fuel_date}) to ${last.odometer.toLocaleString()} mi (${last.fuel_date}) — jump of ${delta.toLocaleString()} mi.`;
  }
  return summary ? `${summary}\n\n${lines.join("\n")}` : lines.join("\n");
}

export function AlertsPage() {
  const { user } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [status, setStatus] = useState("open");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [receiptAlert, setReceiptAlert] = useState<Alert | null>(null);
  const [printUnit, setPrintUnit] = useState<UnitGroup | null>(null);

  const canManage = can(user, "manageAlerts");
  const showActions = canManage && status === "open";
  const byUnit = useMemo(() => groupAlertsByUnit(alerts), [alerts]);
  const printPrintedOn = useMemo(() => {
    const d = new Date();
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [printUnit]);

  async function load(s = status) {
    const data = await api<{ alerts: Alert[] }>(`/alerts?status=${s}`);
    setAlerts(data.alerts);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [status]);

  useEffect(() => {
    const cls = "print-fuel-alert-packet";
    if (printUnit) document.body.classList.add(cls);
    else document.body.classList.remove(cls);
    return () => document.body.classList.remove(cls);
  }, [printUnit]);

  useEffect(() => {
    function onAfterPrint() {
      setPrintUnit(null);
    }
    window.addEventListener("afterprint", onAfterPrint);
    return () => window.removeEventListener("afterprint", onAfterPrint);
  }, []);

  function printUnitPacket(g: UnitGroup) {
    setPrintUnit(g);
    window.setTimeout(() => window.print(), 120);
  }

  async function ack(id: number, next: "acknowledged" | "dismissed") {
    setBusyId(id);
    setError("");
    try {
      await api(`/alerts/${id}/ack`, {
        method: "POST",
        body: JSON.stringify({ status: next, note: note[id] || undefined }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusyId(null);
    }
  }

  async function voidFuel(a: Alert) {
    const okConfirm = window.confirm(
      `Void this fuel receipt for Unit ${a.unit_number}?\n\n` +
        `${a.fuel_date || "—"} · ${a.odometer.toLocaleString()} mi` +
        (a.employee_name ? ` · ${a.employee_name}` : "") +
        `\n\nThis deletes the fuel entry (and its alerts). Use for duplicates / bad scans.`
    );
    if (!okConfirm) return;
    setBusyId(a.id);
    setError("");
    try {
      await api(`/alerts/${a.id}/void-fuel`, {
        method: "POST",
        body: JSON.stringify({ note: note[a.id] || "Voided from fuel alerts" }),
      });
      if (receiptAlert?.id === a.id) setReceiptAlert(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not void fuel entry");
    } finally {
      setBusyId(null);
    }
  }

  function ReceiptBtn({ a }: { a: Alert }) {
    if (!a.receipt_key) {
      return <span className="muted" style={{ fontSize: "0.78rem" }}>No photo</span>;
    }
    return (
      <button
        type="button"
        className="btn secondary btn-sm"
        onClick={() => setReceiptAlert(a)}
      >
        Receipt
      </button>
    );
  }

  function ActionBlock({ a }: { a: Alert }) {
    return (
      <div className="alert-actions no-print">
        <input
          className="alert-note-input"
          placeholder="Note"
          value={note[a.id] || ""}
          onChange={(e) => setNote((n) => ({ ...n, [a.id]: e.target.value }))}
          disabled={busyId === a.id}
        />
        <div className="alert-action-btns">
          <button
            type="button"
            className="btn secondary btn-sm"
            disabled={busyId === a.id}
            onClick={() => ack(a.id, "acknowledged")}
          >
            {busyId === a.id ? "…" : "Ack"}
          </button>
          <button
            type="button"
            className="btn secondary btn-sm"
            disabled={busyId === a.id}
            onClick={() => ack(a.id, "dismissed")}
          >
            Dismiss
          </button>
          <button
            type="button"
            className="btn secondary btn-sm btn-void"
            disabled={busyId === a.id}
            onClick={() => void voidFuel(a)}
            title="Delete this fuel entry (duplicate / bad scan)"
          >
            Void
          </button>
        </div>
      </div>
    );
  }

  const colSpan = showActions ? 8 : 7;

  return (
    <div className="alerts-page">
      <div className="page-header">
        <div>
          <h1>Fuel alerts</h1>
          <p>
            Grouped by unit (oldest receipt first). Open each receipt photo to verify gallons,
            total, and that the odometer story makes sense.
          </p>
        </div>
        <div className="filters no-print">
          {["open", "acknowledged", "dismissed"].map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${status === s ? "active" : ""}`}
              onClick={() => setStatus(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="error">{error}</div>}

      {!alerts.length && <div className="card empty">No {status} alerts.</div>}

      {byUnit.length > 0 && (
        <div className="card alerts-wide">
          <div className="table-wrap alerts-table-wrap">
            <table className="alerts-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Unit</th>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Miles</th>
                  <th>Message</th>
                  <th className="no-print">Receipt</th>
                  {showActions && <th className="no-print">Action</th>}
                </tr>
              </thead>
              <tbody>
                {byUnit.map((g) => (
                  <Fragment key={g.unit_number}>
                    <tr className="alert-unit-group-header">
                      <td colSpan={colSpan}>
                        <div className="alert-unit-header-row">
                          <div>
                            <strong>Unit {g.unit_number}</strong>
                            <span className="muted" style={{ marginLeft: "0.5rem" }}>
                              {g.alerts.length} alert{g.alerts.length === 1 ? "" : "s"} · oldest →
                              newest
                            </span>
                          </div>
                          <button
                            type="button"
                            className="btn secondary btn-sm no-print"
                            onClick={() => printUnitPacket(g)}
                          >
                            Print for tech
                          </button>
                        </div>
                      </td>
                    </tr>
                    {g.alerts.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <span className={`badge ${a.severity}`}>{a.severity}</span>
                        </td>
                        <td>
                          <strong className="alert-unit">{a.unit_number}</strong>
                        </td>
                        <td>{a.fuel_date}</td>
                        <td>{a.employee_name}</td>
                        <td>{a.odometer.toLocaleString()}</td>
                        <td>
                          <div className="alert-msg">{a.message}</div>
                          <div className="muted alert-type">{typeLabel(a.alert_type)}</div>
                        </td>
                        <td className="no-print">
                          <ReceiptBtn a={a} />
                        </td>
                        {showActions && (
                          <td className="no-print">
                            <ActionBlock a={a} />
                          </td>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {byUnit.length > 0 && (
        <div className="alerts-narrow">
          {byUnit.map((g) => (
            <div key={g.unit_number} className="alert-unit-block">
              <div className="alert-unit-header-row">
                <h2 className="alert-unit-heading">
                  Unit {g.unit_number}
                  <span className="muted" style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                    {" "}
                    · {g.alerts.length} · oldest first
                  </span>
                </h2>
                <button
                  type="button"
                  className="btn secondary btn-sm no-print"
                  onClick={() => printUnitPacket(g)}
                >
                  Print for tech
                </button>
              </div>
              <ul className="alerts-narrow-list">
                {g.alerts.map((a) => (
                  <li key={a.id} className={`alert-card severity-${a.severity}`}>
                    <div className="alert-card-header">
                      <div className="alert-card-title">
                        <strong className="alert-unit">{a.fuel_date || "No date"}</strong>
                        <div className="alert-card-badges">
                          <span className={`badge ${a.severity}`}>{a.severity}</span>
                          <span className="badge">{typeLabel(a.alert_type)}</span>
                        </div>
                      </div>
                    </div>
                    <p className="alert-card-message">{a.message}</p>
                    <dl className="alert-fields">
                      <div className="alert-field">
                        <dt>Employee</dt>
                        <dd>{a.employee_name || "—"}</dd>
                      </div>
                      <div className="alert-field">
                        <dt>Odometer</dt>
                        <dd>{a.odometer.toLocaleString()} mi</dd>
                      </div>
                      <div className="alert-field">
                        <dt>Gallons</dt>
                        <dd>{a.gallons != null ? Number(a.gallons).toLocaleString() : "—"}</dd>
                      </div>
                      <div className="alert-field">
                        <dt>Total</dt>
                        <dd>{money(a.total_cost)}</dd>
                      </div>
                    </dl>
                    <div className="toolbar no-print" style={{ marginTop: "0.35rem" }}>
                      <ReceiptBtn a={a} />
                    </div>
                    {showActions && <ActionBlock a={a} />}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {receiptAlert && (
        <div className="modal-backdrop" onClick={() => setReceiptAlert(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h2>
              Fuel receipt · Unit {receiptAlert.unit_number}
            </h2>
            <p style={{ marginTop: 0 }}>
              <strong>{receiptAlert.fuel_date || "—"}</strong>
              {receiptAlert.employee_name ? ` · ${receiptAlert.employee_name}` : ""}
              {" · "}
              {receiptAlert.odometer.toLocaleString()} mi
              {receiptAlert.gallons != null
                ? ` · ${Number(receiptAlert.gallons).toLocaleString()} gal`
                : ""}
              {receiptAlert.total_cost != null ? ` · ${money(receiptAlert.total_cost)}` : ""}
            </p>
            <p className="muted" style={{ marginTop: 0 }}>
              {receiptAlert.message}
            </p>
            {receiptAlert.receipt_key ? (
              <div style={{ textAlign: "center", marginBottom: "1rem" }}>
                <a
                  href={`/api/uploads/${encodeURIComponent(receiptAlert.receipt_key)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`/api/uploads/${encodeURIComponent(receiptAlert.receipt_key)}`}
                    alt="Fuel receipt"
                    style={{
                      maxWidth: "100%",
                      maxHeight: "55vh",
                      borderRadius: 8,
                      border: "1px solid var(--line)",
                    }}
                  />
                </a>
                <p className="muted" style={{ fontSize: "0.82rem", margin: "0.35rem 0 0" }}>
                  Tap photo for full size
                </p>
              </div>
            ) : (
              <p className="muted">No receipt photo on this fuel entry.</p>
            )}
            <div className="toolbar alert-action-btns">
              {showActions && (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busyId === receiptAlert.id}
                    onClick={() => {
                      void ack(receiptAlert.id, "acknowledged").then(() => setReceiptAlert(null));
                    }}
                  >
                    Ack
                  </button>
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={busyId === receiptAlert.id}
                    onClick={() => {
                      void ack(receiptAlert.id, "dismissed").then(() => setReceiptAlert(null));
                    }}
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    className="btn secondary btn-sm btn-void"
                    disabled={busyId === receiptAlert.id}
                    onClick={() => void voidFuel(receiptAlert)}
                  >
                    Void entry
                  </button>
                </>
              )}
              <button
                type="button"
                className="btn secondary btn-sm"
                onClick={() => setReceiptAlert(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print packet: unit problem + receipt copies + tech write-in response */}
      {printUnit && (
        <div className="print-only alert-print-packet" aria-hidden>
          <header className="alert-print-header">
            <div>
              <p className="alert-print-brand">Total Assurance · Fleet fuel review</p>
              <h1>Fuel log problem — Unit {printUnit.unit_number}</h1>
              <p className="alert-print-sub">
                Hand to technician · please review receipts and explain what happened
              </p>
            </div>
            <div className="alert-print-meta">
              <div>
                <span className="alert-print-k">Printed</span> {printPrintedOn}
              </div>
              <div>
                <span className="alert-print-k">By</span>{" "}
                {user?.display_name || "Office"}
              </div>
              <div>
                <span className="alert-print-k">Alerts</span> {printUnit.alerts.length}
              </div>
            </div>
          </header>

          <section className="alert-print-block">
            <h2>What looks wrong</h2>
            <p className="alert-print-pre">{buildUnitStory(printUnit.alerts)}</p>
          </section>

          <section className="alert-print-block">
            <h2>Fuel receipts involved (oldest → newest)</h2>
            {printUnit.alerts.map((a, idx) => (
              <div key={a.id} className="alert-print-receipt-card">
                <div className="alert-print-receipt-head">
                  <strong>
                    #{idx + 1} · {a.fuel_date || "—"} · {a.odometer.toLocaleString()} mi
                  </strong>
                  <span>
                    {a.employee_name || "—"}
                    {a.gallons != null ? ` · ${Number(a.gallons).toLocaleString()} gal` : ""}
                    {a.total_cost != null ? ` · ${money(a.total_cost)}` : ""}
                  </span>
                </div>
                <p className="alert-print-msg">
                  <span className="alert-print-k">{typeLabel(a.alert_type)}</span> {a.message}
                </p>
                {a.receipt_key ? (
                  <img
                    className="alert-print-receipt-img"
                    src={`/api/uploads/${encodeURIComponent(a.receipt_key)}`}
                    alt={`Receipt ${a.fuel_date || a.id}`}
                  />
                ) : (
                  <p className="alert-print-no-photo">No receipt photo on file for this entry.</p>
                )}
              </div>
            ))}
          </section>

          <section className="alert-print-response">
            <h2>Technician response</h2>
            <p className="alert-print-prompt">
              What caused this issue? (wrong odometer typed, duplicate receipt, unit swap, etc.)
            </p>
            <div className="alert-print-lines">
              <div className="alert-print-line" />
              <div className="alert-print-line" />
              <div className="alert-print-line" />
              <div className="alert-print-line" />
              <div className="alert-print-line" />
              <div className="alert-print-line" />
            </div>
            <div className="alert-print-sign-row">
              <div className="alert-print-sign">
                <span className="alert-print-line" />
                <span className="alert-print-k">Tech signature</span>
              </div>
              <div className="alert-print-sign">
                <span className="alert-print-line" />
                <span className="alert-print-k">Printed name</span>
              </div>
              <div className="alert-print-sign">
                <span className="alert-print-line" />
                <span className="alert-print-k">Date</span>
              </div>
            </div>
          </section>

          <p className="alert-print-foot">
            Return this sheet to the office / shop with the explanation. Keep with fuel alert
            records for Unit {printUnit.unit_number}.
          </p>
        </div>
      )}
    </div>
  );
}
