-- Positive swept_at records a completed sweep; nonpositive records pending provider reconciliation. Either resumes on poll.
UPDATE trigger_bindings SET swept_at = 0
WHERE swept_at IS NOT NULL AND disabled_at IS NULL AND composio_trigger_id IN (
  SELECT composio_trigger_id FROM trigger_bindings WHERE disabled_at IS NULL
  GROUP BY composio_trigger_id HAVING COUNT(*) > 1 AND COUNT(*) = COUNT(swept_at)
);
