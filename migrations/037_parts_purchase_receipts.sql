-- Employee company-card parts purchases + invoice/packing-slip photo capture
-- OCR learns vendor_name / invoice_number / total_cost / card_last4 via ocr_memory (store_key parts_*)

CREATE TABLE IF NOT EXISTS parts_purchase_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchased_by_user_id INTEGER NOT NULL REFERENCES users(id),
  purchase_kind TEXT NOT NULL DEFAULT 'vendor'
    CHECK (purchase_kind IN ('vendor', 'other')),
  vendor_name TEXT NOT NULL,
  invoice_number TEXT,
  purchase_date TEXT,
  total_cost REAL,
  card_last4 TEXT,
  notes TEXT,
  receipt_key TEXT NOT NULL,
  ocr_raw TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parts_purch_user ON parts_purchase_receipts(purchased_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parts_purch_vendor ON parts_purchase_receipts(vendor_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_parts_purch_invoice ON parts_purchase_receipts(invoice_number);
CREATE INDEX IF NOT EXISTS idx_parts_purch_date ON parts_purchase_receipts(purchase_date DESC);
