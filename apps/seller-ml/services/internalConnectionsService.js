"use strict";

// Conexão única do Mercado Livre: o módulo ML é o dono das contas e das chaves.
// Outros produtos da DACHBYTE (hoje, o DACH Hub) pedem por aqui: listar contas
// da empresa, iniciar autorização, obter chave válida e ativar/desativar a conta
// no produto. Só quem é dono renova chaves; quem consome só pede.

const { decryptToken } = require("./tokenCrypto");

const UNLINKED = ["desvinculada", "revogada", "unlinked", "revoked"];
// Pela API interna só se ativa produtos que não são o próprio módulo ML: a conta
// entra no ML só quando o hub de acessos confirma a contratação (aviso de liberação).
const EXTERNAL_PRODUCTS = new Set(["dach_hub"]);
// Autorização: para o DACH Hub (volta em /hub/...) ou para contratar no ML pela
// seleção de plataforma ("none": a conta nasce sem produto e volta para a seleção).
const AUTHORIZE_RETURN = {
  dach_hub: /^\/hub\/[A-Za-z0-9/_-]*$/,
  none: /^\/selecao-plataforma$/,
};

function fail(code, status) {
  return Object.assign(new Error(code), { status });
}

function text(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

function requireTenant(input) {
  const tenantId = text(input?.tenant_id);
  if (!tenantId) throw fail("tenant_required", 400);
  return tenantId;
}

function requireProduct(input) {
  const product = text(input?.product);
  if (!EXTERNAL_PRODUCTS.has(product)) throw fail("product_not_allowed", 400);
  return product;
}

function requireMeliUserId(input) {
  const id = Number(input?.meli_user_id);
  if (!Number.isSafeInteger(id) || id <= 0) throw fail("meli_user_id_required", 400);
  return id;
}

function mlEnvCreds() {
  return {
    app_id: process.env.ML_APP_ID || process.env.APP_ID || process.env.CLIENT_ID || process.env.MERCADOLIBRE_APP_ID || null,
    client_secret: process.env.ML_CLIENT_SECRET || process.env.CLIENT_SECRET || process.env.MERCADOLIBRE_CLIENT_SECRET || null,
    redirect_uri: process.env.ML_REDIRECT_URI || process.env.REDIRECT_URI || process.env.MERCADOLIBRE_REDIRECT_URI || null,
  };
}

/**
 * @param {{ db: { query: Function, withClient: Function },
 *           tokens: { renovarTokenSeNecessario: Function, renovarToken: Function },
 *           authorize: Function }} deps
 */
function createInternalConnectionsService({ db, tokens, authorize, registerHubResource = async () => {}, queueMeasurement = async () => {} }) {
  async function findAccount(tenantId, meliUserId) {
    const { rows } = await db.query(
      `select mc.id, mc.empresa_id, mc.meli_user_id, mc.apelido, mc.site_id, mc.status,
              mt.access_token, mt.access_expires_at, mt.refresh_token, mt.scope,
              coalesce(array_agg(p.produto order by p.produto) filter (where p.produto is not null), '{}') as produtos
         from meli_contas mc
         join empresas e on e.id = mc.empresa_id
    left join meli_tokens mt on mt.meli_conta_id = mc.id
    left join ml.meli_conta_produtos p on p.meli_conta_id = mc.id
        where e.tenant_global_id = $1
          and mc.meli_user_id = $2
          and lower(coalesce(mc.status, '')) <> all($3::text[])
        group by mc.id, mt.meli_conta_id
        limit 1`,
      [tenantId, meliUserId, UNLINKED],
    );
    return rows[0] || null;
  }

  function present(row) {
    const hasTokens = Boolean(row.has_tokens ?? row.refresh_token);
    return {
      meli_user_id: Number(row.meli_user_id),
      label: row.apelido || `Conta ${row.meli_user_id}`,
      site_id: row.site_id || "MLB",
      connection: hasTokens && String(row.status) === "ativa" ? "ok" : "reconnect_required",
      products: Array.isArray(row.produtos) ? row.produtos : [],
    };
  }

  return {
    /** Contas conectadas da empresa, com os produtos em que estão ativas. */
    async listAccounts(input) {
      const tenantId = requireTenant(input);
      const { rows } = await db.query(
        `select mc.id, mc.meli_user_id, mc.apelido, mc.site_id, mc.status,
                (mt.meli_conta_id is not null) as has_tokens,
                coalesce(array_agg(p.produto order by p.produto) filter (where p.produto is not null), '{}') as produtos
           from meli_contas mc
           join empresas e on e.id = mc.empresa_id
      left join meli_tokens mt on mt.meli_conta_id = mc.id
      left join ml.meli_conta_produtos p on p.meli_conta_id = mc.id
          where e.tenant_global_id = $1
            and lower(coalesce(mc.status, '')) <> all($2::text[])
          group by mc.id, mt.meli_conta_id
          order by mc.id`,
        [tenantId, UNLINKED],
      );
      return { accounts: rows.map(present) };
    },

    /** URL de autorização no ML; a conta volta ativa no produto que pediu. */
    async authorize(input) {
      const tenantId = requireTenant(input);
      const product = text(input?.product);
      if (!AUTHORIZE_RETURN[product]) throw fail("product_not_allowed", 400);
      const returnTo = text(input?.return_to, 300);
      if (!AUTHORIZE_RETURN[product].test(returnTo)) throw fail("invalid_return_to", 400);
      return authorize({
        tenantId,
        product,
        returnTo,
        companyName: text(input?.company_name),
        userGlobalId: text(input?.user_global_id) || null,
        publicOrigin: text(input?.public_origin, 300),
      });
    },

    /**
     * Chave válida da conta. Renova sob a trava do módulo quando falta pouco para
     * vencer, ou quando o produto avisa que a chave que tinha foi recusada.
     */
    async token(input) {
      const tenantId = requireTenant(input);
      const product = requireProduct(input);
      const meliUserId = requireMeliUserId(input);
      const account = await findAccount(tenantId, meliUserId);
      if (!account) throw fail("account_not_found", 404);
      if (!account.produtos.includes(product)) throw fail("account_not_active_in_product", 403);
      if (!account.refresh_token && !account.access_token) throw fail("reconnect_required", 409);
      if (String(account.status) === "erro") throw fail("reconnect_required", 409);

      const creds = {
        ...mlEnvCreds(),
        meli_conta_id: Number(account.id),
        account_key: String(account.id),
        meli_user_id: Number(account.meli_user_id),
        site_id: account.site_id || "MLB",
        access_token: account.access_token ? decryptToken(account.access_token) : null,
        refresh_token: account.refresh_token ? decryptToken(account.refresh_token) : null,
        access_expires_at: account.access_expires_at || null,
        scope: account.scope || null,
      };

      const rejected = text(input?.rejected_access_token, 4000);
      let accessToken;
      try {
        if (rejected && rejected === creds.access_token) {
          const renewed = await tokens.renovarToken(creds, { rejectedAccessToken: rejected });
          accessToken = renewed?.access_token;
        } else {
          accessToken = await tokens.renovarTokenSeNecessario(creds);
        }
      } catch (error) {
        if (error?.reconnectRequired) throw fail("reconnect_required", 409);
        throw fail("token_unavailable", 503);
      }
      if (!accessToken) throw fail("token_unavailable", 503);

      const fresh = await db.query(
        `select access_expires_at from meli_tokens where meli_conta_id = $1 limit 1`,
        [account.id],
      );
      return {
        meli_user_id: Number(account.meli_user_id),
        access_token: accessToken,
        expires_at: fresh.rows[0]?.access_expires_at ? new Date(fresh.rows[0].access_expires_at).toISOString() : null,
      };
    },

    /**
     * Seleção de plataforma: usar no ML uma conta já conectada na DACHBYTE (ex.: pelo Hub).
     * Registra a conta no hub de acessos (aguardando contratação) e começa a medição de
     * pedidos para a faixa. A conta só entra no módulo quando a contratação é confirmada.
     */
    async registerForMl(input) {
      const tenantId = requireTenant(input);
      const meliUserId = requireMeliUserId(input);
      const account = await findAccount(tenantId, meliUserId);
      if (!account) throw fail("account_not_found", 404);
      if (account.produtos.includes("ml")) throw fail("account_already_in_ml", 409);
      if (!account.refresh_token || String(account.status) !== "ativa") throw fail("reconnect_required", 409);
      await registerHubResource({
        tenantId, empresaId: Number(account.empresa_id), meliUserId, label: account.apelido || `Conta ${meliUserId}`, accountId: Number(account.id),
      });
      await queueMeasurement(Number(account.id));
      return { resource_key: `ml:${meliUserId}` };
    },

    /** Ativa uma conta já conectada da empresa no produto (ex.: importar no Hub). */
    async activate(input) {
      const tenantId = requireTenant(input);
      const product = requireProduct(input);
      const meliUserId = requireMeliUserId(input);
      const account = await findAccount(tenantId, meliUserId);
      if (!account) throw fail("account_not_found", 404);
      await db.query(
        `insert into ml.meli_conta_produtos (meli_conta_id, produto, ativado_por)
         values ($1, $2, $3) on conflict (meli_conta_id, produto) do nothing`,
        [account.id, product, text(input?.actor) || null],
      );
      return { account: present({ ...account, produtos: [...new Set([...account.produtos, product])].sort() }) };
    },

    /**
     * Tira a conta do produto. A conexão continua guardada (outro produto pode
     * usar, ou o cliente reativa sem autorizar de novo).
     */
    async deactivate(input) {
      const tenantId = requireTenant(input);
      const product = requireProduct(input);
      const meliUserId = requireMeliUserId(input);
      const account = await findAccount(tenantId, meliUserId);
      if (!account) return { ok: true, already: true };
      await db.query(
        `delete from ml.meli_conta_produtos where meli_conta_id = $1 and produto = $2`,
        [account.id, product],
      );
      return { ok: true };
    },
  };
}

module.exports = { createInternalConnectionsService, EXTERNAL_PRODUCTS };
