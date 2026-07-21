import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, can, Role, roleLabel } from "../api";
import { useAuth } from "../auth";

interface Employee {
  id: number;
  name: string;
  active: number;
  phone: string | null;
  notes: string | null;
}

interface AdminUser {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  role: Role;
  employee_id: number | null;
  manager_user_id?: number | null;
  manager_name?: string | null;
  phone: string | null;
  must_change_password: number;
  auth_provider: string;
  active: number;
}

export function AdminPage() {
  const { user } = useAuth();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const usersTableRef = useRef<HTMLDivElement>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [tempPwNotice, setTempPwNotice] = useState("");
  const [busyUser, setBusyUser] = useState(false);
  const [busyEmp, setBusyEmp] = useState(false);
  const [justAddedId, setJustAddedId] = useState<number | null>(null);

  const [empName, setEmpName] = useState("");
  const [empPhone, setEmpPhone] = useState("");
  const [uName, setUName] = useState("");
  const [uUser, setUUser] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPass, setUPass] = useState("");
  const [uPhone, setUPhone] = useState("");
  const [uRole, setURole] = useState<Role>("driver");
  const [uManager, setUManager] = useState("");
  const [uEmp, setUEmp] = useState("");

  // ServiceTitan API
  const [stStatus, setStStatus] = useState<{
    configured: boolean;
    tenant_id: string | null;
    has_client_id: boolean;
    has_client_secret: boolean;
    has_app_key: boolean;
    last_status: string | null;
  } | null>(null);
  const [stTenant, setStTenant] = useState("");
  const [stClientId, setStClientId] = useState("");
  const [stClientSecret, setStClientSecret] = useState("");
  const [stAppKey, setStAppKey] = useState("");
  const [stBusy, setStBusy] = useState(false);
  const [stTestMsg, setStTestMsg] = useState("");

  function showFeedback(message: string, isError = false) {
    if (isError) {
      setOk("");
      setError(message);
    } else {
      setError("");
      setOk(message);
    }
    // Scroll confirmation into view (esp. on phone after long form)
    requestAnimationFrame(() => {
      feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  async function loadStStatus() {
    if (!can(user, "manageSettings")) return;
    try {
      const st = await api<{
        configured: boolean;
        tenant_id: string | null;
        has_client_id: boolean;
        has_client_secret: boolean;
        has_app_key: boolean;
        last_status: string | null;
      }>("/integrations/servicetitan/status");
      setStStatus(st);
      if (st.tenant_id) setStTenant(st.tenant_id);
    } catch {
      /* optional until deploy */
    }
  }

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
      await loadStStatus();
    }
  }

  /** Employee has a linked login (by employee_id or matching name). */
  function employeeHasAccount(emp: Employee): boolean {
    const empName = emp.name.trim().toLowerCase();
    return users.some((u) => {
      if (!u.active) return false;
      if (u.employee_id != null && Number(u.employee_id) === emp.id) return true;
      const dn = (u.display_name || "").trim().toLowerCase();
      return dn !== "" && dn === empName;
    });
  }

  const employeeAccountMap = useMemo(() => {
    const m = new Map<number, boolean>();
    for (const e of employees) m.set(e.id, employeeHasAccount(e));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, users]);

  async function saveStCredentials(e: FormEvent) {
    e.preventDefault();
    setStBusy(true);
    setStTestMsg("");
    try {
      // Only send fields the user filled — blank client/app/secret means "keep existing"
      const body: Record<string, string> = { tenant_id: stTenant.trim() };
      if (stClientId.trim()) body.client_id = stClientId.trim();
      if (stClientSecret.trim()) body.client_secret = stClientSecret.trim();
      if (stAppKey.trim()) body.app_key = stAppKey.trim();
      if (!stStatus?.configured && (!body.client_id || !body.client_secret || !body.app_key)) {
        showFeedback("First setup needs Tenant ID, Client ID, Client Secret, and App Key.", true);
        setStBusy(false);
        return;
      }
      await api("/integrations/servicetitan/credentials", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      setStClientSecret("");
      setStClientId("");
      setStAppKey("");
      await loadStStatus();
      showFeedback("ServiceTitan credentials saved. Click Test connection next.");
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Failed to save ST credentials", true);
    } finally {
      setStBusy(false);
    }
  }

  async function testStConnection() {
    setStBusy(true);
    setStTestMsg("");
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/servicetitan/test", {
        method: "POST",
        body: "{}",
      });
      setStTestMsg(r.detail);
      if (r.ok) showFeedback("ServiceTitan connection OK — pricebook API reachable.");
      else showFeedback(r.detail || "Connection failed", true);
      await loadStStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Test failed";
      setStTestMsg(msg);
      showFeedback(msg, true);
    } finally {
      setStBusy(false);
    }
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  // Clear “just added” highlight after a few seconds
  useEffect(() => {
    if (justAddedId == null) return;
    const t = window.setTimeout(() => setJustAddedId(null), 8000);
    return () => window.clearTimeout(t);
  }, [justAddedId]);

  async function addEmployee(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    setBusyEmp(true);
    try {
      await api("/employees", {
        method: "POST",
        body: JSON.stringify({ name: empName, phone: empPhone || null }),
      });
      const name = empName.trim();
      setEmpName("");
      setEmpPhone("");
      await load();
      showFeedback(`Employee added: ${name}`);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Failed to add employee", true);
    } finally {
      setBusyEmp(false);
    }
  }

  async function addUser(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    setTempPwNotice("");
    if (!uUser.trim()) {
      showFeedback("Username is required — that is their login.", true);
      return;
    }
    setBusyUser(true);
    try {
      const res = await api<{ user: AdminUser; temporary_password?: string }>("/users", {
        method: "POST",
        body: JSON.stringify({
          display_name: uName,
          username: uUser.trim().toLowerCase(),
          email: uEmail || undefined,
          password: uPass || undefined,
          phone: uPhone || undefined,
          role: uRole,
          employee_id: uEmp ? Number(uEmp) : undefined,
          manager_user_id: uManager ? Number(uManager) : null,
        }),
      });
      const created = res.user;
      setUName("");
      setUUser("");
      setUEmail("");
      setUPass("");
      setUPhone("");
      setUEmp("");
      setUManager("");
      setJustAddedId(created.id);
      await load();
      const login = created.username || uUser.trim().toLowerCase();
      showFeedback(`User added: ${created.display_name} (login: ${login})`);
      if (res.temporary_password) {
        setTempPwNotice(
          `Give them these credentials:\n• Username: ${login}\n• Temporary password: ${res.temporary_password}\nThey must change the password after first sign-in.`
        );
      }
      requestAnimationFrame(() => {
        usersTableRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Failed to create user", true);
    } finally {
      setBusyUser(false);
    }
  }

  async function resetPassword(u: AdminUser) {
    const pw = window.prompt(
      `Temporary password for ${u.display_name} (min 8 characters).\nLeave blank to auto-generate.\nThey will be asked to choose their own after login.`
    );
    if (pw === null) return;
    try {
      const res = await api<{ temporary_password?: string }>(`/users/${u.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: pw.trim() || undefined }),
      });
      const shown = res.temporary_password || pw;
      showFeedback(`Password reset for ${u.display_name}`);
      setTempPwNotice(
        `Temporary password for ${u.username || u.display_name}: ${shown} — they must change it after login.`
      );
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Reset failed", true);
    }
  }

  async function setActive(u: AdminUser, active: boolean) {
    const action = active ? "reactivate" : "deactivate";
    if (!window.confirm(`${action} ${u.display_name}?`)) return;
    try {
      await api(`/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
      await load();
      showFeedback(
        active ? `${u.display_name} reactivated` : `${u.display_name} deactivated (can't sign in)`
      );
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Update failed", true);
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(settings) });
      showFeedback("Settings saved");
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Failed", true);
    }
  }


  if (!can(user, "manageUsers") && !can(user, "manageEmployees")) {
    return <div className="error">Admin access required.</div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{can(user, "manageUsers") ? "Admin" : "People"}</h1>
          <p>
            {can(user, "manageUsers")
              ? "Everyone is listed as an employee. Logins use Field, Mechanic, Office, Warehouse, or Admin."
              : "Employee list and unit assignments"}
          </p>
        </div>
      </div>
      <div ref={feedbackRef}>
        {error && (
          <div className="error admin-feedback" role="alert">
            {error}
          </div>
        )}
        {ok && (
          <div className="success admin-feedback" role="status">
            <strong>✓ {ok}</strong>
          </div>
        )}
        {tempPwNotice && (
          <div className="success admin-feedback admin-feedback-creds" role="status">
            <strong>User ready — share login details</strong>
            <pre className="admin-creds">{tempPwNotice}</pre>
            <button
              className="btn secondary"
              type="button"
              onClick={() => setTempPwNotice("")}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      <div className="admin-people-grid">
        {can(user, "manageEmployees") && (
          <div className="card admin-card">
            <h2>Employees (everyone)</h2>
            <p className="muted admin-card-hint">
              <span className="emp-dot has-account" aria-hidden /> has login ·{" "}
              <span className="emp-dot no-account" aria-hidden /> no login yet
            </p>
            <form className="form admin-compact-form" onSubmit={addEmployee}>
              <label>
                Name
                <input value={empName} onChange={(e) => setEmpName(e.target.value)} required />
              </label>
              <label>
                Phone
                <input
                  value={empPhone}
                  onChange={(e) => setEmpPhone(e.target.value)}
                  placeholder="(361) 555-0100"
                  inputMode="tel"
                />
              </label>
              <button className="btn" type="submit" disabled={busyEmp}>
                {busyEmp ? "Adding…" : "Add employee"}
              </button>
            </form>
            <ul className="emp-account-list">
              {employees.map((e) => {
                const hasAcct = employeeAccountMap.get(e.id) === true;
                return (
                  <li
                    key={e.id}
                    className={`emp-account-row${hasAcct ? " has-account" : " no-account"}`}
                  >
                    <span
                      className={`emp-dot${hasAcct ? " has-account" : " no-account"}`}
                      title={hasAcct ? "Has a user login" : "No matching user account yet"}
                      aria-label={hasAcct ? "Has account" : "No account"}
                    />
                    <span className="emp-account-name">
                      {e.name}
                      {!e.active && <span className="badge">inactive</span>}
                    </span>
                    {e.phone ? <span className="muted emp-account-phone">{e.phone}</span> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {can(user, "manageUsers") && (
          <div className="card admin-card">
            <h2>Users (logins)</h2>
            <form className="form admin-compact-form" onSubmit={addUser}>
              <label>
                Display name
                <input value={uName} onChange={(e) => setUName(e.target.value)} required />
              </label>
              <label>
                Username (login)
                <input
                  value={uUser}
                  onChange={(e) => setUUser(e.target.value)}
                  required
                  autoComplete="off"
                  placeholder="firstname.lastname"
                />
              </label>
              <div className="form-row-2">
                <label>
                  Phone
                  <input
                    value={uPhone}
                    onChange={(e) => setUPhone(e.target.value)}
                    placeholder="(361) 555-0100"
                    inputMode="tel"
                  />
                </label>
                <label>
                  Email (optional)
                  <input value={uEmail} onChange={(e) => setUEmail(e.target.value)} />
                </label>
              </div>
              <label>
                Temporary password (optional)
                <input
                  type="text"
                  value={uPass}
                  onChange={(e) => setUPass(e.target.value)}
                  placeholder="Leave blank to auto-generate"
                  autoComplete="new-password"
                />
              </label>
              <p className="muted admin-card-hint">
                They sign in with username + temp password, then set their own in Settings.
              </p>
              <fieldset className="role-check-fieldset role-check-compact">
                <legend>Role</legend>
                <div className="role-chip-row">
                  {(
                    [
                      ["driver", "Field"],
                      ["mechanic", "Mechanic"],
                      ["office", "Office"],
                      ["warehouse", "Warehouse"],
                      ["admin", "Admin"],
                      ["viewer", "Viewer"],
                    ] as [Role, string][]
                  ).map(([value, label]) => (
                    <label
                      key={value}
                      className={`role-chip${uRole === value ? " active" : ""}`}
                    >
                      <input
                        type="radio"
                        name="new-user-role"
                        checked={uRole === value}
                        onChange={() => setURole(value)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="form-row-2">
                <label>
                  Manager
                  <select value={uManager} onChange={(e) => setUManager(e.target.value)}>
                    <option value="">None</option>
                    {users
                      .filter((u) => u.active && ["admin", "office", "mechanic"].includes(u.role))
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.display_name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Link employee
                  <select value={uEmp} onChange={(e) => setUEmp(e.target.value)}>
                    <option value="">None</option>
                    {employees.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {employeeAccountMap.get(e.id) ? " ✓" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button className="btn" type="submit" disabled={busyUser}>
                {busyUser ? "Creating…" : "Create user"}
              </button>
            </form>
            <div className="table-wrap admin-users-table" ref={usersTableRef}>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Login</th>
                    <th>Phone</th>
                    <th>Role</th>
                    <th>Manager</th>
                    <th>Employee</th>
                    <th className="no-print">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      className={u.id === justAddedId ? "row-just-added" : undefined}
                      style={{ opacity: u.active ? 1 : 0.55 }}
                    >
                      <td>
                        <span className="admin-cell-name">{u.display_name}</span>
                        {u.id === justAddedId && (
                          <span className="badge ok" style={{ marginLeft: "0.3rem" }}>
                            new
                          </span>
                        )}
                        {!u.active && <span className="badge">off</span>}
                        {!!u.must_change_password && (
                          <div className="muted" style={{ fontSize: "0.72rem" }}>
                            must set password
                          </div>
                        )}
                      </td>
                      <td>
                        <strong className="admin-cell-login">{u.username || "—"}</strong>
                        {u.email && (
                          <div className="muted admin-cell-email">{u.email}</div>
                        )}
                      </td>
                      <td className="admin-cell-phone">{u.phone || "—"}</td>
                      <td>{roleLabel(u.role)}</td>
                      <td>{u.manager_name || "—"}</td>
                      <td>
                        {u.employee_id
                          ? employees.find((e) => e.id === u.employee_id)?.name ||
                            `#${u.employee_id}`
                          : "—"}
                      </td>
                      <td className="no-print">
                        <div className="admin-user-actions">
                          <button
                            className="btn secondary btn-sm"
                            type="button"
                            onClick={() => resetPassword(u)}
                          >
                            Reset
                          </button>
                          {u.active ? (
                            <button
                              className="btn ghost btn-sm"
                              type="button"
                              onClick={() => setActive(u, false)}
                            >
                              Off
                            </button>
                          ) : (
                            <button
                              className="btn secondary btn-sm"
                              type="button"
                              onClick={() => setActive(u, true)}
                            >
                              On
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
              Username is their login. Reset password when they forget it or leave the company, then
              deactivate so they cannot sign in.
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
                  onChange={(e) =>
                    setSettings({ ...settings, large_jump_miles_per_day: e.target.value })
                  }
                />
              </label>
              <label>
                Compliance “expiring soon” window (days)
                <input
                  value={settings.expiring_soon_days || ""}
                  onChange={(e) => setSettings({ ...settings, expiring_soon_days: e.target.value })}
                />
              </label>
              <label>
                GPS “stale” after hours (default 6) — units with no update longer than this stand out
                <input
                  value={settings.gps_stale_hours || "6"}
                  onChange={(e) => setSettings({ ...settings, gps_stale_hours: e.target.value })}
                />
              </label>
              <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "0.5rem 0" }} />
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>Role phone numbers (SMS)</h3>
              <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.88rem" }}>
                Defaults used for emergency SMS and as text targets for techs. Set the shop line, the
                mechanic’s cell, and the office line (fallback for everyone else). Optional Twilio.
              </p>
              <label>
                Shop phone
                <input
                  value={settings.shop_sms_phone || ""}
                  onChange={(e) => setSettings({ ...settings, shop_sms_phone: e.target.value })}
                  placeholder="(361) 555-0199"
                  inputMode="tel"
                />
              </label>
              <label>
                Mechanic phone
                <input
                  value={settings.mechanic_sms_phone || ""}
                  onChange={(e) => setSettings({ ...settings, mechanic_sms_phone: e.target.value })}
                  placeholder="(361) 555-0101"
                  inputMode="tel"
                />
              </label>
              <label>
                Office phone (default for everyone else)
                <input
                  value={settings.office_sms_phone || ""}
                  onChange={(e) => setSettings({ ...settings, office_sms_phone: e.target.value })}
                  placeholder="(361) 555-0100"
                  inputMode="tel"
                />
              </label>
              <hr style={{ border: "none", borderTop: "1px solid var(--line)", margin: "0.5rem 0" }} />
              <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem" }}>Free phone alerts</h3>
              <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.88rem" }}>
                Fleet word: ntfy → <strong>{settings.ntfy_topic || "totalassurance"}</strong> (real
                emergencies — mechanic stays here). Admin tests use{" "}
                <strong>totalassurance-admin</strong> so the mechanic is not buzzed.
              </p>
              <label>
                Alert word (keep it easy — default is totalassurance)
                <input
                  value={settings.ntfy_topic || "totalassurance"}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ntfy_topic: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""),
                    })
                  }
                  placeholder="totalassurance"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                Discord webhook (optional)
                <input
                  value={settings.discord_webhook_url || ""}
                  onChange={(e) => setSettings({ ...settings, discord_webhook_url: e.target.value })}
                  placeholder="https://discord.com/api/webhooks/…"
                  autoComplete="off"
                />
              </label>
              <button className="btn" type="submit">
                Save settings
              </button>
            </form>
          </div>
        )}

        {can(user, "manageSettings") && (
          <div className="card">
            <h2>ServiceTitan API</h2>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.9rem" }}>
              Connect once so Inventory can pull material photos (and future pricebook sync). You
              need four values from ServiceTitan — free for your own company (private app).
            </p>

            <ol className="muted" style={{ fontSize: "0.88rem", paddingLeft: "1.25rem", marginTop: 0 }}>
              <li>
                Open{" "}
                <a href="https://developer.servicetitan.io" target="_blank" rel="noreferrer">
                  developer.servicetitan.io
                </a>{" "}
                → <strong>Login as Production Environment User</strong> with your ST admin login.
              </li>
              <li>
                <strong>My Apps → + New App</strong> — name it e.g. “Total Assurance Fleet”. Add
                your <strong>Tenant ID</strong>. Under API scopes enable at least{" "}
                <strong>Pricebook → View</strong> (and Inventory View if listed). Save and copy the{" "}
                <strong>Application Key</strong> (App Key).
              </li>
              <li>
                In ServiceTitan: <strong>Settings → Integrations → API Application Access</strong>.
                Tenant ID is top-right. Click <strong>Connect New App</strong>, pick your app,{" "}
                <strong>Allow Access</strong>, then copy <strong>Client ID</strong> and{" "}
                <strong>Generate</strong> Client Secret.
              </li>
              <li>Paste all four below → Save → Test connection.</li>
            </ol>

            <div
              className="muted"
              style={{
                fontSize: "0.85rem",
                marginBottom: "0.75rem",
                padding: "0.5rem 0.65rem",
                background: "var(--surface-2, #f4f5f7)",
                borderRadius: 6,
              }}
            >
              Status:{" "}
              {stStatus == null ? (
                "…"
              ) : stStatus.configured ? (
                <strong style={{ color: "var(--ok, #0a7)" }}>Configured</strong>
              ) : (
                <strong style={{ color: "var(--warn, #b75)" }}>Not configured</strong>
              )}
              {stStatus?.tenant_id ? ` · Tenant ${stStatus.tenant_id}` : ""}
              {stStatus
                ? ` · Client ID ${stStatus.has_client_id ? "✓" : "—"} · Secret ${
                    stStatus.has_client_secret ? "✓" : "—"
                  } · App Key ${stStatus.has_app_key ? "✓" : "—"}`
                : ""}
              {stStatus?.last_status ? (
                <>
                  <br />
                  Last: {stStatus.last_status}
                </>
              ) : null}
            </div>

            <form className="form" onSubmit={saveStCredentials}>
              <label>
                Tenant ID
                <input
                  value={stTenant}
                  onChange={(e) => setStTenant(e.target.value.trim())}
                  placeholder="e.g. 1234567890"
                  autoComplete="off"
                  inputMode="numeric"
                  required
                />
              </label>
              <label>
                Client ID
                <input
                  value={stClientId}
                  onChange={(e) => setStClientId(e.target.value.trim())}
                  placeholder={stStatus?.has_client_id ? "(saved — paste to replace)" : "cid.…"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label>
                Client Secret
                <input
                  type="password"
                  value={stClientSecret}
                  onChange={(e) => setStClientSecret(e.target.value)}
                  placeholder={
                    stStatus?.has_client_secret
                      ? "(saved — leave blank to keep, or paste new)"
                      : "Paste secret once"
                  }
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </label>
              <label>
                App Key (Application Key)
                <input
                  value={stAppKey}
                  onChange={(e) => setStAppKey(e.target.value.trim())}
                  placeholder={stStatus?.has_app_key ? "(saved — paste to replace)" : "ak.…"}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                <button className="btn" type="submit" disabled={stBusy}>
                  {stBusy ? "Saving…" : "Save credentials"}
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={stBusy}
                  onClick={() => void testStConnection()}
                >
                  Test connection
                </button>
              </div>
              {stTestMsg ? (
                <p
                  className="muted"
                  style={{ margin: "0.5rem 0 0", fontSize: "0.88rem", wordBreak: "break-word" }}
                >
                  {stTestMsg}
                </p>
              ) : null}
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
