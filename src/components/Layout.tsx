import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import {
  api,
  can,
  isViewer,
  roleLabel,
  usesAdminShell,
  type Role,
} from "../api";
import { useAuth } from "../auth";
import {
  canFavoritePath,
  favoriteMeta,
  normalizeFavoritePath,
} from "../favoriteRoutes";
import {
  clearNavReturn,
  readNavReturn,
  returnBarLabel,
} from "../navReturn";
import { useFavorites } from "../useFavorites";
import { GlobalQuickSearch } from "./GlobalQuickSearch";
import { NotificationBell } from "./NotificationBell";
import { OfflineBanner } from "./OfflineBanner";
import { RecognitionToast } from "./RecognitionToast";

type NavItem = {
  to: string;
  label: string;
  show: boolean;
  /** Visual subhead inside a long group. Not a new door. */
  section?: string;
  badge?: number;
  /** Show badge even when 0 (e.g. warehouse vendor-run counter) */
  badgeAlways?: boolean;
  badgeLabel?: string;
  /** Official A mark before the label (Studio door) */
  markA?: boolean;
};

function NavBadge({
  count,
  always,
  label,
}: {
  count: number;
  always?: boolean;
  label?: string;
}) {
  if (!always && count <= 0) return null;
  const display = count > 99 ? "99+" : count;
  const zero = count <= 0;
  return (
    <span
      className={`nav-badge${zero ? " is-zero" : " is-hot"}`}
      aria-label={label || (zero ? "None waiting" : `${count} waiting`)}
      title={label || (zero ? "Caught up" : `${count} to pick up`)}
    >
      {display}
    </span>
  );
}

function NavGroup({ title, items }: { title: string; items: NavItem[] }) {
  const visible = items.filter((l) => l.show);
  if (!visible.length) return null;
  return (
    <div className="nav-group">
      <div className="nav-group-title">{title}</div>
      {visible.map((l) => (
        <NavLink
          key={l.to}
          to={l.to}
          end={l.to === "/" || l.to === "/live" || l.to === "/inventory"}
          className={({ isActive }) => (isActive ? "active" : undefined)}
        >
          <span className={l.markA ? "nav-label-with-mark" : undefined}>
            {l.markA ? (
              <img src="/logo-mark.png" alt="" className="nav-mark-a" width={18} height={18} />
            ) : null}
            {l.label}
          </span>
          {l.badge != null && (
            <NavBadge count={l.badge} always={l.badgeAlways} label={l.badgeLabel} />
          )}
        </NavLink>
      ))}
    </div>
  );
}

