/** Azali Homes new-house (RNC) helpers. No ServiceTitan calls. */

export type Stories = "single" | "two";
export type SysLoc = "attic" | "closet" | "second_attic";

export const TONNAGE_OPTIONS = ["1.5", "2", "2.5", "3", "3.5", "4", "5"] as const;

export const FLAG_KEY = "azali_rnc_st_create";
export const CUSTOMER_ID_KEY = "azali_homes_customer_id";
export const DEFAULT_CUSTOMER_ID = "266637796";
export const PROJECT_TYPE_KEY = "azali_rnc_project_type_id";
export const PROJECT_STATUS_KEY = "azali_rnc_status_id";
export const BUSINESS_UNIT_KEY = "azali_rnc_business_unit_id";
export const PROJECT_MANAGER_KEY = "azali_rnc_project_manager_id";
export const TAG_KEY = "azali_rnc_construction_tag_id";
export const PAYROLL_KEY = "azali_rnc_prevailing_wage_id";
export const GROUPS_KEY = "azali_rnc_groups";

export const ROUGH_IN =
  "Rough-in phase for HVAC system in new construction: Install ductwork, insulated copper refrigerant lines, primary and secondary drain lines, all communication/control wires, provide roof jacks for all exhaust fans, dryer, vent hood and fresh air.";

export const KNOWN_GROUPS = [
  "Azali homes - The Reserve at Portland Subdivision",
  "Azali Homes - Azali Estates subdivision",
];

