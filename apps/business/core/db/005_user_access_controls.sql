alter table volt_core.user_companies
  add column if not exists permissions jsonb not null default '[]'::jsonb,
  add column if not exists screens jsonb not null default '[]'::jsonb;
