-- Tool loan paperwork verification after the part arrives
-- Flow: pending_order → ordered → arrived → paperwork_signed

ALTER TABLE tool_loan_requests ADD COLUMN paperwork_signed_at TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN paperwork_note TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN paperwork_key TEXT;

-- Existing arrived loans still need paperwork checked
UPDATE tool_loan_requests
SET updated_at = datetime('now')
WHERE status = 'approved' AND part_status = 'arrived';