export function flagIsOn(raw: string | null | undefined): boolean {
  const v = String(raw ?? "false").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function isAzaliMiller(user: {
  role?: string | null;
  display_name?: string | null;
  username?: string | null;
} | null): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const name = String(user.display_name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const userName = String(user.username || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (userName === "chrismiller" || userName === "cmiller" || userName === "christophermiller") {
    return true;
  }
  if (name === "chris miller" || name.startsWith("chris miller ")) return true;
  if (name === "christopher miller" || name.startsWith("christopher miller ")) return true;
  if (/\bmiller\b/.test(name) && /\bchris(?:topher)?\b/.test(name)) return true;
  return false;
}

export function locPhrase(loc: string): string {
  if (loc === "attic") return "attic";
  if (loc === "closet") return "closet";
  if (loc === "second_attic") return "2nd floor attic";
  return "";
}

export function projectNameFromStreet(street: string): string {
  const s = street.replace(/\s+/g, " ").trim();
  return s ? `${s} (RNC)` : "";
}

export function addMonthsIso(startIso: string, months: number): string {
  const [y, m, d] = startIso.split("-").map((n) => Number(n));
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function todayChicago(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

export function applyRncTemplate(
  template: string,
  input: {
    tons1: string;
    loc1: string;
    tons2: string;
    loc2: string;
    fans: number | null;
    brand: string;
  }
): string {
  return String(template || "")
    .replaceAll("{T1}", input.tons1)
    .replaceAll("{T2}", input.tons2)
    .replaceAll("{T}", input.tons1)
    .replaceAll("{loc1}", locPhrase(input.loc1))
    .replaceAll("{loc2}", locPhrase(input.loc2))
    .replaceAll("{loc}", locPhrase(input.loc1))
    .replaceAll("{brand}", input.brand.trim())
    .replaceAll("{fans}", input.fans == null ? "" : String(input.fans));
}

export function describeHouse(input: {
  stories: Stories | "";
  tons1: string;
  loc1: string;
  tons2: string;
  loc2: string;
  fans: number | null;
  brand: string;
}): string {
  const brand = input.brand.trim();
  const fans = input.fans == null ? "" : String(input.fans);
  if (input.stories === "single") {
    const loc = locPhrase(input.loc1);
    return `${ROUGH_IN} This home will have a ${input.tons1} ton air handler installed in the ${loc}, Will need a ${input.tons1} ton single stage condenser to install at final. ${brand} equipment We will provide ${fans} exhaust fans for this home`;
  }
  if (input.stories === "two") {
    const loc1 = locPhrase(input.loc1);
    const loc2 = locPhrase(input.loc2);
    return `${ROUGH_IN} This home will have a ${input.tons1} ton air handler installed in the ${loc1} for the 1st floor system and a ${input.tons2} ton air handler installed in the ${loc2}, Will need a ${input.tons2} ton and ${input.tons1} ton single stage condensers to install at final. ${brand} equipment We will provide ${fans} exhaust fans for this home.`;
  }
  return ROUGH_IN;
}

export function formatContract(raw: string): { ok: boolean; text: string } {
  const original = String(raw || "");
  const trimmed = original.trim();
  if (!trimmed) return { ok: true, text: "" };
  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return { ok: false, text: original };
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { ok: false, text: original };
  return { ok: true, text: n.toLocaleString("en-US", { style: "currency", currency: "USD" }) };
}

export const DEFAULT_SINGLE_TEMPLATE =
  `${ROUGH_IN} This home will have a {T} ton air handler installed in the {loc}, Will need a {T} ton single stage condenser to install at final. {brand} equipment We will provide {fans} exhaust fans for this home`;

export const DEFAULT_TWO_TEMPLATE =
  `${ROUGH_IN} This home will have a {T1} ton air handler installed in the {loc1} for the 1st floor system and a {T2} ton air handler installed in the {loc2}, Will need a {T2} ton and {T1} ton single stage condensers to install at final. {brand} equipment We will provide {fans} exhaust fans for this home.`;

export const TEMPLATE_SINGLE_KEY = "azali_rnc_template_single";
export const TEMPLATE_TWO_KEY = "azali_rnc_template_two";

export function formReady(input: {
  street: string;
  city: string;
  zip: string;
  group: string;
  stories: string;
  tons1: string;
  loc1: string;
  tons2: string;
  loc2: string;
  fans: number | null;
}): boolean {
  return firstMissing(input) === "";
}

export function firstMissing(input: {
  street: string;
  city: string;
  zip: string;
  group: string;
  stories: string;
  tons1: string;
  loc1: string;
  tons2: string;
  loc2: string;
  fans: number | null;
}): "" | "street" | "city" | "zip" | "group" | "stories" | "tons1" | "loc1" | "tons2" | "loc2" | "fans" {
  if (!input.street.trim()) return "street";
  if (!input.city.trim()) return "city";
  if (!input.zip.trim()) return "zip";
  if (!input.group.trim()) return "group";
  if (input.stories !== "single" && input.stories !== "two") return "stories";
  if (!TONNAGE_OPTIONS.includes(input.tons1 as (typeof TONNAGE_OPTIONS)[number])) return "tons1";
  if (input.stories === "single" && input.loc1 !== "attic" && input.loc1 !== "closet") return "loc1";
  if (input.stories === "two") {
    if (input.loc1 !== "attic" && input.loc1 !== "closet") return "loc1";
    if (!TONNAGE_OPTIONS.includes(input.tons2 as (typeof TONNAGE_OPTIONS)[number])) return "tons2";
    if (input.loc2 !== "second_attic" && input.loc2 !== "closet") return "loc2";
  }
  if (input.fans == null || input.fans < 0 || input.fans > 10) return "fans";
  return "";
}

export function customerMatchStop(matches: { id: number; name: string }[]): {
  ok: boolean;
  id?: number;
  error?: string;
} {
  const exact = matches.filter((m) => m.name.trim().toLowerCase() === "azali homes");
  if (exact.length === 1) return { ok: true, id: exact[0].id };
  if (matches.length === 1 && matches[0].id > 0) return { ok: true, id: matches[0].id };
  if (exact.length > 1) {
    return { ok: false, error: "More than one Azali Homes customer. Stop and show the matches." };
  }
  return {
    ok: false,
    error: matches.length ? "Azali Homes did not match exactly." : "No ServiceTitan customer named Azali Homes",
  };
}

export function sameStreet(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\(rnc\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

export function estimateIsApproved(status: string): boolean {
  const s = status.toLowerCase().replace(/_/g, " ");
  return s === "sold" || s === "approved" || /(^|\s)sold(\s|$)/.test(s);
}

export function estimateIsClosed(status: string): boolean {
  const s = status.toLowerCase().replace(/_/g, " ");
  return estimateIsApproved(s) || /dismiss/.test(s) || s === "void" || s === "canceled" || s === "cancelled";
}

export type StIds = {
  customer_id: string;
  project_type_id: string;
  status_id: string;
  business_unit_id: string;
  project_manager_id: string;
  tag_id: string;
  payroll_id: string;
};

export function mergeGroups(prev: string[], incoming: string[] | undefined): string[] | null {
  if (!Array.isArray(incoming)) return null;
  return Array.from(new Set([...prev, ...incoming].map((s) => String(s).trim()).filter(Boolean)));
}

export function missingStIds(ids: StIds): string[] {
  const labels: [keyof StIds, string][] = [
    ["customer_id", "Azali Homes customer id"],
    ["project_type_id", "Project type New Construction"],
    ["business_unit_id", "Business unit Residential Construction"],
    ["project_manager_id", "Project manager Chris Miller"],
    ["tag_id", "Tag construction"],
    ["status_id", "Status Scheduled"],
  ];
  return labels.filter(([key]) => !String(ids[key] || "").trim()).map(([, label]) => label);
}
