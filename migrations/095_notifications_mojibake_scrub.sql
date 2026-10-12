-- One-shot scrub of mojibake separators in notification titles/bodies
UPDATE notifications
SET title = REPLACE(REPLACE(REPLACE(REPLACE(title, 'Â·', ' - '), 'â€"', '-'), 'â€“', '-'), '·', ' - '),
    body = REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(body,''), 'Â·', ' - '), 'â€"', '-'), 'â€“', '-'), '·', ' - ')
WHERE title LIKE '%Â%' OR title LIKE '%â€%' OR body LIKE '%Â%' OR body LIKE '%â€%'
   OR title LIKE '%·%' OR body LIKE '%·%';
