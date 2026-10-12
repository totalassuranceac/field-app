import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import {
  OPS_DEFAULT_PERIOD,
  OPS_PERIODS,
  parseOpsPeriodClient,
  type OpsPeriod,
} from "../opsPeriod";

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
  comeback_jobs?: number | null;
  comeback_rate?: number | null;
  comeback_types?: { job_type: string; count: number }[];
  avg_ticket?: number | null;
  recalls?: RecallOfWork[];
  recalls_more?: number;
};

type RecallOfWork = {
  original_job_id: string;
  original_job_number: string | null;
  original_job_type: string | null;
  recall_job_id: string;
  recall_job_number: string | null;
};

type OpsInstallTeam = {
  key: string;
  label: string;
  members: OpsPersonRow[];
  jobs: number | null;
  jobs_prior: number | null;
  jobs_delta: number | null;
  status: "ok" | "unavailable";
};

type OpsPayload = {
  period: OpsPeriod;
  period_label: string;
  prior_label: string;
  timezone: string;
  view?: "office" | "self";
  service: OpsPersonRow[];
  install: OpsPersonRow[];
  install_teams?: OpsInstallTeam[];
  pulse: {
    jobs: number | null;
    jobs_prior: number | null;
    jobs_delta: number | null;
    jobs_tagged?: number | null;
    jobs_tagged_prior?: number | null;
  };
  sparkline?: { dates: string[]; jobs: number[] };
  self_summary?: {
    user_id: number;
    display_name: string;
    jobs: number | null;
    jobs_prior: number | null;
    jobs_delta: number | null;
    sales: number | null;
    sales_prior: number | null;
    sales_delta: number | null;
    comeback_jobs?: number | null;
    comeback_rate?: number | null;
    comeback_types?: { job_type: string; count: number }[];
    avg_ticket?: number | null;
    recalls?: RecallOfWork[];
    recalls_more?: number;
  } | null;
  recalls_partial?: boolean;
  crew_split?: "st_team" | "rides_with" | "service_only";
  window_start_date?: string;
  window_end_date?: string;
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
  is_comeback?: boolean;
  recall_for_job_id?: string | null;
  recall_for_job_number?: string | null;
};

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


/** HARD LOCK: First + last initial (Abel H / John D). Never bare first — two Johns collide. */
function shortOpsName(full: string): string {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.includes("/")) {
    return t
      .split("/")
      .map((part) => shortOpsName(part.trim()))
      .filter(Boolean)
      .join("/");
  }
  const parts = t.split(/\s+/).filter(Boolean);
  const first = parts[0] || t;
  if (first.toLowerCase() === "chris" && parts.length === 1) return "";
  if (parts.length === 1) return first;
  const last = parts[parts.length - 1];
  return `${first} ${last.charAt(0).toUpperCase()}`;
}

function coachLines(row: {
  status?: "ok" | "unavailable";
  jobs: number | null;
  comeback_jobs?: number | null;
  comeback_rate?: number | null;
  comeback_types?: { job_type: string; count: number }[];
  avg_ticket?: number | null;
  recalls?: RecallOfWork[];
  recalls_more?: number;
}): string[] {
  if (row.status === "unavailable" || row.jobs == null || row.jobs <= 0) return [];
  const lines: string[] = [];
  if (row.comeback_jobs != null) {
    if (row.comeback_jobs === 0) {
      lines.push("No comebacks");
    } else {
      const pct =
        row.comeback_rate != null ? ` (${Math.round(row.comeback_rate * 100)}%)` : "";
      const types = (row.comeback_types || [])
        .map((t) => `${t.count} ${t.job_type}`)
        .join(", ");
      lines.push(
        `Comebacks ${row.comeback_jobs} of ${row.jobs}${pct}${types ? `. ${types}` : ""}`
      );
    }
  }
  if (row.avg_ticket != null) lines.push(`Avg ticket ${money(row.avg_ticket)}`);
  const recalls = row.recalls || [];
  if (recalls.length) {
    const shown = recalls.slice(0, 2).map((r) => {
      const orig = r.original_job_number || r.original_job_id;
      const back = r.recall_job_number || r.recall_job_id;
      return `#${orig} came back as #${back}`;
    });
    const extra = (row.recalls_more || 0) + Math.max(0, recalls.length - 2);
    lines.push(
      `Earlier work called back: ${shown.join("; ")}${extra > 0 ? `, and ${extra} more` : ""}`
    );
  }
  return lines;
}

