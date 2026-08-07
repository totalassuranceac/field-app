import { useEffect, useState } from "react";
import {
  clearOfflineQueue,
  flushOfflineQueue,
  listQueued,
  subscribeOfflineQueue,
} from "../offlineQueue";

/**
 * Shows when there are pending offline changes, or when the device is offline.
 */
export function OfflineBanner() {
  const [pending, setPending] = useState(0);
  const [labels, setLabels] = useState<string[]>([]);
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState("");

  async function refreshLabels() {
    try {
      const list = await listQueued();
      setLabels(list.map((q) => q.label + (q.lastError ? ` (${q.lastError})` : "")));
    } catch {
      setLabels([]);
    }
  }

  useEffect(() => {
    const unsub = subscribeOfflineQueue((n) => {
      setPending(n);
      void refreshLabels();
    });
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
    void refreshLabels();
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
      if (r.labels?.length) setLabels(r.labels);
      else await refreshLabels();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Sync failed");
    } finally {
      setSyncing(false);
      window.setTimeout(() => setMsg(""), 8000);
    }
  }

  async function discardPending() {
    if (
      !window.confirm(
        `Discard ${pending} unsynced change${pending === 1 ? "" : "s"} on this phone?\n\nThey will not be sent to the server. Only do this if you already re-entered the work or no longer need them.`
      )
    ) {
      return;
    }
    setSyncing(true);
    try {
      const n = await clearOfflineQueue();
      setMsg(n ? `Discarded ${n} pending change${n === 1 ? "" : "s"}.` : "Queue was already empty.");
      setLabels([]);
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
            — not on the server yet. Tap <strong>Send now</strong> if you’re on
            Wi‑Fi. If it hangs, wait ~15 seconds for a timeout, or sign out and
            back in.
            {labels.length > 0 ? (
              <span className="muted">
                {" "}
                · Waiting: {labels.slice(0, 3).join("; ")}
                {labels.length > 3 ? "…" : ""}
              </span>
            ) : null}
          </>
        ) : (
          msg
        )}
        {msg && pending > 0 ? <span className="muted"> · {msg}</span> : null}
      </div>
      {(pending > 0 || !online) && (
        <div className="offline-banner-actions">
          <button
            type="button"
            className="btn secondary offline-banner-btn"
            disabled={syncing || !online}
            onClick={() => void retryNow()}
          >
            {syncing ? "Sending…" : online ? "Send now" : "Waiting…"}
          </button>
          {pending > 0 && online ? (
            <button
              type="button"
              className="btn secondary offline-banner-btn"
              disabled={syncing}
              onClick={() => void discardPending()}
            >
              Discard
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
