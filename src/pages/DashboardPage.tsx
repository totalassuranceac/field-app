import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can, roleLabel } from "../api";
import { useAuth } from "../auth";
import { OfficeHome } from "./OfficeHome";

interface Dash {
  stats: {
    open_alerts: number;
    open_issues: number;
    expiring_soon: number;
    weekly_checks_due: number;
    tracking_issues?: number;
    not_reporting?: number;
    stale_or_offline?: number;
    dashcam_policy?: number;
    expected_trackers?: number;
    live_matched?: number;
    open_warranties?: number;
    open_pickups?: number;
    assets_attention?: number;
    handbook_pending?: number;
    emergencies?: number;
  };
  tracking_issues?: Array<{
    code: string;
    severity: string;
    message: string;
    unit_number: string | null;
    vehicle_id: number | null;
  }>;
  my_reminders: {
    weekly_checks: Array<{
      id: number;
      unit_number: string;
      assigned_driver: string | null;
      last_check_date: string | null;
    }>;
    repairs: Array<{
      id: number;
      title: string;
      status: string;
      scheduled_date: string | null;
      severity: string;
      unit_number: string;
    }>;
  };
  recent_fuel: Array<{
    id: number;
    unit_number: string;
    employee_name: string;
    odometer: number;
    fuel_date: string;
    total_cost: number | null;
  }>;
  recent_alerts: Array<{
    id: number;
    unit_number: string;
    message: string;
    severity: string;
  }>;
}

type Tone = "ok" | "warn" | "bad" | "info";

type FocusItem = {
  key: string;
  value: number | string;
  label: string;
  hint: string;
  to: string;
  tone: Tone;
  /** higher = more important for sorting when hot */
  weight: number;
};

function toneForCount(n: number, warnAt = 1, badAt = 3): Tone {
  if (n >= badAt) return "bad";
  if (n >= warnAt) return "warn";
  return "ok";
}

