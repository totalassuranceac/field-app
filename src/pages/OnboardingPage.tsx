import { FormEvent, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, can } from "../api";
import { useAuth } from "../auth";

GlobalWorkerOptions.workerSrc = pdfWorker;

type FormMeta = {
  kind: string;
  version_label: string;
  url: string;
  source: string;
  updated_at: string | null;
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

function Line({ wide }: { wide?: boolean }) {
  return <span className={`onboard-line${wide ? " is-wide" : ""}`} />;
}

function YesNo() {
  return (
    <span className="onboard-yesno">
      <span className="onboard-box" /> Yes{" "}
      <span className="onboard-box" /> No
    </span>
  );
}

function Letterhead({
  subtitle,
  hireName,
  preparedBy,
  preparedOn,
}: {
  subtitle: string;
  hireName: string;
  preparedBy: string;
  preparedOn: string;
}) {
  return (
    <header className="onboard-letterhead">
      <div className="onboard-brand">
        <img
          className="onboard-wordmark"
          src="/logo-form-primary.png"
          alt="Total Assurance"
        />
        <div className="onboard-company-name">Total Assurance A/C &amp; Heating</div>
        <div className="onboard-subtitle">{subtitle}</div>
      </div>
      <div className="onboard-meta">
        <div className="onboard-meta-label">Packet date</div>
        <div className="onboard-meta-date">{formatDisplayDate(preparedOn)}</div>
        {hireName.trim() ? <div className="onboard-meta-by">New hire: {hireName.trim()}</div> : null}
        <div className="onboard-meta-by">Prepared by {preparedBy}</div>
      </div>
    </header>
  );
}

function Field({
  label,
  wide,
  hint,
}: {
  label: string;
  wide?: boolean;
  hint?: string;
}) {
  return (
    <div className={`onboard-field${wide ? " is-wide" : ""}`}>
      <div className="onboard-field-label">
        {label}
        {hint ? <span className="onboard-field-hint"> · {hint}</span> : null}
      </div>
      <Line wide={wide} />
    </div>
  );
}

/** Bottom footer bar: note left, page count right. */
function SheetFooter({
  page,
  total = 6,
  note,
}: {
  page: number;
  total?: number;
  note?: string;
}) {
  return (
    <footer className="onboard-sheet-footer">
      <div className="onboard-foot-left">
        <span className="onboard-foot-brand">Total Assurance A/C &amp; Heating</span>
        {note ? <span className="onboard-foot-note">{note}</span> : null}
      </div>
      <div className="onboard-page-num" aria-label={`Page ${page} of ${total}`}>
        <span className="onboard-page-label">Page</span>
        <span className="onboard-page-value">
          {page} / {total}
        </span>
      </div>
    </footer>
  );
}

/** Full-page form shell: letterhead + filled body + footer with page count. */
function Sheet({
  page,
  total = 6,
  note,
  className,
  letterhead,
  children,
}: {
  page: number;
  total?: number;
  note?: string;
  className?: string;
  letterhead: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`onboard-sheet${className ? ` ${className}` : ""}`}>
      {letterhead}
      <div className="onboard-sheet-body">{children}</div>
      <SheetFooter page={page} total={total} note={note} />
    </section>
  );
}

/**
 * New hire onboarding — branded print packet + official W-4 / I-9 PDFs.
 * Office/admin only (same gate as People).
 */
