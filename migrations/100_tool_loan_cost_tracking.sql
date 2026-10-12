-- Tool loan: cost-verify on arrive + shipment tracking visibility
-- actual_cost: what office paid when marking arrived (never invent)
-- carrier / tracking_*: optional; empty OK; never invent

ALTER TABLE tool_loan_requests ADD COLUMN actual_cost REAL;
ALTER TABLE tool_loan_requests ADD COLUMN carrier TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN tracking_number TEXT;
ALTER TABLE tool_loan_requests ADD COLUMN tracking_url TEXT;
