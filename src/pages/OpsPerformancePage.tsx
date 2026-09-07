import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type OpsPeriod = "this_week" | "last_week" | "this_month" | "last_month";

type OpsPersonRow = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  jobs: number | null;
  jobs_prior: number | null;
  jobs_delta: number | null;
  sales: number | null;
  sales_prior: number | null;
  sales_delta: number | null;
  zero_charge: number | null;
  zero_charge_prior: number | null;
  zero_charge_delta: number | null;
  status: "ok" | "unavailable";
};

type OpsPayload = {
  period: OpsPeriod;
  period_label: string;
  prior_label: string;
  timezone: string;
  service: OpsPersonRow[];
  install: OpsPersonRow[];
  pulse: {
    jobs: number | null;
    jobs_prior: number | null;
    jobs_delta: number | null;
  };
  miller_user_id: number | null;
  message?: string;
  error?: string;
};

type JobLine = {
  st_job_id: string;
  job_number: string | null;
  customer_name: string | null;
  address: string | null;
  completed_at: string | null;
  total: number | null;
  job_type: string | null;
};

const PERIODS: Array<{ id: OpsPeriod; label: string }> = [
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
];

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function signed(n: number | null | undefined, asMoney = false): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "even";
  if (asMoney) {
    const abs = money(Math.abs(n));
    return n > 0 ? `+${abs}` : `−${abs}`;
  }
  return n > 0 ? `+${n}` : String(n);
}

function deltaClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "ops-delta is-flat";
  return n > 0 ? "ops-delta is-up" : "ops-delta is-down";
}

