create table if not exists patch_notes (
  id bigserial primary key,
  version text not null unique,
  title text not null,
  summary text,
  novidades_text text,
  melhorias_text text,
  correcoes_text text,
  cta_label text,
  cta_url text,
  status text not null default 'draft',
  audience text not null default 'manual',
  created_by bigint references usuarios(id) on delete set null,
  updated_by bigint references usuarios(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint patch_notes_status_check check (status in ('draft', 'sent')),
  constraint patch_notes_audience_check check (audience in ('manual', 'all_active', 'admins'))
);

create table if not exists patch_note_deliveries (
  id bigserial primary key,
  patch_note_id bigint not null references patch_notes(id) on delete cascade,
  recipient_email text not null,
  recipient_name text,
  delivery_status text not null default 'pending',
  provider_message_id text,
  error_message text,
  sent_at timestamptz not null default now(),
  constraint patch_note_deliveries_status_check
    check (delivery_status in ('pending', 'sent', 'failed'))
);

create index if not exists patch_note_deliveries_patch_note_id_idx
  on patch_note_deliveries (patch_note_id);

create index if not exists patch_note_deliveries_recipient_email_idx
  on patch_note_deliveries (recipient_email);
