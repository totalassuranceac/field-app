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
  if (
    kind === "app_feedback" ||
    kind === "app_feedback_update" ||
    entity === "app_feedback" ||
    text.includes("app feedback") ||
    text.includes("your app feedback")
  ) {
    if (kind === "app_feedback" || text.includes("app feedback ·")) {
      return "/feedback?tab=inbox";
    }
    return "/feedback?tab=mine";
  }
  if (
    kind === "time_off_request" ||
    kind === "time_off_decision" ||
    entity === "time_off" ||
    text.includes("time off")
  ) {
    if (kind === "time_off_request" || text.includes("request")) {
      return "/time-off?tab=approvals";
    }
    return "/time-off";
  }
  if (
    kind === "tool_loan_request" ||
    kind === "tool_loan_decision" ||
    kind === "tool_loan_part" ||
    entity === "tool_loan" ||
    text.includes("tool loan") ||
    text.includes("tool ordered") ||
    text.includes("tool arrived")
  ) {
    if (
      kind === "tool_loan_request" ||
      (text.includes("needs") && text.includes("approval"))
    ) {
      return "/tool-loans?tab=approvals";
    }
    return "/tool-loans";
  }
  if (
    kind === "parts_order_request" ||
    kind === "parts_order_status" ||
    entity === "parts_order" ||
    text.includes("parts order") ||
    text.includes("parts ordered") ||
    text.includes("parts order needed")
  ) {
    return "/parts-orders";
  }
  if (
    kind === "parts_run_request" ||
    kind === "parts_run_status" ||
    entity === "parts_run" ||
    text.includes("parts delivery") ||
    text.includes("warehouse delivery") ||
    text.includes("parts are on the way") ||
    text.includes("parts delivered")
  ) {
    if (kind === "parts_run_request" || text.includes("needed")) {
      return "/parts-runs?tab=open";
    }
    return "/parts-runs";
  }
  if (kind === "weekly_check" || kind.includes("weekly")) return "/inspections";
  if (kind.startsWith("warranty_") || kind === "warranty_aging" || kind === "warranty_urgent")
    return "/warranties";
  if (
    kind === "parts_place_reminder" ||
    kind === "parts_dropoff" ||
    entity === "parts_dropoff" ||
    text.includes("where did you put") ||
    text.includes("parts at shop") ||
    text.includes("drop-off") ||
    text.includes("dropoff")
  ) {
    return "/parts-dropoff";
  }
  if (kind === "pickup_waiting" || (kind.includes("pickup") && !text.includes("drop"))) {
    return "/part-pickup";
  }
  if (kind.includes("fuel") && (text.includes("receipt") || text.includes("ocr"))) {
    return "/fuel/receipt-review";
  }
  if (kind === "asset_attention" || kind.includes("asset")) return "/assets";
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
    kind === "repair_scheduled" ||
    kind === "repair_bring_in_today" ||
    kind === "repair_in_progress" ||
    kind === "repair_completed" ||
    kind === "repair_cancelled" ||
    kind === "repair_update" ||
    kind === "oil_change_due" ||
    kind.includes("repair") ||
    kind.includes("issue") ||
    entity === "issue" ||
    entity === "vehicle_issue"
  ) {
    // Deep-link to that ticket (schedule, complete, or shop board)
    if (n.entity_id != null && String(n.entity_id).trim() !== "") {
      return `/issues?id=${encodeURIComponent(String(n.entity_id))}`;
    }
    if (kind === "repair_request" || kind === "flat_emergency") {
      return "/issues?tab=needs";
    }
    return "/issues";
  }
  if (
    kind === "vendor_run" ||
    kind === "vendor_run_waiting" ||
    entity === "vendor_run" ||
    entity === "part_pickup" ||
    text.includes("parts ready") ||
    text.includes("vendor run") ||
    text.includes("part pickup") ||
    text.includes("part at vendor") ||
    text.includes("still need pickup")
  ) {
    // Deep-link to the exact ticket (open, or Picked/done if already closed)
    if (n.entity_id != null && String(n.entity_id).trim() !== "") {
      return `/part-pickup?ticket=${encodeURIComponent(String(n.entity_id))}`;
    }
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
