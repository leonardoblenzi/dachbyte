"use strict";

function serviceError(message, code, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function validIds(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter(Number.isFinite))];
}

function accountKeys(accounts) {
  return [...new Set((accounts || []).flatMap((account) => [account.id, account.meli_user_id])
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== "")
    .map(String))];
}

function auditScope(companyId, accountIds, auditAccountKeys, userIds) {
  return {
    sql: `(
      a.empresa_id = $1
      OR a.meli_conta_id = ANY($2::bigint[])
      OR coalesce(a.metadata ->> 'empresa_id', '') = $1::text
      OR coalesce(a.metadata ->> 'company_id', '') = $1::text
      OR coalesce(a.metadata ->> 'meli_conta_id', '') = ANY($3::text[])
      OR coalesce(a.metadata ->> 'accountKey', '') = ANY($3::text[])
      OR coalesce(a.metadata ->> 'account_key', '') = ANY($3::text[])
      OR a.user_id = ANY($4::bigint[])
    )`,
    params: [Number(companyId), validIds(accountIds), Array.isArray(auditAccountKeys) ? auditAccountKeys : [], validIds(userIds)],
  };
}

async function loadImpact(client, companyId, { lock = false } = {}) {
  const company = await client.query(
    `select id, nome, document_type, document_number, tenant_global_id
       from ml.empresas
      where id = $1
      limit 1${lock ? " for update" : ""}`,
    [companyId],
  );
  if (!company.rows[0]) return null;

  const users = await client.query(
    `select u.id, u.nome, u.email, u.nivel,
            count(eu_all.empresa_id)::int as empresas_count
       from ml.empresa_usuarios eu
       join ml.usuarios u on u.id = eu.usuario_id
       left join ml.empresa_usuarios eu_all on eu_all.usuario_id = u.id
      where eu.empresa_id = $1
      group by u.id, u.nome, u.email, u.nivel
      order by u.nome nulls last, u.email asc, u.id asc`,
    [companyId],
  );
  const accounts = await client.query(
    `select id, apelido, meli_user_id, status
       from ml.meli_contas
      where empresa_id = $1
      order by id asc`,
    [companyId],
  );

  const allUsers = users.rows || [];
  const usersToDelete = allUsers.filter((user) => (
    String(user.nivel || "").trim().toLowerCase() !== "admin_master"
      && Number(user.empresas_count || 0) <= 1
  ));
  const deletedIds = new Set(usersToDelete.map((user) => Number(user.id)));
  const usersToUnlink = allUsers.filter((user) => !deletedIds.has(Number(user.id)));
  const accountRows = accounts.rows || [];
  const scope = auditScope(
    companyId,
    accountRows.map((account) => account.id),
    accountKeys(accountRows),
    usersToDelete.map((user) => user.id),
  );
  const auditCount = await client.query(
    `select count(*)::bigint as count from ml.auth_audit a where ${scope.sql}`,
    scope.params,
  );

  return {
    empresa: company.rows[0],
    users: allUsers,
    usersToDelete,
    usersToUnlink,
    accounts: accountRows,
    auditEventsCount: Number(auditCount.rows[0]?.count || 0),
    auditScope: scope,
  };
}

function toPublicImpact(impact, jobs) {
  const activeJobs = jobs?.activeJobs || [];
  const inspectionFailures = jobs?.inspectionFailures || [];
  const blocked = Boolean(jobs?.blocked || activeJobs.length || inspectionFailures.length);
  return {
    empresa: impact.empresa,
    usersToDelete: impact.usersToDelete,
    usersToUnlink: impact.usersToUnlink,
    accounts: impact.accounts,
    auditEventsCount: impact.auditEventsCount,
    auditScope: {
      relational: true,
      metadata: true,
      user: true,
    },
    activeJobs,
    inspectionFailures,
    blocked,
    canDelete: !blocked,
    counts: {
      users: impact.users.length,
      usersToDelete: impact.usersToDelete.length,
      usersToUnlink: impact.usersToUnlink.length,
      accounts: impact.accounts.length,
      auditEvents: impact.auditEventsCount,
    },
  };
}

