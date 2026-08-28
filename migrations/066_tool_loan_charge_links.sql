-- Many tool loan requests can share one payroll charge (bundled low-amount purchases).

CREATE TABLE IF NOT EXISTS tool_loan_charge_links (
  charge_id INTEGER NOT NULL REFERENCES tool_loan_charges(id),
  request_id INTEGER NOT NULL REFERENCES tool_loan_requests(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (charge_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_loan_charge_links_request
  ON tool_loan_charge_links(request_id);

-- Backfill from existing single FK
INSERT OR IGNORE INTO tool_loan_charge_links (charge_id, request_id)
SELECT id, tool_loan_request_id
FROM tool_loan_charges
WHERE tool_loan_request_id IS NOT NULL AND IFNULL(voided, 0) = 0;
