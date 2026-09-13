-- Safety migration for environments where 061 already ran before the final
-- legacy policy decision. Keep current linked ML accounts operational and
-- unlimited until each one is commercially converted to a paid/courtesy plan.
--
-- It intentionally does not update subscription dates, Hub entitlements,
-- token expiration, or any existing access end date.
UPDATE meli_contas
   SET billing_status = 'legacy_active',
       billing_mode = 'legacy',
       usage_policy = 'unlimited',
       range_enforcement = false,
       billing_updated_at = now()
 WHERE billing_status = 'legacy_active'
   AND billing_mode = 'legacy';
