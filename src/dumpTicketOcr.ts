/**
 * Client OCR for dump / landfill scale tickets.
 * Learns net weight + total via ocr_memory (maps weight → gallons under store key "dump").
 */

import { loadOcrHints, clearOcrHintsCache, type OcrHints } from "./receiptOcr";

export interface DumpTicketParseResult {
  dump_date: string | null;
  net_weight_lbs: number | null;
  total_amount: number | null;
  raw_text: string;
  confidence: "high" | "medium" | "low";
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

function parseDate(text: string): string | null {
  const mdy = text.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
  if (mdy) {
    let y = parseInt(mdy[3], 10);
    if (y < 100) y += 2000;
    return toIsoDate(y, parseInt(mdy[1], 10), parseInt(mdy[2], 10));
  }
  const ymd = text.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
  if (ymd) {
    return toIsoDate(parseInt(ymd[1], 10), parseInt(ymd[2], 10), parseInt(ymd[3], 10));
  }
  return null;
}

function moneyOnLine(line: string): number[] {
  const out: number[] = [];
  const soft = line.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");
  for (const m of soft.matchAll(/\$\s*(\d{1,6}\.\d{2})\b/g)) out.push(parseFloat(m[1]));
  for (const m of soft.matchAll(/USD\s*\$?\s*(\d{1,6}\.\d{2})\b/gi)) out.push(parseFloat(m[1]));
  if (!out.length) {
    for (const m of soft.matchAll(/\b(\d{1,6}\.\d{2})\b/g)) {
      const n = parseFloat(m[1]);
      if (n >= 1) out.push(n);
    }
  }
  return out.filter((n) => n >= 1 && n < 100000);
}

function parseTotal(text: string, lines: string[]): number | null {
  const scored: { n: number; score: number }[] = [];
  const push = (n: number | null | undefined, score: number) => {
    if (n == null || !Number.isFinite(n) || n < 1) return;
    scored.push({ n, score });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const up = line.toUpperCase();
    const moneys = moneyOnLine(line);
    const nextMoneys = i + 1 < lines.length ? moneyOnLine(lines[i + 1]) : [];
    if (/TOTAL\s*AMOUNT|AMOUNT\s*DUE|BALANCE\s*DUE|GRAND\s*TOTAL|AMOUNT\s*PAID/i.test(up)) {
      push(moneys[moneys.length - 1] ?? nextMoneys[0], 50);
    } else if (/\bTOTAL\b/i.test(up) && !/SUB\s*TOTAL|NET\s*WT|GROSS/i.test(up)) {
      push(moneys[moneys.length - 1] ?? nextMoneys[0], 40);
    } else if (/\$/.test(line) && moneys.length) {
      push(moneys[moneys.length - 1], 12);
    }
  }

  scored.sort((a, b) => b.score - a.score || b.n - a.n);
  return scored[0]?.n ?? null;
}

/** Parse net weight in pounds from scale ticket text. */
function parseNetWeightLbs(text: string, lines: string[]): number | null {
  const candidates: { n: number; score: number }[] = [];
  const push = (raw: string | undefined | null, score: number, unitHint?: string) => {
    if (!raw) return;
    const cleaned = String(raw).replace(/,/g, "").trim();
    const n = parseFloat(cleaned);
    if (!Number.isFinite(n) || n <= 0 || n > 200000) return;
    let lbs = n;
    const u = (unitHint || "").toUpperCase();
    if (/\bT(?:ON)?S?\b/.test(u) || (n > 0 && n < 80 && /ton/i.test(text) && score >= 30)) {
      // Only convert if clearly tons (small number + ton label)
      if (/\bT(?:ON)?S?\b/.test(u) || /ton/i.test(unitHint || "")) {
        lbs = n * 2000;
      }
    }
    candidates.push({ n: Math.round(lbs * 100) / 100, score });
  };

  // Labeled net weight on same or next line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const up = line.toUpperCase();
    const next = lines[i + 1] || "";
    if (/NET\s*(WT|WEIGHT|WGT)?\.?|NET\s*LBS?|NET\s*POUNDS/i.test(up)) {
      const m =
        line.match(
          /NET\s*(?:WT|WEIGHT|WGT)?\.?\s*[:#]?\s*([\d,]+\.?\d*)\s*(LBS?|POUNDS?|TONS?|T)?/i
        ) || next.match(/^\s*([\d,]+\.?\d*)\s*(LBS?|POUNDS?|TONS?|T)?/i);
      if (m) push(m[1], 55, m[2] || line);
    }
    if (/\bNET\b/i.test(up) && /LBS?|POUND/i.test(up)) {
      const m = line.match(/([\d,]+\.?\d*)\s*(LBS?|POUNDS?)/i);
      if (m) push(m[1], 48, m[2]);
    }
  }

  // Global patterns
  for (const m of text.matchAll(
    /NET\s*(?:WT|WEIGHT|WGT)?\.?\s*[:#]?\s*([\d,]+\.?\d*)\s*(LBS?|POUNDS?|TONS?|T)?/gi
  )) {
    push(m[1], 50, m[2] || "");
  }
  for (const m of text.matchAll(/\b([\d,]+\.?\d*)\s*(LBS?|POUNDS?)\b/gi)) {
    // Prefer when near NET
    const idx = m.index ?? 0;
    const window = text.slice(Math.max(0, idx - 40), idx + 40).toUpperCase();
    push(m[1], /NET/.test(window) ? 42 : 18, m[2]);
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.n ?? null;
}

/** Pull a number from a line (and optional next line) near a dump label. */
function numberNearLabel(
  lines: string[],
  label: string,
  kind: "weight" | "money"
): number | null {
  const lab = label.toUpperCase();
  for (let i = 0; i < lines.length; i++) {
    const up = lines[i].toUpperCase();
    if (!up.includes(lab)) continue;
    const pool = [lines[i], lines[i + 1] || "", lines[i - 1] || ""];
    for (const line of pool) {
      if (kind === "money") {
        const ms = moneyOnLine(line);
        if (ms.length) return ms[ms.length - 1];
      } else {
        const m = line.match(/([\d,]+\.?\d*)\s*(LBS?|POUNDS?|TONS?|T)?/i);
        if (m) {
          let n = parseFloat(m[1].replace(/,/g, ""));
          if (!Number.isFinite(n) || n <= 0) continue;
          if (m[2] && /^T/i.test(m[2])) n *= 2000;
          if (n > 0 && n < 200000) return Math.round(n * 100) / 100;
        }
      }
    }
  }
  return null;
}

/**
 * Dump-specific learning: use remembered line labels (NET WT, TOTAL, …)
 * and digit substitutions — never fuel "G token" / memorized prior weights.
 */
function applyDumpLearning(
  parsed: Omit<DumpTicketParseResult, "raw_text">,
  rawText: string,
  hints: OcrHints | null | undefined
): Omit<DumpTicketParseResult, "raw_text"> {
  if (!hints) return parsed;
  const out = { ...parsed };
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const keys = ["dump", "global"];

  const labelsFor = (field: string): string[] => {
    const outL: string[] = [];
    for (const sk of keys) {
      for (const lab of hints.line_labels?.[sk]?.[field] || []) {
        if (lab && lab !== "1" && !outL.includes(lab)) outL.push(lab);
      }
    }
    return outL;
  };

  const applySub = (field: string, current: number | null): number | null => {
    if (current == null) return current;
    const cur = String(current);
    for (const sk of ["dump"]) {
      const map = hints.subs?.[sk]?.[field];
      if (!map) continue;
      if (map[cur] != null) {
        const n = parseFloat(map[cur]);
        if (Number.isFinite(n)) return n;
      }
      for (const [wrong, right] of Object.entries(map)) {
        if (Math.abs(parseFloat(wrong) - current) < 0.001) {
          const n = parseFloat(right);
          if (Number.isFinite(n)) return n;
        }
      }
    }
    return current;
  };

  // Weight from learned NET labels when missing or weak
  if (out.net_weight_lbs == null) {
    for (const lab of [
      ...labelsFor("gallons"),
      "NET WEIGHT",
      "NET WT",
      "NET WGT",
      "NET LBS",
      "NET",
    ]) {
      const n = numberNearLabel(lines, lab, "weight");
      if (n != null) {
        out.net_weight_lbs = n;
        break;
      }
    }
  }
  out.net_weight_lbs = applySub("gallons", out.net_weight_lbs);

  // Total from learned TOTAL / AMOUNT labels
  if (out.total_amount == null) {
    for (const lab of [
      ...labelsFor("total_cost"),
      "TOTAL AMOUNT",
      "AMOUNT DUE",
      "TICKET TOTAL",
      "TOTAL",
    ]) {
      const n = numberNearLabel(lines, lab, "money");
      if (n != null) {
        out.total_amount = n;
        break;
      }
    }
  }
  out.total_amount = applySub("total_cost", out.total_amount);

  // Date sub
  if (out.dump_date) {
    for (const sk of keys) {
      const map = hints.subs?.[sk]?.fuel_date;
      if (map?.[out.dump_date]) {
        out.dump_date = map[out.dump_date];
        break;
      }
    }
  }

  return out;
}

export function parseDumpTicketText(text: string): Omit<DumpTicketParseResult, "raw_text"> {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const dump_date = parseDate(text);
  const net_weight_lbs = parseNetWeightLbs(text, lines);
  const total_amount = parseTotal(text, lines);

  let confidence: "high" | "medium" | "low" = "low";
  const hits = [dump_date, net_weight_lbs, total_amount].filter((x) => x != null).length;
  if (hits >= 3) confidence = "high";
  else if (hits >= 2) confidence = "medium";

  return { dump_date, net_weight_lbs, total_amount, confidence };
}

async function preprocessImage(file: File): Promise<HTMLCanvasElement | File> {
  try {
    const bmp = await createImageBitmap(file);
    const maxW = 1600;
    const scale = bmp.width > maxW ? maxW / bmp.width : 1;
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
      let c = (g - 128) * 1.75 + 128;
      if (c < 140) c = c * 0.85;
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

export async function ocrDumpTicketImage(
  file: File,
  hints?: OcrHints | null
): Promise<DumpTicketParseResult> {
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
      const mid = await runStrip(Math.round(full.height * 0.2), Math.round(full.height * 0.9));
      if (mid) text = `${text}\n${mid}`;
    }
  } catch {
    /* optional */
  }

  text = text.replace(/(\d)\s+\.\s*(\d)/g, "$1.$2").replace(/(\d)\.\s+(\d{2})\b/g, "$1.$2");
  let parsed = parseDumpTicketText(text);
  parsed = applyDumpLearning(parsed, text, hints);

  let confidence: "high" | "medium" | "low" = parsed.confidence;
  const hits = [parsed.dump_date, parsed.net_weight_lbs, parsed.total_amount].filter(
    (x) => x != null
  ).length;
  if (hits >= 3) confidence = "high";
  else if (hits >= 2) confidence = "medium";
  else confidence = "low";

  return { ...parsed, confidence, raw_text: text };
}

export { loadOcrHints, clearOcrHintsCache };
export type { OcrHints };
