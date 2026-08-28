import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { MyShortcuts } from "../components/MyShortcuts";


interface SchedIssue {
  id: number;
  unit_number: string;
  title: string;
  status: string;
  scheduled_date: string | null;
  severity: string;
  is_emergency?: number;
  reporter_name?: string;
}

/**
 * Clean office home: live map + what's scheduled for the shop.
 * Hides shop-floor noise (fuel OCR, yard stickers, mileage flags, etc.).
 */
export function OfficeHome() {
  const { user } = useAuth();
  const [issues, setIssues] = useState<SchedIssue[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [warranties, setWarranties] = useState(0);
  const [vendorWaiting, setVendorWaiting] = useState(0);
  const [handbookPending, setHandbookPending] = useState(false);

  function load() {
    setLoading(true);
    setError("");
    Promise.all([
      api<{ issues: SchedIssue[] }>("/issues?report=schedule"),
      api<{ unread: number }>("/notifications").catch(() => ({ unread: 0 })),
      api<{ warranties?: unknown[] }>("/warranties?status=open").catch(() => ({
        warranties: [],
      })),
      api<{ waiting?: number }>("/inventory/vendor-runs/count").catch(() => ({
        waiting: 0,
      })),
      api<{ pending?: boolean }>("/handbook").catch(() => ({ pending: false })),
    ])
      .then(([iss, n, w, vr, h]) => {
        setIssues(iss.issues || []);
        setUnread(n.unread || 0);
        setWarranties((w.warranties || []).length);
        setVendorWaiting(vr.waiting || 0);
        setHandbookPending(!!h.pending);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  const emergencies = issues.filter(
    (i) => i.is_emergency || i.severity === "critical" || i.status === "open"
  );
  const scheduled = issues.filter(
    (i) => i.status === "scheduled" || i.status === "in_progress"
  );
  const first = user?.display_name?.split(" ")[0] || "there";

  return (
    <div className="office-home">
      <header className="office-hero">
        <div>
          <p className="office-kicker">Office</p>
          <h1 className="office-title">Hi, {first}</h1>
          <p className="office-sub">Where the fleet is · what the shop has scheduled</p>
        </div>
      </header>

      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      {handbookPending && (
        <div className="handbook-pending-banner" role="status">
          <span>
            <strong>Employee handbook</strong> — please read and acknowledge.
          </span>
          <Link className="btn" to="/handbook">
            Open handbook
          </Link>
        </div>
      )}

      <MyShortcuts />

      <div className="office-actions">
        <Link to="/live" className="office-action primary">
          <span className="office-action-icon" aria-hidden>
            🗺
          </span>
          <span>
            <strong>Live map</strong>
            <span className="office-action-hint">See every unit on the road</span>
          </span>
        </Link>
        <Link to="/tv" className="office-action">
          <span className="office-action-icon" aria-hidden>
            📺
          </span>
          <span>
            <strong>TV board</strong>
            <span className="office-action-hint">Full-screen for the office TV</span>
          </span>
        </Link>
        <Link to="/issues" className="office-action">
          <span className="office-action-icon" aria-hidden>
            🔧
          </span>
          <span>
            <strong>Shop board</strong>
            <span className="office-action-hint">
              {scheduled.length
                ? `${scheduled.length} scheduled or in progress`
                : "Nothing scheduled right now"}
            </span>
          </span>
        </Link>
        <Link to="/warranties" className="office-action">
          <span className="office-action-icon" aria-hidden>
            📦
          </span>
          <span>
            <strong>Open warranties</strong>
            <span className="office-action-hint">
              {warranties ? `${warranties} open` : "None waiting"}
            </span>
          </span>
        </Link>
        <Link to="/inventory" className="office-action">
          <span className="office-action-icon" aria-hidden>
            📊
          </span>
          <span>
            <strong>Inventory</strong>
            <span className="office-action-hint">View stock &amp; trucks</span>
          </span>
        </Link>
        <Link to="/part-pickup" className="office-action">
          <span className="office-action-icon" aria-hidden>
            🏪
          </span>
          <span>
            <strong>Part pickup request</strong>
            <span className="office-action-hint">
              {vendorWaiting
                ? `${vendorWaiting} waiting for warehouse pickup`
                : "Parts ready at a store — request pickup"}
            </span>
          </span>
        </Link>
        {unread > 0 && (
          <Link to="/notifications" className="office-action alert">
            <span className="office-action-icon" aria-hidden>
              🔔
            </span>
            <span>
              <strong>Notifications</strong>
              <span className="office-action-hint">
                {unread} unread — check for driver emergencies
              </span>
            </span>
          </Link>
        )}
      </div>

      <section className="office-section">
        <div className="office-section-head">
          <h2>On the shop board</h2>
          <Link to="/issues" className="home-mini-link">
            All →
          </Link>
        </div>

        {loading && !issues.length ? (
          <p className="muted">Loading…</p>
        ) : !issues.length ? (
          <div className="office-empty card">
            <p>
              <strong>No open or scheduled repairs.</strong>
            </p>
            <p className="muted" style={{ margin: 0 }}>
              When a tech reports an issue or the shop schedules work, it shows up here.
            </p>
          </div>
        ) : (
          <ul className="office-repair-list">
            {issues.slice(0, 12).map((i) => (
              <li key={i.id}>
                <Link to="/issues" className="office-repair-card">
                  <div className="office-repair-top">
                    <strong className="office-unit">Unit {i.unit_number}</strong>
                    <span className={`badge ${i.status}`}>{i.status.replace(/_/g, " ")}</span>
                    {(i.is_emergency || i.severity === "critical") && (
                      <span className="badge critical">urgent</span>
                    )}
                  </div>
                  <div className="office-repair-title">{i.title}</div>
                  <div className="office-repair-meta muted">
                    {i.scheduled_date ? `Scheduled ${i.scheduled_date}` : "Not dated yet"}
                    {i.reporter_name ? ` · ${i.reporter_name}` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {emergencies.length > 0 && (
        <section className="office-section">
          <div className="office-section-head">
            <h2>Needs attention</h2>
          </div>
          <div className="card office-attention">
            <p style={{ margin: 0 }}>
              <strong>{emergencies.length}</strong> open or urgent item
              {emergencies.length === 1 ? "" : "s"} on the board — use{" "}
              <Link to="/issues">Scheduled repairs</Link> or the live map if a unit is stopped.
            </p>
          </div>
        </section>
      )}

      <p className="office-footnote muted">
        Office view is streamlined on purpose. Shop and admin tools stay with mechanics and admins.
      </p>
    </div>
  );
}