function CoachLine({
  row,
}: {
  row: {
    status?: "ok" | "unavailable";
    jobs: number | null;
    comeback_jobs?: number | null;
    comeback_rate?: number | null;
    comeback_types?: { job_type: string; count: number }[];
    avg_ticket?: number | null;
    recalls?: RecallOfWork[];
    recalls_more?: number;
  };
}) {
  const lines = coachLines(row);
  if (!lines.length) return null;
  return (
    <div className="ops-coach muted">
      {lines.map((line, i) => (
        <span key={i} className="ops-coach-line">
          {line}
        </span>
      ))}
    </div>
  );
}

function deltaClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "ops-delta is-flat";
  return n > 0 ? "ops-delta is-up" : "ops-delta is-down";
}

/** Thin SVG jobs/day sparkline — lookback length = selected 7/30/90. */
function JobsSparkline({
  jobs,
  label,
}: {
  jobs: number[];
  label?: string;
}) {
  const w = 220;
  const h = 36;
  const pad = 2;
  if (!jobs.length) {
    return <span className="muted ops-spark-empty">No daily data</span>;
  }
  const max = Math.max(1, ...jobs);
  const n = jobs.length;
  const pts = jobs.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / Math.max(1, n - 1);
    const y = h - pad - (v / max) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const poly = pts.join(" ");
  const area = `${pad},${h - pad} ${poly} ${w - pad},${h - pad}`;
  return (
    <div className="ops-spark" title={label || "Jobs per day"}>
      <svg
        className="ops-spark-svg"
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        role="img"
        aria-label={label || "Jobs per day sparkline"}
      >
        <polygon className="ops-spark-area" points={area} />
        <polyline
          className="ops-spark-line"
          fill="none"
          strokeWidth="1.75"
          points={poly}
        />
      </svg>
    </div>
  );
}


