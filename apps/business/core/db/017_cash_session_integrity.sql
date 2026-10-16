-- A company can operate only one open cash session at a time. The partial
-- index keeps closed-session history unrestricted while making the invariant
-- safe under concurrent opens.
create unique index if not exists uq_volt_core_cash_sessions_one_open_per_company
  on volt_core.cash_sessions (company_id)
  where status = 'open';
