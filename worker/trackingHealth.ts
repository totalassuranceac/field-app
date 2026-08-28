/**
 * Fleet tracking & equipment health — flags units that look off vs paid GPS / dashcam policy.
 *
 * Policy:
 * - Active units with a GPS system (OneStep / Verizon) are expected to report live.
 * - Stale or offline trackers stand out (you’re paying for the service).
 * - Every tracked unit should have a working dash cam.
 * - Verizon GPS → Verizon dash cam; OneStep GPS → third-party cam (no monthly fee).
 */

import type { LivePosition, LivePositionsResult } from "./gps";

export type TrackingIssueCode =
  | "not_reporting"
  | "stale"
  | "offline"
  | "gps_broken"
  | "dashcam_broken"
  | "tracked_no_dashcam"
  | "cam_mismatch_verizon"
  | "cam_mismatch_onestep"
  | "unmatched_device";

export type TrackingSeverity = "bad" | "warn";

export interface TrackingIssue {
  code: TrackingIssueCode;
  severity: TrackingSeverity;
  message: string;
  vehicle_id: number | null;
  unit_number: string | null;
  provider?: string | null;
  detail?: string | null;
}

export interface VehicleTrackRow {
  id: number;
  unit_number: string;
  status: string;
  gps_tracker: string | null;
  gps_status: string | null;
  dash_cam_status: string;
  cam_type: string | null;
  assigned_driver?: string | null;
}

export interface CoverageRow {
  vehicle_id: number;
  unit_number: string;
  assigned_driver: string | null;
  status: string;
  gps_tracker: string | null;
  /** on_map | missing | no_gps_assigned */
  coverage: "on_map" | "missing" | "no_gps_assigned";
  reason: string;
  provider?: string | null;
}

export interface TrackingHealthSummary {
  stale_hours: number;
  counts: {
    not_reporting: number;
    stale_or_offline: number;
    dashcam_policy: number;
    equipment_manual: number;
    unmatched_devices: number;
    total: number;
    /** Fleet units (non-retired) with no live pin */
    missing_from_map: number;
    on_map: number;
    no_gps_assigned: number;
  };
  issues: TrackingIssue[];
  /** Active units with a GPS system that should appear live */
  expected_trackers: number;
  live_matched: number;
  /**
   * Per-vehicle coverage vs live map (non-retired fleet).
   * Use this to see which app vehicles are missing from Live map.
   */
  coverage: CoverageRow[];
}

export function normalizeGpsProvider(
  tracker: string | null | undefined
): "onestep" | "verizon" | null {
  const t = (tracker || "").toLowerCase();
  if (!t.trim()) return null;
  if (/verizon|reveal|vzw/.test(t)) return "verizon";
  if (/one\s*step|onestep|1step/.test(t)) return "onestep";
  return null;
}

export function normalizeCamKind(
  camType: string | null | undefined
): "verizon" | "third_party" | null {
  const t = (camType || "").toLowerCase().trim();
  if (!t) return null;
  if (/verizon|reveal|vzw/.test(t)) return "verizon";
  // Installed third-party / no monthly fee (Dash Cam, aftermarket brands, etc.)
  return "third_party";
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / (1000 * 60 * 60);
}

function expectsTracking(v: VehicleTrackRow): boolean {
  if (v.status === "retired") return false;
  // Paying for a service if a system is assigned, or status says working
  if (normalizeGpsProvider(v.gps_tracker)) return true;
  if (v.gps_status === "working") return true;
  return false;
}

/**
 * Compare registry + live feed and return issues that should stand out for admin/mechanic.
 */
