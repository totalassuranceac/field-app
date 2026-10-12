import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { can } from "../api";
import { isAzaliMiller } from "../lib/azaliRnc";
import { useAuth } from "../auth";
import { MillerInstallQuickAdd } from "../components/MillerInstallQuickAdd";
import "../day-board.css";

function todayIso(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function shiftIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return utc.toISOString().slice(0, 10);
}

/** Office page: Miller Install book (moved off Day Board). Day Board stays view-only. */
export function InstallBookPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const preferNc = params.get("nc") === "final" ? "final" : params.get("nc") === "rough" ? "rough" : undefined;
  const initialAddress = params.get("street") || "";
  const officeOk =
    can(user, "viewOpsPerformance") ||
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "supervisor" ||
    isAzaliMiller(user);
  const [date, setDate] = useState(todayIso);

  const dateLabel = useMemo(() => {
    try {
      const d = new Date(`${date}T12:00:00`);
      if (!Number.isFinite(d.getTime())) return date;
      return d.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "America/Chicago",
      });
    } catch {
      return date;
    }
  }, [date]);

  if (!officeOk) {
    return (
      <div className="page">
        <header className="page-header">
          <div>
            <h1>Book install</h1>
            <p className="muted">Miller / Install + NC - office / supervisor only</p>
          </div>
        </header>
        <div className="card">
          <p>You do not have access to book Install / NC jobs here.</p>
          <p className="muted">Day board remains available for viewing scheduled work.</p>
          <Link to="/day-board" className="btn secondary">
            Open Day board
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page day-board-page install-book-page">
      <header className="page-header day-board-page-header">
        <div>
          <h1>Book install</h1>
          <p className="muted">
            Miller / Install + NC / book to ServiceTitan. Day board is view-only.
          </p>
        </div>
        <div className="day-board-header-actions">
          <button
            type="button"
            className="btn secondary"
            onClick={() => setDate(todayIso())}
          >
            Today
          </button>
          <Link to="/day-board" className="btn secondary">
            Day board
          </Link>
          <Link to="/new-construction" className="btn secondary">
            New construction house
          </Link>
        </div>
      </header>

      <div className="day-board-controls">
        <div className="day-board-date-nav" role="group" aria-label="Change day">
          <button
            type="button"
            className="btn secondary day-board-date-step"
            onClick={() => setDate((d) => shiftIso(d, -1))}
            aria-label="Previous day"
          >
            Prev
          </button>
          <div className="day-board-date-face">
            <span className="day-board-date-label">{dateLabel}</span>
            <label className="day-board-date-wrap">
              <span className="sr-only">Pick day</span>
              <input
                type="date"
                className="day-board-date"
                value={date}
                onChange={(e) => setDate(e.target.value || todayIso())}
                aria-label="Pick day"
              />
            </label>
          </div>
          <button
            type="button"
            className="btn secondary day-board-date-step"
            onClick={() => setDate((d) => shiftIso(d, 1))}
            aria-label="Next day"
          >
            Next
          </button>
        </div>
      </div>

      <MillerInstallQuickAdd date={date} preferNc={preferNc} initialAddress={initialAddress} />
    </div>
  );
}
