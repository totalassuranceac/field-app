export type Wrapup = { found: string[]; did: string[]; recommend: string[]; parts: string[] };
const RE = {
  recommend: /\b(recommend\w*|should|suggest\w*|needs? to|next time|quote|upgrade|customer wants)\b/i,
  parts: /(\bused\b|\bparts?\b|\b\d+\s*(x|pcs|sticks|ft|lb)\b|\b[A-Z]{2,}\d{2,}\b)/,
  did: /\b(replac\w*|install\w*|clean\w*|reset\w*|add(ed)?|charged|recharg\w*|tighten\w*|braz\w*|solder\w*|flush\w*|swap\w*|test(ed)?|repair\w*)\b/i,
  found: /\b(found|diagnos\w*|bad|fail\w*|leak\w*|low|tripp\w*|reading\w*|weak|burnt|grounded|shorted|clog\w*)\b/i,
};
const START_FOUND = /^(found|diagnos\w*|noticed|checked|unit (was|is))\b/i;
export function splitWrapup(text: string): Wrapup {
  const out: Wrapup = { found: [], did: [], recommend: [], parts: [] };
  const parts = String(text || "").replace(/[^\x20-\x7E\n]/g, " ").split(/(?:\.\s+|\.$|;|\n| and then | then )/i);
  for (let p of parts) {
    p = p.replace(/\s+/g, " ").trim().replace(/^(and|also|um|uh)\s+/i, "");
    if (p.length < 3) continue;
    p = (p[0].toUpperCase() + p.slice(1)).slice(0, 200);
    const box: keyof Wrapup = START_FOUND.test(p) ? "found" : RE.recommend.test(p) ? "recommend" : RE.parts.test(p) ? "parts" : RE.did.test(p) ? "did" : RE.found.test(p) ? "found" : "did";
    if (out[box].length < 6) out[box].push(p);
  }
  return out;
}
export function wrapupCopyText(w: Wrapup): string {
  const j = (a: string[]) => (a.length ? a.join("; ") : "-");
  return `FOUND: ${j(w.found)}\nDID: ${j(w.did)}\nRECOMMEND: ${j(w.recommend)}\nPARTS: ${j(w.parts)}`;
}
export type AiFn = (system: string, user: string) => Promise<{ ok: true; text: string; model: string } | { ok: false; reason: string }>;
export const WRAPUP_AI_SYSTEM = "Sort this HVAC technician's job notes into JSON {found:[],did:[],recommend:[],parts:[]}. Short phrases. Use only what is written. Plain ASCII.";
export async function splitWrapupSmart(text: string, ai?: AiFn): Promise<{ result: Wrapup; split_by: "rules" | "ai" }> {
  if (ai) {
    try {
      const r = await ai(WRAPUP_AI_SYSTEM, text.slice(0, 4000));
      if (r.ok) {
        const m = r.text.match(/\{[\s\S]*\}/);
        const j = m ? JSON.parse(m[0]) : null;
        const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).replace(/[^\x20-\x7E]/g, "").trim().slice(0, 200)).filter((x) => x.length >= 3).slice(0, 6) : []);
        if (j) {
          const res: Wrapup = { found: arr(j.found), did: arr(j.did), recommend: arr(j.recommend), parts: arr(j.parts) };
          if (res.found.length + res.did.length + res.recommend.length + res.parts.length > 0) return { result: res, split_by: "ai" };
        }
      }
    } catch { /* fall through */ }
  }
  return { result: splitWrapup(text), split_by: "rules" };
}
