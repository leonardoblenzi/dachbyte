"use strict";

const db = require("../db/db");

function normalizeModel(value) {
  const model = String(value || "").replace(/\s+/g, " ").trim();
  if (!model) {
    throw new Error("Informe o modelo padrao.");
  }
  if (model.length > 120) {
    throw new Error("O modelo padrao deve ter no maximo 120 caracteres.");
  }
  return model;
}

function normalizeModelKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function ensureCompanyId(empresaId) {
  const id = parsePositiveId(empresaId);
  if (!id) {
    throw new Error("Empresa nao identificada para salvar modelos padrao.");
  }
  return id;
}

function currentUserId(user) {
  return parsePositiveId(user?.uid ?? user?.id ?? user?.usuario_id);
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    modelo: row.modelo,
    modelo_normalizado: row.modelo_normalizado,
    criado_por_usuario_id: row.criado_por_usuario_id ? Number(row.criado_por_usuario_id) : null,
    criado_por_nome: row.criado_por_nome || null,
    atualizado_por_usuario_id: row.atualizado_por_usuario_id ? Number(row.atualizado_por_usuario_id) : null,
    atualizado_por_nome: row.atualizado_por_nome || null,
    criado_em: row.criado_em,
    atualizado_em: row.atualizado_em,
  };
}

function mapValueRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    modelo_padrao_id: Number(row.modelo_padrao_id),
    valor: row.valor,
    valor_normalizado: row.valor_normalizado,
    criado_por_usuario_id: row.criado_por_usuario_id ? Number(row.criado_por_usuario_id) : null,
    criado_por_nome: row.criado_por_nome || null,
    atualizado_por_usuario_id: row.atualizado_por_usuario_id ? Number(row.atualizado_por_usuario_id) : null,
    atualizado_por_nome: row.atualizado_por_nome || null,
    criado_em: row.criado_em,
    atualizado_em: row.atualizado_em,
  };
}

async function list({ empresaId, search = "", limit = 200 } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const term = String(search || "").trim();
  const params = [companyId, safeLimit];
  let where = "where p.empresa_id = $1 and p.ativo = true";

  if (term) {
    params.push(`%${normalizeModelKey(term)}%`);
    where += ` and p.modelo_normalizado like $${params.length}`;
  }

  const { rows } = await db.query(
    `select
       p.id,
       p.modelo,
       p.modelo_normalizado,
       p.criado_por_usuario_id,
       uc.nome as criado_por_nome,
       p.atualizado_por_usuario_id,
       ua.nome as atualizado_por_nome,
       p.criado_em,
       p.atualizado_em
     from ml_modelo_massa_modelos_padrao p
     left join usuarios uc on uc.id = p.criado_por_usuario_id
     left join usuarios ua on ua.id = p.atualizado_por_usuario_id
     ${where}
     order by p.modelo asc
     limit $2`,
    params,
  );

  const groups = rows.map(mapRow);
  if (!groups.length) return groups;

  const groupIds = groups.map((group) => group.id);
  const valuesResult = await db.query(
    `select
       v.id,
       v.modelo_padrao_id,
       v.valor,
       v.valor_normalizado,
       v.criado_por_usuario_id,
       uc.nome as criado_por_nome,
       v.atualizado_por_usuario_id,
       ua.nome as atualizado_por_nome,
       v.criado_em,
       v.atualizado_em
     from ml_modelo_massa_modelos_padrao_valores v
     left join usuarios uc on uc.id = v.criado_por_usuario_id
     left join usuarios ua on ua.id = v.atualizado_por_usuario_id
     where v.modelo_padrao_id = any($1::bigint[])
       and v.ativo = true
     order by v.valor asc`,
    [groupIds],
  );

  const valuesByGroup = new Map();
  for (const value of valuesResult.rows.map(mapValueRow)) {
    const key = Number(value.modelo_padrao_id);
    if (!valuesByGroup.has(key)) valuesByGroup.set(key, []);
    valuesByGroup.get(key).push(value);
  }

  return groups.map((group) => ({
    ...group,
    valores: valuesByGroup.get(group.id) || [],
  }));
}

