// @ts-check
"use strict";

const crypto = require("node:crypto");
const { normalizeRule, ruleMatches, ACTIONS } = require("./rules");

/** Uma automação pode disparar outra (ex.: mudou status → regra de status), até este limite. */
const MAX_CHAIN = 3;
const WEBHOOK_TIMEOUT_MS = 5000;
const STATUS_COLORS = ["violet", "blue", "green", "yellow", "orange", "red", "gray"];

/** @param {string} message @param {number} status @param {string} code */
function fail(message, status, code) { return Object.assign(new Error(message), { status, code }); }
/** @param {unknown} error */
const errorText = (error) => String(/** @type {any} */ (error)?.message || error || "erro").slice(0, 300);

/**
 * @typedef {{ tenantId: string, userId?: string | null }} Identity
 * @typedef {{ tenantId: string, orderId: number, event: string, eventKey: string, stage?: string }} Occurrence
 * @typedef {{ enqueueAutomation: (job: Occurrence) => Promise<void> }} AutomationQueue
 */

/**
 * Status internos, etiquetas e automações (evento → condição → ação).
 * @param {{
 *   repository: ReturnType<typeof import("./repository").createAutomationsRepository>,
 *   fetchImpl?: typeof fetch,
 *   queue?: AutomationQueue | null,
 * }} deps
 */
