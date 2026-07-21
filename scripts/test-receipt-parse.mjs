// Quick parser checks against Stripes / Circle K sample layouts
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";

// Compile-free: duplicate minimal re-export by dynamic import of built path won't work.
// Use tsx if available, else eval transpile-free by reading and using Function — better: copy parser logic test via vite-node or npx tsx.

const samples = {
  stripes2213: `STRIPES #2213
6801 Everhart
DSL CR #13   29.531G   116.62
SELF @ 3.949 / G
TOTAL   116.62
USD$116.62
************1599
ST#2213
7/2/26 5:57:28 PM`,
  stripesPrepay: `Welcome To
Stripes 2221
***PRE-AUTHORIZED RECEIPT***
PREPAY CR #11    65.00
TOTAL  65.00
Acct/Card #: ***********5959
ST#2221
4/14/26 8:15:46 AM`,
  stripesGallons: `Welcome to
Stripes 2221
DATE 3/16/26 8:36
TRAN#9076976
GALLONS:  13.246
PRICE/G   $3.319
FUEL SALE  $43.96
CREDIT DE  $43.96
************0340`,
  circleK: `12/22/2025 8:28:20 AM
Circle K  2741849
2202 Holly Rd
16.238 Gallons @ $2.799/Gal  $45.45
Total:  $45.45
XXXXXXXXXXXX5017
12/22/2025 08:27:59`,
  circleK2: `2/20/2026 15:05:4
Circle K  2741135
Gallons   21.710
PRICE/G  $2.469
TOTAL SALE  $53.60
XXXXXXXXXXXX0028
02/20/2026 14:59:56`,
  sevenEleven: `OH THANK HEAVEN
FOR 7-ELEVEN
4222 RODD FIELD RD
CORPUS CHRISTI TX
STORE:42009
PHONE:3615009349
RUL
21 GAL @ 2.319 /GAL     49.91
FUEL TO     $49.91
SUB TOTAL   $49.91
CREDIT     $49.91
SALE
VISA
************6069
AUTH:000048`,
  sevenElevenNoQty: `7-ELEVEN
STORE:42009
GAL @ 2.319 /GAL     49.91
FUEL TO  $49.91
CREDIT   $49.91
************6069`,
  circleKBlurry: `2/20/2026 15:05:4
Circle K 2741135
4502 E Causeway Blvd
UNL-REG
Gallons  21.710
PRICE/G  $2.469
TOTAL FUEL  $53.60
TOTAL SALE  $53.60
XXXXXXXXXXXX0028
Chip Read
02/20/2026 14:59:56`,
  // Real scan that previously returned store "KKK" from masked Store # *****
  stripes2221MaskedStore: `Welcome to
Stripes 2221
6418 Weber Rd
Corpus Christi, TX
DATE 1/29/26 8:00
TRAN#9124353
PUMP# 12
GALLONS:  20.890
PRICE/G:  $2.669
FUEL SALE  $55.76
CREDIT DE  $55.76
USD$55.76
************6069
Store # ***************
****`,
  stripesOcrJunkStore: `Welcome to
Stripes 2221
GALLONS: 20.890
TOTAL $55.76
Store # KKK
ST#2221`,
  // Card last4 variants OCR often produces
  cardStars6069: `Stripes 2221
GALLONS: 20.890
CREDIT DE $55.76
USD$55.76
************6069
Entry: Contactless`,
  cardXocr6069: `Stripes 2221
USD$55.76
xxxxxxxxxxxx6069
VISA`,
  cardSpaced6069: `Stripes 2221
CREDIT DE $55.76
USD$55.76
****** **** 6069
CC`,
  cardOcrKmask: `Stripes 2221
USD$55.76
kkkkkkkkkkkk6069
Entry: Contactless`,
  // Total OCR drop leading 5: $5.76 instead of $55.76 — recover via gal × price
  totalTruncated576: `Welcome to
Stripes 2221
DATE 1/29/26 8:00
GALLONS:  20.890
PRICE/G:  $2.669
FUEL SALE  $5.76
CREDIT DE  $5.76
USD$5.76
************6069`,
  totalCorrect5576: `Welcome to
Stripes 2221
DATE 1/29/26 8:00
GALLONS:  20.890
PRICE/G:  $2.669
FUEL SALE  $55.76
CREDIT DE  $55.76
USD$55.76
************6069`,
  cardBareAfterUsd: `Stripes 2221
GALLONS: 20.890
PRICE/G: $2.669
FUEL SALE $55.76
USD$55.76
6069
Entry: Contactless`,
};

// Import from dist won't work. Use npx tsx.
const { parseReceiptText } = await import("../src/receiptOcr.ts");

for (const [name, text] of Object.entries(samples)) {
  const r = parseReceiptText(text);
  console.log(name, {
    date: r.fuel_date,
    time: r.fuel_time,
    gal: r.gallons,
    total: r.total_cost,
    store: r.store_number,
    card: r.card_last4,
    conf: r.confidence,
    retake: r.needs_retake,
    prepay: r.is_prepay,
  });
}
