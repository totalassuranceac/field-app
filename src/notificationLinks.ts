/**
 * Map a notification kind / entity to an in-app route so tapping
 * the alert takes you where you need to act (handbook, repairs, etc.).
 */
export function notificationLink(n: {
  kind?: string | null;
  entity_type?: string | null;
  entity_id?: string | number | null;
  title?: string | null;
  body?: string | null;
}): string | null {
  const kind = String(n.kind || "").toLowerCase();
  const entity = String(n.entity_type || "").toLowerCase();
  const text = `${n.title || ""} ${n.body || ""}`.toLowerCase();

  // Explicit kinds
  if (kind === "weekly_check" || kind.includes("weekly")) return "/inspections";
  if (kind === "message" || kind.startsWith("message")) return "/messages";
  if (kind.startsWith("handbook") || entity === "handbook" || text.includes("handbook")) {
    return "/handbook";
  }
  if (
    kind.startsWith("warranty") ||
    entity === "warranty" ||
    text.includes("warranty")
  ) {
    return "/warranties";
  }
  if (
    kind === "flat_emergency" ||
    kind === "repair_request" ||
    kind === "oil_change_due" ||
    kind.includes("repair") ||
    kind.includes("issue") ||
    entity === "issue"
  ) {
    return "/issues";
  }
  if (kind.includes("pickup") || entity === "pickup" || text.includes("pickup")) {
    return "/inventory";
  }
  if (kind.includes("fuel") || kind.includes("mileage") || kind.includes("alert")) {
    return "/alerts";
  }
  if (kind.includes("asset") || text.includes("bottle") || text.includes("ladder")) {
    return "/assets";
  }
  if (
    kind.includes("review") ||
    kind === "company_review" ||
    entity === "review" ||
    text.includes("google review") ||
    text.includes("shout-out")
  ) {
    return "/reviews";
  }
  if (entity === "vehicle" && n.entity_id) {
    return `/vehicles`;
  }

  // Fallback from entity_type alone
  if (entity === "handbook") return "/handbook";
  if (entity === "warranty") return "/warranties";
  if (entity === "issue") return "/issues";
  if (entity === "message") return "/messages";
  if (entity === "inspection") return "/inspections";
  if (entity === "review") return "/reviews";

  return null;
}
