import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";
import { notificationLink } from "../notificationLinks";

interface Note {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export function NotificationsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [list, setList] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function load() {
    const data = await api<{ notifications: Note[]; unread: number }>("/notifications");
    setList(data.notifications || []);
    setUnread(data.unread || 0);
  }

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);

  async function markAll() {
    await api("/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });
    await load();
  }

  async function markOne(id: number) {
    try {
      await api("/notifications/read", { method: "POST", body: JSON.stringify({ id }) });
    } catch {
      /* still navigate */
    }
    await load();
  }

  async function openNote(n: Note) {
    const to = notificationLink(n);
    if (!n.read_at) await markOne(n.id);
    if (to) navigate(to);
  }

  async function sendWeekly() {
    setOk("");
    try {
      const r = await api<{ created: number }>("/notifications/weekly-remind", { method: "POST" });
      setOk(`Sent ${r.created} weekly-check reminder(s) to drivers who are due.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Notifications</h1>
          <p>
            {unread ? `${unread} unread` : "You’re caught up"} · tap an alert to open it
          </p>
        </div>
        <div className="toolbar">
          {unread > 0 && (
            <button className="btn secondary" type="button" onClick={() => void markAll()}>
              Mark all read
            </button>
          )}
          {can(user, "manageIssues") && (
            <button className="btn" type="button" onClick={() => void sendWeekly()}>
              Send weekly check reminders
            </button>
          )}
        </div>
      </div>

      {ok && (
        <div className="success" style={{ marginBottom: "1rem" }}>
          {ok}
        </div>
      )}
      {error && (
        <div className="error" style={{ marginBottom: "1rem" }}>
          {error}
        </div>
      )}

      <div className="card">
        {!list.length ? (
          <div className="empty">No notifications yet.</div>
        ) : (
          <ul className="notify-list">
            {list.map((n) => {
              const to = notificationLink(n);
              const clickable = Boolean(to);
              return (
                <li
                  key={n.id}
                  className={`notify-item${n.read_at ? " read" : ""}${
                    clickable ? " is-clickable" : ""
                  }`}
                >
                  {clickable ? (
                    <button
                      type="button"
                      className="notify-main notify-main-btn"
                      onClick={() => void openNote(n)}
                    >
                      <strong>{n.title}</strong>
                      {n.body && <p className="muted">{n.body}</p>}
                      <span className="muted notify-meta">
                        {n.created_at?.replace("T", " ").slice(0, 16)}
                        <span className="notify-open-hint"> · Tap to open</span>
                      </span>
                    </button>
                  ) : (
                    <div className="notify-main">
                      <strong>{n.title}</strong>
                      {n.body && <p className="muted">{n.body}</p>}
                      <span className="muted notify-meta">
                        {n.created_at?.replace("T", " ").slice(0, 16)} · {n.kind}
                      </span>
                    </div>
                  )}
                  <div className="toolbar notify-item-actions">
                    {to && (
                      <Link
                        className="btn secondary btn-sm"
                        to={to}
                        onClick={() => void markOne(n.id)}
                      >
                        Open
                      </Link>
                    )}
                    {!n.read_at && (
                      <button
                        className="btn ghost btn-sm"
                        type="button"
                        onClick={() => void markOne(n.id)}
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
