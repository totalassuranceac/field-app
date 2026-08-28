import { Link } from "react-router-dom";
import {
  ALL_PERMISSIONS,
  permissionsForRole,
  roleLabel,
  type Role,
} from "../api";
import { useAuth } from "../auth";

const ROLES: Role[] = [
  "admin",
  "supervisor",
  "warehouse",
  "office",
  "driver",
  "mechanic",
  "viewer",
];

const FEATURES: Array<{ path: string; label: string; need?: string; note?: string }> = [
  { path: "/inventory", label: "Inventory / pickup / stock", need: "viewInventory" },
  { path: "/assets", label: "Company assets", need: "viewCompanyAssets" },
  { path: "/warranties", label: "Warranty drop-off", note: "All signed-in roles" },
  { path: "/fuel", label: "Fuel log", need: "logFuel" },
  { path: "/inspections", label: "Weekly checks", note: "Field + shop" },
  { path: "/issues", label: "Repairs", need: "reportIssues" },
  { path: "/vehicles", label: "Vehicles", need: "manageVehicles" },
  { path: "/yard", label: "Yard walk", need: "manageVehicles" },
  { path: "/live", label: "Live map", need: "viewLiveMap" },
  { path: "/alerts", label: "Mileage flags", need: "viewAlerts" },
  { path: "/reports", label: "Reports", need: "viewReports" },
  { path: "/handbook", label: "Employee handbook", note: "Everyone" },
  { path: "/admin", label: "People / admin", need: "manageEmployees" },
  { path: "/audit", label: "Audit log", need: "viewAudit" },
  { path: "/settings", label: "Settings", note: "All (admin for system settings)" },
];

export function RolesPage() {
  const { user, realUser, viewAsRole, setViewAsRole } = useAuth();
  const isTrueAdmin = realUser?.role === "admin" && !realUser?.is_warehouse;

  if (!isTrueAdmin) {
    return (
      <div className="page">
        <div className="error">Admin only — role simulator.</div>
      </div>
    );
  }

  return (
    <div className="page roles-page">
      <div className="page-header">
        <div>
          <h1>Role simulator</h1>
          <p>
            You are logged in as <strong>{realUser?.display_name}</strong> (Admin). Your credentials
            unlock every API. Use <strong>Simulate role</strong> in the top bar to see each role’s
            menus and screens. While previewing, the UI is restricted but the server still trusts
            Admin.
          </p>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Quick switch</h2>
        <div className="roles-switch-row">
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              className={`btn ${
                (r === "admin" && !viewAsRole) || viewAsRole === r ? "" : "secondary"
              }`}
              onClick={() => setViewAsRole(r === "admin" ? null : r)}
            >
              {roleLabel(r)}
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: "0.82rem", marginBottom: 0 }}>
          Current preview:{" "}
          <strong>{viewAsRole ? roleLabel(viewAsRole) : "Admin (full)"}</strong>
          {user?.role !== "admin" ? ` · effective role ${roleLabel(user?.role)}` : ""}
        </p>
      </div>

      <div className="card" style={{ overflowX: "auto" }}>
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Permission matrix</h2>
        <p className="muted" style={{ fontSize: "0.82rem" }}>
          Admin column is all ✓. Other columns show what that role’s UI allows.
        </p>
        <table className="roles-matrix">
          <thead>
            <tr>
              <th>Permission</th>
              {ROLES.map((r) => (
                <th key={r}>{roleLabel(r)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ALL_PERMISSIONS.map((p) => (
              <tr key={p}>
                <td>
                  <code>{p}</code>
                </td>
                {ROLES.map((r) => {
                  const ok = permissionsForRole(r)[p];
                  return (
                    <td key={r} className={ok ? "roles-yes" : "roles-no"}>
                      {ok ? "✓" : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>Feature smoke links (as Admin)</h2>
        <p className="muted" style={{ fontSize: "0.82rem" }}>
          Open each screen with full access. Then simulate Field / Warehouse to confirm the same
          URLs look correct for them.
        </p>
        <ul className="roles-feature-list">
          {FEATURES.map((f) => (
            <li key={f.path}>
              <Link to={f.path}>{f.label}</Link>
              <span className="muted">
                {f.need ? ` · needs ${f.need}` : f.note ? ` · ${f.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: "1.05rem" }}>How to test each role</h2>
        <ol className="roles-howto">
          <li>
            Stay on <strong>Admin (full access)</strong> and walk the feature list above.
          </li>
          <li>
            Switch to <strong>Warehouse</strong> — confirm Inventory + Assets first, pickup/handoff,
            bottle swap.
          </li>
          <li>
            Switch to <strong>Field</strong> — fuel, warranties (Take photo), my truck gear, weekly
            checks, handbook.
          </li>
          <li>
            Switch to <strong>Office</strong> — home becomes office map/repairs style; inventory view.
          </li>
          <li>
            Switch to <strong>Mechanic</strong> — repairs/shop, service, yard.
          </li>
          <li>
            Switch to <strong>Viewer</strong> — mostly read-only fleet views.
          </li>
          <li>
            Tap <strong>Back to Admin</strong> when done.
          </li>
        </ol>
      </div>
    </div>
  );
}
