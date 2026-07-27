/**
 * OCR for equipment nameplates — model # and serial # for warranty drop-off.
 * Learns corrections via the same ocr_memory system as fuel (hints + feedback).
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
  if (s.length < 3 || s.length > 28) return false;
  if (!/[A-Z0-9]/.test(s)) return false;
  // Reject pure dates / money
  if (/^\d{1,2}[\/\-]\d/.test(s)) return false;
  return true;
}

function plausibleSerial(s: string): boolean {
  if (s.length < 4 || s.length > 32) return false;
  if (!/[A-Z0-9]/.test(s)) return false;
  return true;
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

  let model: string | null = null;
  let serial: string | null = null;

  const modelRes: RegExp[] = [
    /(?:MODEL|MOD(?:EL)?)\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,26})/i,
    /\bM\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/.]{2,26})/i,
    /\bMOD\s*[:#]\s*([A-Z0-9][A-Z0-9\-\/.]{2,26})/i,
  ];
  const serialRes: RegExp[] = [
    /(?:SERIAL|SER(?:IAL)?)\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,30})/i,
    /\bS\s*\/\s*N\s*[:#]?\s*([A-Z0-9][A-Z0-9\-]{3,30})/i,
    /\bSER\s*[:#]\s*([A-Z0-9][A-Z0-9\-]{3,30})/i,
  ];

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
  for (const re of serialRes) {
    const m = joined.match(re);
    if (m) {
      const t = cleanToken(m[1]);
      if (plausibleSerial(t)) {
        serial = t;
        break;
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
      if (plausibleSerial(t)) serial = t;
    }
  }

  const hits = [model, serial].filter(Boolean).length;
  const confidence: "high" | "medium" | "low" =
    hits >= 2 ? "high" : hits === 1 ? "medium" : "low";

  return { model_number: model, serial_number: serial, confidence };
}

/** Apply ocr_memory subs for model/serial (mapped via store_number-style keys). */
function applyNameplateHints(
  parsed: Omit<NameplateParseResult, "raw_text">,
  rawText: string,
  hints: OcrHints | null | undefined
): Omit<NameplateParseResult, "raw_text"> {
  if (!hints) return parsed;
  // Reuse fuel learning map: model → store_number channel is wrong;
  // use applyOcrLearning with vendor_name/invoice fields and also direct subs.
  const out = { ...parsed };
  const keys = ["nameplate", "nameplate_global", "global"];

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

  // Line labels learned for MODEL / SERIAL
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const sk of keys) {
    for (const lab of hints.line_labels[sk]?.model_number || []) {
      if (!lab || lab === "1") continue;
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx < 0) continue;
      for (const line of [lines[idx], lines[idx + 1]].filter(Boolean)) {
        const m =
          line.match(/(?:MODEL|M\/N|MOD)[^\w]{0,8}([A-Z0-9][A-Z0-9\-\/.]{2,26})/i) ||
          line.match(/\b([A-Z0-9][A-Z0-9\-\/.]{3,20})\b/);
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
        if (m && plausibleSerial(cleanToken(m[1]))) {
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
