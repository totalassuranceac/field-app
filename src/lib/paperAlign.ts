/** Straighten a photo of paper. Letter, half sheet, and legal snap to that size. */

export type Pt = { x: number; y: number };
export type PaperKind = "letter" | "half" | "legal" | "receipt" | "unknown";

export type DetectedPaper = {
  corners: Pt[];
  kind: PaperKind;
  confident: boolean;
};

const LETTER = 8.5 / 11;
const HALF = 5.5 / 8.5;
const LEGAL = 8.5 / 14;

export function dist(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

/** Short side divided by long side. */
export function sheetRatio(corners: Pt[]): number {
  const w = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2;
  const h = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2;
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  if (long < 1) return 1;
  return short / long;
}

export function isLandscape(corners: Pt[]): boolean {
  const w = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2;
  const h = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2;
  return w > h;
}

/** Closest standard size, or unknown when none is close. A long strip is a receipt. */
export function classifySheet(corners: Pt[]): PaperKind {
  const ratio = sheetRatio(corners);
  if (ratio < 0.42) return "receipt";
  const options: Array<[PaperKind, number]> = [
    ["letter", LETTER],
    ["half", HALF],
    ["legal", LEGAL],
  ];
  let best: PaperKind = "unknown";
  let bestGap = 0.06;
  for (const [kind, target] of options) {
    const gap = Math.abs(ratio - target) / target;
    if (gap < bestGap) {
      best = kind;
      bestGap = gap;
    }
  }
  return best;
}

export function paperLabel(kind: PaperKind): string {
  if (kind === "letter") return "Letter paper, 8.5 x 11";
  if (kind === "half") return "Half sheet, 5.5 x 8.5";
  if (kind === "legal") return "Legal paper, 8.5 x 14";
  if (kind === "receipt") return "Receipt";
  return "Paper";
}

export function outputSize(kind: PaperKind, corners: Pt[]): { w: number; h: number } {
  const landscape = isLandscape(corners);
  const ratio = sheetRatio(corners);
  let short = 1000;
  let long = 1000;
  if (kind === "letter") {
    long = 1400;
    short = Math.round(long * LETTER);
  } else if (kind === "half") {
    long = 1200;
    short = Math.round(long * HALF);
  } else if (kind === "legal") {
    long = 1500;
    short = Math.round(long * LEGAL);
  } else {
    long = 1500;
    short = Math.max(280, Math.round(long * Math.min(ratio, 0.95)));
  }
  return landscape ? { w: long, h: short } : { w: short, h: long };
}

function otsu(gray: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let max = 0;
  let threshold = 180;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > max) {
      max = between;
      threshold = t;
    }
  }
  return threshold;
}

function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = mask.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mask[i]) continue;
      if (mask[i - 1] || mask[i + 1] || mask[i - w] || mask[i + w]) out[i] = 1;
    }
  }
  return out;
}

/** Bright paper blob -> four corners. Coordinates are in this gray image. */
export function detectPaper(gray: Uint8Array, w: number, h: number): DetectedPaper | null {
  if (gray.length < w * h || w < 20 || h < 20) return null;
  const threshold = otsu(gray);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = gray[i] > threshold ? 1 : 0;
  const grown = dilate(mask, w, h);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  let bestArea = 0;
  let best: Pt[] | null = null;
  let bestBorder = 0;

  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let area = 0;
    let border = 0;
    let tl = { x: w, y: h };
    let tr = { x: 0, y: h };
    let br = { x: 0, y: 0 };
    let bl = { x: w, y: 0 };
    let tlScore = Infinity;
    let trScore = -Infinity;
    let brScore = -Infinity;
    let blScore = Infinity;
    while (stack.length) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      area++;
      if (x < 2 || y < 2 || x > w - 3 || y > h - 3) border++;
      const sTl = x + y;
      const sTr = x - y;
      const sBr = x + y;
      const sBl = x - y;
      if (sTl < tlScore) {
        tlScore = sTl;
        tl = { x, y };
      }
      if (sTr > trScore) {
        trScore = sTr;
        tr = { x, y };
      }
      if (sBr > brScore) {
        brScore = sBr;
        br = { x, y };
      }
      if (sBl < blScore) {
        blScore = sBl;
        bl = { x, y };
      }
      const n1 = i - 1;
      const n2 = i + 1;
      const n3 = i - w;
      const n4 = i + w;
      if (x > 0 && grown[n1] && !seen[n1]) {
        seen[n1] = 1;
        stack.push(n1);
      }
      if (x + 1 < w && grown[n2] && !seen[n2]) {
        seen[n2] = 1;
        stack.push(n2);
      }
      if (y > 0 && grown[n3] && !seen[n3]) {
        seen[n3] = 1;
        stack.push(n3);
      }
      if (y + 1 < h && grown[n4] && !seen[n4]) {
        seen[n4] = 1;
        stack.push(n4);
      }
    }
    if (area > bestArea) {
      bestArea = area;
      best = [tl, tr, br, bl];
      bestBorder = border;
    }
  }

  if (!best || bestArea < w * h * 0.08) return null;
  const spanOk = best.every((p, i) => best!.every((q, j) => i === j || dist(p, q) > Math.min(w, h) * 0.08));
  if (!spanOk) return null;
  const kind = classifySheet(best);
  const areaRatio = bestArea / (w * h);
  const borderHeavy = bestBorder > Math.min(w, h);
  const confident =
    !borderHeavy &&
    areaRatio < 0.9 &&
    areaRatio > 0.1 &&
    kind !== "unknown";
  return { corners: best, kind, confident };
}

