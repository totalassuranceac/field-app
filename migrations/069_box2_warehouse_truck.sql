-- Box 2 = warehouse / pool truck: no tech assigned, still on live map as "Warehouse truck"
UPDATE vehicles
SET
  assigned_driver = 'Warehouse truck',
  assigned_employee_id = NULL,
  helper_employee_id = NULL,
  updated_at = datetime('now')
WHERE status != 'retired'
  AND (
    lower(trim(unit_number)) IN ('box 2', 'box2', 'box-2', 'box02', 'box 02')
    OR lower(replace(replace(trim(unit_number), ' ', ''), '-', '')) = 'box2'
  );
