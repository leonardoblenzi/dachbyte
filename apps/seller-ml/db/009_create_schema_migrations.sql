create table if not exists schema_migrations (
  id bigserial primary key,
  filename text not null unique,
  applied_at timestamptz not null default now()
);
