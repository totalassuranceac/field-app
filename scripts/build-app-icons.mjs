/**
 * Build polished Total Assurance Fleet app icons.
 * Light blue A + brand red swoosh on dark navy tile, centered, peer-app scale.
 */
import sharp from "sharp";
import { writeFileSync } from "fs";

const full = await sharp("public/logo-source.jpg")
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const d = full.data;
const W = full.info.width;
const H = full.info.height;
const white = (i) => d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248;

let minX = W,
  minY = H,
  maxX = 0,
  maxY = 0;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (!white((y * W + x) * 4)) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
}

let gap = null;
for (let x = minX + 80; x < W * 0.4; x++) {
  let rows = 0;
  for (let y = minY; y <= maxY; y++) {
    if (!white((y * W + x) * 4)) rows++;
  }
  if (rows / (maxY - minY + 1) < 0.012) {
    gap = x;
    break;
  }
}

const mL = minX;
const mT = minY;
const mR = (gap ?? Math.round(W * 0.3)) - 4;
const mB = maxY;
const mw = mR - mL + 1;
const mh = mB - mT + 1;

const crop = await sharp("public/logo-source.jpg")
  .extract({ left: mL, top: mT, width: mw, height: mh })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const cd = crop.data;
const cw = crop.info.width;
const ch = crop.info.height;

// Clean palette for dark home-screen tiles
const LIGHT_A = { r: 130, g: 200, b: 245 };
const RED = { r: 225, g: 25, b: 35 };
const STROKE = { r: 14, g: 18, b: 28 };

const rgba = Buffer.alloc(cw * ch * 4);
let cMinX = cw,
  cMinY = ch,
  cMaxX = 0,
  cMaxY = 0;

for (let y = 0; y < ch; y++) {
  for (let x = 0; x < cw; x++) {
    const i = (y * cw + x) * 4;
    let r = cd[i];
    let g = cd[i + 1];
    let b = cd[i + 2];

    if (r > 248 && g > 248 && b > 248) {
      rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
      continue;
    }

    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const sat = maxc === 0 ? 0 : (maxc - minc) / maxc;

    const isRed = r > 130 && r > g * 1.4 && r > b * 1.4;
    const isWhiteStripe = lum > 200 && sat < 0.15;
    const isBlackStripe = lum < 70 && sat < 0.35;
    const isA =
      !isRed &&
      !isWhiteStripe &&
      !isBlackStripe &&
      ((b > r && lum < 160) || (r < 90 && g < 110 && b < 140));

    if (isRed) {
      const t = Math.min(1, Math.max(0.75, lum / 110));
      r = Math.round(Math.min(255, RED.r * t + 15));
      g = Math.round(RED.g * t);
      b = Math.round(RED.b * t);
    } else if (isWhiteStripe) {
      // Upper wave becomes light blue on dark tile
      r = LIGHT_A.r;
      g = LIGHT_A.g;
      b = 255;
    } else if (isBlackStripe) {
      r = STROKE.r;
      g = STROKE.g;
      b = STROKE.b;
    } else if (isA) {
      // Navy A → bright light blue (clean on dark bg)
      const t = Math.min(1.1, Math.max(0.85, (lum + 50) / 95));
      r = Math.min(255, Math.round(LIGHT_A.r * t));
      g = Math.min(255, Math.round(LIGHT_A.g * t));
      b = Math.min(255, Math.round(LIGHT_A.b * t + 5));
    }

    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = 255;
    if (x < cMinX) cMinX = x;
    if (y < cMinY) cMinY = y;
    if (x > cMaxX) cMaxX = x;
    if (y > cMaxY) cMaxY = y;
  }
}

const pad = 8;
const tL = Math.max(0, cMinX - pad);
const tT = Math.max(0, cMinY - pad);
const tW = Math.min(cw - tL, cMaxX - cMinX + 1 + pad * 2);
const tH = Math.min(ch - tT, cMaxY - cMinY + 1 + pad * 2);

// Hi-res transparent mark
const mark = await sharp(rgba, { raw: { width: cw, height: ch, channels: 4 } })
  .extract({ left: tL, top: tT, width: tW, height: tH })
  .resize(Math.round(tW * 4), Math.round(tH * 4), { kernel: "lanczos3" })
  .png()
  .toBuffer();

const markMeta = await sharp(mark).metadata();
const mw2 = markMeta.width;
const mh2 = markMeta.height;
await sharp(mark).toFile("public/logo-mark-raw.png");
console.log("mark", mw2, "x", mh2);

// App chrome navy
const BG = { r: 12, g: 18, b: 32, alpha: 1 };

async function makeIcon(size, marginFrac, outPath) {
  const maxInner = Math.floor(size * (1 - 2 * marginFrac));
  const scale = Math.min(maxInner / mw2, maxInner / mh2);
  const lw = Math.max(1, Math.round(mw2 * scale));
  const lh = Math.max(1, Math.round(mh2 * scale));
  const logo = await sharp(mark)
    .resize(lw, lh, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const left = Math.floor((size - lw) / 2);
  const top = Math.floor((size - lh) / 2);

  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, left, top }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);

  console.log(outPath, {
    fill: ((Math.max(lw, lh) / size) * 100).toFixed(0) + "%",
    lw,
    lh,
    pad: {
      L: left,
      R: size - left - lw,
      T: top,
      B: size - top - lh,
    },
  });
}

// ~90% fill — matches Grok / X / YouTube home-screen scale
await makeIcon(192, 0.05, "public/icon-192.png");
await makeIcon(512, 0.05, "public/icon-512.png");
await makeIcon(512, 0.11, "public/icon-maskable-512.png");
await makeIcon(180, 0.05, "public/apple-touch-icon.png");
await makeIcon(192, 0.05, "public/logo-mark.png");
await makeIcon(48, 0.04, "public/favicon-48.png");

console.log("Polished app icons written.");
