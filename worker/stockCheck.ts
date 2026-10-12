/**
 * Part in stock preview. Admin always. Techs only when stock_check_techs_enabled is on.
 * Read-only. No ServiceTitan inventory writes.
 */
import type { PublicUser } from "./types";
import { getSetting, setSetting } from "./audit";
import { HARD_LOCK_INSTALL_PAIRS, namesMatchHint } from "./installCrewPairs";

export const STOCK_CHECK_TECHS_KEY = "stock_check_techs_enabled";

export async function stockCheckTechsEnabled(db: D1Database): Promise<boolean> {
  const raw = (await getSetting(db, STOCK_CHECK_TECHS_KEY, "false")).trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

export async function setStockCheckTechsEnabled(db: D1Database, on: boolean): Promise<void> {
  await setSetting(db, STOCK_CHECK_TECHS_KEY, on ? "true" : "false");
}

function isLeadInstaller(name: string): boolean {
  return HARD_LOCK_INSTALL_PAIRS.some((p) => namesMatchHint(name, p.lead));
}

function isHelper(name: string): boolean {
  return HARD_LOCK_INSTALL_PAIRS.some((p) => namesMatchHint(name, p.helper));
}

/** Admin/owner always. Field tech or lead installer only when the flag is on. */
export async function canUseStockCheck(db: D1Database, user: PublicUser): Promise<boolean> {
  if (user.role === "admin") return true;
  if (!(await stockCheckTechsEnabled(db))) return false;
  const name = user.display_name || "";
  if (isHelper(name)) return false;
  if (user.role === "driver") return true;
  return isLeadInstaller(name);
}

export function stockCheckPreviewLabel(techsOn: boolean): string {
  return techsOn ? "Part in stock" : "Part in stock (admin preview)";
}
