import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, roleLabel } from "../api";
import { useAuth } from "../auth";
import { MyShortcuts } from "../components/MyShortcuts";
import { NewHireSafetyCard } from "../components/NewHireSafetyCard";
import { ResponsibilityHomeCard } from "../components/ResponsibilityHomeCard";
import { PullTomorrowHome } from "./TomorrowMaterialsPage";
import { isAzaliMiller } from "../lib/azaliRnc";
import { cleanUiText } from "../lib/utf8Mojibake";



interface SchedIssue {
  id: number;
  unit_number: string;
  title: string;
  status: string;
  scheduled_date: string | null;
  severity: string;
  is_emergency?: number;
  reporter_name?: string;
}

/**
 * Clean office home: live map + what's scheduled for the shop.
 * Hides shop-floor noise (fuel OCR, yard stickers, mileage flags, etc.).
 */
export function OfficeHome() {
  const { user } = useAuth();
  const [issues, setIssues] = useState<SchedIssue[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [warranties, setWarranties] = useState(0);
  const [vendorWaiting, setVendorWaiting] = useState(0);
  const [regAttention, setRegAttention] = useState(0);
  const [regHint, setRegHint] = useState("");

  function load() {
    setLoading(true);
    setError("");
    Promise.all([
      api<{ issues: SchedIssue[] }>("/issues?report=schedule"),
      api<{ unread: number }>("/notifications").catch(() => ({ unread: 0 })),
      api<{ file_count?: number; attention_count?: number; warranties?: unknown[] }>(
        "/warranties?status=file"
      ).catch(
        (): {
          file_count: number;
          attention_count: number;
          warranties: unknown[];
        } => ({
          file_count: 0,
          attention_count: 0,
          warranties: [],
        })
      ),
      api<{ waiting?: number }>("/inventory/vendor-runs/count").catch(() => ({
        waiting: 0,
      })),
      api<{
        stats?: {
          registration_attention?: number;
          registration_expired?: number;
          registration_due_soon?: number;
          registration_missing?: number;
        };
      }>("/dashboard").catch(() => ({ stats: {} })),
    ])
      .then(([iss, n, w, vr, dash]) => {
        setIssues(iss.issues || []);
        setUnread(n.unread || 0);
        setWarranties(
          typeof w.file_count === "number"
            ? w.file_count
            : typeof w.attention_count === "number"
              ? w.attention_count
              : (w.warranties || []).length
        );
        setVendorWaiting(vr.waiting || 0);
        const st = dash.stats || {};
        const att = Number(st.registration_attention || 0);
        setRegAttention(att);
        const bits = [
          st.registration_expired ? `${st.registration_expired} expired` : null,
          st.registration_due_soon ? `${st.registration_due_soon} due soon` : null,
          st.registration_missing ? `${st.registration_missing} missing date` : null,
        ].filter(Boolean);
        setRegHint(
          bits.length ? bits.join(" - ") : "Expired, due in 30 days, or missing sticker date"
        );
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
  }, []);

  const emergencies = issues.filter(
    (i) => i.is_emergency || i.severity === "critical" || i.status === "open"
  );
  const scheduled = issues.filter(
    (i) => i.status === "scheduled" || i.status === "in_progress"
  );
  const first = user?.display_name?.split(" ")[0] || "there";

  return (
    <div className="office-home">
      <header className="office-hero">
        <div>
          <p className="office-kicker">{roleLabel(user?.role || "office")}</p>
          <h1 className="office-title">Hi, {first}</h1>
          <p className="office-sub">Where the fleet is - what the shop has scheduled</p>
        </div>
      </header>

      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <NewHireSafetyCard />
      <ResponsibilityHomeCard />

      {emergencies.length > 0 && (
        <section className="office-section">
          <div className="office-section-head">
            <h2>Needs attention</h2>
          </div>
          <div className="card office-attention">
            <p style={{ margin: 0 }}>
              <strong>{emergencies.length}</strong> open or urgent item
              {emergencies.length === 1 ? "" : "s"} on the board - use{" "}
              <Link to="/issues">Scheduled repairs</Link> or the live map if a unit is stopped.
            </p>
          </div>
        </section>
      )}

      <section className="office-section" aria-label="Waiting">
        <div className="office-section-head">
          <h2>Waiting</h2>
        </div>
        <div className="office-actions">
          {unread > 0 && (
          <Link to="/notifications" className="office-action alert">
            <span className="office-action-icon" aria-hidden>
              !
            </span>
            <span>
              <strong>Notifications</strong>
              <span className="office-action-hint">
                {unread} unread - check for driver emergencies
              </span>
            </span>
          </Link>
        )}
          <Link to="/warranties" className="office-action">
          <span className="office-action-icon" aria-hidden>
            W
          </span>
          <span>
            <strong>Warranties to file</strong>
            <span className="office-action-hint">
              {warranties ? `${warranties} on File pile` : "File pile clear"}
            </span>
          </span>
        </Link>
          <Link to="/part-pickup" className="office-action">
          <span className="office-action-icon" aria-hidden>
            PK
          </span>
          <span>
            <strong>Will-call</strong>
            <span className="office-action-hint">
              {vendorWaiting
                ? `${vendorWaiting} waiting for warehouse pickup`
                : "Parts ready at a store - request pickup"}
            </span>
          </span>
        </Link>
          <Link to="/yard?filter=registration" className="office-action">
          <span className="office-action-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                fill="currentColor"
                d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11v6h-2v2h-2v-2H9v2H7v-2H5v-6zm2.2-1h9.6l-1-3H8.2l-1 3zM7.5 16a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm9 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"
              />
            </svg>
          </span>
          <span>
            <strong>
              Fleet compliance{regAttention > 0 ? ` (${regAttention})` : ""}
            </strong>
            <span className="office-action-hint">
              {cleanUiText(regHint || "Sticker dates - expired - missing")}
            </span>
          </span>
        </Link>
          <Link to="/issues" className="office-action">
          <span className="office-action-icon" aria-hidden>
            RP
          </span>
          <span>
            <strong>Repair board</strong>
            <span className="office-action-hint">
              {scheduled.length
                ? `${scheduled.length} scheduled or in progress`
                : "Nothing scheduled right now"}
            </span>
          </span>
        </Link>
        </div>
      </section>

      <section className="home-section" aria-label="Pull for tomorrow">
        <div className="office-actions">
          <PullTomorrowHome />
        </div>
      </section>
      <MyShortcuts />

      <section className="office-section" aria-label="Daily">
        <div className="office-section-head">
          <h2>Daily</h2>
        </div>
        <div className="office-actions">
          <Link to="/day-board" className="office-action primary">
          <span className="office-action-icon" aria-hidden>
            JB
          </span>
          <span>
            <strong>Today's jobs</strong>
            <span className="office-action-hint">
              {cleanUiText("Tech - jobs - pick any day")}
            </span>
          </span>
        </Link>
          <Link to="/ops/job-lengths" className="office-action">
          <span className="office-action-icon" aria-hidden>
            JL
          </span>
          <span>
            <strong>Job lengths</strong>
            <span className="office-action-hint">How long jobs are running</span>
          </span>
        </Link>
          <Link to="/nate" className="office-action">
          <span className="office-action-icon" aria-hidden>
            NA
          </span>
          <span>
            <strong>Who is ready for NATE</strong>
            <span className="office-action-hint">Practice status. No ranking.</span>
          </span>
        </Link>
          {isAzaliMiller(user) ? (
          <Link to="/new-construction" className="office-action">
            <span>
              <strong>New Azali house</strong>
              <span className="office-action-hint">RNC location and project</span>
            </span>
          </Link>
        ) : null}
          <Link to="/install-book" className="office-action">
          <span className="office-action-icon" aria-hidden>
            +
          </span>
          <span>
            <strong>Book install</strong>
            <span className="office-action-hint">Miller / Install + NC / book jobs</span>
          </span>
        </Link>
          <Link to="/ops-performance?period=7" className="office-action">
          <span className="office-action-icon" aria-hidden>
            WK
          </span>
          <span>
            <strong>Shop scoreboard</strong>
            <span className="office-action-hint">
              This Chicago week - jobs, sales, comebacks, recalls
            </span>
          </span>
        </Link>
          <Link to="/tv" className="office-action">
          <span className="office-action-icon" aria-hidden>
            TV
          </span>
          <span>
            <strong>TV board</strong>
            <span className="office-action-hint">Full-screen for the office TV</span>
          </span>
        </Link>
          <Link to="/invoice-lookup" className="office-action">
          <span className="office-action-icon" aria-hidden>
            IN
          </span>
          <span>
            <strong>Invoice lookup</strong>
            <span className="office-action-hint">Address - model and serial - print</span>
          </span>
        </Link>
          <Link to="/inventory" className="office-action">
          <span className="office-action-icon" aria-hidden>
            ST
          </span>
          <span>
            <strong>Stock room</strong>
            <span className="office-action-hint">View stock and trucks</span>
          </span>
        </Link>
        </div>
      </section>

      <ProposalFollowupCard />

      <section className="office-section">
        <div className="office-section-head">
          <h2>On the shop board</h2>
          <Link to="/issues" className="home-mini-link">
            All -
          </Link>
        </div>

        {loading && !issues.length ? (
          <p className="muted">Loading...</p>
        ) : !issues.length ? (
          <div className="office-empty card">
            <p>
              <strong>No open or scheduled repairs.</strong>
            </p>
            <p className="muted" style={{ margin: 0 }}>
              When a tech reports an issue or the shop schedules work, it shows up here.
            </p>
          </div>
        ) : (
          <ul className="office-repair-list">
            {issues.slice(0, 12).map((i) => (
              <li key={i.id}>
                <Link to="/issues" className="office-repair-card">
                  <div className="office-repair-top">
                    <strong className="office-unit">Unit {i.unit_number}</strong>
                    <span className={`badge ${i.status}`}>{i.status.replace(/_/g, " ")}</span>
                    {(i.is_emergency || i.severity === "critical") && (
                      <span className="badge critical">urgent</span>
                    )}
                  </div>
                  <div className="office-repair-title">{i.title}</div>
                  <div className="office-repair-meta muted">
                    {i.scheduled_date ? `Scheduled ${i.scheduled_date}` : "Not dated yet"}
                    {i.reporter_name ? ` - ${i.reporter_name}` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="office-footnote muted">
        Office view is streamlined on purpose. Shop and admin tools stay with mechanics and admins.
      </p>
    </div>
  );
}

type FollowupItem = {
  id: number;
  customer_name: string | null;
  job_address: string | null;
  title: string | null;
  followup_day: number;
  followup_due_at: string;
  draft_body: string | null;
  status: string;
};

/** Lean proposal follow-up queue - READY drafts only; never auto-email. */
function ProposalFollowupCard() {
  const [items, setItems] = useState<FollowupItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [form, setForm] = useState({
    customer_name: "",
    job_address: "",
    title: "",
    sent_at: "",
  });
  const [msg, setMsg] = useState("");

  async function loadFollowups() {
    try {
      const d = await api<{ items: FollowupItem[] }>("/proposals/followups?status=ready");
      setItems(d.items || []);
    } catch {
      setItems([]);
    }
  }

  useEffect(() => {
    void loadFollowups();
  }, []);

  async function stampSent(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      await api("/proposals/sent", {
        method: "POST",
        body: JSON.stringify({
          customer_name: form.customer_name.trim() || null,
          job_address: form.job_address.trim() || null,
          title: form.title.trim() || null,
          sent_at: form.sent_at || null,
        }),
      });
      setMsg("Proposal stamped - 3-day and 7-day drafts scheduled (manual send only).");
      setForm({ customer_name: "", job_address: "", title: "", sent_at: "" });
      setShowLog(false);
      await loadFollowups();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Could not stamp proposal");
    } finally {
      setBusy(false);
    }
  }

  async function act(id: number, action: "mark_sent" | "dismiss") {
    setBusy(true);
    try {
      await api(`/proposals/followups/${id}/ready-action`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      await loadFollowups();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="office-section">
      <div className="office-section-head">
        <h2>Proposal follow-ups</h2>
        <button
          type="button"
          className="btn secondary btn-sm"
          onClick={() => setShowLog((v) => !v)}
        >
          {showLog ? "Hide log" : "Log proposal sent"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: "0.82rem", marginTop: 0 }}>
        Soft lock: drafts only - never auto-email. Tap Mark sent after you copy/send yourself.
      </p>
      {msg ? <div className="info-banner">{msg}</div> : null}
      {showLog && (
        <form className="card form" onSubmit={(ev) => void stampSent(ev)} style={{ marginBottom: "0.75rem" }}>
          <div className="form row">
            <label>
              Customer
              <input
                value={form.customer_name}
                onChange={(e) => setForm({ ...form, customer_name: e.target.value })}
                placeholder="Name"
              />
            </label>
            <label>
              Address
              <input
                value={form.job_address}
                onChange={(e) => setForm({ ...form, job_address: e.target.value })}
                placeholder="Job street"
              />
            </label>
          </div>
          <div className="form row">
            <label>
              Proposal / estimate title
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Optional"
              />
            </label>
            <label>
              Sent date
              <input
                type="date"
                value={form.sent_at}
                onChange={(e) => setForm({ ...form, sent_at: e.target.value })}
              />
            </label>
          </div>
          <button className="btn btn-sm" type="submit" disabled={busy}>
            {busy ? "Saving..." : "Stamp sent + schedule 3d / 7d"}
          </button>
        </form>
      )}
      {!items.length ? (
        <div className="card muted">No READY follow-up drafts.</div>
      ) : (
        <ul className="office-repair-list">
          {items.map((it) => (
            <li key={it.id} className="card" style={{ listStyle: "none", marginBottom: "0.5rem" }}>
              <div>
                <strong>
                  Day {it.followup_day} - {it.customer_name || "Customer"}
                </strong>
                <span className="muted"> - due {it.followup_due_at}</span>
              </div>
              {it.job_address ? (
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {it.job_address}
                </div>
              ) : null}
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  fontSize: "0.85rem",
                  margin: "0.45rem 0",
                  background: "rgba(0,0,0,0.03)",
                  padding: "0.5rem",
                  borderRadius: 8,
                }}
              >
                {it.draft_body || "(empty draft)"}
              </pre>
              <div className="toolbar" style={{ gap: "0.35rem" }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => {
                    if (it.draft_body && navigator.clipboard?.writeText) {
                      void navigator.clipboard.writeText(it.draft_body);
                    }
                    void act(it.id, "mark_sent");
                  }}
                >
                  Copy + mark sent
                </button>
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  disabled={busy}
                  onClick={() => void act(it.id, "dismiss")}
                >
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