/** Collapsible category for admin nav — click header to expand */
function NavCategory({
  id,
  title,
  hint,
  items,
  open,
  onToggle,
}: {
  id: string;
  title: string;
  hint?: string;
  items: NavItem[];
  open: boolean;
  onToggle: (id: string) => void;
}) {
  const visible = items.filter((l) => l.show);
  if (!visible.length) return null;
  return (
    <div className={`nav-category${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="nav-category-toggle"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(id);
        }}
      >
        <span className="nav-category-label">
          <strong>{title}</strong>
          {hint ? <span className="nav-category-hint">{hint}</span> : null}
        </span>
        <span className="nav-category-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="nav-category-items">
          {visible.map((l, i) => (
            <span key={l.to} className="nav-item-wrap">
            {l.section && l.section !== visible[i - 1]?.section ? (
              <div className="nav-section-label">{l.section}</div>
            ) : null}
            <NavLink
              to={l.to}
              end={l.to === "/" || l.to === "/live" || l.to === "/inventory"}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              <span className={l.markA ? "nav-label-with-mark" : undefined}>
                {l.markA ? (
                  <img src="/logo-mark.png" alt="" className="nav-mark-a" width={18} height={18} />
                ) : null}
                {l.label}
              </span>
              {l.badge != null && (
                <NavBadge count={l.badge} always={l.badgeAlways} label={l.badgeLabel} />
              )}
            </NavLink>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Which collapsible nav section a path belongs to (same for every role). */
function pathCategory(pathname: string): string {
  if (pathname.startsWith("/day-board")) return "dispatch";
  if (pathname.startsWith("/clock") || pathname.startsWith("/tools-checklist")) return "mywork";
  if (pathname.startsWith("/ops-performance") || pathname.startsWith("/nate")) return "performance";
  if (pathname.startsWith("/live-inventory")) return "warehouse";
  if (
    pathname.startsWith("/vehicles") ||
    pathname.startsWith("/live") ||
    pathname.startsWith("/yard") ||
    pathname.startsWith("/alerts") ||
    pathname.startsWith("/downtime") ||
    pathname.startsWith("/reports") ||
    pathname.startsWith("/fuel") ||
    pathname.startsWith("/inspections")
  ) {
    return "fleet";
  }
  if (
    pathname.startsWith("/live-inventory") ||
    pathname.startsWith("/inventory") ||
    pathname.startsWith("/part-pickup") ||
    pathname.startsWith("/vendor-runs") ||
    pathname.startsWith("/parts-dropoff") ||
    pathname.startsWith("/deliveries") ||
    pathname.startsWith("/truck-stock") ||
    pathname.startsWith("/parts-receipts") ||
    pathname.startsWith("/assets") ||
    pathname.startsWith("/warranties") ||
    pathname.startsWith("/invoice-lookup") ||
    pathname.startsWith("/parts-runs") ||
    pathname.startsWith("/dump-runs")
  ) {
    return "warehouse";
  }
  if (
    pathname.startsWith("/issues") ||
    pathname.startsWith("/fleet-shop") ||
    pathname.startsWith("/done-today") ||
    pathname.startsWith("/service") ||
    pathname.startsWith("/parts-orders")
  ) {
    return "shop";
  }
  if (
    pathname.startsWith("/admin") ||
    pathname.startsWith("/roles") ||
    pathname.startsWith("/audit") ||
    pathname.startsWith("/review-texts") ||
    pathname.startsWith("/time-off") ||
    pathname.startsWith("/tool-loans") ||
    pathname.startsWith("/tool-loan-ledger") ||
    pathname.startsWith("/reviews") ||
    pathname.startsWith("/notifications") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/warehouse-cameras") ||
    pathname.startsWith("/studio") ||
    pathname.startsWith("/tv")
  ) {
    return "company";
  }
  if (
    pathname.startsWith("/safety") ||
    pathname.startsWith("/howto") ||
    pathname.startsWith("/handbook") ||
    pathname.startsWith("/feedback")
  ) {
    return "help";
  }
  return "home";
}

export function Layout({ children }: { children: ReactNode }) {
  const { user, realUser, viewAsRole, setViewAsRole } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const { isFavorite, toggleFavorite, busy: favBusy } = useFavorites();
  /** Full-screen TV wallboard — no sidebar / top chrome */
  const isTvBoard = location.pathname === "/tv" || location.pathname.startsWith("/tv/");
  useEffect(() => {
    if (location.pathname === "/feedback") return;
    try {
      sessionStorage.setItem("fieldapp-last-path", location.pathname);
    } catch {
      /* ignore */
    }
  }, [location.pathname]);
  const favPath = normalizeFavoritePath(location.pathname);
  const favAllowed = canFavoritePath(user, favPath);
  const favLabel = favoriteMeta(favPath)?.label || "this page";
  const favOn = isFavorite(favPath);

  const navReturn = readNavReturn(location.state);
  const returnPath = navReturn?.returnTo?.split("?")[0] || "";
  // Hide bar when already on the return destination (e.g. back on Notifications)
  const showReturnBar = Boolean(navReturn?.returnTo) && returnPath !== location.pathname;

  // Clear return marker once user is back on that page
  useEffect(() => {
    if (returnPath && returnPath === location.pathname) {
      clearNavReturn();
    }
  }, [location.pathname, returnPath]);
  const [unread, setUnread] = useState(0);
  /** Parts waiting at vendors — warehouse glance counter (shows 0 when clear) */
  const [vendorWaiting, setVendorWaiting] = useState(0);
  /** Parts left at shop after field pickup — ready for warehouse */
  const [dropoffWaiting, setDropoffWaiting] = useState(0);
  /** Fuel receipts needing OCR verify (admin/office) */
  const [fuelOcrPending, setFuelOcrPending] = useState(0);
  /** Time-off approvals waiting for this manager / office */
  const [timeOffPending, setTimeOffPending] = useState(0);
  /** Tool loan approvals waiting for manager / office */
  const [toolLoanPending, setToolLoanPending] = useState(0);
  /** Open parts orders (needed / ordered / arriving) */
  const [partsOrderPending, setPartsOrderPending] = useState(0);
  /** Open field parts delivery runs */
  const [partsRunPending, setPartsRunPending] = useState(0);
  /** Install pickups waiting on Miller to assign or mark booked */
  const [installScheduleWaiting, setInstallScheduleWaiting] = useState(0);
  const [stockCheckLabel, setStockCheckLabel] = useState("");
  /** Open tech repair requests waiting for shop to schedule */
  const [openRepairsCount, setOpenRepairsCount] = useState(0);
  const [fleetShopReady, setFleetShopReady] = useState(false);
  /** Open collapsible nav section (same Command Center style for every role) */
  const [openCat, setOpenCat] = useState<string>(() => pathCategory(location.pathname));
  const sidebarClass = open ? "sidebar open" : "sidebar";
  // White/light logo artwork on dark navy sidebar
  const logoSrc = "/logo-light.png";
  const isDriver = user?.role === "driver";
  const isOffice = user?.role === "office";
  const isWarehouse = user?.role === "warehouse";
  const isMechanic = user?.role === "mechanic";
  const isTrueAdmin = realUser?.role === "admin";
  const adminShell = usesAdminShell(user) && !viewAsRole;
  const readOnly = isViewer(user);
  // Warehouse + fleet manager (mechanic) need the waiting pickup badge like Speedy
  const showVendorCounter =
    isWarehouse ||
    isOffice ||
    isMechanic ||
    adminShell ||
    user?.role === "admin" ||
    user?.role === "viewer" ||
    user?.role === "supervisor";
  const showRepairBadge =
    isMechanic || isOffice || adminShell || user?.role === "admin" || user?.role === "viewer";
  const showFuelOcrBadge = can(user, "editFuel") || adminShell;
  const isMillerNav =
    adminShell ||
    user?.role === "admin" ||
    `${user?.display_name || ""} ${user?.username || ""}`.toLowerCase().includes("miller");

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const d = await api<{ unread: number }>("/notifications");
        if (!cancelled) setUnread(d.unread || 0);
      } catch {
        /* ignore */
      }
      if (showVendorCounter) {
        try {
          // Lightweight COUNT only — full list was timing out D1 on large catalogs
          const vr = await api<{ waiting?: number }>("/inventory/part-pickups/count").catch(
            () => api<{ waiting?: number }>("/inventory/vendor-runs/count")
          );
          if (!cancelled) setVendorWaiting(Number(vr.waiting) || 0);
        } catch {
          /* migration optional */
        }
        try {
          const dr = await api<{ waiting?: number }>("/inventory/parts-dropoffs/count");
          if (!cancelled) setDropoffWaiting(Number(dr.waiting) || 0);
        } catch {
          /* migration optional */
        }
      }
      try {
        const [sc, pf] = await Promise.all([
          api<{ allowed?: boolean; label?: string }>("/inventory/stock-check/access").catch(() => ({
            allowed: false,
            label: "",
          })),
          api<{ allowed?: boolean; label?: string }>("/part-finder/access").catch(() => ({
            allowed: false,
            label: "",
          })),
        ]);
        if (!cancelled) {
          if (sc.allowed) setStockCheckLabel(sc.label || "Part in stock");
          else if (pf.allowed) setStockCheckLabel(pf.label || "Repair part (serial)");
          else setStockCheckLabel("");
        }
      } catch {
        if (!cancelled) setStockCheckLabel("");
      }
      if (isMillerNav) {
        try {
          const sq = await api<{ waiting?: number }>("/inventory/part-pickups/schedule-queue");
          if (!cancelled) setInstallScheduleWaiting(Number(sq.waiting) || 0);
        } catch {
          /* optional */
        }
      }
      if (showRepairBadge) {
        try {
          const ir = await api<{ issues?: unknown[]; needs_schedule?: number }>(
            "/issues?report=needs_schedule"
          );
          if (!cancelled) {
            setOpenRepairsCount(
              typeof ir.needs_schedule === "number"
                ? ir.needs_schedule
                : (ir.issues || []).length
            );
          }
        } catch {
          /* optional */
        }
      }
      if (showFuelOcrBadge) {
        try {
          const fo = await api<{ pending?: number }>("/fuel/receipt-review/count");
          if (!cancelled) setFuelOcrPending(Number(fo.pending) || 0);
        } catch {
          /* optional */
        }
      }
      try {
        const to = await api<{ pending?: number }>("/time-off/pending-count");
        if (!cancelled) setTimeOffPending(Number(to.pending) || 0);
      } catch {
        /* optional */
      }
      try {
        const tl = await api<{ pending?: number }>("/tool-loans/pending-count");
        if (!cancelled) setToolLoanPending(Number(tl.pending) || 0);
      } catch {
        /* optional */
      }
      if (isMechanic || isOffice || isWarehouse || adminShell || user?.role === "admin") {
        try {
          const po = await api<{ pending?: number }>("/parts-orders/pending-count");
          if (!cancelled) setPartsOrderPending(Number(po.pending) || 0);
        } catch {
          /* optional */
        }
      }
      if (isMechanic || isOffice || isWarehouse || adminShell || user?.role === "admin") {
        try {
          const pr = await api<{ pending?: number }>("/parts-runs/pending-count");
          if (!cancelled) setPartsRunPending(Number(pr.pending) || 0);
        } catch {
          /* optional */
        }
      }
    }
    // Defer badge poll so first paint is not blocked (longer delay on cellular)
    const start = window.setTimeout(() => void poll(), 1200);
    const id = window.setInterval(poll, 45_000);
    const onVendorChange = () => void poll();
    window.addEventListener("vendor-runs-changed", onVendorChange);
    window.addEventListener("parts-dropoffs-changed", onVendorChange);
    return () => {
      cancelled = true;
      window.clearTimeout(start);
      window.clearInterval(id);
      window.removeEventListener("vendor-runs-changed", onVendorChange);
      window.removeEventListener("parts-dropoffs-changed", onVendorChange);
    };
  }, [
    user?.id,
    user?.role,
    showVendorCounter,
    showRepairBadge,
    showFuelOcrBadge,
    isMechanic,
    isOffice,
    isWarehouse,
    adminShell,
    isMillerNav,
  ]);

  useEffect(() => {
    document.title = "Total Assurance";
  }, []);

  useEffect(() => {
    if (!can(user, "viewFleetShop") && !can(user, "reportTruckProblem")) return;
    api<{ ready?: boolean }>("/fleet-shop/config")
      .then((d) => setFleetShopReady(Boolean(d.ready)))
      .catch(() => setFleetShopReady(false));
  }, [user?.id, user?.role]);

  // Keep the category matching the page open while browsing (all roles)
  useEffect(() => {
    setOpenCat(pathCategory(location.pathname));
  }, [location.pathname]);

  // Close mobile menu after navigating to a page
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  // When the phone menu is open, lock page scroll so only the drawer list scrolls
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const html = document.documentElement;
    const body = document.body;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyWidth: body.style.width,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
    };
    html.classList.add("nav-open");
    body.classList.add("nav-open");
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    // position:fixed stops background scroll on iOS/Android without killing drawer touch
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";

    // Ensure the scroll pane can receive touch (some WebViews need this)
    const scroller = document.getElementById("app-nav-scroll");
    if (scroller) {
      scroller.style.overflowY = "scroll";
      scroller.style.setProperty("-webkit-overflow-scrolling", "touch");
    }

    return () => {
      html.classList.remove("nav-open");
      body.classList.remove("nav-open");
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      body.style.position = prev.bodyPosition;
      body.style.top = prev.bodyTop;
      body.style.width = prev.bodyWidth;
      body.style.left = prev.bodyLeft;
      body.style.right = prev.bodyRight;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  const vendorNavBadge = {
    badge: vendorWaiting,
    badgeAlways: true as const,
    badgeLabel:
      vendorWaiting > 0
        ? `${vendorWaiting} part${vendorWaiting === 1 ? "" : "s"} to pick up`
        : "No parts waiting for pickup",
  };

  const dropoffNavBadge = {
    badge: dropoffWaiting,
    badgeAlways: true as const,
    badgeLabel:
      dropoffWaiting > 0
        ? `${dropoffWaiting} drop-off${dropoffWaiting === 1 ? "" : "s"} at the shop`
        : "No parts waiting at the shop",
  };

  /**
   * Same Command Center categories for every role — only permitted links show.
   * Empty categories are hidden automatically by NavCategory.
   */
  /** Home stays thin — Day board / clock / ops live in named sections below. */
  const homeNav: NavItem[] = [
    {
      to: "/",
      label: "Home",
      show: true,
    },
  ];

  // Chris UX walk: techs never see owner/office tools
  const isFieldTech = isDriver && !adminShell && !isOffice && !isWarehouse && !isMechanic;

  const dispatchNav: NavItem[] = [
    {
      to: "/day-board",
      label: "Today's jobs",
      show: can(user, "viewDayBoard"),
    },
    {
      to: "/ops/job-lengths",
      label: "Job lengths",
      show: can(user, "viewJobLengths"),
    },
    {
      to: "/install-book",
      label: "Book install",
      show:
        !isFieldTech &&
        (can(user, "viewOpsPerformance") ||
          user?.role === "admin" ||
          user?.role === "office" ||
          user?.role === "supervisor"),
    },
  ];

  const myWorkNav: NavItem[] = [
    {
      to: "/clock",
      label: "Clock in / out",
      show: can(user, "useJobClock"),
    },
    { to: "/tools-checklist", label: "My tools", show: true },
  ];

  const performanceNav: NavItem[] = [
    {
      to: "/ops-performance",
      label: isFieldTech ? "My numbers" : "Shop scoreboard",
      show: can(user, "viewOpsPerformance"),
    },
    { to: "/nate", label: "NATE study", show: true },
  ];

  // Fleet & shop (merged): units, map, fuel, checks, repairs
  const fleetShopNav: NavItem[] = [
    {
      to: "/vehicles",
      label: "Fleet units",
      section: "Trucks",
      show: adminShell || isWarehouse || isMechanic,
    },
    {
      to: "/live",
      label: "Fleet map",
      section: "Trucks",
      show: can(user, "viewLiveMap"),
    },
    {
      to: "/yard",
      label: "Fleet compliance",
      section: "Trucks",
      show: adminShell || isMechanic,
    },
    {
      to: "/fuel",
      label: "Log fuel",
      section: "Fuel",
      show: adminShell || can(user, "logFuel") || can(user, "viewReports"),
    },
    {
      to: "/fuel/receipt-review",
      label: "Verify fuel",
      section: "Fuel",
      // Owner + Office only (Chris walk)
      show: !isFieldTech && !isMechanic && (adminShell || isOffice || can(user, "editFuel")),
      ...(showFuelOcrBadge && fuelOcrPending > 0
        ? {
            badge: fuelOcrPending,
            badgeAlways: false as const,
            badgeLabel: `${fuelOcrPending} fuel receipt${fuelOcrPending === 1 ? "" : "s"} need review`,
          }
        : {}),
    },
    {
      to: "/alerts",
      label: "Fuel problems",
      section: "Fuel",
      show: adminShell || isMechanic || (isOffice && can(user, "viewAlerts")),
    },
    {
      to: "/inspections",
      label: "Weekly check",
      section: "Checks",
      show: adminShell || isDriver || isMechanic || isOffice,
    },
    {
      to: "/downtime",
      label: "Out of service",
      section: "Checks",
      show:
        adminShell ||
        isMechanic ||
        (isOffice && (can(user, "viewReports") || can(user, "manageIssues"))),
    },
    {
      to: "/fleet-shop",
      label: "Fleet Shop",
      section: "Shop",
      show: can(user, "viewFleetShop") && fleetShopReady,
    },
    {
      to: "/fleet-shop/report",
      label: "Truck problem",
      section: "Shop",
      show: can(user, "reportTruckProblem") && fleetShopReady,
    },
    {
      to: "/done-today",
      label: "Done today",
      section: "Shop",
      show: can(user, "viewDoneToday"),
    },
    {
      to: "/issues",
      label:
        can(user, "manageIssues") || adminShell
          ? "Repair board"
          : can(user, "reportIssues")
            ? "Report a problem"
            : "Repairs",
      section: "Shop",
      show:
        adminShell ||
        can(user, "reportIssues") ||
        can(user, "manageIssues") ||
        user?.role === "viewer",
      ...(openRepairsCount != null && can(user, "manageIssues")
        ? {
            badge: openRepairsCount,
            badgeAlways: false,
            badgeLabel:
              openRepairsCount > 0
                ? `${openRepairsCount} need scheduling`
                : "No open repair requests",
          }
        : {}),
    },
    {
      to: "/service",
      label: "Oil changes",
      section: "Shop",
      show: adminShell || isMechanic,
    },
    {
      to: "/parts-orders",
      label: "Order for shop",
      section: "Shop",
      show:
        adminShell ||
        isMechanic ||
        isOffice ||
        isWarehouse ||
        user?.role === "admin" ||
        user?.role === "driver" ||
        user?.role === "viewer",
      ...(partsOrderPending > 0
        ? {
            badge: partsOrderPending,
            badgeAlways: false as const,
            badgeLabel: `${partsOrderPending} open shop order${partsOrderPending === 1 ? "" : "s"}`,
          }
        : {}),
    },
  ];

  const partsNav: NavItem[] = [
    {
      to: "/tomorrow-materials",
      label: "Pull for tomorrow",
      section: "For a job",
      show:
        adminShell ||
        isWarehouse ||
        isOffice ||
        user?.role === "supervisor",
    },
    {
      to: "/part-pickup",
      label: "Will-call",
      section: "For a job",
      show: true,
      ...(isMillerNav && installScheduleWaiting > 0
        ? {
            badge: installScheduleWaiting,
            badgeAlways: false as const,
            badgeLabel: `${installScheduleWaiting} install${installScheduleWaiting === 1 ? "" : "s"} to schedule`,
          }
        : showVendorCounter
          ? vendorNavBadge
          : {}),
    },
    {
      to: "/parts-dropoff",
      label: "Shop counter",
      section: "For a job",
      show: true,
      ...(showVendorCounter ? dropoffNavBadge : {}),
    },
    {
      to: "/deliveries",
      label: "Parts received",
      section: "For a job",
      show: can(user, "viewDeliveries"),
    },
    {
      to: "/parts-runs",
      label: "Deliver to job",
      section: "For a job",
      show: true,
      ...(partsRunPending > 0
        ? {
            badge: partsRunPending,
            badgeAlways: false as const,
            badgeLabel: `${partsRunPending} warehouse delivery request${partsRunPending === 1 ? "" : "s"} open`,
          }
        : {}),
    },
    {
      to: "/inventory",
      label: "Stock room",
      section: "Stock",
      show: adminShell || can(user, "viewInventory") || isWarehouse,
    },
    {
      to: "/inventory/stock-moves",
      label: "Stock moves",
      section: "Stock",
      show: adminShell || can(user, "viewInventory") || isWarehouse,
    },
    {
      to: "/live-inventory",
      label: "Live inventory",
      section: "Stock",
      show: user?.role === "admin" || isWarehouse,
    },
    {
      to: "/part-in-stock",
      label: stockCheckLabel || "Part in stock",
      section: "Stock",
      show: Boolean(stockCheckLabel),
    },
    {
      to: "/truck-stock",
      label: "Truck stock count",
      section: "Stock",
      show: true,
    },
    {
      to: "/parts-receipts",
      label: "Purchase receipts",
      section: "Paper",
      show: can(user, "logPartsPurchase") || can(user, "viewPartsPurchase"),
    },
    {
      to: "/warranties",
      label: "Warranties",
      section: "Paper",
      show: true,
    },
    {
      to: "/invoice-lookup",
      label: "Invoice lookup",
      section: "Paper",
      show:
        adminShell ||
        user?.role === "office" ||
        user?.role === "supervisor",
    },
    {
      to: "/assets",
      label: isDriver ? "My truck gear" : "Company assets",
      section: "Gear",
      show: can(user, "viewCompanyAssets"),
    },
    {
      to: "/dump-runs",
      label: "Dump runs",
      section: "Gear",
      show: can(user, "viewDumpRuns") || can(user, "logDumpRuns") || isWarehouse,
    },
  ];

  const helpNav: NavItem[] = [
    { to: "/safety", label: "Safety", show: true },
    { to: "/howto", label: "How-to guides", show: true },
    { to: "/handbook", label: "Employee handbook", show: true },
    { to: "/feedback", label: "App feedback", show: true },
  ];

  // Company: people, exports, cameras, requests. Help is its own group.
  const companyNav: NavItem[] = [
    {
      to: "/admin",
      label: "Employees",
      show:
        !isFieldTech &&
        (adminShell || can(user, "manageUsers") || can(user, "manageEmployees")),
    },
    {
      to: "/onboarding",
      label: "Company forms",
      show:
        user?.role === "admin" || user?.role === "office" || user?.role === "supervisor",
    },
    {
      to: "/hr/writeups",
      label: "Write-ups",
      show: can(user, "manageWriteups"),
    },
    {
      to: "/reports",
      label: "Fuel & fleet exports",
      show: !isFieldTech && (adminShell || isMechanic || (isOffice && can(user, "viewReports"))),
    },
    {
      to: "/warehouse-cameras",
      label: "Shop cameras",
      show: adminShell || isOffice || isWarehouse || user?.role === "supervisor",
    },
    {
      to: "/time-off",
      label: "Time off",
      show: true,
      ...(timeOffPending > 0
        ? {
            badge: timeOffPending,
            badgeAlways: false as const,
            badgeLabel: `${timeOffPending} time-off request${timeOffPending === 1 ? "" : "s"} to review`,
          }
        : {}),
    },
    {
      to: "/tool-loans",
      label: "Tool loan",
      show: true,
      ...(toolLoanPending > 0
        ? {
            badge: toolLoanPending,
            badgeAlways: false as const,
            badgeLabel: `${toolLoanPending} tool loan request${toolLoanPending === 1 ? "" : "s"} to review`,
          }
        : {}),
    },
    {
      to: "/tool-loan-ledger",
      label: "Tool loan payroll",
      show:
        !isFieldTech &&
        (user?.role === "admin" || user?.role === "office" || user?.role === "supervisor"),
    },
    {
      to: "/notifications",
      label: "Inbox",
      show: true,
      badge: unread,
    },
    {
      to: "/tv",
      label: "TV board",
      show: !isFieldTech && (adminShell || isOffice || isMechanic),
    },
    {
      to: "/roles",
      label: "Preview roles",
      show: isTrueAdmin && !viewAsRole,
    },
    {
      to: "/audit",
      label: "Change history",
      show: !isFieldTech && can(user, "viewAudit"),
    },
    {
      to: "/review-texts",
      label: "Review texts",
      show: isTrueAdmin && !viewAsRole,
    },
  ];

  function toggleCat(id: string) {
    setOpenCat((prev) => (prev === id ? "" : id));
  }

  if (isTvBoard) {
    return <div className="tv-shell">{children}</div>;
  }

  return (
    <div className="app-shell">
      {open && (
        <button
          type="button"
          className="nav-backdrop no-print"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={sidebarClass} id="app-nav-drawer">
        <div className="drawer-head">
          <div className="drawer-brand">
            <img src={logoSrc} alt="Total Assurance A/C & Heating" className="drawer-logo-img" />
          </div>
          <button
            type="button"
            className="drawer-close no-print"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          >
            ✕
          </button>
        </div>
        {/* Dedicated scroll pane — whole menu list + account row (Android-safe) */}
        <div className="drawer-scroll" id="app-nav-scroll">
          <nav className="nav">
            <NavGroup title="Home" items={homeNav} />
            <NavCategory
              id="dispatch"
              title="Dispatch"
              hint="Today's jobs · live ServiceTitan"
              items={dispatchNav}
              open={openCat === "dispatch"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="mywork"
              title="My work"
              hint="Clock · your tools"
              items={myWorkNav}
              open={openCat === "mywork"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="performance"
              title="Performance"
              hint={isFieldTech ? "Your jobs · NATE" : "This week · NATE"}
              items={performanceNav}
              open={openCat === "performance"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="fleet"
              title="Fleet & shop"
              hint="Units · map · fuel · repairs"
              items={fleetShopNav}
              open={openCat === "fleet"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="warehouse"
              title="Parts"
              hint="For a job · stock · paper"
              items={partsNav}
              open={openCat === "warehouse"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="help"
              title="Help"
              hint="Safety · guides"
              items={helpNav}
              open={openCat === "help"}
              onToggle={toggleCat}
            />
            <NavCategory
              id="company"
              title="Company"
              hint="Employees · time off · cameras · exports"
              items={companyNav}
              open={openCat === "company"}
              onToggle={toggleCat}
            />
          </nav>
          <NavLink
            to="/settings"
            className={({ isActive }) => `user-box user-box-link${isActive ? " active" : ""}`}
            onClick={() => setOpen(false)}
            title="Open settings"
          >
            <div className="role">{roleLabel(user?.role)}</div>
            <div className="user-box-name">{user?.display_name}</div>
            <div className="user-box-hint">
              {isOffice || isWarehouse ? "Settings · sign out" : "Tap for settings · sign out"}
            </div>
          </NavLink>
        </div>
      </aside>
      <div className="content-column">
        <OfflineBanner />
      <RecognitionToast />
        {readOnly && (
          <div className="viewer-readonly-bar no-print" role="status">
            <strong>Viewer · look around only</strong>
            <span>Same layout as Admin — you can’t change or submit data</span>
          </div>
        )}
        {isTrueAdmin && (
          <div
            className={`view-as-bar no-print${viewAsRole ? " is-preview" : ""}`}
            title={
              viewAsRole
                ? `Previewing ${roleLabel(viewAsRole)} UI — API still uses Admin`
                : "Preview another role’s screens"
            }
          >
            <span className="view-as-prefix">View as</span>
            <select
              className="view-as-select"
              value={viewAsRole || "admin"}
              aria-label="View as role"
              onChange={(e) => {
                const v = e.target.value as Role | "admin";
                setViewAsRole(v === "admin" ? null : (v as Role));
              }}
            >
              <option value="admin">Admin</option>
              <option value="supervisor">Supervisor</option>
              <option value="warehouse">Warehouse</option>
              <option value="office">{roleLabel("office")}</option>
              <option value="driver">Field</option>
              <option value="mechanic">Mechanic</option>
              <option value="viewer">Viewer</option>
            </select>
            {viewAsRole ? (
              <button type="button" className="view-as-exit" onClick={() => setViewAsRole(null)}>
                Exit
              </button>
            ) : null}
          </div>
        )}
        {/* Dark header: logo only (+ menu) */}
        <div className="topbar-mobile no-print">
          <div className="topbar-row topbar-row-brand">
            <div className="topbar-side topbar-side-left">
              <button
                type="button"
                className={`topbar-hamburger${open ? " is-open" : ""}`}
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                aria-controls="app-nav-drawer"
                aria-label={open ? "Close menu" : "Open menu"}
              >
                <span className="topbar-hamburger-lines" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </button>
            </div>
            <div className="topbar-logo-center">
              <img
                src={logoSrc}
                alt="Total Assurance A/C & Heating"
                className="topbar-logo-img"
              />
            </div>
            <div className="topbar-side topbar-side-right" aria-hidden="true" />
          </div>
        </div>
        <div className="content-body">
          {/* Same page color as main — right side, opposite Command Center */}
          <div className="content-tools no-print">
            <div className="topbar-actions content-tools-actions">
              <GlobalQuickSearch />
              {showVendorCounter && !location.pathname.startsWith("/part-pickup") && (
                <NavLink
                  to="/part-pickup"
                  className={`topbar-vendor-chip${vendorWaiting > 0 ? " is-hot" : " is-clear"}`}
                  title={
                    vendorWaiting > 0
                      ? `${vendorWaiting} part pickup request${vendorWaiting === 1 ? "" : "s"} open`
                      : "No open part pickup requests"
                  }
                  aria-label={
                    vendorWaiting > 0
                      ? `${vendorWaiting} part pickup requests`
                      : "No part pickup requests"
                  }
                >
                  <span className="topbar-vendor-chip-label">Pickup</span>
                  <span className="topbar-vendor-chip-n">
                    {vendorWaiting > 99 ? "99+" : vendorWaiting}
                  </span>
                </NavLink>
              )}
              {favAllowed ? (
                <button
                  type="button"
                  className={`topbar-fav-btn${favOn ? " is-on" : ""}`}
                  disabled={favBusy}
                  title={favOn ? `Unstar ${favLabel}` : `Star ${favLabel} — shows on Home`}
                  aria-label={favOn ? `Unstar ${favLabel}` : `Star ${favLabel}`}
                  aria-pressed={favOn}
                  onClick={() => void toggleFavorite(favPath)}
                >
                  {favOn ? "★" : "☆"}
                </button>
              ) : null}
              <NotificationBell />
            </div>
          </div>
          {/* Always-visible when you opened a page from Notifications (or similar) */}
          {showReturnBar && navReturn ? (
            <div className="return-bar no-print" role="navigation" aria-label="Go back">
              <button
                type="button"
                className="return-bar-btn"
                onClick={() => {
                  const dest = navReturn.returnTo;
                  clearNavReturn();
                  navigate(dest);
                }}
              >
                ← {returnBarLabel(navReturn)}
              </button>
            </div>
          ) : null}
          <main className="main">{children}</main>
        </div>
      </div>
    </div>
  );
}
