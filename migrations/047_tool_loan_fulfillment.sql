-- Tool loan part fulfillment tracking (after office approves the loan)
-- Employee can see: pending order → ordered → arrived

ALTER TABLE tool_loan_requests ADD COLUMN part_status TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN ordered_at TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN arrived_at TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN part_note TEXT;

CREATE INDEX IF NOT EXISTS idx_tool_loan_part
  ON tool_loan_requests(part_status, status);

-- Existing approved loans start in "waiting to order"
UPDATE tool_loan_requests
SET part_status = 'pending_order', updated_at = datetime('now')
WHERE status = 'approved' AND (part_status IS NULL OR part_status = '');
