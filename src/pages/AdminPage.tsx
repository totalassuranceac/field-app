import { FormEvent, useEffect, useState } from "react";
import { api, can, Role } from "../api";
import { useAuth } from "../auth";

interface Employee {
  id: number;
  name: string;
  active: number;
  notes: string | null;
}

interface AdminUser {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  role: Role;
  employee_id: number | null;
  auth_provider: string;
  active: number;
}

export function AdminPage() {
  const { user } = useAuth();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  const [empName, setEmpName] = useState("");
  const [uName, setUName] = useState("");
  const [uUser, setUUser] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPass, setUPass] = useState("");
  const [uRole, setURole] = useState<Role>("driver");
  const [uEmp, setUEmp] = useState("");

  async function load() {
    const emp = await api<{ employees: Employee[] }>("/employees?all=1");
    setEmployees(emp.employees);
    if (can(user, "manageUsers")) {
      const u = await api<{ users: AdminUser[] }>("/users");
      setUsers(u.users);
    }
    if (can(user, "manageSettings")) {
      const s = await api<{ settings: Record<string, string> }>("/settings");
      setSettings(s.settings);
    }
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function addEmployee(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/employees", { method: "POST", body: JSON.stringify({ name: empName }) });
      setEmpName("");
      setOk("Employee added");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function addUser(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/users", {
        method: "POST",
        body: JSON.stringify({
          display_name: uName,
          username: uUser || undefined,
          email: uEmail || undefined,
          password: uPass || undefined,
          role: uRole,
          employee_id: uEmp ? Number(uEmp) : undefined,
        }),
      });
      setUName("");
      setUUser("");
      setUEmail("");
      setUPass("");
      setOk("User created");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(settings) });
      setOk("Settings saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  if (!can(user, "manageUsers") && !can(user, "manageEmployees")) {
    return <div className="error">Admin access required.</div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p>Employees, users, and mileage thresholds</p>
        </div>
      </div>
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}
      {ok && <div className="success" style={{ marginBottom: "1rem" }}>{ok}</div>}

      <div className="grid two">
        {can(user, "manageEmployees") && (
          <div className="card">
            <h2>Employees</h2>
            <form className="form" onSubmit={addEmployee} style={{ marginBottom: "1rem" }}>
              <label>
                Name
                <input value={empName} onChange={(e) => setEmpName(e.target.value)} required />
              </label>
              <button className="btn" type="submit">
                Add employee
              </button>
            </form>
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {employees.map((e) => (
                <li key={e.id}>
                  {e.name} {!e.active && <span className="badge">inactive</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {can(user, "manageUsers") && (
          <div className="card">
            <h2>Users</h2>
            <form className="form" onSubmit={addUser} style={{ marginBottom: "1rem" }}>
              <label>
                Display name
                <input value={uName} onChange={(e) => setUName(e.target.value)} required />
              </label>
              <label>
                Username (password login)
                <input value={uUser} onChange={(e) => setUUser(e.target.value)} />
              </label>
              <label>
                Email (Google / contact)
                <input value={uEmail} onChange={(e) => setUEmail(e.target.value)} />
              </label>
              <label>
                Password
                <input type="password" value={uPass} onChange={(e) => setUPass(e.target.value)} />
              </label>
              <label>
                Role
                <select value={uRole} onChange={(e) => setURole(e.target.value as Role)}>
                  <option value="admin">admin</option>
                  <option value="office">office</option>
                  <option value="driver">driver</option>
                  <option value="mechanic">mechanic</option>
                  <option value="viewer">viewer</option>
                </select>
              </label>
              <label>
                Linked employee
                <select value={uEmp} onChange={(e) => setUEmp(e.target.value)}>
                  <option value="">None</option>
                  {employees.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn" type="submit">
                Create user
              </button>
            </form>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Login</th>
                    <th>Role</th>
                    <th className="no-print">Password</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td>{u.display_name}</td>
                      <td>
                        {u.username || u.email || "—"}
                        <div className="muted">{u.auth_provider}</div>
                      </td>
                      <td>{u.role}</td>
                      <td className="no-print">
                        <button
                          className="btn secondary"
                          type="button"
                          onClick={async () => {
                            const pw = window.prompt(
                              `New password for ${u.display_name} (min 8 characters):`
                            );
                            if (!pw) return;
                            try {
                              await api(`/users/${u.id}/reset-password`, {
                                method: "POST",
                                body: JSON.stringify({ password: pw }),
                              });
                              setOk(`Password reset for ${u.display_name}`);
                            } catch (err) {
                              setError(err instanceof Error ? err.message : "Reset failed");
                            }
                          }}
                        >
                          Reset
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
              Create one login per employee (role: driver). Use Reset if they forget their password —
              their other sessions are signed out.
            </p>
          </div>
        )}

        {can(user, "manageSettings") && (
          <div className="card">
            <h2>Red flag thresholds</h2>
            <form className="form" onSubmit={saveSettings}>
              <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.88rem" }}>
                Tuned for Corpus Christi / local routes. Flags help catch wrong-vehicle fill-ups and
                odometer abuse without being so tight that normal multi-job days false-alarm.
              </p>
              <label>
                Miles between fill-ups that looks wrong (default 250)
                <input
                  value={settings.large_jump_miles || ""}
                  onChange={(e) => setSettings({ ...settings, large_jump_miles: e.target.value })}
                />
              </label>
              <label>
                Miles per day that looks wrong (default 180)
                <input
                  value={settings.large_jump_miles_per_day || ""}
                  onChange={(e) => setSettings({ ...settings, large_jump_miles_per_day: e.target.value })}
                />
              </label>
              <label>
                Compliance “expiring soon” window (days)
                <input
                  value={settings.expiring_soon_days || ""}
                  onChange={(e) => setSettings({ ...settings, expiring_soon_days: e.target.value })}
                />
              </label>
              <button className="btn" type="submit">
                Save settings
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
