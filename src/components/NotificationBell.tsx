import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";

type Panel = "closed" | "open";

/**
 * Top-corner bell: unread notifications + messages + open warranties count.
 */
export function NotificationBell() {
  const [open, setOpen] = useState<Panel>("closed");
  const [notifUnread, setNotifUnread] = useState(0);
  const [msgUnread, setMsgUnread] = useState(0);
  const [warrantyOpen, setWarrantyOpen] = useState(0);
  const [preview, setPreview] = useState<
    Array<{ id: number; title: string; body: string | null; kind: string; created_at: string }>
  >([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const [n, m, w] = await Promise.all([
        api<{ unread: number; notifications: typeof preview }>("/notifications"),
        api<{ unread: number }>("/messages").catch(() => ({ unread: 0 })),
        api<{ open_count: number }>("/warranties?status=open").catch(() => ({ open_count: 0 })),
      ]);
      setNotifUnread(n.unread || 0);
      setMsgUnread(m.unread || 0);
      setWarrantyOpen(w.open_count || 0);
      setPreview((n.notifications || []).slice(0, 8));
    } catch {
      /* ignore poll errors */
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 25_000);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (open !== "open") return;
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen("closed");
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const total = notifUnread + msgUnread;
  const badge = total + (warrantyOpen > 0 && notifUnread === 0 && msgUnread === 0 ? 0 : 0);
  // Show warranty count in panel; badge prefers message/notif unread
  const showBadge = total > 0 || warrantyOpen > 0;

  return (
    <div className="notif-bell" ref={rootRef}>
      <button
        type="button"
        className="notif-bell-btn"
        aria-label={showBadge ? `Notifications, ${total} unread` : "Notifications"}
        aria-expanded={open === "open"}
        onClick={() => setOpen((o) => (o === "open" ? "closed" : "open"))}
      >
        <span className="notif-bell-icon" aria-hidden>
          🔔
        </span>
        {showBadge ? (
          <span className="notif-bell-badge">{total > 0 ? (total > 9 ? "9+" : total) : "!"}</span>
        ) : null}
      </button>
      {open === "open" && (
        <div className="notif-panel">
          <div className="notif-panel-head">
            <strong>Inbox</strong>
            <button type="button" className="btn ghost" onClick={() => setOpen("closed")}>
              Close
            </button>
          </div>
          <div className="notif-panel-links">
            <Link to="/messages" className="notif-panel-link" onClick={() => setOpen("closed")}>
              Messages{msgUnread ? ` (${msgUnread})` : ""}
            </Link>
            <Link to="/warranties" className="notif-panel-link" onClick={() => setOpen("closed")}>
              Warranties{warrantyOpen ? ` · ${warrantyOpen} open` : ""}
            </Link>
            <Link
              to="/notifications"
              className="notif-panel-link"
              onClick={() => setOpen("closed")}
            >
              All alerts{notifUnread ? ` (${notifUnread})` : ""}
            </Link>
          </div>
          <ul className="notif-panel-list">
            {!preview.length && <li className="muted">No recent alerts.</li>}
            {preview.map((n) => (
              <li key={n.id} className="notif-panel-item">
                <div className="notif-panel-title">{n.title}</div>
                {n.body ? <div className="muted notif-panel-body">{n.body}</div> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
