# Tool loan ledger — low-error design (with signed forms)

Based on your paper form **TOOL LOAN REQUEST AND AGREEMENT** and Excel tracker.

## Form terms (from PDF)

- Loan cannot exceed **3/4 of average weekly earnings**
- Employee employed **≥ 3 months** before loan
- Default repayment: **$50/week** payroll deduction until paid
- On termination: balance from final pay / PTO / other comps; remainder due in **15 days**
- Fields: loan description, amount, weekly deduction, employee signature + printed name, supervisor approval, date

## Goals

1. Accurate money ledger (charges / payments / balances) — **no silent deletes**
2. Employee sees only **their** balance (Phase 2)
3. Office prints a **signature-ready agreement** for the employee file
4. Store **signed PDFs** on the person (digital employee folder for loans)
5. **Batch upload** old signed forms / receipts and attach to the right person

## Recommended architecture

### A. Money (already started)

| Table | Purpose |
|-------|---------|
| `tool_loan_people` | Person (linked user or former) |
| `tool_loan_charges` | Purchases / carried balances |
| `tool_loan_payments` | Payroll / spiff / other |
| Balance | Always `SUM(charges) − SUM(payments)` |

Rules:

- Append-only; **void** only (with reason + who + when)
- Former employees keep rows forever
- Weekly CSV for owner from open balances + weekly deduction

### B. Agreements & documents (next build)

| Table | Purpose |
|-------|---------|
| `tool_loan_agreements` | One row per signed (or pending signature) agreement |
| Fields | person_id, charge_id(s), amount, weekly_deduction, description, status (`draft` / `printed` / `signed` / `filed`), signed_at, storage_key, uploaded_by, created_at |

Storage: same as receipts today — **R2 if bound**, else **D1 `receipt_blobs`**, folder prefix e.g. `tool-loan-forms/{person_id}/`.

### C. Printable form (browser → PDF)

1. Office enters loan (description, amount, weekly $).
2. App generates a **print page** matching your PDF wording (company terms locked; fields filled).
3. Print → sign on paper → scan/photo → **Upload signed copy** to that agreement.
4. Optional later: e-sign (DocuSign/HelloSign) — not required for Phase 1.5.

### D. Batch upload of old signed forms

**Option 1 — Filename convention (simplest, least error)**  
Upload many PDFs named like:

`2024-11-13_Joseph-Valdez_192.20.pdf`  
`LastFirst_YYYY-MM-DD_amount.pdf`

Importer parses name → match `tool_loan_people` (same alias map) → attach file; unmatched go to **Review queue**.

**Option 2 — One folder ZIP + review UI**  
Upload ZIP → list files → dropdown person for each → Save. Safer when names don’t match.

**Option 3 — OCR / AI later**  
Read printed name from scan. Higher effort; use after manual batch works.

**Recommendation:** Option 1 + Option 2 review queue (low error, works with your Dropbox pile).

### E. Error-proofing checklist

| Control | Why |
|---------|-----|
| No hard delete of money rows | Balances can’t “disappear” |
| Void requires reason | Audit trail |
| Dual confirmation on void of large amounts | e.g. > $200 |
| Import is idempotent (`import_key`) | Safe re-upload of Excel |
| Print agreement locked terms | Matches legal form language |
| Signed PDF required before “active” loan (optional policy) | Paper trail in system |
| Office-only money + documents | Confidentiality |
| Nightly/weekly CSV export | Backup outside the app |

### F. Suggested build order

1. **Fix ledger load/import UI** (must work first)  
2. **Print agreement** from charge + person (HTML print CSS)  
3. **Upload signed PDF** per person / per charge  
4. **Batch upload + match review queue**  
5. Phase 2: tech “My balance + my forms” (read-only)

## Mapping to your current process

| Today | In app |
|-------|--------|
| Excel Loan Entry | Add charge |
| Excel Payments (blue = spiff) | Add payment type spiff |
| Excel Summary → owner | Payroll week CSV |
| Paper form signed → employee folder | Print agreement + upload signed PDF to person |
| Stack of old scans | Batch upload → match to person |
