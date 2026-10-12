import { useEffect, useState } from "react";
import { api } from "../api";

type OpenNudge = {
  employee_id: number;
  name: string;
  job: string;
  appt_id: string;
  minutes_late: number | null;
  office_alerted: boolean;
  nudge_type?: "late" | "left_on_job";
};

type OpenResponse = {
  mode: "off" | "dry" | "live";
  day: string;
  items: OpenNudge[];
};

export function ClockinNudgeCard() {
  const [data, setData] = useState<OpenResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const res = await api<OpenResponse>("/clockin-nudges/today");
        if (!stop) {
          setData(res);
          setError("");
        }
      } catch {
        if (!stop) setError("Could not load clock-in nudges.");
      }
    }
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, []);

  const mode = data?.mode || "off";
  const items = data?.items || [];
  const hint =
    mode === "dry"
      ? "Dry run. Texts are logged, not sent."
      : mode === "live"
        ? "Watch is on."
        : "Watch is off.";

  return (
    <section
      className="home-section"
      aria-label="Not clocked in"
      style={{
        background: "var(--card)",
        color: "var(--ink)",
        border: "1px solid var(--line)",
        borderRadius: 12,
        padding: "0.85rem 1rem",
        marginBottom: "0.85rem",
      }}
    >
      <h2 style={{ margin: "0 0 0.25rem", fontSize: "1.05rem" }}>Not clocked in</h2>
      {!data && !error ? (
        <p className="muted" style={{ margin: 0 }}>
          Checking...
        </p>
      ) : null}
      {data ? (
        <p className="muted" style={{ margin: 0 }}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="muted" style={{ margin: "0.45rem 0 0" }}>
          {error}
        </p>
      ) : null}
      {!error && data && items.length === 0 ? (
        <p style={{ margin: "0.45rem 0 0" }}>None right now.</p>
      ) : null}
      {items.length > 0 ? (
        <ul style={{ margin: "0.45rem 0 0", paddingLeft: "1.15rem" }}>
          {items.slice(0, 20).map((row) => (
            <li key={`${row.employee_id}-${row.appt_id}-${row.nudge_type || "late"}`} style={{ margin: "0.2rem 0" }}>
              <strong>{row.name}</strong>
              {" - "}
              {row.job}
              {row.nudge_type === "left_on_job"
                ? " - left on job"
                : row.minutes_late != null
                  ? ` - ${row.minutes_late} min late`
                  : ""}
            </li>
          ))}
        </ul>
      ) : null}
      {items.length > 20 ? (
        <p className="muted" style={{ margin: "0.35rem 0 0" }}>
          {items.length - 20} more
        </p>
      ) : null}
    </section>
  );
}
