import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import {
  JOB_DURATIONS_JOB_COUNT,
  JOB_DURATIONS_SOURCE,
  JOB_DURATION_ROWS,
  bookSlotCell,
  longDayCell,
  normalizeJobTypeName,
  usualCell,
  type JobDurationRow,
} from "../jobDurations";
import { formatJobLengthMinutes } from "../jobLengthFormat";
import { printWithLightTheme } from "../printTheme";

type JobLengthRow = {
  job_type_name: string;
  median_minutes: number | null;
};

const CLASS_ORDER = ["Service", "Install", "Other"];

function classRank(cls: string): number {
  const i = CLASS_ORDER.indexOf(cls);
  return i === -1 ? CLASS_ORDER.length : i;
}

function techCell(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : "-";
}

function driveCell(mins: number): string {
  if (!Number.isFinite(mins)) return "-";
  return formatJobLengthMinutes(mins);
}

export function JobLengthsPage() {
  const { user } = useAuth();
  const allowed = can(user, "viewJobLengths");
  const [bookedByType, setBookedByType] = useState<Record<string, number> | null>(null);
  const [bookedNote, setBookedNote] = useState("");

  const groups = useMemo(() => {
    const list = [...JOB_DURATION_ROWS].sort((a, b) => {
      const c = classRank(a.cls) - classRank(b.cls);
      if (c) return c;
      if (b.jobs !== a.jobs) return b.jobs - a.jobs;
      return a.job_type.localeCompare(b.job_type);
    });
    const out: { cls: string; rows: JobDurationRow[] }[] = [];
    for (const row of list) {
      const last = out[out.length - 1];
      if (!last || last.cls !== row.cls) out.push({ cls: row.cls, rows: [row] });
      else last.rows.push(row);
    }
    return out;
  }, []);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setBookedNote("Booked windows are still loading.");
    void api<{ rows?: JobLengthRow[] }>("/job-lengths?days=90", { timeoutMs: 60_000 })
      .then((res) => {
        if (cancelled) return;
        const next: Record<string, number> = {};
        for (const row of res.rows || []) {
          if (row.median_minutes == null || !row.job_type_name) continue;
          next[normalizeJobTypeName(row.job_type_name)] = row.median_minutes;
        }
        setBookedByType(next);
        setBookedNote("");
      })
      .catch(() => {
        if (cancelled) return;
        setBookedByType({});
        setBookedNote("Booked windows could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  function bookedCell(name: string): string {
    if (!bookedByType) return "-";
    const mins = bookedByType[normalizeJobTypeName(name)];
    if (mins == null) return "-";
    return formatJobLengthMinutes(mins);
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Job lengths</h1>
        </header>
        <div className="empty-state">
          <p>You are not allowed to view job lengths.</p>
          <Link to="/" className="btn secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const jobCount = JOB_DURATIONS_JOB_COUNT.toLocaleString("en-US");

  return (
    <div className="page job-lengths-page">
      <header className="page-header">
        <div>
          <h1>Job lengths</h1>
          <p className="muted" title={JOB_DURATIONS_SOURCE}>
            Real time on site from ServiceTitan timesheets, jobs finished Jul 1 - Oct 2, 2026 ({jobCount} jobs).
            First tech in to last tech out. Book this slot = long day plus average drive, rounded up to the next half hour.
          </p>
          <p className="muted">Long day = 3 out of 4 jobs finish within this time.</p>
          {bookedNote ? <p className="muted no-print">{bookedNote}</p> : null}
        </div>
        <button
          type="button"
          className="btn secondary no-print"
          onClick={() => void printWithLightTheme("print-job-lengths")}
        >
          Print
        </button>
      </header>

      <div className="job-lengths-wrap">
        <table className="job-lengths-table">
          <thead>
            <tr>
              <th>Job type</th>
              <th>Class</th>
              <th>Jobs</th>
              <th>Usually</th>
              <th>Long day</th>
              <th>Book this slot</th>
              <th>Techs</th>
              <th>Drive</th>
              <th>Booked in ST</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.cls}>
                <tr className="is-group">
                  <td colSpan={9}>{group.cls}</td>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.job_type} className={row.low_sample ? "is-low-sample" : undefined}>
                    <td>{row.job_type}</td>
                    <td>{row.cls}</td>
                    <td>{row.jobs}</td>
                    <td>{usualCell(row)}</td>
                    <td>{longDayCell(row)}</td>
                    <td>{bookSlotCell(row)}</td>
                    <td>{techCell(row.techs_mean)}</td>
                    <td>{driveCell(row.drive_minutes_mean)}</td>
                    <td>{bookedCell(row.job_type)}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
