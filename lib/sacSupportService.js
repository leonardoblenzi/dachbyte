"use strict";

const crypto = require("crypto");
const zlib = require("zlib");
const bcrypt = require("bcryptjs");
const db = require("./sacDatabase");

const TIMEZONE = "America/Sao_Paulo";
const SUPPORT_START_HOUR = 8;
const SUPPORT_END_HOUR = 22;
const RETENTION_YEARS = 5;

const CATEGORIES = [
  "Contratação",
  "Bugs/Problemas na plataforma",
  "Erros de processos",
  "Solicitação de melhoria",
];

const SUBCATEGORIES = [
  "DACHBYTE Mercado Livre",
  "DACHBYTE Shopee",
  "Avantracking",
  "LogiSync",
  "MadeiraMadeira",
  "DACHBYTE Business",
  "DACHBYTE Chat",
  "DACHBYTE Stock",
];

const ACTIVE_CHAT_STATUSES = new Set(["queued", "in_progress"]);
const OPEN_TICKET_STATUSES = new Set([
  "open",
  "waiting_admin",
  "waiting_customer",
  "resolved",
  "reopened",
]);

function uniqueValues(values) {
  return Array.from(
    new Set(values.map((value) => normalizeText(value, 320).toLowerCase()).filter(Boolean)),
  );
}

function normalizeText(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeEmail(value, required = false) {
  const email = normalizeText(value, 320).toLowerCase();
  if (!email) {
    if (required) throw userError("Informe um e-mail valido.", 400);
    return null;
  }
  return email;
}

function normalizePhone(value) {
  const phone = normalizeText(value, 40);
  return phone || null;
}

function userError(message, status = 400, code = "VALIDATION_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function optionKey(value) {
  return normalizeText(value, 120)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function optionKeys(value) {
  const raw = normalizeText(value, 120);
  const keys = [optionKey(raw)];
  try {
    const repaired = Buffer.from(raw, "latin1").toString("utf8");
    if (repaired && repaired !== raw) keys.push(optionKey(repaired));
  } catch (_error) {
    // Keep the raw key only when the string cannot be decoded as a legacy form value.
  }
  return keys.filter(Boolean);
}

function findOption(options, value) {
  const keys = new Set(optionKeys(value));
  if (!keys.size) return null;
  return options.find((item) => keys.has(optionKey(item))) || null;
}

function normalizeCategory(value) {
  const found = findOption(CATEGORIES, value);
  if (!found) {
    throw userError("Selecione uma categoria valida.", 400);
  }
  return found;
}

function normalizeSubcategory(category, value, fallbackValue = null) {
  if (category === "Contratação") return null;
  const raw = normalizeText(value, 80);
  const found = findOption(SUBCATEGORIES, raw);
  if (found) return found;

  if (!raw && fallbackValue) {
    const fallback = findOption(SUBCATEGORIES, fallbackValue);
    if (fallback) return fallback;
  }

  if (!found) {
    throw userError("Selecione uma subcategoria valida.", 400);
  }
  return found;
}

function nowIso() {
  return new Date().toISOString();
}

function addRetentionYears(date = new Date()) {
  const copy = new Date(date.getTime());
  copy.setUTCFullYear(copy.getUTCFullYear() + RETENTION_YEARS);
  return copy;
}

function getZonedParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = Number(parts.hour === "24" ? "0" : parts.hour);
  return {
    weekday: parts.weekday,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function isBusinessMoment(date = new Date()) {
  const parts = getZonedParts(date);
  const weekday = String(parts.weekday || "").toLowerCase();
  const isWeekday = ["mon", "tue", "wed", "thu", "fri"].includes(weekday);
  return isWeekday && parts.hour >= SUPPORT_START_HOUR && parts.hour < SUPPORT_END_HOUR;
}

function nextBusinessStartLabel() {
  const cursor = new Date();
  for (let index = 0; index < 14 * 24; index += 1) {
    const check = new Date(cursor.getTime() + index * 60 * 60 * 1000);
    const parts = getZonedParts(check);
    const weekday = String(parts.weekday || "").toLowerCase();
    const isWeekday = ["mon", "tue", "wed", "thu", "fri"].includes(weekday);
    if (isWeekday && parts.hour < SUPPORT_START_HOUR) {
      return "hoje as 8h";
    }
    if (isWeekday && parts.hour >= SUPPORT_START_HOUR && parts.hour < SUPPORT_END_HOUR) {
      return "agora";
    }
    if (isWeekday && parts.hour === SUPPORT_START_HOUR) {
      return `${parts.day}/${String(parts.month).padStart(2, "0")} as 8h`;
    }
  }
  return "no proximo dia util as 8h";
}

function supportStatus() {
  const open = isBusinessMoment();
  return {
    open,
    timezone: TIMEZONE,
    schedule: "Segunda a sexta, das 8h as 22h",
    message: open
      ? "Atendimento ao vivo disponivel agora."
      : "Atendimento ao vivo funciona de segunda a sexta, das 8h as 22h. Voce pode abrir um ticket agora.",
    next_open_label: open ? "agora" : nextBusinessStartLabel(),
    categories: CATEGORIES,
    subcategories: SUBCATEGORIES,
  };
}

function addBusinessHours(start, hours) {
  let remaining = Math.max(0, Number(hours) || 0);
  let cursor = new Date(start.getTime());
  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
    if (isBusinessMoment(cursor)) remaining -= 1;
  }
  return cursor;
}

function packMessages(messages) {
  const normalized = Array.isArray(messages) ? messages : [];
  const json = JSON.stringify(normalized);
  const buffer = zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 });
  return {
    buffer,
    count: normalized.length,
    bytes: buffer.length,
  };
}

