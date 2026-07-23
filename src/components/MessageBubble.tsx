import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";
import { playMessageSound, unlockMessageSound } from "../messageSound";

type PeekMsg = {
  id: number;
  from_user_id: number;
  from_name: string;
  body: string;
  conversation_id?: number | null;
  conversation_subject?: string | null;
  created_at: string;
};

const STORAGE_MAX = "fieldapp_msg_max_id";
const STORAGE_SOUND = "fieldapp_msg_sound"; // "1" | "0"

/**
 * Facebook Messenger–style floating bubble + chime when a new team message arrives.
 * Polls while the user is logged in; does not fire for messages you sent yourself.
 */
export function MessageBubble() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [toast, setToast] = useState<PeekMsg | null>(null);
  const [unread, setUnread] = useState(0);
  const [soundOn, setSoundOn] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_SOUND) !== "0";
    } catch {
      return true;
    }
  });
  const maxIdRef = useRef<number>(0);
  const primedRef = useRef(false);
  const hideTimer = useRef<number | null>(null);

  // Bootstrap max id so we don't toast historical messages on first load
  useEffect(() => {
    if (!user) return;
    try {
      const stored = Number(localStorage.getItem(STORAGE_MAX) || "0");
      if (stored > 0) maxIdRef.current = stored;
    } catch {
      /* ignore */
    }
  }, [user?.id]);

  // Unlock audio on first user interaction (required on iOS/Android)
  useEffect(() => {
    function unlock() {
      unlockMessageSound();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    }
    document.addEventListener("pointerdown", unlock, { passive: true });
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  const userId = user?.id;
  const onMessagesPage = location.pathname.startsWith("/messages");

  const poll = useCallback(async () => {
    if (!userId) return;
    try {
      const since = maxIdRef.current > 0 ? maxIdRef.current : 0;
      // peek=1 avoids heavy backfill/joins that froze the app on open
      const data = await api<{
        messages: PeekMsg[];
        unread: number;
        max_id?: number;
      }>(`/messages?peek=1&limit=5${since > 0 ? `&since_id=${since}` : ""}`);

      setUnread(data.unread || 0);
      const serverMax = Number(data.max_id || 0);

      if (!primedRef.current) {
        primedRef.current = true;
        const next = serverMax || maxIdRef.current;
        maxIdRef.current = next;
        try {
          localStorage.setItem(STORAGE_MAX, String(next));
        } catch {
          /* ignore */
        }
        return;
      }

      const incoming = (data.messages || [])
        .filter((m) => m.from_user_id !== userId && m.id > maxIdRef.current)
        .sort((a, b) => a.id - b.id);

      if (serverMax > maxIdRef.current) {
        maxIdRef.current = serverMax;
        try {
          localStorage.setItem(STORAGE_MAX, String(serverMax));
        } catch {
          /* ignore */
        }
      }

      if (!incoming.length) return;

      const latest = incoming[incoming.length - 1];
      if (soundOn && !onMessagesPage) {
        playMessageSound();
      }
      if (!onMessagesPage) {
        setToast(latest);
        if (hideTimer.current) window.clearTimeout(hideTimer.current);
        hideTimer.current = window.setTimeout(() => setToast(null), 9000);
      }
    } catch {
      /* ignore poll errors */
    }
  }, [userId, onMessagesPage, soundOn]);

  useEffect(() => {
    if (!userId) return;
    // Defer first poll slightly so home/auth can paint first
    const start = window.setTimeout(() => void poll(), 800);
    const id = window.setInterval(() => void poll(), 20_000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearTimeout(start);
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [userId, poll]);

  if (!user) return null;

  function openToast() {
    unlockMessageSound();
    const cid = toast?.conversation_id;
    setToast(null);
    navigate(cid ? `/messages?c=${cid}` : "/messages");
  }

  function toggleSound() {
    unlockMessageSound();
    setSoundOn((on) => {
      const next = !on;
      try {
        localStorage.setItem(STORAGE_SOUND, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      if (next) playMessageSound();
      return next;
    });
  }

  return (
    <div className="msg-bubble-root" aria-live="polite">
      {toast && (
        <button type="button" className="msg-toast" onClick={openToast}>
          <span className="msg-toast-avatar" aria-hidden>
            {(toast.from_name || "?").slice(0, 1).toUpperCase()}
          </span>
          <span className="msg-toast-text">
            <strong>{toast.from_name}</strong>
            {toast.conversation_subject ? (
              <span className="msg-toast-subject">{toast.conversation_subject}</span>
            ) : null}
            <span className="msg-toast-body">
              {toast.body.length > 90 ? `${toast.body.slice(0, 90).trim()}…` : toast.body}
            </span>
          </span>
          <span className="msg-toast-close" aria-hidden>
            ✕
          </span>
        </button>
      )}

      <div className="msg-fab-wrap">
        {unread > 0 && !location.pathname.startsWith("/messages") ? (
          <button
            type="button"
            className="msg-fab"
            aria-label={`${unread} unread messages`}
            onClick={() => {
              unlockMessageSound();
              navigate("/messages");
            }}
          >
            <span className="msg-fab-icon" aria-hidden>
              💬
            </span>
            <span className="msg-fab-badge">{unread > 9 ? "9+" : unread}</span>
          </button>
        ) : null}
        <button
          type="button"
          className={`msg-sound-toggle${soundOn ? " is-on" : ""}`}
          title={soundOn ? "Message sound on" : "Message sound off"}
          aria-label={soundOn ? "Turn message sound off" : "Turn message sound on"}
          onClick={toggleSound}
        >
          {soundOn ? "🔔" : "🔕"}
        </button>
      </div>
    </div>
  );
}
