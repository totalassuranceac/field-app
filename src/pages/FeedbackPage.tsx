import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type FeedbackCategory = "suggestion" | "bug" | "praise" | "other";
type FeedbackStatus = "new" | "reviewed" | "done" | "dismissed";

interface FeedbackItem {
  id: number;
  user_id: number;
  category: string;
  message: string;
  page_context: string | null;
  status: FeedbackStatus | string;
  admin_note: string | null;
  created_at: string;
  reviewed_at?: string | null;
  employee_name?: string | null;
  employee_role?: string | null;
  reviewed_by_name?: string | null;
}

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "suggestion", label: "Suggestion / idea" },
  { value: "bug", label: "Something is broken" },
  { value: "praise", label: "What’s working well" },
  { value: "other", label: "Other" },
];

function categoryLabel(c: string): string {
  return CATEGORIES.find((x) => x.value === c)?.label || c;
}

function statusLabel(s: string): string {
  if (s === "new") return "New";
  if (s === "reviewed") return "Seen";
  if (s === "done") return "Done";
  if (s === "dismissed") return "Closed";
  return s;
}

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso.slice(0, 16);
  }
}

/**
 * App feedback — employees suggest improvements; office/admin reviews inbox.
 */
export function FeedbackPage() {
  const { user } = useAuth();
  const isReviewer =
    user?.role === "admin" || user?.role === "office" || user?.role === "supervisor";

  const [tab, setTab] = useState<"submit" | "mine" | "inbox">("submit");
  const [mine, setMine] = useState<FeedbackItem[]>([]);
  const [inbox, setInbox] = useState<FeedbackItem[]>([]);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<number | null>(null);

  const [category, setCategory] = useState<FeedbackCategory>("suggestion");
  const [message, setMessage] = useState("");

  const loadMine = useCallback(async () => {
    const d = await api<{ items: FeedbackItem[] }>("/feedback?view=mine");
    setMine(d.items || []);
  }, []);

  const loadInbox = useCallback(async () => {
    if (!isReviewer) return;
    const d = await api<{ items: FeedbackItem[]; pending?: number }>(
      "/feedback?view=inbox&status=all"
    );
    setInbox(d.items || []);
    setPending(d.pending ?? 0);
  }, [isReviewer]);

  const refresh = useCallback(async () => {
    setError("");
    try {
      await loadMine();
      if (tab === "inbox") await loadInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load");
    }
  }, [loadMine, loadInbox, tab]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get("tab");
    if (t === "inbox" && isReviewer) setTab("inbox");
    else if (t === "mine" || t === "submit") setTab(t);
  }, [isReviewer]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setOk("");
    try {
      const msg = message.trim();
      if (msg.length < 8) {
        throw new Error("Please write a short sentence so we understand your idea.");
      }
      await api("/feedback", {
        method: "POST",
        body: JSON.stringify({
          category,
          message: msg,
          page_context: typeof window !== "undefined" ? window.location.pathname : null,
        }),
      });
      setOk("Thanks — your feedback was sent. We read every one.");
      setMessage("");
      setCategory("suggestion");
      setTab("mine");
      await loadMine();
      if (isReviewer) await loadInbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(id: number, status: FeedbackStatus) {
    setActingId(id);
    setError("");
    try {
      await api(`/feedback/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setOk(
        status === "done"
          ? "Marked done — employee notified."
          : status === "reviewed"
            ? "Marked as seen."
            : status === "dismissed"
              ? "Closed."
              : "Updated."
      );
      await loadInbox();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setActingId(null);
    }
  }

  return (
    <div className="page feedback-page">
      <div className="page-header">
        <div>
          <h1>App feedback</h1>
          <p>
            Got an idea to make Field App easier? Tell us what would help — bugs, missing features,
            or what already works well.
          </p>
        </div>
      </div>

      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <div className="filters no-print" style={{ marginBottom: "0.75rem" }}>
        <button
          type="button"
          className={`chip ${tab === "submit" ? "active" : ""}`}
          onClick={() => setTab("submit")}
        >
          Send feedback
        </button>
        <button
          type="button"
          className={`chip ${tab === "mine" ? "active" : ""}`}
          onClick={() => setTab("mine")}
        >
          My feedback
        </button>
        {isReviewer && (
          <button
            type="button"
            className={`chip ${tab === "inbox" ? "active" : ""}`}
            onClick={() => setTab("inbox")}
          >
            Inbox{pending > 0 ? ` (${pending} new)` : ""}
          </button>
        )}
      </div>

      {tab === "submit" && (
        <form className="card form" onSubmit={submit}>
          <h2 style={{ marginTop: 0 }}>What should we improve?</h2>
          <p className="muted" style={{ marginTop: 0, fontSize: "0.9rem" }}>
            Be specific if you can (which screen, what you expected). No idea is too small.
          </p>
          <label>
            Type
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Your feedback *
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              rows={5}
              minLength={8}
              maxLength={4000}
              placeholder="e.g. On fuel log, it would help if…"
              autoFocus
            />
          </label>
          <div className="toolbar">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send feedback"}
            </button>
          </div>
        </form>
      )}

      {tab === "mine" && (
        <section className="feedback-list">
          {!mine.length ? (
            <div className="card muted">You haven&apos;t sent any feedback yet.</div>
          ) : (
            mine.map((f) => (
              <article key={f.id} className={`card feedback-card st-${f.status}`}>
                <div className="feedback-card-head">
                  <span className="feedback-cat">{categoryLabel(f.category)}</span>
                  <span className={`feedback-status st-${f.status}`}>{statusLabel(f.status)}</span>
                </div>
                <p className="feedback-msg">{f.message}</p>
                <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
                  {formatWhen(f.created_at)}
                </p>
                {f.admin_note && (
                  <p className="feedback-admin-note">
                    <strong>Note from office:</strong> {f.admin_note}
                  </p>
                )}
              </article>
            ))
          )}
        </section>
      )}

      {tab === "inbox" && isReviewer && (
        <section className="feedback-list">
          <p className="muted" style={{ marginTop: 0, fontSize: "0.9rem" }}>
            Employee suggestions for Field App. Mark Seen when you&apos;ve read it, Done when
            addressed (they get a thank-you note).
          </p>
          {!inbox.length ? (
            <div className="card muted">No feedback yet.</div>
          ) : (
            inbox.map((f) => (
              <article key={f.id} className={`card feedback-card st-${f.status}`}>
                <div className="feedback-card-head">
                  <strong>
                    {f.employee_name || "Employee"}
                    {f.employee_role ? (
                      <span className="muted" style={{ fontWeight: 500 }}>
                        {" "}
                        · {f.employee_role}
                      </span>
                    ) : null}
                  </strong>
                  <span className={`feedback-status st-${f.status}`}>{statusLabel(f.status)}</span>
                </div>
                <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.85rem" }}>
                  {categoryLabel(f.category)} · {formatWhen(f.created_at)}
                  {f.page_context ? ` · from ${f.page_context}` : ""}
                </p>
                <p className="feedback-msg">{f.message}</p>
                {f.reviewed_by_name && f.status !== "new" && (
                  <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.82rem" }}>
                    Reviewed by {f.reviewed_by_name}
                    {f.reviewed_at ? ` · ${formatWhen(f.reviewed_at)}` : ""}
                  </p>
                )}
                <div className="toolbar" style={{ marginTop: "0.55rem" }}>
                  {f.status === "new" && (
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      disabled={actingId === f.id}
                      onClick={() => void setStatus(f.id, "reviewed")}
                    >
                      Mark seen
                    </button>
                  )}
                  {(f.status === "new" || f.status === "reviewed") && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={actingId === f.id}
                        onClick={() => void setStatus(f.id, "done")}
                      >
                        Done
                      </button>
                      <button
                        type="button"
                        className="btn ghost btn-sm"
                        disabled={actingId === f.id}
                        onClick={() => void setStatus(f.id, "dismissed")}
                      >
                        Close
                      </button>
                    </>
                  )}
                  {(f.status === "done" || f.status === "dismissed") && (
                    <button
                      type="button"
                      className="btn ghost btn-sm"
                      disabled={actingId === f.id}
                      onClick={() => void setStatus(f.id, "new")}
                    >
                      Reopen
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      )}
    </div>
  );
}
