import { useEffect, useState } from "react";
import { api } from "../api";

type ZeroChargeRow = {
  user_id: number;
  display_name: string;
  st_technician_id: number | null;
  this_month: number | null;
  last_month: number | null;
  delta: number | null;
  status: "ok" | "unavailable";
};

type ZeroChargePayload = {
  view: "self" | "roster";
  month_label: string;
  last_month_label: string;
  timezone: string;
  job_types_used: string[];
  job_types_missing: string[];
  self: ZeroChargeRow | null;
  roster: ZeroChargeRow[];
  error?: string;
};

function deltaLabel(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  if (delta === 0) return "even";
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

function SelfBody({ row }: { row: ZeroChargeRow | null }) {
  if (!row) return <p className="muted zero-charge-meta">No data</p>;
  if (row.status === "unavailable") {
    return <p className="muted zero-charge-meta">Unavailable</p>;
  }
  return (
    <>
      <div className="zero-charge-stat">
        <span className="zero-charge-stat-label">This month</span>
        <span className="zero-charge-stat-value">{row.this_month ?? 0}</span>
      </div>
      <div className="zero-charge-vs">
        vs last month: <strong>{deltaLabel(row.delta)}</strong>
      </div>
    </>
  );
}

/**
 * Compact Zero-charge card. Tech sees self only; managers see roster.
 */
export function ZeroChargeCard() {
  const [data, setData] = useState<ZeroChargePayload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<ZeroChargePayload>("/zero-charge")
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(d.error || "");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load Zero-charge");
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && !data) {
    return (
      <section className="card zero-charge-card" aria-label="Zero-charge">
        <h2 className="zero-charge-title">Zero-charge</h2>
        <p className="muted zero-charge-meta">Loading…</p>
      </section>
    );
  }

  if (error && !data?.self && !(data?.roster?.length)) {
    return (
      <section className="card zero-charge-card" aria-label="Zero-charge">
        <h2 className="zero-charge-title">Zero-charge</h2>
        <p className="muted zero-charge-meta">{error}</p>
      </section>
    );
  }

  const isRoster = data?.view === "roster";

  return (
    <section className="card zero-charge-card" aria-label="Zero-charge">
      <div className="zero-charge-head">
        <h2 className="zero-charge-title">Zero-charge</h2>
        {data?.month_label ? (
          <span className="muted zero-charge-month">{data.month_label}</span>
        ) : null}
      </div>

      {!isRoster ? (
        <SelfBody row={data?.self || null} />
      ) : (
        <>
          {data?.self && data.self.status === "ok" ? (
            <div className="zero-charge-self-inline">
              <SelfBody row={data.self} />
            </div>
          ) : null}
          <ul className="zero-charge-roster">
            {(data?.roster || []).map((r) => (
              <li key={r.user_id} className="zero-charge-roster-row">
                <span className="zero-charge-roster-name">{r.display_name}</span>
                {r.status === "unavailable" ? (
                  <span className="muted">Unavailable</span>
                ) : (
                  <span className="zero-charge-roster-nums">
                    <strong>{r.this_month ?? 0}</strong>
                    <span className="muted"> · {deltaLabel(r.delta)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {!(data?.roster || []).length ? (
            <p className="muted zero-charge-meta">No technicians linked yet</p>
          ) : null}
        </>
      )}
      {error ? <p className="muted zero-charge-meta">{error}</p> : null}
    </section>
  );
}
