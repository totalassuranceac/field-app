import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api, appBrandName, can, isViewer, roleLabel, usesAdminShell, type Role } from "../api";
import { useAuth } from "../auth";
import { NotificationBell } from "./NotificationBell";
import { OfflineBanner } from "./OfflineBanner";

type NavItem = { to: string; label: string; show: boolean; badge?: number };

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
          {l.badge != null && l.badge > 0 && (
            <span className="nav-badge" aria-label={`${l.badge} unread`}>
              {l.badge > 99 ? "99+" : l.badge}
            </span>
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
              {l.badge != null && l.badge > 0 && (
                <span className="nav-badge" aria-label={`${l.badge} unread`}>
                  {l.badge > 99 ? "99+" : l.badge}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

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
    pathname.startsWith("/reviews") ||
    pathname.startsWith("/messages") ||
    pathname.startsWith("/notifications") ||
    pathname.startsWith("/settings")
  ) {
    return "company";
  }
  return "home";
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, realUser, viewAsRole, setViewAsRole } = useAuth();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [adminOpen, setAdminOpen] = useState<string>(() => pathCategory(location.pathname));
  const sidebarClass = open ? "sidebar open" : "sidebar";
  // White/light logo artwork on dark navy sidebar
  const logoSrc = "/logo-light.png";
  const isDriver = user?.role === "driver";
  const isOffice = user?.role === "office";
  const isWarehouse = user?.role === "warehouse";
  const isTrueAdmin = realUser?.role === "admin";
  const brand = appBrandName(user?.role);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const d = await api<{ unread: number }>("/notifications");
        if (!cancelled) setUnread(d.unread || 0);
      } catch {
        /* ignore */
      }
    }
    poll();
    const id = window.setInterval(poll, 20_000);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") poll();
    });
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [user?.id]);

  useEffect(() => {
    document.title = `${brand} · Total Assurance`;
  }, [brand]);

  const adminShell = usesAdminShell(user) && !viewAsRole;
  const readOnly = isViewer(user);

  // Keep the category matching the page open while browsing
  useEffect(() => {
    if (adminShell) {
      setAdminOpen(pathCategory(location.pathname));
    }
  }, [location.pathname, adminShell]);

  const officeNav: NavItem[] = [
    { to: "/", label: "Home", show: true },
    { to: "/live", label: "Live map", show: true },
    { to: "/issues", label: "Scheduled repairs", show: true },
    { to: "/inventory", label: "Inventory", show: can(user, "viewInventory") },
    { to: "/assets", label: "Assets", show: can(user, "viewCompanyAssets") },
    { to: "/warranties", label: "Warranties", show: true },
    { to: "/howto", label: "How-to", show: true },
    { to: "/reviews", label: "Our reviews", show: true },
    { to: "/handbook", label: "Handbook", show: true },
    { to: "/messages", label: "Messages", show: true },
    { to: "/notifications", label: "Notifications", show: true, badge: unread },
  ];
  const officeAccount: NavItem[] = [
    { to: "/admin", label: "People", show: can(user, "manageEmployees") },
  ];

  const warehouseNav: NavItem[] = [
    { to: "/", label: "Home", show: true },
    { to: "/inventory", label: "Inventory", show: true },
    { to: "/assets", label: "Bottles & gear", show: true },
    { to: "/warranties", label: "Warranties", show: true },
    { to: "/vehicles", label: "Trucks", show: true },
    { to: "/messages", label: "Messages", show: true },
    { to: "/notifications", label: "Notifications", show: true, badge: unread },
  ];
  const warehouseAccount: NavItem[] = [
    { to: "/howto", label: "How-to", show: true },
    { to: "/reviews", label: "Our reviews", show: true },
    { to: "/handbook", label: "Handbook", show: true },
    { to: "/settings", label: "Settings", show: true },
  ];

  const daily: NavItem[] = [
    { to: "/", label: "Home", show: true },
    { to: "/warranties", label: "Warranties", show: true },
    { to: "/messages", label: "Messages", show: true },
    { to: "/notifications", label: "Notifications", show: true, badge: unread },
    { to: "/howto", label: "How-to", show: true },
    { to: "/reviews", label: "Our reviews", show: true },
    { to: "/handbook", label: "Handbook", show: true },
    {
      to: "/fuel",
      label: "Log fuel",
      show: can(user, "logFuel") || (!isDriver && can(user, "viewReports")),
    },
    {
      to: "/inspections",
      label: "Weekly checks",
      show: true,
    },
    {
      to: "/assets",
      label: isDriver ? "My truck gear" : "Assets",
      show: can(user, "viewCompanyAssets"),
    },
    {
      to: "/issues",
      label: can(user, "manageIssues")
        ? "Repairs & shop"
        : can(user, "reportIssues")
          ? "Request repair"
          : "Repairs",
      show: can(user, "reportIssues") || can(user, "manageIssues") || user?.role === "viewer",
    },
  ];

  const fleet: NavItem[] = [
    { to: "/live", label: "Live map", show: true },
    {
      to: "/alerts",
      label: "Mileage flags",
      show: !isDriver && can(user, "viewAlerts"),
    },
    { to: "/yard", label: "Yard walk", show: !isDriver },
    { to: "/vehicles", label: "Vehicles", show: !isDriver },
    {
      to: "/downtime",
      label: "Downtime",
      show: !isDriver && (can(user, "viewReports") || can(user, "manageIssues")),
    },
    { to: "/reports", label: "Reports", show: !isDriver && can(user, "viewReports") },
  ];

  const account: NavItem[] = [
    {
      to: "/admin",
      label: "Admin",
      show: can(user, "manageUsers") || can(user, "manageEmployees"),
    },
    {
      to: "/roles",
      label: "Role simulator",
      show: isTrueAdmin && !viewAsRole,
    },
    {
      to: "/inventory",
      label: "Inventory",
      show: can(user, "viewInventory"),
    },
    {
      to: "/assets",
      label: "Assets",
      show: can(user, "viewCompanyAssets") && !isDriver,
    },
    { to: "/howto", label: "How-to", show: true },
    { to: "/reviews", label: "Our reviews", show: true },
    { to: "/handbook", label: "Handbook", show: true },
    { to: "/audit", label: "Audit log", show: can(user, "viewAudit") },
  ];

  // ——— Admin categories (click to expand) ———
  const adminHome: NavItem[] = [{ to: "/", label: "Command center", show: true }];

  const adminFleet: NavItem[] = [
    { to: "/vehicles", label: "Vehicles", show: true },
    { to: "/live", label: "Live map", show: true },
    { to: "/yard", label: "Yard walk", show: true },
    { to: "/fuel", label: "Fuel log", show: true },
    { to: "/inspections", label: "Weekly checks", show: true },
    { to: "/alerts", label: "Mileage flags", show: true },
    { to: "/downtime", label: "Downtime", show: true },
    { to: "/reports", label: "Reports", show: true },
  ];

  const adminWarehouse: NavItem[] = [
    { to: "/inventory", label: "Inventory & pickup", show: true },
    { to: "/assets", label: "Bottles & equipment", show: true },
    { to: "/warranties", label: "Warranties", show: true },
  ];

  const adminShop: NavItem[] = [
    { to: "/issues", label: "Repairs & shop", show: true },
    { to: "/service", label: "Oil / service", show: true },
  ];

  const adminCompany: NavItem[] = [
    { to: "/admin", label: "People & settings", show: true },
    { to: "/howto", label: "How-to", show: true },
    { to: "/reviews", label: "Our reviews", show: true },
    { to: "/handbook", label: "Handbook", show: true },
    { to: "/messages", label: "Messages", show: true },
    { to: "/notifications", label: "Notifications", show: true, badge: unread },
    { to: "/roles", label: "Role simulator", show: isTrueAdmin && !viewAsRole },
    { to: "/audit", label: "Audit log", show: can(user, "viewAudit") },
  ];

  function toggleAdminCat(id: string) {
    setAdminOpen((prev) => (prev === id ? "" : id));
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
      <aside className={sidebarClass}>
        <div className="brand">
          <img src={logoSrc} alt="Total Assurance A/C & Heating" />
          <span>{brand}</span>
        </div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {isWarehouse ? (
            <>
              <NavGroup title="Warehouse" items={warehouseNav} />
              <NavGroup title="Account" items={warehouseAccount} />
            </>
          ) : isOffice ? (
            <>
              <NavGroup title="Office" items={officeNav} />
              <NavGroup title="Account" items={officeAccount} />
            </>
          ) : adminShell ? (
            <>
              <NavGroup title="Home" items={adminHome} />
              <NavCategory
                id="fleet"
                title="Fleet"
                hint="Trucks · fuel · checks · map"
                items={adminFleet}
                open={adminOpen === "fleet"}
                onToggle={toggleAdminCat}
              />
              <NavCategory
                id="warehouse"
                title="Warehouse"
                hint="Parts · bottles · warranties"
                items={adminWarehouse}
                open={adminOpen === "warehouse"}
                onToggle={toggleAdminCat}
              />
              <NavCategory
                id="shop"
                title="Shop"
                hint="Repairs · service"
                items={adminShop}
                open={adminOpen === "shop"}
                onToggle={toggleAdminCat}
              />
              <NavCategory
                id="company"
                title="Company"
                hint="People · messages · handbook"
                items={adminCompany}
                open={adminOpen === "company"}
                onToggle={toggleAdminCat}
              />
            </>
          ) : (
            <>
              <NavGroup title="Daily work" items={daily} />
              <NavGroup title="Fleet" items={fleet} />
              <NavGroup title="Account" items={account} />
            </>
          )}
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
        <div className="topbar-mobile no-print">
          <div className="brand topbar-brand">
            <img src={logoSrc} alt="Total Assurance A/C & Heating" />
            <span>{brand}</span>
          </div>
          <div className="topbar-actions">
            <NotificationBell />
            <button
              className="btn ghost topbar-menu-btn"
              onClick={() => setOpen((v) => !v)}
              type="button"
              aria-expanded={open}
              aria-label={open ? "Close menu" : "Open menu"}
            >
              {open ? "Close" : "Menu"}
            </button>
          </div>
        </div>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
