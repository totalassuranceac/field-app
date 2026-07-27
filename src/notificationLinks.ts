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

  // Messaging UI removed — old chat alerts just open the inbox
  if (
    kind === "message" ||
    kind === "message_ack" ||
    kind.startsWith("message") ||
    entity === "conversation" ||
    entity === "message"
  ) {
    return "/notifications";
  }

  // Explicit kinds
  if (kind === "weekly_check" || kind.includes("weekly")) return "/inspections";
  if (kind.startsWith("handbook") || entity === "handbook" || text.includes("handbook")) {
    return "/handbook";
  }
  // Do not match "warranty" inside arbitrary free text — only real warranty notifications
  if (kind.startsWith("warranty") || entity === "warranty") {
    return "/warranties";
  }
  if (
    kind === "parts_purchase" ||
    entity === "parts_purchase" ||
    text.includes("parts receipt")
  ) {
    return "/parts-receipts";
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
  if (
    kind === "vendor_run" ||
    entity === "vendor_run" ||
    text.includes("parts ready") ||
    text.includes("vendor run") ||
    text.includes("part pickup")
  ) {
    return "/part-pickup";
  }
  if (
    kind === "truck_stock_count" ||
    entity === "truck_stock_count" ||
    text.includes("truck stock count")
  ) {
    return "/truck-stock";
  }
  if (kind.includes("pickup") || entity === "pickup" || text.includes("pickup")) {
    return "/inventory";
  }
  if (kind.includes("fuel") || kind.includes("mileage") || kind.includes("alert")) {
    return "/alerts";
  }
  if (kind.includes("asset")) {
    return "/assets";
  }
  if (kind.includes("review") || kind === "company_review" || entity === "review") {
    return "/reviews";
  }
  if (entity === "vehicle" && n.entity_id) {
    return `/vehicles`;
  }

  // Fallback from entity_type alone
  if (entity === "handbook") return "/handbook";
  if (entity === "warranty") return "/warranties";
  if (entity === "parts_purchase") return "/parts-receipts";
  if (entity === "issue") return "/issues";
  if (entity === "inspection") return "/inspections";
  if (entity === "review") return "/reviews";

  return null;
}
