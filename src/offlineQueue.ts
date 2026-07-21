/**
 * Offline / bad-signal mutation queue.
 * POST/PATCH/PUT/DELETE that fail due to network are stored in IndexedDB
 * and replayed when the device is online again.
 */

const DB_NAME = "ta-fleet-offline";
const DB_VERSION = 1;
const STORE = "mutations";

export type QueuedMutation = {
  id: string;
  path: string;
  method: string;
  /** JSON body as string */
  jsonBody?: string;
  /** FormData serialized for photo uploads */
  formParts?: Array<
    | { kind: "text"; name: string; value: string }
    | { kind: "file"; name: string; fileName: string; type: string; data: ArrayBuffer }
  >;
  label: string;
  createdAt: number;
  attempts: number;
  lastError?: string;
};

export class OfflineQueuedError extends Error {
  queueId: string;
  pendingCount: number;
  constructor(queueId: string, pendingCount: number, label: string) {
    super(
      `Saved offline (${label}). Will send automatically when you have signal again. Pending: ${pendingCount}.`
    );
    this.name = "OfflineQueuedError";
    this.queueId = queueId;
    this.pendingCount = pendingCount;
  }
}

type Listener = (count: number) => void;
const listeners = new Set<Listener>();

function notify(count: number) {
  for (const fn of listeners) {
    try {
      fn(count);
    } catch {
      /* ignore */
    }
  }
}

export function subscribeOfflineQueue(fn: Listener): () => void {
  listeners.add(fn);
  void pendingCount().then(fn);
  return () => listeners.delete(fn);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let req: IDBRequest<T> | void;
    try {
      req = fn(store) as IDBRequest<T> | void;
    } catch (e) {
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB tx failed"));
    if (req) {
      req.onerror = () => reject(req.error);
    }
  });
}

export async function listQueued(): Promise<QueuedMutation[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => {
        const rows = (req.result || []) as QueuedMutation[];
        rows.sort((a, b) => a.createdAt - b.createdAt);
        resolve(rows);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function pendingCount(): Promise<number> {
  const list = await listQueued();
  return list.length;
}

function labelFor(path: string, method: string): string {
  if (path.startsWith("/warranties") && method === "POST") return "Warranty drop-off";
  if (path.startsWith("/warranties")) return "Warranty update";
  if (path.startsWith("/fuel")) return "Fuel log";
  if (path.startsWith("/issues")) return "Repair request";
  if (path.startsWith("/inspections")) return "Weekly check";
  if (path.includes("/condition")) return "Equipment condition";
  if (path.includes("/hand-over") || path.includes("/complete") || path.includes("/pickups"))
    return "Pickup / handoff";
  if (path.startsWith("/assets")) return "Assets update";
  if (path.startsWith("/inventory")) return "Inventory change";
  if (path.startsWith("/uploads")) return "Photo upload";
  if (path.startsWith("/messages")) return "Message";
  return `${method} ${path}`;
}

/** Paths that must never be queued (auth, reads). */
export function isQueueableMutation(path: string, method: string): boolean {
  const m = method.toUpperCase();
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(m)) return false;
  if (path.startsWith("/auth")) return false;
  if (path.startsWith("/ocr")) return false;
  // Live GPS etc. — not user "save" actions
  if (path.startsWith("/live")) return false;
  return true;
}

export function isNetworkFailure(err: unknown, status?: number): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (status === 0 || status === 502 || status === 503 || status === 504) return true;
  if (err instanceof TypeError) return true; // fetch failed
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("network") ||
      msg.includes("offline") ||
      msg.includes("failed to fetch") ||
      msg.includes("could not reach")
    ) {
      return true;
    }
  }
  return false;
}

