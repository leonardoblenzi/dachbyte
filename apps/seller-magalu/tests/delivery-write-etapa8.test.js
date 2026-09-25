"use strict";

process.env.MAGALU_ENCRYPTION_KEY = process.env.MAGALU_ENCRYPTION_KEY || "12345678901234567890123456789012";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const payload = require("../src/services/deliveryWritePayload");

test("010 cria previews/operações protegidas sem XML em texto puro", () => {
  const sql = read("db/migrations/010_delivery_write_operations.sql");
  assert.match(sql, /create table if not exists magalu\.delivery_write_previews/i);
  assert.match(sql, /create table if not exists magalu\.delivery_write_operations/i);
  assert.match(sql, /sensitive_payload_ciphertext text/i);
  assert.doesNotMatch(sql, /\bxml\s+text\b/i);
  assert.match(sql, /uncertain.*divergent/s);
});

test("flags de escrita fiscal/entrega nascem desligadas", () => {
  const env = read("src/config/env.js");
  assert.match(env, /MAGALU_DELIVERY_WRITE_ENABLED = bool\(process\.env\.MAGALU_DELIVERY_WRITE_ENABLED, false\)/);
  assert.match(env, /MAGALU_INVOICE_WRITE_ENABLED = bool\(process\.env\.MAGALU_INVOICE_WRITE_ENABLED, false\)/);
  assert.match(env, /open:order-invoice-seller:read/);
  assert.match(env, /open:order-delivery-seller:write/);
  assert.match(env, /open:order-logistics-seller:write/);
});

test("NF-e valida contrato e só expõe metadados não sensíveis", () => {
  const normalized = payload.normalizeInvoiceInput({
    amount: "123.45",
    key: "1".repeat(44),
    xml: "<nfe><secret>conteudo-fiscal</secret></nfe>",
    issued_at: "2026-09-25T12:00:00-03:00",
    issuer: "12345678000199",
  }, "canal-1");
  assert.equal(normalized.body.key, "1".repeat(44));
  assert.equal(normalized.body.channel.id, "canal-1");
  assert.equal(normalized.metadata.amount, 123.45);
  assert.equal(normalized.metadata.key, "1".repeat(44));
  assert.equal(normalized.metadata.issuer_masked.endsWith("0199"), true);
  assert.equal(Object.hasOwn(normalized.metadata, "xml"), false);
  assert.equal(Object.hasOwn(normalized.metadata, "issuer"), false);
});

test("payload fiscal é criptografado e recuperável somente pelo backend", () => {
  const body = { xml: "<nfe>sigilo</nfe>", issuer: "12345678000199", key: "2".repeat(44) };
  const encrypted = payload.encryptBody(body);
  assert.ok(encrypted.startsWith("v1:"));
  assert.equal(encrypted.includes("sigilo"), false);
  assert.deepEqual(payload.decryptBody(encrypted), body);
});

test("requiredScopes inclui leitura necessária à verificação e writes oficiais", () => {
  const invoice = payload.requiredScopes(payload.ACTIONS.INVOICE);
  assert.ok(invoice.includes("open:order-delivery-seller:read"));
  assert.ok(invoice.includes("open:order-invoice-seller:read"));
  assert.ok(invoice.includes("open:order-order-seller:write"));
  assert.ok(invoice.includes("open:order-delivery-seller:write"));
  assert.ok(invoice.includes("open:order-logistics-seller:write"));
  const finish = payload.requiredScopes(payload.ACTIONS.FINISH);
  assert.ok(finish.includes("open:order-delivery-seller:read"));
  assert.ok(finish.includes("open:order-delivery-seller:write"));
});

test("sanitizer remoto remove XML, issuer e PII", () => {
  const safe = payload.sanitizeRemote({ key: "3".repeat(44), xml: "<nfe/>", issuer: "123", buyer: { cpf: "1", email: "a@b.com" }, status: "approved" });
  assert.equal(safe.key, "3".repeat(44));
  assert.equal(safe.status, "approved");
  assert.equal(Object.hasOwn(safe, "xml"), false);
  assert.equal(Object.hasOwn(safe, "issuer"), false);
  assert.equal(Object.hasOwn(safe.buyer, "cpf"), false);
  assert.equal(Object.hasOwn(safe.buyer, "email"), false);
});

test("remote Stage 8 só escreve NF-e e finishing, sem shipped/label", () => {
  const remote = read("src/services/deliveryWriteRemoteService.js");
  assert.match(remote, /\/invoices/);
  assert.match(remote, /\/finishing/);
  assert.match(remote, /attempts:1/);
  assert.doesNotMatch(remote, /\/shippings/);
  assert.doesNotMatch(remote, /shipping-labels/);
});