async function create({ empresaId, modelo, user } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const safeModel = normalizeModel(modelo);
  const modelKey = normalizeModelKey(safeModel);
  const userId = currentUserId(user);

  const existing = await db.query(
    `select id, ativo
       from ml_modelo_massa_modelos_padrao
      where empresa_id = $1
        and modelo_normalizado = $2
      order by ativo desc, id desc
      limit 1`,
    [companyId, modelKey],
  );

  if (existing.rows[0]?.ativo === true) {
    throw new Error("Este modelo padrao ja esta cadastrado.");
  }

  const inactiveId = parsePositiveId(existing.rows[0]?.id);
  const { rows } = inactiveId
    ? await db.query(
        `update ml_modelo_massa_modelos_padrao
            set modelo = $3,
                ativo = true,
                atualizado_por_usuario_id = $4,
                atualizado_em = now()
          where id = $1
            and empresa_id = $2
          returning id, modelo, modelo_normalizado, criado_por_usuario_id,
                    null::text as criado_por_nome, atualizado_por_usuario_id,
                    null::text as atualizado_por_nome, criado_em, atualizado_em`,
        [inactiveId, companyId, safeModel, userId],
      )
    : await db.query(
        `insert into ml_modelo_massa_modelos_padrao
          (empresa_id, modelo, modelo_normalizado, criado_por_usuario_id, atualizado_por_usuario_id)
         values ($1, $2, $3, $4, $4)
         returning id, modelo, modelo_normalizado, criado_por_usuario_id,
                   null::text as criado_por_nome, atualizado_por_usuario_id,
                   null::text as atualizado_por_nome, criado_em, atualizado_em`,
        [companyId, safeModel, modelKey, userId],
      );

  return mapRow(rows[0]);
}

async function update({ empresaId, id, modelo, user } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const presetId = parsePositiveId(id);
  if (!presetId) {
    throw new Error("Modelo padrao invalido.");
  }

  const safeModel = normalizeModel(modelo);
  const modelKey = normalizeModelKey(safeModel);
  const userId = currentUserId(user);

  const duplicate = await db.query(
    `select id
       from ml_modelo_massa_modelos_padrao
      where empresa_id = $1
        and modelo_normalizado = $2
        and ativo = true
        and id <> $3
      limit 1`,
    [companyId, modelKey, presetId],
  );

  if (duplicate.rows[0]) {
    throw new Error("Este modelo padrao ja esta cadastrado.");
  }

  const { rows } = await db.query(
    `update ml_modelo_massa_modelos_padrao
        set modelo = $3,
            modelo_normalizado = $4,
            atualizado_por_usuario_id = $5,
            atualizado_em = now()
      where id = $1
        and empresa_id = $2
        and ativo = true
      returning id, modelo, modelo_normalizado, criado_por_usuario_id,
                null::text as criado_por_nome, atualizado_por_usuario_id,
                null::text as atualizado_por_nome, criado_em, atualizado_em`,
    [presetId, companyId, safeModel, modelKey, userId],
  );

  if (!rows[0]) {
    throw new Error("Modelo padrao nao encontrado.");
  }

  return mapRow(rows[0]);
}

async function remove({ empresaId, id, user } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const presetId = parsePositiveId(id);
  if (!presetId) {
    throw new Error("Modelo padrao invalido.");
  }

  const userId = currentUserId(user);
  const { rows } = await db.query(
    `update ml_modelo_massa_modelos_padrao
        set ativo = false,
            atualizado_por_usuario_id = $3,
            atualizado_em = now()
      where id = $1
        and empresa_id = $2
        and ativo = true
      returning id`,
    [presetId, companyId, userId],
  );

  if (!rows[0]) {
    throw new Error("Modelo padrao nao encontrado.");
  }

  return { id: presetId };
}

async function ensureGroup(companyId, groupId) {
  const presetId = parsePositiveId(groupId);
  if (!presetId) {
    throw new Error("Modelo padrao invalido.");
  }
  const { rows } = await db.query(
    `select id
       from ml_modelo_massa_modelos_padrao
      where id = $1
        and empresa_id = $2
        and ativo = true
      limit 1`,
    [presetId, companyId],
  );
  if (!rows[0]) {
    throw new Error("Modelo padrao nao encontrado.");
  }
  return presetId;
}