export function defaultCorners(w: number, h: number): Pt[] {
  const m = 0.08;
  return [
    { x: w * m, y: h * m },
    { x: w * (1 - m), y: h * m },
    { x: w * (1 - m), y: h * (1 - m) },
    { x: w * m, y: h * (1 - m) },
  ];
}

function solve3(m: number[], v: number[]): number[] | null {
  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-8) return null;
  const inv = 1 / det;
  const i = [
    (m[4] * m[8] - m[5] * m[7]) * inv,
    (m[2] * m[7] - m[1] * m[8]) * inv,
    (m[1] * m[5] - m[2] * m[4]) * inv,
    (m[5] * m[6] - m[3] * m[8]) * inv,
    (m[0] * m[8] - m[2] * m[6]) * inv,
    (m[2] * m[3] - m[0] * m[5]) * inv,
    (m[3] * m[7] - m[4] * m[6]) * inv,
    (m[1] * m[6] - m[0] * m[7]) * inv,
    (m[0] * m[4] - m[1] * m[3]) * inv,
  ];
  return [
    i[0] * v[0] + i[1] * v[1] + i[2] * v[2],
    i[3] * v[0] + i[4] * v[1] + i[5] * v[2],
    i[6] * v[0] + i[7] * v[1] + i[8] * v[2],
  ];
}

/** Map source triangle onto dest triangle and draw that slice of the photo. */
function drawTriangle(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  s0: Pt,
  s1: Pt,
  s2: Pt,
  d0: Pt,
  d1: Pt,
  d2: Pt
) {
  const srcM = [s0.x, s0.y, 1, s1.x, s1.y, 1, s2.x, s2.y, 1];
  const ax = solve3(srcM, [d0.x, d1.x, d2.x]);
  const ay = solve3(srcM, [d0.y, d1.y, d2.y]);
  if (!ax || !ay) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(d0.x, d0.y);
  ctx.lineTo(d1.x, d1.y);
  ctx.lineTo(d2.x, d2.y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(ax[0], ay[0], ax[1], ay[1], ax[2], ay[2]);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

export async function warpPaper(image: CanvasImageSource, srcW: number, srcH: number, corners: Pt[], kind: PaperKind): Promise<Blob> {
  const size = outputSize(kind, corners);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not straighten the photo");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size.w, size.h);
  const d0 = { x: 0, y: 0 };
  const d1 = { x: size.w, y: 0 };
  const d2 = { x: size.w, y: size.h };
  const d3 = { x: 0, y: size.h };
  drawTriangle(ctx, image, corners[0], corners[1], corners[2], d0, d1, d2);
  drawTriangle(ctx, image, corners[0], corners[2], corners[3], d0, d2, d3);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.86));
  if (!blob) throw new Error("Could not straighten the photo");
  void srcW;
  void srcH;
  return blob;
}

export async function fileFromWarp(image: CanvasImageSource, srcW: number, srcH: number, corners: Pt[], kind: PaperKind): Promise<File> {
  const blob = await warpPaper(image, srcW, srcH, corners, kind);
  return new File([blob], "aligned-paper.jpg", { type: "image/jpeg" });
}

/** Downscale, find paper, map corners back to the full photo. */
export async function analyzeBitmap(bitmap: ImageBitmap, sheetOnly: boolean): Promise<DetectedPaper> {
  const maxW = 360;
  const scale = bitmap.width > maxW ? maxW / bitmap.width : 1;
  const sw = Math.max(20, Math.round(bitmap.width * scale));
  const sh = Math.max(20, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { corners: defaultCorners(bitmap.width, bitmap.height), kind: "unknown", confident: false };
  ctx.drawImage(bitmap, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  const gray = new Uint8Array(sw * sh);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = (data[i] * 54 + data[i + 1] * 183 + data[i + 2] * 19) >> 8;
  }
  const found = detectPaper(gray, sw, sh);
  if (!found) {
    return { corners: defaultCorners(bitmap.width, bitmap.height), kind: "unknown", confident: false };
  }
  const sx = bitmap.width / sw;
  const sy = bitmap.height / sh;
  const corners = found.corners.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  let kind = classifySheet(corners);
  let confident = found.confident;
  if (sheetOnly && kind === "receipt") {
    kind = "unknown";
    confident = false;
  }
  if (sheetOnly && (kind === "letter" || kind === "half" || kind === "legal")) confident = found.confident;
  return { corners, kind, confident };
}
