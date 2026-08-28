/**
 * OCR for equipment nameplates — model # and serial # for warranty drop-off.
 * Learns corrections via the same ocr_memory system as fuel (hints + feedback).
 *
 * Brand layouts (field-trained):
 * - Lennox condensers / outdoor units: M/N line = model (near top under city),
 *   S/N line immediately below = serial. Example:
 *     M/N  ML17XC1-018-230A02
 *     S/N  1924B28788
 *
 * Real phone OCR often mangles labels (M/N→WIN/MIN, S/N→SIN) and letters
 * (B→8). Multi-pass image OCR + brand-specific recovery handles that.
 */

import {
  loadOcrHints,
  recognizeNameplateImageText,
  warmOcrEngine,
  type OcrHints,
} from "./receiptOcr";

export interface NameplateParseResult {
  model_number: string | null;
  serial_number: string | null;
  manufacturer: string | null;
  raw_text: string;
  confidence: "high" | "medium" | "low";
}

function cleanToken(raw: string): string {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[|]/g, "I")
    .replace(/^[:#.\-]+|[:#.\-]+$/g, "")
    .toUpperCase();
}

function plausibleModel(s: string): boolean {
  if (s.length < 5 || s.length > 36) return false;
  if (!/[A-Z]/.test(s) || !/\d/.test(s)) return false;
  if (/^\d{1,2}[\/\-]\d/.test(s)) return false;
  if (/^(HFC|R\d|PSIG|HZ|PH|FLA|LRA|MIN|MAX|DESIGN|PRESSURE|CONTAINS|FACTORY)/i.test(s)) {
    return false;
  }
  return true;
}

function plausibleSerial(s: string): boolean {
  if (s.length < 6 || s.length > 32) return false;
  if (!/[A-Z0-9]/.test(s)) return false;
  if (/^(HFC|R\d|PSIG|HZ|CONTAINS|PRESSURE|DESIGN|FACTORY)/i.test(s)) return false;
  // Reject obvious junk from design-pressure block
  if (/PSIG|VOLT|MOTOR/i.test(s)) return false;
  return true;
}

/** Detect manufacturer from OCR text for brand-specific layouts. */
export function detectNameplateBrand(text: string): string | null {
  const t = text.toUpperCase();
  if (/\bLENNOX\b/.test(t) || /DALLAS\s*,?\s*TEXAS/.test(t) || /LENNOA|VENNOA|LENNO/.test(t)) {
    return "lennox";
  }
  if (/\bCARRIER\b/.test(t)) return "carrier";
  if (/\bTRANE\b/.test(t)) return "trane";
  if (/\bGOODMAN\b/.test(t)) return "goodman";
  if (/\bRHEEM\b|\bRUUD\b/.test(t)) return "rheem";
  if (/\bYORK\b/.test(t)) return "york";
  if (/\bAMANA\b/.test(t)) return "amana";
  if (/\bDAIKIN\b/.test(t)) return "daikin";
  return null;
}

/** Compact OCR blob for model matching: join digit gaps, keep hyphens. */
function compactModelBlob(s: string): string {
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9\-\s]/g, " ")
    .replace(/(\d)\s+(\d)/g, "$1$2")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, "");
}

/**
 * Score a model candidate — prefer longer, hyphenated HVAC-style tokens.
 */
function scoreModel(s: string): number {
  let n = s.length;
  if (/-/.test(s)) n += 8;
  if (/^\d+$/.test(s)) n -= 20;
  if (/XC\d|XP\d|ACX|ML\d|EL\d|TS\d/i.test(s)) n += 12;
  if (/\d{3}[A-Z]\d{2}$/.test(s)) n += 6; // e.g. 230A02
  return n;
}

/**
 * Lennox outdoor / condenser nameplate recovery.
 * OCR often reads:
 *   M/N ML17XC1-018-230A02  →  WIN L17XC1-01 8-230A02  /  MIN MLA 7XC1-…
 *   S/N 1924B28788          →  SIN 1924828788  (B confuses as 8)
 */
