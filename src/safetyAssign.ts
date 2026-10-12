/**
 * Which safety courses belong to which job, and when a stamp needs a refresher.
 * A course stays current for one year. The refresher opens 30 days before that year ends.
 */

export type SafetyTrack = "service" | "install" | "warehouse" | "shop" | "office";
export type SafetyLevel = "essential" | "extra";
export type SafetyDueStatus = "none" | "current" | "due_soon" | "overdue";

export const SAFETY_REFRESH_LEAD_DAYS = 30;

export const TRACK_LABEL: Record<SafetyTrack, string> = {
  service: "Service",
  install: "Install",
  warehouse: "Warehouse",
  shop: "Shop",
  office: "Office",
};

export const SAFETY_TRACKS: SafetyTrack[] = ["service", "install", "warehouse", "shop", "office"];

/** library_key -> job. Absent means that job does not take the course. */
export const JOB_AUDIENCES: Record<string, Partial<Record<SafetyTrack, SafetyLevel>>> = {
  "nh-stop": { service: "essential", install: "essential" },
  "nh-body": { service: "essential", install: "essential" },
  "nh-ladders": { service: "essential", install: "essential" },
  "nh-power": { service: "essential", install: "essential" },
  "nh-refrigerant": { service: "essential", install: "essential" },
  "nh-driving": { service: "essential", install: "essential" },
  "nh-home": { service: "essential", install: "essential" },
  "ht-attic": { service: "extra", install: "essential" },
  "ht-ladder-setup": { service: "extra", install: "extra" },
  "el-panels": { service: "extra", install: "extra" },
  "el-capacitors": { service: "extra" },
  "heat-illness": { service: "extra", install: "extra" },
  "heat-crawl": { service: "extra", install: "extra" },
  "rf-recovery": { service: "extra", install: "extra" },
  "rf-brazing": { install: "essential" },
  "rf-gas": { service: "extra", install: "extra" },
  "dv-phone": { service: "extra", install: "extra" },
  "dv-parked": { service: "extra", install: "extra" },
  "call-pets": { service: "extra", install: "extra" },
  "call-leave": { service: "extra", install: "extra" },
  "wh-stop": { warehouse: "essential" },
  "wh-lift": { warehouse: "essential" },
  "wh-dock": { warehouse: "essential" },
  "wh-aisle": { warehouse: "essential" },
  "wh-blade": { warehouse: "extra" },
  "wh-heat": { warehouse: "extra" },
  "sh-stop": { shop: "essential" },
  "sh-jack": { shop: "essential" },
  "sh-spark": { shop: "essential" },
  "sh-hands": { shop: "essential" },
  "sh-cylinders": { shop: "extra" },
  "of-stop": { office: "essential" },
  "of-lot": { office: "essential" },
  "of-counter": { office: "essential" },
};

export function audiencesForKey(libraryKey: string): Partial<Record<SafetyTrack, SafetyLevel>> {
  return JOB_AUDIENCES[libraryKey] || {};
}

export function forNewHireFlag(audiences: Partial<Record<SafetyTrack, SafetyLevel>>): 0 | 1 {
  return audiences.service === "essential" || audiences.install === "essential" ? 1 : 0;
}

export function parseAudiences(raw: unknown): Partial<Record<SafetyTrack, SafetyLevel>> {
  let value = raw;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return {};
    try {
      value = JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<SafetyTrack, SafetyLevel>> = {};
  for (const track of SAFETY_TRACKS) {
    const level = (value as Record<string, unknown>)[track];
    if (level === "essential" || level === "extra") out[track] = level;
  }
  return out;
}

export function levelFor(
  audiences: Partial<Record<SafetyTrack, SafetyLevel>>,
  track: SafetyTrack
): SafetyLevel | null {
  return audiences[track] || null;
}

export function safetyTrack(input: {
  role?: string | null;
  is_warehouse?: boolean | number | null;
  position_title?: string | null;
}): SafetyTrack {
  const title = String(input.position_title || "")
    .trim()
    .toLowerCase();
  if (title.includes("warehouse") || title.includes("parts")) return "warehouse";
  if (title.includes("fleet") || title.includes("shop") || title.includes("mechanic")) return "shop";
  if (title.includes("install")) return "install";
  if (
    title.includes("service") ||
    title.includes("maintenance") ||
    title.includes("apprentice")
  ) {
    return "service";
  }
  if (title.includes("dispatcher") || title.includes("csr") || title.includes("office")) return "office";
  if (title.includes("supervisor")) return "service";

  const warehouse =
    input.role === "warehouse" || input.is_warehouse === true || Number(input.is_warehouse) === 1;
  if (warehouse) return "warehouse";
  if (input.role === "mechanic") return "shop";
  if (input.role === "driver" || input.role === "supervisor") return "service";
  return "office";
}

export function todayIsoUtc(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function addMonthsIso(iso: string, months: number): string | null {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const cursor = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0)).getUTCDate();
  const clamped = Math.min(day, last);
  const out = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), clamped));
  return out.toISOString().slice(0, 10);
}

export function addDaysIso(iso: string, days: number): string | null {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const out = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return out.toISOString().slice(0, 10);
}

export type SafetyDue = {
  status: SafetyDueStatus;
  last_taken: string | null;
  due_on: string | null;
  refresh_on: string | null;
};

export function safetyDue(completedAt: string | null | undefined, todayIso = todayIsoUtc()): SafetyDue {
  const match = String(completedAt || "").match(/^(\d{4}-\d{2}-\d{2})/);
  if (!match) {
    return { status: "none", last_taken: null, due_on: null, refresh_on: null };
  }
  const last = match[1];
  const due = addMonthsIso(last, 12);
  const refresh = due ? addDaysIso(due, -SAFETY_REFRESH_LEAD_DAYS) : null;
  if (!due || !refresh) {
    return { status: "none", last_taken: last, due_on: null, refresh_on: null };
  }
  let status: SafetyDueStatus = "current";
  if (todayIso >= due) status = "overdue";
  else if (todayIso >= refresh) status = "due_soon";
  return { status, last_taken: last, due_on: due, refresh_on: refresh };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function safetyDateLabel(iso: string | null | undefined): string {
  const match = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const month = MONTHS[Number(match[2]) - 1];
  const day = Number(match[3]);
  if (!month || !day) return "";
  return `${month} ${day}, ${match[1]}`;
}
