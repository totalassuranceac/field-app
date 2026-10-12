/**
 * REFERENCE (box prototype, not compiled against the live tree). Admin-only log for the post-payment Google
 * review text (Chris's 10/3 7:23 AM spec). Match the live tree's page-header / table / badge classes on the PC.
 * Mode control: Off, Dry run and Test number ONLY. There is no Live option in this build.
 * Test number = real texts go ONLY to the env allowlist REVIEW_TEXT_TEST_NUMBER (shown masked); every other
 * customer is logged as "would text". Test mode also needs env REVIEW_TEXT_LIVE_SEND=on; neither is set in this build.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type Row = {
  id: number;
  st_payment_id: string;
  st_customer_id: number;
  customer_name: string | null;
  payment_type: string | null;
  payment_total: number | null;
  payment_created_on: string | null;
  payment_created_by: string | null;
  status: string;
  reason: string | null;
  st_job_id: string | null;
  eligible_at: string | null;
  template_variant: string | null;
  segments: number | null;
  tech_first: string | null;
  reviewed: number;
  phone_masked: string;
  body: string | null;
  hold_until: string | null;
  decided_at: string | null;
};
type Mode = "off" | "dry" | "test" | "live";
type Preview = { variant: string; body: string; chars: number; segments: number };
type Resp = {
  mode: Mode;
  mode_note?: string;
  test_number_masked: string | null;
  last_tick: { at: string; polled: number; would_send: number; sent: number; skipped: number; voided: number; held: number; errors: string[] } | null;
  counts: Record<string, number>;
  previews: Preview[];
  rows: Row[];
};

type Sample = { id: string; found: boolean; type_name: string | null; batch: string | null; invoices: string; total: number | null; decision: string };
/** Gauge's 10/3 samples: 4 expected to text (2 office checks, 2 field cards), 1 online expected skipped. */
const SAMPLE_IDS = "397158161,397105159,397164560,397143295,397074687";
const EXPECTED: Record<string, string> = {
  "397158161": "would_queue",
  "397105159": "would_queue",
  "397164560": "would_queue",
  "397143295": "would_queue",
  "397074687": "skip:type_excluded",
};

const STATUSES = ["", "would_send", "sent", "held", "queued", "skipped", "voided", "error"];
const LABEL: Record<string, string> = {
  would_send: "Would text",
  held: "Waiting",
  queued: "Checking for voids",
  skipped: "Skipped",
  voided: "Voided",
  error: "Error",
  sent: "Sent",
};
/** Plain-English reasons for the office. */
const WHY: Record<string, string> = {
  dry_run: "Dry run: logged only",
  not_test_number: "Test mode: not the test number, logged only",
  test_number: "Test mode: sent to the test number",
  live_flag_off: "Live blocked (flag off): logged only",
  waiting_complete: "Waiting for the job to be completed",
  waiting_paid: "Waiting for the invoice to be paid in full",
  waiting_2h: "Waiting 2 h after completed + paid",
  held_for_window: "Held for the 9 AM-7 PM window",
  type_excluded: "Payment type not in-person (e.g. Online Payments)",
  online_batch: "Online batch (Adyen)",
  no_mobile: "No mobile number (landline only)",
  no_text_flag: "Do-not-text on the contact",
  opted_out: "Texted STOP before",
  payment_gone: "Payment voided before the recheck",
  customer_cap: "Already asked in the last 90 days",
  phone_cap: "This phone was asked in the last 90 days",
  same_job: "Another payment on this job already counted",
  job_canceled: "Job canceled",
  recall: "Recall job",
  callback_job_type: "Callback job type",
  flagged_tag: "Flagged tag (complaint, dispute, do not text...)",
  home_warranty: "Home warranty job",
  commercial_no_contact: "Commercial, no named contact",
  already_reviewed: "Marked as already reviewed",
  not_completed: "Job never completed (gave up after 14 days)",
  not_paid: "Invoice never paid (gave up after 14 days)",
  stale: "Too late (over 72 h after eligible)",
};
const VARIANT: Record<string, string> = {
  tech_named: "Name + tech",
  notech_named: "Name, no tech",
  tech_noname: "No name + tech",
  notech_noname: "No name, no tech",
};

function ct(s: string | null): string {
  if (!s) return "";
  const ms = Date.parse(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  if (!Number.isFinite(ms)) return s;
  return new Date(ms).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) + " CT";
}
const modeLabel = (m: Mode) => (m === "dry" ? "Dry run (no texts sent)" : m === "test" ? "Test number only" : m === "off" ? "Off" : "Live");

