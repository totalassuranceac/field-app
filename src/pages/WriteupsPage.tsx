import { FormEvent, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, can, canVoidWriteups } from "../api";
import { useAuth } from "../auth";
import { WriteupDetailFields, WriteupDetailSummary } from "../components/WriteupDetailForm";
import { WriteupSheet } from "../components/WriteupSheet";
import { printWithLightTheme } from "../printTheme";
import { WRITEUP_TEMPLATES } from "../writeupTemplates";
import { cloneWriteupDetail, coerceWriteupDetail, emptyWriteupDetail, type WriteupDetail } from "../../worker/writeupDetail";

type Writeup = {
  id: number;
  employee_id: number | null;
  employee_name: string;
  supervisor_name: string | null;
  incident_date: string | null;
  what_happened: string;
  prior_warnings: string | null;
  expectations: string | null;
  consequences: string | null;
  created_by_user_id: number;
  created_at: string;
  voided_at: string | null;
  voided_by_user_id: number | null;
  void_reason: string | null;
  created_by_name?: string | null;
  voided_by_name?: string | null;
  form_detail?: WriteupDetail | null;
};

type EmployeeOpt = { id: number; name: string; active?: number };

function displayDate(value: string | null | undefined): string {
  if (!value) return "-";
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(value);
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`;
}

function firstLine(text: string | null | undefined): string {
  const line = String(text || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return "-";
  return line.length > 140 ? `${line.slice(0, 140)}...` : line;
}

function countLabel(count: number): string {
  return `${count} write-up${count === 1 ? "" : "s"}`;
}

function todayIso(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function NewWriteupForm({
  employees,
  defaultSupervisor,
  onSaved,
}: {
  employees: EmployeeOpt[];
  defaultSupervisor: string;
  onSaved: () => void;
}) {
  const navigate = useNavigate();
  const [employeeId, setEmployeeId] = useState(
    () => new URLSearchParams(window.location.search).get("employee_id") || ""
  );
  const [employee, setEmployee] = useState(
    () => new URLSearchParams(window.location.search).get("for") || ""
  );
  const [date, setDate] = useState(todayIso);
  const [supervisor, setSupervisor] = useState(defaultSupervisor);
  const [what, setWhat] = useState("");
  const [prior, setPrior] = useState("");
  const [expectations, setExpectations] = useState("");
  const [consequences, setConsequences] = useState("");
  const [detail, setDetail] = useState<WriteupDetail>({ ...emptyWriteupDetail(), company_form: true });
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function placeTemplate(id: string) {
    const template = WRITEUP_TEMPLATES.find((t) => t.id === id);
    if (!template) return;
    setTemplateId(id);
    setWhat(template.what);
    setPrior(template.prior);
    setExpectations(template.expectations);
    setConsequences(template.consequences);
    setDetail(cloneWriteupDetail(template.detail));
  }

  function linkedEmployeeId(): number | null {
    if (!employeeId) return null;
    const row = employees.find((e) => String(e.id) === employeeId);
    if (!row) return null;
    if (row.name.trim().toLowerCase() !== employee.trim().toLowerCase()) return null;
    return row.id;
  }

  async function save(andPrint: boolean) {
    if (!employee.trim()) {
      setError("Type the employee name.");
      return;
    }
    if (!what.trim()) {
      setError("Type what happened.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = await api<{ writeup: { id: number } }>("/hr/writeups", {
        method: "POST",
        body: JSON.stringify({
          employee_id: linkedEmployeeId(),
          employee_name: employee,
          supervisor_name: supervisor,
          incident_date: date,
          what_happened: what,
          prior_warnings: prior,
          expectations,
          consequences,
          form_detail: { ...detail, company_form: true },
        }),
      });
      onSaved();
      navigate(
        andPrint
          ? `/hr/writeups/${saved.writeup.id}?print=1`
          : `/hr/writeups/${saved.writeup.id}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the write-up");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card no-print">
      <h2>New write-up</h2>
      <p className="muted">
        Pick a starting point, then change any line. Brackets are blanks to fill in. The corrective action stays blank until you mark it. Nothing is emailed or texted.
      </p>
      <div className="writeup-templates" role="group" aria-label="Write-up templates">
        {WRITEUP_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`btn secondary btn-sm${templateId === template.id ? " is-on" : ""}`}
            aria-pressed={templateId === template.id}
            onClick={() => placeTemplate(template.id)}
          >
            {template.label}
          </button>
        ))}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="onboard-setup-grid">
        <label>
          Employee on file
          <select
            value={employeeId}
            onChange={(e) => {
              const id = e.target.value;
              setEmployeeId(id);
              const row = employees.find((x) => String(x.id) === id);
              if (row) setEmployee(row.name);
            }}
          >
            <option value="">Not on the list</option>
            {employees.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
                {person.active === 0 ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Employee
          <input
            value={employee}
            onChange={(e) => {
              const name = e.target.value;
              setEmployee(name);
              if (employeeId) {
                const row = employees.find((x) => String(x.id) === employeeId);
                if (row && row.name.trim().toLowerCase() !== name.trim().toLowerCase()) {
                  setEmployeeId("");
                }
              }
            }}
            placeholder="Employee name"
          />
        </label>
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Supervisor
          <input value={supervisor} onChange={(e) => setSupervisor(e.target.value)} />
        </label>
      </div>
      <WriteupDetailFields
        name="new-writeup"
        detail={detail}
        onChange={setDetail}
        what={what}
        onWhat={setWhat}
        prior={prior}
        onPrior={setPrior}
        expectations={expectations}
        onExpectations={setExpectations}
        consequences={consequences}
        onConsequences={setConsequences}
      />
      <div className="writeup-actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save(false)}>
          {busy ? "Saving..." : "Save write-up"}
        </button>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void save(true)}>
          Save and print
        </button>
      </div>
    </section>
  );
}

