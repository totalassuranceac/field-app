export type EquipDecode = { mfg_year: number | null; mfg_month: number | null; tonnage: number | null; refrigerant_hint: string | null; confidence: "high" | "medium" | "low"; brand_family: string | null };
const FAM: Array<[string, RegExp]> = [
  ["lennox", /lennox|armstrong|airease|ducane|concord/i],
  ["carrier", /carrier|bryant|payne|icp|heil|tempstar|comfortmaker/i],
  ["goodman", /goodman|amana|daikin/i],
  ["trane", /trane|american standard|ameristar/i],
  ["rheem", /rheem|ruud|weatherking|weather king/i],
];
const TON: Record<string, number> = { "018": 1.5, "024": 2, "030": 2.5, "036": 3, "042": 3.5, "048": 4, "060": 5 };
function yr(yy: number, now: Date): number { const cur = now.getUTCFullYear() % 100; return yy <= cur ? 2000 + yy : 1900 + yy; }
export function familyOf(m: string | null): string | null { if (!m) return null; for (const [f, re] of FAM) if (re.test(m)) return f; return null; }
export function tonnageFromModel(model: string | null): { tons: number | null; strong: boolean } {
  const runs = String(model || "").toUpperCase().match(/\d+/g) || [];
  for (const r of runs) for (let i = 0; i + 3 <= r.length; i++) { const c = r.slice(i, i + 3); if (TON[c] != null) return { tons: TON[c], strong: true }; }
  for (let k = 1; k < runs.length; k++) { const r = runs[k]; if (r.length === 3) { const c = "0" + r.slice(1); if (TON[c] != null) return { tons: TON[c], strong: false }; } }
  for (const r of runs) if (r.length === 4) { const c = "0" + r.slice(2); if (TON[c] != null) return { tons: TON[c], strong: false }; }
  return { tons: null, strong: false };
}
export function refrigerantHint(y: number | null): string | null {
  if (y == null) return null;
  if (y < 2010) return "likely R-22 (check nameplate)";
  if (y <= 2024) return "likely R-410A (check nameplate)";
  return "likely R-454B or R-32, A2L (check nameplate)";
}
export function decodeEquipment(manufacturer: string | null, model: string | null, serial: string | null, now = new Date()): EquipDecode {
  const fam = familyOf(manufacturer);
  const s = String(serial || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  let y: number | null = null, mo: number | null = null, m: RegExpMatchArray | null;
  if (fam === "lennox" && (m = s.match(/^\d{2}(\d{2})([A-HJ-M])/))) { y = yr(+m[1], now); mo = "ABCDEFGHJKLM".indexOf(m[2]) + 1; }
  else if (fam === "carrier" && (m = s.match(/^(\d{2})(\d{2})[A-Z]/))) { const wk = +m[1]; if (wk >= 1 && wk <= 53) { y = yr(+m[2], now); mo = Math.min(12, Math.ceil(wk / 4.35)); } }
  else if (fam === "goodman" && (m = s.match(/^(\d{2})(\d{2})\d{6}/))) { const mm = +m[2]; if (mm >= 1 && mm <= 12) { y = yr(+m[1], now); mo = mm; } }
  else if (fam === "trane" && s.length >= 9 && (m = s.match(/^(\d{2})(\d{2})\d/))) { const wk = +m[2]; if (wk >= 1 && wk <= 53) { y = yr(+m[1], now); mo = Math.min(12, Math.ceil(wk / 4.35)); } }
  else if (fam === "rheem" && (m = s.match(/^[A-Z](\d{2})(\d{2})/))) { const mm = +m[1]; if (mm >= 1 && mm <= 12) { y = yr(+m[2], now); mo = mm; } }
  if (y != null && (y < 1990 || y > now.getUTCFullYear())) { y = null; mo = null; }
  const t = tonnageFromModel(model);
  const confidence: EquipDecode["confidence"] = y != null && t.strong ? "high" : y != null || t.strong ? "medium" : "low";
  return { mfg_year: y, mfg_month: y != null ? mo : null, tonnage: t.tons, refrigerant_hint: refrigerantHint(y), confidence, brand_family: fam };
}