function parseLennoxNameplate(
  joined: string,
  lines: string[]
): { model: string | null; serial: string | null } {
  let model: string | null = null;
  let serial: string | null = null;
  const modelCandidates: string[] = [];
  const serialCandidates: string[] = [];

  // --- Serial: S/N, SIN, SN, S1N labels (OCR mangling of S/N) ---
  const serialLabelRes = [
    /\bS\s*\/\s*N\s*[:#]?\s*([A-Z0-9]{6,16})/gi,
    /\bSIN\s*[:#]?\s*([A-Z0-9]{6,16})/gi,
    /\bSN\s*[:#]?\s*([A-Z0-9]{6,16})/gi,
    /\bSERIAL\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9]{6,16})/gi,
  ];
  for (const re of serialLabelRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined))) {
      const t = cleanToken(m[1]);
      if (plausibleSerial(t) && !/PRESSURE|DESIGN|CONTAINS/i.test(t)) {
        serialCandidates.push(fixLennoxSerial(t));
      }
    }
  }

  // Bare Lennox-style serial near top of plate: 4 digits + letter/digit + 5+ digits
  for (const m of joined.matchAll(/\b(\d{4}[A-Z0-9]\d{4,8})\b/gi)) {
    serialCandidates.push(fixLennoxSerial(cleanToken(m[1])));
  }

  // --- Model: M/N and mangled labels WIN/MIN/MN/WN ---
  const modelLabelRes = [
    /\bM\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/\s.]{5,40})/gi,
    // OCR often mangles "M/N" into WIN / MIN / NIN / WN / STR
    /\b(?:WIN|MIN|NIN|MN|WN|MW|W\/N|STR)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/\s.]{5,40})/gi,
    /\bMODEL\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/\s.]{5,40})/gi,
  ];
  for (const re of modelLabelRes) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(joined))) {
      const blob = m[1].split(/\n|DESIGN|CONTAINS|PRESSURE|FACTORY/i)[0];
      const recovered = recoverLennoxModelToken(blob);
      if (recovered) modelCandidates.push(recovered);
    }
  }

  // Line-oriented: label line then value
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] || "";
    if (/\b(?:M\s*\/\s*N|MODEL|WIN|MIN|\bMN\b)/i.test(line)) {
      for (const src of [line, next]) {
        const recovered = recoverLennoxModelToken(src);
        if (recovered) modelCandidates.push(recovered);
      }
    }
    if (/\b(?:S\s*\/\s*N|SERIAL|SIN|\bSN\b)/i.test(line)) {
      const same = line.match(/(?:S\s*\/\s*N|SIN|SN|SERIAL)[^\w]{0,6}([A-Z0-9]{6,16})/i);
      if (same) serialCandidates.push(fixLennoxSerial(cleanToken(same[1])));
      const nt = cleanToken(next.split(/\s+/)[0] || "");
      if (plausibleSerial(nt)) serialCandidates.push(fixLennoxSerial(nt));
    }
  }

  // Free-form scan of compacted full text for HVAC model shape
  const compactAll = compactModelBlob(joined);
  for (const m of compactAll.matchAll(
    /(?:WIN|MIN|NIN|MN|WN|M\/N)?(M?L?\d{2}[A-Z]{2}\d-?\d{3}-?\d{3}[A-Z]\d{2})/g
  )) {
    const recovered = recoverLennoxModelToken(m[1]);
    if (recovered) modelCandidates.push(recovered);
  }
  // Family + size + electrical without full prefix (7XC1-018-230A02)
  for (const m of compactAll.matchAll(/([A-Z]{0,2}\d{0,2}XC\d-?\d{3}-?\d{3}[A-Z]\d{2})/g)) {
    const recovered = recoverLennoxModelToken(m[1]);
    if (recovered) modelCandidates.push(recovered);
  }
  // Stitch pieces when every pass is partial (common on phone photos)
  const assembled = assembleLennoxFromFragments(joined);
  if (assembled) modelCandidates.push(assembled);

  // Pick best candidates
  if (modelCandidates.length) {
    modelCandidates.sort((a, b) => scoreModel(b) - scoreModel(a));
    model = modelCandidates[0];
  }
  if (serialCandidates.length) {
    // Prefer letter-containing serials (true Lennox) over pure digits
    const scoreSn = (s: string) =>
      (/B/.test(s) ? 20 : /[A-Z]/.test(s) ? 10 : 0) + s.length;
    serialCandidates.sort((a, b) => scoreSn(b) - scoreSn(a));
    const withLetter = serialCandidates.find((s) => /[A-Z]/.test(s) && plausibleSerial(s));
    serial = withLetter || serialCandidates.find((s) => plausibleSerial(s)) || null;
  }

  if (model && serial && model === serial) serial = null;
  return { model, serial };
}

/**
 * Recover Lennox model from a noisy OCR fragment.
 * Examples in → out:
 *   "L17XC1-01 8-230A02" → ML17XC1-018-230A02
 *   "ALA 7XC1-01 -230A02" → ML17XC1-018-230A02
 *   "WL7XCLD 8-230A02" → best-effort
 */
