import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, can } from "../api";
import { useAuth } from "../auth";

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
    await api("/notifications/read", { method: "POST", body: JSON.stringify({ id }) });
    await load();
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

  function linkFor(n: Note): string | null {
    if (n.kind === "weekly_check") return "/inspections";
    if (n.kind === "message") return "/messages";
    if (
      n.kind === "warranty_dropoff" ||
      n.kind === "warranty_processed" ||
      n.kind === "warranty_vendor_return"
    ) {
      return "/warranties";
    }
    if (
      n.kind === "flat_emergency" ||
      n.kind === "repair_request" ||
      n.kind === "oil_change_due"
    ) {
      return "/issues";
    }
    return null;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Notifications</h1>
          <p>
            {unread ? `${unread} unread` : "You’re caught up"} · weekly checks &amp; repair alerts
          </p>
        </div>
        <div className="toolbar">
          {unread > 0 && (
            <button className="btn secondary" type="button" onClick={() => markAll()}>
              Mark all read
            </button>
          )}
          {can(user, "manageIssues") && (
            <button className="btn" type="button" onClick={() => sendWeekly()}>
              Send weekly check reminders
            </button>
          )}
        </div>
      </div>

      {ok && <div className="success" style={{ marginBottom: "1rem" }}>{ok}</div>}
      {error && <div className="error" style={{ marginBottom: "1rem" }}>{error}</div>}

      <div className="card">
        {!list.length ? (
          <div className="empty">No notifications yet.</div>
        ) : (
          <ul className="notify-list">
            {list.map((n) => {
              const to = linkFor(n);
              return (
                <li key={n.id} className={n.read_at ? "notify-item read" : "notify-item"}>
                  <div className="notify-main">
                    <strong>{n.title}</strong>
                    {n.body && <p className="muted">{n.body}</p>}
                    <span className="muted" style={{ fontSize: "0.78rem" }}>
                      {n.created_at?.replace("T", " ").slice(0, 16)} · {n.kind}
                    </span>
                  </div>
                  <div className="toolbar">
                    {to && (
                      <Link className="btn secondary" to={to} onClick={() => markOne(n.id)}>
                        Open
                      </Link>
                    )}
                    {!n.read_at && (
                      <button className="btn ghost" type="button" onClick={() => markOne(n.id)}>
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
