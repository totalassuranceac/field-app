/**
 * Warranty shop piles helpers — File / Hold / Return / Parked.
 * Solar Supply ≠ Johnstone closeout.
 */

export function normVendorName(s: string | null | undefined): string {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[.,'"_/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Solar Supply (and close aliases) — return pile; invoice-deleted closeout. */
export function isSolarSupplyVendor(name: string | null | undefined): boolean {
  const n = normVendorName(name);
  if (!n) return false;
  if (n === "solar" || n === "solar supply") return true;
  if (n.startsWith("solar supply")) return true;
  if (/\bsolar\s+supply\b/.test(n)) return true;
  return false;
}

/** Johnstone — return-to-counter only; no invoice-deleted button. */
export function isJohnstoneVendor(name: string | null | undefined): boolean {
  const n = normVendorName(name);
  if (!n) return false;
  return n === "johnstone" || n.startsWith("johnstone ") || /\bjohnstone\b/.test(n);
}

/** Drop-off should land on Return pile (not File). */
export function vendorDefaultsToReturn(name: string | null | undefined): boolean {
  return isSolarSupplyVendor(name) || isJohnstoneVendor(name);
}

/** File pile = dropped off, not parked. */
export async function countWarrantyFilePile(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM warranty_claims
         WHERE status = 'dropped_off' AND IFNULL(parked, 0) = 0`
      )
      .first<{ n: number }>();
    return Number(row?.n || 0);
  } catch (e) {
    // Migration 079 not applied yet — fall back to all dropped_off
    const msg = e instanceof Error ? e.message : String(e);
    if (/no such column.*parked/i.test(msg)) {
      try {
        const row = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM warranty_claims WHERE status = 'dropped_off'`
          )
          .first<{ n: number }>();
        return Number(row?.n || 0);
      } catch {
        return 0;
      }
    }
    return 0;
  }
}
