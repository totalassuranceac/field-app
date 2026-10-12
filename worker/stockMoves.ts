/**
 * Parts-run stock moves. Field App tables only.
 * Pure planners are what the unit test calls. No ServiceTitan. No notifications.
 */

export const STOCK_MOVE_STATUSES = [
  "moved",
  "blocked_short",
  "clamped",
  "undone",
  "undo",
] as const;

export type StockMoveStatus = (typeof STOCK_MOVE_STATUSES)[number];

export class ShortStockError extends Error {
  have: number;
  need: number;
  constructor(have: number, need: number) {
    super(`Short: warehouse shows ${have}, needs ${need}`);
    this.name = "ShortStockError";
    this.have = have;
    this.need = need;
  }
}

export function shortFlag(have: number, need: number): string {
  return `Short: warehouse shows ${have}, needs ${need}`;
}

export function undoBlockedMessage(have: number, need: number, label = "Truck"): string {
  return `${label} shows ${have}, can't undo ${need}`;
}

export function clampFlagText(before: number, askedRemove: number): string {
  const short = askedRemove - before;
  return `Clamped: had ${before}, asked to remove ${askedRemove} (${short} short)`;
}

export function stockMovesEnabled(value: string | null | undefined): boolean {
  return String(value ?? "") === "1";
}

export function shouldTransferOnDeliver(opts: {
  setting: string | null | undefined;
  clientOptOut: boolean;
  lineCount: number;
}): boolean {
  return stockMovesEnabled(opts.setting) && !opts.clientOptOut && opts.lineCount > 0;
}

export function normalizeMoveQty(qty: number): number | null {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0 || n > 999) return null;
  return n;
}

export type MovePlan =
  | { action: "skip_kill" }
  | { action: "skip_done" }
  | { action: "bad_qty" }
  | {
      action: "blocked_short";
      have: number;
      need: number;
      flag: string;
    }
  | {
      action: "move";
      qty: number;
      fromBefore: number;
      fromAfter: number;
      toBefore: number;
      toAfter: number;
    }
  | {
      action: "issue";
      qty: number;
      fromBefore: number;
      fromAfter: number;
    };

/** Decide one parts-run line. Never returns a negative balance. */
export function planPartsRunLine(opts: {
  killSwitchOn: boolean;
  alreadyTransferred: boolean;
  qty: number;
  fromBefore: number;
  toBefore: number | null;
}): MovePlan {
  if (!opts.killSwitchOn) return { action: "skip_kill" };
  if (opts.alreadyTransferred) return { action: "skip_done" };
  const qty = normalizeMoveQty(opts.qty);
  if (qty == null) return { action: "bad_qty" };
  const fromBefore = Number(opts.fromBefore) || 0;
  if (fromBefore < qty) {
    return {
      action: "blocked_short",
      have: fromBefore,
      need: qty,
      flag: shortFlag(fromBefore, qty),
    };
  }
  const fromAfter = fromBefore - qty;
  if (opts.toBefore == null) {
    return { action: "issue", qty, fromBefore, fromAfter };
  }
  const toBefore = Number(opts.toBefore) || 0;
  return {
    action: "move",
    qty,
    fromBefore,
    fromAfter,
    toBefore,
    toAfter: toBefore + qty,
  };
}

export function planStrictIssue(
  before: number,
  qty: number
): { ok: true; before: number; after: number; qty: number } | { ok: false; have: number; need: number } {
  const n = normalizeMoveQty(qty);
  const have = Number(before) || 0;
  if (n == null) return { ok: false, have, need: Number(qty) || 0 };
  if (have < n) return { ok: false, have, need: n };
  return { ok: true, before: have, after: have - n, qty: n };
}

/** Same clamp and same returned qty as adjustStockQty. Adds a flag when it would have gone negative. */
export function planAdjust(
  before: number,
  delta: number
): { next: number; clamped: boolean; flagText: string | null; requestedQty: number } {
  const beforeN = Number(before) || 0;
  const deltaN = Number(delta) || 0;
  const raw = beforeN + deltaN;
  const next = Math.max(0, raw);
  const clamped = raw < 0;
  const requestedQty = Math.abs(deltaN);
  return {
    next,
    clamped,
    flagText: clamped ? clampFlagText(beforeN, requestedQty) : null,
    requestedQty,
  };
}

export type UndoPlan =
  | { ok: false; message: string }
  | {
      ok: true;
      qty: number;
      destBefore: number;
      destAfter: number;
      sourceBefore: number;
      sourceAfter: number;
    };

export function planUndo(opts: {
  status: string;
  qty: number;
  destOnHand: number | null;
  sourceOnHand: number;
  hasDestination: boolean;
  label?: string;
}): UndoPlan {
  if (opts.status === "undone") return { ok: false, message: "Already undone" };
  if (opts.status !== "moved") return { ok: false, message: "Only a moved row can be undone" };
  const qty = Number(opts.qty) || 0;
  if (qty <= 0) return { ok: false, message: "Nothing to undo" };
  const sourceBefore = Number(opts.sourceOnHand) || 0;
  if (!opts.hasDestination) {
    return {
      ok: true,
      qty,
      destBefore: 0,
      destAfter: 0,
      sourceBefore,
      sourceAfter: sourceBefore + qty,
    };
  }
  const destBefore = Number(opts.destOnHand) || 0;
  if (destBefore < qty) {
    return { ok: false, message: undoBlockedMessage(destBefore, qty, opts.label || "Truck") };
  }
  return {
    ok: true,
    qty,
    destBefore,
    destAfter: destBefore - qty,
    sourceBefore,
    sourceAfter: sourceBefore + qty,
  };
}

export function statusLabel(status: string): string {
  if (status === "moved") return "Moved";
  if (status === "blocked_short") return "Short";
  if (status === "clamped") return "Flagged";
  if (status === "undone") return "Undone";
  if (status === "undo") return "Undo";
  return status;
}

export function sourceLabel(row: {
  source_kind: string;
  source_id: number | null;
  undo_of_log_id?: number | null;
}): string {
  if (row.source_kind === "parts_run" && row.source_id) return `Parts run #${row.source_id}`;
  if (row.source_kind === "undo" && row.undo_of_log_id) return `Undo of #${row.undo_of_log_id}`;
  if (row.source_kind === "adjust") return "Manual adjust";
  return row.source_kind;
}
