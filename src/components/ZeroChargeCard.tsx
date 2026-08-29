import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type ZeroChargeRow = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  this_month: number | null;
  last_month: number | null;
  delta: number | null;
  jobs_this_month?: number | null;
  jobs_last_month?: number | null;
  jobs_delta?: number | null;
  this_month_sales?: number | null;
  last_month_sales?: number | null;
  sales_delta?: number | null;
  rank?: number | null;
  status: "ok" | "unavailable";
};

type ZeroChargePayload = {
  view: "self" | "roster" | "none";
  month_label: string;
  last_month_label: string;
  timezone: string;
  job_types_used: string[];
  job_types_missing: string[];
  self: ZeroChargeRow | null;
  roster: ZeroChargeRow[];
  roster_sorted_by?: "sales" | "name";
  sales_pending?: boolean;
  error?: string;
};

const LOAD_FAIL = "Could not load this month. Try again.";

/** Keep in sync with worker/zeroCharge.ts ZERO_CHARGE_TECH_NAMES */
const ZERO_CHARGE_TECH_NAMES = [
  "Robert Gonzalez",
  "Wayne McCaskill",
  "Abel Herrera",
  "Omar Camacho",
  "Adam Bosquez",
  "Kyle Duffield",
];

const MANAGER_NAME_HINTS = [
  "chris marroquin",
  "kelsie",
  "bianca",
  "eric",
  "chris miller",
];

function normName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[.,'"_/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clientMaySeeZeroCharge(role: string | undefined, displayName: string | undefined): boolean {
  if (role === "admin" || role === "office" || role === "supervisor") return true;
  const n = normName(displayName || "");
  if (!n) return false;
  if (ZERO_CHARGE_TECH_NAMES.some((name) => normName(name) === n)) return true;
  return MANAGER_NAME_HINTS.some((hint) => {
    if (n === hint) return true;
    if (!hint.includes(" ") && n.split(" ")[0] === hint) return true;
    if (hint.includes(" ") && (n === hint || n.startsWith(hint + " ") || n.endsWith(" " + hint))) {
      return true;
    }
    return false;
  });
}

