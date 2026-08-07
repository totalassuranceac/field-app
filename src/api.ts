import {
  bootstrapOfflineQueue,
  enqueueFromRequest,
  flushOfflineQueue,
  isNetworkFailure,
  isQueueableMutation,
  OfflineQueuedError,
  pendingCount,
  subscribeOfflineQueue,
} from "./offlineQueue";

export {
  OfflineQueuedError,
  flushOfflineQueue,
  pendingCount,
  subscribeOfflineQueue,
  bootstrapOfflineQueue,
};

export class ApiError extends Error {
  status: number;
  /** Parsed JSON body when the server returned an error object */
  data?: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function redirectToLogin() {
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  if (path === "/login" || path.startsWith("/join/")) return;
  const next = path + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

/** Default request timeout (ms). Mobile carriers often stall ~15s then fail the page. */
const DEFAULT_TIMEOUT_MS = 12_000;
/** Auth must fail fast so the app never sits on a blank “Loading…” screen. */
const AUTH_TIMEOUT_MS = 6_000;

export type ApiOptions = RequestInit & {
  /** Override request timeout in ms (0 = no timeout). */
  timeoutMs?: number;
};

/**
 * API helper. Mutating requests that hit offline / bad signal are queued in
 * IndexedDB and sent automatically when connection returns.
 */
export async function api<T = unknown>(
  path: string,
  options: ApiOptions = {}
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const queueable = isQueueableMutation(path, method);
  const { timeoutMs: timeoutOpt, ...fetchInit } = options;

  if (typeof navigator !== "undefined" && navigator.onLine === false && queueable) {
    const item = await enqueueFromRequest(path, options);
    const count = await pendingCount();
    throw new OfflineQueuedError(item.id, count, item.label);
  }

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError(0, "You appear to be offline. Check your connection and try again.");
  }

  const headers = new Headers(fetchInit.headers || {});
  if (fetchInit.body && !(fetchInit.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const isAuthMe = path === "/auth/me" || path.startsWith("/auth/me?");
  const timeoutMs =
    timeoutOpt !== undefined
      ? timeoutOpt
      : isAuthMe
        ? AUTH_TIMEOUT_MS
        : DEFAULT_TIMEOUT_MS;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller && timeoutMs > 0) {
    // Honor caller abort if provided
    if (fetchInit.signal) {
      if (fetchInit.signal.aborted) controller.abort();
      else {
        fetchInit.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...fetchInit,
      headers,
      credentials: "include",
      signal: controller?.signal ?? fetchInit.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      throw new ApiError(
        0,
        "Server took too long to respond. Check signal and try again."
      );
    }
    if (queueable && isNetworkFailure(err)) {
      const item = await enqueueFromRequest(path, options);
      const count = await pendingCount();
      throw new OfflineQueuedError(item.id, count, item.label);
    }
    throw new ApiError(
      0,
      "Network error — could not reach the server. Check connection and try again."
    );
  }
  if (timer) clearTimeout(timer);

  // Gateway blips on mobile — queue mutations so they aren't lost
  if (queueable && (res.status === 502 || res.status === 503 || res.status === 504)) {
    const item = await enqueueFromRequest(path, options);
    const count = await pendingCount();
    throw new OfflineQueuedError(item.id, count, item.label);
  }

  const text = await res.text();
  const looksLikeHtml =
    /^\s*<(!DOCTYPE|html|!--)/i.test(text) || text.includes("<!DOCTYPE html>");

  let data: unknown = null;
  if (text && !looksLikeHtml) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  // /auth/me may return 401 on some edge paths — treat as logged out, never redirect-loop
  if (res.status === 401 && (path.startsWith("/auth/me") || path === "/auth/me")) {
    return { user: null } as T;
  }

  if (
    res.status === 401 &&
    !path.startsWith("/auth/login") &&
    !path.startsWith("/auth/me") &&
    !path.startsWith("/auth/invite")
  ) {
    redirectToLogin();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }

  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`;
    if (data && typeof data === "object" && data !== null) {
      const obj = data as { error?: string; message?: string };
      if (obj.error) msg = String(obj.error);
      else if (obj.message) msg = String(obj.message);
    } else if (looksLikeHtml) {
      msg =
        res.status === 502 || res.status === 503 || res.status === 504
          ? "Server temporarily unavailable. Wait a moment and try again."
          : `Server error (${res.status}). Try refresh — if it keeps happening, the API may be overloaded.`;
    } else if (text && text.length < 200 && !text.includes("<")) {
      msg = text;
    }
    msg = msg.replace(/\s+/g, " ").trim().slice(0, 200);
    throw new ApiError(res.status, msg, data);
  }

  if (looksLikeHtml) {
    // SPA fallback HTML on an API path — do not hang auth forever
    if (path.startsWith("/auth/me")) return { user: null } as T;
    throw new ApiError(
      res.status || 502,
      "Got an unexpected response from the server. Refresh and try again."
    );
  }
  if (data == null) {
    if (path.startsWith("/auth/me")) return { user: null } as T;
    throw new ApiError(
      res.status || 502,
      "Got an empty response from the server. Refresh and try again."
    );
  }
  return data as T;
}

/**
 * Authenticated binary fetch (JPEG snapshots, file downloads).
 * Same cookies / timeout behavior as api(), but returns a Blob.
 */
export async function apiBinary(
  path: string,
  options: ApiOptions = {}
): Promise<Blob> {
  const { timeoutMs: timeoutOpt, ...fetchInit } = options;
  const timeoutMs = timeoutOpt !== undefined ? timeoutOpt : DEFAULT_TIMEOUT_MS;

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError(0, "You appear to be offline. Check your connection and try again.");
  }

  const headers = new Headers(fetchInit.headers || {});
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (controller && timeoutMs > 0) {
    if (fetchInit.signal) {
      if (fetchInit.signal.aborted) controller.abort();
      else {
        fetchInit.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...fetchInit,
      headers,
      credentials: "include",
      signal: controller?.signal ?? fetchInit.signal,
    });
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      throw new ApiError(0, "Server took too long to respond. Check signal and try again.");
    }
    throw new ApiError(
      0,
      "Network error — could not reach the server. Check connection and try again."
    );
  }
  if (timer) clearTimeout(timer);

  if (res.status === 401) {
    redirectToLogin();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }

  if (!res.ok) {
    let msg = res.statusText || `Request failed (${res.status})`;
    try {
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (data && typeof data === "object" && data !== null) {
        const obj = data as { error?: string; message?: string };
        if (obj.error) msg = String(obj.error);
        else if (obj.message) msg = String(obj.message);
      } else if (text && text.length < 200 && !text.includes("<")) {
        msg = text;
      }
    } catch {
      /* keep status text */
    }
    throw new ApiError(res.status, msg.replace(/\s+/g, " ").trim().slice(0, 220));
  }

  const blob = await res.blob();
  if (!blob.size) {
    throw new ApiError(502, "Empty image from camera proxy");
  }
  return blob;
}

export type Role =
  | "admin"
  | "office"
  | "driver"
  | "mechanic"
  | "viewer"
  | "warehouse"
  | "supervisor";

/** Roles admin can preview as (session "view as") */
export const VIEW_AS_ROLES: Role[] = [
  "supervisor",
  "warehouse",
  "office",
  "driver",
  "mechanic",
  "viewer",
];

export interface User {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  role: Role;
  /** Warehouse is stored as office + is_warehouse in DB */
  is_warehouse?: boolean;
  /** Real role when admin is previewing another role */
  real_role?: Role;
  employee_id: number | null;
  phone?: string | null;
  must_change_password?: boolean;
}

/** All permission keys used by the UI (admin always has every one). */
export const ALL_PERMISSIONS = [
  "manageUsers",
  "manageEmployees",
  "manageVehicles",
  "manageVehicleCompliance",
  "logFuel",
  "editFuel",
  "logPartsPurchase",
  "viewPartsPurchase",
  "viewAlerts",
  "manageAlerts",
  "reportIssues",
  "manageIssues",
  "viewAudit",
  "viewReports",
  "manageSettings",
  "viewInventory",
  "manageInventory",
  "manageInventoryLevels",
  "viewCompanyAssets",
  "manageCompanyAssets",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Permissions that change data (viewer never has these). */
const WRITE_PERMISSIONS = new Set<string>([
  "manageUsers",
  "manageEmployees",
  "manageVehicles",
  "manageVehicleCompliance",
  "logFuel",
  "editFuel",
  "logPartsPurchase",
  "manageAlerts",
  "reportIssues",
  "manageIssues",
  "manageSettings",
  "manageInventory",
  "manageInventoryLevels",
  "manageCompanyAssets",
]);

/** True for the explorer role — same UI as admin, no mutations. */
export function isViewer(user: User | null | undefined): boolean {
  return user?.role === "viewer";
}

/**
 * Broad nav shell (fleet + warehouse + company menus).
 * Admin, viewer (read-only), and supervisor (ops, no system settings).
 */
export function usesAdminShell(user: User | null | undefined): boolean {
  return (
    user?.role === "admin" ||
    user?.role === "viewer" ||
    user?.role === "supervisor"
  );
}

/**
 * UI permission check.
 * - Effective role "admin" → superuser (all features).
 * - "viewer" → same browse surface as admin, but never write actions
 *   (so they can explore the app without changing data).
 * - When admin uses View as, role becomes warehouse/field/etc. so the UI
 *   matches that role (API still runs as admin on the server).
 */
export function can(user: User | null, action: string): boolean {
  if (!user) return false;
  const r = user.role;
  // Superuser only when not previewing another role
  if (r === "admin") return true;

  // Viewer: read-only twin of admin UI
  if (r === "viewer") {
    if (WRITE_PERMISSIONS.has(action)) return false;
    // All non-write capabilities (view*, browse) are allowed
    return true;
  }

  const map: Record<string, Role[]> = {
    manageUsers: ["admin"],
    manageEmployees: ["admin", "office", "supervisor"],
    manageVehicles: ["admin", "office", "mechanic", "supervisor"],
    manageVehicleCompliance: ["admin", "office", "mechanic", "supervisor"],
    logFuel: ["admin", "office", "driver", "mechanic", "warehouse", "supervisor"],
    editFuel: ["admin", "office", "supervisor"],
    logPartsPurchase: [
      "admin",
      "office",
      "driver",
      "mechanic",
      "warehouse",
      "supervisor",
    ],
    viewPartsPurchase: [
      "admin",
      "office",
      "driver",
      "mechanic",
      "warehouse",
      "viewer",
      "supervisor",
    ],
    viewAlerts: ["admin", "office", "mechanic", "viewer", "supervisor"],
    manageAlerts: ["admin", "office", "mechanic", "supervisor"],
    reportIssues: ["admin", "office", "driver", "mechanic", "supervisor"],
    manageIssues: ["admin", "mechanic", "office", "supervisor"],
    viewAudit: ["admin", "viewer", "supervisor"],
    viewReports: [
      "admin",
      "office",
      "mechanic",
      "viewer",
      "warehouse",
      "supervisor",
    ],
    manageSettings: ["admin"],
    viewInventory: ["admin", "office", "warehouse", "viewer", "supervisor"],
    manageInventory: ["admin", "warehouse"],
    manageInventoryLevels: ["admin", "warehouse"],
    viewCompanyAssets: [
      "admin",
      "office",
      "warehouse",
      "driver",
      "mechanic",
      "viewer",
      "supervisor",
    ],
    manageCompanyAssets: ["admin", "warehouse"],
  };
  return (map[action] || []).includes(r);
}

/** Permission matrix for role simulation / admin testing */
export function permissionsForRole(role: Role): Record<string, boolean> {
  const fake: User = {
    id: 0,
    email: null,
    username: null,
    display_name: role,
    role,
    employee_id: null,
  };
  const out: Record<string, boolean> = {};
  for (const p of ALL_PERMISSIONS) {
    out[p] = can(fake, p);
  }
  return out;
}

/** Short role guide for UI copy (internal codes stay: driver = field) */
export function roleLabel(role: Role | string | undefined): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "office":
      return "Office";
    case "driver":
      return "Field";
    case "mechanic":
      return "Mechanic";
    case "warehouse":
      return "Warehouse";
    case "viewer":
      return "Viewer";
    case "supervisor":
      return "Supervisor";
    default:
      return role || "User";
  }
}

/**
 * Product name in the shell / tab title.
 * One app for field, warehouse, shop, and office — role is shown on the user card.
 */
export function appBrandName(role?: Role | string | undefined): string {
  if (role === "viewer") return "Field App · Viewer";
  if (role === "supervisor") return "Field App · Supervisor";
  return "Field App";
}

/** Full product line under Total Assurance (login, PWA, docs). */
export const APP_PRODUCT_NAME = "Field App";
export const APP_COMPANY_LINE = "Total Assurance A/C & Heating";
