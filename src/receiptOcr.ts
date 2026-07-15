/**
 * Client-side receipt OCR helpers (Tesseract.js CDN).
 */

export interface ReceiptParseResult {
  gallons: number | null;
  total_cost: number | null;
  fuel_date: string | null;
  station_notes: string | null;
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
  // Reject far-future / very old relative to now
  const now = new Date();
  const diffDays = (d.getTime() - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000;
  if (diffDays > 3 || diffDays < -400) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Pull the best receipt transaction date into YYYY-MM-DD */
export function parseReceiptDate(text: string): string | null {
  const cleaned = text.replace(/\r/g, "\n");
  const candidates: { iso: string; score: number }[] = [];

  const push = (y: number, m: number, d: number, score: number) => {
    const iso = toIsoDate(y, m, d);
    if (iso) candidates.push({ iso, score });
  };

  // Labeled dates get higher score
  const labeled = [
    /(?:DATE|TRAN\s*DATE|TRANS(?:ACTION)?\s*DATE|SALE\s*DATE|INVOICE\s*DATE)\s*[:#]?\s*(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/gi,
    /(?:DATE|TRAN\s*DATE|TRANS(?:ACTION)?\s*DATE)\s*[:#]?\s*(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/gi,
  ];
  for (const re of labeled) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned))) {
      if (m[1].length === 4) {
        push(Number(m[1]), Number(m[2]), Number(m[3]), 10);
      } else {
        let y = Number(m[3]);
        if (y < 100) y += 2000;
        push(y, Number(m[1]), Number(m[2]), 10);
      }
    }
  }

  // Common US formats MM/DD/YYYY or MM-DD-YY
  const us = cleaned.matchAll(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g);
  for (const m of us) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    // Prefer mid-score unlabeled
    push(y, Number(m[1]), Number(m[2]), 5);
  }

  // ISO-ish YYYY-MM-DD
  const isoish = cleaned.matchAll(/\b(20\d{2})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})\b/g);
  for (const m of isoish) {
    push(Number(m[1]), Number(m[2]), Number(m[3]), 7);
  }

  // OCR noise: 0/O confusions around dates — try fixing O->0 in digit-like tokens
  const fixed = cleaned.replace(/([0-9OIl]{1,2})[\/\-.]([0-9OIl]{1,2})[\/\-.]([0-9OIl]{2,4})/gi, (full) =>
    full.replace(/O/gi, "0").replace(/[Il]/g, "1")
  );
  if (fixed !== cleaned) {
    const us2 = fixed.matchAll(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/g);
    for (const m of us2) {
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      push(y, Number(m[1]), Number(m[2]), 4);
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  // Prefer most recent among top scores
  const topScore = candidates[0].score;
  const top = candidates.filter((c) => c.score === topScore);
  top.sort((a, b) => (a.iso < b.iso ? 1 : -1));
  return top[0].iso;
}

function parseReceiptText(text: string): Omit<ReceiptParseResult, "raw_text"> {
  const cleaned = text.replace(/\r/g, "\n");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  const joined = cleaned.replace(/,/g, "");

  let gallons: number | null = null;
  let total_cost: number | null = null;
  let station_notes: string | null = null;

  const galPatterns = [
    /(?:GALLONS?|GAL|VOLUME|QTY|QUANTITY)\s*[:#]?\s*(\d+\.?\d*)/i,
    /(\d+\.\d{1,4})\s*(?:GAL|GALLONS?)\b/i,
    /\b(\d{1,2}\.\d{3})\b/,
  ];
  for (const re of galPatterns) {
    const m = joined.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (n > 0 && n < 200) {
        gallons = n;
        break;
      }
    }
  }

  const totalLine = lines.find((l) => /TOTAL|AMOUNT DUE|SALE AMT|GRAND/i.test(l) && /\$?\d/.test(l));
  const moneyRe = /\$?\s*(\d{1,4}\.\d{2})\b/g;
  if (totalLine) {
    const monies = [...totalLine.matchAll(moneyRe)].map((m) => parseFloat(m[1]));
    if (monies.length) total_cost = monies[monies.length - 1];
  }
  if (total_cost == null) {
    const all = [...joined.matchAll(moneyRe)].map((m) => parseFloat(m[1])).filter((n) => n > 1 && n < 1000);
    if (all.length) total_cost = Math.max(...all);
  }

  const fuel_date = parseReceiptDate(cleaned);

  const station = lines.find(
    (l) =>
      l.length > 3 &&
      !/^\d/.test(l) &&
      !/TOTAL|GALLON|PUMP|VISA|MASTERCARD|DEBIT|AUTH|DATE/i.test(l)
  );
  if (station) station_notes = station.slice(0, 120);

  let confidence: "high" | "medium" | "low" = "low";
  const hits = [gallons != null, total_cost != null, fuel_date != null].filter(Boolean).length;
  if (hits >= 3) confidence = "high";
  else if (hits >= 2) confidence = "medium";
  else if (hits === 1) confidence = "low";

  return { gallons, total_cost, fuel_date, station_notes, confidence };
}

export async function ocrReceiptImage(file: File): Promise<ReceiptParseResult> {
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

  const result = await Tesseract.recognize(file, "eng", {
    logger: () => {},
  });
  const text: string = result?.data?.text || "";
  const parsed = parseReceiptText(text);
  return { ...parsed, raw_text: text };
}

export { parseReceiptText };
