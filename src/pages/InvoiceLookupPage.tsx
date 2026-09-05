import { FormEvent, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

type Equipment = {
  model: string | null;
  serial: string | null;
  label?: string | null;
};

type LookupSection = "buy" | "st_installed";

type LookupResult = {
  source: "st" | "warranty" | "receipt";
  source_label: string;
  section: LookupSection;
  customer_name: string | null;
  address: string;
  equipment: Equipment[];
  invoice_number?: string | null;
  st_location_id?: number | null;
  warranty_log?: string | null;
  notes?: string | null;
  equipment_missing?: boolean;
};

type LookupResponse = {
  query: string;
  normalized: string;
  results: LookupResult[];
  suggestions: string[];
  st_error?: string | null;
  st_installed_unavailable?: boolean;
  st_installed_banner?: string | null;
  error?: string;
};

function canUseInvoiceLookup(role: string | undefined): boolean {
  return role === "admin" || role === "office" || role === "supervisor";
}

export function InvoiceLookupPage() {
  const { user } = useAuth();
  const allowed = canUseInvoiceLookup(user?.role);

  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<LookupResponse | null>(null);

  const buyResults = useMemo(
    () => (data?.results || []).filter((r) => r.section === "buy"),
    [data]
  );
  const stResults = useMemo(
    () => (data?.results || []).filter((r) => r.section === "st_installed"),
    [data]
  );

  if (!allowed) {
    return <Navigate to="/" replace />;
  }

  async function runSearch(raw: string) {
    const query = raw.trim();
    if (query.length < 3) {
      setError("Type at least 3 characters of the street address.");
      return;
    }
    setBusy(true);
    setError("");
    setData(null);
    try {
      const res = await api<LookupResponse>(
        `/office/invoice-lookup?q=${encodeURIComponent(query)}`,
        { timeoutMs: 45_000 }
      );
      if (res.error) throw new Error(res.error);
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed");
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void runSearch(q);
  }

  async function printResult(r: LookupResult) {
    setError("");
    try {
      const res = await fetch("/api/office/invoice-lookup/print", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          address: r.address,
          customer_name: r.customer_name,
          equipment: r.equipment,
          invoice_number: r.invoice_number,
          warranty_log: r.warranty_log,
          notes: r.notes,
          source_label: r.source_label,
          section: r.section,
        }),
      });
      const html = await res.text();
      if (!res.ok) {
        let msg = "Print failed";
        try {
          msg = (JSON.parse(html) as { error?: string }).error || msg;
        } catch {
          /* use default */
        }
        throw new Error(msg);
      }
      const w = window.open("", "_blank", "noopener,noreferrer,width=900,height=1000");
      if (!w) {
        setError("Allow pop-ups to print the sheet.");
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Print failed");
    }
  }

  function copyModelSerial(r: LookupResult) {
    const lines = r.equipment
      .filter((e) => e.model || e.serial)
      .map((e) => {
        const bits = [
          e.label ? `${e.label}:` : null,
          e.model ? `Model ${e.model}` : null,
          e.serial ? `Serial ${e.serial}` : null,
        ].filter(Boolean);
        return bits.join(" · ");
      });
    const text = [r.source_label, r.address, r.customer_name, ...lines]
      .filter(Boolean)
      .join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => setError(""),
      () => setError("Could not copy — select text manually")
    );
  }

  function renderCard(r: LookupResult, idx: number) {
    const missing = !!r.equipment_missing || !r.equipment.some((e) => e.model || e.serial);
    return (
      <article
        key={`${r.section}-${r.source}-${r.st_location_id || r.warranty_log || r.invoice_number || idx}`}
        className={`card invoice-lookup-card${missing ? " is-missing" : ""}`}
      >
        <div className="invoice-lookup-source-pill">{r.source_label}</div>
        <div className="invoice-lookup-equip">
          {missing ? (
            <p className="invoice-lookup-missing">
              {r.section === "buy"
                ? "Address matched — no model/serial on buy/warranty record"
                : "Address matched — equipment missing in ST"}
            </p>
          ) : (
            r.equipment
              .filter((e) => e.model || e.serial)
              .map((e, i) => (
                <div key={i} className="invoice-lookup-equip-block">
                  {e.label ? (
                    <div className="muted invoice-lookup-equip-label">{e.label}</div>
                  ) : null}
                  <div className="invoice-lookup-model">
                    <span>Model</span>
                    <strong>{e.model || "—"}</strong>
                  </div>
                  <div className="invoice-lookup-serial">
                    <span>Serial</span>
                    <strong>{e.serial || "—"}</strong>
                  </div>
                </div>
              ))
          )}
        </div>
        <div className="invoice-lookup-meta">
          {r.customer_name ? (
            <div>
              <span className="muted">Customer</span> {r.customer_name}
            </div>
          ) : null}
          <div>
            <span className="muted">Address</span> {r.address}
          </div>
          {r.st_location_id ? (
            <div>
              <span className="muted">ST location</span> {r.st_location_id}
            </div>
          ) : null}
          {r.warranty_log ? (
            <div>
              <span className="muted">Warranty log</span> {r.warranty_log}
            </div>
          ) : null}
          {r.invoice_number ? (
            <div>
              <span className="muted">Invoice #</span> {r.invoice_number}
            </div>
          ) : null}
          {r.notes ? (
            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {r.notes}
            </div>
          ) : null}
        </div>
        <div className="toolbar invoice-lookup-actions">
          <button
            type="button"
            className="btn"
            disabled={missing}
            onClick={() => void printResult(r)}
            title={missing ? "No model/serial to print" : "Print model & serial sheet"}
          >
            Print
          </button>
          <button
            type="button"
            className="btn secondary"
            disabled={missing}
            onClick={() => copyModelSerial(r)}
          >
            Copy model + serial
          </button>
        </div>
      </article>
    );
  }

  return (
    <div className="page invoice-lookup-page">
      <div className="page-header no-print">
        <div>
          <h1>Invoice lookup</h1>
          <p className="muted" style={{ margin: 0 }}>
            Buy-vendor / warranty serials first (packing slip). ST installed equipment is secondary
            and may differ — both shown when they disagree. Nothing invented.
          </p>
        </div>
        <Link className="btn secondary btn-sm" to="/">
          Home
        </Link>
      </div>

      <form className="card invoice-lookup-search no-print" onSubmit={onSubmit}>
        <label>
          Street address
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Street address (e.g. 22 Townhouse)"
            autoFocus
            autoComplete="street-address"
            enterKeyHint="search"
          />
        </label>
        <button className="btn" type="submit" disabled={busy || q.trim().length < 3}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error ? <div className="error inv-flash no-print">{error}</div> : null}

      {busy ? <p className="muted no-print">Searching…</p> : null}

      {data && !busy ? (
        <div className="invoice-lookup-results no-print">
          {data.st_installed_banner || data.st_installed_unavailable ? (
            <div className="invoice-lookup-banner" role="status">
              {data.st_installed_banner ||
                "ST installed equipment not available (API scope) — using buy records only"}
            </div>
          ) : null}
          {data.st_error ? (
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              ServiceTitan note: {data.st_error}
            </p>
          ) : null}

          {!data.results.length && !data.suggestions.length ? (
            <p className="muted">No match — try a shorter street name</p>
          ) : null}

          {data.suggestions.length > 0 ? (
            <div className="invoice-lookup-suggestions">
              <div className="muted" style={{ marginBottom: "0.35rem" }}>
                Did you mean? (Field App fuzzy — ST search is contains-only)
              </div>
              <div className="invoice-lookup-chips">
                {data.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="btn secondary btn-sm"
                    onClick={() => {
                      setQ(s);
                      void runSearch(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {buyResults.length > 0 ? (
            <section className="invoice-lookup-section">
              <h2 className="invoice-lookup-section-title">
                1 · From buy / warranty records (primary)
              </h2>
              <p className="muted invoice-lookup-section-hint">
                Model + serial from vendor purchase / warranty cards — what Kelsie usually needs for
                the buy invoice.
              </p>
              {buyResults.map((r, i) => renderCard(r, i))}
            </section>
          ) : null}

          {stResults.length > 0 ? (
            <section className="invoice-lookup-section">
              <h2 className="invoice-lookup-section-title">
                2 · From ST installed equipment (secondary)
              </h2>
              <p className="muted invoice-lookup-section-hint">
                Location equipment in ServiceTitan — may differ from the buy-vendor packing slip.
                Shown separately so nothing is mixed unlabeled.
              </p>
              {stResults.map((r, i) => renderCard(r, i + 500))}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