function recoverLennoxModelToken(raw: string): string | null {
  if (!raw) return null;
  let s = raw
    .toUpperCase()
    .replace(/[^A-Z0-9\-\s]/g, " ")
    // Join split size codes: "01 8" → "018", "0 18" → "018"
    .replace(/(\d)\s+(\d)/g, "$1$2")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9\-]/g, "");

  // Strip OCR label prefixes glued on (M/N → WIN/MIN/NIN/…)
  s = s.replace(/^(?:WIN|MIN|NIN|MN|WN|MW|SIN|SN|STR)+/, "");

  // Fix common family OCR: XCH→XC1, XCL→XC1, XCA→XC1
  s = s.replace(/XC[HILA](?=\d|-|$)/g, "XC1");

  // A/W/N before L## often is misread M (AL17XC1 → ML17XC1)
  s = s.replace(/^[AWN]L(?=\d{2})/, "ML");
  s = s.replace(/^WLI(?=\d)/, "ML1");
  s = s.replace(/^MLA(?=\d)/, "ML1"); // MLA7XC1 → ML17XC1

  // Ensure hyphens in …XXX-018-230A02 pattern when digits run together
  const glued = s.match(/^([A-Z]{0,3}\d{2}[A-Z]{2}\d)(\d{3})(\d{3}[A-Z]\d{2})$/);
  if (glued) s = `${glued[1]}-${glued[2]}-${glued[3]}`;
  // L17XC1-018230A02 → L17XC1-018-230A02
  s = s.replace(/([A-Z0-9]+)-(\d{3})(\d{3}[A-Z]\d{2})$/, "$1-$2-$3");
  // L17XC1018-230A02
  s = s.replace(/^([A-Z]{0,3}\d{2}[A-Z]{2}\d)(\d{3})-/, "$1-$2-");
  // Incomplete size: ML17XC1-01-230A02 → leave for fragment assembler; try 018 if 01 alone
  s = s.replace(/^(ML\d{2}[A-Z]{2}\d)-(\d{2})-(\d{3}[A-Z]\d{2})$/, (_, a, mid, elec) => {
    // Only auto-pad when middle is "01" and electrical looks like residential 230
    if (mid === "01" && /^230A/.test(elec)) return `${a}-018-${elec}`;
    return `${a}-${mid}-${elec}`;
  });

  // Missing leading M on ML… series (OCR often drops M after M/N label)
  if (/^L\d{2}[A-Z]{2}\d-/.test(s)) s = "M" + s;
  // 17XC1-… without ML
  if (/^\d{2}XC\d-/.test(s)) s = "ML" + s;
  // 7XC1-018-… (dropped 1) → try ML17XC1
  if (/^7XC\d-/.test(s)) s = "ML1" + s;

  // Leading junk before ML
  const ml = s.match(/(ML\d{2}[A-Z]{2}\d-\d{3}-\d{3}[A-Z]\d{2})/);
  if (ml) s = ml[1];

  // Standard Lennox outdoor shape
  if (/^[A-Z]{1,4}\d{2}[A-Z]{2}\d-\d{3}-\d{3}[A-Z]\d{2}$/.test(s) && plausibleModel(s)) {
    return s;
  }
  // Slightly looser
  if (/^[A-Z0-9]{4,12}-\d{3}-[A-Z0-9]{4,8}$/.test(s) && plausibleModel(s)) {
    return s;
  }
  if (plausibleModel(s) && s.length >= 10 && /-\d{3}-/.test(s)) return s;
  return null;
}

/**
 * When no single line is clean, stitch Lennox model from pieces across OCR passes:
 *   family 17XC1 + size 018 + electrical 230A02 → ML17XC1-018-230A02
 */
