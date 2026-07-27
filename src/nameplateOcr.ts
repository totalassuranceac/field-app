/**
 * OCR for equipment nameplates — model # and serial # for warranty drop-off.
 * Learns corrections via the same ocr_memory system as fuel (hints + feedback).
 *
 * Brand layouts (field-trained):
 * - Lennox condensers / outdoor units: M/N line = model (near top under city),
 *   S/N line immediately below = serial. Example:
 *     M/N  ML17XC1-018-230A02
 *     S/N  1924B28788
 */

import {
  loadOcrHints,
  recognizeImageText,
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
  if (s.length < 3 || s.length > 36) return false;
  if (!/[A-Z0-9]/.test(s)) return false;
  // Reject pure dates / money / pressure labels
  if (/^\d{1,2}[\/\-]\d/.test(s)) return false;
  if (/^(HFC|R\d|PSIG|HZ|PH|FLA|LRA|MIN|MAX)/i.test(s)) return false;
  return true;
}

function plausibleSerial(s: string): boolean {
  if (s.length < 4 || s.length > 32) return false;
  if (!/[A-Z0-9]/.test(s)) return false;
  if (/^(HFC|R\d|PSIG|HZ|CONTAINS)/i.test(s)) return false;
  return true;
}

/** Detect manufacturer from OCR text for brand-specific layouts. */
export function detectNameplateBrand(text: string): string | null {
  const t = text.toUpperCase();
  if (/\bLENNOX\b/.test(t) || /DALLAS\s*,?\s*TEXAS/.test(t)) return "lennox";
  if (/\bCARRIER\b/.test(t)) return "carrier";
  if (/\bTRANE\b/.test(t)) return "trane";
  if (/\bGOODMAN\b/.test(t)) return "goodman";
  if (/\bRHEEM\b|\bRUUD\b/.test(t)) return "rheem";
  if (/\bYORK\b/.test(t)) return "york";
  if (/\bAMANA\b/.test(t)) return "amana";
  if (/\bDAIKIN\b/.test(t)) return "daikin";
  return null;
}

/**
 * Lennox outdoor / condenser nameplate layout (field-confirmed):
 *   Under "LENNOX / DALLAS, TEXAS" header:
 *   - Red zone  → M/N  <model>     e.g. ML17XC1-018-230A02
 *   - Blue zone → S/N  <serial>    e.g. 1924B28788  (directly under M/N)
 * Model is usually longer with hyphens; serial often year-week + letter + digits.
 * Barcode at bottom often repeats the serial.
 */
function parseLennoxNameplate(
  joined: string,
  lines: string[]
): { model: string | null; serial: string | null } {
  let model: string | null = null;
  let serial: string | null = null;

  // Primary: labeled lines (M/N then S/N stacked)
  // Allow OCR noise: M/N, MN, M N, MOD, MODEL
  const mn =
    joined.match(
      /\bM\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{4,34})/i
    ) ||
    joined.match(
      /\bMODEL\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{4,34})/i
    ) ||
    joined.match(/\bMN\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{4,34})/i);
  if (mn) {
    const t = cleanToken(mn[1]);
    // Stop before design-pressure junk glued by OCR
    const cut = t.replace(/(DESIGN|PRESSURE|CONTAINS|HFC|FACTORY).*$/i, "");
    if (plausibleModel(cut)) model = cut;
  }

  const sn =
    joined.match(
      /\bS\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{5,28})/i
    ) ||
    joined.match(
      /\bSERIAL\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{5,28})/i
    ) ||
    joined.match(/\bSN\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{5,28})/i);
  if (sn) {
    const t = cleanToken(sn[1]);
    const cut = t.replace(/(CONTAINS|HFC|DESIGN|FACTORY|PRESSURE).*$/i, "");
    if (plausibleSerial(cut)) serial = cut;
  }

  // Line-by-line: value may sit on same line after label or next line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = (lines[i + 1] || "").trim();
    if (!model && /\bM\s*\/\s*N\b|\bMODEL\b|\bMN\b/i.test(line)) {
      const same =
        line.match(/\bM\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{4,34})/i) ||
        line.match(/\bMODEL[^\w]{0,10}([A-Z0-9][A-Z0-9\-\/.]{4,34})/i);
      if (same) {
        const t = cleanToken(same[1]);
        if (plausibleModel(t)) model = t;
      } else if (next) {
        const t = cleanToken(next.split(/\s+/)[0] || next);
        if (plausibleModel(t) && /[A-Z]/.test(t) && /\d/.test(t)) model = t;
      }
    }
    if (!serial && /\bS\s*\/\s*N\b|\bSERIAL\b|\bSN\b/i.test(line)) {
      const same =
        line.match(/\bS\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{5,28})/i) ||
        line.match(/\bSERIAL[^\w]{0,10}([A-Z0-9][A-Z0-9\-]{5,28})/i);
      if (same) {
        const t = cleanToken(same[1]);
        if (plausibleSerial(t)) serial = t;
      } else if (next) {
        const t = cleanToken(next.split(/\s+/)[0] || next);
        if (plausibleSerial(t)) serial = t;
      }
    }
  }

  // Lennox serial shape: often 2 digit year + 2 digit week + letter + digits (e.g. 1924B28788)
  if (!serial) {
    const lennoxSn = joined.match(/\b(\d{4}[A-Z]\d{4,8})\b/i);
    if (lennoxSn) {
      const t = cleanToken(lennoxSn[1]);
      if (plausibleSerial(t) && t !== model) serial = t;
    }
  }

  // Don't let serial equal model
  if (model && serial && model === serial) {
    serial = null;
  }

  return { model, serial };
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
        const t = cleanToken(m[1]);
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
    if (!serial && /SERIAL|S\/N|SER\b/i.test(line) && !/(?:SERIAL|S\/N).{0,8}[A-Z0-9]{4,}/i.test(line)) {
      const t = cleanToken(next.split(/\s+/)[0] || next);
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

  for (const sk of keys) {
    const mMap = hints.subs[sk]?.model_number;
    if (mMap && out.model_number && mMap[out.model_number]) {
      out.model_number = mMap[out.model_number];
    }
    const sMap = hints.subs[sk]?.serial_number;
    if (sMap && out.serial_number && sMap[out.serial_number]) {
      out.serial_number = sMap[out.serial_number];
    }
    // Known values present in this OCR text
    for (const v of hints.known_values[sk]?.model_number || []) {
      if (rawText.toUpperCase().includes(v.toUpperCase()) && v.length >= 3) {
        out.model_number = v.toUpperCase();
        break;
      }
    }
    for (const v of hints.known_values[sk]?.serial_number || []) {
      if (rawText.toUpperCase().includes(v.toUpperCase()) && v.length >= 4) {
        out.serial_number = v.toUpperCase();
        break;
      }
    }
  }

  // Line labels learned for MODEL / SERIAL — prefer brand key first
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
          line.match(/(?:SERIAL|S\/N|SER)[^\w]{0,8}([A-Z0-9][A-Z0-9\-]{3,30})/i) ||
          line.match(/\b([A-Z0-9][A-Z0-9\-]{5,24})\b/);
        if (m && plausibleSerial(cleanToken(m[1])) && cleanToken(m[1]) !== out.model_number) {
          out.serial_number = cleanToken(m[1]);
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
  const text = await recognizeImageText(file);
  let parsed = parseNameplateText(text);
  parsed = applyNameplateHints(parsed, text, hints);
  return { ...parsed, raw_text: text };
}

export { loadOcrHints, warmOcrEngine };
export type { OcrHints };