function FocusGrid({
  items,
  title,
  subtitle,
}: {
  items: FocusItem[];
  title: string;
  subtitle?: string;
}) {
  // Hot items (warn/bad) first so they catch the eye
  const sorted = [...items].sort((a, b) => {
    const rank = (t: Tone) => (t === "bad" ? 0 : t === "warn" ? 1 : t === "info" ? 2 : 3);
    const d = rank(a.tone) - rank(b.tone);
    if (d !== 0) return d;
    const av = typeof a.value === "number" ? a.value : 0;
    const bv = typeof b.value === "number" ? b.value : 0;
    return bv - av || b.weight - a.weight;
  });
  const hot = sorted.filter((i) => i.tone === "bad" || i.tone === "warn");
  const rest = sorted.filter((i) => i.tone !== "bad" && i.tone !== "warn");

  return (
    <section className="home-section" aria-label={title}>
      <div className="home-section-head">
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {subtitle ? (
            <p className="muted" style={{ margin: "0.15rem 0 0", fontSize: "0.78rem" }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {hot.length > 0 ? (
          <span className="badge warning">{hot.length} need attention</span>
        ) : (
          <span className="badge ok">All clear</span>
        )}
      </div>
      {hot.length > 0 && (
        <div className="focus-hot-grid">
          {hot.map((t) => (
            <Link key={t.key} to={t.to} className={`focus-card tone-${t.tone}`}>
              <span className="focus-card-value">{t.value}</span>
              <span className="focus-card-label">{t.label}</span>
              <span className="focus-card-hint">{t.hint}</span>
            </Link>
          ))}
        </div>
      )}
      {rest.length > 0 && (
        <div className="home-actions status-tiles focus-rest-grid">
          {rest.map((t) => (
            <Link key={t.key} to={t.to} className={`home-action status-tile tone-${t.tone}`}>
              <span className="home-action-icon status-tile-icon" aria-hidden>
                {t.value}
              </span>
              <span className="home-action-text">
                <strong>{t.label}</strong>
                <span>{t.hint}</span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function ActionRow({
  items,
}: {
  items: Array<{ to: string; icon: string; title: string; hint: string; primary?: boolean }>;
}) {
  return (
    <section className="home-section" aria-label="Quick actions">
      <div className="home-section-head">
        <h2>Do now</h2>
      </div>
      <div className="home-actions">
        {items.map((a) => (
          <Link
            key={a.to + a.title}
            className={`home-action${a.primary ? " primary" : ""}`}
            to={a.to}
          >
            <span className="home-action-icon" aria-hidden>
              {a.icon}
            </span>
            <span className="home-action-text">
              <strong>{a.title}</strong>
              <span>{a.hint}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const role = user?.role || "viewer";
  const isDriver = role === "driver";
  const isOffice = role === "office";
  const isWarehouse = role === "warehouse";
  const isAdmin = role === "admin";
  const isMechanic = role === "mechanic";
  const isViewer = role === "viewer";

  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [handbookPending, setHandbookPending] = useState(false);

  function load() {
    setLoading(true);
    setError("");
    // Never leave staff on a blank spinner if GPS/network is slow
    const watchdog = window.setTimeout(() => {
      setLoading(false);
    }, 5500);
    api<Dash>("/dashboard")
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => {
        window.clearTimeout(watchdog);
        setLoading(false);
      });
    api<{ pending?: boolean }>("/handbook")
      .then((h) => setHandbookPending(!!h.pending))
      .catch(() => setHandbookPending(false));
  }

  useEffect(() => {
    if (isOffice) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // Office keeps its own focused home
  if (isOffice) {
    return <OfficeHome />;
  }

  if (loading && !data) {
    return (
      <div className="home home-clean">
        <header className="home-hero">
          <div>
            <p className="home-kicker">{roleLabel(role)}</p>
            <h1 className="home-title">Loading…</h1>
            <p className="home-sub muted">Pulling your at-a-glance numbers</p>
          </div>
        </header>
        <div className="home-actions" style={{ marginTop: "0.75rem" }}>
          {isWarehouse && (
            <Link className="home-action primary" to="/inventory">
              <span className="home-action-text">
                <strong>Open Inventory</strong>
                <span>Find parts · pickup · stock</span>
              </span>
            </Link>
          )}
          {isAdmin && (
            <>
              <Link className="home-action primary" to="/inventory">
                <span className="home-action-text">
                  <strong>Inventory</strong>
                  <span>Parts &amp; warehouse</span>
                </span>
              </Link>
              <Link className="home-action" to="/issues">
                <span className="home-action-text">
                  <strong>Repairs</strong>
                  <span>Shop board</span>
                </span>
              </Link>
            </>
          )}
          {!isWarehouse && !isAdmin && (
            <Link className="home-action primary" to={isDriver ? "/fuel" : "/issues"}>
              <span className="home-action-text">
                <strong>{isDriver ? "Log fuel" : "Continue"}</strong>
                <span>While home finishes loading</span>
              </span>
            </Link>
          )}
        </div>
      </div>
    );
  }

  const stats = data?.stats;
  const myWeekly = data?.my_reminders?.weekly_checks || [];
  const myRepairs = data?.my_reminders?.repairs || [];
  const trackingList = data?.tracking_issues || [];
  const first = user?.display_name?.split(" ")[0] || "there";

  const s = {
    emergencies: stats?.emergencies ?? 0,
    open_issues: stats?.open_issues ?? 0,
    open_alerts: stats?.open_alerts ?? 0,
    weekly: stats?.weekly_checks_due ?? 0,
    expiring: stats?.expiring_soon ?? 0,
    tracking: stats?.tracking_issues ?? 0,
    not_reporting: stats?.not_reporting ?? 0,
    warranties: stats?.open_warranties ?? 0,
    pickups: stats?.open_pickups ?? 0,
    assets: stats?.assets_attention ?? 0,
    handbook: stats?.handbook_pending ?? 0,
  };

  let attentionTotal = 0;
  if (isDriver) {
    attentionTotal = myWeekly.length + myRepairs.length + (handbookPending ? 1 : 0);
  } else if (isWarehouse) {
    attentionTotal = s.pickups + s.warranties + s.assets + (handbookPending ? 1 : 0);
  } else if (isMechanic) {
    attentionTotal = s.emergencies + s.open_issues + s.weekly + s.tracking;
  } else {
    attentionTotal =
      s.emergencies +
      s.open_issues +
      s.open_alerts +
      s.weekly +
      s.expiring +
      s.tracking +
      s.warranties +
      s.pickups +
      s.assets +
      (s.handbook > 0 ? 1 : 0);
  }

  /** Role-specific focus tiles */
  const focusItems: FocusItem[] = (() => {
    if (isDriver) {
      return [
        {
          key: "weekly",
          value: myWeekly.length || s.weekly,
          label: "Weekly check due",
          hint: myWeekly.length
            ? myWeekly.map((v) => `Unit ${v.unit_number}`).join(", ")
            : "Your unit this week",
          to: "/inspections",
          tone: toneForCount(myWeekly.length || s.weekly),
          weight: 10,
        },
        {
          key: "repairs",
          value: myRepairs.length || s.open_issues,
          label: "Your repairs",
          hint: myRepairs.length ? "Work on your unit" : "None open",
          to: "/issues",
          tone: toneForCount(myRepairs.length),
          weight: 9,
        },
        {
          key: "warranties",
          value: "→",
          label: "Warranty drop-off",
          hint: "Photo where you leave parts",
          to: "/warranties",
          tone: "info",
          weight: 5,
        },
        {
          key: "gear",
          value: "→",
          label: "My truck gear",
          hint: "Bottles & equipment",
          to: "/assets",
          tone: "info",
          weight: 4,
        },
      ];
    }

    if (isWarehouse) {
      return [
        {
          key: "pickups",
          value: s.pickups,
          label: "Open pickups / handoffs",
          hint: "Custody waiting at the counter",
          to: "/inventory",
          tone: toneForCount(s.pickups, 1, 3),
          weight: 10,
        },
        {
          key: "warranties",
          value: s.warranties,
          label: "Open warranties",
          hint: "Parts dropped off to process",
          to: "/warranties",
          tone: toneForCount(s.warranties, 1, 5),
          weight: 9,
        },
        {
          key: "assets",
          value: s.assets,
          label: "Equipment needs attention",
          hint: "Damaged / repair / missing",
          to: "/assets",
          tone: toneForCount(s.assets, 1, 2),
          weight: 8,
        },
        {
          key: "bottles",
          value: "→",
          label: "Gas bottle counts",
          hint: "O2 · N2 · acetylene swap",
          to: "/assets",
          tone: "info",
          weight: 6,
        },
        {
          key: "inventory",
          value: "→",
          label: "Stock & stage",
          hint: "Truck stock · reorder",
          to: "/inventory",
          tone: "info",
          weight: 5,
        },
      ];
    }

    if (isMechanic) {
      return [
        {
          key: "emergencies",
          value: s.emergencies,
          label: "Urgent / emergency repairs",
          hint: "High severity or emergency flags",
          to: "/issues",
          tone: toneForCount(s.emergencies, 1, 1),
          weight: 12,
        },
        {
          key: "repairs",
          value: s.open_issues,
          label: "Open shop jobs",
          hint: "Scheduled · in progress · open",
          to: "/issues",
          tone: toneForCount(s.open_issues, 1, 4),
          weight: 10,
        },
        {
          key: "weekly",
          value: s.weekly,
          label: "Weekly checks due",
          hint: "Units not checked in 7 days",
          to: "/inspections",
          tone: toneForCount(s.weekly, 1, 5),
          weight: 7,
        },
        {
          key: "tracking",
          value: s.tracking,
          label: "GPS / cam issues",
          hint:
            s.not_reporting > 0
              ? `${s.not_reporting} not reporting live`
              : "Trackers & dash cams",
          to: "/live",
          tone: toneForCount(s.tracking, 1, 2),
          weight: 8,
        },
        {
          key: "yard",
          value: s.expiring,
          label: "Compliance soon",
          hint: "Reg / insurance",
          to: "/yard",
          tone: toneForCount(s.expiring, 1, 3),
          weight: 6,
        },
      ];
    }

    // Admin + viewer bird's-eye (viewer tiles still link for read)
    return [
      {
        key: "emergencies",
        value: s.emergencies,
        label: "Urgent repairs",
        hint: "Emergency / high severity open",
        to: "/issues",
        tone: toneForCount(s.emergencies, 1, 1),
        weight: 20,
      },
      {
        key: "repairs",
        value: s.open_issues,
        label: "Open repairs",
        hint: "Shop board · field requests",
        to: "/issues",
        tone: toneForCount(s.open_issues, 1, 5),
        weight: 15,
      },
      {
        key: "pickups",
        value: s.pickups,
        label: "Warehouse pickups",
        hint: "Handoffs still open",
        to: "/inventory",
        tone: toneForCount(s.pickups, 1, 3),
        weight: 14,
      },
      {
        key: "warranties",
        value: s.warranties,
        label: "Open warranties",
        hint: "Drop-offs waiting to process",
        to: "/warranties",
        tone: toneForCount(s.warranties, 1, 5),
        weight: 13,
      },
      {
        key: "flags",
        value: s.open_alerts,
        label: "Mileage flags",
        hint: "Odd odometer / fuel patterns",
        to: "/alerts",
        tone: toneForCount(s.open_alerts, 1, 2),
        weight: 12,
      },
      {
        key: "tracking",
        value: s.tracking,
        label: "GPS / dash cam",
        hint:
          s.not_reporting > 0
            ? `${s.not_reporting} not on map`
            : stats?.expected_trackers
              ? `${stats.live_matched ?? 0}/${stats.expected_trackers} live`
              : "Tracking health",
        to: "/live",
        tone: toneForCount(s.tracking, 1, 2),
        weight: 11,
      },
      {
        key: "weekly",
        value: s.weekly,
        label: "Weekly checks due",
        hint: "No check in last 7 days",
        to: "/inspections",
        tone: toneForCount(s.weekly, 1, 5),
        weight: 10,
      },
      {
        key: "compliance",
        value: s.expiring,
        label: "Compliance soon",
        hint: "Registration / insurance",
        to: "/yard",
        tone: toneForCount(s.expiring, 1, 3),
        weight: 9,
      },
      {
        key: "assets",
        value: s.assets,
        label: "Equipment attention",
        hint: "Ladders / tools damaged or repair",
        to: "/assets",
        tone: toneForCount(s.assets, 1, 2),
        weight: 8,
      },
      {
        key: "handbook",
        value: s.handbook,
        label: "Handbook not signed",
        hint: "Staff still need to acknowledge",
        to: "/handbook",
        tone: toneForCount(s.handbook, 1, 3),
        weight: 7,
      },
    ];
  })();

  const actions = (() => {
    if (isDriver) {
      return [
        { to: "/fuel", icon: "⛽", title: "Log fuel", hint: "Photo receipt · odometer", primary: true },
        { to: "/inspections", icon: "✓", title: "Weekly check", hint: "OK or report issue" },
        { to: "/warranties", icon: "📦", title: "Warranty drop-off", hint: "Photo the shelf" },
        { to: "/issues", icon: "🔧", title: "Request repair", hint: "Something’s wrong" },
        { to: "/assets", icon: "🧰", title: "My truck gear", hint: "Bottles & tools" },
        { to: "/live", icon: "🗺", title: "Live map", hint: "Fleet locations" },
      ];
    }
    if (isWarehouse) {
      return [
        {
          to: "/inventory",
          icon: "📋",
          title: "Pickup / handoff",
          hint: "Scan · custody · truck",
          primary: true,
        },
        { to: "/assets", icon: "🧪", title: "Bottles & gear", hint: "Swap gas · ladders" },
        { to: "/warranties", icon: "📦", title: "Warranties", hint: "Process drop-offs" },
        { to: "/inventory", icon: "📊", title: "Stock levels", hint: "Stage · order" },
        { to: "/messages", icon: "💬", title: "Messages", hint: "Team" },
      ];
    }
    if (isMechanic) {
      return [
        { to: "/issues", icon: "🔧", title: "Shop board", hint: "Repairs & schedule", primary: true },
        { to: "/yard", icon: "📋", title: "Yard walk", hint: "Stickers · cams · GPS" },
        { to: "/vehicles", icon: "🚐", title: "Vehicles", hint: "Fleet registry" },
        { to: "/live", icon: "🗺", title: "Live map", hint: "Where units are" },
        { to: "/inspections", icon: "✓", title: "Weekly checks", hint: "Status board" },
      ];
    }
    if (isViewer) {
      return [
        { to: "/live", icon: "🗺", title: "Live map", hint: "Fleet locations", primary: true },
        { to: "/reports", icon: "📈", title: "Reports", hint: "Browse numbers" },
        { to: "/inspections", icon: "✓", title: "Weekly checks", hint: "Status only" },
        { to: "/alerts", icon: "🚩", title: "Mileage flags", hint: "Open flags" },
      ];
    }
    // Admin — operations hub actions
    return [
      { to: "/issues", icon: "🔧", title: "Repairs", hint: "Shop + field requests", primary: true },
      { to: "/inventory", icon: "📦", title: "Warehouse", hint: "Stock · pickup · stage" },
      { to: "/warranties", icon: "🧾", title: "Warranties", hint: "Drop-offs to process" },
      { to: "/live", icon: "🗺", title: "Live map", hint: "Fleet on the road" },
      { to: "/assets", icon: "🧰", title: "Assets", hint: "Bottles · ladders · tools" },
      { to: "/alerts", icon: "🚩", title: "Flags", hint: "Mileage / fuel oddities" },
      { to: "/yard", icon: "📋", title: "Yard", hint: "Compliance walk" },
      { to: "/roles", icon: "👁", title: "Role simulator", hint: "Preview staff screens" },
      { to: "/admin", icon: "👥", title: "People", hint: "Users · settings" },
      { to: "/audit", icon: "📜", title: "Audit", hint: "Who changed what" },
    ];
  })();

  const kicker = isAdmin
    ? "Command center"
    : isWarehouse
      ? "Warehouse"
      : isMechanic
        ? "Shop"
        : isDriver
          ? "Field"
          : roleLabel(role);

  const subtitle = isAdmin
    ? attentionTotal === 0
      ? "Everything looks clear — scan below anytime"
      : `${attentionTotal} items need your attention across fleet, shop & warehouse`
    : isWarehouse
      ? attentionTotal === 0
        ? "Counter is clear"
        : `${attentionTotal} open at the counter / stock`
      : isDriver
        ? attentionTotal === 0
          ? "You’re caught up"
          : `${attentionTotal} for you today`
        : attentionTotal === 0
          ? "All clear"
          : `${attentionTotal} need attention`;

  const handbookBanner = handbookPending ? (
    <div className="handbook-pending-banner" role="status">
      <span>
        <strong>Employee handbook</strong> — please read and acknowledge.
      </span>
      <Link className="btn" to="/handbook">
        Open handbook
      </Link>
    </div>
  ) : null;

  return (
    <div className={`home home-clean home-role-${role}`}>
      <header className="home-hero">
        <div>
          <p className="home-kicker">{kicker}</p>
          <h1 className="home-title">Hi, {first}</h1>
          <p className="home-sub">{subtitle}</p>
        </div>
        {isAdmin && (
          <button type="button" className="btn secondary home-refresh" onClick={load}>
            Refresh
          </button>
        )}
      </header>

      {error && (
        <div className="error" style={{ marginBottom: "0.85rem" }}>
          {error}
          <div style={{ marginTop: "0.5rem" }}>
            <button className="btn secondary" type="button" onClick={load}>
              Retry
            </button>
          </div>
        </div>
      )}

      {handbookBanner}

      {/* Role-specific at-a-glance board */}
      <FocusGrid
        items={focusItems}
        title={
          isAdmin
            ? "Command center"
            : isWarehouse
              ? "Warehouse at a glance"
              : isDriver
                ? "Field at a glance"
                : isMechanic
                  ? "Shop at a glance"
                  : "At a glance"
        }
        subtitle={
          isAdmin
            ? "Fleet · shop · warehouse · compliance — hot items first"
            : isWarehouse
              ? "Pickups, warranties, bottles & damaged gear"
              : isDriver
                ? "Your checks, repairs, drop-offs & truck gear"
                : isMechanic
                  ? "Urgent jobs, shop board, yard & tracking"
                  : "Status that matters for your role"
        }
      />

      {/* Personal field reminders */}
      {isDriver && (myWeekly.length > 0 || myRepairs.length > 0) && (
        <section className="home-section" aria-label="For you">
          <div className="home-section-head">
            <h2>For you</h2>
          </div>
          <div className="home-pills">
            {myWeekly.map((v) => (
              <Link key={`w-${v.id}`} className="home-pill warn" to="/inspections">
                <strong>Check unit {v.unit_number}</strong>
                <span>{v.last_check_date ? `Last ${v.last_check_date}` : "Never checked"}</span>
              </Link>
            ))}
            {myRepairs.map((r) => (
              <Link key={`r-${r.id}`} className="home-pill alert" to="/issues">
                <strong>
                  {r.unit_number} · {r.status}
                </strong>
                <span>
                  {r.title}
                  {r.scheduled_date ? ` · ${r.scheduled_date}` : ""}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <ActionRow items={actions} />

      {/* Admin / shop: tracking list when hot */}
      {!isDriver && !isWarehouse && trackingList.length > 0 && (
        <section className="home-section" aria-label="Tracking">
          <div className="home-section-head">
            <h2>Tracking issues</h2>
            <Link to="/live" className="home-mini-link">
              Map →
            </Link>
          </div>
          <ul className="home-feed card" style={{ padding: "0.55rem 0.75rem" }}>
            {trackingList.slice(0, 6).map((t, i) => (
              <li key={`${t.code}-${t.vehicle_id ?? i}`}>
                <span className="home-feed-main">
                  <span className={`badge ${t.severity === "bad" ? "danger" : "warning"}`}>
                    {t.severity === "bad" ? "urgent" : "check"}
                  </span>{" "}
                  <strong>{t.unit_number ? `Unit ${t.unit_number}` : "Device"}</strong>
                </span>
                <span className="home-feed-meta home-feed-msg">{t.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recent fuel / flags for admin & mechanic */}
      {data && (isAdmin || isMechanic || isViewer) && (
        <section className="home-section" aria-label="Recent">
          <div className="home-section-head">
            <h2>Recent activity</h2>
          </div>
          <div className="home-activity-grid">
            <div className="card home-activity-card">
              <div className="home-collapse-label" style={{ padding: "0.15rem 0 0.35rem" }}>
                <strong>Fuel</strong>
                {can(user, "logFuel") && (
                  <Link className="home-mini-link" to="/fuel" style={{ marginLeft: "0.5rem" }}>
                    Log →
                  </Link>
                )}
              </div>
              {!data.recent_fuel.length ? (
                <p className="muted empty-tight">No entries yet.</p>
              ) : (
                <ul className="home-feed">
                  {data.recent_fuel.slice(0, 4).map((f) => (
                    <li key={f.id}>
                      <span className="home-feed-main">
                        <strong>{f.unit_number}</strong> · {f.employee_name}
                      </span>
                      <span className="home-feed-meta">
                        {f.fuel_date}
                        {f.total_cost != null ? ` · $${Number(f.total_cost).toFixed(0)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="card home-activity-card">
              <div className="home-collapse-label" style={{ padding: "0.15rem 0 0.35rem" }}>
                <strong>Mileage flags</strong>
                <Link className="home-mini-link" to="/alerts" style={{ marginLeft: "0.5rem" }}>
                  All →
                </Link>
              </div>
              {!data.recent_alerts.length ? (
                <p className="muted empty-tight">None open.</p>
              ) : (
                <ul className="home-feed">
                  {data.recent_alerts.slice(0, 4).map((a) => (
                    <li key={a.id}>
                      <span className="home-feed-main">
                        <span className={`badge ${a.severity}`}>{a.severity}</span>{" "}
                        <strong>{a.unit_number}</strong>
                      </span>
                      <span className="home-feed-meta home-feed-msg">{a.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
