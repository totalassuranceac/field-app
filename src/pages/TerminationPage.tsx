import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

type EmpRow = {
  id: number;
  name: string;
  hire_date?: string | null;
  active: number;
  separation_date?: string | null;
};

function todayIso(): string {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function formatDisplayDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}

function daysBetween(fromIso: string, toIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso) || !/^\d{4}-\d{2}-\d{2}$/.test(toIso)) return null;
  const a = new Date(`${fromIso}T12:00:00`);
  const b = new Date(`${toIso}T12:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function firstNameFrom(full: string): string {
  const part = full.trim().split(/\s+/)[0];
  return part || "";
}

/**
 * Standalone printable separation / termination acknowledgment.
 * Pick employee → hire date fills in → optional reasons → Print → employee signs.
 */
function printerDisplayName(
  u: { display_name?: string | null; email?: string | null; username?: string | null } | null
): string {
  const name = (u?.display_name || "").trim();
  if (name) return name;
  const email = (u?.email || "").trim();
  if (email) return email;
  return (u?.username || "").trim();
}

export function TerminationPage() {
  const { user, realUser } = useAuth();
  const [searchParams] = useSearchParams();
  const allowed =
    can(user, "manageUsers") || can(user, "manageEmployees") || user?.role === "office";

  const [employees, setEmployees] = useState<EmpRow[]>([]);
  const [loadError, setLoadError] = useState("");
  const [empId, setEmpId] = useState("");
  const appliedUrlEmp = useRef(false);

  const [employeeName, setEmployeeName] = useState("");
  const [preferredName, setPreferredName] = useState("");
  const [hireDate, setHireDate] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(todayIso());
  const [position, setPosition] = useState("");
  /** Logged-in account display name (not view-as). */
  const preparedByName = printerDisplayName(realUser || user);
  const [inProbation, setInProbation] = useState(false);
  const [reasonsText, setReasonsText] = useState("");
  const [extraNotes, setExtraNotes] = useState("");

  function applyEmployee(emp: EmpRow, effectiveForProbation?: string) {
    const effective = effectiveForProbation || effectiveDate || todayIso();
    setEmployeeName(emp.name);
    setPreferredName(firstNameFrom(emp.name));
    setHireDate(emp.hire_date || "");
    let nextEffective = effective;
    if (emp.separation_date && /^\d{4}-\d{2}-\d{2}$/.test(emp.separation_date)) {
      nextEffective = emp.separation_date;
      setEffectiveDate(emp.separation_date);
    }
    const days = emp.hire_date ? daysBetween(emp.hire_date, nextEffective) : null;
    setInProbation(days != null && days >= 0 && days < 90);
  }

  const loadEmployees = useCallback(async () => {
    setLoadError("");
    try {
      const data = await api<{ employees: EmpRow[] }>("/employees?all=1");
      const list = (data.employees || [])
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      setEmployees(list);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load employees");
    }
  }, []);

  useEffect(() => {
    if (allowed) void loadEmployees();
  }, [allowed, loadEmployees]);

  useEffect(() => {
    return () => {
      document.body.classList.remove("print-onboarding");
    };
  }, []);

  /** Optional deep link from People: /termination?emp=26 */
  useEffect(() => {
    if (appliedUrlEmp.current || !employees.length) return;
    const fromUrl = searchParams.get("emp")?.trim();
    if (!fromUrl) return;
    const emp = employees.find((e) => String(e.id) === fromUrl);
    if (!emp) return;
    appliedUrlEmp.current = true;
    setEmpId(fromUrl);
    applyEmployee(emp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employees, searchParams]);

  function onSelectEmployee(id: string) {
    setEmpId(id);
    if (!id) {
      setEmployeeName("");
      setPreferredName("");
      setHireDate("");
      setInProbation(false);
      return;
    }
    const emp = employees.find((e) => String(e.id) === id);
    if (emp) applyEmployee(emp);
  }

  function printNotice() {
    if (!employeeName.trim()) return;
    document.body.classList.add("print-onboarding");
    window.setTimeout(() => {
      const cleanup = () => {
        document.body.classList.remove("print-onboarding");
        window.removeEventListener("afterprint", cleanup);
      };
      window.addEventListener("afterprint", cleanup);
      window.print();
      window.setTimeout(cleanup, 180_000);
    }, 100);
  }

  const sortedEmployees = useMemo(() => {
    const active = employees.filter((e) => e.active !== 0);
    const inactive = employees.filter((e) => e.active === 0);
    return [...active, ...inactive];
  }, [employees]);

  if (!allowed) {
    return (
      <div className="page">
        <div className="error">Office or admin access required for separation paperwork.</div>
        <p>
          <Link to="/admin">Back to People</Link>
        </p>
      </div>
    );
  }

  const reasons = reasonsText
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  const displayName = employeeName.trim() || "________________";
  const greetingName = preferredName.trim() || displayName.split(" ")[0] || "Employee";
  const canPrint = Boolean(employeeName.trim());

  return (
    <div className="page onboard-page">
      <div className="page-header no-print">
        <div>
          <h1>Separation notice</h1>
          <p>
            Pick an employee, adjust details if needed, then print. They sign to acknowledge receipt
            of the notice.
          </p>
        </div>
        <div className="onboard-header-actions">
          <Link className="btn secondary" to="/admin">
            Back to People
          </Link>
          <button type="button" className="btn" disabled={!canPrint} onClick={printNotice}>
            Print separation notice
          </button>
        </div>
      </div>

      {loadError ? <div className="error inv-flash no-print">{loadError}</div> : null}

      <div className="card no-print onboard-setup">
        <h2 className="inv-section-title">Notice details</h2>
        <div className="onboard-setup-grid">
          <label>
            Employee
            <select value={empId} onChange={(e) => onSelectEmployee(e.target.value)}>
              <option value="">Select…</option>
              {sortedEmployees.map((e) => (
                <option key={e.id} value={String(e.id)}>
                  {e.name}
                  {e.active === 0 ? " (inactive)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Preferred / first name (letter greeting)
            <input
              value={preferredName}
              onChange={(e) => setPreferredName(e.target.value)}
              placeholder="Auto-fills from name"
              disabled={!empId}
            />
          </label>
          <label>
            Position (optional)
            <input
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Install helper"
            />
          </label>
          <label>
            Hire / start date
            <input
              type="date"
              value={hireDate}
              onChange={(e) => {
                const v = e.target.value;
                setHireDate(v);
                const days = v ? daysBetween(v, effectiveDate || todayIso()) : null;
                setInProbation(days != null && days >= 0 && days < 90);
              }}
            />
          </label>
          <label>
            Separation effective date
            <input
              type="date"
              value={effectiveDate}
              onChange={(e) => {
                const v = e.target.value;
                setEffectiveDate(v);
                const days = hireDate ? daysBetween(hireDate, v || todayIso()) : null;
                setInProbation(days != null && days >= 0 && days < 90);
              }}
            />
          </label>
          <label>
            Prepared by (your name)
            <input
              value={preparedByName || "(no name on your account)"}
              readOnly
              title="Taken from the account that is printing this form"
            />
          </label>
        </div>

        <label className="emp-edit-check" style={{ display: "flex", marginTop: "0.75rem", gap: "0.5rem" }}>
          <input
            type="checkbox"
            checked={inProbation}
            onChange={(e) => setInProbation(e.target.checked)}
          />
          Still within 90-day probationary period
          <span className="muted" style={{ fontWeight: 400 }}>
            (auto from hire date; uncheck for non-probation separations)
          </span>
        </label>

        <label style={{ display: "block", marginTop: "0.75rem" }}>
          Reasons / concerns considered (optional — one per line; leave blank to omit)
          <textarea
            value={reasonsText}
            onChange={(e) => setReasonsText(e.target.value)}
            rows={4}
            placeholder={"e.g. Attendance issues\nPerformance concerns\n…"}
            style={{ width: "100%", marginTop: "0.35rem" }}
          />
        </label>
        <label style={{ display: "block", marginTop: "0.75rem" }}>
          Extra context (optional — prints as a short paragraph)
          <textarea
            value={extraNotes}
            onChange={(e) => setExtraNotes(e.target.value)}
            rows={2}
            placeholder="Optional additional notes for the letter…"
            style={{ width: "100%", marginTop: "0.35rem" }}
          />
        </label>
        <div className="onboard-setup-actions">
          <button type="button" className="btn" disabled={!canPrint} onClick={printNotice}>
            Print separation notice
          </button>
          {!canPrint ? (
            <span className="muted" style={{ fontSize: "0.88rem" }}>
              Select an employee to enable print.
            </span>
          ) : null}
        </div>
      </div>

      <div className="onboard-print-root term-print-root">
        <section className="onboard-sheet term-sheet">
          <header className="onboard-letterhead">
            <div className="onboard-brand">
              <img
                className="onboard-wordmark"
                src="/logo-form-primary.png"
                alt="Total Assurance"
              />
              <div className="onboard-company-name">Total Assurance A/C &amp; Heating</div>
              <div className="onboard-subtitle">
                Notice of separation
                {inProbation ? " · Probationary period" : ""}
              </div>
            </div>
            <div className="onboard-meta">
              <div className="onboard-meta-label">Effective date</div>
              <div className="onboard-meta-date">{formatDisplayDate(effectiveDate)}</div>
              <div className="onboard-meta-by">Employee: {displayName}</div>
              <div className="onboard-meta-by">
                Prepared by {preparedByName || "Office"}
              </div>
            </div>
          </header>

          <div className="onboard-sheet-body term-body">
            <h2 className="onboard-doc-title">Notice of separation</h2>

            <p className="term-p">Dear {greetingName},</p>

            <p className="term-p">
              Thank you for your time with Total Assurance A/C &amp; Heating
              {position.trim() ? ` as ${position.trim()}` : ""}. This notice confirms that your
              employment ends <strong>effective {formatDisplayDate(effectiveDate)}</strong>.
              {inProbation ? (
                <>
                  {" "}
                  You are still within your <strong>90-day probationary period</strong>
                  {hireDate ? ` (hire date ${formatDisplayDate(hireDate)})` : ""}, during which we
                  evaluate whether the role is a good fit for both sides.
                </>
              ) : hireDate ? (
                <> Your hire date on file is {formatDisplayDate(hireDate)}.</>
              ) : null}
            </p>

            {extraNotes.trim() ? <p className="term-p">{extraNotes.trim()}</p> : null}

            {reasons.length > 0 ? (
              <>
                <p className="term-p term-p-tight">
                  Concerns considered during your time with us include:
                </p>
                <ul className="term-reasons">
                  {reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </>
            ) : null}

            <p className="term-p">
              Taking everything into consideration, we have decided to end your employment effective
              the date above. We appreciate the time you spent with us and wish you the best.
            </p>

            <div className="term-info-box">
              <p className="term-info-line">
                <strong>Last day:</strong> {formatDisplayDate(effectiveDate)}. Please return all
                company property (keys, badges, tools, uniforms, devices, and other company items)
                to the office as soon as possible. Questions about final pay may be directed to the
                office during normal business hours.
              </p>
            </div>

            <div className="onboard-keep onboard-sign-bottom term-ack">
              <div className="onboard-ack-box">
                <p>
                  <strong>Employee acknowledgment.</strong> I have received this Notice of
                  Separation and understand my employment ends effective{" "}
                  <strong>{formatDisplayDate(effectiveDate)}</strong>. My signature confirms
                  receipt of this notice; it does not waive any rights under applicable law.
                </p>
              </div>

              <div className="onboard-sign-row term-sign-row">
                <div>
                  <div className="onboard-sign-line term-sign-line" />
                  <div className="onboard-sign-label">Employee signature — {displayName}</div>
                </div>
                <div>
                  <div className="onboard-sign-line term-sign-line" />
                  <div className="onboard-sign-label">Date</div>
                </div>
              </div>

              <div className="onboard-sign-row term-sign-row">
                <div>
                  <div className="onboard-sign-line term-sign-line" />
                  <div className="onboard-sign-label">Company signature / title</div>
                </div>
                <div>
                  <div className="onboard-sign-line term-sign-line" />
                  <div className="onboard-sign-label">Date</div>
                </div>
              </div>

              <div className="onboard-sign-row term-sign-row">
                <div>
                  <div className="onboard-sign-line term-sign-line" />
                  <div className="onboard-sign-label">Witness signature (optional)</div>
                </div>
                <div>
                  <div className="onboard-sign-line term-sign-line" />
                  <div className="onboard-sign-label">Date</div>
                </div>
              </div>
            </div>
          </div>

          <footer className="onboard-sheet-footer">
            <div className="onboard-foot-left">
              <span className="onboard-foot-brand">Total Assurance A/C &amp; Heating</span>
              <span className="onboard-foot-note">Confidential personnel record</span>
            </div>
            <div className="onboard-page-num" aria-label="Page 1 of 1">
              <span className="onboard-page-label">Page</span>
              <span className="onboard-page-value">1 / 1</span>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}