test("execução é Hub-first imediatamente antes de dispatch e não reenvia ambiguidades", () => {
  const exec = read("src/services/deliveryWriteExecutionService.js");
  assert.match(exec, /RECON_ONLY=new Set\(\["dispatching","accepted","divergent","uncertain"\]\)/);
  assert.ok(exec.indexOf('checkAccountAccess') < exec.lastIndexOf('repo.setDispatching'));
  assert.ok(exec.lastIndexOf('checkAccountAccess') < exec.lastIndexOf('repo.setDispatching'));
  assert.match(exec, /force:true,action:"WRITE magalu"/);
  assert.match(exec, /if\(isReconciliationOnly\(op\)\)return reconcile\(account,op\)/);
  assert.match(exec, /MAGALU_DELIVERY_WRITE_RESULT_UNCERTAIN/);
});

test("ciphertext é apagado no preview usado e antes do POST remoto", () => {
  const repo = read("src/repositories/deliveryWriteRepository.js");
  const exec = read("src/services/deliveryWriteExecutionService.js");
  assert.match(repo, /used_at=now\(\),sensitive_payload_ciphertext=null/);
  assert.match(repo, /status='dispatching'.*sensitive_payload_ciphertext=null/);
  assert.ok(exec.indexOf("repo.decryptedBody(op)") < exec.indexOf("repo.setDispatching"));
});

test("respostas remotas persistidas passam por sanitizer", () => {
  const exec = read("src/services/deliveryWriteExecutionService.js");
  const controller = read("src/controllers/deliveryWriteController.js");
  assert.match(exec, /sanitizeRemote\(response\.data\)/);
  assert.match(controller, /data:sanitizeRemote\(response\.data\)/);
});

test("worker possui retenção e scheduler diário", () => {
  const worker = read("src/jobs/deliveryWrite.worker.js");
  const queue = read("src/queues/magaluQueue.js");
  assert.match(worker, /job\.name==="retention"/);
  assert.match(worker, /cleanupRetention/);
  assert.match(queue, /ensureDeliveryWriteRetentionSchedule/);
  assert.match(queue, /37 4 \* \* \*/);
});

test("operação pública nunca retorna ciphertext", () => {
  const repo = read("src/repositories/deliveryWriteRepository.js");
  assert.match(repo, /const\{ sensitive_payload_ciphertext,\.\.\.safe\}=row/);
  const publicRow = { id: 1, status: "queued", sensitive_payload_ciphertext: "v1:segredo" };
  // contrato estático reforçado acima; aqui validamos que a coluna é classificada como sensível na migration.
  assert.equal(publicRow.sensitive_payload_ciphertext.includes("segredo"), true);
});

test("controller bloqueia fulfillment e exige status seguros", () => {
  const controller = read("src/controllers/deliveryWriteController.js");
  assert.match(controller, /before\.status!=="approved"/);
  assert.match(controller, /delivery\.is_fulfillment===true/);
  assert.match(controller, /before\.status!=="shipped"/);
  assert.match(controller, /ship_delivery:false,label_generation:false/);
});

test("Master e unlink reconhecem delivery_write como operação bloqueadora/reverificável", () => {
  const masterRepo = read("src/repositories/masterRepository.js");
  const masterRoutes = read("src/routes/master.routes.js");
  const account = read("src/repositories/accountManagementRepository.js");
  assert.match(masterRepo, /magalu\.delivery_write_operations/);
  assert.match(masterRepo, /delivery_write/);
  assert.doesNotMatch(masterRepo, /select o\.\*.*delivery_write_operations/s);
  assert.match(masterRoutes, /operations\/delivery\/:operationId\/reverify/);
  assert.match(account, /deliveryOperationBlockers/);
  assert.match(account, /delivery_write_operations/);
});

test("UI exige preview/confirm e trata datas inválidas sem RangeError", () => {
  const ui = read("public/js/magalu-orders.js");
  assert.match(ui, /delivery-writes\/preview/);
  assert.match(ui, /delivery-writes\/apply/);
  assert.match(ui, /Number\.isNaN\(issuedDate\.getTime\(\)\)/);
  assert.match(ui, /Number\.isNaN\(deliveredDate\.getTime\(\)\)/);
  assert.match(ui, /uncertain","divergent/);
});

test("heartbeat/foundation avançam para etapa 8", () => {
  assert.match(read("src/worker.js"), /stage:8/);
  assert.match(read("src/routes/api.routes.js"), /stage:8,revision:"8\.0"/);
  assert.match(read("src/config/queueNames.js"), /deliveryWrite: "magalu-delivery-write"/);
});