function unpackMessages(buffer) {
  if (!buffer) return [];
  try {
    const raw = zlib.gunzipSync(Buffer.from(buffer)).toString("utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function publicMessage(message) {
  return {
    id: message.i,
    at: message.a,
    author: message.b,
    authorName: message.n || null,
    text: message.t || message.text || message.message || "",
    kind: message.k || "message",
  };
}

function makeMessage({ author, authorName, text, kind = "message" }) {
  return {
    i: crypto.randomUUID(),
    a: nowIso(),
    b: author,
    n: normalizeText(authorName, 120) || null,
    t: normalizeText(text, 8000),
    k: kind,
  };
}

function rowWithMessages(row) {
  if (!row) return null;
  return {
    ...row,
    messages: unpackMessages(row.messages_gzip).map(publicMessage),
    messages_gzip: undefined,
  };
}

async function protocolExists(protocol) {
  const result = await db.query(
    `select 1 from sac_support_chats where protocol = $1
      union all
     select 1 from sac_support_tickets where protocol = $1
     limit 1`,
    [protocol],
  );
  return result.rowCount > 0;
}

async function generateProtocol(prefix) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
    const protocol = `${prefix}-${date}-${suffix}`;
    if (!(await protocolExists(protocol))) return protocol;
  }
  throw new Error("Nao foi possivel gerar protocolo unico.");
}

function inferSourceModule(pageUrl) {
  const url = normalizeText(pageUrl, 1000).toLowerCase();
  if (url.includes("/shopee")) return "DACHBYTE Shopee";
  if (url.includes("/avantracking")) return "Avantracking";
  if (url.includes("/davanttilog")) return "LogiSync";
  if (url.includes("/madeiramadeira")) return "MadeiraMadeira";
  if (url.includes("/voltstock")) return "DACHBYTE Stock";
  if (url.includes("/voltchat") || url.includes("/chat")) return "DACHBYTE Chat";
  if (url.includes("volt")) return "DACHBYTE Business";
  if (url.includes("/ml")) return "DACHBYTE Mercado Livre";
  return "DACHBYTE";
}

function validateCustomerPayload(payload, options = {}) {
  const customerName = normalizeText(payload.customerName || payload.name, 160);
  const companyName = normalizeText(payload.companyName || payload.company, 180);
  if (!customerName) throw userError("Informe seu nome.", 400);
  if (!companyName) throw userError("Informe de qual empresa voce fala.", 400);

  const pageUrl = normalizeText(payload.pageUrl, 1000);
  const sourceModule = normalizeText(payload.sourceModule, 80) || inferSourceModule(pageUrl);
  const category = normalizeCategory(payload.category);
  const subcategory = normalizeSubcategory(category, payload.subcategory, sourceModule);
  const email = normalizeEmail(payload.email, Boolean(options.requireEmail));

  return {
    customerName,
    companyName,
    email,
    whatsapp: normalizePhone(payload.whatsapp),
    title: normalizeText(payload.title, 180),
    category,
    subcategory,
    message: normalizeText(payload.message, 8000),
    pageUrl,
    userAgent: normalizeText(payload.userAgent, 800),
    sourceModule,
  };
}

