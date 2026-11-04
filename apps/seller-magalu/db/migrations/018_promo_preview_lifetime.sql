alter table magalu.promo_pricing_previews
  alter column expires_at set default (now() + interval '24 hours');
