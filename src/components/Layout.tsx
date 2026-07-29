import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { api, can, isViewer, roleLabel, usesAdminShell, type Role } from "../api";
import { useAuth } from "../auth";
import {
  clearNavReturn,
  readNavReturn,
  returnBarLabel,
} from "../navReturn";
import { NotificationBell } from "./NotificationBell";
import { OfflineBanner } from "./OfflineBanner";

type NavItem = {
  to: string;
  label: string;
  show: boolean;
  badge?: number;
  /** Show badge even when 0 (e.g. warehouse vendor-run counter) */
  badgeAlways?: boolean;
  badgeLabel?: string;
};

function NavBadge({
  count,
  always,
  label,
}: {
  count: number;
  always?: boolean;
  label?: string;
}) {
  if (!always && count <= 0) return null;
  const display = count > 99 ? "99+" : count;
  const zero = count <= 0;
  return (
    <span
      className={`nav-badge${zero ? " is-zero" : " is-hot"}`}
      aria-label={label || (zero ? "None waiting" : `${count} waiting`)}
      title={label || (zero ? "Caught up" : `${count} to pick up`)}
    >
      {display}
    </span>
  );
}

function NavGroup({ title, items }: { title: string; items: NavItem[] }) {
  const visible = items.filter((l) => l.show);
  if (!visible.length) return null;
  return (
    <div className="nav-group">
      <div className="nav-group-title">{title}</div>
      {visible.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.to === "/"}
          className={({ isActive }) => (isActive ? "active" : undefined)}
        >
          <span>{l.label}</span>
          {l.badge != null && (
            <NavBadge count={l.badge} always={l.badgeAlways} label={l.badgeLabel} />
          )}
        </NavLink>
      ))}
    </div>
  );
}