export function computeTrackingHealth(
  vehicles: VehicleTrackRow[],
  live: LivePositionsResult | null,
  staleHours = 6
): TrackingHealthSummary {
  const issues: TrackingIssue[] = [];
  const positions = live?.positions || [];
  const byVehicle = new Map<number, LivePosition[]>();
  for (const p of positions) {
    if (p.vehicle_id == null) continue;
    const arr = byVehicle.get(p.vehicle_id) || [];
    arr.push(p);
    byVehicle.set(p.vehicle_id, arr);
  }

  let expected = 0;
  let liveMatched = 0;
  const coverage: CoverageRow[] = [];

  for (const v of vehicles) {
    if (v.status === "retired") continue;

    const provider = normalizeGpsProvider(v.gps_tracker);
    const tracked = expectsTracking(v);
    const liveHits = byVehicle.get(v.id) || [];
    const best = liveHits[0] || null;
    const driver = (v.assigned_driver || "").trim() || null;

    // Per-unit coverage for Live map “who’s missing”
    if (best) {
      coverage.push({
        vehicle_id: v.id,
        unit_number: v.unit_number,
        assigned_driver: driver,
        status: v.status,
        gps_tracker: v.gps_tracker,
        coverage: "on_map",
        reason: `Live on ${providerLabel(best.provider)}`,
        provider: best.provider,
      });
    } else if (tracked) {
      coverage.push({
        vehicle_id: v.id,
        unit_number: v.unit_number,
        assigned_driver: driver,
        status: v.status,
        gps_tracker: v.gps_tracker,
        coverage: "missing",
        reason: v.gps_tracker
          ? `Has ${v.gps_tracker} but no live pin (name mismatch, offline, or no GPS fix)`
          : "Expected on map but no live pin",
        provider,
      });
    } else {
      coverage.push({
        vehicle_id: v.id,
        unit_number: v.unit_number,
        assigned_driver: driver,
        status: v.status,
        gps_tracker: v.gps_tracker,
        coverage: "no_gps_assigned",
        reason: "No GPS system set on vehicle (or GPS not expected) — will not show until OneStep/Verizon is assigned and reporting",
        provider: null,
      });
    }

    // Manual equipment flags (always useful)
    if (v.gps_status === "not_working" || v.gps_status === "missing") {
      issues.push({
        code: "gps_broken",
        severity: "bad",
        message: `Unit ${v.unit_number}: GPS marked ${v.gps_status.replace("_", " ")}`,
        vehicle_id: v.id,
        unit_number: v.unit_number,
        provider,
        detail: v.gps_tracker,
      });
    }
    if (v.dash_cam_status === "not_working" || v.dash_cam_status === "missing") {
      issues.push({
        code: "dashcam_broken",
        severity: "bad",
        message: `Unit ${v.unit_number}: dash cam ${v.dash_cam_status.replace("_", " ")}`,
        vehicle_id: v.id,
        unit_number: v.unit_number,
        provider,
        detail: v.cam_type,
      });
    }

    if (!tracked) continue;
    expected++;

    // Live presence / staleness
    if (!best) {
      // Only flag not_reporting when a provider is actually configured for that brand
      const providerOk =
        provider === "onestep"
          ? live?.providers?.onestep?.configured !== false
          : provider === "verizon"
            ? live?.providers?.verizon?.configured !== false
            : true;
      if (providerOk && live) {
        issues.push({
          code: "not_reporting",
          severity: "bad",
          message: `Unit ${v.unit_number}: on ${v.gps_tracker || "GPS"} but not on the live map — check the tracker (you may be paying for nothing)`,
          vehicle_id: v.id,
          unit_number: v.unit_number,
          provider,
          detail: v.gps_tracker,
        });
      }
    } else {
      liveMatched++;
      const ageH = hoursSince(best.last_update);
      if (best.online === false) {
        issues.push({
          code: "offline",
          severity: "bad",
          message: `Unit ${v.unit_number}: tracker offline on ${providerLabel(best.provider)}`,
          vehicle_id: v.id,
          unit_number: v.unit_number,
          provider: best.provider,
          detail: best.last_update,
        });
      } else if (ageH != null && ageH > staleHours) {
        issues.push({
          code: "stale",
          severity: ageH > staleHours * 2 ? "bad" : "warn",
          message: `Unit ${v.unit_number}: last GPS update ${Math.round(ageH)}h ago (stale — stopped tracking?)`,
          vehicle_id: v.id,
          unit_number: v.unit_number,
          provider: best.provider,
          detail: best.last_update,
        });
      }
    }

    // Cam type pairing only when cam is in use (not N/A) — N/A is intentionally ignored
    if (v.dash_cam_status === "working" || v.dash_cam_status === "not_working" || v.dash_cam_status === "missing") {
      const camKind = normalizeCamKind(v.cam_type);
      if (provider === "verizon" && camKind && camKind !== "verizon") {
        issues.push({
          code: "cam_mismatch_verizon",
          severity: "warn",
          message: `Unit ${v.unit_number}: Verizon GPS should use a Verizon dash cam (cam type is “${v.cam_type}”)`,
          vehicle_id: v.id,
          unit_number: v.unit_number,
          provider: "verizon",
          detail: v.cam_type,
        });
      }
      if (provider === "onestep" && camKind === "verizon") {
        issues.push({
          code: "cam_mismatch_onestep",
          severity: "bad",
          message: `Unit ${v.unit_number}: OneStep GPS should use the third-party dash cam (no monthly fee) — not Verizon cam`,
          vehicle_id: v.id,
          unit_number: v.unit_number,
          provider: "onestep",
          detail: v.cam_type,
        });
      }
    }
  }

  coverage.sort((a, b) => {
    const rank = { missing: 0, no_gps_assigned: 1, on_map: 2 };
    return (
      rank[a.coverage] - rank[b.coverage] ||
      a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true })
    );
  });

  // Devices on the feed not linked to a fleet unit
  for (const p of positions) {
    if (p.vehicle_id != null) continue;
    issues.push({
      code: "unmatched_device",
      severity: "warn",
      message: `Live device “${p.name}” on ${providerLabel(p.provider)} is not matched to a fleet unit — check unit # / GPS system on the vehicle record`,
      vehicle_id: null,
      unit_number: null,
      provider: p.provider,
      detail: p.name,
    });
  }

  // Sort: bad first, then by unit
  const sevRank = { bad: 0, warn: 1 };
  issues.sort(
    (a, b) =>
      sevRank[a.severity] - sevRank[b.severity] ||
      String(a.unit_number || a.detail || "").localeCompare(String(b.unit_number || b.detail || ""), undefined, {
        numeric: true,
      })
  );

  const counts = {
    not_reporting: issues.filter((i) => i.code === "not_reporting").length,
    stale_or_offline: issues.filter((i) => i.code === "stale" || i.code === "offline").length,
    dashcam_policy: issues.filter((i) =>
      ["tracked_no_dashcam", "cam_mismatch_verizon", "cam_mismatch_onestep"].includes(i.code)
    ).length,
    equipment_manual: issues.filter((i) => i.code === "gps_broken" || i.code === "dashcam_broken")
      .length,
    unmatched_devices: issues.filter((i) => i.code === "unmatched_device").length,
    total: issues.length,
    missing_from_map: coverage.filter((c) => c.coverage === "missing").length,
    on_map: coverage.filter((c) => c.coverage === "on_map").length,
    no_gps_assigned: coverage.filter((c) => c.coverage === "no_gps_assigned").length,
  };

  return {
    stale_hours: staleHours,
    counts,
    issues,
    expected_trackers: expected,
    live_matched: liveMatched,
    coverage,
  };
}

function providerLabel(p: string | null | undefined): string {
  if (p === "onestep") return "OneStep";
  if (p === "verizon") return "Verizon";
  return p || "GPS";
}
