CREATE TABLE IF NOT EXISTS sac_support_chats (
  id text PRIMARY KEY,
  protocol text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  company_name text NOT NULL,
  email text,
  whatsapp text,
  title text,
  category text NOT NULL,
  subcategory text,
  status text NOT NULL DEFAULT 'queued',
  source_module text,
  page_url text,
  user_agent text,
  assigned_admin_email text,
  messages_gzip bytea,
  messages_count integer NOT NULL DEFAULT 0,
  compacted_bytes integer NOT NULL DEFAULT 0,
  rating integer,
  problem_resolved boolean,
  feedback text,
  erasure_note text,
  delete_authorized_at timestamptz,
  ended_at timestamptz,
  closed_at timestamptz,
  last_customer_message_at timestamptz,
  last_admin_message_at timestamptz,
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '5 years'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sac_support_chats_status_created
  ON sac_support_chats (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sac_support_chats_filters
  ON sac_support_chats (category, subcategory, customer_name, email);

CREATE TABLE IF NOT EXISTS sac_support_tickets (
  id text PRIMARY KEY,
  protocol text NOT NULL UNIQUE,
  chat_id text REFERENCES sac_support_chats(id) ON DELETE SET NULL,
  customer_name text NOT NULL,
  company_name text NOT NULL,
  email text NOT NULL,
  whatsapp text,
  title text NOT NULL,
  category text NOT NULL,
  subcategory text,
  status text NOT NULL DEFAULT 'open',
  priority text NOT NULL DEFAULT 'normal',
  source_module text,
  page_url text,
  user_agent text,
  assigned_admin_email text,
  messages_gzip bytea,
  messages_count integer NOT NULL DEFAULT 0,
  compacted_bytes integer NOT NULL DEFAULT 0,
  rating integer,
  problem_resolved boolean,
  feedback text,
  erasure_note text,
  delete_authorized_at timestamptz,
  response_deadline_at timestamptz,
  last_customer_message_at timestamptz,
  last_admin_message_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  reopened_at timestamptz,
  retention_until timestamptz NOT NULL DEFAULT (now() + interval '5 years'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sac_support_tickets_status_created
  ON sac_support_tickets (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sac_support_tickets_filters
  ON sac_support_tickets (category, subcategory, customer_name, email, title);

CREATE INDEX IF NOT EXISTS idx_sac_support_tickets_deadline
  ON sac_support_tickets (response_deadline_at)
  WHERE response_deadline_at IS NOT NULL;