function createCompanyDeletionService({ db, activeJobs, randomUUID } = {}) {
  if (!db || typeof db.withClient !== "function") throw new Error("db.withClient e obrigatorio.");
  if (!activeJobs || typeof activeJobs.checkCompanyActiveJobs !== "function") {
    throw new Error("activeJobs.checkCompanyActiveJobs e obrigatorio.");
  }
  const uuid = typeof randomUUID === "function" ? randomUUID : require("crypto").randomUUID;

  async function previewCompanyDeletion(companyId) {
    const id = Number(companyId);
    if (!Number.isFinite(id)) throw serviceError("ID invalido.", "INVALID_COMPANY_ID");
    return db.withClient(async (client) => {
      const impact = await loadImpact(client, id);
      if (!impact) throw serviceError("Empresa nao encontrada.", "COMPANY_NOT_FOUND");
      const jobs = await activeJobs.checkCompanyActiveJobs(accountKeys(impact.accounts));
      return toPublicImpact(impact, jobs);
    });
  }

  async function deleteCompany({ companyId, actor } = {}) {
    const id = Number(companyId);
    if (!Number.isFinite(id)) throw serviceError("ID invalido.", "INVALID_COMPANY_ID");

    return db.withClient(async (client) => {
      await client.query("begin");
      try {
        const impact = await loadImpact(client, id, { lock: true });
        if (!impact) throw serviceError("Empresa nao encontrada.", "COMPANY_NOT_FOUND");

        const jobs = await activeJobs.checkCompanyActiveJobs(accountKeys(impact.accounts));
        const publicImpact = toPublicImpact(impact, jobs);
        if (publicImpact.blocked) {
          throw serviceError("Existem jobs ativos ou indisponiveis para inspecao.", "COMPANY_DELETION_BLOCKED", publicImpact);
        }

        const deleteUserIds = validIds(impact.usersToDelete.map((user) => user.id));
        if (deleteUserIds.length) {
          await client.query(
            `select id from ml.usuarios
              where id = any($1::bigint[])
                and lower(coalesce(nivel, 'usuario')) <> 'admin_master'
              for update`,
            [deleteUserIds],
          );
        }
        const deletedAudit = await client.query(
          `delete from ml.auth_audit a where ${impact.auditScope.sql}`,
          impact.auditScope.params,
        );
        let deletedUsers = { rowCount: 0 };
        if (deleteUserIds.length) {
          deletedUsers = await client.query(
            `delete from ml.usuarios
              where id = any($1::bigint[])
                and lower(coalesce(nivel, 'usuario')) <> 'admin_master'`,
            [deleteUserIds],
          );
        }
        const deletedCompany = await client.query(
          "delete from ml.empresas where id = $1 returning id",
          [id],
        );
        const requestId = uuid();
        const receipt = await client.query(
          `insert into ml.company_deletion_receipts
             (request_id, deleted_empresa_id, empresa_nome, actor_user_id, actor_email,
              users_deleted_count, users_unlinked_count, accounts_deleted_count,
              audit_events_deleted_count, status)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed')
           returning id, request_id, deleted_empresa_id, empresa_nome, actor_user_id,
                     actor_email, deleted_at, users_deleted_count, users_unlinked_count,
                     accounts_deleted_count, audit_events_deleted_count, status`,
          [
            requestId,
            id,
            impact.empresa.nome || null,
            Number.isFinite(Number(actor?.id)) ? Number(actor.id) : null,
            String(actor?.email || "").trim() || null,
            deletedUsers.rowCount || 0,
            impact.usersToUnlink.length,
            impact.accounts.length,
            deletedAudit.rowCount || 0,
          ],
        );
        await client.query("commit");
        return {
          receipt: receipt.rows[0],
          impact: publicImpact,
          deletedCompany: deletedCompany.rowCount || 0,
          deletedUsers: deletedUsers.rowCount || 0,
          deletedAuditEvents: deletedAudit.rowCount || 0,
        };
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    });
  }

  async function listDeletionReceipts({ search, from, to, operator, page = 1, pageSize = 25 } = {}) {
    const safePage = Math.max(1, Math.floor(Number(page) || 1));
    const safePageSize = Math.min(100, Math.max(1, Math.floor(Number(pageSize) || 25)));
    const filters = [];
    const params = [];
    const add = (sql, values) => {
      const list = Array.isArray(values) ? values : [values];
      let index = 0;
      filters.push(sql.replace(/\?/g, () => {
        params.push(list[index]);
        index += 1;
        return `$${params.length}`;
      }));
    };
    const queryText = String(search || "").trim();
    if (queryText) add("(cast(deleted_empresa_id as text) ilike ? or coalesce(empresa_nome, '') ilike ?)", [`%${queryText}%`, `%${queryText}%`]);
    if (from) add("deleted_at >= ?::timestamptz", String(from));
    if (to) add("deleted_at <= ?::timestamptz", String(to));
    if (operator) add("(cast(actor_user_id as text) = ? or coalesce(actor_email, '') ilike ?)", [String(operator), String(operator)]);
    const where = filters.length ? ` where ${filters.join(" and ")}` : "";
    const count = await db.query(`select count(*)::bigint as total from ml.company_deletion_receipts${where}`, params);
    const listParams = [...params, safePageSize, (safePage - 1) * safePageSize];
    const rows = await db.query(
      `select id, request_id, deleted_empresa_id, empresa_nome, actor_user_id, actor_email,
              deleted_at, users_deleted_count, users_unlinked_count, accounts_deleted_count,
              audit_events_deleted_count, status
         from ml.company_deletion_receipts${where}
        order by deleted_at desc, id desc
        limit $${listParams.length - 1} offset $${listParams.length}`,
      listParams,
    );
    return { items: rows.rows || [], page: safePage, pageSize: safePageSize, total: Number(count.rows[0]?.total || 0) };
  }

  return { previewCompanyDeletion, deleteCompany, listDeletionReceipts };
}

module.exports = { auditScope, createCompanyDeletionService };
