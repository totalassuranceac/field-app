/**
 * Shared Ops period ids — Home + Performance must use the same strings
 * so the Worker resolveOpsPeriods window stays one truth.
 * UI: Look back 7 / 30 / 90 days (default 7 = this week).
 */
export type OpsPeriod = "7" | "30" | "90";

export const OPS_PERIODS: Array<{ id: OpsPeriod; label: string }> = [
  { id: "7", label: "7 days" },
  { id: "30", label: "30 days" },
  { id: "90", label: "90 days" },
];

export function parseOpsPeriodClient(raw: string | null | undefined): OpsPeriod {
  const p = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (p === "7" || p === "d7" || p === "lookback_7" || p === "this_week" || p === "last_week") {
    return "7";
  }
  if (p === "90" || p === "d90" || p === "lookback_90") return "90";
  // 30 + legacy month aliases + unknown → default 30
  return "30";
}

/** Default period for Home → Ops links and Performance page. */
export const OPS_DEFAULT_PERIOD: OpsPeriod = "7";