/** Collapsible category for admin nav — click header to expand */
function NavCategory({
  id,
  title,
  hint,
  items,
  open,
  onToggle,
}: {
  id: string;
  title: string;
  hint?: string;
  items: NavItem[];
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const visible = items.filter((l) => l.show);
  if (!visible.length) return null;
  return (
    <div className={`nav-category${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="nav-category-toggle"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(id);
        }}
      >
        <span className="nav-category-label">
          <strong>{title}</strong>
          {hint ? <span className="nav-category-hint">{hint}</span> : null}
        </span>
        <span className="nav-category-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="nav-category-items">
          {visible.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              end={l.to === "/"}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <span>{l.label}</span>
              {l.badge != null && (
                <NavBadge count={l.badge} always={l.badgeAlways} label={l.badgeLabel} />
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

/** Which collapsible nav section a path belongs to (same for every role). */
function pathCategory(pathname: string): string {
  if (
    pathname.startsWith("/vehicles") ||
    pathname.startsWith("/live") ||
    pathname.startsWith("/yard") ||
    pathname.startsWith("/alerts") ||
    pathname.startsWith("/downtime") ||
    pathname.startsWith("/reports") ||
    pathname.startsWith("/fuel") ||
    pathname.startsWith("/inspections")
  ) {
    return "fleet";
  }
  if (
    pathname.startsWith("/inventory") ||
    pathname.startsWith("/part-pickup") ||
    pathname.startsWith("/vendor-runs") ||
    pathname.startsWith("/parts-dropoff") ||
    pathname.startsWith("/truck-stock") ||
    pathname.startsWith("/parts-receipts") ||
    pathname.startsWith("/assets") ||
    pathname.startsWith("/warranties")
  ) {
    return "warehouse";
  }
  if (pathname.startsWith("/issues") || pathname.startsWith("/service")) {
    return "shop";
  }
  if (
    pathname.startsWith("/admin") ||
    pathname.startsWith("/roles") ||
    pathname.startsWith("/audit") ||
    pathname.startsWith("/handbook") ||
    pathname.startsWith("/howto") ||
    pathname.startsWith("/time-off") ||
    pathname.startsWith("/tool-loans") ||
    pathname.startsWith("/reviews") ||
    pathname.startsWith("/notifications") ||
    pathname.startsWith("/settings")
  ) {
    return "company";
  }
  return "home";
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, realUser, viewAsRole, setViewAsRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const navReturn = readNavReturn(location.state);
  const returnPath = navReturn?.returnTo?.split("?")[0] || "";
  // Hide bar when already on the return destination (e.g. back on Notifications)
  const showReturnBar = Boolean(navReturn?.returnTo) && returnPath !== location.pathname;

  // Clear return marker once user is back on that page
  useEffect(() => {
    if (returnPath && returnPath === location.pathname) {
      clearNavReturn();
    }
  }, [location.pathname, returnPath]);
  const [unread, setUnread] = useState(0);
  /** Parts waiting at vendors — warehouse glance counter (shows 0 when clear) */
  const [vendorWaiting, setVendorWaiting] = useState(0);
  /** Parts left at shop after field pickup — ready for warehouse */
  const [dropoffWaiting, setDropoffWaiting] = useState(0);
  /** Fuel receipts needing OCR verify (admin/office) */
  const [fuelOcrPending, setFuelOcrPending] = useState(0);
  /** Time-off approvals waiting for this manager / office */
  const [timeOffPending, setTimeOffPending] = useState(0);
  /** Tool loan approvals waiting for manager / office */
  const [toolLoanPending, setToolLoanPending] = useState(0);
  /** Open tech repair requests waiting for shop to schedule */
  const [openRepairsCount, setOpenRepairsCount] = useState(0);
  /** Open collapsible nav section (same Command Center style for every role) */
  const [openCat, setOpenCat] = useState<string>(() => pathCategory(location.pathname));
  const sidebarClass = open ? "sidebar open" : "sidebar";
  // White/light logo artwork on dark navy sidebar
  const logoSrc = "/logo-light.png";
  const isDriver = user?.role === "driver";
  const isOffice = user?.role === "office";
  const isWarehouse = user?.role === "warehouse";
  const isMechanic = user?.role === "mechanic";
  const isTrueAdmin = realUser?.role === "admin";
  const adminShell = usesAdminShell(user) && !viewAsRole;
  const readOnly = isViewer(user);
  const showVendorCounter =
    isWarehouse || isOffice || adminShell || user?.role === "admin" || user?.role === "viewer";
  const showRepairBadge =
    isMechanic || isOffice || adminShell || user?.role === "admin" || user?.role === "viewer";
  const showFuelOcrBadge = can(user, "editFuel") || adminShell;

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const d = await api<{ unread: number }>("/notifications");
        if (!cancelled) setUnread(d.unread || 0);
      } catch {
        /* ignore */
      }
      if (showVendorCounter) {
        try {
          // Lightweight COUNT only — full list was timing out D1 on large catalogs
          const vr = await api<{ waiting?: number }>("/inventory/part-pickups/count").catch(
            () => api<{ waiting?: number }>("/inventory/vendor-runs/count")
          );
          if (!cancelled) setVendorWaiting(Number(vr.waiting) || 0);
        } catch {
          /* migration optional */
        }
        try {
          const dr = await api<{ waiting?: number }>("/inventory/parts-dropoffs/count");
          if (!cancelled) setDropoffWaiting(Number(dr.waiting) || 0);
        } catch {
          /* migration optional */
        }
      }
      if (showRepairBadge) {
        try {
          const ir = await api<{ issues?: unknown[]; needs_schedule?: number }>(
            "/issues?report=needs_schedule"
          );
          if (!cancelled) {
            setOpenRepairsCount(
              typeof ir.needs_schedule === "number"
                ? ir.needs_schedule
                : (ir.issues || []).length
            );
          }
        } catch {
          /* optional */
        }
      }
      if (showFuelOcrBadge) {
        try {
          const fo = await api<{ pending?: number }>("/fuel/receipt-review/count");
          if (!cancelled) setFuelOcrPending(Number(fo.pending) || 0);
        } catch {
          /* optional */
        }
      }
      try {
        const to = await api<{ pending?: number }>("/time-off/pending-count");
        if (!cancelled) setTimeOffPending(Number(to.pending) || 0);
      } catch {
        /* optional */
      }
      try {
        const tl = await api<{ pending?: number }>("/tool-loans/pending-count");
        if (!cancelled) setToolLoanPending(Number(tl.pending) || 0);
      } catch {
        /* optional */
      }
    }
    // Defer badge poll so first paint is not blocked (longer delay on cellular)
    const start = window.setTimeout(() => void poll(), 1200);
    const id = window.setInterval(poll, 45_000);
    const onVendorChange = () => void poll();
    window.addEventListener("vendor-runs-changed", onVendorChange);
    window.addEventListener("parts-dropoffs-changed", onVendorChange);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
      window.clearInterval(id);
      window.removeEventListener("vendor-runs-changed", onVendorChange);
      window.removeEventListener("parts-dropoffs-changed", onVendorChange);
    };
  }, [user?.id, showVendorCounter, showRepairBadge, showFuelOcrBadge]);

  useEffect(() => {
    document.title = "Total Assurance";
  }, []);

  // Keep the category matching the page open while browsing (all roles)
  useEffect(() => {
    setOpenCat(pathCategory(location.pathname));
  }, [location.pathname]);

  // Close mobile menu after navigating to a page
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // When the phone menu is open, lock page scroll so only the drawer list scrolls
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyWidth: body.style.width,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
    };
    html.classList.add("nav-open");
    body.classList.add("nav-open");
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    // position:fixed stops background scroll on iOS/Android without killing drawer touch
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";

    // Ensure the scroll pane can receive touch (some WebViews need this)
    const scroller = document.getElementById("app-nav-scroll");
    if (scroller) {
      scroller.style.overflowY = "scroll";
      scroller.style.setProperty("-webkit-overflow-scrolling", "touch");
    }

    return () => {
      html.classList.remove("nav-open");
      body.classList.remove("nav-open");
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      body.style.position = prev.bodyPosition;
      body.style.top = prev.bodyTop;
      body.style.width = prev.bodyWidth;
      body.style.left = prev.bodyLeft;
      body.style.right = prev.bodyRight;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  const vendorNavBadge = {
    badge: vendorWaiting,
    badgeAlways: true as const,
    badgeLabel:
      vendorWaiting > 0
        ? `${vendorWaiting} part${vendorWaiting === 1 ? "" : "s"} to pick up`
        : "No parts waiting for pickup",
  };

  const dropoffNavBadge = {
    badge: dropoffWaiting,
    badgeAlways: true as const,
    badgeLabel:
      dropoffWaiting > 0
        ? `${dropoffWaiting} drop-off${dropoffWaiting === 1 ? "" : "s"} at the shop`
        : "No parts waiting at the shop",
  };

  /**
   * Same Command Center categories for every role — only permitted links show.
   * Empty categories are hidden automatically by NavCategory.
   */
  const homeNav: NavItem[] = [
    {
      to: "/",
      label: adminShell ? "Command center" : "Home",
      show: true,
    },
  ];

  // Fleet: trucks, map, fuel, checks, ops reports
  const fleetNav: NavItem[] = [
    {
      to: "/vehicles",
      label: isWarehouse ? "Trucks" : "Vehicles",
      // Admin, warehouse (trucks), mechanic — not field/office clutter
      show: adminShell || isWarehouse || isMechanic,
    },
    {
      to: "/live",
      label: "Live map",
      // Not on warehouse short-list (they focus on parts)
      show: adminShell || isOffice || isDriver || isMechanic,
    },
    {
      to: "/yard",
      label: "Yard walk",
      show: adminShell || isMechanic,
    },
    {
      to: "/fuel",
      label: can(user, "logFuel") ? "Log fuel" : "Fuel log",
      show: adminShell || can(user, "logFuel") || can(user, "viewReports"),
    },
    {
      to: "/fuel/receipt-review",
      label: "Receipt verify",
      show: adminShell || can(user, "editFuel"),
      ...(showFuelOcrBadge && fuelOcrPending > 0
        ? {
            badge: fuelOcrPending,
            badgeAlways: false as const,
            badgeLabel: `${fuelOcrPending} receipt${fuelOcrPending === 1 ? "" : "s"} need verify`,
          }
        : {}),
    },
    {
      to: "/inspections",
      label: "Weekly checks",
      show: adminShell || isDriver || isMechanic || isOffice,
    },
    {
      to: "/alerts",
      label: "Mileage flags",
      show: adminShell || isMechanic || (isOffice && can(user, "viewAlerts")),
    },
    {
      to: "/downtime",
      label: "Downtime",
      show:
        adminShell ||
        isMechanic ||
        (isOffice && (can(user, "viewReports") || can(user, "manageIssues"))),
    },
    {
      to: "/reports",
      label: "Reports",
      show: adminShell || isMechanic || (isOffice && can(user, "viewReports")),
    },
  ];

  // Warehouse: parts, pickups, bottles, warranties
  const warehouseNav: NavItem[] = [
    {
      to: "/inventory",
      label: adminShell ? "Inventory & pickup" : "Inventory",
      show: adminShell || can(user, "viewInventory") || isWarehouse,
    },
    {
      to: "/part-pickup",
      label: "Part pickup",
      show: true,
      ...(showVendorCounter ? vendorNavBadge : {}),
    },
    {
      to: "/parts-dropoff",
      label: "Parts drop-off",
      show: true,
      ...(showVendorCounter ? dropoffNavBadge : {}),
    },
    {
      to: "/truck-stock",
      label: "Truck stock count",
      show: true,
    },
    {
      to: "/parts-receipts",
      label: "Parts receipts",
      show: can(user, "logPartsPurchase") || can(user, "viewPartsPurchase"),
    },
    {
      to: "/assets",
      label: isDriver
        ? "My truck gear"
        : isWarehouse
          ? "Bottles & gear"
          : adminShell
            ? "Bottles & equipment"
            : "Assets",
      show: can(user, "viewCompanyAssets"),
    },
    {
      to: "/warranties",
      label: "Warranties",
      show: true,
    },
  ];

  // Shop: repairs & service
  const shopNav: NavItem[] = [
    {
      to: "/issues",
      label:
        can(user, "manageIssues") || adminShell
          ? "Repairs & shop"
          : can(user, "reportIssues")
            ? "Request repair"
            : "Repairs",
      show:
        adminShell ||
        can(user, "reportIssues") ||
        can(user, "manageIssues") ||
        user?.role === "viewer",
      ...(openRepairsCount != null && can(user, "manageIssues")
        ? {
            badge: openRepairsCount,
            badgeAlways: false,
            badgeLabel:
              openRepairsCount > 0
                ? `${openRepairsCount} need scheduling`
                : "No open repair requests",
          }
        : {}),
    },
    {
      to: "/service",
      label: "Oil / service",
      show: adminShell || isMechanic,
    },
  ];

  // Company: people, help, inbox
  const companyNav: NavItem[] = [
    {
      to: "/admin",
      label: adminShell
        ? "People & settings"
        : can(user, "manageEmployees")
          ? "People"
          : "Admin",
      show: adminShell || can(user, "manageUsers") || can(user, "manageEmployees"),
    },
    {
      to: "/time-off",
      label: "Time Off Request",
      show: true,
      ...(timeOffPending > 0
        ? {
            badge: timeOffPending,
            badgeAlways: false as const,
            badgeLabel: `${timeOffPending} time-off request${timeOffPending === 1 ? "" : "s"} to review`,
          }
        : {}),
    },
    {
      to: "/tool-loans",
      label: "Tool Loan Request",
      show: true,
      ...(toolLoanPending > 0
        ? {
            badge: toolLoanPending,
            badgeAlways: false as const,
            badgeLabel: `${toolLoanPending} tool loan request${toolLoanPending === 1 ? "" : "s"} to review`,
          }
        : {}),
    },
    { to: "/howto", label: "How-to", show: true },
    { to: "/handbook", label: "Handbook", show: true },
    {
      to: "/notifications",
      label: "Notifications",
      show: true,
      badge: unread,
    },
    {
      to: "/roles",
      label: "Role simulator",
      show: isTrueAdmin && !viewAsRole,
    },
    {
      to: "/audit",
      label: "Audit log",
      show: can(user, "viewAudit"),
    },
  ];

  function toggleCat(id: string) {
    setOpenCat((prev) => (prev === id ? "" : id));
  }

  return (
    <div className="app-shell">
      {open && (
        <button
          type="button"
          className="nav-backdrop no-print"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={sidebarClass} id="app-nav-drawer">
        <div className="drawer-head">
          <div className="drawer-brand">
            <img src={logoSrc} alt="Total Assurance A/C & Heating" className="drawer-logo-img" />
          </div>
          <button
            type="button"
            className="drawer-close no-print"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        {/* Dedicated scroll pane — whole menu list + account row (Android-safe) */}
        <div className="drawer-scroll" id="app-nav-scroll">
          <nav className="nav">
            <NavGroup title="Home" items={homeNav} />
            <NavCategory
              id="fleet"
              title="Fleet"
              hint="Trucks · fuel · checks · map"
              items={fleetNav}
              open={openCat === "fleet"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="warehouse"
              title="Warehouse"
              hint="Parts · bottles · warranties"
              items={warehouseNav}
              open={openCat === "warehouse"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="shop"
              title="Shop"
              hint="Repairs · service"
              items={shopNav}
              open={openCat === "shop"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="company"
              title="Company"
              hint="People · alerts · handbook"
              items={companyNav}
              open={openCat === "company"}
              onToggle={toggleCat}
            />
          </nav>
          <NavLink
            to="/settings"
            className={({ isActive }) => `user-box user-box-link${isActive ? " active" : ""}`}
            onClick={() => setOpen(false)}
            title="Open settings"
          >
            <div className="role">{roleLabel(user?.role)}</div>
            <div className="user-box-name">{user?.display_name}</div>
            <div className="user-box-hint">
              {isOffice || isWarehouse ? "Settings · sign out" : "Tap for settings · sign out"}
            </div>
          </NavLink>
        </div>
      </aside>
      <div className="content-column">
        <OfflineBanner />
        {readOnly && (
          <div className="viewer-readonly-bar no-print" role="status">
            <strong>Viewer · look around only</strong>
            <span>Same layout as Admin — you can’t change or submit data</span>
          </div>
        )}
        {isTrueAdmin && (
          <div
            className={`view-as-bar no-print${viewAsRole ? " is-preview" : ""}`}
            title={
              viewAsRole
                ? `Previewing ${roleLabel(viewAsRole)} UI — API still uses Admin`
                : "Preview another role’s screens"
            }
          >
            <span className="view-as-prefix">View as</span>
            <select
              className="view-as-select"
              value={viewAsRole || "admin"}
              aria-label="View as role"
              onChange={(e) => {
                const v = e.target.value as Role | "admin";
                setViewAsRole(v === "admin" ? null : (v as Role));
              }}
            >
              <option value="admin">Admin</option>
              <option value="warehouse">Warehouse</option>
              <option value="office">Office</option>
              <option value="driver">Field</option>
              <option value="mechanic">Mechanic</option>
              <option value="viewer">Viewer</option>
            </select>
            {viewAsRole ? (
              <button type="button" className="view-as-exit" onClick={() => setViewAsRole(null)}>
                Exit
              </button>
            ) : null}
          </div>
        )}
        {/* Dark header: logo only (+ menu) */}
        <div className="topbar-mobile no-print">
          <div className="topbar-row topbar-row-brand">
            <div className="topbar-side topbar-side-left">
              <button
                type="button"
                className={`topbar-hamburger${open ? " is-open" : ""}`}
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls="app-nav-drawer"
                aria-label={open ? "Close menu" : "Open menu"}
              >
                <span className="topbar-hamburger-lines" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </button>
            </div>
            <div className="topbar-logo-center">
              <img
                src={logoSrc}
                alt="Total Assurance A/C & Heating"
                className="topbar-logo-img"
              />
            </div>
            <div className="topbar-side topbar-side-right" aria-hidden="true" />
          </div>
        </div>
        <div className="content-body">
          {/* Same page color as main — right side, opposite Command Center */}
          <div className="content-tools no-print">
            <div className="topbar-actions content-tools-actions">
              {showVendorCounter && (
                <NavLink
                  to="/part-pickup"
                  className={`topbar-vendor-chip${vendorWaiting > 0 ? " is-hot" : " is-clear"}`}
                  title={
                    vendorWaiting > 0
                      ? `${vendorWaiting} parts waiting for pickup`
                      : "Part pickup clear — nothing waiting"
                  }
                  aria-label={
                    vendorWaiting > 0
                      ? `${vendorWaiting} parts to pick up`
                      : "Part pickup clear"
                  }
                >
                  <span className="topbar-vendor-chip-label">Pickup</span>
                  <span className="topbar-vendor-chip-n">
                    {vendorWaiting > 99 ? "99+" : vendorWaiting}
                  </span>
                </NavLink>
              )}
              <NotificationBell />
            </div>
          </div>
          {/* Always-visible when you opened a page from Notifications (or similar) */}
          {showReturnBar && navReturn ? (
            <div className="return-bar no-print" role="navigation" aria-label="Go back">
              <button
                type="button"
                className="return-bar-btn"
                onClick={() => {
                  const dest = navReturn.returnTo;
                  clearNavReturn();
                  navigate(dest);
                }}
              >
                ← {returnBarLabel(navReturn)}
              </button>
            </div>
          ) : null}
          <main className="main">{children}</main>
        </div>
      </div>
    </div>
  );
}
