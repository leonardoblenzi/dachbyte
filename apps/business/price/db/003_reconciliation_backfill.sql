-- Vínculos criados antes do motor de conciliação não possuem evidência suficiente
-- para receber confiança automática. Eles entram na fila de revisão humana.
UPDATE volt_price.orders
SET reconciliation_status = 'review',
    match_confidence = NULL,
    match_reason = 'legacy_link_requires_review',
    matched_at = NULL,
    updated_at = now()
WHERE marketplace IS NOT NULL
  AND marketplace_order_id IS NOT NULL
  AND reconciliation_status = 'unmatched';