export function OnboardingPage() {
  const { user } = useAuth();
  const allowed =
    can(user, "manageEmployees") ||
    user?.role === "admin" ||
    user?.role === "office" ||
    user?.role === "supervisor";

  const [hireName, setHireName] = useState("");
  const [position, setPosition] = useState("");
  const [startDate, setStartDate] = useState("");
  const [preparedOn, setPreparedOn] = useState(todayIso);
  const preparedBy = user?.display_name || user?.username || "Office";

  const [forms, setForms] = useState<Record<string, FormMeta>>({});
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [w4File, setW4File] = useState<File | null>(null);
  const [i9File, setI9File] = useState<File | null>(null);
  const [w4Ver, setW4Ver] = useState("2026");
  const [i9Ver, setI9Ver] = useState("Expires 05/31/2027");
  const [printBusy, setPrintBusy] = useState(false);
  const officialPrintRef = useRef<HTMLDivElement | null>(null);

  const loadForms = useCallback(async () => {
    const d = await api<{ forms: Record<string, FormMeta> }>("/onboarding/forms");
    setForms(d.forms || {});
    if (d.forms?.w4?.version_label) setW4Ver(d.forms.w4.version_label);
    if (d.forms?.i9?.version_label) setI9Ver(d.forms.i9.version_label);
  }, []);

  useEffect(() => {
    if (!allowed) return;
    loadForms().catch((e) => setError(e instanceof Error ? e.message : "Could not load forms"));
  }, [allowed, loadForms]);

  useEffect(() => {
    return () => {
      document.body.classList.remove("print-onboarding");
    };
  }, []);

  function openOfficialPdfs() {
    const w4 = forms.w4?.url || "/onboarding/w4.pdf";
    const i9 = forms.i9?.url || "/onboarding/i9.pdf";
    window.open(w4, "_blank", "noopener,noreferrer");
    window.setTimeout(() => {
      window.open(i9, "_blank", "noopener,noreferrer");
    }, 350);
  }

  /** Embed official W-4 + I-9 pages into the print root for one complete packet. */
  async function renderOfficialPdfsIntoPrintRoot() {
    const host = officialPrintRef.current;
    if (!host) throw new Error("Print area missing");
    host.innerHTML = "";

    async function appendPdf(url: string, label: string) {
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Could not load ${label} (${res.status})`);
      const data = new Uint8Array(await res.arrayBuffer());
      const pdf = await getDocument({ data }).promise;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const base = page.getViewport({ scale: 1 });
        // Render sharp (2x) then display at letter width — keep aspect ratio exact
        const cssWidthIn = 7.5;
        const cssWidthPx = cssWidthIn * 96;
        const renderScale = (cssWidthPx * 2) / base.width;
        const viewport = page.getViewport({ scale: renderScale });
        const wrap = document.createElement("article");
        wrap.className = "onboard-pdf-sheet";
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        // Lock display size by aspect ratio so print cannot squash/stretch
        canvas.style.width = `${cssWidthIn}in`;
        canvas.style.height = "auto";
        canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
        canvas.style.maxWidth = "100%";
        canvas.style.display = "block";
        canvas.style.margin = "0 auto";
        wrap.appendChild(canvas);
        const cap = document.createElement("div");
        cap.className = "onboard-pdf-caption";
        cap.textContent = `${label} · page ${n} of ${pdf.numPages}`;
        wrap.appendChild(cap);
        host.appendChild(wrap);
        await page.render({ canvasContext: ctx, viewport }).promise;
        try {
          page.cleanup();
        } catch {
          /* ignore */
        }
      }
      // PDFDocumentProxy exposes cleanup(), not destroy() (destroy is on the loading task)
      try {
        await Promise.resolve(pdf.cleanup());
      } catch {
        /* ignore — canvases already painted */
      }
    }

    await appendPdf(
      forms.w4?.url || "/onboarding/w4.pdf",
      `Official Form W-4 (${forms.w4?.version_label || "2026"})`
    );
    await appendPdf(
      forms.i9?.url || "/onboarding/i9.pdf",
      `Official Form I-9 (${forms.i9?.version_label || "current"})`
    );
  }

  async function printPacket() {
    setError("");
    setOk("");
    setPrintBusy(true);
    if (officialPrintRef.current) officialPrintRef.current.innerHTML = "";

    try {
      setOk("Loading official W-4 and I-9 into the packet…");
      await renderOfficialPdfsIntoPrintRoot();
      document.body.classList.add("print-onboarding");
      await new Promise((r) => window.setTimeout(r, 150));

      await new Promise<void>((resolve) => {
        const cleanup = () => {
          document.body.classList.remove("print-onboarding");
          if (officialPrintRef.current) officialPrintRef.current.innerHTML = "";
          window.removeEventListener("afterprint", cleanup);
          resolve();
        };
        window.addEventListener("afterprint", cleanup);
        window.print();
        window.setTimeout(cleanup, 180_000);
      });

      setOk("Full hire packet printed (company forms + W-4 + I-9).");
    } catch (e) {
      document.body.classList.remove("print-onboarding");
      if (officialPrintRef.current) officialPrintRef.current.innerHTML = "";
      setError(
        e instanceof Error
          ? `${e.message} — you can still use Open W-4 & I-9 only.`
          : "Could not include W-4 / I-9. Try Open W-4 & I-9 only."
      );
    } finally {
      setPrintBusy(false);
    }
  }

  async function replaceForm(kind: "w4" | "i9", file: File | null, version: string) {
    if (!file) {
      setError(`Choose a PDF for ${kind.toUpperCase()}.`);
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("version_label", version.trim() || (kind === "w4" ? "2026" : "Current"));
      await api(`/onboarding/forms/${kind}`, { method: "POST", body: fd });
      setOk(`${kind.toUpperCase()} updated to “${version.trim()}”.`);
      if (kind === "w4") setW4File(null);
      else setI9File(null);
      await loadForms();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Replace failed");
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="page">
        <div className="error">Office or admin access required for new hire onboarding.</div>
        <p>
          <Link to="/admin">Back to People</Link>
        </p>
      </div>
    );
  }

  const w4Label = forms.w4?.version_label || "2026";
  const i9Label = forms.i9?.version_label || "Expires 05/31/2027";

  return (
    <div className="page onboard-page">
      <div className="page-header no-print">
        <div>
          <h1>New hire packet</h1>
          <p>
            One print job = company forms <strong>+ official W-4 + official I-9</strong>. Collect DL +
            SSN copies before they leave.
          </p>
        </div>
        <div className="onboard-header-actions">
          <Link className="btn secondary" to="/admin">
            Back to People
          </Link>
          <button
            type="button"
            className="btn"
            disabled={printBusy}
            onClick={() => void printPacket()}
          >
            {printBusy ? "Loading W-4 & I-9…" : "Print full hire packet"}
          </button>
        </div>
      </div>

      {error ? <div className="error inv-flash no-print">{error}</div> : null}
      {ok ? <div className="success inv-flash no-print">{ok}</div> : null}

      <div className="card no-print onboard-setup">
        <h2 className="inv-section-title">Packet details (optional)</h2>
        <div className="onboard-setup-grid">
          <label>
            New hire name
            <input
              value={hireName}
              onChange={(e) => setHireName(e.target.value)}
              placeholder="Full legal name"
            />
          </label>
          <label>
            Position
            <input
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="e.g. Install tech"
            />
          </label>
          <label>
            Start date
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            Packet date
            <input type="date" value={preparedOn} onChange={(e) => setPreparedOn(e.target.value)} />
          </label>
        </div>
        <p className="muted" style={{ margin: "0.65rem 0 0", fontSize: "0.88rem" }}>
          Active blanks: <strong>W-4 {w4Label}</strong>
          {forms.w4?.source === "upload" ? " (uploaded)" : " (bundled)"} ·{" "}
          <strong>I-9 {i9Label}</strong>
          {forms.i9?.source === "upload" ? " (uploaded)" : " (bundled)"}
        </p>
        <div className="onboard-setup-actions">
          <button
            type="button"
            className="btn"
            disabled={printBusy}
            onClick={() => void printPacket()}
          >
            {printBusy ? "Loading W-4 & I-9…" : "Print full hire packet"}
          </button>
          <button type="button" className="btn secondary" onClick={openOfficialPdfs}>
            Open W-4 &amp; I-9 only
          </button>
          <button
            type="button"
            className="btn secondary btn-sm"
            onClick={() => setShowReplace((v) => !v)}
          >
            {showReplace ? "Hide replace forms" : "Replace W-4 / I-9 (keep current)"}
          </button>
        </div>
        {showReplace ? (
          <div className="onboard-replace">
            <p className="muted" style={{ fontSize: "0.85rem" }}>
              When IRS releases a new W-4 (usually each January) or USCIS updates I-9, upload the new
              official PDF here. Do not use homemade recreations.
            </p>
            <form
              className="onboard-replace-row"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void replaceForm("w4", w4File, w4Ver);
              }}
            >
              <strong>W-4</strong>
              <input
                value={w4Ver}
                onChange={(e) => setW4Ver(e.target.value)}
                placeholder="Version e.g. 2026"
              />
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => setW4File(e.target.files?.[0] || null)}
              />
              <button className="btn secondary btn-sm" type="submit" disabled={busy}>
                Replace W-4
              </button>
            </form>
            <form
              className="onboard-replace-row"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                void replaceForm("i9", i9File, i9Ver);
              }}
            >
              <strong>I-9</strong>
              <input
                value={i9Ver}
                onChange={(e) => setI9Ver(e.target.value)}
                placeholder="e.g. Expires 05/31/2027"
              />
              <input
                type="file"
                accept="application/pdf,.pdf"
                onChange={(e) => setI9File(e.target.files?.[0] || null)}
              />
              <button className="btn secondary btn-sm" type="submit" disabled={busy}>
                Replace I-9
              </button>
            </form>
          </div>
        ) : null}
      </div>

      {/* ——— PRINT ROOT ——— */}
      <div className="onboard-print-root" id="onboard-print">
        {/* 1. Checklist */}
        <Sheet
          page={1}
          className="onboard-checklist-sheet"
          note="Packet continues with official W-4 and I-9 after page 6"
          letterhead={
            <Letterhead
              subtitle="New hire checklist · Collect before they leave"
              hireName={hireName}
              preparedBy={preparedBy}
              preparedOn={preparedOn}
            />
          }
        >
          <h2 className="onboard-doc-title">New hire checklist</h2>
          {(position || startDate) && (
            <p className="onboard-lead">
              {position ? (
                <>
                  Position: <strong>{position}</strong>
                </>
              ) : null}
              {position && startDate ? " · " : null}
              {startDate ? (
                <>
                  Start: <strong>{formatDisplayDate(startDate)}</strong>
                </>
              ) : null}
            </p>
          )}
          <p className="onboard-lead">
            Complete every item. Rows marked MUST COLLECT are easy to forget — do them first.
          </p>

          <table className="onboard-check-table">
            <thead>
              <tr>
                <th className="onboard-check-col-done">✓</th>
                <th>Checklist item</th>
              </tr>
            </thead>
            <tbody>
              <tr className="onboard-check-must">
                <td>
                  <span className="onboard-box" />
                </td>
                <td>
                  <strong>MUST COLLECT — Driver license copy</strong>
                  <div className="onboard-check-detail">Front and back · personnel file</div>
                </td>
              </tr>
              <tr className="onboard-check-must">
                <td>
                  <span className="onboard-box" />
                </td>
                <td>
                  <strong>MUST COLLECT — Social Security card copy</strong>
                  <div className="onboard-check-detail">Clear copy · personnel file</div>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="onboard-box" />
                </td>
                <td>Employee Application completed and signed</td>
              </tr>
              <tr>
                <td>
                  <span className="onboard-box" />
                </td>
                <td>
                  Official <strong>Form W-4 ({w4Label})</strong> completed
                </td>
              </tr>
              <tr>
                <td>
                  <span className="onboard-box" />
                </td>
                <td>
                  Official <strong>Form I-9 ({i9Label})</strong> — employee Section 1; office verifies
                  docs within 3 business days
                </td>
              </tr>
              <tr>
                <td>
                  <span className="onboard-box" />
                </td>
                <td>Direct deposit form (+ voided check if available)</td>
              </tr>
              <tr>
                <td>
                  <span className="onboard-box" />
                </td>
                <td>Emergency contact form</td>
              </tr>
              <tr>
                <td>
                  <span className="onboard-box" />
                </td>
                <td>Field App invite sent · Handbook acknowledgment explained</td>
              </tr>
            </tbody>
          </table>

          <div className="onboard-sign-row">
            <div>
              <div className="onboard-sign-line" />
              <div className="onboard-sign-label">Office received packet</div>
            </div>
            <div>
              <div className="onboard-sign-line" />
              <div className="onboard-sign-label">Date</div>
            </div>
          </div>
        </Sheet>

        {/* 2. Application p1 */}
        <Sheet
          page={2}
          className="onboard-app-sheet"
          note="EOE · Background check, drug screen & references required · Valid 90 days"
          letterhead={
            <Letterhead
              subtitle="Employee application · 1 of 3"
              hireName={hireName}
              preparedBy={preparedBy}
              preparedOn={preparedOn}
            />
          }
        >
          <h2 className="onboard-doc-title">Application for employment</h2>
          <div className="onboard-grid-2">
            <Field label="Date of application" />
            <Field label="Position desired" />
          </div>

          <h3 className="onboard-h">Personal information</h3>
          <Field label="Full legal name (first, middle, last)" wide />
          <div className="onboard-grid-2">
            <Field label="Street address" />
            <div className="onboard-grid-3 onboard-nested-3">
              <Field label="City" />
              <Field label="ST" />
              <Field label="ZIP" />
            </div>
          </div>
          <div className="onboard-grid-3">
            <Field label="Cell phone" />
            <Field label="Alt phone" />
            <Field label="Email" />
          </div>
          <div className="onboard-grid-3">
            <Field label="SSN" hint="background check" />
            <Field label="Date of birth" />
            <Field label="DL # / state / expires" />
          </div>

          <div className="onboard-yn-inline">
            <span>
              Work authorized in U.S.? <YesNo />
            </span>
            <span>
              Age 18+? <YesNo />
            </span>
            <span>
              Worked here before? <YesNo />
            </span>
          </div>
          <Field label="If yes — prior dates & position" wide />
          <div className="onboard-yn-inline">
            <span>
              Felony/misdemeanor (not minor traffic)? <YesNo />
            </span>
          </div>
          <Field label="If yes — date, charge, jurisdiction, outcome" wide />

          <h3 className="onboard-h">Availability &amp; preferences</h3>
          <div className="onboard-grid-3">
            <Field label="Earliest start" />
            <Field label="Desired pay" />
            <Field label="Availability (days/hours)" />
          </div>
          <p className="onboard-q">
            Type: <span className="onboard-box" /> Full-time <span className="onboard-box" /> Part-time{" "}
            <span className="onboard-box" /> Seasonal <span className="onboard-box" /> On-call
            &nbsp;&nbsp; OT / evenings / weekends OK? <YesNo />
          </p>
          <div className="onboard-yn-inline">
            <span>
              Reliable transportation to job sites? <YesNo />
            </span>
            <span>
              Clean driving record (5 yrs)? <YesNo />
            </span>
          </div>
        </Sheet>

        {/* 3. Application p2 — education + 3 employers */}
        <Sheet
          page={3}
          className="onboard-app-sheet onboard-sheet-workhist"
          note="Application · education & work history"
          letterhead={
            <Letterhead
              subtitle="Employee application · 2 of 3"
              hireName={hireName}
              preparedBy={preparedBy}
              preparedOn={preparedOn}
            />
          }
        >
          <h2 className="onboard-doc-title">Education &amp; work history</h2>

          <h3 className="onboard-h">Education &amp; HVAC credentials</h3>
          <div className="onboard-grid-3">
            <Field label="High school / GED" />
            <Field label="Graduated? Y / N" />
            <Field label="Years HVAC experience" />
          </div>
          <div className="onboard-grid-2">
            <Field label="College / trade / apprenticeship" />
            <Field label="Focus (install / service / commercial…)" />
          </div>
          <Field label="Certifications (EPA 608, NATE, ICE, state license…)" wide />

          <h3 className="onboard-h">Employment history — most recent first (list all that apply)</h3>
          <div className="onboard-emp-stack">
            {[1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="onboard-emp-row">
                <div className="onboard-emp-num">{n}</div>
                <div className="onboard-emp-body">
                  <div className="onboard-grid-4">
                    <Field label="Company" />
                    <Field label="From → To" />
                    <Field label="Job title" />
                    <Field label="Pay" />
                  </div>
                  <div className="onboard-grid-2">
                    <Field label="Supervisor / phone" />
                    <div className="onboard-field">
                      <div className="onboard-field-label">
                        May we contact this employer? <YesNo />
                      </div>
                    </div>
                  </div>
                  <div className="onboard-field onboard-field-grow">
                    <div className="onboard-field-label">
                      Key duties, achievements, and reason for leaving
                    </div>
                    <Line wide />
                    <Line wide />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Sheet>

        {/* 4. Application p3 */}
        <Sheet
          page={4}
          className="onboard-app-sheet"
          note="Thank you · Equal Opportunity Employer · End of application"
          letterhead={
            <Letterhead
              subtitle="Employee application · 3 of 3"
              hireName={hireName}
              preparedBy={preparedBy}
              preparedOn={preparedOn}
            />
          }
        >
          <h2 className="onboard-doc-title">References &amp; certification</h2>

          <h3 className="onboard-h">Skills &amp; equipment</h3>
          <Field label="Tools / software (gauges, recovery, ServiceTitan…)" wide />
          <p className="onboard-q">
            CDL / box truck / boom / scissor lift? <span className="onboard-box" /> CDL{" "}
            <span className="onboard-box" /> Lifts <span className="onboard-box" /> None
            &nbsp;&nbsp; Military (optional): <Line />
          </p>

          <h3 className="onboard-h">Professional references (3 — no relatives)</h3>
          <div className="onboard-ref-table">
            <div className="onboard-ref-head">
              <span>Name</span>
              <span>Company / title</span>
              <span>Phone</span>
              <span>Relationship</span>
            </div>
            {[1, 2, 3].map((n) => (
              <div key={n} className="onboard-ref-row">
                <span className="onboard-ref-cell" />
                <span className="onboard-ref-cell" />
                <span className="onboard-ref-cell" />
                <span className="onboard-ref-cell" />
              </div>
            ))}
          </div>

          <Field label="Why Total Assurance? (optional)" wide />

          <div className="onboard-keep onboard-sign-bottom">
            <h3 className="onboard-h">Authorization &amp; signature</h3>
            <div className="onboard-ack-box">
              <p>
                I certify this application is true and complete. False statements may result in refusal
                of employment or termination. I authorize background checks (criminal, MVR, employment,
                education, credit where allowed) and drug/alcohol screening. Employment is{" "}
                <strong>at-will</strong> and this form is not a contract.
              </p>
            </div>
            <div className="onboard-sign-row">
              <div>
                <div className="onboard-sign-line" />
                <div className="onboard-sign-label">Applicant signature</div>
              </div>
              <div>
                <div className="onboard-sign-line" />
                <div className="onboard-sign-label">Date</div>
              </div>
            </div>
            <Field label="Printed name" wide />
          </div>
        </Sheet>

        {/* 5. Direct deposit */}
        <Sheet
          page={5}
          note="Confidential · Attach voided check if available"
          letterhead={
            <Letterhead
              subtitle="Payroll · Direct deposit"
              hireName={hireName}
              preparedBy={preparedBy}
              preparedOn={preparedOn}
            />
          }
        >
          <h2 className="onboard-doc-title">Direct deposit authorization</h2>
          <p className="onboard-lead">
            Prefer attaching a <strong>voided check</strong>. Routing # = 9 digits, bottom-left of check.
          </p>
          <div className="onboard-grid-2">
            <Field label="Employee name" />
            <Field label="Email for pay notices" />
          </div>

          <div className="onboard-account-card">
            <h3 className="onboard-h">Primary account</h3>
            <p className="onboard-q">
              <span className="onboard-box" /> Checking <span className="onboard-box" /> Savings
              &nbsp;&nbsp; Amount: <span className="onboard-box" /> Full net{" "}
              <span className="onboard-box" /> %{" "}
              <span className="onboard-mini-line" /> <span className="onboard-box" /> ${" "}
              <span className="onboard-mini-line" />
            </p>
            <div className="onboard-grid-3">
              <Field label="Bank name" />
              <Field label="Routing # (9 digits)" />
              <Field label="Account #" />
            </div>
          </div>

          <div className="onboard-account-card">
            <h3 className="onboard-h">Second account (optional)</h3>
            <p className="onboard-q">
              <span className="onboard-box" /> Checking <span className="onboard-box" /> Savings
              &nbsp;&nbsp; Amount: <span className="onboard-box" /> %{" "}
              <span className="onboard-mini-line" /> <span className="onboard-box" /> ${" "}
              <span className="onboard-mini-line" /> <span className="onboard-box" /> Remainder
            </p>
            <div className="onboard-grid-3">
              <Field label="Bank name" />
              <Field label="Routing # (9 digits)" />
              <Field label="Account #" />
            </div>
          </div>

          <div className="onboard-keep onboard-sign-bottom">
            <div className="onboard-ack-box">
              <p>
                I authorize Total Assurance A/C &amp; Heating to deposit pay to the account(s) above and
                to correct deposit errors. Remains in effect until I give written notice (14+ days
                preferred).
              </p>
            </div>
            <div className="onboard-sign-row">
              <div>
                <div className="onboard-sign-line" />
                <div className="onboard-sign-label">Employee signature</div>
              </div>
              <div>
                <div className="onboard-sign-line" />
                <div className="onboard-sign-label">Date</div>
              </div>
            </div>
          </div>
        </Sheet>

        {/* 6. Emergency + welcome */}
        <Sheet
          page={6}
          note="3833 Saturn Rd, Corpus Christi, TX 78413 · 361-446-6925 · End of branded packet"
          letterhead={
            <Letterhead
              subtitle="Emergency contact &amp; welcome"
              hireName={hireName}
              preparedBy={preparedBy}
              preparedOn={preparedOn}
            />
          }
        >
          <h2 className="onboard-doc-title">Emergency contact</h2>
          <Field label="Employee name" wide />
          <div className="onboard-grid-2">
            <div className="onboard-account-card">
              <h3 className="onboard-h">Primary</h3>
              <Field label="Name" />
              <div className="onboard-grid-2">
                <Field label="Relationship" />
                <Field label="Phone" />
              </div>
            </div>
            <div className="onboard-account-card">
              <h3 className="onboard-h">Secondary (optional)</h3>
              <Field label="Name" />
              <div className="onboard-grid-2">
                <Field label="Relationship" />
                <Field label="Phone" />
              </div>
            </div>
          </div>
          <Field label="Allergies / medical notes for office (optional)" wide />

          <h3 className="onboard-h">Welcome — next steps</h3>
          <ol className="onboard-steps">
            <li>Finish this packet (application, W-4, I-9, deposit, emergency contact).</li>
            <li>
              Office copies your <strong>driver’s license</strong> and <strong>Social Security card</strong>.
            </li>
            <li>
              Use your <strong>Field App invite</strong> → open <strong>Handbook</strong> → confirm.
            </li>
            <li>Ask your manager about safety orientation, tools, truck, and first-week schedule.</li>
          </ol>

          <div className="onboard-keep onboard-sign-bottom">
            <div className="onboard-ack-box">
              <p>
                I understand I-9 docs are due within 3 business days of hire. Total Assurance is an
                at-will Equal Opportunity Employer.
              </p>
            </div>
            <div className="onboard-sign-row">
              <div>
                <div className="onboard-sign-line" />
                <div className="onboard-sign-label">New hire signature</div>
              </div>
              <div>
                <div className="onboard-sign-line" />
                <div className="onboard-sign-label">Date</div>
              </div>
            </div>
          </div>
        </Sheet>

        {/* Official IRS W-4 + USCIS I-9 — canvases filled right before print */}
        <div
          className="onboard-official-print"
          ref={officialPrintRef}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
