import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

type RecognitionEvent = {
  employee_id: number;
  name: string;
  event_type: "birthday" | "anniversary";
  date: string;
  years_of_service?: number;
};

type TodayPayload = {
  as_of: string;
  events: RecognitionEvent[];
};

type PersonLine = {
  key: string;
  name: string;
  yearsLabel?: string;
};

/** One full-screen per event TYPE (all people of that type share equally). */
type ToastScreen = {
  kind: "birthday" | "anniversary";
  headline: string;
  people: PersonLine[];
};

const CHRIS_MARROQUIN_USER_ID = 3;

function chicagoIsoDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

function seenKey(userId: number, day: string): string {
  return `ta-recognition-seen:${userId}:${day}`;
}

function isChrisPolishMode(user: { id: number; role?: string; real_role?: string; display_name?: string } | null | undefined): boolean {
  if (!user?.id) return false;
  if (user.id === CHRIS_MARROQUIN_USER_ID) return true;
  const role = user.real_role || user.role;
  const name = (user.display_name || "").toLowerCase();
  if (role === "admin" && name.includes("marroquin") && name.includes("chris")) return true;
  return false;
}

function yearsLabel(yrs: number | undefined): string | undefined {
  if (yrs == null || Number.isNaN(yrs)) return undefined;
  return yrs === 1 ? "1 year" : `${yrs} years`;
}

function byNameAz(a: RecognitionEvent, b: RecognitionEvent): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/**
 * FINAL UX LOCK:
 * - Same type (2+ birthdays OR 2+ anniversaries) = ONE shared screen, equal huge names.
 * - Mixed types ONLY = sequential by type: birthdays screen, then anniversaries.
 * - Never per-person sequential (no Arin then Eric for two birthdays).
 */
function buildScreens(events: RecognitionEvent[]): ToastScreen[] {
  const birthdays = events.filter((e) => e.event_type === "birthday").slice().sort(byNameAz);
  const anniversaries = events.filter((e) => e.event_type === "anniversary").slice().sort(byNameAz);
  const screens: ToastScreen[] = [];
  if (birthdays.length) {
    screens.push({
      kind: "birthday",
      headline: "Happy birthday",
      people: birthdays.map((ev) => ({ key: `b-${ev.employee_id}`, name: ev.name })),
    });
  }
  if (anniversaries.length) {
    screens.push({
      kind: "anniversary",
      headline: "Happy work anniversary",
      people: anniversaries.map((ev) => ({
        key: `a-${ev.employee_id}`,
        name: ev.name,
        yearsLabel: yearsLabel(ev.years_of_service),
      })),
    });
  }
  return screens;
}

const CONFETTI_BITS = [
  { left: "4%", delay: "0s", kind: "dot", color: "#f9a8d4", dur: "2.4s" },
  { left: "12%", delay: "0.15s", kind: "balloon", color: "#93c5fd", dur: "3.1s" },
  { left: "20%", delay: "0.4s", kind: "dot", color: "#fcd34d", dur: "2.7s" },
  { left: "28%", delay: "0.08s", kind: "dot", color: "#86efac", dur: "2.9s" },
  { left: "36%", delay: "0.55s", kind: "balloon", color: "#f9a8d4", dur: "3.4s" },
  { left: "44%", delay: "0.22s", kind: "dot", color: "#c4b5fd", dur: "2.5s" },
  { left: "52%", delay: "0.7s", kind: "dot", color: "#fda4af", dur: "3.0s" },
  { left: "60%", delay: "0.12s", kind: "balloon", color: "#fcd34d", dur: "2.8s" },
  { left: "68%", delay: "0.38s", kind: "dot", color: "#67e8f9", dur: "3.2s" },
  { left: "76%", delay: "0.5s", kind: "dot", color: "#f9a8d4", dur: "2.6s" },
  { left: "84%", delay: "0.28s", kind: "balloon", color: "#86efac", dur: "3.3s" },
  { left: "92%", delay: "0.62s", kind: "dot", color: "#93c5fd", dur: "2.9s" },
];

