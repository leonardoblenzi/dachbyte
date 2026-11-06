-- Avisos (webhooks) assinados por conta: no Magalu cada seller assina com o próprio token
-- e cada assinatura tem um segredo (whsec_*), mostrado uma única vez. Guardado cifrado, como os tokens.
alter table hub.channel_accounts
  add column if not exists webhook_secrets_enc text,
  add column if not exists webhooks_subscribed_at timestamptz,
  add column if not exists webhooks_error text;
