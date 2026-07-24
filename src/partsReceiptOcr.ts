/**
 * Client OCR for parts / invoice / packing-slip photos (company card purchases).
 * Learns vendor_name, invoice_number, total_cost, card_last4 via the same
 * ocr_memory system as fuel (hints + feedback on save).
 */

import type { OcrHints } from "./receiptOcr";
import { applyOcrLearning, loadOcrHints, clearOcrHintsCache } from "./receiptOcr";

export interface PartsReceiptParseResult {
  vendor_name: string | null;
  invoice_number: string | null;
  purchase_date: string | null;
  total_cost: number | null;
  card_last4: string | null;
  raw_text: string;
  confidence: "high" | "medium" | "low";
  missing: string[];
}

function pad2(n: string | number) {
  return String(n).padStart(2, "0");
}

function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 2000 || year > 2100) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Known fleet HVAC / parts vendors — boost when OCR matches loosely. */
const KNOWN_VENDORS: { re: RegExp; name: string }[] = [
  { re: /johnstone/i, name: "Johnstone" },
  { re: /carrier\s*enterprise|carrier\s*ent/i, name: "Carrier Enterprise" },
  { re: /\bferguson\b/i, name: "Ferguson" },
  { re: /\brefrigeration\s*hardware|rhs\b/i, name: "Refrigeration Hardware" },
  { re: /\bunited\s*refriger/i, name: "United Refrigeration" },
  { re: /\buri\b/i, name: "United Refrigeration" },
  { re: /\bgemini\b/i, name: "Gemini" },
  { re: /\bwinsupply\b/i, name: "Winsupply" },
  { re: /\bhome\s*depot\b/i, name: "Home Depot" },
  { re: /\bLOWE'?S\b/i, name: "Lowe's" },
  { re: /\bace\s*hardware\b/i, name: "Ace Hardware" },
  { re: /\bgrainger\b/i, name: "Grainger" },
  { re: /\bfastenal\b/i, name: "Fastenal" },
  { re: /\bamazon\b/i, name: "Amazon" },
  { re: /\bwalmart\b/i, name: "Walmart" },
  { re: /\btractors?\s*supply\b/i, name: "Tractor Supply" },
  { re: /\bo'?reilly|oreilly/i, name: "O'Reilly" },
  { re: /\bautozone\b/i, name: "AutoZone" },
  { re: /\bnapa\b/i, name: "NAPA" },
];

function moneyOnLine(line: string): number[] {
  const out: number[] = [];
  const soft = line.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");
  for (const m of soft.matchAll(/\$\s*(\d{1,5}\.\d{2})\b/g)) out.push(parseFloat(m[1]));
  for (const m of soft.matchAll(/USD\s*\$?\s*(\d{1,5}\.\d{2})\b/gi)) out.push(parseFloat(m[1]));
  if (!out.length) {
    for (const m of soft.matchAll(/\b(\d{1,5}\.\d{2})\b/g)) {
      const n = parseFloat(m[1]);
      if (n >= 1) out.push(n);
    }
  }
  return out.filter((n) => n >= 1 && n < 50000);
}

function parseInvoiceNumber(text: string, lines: string[]): string | null {
  const candidates: { n: string; score: number }[] = [];
  const push = (raw: string | undefined | null, score: number) => {
    if (!raw) return;
    let s = String(raw).trim().replace(/\s+/g, "");
    // Strip common OCR glue
    s = s.replace(/^[#:\-]+/, "").replace(/[|:;]+$/, "");
    if (s.length < 3 || s.length > 28) return;
    // Reject pure money / dates
    if (/^\d+\.\d{2}$/.test(s)) return;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(s)) return;
    if (!/[A-Za-z0-9]/.test(s)) return;
    candidates.push({ n: s, score });
  };

  const labelRes: { re: RegExp; score: number }[] = [
    { re: /(?:INVOICE|INV\.?)\s*(?:NO\.?|NUMBER|#|NUM)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, score: 40 },
    { re: /(?:PACKING\s*SLIP|PACK\s*SLIP|P\.?\s*S\.?)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, score: 42 },
    { re: /(?:ORDER|SO|SALES\s*ORDER)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, score: 28 },
    { re: /(?:PO|P\.O\.|PURCHASE\s*ORDER)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, score: 24 },
    { re: /(?:DOC(?:UMENT)?|RECEIPT)\s*(?:NO\.?|NUMBER|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/gi, score: 22 },
    { re: /(?:REF(?:ERENCE)?)\s*(?:NO\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,20})/gi, score: 18 },
  ];

  for (const { re, score } of labelRes) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push(m[1], score);
  }

  // Line-by-line: label on one line, value on next
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/INVOICE|PACKING\s*SLIP|INV\.?\s*#|PACK\s*SLIP/i.test(line)) {
      const same =
        line.match(/(?:INVOICE|INV\.?|PACKING\s*SLIP|PACK\s*SLIP)[^\dA-Z]{0,12}([A-Z0-9][A-Z0-9\-\/]{2,24})/i) ||
        line.match(/[:#]\s*([A-Z0-9][A-Z0-9\-\/]{2,24})\s*$/i);
      if (same) push(same[1], 36);
      const next = lines[i + 1] || "";
      if (/^[A-Z0-9][A-Z0-9\-\/]{2,24}$/i.test(next.trim())) push(next.trim(), 34);
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.n.length - a.n.length);
  return candidates[0].n;
}

function parseVendorName(text: string, lines: string[]): string | null {
  for (const v of KNOWN_VENDORS) {
    if (v.re.test(text)) return v.name;
  }
  // Header lines often hold merchant name (skip address-like)
  for (let i = 0; i < Math.min(8, lines.length); i++) {
    const line = lines[i].trim();
    if (line.length < 3 || line.length > 48) continue;
    if (/^\d|^DATE|INVOICE|PHONE|FAX|WWW\.|HTTP|TOTAL|SUBTOTAL|TAX|CARD|VISA|PAGE/i.test(line)) {
      continue;
    }
    if (/\d{3}[\s\-]\d{3}/.test(line)) continue; // phone
    if (/^\d+\s+\w+\s+(ST|RD|AVE|DR|BLVD|LN|HWY)/i.test(line)) continue;
    // Prefer lines with letters that look like a business name
    if (/[A-Za-z]{3,}/.test(line) && !/thank\s*you|customer\s*copy/i.test(line)) {
      return line.replace(/\s{2,}/g, " ").slice(0, 60);
    }
  }
  return null;
}

function parseTotal(text: string, lines: string[]): number | null {
  const scores: { n: number; score: number }[] = [];
  for (const line of lines) {
    const monies = moneyOnLine(line);
    if (!monies.length) continue;
    const n = monies[monies.length - 1];
    let score = 0;
    if (/\bGRAND\s*TOTAL\b/i.test(line)) score = 40;
    else if (/\bAMOUNT\s*due\b/i.test(line)) score = 38;
    else if (/\bTOTAL\s*DUE\b/i.test(line)) score = 38;
    else if (/\bBALANCE\s*DUE\b/i.test(line)) score = 36;
    else if (/\bTOTAL\b/i.test(line) && !/SUB\s*TOTAL|SUBTOTAL|TAX|QTY|ITEMS/i.test(line)) score = 32;
    else if (/USD\s*\$/i.test(line)) score = 28;
    else if (/\bVISA\b|\bMASTERCARD\b|\bCREDIT\b/i.test(line) && n >= 5) score = 22;
    else continue;
    if (n >= 5) score += 2;
    scores.push({ n, score });
  }
  if (!scores.length) {
    // Largest $ amount as last resort
    const all: number[] = [];
    for (const line of lines) all.push(...moneyOnLine(line));
    if (all.length) return Math.round(Math.max(...all) * 100) / 100;
    return null;
  }
  scores.sort((a, b) => b.score - a.score || b.n - a.n);
  return Math.round(scores[0].n * 100) / 100;
}

function parseCardLast4(text: string, lines: string[]): string | null {
  const candidates: { n: string; score: number }[] = [];
  const push = (raw: string, score: number) => {
    const n = raw.replace(/\D/g, "").slice(-4);
    if (!/^\d{4}$/.test(n) || n === "0000") return;
    candidates.push({ n, score });
  };
  const mask = text.replace(/[xX#•·]/g, "*");
  for (const m of mask.matchAll(/\*{3,}\s*(\d{4})\b/g)) push(m[1], 30);
  for (const m of text.matchAll(/X{4,}(\d{4})\b/gi)) push(m[1], 28);
  for (const m of text.matchAll(/(?:CARD|ACCT|ACCOUNT)[^\n]{0,40}?(\d{4})\b/gi)) push(m[1], 24);
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i].replace(/[xX#•·]/g, "*");
    const m = L.match(/\*{2,}\s*(\d{4})\b/);
    if (m) {
      let score = 20;
      if (/VISA|MC|CARD|CREDIT|CONTACT/i.test(lines[i] + " " + (lines[i - 1] || "") + " " + (lines[i + 1] || ""))) {
        score = 34;
      }
      push(m[1], score);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].n;
}

function parseDate(text: string): string | null {
  const patterns = [
    /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/g,
    /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})\b/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      const iso = toIsoDate(y, Number(m[1]), Number(m[2]));
      if (iso) return iso;
    }
  }
  return null;
}

export function parsePartsReceiptText(text: string): Omit<PartsReceiptParseResult, "raw_text"> {
  const cleaned = text.replace(/\r/g, "\n");
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const vendor_name = parseVendorName(cleaned, lines);
  const invoice_number = parseInvoiceNumber(cleaned, lines);
  const total_cost = parseTotal(cleaned, lines);
  const card_last4 = parseCardLast4(cleaned, lines);
  const purchase_date = parseDate(cleaned);

  const missing: string[] = [];
  if (!vendor_name) missing.push("vendor");
  if (!invoice_number) missing.push("invoice");
  // total/card optional for packing slips

  let confidence: "high" | "medium" | "low" = "low";
  const hits = [vendor_name, invoice_number, total_cost != null ? 1 : null].filter(Boolean).length;
  if (hits >= 3) confidence = "high";
  else if (hits >= 2) confidence = "medium";

  return {
    vendor_name,
    invoice_number,
    purchase_date,
    total_cost,
    card_last4,
    confidence,
    missing,
  };
}

/**
 * Map parts fields into the fuel OCR learning shape so applyOcrLearning can reuse
 * substitutions (store_number ≈ vendor, gallons unused, total/card shared).
 */
function toFuelLikeSnapshot(p: Omit<PartsReceiptParseResult, "raw_text">) {
  return {
    fuel_date: p.purchase_date,
    fuel_time: null as string | null,
    gallons: null as number | null,
    total_cost: p.total_cost,
    store_number: p.vendor_name,
    card_last4: p.card_last4,
  };
}

function fromFuelLike(
  base: Omit<PartsReceiptParseResult, "raw_text">,
  learned: {
    store_number?: string | null;
    total_cost?: number | null;
    card_last4?: string | null;
    fuel_date?: string | null;
  }
): Omit<PartsReceiptParseResult, "raw_text"> {
  const vendor_name = learned.store_number || base.vendor_name;
  const total_cost = learned.total_cost ?? base.total_cost;
  const card_last4 = learned.card_last4 || base.card_last4;
  const purchase_date = learned.fuel_date || base.purchase_date;
  // invoice stays from parser (learning stores as known_values on invoice field via feedback)
  const missing: string[] = [];
  if (!vendor_name) missing.push("vendor");
  if (!base.invoice_number) missing.push("invoice");
  const hits = [vendor_name, base.invoice_number, total_cost != null ? 1 : null].filter(Boolean).length;
  return {
    vendor_name,
    invoice_number: base.invoice_number,
    purchase_date,
    total_cost,
    card_last4,
    confidence: hits >= 3 ? "high" : hits >= 2 ? "medium" : "low",
    missing,
  };
}

async function preprocessImage(file: File): Promise<HTMLCanvasElement | File> {
  try {
    const bmp = await createImageBitmap(file);
    const maxW = 2000;
    const minW = 1200;
    let scale = bmp.width > maxW ? maxW / bmp.width : 1;
    if (bmp.width * scale < minW) scale = minW / bmp.width;
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let c = (g - 128) * 1.8 + 128;
      if (c < 140) c = c * 0.8;
      else c = 255 - (255 - c) * 0.85;
      const v = Math.max(0, Math.min(255, c));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    bmp.close?.();
    return canvas;
  } catch {
    return file;
  }
}

/** Apply invoice-specific learning from hints (line labels for invoice #). */
function applyInvoiceHints(
  parsed: Omit<PartsReceiptParseResult, "raw_text">,
  rawText: string,
  hints: OcrHints | null | undefined
): Omit<PartsReceiptParseResult, "raw_text"> {
  if (!hints) return parsed;
  const out = { ...parsed };
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vendorKey = partsStoreKey(out.vendor_name, rawText);
  const keys = [vendorKey, "parts_global", "global"];

  // Substitutions for invoice_number
  for (const sk of keys) {
    const map = hints.subs[sk]?.invoice_number;
    if (map && out.invoice_number && map[out.invoice_number]) {
      out.invoice_number = map[out.invoice_number];
    }
  }

  // Line labels: re-scan for invoice near learned labels
  for (const sk of keys) {
    const labels = hints.line_labels[sk]?.invoice_number || [];
    for (const lab of labels) {
      if (!lab || lab === "1") continue;
      const idx = lines.findIndex((l) => l.toUpperCase().includes(lab.toUpperCase()));
      if (idx < 0) continue;
      for (const line of [lines[idx], lines[idx + 1], lines[idx - 1]].filter(Boolean)) {
        const m =
          line.match(/(?:INVOICE|INV|PACKING\s*SLIP|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{2,24})/i) ||
          line.match(/\b([A-Z0-9]{4,}[A-Z0-9\-\/]*)\b/);
        if (m && m[1].length >= 3 && !/^\d+\.\d{2}$/.test(m[1])) {
          out.invoice_number = m[1];
          break;
        }
      }
      if (out.invoice_number) break;
    }
  }

  // Known invoice values present in text
  for (const sk of keys) {
    for (const v of hints.known_values[sk]?.invoice_number || []) {
      if (rawText.includes(v) && v.length >= 3) {
        out.invoice_number = v;
        break;
      }
    }
  }

  // Vendor subs
  for (const sk of keys) {
    const map = hints.subs[sk]?.vendor_name || hints.subs[sk]?.store_number;
    if (map && out.vendor_name && map[out.vendor_name]) {
      out.vendor_name = map[out.vendor_name];
    }
  }

  return out;
}

export function partsStoreKey(vendor: string | null | undefined, raw?: string | null): string {
  const s = (vendor || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (s && s.length >= 2) return `parts_${s.slice(0, 40)}`;
  const rawL = (raw || "").toLowerCase();
  for (const v of KNOWN_VENDORS) {
    if (v.re.test(rawL)) {
      return `parts_${v.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    }
  }
  return "parts_global";
}

export async function ocrPartsReceiptImage(
  file: File,
  hints?: OcrHints | null
): Promise<PartsReceiptParseResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Tesseract: any = (window as any).Tesseract;
  if (!Tesseract) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Could not load OCR engine"));
      document.head.appendChild(s);
    });
    Tesseract = (window as any).Tesseract;
  }

  const source = await preprocessImage(file);
  const result = await Tesseract.recognize(source, "eng", { logger: () => {} });
  let text: string = result?.data?.text || "";

  // Header strip often has vendor + invoice
  try {
    if (source && typeof (source as HTMLCanvasElement).getContext === "function") {
      const full = source as HTMLCanvasElement;
      const runStrip = async (y0: number, y1: number): Promise<string> => {
        const h = Math.max(8, y1 - y0);
        const strip = document.createElement("canvas");
        strip.width = full.width;
        strip.height = h;
        const sctx = strip.getContext("2d");
        if (!sctx) return "";
        sctx.drawImage(full, 0, y0, full.width, h, 0, 0, full.width, h);
        const r = await Tesseract.recognize(strip, "eng", { logger: () => {} });
        return (r?.data?.text || "").trim();
      };
      const top = await runStrip(0, Math.round(full.height * 0.4));
      const mid = await runStrip(Math.round(full.height * 0.35), Math.round(full.height * 0.85));
      if (top) text = `${text}\n${top}`;
      if (mid) text = `${text}\n${mid}`;
    }
  } catch {
    /* optional */
  }

  text = text.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");

  let parsed = parsePartsReceiptText(text);

  // Reuse fuel learning for vendor≈store, total, card, date
  if (hints) {
    const fuelLike = applyOcrLearning(toFuelLikeSnapshot(parsed), text, hints);
    parsed = fromFuelLike(parsed, fuelLike);
    parsed = applyInvoiceHints(parsed, text, hints);
  }

  return { ...parsed, raw_text: text };
}

export { loadOcrHints, clearOcrHintsCache };
export type { OcrHints };
