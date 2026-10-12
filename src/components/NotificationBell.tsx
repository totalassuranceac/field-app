import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { notificationLink } from "../notificationLinks";
import { notificationsReturnState, setNavReturn } from "../navReturn";
import { repairUtf8Mojibake } from "../lib/utf8Mojibake";

type Panel = "closed" | "open";

type PreviewNote = {
  id: number;
  title: string;
  body: string | null;
  kind: string;
  entity_type?: string | null;
  entity_id?: string | number | null;
  created_at: string;
  read_at?: string | null;
};

/** Inbox tray icon — fits dark UI better than emoji bell */
function InboxIcon() {
  return (
    <svg
      className="notif-bell-svg"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 14v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      <path d="M4 14l2.2-6.5A2 2 0 0 1 8.1 6h7.8a2 2 0 0 1 1.9 1.5L20 14" />
      <path d="M9 11h6" />
    </svg>
  );
}

/**
 * Top-corner alerts: unread notifications + open warranties.
 * Tapping a row marks it read and opens the related page (e.g. handbook).
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState<Panel>("closed");
  const [notifUnread, setNotifUnread] = useState(0);
  const [warrantyOpen, setWarrantyOpen] = useState(0);
  const [preview, setPreview] = useState<PreviewNote[]>([]);
  const [bellError, setBellError] = useState(false);
  const [bellLoading, setBellLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setBellLoading(true);
    setBellError(false);
    try {
      const [n, w] = await Promise.all([
        api<{ unread: number; notifications: PreviewNote[] }>("/notifications", {
          timeoutMs: 8_000,
        }),
        api<{ file_count?: number; attention_count?: number; open_count?: number }>(
          "/warranties?status=file",
          { timeoutMs: 8_000 }
        ).catch(
          (): { file_count: number; attention_count: number } => ({
            file_count: 0,
            attention_count: 0,
          })
        ),
      ]);
      setNotifUnread(n.unread || 0);
      // File pile only (dropped_off - parked) - not Hold / all-open
      setWarrantyOpen(w.file_count ?? w.attention_count ?? 0);
      // Hide legacy chat alerts - messaging UI was removed
      setPreview(
        (n.notifications || [])
          .filter((x) => {
            const k = String(x.kind || "").toLowerCase();
            return !k.startsWith("message");
          })
          .slice(0, 12)
      );
    } catch {
      setBellError(true);
      /* calm empty - no endless spinner */
    } finally {
      setBellLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 25_000);
    const onChanged = () => void load();
    window.addEventListener("notifications-changed", onChanged);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("notifications-changed", onChanged);
    };
  }, [load]);

  /** Rule 2: if user already opened the related screen, clear matching unread */
  useEffect(() => {
    const path = location.pathname || "";
    if (!path || path === "/login" || path === "/join") return;
    let cancelled = false;
    (async () => {
      try {
        const n = await api<{ notifications: PreviewNote[] }>("/notifications");
        if (cancelled) return;
        const unread = (n.notifications || []).filter((x) => !x.read_at);
        let marked = 0;
        for (const note of unread) {
          const to = notificationLink(note);
          if (!to) continue;
          const base = to.split("?")[0];
          if (path === base || path.startsWith(base + "/")) {
            try {
              await api("/notifications/read", {
                method: "POST",
                body: JSON.stringify({ id: note.id }),
              });
              marked += 1;
            } catch {
              /* ignore */
            }
          }
        }
        if (!cancelled && marked > 0) {
          window.dispatchEvent(new Event("notifications-changed"));
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);


  useEffect(() => {
    if (open !== "open") return;
    function onDoc(e: MouseEvent | TouchEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen("closed");
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [open]);

  useEffect(() => {
    if (open !== "open") return;
    const prev = document.body.style.overflow;
    if (window.matchMedia("(max-width: 720px)").matches) {
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  async function openNote(n: PreviewNote) {
    const to = notificationLink(n) || "/notifications";
    setOpen("closed");
    try {
      await api("/notifications/read", { method: "POST", body: JSON.stringify({ id: n.id }) });
    } catch {
      /* still navigate */
    }
    const ret = notificationsReturnState();
    setNavReturn(ret.returnTo, ret.returnLabel);
    navigate(to, { state: ret });
    void load();
  }

  const total = notifUnread;
  const showBadge = total > 0 || warrantyOpen > 0;

  return (
    <div className={`notif-bell${open === "open" ? " is-open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="notif-bell-btn"
        aria-label={showBadge ? `Inbox, ${total} unread` : "Inbox"}
        aria-expanded={open === "open"}
        onClick={() => {
          setOpen((o) => (o === "open" ? "closed" : "open"));
          if (open === "closed") void load();
        }}
      >
        <InboxIcon />
        {showBadge ? (
          <span className="notif-bell-badge">{total > 0 ? (total > 9 ? "9+" : total) : "!"}</span>
        ) : null}
      </button>

      {open === "open" && (
        <>
          <button
            type="button"
            className="notif-panel-scrim"
            aria-label="Close inbox"
            onClick={() => setOpen("closed")}
          />
          <div className="notif-panel" role="dialog" aria-label="Inbox">
            <div className="notif-panel-head">
              <strong>Inbox</strong>
              <button type="button" className="btn ghost btn-sm" onClick={() => setOpen("closed")}>
                Close
              </button>
            </div>
            <div className="notif-panel-links">
              <Link to="/warranties" className="notif-panel-link" onClick={() => setOpen("closed")}>
                Warranties{warrantyOpen ? ` - ${warrantyOpen} to file` : ""}
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
              {bellLoading && !preview.length ? (
                <li className="muted notif-panel-empty">Loading…</li>
              ) : null}
              {!bellLoading && bellError && !preview.length ? (
                <li className="muted notif-panel-empty">Inbox unavailable - try again</li>
              ) : null}
              {!bellLoading && !bellError && !preview.length ? (
                <li className="muted notif-panel-empty">No recent alerts.</li>
              ) : null}
              {preview.map((n) => {
                const to = notificationLink(n);
                const unread = !n.read_at;
                const title = repairUtf8Mojibake(String(n.title || ""))
                  .replace(/\u00b7/g, " - ")
                  .replace(/[\u2013\u2014]/g, "-");
                const body = n.body
                  ? repairUtf8Mojibake(String(n.body))
                      .replace(/\u00b7/g, " - ")
                      .replace(/[\u2013\u2014]/g, "-")
                  : null;
                return (
                  <li
                    key={n.id}
                    className={`notif-panel-item${unread ? " is-unread" : " is-read"}`}
                  >
                    <button
                      type="button"
                      className="notif-panel-item-btn"
                      onClick={() => void openNote(n)}
                    >
                      <div className="notif-panel-title">{title}</div>
                      {body ? <div className="muted notif-panel-body">{body}</div> : null}
                      <div className="muted notif-panel-go">
                        {to ? "Tap to open" : "Tap for details"}
                        {unread ? " - unread" : ""}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
            <Link
              to="/notifications"
              className="notif-panel-footer"
              onClick={() => setOpen("closed")}
            >
              View all notifications
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
