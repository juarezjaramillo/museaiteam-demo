-- Saved marketer guardrails predate the Studio pickers: no owner ever chose
-- to deny the campaign-image studio, so grant it (idempotent via UNION).
UPDATE guardrails
SET systems = (
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(guardrails.systems) UNION SELECT 'creative'
  )
),
write_scope = (
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(guardrails.write_scope) UNION SELECT 'image'
  )
)
WHERE worker_role = 'marketer';