export async function enqueueFromRequest(
  path: string,
  options: RequestInit
): Promise<QueuedMutation> {
  const method = (options.method || "GET").toUpperCase();
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const item: QueuedMutation = {
    id,
    path,
    method,
    label: labelFor(path, method),
    createdAt: Date.now(),
    attempts: 0,
  };

  if (options.body instanceof FormData) {
    const parts: QueuedMutation["formParts"] = [];
    for (const [name, value] of options.body.entries()) {
      if (typeof value === "string") {
        parts.push({ kind: "text", name, value });
      } else {
        const file = value as File;
        const data = await file.arrayBuffer();
        parts.push({
          kind: "file",
          name,
          fileName: file.name || "photo.jpg",
          type: file.type || "image/jpeg",
          data,
        });
      }
    }
    item.formParts = parts;
  } else if (typeof options.body === "string") {
    item.jsonBody = options.body;
  } else if (options.body != null) {
    item.jsonBody = JSON.stringify(options.body);
  }

  await withStore("readwrite", (store) => store.put(item));
  const count = await pendingCount();
  notify(count);
  return item;
}

async function removeQueued(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
  notify(await pendingCount());
}

async function bumpAttempt(id: string, lastError: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const row = getReq.result as QueuedMutation | undefined;
      if (row) {
        row.attempts = (row.attempts || 0) + 1;
        row.lastError = lastError.slice(0, 200);
        store.put(row);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let flushing = false;

/**
 * Replay queued mutations oldest-first.
 * Stops on first hard failure that isn't "still offline".
 */
export async function flushOfflineQueue(): Promise<{
  sent: number;
  remaining: number;
  errors: string[];
}> {
  if (flushing) {
    return { sent: 0, remaining: await pendingCount(), errors: [] };
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { sent: 0, remaining: await pendingCount(), errors: ["Still offline"] };
  }

  flushing = true;
  let sent = 0;
  const errors: string[] = [];

  try {
    const queue = await listQueued();
    for (const item of queue) {
      try {
        let body: BodyInit | undefined;
        const headers = new Headers();
        if (item.formParts) {
          const fd = new FormData();
          for (const p of item.formParts) {
            if (p.kind === "text") {
              fd.append(p.name, p.value);
            } else {
              fd.append(p.name, new Blob([p.data], { type: p.type }), p.fileName);
            }
          }
          body = fd;
        } else if (item.jsonBody != null) {
          body = item.jsonBody;
          headers.set("Content-Type", "application/json");
        }

        const res = await fetch(`/api${item.path}`, {
          method: item.method,
          headers,
          body,
          credentials: "include",
        });

        if (res.status === 401) {
          errors.push("Session expired — sign in again to sync pending changes.");
          break;
        }

        if (res.status === 502 || res.status === 503 || res.status === 504) {
          await bumpAttempt(item.id, `HTTP ${res.status}`);
          errors.push("Server still unavailable — will retry.");
          break;
        }

        if (!res.ok) {
          // Server rejected — drop so we don't loop forever on bad data
          const text = await res.text().catch(() => "");
          let msg = `HTTP ${res.status}`;
          try {
            const j = JSON.parse(text) as { error?: string };
            if (j.error) msg = j.error;
          } catch {
            /* ignore */
          }
          await removeQueued(item.id);
          errors.push(`${item.label}: ${msg}`);
          continue;
        }

        await removeQueued(item.id);
        sent += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await bumpAttempt(item.id, msg);
        if (isNetworkFailure(e)) {
          errors.push("Still no connection — will retry when signal returns.");
          break;
        }
        errors.push(`${item.label}: ${msg}`);
      }
    }
  } finally {
    flushing = false;
  }

  const remaining = await pendingCount();
  notify(remaining);
  return { sent, remaining, errors };
}

let bootstrapped = false;

/** Call once from app root — listens for online / focus and flushes. */
export function bootstrapOfflineQueue(): void {
  if (bootstrapped || typeof window === "undefined") return;
  bootstrapped = true;

  const tryFlush = () => {
    void flushOfflineQueue().then((r) => {
      if (r.sent > 0 && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("ta-offline-synced", { detail: r })
        );
      }
    });
  };

  window.addEventListener("online", tryFlush);
  window.addEventListener("focus", tryFlush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") tryFlush();
  });
  // First attempt shortly after load
  window.setTimeout(tryFlush, 1500);
  // Periodic retry while pending (bad signal flaps)
  window.setInterval(() => {
    void pendingCount().then((n) => {
      if (n > 0 && navigator.onLine) tryFlush();
    });
  }, 30_000);
}
