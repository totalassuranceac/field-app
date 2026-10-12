export type JobNoteLevel = "bring" | "heads_up" | "talk";
export type JobNote = { code: "SOLDER" | "CALLBACK_30D" | "OPTIONS_AGE" | "R22"; level: JobNoteLevel; text: string };
export type JobRuleInput = {
  job_type_id: number | null;
  job_type: string | null;
  texts: Array<string | null | undefined>;
  prior_jobs?: Array<{ job_number: string | null; completed_on: string | null; job_type: string | null }>;
  equipment?: Array<{ mfg_year: number | null; refrigerant_hint: string | null }>;
  now?: Date;
  solder_type_ids?: number[];
  options_age_years?: number;
};
export const SOLDER_TYPE_IDS_DEFAULT = [339591774, 336193175];
export const SOLDER_TEXT =
  "SOLDER: Compressor/TXV install - bring 15% silver solder (WEL SOLDER 15 / HJW15SILSOLDER), enough sticks to braze in place.";
const PART = /\b(compressor|txv|t\.x\.v\.?|expansion valve|metering device)\b/g;
const ACTION = /(\br\s?&\s?r\b|\bremoval\/replacement\b|\bremove and replace\b|\bremove\/install\b|\breplac(e|ed|ing|ement)\b|\binstall(ed|ing)?\b|\bswap\b|\bchange ?out\b)/;
const BLOCK = /(quote only|estimate only|do not replace|declined)/;
const TYPE_RE = /\b(compressor|txv|expansion\s+valve)\b.*\b(replace|replacement|install|swap|change[\s-]?out)\b|\b(replace|replacement|install|swap|change[\s-]?out)\b.*\b(compressor|txv|expansion\s+valve)\b/i;
export function cleanText(s: string | null | undefined): string {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().toLowerCase();
}
export function needsSolder(i: Pick<JobRuleInput, "job_type_id" | "job_type" | "texts" | "solder_type_ids">): boolean {
  const ids = i.solder_type_ids && i.solder_type_ids.length ? i.solder_type_ids : SOLDER_TYPE_IDS_DEFAULT;
  if (i.job_type_id != null && ids.includes(Number(i.job_type_id))) return true;
  if (i.job_type && TYPE_RE.test(i.job_type)) return true;
  for (const raw of i.texts) {
    const t = cleanText(raw);
    if (!t) continue;
    PART.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PART.exec(t))) {
      const win = t.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
      if (BLOCK.test(win)) continue;
      if (ACTION.test(win)) return true;
    }
  }
  return false;
}
function md(iso: string): string {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "numeric", day: "numeric" });
  return f.format(d);
}
export function jobNotesFor(i: JobRuleInput): JobNote[] {
  const now = i.now || new Date();
  const out: JobNote[] = [];
  if (needsSolder(i)) out.push({ code: "SOLDER", level: "bring", text: SOLDER_TEXT });
  const recent = (i.prior_jobs || [])
    .filter((p) => p.completed_on && now.getTime() - new Date(p.completed_on).getTime() <= 30 * 86400000 && now.getTime() >= new Date(p.completed_on).getTime())
    .sort((a, b) => String(b.completed_on).localeCompare(String(a.completed_on)))[0];
  if (recent) out.push({ code: "CALLBACK_30D", level: "heads_up", text: `Possible callback: job #${recent.job_number || "?"} here on ${md(recent.completed_on!)} (${recent.job_type || "job"}). Check what was done.` });
  const years = (i.equipment || []).map((e) => e.mfg_year).filter((y): y is number => typeof y === "number");
  const limit = i.options_age_years ?? 12;
  if (years.length) {
    const age = now.getUTCFullYear() - Math.min(...years);
    if (age >= limit) out.push({ code: "OPTIONS_AGE", level: "talk", text: `Unit is about ${age} years old. Offer options (Silver / Gold / Platinum).` });
  }
  if ((i.equipment || []).some((e) => (e.refrigerant_hint || "").toLowerCase().startsWith("likely r-22")))
    out.push({ code: "R22", level: "talk", text: "Likely R-22 system. Talk replacement options." });
  return out.slice(0, 4);
}