function assembleLennoxFromFragments(text: string): string | null {
  const u = text.toUpperCase();
  const compact = compactModelBlob(u);

  // Series / family: 17XC1, 14ACX, 16XP1, or bare XC1 with nearby 17
  let family: string | null = null;
  const famFull = compact.match(/(\d{2}(?:XC|XP|ACX|AHX|HPX)\d)/);
  if (famFull) family = famFull[1];
  if (!family) {
    const xc = compact.match(/(XC\d)/);
    const yr = u.match(/\b1[4-9]\b/) || compact.match(/[A-Z]L?(1[4-9])XC/);
    if (xc && yr) family = `${yr[1] || yr[0]}${xc[1]}`;
    else if (xc) {
      // "7XC1" often drops the leading 1 → 17XC1
      const seven = compact.match(/([67])(XC\d)/);
      if (seven) family = `1${seven[1]}${seven[2]}`;
    }
  }
  if (!family) return null;

  // Capacity / chassis size codes common on Lennox outdoor
  const sizes = new Set<string>();
  for (const m of compact.matchAll(/(0(?:12|18|24|30|36|42|48|60))/g)) sizes.add(m[1]);
  // Fragmented "01 8" / "-01 8-" / "01-8" across OCR
  if (/0\s*1\s*8/.test(u) || /-01\s*8-/.test(u) || /01\s*8-/.test(u) || /-018-/.test(compact)) {
    sizes.add("018");
  }
  if (/0\s*2\s*4/.test(u) || /-024-/.test(compact)) sizes.add("024");
  if (/0\s*3\s*6/.test(u) || /-036-/.test(compact)) sizes.add("036");
  // Incomplete "-01-" next to 230A often is 018
  if (sizes.size === 0 && /-01-/.test(compact) && /230A/.test(compact)) sizes.add("018");

  // Electrical: 230A02, 230A01, 211A04, etc.
  const elecs = [...compact.matchAll(/(\d{3}A\d{2})/g)].map((m) => m[1]);
  // Prefer 230A** (most common residential dual-voltage sticker)
  elecs.sort((a, b) => {
    const pa = a.startsWith("230") ? 0 : 1;
    const pb = b.startsWith("230") ? 0 : 1;
    return pa - pb;
  });

  if (!sizes.size || !elecs.length) return null;
  const size = [...sizes][0];
  const elec = elecs[0];
  const model = `ML${family}-${size}-${elec}`;
  return plausibleModel(model) ? model : null;
}

/**
 * Lennox serial OCR fix: B often reads as 8.
 * True format frequently: YYWW + letter + body (e.g. 1924B28788).
 */
function fixLennoxSerial(raw: string): string {
  let s = cleanToken(raw);
  // Strip trailing junk
  s = s.replace(/(CONTAINS|HFC|DESIGN|PRESSURE).*$/i, "");
  if (!plausibleSerial(s)) return s;

  // 10 pure digits with 8 in the letter slot → prefer B (common on Lennox)
  if (/^\d{4}8\d{5}$/.test(s)) {
    return s.slice(0, 4) + "B" + s.slice(5);
  }
  // 0 or O in letter slot
  if (/^\d{4}[0O]\d{5}$/.test(s)) {
    return s.slice(0, 4) + "B" + s.slice(5);
  }
  return s;
}

/**
 * Extract model and serial from OCR text of an HVAC / equipment nameplate.
 */
export function parseNameplateText(text: string): Omit<NameplateParseResult, "raw_text"> {
  const cleaned = text.replace(/\r/g, "\n");
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const joined = cleaned;
  const brand = detectNameplateBrand(text);

  let model: string | null = null;
  let serial: string | null = null;

  // Brand-specific first (higher precision)
  if (brand === "lennox") {
    const lx = parseLennoxNameplate(joined, lines);
    model = lx.model;
    serial = lx.serial;
  }

  const modelRes: RegExp[] = [
    /(?:MODEL|MOD(?:EL)?)\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,34})/i,
    /\bM\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,34})/i,
    /\bMOD\s*[:#]\s*([A-Z0-9][A-Z0-9\-\/.]{2,34})/i,
  ];
  const serialRes: RegExp[] = [
    /(?:SERIAL|SER(?:IAL)?)\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,30})/i,
    /\bS\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,30})/i,
    /\bSIN\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{5,16})/i,
    /\bSER\s*[:#]\s*([A-Z0-9][A-Z0-9\-]{3,30})/i,
  ];

  if (!model) {
    for (const re of modelRes) {
      const m = joined.match(re);
      if (m) {
        const t = cleanToken(m[1]);
        if (plausibleModel(t)) {
          model = t;
          break;
        }
      }
    }
  }
  if (!serial) {
    for (const re of serialRes) {
      const m = joined.match(re);
      if (m) {
        let t = cleanToken(m[1]);
        if (brand === "lennox") t = fixLennoxSerial(t);
        if (plausibleSerial(t) && t !== model) {
          serial = t;
          break;
        }
      }
    }
  }

  // Label on one line, value on next
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = (lines[i + 1] || "").trim();
    if (!model && /MODEL|M\/N|MOD\b/i.test(line) && !/(?:MODEL|M\/N).{0,8}[A-Z0-9]{4,}/i.test(line)) {
      const t = cleanToken(next.split(/\s+/)[0] || next);
      if (plausibleModel(t)) model = t;
    }
    if (!serial && /SERIAL|S\/N|SER\b|SIN\b/i.test(line) && !/(?:SERIAL|S\/N|SIN).{0,8}[A-Z0-9]{4,}/i.test(line)) {
      let t = cleanToken(next.split(/\s+/)[0] || next);
      if (brand === "lennox") t = fixLennoxSerial(t);
      if (plausibleSerial(t) && t !== model) serial = t;
    }
  }

  const hits = [model, serial].filter(Boolean).length;
  const confidence: "high" | "medium" | "low" =
    hits >= 2 ? "high" : hits === 1 ? "medium" : "low";

  return {
    model_number: model,
    serial_number: serial,
    manufacturer: brand,
    confidence,
  };
}