/**
 * Can't-miss full-screen birthday / anniversary recognition.
 * Same type shares one screen (equal name size). Mixed types ONLY: Got it advances
 * birthday screen then anniversary screen. No auto-advance. No per-person sequence.
 * Shop: once per user per Chicago day for the WHOLE flow (mark seen when finished).
 * Chris Marroquin (user id 3): polish mode -- never lock; re-shows every open.
 */
export function RecognitionToast({ enabled = true }: { enabled?: boolean }) {
  const { user, realUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [screens, setScreens] = useState<ToastScreen[]>([]);
  const [screenIndex, setScreenIndex] = useState(0);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const day = useMemo(() => chicagoIsoDate(), []);
  const polish = isChrisPolishMode(realUser ?? user);
  const lockUserId = realUser?.id ?? user?.id;

  useEffect(() => {
    if (!enabled || !user?.id) return;
    let cancelled = false;

    const uid = realUser?.id ?? user.id;
    const key = seenKey(uid, day);

    if (!polish) {
      try {
        if (typeof localStorage !== "undefined" && localStorage.getItem(key)) {
          return;
        }
      } catch {
        /* private mode */
      }
    }

    async function load() {
      try {
        const data = await api<TodayPayload>("/recognition/today");
        if (cancelled) return;
        const events = (data.events || []).filter(Boolean);
        const built = buildScreens(events);
        if (!built.length) {
          if (!polish) {
            try { localStorage.setItem(key, "1"); } catch { /* ignore */ }
          }
          return;
        }
        setScreens(built);
        setScreenIndex(0);
        setOpen(true);
      } catch {
        /* optional -- do not block app */
      }
    }

    const t = window.setTimeout(() => void load(), 700);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [enabled, user?.id, realUser?.id, day, polish]);

  useEffect(() => {
    if (!open) return;
    const el = overlayRef.current;
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, [open, screenIndex]);

  const markSeen = () => {
    if (polish || !lockUserId) return;
    try {
      localStorage.setItem(seenKey(lockUserId, day), "1");
    } catch {
      /* ignore */
    }
  };

  const advance = () => {
    if (screenIndex < screens.length - 1) {
      setScreenIndex((i) => i + 1);
      return;
    }
    markSeen();
    setOpen(false);
  };

  if (!open || !screens.length) return null;

  const toast = screens[screenIndex];
  if (!toast) return null;

  const hasMore = screenIndex < screens.length - 1;
  const tapHint = hasMore ? "Tap anywhere for next" : "Tap anywhere to close";
  const multi = toast.people.length > 1;

  return (
    <div
      ref={overlayRef}
      className="recognition-toast-overlay no-print"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recognition-toast-headline"
      onClick={advance}
      onKeyDown={(e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          advance();
        }
      }}
      tabIndex={0}
    >
      {/* Stage does NOT call advance -- overlay owns one tap = one advance (no double-skip). */}
      <div
        key={`recognition-screen-${screenIndex}-${toast.kind}`}
        className="recognition-toast-stage"
      >
        <div className="recognition-toast-confetti" aria-hidden>
          {CONFETTI_BITS.map((b, i) => (
            <span
              key={i}
              className={`recognition-bit recognition-bit-${b.kind}`}
              style={{
                left: b.left,
                animationDelay: b.delay,
                animationDuration: b.dur,
                background: b.color,
              }}
            />
          ))}
        </div>
        <div className="recognition-toast-glow" aria-hidden />
        <h2 id="recognition-toast-headline" className="recognition-toast-headline">
          {toast.headline}
        </h2>
        <ul
          className={
            multi
              ? "recognition-toast-people recognition-toast-people-multi"
              : "recognition-toast-people"
          }
        >
          {toast.people.map((p) => (
            <li key={p.key} className="recognition-toast-person">
              <span className="recognition-toast-name">{p.name}</span>
              {p.yearsLabel ? (
                <span className="recognition-toast-years">{p.yearsLabel}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="recognition-toast-dismiss"
          onClick={(e) => {
            e.stopPropagation();
            advance();
          }}
        >
          Got it
        </button>
        <p className="recognition-toast-tap">{tapHint}</p>
      </div>
    </div>
  );
}