import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { CollapsibleSection, LogItem, LogList } from "../components/CollapsibleLog";

interface Msg {
  id: number;
  from_user_id: number;
  to_user_id: number | null;
  body: string;
  created_at: string;
  from_name: string;
  to_name: string | null;
  is_read: number | null;
}

interface Peer {
  id: number;
  display_name: string;
  role: string;
}

export function MessagesPage() {
  const { user } = useAuth();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [toId, setToId] = useState<string>("");
  const [broadcast, setBroadcast] = useState(false);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    const [m, u] = await Promise.all([
      api<{ messages: Msg[]; unread: number }>("/messages"),
      api<{ users: Peer[] }>("/messages/users"),
    ]);
    setMessages(m.messages || []);
    setPeers(u.users || []);
    // Mark all visible as read
    void api("/messages/read", { method: "POST", body: JSON.stringify({ all: true }) }).catch(
      () => null
    );
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError("");
    setOk("");
    try {
      await api("/messages", {
        method: "POST",
        body: JSON.stringify({
          body: body.trim(),
          broadcast,
          to_user_id: broadcast ? null : Number(toId) || null,
        }),
      });
      setBody("");
      setOk(broadcast ? "Team message sent." : "Message sent.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="msg-page">
      <div className="page-header">
        <div>
          <h1>Messages</h1>
          <p>Quick team notes — everyone can reach each other here.</p>
        </div>
      </div>
      {error && <div className="error inv-flash">{error}</div>}
      {ok && <div className="success inv-flash">{ok}</div>}

      <form className="card msg-compose" onSubmit={send}>
        <label className="msg-broadcast">
          <input
            type="checkbox"
            checked={broadcast}
            onChange={(e) => setBroadcast(e.target.checked)}
          />
          Send to whole team
        </label>
        {!broadcast && (
          <label>
            To
            <select value={toId} onChange={(e) => setToId(e.target.value)} required={!broadcast}>
              <option value="">Select person…</option>
              {peers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name} ({p.role})
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Message
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Warranty parts at the counter · need help staging trucks · etc."
            required
          />
        </label>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Sending…" : "Send"}
        </button>
      </form>

      <CollapsibleSection
        title="Recent messages"
        count={messages.length}
        hint="Tap a row to read the full message"
        defaultOpen={messages.length > 0 && messages.length <= 8}
      >
        <LogList empty="No messages yet. Say hello to the team.">
          {messages.map((m) => {
            const mine = m.from_user_id === user?.id;
            const team = m.to_user_id == null;
            const preview =
              m.body.length > 72 ? `${m.body.slice(0, 72).trim()}…` : m.body;
            return (
              <LogItem
                key={m.id}
                summary={
                  <>
                    <strong>{mine ? "You" : m.from_name}</strong>
                    <span className="log-item-meta">
                      {team ? "→ Team" : mine ? `→ ${m.to_name || "?"}` : "→ you"}
                    </span>
                    <span className="log-item-meta">{preview}</span>
                    <span className="log-item-meta">
                      {m.created_at?.replace("T", " ").slice(0, 16)}
                    </span>
                  </>
                }
              >
                <div className="msg-body">{m.body}</div>
              </LogItem>
            );
          })}
        </LogList>
      </CollapsibleSection>
    </div>
  );
}
