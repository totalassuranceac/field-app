import { useEffect, useState } from "react";
import {
  flushOfflineQueue,
  subscribeOfflineQueue,
} from "../offlineQueue";

/**
 * Shows when there are pending offline changes, or when the device is offline.
 */
export function OfflineBanner() {
  const [pending, setPending] = useState(0);
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const unsub = subscribeOfflineQueue(setPending);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    const onSynced = (e: Event) => {
      const d = (e as CustomEvent).detail as { sent?: number } | undefined;
      if (d?.sent) {
        setMsg(`${d.sent} change${d.sent === 1 ? "" : "s"} synced.`);
        window.setTimeout(() => setMsg(""), 4000);
      }
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("ta-offline-synced", onSynced);
    return () => {
      unsub();
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("ta-offline-synced", onSynced);
    };
  }, []);

  async function retryNow() {
    setSyncing(true);
    setMsg("");
    try {
      const r = await flushOfflineQueue();
      if (r.sent) setMsg(`${r.sent} synced.`);
      else if (r.errors[0]) setMsg(r.errors[0]);
      else if (r.remaining) setMsg("Still waiting for a solid connection…");
      else setMsg("Queue is clear.");
    } finally {
      setSyncing(false);
      window.setTimeout(() => setMsg(""), 5000);
    }
  }

  if (online && pending === 0 && !msg) return null;

  return (
    <div
      className={`offline-banner${!online ? " is-offline" : ""}${pending > 0 ? " has-pending" : ""}`}
      role="status"
    >
      <div className="offline-banner-text">
        {!online ? (
          <>
            <strong>Saved offline</strong> — no signal right now. Keep working;
            fuel, drop-offs, and other saves stay on this phone and send
            automatically when you’re back on Wi‑Fi or cell data.
            {pending > 0 ? ` (${pending} waiting to send)` : ""}
          </>
        ) : pending > 0 ? (
          <>
            <strong>
              {pending} change{pending === 1 ? "" : "s"} saved on this phone
            </strong>{" "}
            — not on the server yet (weak or no service when you saved). Will
            auto-send when the connection is solid. Tap Retry if you’re online
            and it’s stuck.
          </>
        ) : (
          msg
        )}
        {msg && pending > 0 ? <span className="muted"> · {msg}</span> : null}
      </div>
      {(pending > 0 || !online) && (
        <button
          type="button"
          className="btn secondary offline-banner-btn"
          disabled={syncing || !online}
          onClick={() => void retryNow()}
        >
          {syncing ? "Sending…" : online ? "Send now" : "Waiting…"}
        </button>
      )}
    </div>
  );
}