async function createValue({ empresaId, modeloPadraoId, valor, user } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const groupId = await ensureGroup(companyId, modeloPadraoId);
  const safeValue = normalizeModel(valor);
  const valueKey = normalizeModelKey(safeValue);
  const userId = currentUserId(user);

  const existing = await db.query(
    `select id, ativo
       from ml_modelo_massa_modelos_padrao_valores
      where modelo_padrao_id = $1
        and valor_normalizado = $2
      order by ativo desc, id desc
      limit 1`,
    [groupId, valueKey],
  );

  if (existing.rows[0]?.ativo === true) {
    throw new Error("Este valor ja esta cadastrado neste modelo padrao.");
  }

  const inactiveId = parsePositiveId(existing.rows[0]?.id);
  const { rows } = inactiveId
    ? await db.query(
        `update ml_modelo_massa_modelos_padrao_valores
            set valor = $3,
                ativo = true,
                atualizado_por_usuario_id = $4,
                atualizado_em = now()
          where id = $1
            and modelo_padrao_id = $2
          returning id, modelo_padrao_id, valor, valor_normalizado,
                    criado_por_usuario_id, null::text as criado_por_nome,
                    atualizado_por_usuario_id, null::text as atualizado_por_nome,
                    criado_em, atualizado_em`,
        [inactiveId, groupId, safeValue, userId],
      )
    : await db.query(
        `insert into ml_modelo_massa_modelos_padrao_valores
          (modelo_padrao_id, valor, valor_normalizado, criado_por_usuario_id, atualizado_por_usuario_id)
         values ($1, $2, $3, $4, $4)
         returning id, modelo_padrao_id, valor, valor_normalizado,
                   criado_por_usuario_id, null::text as criado_por_nome,
                   atualizado_por_usuario_id, null::text as atualizado_por_nome,
                   criado_em, atualizado_em`,
        [groupId, safeValue, valueKey, userId],
      );

  return mapValueRow(rows[0]);
}

async function updateValue({ empresaId, modeloPadraoId, id, valor, user } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const groupId = await ensureGroup(companyId, modeloPadraoId);
  const valueId = parsePositiveId(id);
  if (!valueId) {
    throw new Error("Valor do modelo padrao invalido.");
  }

  const safeValue = normalizeModel(valor);
  const valueKey = normalizeModelKey(safeValue);
  const userId = currentUserId(user);

  const duplicate = await db.query(
    `select id
       from ml_modelo_massa_modelos_padrao_valores
      where modelo_padrao_id = $1
        and valor_normalizado = $2
        and ativo = true
        and id <> $3
      limit 1`,
    [groupId, valueKey, valueId],
  );

  if (duplicate.rows[0]) {
    throw new Error("Este valor ja esta cadastrado neste modelo padrao.");
  }

  const { rows } = await db.query(
    `update ml_modelo_massa_modelos_padrao_valores
        set valor = $3,
            valor_normalizado = $4,
            atualizado_por_usuario_id = $5,
            atualizado_em = now()
      where id = $1
        and modelo_padrao_id = $2
        and ativo = true
      returning id, modelo_padrao_id, valor, valor_normalizado,
                criado_por_usuario_id, null::text as criado_por_nome,
                atualizado_por_usuario_id, null::text as atualizado_por_nome,
                criado_em, atualizado_em`,
    [valueId, groupId, safeValue, valueKey, userId],
  );

  if (!rows[0]) {
    throw new Error("Valor do modelo padrao nao encontrado.");
  }

  return mapValueRow(rows[0]);
}

async function removeValue({ empresaId, modeloPadraoId, id, user } = {}) {
  const companyId = ensureCompanyId(empresaId);
  const groupId = await ensureGroup(companyId, modeloPadraoId);
  const valueId = parsePositiveId(id);
  if (!valueId) {
    throw new Error("Valor do modelo padrao invalido.");
  }

  const userId = currentUserId(user);
  const { rows } = await db.query(
    `update ml_modelo_massa_modelos_padrao_valores
        set ativo = false,
            atualizado_por_usuario_id = $3,
            atualizado_em = now()
      where id = $1
        and modelo_padrao_id = $2
        and ativo = true
      returning id`,
    [valueId, groupId, userId],
  );

  if (!rows[0]) {
    throw new Error("Valor do modelo padrao nao encontrado.");
  }

  return { id: valueId };
}

module.exports = {
  list,
  create,
  update,
  remove,
  createValue,
  updateValue,
  removeValue,
  normalizeModelKey,
};
