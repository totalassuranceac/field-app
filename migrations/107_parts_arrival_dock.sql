-- Where a received box sits, the qty that arrived, and an optional photo.
-- File only. Do not run on production until Chris says Y.
-- The worker also adds these columns with ALTER on first use.
-- Receiving does not write stock_balances.

ALTER TABLE parts_arrivals ADD COLUMN qty REAL;
ALTER TABLE parts_arrivals ADD COLUMN place_kind TEXT;
ALTER TABLE parts_arrivals ADD COLUMN place_location_id INTEGER;
ALTER TABLE parts_arrivals ADD COLUMN place_label TEXT;
ALTER TABLE parts_arrivals ADD COLUMN photo_key TEXT;

-- Optional. Receiving prefills Actual qty only when a request already has one.
ALTER TABLE parts_order_requests ADD COLUMN qty REAL;
