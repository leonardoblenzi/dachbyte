-- DACH Hub · alerta de estoque baixo: produtos com disponível até este limite aparecem no painel e nos alertas.
alter table hub.tenant_settings add column if not exists low_stock_threshold integer not null default 5 check (low_stock_threshold >= 0);
