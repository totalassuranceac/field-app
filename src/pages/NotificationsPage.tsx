import { useCallback, useEffect, useRef, useState } from "react";
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

const SWIPE_THRESHOLD = 64;
const SWIPE_MAX = 120;

/** Navigate targets opened from inbox so Back can return here. */
const NOTIF_NAV_STATE = { returnTo: "/notifications" as const };

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

  const rowRef = useRef<HTMLDivElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const dxRef = useRef(0);
  const axis = useRef<"none" | "h" | "v">("none");
  const tracking = useRef(false);
  const didSwipe = useRef(false);
  const [dx, setDx] = useState(0);

  const setOffset = useCallback((v: number) => {
    dxRef.current = v;
    setDx(v);
    if (rowRef.current) {
      rowRef.current.style.transform = `translateX(${v}px)`;
    }
  }, []);

  const reset = useCallback(() => {
    tracking.current = false;
    axis.current = "none";
    setOffset(0);
    if (rowRef.current) {
      rowRef.current.classList.remove("is-swiping");
    }
  }, [setOffset]);

  // Touch handlers on the sliding card (works on iOS/Android; pointer alone is flaky with nested buttons)
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !unread) return;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX.current = t.clientX;
      startY.current = t.clientY;
      dxRef.current = 0;
      axis.current = "none";
      tracking.current = true;
      didSwipe.current = false;
      el.classList.add("is-swiping");
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking.current || e.touches.length !== 1) return;
      const t = e.touches[0];
      const rawX = t.clientX - startX.current;
      const rawY = t.clientY - startY.current;

      if (axis.current === "none") {
        if (Math.abs(rawX) < 8 && Math.abs(rawY) < 8) return;
        axis.current = Math.abs(rawX) >= Math.abs(rawY) ? "h" : "v";
        if (axis.current === "v") {
          tracking.current = false;
          el.classList.remove("is-swiping");
          return;
        }
      }
      if (axis.current !== "h") return;

      // Horizontal swipe — block page scroll
      e.preventDefault();
      const next = Math.max(-SWIPE_MAX, Math.min(0, rawX));
      if (Math.abs(next) > 10) didSwipe.current = true;
      setOffset(next);
    };

    const onEnd = () => {
      if (!tracking.current && axis.current !== "h") {
        reset();
        return;
      }
      const final = dxRef.current;
      tracking.current = false;
      el.classList.remove("is-swiping");
      if (axis.current === "h" && final <= -SWIPE_THRESHOLD) {
        setOffset(-SWIPE_MAX);
        window.setTimeout(() => {
          onMarkRead(n.id);
          setOffset(0);
          axis.current = "none";
          didSwipe.current = false;
        }, 140);
      } else {
        setOffset(0);
        axis.current = "none";
        // Keep didSwipe true briefly so click doesn't fire open
        window.setTimeout(() => {
          didSwipe.current = false;
        }, 50);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [unread, n.id, onMarkRead, reset, setOffset]);

  // Mouse drag (desktop testing)
  useEffect(() => {
    const el = rowRef.current;
    if (!el || !unread) return;

    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      startX.current = e.clientX;
      startY.current = e.clientY;
      dxRef.current = 0;
      axis.current = "none";
      tracking.current = true;
      didSwipe.current = false;
      el.classList.add("is-swiping");
    };

    const onMove = (e: MouseEvent) => {
      if (!tracking.current) return;
      const rawX = e.clientX - startX.current;
      const rawY = e.clientY - startY.current;
      if (axis.current === "none") {
        if (Math.abs(rawX) < 6 && Math.abs(rawY) < 6) return;
        axis.current = Math.abs(rawX) >= Math.abs(rawY) ? "h" : "v";
        if (axis.current === "v") {
          tracking.current = false;
          el.classList.remove("is-swiping");
          return;
        }
      }
      if (axis.current !== "h") return;
      e.preventDefault();
      const next = Math.max(-SWIPE_MAX, Math.min(0, rawX));
      if (Math.abs(next) > 10) didSwipe.current = true;
      setOffset(next);
    };

    const onUp = () => {
      if (!tracking.current && axis.current !== "h") return;
      const final = dxRef.current;
      tracking.current = false;
      el.classList.remove("is-swiping");
      if (axis.current === "h" && final <= -SWIPE_THRESHOLD) {
        setOffset(-SWIPE_MAX);
        window.setTimeout(() => {
          onMarkRead(n.id);
          setOffset(0);
          axis.current = "none";
          didSwipe.current = false;
        }, 140);
      } else {
        setOffset(0);
        axis.current = "none";
        window.setTimeout(() => {
          didSwipe.current = false;
        }, 50);
      }
    };

    el.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [unread, n.id, onMarkRead, setOffset]);

  const reveal = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);

  function handleOpen() {
    if (didSwipe.current || Math.abs(dxRef.current) > 12) return;
    void onOpen(n);
  }

  return (
    <li
      className={`notify-swipe-row${unread ? " is-unread" : " is-read"}${
        clickable ? " is-clickable" : ""
      }`}
    >
      <div className="notify-swipe-actions" aria-hidden>
        <span className="notify-swipe-label" style={{ opacity: 0.35 + reveal * 0.65 }}>
          Mark read
        </span>
      </div>
      <div
        ref={rowRef}
        className={`notify-item${unread ? "" : " read"}`}
        style={{ transform: `translateX(${dx}px)` }}
      >
        {unread && <span className="notify-unread-dot" aria-hidden title="Unread" />}
        <div
          className="notify-main"
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={clickable ? handleOpen : undefined}
          onKeyDown={
            clickable
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleOpen();
                  }
                }
              : undefined
          }
        >
          <span className="notify-title">{n.title}</span>
          {n.body && <p className="notify-body muted">{n.body}</p>}
          <span className="muted notify-meta">
            {n.created_at?.replace("T", " ").slice(0, 16)}
            {clickable ? <span className="notify-open-hint"> · Tap to open</span> : ` · ${n.kind}`}
            {unread ? <span className="notify-swipe-hint"> · Swipe left = read</span> : null}
          </span>
        </div>
        <div className="toolbar notify-item-actions">
          {to && (
            <Link
              className="btn secondary btn-sm"
              to={to}
              state={NOTIF_NAV_STATE}
              onClick={() => void onMarkRead(n.id)}
            >
              Open
            </Link>
          )}
          {unread && (
            <button
              className="btn ghost btn-sm"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void onMarkRead(n.id);
              }}
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

  const markOne = useCallback(async (id: number) => {
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
  }, []);

  async function openNote(n: Note) {
    const to = notificationLink(n);
    if (!n.read_at) await markOne(n.id);
    if (to) navigate(to, { state: NOTIF_NAV_STATE });
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

      <div className="card notify-card">
        {!list.length ? (
          <div className="empty">No notifications yet.</div>
        ) : (
          <ul className="notify-list">
            {list.map((n) => (
              <NotifyRow
                key={n.id}
                n={n}
                onOpen={(note) => void openNote(note)}
                onMarkRead={markOne}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
