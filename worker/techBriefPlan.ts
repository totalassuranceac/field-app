import type { JobNote } from "./jobNoteRules";
export type BriefInput = {
  notes: JobNote[];
  past_jobs: { job_number: string | null; date: string | null; job_type: string | null }[];
  equipment: { unit_role: string; manufacturer: string | null; model_number: string | null; tonnage: number | null; mfg_year: number | null }[];
  warranty: { log_number: string; part_name: string | null }[];
  open_estimates: number;
  access_code: string | null;
  permit_blocking: boolean;
  now?: Date;
};
const ROLE: Record<string, string> = { outdoor: "Outdoor", indoor: "Indoor", furnace: "Furnace", air_handler: "Air handler", package: "Package", unknown: "Unit" };
function ct(iso: string): string { return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric", day: "numeric" }).format(new Date(iso)); }
export function buildBriefLines(b: BriefInput): string[] {
  const now = b.now || new Date();
  const L: string[] = [];
  for (const n of b.notes) if (n.level !== "talk") L.push(n.text);
  const dated = b.past_jobs.filter((p) => p.date).sort((x, y) => String(y.date).localeCompare(String(x.date)));
  if (dated.length) {
    const last = dated[0];
    const n12 = dated.filter((p) => now.getTime() - new Date(p.date!).getTime() <= 365 * 86400000).length;
    L.push(`Last here: ${ct(last.date!)} ${last.job_type || "job"} (#${last.job_number || "?"}). ${n12} job${n12 === 1 ? "" : "s"} here in 12 months.`);
  } else L.push("First visit on record at this address.");
  for (const e of b.equipment.slice(0, 2)) {
    const bits = [[e.manufacturer, e.model_number].filter(Boolean).join(" ") || "Unknown unit"];
    if (e.tonnage) bits.push(`${e.tonnage} ton`);
    if (e.mfg_year) bits.push(`made ${e.mfg_year} (${now.getUTCFullYear() - e.mfg_year} yrs)`);
    L.push(`${ROLE[e.unit_role] || "Unit"}: ${bits.join(", ")}`);
  }
  for (const w of b.warranty.slice(0, 2)) L.push(`Open warranty claim ${w.log_number}${w.part_name ? ` (${w.part_name})` : ""} at this address`);
  if (b.open_estimates > 0) L.push(`Open estimates on this job: ${b.open_estimates}`);
  if (b.access_code) L.push(`Gate: ${b.access_code}`);
  if (b.permit_blocking) L.push("Permit needed before Complete");
  for (const n of b.notes) if (n.level === "talk") L.push(n.text);
  return L.map((s) => s.replace(/[^\x20-\x7E]/g, "")).slice(0, 8);
}
