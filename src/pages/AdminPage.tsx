import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, can, isViewer, Role, roleLabel } from "../api";
import { useAuth } from "../auth";

/** US-style display: (361) 555-0100 — leaves international-ish numbers alone. */
function formatPhone(raw: string | null | undefined): string {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (!s) return "";
  const d = s.replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) {
    return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  }
  if (d.length === 10) {
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (d.length === 7) {
    return `${d.slice(0, 3)}-${d.slice(3)}`;
  }
  // Already has punctuation or odd length — return trimmed original
  return s;
}

interface Employee {
  id: number;
  name: string;
  active: number;
  phone: string | null;
  notes: string | null;
  rides_with_employee_id?: number | null;
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
  /** 1 when password_hash is set */
  has_password?: number;
  /** 1 when open invite or still needs password setup */
  invite_pending?: number;
  invite_expires_at?: string | null;
}

type UserMatch = {
  kind: "user";
  id: number;
  display_name: string;
  username: string | null;
  email?: string | null;
  role: string;
  employee_id: number | null;
  phone: string | null;
  active: number;
  score: number;
  reasons: string[];
};

type EmpMatch = {
  kind: "employee";
  id: number;
  name: string;
  phone: string | null;
  active: number;
  score: number;
  reasons: string[];
};

type MatchPayload = {
  needs_confirm?: boolean;
  message?: string;
  users?: UserMatch[];
  employees?: EmpMatch[];
};