export function WriteupsPage() {
  const { user } = useAuth();
  const { id: idParam } = useParams();
  const [params, setParams] = useSearchParams();
  const allowed = can(user, "manageWriteups");
  const mayVoid = canVoidWriteups(user);
  const detailId = Number(idParam || 0);
  const employeeId = params.get("employee_id") || "";
  const query = params.get("q") || "";
  const showVoided = params.get("include_voided") === "1";

  const [employees, setEmployees] = useState<EmployeeOpt[]>([]);
  const [rows, setRows] = useState<Writeup[]>([]);
  const [count, setCount] = useState(0);
  const [detail, setDetail] = useState<Writeup | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidBusy, setVoidBusy] = useState(false);
  const [searchDraft, setSearchDraft] = useState(query);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editWhat, setEditWhat] = useState("");
  const [editPrior, setEditPrior] = useState("");
  const [editExpect, setEditExpect] = useState("");
  const [editConseq, setEditConseq] = useState("");
  const [editSupervisor, setEditSupervisor] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editName, setEditName] = useState("");
  const [editDetail, setEditDetail] = useState<WriteupDetail>(emptyWriteupDetail);
  const [saveBusy, setSaveBusy] = useState(false);

  useEffect(() => {
    setSearchDraft(query);
  }, [query]);

  useEffect(() => {
    if (!allowed) return;
    api<{ employees: EmployeeOpt[] }>("/employees?all=1")
      .then((d) => setEmployees(d.employees || []))
      .catch(() => setEmployees([]));
  }, [allowed]);

  const loadList = useCallback(async () => {
    const qs = new URLSearchParams();
    if (employeeId) qs.set("employee_id", employeeId);
    if (query.trim()) qs.set("q", query.trim());
    if (showVoided) qs.set("include_voided", "1");
    const data = await api<{ writeups: Writeup[]; count: number }>(
      `/hr/writeups${qs.toString() ? `?${qs}` : ""}`
    );
    setRows(data.writeups || []);
    setCount(Number(data.count || 0));
  }, [employeeId, query, showVoided]);

  const loadDetail = useCallback(async (id: number) => {
    const data = await api<{ writeup: Writeup }>(`/hr/writeups/${id}`);
    setDetail(data.writeup);
  }, []);

  useEffect(() => {
    if (!detail || detail.id !== detailId) return;
    if (params.get("print") !== "1") return;
    let alive = true;
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!alive) return;
        void printWithLightTheme("print-writeup");
        setParams(
          (prev) => {
            if (prev.get("print") !== "1") return prev;
            const next = new URLSearchParams(prev);
            next.delete("print");
            return next;
          },
          { replace: true }
        );
      });
    });
    return () => {
      alive = false;
      cancelAnimationFrame(outer);
    };
  }, [detail, detailId, params, setParams]);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const job = detailId ? loadDetail(detailId) : loadList();
    job
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load write-ups");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, detailId, loadDetail, loadList]);

  function setFilter(next: { employee_id?: string; q?: string; include_voided?: boolean }) {
    const qs = new URLSearchParams(params);
    if (next.employee_id !== undefined) {
      if (next.employee_id) qs.set("employee_id", next.employee_id);
      else qs.delete("employee_id");
    }
    if (next.q !== undefined) {
      if (next.q.trim()) qs.set("q", next.q.trim());
      else qs.delete("q");
    }
    if (next.include_voided !== undefined) {
      if (next.include_voided) qs.set("include_voided", "1");
      else qs.delete("include_voided");
    }
    setParams(qs, { replace: true });
  }

  function onSearch(e: FormEvent) {
    e.preventDefault();
    setFilter({ q: searchDraft });
  }

  function beginEdit(row: Writeup) {
    setEditName(row.employee_name);
    setEditDate(String(row.incident_date || row.created_at || "").slice(0, 10));
    setEditSupervisor(row.supervisor_name || "");
    setEditWhat(row.what_happened || "");
    setEditPrior(row.prior_warnings || "");
    setEditExpect(row.expectations || "");
    setEditConseq(row.consequences || "");
    setEditDetail(coerceWriteupDetail(row.form_detail));
    setEditing(true);
    setError("");
  }

  async function saveEdit() {
    if (!detail) return;
    if (!editName.trim() || !editWhat.trim()) {
      setError("Employee name and what happened are required.");
      return;
    }
    setSaveBusy(true);
    setError("");
    try {
      const data = await api<{ writeup: Writeup }>(`/hr/writeups/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          employee_id: detail.employee_id,
          employee_name: editName,
          supervisor_name: editSupervisor,
          incident_date: editDate,
          what_happened: editWhat,
          prior_warnings: editPrior,
          expectations: editExpect,
          consequences: editConseq,
          form_detail: { ...editDetail, company_form: true },
        }),
      });
      setDetail(data.writeup);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the write-up");
    } finally {
      setSaveBusy(false);
    }
  }

  async function voidWriteup(e: FormEvent) {
    e.preventDefault();
    if (!detail || !mayVoid) return;
    setVoidBusy(true);
    setError("");
    try {
      const data = await api<{ writeup: Writeup }>(`/hr/writeups/${detail.id}/void`, {
        method: "POST",
        body: JSON.stringify({ reason: voidReason }),
      });
      setDetail(data.writeup);
      setVoidReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void this write-up");
    } finally {
      setVoidBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Write-ups</h1>
        </header>
        <div className="empty-state">
          <p>You are not allowed to view write-ups.</p>
          <Link to="/" className="btn secondary">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const selectedEmployee = employees.find((e) => String(e.id) === employeeId);
  const listParams = new URLSearchParams(params);
  listParams.delete("print");
  const listQuery = listParams.toString();
  const backHref = `/hr/writeups${listQuery ? `?${listQuery}` : ""}`;

  if (detailId) {
    const row = detail;
    return (
      <div className="page writeups-page">
        <header className="page-header no-print">
          <div>
            <h1>Write-up</h1>
            <p className="muted">Private record. Nobody is notified.</p>
          </div>
          <div className="writeup-actions">
            <Link className="btn secondary" to={backHref}>
              Back to list
            </Link>
            {row && !row.voided_at ? (
              <button
                type="button"
                className="btn secondary"
                onClick={() => (editing ? setEditing(false) : beginEdit(row))}
              >
                {editing ? "Cancel edit" : "Edit"}
              </button>
            ) : null}
            {row ? (
              <button type="button" className="btn" onClick={() => void printWithLightTheme("print-writeup")}>
                Print
              </button>
            ) : null}
            {row ? (
              <Link
                className="btn secondary"
                to={`/warehouse-cameras?at=${encodeURIComponent(row.created_at || new Date().toISOString())}`}
              >
                Clips around this time
              </Link>
            ) : null}
            {row ? (
              <Link className="btn secondary" to={`/audit?entity=writeup&id=${row.id}`}>
                Change history
              </Link>
            ) : null}
          </div>
        </header>
        {error ? <div className="error inv-flash no-print">{error}</div> : null}
        {loading && !row ? <p className="muted no-print">Loading...</p> : null}
        {row ? (
          <>
            <section className="card no-print">
              <p className="writeup-count">
                {row.employee_name}
                {row.voided_at ? <span className="writeup-void-badge">Voided</span> : null}
              </p>
              <dl className="writeup-detail">
                <div>
                  <dt>Date</dt>
                  <dd>{displayDate(row.incident_date || row.created_at)}</dd>
                </div>
                <div>
                  <dt>Employee</dt>
                  <dd>{row.employee_name}</dd>
                </div>
                <div>
                  <dt>Supervisor</dt>
                  <dd>{row.supervisor_name || "-"}</dd>
                </div>
                <div>
                  <dt>Saved by</dt>
                  <dd>
                    {row.created_by_name || "Unknown"} on {displayDate(row.created_at)}
                  </dd>
                </div>
              </dl>
              {editing ? (
                <>
                  <label>
                    Employee
                    <input value={editName} onChange={(e) => setEditName(e.target.value)} />
                  </label>
                  <label>
                    Date
                    <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                  </label>
                  <label>
                    Supervisor
                    <input value={editSupervisor} onChange={(e) => setEditSupervisor(e.target.value)} />
                  </label>
                  <WriteupDetailFields
                    name="edit-writeup"
                    detail={editDetail}
                    onChange={setEditDetail}
                    what={editWhat}
                    onWhat={setEditWhat}
                    prior={editPrior}
                    onPrior={setEditPrior}
                    expectations={editExpect}
                    onExpectations={setEditExpect}
                    consequences={editConseq}
                    onConsequences={setEditConseq}
                  />
                  <button type="button" className="btn" disabled={saveBusy} onClick={() => void saveEdit()}>
                    {saveBusy ? "Saving..." : "Save corrections"}
                  </button>
                </>
              ) : (
                <>
                  <WriteupDetailSummary
                    detail={coerceWriteupDetail(row.form_detail)}
                    what={row.what_happened || ""}
                    prior={row.prior_warnings || ""}
                    expectations={row.expectations || ""}
                    consequences={row.consequences || ""}
                  />
                </>
              )}
              {row.voided_at ? (
                <p className="writeup-void-note">
                  Voided {displayDate(row.voided_at)}
                  {row.voided_by_name ? ` by ${row.voided_by_name}` : ""}. {row.void_reason || ""}
                </p>
              ) : null}
              {mayVoid && !row.voided_at ? (
                <form className="writeup-void-form" onSubmit={(e) => void voidWriteup(e)}>
                  <label>
                    Void reason
                    <textarea
                      rows={2}
                      value={voidReason}
                      onChange={(e) => setVoidReason(e.target.value)}
                      required
                    />
                  </label>
                  <button className="btn secondary" type="submit" disabled={voidBusy}>
                    {voidBusy ? "Voiding..." : "Void"}
                  </button>
                </form>
              ) : null}
            </section>
            <WriteupSheet
              dateLabel={displayDate(editing ? editDate : row.incident_date || row.created_at)}
              employee={editing ? editName : row.employee_name}
              supervisor={editing ? editSupervisor : row.supervisor_name || ""}
              what={editing ? editWhat : row.what_happened || ""}
              prior={editing ? editPrior : row.prior_warnings || ""}
              expectations={editing ? editExpect : row.expectations || ""}
              consequences={editing ? editConseq : row.consequences || ""}
              detail={
                editing
                  ? { ...editDetail, company_form: true }
                  : coerceWriteupDetail(row.form_detail)
              }
              voided={Boolean(row.voided_at)}
            />
          </>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page writeups-page">
      <header className="page-header">
        <div>
          <h1>Write-ups</h1>
          <p className="muted">Private HR copies. Nothing is emailed or texted.</p>
        </div>
        <button type="button" className="btn" onClick={() => setShowNew((open) => !open)}>
          {showNew ? "Close form" : "New write-up"}
        </button>
      </header>
      {showNew ? (
        <NewWriteupForm
          employees={employees}
          defaultSupervisor={user?.display_name || ""}
          onSaved={() => {
            setShowNew(false);
            void loadList();
          }}
        />
      ) : null}
      {error ? <div className="error inv-flash">{error}</div> : null}
      <section className="card">
        <form className="writeup-filters" onSubmit={onSearch}>
          <label>
            Employee
            <select value={employeeId} onChange={(e) => setFilter({ employee_id: e.target.value })}>
              <option value="">All employees</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.active === 0 ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search
            <input
              type="search"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              placeholder="Name or what happened"
            />
          </label>
          <label className="writeup-check">
            <input
              type="checkbox"
              checked={showVoided}
              onChange={(e) => setFilter({ include_voided: e.target.checked })}
            />
            Show voided
          </label>
          <button className="btn secondary" type="submit">
            Search
          </button>
        </form>
        <p className="writeup-count">
          {selectedEmployee ? `${selectedEmployee.name} - ${countLabel(count)}` : countLabel(count)}
        </p>
        {loading && rows.length === 0 ? <p className="muted">Loading...</p> : null}
        {!loading && rows.length === 0 ? <p className="muted">No write-ups saved yet.</p> : null}
        {rows.length > 0 ? (
          <div className="writeup-table-wrap">
            <table className="writeup-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Employee</th>
                  <th>Supervisor</th>
                  <th>What happened</th>
                  <th>Saved by</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{displayDate(row.incident_date || row.created_at)}</td>
                    <td>
                      <Link to={`/hr/writeups/${row.id}${listQuery ? `?${listQuery}` : ""}`}>
                        {row.employee_name}
                      </Link>
                    </td>
                    <td>{row.supervisor_name || "-"}</td>
                    <td>{firstLine(row.what_happened)}</td>
                    <td>{row.created_by_name || "-"}</td>
                    <td>{row.voided_at ? <span className="writeup-void-badge">Voided</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </div>
  );
}