export function OpsPerformancePage() {
  const { user } = useAuth();
  const allowed = can(user, "viewOpsPerformance");
  const [searchParams, setSearchParams] = useSearchParams();
  const [period, setPeriod] = useState<OpsPeriod>(() =>
    parseOpsPeriodClient(searchParams.get("period") || OPS_DEFAULT_PERIOD)
  );
  const [data, setData] = useState<OpsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [drill, setDrill] = useState<{
    userId: number;
    name: string;
    jobs: JobLine[];
    loading: boolean;
    error: string;
    summary?: OpsPersonRow | null;
  } | null>(null);

  function choosePeriod(next: OpsPeriod) {
    setPeriod(next);
    setSearchParams({ period: next }, { replace: true });
  }

  const load = useCallback(async () => {
    if (!allowed) return;
    setLoading(true);
    setError("");
    try {
      // Fast first paint: jobs / pulse / teams without per-job invoice totals
      const fast = await api<OpsPayload>(
        `/ops-performance?period=${encodeURIComponent(period)}&sales=0`,
        { timeoutMs: 60_000 }
      );
      setData(fast);
      setLoading(false);
      if (fast.error && !(fast.service?.length || fast.install?.length)) {
        setError(fast.error);
        return;
      }
      // Enrich sales in background (server reuses short job-pool cache)
      try {
        const full = await api<OpsPayload>(
          `/ops-performance?period=${encodeURIComponent(period)}`,
          { timeoutMs: 90_000 }
        );
        if (!full.error || full.service?.length || full.install?.length) {
          setData(full);
        }
      } catch {
        /* keep jobs-only board */
      }
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : "Could not load performance");
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
      summary: row,
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
        summary: row,
      });
    } catch (e) {
      setDrill({
        userId: row.user_id,
        name: row.display_name,
        jobs: [],
        loading: false,
        error: e instanceof Error ? e.message : "Could not load jobs",
        summary: row,
      });
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Shop scoreboard</h1>
        </header>
        <div className="empty-state">
          <p>Sign in with a Field App account that can open Ops performance.</p>
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
          <h1>{data?.view === "self" ? "My numbers" : "Shop scoreboard"}</h1>
          <p className="muted">
            {data?.view === "self"
              ? "Your jobs, comeback rate, and average ticket."
              : "Jobs, sales, comeback rate, and recalls of earlier work."}
            {data?.period_label ? ` ${data.period_label}` : ""}
          </p>
        </div>
        <div className="no-print" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {can(user, "viewJobLengths") ? (
            <Link to="/ops/job-lengths" className="btn secondary">
              Job lengths
            </Link>
          ) : null}
          <button
            type="button"
            className="btn secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Loading…" : "Reload"}
          </button>
        </div>
      </header>

      <div className="ops-period-toggles" role="tablist" aria-label="Look back">
        {OPS_PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={period === p.id}
            className={`ops-period-btn${period === p.id ? " is-active" : ""}`}
            onClick={() => choosePeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {data?.prior_label ? (
        <p className="muted ops-vs-prior">Vs prior: {data.prior_label}</p>
      ) : null}

      {(data?.sparkline?.jobs?.length || data?.self_summary) && (
        <section
          className="card ops-spark-card"
          aria-label={data?.view === "self" ? "Your pace" : "Shop pace"}
        >
          <div className="ops-spark-head">
            <h2 className="ops-section-title">
              {data?.view === "self" ? "Your pace" : "Shop pace"}
            </h2>
            {data?.self_summary ? (
              <div className="ops-self-delta">
                <span className="ops-self-jobs">
                  {data.self_summary.jobs ?? "—"}{" "}
                  <span className="muted">jobs</span>
                </span>
                <span className={deltaClass(data.self_summary.jobs_delta)}>
                  vs prior {signed(data.self_summary.jobs_delta)}
                </span>
                {data.self_summary.sales != null ? (
                  <span className="ops-self-sales muted">
                    {money(data.self_summary.sales)}{" "}
                    <span className={deltaClass(data.self_summary.sales_delta)}>
                      {signed(data.self_summary.sales_delta, true)}
                    </span>
                  </span>
                ) : null}
                <CoachLine row={{ ...data.self_summary, status: "ok" }} />
              </div>
            ) : data?.pulse ? (
              <div className="ops-self-delta">
                <span className="ops-self-jobs">
                  {data.pulse.jobs ?? "—"}{" "}
                  <span className="muted">jobs</span>
                </span>
                <span className={deltaClass(data.pulse.jobs_delta)}>
                  vs prior {signed(data.pulse.jobs_delta)}
                </span>
              </div>
            ) : null}
          </div>
          {data?.sparkline?.jobs?.length ? (
            <JobsSparkline
              jobs={data.sparkline.jobs}
              label={
                data.view === "self"
                  ? "Your jobs per day"
                  : "Shop jobs per day"
              }
            />
          ) : null}
          <p className="muted ops-spark-caption">
            Jobs/day · {data?.period_label || "lookback"}
            {data?.prior_label ? ` · vs ${data.prior_label}` : ""}
          </p>
        </section>
      )}


      {error && (
        <div className="error" style={{ marginBottom: "0.85rem" }}>
          {error}
        </div>
      )}

      {data?.message && !error ? (
        <p className="muted ops-hint">{data.message}</p>
      ) : null}

      {data?.view === "self" ? (
        <p className="muted ops-self-banner">
          Your numbers + HARD LOCK crew partner - rest of shop hidden. Supervisors see the full board.
        </p>
      ) : null}

      <p className="muted ops-shared-note">
        Shared job counts for each tech. Shop total is not the sum of rows.
        Comebacks are Follow-up Visit and Warranty Service jobs the tech worked.
        A recall lists everyone who was on the original job.
      </p>
      {data?.recalls_partial ? (
        <p className="muted ops-shared-note">
          Some recalled jobs from before this window were not opened.
        </p>
      ) : null}

      {data?.pulse && (
        <section className="card ops-pulse" aria-label="Shop pulse">
          <h2 className="ops-section-title">Shop pulse</h2>
          <div className="ops-pulse-row">
            <span className="ops-pulse-label">Completed</span>
            <span className="ops-pulse-value">{data.pulse.jobs ?? "—"}</span>
            <span className="ops-pulse-tagged muted">
              · {data.pulse.jobs_tagged ?? "—"} tagged to a tech
            </span>
            <span className={deltaClass(data.pulse.jobs_delta)}>
              vs prior {signed(data.pulse.jobs_delta)}
            </span>
          </div>
          <p className="muted ops-pulse-explain">
            {(data.pulse.jobs ?? 0) > 0
              ? `${data.pulse.jobs} completed · ${data.pulse.jobs_tagged ?? 0} tagged to a tech. A “—” row means ST didn’t stamp a name.`
              : "No completed jobs in this Chicago window yet — that is a quiet week, not a load failure."}
          </p>
        </section>
      )}

      <section className="card ops-block" aria-label="Service">
        <h2 className="ops-section-title">SERVICE</h2>
        <p className="muted ops-block-hint">
          Top movers first · Jobs, then Sales · tap a name for jobs
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
                  <th scope="col" className="ops-rank-col">
                    #
                  </th>
                  <th scope="col">Name</th>
                  <th scope="col">Jobs</th>
                  <th scope="col">Sales</th>
                  <th scope="col" title="Warranty / follow-up jobs">
                    Warranty / follow-ups
                  </th>
                  <th scope="col">Vs prior</th>
                </tr>
              </thead>
              <tbody>
                {(data?.service || []).map((r, idx) => {
                    const isZero =
                      r.status === "unavailable" ||
                      ((r.jobs == null || r.jobs === 0) &&
                        (r.sales == null || r.sales === 0));
                    return (
                  <tr
                    key={r.user_id}
                    className={isZero ? "ops-row-zero" : undefined}
                  >
                    <td className="ops-rank muted ops-rank-col">{idx + 1}</td>
                    <td>
                      <button
                        type="button"
                        className="ops-name-btn"
                        onClick={() => void openPerson(r)}
                      >
                        {shortOpsName(r.display_name) || r.display_name}
                      </button>
                      <CoachLine row={r} />
                      {r.status === "unavailable" ? (
                        <div className="ops-unlink-cta">
                          <Link to="/admin">Link this login to ST</Link>
                        </div>
                      ) : null}
                    </td>
                    {r.status === "unavailable" ? (
                      <>
                        <td className="muted">—</td>
                        <td className="muted">—</td>
                        <td className="muted">—</td>
                        <td className="muted">—</td>
                      </>
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
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data?.crew_split === "service_only" ? null : (
      <section className="card ops-block" aria-label="Install">
        <h2 className="ops-section-title">INSTALL</h2>
        <p className="muted ops-block-hint">
          Teams ranked by combined jobs · Chris HARD LOCK pairs (lead first)
          {data?.view === "self"
            ? " · your crew only"
            : data?.crew_split === "rides_with"
              ? " · locked crews + FA ride pairs"
              : " · locked crews + ST team"}
        </p>
        {!(data?.install_teams || []).length && !(data?.install || []).length ? (
          <p className="muted">No install jobs tagged in this period (crew list still real).</p>
        ) : (
          <div className="ops-table-wrap">
            <table className="ops-table ops-install-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">Team</th>
                  <th scope="col">Jobs</th>
                  <th scope="col">Vs prior</th>
                </tr>
              </thead>
              <tbody>
                {(data?.install_teams?.length
                  ? data.install_teams
                  : (data?.install || []).map((r) => ({
                      key: `solo-${r.user_id}`,
                      label: r.display_name,
                      members: [r],
                      jobs: r.jobs,
                      jobs_prior: r.jobs_prior,
                      jobs_delta: r.jobs_delta,
                      status: r.status,
                    }))
                ).map((team, idx) => (
                  <tr key={team.key}>
                    <td className="ops-rank muted">{idx + 1}</td>
                    <td>
                      <div className="ops-team-names">
                        {team.members.map((m) => (
                          <div key={m.user_id} className="ops-member">
                            <button
                              type="button"
                              className="ops-name-btn"
                              onClick={() => void openPerson(m)}
                            >
                              {shortOpsName(m.display_name) || m.display_name}
                              {m.jobs != null ? (
                                <span className="ops-member-jobs muted">
                                  {" "}
                                  ({m.jobs})
                                </span>
                              ) : m.status === "unavailable" ? (
                                <span className="ops-member-jobs muted"> (—)</span>
                              ) : null}
                            </button>
                            <CoachLine row={m} />
                          </div>
                        ))}
                      </div>
                      {team.members.length > 1 ? (
                        <div className="ops-team-label muted">{team.label}</div>
                      ) : null}
                    </td>
                    {team.status === "unavailable" ? (
                      <>
                        <td className="muted">—</td>
                        <td className="muted">—</td>
                      </>
                    ) : (
                      <>
                        <td>{team.jobs ?? "—"}</td>
                        <td>
                          <span className={deltaClass(team.jobs_delta)}>
                            {signed(team.jobs_delta)}
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
      )}

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
            {drill.summary ? (
              <div className="ops-tech-big" aria-label="Tech totals">
                <div className="ops-tech-big-item">
                  <span className="ops-tech-big-value">
                    {drill.summary.status === "unavailable"
                      ? "—"
                      : drill.summary.jobs ?? "—"}
                  </span>
                  <span className="ops-tech-big-label">Jobs</span>
                </div>
                <div className="ops-tech-big-item">
                  <span className="ops-tech-big-value">
                    {drill.summary.status === "unavailable"
                      ? "—"
                      : money(drill.summary.sales)}
                  </span>
                  <span className="ops-tech-big-label">Sales</span>
                </div>
                <div className="ops-tech-big-item">
                  <span className="ops-tech-big-value">
                    {drill.summary.status === "unavailable"
                      ? "—"
                      : drill.summary.zero_charge ?? "—"}
                  </span>
                  <span className="ops-tech-big-label">Warranty / follow-ups</span>
                </div>
              </div>
            ) : null}
            {drill.summary?.status === "unavailable" ? (
              <p className="ops-unlink-cta">
                <Link to="/admin">Link this login to ST</Link>
              </p>
            ) : null}
            {(drill.summary?.recalls || []).length ? (
              <div className="ops-coach">
                <strong>Earlier work called back</strong>
                <ul className="ops-recall-list">
                  {(drill.summary?.recalls || []).map((r) => (
                    <li key={`${r.original_job_id}-${r.recall_job_id}`}>
                      #{r.original_job_number || r.original_job_id}
                      {r.original_job_type ? ` (${r.original_job_type})` : ""} came back as #
                      {r.recall_job_number || r.recall_job_id}
                    </li>
                  ))}
                </ul>
                {drill.summary?.recalls_more ? (
                  <p className="muted">{drill.summary.recalls_more} more not listed.</p>
                ) : null}
              </div>
            ) : null}
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
                      {j.is_comeback ? <span className="ops-coach-tag">Comeback</span> : null}
                      {j.job_type ? `${j.job_type} · ` : ""}
                      {j.total != null ? money(j.total) : "—"}
                      {j.recall_for_job_id
                        ? ` · Recalls #${j.recall_for_job_number || j.recall_for_job_id}`
                        : ""}
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
