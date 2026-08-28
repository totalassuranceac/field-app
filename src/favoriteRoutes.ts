import { can, type User } from "./api";

export type FavoriteRoute = {
  path: string;
  label: string;
  hint?: string;
};

/** All sections that can appear as Home shortcuts (permissions still apply). */
export const FAVORITE_CATALOG: FavoriteRoute[] = [
  { path: "/vehicles", label: "Trucks", hint: "Units & assignments" },
  { path: "/live", label: "Live map", hint: "Fleet GPS" },
  { path: "/yard", label: "Yard", hint: "Shop yard board" },
  { path: "/fuel", label: "Fuel", hint: "Log fuel" },
  { path: "/fuel/receipt-review", label: "Fuel receipts", hint: "OCR review" },
  { path: "/inspections", label: "Weekly check", hint: "Van weekly checks" },
  { path: "/alerts", label: "Fuel alerts", hint: "Card / fuel issues" },
  { path: "/downtime", label: "Trucks down", hint: "Out of service" },
  { path: "/reports", label: "Reports", hint: "Fleet reports" },
  { path: "/inventory", label: "Stock room", hint: "Parts inventory" },
  { path: "/part-pickup", label: "Part pickup request", hint: "Vendor pickups" },
  { path: "/parts-dropoff", label: "Brought to shop", hint: "Shop drop-offs" },
  { path: "/parts-runs", label: "Warehouse delivery", hint: "Job deliveries" },
  { path: "/truck-stock", label: "Count truck stock", hint: "Truck counts" },
  { path: "/parts-receipts", label: "Bought parts", hint: "Purchase receipts" },
  { path: "/dump-runs", label: "Dump runs", hint: "Dump tickets" },
  { path: "/assets", label: "Company assets", hint: "Gear & bottles" },
  { path: "/warranties", label: "Warranties", hint: "Claims & drop-offs" },
  { path: "/issues", label: "Shop board", hint: "Repairs" },
  { path: "/service", label: "Oil changes", hint: "Service due" },
  { path: "/parts-orders", label: "Order for shop", hint: "Shop orders" },
  { path: "/admin", label: "People", hint: "Employees & logins" },
  { path: "/warehouse-cameras", label: "Security cameras", hint: "NVR / shop cams" },
  { path: "/time-off", label: "Time off", hint: "PTO requests" },
  { path: "/tool-loans", label: "Tool loan", hint: "Borrow tools" },
  { path: "/tool-loan-ledger", label: "Tool loan payroll", hint: "Charges" },
  { path: "/onboarding", label: "New hire packet", hint: "Hire forms" },
  { path: "/termination", label: "Separation notice", hint: "Exit paperwork" },
  { path: "/feedback", label: "App feedback", hint: "Send feedback" },
  { path: "/howto", label: "How-to guides", hint: "App help" },
  { path: "/handbook", label: "Handbook", hint: "Policies" },
  { path: "/notifications", label: "Inbox", hint: "Notifications" },
  { path: "/tv", label: "TV board", hint: "Shop TV" },
  { path: "/settings", label: "Settings", hint: "Account" },
];

const CATALOG_BY_PATH = new Map(FAVORITE_CATALOG.map((r) => [r.path, r]));

export function favoriteMeta(path: string): FavoriteRoute | null {
  return CATALOG_BY_PATH.get(normalizeFavoritePath(path)) || null;
}

export function normalizeFavoritePath(path: string): string {
  if (!path) return "";
  let p = path.split("?")[0].split("#")[0].trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Whether this user may open (and therefore favorite) the path. */
export function canFavoritePath(user: User | null, path: string): boolean {
  if (!user) return false;
  const p = normalizeFavoritePath(path);
  if (!CATALOG_BY_PATH.has(p)) return false;

  const role = user.role;
  const adminShell =
    role === "admin" || role === "viewer" || (role === "office" && !user.is_warehouse);
  const isWarehouse = role === "warehouse" || (!!user.is_warehouse && role === "office");
  const isDriver = role === "driver";
  const isMechanic = role === "mechanic";
  const isOffice = role === "office" && !user.is_warehouse;
  const isSupervisor = role === "supervisor";

  switch (p) {
    case "/vehicles":
      return adminShell || isWarehouse || isMechanic || isSupervisor;
    case "/live":
      return can(user, "viewLiveMap");
    case "/yard":
      return adminShell || isMechanic || isSupervisor;
    case "/fuel":
      return adminShell || can(user, "logFuel") || can(user, "viewReports") || isDriver;
    case "/fuel/receipt-review":
      return adminShell || can(user, "editFuel");
    case "/inspections":
      return adminShell || isDriver || isMechanic || isOffice || isSupervisor || isWarehouse;
    case "/alerts":
      return adminShell || isMechanic || (isOffice && can(user, "viewAlerts")) || isSupervisor;
    case "/downtime":
      return (
        adminShell ||
        isMechanic ||
        isSupervisor ||
        (isOffice && (can(user, "viewReports") || can(user, "manageIssues")))
      );
    case "/reports":
      return adminShell || isMechanic || isSupervisor || (isOffice && can(user, "viewReports"));
    case "/inventory":
      return adminShell || can(user, "viewInventory") || isWarehouse;
    case "/part-pickup":
    case "/parts-dropoff":
    case "/parts-runs":
    case "/truck-stock":
      return true;
    case "/parts-receipts":
      return can(user, "logPartsPurchase") || can(user, "viewPartsPurchase");
    case "/dump-runs":
      return can(user, "viewDumpRuns") || can(user, "logDumpRuns") || isWarehouse;
    case "/assets":
      return true;
    case "/warranties":
      return true;
    case "/issues":
      return true;
    case "/service":
      return adminShell || isMechanic || isSupervisor;
    case "/parts-orders":
      return adminShell || isMechanic || isWarehouse || isSupervisor;
    case "/admin":
      return can(user, "manageUsers") || can(user, "manageEmployees") || role === "viewer";
    case "/warehouse-cameras":
      return adminShell || isOffice || isWarehouse || isSupervisor;
    case "/time-off":
    case "/tool-loans":
      return true;
    case "/tool-loan-ledger":
      return role === "admin" || role === "office" || role === "supervisor";
    case "/onboarding":
    case "/termination":
      return can(user, "manageUsers") || can(user, "manageEmployees") || role === "office";
    case "/feedback":
    case "/howto":
    case "/handbook":
    case "/notifications":
    case "/settings":
      return true;
    case "/tv":
      return adminShell || isOffice || isMechanic || isSupervisor;
    default:
      return false;
  }
}

export function allowedFavoriteCatalog(user: User | null): FavoriteRoute[] {
  return FAVORITE_CATALOG.filter((r) => canFavoritePath(user, r.path));
}

export const MAX_FAVORITES = 16;
