import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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

const SWIPE_THRESHOLD = 72;
const SWIPE_MAX = 110;

function NotifyRow({
  n,
  onOpen,
  onMarkRead,
}: {
  n: Note;
  onOpen: (n: Note) => void;
  onMarkRead: (id: number) => void;
}) {
  const unread = !n.read_at;
  const to = notificationLink(n);
  const clickable = Boolean(to);
  const startX = useRef(0);
  const startY = useRef(0);
  const dragging = useRef(false);
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);

  const reset = useCallback(() => {
    setOffset(0);
    setSwiping(false);
    dragging.current = false;
  }, []);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (!unread) return;
    // Only primary touch/mouse
    if (e.button !== 0 && e.pointerType === "mouse") return;
    startX.current = e.clientX;
    startY.current = e.clientY;
    dragging.current = true;
    setSwiping(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!dragging.current || !unread) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    // Vertical scroll wins — cancel horizontal swipe
    if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
      reset();
      return;
    }
    // Swipe left only (negative dx)
    if (dx < 0) {
      setOffset(Math.max(-SWIPE_MAX, dx));
    } else {
      setOffset(0);
    }
  }

  function onPointerUp() {
    if (!dragging.current) return;
    dragging.current = false;
    if (offset <= -SWIPE_THRESHOLD && unread) {
      // Snap open then mark read
      setOffset(-SWIPE_MAX);
      setTimeout(() => {
        onMarkRead(n.id);
        reset();
      }, 120);
    } else {
      reset();
    }
  }

  const reveal = Math.min(1, Math.abs(offset) / SWIPE_THRESHOLD);

  return (
    <li
      className={`notify-swipe-row${unread ? " is-unread" : " is-read"}${
        clickable ? " is-clickable" : ""
      }`}
    >
      <div className="notify-swipe-actions" aria-hidden={offset >= 0}>
        <span className="notify-swipe-label" style={{ opacity: 0.4 + reveal * 0.6 }}>
          Mark read
        </span>
      </div>
      <div
        className={`notify-item${unread ? "" : " read"}${swiping ? " is-swiping" : ""}`}
        style={{ transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onPointerLeave={() => {
          if (dragging.current && offset > -SWIPE_THRESHOLD) reset();
        }}
      >
        {unread && <span className="notify-unread-dot" aria-hidden title="Unread" />}
        {clickable ? (
          <button
            type="button"
            className="notify-main notify-main-btn"
            onClick={() => {
              // Don't open if this was a swipe
              if (Math.abs(offset) > 8) return;
              void onOpen(n);
            }}
          >
            <span className="notify-title">{n.title}</span>
            {n.body && <p className="notify-body muted">{n.body}</p>}
            <span className="muted notify-meta">
              {n.created_at?.replace("T", " ").slice(0, 16)}
              <span className="notify-open-hint"> · Tap to open</span>
              {unread ? (
                <span className="notify-swipe-hint"> · Swipe left to mark read</span>
              ) : null}
            </span>
          </button>
        ) : (
          <div className="notify-main">
            <span className="notify-title">{n.title}</span>
            {n.body && <p className="notify-body muted">{n.body}</p>}
            <span className="muted notify-meta">
              {n.created_at?.replace("T", " ").slice(0, 16)} · {n.kind}
              {unread ? (
                <span className="notify-swipe-hint"> · Swipe left to mark read</span>
              ) : null}
            </span>
          </div>
        )}
        <div className="toolbar notify-item-actions">
          {to && (
            <Link
              className="btn secondary btn-sm"
              to={to}
              onClick={() => void onMarkRead(n.id)}
            >
              Open
            </Link>
          )}
          {unread && (
            <button
              className="btn ghost btn-sm"
              type="button"
              onClick={() => void onMarkRead(n.id)}
            >
              Mark read
            </button>
          )}
        </div>
      </div>
    </li>
  );
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
    // Optimistic
    setList((prev) =>
      prev.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() }))
    );
    setUnread(0);
    try {
      await api("/notifications/read", { method: "POST", body: JSON.stringify({ all: true }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark all read");
      await load();
    }
  }

  async function markOne(id: number) {
    // Optimistic Gmail-style: title un-bolds immediately
    setList((prev) =>
      prev.map((n) =>
        n.id === id && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n
      )
    );
    setUnread((u) => Math.max(0, u - 1));
    try {
      await api("/notifications/read", { method: "POST", body: JSON.stringify({ id }) });
    } catch {
      await load();
    }
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
            {unread ? `${unread} unread` : "You’re caught up"} · bold = unread · swipe left to mark
            read
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
            {list.map((n) => (
              <NotifyRow
                key={n.id}
                n={n}
                onOpen={(note) => void openNote(note)}
                onMarkRead={(id) => void markOne(id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
