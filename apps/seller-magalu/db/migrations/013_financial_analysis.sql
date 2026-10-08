-- Replaceable, account-scoped financial snapshots. Raw payment payloads are not stored.
create table if not exists magalu.order_financial_reports (
  account_id bigint not null references magalu.accounts(id) on delete cascade,
  order_code text not null,
  report_id text,
  remote_updated_at timestamptz,
  transaction_count integer not null default 0,
  sale numeric(18,2) not null default 0,
  commission numeric(18,2) not null default 0,
  fees numeric(18,2) not null default 0,
  shipping_net numeric(18,2) not null default 0,
  promotion_net numeric(18,2) not null default 0,
  subsidy numeric(18,2) not null default 0,
  discount_net numeric(18,2) not null default 0,
  refund_net numeric(18,2) not null default 0,
  other_net numeric(18,2) not null default 0,
  ignored_absolute_discount numeric(18,2) not null default 0,
  net_receivable numeric(18,2) not null default 0,
  fetched_at timestamptz not null default now(),
  primary key (account_id, order_code)
);
create index if not exists idx_magalu_order_financial_reports_fetched
  on magalu.order_financial_reports(account_id, fetched_at desc);