export function OpsPerformancePage() {
  const { user } = useAuth();
  const allowed = can(user, "viewOpsPerformance");
  const [period, setPeriod] = useState<OpsPeriod>("this_week");
  const [data, setData] = useState<OpsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drill, setDrill] = useState<{
    userId: number;
    name: string;
    jobs: JobLine[];
    loading: boolean;
    error: string;
  } | null>(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError("");
    try {
      const res = await api<OpsPayload>(
        `/ops-performance?period=${encodeURIComponent(period)}`,
        { timeoutMs: 90_000 }
      );
      setData(res);
      if (res.error && !(res.service?.length || res.install?.length)) {
        setError(res.error);
      }
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load performance");
    } finally {
      setLoading(false);
    }
  }, [allowed, period]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openPerson(row: OpsPersonRow) {
    setDrill({
      userId: row.user_id,
      name: row.display_name,
      jobs: [],
      loading: true,
      error: "",
    });
    try {
      const res = await api<{
        display_name?: string;
        jobs?: JobLine[];
        error?: string;
        message?: string;
      }>(
        `/ops-performance/jobs?user_id=${row.user_id}&period=${encodeURIComponent(period)}`,
        { timeoutMs: 60_000 }
      );
      setDrill({
        userId: row.user_id,
        name: res.display_name || row.display_name,
        jobs: res.jobs || [],
        loading: false,
        error: res.error || res.message || "",
      });
    } catch (e) {
      setDrill({
        userId: row.user_id,
        name: row.display_name,
        jobs: [],
        loading: false,
        error: e instanceof Error ? e.message : "Could not load jobs",
      });
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Ops performance</h1>
        </header>
        <div className="empty-state">
          <p>Office, supervisors, and admin only.</p>
          <Link to="/" className="btn secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page ops-perf-page">
      <header className="page-header">
        <div>
          <h1>Ops performance</h1>
          <p className="muted">
            How the shop is doing — jobs, sales, zero-charge.
            {data?.period_label ? ` · ${data.period_label}` : ""}
          </p>
        </div>
        <button
          type="button"
          className="btn secondary"
          onClick={() => void load()}
          disabled={loading}
        >
          {loading ? "Loading…" : "Reload"}
        </button>
      </header>

      <div className="ops-period-toggles" role="tablist" aria-label="Period">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={period === p.id}
            className={`ops-period-btn${period === p.id ? " is-active" : ""}`}
            onClick={() => setPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {data?.prior_label ? (
        <p className="muted ops-vs-prior">Vs prior: {data.prior_label}</p>
      ) : null}

      {error && (
        <div className="error" style={{ marginBottom: "0.85rem" }}>
          {error}
        </div>
      )}

      {data?.message && !error ? (
        <p className="muted ops-hint">{data.message}</p>
      ) : null}

      {data?.pulse && (
        <section className="card ops-pulse" aria-label="Shop pulse">
          <h2 className="ops-section-title">Shop pulse</h2>
          <div className="ops-pulse-row">
            <span className="ops-pulse-label">Completed jobs</span>
            <span className="ops-pulse-value">{data.pulse.jobs ?? "—"}</span>
            <span className={deltaClass(data.pulse.jobs_delta)}>
              vs prior {signed(data.pulse.jobs_delta)}
            </span>
          </div>
        </section>
      )}

      <section className="card ops-block" aria-label="Service techs">
        <h2 className="ops-section-title">Service techs</h2>
        <p className="muted ops-block-hint">
          All active field techs · A–Z · tap a name for jobs
        </p>
        {loading && !data ? (
          <p className="muted">Loading…</p>
        ) : !(data?.service || []).length ? (
          <p className="muted">No service techs found.</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Jobs</th>
                  <th scope="col">Sales</th>
                  <th scope="col">Zero-charge</th>
                  <th scope="col">Vs prior</th>
                </tr>
              </thead>
              <tbody>
                {(data?.service || []).map((r) => (
                  <tr key={r.user_id}>
                    <td>
                      <button
                        type="button"
                        className="ops-name-btn"
                        onClick={() => void openPerson(r)}
                      >
                        {r.display_name}
                      </button>
                    </td>
                    {r.status === "unavailable" ? (
                      <td colSpan={4} className="muted">
                        No ST tech linked
                      </td>
                    ) : (
                      <>
                        <td>{r.jobs ?? "—"}</td>
                        <td>{money(r.sales)}</td>
                        <td>{r.zero_charge ?? "—"}</td>
                        <td>
                          <span className={deltaClass(r.sales_delta ?? r.jobs_delta)}>
                            {r.sales_delta != null
                              ? signed(r.sales_delta, true)
                              : signed(r.jobs_delta)}
                          </span>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card ops-block" aria-label="Install duct">
        <h2 className="ops-section-title">Install / duct</h2>
        <p className="muted ops-block-hint">
          Miller’s crew · jobs completed · no sales race
        </p>
        {!(data?.install || []).length ? (
          <p className="muted">
            {data?.miller_user_id
              ? "No crew linked yet — set Chris Miller as manager on duct logins."
              : "Link Chris Miller in People, then set him as manager on duct techs."}
          </p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Jobs</th>
                  <th scope="col">Vs prior</th>
                </tr>
              </thead>
              <tbody>
                {(data?.install || []).map((r) => (
                  <tr key={r.user_id}>
                    <td>
                      <button
                        type="button"
                        className="ops-name-btn"
                        onClick={() => void openPerson(r)}
                      >
                        {r.display_name}
                      </button>
                    </td>
                    {r.status === "unavailable" ? (
                      <td colSpan={2} className="muted">
                        No ST tech linked
                      </td>
                    ) : (
                      <>
                        <td>{r.jobs ?? "—"}</td>
                        <td>
                          <span className={deltaClass(r.jobs_delta)}>
                            {signed(r.jobs_delta)}
                          </span>
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {drill && (
        <div
          className="ops-drill-backdrop"
          role="presentation"
          onClick={() => setDrill(null)}
        >
          <div
            className="card ops-drill"
            role="dialog"
            aria-label={`${drill.name} jobs`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ops-drill-head">
              <h2>{drill.name}</h2>
              <button
                type="button"
                className="btn secondary"
                onClick={() => setDrill(null)}
              >
                Close
              </button>
            </div>
            <p className="muted">{data?.period_label}</p>
            {drill.loading ? (
              <p className="muted">Loading jobs…</p>
            ) : drill.error && !drill.jobs.length ? (
              <p className="muted">{drill.error}</p>
            ) : !drill.jobs.length ? (
              <p className="muted">No completed jobs in this period.</p>
            ) : (
              <ul className="ops-drill-list">
                {drill.jobs.map((j) => (
                  <li key={j.st_job_id} className="ops-drill-item">
                    <strong>
                      {j.job_number ? `#${j.job_number}` : `Job ${j.st_job_id}`}
                    </strong>
                    <span>{j.customer_name || "Customer"}</span>
                    {j.address ? <span className="muted">{j.address}</span> : null}
                    <span className="ops-drill-meta">
                      {j.job_type ? `${j.job_type} · ` : ""}
                      {j.total != null ? money(j.total) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