function deltaLabel(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  if (delta === 0) return "even";
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function money(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function moneyDelta(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  if (delta === 0) return "even";
  const abs = money(Math.abs(delta));
  return delta > 0 ? `+${abs}` : `-${abs}`;
}

function userFacingError(err: unknown, apiError?: string | null): string {
  if (apiError) return LOAD_FAIL;
  const msg = err instanceof Error ? err.message : String(err || "");
  if (/took too long|timeout|timed out|abort/i.test(msg)) {
    return LOAD_FAIL;
  }
  return LOAD_FAIL;
}

/** Tech home: jobs / sales / zero-charge with signed deltas. No rank, no other names. */
function SelfBody({ row }: { row: ZeroChargeRow | null }) {
  if (!row) return <p className="muted zero-charge-meta">No data</p>;
  if (row.status === "unavailable") {
    return <p className="muted zero-charge-meta">Unavailable</p>;
  }
  return (
    <div className="zero-charge-self-grid">
      <div className="zero-charge-stat">
        <span className="zero-charge-stat-label">Jobs this month</span>
        <span className="zero-charge-stat-value">{row.jobs_this_month ?? 0}</span>
        <span className="zero-charge-vs">vs last month: {deltaLabel(row.jobs_delta)}</span>
      </div>
      <div className="zero-charge-stat">
        <span className="zero-charge-stat-label">Sales this month</span>
        <span className="zero-charge-stat-value zero-charge-stat-money">
          {row.this_month_sales == null ? "…" : money(row.this_month_sales)}
        </span>
        <span className="zero-charge-vs">
          vs last month: {row.sales_delta == null ? "…" : moneyDelta(row.sales_delta)}
        </span>
      </div>
      <div className="zero-charge-stat">
        <span className="zero-charge-stat-label">Zero-charge this month</span>
        <span className="zero-charge-stat-value">
          {row.this_month == null ? "—" : row.this_month}
        </span>
        <span className="zero-charge-vs">
          {row.this_month == null ? "" : `vs last month: ${deltaLabel(row.delta)}`}
        </span>
      </div>
    </div>
  );
}

/**
 * Six techs → own month board. Managers → six-person roster ranked by sales.
 * Everyone else → hidden. No diagnose / debug on the card.
 */
export function ZeroChargeCard() {
  const { user } = useAuth();
  const eligible = clientMaySeeZeroCharge(user?.role, user?.display_name || undefined);
  const [data, setData] = useState<ZeroChargePayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(eligible);

  useEffect(() => {
    if (!eligible) {
      setLoading(false);
      setData({ view: "none" } as ZeroChargePayload);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api<ZeroChargePayload>("/zero-charge", { timeoutMs: 45_000 })
      .then(async (d) => {
        if (cancelled) return;
        setData(d);
        const hasRows = !!(d.self || (d.roster && d.roster.length));
        setError(hasRows ? "" : d.error ? LOAD_FAIL : "");
        setLoading(false);
        if (d.view === "none" || d.sales_pending === false) return;
        try {
          const withSales = await api<ZeroChargePayload>("/zero-charge?sales=1", {
            timeoutMs: 45_000,
          });
          if (cancelled) return;
          setData(withSales);
          const salesRows = !!(withSales.self || (withSales.roster && withSales.roster.length));
          if (!salesRows && withSales.error) setError(LOAD_FAIL);
        } catch {
          if (cancelled) return;
          // Keep core numbers; do not dump ST/diagnose text
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setError(userFacingError(e));
        setData(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eligible]);

  if (!eligible || data?.view === "none") {
    return null;
  }

  if (loading && !data) {
    return (
      <section className="card zero-charge-card" aria-label="Zero-charge">
        <h2 className="zero-charge-title">Zero-charge</h2>
        <p className="muted zero-charge-meta">Loading…</p>
      </section>
    );
  }

  const isRoster = data?.view === "roster";
  const hasRows = !!(data?.self || (data?.roster && data.roster.length));

  if (error && !hasRows) {
    return (
      <section className="card zero-charge-card" aria-label="Zero-charge">
        <h2 className="zero-charge-title">{isRoster ? "Service techs" : "My month"}</h2>
        {data?.month_label ? (
          <span className="muted zero-charge-month">{data.month_label}</span>
        ) : null}
        <p className="muted zero-charge-meta">{LOAD_FAIL}</p>
      </section>
    );
  }

  return (
    <section className="card zero-charge-card" aria-label="Zero-charge">
      <div className="zero-charge-head">
        <h2 className="zero-charge-title">{isRoster ? "Service techs" : "My month"}</h2>
        {data?.month_label ? (
          <span className="muted zero-charge-month">{data.month_label}</span>
        ) : null}
      </div>

      {!isRoster ? (
        <SelfBody row={data?.self || null} />
      ) : (
        <ul className="zero-charge-roster">
          {(data?.roster || []).map((r) => (
            <li key={r.user_id} className="zero-charge-roster-row">
              <span className="zero-charge-roster-name">
                {r.status === "ok" && r.rank != null ? (
                  <span className="zero-charge-rank">#{r.rank}</span>
                ) : null}{" "}
                {r.display_name}
              </span>
              {r.status === "unavailable" ? (
                <span className="muted">Unavailable</span>
              ) : (
                <span className="zero-charge-roster-nums">
                  <span title="Jobs completed">{r.jobs_this_month ?? 0} jobs</span>
                  <span className="muted"> · </span>
                  <span title="Sales this month">
                    {r.this_month_sales == null ? "…" : money(r.this_month_sales)}
                  </span>
                  <span className="muted"> · </span>
                  <span title="Zero-charge">
                    {r.this_month == null ? "—" : `${r.this_month} zc`}
                  </span>
                  <span className="muted"> · </span>
                  <span title="Sales vs last month">
                    {r.sales_delta == null ? "…" : moneyDelta(r.sales_delta)}
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
