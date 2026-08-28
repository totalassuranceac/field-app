/**
 * One-shot: build seed-pto-log.sql + tmp-pto-log-rows.json from sheet Time Off Log.
 * Run: node scripts/gen-pto-log-seed.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const raw = `DATE USED,NAME,VACATION USED,SICK USED,APPROVED BY,NOTES
10/15/2025,John J Alvarado,,8,Chris Marroquin,Migration to new list
10/15/2025,Adam M Bosquez,40,13,Chris Marroquin,Migration to new list
10/15/2025,Omar J Camacho,120,48,Chris Marroquin,Migration to new list
10/15/2025,Kelsie M Gomez,16,38,Chris Marroquin,Migration to new list
10/15/2025,Geovany Montes,32,5,Chris Marroquin,Migration to new list
10/15/2025,Humberto Ortiz,8,8,Chris Marroquin,Migration to new list
10/15/2025,Bianca M Ramirez,80,40,Chris Marroquin,Migration to new list
10/15/2025,Warren T Engle,64,20,Chris Marroquin,Migration to new list
10/15/2025,Justin D Lyles,80,40,Chris Marroquin,Migration to new list
10/15/2025,Jonathan L Willie,62,40,Chris Marroquin,Migration to new list
10/15/2025,Michael Casarez,0,10,Chris Marroquin,Migration to new list
10/15/2025,Jaden De La Garza,40,40,Chris Marroquin,Migration to new list
10/15/2025,Roberto F Gonzalez,48,24,Chris Marroquin,Migration to new list
10/15/2025,Arin R Ramirez,2,40,Chris Marroquin,Migration to new list
10/15/2025,Marcus T Tovar,16,30,Chris Marroquin,Migration to new list
10/15/2025,Kai G Woodruff,40,48,Chris Marroquin,Migration to new list
10/15/2025,Abelardo Herrera,,31,Chris Marroquin,Migration to new list
10/15/2025,Wayne McCaskill,,37,Chris Marroquin,Migration to new list
10/17/2025,Kenneth Marroquin Jr,,6,Chris Marroquin,per employee request
10/17/2025,Abelardo Herrera,,7,Chris Marroquin,per employee request
10/17/2025,John J Alvarado,,2,Chris Marroquin,per employee request
10/17/2025,John Williams,,10,Chris Marroquin,per employee request
10/17/2025,Jonathan L Willie,,3,Chris Marroquin,per employee request
10/17/2025,Michael Casarez,,16,Chris Marroquin,per employee request
10/21/2025,Arin R Ramirez,,8,Chris Marroquin,per employee request
10/21/2025,Roberto F Gonzalez,,7,Chris Marroquin,per employee request
10/24/2025,Geovany Montes,10,,Chris Marroquin,per employee request
10/24/2021,Humberto Ortiz,8,,Chris Marroquin,per employee request
10/24/2025,Jonathan L Willie,6,,Chris Marroquin,per employee request
10/24/2025,Kenneth Marroquin Jr,,23,Chris Marroquin,per employee request
10/24/2025,Marcus T Tovar,,8,Chris Marroquin,per employee request
10/24/2025,Michael Casarez,,2,Chris Marroquin,per employee request
10/24/2025,Roberto F Gonzalez,,7,Chris Marroquin,per employee request
10/28/2025,Bianca M Ramirez,80,40,Chris Marroquin,Reimbursement for Maternity Leave
10/28/2025,John J Alvarado,,8,Chris Marroquin,per employee request
10/28/2025,Warren T Engle,,8,Chris Marroquin,per employee request
10/28/2025,Kenneth Marroquin Jr,,5,Chris Marroquin,per employee request
10/28/2025,Adam M Bosquez,,5,Chris Marroquin,per employee request
10/28/2025,Abelardo Herrera,8,2,Chris Marroquin,per employee request
11/3/2025,Jonathan L Willie,8,,Chris Marroquin,per employee request
11/3/2025,Arin R Ramirez,20,,Chris Marroquin,per employee request
11/3/2025,Adam M Bosquez,6,,Chris Marroquin,per employee request
11/03/25,Wayne McCaskill,6,,Chris Marroquin,per employee request
11/03/2025,Marcus T Tovar,6,,Chris Marroquin,per employee request
11/05/25,John J Alvarado,,1,Chris Marroquin,per employee request
11/10/2025,Kai G Woodruff,,8,Chris Marroquin,per employee request
11/10/2025,Humberto Ortiz,8,,Chris Marroquin,per employee request
11/10/2025,Marcus T Tovar,18,2,Chris Marroquin,per employee request
11/10/2025,John J Alvarado,3,21,Chris Marroquin,per employee request
11/10/2025,Roberto F Gonzalez,12,2,Chris Marroquin,per employee request
11/10/2025,Warren T Engle,,6,Chris Marroquin,per employee request
11/10/2025,John Williams,,8,Chris Marroquin,per employee request
11/10/2025,Jonathan L Willie,4,,Chris Marroquin,per employee request
11/10/2025,Wayne McCaskill,4,3,Chris Marroquin,per employee request
11/10/2025,Kenneth Marroquin Jr,,6,Chris Marroquin,per employee request
11/10/2025,Adam M Bosquez,16,,Chris Marroquin,per employee request
11/11/2025,Warren T Engle,,2,Chris Marroquin,underpaid 2hrs so Eric gave him cash
11/17/2025,Arin R Ramirez,11,,Chris Marroquin,per employee request
11/17/2025,Roberto F Gonzalez,3,,Chris Marroquin,per employee request
11/17/2025,Humberto Ortiz,7,,Chris Marroquin,per employee request
11/17/2025,John J Alvarado,2,,Chris Marroquin,per employee request
11/17/2025,Michael Casarez,,12,Chris Marroquin,per employee request
11/17/2025,Warren T Engle,2,4,Chris Marroquin,per employee request
11/17/2025,John Williams,,8,Chris Marroquin,per employee request
11/18/2025,Adam M Bosquez,,3,Chris Marroquin,per employee request
11/24/25,Abelardo Herrera,8,,Chris Marroquin,per employee request
11/24/2025,Geovany Montes,,4,Chris Marroquin,per employee request
11/24/2025,Kenneth Marroquin Jr,8,,Chris Marroquin,per employee request
11/24/2025,Roberto F Gonzalez,1,,Chris Marroquin,per employee request
11/24/2025,Warren T Engle,3,,Chris Marroquin,per employee request
12/01/25,John J Alvarado,5,,Chris Marroquin,per employee request
12/01/2025,Michael Casarez,8,,Chris Marroquin,per employee request
12/01/2025,Roberto F Gonzalez,16,,Chris Marroquin,per employee request
12/01/2025,Kelsie M Gomez,10,2,Chris Marroquin,per employee request
12/01/2025,Geovany Montes,,8,Chris Marroquin,per employee request
12/01/2025,Wayne McCaskill,8,,Chris Marroquin,per employee request
12/01/2025,Humberto Ortiz,,11,Chris Marroquin,per employee request
12/01/2025,Arin R Ramirez,12,,Chris Marroquin,per employee request
12/01/2025,Warren T Engle,15,,Chris Marroquin,per employee request
12/04/2025,Abelardo Herrera,,8,Chris Marroquin,per employee request
12/09/2025,Humberto Ortiz,,2,Chris Marroquin,per employee request
12/09/2025,Geovany Montes,,7,Chris Marroquin,per employee request
12/09/2025,John Williams,,3,Chris Marroquin,per employee request
12/16/2025,Michael Casarez,5,,Chris Marroquin,per employee request
12/16/2025,Warren T Engle,3,,Chris Marroquin,per employee request
12/16/2025,Kelsie M Gomez,16,,Chris Marroquin,per employee request
12/16/2025,Humberto Ortiz,6,19,Chris Marroquin,per employee request
12/16/2025,Arin R Ramirez,2,,Chris Marroquin,per employee request
12/16/2025,John Williams,,5,Chris Marroquin,per employee request
12/16/2025,Wayne McCaskill,16,,Chris Marroquin,per employee request
12/12/2025,Warren T Engle,12,,Chris Marroquin,per employee request
12/15/2025,Kai G Woodruff,8,,Chris Marroquin,per employee request
12/16/2025,Kai G Woodruff,8,,Chris Marroquin,per employee request
12/22/2025,Arin R Ramirez,1,,Chris Marroquin,per employee request
12/22/2025,Jonathan L Willie,,32,Chris Marroquin,per employee request
12/22/2025,Geovany Montes,,6,Chris Marroquin,per employee request
12/29/2025,Jonathan L Willie,,8,Chris Marroquin,per employee request
12/29/2025,John J Alvarado,7,,Chris Marroquin,per employee request
12/29/2025,Michael Casarez,24,,Chris Marroquin,per employee request
12/29/2025,Kenneth Marroquin Jr,9,,Chris Marroquin,per employee request
12/29/2025,Geovany Montes,8,,Chris Marroquin,per employee request
12/29/2025,Humberto Ortiz,17,,Chris Marroquin,per employee request
12/29/2025,Charles Dickerson,11,,Chris Marroquin,per employee request
12/29/2025,Warren T Engle,10,,Chris Marroquin,per employee request
12/29/2025,Arin R Ramirez,8,,Chris Marroquin,per employee request
12/29/2025,Wayne McCaskill,6,,Chris Marroquin,per employee request
01/06/26,Charles Dickerson,,8,Chris Marroquin,per employee request
01/06/26,Warren T Engle,10,,Chris Marroquin,per employee request
01/06/26,Abelardo Herrera,8,,Chris Marroquin,per employee request
01/06/26,Geovany Montes,32,,Chris Marroquin,per employee request
01/06/26,Humberto Ortiz,12,,Chris Marroquin,per employee request
01/06/26,Arin R Ramirez,4,,Chris Marroquin,per employee request
01/06/26,John Williams,,6,Chris Marroquin,per employee request
01/13/26,Michael Casarez,3,,Chris Marroquin,per employee request
01/13/26,Warren T Engle,1,,Chris Marroquin,per employee request
01/13/26,Geovany Montes,8,5,Chris Marroquin,per employee request
01/13/26,Humberto Ortiz,7,,Chris Marroquin,per employee request
01/13/26,Arin R Ramirez,,7,Chris Marroquin,per employee request
01/13/26,John Williams,8,,Chris Marroquin,per employee request
01/13/26,Kai G Woodruff,,4,Chris Marroquin,per employee request
01/13/26,Marcus T Tovar,,2,Chris Marroquin,per employee request
01/20/26,Adam M Bosquez,8,,Chris Marroquin,per employee request
01/20/26,Kenneth Marroquin Jr,7,,Chris Marroquin,per employee request
01/20/26,Geovany Montes,,4,Chris Marroquin,per employee request
01/20/26,Humberto Ortiz,13,,Chris Marroquin,per employee request
01/20/26,John J Alvarado,6,,Chris Marroquin,per employee request
01/20/26,Jonathan L Willie,3,,Chris Marroquin,per employee request
01/20/26,Marcus T Tovar,,3,Chris Marroquin,per employee request
01/26/26,John J Alvarado,32,,Chris Marroquin,per employee request
01/26/26,Kirk Crumbly,,8,Chris Marroquin,per employee request
01/26/26,Humberto Ortiz,3,,Chris Marroquin,per employee request
01/26/26,Arin R Ramirez,20,,Chris Marroquin,per employee request
1/26/26,Geovany Montes,4,1,Chris Marroquin,per employee request
01/26/26,Marcus T Tovar,,8,Chris Marroquin,per employee request
01/16/26,John Williams,19,,Chris Marroquin,per employee request
01/16/26,Jonathan L Willie,27,,Chris Marroquin,per employee request
02/04/26,John J Alvarado,6,,Chris Marroquin,per employee request
02/04/2026,Michael Casarez,,4,Chris Marroquin,per employee request
02/04/26,Warren T Engle,,5,Chris Marroquin,per employee request
02/04/26,Kelsie M Gomez,16,,Chris Marroquin,per employee request
02/04/26,Geovany Montes,16,,Chris Marroquin,per employee request
02/04/26,Humberto Ortiz,29,,Chris Marroquin,per employee request
02/04/26,Marcus T Tovar,,6,Chris Marroquin,per employee request
02/04/26,Arin R Ramirez,,0,Chris Marroquin,per employee request
02/04/26,Adam M Bosquez,16,,Chris Marroquin,per employee request
02/04/26,John Williams,13,,Chris Marroquin,per employee request
02/09/26,Kirk Crumbly,,1,Chris Marroquin,per employee request
02/09/26,John J Alvarado,16,,Chris Marroquin,per employee request
02/09/26,Warren T Engle,,11,Chris Marroquin,per employee request
02/09/26,Kelsie M Gomez,5,,Chris Marroquin,per employee request
02/09/26,Kenneth Marroquin Jr,3,,Chris Marroquin,per employee request
02/09/26,Geovany Montes,10,,Chris Marroquin,per employee request
02/09/26,Adam M Bosquez,,8,Chris Marroquin,per employee request
02/09/26,Jonathan L Willie,18,,Chris Marroquin,per employee request
02/09/26,Kai G Woodruff,,28,Chris Marroquin,per employee request
02/09/26,Humberto Ortiz,10,,Chris Marroquin,per employee request
02/16/26,Kelsie M Gomez,,8,Chris Marroquin,per employee request
02/16/26,Kenneth Marroquin Jr,7,,Chris Marroquin,per employee request
02/16/26,Marcus T Tovar,,11,Chris Marroquin,per employee request
02/16/26,Jonathan L Willie,32,,Chris Marroquin,per employee request
02/16/26,John J Alvarado,14,,Chris Marroquin,per employee request
02/16/26,Kai G Woodruff,26,,Chris Marroquin,per employee request
02/16/26,Warren T Engle,,3,Chris Marroquin,per employee request
02/23/26,John J Alvarado,4,,Chris Marroquin,per employee request
02/23/26,Kirk Crumbly,8,,Chris Marroquin,per employee request
02/23/26,Warren T Engle,,1,Chris Marroquin,per employee request
02/24/26,Charles Dickerson,,1,Chris Marroquin,per employee request
03/02/26,Charles Dickerson,,2,Chris Marroquin,per employee request
03/04/26,John J Alvarado,,4,Chris Marroquin,per employee request
03/04/26,Kirk Crumbly,,8,Chris Marroquin,per employee request
03/16/26,Arin R Ramirez,,8,Chris Marroquin,per employee request
03/16/26,Charles Dickerson,,4,Chris Marroquin,per employee request
03/16/26,John J Alvarado,8,,Chris Marroquin,per employee request
03/20/26,Kai G Woodruff,13,,Chris Marroquin,per employee request
03/20/26,John J Alvarado,6,,Chris Marroquin,per employee request
03/20,Kelsie M Gomez,9,,Chris Marroquin,per employee request
03/20/26,Marcus T Tovar,2,,Chris Marroquin,per employee request
03/20/26,Warren T Engle,,14,Chris Marroquin,per employee request
03/23/26,Kenneth Marroquin Jr,6,,Chris Marroquin,per employee request
03/23/26,Kai G Woodruff,12,,Chris Marroquin,per employee request
03/23/26,Marcus T Tovar,,10,Chris Marroquin,per employee request
04/03/26,Arin R Ramirez,,6,Chris Marroquin,per employee request
04/03/26,Kai G Woodruff,5,,Chris Marroquin,per employee request
04/03/26,Wayne McCaskill,,16,Chris Marroquin,per employee request
04/10/26,John J Alvarado,6,,Chris Marroquin,per employee request
04/10/26,Warren T Engle,10,6,Chris Marroquin,per employee request
04/10/26,Kelsie M Gomez,,8,Chris Marroquin,per employee request
04/10/26,Wayne McCaskill,,16,Chris Marroquin,per employee request
04/10/26,Arin R Ramirez,,8,Chris Marroquin,per employee request
04/10/26,Kai G Woodruff,8,,Chris Marroquin,per employee request
04/10/26,Nathaniel Torres,,8,Chris Marroquin,per employee request
04/17/26,Warren T Engle,5,,Chris Marroquin,per employee request
04/17/26,Kyle Duffield,,8,Chris Marroquin,per employee request
04/17/26,Kirk Crumbly,,9,Chris Marroquin,per employee request
04/24/26,Kelsie M Gomez,6,,Chris Marroquin,per employee request
05/08/26,Justin D Lyles,,8,Chris Marroquin,per employee request
05/08/26,Nathaniel Torres,,16,Chris Marroquin,per employee request
05/15/26,Arin R Ramirez,,2,Chris Marroquin,per employee request
05/23.26,Wayne McCaskill,,8,Chris Marroquin,per employee request
05/23/26,Nathaniel Torres,,16,Chris Marroquin,per employee request
05/23/26,Marcus T Tovar,8,,Chris Marroquin,per employee request
05/23/26,Kelsie M Gomez,2,,Chris Marroquin,per employee request
05/26/26,Warren T Engle,7,,Chris Marroquin,per employee request
05/26/26,Charles Dickerson,,4,Chris Marroquin,per employee request
05/26/26,Arin R Ramirez,,9,Chris Marroquin,per employee request
06/05/26,Arin R Ramirez,,3,Chris Marroquin,per employee request
06/05/26,Charles Dickerson,,4,Chris Marroquin,Chris
06/05/2026,Bianca M Ramirez,,31,Chris Marroquin,Bianca Sick Pay Advancement
06/12/26,Arin R Ramirez,3,4,Chris Marroquin,per employee request
06/12/26,Charles Dickerson,,6,Chris Marroquin,per employee request
06/12/26,Kelsie M Gomez,6,,Chris Marroquin,per employee request
06/12/26,Kirk Crumbly,32,14,Chris Marroquin,per employee request
06/19/25,Nathaniel Torres,25,,Chris Marroquin,per employee request
06/27/26,Arin R Ramirez,7,,Chris Marroquin,per employee request
06/27/26,John J Alvarado,5,,Chris Marroquin,per employee request
06/27/26,Nathaniel Torres,22,,Chris Marroquin,per employee request
06/25/26,Roberto F Gonzalez,16,,Chris Marroquin,per employee request
07/14/26,Abelardo Herrera,16,,Chris Marroquin,per employee request
07/24/26,Jaden De La Garza,,6,Chris Marroquin,per employee request
07/24/26,Kelsie M Gomez,,11,Chris Marroquin,per employee request
07/24/26,Roberto F Gonzalez,,8,Chris Marroquin,per employee request
07/31/26,Jaden De La Garza,,12,Chris Marroquin,per employee request
07/31/26,Kyle Duffield,25,,Chris Marroquin,per employee request
07/31/26,Marcus T Tovar,2,,Chris Marroquin,per employee request
07/31/26,Arin R Ramirez,9,,Chris Marroquin,per employee request
07/31/26,Roberto F Gonzalez,,2,Chris Marroquin,per employee request
08/07/26,Warren T Engle,8,,Chris Marroquin,per employee request
08/07/26,Noah Maxwell,,2,Chris Marroquin,per employee request
08/14/26,John J Alvarado,,8,Chris Marroquin,per employee request
08/14/26,Noah Maxwell,,5,Chris Marroquin,per employee request
08/14/26,Roberto F Gonzalez,,8,Chris Marroquin,per employee request
08/21/26,Humberto Ortiz,,7,Chris Marroquin,per employee request`;

/** Sheet full name → Field App employees.id (active roster nicknames). */
const idBySheet = {
  "Abelardo Herrera": 2,
  "Adam M Bosquez": 4,
  "Arin R Ramirez": 5,
  "Bianca M Ramirez": 23,
  "Charles Dickerson": 22,
  "Geovany Montes": 28,
  "Humberto Ortiz": 15,
  "Jaden De La Garza": 25,
  "John J Alvarado": 10,
  "Justin D Lyles": 1,
  "Kai G Woodruff": 8,
  "Kelsie M Gomez": 21,
  "Kenneth Marroquin Jr": 20,
  "Kirk Crumbly": 3,
  "Marcus T Tovar": 13,
  "Michael Casarez": 11,
  "Nathaniel Torres": 30,
  "Omar J Camacho": 6,
  "Roberto F Gonzalez": 7,
  "Warren T Engle": 12,
  "Wayne McCaskill": 14,
  "John Williams": 9,
  "Kyle Duffield": 18,
  "Noah Maxwell": 31,
};