export function AdminPage() {
  const { user } = useAuth();
  const feedbackRef = useRef<HTMLDivElement>(null);
  const usersTableRef = useRef<HTMLDivElement>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  /** Invite link or (legacy) temp password text to share with the new user */
  const [inviteNotice, setInviteNotice] = useState(() => {
    try {
      return sessionStorage.getItem("admin_invite_notice") || "";
    } catch {
      return "";
    }
  });
  const [inviteUrl, setInviteUrl] = useState(() => {
    try {
      return sessionStorage.getItem("admin_invite_url") || "";
    } catch {
      return "";
    }
  });
  const [busyUser, setBusyUser] = useState(false);
  const [busyEmp, setBusyEmp] = useState(false);
  const [justAddedId, setJustAddedId] = useState<number | null>(null);

  /** Edit login (username / resend invite) — survives lost one-time banner */
  const [loginEdit, setLoginEdit] = useState<AdminUser | null>(null);
  const [loginEditName, setLoginEditName] = useState("");
  const [loginEditUser, setLoginEditUser] = useState("");
  const [loginEditBusy, setLoginEditBusy] = useState(false);
  const loginEditRef = useRef<HTMLDivElement>(null);

  function persistInvite(notice: string, url: string) {
    setInviteNotice(notice);
    setInviteUrl(url);
    try {
      if (notice) sessionStorage.setItem("admin_invite_notice", notice);
      else sessionStorage.removeItem("admin_invite_notice");
      if (url) sessionStorage.setItem("admin_invite_url", url);
      else sessionStorage.removeItem("admin_invite_url");
    } catch {
      /* private mode */
    }
  }

  function clearInviteBanner() {
    persistInvite("", "");
  }

  function openLoginEdit(u: AdminUser) {
    setLoginEdit(u);
    setLoginEditName(u.display_name);
    setLoginEditUser(u.username || "");
    setError("");
    requestAnimationFrame(() => {
      loginEditRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function closeLoginEdit() {
    setLoginEdit(null);
    setLoginEditBusy(false);
  }

  function isPendingSetup(u: AdminUser): boolean {
    return (
      Number(u.invite_pending) === 1 ||
      Number(u.must_change_password) === 1 ||
      Number(u.has_password) === 0
    );
  }

  const [empName, setEmpName] = useState("");
  const [empPhone, setEmpPhone] = useState("");
  /** Pending “is this the same person?” when name/phone matches an existing login */
  const [empMatch, setEmpMatch] = useState<MatchPayload | null>(null);
  const [uName, setUName] = useState("");
  const [uUser, setUUser] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPass, setUPass] = useState("");
  const [uPhone, setUPhone] = useState("");
  const [uRole, setURole] = useState<Role>("driver");
  const [uManager, setUManager] = useState("");
  const [uEmp, setUEmp] = useState("");
  const [userMatchWarn, setUserMatchWarn] = useState<string | null>(null);
  /** After admin confirms "create login anyway" for similar employee names */
  const skipUserEmpMatchRef = useRef(false);

  // Click employee name → edit panel (name/phone + role / login link)
  const [editEmp, setEditEmp] = useState<Employee | null>(null);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [editRidesWith, setEditRidesWith] = useState("");
  const [editLinkedUserId, setEditLinkedUserId] = useState("");
  const [editRole, setEditRole] = useState<Role>("driver");
  const [editCreateLogin, setEditCreateLogin] = useState(false);
  const [editUsername, setEditUsername] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const editPanelRef = useRef<HTMLDivElement>(null);

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

  /** Handbook acks — clear only from Admin settings (not handbook roster) */
  const [handbookRoster, setHandbookRoster] = useState<
    Array<{
      id: number;
      display_name: string;
      role: string;
      acknowledged: boolean;
      acknowledged_at?: string;
    }>
  >([]);
  const [handbookBusyId, setHandbookBusyId] = useState<number | null>(null);

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
    // Admin writes + viewer browse
    if (can(user, "manageUsers") || isViewer(user)) {
      const u = await api<{ users: AdminUser[] }>("/users");
      setUsers(u.users);
    }
    if (can(user, "manageSettings") || isViewer(user)) {
      const s = await api<{ settings: Record<string, string> }>("/settings").catch(() => ({
        settings: {} as Record<string, string>,
      }));
      setSettings(s.settings || {});
      if (can(user, "manageSettings")) await loadStStatus();
    }
    // Handbook ack roster for admin clear-controls (settings area)
    if (user?.role === "admin" || isViewer(user)) {
      const hb = await api<{
        roster?: Array<{
          id: number;
          display_name: string;
          role: string;
          acknowledged: boolean;
          acknowledged_at?: string;
        }>;
      }>("/handbook/status").catch(() => ({ roster: [] }));
      setHandbookRoster(hb.roster || []);
    }
  }

  async function clearHandbookAck(row: {
    id: number;
    display_name: string;
  }) {
    if (user?.role !== "admin") return;
    if (
      !window.confirm(
        `Clear handbook acknowledgment for ${row.display_name}?\n\nThey will need to open the handbook again and re-confirm. This cannot be undone from their side.`
      )
    ) {
      return;
    }
    setHandbookBusyId(row.id);
    try {
      await api(`/handbook/acknowledgments/${row.id}`, { method: "DELETE" });
      showFeedback(`Cleared handbook ack for ${row.display_name}`);
      const hb = await api<{
        roster?: Array<{
          id: number;
          display_name: string;
          role: string;
          acknowledged: boolean;
          acknowledged_at?: string;
        }>;
      }>("/handbook/status").catch(() => ({ roster: [] }));
      setHandbookRoster(hb.roster || []);
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Could not clear acknowledgment", true);
    } finally {
      setHandbookBusyId(null);
    }
  }

  /** Linked login for an employee (prefer employee_id, then exact name match). */
  function userForEmployee(emp: Employee): AdminUser | undefined {
    const byId = users.find((u) => u.employee_id != null && Number(u.employee_id) === emp.id);
    if (byId) return byId;
    const empName = emp.name.trim().toLowerCase();
    return users.find(
      (u) => u.active && (u.display_name || "").trim().toLowerCase() === empName
    );
  }

  /** Employee has a linked login (by employee_id or matching name). */
  function employeeHasAccount(emp: Employee): boolean {
    return Boolean(userForEmployee(emp));
  }

  function openEmployeeEdit(emp: Employee) {
    setEditEmp(emp);
    setEditName(emp.name);
    setEditPhone(emp.phone ? formatPhone(emp.phone) : "");
    setEditActive(emp.active !== 0);
    setEditRidesWith(
      emp.rides_with_employee_id ? String(emp.rides_with_employee_id) : ""
    );
    const linked = userForEmployee(emp);
    setEditLinkedUserId(linked ? String(linked.id) : "");
    setEditRole((linked?.role as Role) || "driver");
    setEditCreateLogin(false);
    setEditUsername(
      linked?.username ||
        emp.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ".")
          .replace(/^\.+|\.+$/g, "")
          .slice(0, 32)
    );
    setError("");
    setOk("");
    requestAnimationFrame(() => {
      editPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }

  function closeEmployeeEdit() {
    setEditEmp(null);
    setEditCreateLogin(false);
  }

  async function saveEmployeeEdit(e: FormEvent) {
    e.preventDefault();
    if (!editEmp) return;
    if (!editName.trim()) {
      showFeedback("Name is required", true);
      return;
    }
    const canUsers = can(user, "manageUsers");
    setEditBusy(true);
    setError("");
    setOk("");
    try {
      // 1) Employee record
      await api(`/employees/${editEmp.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          phone: formatPhone(editPhone) || null,
          active: editActive,
          rides_with_employee_id: editRidesWith ? Number(editRidesWith) : null,
        }),
      });

      let note = `Saved ${editName.trim()}`;
      if (editRidesWith) {
        const partner = employees.find((e) => e.id === Number(editRidesWith));
        if (partner) note += ` · rides with ${partner.name}`;
      }

      if (canUsers) {
        const linkId =
          editLinkedUserId && editLinkedUserId !== "none" ? Number(editLinkedUserId) : null;
        const previously = userForEmployee(editEmp);

        if (editCreateLogin && !linkId) {
          // Create a new login for this employee
          if (!editUsername.trim()) {
            showFeedback("Username is required to create a login", true);
            setEditBusy(false);
            return;
          }
          const res = await api<{
            user: AdminUser;
            invite_url?: string | null;
            temporary_password?: string | null;
          }>("/users", {
            method: "POST",
            body: JSON.stringify({
              display_name: editName.trim(),
              username: editUsername.trim().toLowerCase(),
              phone: formatPhone(editPhone) || undefined,
              role: editRole,
              employee_id: editEmp.id,
            }),
          });
          const login = res.user.username || editUsername;
          note = `Saved ${editName.trim()} · login @${login} (${roleLabel(editRole)})`;
          if (res.invite_url) {
            persistInvite(
              `Send them this link (one-time, ~7 days):\n${res.invite_url}\n\n• Username to type: ${login}\n• They create their password and are signed in immediately.\n\nTip: Banner stays until dismissed. Use Edit login on their user row to fix username or resend.`,
              res.invite_url
            );
          } else if (res.temporary_password) {
            persistInvite(
              `Give them:\n• Username: ${login}\n• Password: ${res.temporary_password}`,
              ""
            );
          }
        } else if (linkId) {
          // Unlink previous different user if needed
          if (previously && previously.id !== linkId && Number(previously.employee_id) === editEmp.id) {
            await api(`/users/${previously.id}`, {
              method: "PATCH",
              body: JSON.stringify({ employee_id: null }),
            });
          }
          // Clear other holder of this link
          const taken = users.find(
            (x) => x.active && x.id !== linkId && Number(x.employee_id) === editEmp.id
          );
          if (taken) {
            await api(`/users/${taken.id}`, {
              method: "PATCH",
              body: JSON.stringify({ employee_id: null }),
            });
          }
          await api(`/users/${linkId}`, {
            method: "PATCH",
            body: JSON.stringify({
              employee_id: editEmp.id,
              role: editRole,
              phone: formatPhone(editPhone) || undefined,
              display_name: editName.trim(),
            }),
          });
          note = `Saved ${editName.trim()} · role ${roleLabel(editRole)}`;
        } else if (previously && Number(previously.employee_id) === editEmp.id) {
          // Unlink only
          await api(`/users/${previously.id}`, {
            method: "PATCH",
            body: JSON.stringify({ employee_id: null }),
          });
          note = `Saved ${editName.trim()} · login unlinked`;
        }
      }

      await load();
      showFeedback(note);
      closeEmployeeEdit();
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Could not save employee", true);
    } finally {
      setEditBusy(false);
    }
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

  async function createEmployee(opts: {
    force?: boolean;
    link_user_id?: number | null;
  } = {}) {
    const name = empName.trim();
    if (!name) {
      showFeedback("Name required", true);
      return;
    }
    setBusyEmp(true);
    setError("");
    setOk("");
    try {
      const res = await api<{
        employee?: Employee;
        linked_user?: { id: number; display_name: string; username: string | null } | null;
        needs_confirm?: boolean;
      }>("/employees", {
        method: "POST",
        body: JSON.stringify({
          name,
          phone: formatPhone(empPhone.trim()) || null,
          force: opts.force === true,
          link_user_id: opts.link_user_id ?? undefined,
        }),
      });
      setEmpMatch(null);
      setEmpName("");
      setEmpPhone("");
      await load();
      if (res.linked_user) {
        showFeedback(
          `Employee added: ${name} · linked to login ${res.linked_user.username || res.linked_user.display_name}`
        );
      } else {
        showFeedback(`Employee added: ${name}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data) {
        const payload = err.data as MatchPayload;
        if (payload.needs_confirm) {
          setEmpMatch(payload);
          setError("");
          setOk("");
          return;
        }
      }
      showFeedback(err instanceof Error ? err.message : "Failed to add employee", true);
    } finally {
      setBusyEmp(false);
    }
  }

  async function addEmployee(e: FormEvent) {
    e.preventDefault();
    setEmpMatch(null);
    await createEmployee();
  }

  /** Soft client-side check: similar employee when creating a login without a link */
  function findSimilarEmployeesForUser(displayName: string): Employee[] {
    const norm = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const a = norm(displayName);
    if (!a) return [];
    const aTokens = a.split(" ").filter((t) => t.length >= 2);
    return employees
      .filter((e) => {
        const b = norm(e.name);
        if (!b) return false;
        if (a === b) return true;
        const bTokens = b.split(" ").filter((t) => t.length >= 2);
        if (!aTokens.length || !bTokens.length) return false;
        if (aTokens.every((t) => bTokens.includes(t)) || bTokens.every((t) => aTokens.includes(t)))
          return true;
        const aLast = aTokens[aTokens.length - 1];
        const bLast = bTokens[bTokens.length - 1];
        return Boolean(aLast && aLast === bLast && aLast.length >= 3);
      })
      .slice(0, 5);
  }

  async function createUserAccount() {
    if (!uUser.trim()) {
      showFeedback("Username is required — that is their login.", true);
      return;
    }
    setBusyUser(true);
    setError("");
    setOk("");
    clearInviteBanner();
    try {
      const res = await api<{
        user: AdminUser;
        invite_url?: string | null;
        temporary_password?: string | null;
      }>("/users", {
        method: "POST",
        body: JSON.stringify({
          display_name: uName,
          username: uUser.trim().toLowerCase(),
          email: uEmail || undefined,
          password: uPass || undefined,
          phone: formatPhone(uPhone) || undefined,
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
      setUserMatchWarn(null);
      skipUserEmpMatchRef.current = false;
      setJustAddedId(created.id);
      await load();
      const login = created.username || uUser.trim().toLowerCase();
      showFeedback(`User added: ${created.display_name} (login: ${login})`);
      if (res.invite_url) {
        persistInvite(
          `Send them this link (one-time, ~7 days):\n${res.invite_url}\n\n• Username to type: ${login}\n• They create their password and are signed in immediately.\n\nTip: Banner stays until dismissed. Use Edit login to fix username or resend.`,
          res.invite_url
        );
      } else if (res.temporary_password) {
        persistInvite(
          `Give them:\n• Username: ${login}\n• Password: ${res.temporary_password}`,
          ""
        );
      }
      requestAnimationFrame(() => {
        usersTableRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Failed to create user", true);
    } finally {
      setBusyUser(false);
    }
  }

  async function addUser(e: FormEvent) {
    e.preventDefault();
    setError("");
    setOk("");
    clearInviteBanner();
    if (!uUser.trim()) {
      showFeedback("Username is required — that is their login.", true);
      return;
    }
    // If no employee linked, warn about similar people before creating
    if (!uEmp && !skipUserEmpMatchRef.current) {
      const similar = findSimilarEmployeesForUser(uName);
      if (similar.length) {
        setUserMatchWarn(
          similar.map((s) => `${s.name}${s.phone ? ` (${s.phone})` : ""}`).join(" · ")
        );
        return;
      }
    }
    setUserMatchWarn(null);
    await createUserAccount();
  }

  /** Preferred: send join link so they set their own password (no temp password). */
  async function sendInviteLink(
    u: AdminUser,
    opts?: { username?: string; display_name?: string; skipConfirm?: boolean }
  ) {
    const un = (opts?.username || u.username || "").trim().toLowerCase();
    if (!un) {
      showFeedback("User needs a username before you can send an invite link", true);
      return false;
    }
    if (
      !opts?.skipConfirm &&
      !window.confirm(
        `Send ${opts?.display_name || u.display_name} a join link?\n\nThey open the link, type username “${un}”, create a password, and are signed in.\nAny existing password is cleared until they finish.`
      )
    ) {
      return false;
    }
    try {
      const res = await api<{ invite_url?: string; username?: string }>(`/users/${u.id}/invite`, {
        method: "POST",
        body: JSON.stringify({
          username: un,
          display_name: opts?.display_name?.trim() || undefined,
        }),
      });
      showFeedback(`Invite link ready for ${opts?.display_name || u.display_name}`);
      if (res.invite_url) {
        const login = res.username || un;
        persistInvite(
          `Send them this link (one-time, ~7 days):\n${res.invite_url}\n\n• Username to type: ${login}\n• They create their password and are signed in immediately.\n\nTip: This banner stays until you dismiss it — you can also open Edit login anytime to resend.`,
          res.invite_url
        );
        requestAnimationFrame(() => {
          feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      }
      await load();
      return true;
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Invite failed", true);
      return false;
    }
  }

  /** Save username/name and optionally re-issue invite in one step. */
  async function saveLoginEdit(e: FormEvent, alsoInvite: boolean) {
    e.preventDefault();
    if (!loginEdit) return;
    const un = loginEditUser.trim().toLowerCase();
    if (!un) {
      showFeedback("Username is required", true);
      return;
    }
    if (!/^[a-z0-9._-]{2,40}$/i.test(un)) {
      showFeedback("Username: 2–40 characters, letters/numbers . _ - only", true);
      return;
    }
    setLoginEditBusy(true);
    try {
      if (alsoInvite) {
        const okInvite = await sendInviteLink(loginEdit, {
          username: un,
          display_name: loginEditName.trim() || loginEdit.display_name,
          skipConfirm: true,
        });
        if (okInvite) closeLoginEdit();
      } else {
        await api(`/users/${loginEdit.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            username: un,
            display_name: loginEditName.trim() || loginEdit.display_name,
          }),
        });
        await load();
        showFeedback(`Saved login @${un} for ${loginEditName.trim() || loginEdit.display_name}`);
        closeLoginEdit();
      }
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Could not save login", true);
    } finally {
      setLoginEditBusy(false);
    }
  }

  async function resetPassword(u: AdminUser) {
    // Default: invite link. Optional typed password only if admin insists.
    const choice = window.prompt(
      `Password setup for ${u.display_name}\n\nLeave blank → send a join link (recommended).\nOr type a password (min 8) if you must set one yourself.`,
      ""
    );
    if (choice === null) return;
    try {
      if (!choice.trim()) {
        const res = await api<{ invite_url?: string; username?: string }>(
          `/users/${u.id}/reset-password`,
          {
            method: "POST",
            body: JSON.stringify({}),
          }
        );
        showFeedback(`Join link ready for ${u.display_name}`);
        if (res.invite_url) {
          persistInvite(
            `Send them this link (one-time, ~7 days):\n${res.invite_url}\n\n• Username to type: ${res.username || u.username}\n• They create their password and are signed in immediately.\n\nTip: Banner stays until dismissed. Use Edit login to fix username or resend.`,
            res.invite_url
          );
          requestAnimationFrame(() => {
            feedbackRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          });
        }
        await load();
        return;
      }
      if (choice.trim().length < 8) {
        showFeedback("Password must be at least 8 characters", true);
        return;
      }
      await api(`/users/${u.id}/reset-password`, {
        method: "POST",
        body: JSON.stringify({ password: choice.trim() }),
      });
      showFeedback(`Password set for ${u.display_name}`);
      persistInvite(
        `Give them:\n• Username: ${u.username || u.display_name}\n• Password: ${choice.trim()}\nThey can change it later in Settings.`,
        ""
      );
      await load();
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

  /** Link / unlink an existing login to an employee (any time after create). */
  async function linkUserEmployee(u: AdminUser, employeeId: string) {
    const empId = employeeId === "" || employeeId === "none" ? null : Number(employeeId);
    if (empId != null && Number.isNaN(empId)) return;
    // Prevent two logins silently claiming the same employee — confirm if taken
    if (empId != null) {
      const taken = users.find(
        (x) => x.active && x.id !== u.id && Number(x.employee_id) === empId
      );
      if (taken) {
        if (
          !confirm(
            `${employees.find((e) => e.id === empId)?.name || "That employee"} is already linked to ${taken.display_name}. Move the link to ${u.display_name}?`
          )
        ) {
          return;
        }
        try {
          await api(`/users/${taken.id}`, {
            method: "PATCH",
            body: JSON.stringify({ employee_id: null }),
          });
        } catch {
          /* continue — may still fail on unique later */
        }
      }
    }
    try {
      await api(`/users/${u.id}`, {
        method: "PATCH",
        body: JSON.stringify({ employee_id: empId }),
      });
      await load();
      if (empId == null) {
        showFeedback(`Unlinked employee from ${u.display_name}`);
      } else {
        const en = employees.find((e) => e.id === empId)?.name || `#${empId}`;
        showFeedback(`Linked ${u.display_name} → ${en}`);
      }
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Could not update link", true);
    }
  }

  /** Employees available to link (prefer unlinked, but allow reassign). */
  const employeesForLink = useMemo(() => {
    const linkedIds = new Set(
      users.filter((u) => u.employee_id != null).map((u) => Number(u.employee_id))
    );
    return [...employees].sort((a, b) => {
      const aL = linkedIds.has(a.id) ? 1 : 0;
      const bL = linkedIds.has(b.id) ? 1 : 0;
      if (aL !== bL) return aL - bL;
      return a.name.localeCompare(b.name);
    });
  }, [employees, users]);

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    try {
      await api("/settings", { method: "PUT", body: JSON.stringify(settings) });
      showFeedback("Settings saved");
    } catch (err) {
      showFeedback(err instanceof Error ? err.message : "Failed", true);
    }
  }


  const canEditPeople =
    can(user, "manageUsers") || can(user, "manageEmployees");
  const canBrowsePeople = canEditPeople || isViewer(user);
  const readOnly = isViewer(user);

  if (!canBrowsePeople) {
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
        {inviteNotice && (
          <div className="success admin-feedback admin-feedback-creds" role="status">
            <strong>Share with the user</strong>
            <pre className="admin-creds">{inviteNotice}</pre>
            <div className="admin-match-actions" style={{ marginTop: "0.5rem" }}>
              {inviteUrl && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(inviteUrl).then(
                      () => showFeedback("Invite link copied"),
                      () => showFeedback("Could not copy — select the link above", true)
                    );
                  }}
                >
                  Copy link
                </button>
              )}
              <button
                className="btn secondary"
                type="button"
                onClick={() => clearInviteBanner()}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {loginEdit && can(user, "manageUsers") && (
        <div className="card admin-card admin-login-edit" ref={loginEditRef}>
          <h2>Edit login · {loginEdit.display_name}</h2>
          <p className="muted admin-card-hint">
            Fix a mistyped username, then save or save &amp; resend their join link. Open invites
            stay valid with the corrected username.
            {isPendingSetup(loginEdit) ? (
              <>
                {" "}
                <strong>Pending setup</strong>
                {loginEdit.invite_expires_at
                  ? ` · invite expires ${String(loginEdit.invite_expires_at).replace("T", " ").slice(0, 16)}`
                  : " · no password yet"}
              </>
            ) : null}
          </p>
          <form
            className="form admin-compact-form"
            onSubmit={(e) => void saveLoginEdit(e, false)}
          >
            <label>
              Display name
              <input
                value={loginEditName}
                onChange={(e) => setLoginEditName(e.target.value)}
                required
                autoComplete="off"
              />
            </label>
            <label>
              Username (login)
              <input
                value={loginEditUser}
                onChange={(e) => setLoginEditUser(e.target.value.toLowerCase())}
                required
                autoComplete="off"
                spellCheck={false}
                pattern="[a-z0-9._\-]{2,40}"
                title="2–40 characters: letters, numbers, . _ -"
              />
            </label>
            <div className="admin-match-actions">
              <button className="btn secondary" type="submit" disabled={loginEditBusy}>
                {loginEditBusy ? "Saving…" : "Save username"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={loginEditBusy}
                onClick={(e) => void saveLoginEdit(e as unknown as FormEvent, true)}
              >
                {loginEditBusy ? "Working…" : "Save & resend invite"}
              </button>
              <button
                className="btn ghost"
                type="button"
                disabled={loginEditBusy}
                onClick={() => closeLoginEdit()}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      <div className={`admin-people-grid${readOnly ? " is-readonly" : ""}`}>
        {(can(user, "manageEmployees") || readOnly) && (
          <div className="card admin-card">
            <h2>Employees (everyone)</h2>
            <p className="muted admin-card-hint">
              <span className="emp-dot has-account" aria-hidden /> has login ·{" "}
              <span className="emp-dot no-account" aria-hidden /> no login yet
              {readOnly ? " · view only" : ""}
            </p>
            {canEditPeople && (
            <form className="form admin-compact-form" onSubmit={addEmployee}>
              <label>
                Name
                <input
                  value={empName}
                  onChange={(e) => {
                    setEmpName(e.target.value);
                    setEmpMatch(null);
                  }}
                  required
                />
              </label>
              <label>
                Phone
                <input
                  value={empPhone}
                  onChange={(e) => {
                    setEmpPhone(e.target.value);
                    setEmpMatch(null);
                  }}
                  onBlur={() => {
                    const f = formatPhone(empPhone);
                    if (f) setEmpPhone(f);
                  }}
                  placeholder="(361) 555-0100"
                  inputMode="tel"
                />
              </label>
              <button className="btn" type="submit" disabled={busyEmp}>
                {busyEmp ? "Adding…" : "Add employee"}
              </button>
            </form>
            )}

            {canEditPeople && empMatch && (
              <div className="admin-match-panel" role="alertdialog" aria-labelledby="emp-match-title">
                <h3 id="emp-match-title">Is this the same person?</h3>
                <p className="muted">
                  “{empName.trim()}” looks like someone already in the system. Confirm so we don’t
                  create a duplicate.
                </p>
                {empMatch.users && empMatch.users.length > 0 && (
                  <>
                    <p className="admin-match-group-label">Existing logins</p>
                    <ul className="admin-match-list">
                      {empMatch.users.map((u) => (
                        <li key={`u-${u.id}`}>
                          <div className="admin-match-main">
                            <strong>{u.display_name}</strong>
                            <span className="muted">
                              {" "}
                              · @{u.username || "—"} · {roleLabel(u.role as Role)}
                              {!u.active ? " · inactive" : ""}
                              {u.employee_id ? " · already linked to an employee" : ""}
                            </span>
                            {u.reasons?.length ? (
                              <div className="muted admin-match-why">
                                Match: {u.reasons.join(", ")}
                              </div>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            className="btn"
                            disabled={busyEmp || Boolean(u.employee_id)}
                            title={
                              u.employee_id
                                ? "This login is already linked to another employee"
                                : "Create employee and link this login"
                            }
                            onClick={() =>
                              void createEmployee({ link_user_id: u.id, force: true })
                            }
                          >
                            {u.employee_id ? "Already linked" : "Yes — link this login"}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {empMatch.employees && empMatch.employees.length > 0 && (
                  <>
                    <p className="admin-match-group-label">Existing employees</p>
                    <ul className="admin-match-list">
                      {empMatch.employees.map((e) => (
                        <li key={`e-${e.id}`}>
                          <div className="admin-match-main">
                            <strong>{e.name}</strong>
                            <span className="muted">
                              {e.phone ? ` · ${e.phone}` : ""}
                              {!e.active ? " · inactive" : ""}
                            </span>
                            {e.reasons?.length ? (
                              <div className="muted admin-match-why">
                                Match: {e.reasons.join(", ")}
                              </div>
                            ) : null}
                          </div>
                          <span className="muted admin-match-hint">Already on the list</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <div className="admin-match-actions">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busyEmp}
                    onClick={() => void createEmployee({ force: true })}
                  >
                    No — different person, create new
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busyEmp}
                    onClick={() => setEmpMatch(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {canEditPeople ? (
              <p className="muted admin-card-hint" style={{ marginTop: "0.25rem" }}>
                Tap a name to edit details{can(user, "manageUsers") ? " and role / login" : ""}.
              </p>
            ) : null}
            <ul className="emp-account-list">
              {employees.map((e) => {
                const hasAcct = employeeAccountMap.get(e.id) === true;
                const linked = userForEmployee(e);
                const selected = editEmp?.id === e.id;
                return (
                  <li
                    key={e.id}
                    className={`emp-account-row${hasAcct ? " has-account" : " no-account"}${
                      selected ? " is-selected" : ""
                    }`}
                  >
                    <span
                      className={`emp-dot${hasAcct ? " has-account" : " no-account"}`}
                      title={hasAcct ? "Has a user login" : "No matching user account yet"}
                      aria-label={hasAcct ? "Has account" : "No account"}
                    />
                    <button
                      type="button"
                      className="emp-account-name-btn"
                      onClick={() => {
                        if (canEditPeople) openEmployeeEdit(e);
                      }}
                      disabled={!canEditPeople}
                    >
                      <span className="emp-account-name">
                        {e.name}
                        {!e.active && <span className="badge">inactive</span>}
                      </span>
                      {linked ? (
                        <span className="muted emp-account-role">
                          {roleLabel(linked.role)} · @{linked.username || "—"}
                        </span>
                      ) : null}
                      {e.phone ? (
                        <span className="muted emp-account-phone">{formatPhone(e.phone)}</span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            {canEditPeople && editEmp && (
              <div className="emp-edit-panel" ref={editPanelRef}>
                <div className="emp-edit-header">
                  <h3>Edit employee</h3>
                  <button type="button" className="btn ghost btn-sm" onClick={closeEmployeeEdit}>
                    Close
                  </button>
                </div>
                <form className="form admin-compact-form" onSubmit={(ev) => void saveEmployeeEdit(ev)}>
                  <label>
                    Name
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      required
                    />
                  </label>
                  <label>
                    Phone
                    <input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      onBlur={() => {
                        const f = formatPhone(editPhone);
                        if (f) setEditPhone(f);
                      }}
                      placeholder="(361) 555-0100"
                      inputMode="tel"
                    />
                  </label>
                  <label className="emp-edit-check">
                    <input
                      type="checkbox"
                      checked={editActive}
                      onChange={(e) => setEditActive(e.target.checked)}
                    />
                    Active on employee list
                  </label>
                  <label>
                    Rides with (helper / tech pair)
                    <select
                      value={editRidesWith}
                      onChange={(e) => setEditRidesWith(e.target.value)}
                    >
                      <option value="">— Nobody linked —</option>
                      {employees
                        .filter((e) => e.id !== editEmp.id && e.active !== 0)
                        .map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                    </select>
                    <span className="muted" style={{ fontSize: "0.8rem" }}>
                      When you assign the primary tech to a truck, the helper can be auto-included.
                    </span>
                  </label>

                  {can(user, "manageUsers") && (
                    <>
                      <label>
                        Linked login
                        <select
                          value={editLinkedUserId}
                          onChange={(e) => {
                            const v = e.target.value;
                            setEditLinkedUserId(v);
                            setEditCreateLogin(false);
                            if (v) {
                              const u = users.find((x) => String(x.id) === v);
                              if (u) setEditRole(u.role);
                            }
                          }}
                        >
                          <option value="">None — no login</option>
                          {users
                            .filter(
                              (u) =>
                                u.active ||
                                (editLinkedUserId && String(u.id) === editLinkedUserId)
                            )
                            .map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.display_name} · @{u.username || "—"} · {roleLabel(u.role)}
                                {u.employee_id && Number(u.employee_id) !== editEmp.id
                                  ? " (linked elsewhere)"
                                  : ""}
                              </option>
                            ))}
                        </select>
                      </label>

                      {(editLinkedUserId || editCreateLogin) && (
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
                                className={`role-chip${editRole === value ? " active" : ""}`}
                              >
                                <input
                                  type="radio"
                                  name="edit-emp-role"
                                  checked={editRole === value}
                                  onChange={() => setEditRole(value)}
                                />
                                {label}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      )}

                      {!editLinkedUserId && (
                        <div className="emp-edit-create-login">
                          <label className="emp-edit-check">
                            <input
                              type="checkbox"
                              checked={editCreateLogin}
                              onChange={(e) => setEditCreateLogin(e.target.checked)}
                            />
                            Create a login for this person
                          </label>
                          {editCreateLogin && (
                            <label>
                              Username
                              <input
                                value={editUsername}
                                onChange={(e) => setEditUsername(e.target.value)}
                                autoComplete="off"
                                placeholder="firstname.lastname"
                                required={editCreateLogin}
                              />
                            </label>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  <div className="emp-edit-actions">
                    <button className="btn" type="submit" disabled={editBusy}>
                      {editBusy ? "Saving…" : "Save"}
                    </button>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={editBusy}
                      onClick={closeEmployeeEdit}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {(can(user, "manageUsers") || readOnly) && (
          <div className="card admin-card">
            <h2>Users (logins){readOnly ? " · view only" : ""}</h2>
            {can(user, "manageUsers") && (
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
                    onBlur={() => {
                      const f = formatPhone(uPhone);
                      if (f) setUPhone(f);
                    }}
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
                Password (optional — skip this)
                <input
                  type="text"
                  value={uPass}
                  onChange={(e) => setUPass(e.target.value)}
                  placeholder="Leave blank for invite link"
                  autoComplete="new-password"
                />
              </label>
              <p className="muted admin-card-hint">
                Leave blank (recommended): you get a join link to send them. They type the
                username you chose, create their password, and are signed in immediately.
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
              {userMatchWarn && (
                <div className="admin-match-panel admin-match-panel-user">
                  <h3>Similar employee already listed</h3>
                  <p className="muted">
                    “{uName.trim()}” looks like: <strong>{userMatchWarn}</strong>
                  </p>
                  <p className="muted">
                    Pick them under <strong>Link employee</strong> if it’s the same person, or
                    confirm below to create a login without linking.
                  </p>
                  <div className="admin-match-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busyUser}
                      onClick={() => {
                        skipUserEmpMatchRef.current = true;
                        setUserMatchWarn(null);
                        void createUserAccount();
                      }}
                    >
                      Create login anyway
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        skipUserEmpMatchRef.current = false;
                        setUserMatchWarn(null);
                      }}
                    >
                      Go back
                    </button>
                  </div>
                </div>
              )}
              <button className="btn" type="submit" disabled={busyUser}>
                {busyUser ? "Creating…" : userMatchWarn ? "Review matches above" : "Create user"}
              </button>
            </form>
            )}
            <div className="admin-users-list" ref={usersTableRef}>
              {/* Wide screens: compact table — email sits under login with room to read */}
              <div className="table-wrap admin-users-table admin-users-wide">
                <table>
                  <colgroup>
                    <col className="c-name" />
                    <col className="c-login" />
                    <col className="c-phone" />
                    <col className="c-role" />
                    <col className="c-mgr" />
                    <col className="c-emp" />
                    <col className="c-act" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Login / email</th>
                      <th>Phone</th>
                      <th>Role</th>
                      <th>Manager</th>
                      <th className="no-print">Employee</th>
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
                          <strong className="admin-cell-name" title={u.display_name}>
                            {u.display_name}
                          </strong>
                          {u.id === justAddedId && (
                            <span className="badge ok" style={{ marginLeft: "0.3rem" }}>
                              new
                            </span>
                          )}
                          {!u.active && <span className="badge">off</span>}
                          {isPendingSetup(u) && (
                            <div className="muted admin-cell-hint">pending setup</div>
                          )}
                        </td>
                        <td className="admin-login-cell">
                          <strong title={u.username || undefined}>@{u.username || "—"}</strong>
                          {u.email ? (
                            <a
                              className="admin-cell-email"
                              href={`mailto:${u.email}`}
                              title={u.email}
                            >
                              {u.email}
                            </a>
                          ) : null}
                        </td>
                        <td className="admin-cell-phone admin-cell-nowrap">
                          {u.phone ? formatPhone(u.phone) : "—"}
                        </td>
                        <td className="admin-cell-role admin-cell-nowrap">{roleLabel(u.role)}</td>
                        <td className="admin-cell-mgr admin-cell-nowrap" title={u.manager_name || undefined}>
                          {u.manager_name || "—"}
                        </td>
                        <td className="no-print">
                          {can(user, "manageUsers") ? (
                            <select
                              className="admin-link-select"
                              value={u.employee_id != null ? String(u.employee_id) : ""}
                              aria-label={`Link employee for ${u.display_name}`}
                              onChange={(e) => void linkUserEmployee(u, e.target.value)}
                            >
                              <option value="">Not linked</option>
                              {employeesForLink.map((e) => {
                                const linkedElsewhere = users.some(
                                  (x) =>
                                    x.id !== u.id &&
                                    x.active &&
                                    Number(x.employee_id) === e.id
                                );
                                return (
                                  <option key={e.id} value={e.id}>
                                    {e.name}
                                    {linkedElsewhere ? " (elsewhere)" : ""}
                                    {e.phone ? ` · ${formatPhone(e.phone)}` : ""}
                                  </option>
                                );
                              })}
                            </select>
                          ) : (
                            <span className="muted">
                              {u.employee_id
                                ? employees.find((e) => e.id === u.employee_id)?.name ||
                                  `#${u.employee_id}`
                                : "—"}
                            </span>
                          )}
                        </td>
                        <td className="no-print">
                          {can(user, "manageUsers") ? (
                            <div className="admin-user-actions">
                              <button
                                className="btn secondary btn-sm"
                                type="button"
                                title="Change username or name"
                                onClick={() => openLoginEdit(u)}
                              >
                                Edit
                              </button>
                              <button
                                className="btn secondary btn-sm"
                                type="button"
                                title={
                                  isPendingSetup(u)
                                    ? "Resend join link (they set their password)"
                                    : "Send a new join link (clears current password until they finish)"
                                }
                                onClick={() => void sendInviteLink(u)}
                              >
                                {isPendingSetup(u) ? "Resend" : "Invite"}
                              </button>
                              <button
                                className="btn ghost btn-sm"
                                type="button"
                                title="Join link or set password yourself"
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
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Narrow screens: cards with 2-up fields (not one long column of empty space) */}
              <ul className="admin-users-stack admin-users-narrow">
                {users.map((u) => (
                  <li
                    key={u.id}
                    className={`admin-user-card${u.id === justAddedId ? " row-just-added" : ""}${
                      !u.active ? " is-off" : ""
                    }`}
                  >
                    <div className="admin-user-card-header">
                      <div className="admin-user-card-title">
                        <strong className="admin-user-card-name">{u.display_name}</strong>
                        <div className="admin-user-card-badges">
                          {u.id === justAddedId && <span className="badge ok">new</span>}
                          {!u.active && <span className="badge">off</span>}
                          {isPendingSetup(u) && (
                            <span className="badge">pending setup</span>
                          )}
                        </div>
                      </div>
                      {can(user, "manageUsers") ? (
                        <div className="admin-user-actions no-print">
                          <button
                            className="btn secondary btn-sm"
                            type="button"
                            title="Change username or name"
                            onClick={() => openLoginEdit(u)}
                          >
                            Edit
                          </button>
                          <button
                            className="btn secondary btn-sm"
                            type="button"
                            title={
                              isPendingSetup(u)
                                ? "Resend join link"
                                : "Send a new join link"
                            }
                            onClick={() => void sendInviteLink(u)}
                          >
                            {isPendingSetup(u) ? "Resend" : "Invite"}
                          </button>
                          <button
                            className="btn ghost btn-sm"
                            type="button"
                            title="Join link or set password yourself"
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
                      ) : null}
                    </div>

                    <dl className="admin-user-fields">
                      <div className="admin-user-field">
                        <dt>Login</dt>
                        <dd>
                          <strong>@{u.username || "—"}</strong>
                        </dd>
                      </div>
                      <div className="admin-user-field">
                        <dt>Role</dt>
                        <dd>{roleLabel(u.role)}</dd>
                      </div>
                      <div className="admin-user-field">
                        <dt>Phone</dt>
                        <dd className="admin-cell-phone">
                          {u.phone ? formatPhone(u.phone) : "—"}
                        </dd>
                      </div>
                      <div className="admin-user-field">
                        <dt>Manager</dt>
                        <dd>{u.manager_name || "—"}</dd>
                      </div>
                      <div className="admin-user-field admin-user-field-wide">
                        <dt>Email</dt>
                        <dd>
                          {u.email ? (
                            <a className="admin-user-card-email" href={`mailto:${u.email}`}>
                              {u.email}
                            </a>
                          ) : (
                            "—"
                          )}
                        </dd>
                      </div>
                      <div className="admin-user-field admin-user-field-wide no-print">
                        <dt>Employee link</dt>
                        <dd>
                          {can(user, "manageUsers") ? (
                            <select
                              className="admin-link-select"
                              value={u.employee_id != null ? String(u.employee_id) : ""}
                              onChange={(e) => void linkUserEmployee(u, e.target.value)}
                            >
                              <option value="">Not linked</option>
                              {employeesForLink.map((e) => (
                                <option key={e.id} value={e.id}>
                                  {e.name}
                                  {e.phone ? ` · ${formatPhone(e.phone)}` : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span>
                              {u.employee_id
                                ? employees.find((e) => e.id === u.employee_id)?.name || "—"
                                : "—"}
                            </span>
                          )}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
            </div>
            <p className="muted" style={{ marginTop: "0.75rem", fontSize: "0.85rem" }}>
              Username is their login. Use <strong>Edit</strong> to fix a mistyped username,{" "}
              <strong>Resend</strong> for a new join link (always available — the share banner stays
              until you dismiss it). <strong>Employee link</strong> matches a login to the employee
              list. Deactivate when they leave.
            </p>
          </div>
        )}

        {(user?.role === "admin" || readOnly) && (
          <div className="card admin-handbook-acks">
            <h2>Handbook acknowledgments{readOnly ? " · view only" : ""}</h2>
            <p className="muted" style={{ marginTop: 0, fontSize: "0.88rem" }}>
              Who has signed the current employee handbook.{" "}
              {user?.role === "admin" ? (
                <>
                  Use <strong>Clear</strong> only when someone must re-read and sign again (e.g. new
                  version). Cleared intentionally here so it is not next to the people list by
                  accident.
                </>
              ) : (
                <>View only — only Admin can clear signatures.</>
              )}
            </p>
            {!handbookRoster.length ? (
              <p className="muted" style={{ margin: 0, fontSize: "0.88rem" }}>
                No handbook roster yet — upload a handbook or wait for logins.
              </p>
            ) : (
              <>
                <p className="muted" style={{ margin: "0 0 0.55rem", fontSize: "0.82rem" }}>
                  {handbookRoster.filter((r) => r.acknowledged).length} confirmed ·{" "}
                  {handbookRoster.filter((r) => !r.acknowledged).length} pending
                </p>
                <ul className="admin-handbook-ack-list">
                  {handbookRoster.map((r) => (
                    <li
                      key={r.id}
                      className={`admin-handbook-ack-row${r.acknowledged ? " is-done" : " is-pending"}`}
                    >
                      <div className="admin-handbook-ack-main">
                        <strong>{r.display_name}</strong>
                        <span className="muted">
                          {roleLabel(r.role as Role)}
                          {r.acknowledged_at
                            ? ` · ${String(r.acknowledged_at).replace("T", " ").slice(0, 16)}`
                            : ""}
                        </span>
                      </div>
                      <div className="admin-handbook-ack-actions">
                        <span className={`badge ${r.acknowledged ? "ok" : "warning"}`}>
                          {r.acknowledged ? "Confirmed" : "Pending"}
                        </span>
                        {user?.role === "admin" && r.acknowledged ? (
                          <button
                            type="button"
                            className="btn ghost btn-sm"
                            disabled={handbookBusyId === r.id}
                            onClick={() => void clearHandbookAck(r)}
                          >
                            {handbookBusyId === r.id ? "…" : "Clear"}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {(can(user, "manageSettings") || readOnly) && (
          <div className="card">
            <h2>Red flag thresholds{readOnly ? " · view only" : ""}</h2>
            <form
              className="form"
              onSubmit={(e) => {
                if (readOnly) {
                  e.preventDefault();
                  return;
                }
                void saveSettings(e);
              }}
            >
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
              {!readOnly && (
                <button className="btn" type="submit">
                  Save settings
                </button>
              )}
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
                <strong>My Apps → + New App</strong> — name it e.g. “Field App”. Add
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