async function ensureSacSupportSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sac_support_admins (
      id text PRIMARY KEY,
      email text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Suporte DACHBYTE',
      password_hash text NOT NULL,
      role text NOT NULL DEFAULT 'sac_admin',
      active boolean NOT NULL DEFAULT true,
      source text NOT NULL DEFAULT 'env_seed',
      last_login_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
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

    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS protocol text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS customer_name text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS company_name text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS whatsapp text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS title text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS category text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS subcategory text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS status text DEFAULT 'queued';
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS source_module text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS page_url text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS user_agent text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS assigned_admin_email text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS messages_gzip bytea;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS messages_count integer DEFAULT 0;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS compacted_bytes integer DEFAULT 0;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS rating integer;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS problem_resolved boolean;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS feedback text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS erasure_note text;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS delete_authorized_at timestamptz;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS ended_at timestamptz;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS closed_at timestamptz;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS last_admin_message_at timestamptz;
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS retention_until timestamptz DEFAULT (now() + interval '5 years');
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
    ALTER TABLE sac_support_chats ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS protocol text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS chat_id text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS customer_name text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS company_name text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS whatsapp text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS title text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS category text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS subcategory text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS status text DEFAULT 'open';
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS priority text DEFAULT 'normal';
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS source_module text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS page_url text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS user_agent text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS assigned_admin_email text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS messages_gzip bytea;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS messages_count integer DEFAULT 0;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS compacted_bytes integer DEFAULT 0;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS rating integer;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS problem_resolved boolean;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS feedback text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS erasure_note text;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS delete_authorized_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS response_deadline_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS last_admin_message_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS closed_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS retention_until timestamptz DEFAULT (now() + interval '5 years');
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
    ALTER TABLE sac_support_tickets ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

    CREATE UNIQUE INDEX IF NOT EXISTS idx_sac_support_admins_email
      ON sac_support_admins (email);
    CREATE INDEX IF NOT EXISTS idx_sac_support_admins_active
      ON sac_support_admins (active, email);
    CREATE INDEX IF NOT EXISTS idx_sac_support_chats_status_created
      ON sac_support_chats (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sac_support_chats_filters
      ON sac_support_chats (category, subcategory, customer_name, email);
    CREATE INDEX IF NOT EXISTS idx_sac_support_tickets_status_created
      ON sac_support_tickets (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sac_support_tickets_filters
      ON sac_support_tickets (category, subcategory, customer_name, email, title);
    CREATE INDEX IF NOT EXISTS idx_sac_support_tickets_deadline
      ON sac_support_tickets (response_deadline_at)
      WHERE response_deadline_at IS NOT NULL;
  `);
}

async function ensureSacSupportAdmins(admins = []) {
  const candidates = admins
    .map((admin) => ({
      email: normalizeEmail(admin?.email),
      name: normalizeText(admin?.name || "Suporte DACHBYTE", 160) || "Suporte DACHBYTE",
      password: normalizeText(admin?.password, 500),
      role: normalizeText(admin?.role || "sac_admin", 80) || "sac_admin",
    }))
    .filter((admin) => admin.email && admin.password);

  for (const admin of candidates) {
    const passwordHash = await bcrypt.hash(admin.password, 10);
    await db.query(
      `insert into sac_support_admins (
         id, email, name, password_hash, role, active, source, updated_at
       ) values ($1, $2, $3, $4, $5, true, 'env_seed', now())
       on conflict (email)
       do update set
         name = excluded.name,
         password_hash = excluded.password_hash,
         role = excluded.role,
         active = true,
         source = excluded.source,
         updated_at = now()`,
      [crypto.randomUUID(), admin.email, admin.name, passwordHash, admin.role],
    );
  }
}

function defaultSacSupportAdminSeeds() {
  const sacPassword = normalizeText(process.env.SAC_ADMIN_PASSWORD || "Sac@172839", 500);
  const masterPassword = normalizeText(process.env.MASTER_ADMIN_PASSWORD || sacPassword, 500);
  const seeds = [
    {
      email: process.env.SAC_ADMIN_EMAIL || "davantti@sac.com.br",
      password: sacPassword,
    },
    {
      email: "davantti@sac.com.br",
      password: sacPassword,
    },
    {
      email: process.env.MASTER_ADMIN_EMAIL || "cadastro6@drossiinteriores.com.br",
      password: masterPassword,
    },
  ];

  return Array.from(
    seeds
      .reduce((acc, seed) => {
        const email = normalizeEmail(seed.email);
        const password = normalizeText(seed.password, 500);
        if (!email || !password) return acc;
        acc.set(email, {
          email,
          password,
          name: "Suporte DACHBYTE",
          role: "sac_admin",
        });
        return acc;
      }, new Map())
      .values(),
  );
}

async function verifySacSupportAdminLogin(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = normalizeText(password, 500);
  if (!normalizedEmail || !normalizedPassword) return null;

  const result = await db.query(
    `select id, email, name, password_hash, role, active
       from sac_support_admins
      where email = $1
        and active = true
      limit 1`,
    [normalizedEmail],
  );

  const admin = result.rows[0] || null;
  if (!admin || !admin.password_hash) return null;

  const ok = await bcrypt.compare(normalizedPassword, admin.password_hash);
  if (!ok) return null;

  await db.query(
    `update sac_support_admins
        set last_login_at = now(),
            updated_at = now()
      where id = $1`,
    [admin.id],
  );

  return {
    email: admin.email,
    name: admin.name || "Suporte DACHBYTE",
    role: admin.role || "sac_admin",
  };
}

async function diagnoseSacSupportAdminLogin(email, password) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPassword = normalizeText(password, 500);
  const diagnostic = {
    email: normalizedEmail || null,
    emailReceived: Boolean(normalizedEmail),
    passwordReceived: Boolean(normalizedPassword),
    passwordLength: normalizedPassword.length,
    adminFound: false,
    active: false,
    passwordMatches: false,
  };

  if (!normalizedEmail) return diagnostic;

  const result = await db.query(
    `select email, password_hash, active
       from sac_support_admins
      where email = $1
      limit 1`,
    [normalizedEmail],
  );

  const admin = result.rows[0] || null;
  if (!admin) return diagnostic;

  diagnostic.adminFound = true;
  diagnostic.active = admin.active === true;
  if (normalizedPassword && admin.password_hash) {
    diagnostic.passwordMatches = await bcrypt.compare(normalizedPassword, admin.password_hash);
  }
  return diagnostic;
}

async function findSacSupportAdminByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;

  const result = await db.query(
    `select email, name, role, active
       from sac_support_admins
      where email = $1
        and active = true
      limit 1`,
    [normalizedEmail],
  );

  const admin = result.rows[0] || null;
  if (!admin) return null;
  return {
    email: admin.email,
    name: admin.name || "Suporte DACHBYTE",
    role: admin.role || "sac_admin",
  };
}

async function cleanupExpiredRetention() {
  const chats = await db.query("delete from sac_support_chats where retention_until < now()");
  const tickets = await db.query("delete from sac_support_tickets where retention_until < now()");
  return {
    chats: chats.rowCount || 0,
    tickets: tickets.rowCount || 0,
  };
}

async function createChat(payload) {
  if (!isBusinessMoment()) {
    throw userError(
      "Atendimento ao vivo fora do horario. Abra um ticket para receber retorno.",
      409,
      "SUPPORT_CLOSED",
    );
  }

  const data = validateCustomerPayload(payload);
  const id = crypto.randomUUID();
  const protocol = await generateProtocol("CHAT");
  const firstMessage = data.message || "Solicitacao de chat aberta pelo cliente.";
  const messages = [
    makeMessage({
      author: "customer",
      authorName: data.customerName,
      text: firstMessage,
    }),
    makeMessage({
      author: "system",
      text: `Protocolo ${protocol}. Guarde este numero para acompanhamento. Ao finalizar, perguntaremos se voce autoriza apagar o conteudo do chat; sem autorizacao, ele sera mantido compactado por 5 anos.`,
      kind: "notice",
    }),
  ];
  const packed = packMessages(messages);

  const result = await db.query(
    `insert into sac_support_chats (
       id, protocol, customer_name, company_name, email, whatsapp, title,
       category, subcategory, status, source_module, page_url, user_agent,
       messages_gzip, messages_count, compacted_bytes, last_customer_message_at,
       retention_until
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, 'queued', $10, $11, $12,
       $13, $14, $15, now(), $16
     )
     returning *`,
    [
      id,
      protocol,
      data.customerName,
      data.companyName,
      data.email,
      data.whatsapp,
      data.title || "Chat de suporte",
      data.category,
      data.subcategory,
      data.sourceModule,
      data.pageUrl,
      data.userAgent,
      packed.buffer,
      packed.count,
      packed.bytes,
      addRetentionYears(),
    ],
  );

  return rowWithMessages(result.rows[0]);
}

async function getChat(idOrProtocol) {
  const key = normalizeText(idOrProtocol, 120);
  const result = await db.query(
    `select * from sac_support_chats
      where id = $1 or protocol = $1
      limit 1`,
    [key],
  );
  return rowWithMessages(result.rows[0] || null);
}

async function appendChatMessage(idOrProtocol, { author, authorName, text }) {
  const current = await getChatRaw(idOrProtocol);
  if (!current) throw userError("Chat nao encontrado.", 404);
  if (!ACTIVE_CHAT_STATUSES.has(String(current.status || ""))) {
    throw userError("Este chat ja foi encerrado.", 409);
  }
  const messageText = normalizeText(text, 8000);
  if (!messageText) throw userError("Digite a mensagem.", 400);
  const messages = unpackMessages(current.messages_gzip);
  messages.push(makeMessage({ author, authorName, text: messageText }));
  const packed = packMessages(messages);
  const isAdmin = author === "admin";

  const result = await db.query(
    `update sac_support_chats
        set messages_gzip = $2,
            messages_count = $3,
            compacted_bytes = $4,
            status = case when $5 then 'in_progress' else status end,
            last_customer_message_at = case when $5 then last_customer_message_at else now() end,
            last_admin_message_at = case when $5 then now() else last_admin_message_at end,
            updated_at = now()
      where id = $1
      returning *`,
    [current.id, packed.buffer, packed.count, packed.bytes, isAdmin],
  );
  return rowWithMessages(result.rows[0]);
}

async function getChatRaw(idOrProtocol) {
  const key = normalizeText(idOrProtocol, 120);
  const result = await db.query(
    `select * from sac_support_chats
      where id = $1 or protocol = $1
      limit 1`,
    [key],
  );
  return result.rows[0] || null;
}

async function finalizeChat(idOrProtocol, payload = {}) {
  const current = await getChatRaw(idOrProtocol);
  if (!current) throw userError("Chat nao encontrado.", 404);

  const rating = Number(payload.rating);
  const safeRating = Number.isFinite(rating) ? Math.max(1, Math.min(5, Math.round(rating))) : null;
  const problemResolved =
    payload.problemResolved === true || payload.problemResolved === false
      ? payload.problemResolved
      : null;
  const feedback = normalizeText(payload.feedback, 1000) || null;
  const deleteAuthorized = payload.deleteAuthorized === true;
  const now = new Date();

  let messages = unpackMessages(current.messages_gzip);
  if (deleteAuthorized) {
    const note = `Cliente autorizou apagar o conteudo do chat em ${now.toISOString()}.`;
    messages = [makeMessage({ author: "system", text: note, kind: "erasure" })];
  } else {
    messages.push(
      makeMessage({
        author: "system",
        text: `Chat encerrado. Protocolo ${current.protocol}. Conteudo mantido compactado por 5 anos.`,
        kind: "notice",
      }),
    );
  }
  const packed = packMessages(messages);

  const result = await db.query(
    `update sac_support_chats
        set status = 'closed',
            messages_gzip = $2,
            messages_count = $3,
            compacted_bytes = $4,
            rating = $5,
            problem_resolved = $6,
            feedback = $7,
            delete_authorized_at = case when $8 then now() else delete_authorized_at end,
            erasure_note = case when $8 then $9 else erasure_note end,
            ended_at = coalesce(ended_at, now()),
            closed_at = coalesce(closed_at, now()),
            updated_at = now()
      where id = $1
      returning *`,
    [
      current.id,
      packed.buffer,
      packed.count,
      packed.bytes,
      safeRating,
      problemResolved,
      feedback,
      deleteAuthorized,
      deleteAuthorized ? `Cliente autorizou apagar o conteudo do chat em ${now.toISOString()}.` : null,
    ],
  );
  return rowWithMessages(result.rows[0]);
}

async function createTicket(payload, options = {}) {
  const data = validateCustomerPayload(payload, { requireEmail: true });
  const title = data.title || normalizeText(payload.subject, 180);
  if (!title) throw userError("Informe um titulo para o ticket.", 400);
  const message = data.message || normalizeText(payload.description, 8000);
  if (!message) throw userError("Descreva o ticket.", 400);

  const id = crypto.randomUUID();
  const protocol = await generateProtocol("TKT");
  const messages = [
    makeMessage({
      author: "customer",
      authorName: data.customerName,
      text: message,
    }),
    makeMessage({
      author: "system",
      text: `Ticket aberto com protocolo ${protocol}. Quando o suporte responder, voce tera 48 horas uteis para retornar; sem resposta, o ticket sera fechado automaticamente.`,
      kind: "notice",
    }),
  ];
  const packed = packMessages(messages);

  const result = await db.query(
    `insert into sac_support_tickets (
       id, protocol, chat_id, customer_name, company_name, email, whatsapp,
       title, category, subcategory, status, source_module, page_url, user_agent,
       messages_gzip, messages_count, compacted_bytes, last_customer_message_at,
       retention_until
     ) values (
       $1, $2, $3, $4, $5, $6, $7,
       $8, $9, $10, 'open', $11, $12, $13,
       $14, $15, $16, now(), $17
     )
     returning *`,
    [
      id,
      protocol,
      options.chatId || null,
      data.customerName,
      data.companyName,
      data.email,
      data.whatsapp,
      title,
      data.category,
      data.subcategory,
      data.sourceModule,
      data.pageUrl,
      data.userAgent,
      packed.buffer,
      packed.count,
      packed.bytes,
      addRetentionYears(),
    ],
  );
  return rowWithMessages(result.rows[0]);
}

async function getTicket(idOrProtocol, email = null) {
  const key = normalizeText(idOrProtocol, 120);
  const params = [key];
  let emailClause = "";
  if (email) {
    params.push(normalizeEmail(email, true));
    emailClause = " and lower(email) = $2";
  }
  const result = await db.query(
    `select * from sac_support_tickets
      where (id = $1 or protocol = $1)${emailClause}
      limit 1`,
    params,
  );
  return rowWithMessages(result.rows[0] || null);
}

async function getTicketRaw(idOrProtocol) {
  const key = normalizeText(idOrProtocol, 120);
  const result = await db.query(
    `select * from sac_support_tickets
      where id = $1 or protocol = $1
      limit 1`,
    [key],
  );
  return result.rows[0] || null;
}

async function appendTicketMessage(idOrProtocol, { author, authorName, text, notify = false }) {
  const current = await getTicketRaw(idOrProtocol);
  if (!current) throw userError("Ticket nao encontrado.", 404);
  const status = String(current.status || "");
  if (status === "closed") throw userError("Este ticket esta fechado.", 409);

  const messageText = normalizeText(text, 8000);
  if (!messageText) throw userError("Digite a mensagem.", 400);
  const messages = unpackMessages(current.messages_gzip);
  messages.push(makeMessage({ author, authorName, text: messageText }));
  const packed = packMessages(messages);
  const isAdmin = author === "admin";
  const deadline = isAdmin ? addBusinessHours(new Date(), 48) : null;

  const result = await db.query(
    `update sac_support_tickets
        set messages_gzip = $2,
            messages_count = $3,
            compacted_bytes = $4,
            status = case
              when $5 then 'waiting_customer'
              else 'waiting_admin'
            end,
            response_deadline_at = case when $5 then $6 else null end,
            last_customer_message_at = case when $5 then last_customer_message_at else now() end,
            last_admin_message_at = case when $5 then now() else last_admin_message_at end,
            updated_at = now()
      where id = $1
      returning *`,
    [current.id, packed.buffer, packed.count, packed.bytes, isAdmin, deadline],
  );

  return {
    ticket: rowWithMessages(result.rows[0]),
    shouldNotify: Boolean(isAdmin && notify),
    deadline,
  };
}

async function updateTicketStatus(idOrProtocol, action, actorName = "Suporte DACHBYTE") {
  const current = await getTicketRaw(idOrProtocol);
  if (!current) throw userError("Ticket nao encontrado.", 404);

  const normalized = normalizeText(action, 40).toLowerCase();
  const now = new Date();
  let status;
  let text;
  if (normalized === "resolve" || normalized === "resolved") {
    status = "resolved";
    text = "Ticket marcado como resolvido pelo suporte.";
  } else if (normalized === "close" || normalized === "closed") {
    status = "closed";
    text = "Ticket fechado pelo suporte.";
  } else if (normalized === "reopen" || normalized === "reopened") {
    status = "reopened";
    text = "Ticket reaberto pelo suporte.";
  } else {
    throw userError("Acao de ticket invalida.", 400);
  }

  const messages = unpackMessages(current.messages_gzip);
  messages.push(makeMessage({ author: "system", authorName: actorName, text, kind: "status" }));
  const packed = packMessages(messages);

  const result = await db.query(
    `update sac_support_tickets
        set status = $2,
            messages_gzip = $3,
            messages_count = $4,
            compacted_bytes = $5,
            response_deadline_at = case when $2 = 'waiting_customer' then response_deadline_at else null end,
            resolved_at = case when $2 = 'resolved' then now() else resolved_at end,
            closed_at = case when $2 = 'closed' then now() else closed_at end,
            reopened_at = case when $2 = 'reopened' then now() else reopened_at end,
            updated_at = now()
      where id = $1
      returning *`,
    [current.id, status, packed.buffer, packed.count, packed.bytes],
  );
  return rowWithMessages(result.rows[0]);
}

async function finalizeTicket(idOrProtocol, payload = {}) {
  const current = await getTicketRaw(idOrProtocol);
  if (!current) throw userError("Ticket nao encontrado.", 404);

  const rating = Number(payload.rating);
  const safeRating = Number.isFinite(rating) ? Math.max(1, Math.min(5, Math.round(rating))) : null;
  const problemResolved =
    payload.problemResolved === true || payload.problemResolved === false
      ? payload.problemResolved
      : null;
  const feedback = normalizeText(payload.feedback, 1000) || null;
  const deleteAuthorized = payload.deleteAuthorized === true;
  const now = new Date();

  let messages = unpackMessages(current.messages_gzip);
  if (deleteAuthorized) {
    const note = `Cliente autorizou apagar o conteudo do ticket em ${now.toISOString()}.`;
    messages = [makeMessage({ author: "system", text: note, kind: "erasure" })];
  } else {
    messages.push(
      makeMessage({
        author: "system",
        text: `Ticket finalizado. Protocolo ${current.protocol}. Conteudo mantido compactado por 5 anos.`,
        kind: "notice",
      }),
    );
  }
  const packed = packMessages(messages);

  const result = await db.query(
    `update sac_support_tickets
        set status = 'closed',
            messages_gzip = $2,
            messages_count = $3,
            compacted_bytes = $4,
            rating = $5,
            problem_resolved = $6,
            feedback = $7,
            delete_authorized_at = case when $8 then now() else delete_authorized_at end,
            erasure_note = case when $8 then $9 else erasure_note end,
            closed_at = coalesce(closed_at, now()),
            response_deadline_at = null,
            updated_at = now()
      where id = $1
      returning *`,
    [
      current.id,
      packed.buffer,
      packed.count,
      packed.bytes,
      safeRating,
      problemResolved,
      feedback,
      deleteAuthorized,
      deleteAuthorized ? `Cliente autorizou apagar o conteudo do ticket em ${now.toISOString()}.` : null,
    ],
  );
  return rowWithMessages(result.rows[0]);
}

function listWhere(filters = {}, aliases = {}) {
  const where = [];
  const params = [];
  function add(sql, value) {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  }

  if (filters.status) add(`${aliases.status || "status"} = ?`, filters.status);
  if (filters.category) add(`${aliases.category || "category"} = ?`, filters.category);
  if (filters.subcategory) add(`${aliases.subcategory || "subcategory"} = ?`, filters.subcategory);
  if (filters.q) {
    const q = `%${normalizeText(filters.q, 120).toLowerCase()}%`;
    params.push(q);
    const ref = `$${params.length}`;
    where.push(`(
      lower(customer_name) like ${ref}
      or lower(coalesce(email, '')) like ${ref}
      or lower(coalesce(title, '')) like ${ref}
      or lower(protocol) like ${ref}
      or lower(company_name) like ${ref}
    )`);
  }
  return {
    clause: where.length ? `where ${where.join(" and ")}` : "",
    params,
  };
}

async function listChats(filters = {}) {
  const { clause, params } = listWhere(filters);
  const defaultOpenClause = filters.status
    ? ""
    : (clause ? " and " : "where ") + "status in ('queued', 'in_progress')";
  const limit = Math.min(Math.max(Number(filters.limit) || 80, 1), 200);
  params.push(limit);
  const result = await db.query(
    `select id, protocol, customer_name, company_name, email, whatsapp, title,
            category, subcategory, status, source_module, assigned_admin_email,
            messages_count, compacted_bytes, rating, problem_resolved,
            delete_authorized_at, ended_at, closed_at, last_customer_message_at,
            last_admin_message_at, created_at, updated_at
       from sac_support_chats
       ${clause}${defaultOpenClause}
      order by
        case status when 'queued' then 1 when 'in_progress' then 2 else 3 end,
        updated_at desc
      limit $${params.length}`,
    params,
  );
  return result.rows;
}

async function listTickets(filters = {}) {
  const { clause, params } = listWhere(filters);
  const defaultOpenClause = filters.status
    ? ""
    : (clause ? " and " : "where ") + "status <> 'closed'";
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 250);
  params.push(limit);
  const result = await db.query(
    `select id, protocol, chat_id, customer_name, company_name, email, whatsapp,
            title, category, subcategory, status, priority, source_module,
            assigned_admin_email, messages_count, compacted_bytes, rating,
            problem_resolved, delete_authorized_at, response_deadline_at,
            last_customer_message_at, last_admin_message_at, resolved_at,
            closed_at, reopened_at, created_at, updated_at
       from sac_support_tickets
       ${clause}${defaultOpenClause}
      order by
        case status
          when 'open' then 1
          when 'reopened' then 2
          when 'waiting_admin' then 3
          when 'waiting_customer' then 4
          when 'resolved' then 5
          else 6
        end,
        updated_at desc
      limit $${params.length}`,
    params,
  );
  return result.rows;
}

async function closeOverdueTickets() {
  const overdue = await db.query(
    `select * from sac_support_tickets
      where status = 'waiting_customer'
        and response_deadline_at is not null
        and response_deadline_at <= now()
      limit 50`,
  );
  const closed = [];
  for (const row of overdue.rows) {
    const messages = unpackMessages(row.messages_gzip);
    messages.push(
      makeMessage({
        author: "system",
        text: "Ticket fechado automaticamente por falta de resposta do usuario em 48 horas uteis.",
        kind: "status",
      }),
    );
    const packed = packMessages(messages);
    const result = await db.query(
      `update sac_support_tickets
          set status = 'closed',
              messages_gzip = $2,
              messages_count = $3,
              compacted_bytes = $4,
              response_deadline_at = null,
              closed_at = coalesce(closed_at, now()),
              updated_at = now()
        where id = $1
        returning *`,
      [row.id, packed.buffer, packed.count, packed.bytes],
    );
    closed.push(rowWithMessages(result.rows[0]));
  }
  return closed;
}

async function createTicketFromChat(chatId, payload = {}) {
  const chat = await getChat(chatId);
  if (!chat) throw userError("Chat nao encontrado.", 404);
  const email = normalizeEmail(payload.email || chat.email, true);
  const title = normalizeText(payload.title || chat.title || `Ticket sobre chat ${chat.protocol}`, 180);
  const transcript = chat.messages
    .map((message) => `[${message.at}] ${message.authorName || message.author}: ${message.text}`)
    .join("\n")
    .slice(0, 7000);

  return createTicket(
    {
      customerName: chat.customer_name,
      companyName: chat.company_name,
      email,
      whatsapp: payload.whatsapp || chat.whatsapp,
      title,
      category: payload.category || chat.category,
      subcategory: payload.subcategory || chat.subcategory,
      message: normalizeText(payload.message, 1000) || `Ticket aberto pelo suporte a partir do chat ${chat.protocol}.\n\n${transcript}`,
      pageUrl: chat.page_url,
      userAgent: chat.user_agent,
      sourceModule: chat.source_module,
    },
    { chatId: chat.id },
  );
}

module.exports = {
  CATEGORIES,
  SUBCATEGORIES,
  OPEN_TICKET_STATUSES,
  ensureSacSupportSchema,
  ensureSacSupportAdmins,
  defaultSacSupportAdminSeeds,
  cleanupExpiredRetention,
  verifySacSupportAdminLogin,
  diagnoseSacSupportAdminLogin,
  findSacSupportAdminByEmail,
  supportStatus,
  addBusinessHours,
  createChat,
  getChat,
  appendChatMessage,
  finalizeChat,
  createTicket,
  getTicket,
  appendTicketMessage,
  updateTicketStatus,
  finalizeTicket,
  listChats,
  listTickets,
  closeOverdueTickets,
  createTicketFromChat,
  normalizeEmail,
};
