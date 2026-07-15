export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function redirectToLogin() {
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export async function api<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new ApiError(0, "You appear to be offline. Check your connection and try again.");
  }

  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      ...options,
      headers,
      credentials: "include",
    });
  } catch {
    throw new ApiError(
      0,
      "Network error — could not reach the server. Check connection and try again."
    );
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text ? { error: text.slice(0, 200) } : null;
  }

  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/me")) {
    redirectToLogin();
    throw new ApiError(401, "Session expired. Please sign in again.");
  }

  if (!res.ok) {
    const msg =
      data && typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: string }).error)
        : res.statusText || `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export type Role = "admin" | "office" | "driver" | "mechanic" | "viewer";

export interface User {
  id: number;
  email: string | null;
  username: string | null;
  display_name: string;
  role: Role;
  employee_id: number | null;
}

export function can(user: User | null, action: string): boolean {
  if (!user) return false;
  const r = user.role;
  const map: Record<string, Role[]> = {
    manageUsers: ["admin"],
    manageEmployees: ["admin", "office"],
    manageVehicles: ["admin", "office", "mechanic"],
    logFuel: ["admin", "office", "driver"],
    editFuel: ["admin", "office"],
    manageAlerts: ["admin", "office"],
    reportIssues: ["admin", "office", "driver", "mechanic"],
    manageIssues: ["admin", "mechanic", "office"],
    viewAudit: ["admin"],
    viewReports: ["admin", "office", "mechanic", "viewer"],
    manageSettings: ["admin"],
  };
  return (map[action] || []).includes(r);
}

/** Short role guide for UI copy */
export function roleLabel(role: Role | string | undefined): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "office":
      return "Office";
    case "driver":
      return "Technician";
    case "mechanic":
      return "Fleet mechanic";
    case "viewer":
      return "Viewer";
    default:
      return role || "User";
  }
}
