/** Pure rules for live inventory counts, parts used, and restock. No I/O. */

export const ADJUST_REASONS = ["used_not_marked", "damaged", "miscount", "other"] as const;

export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

export function adjustReasonError(reason: string, note: string): string | null {
  if (
    reason !== "used_not_marked" &&
    reason !== "damaged" &&
    reason !== "miscount" &&
    reason !== "other"
  ) {
    return "Pick a reason: used not marked, damaged, miscount, or other.";
  }
  if (reason === "other" && !String(note || "").trim()) return "Add a note for Other.";
  return null;
}

export function adjustReasonLabel(reason: string): string {
  if (reason === "used_not_marked") return "Used not marked";
  if (reason === "damaged") return "Damaged";
  if (reason === "miscount") return "Miscount";
  if (reason === "other") return "Other";
  return reason;
}

/** Non-negative quantity. Null when the value is not a number. */
export function parseQty(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000) / 1000;
}

/**
 * The tech who logged the part can change it for 24 hours.
 * Warehouse and admin can change it after that.
 */
export function canEditPartsUsed(
  createdAt: string,
  nowMs: number,
  warehouse: boolean
): boolean {
  if (warehouse) return true;
  const s = String(createdAt || "").trim();
  if (!s) return false;
  const ms = Date.parse(s.includes("T") ? s : `${s.replace(" ", "T")}Z`);
  if (!Number.isFinite(ms)) return false;
  return nowMs >= ms && nowMs - ms <= EDIT_WINDOW_MS;
}

/** A restock line is done when it is checked off, or the whole qty is short. */
export function lineSettled(pulled: number, qty: number, shortQty: number): boolean {
  if (Number(pulled) === 1) return true;
  return Number(shortQty) >= Number(qty) && Number(qty) > 0;
}

/** Qty that moves from the warehouse to the truck when the list is filled. */
export function transferQty(qty: number, shortQty: number): number {
  return Math.max(0, Number(qty) - Math.max(0, Number(shortQty)));
}

/** Hour in America/Chicago, 0-23. */
export function chicagoHour(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (!Number.isFinite(hour) || hour === 24) return 0;
  return hour;
}

/**
 * Nightly restock list. Cloudflare cron is UTC, so 5:00am Chicago is
 * 10:00 UTC during daylight time and 11:00 UTC during standard time.
 * Other crons, including the 8:00am shop pack, do not build the list.
 */
export function isRestockBuildCron(cron: string, now: Date): boolean {
  if (cron !== "0 10 * * *" && cron !== "0 11 * * *") return false;
  return chicagoHour(now) === 5;
}