/** Apply ocr_memory subs for model/serial (mapped via store_number-style keys). */
function applyNameplateHints(
  parsed: Omit<NameplateParseResult, "raw_text">,
  rawText: string,
  hints: OcrHints | null | undefined
): Omit<NameplateParseResult, "raw_text"> {
  if (!hints) return parsed;
  const out = { ...parsed };
  const brand = parsed.manufacturer || detectNameplateBrand(rawText);
  const keys = [
    brand ? `nameplate_${brand}` : "",
    "nameplate",
    "nameplate_global",
    "global",
  ].filter(Boolean);

  const blob = rawText.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const digitsBlob = blob.replace(/\D/g, "");

  for (const sk of keys) {
    const mMap = hints.subs[sk]?.model_number;
    if (mMap && out.model_number && mMap[out.model_number]) {
      out.model_number = mMap[out.model_number];
    }
    const sMap = hints.subs[sk]?.serial_number;
    if (sMap && out.serial_number && sMap[out.serial_number]) {
      out.serial_number = sMap[out.serial_number];
    }
    // Prefer previously corrected values that still appear (even garbled) in OCR text
    for (const v of hints.known_values[sk]?.model_number || []) {
      const vu = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (vu.length >= 5 && (blob.includes(vu) || rawText.toUpperCase().includes(v.toUpperCase()))) {
        out.model_number = v.toUpperCase();
        break;
      }
    }
    for (const v of hints.known_values[sk]?.serial_number || []) {
      const vu = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const vd = vu.replace(/\D/g, "");
      if (
        (vu.length >= 6 && blob.includes(vu)) ||
        (vd.length >= 6 && digitsBlob.includes(vd)) ||
        rawText.toUpperCase().includes(v.toUpperCase())
      ) {
        out.serial_number = v.toUpperCase();
        break;
      }
    }
  }

  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const sk of keys) {
    for (const lab of hints.line_labels[sk]?.model_number || []) {
      if (!lab || lab === "1") continue;
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx < 0) continue;
      for (const line of [lines[idx], lines[idx + 1]].filter(Boolean)) {
        const m =
          line.match(/(?:MODEL|M\/N|MOD)[^\w]{0,8}([A-Z0-9][A-Z0-9\-\/.]{2,34})/i) ||
          line.match(/\b([A-Z0-9][A-Z0-9\-\/.]{3,28})\b/);
        if (m && plausibleModel(cleanToken(m[1]))) {
          out.model_number = cleanToken(m[1]);
          break;
        }
      }
    }
    for (const lab of hints.line_labels[sk]?.serial_number || []) {
      if (!lab || lab === "1") continue;
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx < 0) continue;
      for (const line of [lines[idx], lines[idx + 1]].filter(Boolean)) {
        const m =
          line.match(/(?:SERIAL|S\/N|SER|SIN)[^\w]{0,8}([A-Z0-9][A-Z0-9\-]{3,30})/i) ||
          line.match(/\b([A-Z0-9][A-Z0-9\-]{5,24})\b/);
        if (m && plausibleSerial(cleanToken(m[1])) && cleanToken(m[1]) !== out.model_number) {
          let t = cleanToken(m[1]);
          if (brand === "lennox") t = fixLennoxSerial(t);
          out.serial_number = t;
          break;
        }
      }
    }
  }

  const hits = [out.model_number, out.serial_number].filter(Boolean).length;
  out.confidence = hits >= 2 ? "high" : hits === 1 ? "medium" : "low";
  return out;
}

export async function ocrNameplateImage(
  file: File,
  hints?: OcrHints | null
): Promise<NameplateParseResult> {
  // Multi-pass OCR tuned for metal nameplate stickers (not fuel receipts)
  const text = await recognizeNameplateImageText(file);
  let parsed = parseNameplateText(text);
  parsed = applyNameplateHints(parsed, text, hints);
  return { ...parsed, raw_text: text };
}

export { loadOcrHints, warmOcrEngine };
export type { OcrHints };
