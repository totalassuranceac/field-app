import { useState } from "react";
import { NavLink } from "react-router-dom";
import { can, roleLabel } from "../api";
import { useAuth } from "../auth";

type NavItem = { to: string; label: string; show: boolean };

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const sidebarClass = open ? "sidebar open" : "sidebar";
  const logoSrc = "/logo-light.png";

  const daily: NavItem[] = [
    { to: "/", label: "Home", show: true },
    { to: "/fuel", label: "Log fuel", show: can(user, "logFuel") || can(user, "viewReports") },
    { to: "/inspections", label: "Inspections", show: true },
    {
      to: "/issues",
      label: can(user, "manageIssues") ? "Repairs & schedule" : "Report issue",
      show: can(user, "reportIssues") || can(user, "manageIssues"),
    },
  ];

  const fleet: NavItem[] = [
    { to: "/live", label: "Live map", show: true },
    { to: "/alerts", label: "Mileage flags", show: can(user, "logFuel") || can(user, "manageAlerts") },
    { to: "/yard", label: "Yard walk", show: true },
    { to: "/vehicles", label: "Vehicles", show: true },
    { to: "/downtime", label: "Downtime", show: can(user, "viewReports") || can(user, "manageIssues") },
    { to: "/reports", label: "Reports", show: can(user, "viewReports") },
  ];

  const account: NavItem[] = [
    { to: "/settings", label: "Settings", show: true },
    {
      to: "/admin",
      label: "Admin",
      show: can(user, "manageUsers") || can(user, "manageEmployees"),
    },
    { to: "/audit", label: "Audit log", show: can(user, "viewAudit") },
  ];

  function renderGroup(title: string, items: NavItem[]) {
    const visible = items.filter((l) => l.show);
    if (!visible.length) return null;
    return (
      <div className="nav-group" key={title}>
        <div className="nav-group-title">{title}</div>
        {visible.map((l) => (
          <NavLink
            key={l.to}
            to={l.to}
            end={l.to === "/"}
            className={({ isActive }) => (isActive ? "active" : undefined)}
          >
            {l.label}
          </NavLink>
        ))}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className={sidebarClass}>
        <div className="brand">
          <img src={logoSrc} alt="Total Assurance A/C & Heating" />
          <span>Fleet Tracker</span>
        </div>
        <nav className="nav" onClick={() => setOpen(false)}>
          {renderGroup("Daily work", daily)}
          {renderGroup("Fleet", fleet)}
          {renderGroup("Account", account)}
        </nav>
        <div className="user-box">
          <div className="role">{roleLabel(user?.role)}</div>
          <div>{user?.display_name}</div>
          <NavLink
            to="/settings"
            className="btn ghost"
            style={{ marginTop: "0.55rem", width: "100%", textAlign: "center" }}
            onClick={() => setOpen(false)}
          >
            Settings
          </NavLink>
          <button
            className="btn ghost"
            style={{ marginTop: "0.45rem", width: "100%" }}
            onClick={() => logout()}
            type="button"
          >
            Sign out
          </button>
        </div>
      </aside>
      <div>
        <div className="topbar-mobile no-print">
          <img src={logoSrc} alt="Total Assurance" />
          <button className="btn ghost" onClick={() => setOpen((v) => !v)} type="button">
            {open ? "Close" : "Menu"}
          </button>
        </div>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
