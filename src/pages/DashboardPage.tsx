import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, can, roleLabel } from "../api";
import { useAuth } from "../auth";
import { ClockinNudgeCard } from "../components/ClockinNudgeCard";
import { NewHireSafetyCard } from "../components/NewHireSafetyCard";
import { ResponsibilityHomeCard } from "../components/ResponsibilityHomeCard";
import { MyShortcuts } from "../components/MyShortcuts";
import { OfficeHome } from "./OfficeHome";
import { PullTomorrowHome } from "./TomorrowMaterialsPage";
import { isAzaliMiller } from "../lib/azaliRnc";

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
    open_vendor_runs?: number;
    parts_dropoffs_waiting?: number;
    fuel_ocr_pending?: number;
    open_issues_stale?: number;
    assets_attention?: number;
    handbook_pending?: number;
    emergencies?: number;
    /** Registration sticker: expired + due ≤30d + missing date */
    registration_attention?: number;
    registration_expired?: number;
    registration_due_soon?: number;
    registration_missing?: number;
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
    registration?: Array<{
      id: number;
      unit_number: string;
      registration_expires: string;
    }>;
    repairs: Array<{
      id: number;
      title: string;
      status: string;
      scheduled_date: string | null;
      severity: string;
      unit_number: string;
      tech_confirm_status?: string | null;
      schedule_notes?: string | null;
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

function useHomeCollapse(key: string, defaultOpen = false) {
  const storageKey = `home_collapse_${key}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = sessionStorage.getItem(storageKey);
      if (v === "1") return true;
      if (v === "0") return false;
    } catch {
      /* ignore */
    }
    return defaultOpen;
  });
  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try {
        sessionStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }
  return [open, toggle] as const;
}

function CollapsibleHomeSection({
  id,
  title,
  count,
  link,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  link?: { to: string; label: string };
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, toggle] = useHomeCollapse(id, defaultOpen);
  return (
    <section className={`home-section home-collapse${open ? " is-open" : ""}`} aria-label={title}>
      <div className="home-section-head home-collapse-head">
        <button type="button" className="home-collapse-toggle" onClick={toggle} aria-expanded={open}>
          <span className="home-collapse-chevron" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <h2 style={{ margin: 0 }}>{title}</h2>
          {count != null && count > 0 ? (
            <span className="badge warning home-collapse-count">{count}</span>
          ) : null}
        </button>
        {link ? (
          <Link to={link.to} className="home-mini-link">
            {link.label}
          </Link>
        ) : null}
      </div>
      {open ? <div className="home-collapse-body">{children}</div> : null}
    </section>
  );
}

function FocusGrid({
  items,
  title,
  subtitle,
  calm = false,
}: {
  items: FocusItem[];
  title: string;
  subtitle?: string;
  /** Admin calm mode — no HOT badge / fake urgency chrome */
  calm?: boolean;
}) {
  // Real waiting work first (non-zero warn/bad), then the rest
  const sorted = [...items].sort((a, b) => {
    const rank = (t: Tone) => (t === "bad" ? 0 : t === "warn" ? 1 : t === "info" ? 2 : 3);
    const d = rank(a.tone) - rank(b.tone);
    if (d !== 0) return d;
    const av = typeof a.value === "number" ? a.value : 0;
    const bv = typeof b.value === "number" ? b.value : 0;
    return bv - av || b.weight - a.weight;
  });
  const waiting = sorted.filter(
    (i) => typeof i.value === "number" && i.value > 0 && (i.tone === "bad" || i.tone === "warn")
  );

  return (
    <section className={`home-section${calm ? " home-focus-calm" : ""}`} aria-label={title}>
      <div className="home-section-head home-focus-head">
        <div className="home-focus-head-text">
          <h2 style={{ margin: 0 }}>{title}</h2>
          {subtitle ? (
            <div className="home-focus-sub-block">
              <p className="muted home-focus-sub">{subtitle}</p>
              {!calm ? (
                waiting.length > 0 ? (
                  <p className="home-focus-inline-hot">
                    <strong>{waiting.length}</strong> waiting
                  </p>
                ) : (
                  <p className="home-focus-inline-clear">all clear</p>
                )
              ) : null}
            </div>
          ) : null}
        </div>
        {!calm ? (
          waiting.length > 0 ? (
            <div
              className="home-focus-count"
              title={`${waiting.length} real queues with work waiting`}
            >
              <span className="home-focus-count-n">{waiting.length}</span>
              <span className="home-focus-count-label">waiting</span>
            </div>
          ) : (
            <div className="home-focus-count is-clear" title="Nothing waiting">
              <span className="home-focus-count-label">OK</span>
            </div>
          )
        ) : waiting.length === 0 ? (
          <div className="home-focus-count is-clear" title="Nothing waiting">
            <span className="home-focus-count-label">OK</span>
          </div>
        ) : null}
      </div>
      <div className="home-actions status-tiles focus-all-grid">
        {sorted.map((t) => {
          const isWaiting =
            typeof t.value === "number" && t.value > 0 && (t.tone === "bad" || t.tone === "warn");
          return (
            <Link
              key={t.key}
              to={t.to}
              className={`home-action status-tile tone-${t.tone}${
                isWaiting && !calm ? " is-hot" : ""
              }${calm && !isWaiting ? " is-quiet" : ""}`}
            >
              <span className="home-action-icon status-tile-icon" aria-hidden>
                {t.value}
              </span>
              <span className="home-action-text">
                <strong>{t.label}</strong>
                <span>{t.hint}</span>
              </span>
            </Link>
          );
        })}
      </div>
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
  const isSupervisor = role === "supervisor";
  const isWarehouse = role === "warehouse";
  const isAdmin = role === "admin";
  const isMechanic = role === "mechanic";
  const isViewer = role === "viewer";
  /** Same home / command-center UI as admin */
  const isAdminShell = isAdmin || isViewer;
  const isOfficeHome = isOffice || isSupervisor;

  const [data, setData] = useState<Dash | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  /** quiet = background refresh (no full-page spinner) */
  function load(opts?: { quiet?: boolean }) {
    const quiet = !!opts?.quiet;
    if (!quiet) {
      setLoading(true);
      setError("");
    }
    // Hard cap so home never spins forever if API is slow
    const watchdog = quiet
      ? 0
      : window.setTimeout(() => {
          setLoading(false);
        }, 2500);
    api<Dash>("/dashboard")
      .then((d) => {
        setData(d);
        setError("");
      })
      .catch((e) => {
        if (!quiet) setError(e instanceof Error ? e.message : "Could not load home");
      })
      .finally(() => {
        if (watchdog) window.clearTimeout(watchdog);
        setLoading(false);
      });
  }

  // Auto-refresh when opened, then every 45s while visible (not on every focus spam)
  useEffect(() => {
    if (isOfficeHome) return;
    load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") load({ quiet: true });
    }, 45_000);
    const onVis = () => {
      if (document.visibilityState === "visible") load({ quiet: true });
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  // Office and supervisor share the same focused home
  if (isOfficeHome) {
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
          {isAdminShell && (
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
          {!isWarehouse && !isAdminShell && (
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
  const myReg = data?.my_reminders?.registration || [];
  const myAlerts = data?.recent_alerts || [];
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
    vendor_runs: stats?.open_vendor_runs ?? 0,
    dropoffs: stats?.parts_dropoffs_waiting ?? 0,
    fuel_ocr: stats?.fuel_ocr_pending ?? 0,
    stale_issues: stats?.open_issues_stale ?? 0,
    assets: stats?.assets_attention ?? 0,
    handbook: stats?.handbook_pending ?? 0,
    reg_attention: stats?.registration_attention ?? 0,
    reg_expired: stats?.registration_expired ?? 0,
    reg_due: stats?.registration_due_soon ?? 0,
    reg_missing: stats?.registration_missing ?? 0,
  };

  // Real waiting work only — never sum fuel-alert noise / weekly spam / GPS / handbook into a fake total
  let attentionTotal = 0;
  if (isDriver) {
    attentionTotal = myWeekly.length + myRepairs.length + myReg.length + myAlerts.length;
  } else if (isWarehouse) {
    attentionTotal = s.pickups + s.vendor_runs + s.dropoffs + s.warranties;
  } else if (isMechanic) {
    attentionTotal = s.emergencies + s.stale_issues + s.warranties;
  } else {
    // Admin / viewer: warranties, fuel OCR queue, parts at shop / warehouse pulls (+ true emergencies)
    attentionTotal =
      s.emergencies +
      s.reg_attention +
      s.warranties +
      s.fuel_ocr +
      s.dropoffs +
      s.pickups +
      s.vendor_runs;
  }

  if (isDriver) {
    const waiting = myWeekly.length + myRepairs.length + myReg.length + myAlerts.length;
    return (
      <div className="home home-clean home-role-driver">
        <header className="home-hero">
          <div>
            <p className="home-kicker">Field</p>
            <h1 className="home-title">Hi, {first}</h1>
            <p className="home-sub">
              {waiting === 0 ? "Your jobs are up top" : `${waiting} waiting on you`}
            </p>
          </div>
        </header>

        {error && (
          <div className="error" style={{ marginBottom: "0.85rem" }}>
            {error}
            <div style={{ marginTop: "0.5rem" }}>
              <button className="btn secondary" type="button" onClick={() => load()}>
                Retry
              </button>
            </div>
          </div>
        )}

        <NewHireSafetyCard />
        <ResponsibilityHomeCard />

        <section className="home-section" aria-label="Today">
          <div className="home-section-head">
            <h2>Today</h2>
          </div>
          <div className="home-actions">
            {can(user, "viewDayBoard") ? (
              <Link className="home-action primary" to="/day-board">
                <span className="home-action-icon" aria-hidden>
                  JB
                </span>
                <span className="home-action-text">
                  <strong>Today's jobs</strong>
                  <span>Your jobs for today</span>
                </span>
              </Link>
            ) : null}
            {can(user, "useJobClock") ? (
              <Link className="home-action primary" to="/clock">
                <span className="home-action-icon" aria-hidden>
                  CL
                </span>
                <span className="home-action-text">
                  <strong>Clock in / out</strong>
                  <span>En route, arrived, finished</span>
                </span>
              </Link>
            ) : null}
          </div>
        </section>

        {waiting > 0 ? (
          <section className="home-section" aria-label="Waiting on you">
            <div className="home-section-head">
              <h2>Waiting on you</h2>
            </div>
            <div className="home-pills">
              {myWeekly.map((v) => (
                <Link key={`w-${v.id}`} className="home-pill warn" to="/inspections">
                  <strong>Check unit {v.unit_number}</strong>
                  <span>{v.last_check_date ? `Last ${v.last_check_date}` : "Never checked"}</span>
                </Link>
              ))}
              {myReg.map((v) => {
                const due = String(v.registration_expires || "").slice(0, 10);
                const expired = due && due < new Date().toISOString().slice(0, 10);
                return (
                  <span key={`reg-${v.id}`} className="home-pill warn">
                    <strong>
                      {v.unit_number} sticker {expired ? "expired" : "due"}
                    </strong>
                    <span>{due || "Date missing"}</span>
                  </span>
                );
              })}
              {myAlerts.map((a) => (
                <Link key={`a-${a.id}`} className="home-pill alert" to="/fuel">
                  <strong>{a.unit_number} fuel</strong>
                  <span>{a.message}</span>
                </Link>
              ))}
              {myRepairs.map((r) => {
                const needsConfirm =
                  r.status === "scheduled" && r.tech_confirm_status !== "confirmed";
                return (
                  <Link
                    key={`r-${r.id}`}
                    className={`home-pill alert${needsConfirm ? " needs-confirm" : ""}`}
                    to={`/issues?id=${r.id}`}
                  >
                    <strong>
                      {r.status === "scheduled"
                        ? needsConfirm
                          ? `CONFIRM · BRING IN ${r.unit_number}`
                          : `BRING IN ${r.unit_number}`
                        : `${r.unit_number} · ${r.status}`}
                    </strong>
                    <span>
                      {r.title}
                      {r.scheduled_date ? ` · ${r.scheduled_date}` : ""}
                      {needsConfirm
                        ? " · tap to confirm"
                        : r.tech_confirm_status === "confirmed"
                          ? " · confirmed"
                          : ""}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="home-section" aria-label="When you need it">
          <div className="home-section-head">
            <h2>When you need it</h2>
          </div>
          <div className="home-actions">
            <details className="home-part-door">
              <summary className="home-action">
                <span className="home-action-icon" aria-hidden>
                  PT
                </span>
                <span className="home-action-text">
                  <strong>I need a part</strong>
                  <span>At a store, already at the shop, or bring it to the job</span>
                </span>
              </summary>
              <div className="home-part-choices">
                <Link to="/part-pickup">At a store</Link>
                <Link to="/parts-dropoff">Already at the shop</Link>
                <Link to="/parts-runs">Bring it to the job</Link>
              </div>
            </details>
          </div>
          <details className="home-more">
            <summary>More</summary>
            <div className="home-actions">
              {can(user, "logFuel") ? (
                <Link className="home-action" to="/fuel">
                  <span className="home-action-icon" aria-hidden>
                    FL
                  </span>
                  <span className="home-action-text">
                    <strong>Log fuel</strong>
                    <span>Photo the receipt</span>
                  </span>
                </Link>
              ) : null}
              {can(user, "logPartsPurchase") ? (
                <Link className="home-action" to="/parts-receipts">
                  <span className="home-action-icon" aria-hidden>
                    BY
                  </span>
                  <span className="home-action-text">
                    <strong>Purchase receipts</strong>
                    <span>Parts and materials, not fuel</span>
                  </span>
                </Link>
              ) : null}
              <Link className="home-action" to="/warranties">
                <span className="home-action-icon" aria-hidden>
                  W
                </span>
                <span className="home-action-text">
                  <strong>Warranty drop-off</strong>
                  <span>Photo where you leave the part</span>
                </span>
              </Link>
              {can(user, "reportTruckProblem") ? (
                <Link className="home-action" to="/fleet-shop/report">
                  <span className="home-action-icon" aria-hidden>
                    RP
                  </span>
                  <span className="home-action-text">
                    <strong>Truck problem</strong>
                    <span>Flat tire, will not start, warning light</span>
                  </span>
                </Link>
              ) : null}
              <Link className="home-action" to="/responsibility">
                <span className="home-action-icon" aria-hidden>
                  CV
                </span>
                <span className="home-action-text">
                  <strong>Card and vehicle forms</strong>
                  <span>Sign for a company card or a company truck</span>
                </span>
              </Link>
              {can(user, "viewDoneToday") ? (
                <Link className="home-action" to="/done-today">
                  <span className="home-action-icon" aria-hidden>
                    DT
                  </span>
                  <span className="home-action-text">
                    <strong>Done today</strong>
                    <span>What the app already logged</span>
                  </span>
                </Link>
              ) : null}
            </div>
          </details>
        </section>

        <MyShortcuts />
      </div>
    );
  }

  /** Role-specific focus tiles */
  const focusItems: FocusItem[] = (() => {
    if (isWarehouse) {
      return [
        {
          key: "vendor_runs",
          value: s.vendor_runs,
          label: "To pick up at vendors",
          hint: "Parts still at supply houses",
          to: "/part-pickup",
          tone: toneForCount(s.vendor_runs, 1, 3),
          weight: 12,
        },
        {
          key: "dropoffs",
          value: s.dropoffs,
          label: "At shop (drop-offs)",
          hint: "Techs brought parts in — put away / issue",
          to: "/parts-dropoff",
          tone: toneForCount(s.dropoffs, 1, 2),
          weight: 11,
        },
        {
          key: "pickups",
          value: s.pickups,
          label: "Issue / handoff to truck",
          hint: "Custody waiting at the counter",
          to: "/inventory",
          tone: toneForCount(s.pickups, 1, 3),
          weight: 10,
        },
        {
          key: "warranties",
          value: s.warranties,
          label: "Warranties to file",
          hint: "File pile — dropped off, not parked",
          to: "/warranties",
          tone: toneForCount(s.warranties, 1, 5),
          weight: 9,
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
          label: "Shop board",
          hint:
            s.stale_issues > 0
              ? `${s.stale_issues} open 3+ days without schedule`
              : "Needs schedule + booked work",
          to: "/issues",
          tone: toneForCount(s.open_issues, 1, 4),
          weight: 10,
        },
        {
          key: "warranties",
          value: s.warranties,
          label: "Warranties to file",
          hint: "File pile — dropped off, not parked",
          to: "/warranties",
          tone: toneForCount(s.warranties, 1, 5),
          weight: 9,
        },
        {
          key: "stale",
          value: s.stale_issues,
          label: "Unscheduled 3+ days",
          hint: "Open tickets needing a shop date",
          to: "/issues?tab=needs",
          tone: toneForCount(s.stale_issues, 1, 2),
          weight: 8,
        },
      ];
    }

    // Admin + viewer — real waiting queues only (no fuel-alert / weekly / GPS / handbook spam)
    const regHintParts = [
      s.reg_expired ? `${s.reg_expired} expired` : null,
      s.reg_due ? `${s.reg_due} due ≤30d` : null,
      s.reg_missing ? `${s.reg_missing} missing date` : null,
    ].filter(Boolean);
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
        key: "registration",
        value: s.reg_attention,
        label: "Registration renewals",
        hint: regHintParts.length
          ? regHintParts.join(" · ")
          : "Expired, due soon, or missing sticker date",
        to: "/yard?filter=registration",
        tone: toneForCount(s.reg_attention, 1, 3),
        weight: 19,
      },
      {
        key: "warranties",
        value: s.warranties,
        label: "Warranties to file",
        hint: "File pile — dropped off, not parked",
        to: "/warranties",
        tone: toneForCount(s.warranties, 1, 5),
        weight: 18,
      },
      {
        key: "fuel_ocr",
        value: s.fuel_ocr,
        label: "Fuel receipts to verify",
        hint: "OCR queue — teach the app",
        to: "/fuel/receipt-review",
        tone: toneForCount(s.fuel_ocr, 1, 5),
        weight: 17,
      },
      {
        key: "dropoffs",
        value: s.dropoffs,
        label: "Parts at shop",
        hint: "Drop-offs waiting for warehouse",
        to: "/parts-dropoff",
        tone: toneForCount(s.dropoffs, 1, 2),
        weight: 16,
      },
      {
        key: "pickups",
        value: s.pickups,
        label: "Warehouse handoffs",
        hint: "Issue / pull waiting at the counter",
        to: "/inventory",
        tone: toneForCount(s.pickups, 1, 3),
        weight: 15,
      },
      {
        key: "vendor_runs",
        value: s.vendor_runs,
        label: "Vendor pickups waiting",
        hint: "Parts still at supply houses",
        to: "/part-pickup",
        tone: toneForCount(s.vendor_runs, 1, 3),
        weight: 14,
      },
    ];
  })();

  const waitingFocus = focusItems.filter(
    (i) => typeof i.value === "number" && i.value > 0 && (i.tone === "bad" || i.tone === "warn")
  );
  const focusShown = isAdminShell && waitingFocus.length > 0 ? waitingFocus : focusItems;

  const actions = (() => {
    if (isWarehouse) {
      return [
        {
          to: "/inventory",
          icon: "ST",
          title: "Stock room",
          hint: "Scan - custody - truck",
          primary: true,
        },
        {
          to: "/parts-orders#receiving",
          icon: "RC",
          title: "Receiving",
          hint: "Dock a box - where it sits",
        },
        {
          to: "/parts-runs",
          icon: "DL",
          title: "Deliver to job",
          hint: "Field needs a run",
        },
        { to: "/live", icon: "MP", title: "Fleet map", hint: "Find techs - units on the road" },
        { to: "/fuel", icon: "FL", title: "Log fuel", hint: "Receipt photo - any unit" },
        { to: "/assets", icon: "GR", title: "Company assets", hint: "Bottles - ladders - tools" },
        { to: "/parts-receipts", icon: "BY", title: "Purchase receipts", hint: "Company card - photo the receipt" },
        { to: "/warranties", icon: "W", title: "Warranties", hint: "Process drop-offs" },
        { to: "/part-pickup", icon: "PK", title: "Will-call", hint: "Parts ready at a store" },
      ];
    }
    if (isMechanic) {
      return [
        { to: "/issues", icon: "RP", title: "Repair board", hint: "Schedule - work - close", primary: true },
        { to: "/service", icon: "OC", title: "Oil changes", hint: "Due by miles" },
        { to: "/fleet-shop", icon: "FS", title: "Fleet Shop", hint: "Shop jobs and driver reports" },
        {
          to: "/parts-runs",
          icon: "DL",
          title: "Deliver to job",
          hint: "Field needs a run",
        },
        {
          to: "/parts-orders",
          icon: "OR",
          title: "Order for shop",
          hint: "AutoZone - First Call - track",
        },
        { to: "/fuel", icon: "FL", title: "Log fuel", hint: "Receipt photo - odometer" },
        { to: "/parts-receipts", icon: "BY", title: "Purchase receipts", hint: "Company card - photo the receipt" },
        { to: "/yard", icon: "YD", title: "Fleet compliance", hint: "Stickers - cams - GPS" },
        { to: "/vehicles", icon: "UN", title: "Fleet units", hint: "Fleet registry" },
        { to: "/live", icon: "MP", title: "Fleet map", hint: "Where units are" },
        { to: "/inspections", icon: "OK", title: "Weekly check", hint: "Status board" },
      ];
    }
    // Admin shell (admin + viewer) — same hub; viewer is read-only via API/UI gates
    if (isAdminShell) {
      return [
        { to: "/issues", icon: "RP", title: "Repair board", hint: "Repairs + schedule", primary: true },
        {
          to: "/parts-orders",
          icon: "OR",
          title: "Order for shop",
          hint: "AutoZone - First Call - track",
        },
        { to: "/inventory", icon: "ST", title: "Stock room", hint: "Stock - pickup - stage" },
        { to: "/warranties", icon: "W", title: "Warranties", hint: "Drop-offs to process" },
        { to: "/live", icon: "MP", title: "Fleet map", hint: "Fleet on the road" },
        { to: "/fuel/receipt-review", icon: "VF", title: "Verify fuel", hint: "Receipt photo queue" },
        { to: "/assets", icon: "GR", title: "Company assets", hint: "Bottles - ladders - tools" },
        { to: "/yard", icon: "YD", title: "Fleet compliance", hint: "Compliance walk" },
        { to: "/tv", icon: "TV", title: "TV board", hint: "Office wall display" },
        ...(isAdmin
          ? [{ to: "/roles", icon: "PR", title: "Preview roles", hint: "See staff screens" }]
          : []),
        { to: "/admin", icon: "EM", title: "Employees", hint: "Logins - roster" },
        { to: "/audit", icon: "CH", title: "Change history", hint: "Who changed what" },
      ];
    }
    // Office / supervisor — Live map lives in nav; don't duplicate as primary Home card
    return [
      { to: "/day-board", icon: "JB", title: "Today's jobs", hint: "Watch the day", primary: true },
      {
        to: "/ops-performance?period=7",
        icon: "WK",
        title: "Shop scoreboard",
        hint: "Jobs, sales, comebacks, recalls",
      },
      { to: "/reports", icon: "EX", title: "Fuel and fleet exports", hint: "Browse numbers" },
      { to: "/admin", icon: "EM", title: "Employees", hint: "Logins - roster" },
    ];
  })();

  const kicker = isAdminShell
    ? isViewer
      ? "Look only (no edits)"
      : "Admin"
    : isWarehouse
      ? "Warehouse"
      : isMechanic
        ? "Shop"
        : roleLabel(role);

  const subtitle = isAdminShell
    ? attentionTotal === 0
      ? "Nothing waiting — Live map and shortcuts below"
      : `${attentionTotal} real queue${attentionTotal === 1 ? "" : "s"} waiting`
    : isWarehouse
      ? attentionTotal === 0
        ? "Counter is clear"
        : `${attentionTotal} open at the counter / stock`
      : attentionTotal === 0
        ? "All clear"
        : `${attentionTotal} waiting`;

  return (
    <div className={`home home-clean home-role-${role}`}>
      <header className="home-hero">
        <div>
          <p className="home-kicker">{kicker}</p>
          <h1 className="home-title">Hi, {first}</h1>
          <p className="home-sub">{subtitle}</p>
        </div>
      </header>

      {error && (
        <div className="error" style={{ marginBottom: "0.85rem" }}>
          {error}
          <div style={{ marginTop: "0.5rem" }}>
            <button className="btn secondary" type="button" onClick={() => load()}>
              Retry
            </button>
          </div>
        </div>
      )}

      <NewHireSafetyCard />
      <ResponsibilityHomeCard />

      {/* Role-specific at-a-glance board */}
      <FocusGrid
        items={focusShown}
        calm={isAdminShell}
        title={
          isAdminShell
            ? "Waiting counts"
            : isWarehouse
              ? "Warehouse at a glance"
              : isMechanic
                ? "Shop at a glance"
                : "At a glance"
        }
        subtitle={
          isAdminShell
            ? waitingFocus.length > 0
              ? "Only the queues that have something waiting"
              : "Nothing in these queues"
            : isWarehouse
              ? "Vendors, shop drop-offs, warranties, bottles"
              : isMechanic
                ? "Urgent jobs, repair board, compliance & tracking"
                : "Status that matters for your role"
        }
      />

      {isAdmin ? <ClockinNudgeCard /> : null}

      {can(user, "viewDoneToday") ? <DoneTodayHomeCard /> : null}

      {(isWarehouse || isAdminShell) ? (
        <section className="home-section" aria-label="Pull for tomorrow">
          <div className="office-actions">
            <PullTomorrowHome />
          </div>
        </section>
      ) : null}

      <MyShortcuts />

      {!isAdminShell && isAzaliMiller(user) ? (
        <section className="home-section" aria-label="New construction">
          <div className="office-actions">
            <Link to="/new-construction" className="office-action">
              <span>
                <strong>New Azali house</strong>
                <span className="office-action-hint">RNC location and project</span>
              </span>
            </Link>
          </div>
        </section>
      ) : null}

      {isAdminShell ? (
        <section className="home-section home-launch-pad" aria-label="Daily doors">
          <div className="home-section-head">
            <h2>Daily doors</h2>
          </div>
          <div className="office-actions">
            <Link to="/day-board" className="office-action primary">
              <span>
                <strong>Today's jobs</strong>
                <span className="office-action-hint">Watch the day</span>
              </span>
            </Link>
            <Link to="/install-book" className="office-action">
              <span>
                <strong>Book install</strong>
                <span className="office-action-hint">Miller / Install + NC</span>
              </span>
            </Link>
            <Link to="/live" className="office-action">
              <span>
                <strong>Fleet map</strong>
                <span className="office-action-hint">Find a tech</span>
              </span>
            </Link>
            <Link to="/part-pickup" className="office-action">
              <span>
                <strong>Will-call</strong>
                <span className="office-action-hint">Parts at the store</span>
              </span>
            </Link>
            <Link to="/issues" className="office-action">
              <span>
                <strong>Repair board</strong>
                <span className="office-action-hint">Shop repairs</span>
              </span>
            </Link>
            <Link to="/time-off" className="office-action">
              <span>
                <strong>Time off</strong>
                <span className="office-action-hint">Approvals</span>
              </span>
            </Link>
            {isAzaliMiller(user) ? (
              <Link to="/new-construction" className="office-action">
                <span>
                  <strong>New Azali house</strong>
                  <span className="office-action-hint">RNC location and project</span>
                </span>
              </Link>
            ) : null}
            <Link to="/part-in-stock" className="office-action">
              <span>
                <strong>Part in stock</strong>
                <span className="office-action-hint">Search the catalog</span>
              </span>
            </Link>
          </div>
        </section>
      ) : null}

      <ActionRow items={actions} />

      {/* Mechanic only: tracking (parked off Admin Home — not daily attention spam) */}
      {isMechanic && trackingList.length > 0 && (
        <CollapsibleHomeSection
          id="tracking"
          title="Tracking issues"
          count={trackingList.length}
          link={{ to: "/live", label: "Map →" }}
          defaultOpen={false}
        >
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
        </CollapsibleHomeSection>
      )}

      {/* Recent fuel — collapsed; mileage flags parked off Admin Home */}
      {data && isMechanic && (
        <CollapsibleHomeSection
          id="recent_fuel"
          title="Recent activity"
          count={data.recent_fuel.length || undefined}
          link={can(user, "logFuel") ? { to: "/fuel", label: "Log →" } : undefined}
          defaultOpen={false}
        >
          <div className="card home-activity-card">
            {!data.recent_fuel.length ? (
              <p className="muted empty-tight">No fuel entries yet.</p>
            ) : (
              <ul className="home-feed">
                {data.recent_fuel.slice(0, 6).map((f) => (
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
        </CollapsibleHomeSection>
      )}
    </div>
  );
}

function DoneTodayHomeCard() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    api<{ items?: unknown[] }>("/done-today")
      .then((d) => setN((d.items || []).length))
      .catch(() => setN(null));
  }, []);
  return (
    <Link className="fs-card" to="/done-today">
      <strong>Done today{n == null ? "" : ` (${n})`}</strong>
      <div className="muted">Filled in automatically from what you did in the app.</div>
    </Link>
  );
}
