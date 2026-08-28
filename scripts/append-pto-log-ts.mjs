import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const rows = JSON.parse(fs.readFileSync(path.join(root, "tmp-pto-log-rows.json"), "utf8"));
const target = path.join(root, "src", "ptoSheetImport.ts");
let src = fs.readFileSync(target, "utf8");
if (src.includes("export const PTO_SHEET_LOG")) {
  console.log("PTO_SHEET_LOG already present — skipping");
  process.exit(0);
}
const body = rows
  .map(
    (r) =>
      `  { date_used: ${JSON.stringify(r.date_used)}, name: ${JSON.stringify(r.name)}, vacation_used: ${Number(r.vacation_used) || 0}, sick_used: ${Number(r.sick_used) || 0}, approved_by: ${JSON.stringify(r.approved_by)}, notes: ${JSON.stringify(r.notes)} },`
  )
  .join("\n");
const append = `
export type PtoLogImportRow = {
  date_used: string;
  name: string;
  vacation_used?: number;
  sick_used?: number;
  approved_by?: string;
  notes?: string;
};

/** Time Off Log tab from the same PTO Tracker sheet (ledger history — does not change balances). */
export const PTO_SHEET_LOG: PtoLogImportRow[] = [
${body}
];
`;
fs.writeFileSync(target, src.trimEnd() + "\n" + append);
console.log("Appended", rows.length, "log rows to ptoSheetImport.ts");