export function ReviewTextPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Resp | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const isAdmin = user?.role === "admin";
  const [ids, setIds] = useState(SAMPLE_IDS);
  const [samples, setSamples] = useState<Sample[] | null>(null);

  async function checkSamples() {
    setError("");
    try {
      const r = await api<{ ok: boolean; error?: string; rows: Sample[] }>(`/review-text/verify?ids=${encodeURIComponent(ids)}`);
      if (!r.ok) setError(r.error || "Check failed");
      setSamples(r.rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Check failed");
    }
  }

  const load = () =>
    api<Resp>(`/review-text/log?limit=200${status ? `&status=${status}` : ""}`)
      .then(setData)
      .catch((e) => setError(e.message));

  useEffect(() => {
    if (isAdmin) void load();
  }, [isAdmin, status]);

  if (!isAdmin) return <div className="error">Admin only.</div>;

  async function setMode(mode: "off" | "dry" | "test") {
    setSaving(true);
    try {
      await api("/review-text/mode", { method: "PUT", body: JSON.stringify({ mode }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function testSend() {
    setSaving(true);
    setNote("");
    try {
      const r = await api<{ ok: boolean; error?: string; to_masked?: string; segments?: number }>("/review-text/test-send", { method: "POST", body: "{}" });
      setNote(r.ok ? `Test text sent to ${r.to_masked} (${r.segments} texts).` : `Not sent: ${r.error}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Test send failed");
    } finally {
      setSaving(false);
    }
  }

  async function setReviewed(customerId: number, reviewed: boolean) {
    try {
      await api("/review-text/reviewed", { method: "POST", body: JSON.stringify({ customerId, reviewed }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Review texts</h1>
          <p>
            Who would get a Google review text 2 hours after the job is completed and paid (office or field, in person). Sent only 9 AM-7 PM CT,
            Mon-Sat. Nothing is sent from this page except a test to the test number.
          </p>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <div className="card">
            <strong>Mode: {modeLabel(data.mode)}</strong>
            {data.mode_note === "live_flag_off" && <div className="muted">Real texts are blocked: the separate send flag is off.</div>}
            {data.mode_note === "test_number_missing" && <div className="muted">Test mode needs a test number set on the server. Running as dry run.</div>}
            {data.mode_note === "test_number_set" && <div className="muted">A test number is set, so only it can get a real text.</div>}
            <div className="muted">Test number: {data.test_number_masked || "not set"}</div>
            <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button disabled={saving || data.mode === "off"} onClick={() => setMode("off")}>Turn off</button>
              <button disabled={saving || data.mode === "dry"} onClick={() => setMode("dry")}>Dry run</button>
              <button disabled={saving || data.mode === "test"} onClick={() => setMode("test")}>Test number only</button>
              <button disabled={saving || data.mode !== "test"} onClick={() => void testSend()}>Send a test to the test number</button>
            </div>
            {note && <div className="muted" style={{ marginTop: 6 }}>{note}</div>}
            {data.last_tick && (
              <div className="muted" style={{ marginTop: 8 }}>
                Last check {ct(data.last_tick.at)}: {data.last_tick.polled} payments read, {data.last_tick.would_send} would text, {data.last_tick.sent} sent,{" "}
                {data.last_tick.skipped} skipped, {data.last_tick.voided} voided, {data.last_tick.held} waiting
                {data.last_tick.errors.length ? `. Errors: ${data.last_tick.errors.join(", ")}` : ""}
              </div>
            )}
          </div>
          <div className="card">
            <strong>Text preview (fake names)</strong>
            {data.previews.map((p) => (
              <div key={p.variant} style={{ marginTop: 6 }}>
                <div className="muted">{VARIANT[p.variant] || p.variant}: {p.chars} characters, {p.segments} {p.segments === 1 ? "text" : "texts (segments)"}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{p.body}</div>
              </div>
            ))}
          </div>
          <div className="card">
            <strong>Check payments (read only)</strong>
            <div className="muted">Reads these ServiceTitan payments and shows what the rules would do. Nothing is saved or sent.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <input value={ids} onChange={(e) => setIds(e.target.value)} style={{ flex: 1 }} />
              <button onClick={() => void checkSamples()}>Check</button>
            </div>
            {samples && (
              <table className="table" style={{ marginTop: 6 }}>
                <thead>
                  <tr><th>Payment</th><th>Type</th><th>Batch</th><th>Invoices</th><th>Amount</th><th>Result</th><th>Expected</th></tr>
                </thead>
                <tbody>
                  {samples.map((r) => (
                    <tr key={r.id}>
                      <td>{r.id}</td><td>{r.type_name || (r.found ? "?" : "not found")}</td><td>{r.batch || ""}</td><td>{r.invoices}</td>
                      <td>{r.total != null ? `$${r.total.toFixed(2)}` : ""}</td><td>{r.decision}</td>
                      <td>{EXPECTED[r.id] ? (EXPECTED[r.id] === r.decision ? "match" : `MISMATCH (want ${EXPECTED[r.id]})`) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div style={{ margin: "8px 0" }}>
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? `${LABEL[s]} (${data.counts[s] || 0})` : "All"}
                </option>
              ))}
            </select>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Paid</th><th>Customer</th><th>Type</th><th>Amount</th><th>Job</th><th>Tech</th><th>Result</th><th>Why</th><th>Mobile</th><th>Text</th><th>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td>{ct(r.payment_created_on)}</td>
                  <td>{r.customer_name || ""}</td>
                  <td>{r.payment_type || ""}</td>
                  <td>{r.payment_total != null ? `$${r.payment_total.toFixed(2)}` : ""}</td>
                  <td>{r.st_job_id || ""}</td>
                  <td>{r.tech_first || ""}</td>
                  <td>{LABEL[r.status] || r.status}{r.status === "held" && r.hold_until ? ` until ${ct(r.hold_until)}` : ""}</td>
                  <td>{(r.reason && WHY[r.reason]) || r.reason || ""}</td>
                  <td>{r.phone_masked}</td>
                  <td>
                    {r.body ? (
                      <>
                        <div className="muted">{VARIANT[r.template_variant || ""] || ""}{r.segments ? `, ${r.segments} seg` : ""}</div>
                        <div style={{ whiteSpace: "pre-wrap", maxWidth: 360 }}>{r.body}</div>
                      </>
                    ) : ""}
                  </td>
                  <td>
                    <label>
                      <input type="checkbox" checked={Boolean(r.reviewed)} onChange={(e) => void setReviewed(r.st_customer_id, e.target.checked)} /> Left a review
                    </label>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
