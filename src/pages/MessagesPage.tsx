import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { unlockMessageSound } from "../messageSound";
import { clearNavReturn, readNavReturn } from "../navReturn";

interface Peer {
  id: number;
  display_name: string;
  role: string;
}

interface Conversation {
  id: number;
  subject: string;
  is_team: number;
  created_by_user_id: number;
  last_message_at: string;
  created_at: string;
  last_body: string | null;
  last_from_name: string | null;
  last_from_id: number | null;
  message_count: number;
  unread: number;
  peer_name: string | null;
  peer_id: number | null;
}

interface ThreadMsg {
  id: number;
  from_user_id: number;
  to_user_id: number | null;
  body: string;
  created_at: string;
  from_name: string;
  is_read: number | null;
  ack_count: number;
  i_acked: number | null;
  ackers: { user_id: number; display_name: string }[];
  conversation_id?: number;
}

interface ThreadConversation {
  id: number;
  subject: string;
  is_team: number;
  peer_name: string | null;
  peer_id: number | null;
  last_message_at: string;
  created_at: string;
}

function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  return iso.replace("T", " ").slice(0, 16);
}

export function MessagesPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const openId = Number(params.get("c") || "0") || null;
  /** When opened from Notifications, Back returns there instead of chat list only. */
  const returnTo = readNavReturn(location.state)?.returnTo || null;

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [thread, setThread] = useState<ThreadMsg[]>([]);
  const [active, setActive] = useState<ThreadConversation | null>(null);

  const [composing, setComposing] = useState(false);
  /** "" = pick someone; "all" = whole team; otherwise user id string */
  const [toId, setToId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");

  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);

  const threadEndRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number | null>(null);

  const loadList = useCallback(async () => {
    const [c, u] = await Promise.all([
      api<{ conversations: Conversation[]; unread: number }>("/messages/conversations"),
      api<{ users: Peer[] }>("/messages/users"),
    ]);
    setConversations(c.conversations || []);
    setPeers(u.users || []);
  }, []);

  const loadThread = useCallback(async (id: number, opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoadingThread(true);
    try {
      const data = await api<{ conversation: ThreadConversation; messages: ThreadMsg[] }>(
        `/messages/conversations/${id}`
      );
      setActive(data.conversation);
      setThread(data.messages || []);
    } finally {
      if (!opts?.quiet) setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    loadList().catch((e) => setError(e instanceof Error ? e.message : "Load failed"));
  }, [loadList]);

  useEffect(() => {
    if (!openId) {
      setActive(null);
      setThread([]);
      return;
    }
    setComposing(false);
    loadThread(openId).catch((e) =>
      setError(e instanceof Error ? e.message : "Could not open conversation")
    );
    // Refresh list unread badges after open
    void loadList().catch(() => null);
  }, [openId, loadThread, loadList]);

  // Poll open thread for new replies
  useEffect(() => {
    if (!openId) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      return;
    }
    pollRef.current = window.setInterval(() => {
      void loadThread(openId, { quiet: true }).catch(() => null);
    }, 10_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [openId, loadThread]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length, openId]);

  function openConversation(id: number) {
    unlockMessageSound();
    setError("");
    setOk("");
    // Keep returnTo from notifications when drilling into a chat from that entry
    setParams(
      { c: String(id) },
      { state: returnTo ? { returnTo } : location.state, replace: false }
    );
  }

  function backToList() {
    setActive(null);
    setThread([]);
    setReply("");
    if (returnTo) {
      clearNavReturn();
      navigate(returnTo);
      return;
    }
    setParams({});
    void loadList().catch(() => null);
  }

  async function startConversation(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    const isAll = toId === "all";
    if (!isAll && !toId) {
      setError("Pick a person — or All at the bottom of the list for the whole team.");
      return;
    }
    setBusy(true);
    setError("");
    setOk("");
    unlockMessageSound();
    try {
      const res = await api<{ ok: boolean; id: number; conversation_id: number }>("/messages", {
        method: "POST",
        body: JSON.stringify({
          body: body.trim(),
          subject: subject.trim() || undefined,
          broadcast: isAll,
          to_user_id: isAll ? null : Number(toId) || null,
        }),
      });
      setBody("");
      setSubject("");
      setToId("");
      setComposing(false);
      setOk(isAll ? "Team conversation started." : "Conversation started.");
      await loadList();
      if (res.conversation_id) openConversation(res.conversation_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(e: FormEvent) {
    e.preventDefault();
    if (!reply.trim() || !openId) return;
    setBusy(true);
    setError("");
    unlockMessageSound();
    try {
      await api("/messages", {
        method: "POST",
        body: JSON.stringify({
          body: reply.trim(),
          conversation_id: openId,
        }),
      });
      setReply("");
      await loadThread(openId, { quiet: true });
      await loadList();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reply failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAck(msgId: number) {
    unlockMessageSound();
    try {
      await api<{ ok: boolean; acked: boolean }>(`/messages/${msgId}/ack`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (openId) await loadThread(openId, { quiet: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save 👍");
    }
  }

  async function deleteConversation() {
    if (!openId) return;
    const okDel = window.confirm(
      "Delete this conversation for everyone? Messages cannot be recovered."
    );
    if (!okDel) return;
    setBusy(true);
    setError("");
    try {
      await api(`/messages/conversations/${openId}`, { method: "DELETE" });
      setOk("Conversation deleted.");
      setActive(null);
      setThread([]);
      setReply("");
      if (returnTo) {
        clearNavReturn();
        navigate(returnTo);
      } else {
        setParams({});
        await loadList();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  }

  // ——— Thread view (including brief load while opening) ———
  if (openId) {
    const who = active
      ? active.is_team
        ? "Whole team"
        : active.peer_name || "Conversation"
      : "…";
    return (
      <div className="msg-page msg-thread-page">
        <div className="msg-thread-head">
          <button type="button" className="btn ghost btn-sm" onClick={backToList}>
            {returnTo === "/notifications" ? "← Notifications" : "← All chats"}
          </button>
          <div className="msg-thread-title">
            <h1>{active?.subject || (loadingThread ? "Opening…" : "Conversation")}</h1>
            <p>
              {who}
              {active?.is_team ? " · team thread" : active ? " · direct" : ""}
            </p>
          </div>
          <button
            type="button"
            className="btn ghost btn-sm msg-delete-btn"
            disabled={busy}
            onClick={() => void deleteConversation()}
            title="Delete conversation"
          >
            Delete
          </button>
        </div>

        {error && <div className="error inv-flash">{error}</div>}

        {loadingThread && !thread.length ? (
          <p className="muted">Loading conversation…</p>
        ) : (
          <div className="msg-thread" role="log" aria-label="Conversation messages">
            {thread.map((m) => {
              const mine = m.from_user_id === user?.id;
              const acked = !!m.i_acked;
              const ackLabel =
                m.ack_count > 0
                  ? m.ackers?.length
                    ? m.ackers.map((a) => a.display_name).join(", ")
                    : `${m.ack_count} confirmed`
                  : "Tap 👍 when you got it";
              return (
                <div
                  key={m.id}
                  className={`msg-bubble-row${mine ? " mine" : " theirs"}`}
                >
                  {!mine && <div className="msg-bubble-name">{m.from_name}</div>}
                  <div className={`msg-chat-bubble${mine ? " mine" : ""}`}>
                    <div className="msg-body">{m.body}</div>
                    <div className="msg-bubble-foot">
                      <span className="msg-time">{fmtWhen(m.created_at)}</span>
                      <button
                        type="button"
                        className={`msg-ack-btn${acked ? " is-acked" : ""}`}
                        title={ackLabel}
                        aria-label={acked ? "Remove thumbs up" : "Thumbs up — I got it"}
                        aria-pressed={acked}
                        onClick={() => void toggleAck(m.id)}
                      >
                        👍
                        {m.ack_count > 0 ? (
                          <span className="msg-ack-count">{m.ack_count}</span>
                        ) : null}
                      </button>
                    </div>
                    {m.ack_count > 0 && m.ackers?.length ? (
                      <div className="msg-ack-names muted">
                        Got it: {m.ackers.map((a) => a.display_name).join(", ")}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div ref={threadEndRef} />
          </div>
        )}

        <form className="msg-reply-bar" onSubmit={sendReply}>
          <label className="sr-only" htmlFor="msg-reply">
            Reply
          </label>
          <textarea
            id="msg-reply"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="Reply in this conversation…"
            required
          />
          <button className="btn" type="submit" disabled={busy || !reply.trim()}>
            {busy ? "…" : "Reply"}
          </button>
        </form>
      </div>
    );
  }

  // ——— Inbox list ———
  return (
    <div className="msg-page">
      <div className="page-header">
        <div>
          <h1>Messages</h1>
          <p>
            Conversations stay on one subject — reply in the thread, and tap 👍 so people know you
            got it.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            unlockMessageSound();
            setComposing((v) => !v);
            setError("");
            setOk("");
          }}
        >
          {composing ? "Cancel" : "New conversation"}
        </button>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      {composing && (
        <form className="card msg-compose" onSubmit={startConversation}>
          <label>
            Subject
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={120}
              placeholder="e.g. Warranty parts at counter"
              autoFocus
            />
          </label>
          <label>
            To
            <select
              value={toId}
              onChange={(e) => setToId(e.target.value)}
              required
            >
              <option value="">Select person…</option>
              {peers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} ({p.role})
                </option>
              ))}
              <option value="all">All — whole team</option>
            </select>
          </label>
          <label>
            First message
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="Start the conversation…"
              required
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Sending…" : toId === "all" ? "Message whole team" : "Start conversation"}
          </button>
        </form>
      )}

      <div className="msg-conv-list" role="list">
        {!conversations.length && (
          <div className="card muted">No conversations yet. Start one with a clear subject.</div>
        )}
        {conversations.map((c) => {
          const preview =
            c.last_body && c.last_body.length > 80
              ? `${c.last_body.slice(0, 80).trim()}…`
              : c.last_body || "";
          const who = c.is_team ? "Team" : c.peer_name || "Chat";
          return (
            <button
              key={c.id}
              type="button"
              className={`msg-conv-card${c.unread > 0 ? " has-unread" : ""}`}
              role="listitem"
              onClick={() => openConversation(c.id)}
            >
              <div className="msg-conv-top">
                <strong className="msg-conv-subject">{c.subject || "(no subject)"}</strong>
                {c.unread > 0 ? (
                  <span className="msg-conv-unread">{c.unread > 9 ? "9+" : c.unread}</span>
                ) : null}
              </div>
              <div className="msg-conv-meta">
                <span>{who}</span>
                <span className="msg-conv-dot">·</span>
                <span>{c.message_count} msg{c.message_count === 1 ? "" : "s"}</span>
                <span className="msg-conv-dot">·</span>
                <span>{fmtWhen(c.last_message_at)}</span>
              </div>
              {preview ? (
                <div className="msg-conv-preview">
                  {c.last_from_name ? `${c.last_from_name}: ` : ""}
                  {preview}
                </div>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
