// @ts-check
"use strict";

const { sha256 } = require("../../platform/crypto");
const { skuKey } = require("../catalog/normalize");
const { computeAvailability, planListings } = require("./plan");
const { normalizeRule, ruleFromRow } = require("./rules");
const { parseSpreadsheet, toCsv } = require("./spreadsheet");

/** @param {string} message @param {number} status @param {string} code @param {any} [details] */
function fail(message, status, code, details) { return Object.assign(new Error(message), { status, code, details }); }

/** @typedef {{ tenantId: string, userId?: string | null }} Identity */

/**
 * Casos de uso do estoque mestre (E2: calcula e mostra; não escreve nos canais).
 * @param {{ repository: ReturnType<typeof import("./repository").createStockRepository>,
 *           onItemsChanged?: (tenantId: string, itemIds: number[], reason: string) => Promise<unknown> }} deps
 */
function createStockService({ repository, onItemsChanged = async () => {} }) {
  /** Depois de mexer no estoque: recalcula os envios das contas ativas (E3). @param {string} tenantId @param {any} result @param {string} reason */
  async function changed(tenantId, result, reason) {
    const ids = [...new Set((result?.changes || []).map((/** @type {any} */ c) => Number(c.itemId)))];
    if (ids.length) await onItemsChanged(tenantId, ids, reason);
  }

  /** @param {string} tenantId */
  async function availabilityMap(tenantId) {
    return computeAvailability(await repository.availabilityInputs(tenantId));
  }

  /**
   * Resolve as linhas da planilha para itens: SKU normalizado, sem repetição, sem kit.
   * @param {string} tenantId @param {Array<{ line: number, sku: string, quantity: number }>} rows
   */
  async function resolveRows(tenantId, rows) {
    const items = await repository.findItemsBySkuKeys(tenantId, [...new Set(rows.map((r) => skuKey(r.sku)).filter(Boolean))]);
    const byKey = new Map(items.map((/** @type {any} */ i) => [i.skuKey, i]));
    /** @type {Array<{ line: number, message: string }>} */
    const errors = [];
    /** @type {Array<{ line: number, item: any, quantity: number }>} */
    const resolved = [];
    const seen = new Map();
    for (const row of rows) {
      const item = byKey.get(skuKey(row.sku));
      if (!item) { errors.push({ line: row.line, message: `SKU ${row.sku} não existe no catálogo.` }); continue; }
      if (item.kind === "kit") { errors.push({ line: row.line, message: `${item.sku} é kit: informe o estoque dos componentes.` }); continue; }
      if (seen.has(item.id)) { errors.push({ line: row.line, message: `${item.sku} repetido (também na linha ${seen.get(item.id)}).` }); continue; }
      seen.set(item.id, row.line);
      resolved.push({ line: row.line, item, quantity: row.quantity });
    }
    return { resolved, errors };
  }

  return {
    /**
     * Saldos para a tela de Estoque, com o disponível (kits pelos componentes) e totais.
     * @param {string} tenantId @param {{ q?: string, filter?: string, limit?: number, offset?: number }} [options]
     */
    async listStock(tenantId, options = {}) {
      const threshold = await repository.lowStockThreshold(tenantId);
      const [rows, availability] = await Promise.all([repository.listStock(tenantId, { ...options, threshold }), availabilityMap(tenantId)]);
      let withStock = 0, missing = 0, zero = 0;
      for (const [, a] of availability) {
        if (a.hasStock) { withStock += 1; if (a.available <= 0) zero += 1; } else missing += 1;
      }
      return {
        summary: { items: availability.size, withStock, missing, zero, threshold },
        total: rows[0]?.totalCount || 0,
        items: rows.map((/** @type {any} */ r) => {
          const a = availability.get(Number(r.id));
          const { totalCount: _t, ...rest } = r;
          return { ...rest, available: a?.hasStock ? a.available : null, hasStock: Boolean(a?.hasStock) };
        }),
      };
    },

    /**
     * Ajuste manual com motivo: somar/retirar ou definir o saldo.
     * @param {{ identity: Identity, itemId: number, op: "add" | "set", quantity: number, note: string }} input
     */
    async adjust({ identity, itemId, op, quantity, note }) {
      if (!["add", "set"].includes(op)) throw fail("Operação inválida.", 400, "invalid_op");
      if (!Number.isInteger(quantity) || (op === "add" && quantity === 0) || (op === "set" && quantity < 0)) throw fail("Informe uma quantidade inteira válida.", 400, "invalid_quantity");
      if (!String(note || "").trim()) throw fail("Informe o motivo do ajuste.", 400, "note_required");
      const result = await repository.applyEntries(identity.tenantId, [{ itemId, op, quantity, kind: op === "set" ? "inventory" : "adjustment", note, sourceType: "manual" }], { userId: identity.userId });
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "stock_adjusted", details: { item_id: itemId, op, quantity, note } });
      await changed(identity.tenantId, result, "ajuste manual");
      return result;
    },

    /**
     * Lê a planilha e mostra o que vai mudar, sem gravar.
     * @param {{ identity: Identity, file: { fileName: string, contentBase64: string }, mode: "set" | "add" }} input
     */
    async previewSpreadsheet({ identity, file, mode }) {
      if (!["set", "add"].includes(mode)) throw fail("Escolha se a planilha define ou soma o estoque.", 400, "invalid_mode");
      const parsed = await parseSpreadsheet(file);
      const { resolved, errors } = await resolveRows(identity.tenantId, parsed.rows);
      const availability = await availabilityMap(identity.tenantId);
      const rows = resolved.map((r) => {
        const current = availability.get(Number(r.item.id));
        const before = current?.hasStock ? current.onHand : null;
        const after = mode === "set" ? r.quantity : (before ?? 0) + r.quantity;
        return { line: r.line, itemId: Number(r.item.id), sku: r.item.sku, name: r.item.name, before, after, delta: after - (before ?? 0) };
      });
      const negative = rows.filter((r) => r.after < 0).map((r) => ({ line: r.line, message: `${r.sku} ficaria com estoque negativo (${r.after}).` }));
      return {
        rows,
        errors: [...parsed.errors, ...errors, ...negative].sort((a, b) => a.line - b.line),
        summary: { lines: parsed.rows.length + parsed.errors.length, valid: rows.length - negative.length, changed: rows.filter((r) => r.delta !== 0 || r.before == null).length },
      };
    },

    /**
     * Aplica a planilha. Só segue sem erros. No modo "somar", o mesmo arquivo não é aplicado duas vezes.
     * @param {{ identity: Identity, file: { fileName: string, contentBase64: string }, mode: "set" | "add" }} input
     */
    async applySpreadsheet({ identity, file, mode }) {
      const preview = await this.previewSpreadsheet({ identity, file, mode });
      if (preview.errors.length) throw fail("Corrija os erros da planilha antes de aplicar.", 400, "spreadsheet_errors", preview.errors.slice(0, 100));
      const fileHash = sha256(String(file.contentBase64 || "")).slice(0, 32);
      const result = await repository.applyEntries(identity.tenantId, preview.rows.map((r) => ({
        itemId: r.itemId, op: mode, quantity: mode === "set" ? r.after : r.delta,
        kind: /** @type {const} */ ("spreadsheet"), sourceType: "spreadsheet", sourceId: String(file.fileName || "").slice(0, 120),
        idempotencyKey: mode === "add" ? `sheet:${fileHash}:${r.itemId}` : null,
      })).filter((e) => e.op === "set" || e.quantity !== 0), { userId: identity.userId });
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "stock_spreadsheet_applied", details: { file: file.fileName, mode, applied: result.applied, duplicates: result.duplicates } });
      await changed(identity.tenantId, result, "planilha");
      return result;
    },

    /**
     * Estoque inicial a partir dos canais: conta de referência ou menor estoque entre canais.
     * Por padrão só preenche quem ainda não tem estoque informado.
     * @param {{ identity: Identity, source: "account" | "lowest", accountId?: number | null, onlyMissing?: boolean, apply?: boolean }} input
     */
    async initialFromChannels({ identity, source, accountId = null, onlyMissing = true, apply = false }) {
      if (!["account", "lowest"].includes(source)) throw fail("Origem inválida.", 400, "invalid_source");
      if (source === "account" && !accountId) throw fail("Escolha a conta de referência.", 400, "account_required");
      const [targets, availability] = await Promise.all([repository.channelStockByItem(identity.tenantId, { source, accountId }), availabilityMap(identity.tenantId)]);
      const rows = targets
        .filter((t) => !onlyMissing || !availability.get(Number(t.itemId))?.hasStock)
        .map((t) => ({ itemId: Number(t.itemId), sku: t.sku, quantity: Math.max(0, Math.floor(Number(t.quantity) || 0)), before: availability.get(Number(t.itemId))?.hasStock ? availability.get(Number(t.itemId))?.onHand ?? null : null }));
      if (!apply) return { preview: true, count: rows.length, rows: rows.slice(0, 200) };
      const result = await repository.applyEntries(identity.tenantId, rows.map((r) => ({
        itemId: r.itemId, op: /** @type {const} */ ("set"), quantity: r.quantity, kind: /** @type {const} */ ("initial"),
        sourceType: source === "account" ? "channel_account" : "channels_lowest", sourceId: accountId ? String(accountId) : null,
        channelAccountId: source === "account" ? accountId : null,
      })), { userId: identity.userId });
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "stock_initial_from_channels", details: { source, account_id: accountId, only_missing: onlyMissing, applied: result.applied, items: rows.length } });
      await changed(identity.tenantId, result, "estoque inicial");
      return { preview: false, count: rows.length, ...result };
    },

    /** Números do painel "precisa de atenção" (cada um leva à tela filtrada). @param {string} tenantId */
    async attention(tenantId) {
      return repository.attention(tenantId, await repository.lowStockThreshold(tenantId));
    },

    /** @param {string} tenantId @param {{ itemId?: number | null, limit?: number, offset?: number }} [options] */
    listMovements: (tenantId, options) => repository.listMovements(tenantId, options),

    /**
     * "O que mudaria" no modo observação.
     * zeroInChannel: só anúncios com estoque 0 no canal (sem Full).
     * @param {string} tenantId @param {{ accountId?: number | null, onlyChanges?: boolean, zeroInChannel?: boolean, q?: string, limit?: number, offset?: number }} [options]
     */
    async plan(tenantId, { accountId = null, onlyChanges = false, zeroInChannel = false, q = "", limit = 100, offset = 0 } = {}) {
      const [listings, availability] = await Promise.all([repository.planListings(tenantId, { accountId }), availabilityMap(tenantId)]);
      const { rows, summary } = planListings({
        availability,
        listings: listings.map((/** @type {any} */ l) => ({ ...l, accountRule: ruleFromRow(l.accountRule), listingRule: ruleFromRow(l.listingRule) })),
      });
      const term = String(q || "").trim().toLowerCase();
      const filtered = rows.filter((r) => (!onlyChanges || r.state === "increase" || r.state === "decrease")
        && (!zeroInChannel || (!r.fulfillment && r.channelStock != null && Number(r.channelStock) === 0))
        && (!term || r.sku.toLowerCase().includes(term) || String(r.title || "").toLowerCase().includes(term) || r.listingId.toLowerCase().includes(term)));
      const size = Math.min(500, Math.max(1, limit)), from = Math.max(0, offset);
      return { summary, total: filtered.length, rows: filtered.slice(from, from + size) };
    },

    /** @param {string} tenantId */
    async listAccountRules(tenantId) {
      return (await repository.listAccountRules(tenantId)).map((/** @type {any} */ a) => ({ ...a, rule: ruleFromRow(a.rule) }));
    },

    /** Modo de estoque da conta. "active" (escrever nos canais) só na E3. @param {{ identity: Identity, accountId: number, mode: string }} input */
    async setAccountMode({ identity, accountId, mode }) {
      if (mode === "active") throw fail("A escrita de estoque nos canais chega na próxima etapa. Por enquanto, use Observação.", 400, "active_not_available");
      if (!["off", "observe"].includes(mode)) throw fail("Modo inválido.", 400, "invalid_mode");
      const saved = await repository.setAccountMode(identity.tenantId, accountId, /** @type {"off" | "observe"} */ (mode));
      if (!saved) throw fail("Conta não encontrada.", 404, "account_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "stock_mode_changed", details: { account_id: accountId, mode } });
      return saved;
    },

    /**
     * Regra da conta ou exceção do anúncio. rule = null remove (anúncio volta a seguir a conta).
     * @param {{ identity: Identity, scope: "account" | "listing", targetId: number, rule: any }} input
     */
    async saveRule({ identity, scope, targetId, rule }) {
      if (!["account", "listing"].includes(scope)) throw fail("Escopo inválido.", 400, "invalid_scope");
      let clean = null;
      if (rule != null) {
        const normalized = normalizeRule(rule);
        if (!normalized.rule) throw fail(normalized.error || "Regra inválida.", 400, "invalid_rule");
        clean = normalized.rule;
      }
      const saved = await repository.saveRule(identity.tenantId, { scope, targetId, rule: clean, userId: identity.userId });
      if (!saved) throw fail("Conta ou anúncio não encontrado.", 404, "target_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "stock_rule_saved", details: { scope, target_id: targetId, rule: clean } });
      return { ...saved, rule: ruleFromRow(saved.rule) };
    },

    /** @param {{ identity: Identity, listingId: number, enabled: boolean }} input */
    async setListingSync({ identity, listingId, enabled }) {
      const saved = await repository.setListingSync(identity.tenantId, listingId, Boolean(enabled));
      if (!saved) throw fail("Anúncio não encontrado.", 404, "listing_not_found");
      return saved;
    },

    /** @param {string} tenantId @param {number} itemId */
    async getItem(tenantId, itemId) {
      const item = await repository.getItem(tenantId, itemId);
      if (!item) throw fail("Produto não encontrado.", 404, "item_not_found");
      return item;
    },

    /**
     * Define os componentes do kit por SKU. Regras: componente existe, é simples e não é o próprio item;
     * item com estoque próprio ou que é componente de outro kit não vira kit (sem kit dentro de kit).
     * @param {{ identity: Identity, itemId: number, components: Array<{ sku: string, quantity: number }> }} input
     */
    async setKit({ identity, itemId, components }) {
      const item = await repository.getItem(identity.tenantId, itemId);
      if (!item) throw fail("Produto não encontrado.", 404, "item_not_found");
      const list = Array.isArray(components) ? components : [];
      if (list.length) {
        if (item.usedInKits) throw fail("Este produto é componente de outro kit; kit dentro de kit não é permitido.", 400, "nested_kit");
        if (item.kind !== "kit" && Number(item.onHand) !== 0) throw fail("Zere o estoque deste produto antes de transformá-lo em kit.", 400, "kit_has_stock");
      }
      const found = await repository.findItemsBySkuKeys(identity.tenantId, list.map((c) => skuKey(c.sku)));
      const byKey = new Map(found.map((/** @type {any} */ i) => [i.skuKey, i]));
      /** @type {Array<{ itemId: number, quantity: number }>} */
      const clean = [];
      for (const c of list) {
        const comp = byKey.get(skuKey(c.sku));
        const quantity = Number(c.quantity);
        if (!comp) throw fail(`SKU ${c.sku} não existe no catálogo.`, 400, "component_not_found");
        if (Number(comp.id) === Number(itemId)) throw fail("O kit não pode conter ele mesmo.", 400, "self_component");
        if (comp.kind === "kit") throw fail(`${comp.sku} já é kit; kit dentro de kit não é permitido.`, 400, "nested_kit");
        if (!Number.isInteger(quantity) || quantity <= 0) throw fail(`Quantidade inválida para ${comp.sku}.`, 400, "invalid_quantity");
        if (clean.some((x) => x.itemId === Number(comp.id))) throw fail(`${comp.sku} aparece duas vezes.`, 400, "duplicate_component");
        clean.push({ itemId: Number(comp.id), quantity });
      }
      const saved = await repository.replaceKit(identity.tenantId, itemId, clean);
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "kit_saved", details: { item_id: itemId, components: clean } });
      return { ...saved, components: clean };
    },

    /** Planilha de saldos atual (CSV para Excel). @param {string} tenantId */
    async exportCsv(tenantId) {
      const { items } = await this.listStock(tenantId, { limit: 5000 });
      // Acima de 5 mil itens, pagina até o fim.
      let all = items, offset = items.length;
      while (all.length && offset % 5000 === 0) {
        const next = (await this.listStock(tenantId, { limit: 5000, offset })).items;
        if (!next.length) break;
        all = all.concat(next);
        offset += next.length;
      }
      return toCsv(["sku", "nome", "tipo", "fisico", "reservado", "disponivel"],
        all.map((i) => [i.sku, i.name, i.kind === "kit" ? "kit" : "simples", i.kind === "kit" ? null : i.hasStock ? i.onHand : null, i.kind === "kit" ? null : i.reserved, i.available]));
    },
  };
}

module.exports = { createStockService };