function parseDate(s) {
  s = String(s || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return `${y}-${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  }
  // Bare MM/DD — assume 2026 (sheet year for incomplete cells like 03/20)
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    return `2026-${String(Number(m[1])).padStart(2, "0")}-${String(Number(m[2])).padStart(2, "0")}`;
  }
  return null;
}

function esc(s) {
  return String(s || "").replace(/'/g, "''");
}

const lines = raw.trim().split(/\n/).slice(1);
const inserts = [];
const unmatched = new Set();
const badDates = [];
let vacN = 0;
let sickN = 0;
const tsRows = [];

for (const line of lines) {
  if (!line.trim()) continue;
  const parts = line.split(",");
  const dateRaw = parts[0];
  const name = parts[1];
  const vac = parts[2] === "" || parts[2] == null ? 0 : Number(parts[2]);
  const sick = parts[3] === "" || parts[3] == null ? 0 : Number(parts[3]);
  const approvedBy = parts[4] || "";
  const notes = parts.slice(5).join(",") || "";
  const iso = parseDate(dateRaw);
  if (!iso) {
    badDates.push(`${dateRaw} ${name}`);
    continue;
  }
  tsRows.push({
    date_used: dateRaw,
    name,
    vacation_used: vac || 0,
    sick_used: sick || 0,
    approved_by: approvedBy,
    notes,
  });
  const eid = idBySheet[name];
  if (!eid) {
    unmatched.add(name);
    continue;
  }
  const note = (
    "Sheet log · " +
    (notes || "usage") +
    (approvedBy ? ` · by ${approvedBy}` : "")
  ).slice(0, 240);
  if (vac && Number.isFinite(vac) && vac !== 0) {
    inserts.push(
      `INSERT INTO pto_ledger (employee_id, entry_date, kind, hours, source, note) VALUES (${eid}, '${iso}', 'vacation', ${vac}, 'import', '${esc(note)}');`
    );
    vacN++;
  }
  if (sick && Number.isFinite(sick) && sick !== 0) {
    inserts.push(
      `INSERT INTO pto_ledger (employee_id, entry_date, kind, hours, source, note) VALUES (${eid}, '${iso}', 'sick', ${sick}, 'import', '${esc(note)}');`
    );
    sickN++;
  }
}

const sqlPath = path.join(root, "scripts", "seed-pto-log.sql");
const jsonPath = path.join(root, "tmp-pto-log-rows.json");
fs.writeFileSync(
  sqlPath,
  [
    "-- PTO Time Off Log → pto_ledger (does NOT change balances)",
    "-- Idempotent: removes prior Sheet log import rows first",
    "DELETE FROM pto_ledger WHERE source = 'import' AND note LIKE 'Sheet log%';",
    ...inserts,
    "",
  ].join("\n")
);
fs.writeFileSync(jsonPath, JSON.stringify(tsRows, null, 2));

console.log(
  JSON.stringify(
    {
      vacN,
      sickN,
      inserts: inserts.length,
      unmatched: [...unmatched],
      badDates,
      sqlPath,
      jsonPath,
    },
    null,
    2
  )
);
