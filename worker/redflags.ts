import { getSetting } from "./audit";
import type { FuelEntryRow } from "./types";

export interface AlertDraft {
  alert_type: "decrease" | "large_jump" | "no_baseline" | "duplicate_day";
  message: string;
  severity: "info" | "warning" | "critical";
}

export async function evaluateMileageAlerts(
  db: D1Database,
  entry: Pick<FuelEntryRow, "id" | "vehicle_id" | "employee_id" | "odometer" | "fuel_date">
): Promise<AlertDraft[]> {
  const alerts: AlertDraft[] = [];
  // Defaults tuned for Corpus Christi / Coastal Bend local fleet (not long-haul).
  // Wide jumps often mean wrong vehicle or odometer abuse — keep thresholds tight.
  const largeJump = Number(await getSetting(db, "large_jump_miles", "250"));
  const largePerDay = Number(await getSetting(db, "large_jump_miles_per_day", "180"));

  const prev = await db
    .prepare(
      `SELECT * FROM fuel_entries
       WHERE vehicle_id = ? AND id != ?
       ORDER BY fuel_date DESC, id DESC LIMIT 1`
    )
    .bind(entry.vehicle_id, entry.id)
    .first<FuelEntryRow>();

  if (!prev) {
    alerts.push({
      alert_type: "no_baseline",
      message: "First mileage reading for this vehicle - no prior baseline to compare.",
      severity: "info",
    });
  } else {
    if (entry.odometer < prev.odometer) {
      alerts.push({
        alert_type: "decrease",
        message: `Odometer ${entry.odometer} is lower than previous ${prev.odometer} (entry #${prev.id}).`,
        severity: "critical",
      });
    } else {
      const delta = entry.odometer - prev.odometer;
      const days = Math.max(
        1,
        Math.ceil(
          (new Date(entry.fuel_date).getTime() - new Date(prev.fuel_date).getTime()) / (1000 * 60 * 60 * 24)
        )
      );
      const perDay = delta / days;
      if (delta > largeJump || perDay > largePerDay) {
        alerts.push({
          alert_type: "large_jump",
          message: `Large mileage jump: +${delta.toFixed(0)} miles over ~${days} day(s) (~${perDay.toFixed(0)}/day). Possible wrong vehicle or odometer error — verify unit #.`,
          severity: delta > largeJump * 1.5 || perDay > largePerDay * 1.5 ? "critical" : "warning",
        });
      }
    }
  }

  const dup = await db
    .prepare(
      `SELECT id FROM fuel_entries
       WHERE vehicle_id = ? AND employee_id = ? AND fuel_date = ? AND id != ?
       LIMIT 1`
    )
    .bind(entry.vehicle_id, entry.employee_id, entry.fuel_date, entry.id)
    .first<{ id: number }>();

  if (dup) {
    alerts.push({
      alert_type: "duplicate_day",
      message: `Possible duplicate: same employee and vehicle already have a fuel entry on ${entry.fuel_date}.`,
      severity: "info",
    });
  }

  return alerts;
}

export async function insertAlerts(
  db: D1Database,
  fuelEntryId: number,
  vehicleId: number,
  alerts: AlertDraft[]
): Promise<void> {
  for (const a of alerts) {
    await db
      .prepare(
        `INSERT INTO mileage_alerts (fuel_entry_id, vehicle_id, alert_type, message, severity, status)
         VALUES (?, ?, ?, ?, ?, 'open')`
      )
      .bind(fuelEntryId, vehicleId, a.alert_type, a.message, a.severity)
      .run();
  }
}
