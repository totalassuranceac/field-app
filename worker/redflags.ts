import { getSetting } from "./audit";
import type { FuelEntryRow } from "./types";

export interface AlertDraft {
  alert_type: "decrease" | "large_jump" | "no_baseline" | "duplicate_day";
  message: string;
  severity: "info" | "warning" | "critical";
}

export type FuelAlertInput = Pick<
  FuelEntryRow,
  "id" | "vehicle_id" | "employee_id" | "odometer" | "fuel_date"
> & {
  gallons?: number | null;
  total_cost?: number | null;
  card_last4?: string | null;
  store_number?: string | null;
};

/**
 * Mileage / card-abuse checks for Corpus Christi local fleet.
 * Goal: catch wrong unit, rolled-back odometers, and fill-ups that don't match miles driven.
 */
export async function evaluateMileageAlerts(
  db: D1Database,
  entry: FuelAlertInput
): Promise<AlertDraft[]> {
  const alerts: AlertDraft[] = [];
  const largeJump = Number(await getSetting(db, "large_jump_miles", "250"));
  const largePerDay = Number(await getSetting(db, "large_jump_miles_per_day", "180"));
  // Local vans/trucks: under ~6 mpg with a full tank of diesel is suspicious; over ~25 rare for work vans
  const minMpg = Number(await getSetting(db, "min_mpg_flag", "6"));
  const maxMpg = Number(await getSetting(db, "max_mpg_flag", "28"));
  // Many gallons with almost no miles since last fill
  const maxGalLowMiles = Number(await getSetting(db, "max_gallons_low_miles", "12"));
  const lowMilesThreshold = Number(await getSetting(db, "low_miles_for_gallons", "15"));

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
      message: "First mileage reading for this vehicle — no prior baseline to compare.",
      severity: "info",
    });
  } else {
    if (entry.odometer < prev.odometer) {
      alerts.push({
        alert_type: "decrease",
        message: `Odometer went DOWN: ${entry.odometer.toLocaleString()} is lower than previous ${prev.odometer.toLocaleString()} (entry #${prev.id}). Possible wrong unit or abuse — verify.`,
        severity: "critical",
      });
    } else {
      const delta = entry.odometer - prev.odometer;
      const days = Math.max(
        1,
        Math.ceil(
          (new Date(entry.fuel_date).getTime() - new Date(prev.fuel_date).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      );
      const perDay = delta / days;

      if (delta > largeJump || perDay > largePerDay) {
        alerts.push({
          alert_type: "large_jump",
          message: `Large mileage jump: +${delta.toFixed(0)} mi over ~${days} day(s) (~${perDay.toFixed(0)}/day). Possible wrong vehicle or odometer error.`,
          severity: delta > largeJump * 1.5 || perDay > largePerDay * 1.5 ? "critical" : "warning",
        });
      }

      const gallons = entry.gallons ?? null;
      if (gallons != null && gallons > 0 && delta >= 0) {
        // Big fill, almost no miles since last stop — card used but vehicle barely moved
        if (gallons >= maxGalLowMiles && delta <= lowMilesThreshold && prev.id) {
          alerts.push({
            alert_type: "large_jump",
            message: `Card-use check: ${gallons.toFixed(1)} gal with only +${delta.toFixed(0)} mi since last fill (entry #${prev.id}). Miles may not match fuel — verify odometer & unit.`,
            severity: gallons >= 20 && delta <= 5 ? "critical" : "warning",
          });
        }

        // MPG sanity when there are enough miles to estimate
        if (delta >= 30) {
          const mpg = delta / gallons;
          if (mpg < minMpg) {
            alerts.push({
              alert_type: "large_jump",
              message: `Low MPG: ~${mpg.toFixed(1)} mi/gal (${delta.toFixed(0)} mi / ${gallons.toFixed(1)} gal since last fill). Possible wrong unit, odometer skip, or extra fuel on this card.`,
              severity: mpg < minMpg * 0.6 ? "critical" : "warning",
            });
          } else if (mpg > maxMpg) {
            alerts.push({
              alert_type: "large_jump",
              message: `Unusually high MPG: ~${mpg.toFixed(1)} mi/gal (${delta.toFixed(0)} mi / ${gallons.toFixed(1)} gal). Check odometer entry or that gallons match the receipt.`,
              severity: "warning",
            });
          }
        }
      }
    }
  }

  // Same vehicle + employee + day already fueled
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
      message: `Second fill same day for this driver & unit (also entry #${dup.id}). Confirm both are legitimate.`,
      severity: "warning",
    });
  }

  // Same card last-4 used on a different vehicle the same day (possible sharing / wrong unit)
  if (entry.card_last4 && /^\d{4}$/.test(entry.card_last4)) {
    const other = await db
      .prepare(
        `SELECT f.id, v.unit_number FROM fuel_entries f
         JOIN vehicles v ON v.id = f.vehicle_id
         WHERE f.card_last4 = ? AND f.fuel_date = ? AND f.vehicle_id != ? AND f.id != ?
         LIMIT 1`
      )
      .bind(entry.card_last4, entry.fuel_date, entry.vehicle_id, entry.id)
      .first<{ id: number; unit_number: string }>();

    if (other) {
      alerts.push({
        alert_type: "duplicate_day",
        message: `Card ••${entry.card_last4} also used today on unit ${other.unit_number} (entry #${other.id}). Confirm cards aren't being shared across units.`,
        severity: "warning",
      });
    }
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
