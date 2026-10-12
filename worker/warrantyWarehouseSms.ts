/**
 * Warranty warehouse SMS — auto text Chris when a claim hits Hold / Dispose / Return.
 * Hard allowlist only (no broadcast). Dedup forever by warranty id + stage.
 */
import type { Env } from "./types";
import { logSms, normalizePhone, sendSms, smsConfigured } from "./sms";

function shortBody(text: string, max = 320): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/** Shop Twilio number (Messaging Service / From) — 361-446-6925 */
export const WARRANTY_WAREHOUSE_FROM_LAST10 = "3614466925";
/** Chris Marroquin — only recipient for these warehouse stage texts */
export const WARRANTY_WAREHOUSE_TO = "+13617791182";
export const WARRANTY_WAREHOUSE_TO_LAST10 = "3617791182";

export type WarrantyWarehouseStage = "hold" | "dispose" | "return";

export type WarrantySmsRow = {
  id: number;
  log_number: string;
  status: string;
  part_name?: string | null;
  service_address?: string | null;
  customer_name?: string | null;
  vendor_name?: string | null;
  rma_number?: string | null;
  needs_vendor_return?: number | null;
};

function streetOrName(row: WarrantySmsRow): string {
  const addr = String(row.service_address || "").trim();
  if (addr) {
    return addr.split(/[\n,]/)[0]!.trim().slice(0, 60) || "job";
  }
  const name = String(row.customer_name || "").trim();
  if (name) return name.slice(0, 60);
  const part = String(row.part_name || "").trim();
  return part ? part.slice(0, 60) : "job";
}

function vendorLabel(row: WarrantySmsRow): string {
  return String(row.vendor_name || "Vendor").trim().slice(0, 40) || "Vendor";
}

function claimNumber(row: WarrantySmsRow): string {
  return String(row.rma_number || "").trim();
}

/**
 * Which warehouse SMS stage applies to the current card state.
 * - Submitted + claim# → hold (never dispose)
 * - Approved + return flag → return
 * - Approved + no return → dispose
 * - return_to_vendor / delivered → return
 * - Rejected → none (hold stays; no dispose text)
 */
export function resolveWarrantyWarehouseStage(
  row: WarrantySmsRow
): WarrantyWarehouseStage | null {
  const st = String(row.status || "")
    .trim()
    .toLowerCase();
  const claim = claimNumber(row);
  const returnFlag = Number(row.needs_vendor_return || 0) === 1;

  if (st === "rejected" || st === "not_warranty" || st === "dropped_off") {
    return null;
  }

  if (st === "return_to_vendor" || st === "delivered") {
    return "return";
  }

  if (st === "approved") {
    return returnFlag ? "return" : "dispose";
  }

  if (st === "claim_submitted") {
    // Hold only when claim# present — never dispose on Submitted
    if (!claim) return null;
    return "hold";
  }

  return null;
}

export function buildWarrantyWarehouseSmsBody(
  stage: WarrantyWarehouseStage,
  row: WarrantySmsRow
): string {
  const w = String(row.log_number || `W${row.id}`).trim();
  const place = streetOrName(row);
  const vendor = vendorLabel(row);
  const claim = claimNumber(row) || "—";

  if (stage === "hold") {
    return `${w} has been submitted for ${place}. ${vendor} claim ${claim}. Hold the part until approved.`;
  }
  if (stage === "return") {
    return `${w} needs to be returned for ${place}. ${vendor} claim ${claim}. Do not dispose — return to ${vendor}.`;
  }
  // dispose
  return `${w} is approved for ${place}. ${vendor} claim ${claim}. Part can be disposed.`;
}

function smsContext(warrantyId: number, stage: WarrantyWarehouseStage): string {
  return `warranty_wh:${warrantyId}:${stage}`.slice(0, 120);
}

/**
 * Send at most one SMS per warranty id + stage to Chris.
 * Prefer clean body (no TA Fleet prefix). Never throws.
 */
export async function maybeSendWarrantyWarehouseSms(
  env: Env,
  db: D1Database,
  row: WarrantySmsRow,
  opts?: { fromUserId?: number | null }
): Promise<{ sent: boolean; stage: WarrantyWarehouseStage | null; reason?: string }> {
  try {
    if (!smsConfigured(env)) {
      return { sent: false, stage: null, reason: "sms_not_configured" };
    }

    const stage = resolveWarrantyWarehouseStage(row);
    if (!stage) {
      return { sent: false, stage: null, reason: "no_stage" };
    }

    const context = smsContext(row.id, stage);

    // Permanent dedup — never double-text the same stage for this warranty
    try {
      const recent = await db
        .prepare(
          `SELECT id FROM sms_log
           WHERE context = ? AND status = 'sent'
           LIMIT 1`
        )
        .bind(context)
        .first();
      if (recent) {
        return { sent: false, stage, reason: "dedup" };
      }
    } catch {
      /* sms_log optional — continue and try send */
    }

    const to = normalizePhone(WARRANTY_WAREHOUSE_TO);
    if (!to || !to.endsWith(WARRANTY_WAREHOUSE_TO_LAST10)) {
      return { sent: false, stage, reason: "allowlist_fail" };
    }

    const body = shortBody(buildWarrantyWarehouseSmsBody(stage, row), 320);
    const result = await sendSms(env, to, body);
    await logSms(db, {
      from_user_id: opts?.fromUserId ?? null,
      to_user_id: null,
      to_phone: to,
      body,
      status: result.ok ? "sent" : "failed",
      provider_sid: result.ok ? result.sid : null,
      error: result.ok ? null : result.error,
      context,
    });

    return {
      sent: result.ok,
      stage,
      reason: result.ok ? undefined : result.error,
    };
  } catch (e) {
    console.warn(
      "[warranty-wh-sms]",
      e instanceof Error ? e.message : e
    );
    return {
      sent: false,
      stage: null,
      reason: e instanceof Error ? e.message : "error",
    };
  }
}
