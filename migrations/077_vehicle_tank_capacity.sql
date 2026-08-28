-- Tank capacity for overfill flags on fuel entries (gallons).
-- Conservative OEM defaults from make/model; office can edit per unit.

ALTER TABLE vehicles ADD COLUMN tank_capacity_gallons REAL;

UPDATE vehicles
SET tank_capacity_gallons = CASE
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%forklift%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%fork lift%'
    OR LOWER(COALESCE(model,'')) LIKE '%8fgu%'
    THEN NULL
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%transit%' THEN 31
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%raptor%' THEN 36
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%f-150%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%f 150%'
    OR LOWER(COALESCE(model,'')) LIKE 'ford f-150%'
    THEN 26
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%f-250%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%f 250%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%f-350%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%super duty%'
    OR LOWER(COALESCE(model,'')) LIKE 'ford f-250%'
    THEN 34
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%e-250%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%e-350%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%e 250%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%e 350%'
    THEN 35
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%express%' THEN 31
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%promaster%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%pro master%'
    THEN 24
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%nv cargo%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%nv1500%'
    OR LOWER(COALESCE(model,'')) LIKE 'nv%'
    THEN 28
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%compass%' THEN 13.5
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%jetta%' THEN 13.2
  WHEN LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%4runner%'
    OR LOWER(COALESCE(make,'') || ' ' || COALESCE(model,'')) LIKE '%4-runner%'
    THEN 23
  ELSE NULL
END
WHERE tank_capacity_gallons IS NULL;