function createAutomationsService({ repository, fetchImpl = fetch, queue = null }) {
  /** Webhook assinado: X-DachHub-Signature = sha256=HMAC(segredo da empresa, corpo). @param {string} tenantId @param {string} url @param {any} payload */
  async function callWebhook(tenantId, url, payload) {
    const body = JSON.stringify(payload);
    const secret = await repository.webhookSecret(tenantId, () => crypto.randomBytes(24).toString("hex"));
    const signature = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        method: "POST", redirect: "manual", signal: controller.signal, body,
        headers: { "content-type": "application/json", "user-agent": "DACH-Hub-Webhook/1", "x-dachhub-event": String(payload.event), "x-dachhub-signature": `sha256=${signature}` },
      });
      if (!res.ok) throw new Error(`webhook respondeu ${res.status}`);
      return `webhook ${res.status}`;
    } catch (error) {
      throw new Error(/** @type {any} */ (error)?.name === "AbortError" ? "webhook sem resposta em 5s" : errorText(error));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Executa as ações de uma regra. Devolve o resultado de cada uma e se o status interno mudou.
   * @param {any} rule @param {any} order @param {Occurrence} occ
   */
  async function runActions(rule, order, occ) {
    /** @type {Array<{ type: string, ok: boolean, detail: string }>} */
    const results = [];
    /** @type {number | null | undefined} */
    let statusChangedTo;
    for (const action of rule.actions) {
      try {
        if (action.type === "set_custom_status") {
          const name = await repository.setCustomStatus(occ.tenantId, occ.orderId, Number(action.statusId), `automação "${rule.name}"`);
          if (name !== undefined) statusChangedTo = Number(action.statusId);
          results.push({ type: action.type, ok: true, detail: name === undefined ? "já estava neste status" : `status: ${name}` });
        } else if (action.type === "add_tag" || action.type === "remove_tag") {
          await repository.changeTags(occ.tenantId, occ.orderId, action.type === "add_tag" ? [action.tag] : [], action.type === "remove_tag" ? [action.tag] : [], `automação "${rule.name}"`);
          results.push({ type: action.type, ok: true, detail: action.tag });
        } else if (action.type === "notify") {
          await repository.createNotification({ tenantId: occ.tenantId, title: action.title, body: `Pedido ${order.orderId} (${order.channel}) · automação "${rule.name}"`, orderId: occ.orderId, ruleId: Number(rule.id) });
          results.push({ type: action.type, ok: true, detail: action.title });
        } else if (action.type === "webhook") {
          const detail = await callWebhook(occ.tenantId, action.url, {
            event: occ.event, rule: { id: Number(rule.id), name: rule.name }, sentAt: new Date().toISOString(),
            order: {
              id: order.id, orderId: order.orderId, channel: order.channel, account: order.account, stage: order.stage, channelStatus: order.channelStatus,
              customStatus: order.customStatus, tags: order.tags, productsTotal: order.productsTotal, itemsCount: order.itemsCount, skus: order.skus,
              fulfillment: order.fulfillment, trackingCode: order.trackingCode, shipBy: order.shipBy, orderedAt: order.orderedAt,
            },
          });
          results.push({ type: action.type, ok: true, detail });
        }
      } catch (error) {
        results.push({ type: action.type, ok: false, detail: errorText(error) });
      }
    }
    return { results, statusChangedTo };
  }

  /**
   * Avalia e executa as regras ativas do evento para um pedido. Cada regra roda uma vez por ocorrência.
   * @param {Occurrence} occ @param {number} [depth]
   */
  async function onOrderEvent(occ, depth = 0) {
    const rules = await repository.activeRulesFor(occ.tenantId, occ.event);
    if (!rules.length) return { ran: 0 };
    let ran = 0;
    for (const rule of rules) {
      // Relê o pedido a cada regra: a anterior pode ter mudado status ou etiquetas.
      const order = await repository.orderContext(occ.tenantId, occ.orderId);
      if (!order || !ruleMatches(rule, order, occ)) continue;
      const claim = await repository.claimRun({ tenantId: occ.tenantId, ruleId: Number(rule.id), orderId: occ.orderId, event: occ.event, eventKey: occ.eventKey });
      if (!claim) continue;
      const { results, statusChangedTo } = await runActions(rule, order, occ);
      const failed = results.filter((r) => !r.ok);
      await repository.finishRun(Number(claim.id), failed.length ? "failed" : "done", results, failed.length ? failed.map((f) => f.detail).join("; ") : null);
      await repository.addAutomationEvent(occ.orderId, `Automação "${rule.name}": ${results.map((r) => `${/** @type {any} */ (ACTIONS)[r.type] || r.type}${r.ok ? "" : " (falhou)"}`).join(", ")}.`);
      ran += 1;
      if (statusChangedTo != null && depth < MAX_CHAIN) {
        await onOrderEvent({ tenantId: occ.tenantId, orderId: occ.orderId, event: "custom_status_changed", eventKey: `run:${claim.id}` }, depth + 1);
      }
    }
    return { ran };
  }

  /** Confere que os status citados na regra são da empresa. @param {string} tenantId @param {any} rule */
  async function checkStatusRefs(tenantId, rule) {
    const ids = [
      ...rule.actions.filter((/** @type {any} */ a) => a.type === "set_custom_status").map((/** @type {any} */ a) => Number(a.statusId)),
      ...rule.conditions.filter((/** @type {any} */ c) => c.field === "customStatusId" && c.value != null).map((/** @type {any} */ c) => Number(c.value)),
    ];
    const owned = await repository.ownedStatusIds(tenantId, ids);
    if (ids.some((id) => !owned.has(id))) throw fail("A regra cita um status interno que não existe.", 400, "invalid_rule");
  }

  /** @param {Identity} identity @param {number} orderId @param {string} event @param {string} key */
  async function fire(identity, orderId, event, key) {
    const occ = { tenantId: identity.tenantId, orderId, event, eventKey: key };
    if (queue) await queue.enqueueAutomation(occ); else await onOrderEvent(occ);
  }

  return {
    onOrderEvent,

    /** Pedido recebido / mudou de situação (chamado pela central de pedidos). @param {{ tenantId: string, orderId: number, created: boolean, stageChanged: boolean, stage: string }} change */
    async orderChanged(change) {
      /** @type {Occurrence[]} */
      const events = [];
      if (change.created) events.push({ tenantId: change.tenantId, orderId: change.orderId, event: "order_received", eventKey: "once" });
      if (change.created || change.stageChanged) events.push({ tenantId: change.tenantId, orderId: change.orderId, event: "stage_changed", eventKey: `stage:${change.stage}`, stage: change.stage });
      for (const occ of events) {
        if (queue) await queue.enqueueAutomation(occ); else await onOrderEvent(occ);
      }
      return { events: events.length };
    },

    /** Pedido conferido na expedição. @param {{ tenantId: string, orderId: number, packedAt: string }} event */
    async orderPacked(event) {
      const occ = { tenantId: event.tenantId, orderId: event.orderId, event: "order_packed", eventKey: `packed:${event.packedAt}` };
      if (queue) await queue.enqueueAutomation(occ); else await onOrderEvent(occ);
    },

    /** Varredura de prazo (a cada 10 min): vencendo em N horas e vencidos. */
    async scanDue() {
      let fired = 0;
      for (const rule of await repository.activeTimeRules()) {
        const hours = Number(rule.eventParams?.hours) || 0;
        for (const o of await repository.dueOrders(rule.tenantId, rule.event, hours)) {
          const occ = { tenantId: rule.tenantId, orderId: Number(o.id), event: rule.event, eventKey: `ship_by:${new Date(o.shipBy).toISOString()}` };
          if (queue) await queue.enqueueAutomation(occ); else await onOrderEvent(occ);
          fired += 1;
        }
      }
      return { fired };
    },

    // ───── Ações manuais da central de pedidos ─────
    /** Status interno em lote (null limpa). Dispara "status interno mudou". @param {{ identity: Identity, orderIds: number[], statusId: number | null }} input */
    async setStatus({ identity, orderIds, statusId }) {
      if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 500) throw fail("Selecione de 1 a 500 pedidos.", 400, "invalid_selection");
      let changed = 0;
      for (const id of orderIds) {
        const name = await repository.setCustomStatus(identity.tenantId, Number(id), statusId, "manual");
        if (name !== undefined) {
          changed += 1;
          await fire(identity, Number(id), "custom_status_changed", `manual:${Date.now()}:${id}`);
        }
      }
      return { changed };
    },

    /** Etiquetas em lote. @param {{ identity: Identity, orderIds: number[], add?: string[], remove?: string[] }} input */
    async changeTags({ identity, orderIds, add = [], remove = [] }) {
      if (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 500) throw fail("Selecione de 1 a 500 pedidos.", 400, "invalid_selection");
      const clean = (/** @type {string[]} */ list) => [...new Set(list.map((t) => String(t || "").trim().slice(0, 40)).filter(Boolean))];
      let changed = 0;
      for (const id of orderIds) if (await repository.changeTags(identity.tenantId, Number(id), clean(add), clean(remove), "manual")) changed += 1;
      return { changed };
    },

    /** Roda uma regra "manual" (ou qualquer regra) agora nos pedidos escolhidos. @param {{ identity: Identity, ruleId: number, orderIds: number[] }} input */
    async runNow({ identity, ruleId, orderIds }) {
      const rule = await repository.getRule(identity.tenantId, ruleId);
      if (!rule) throw fail("Automação não encontrada.", 404, "rule_not_found");
      if (rule.event !== "manual") throw fail("Só automações de execução manual rodam pelo botão.", 400, "not_manual");
      if (!rule.active) throw fail("Ative a automação antes de executar.", 400, "rule_inactive");
      const stamp = `manual:${identity.userId || "?"}:${Date.now()}`;
      let ran = 0;
      for (const id of orderIds.slice(0, 500)) ran += (await onOrderEvent({ tenantId: identity.tenantId, orderId: Number(id), event: "manual", eventKey: stamp })).ran;
      return { ran };
    },

    // ───── Cadastro ─────
    listStatuses: (/** @type {string} */ tenantId) => repository.listStatuses(tenantId),

    /** @param {{ identity: Identity, id?: number | null, name: string, color: string }} input */
    async saveStatus({ identity, id = null, name, color }) {
      const clean = String(name || "").trim().slice(0, 40);
      if (!clean) throw fail("Dê um nome ao status.", 400, "invalid_status");
      const c = STATUS_COLORS.includes(color) ? color : "violet";
      const saved = id ? await repository.updateStatus(identity.tenantId, id, { name: clean, color: c }) : await repository.createStatus(identity.tenantId, { name: clean, color: c });
      if (!saved) throw fail(id ? "Status não encontrado (ou nome repetido)." : "Já existe um status com esse nome.", 409, "status_conflict");
      return saved;
    },

    /** @param {{ identity: Identity, id: number }} input */
    async deleteStatus({ identity, id }) {
      const used = (await repository.listRules(identity.tenantId)).filter((r) => (r.actions || []).some((/** @type {any} */ a) => Number(a.statusId) === Number(id))
        || (r.conditions || []).some((/** @type {any} */ c) => c.field === "customStatusId" && Number(c.value) === Number(id)));
      if (used.length) throw fail(`O status é usado na automação "${used[0].name}". Mude a automação antes.`, 409, "status_in_use");
      const done = await repository.deleteStatus(identity.tenantId, id);
      if (!done) throw fail("Status não encontrado.", 404, "status_not_found");
      return done;
    },

    listRules: (/** @type {string} */ tenantId) => repository.listRules(tenantId),
    /** @param {string} tenantId @param {number} ruleId */
    listRuns: (tenantId, ruleId) => repository.listRuns(tenantId, ruleId),

    /** Cria ou altera uma automação. @param {{ identity: Identity, id?: number | null, input: any }} args */
    async saveRule({ identity, id = null, input }) {
      const rule = normalizeRule(input);
      await checkStatusRefs(identity.tenantId, rule);
      const saved = id ? await repository.updateRule(identity.tenantId, id, rule) : await repository.createRule(identity.tenantId, rule, identity.userId || null);
      if (!saved) throw fail("Automação não encontrada.", 404, "rule_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: id ? "automation_updated" : "automation_created", details: { rule_id: saved.id, event: rule.event } });
      return repository.getRule(identity.tenantId, Number(saved.id));
    },

    /** @param {{ identity: Identity, id: number, active: boolean }} input */
    async setActive({ identity, id, active }) {
      const saved = await repository.setRuleActive(identity.tenantId, id, Boolean(active));
      if (!saved) throw fail("Automação não encontrada.", 404, "rule_not_found");
      return saved;
    },

    /** @param {{ identity: Identity, id: number }} input */
    async deleteRule({ identity, id }) {
      const done = await repository.deleteRule(identity.tenantId, id);
      if (!done) throw fail("Automação não encontrada.", 404, "rule_not_found");
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "automation_deleted", details: { rule_id: id } });
      return done;
    },

    // ───── Avisos e segredo ─────
    /** @param {string} tenantId @param {{ unreadOnly?: boolean, limit?: number, offset?: number }} [options] */
    listNotifications: (tenantId, options) => repository.listNotifications(tenantId, options),
    unreadCount: (/** @type {string} */ tenantId) => repository.unreadCount(tenantId),
    /** @param {string} tenantId @param {number | null} id */
    markRead: (tenantId, id) => repository.markRead(tenantId, id),
    /** @param {string} tenantId */
    webhookSecret: (tenantId) => repository.webhookSecret(tenantId, () => crypto.randomBytes(24).toString("hex")),
    /** @param {Identity} identity */
    async rotateWebhookSecret(identity) {
      const secret = await repository.rotateWebhookSecret(identity.tenantId, crypto.randomBytes(24).toString("hex"));
      await repository.audit({ tenantId: identity.tenantId, userId: identity.userId, action: "webhook_secret_rotated" });
      return secret;
    },
  };
}

module.exports = { createAutomationsService, MAX_CHAIN };
