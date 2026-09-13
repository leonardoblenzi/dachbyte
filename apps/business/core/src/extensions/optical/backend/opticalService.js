"use strict";

const {
  assertCompanyCapability,
  assertTransition,
  createId,
  db,
  getCompanyConfigurationWithClient,
  insertAuditWithClient,
  insertEventWithClient,
  insertWorkflowEventWithClient,
  nextOperationalNumber,
  recordEvent,
  resolveWorkflow,
  validateCustomFields,
} = require("../../../platform/extensions/coreContracts");

function validateConfiguredCustomFields(configuration, moduleName, values = {}, options = {}) {
  return validateCustomFields(configuration, moduleName, values, options);
}

function invalidOpticalDate() {
  return Object.assign(new Error("Data optica invalida"), {
    statusCode: 400,
    code: "OPTICAL_DATE_INVALID",
  });
}

function validCalendarDate(yearText, monthText, dayText) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year >= 0 && year <= 99) date.setUTCFullYear(year);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw invalidOpticalDate();
  }
  return `${yearText}-${monthText}-${dayText}`;
}

function normalizeDateInput(value) {
  const text = String(value || "").trim();
  if (!text || ["hoje", "agora", "12 meses"].includes(text.toLowerCase())) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return validCalendarDate(iso[1], iso[2], iso[3]);
  const localized = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (localized) return validCalendarDate(localized[3], localized[2], localized[1]);
  throw invalidOpticalDate();
}

function normalizeOperationalStatus(value) {
  const aliases = { "Aberta": "open", "Em producao": "in_production", "Aguardando peca": "waiting_part", "Pronto": "ready" };
  return aliases[value] || String(value || "open").trim().toLowerCase().replace(/\s+/g, "_");
}

async function findCustomerWithClient(client, companyId, customerId, customerName) {
  const normalizedId = String(customerId || "").trim();
  if (normalizedId) {
    const result = await client.query(`
      select id, name, document, phone, email
      from volt_core.customers
      where company_id = $1 and id = $2
      limit 1;
    `, [companyId, normalizedId]);
    return result.rows[0] || null;
  }
  const normalizedName = String(customerName || "").trim();
  if (!normalizedName || normalizedName.toLowerCase() === "cliente avulso") return null;
  const result = await client.query(`
    select id, name, document, phone, email
    from volt_core.customers
    where company_id = $1 and lower(name) = lower($2)
    order by number asc
    limit 1;
  `, [companyId, normalizedName]);
  return result.rows[0] || null;
}

async function listServiceOrders(companyId) {
  const result = await db.query(`select so.id, so.number, so.service, so.owner_name as owner, so.due_date as "dueDate", so.status, so.notes,
      so.custom_fields as "customFields", so.optical_order_id as "opticalOrderId",
      so.customer_id as "customerId", c.name as "customerName", so.created_at as "createdAt", so.updated_at as "updatedAt"
    from volt_core.service_orders so left join volt_core.customers c on c.id = so.customer_id and c.company_id = so.company_id
    where so.company_id = $1 order by so.number desc;`, [companyId]);
  return result.rows;
}

async function createServiceOrder(companyId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const customFields = validateConfiguredCustomFields(configuration, "service_order", input.customFields || {}, { requireAll: true });
      const workflow = resolveWorkflow(configuration, "service_order");
      const status = normalizeOperationalStatus(input.status || workflow?.initial || "open");
      assertTransition(configuration, "service_order", null, status);
      const customer = await findCustomerWithClient(client, companyId, input.customerId, input.customer);
      if (!customer) throw Object.assign(new Error("Cliente da OS nao encontrado"), { statusCode: 404, code: "SERVICE_ORDER_CUSTOMER_REQUIRED" });
      const id = createId("ord");
      const number = await nextOperationalNumber(client, companyId, "service_orders");
      const result = await client.query(`insert into volt_core.service_orders
        (id, company_id, number, customer_id, service, owner_name, due_date, status, notes, custom_fields)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        returning id, number, customer_id as "customerId", service, owner_name as owner, due_date as "dueDate", status, notes, custom_fields as "customFields";`,
      [id, companyId, number, customer.id, input.service || null, input.owner || null,
        normalizeDateInput(input.dueDate || input.due), status, input.notes || null, JSON.stringify(customFields)]);
      await insertWorkflowEventWithClient(client, companyId, "service_order", "service_order", id, null, status, input.actorUserId, { source: "create" });
      await insertEventWithClient(client, companyId, "service_order.created", { serviceOrderId: id });
      await insertAuditWithClient(client, companyId, input.actorUserId, "service_order.created", "service_order", id, null, result.rows[0]);
      await client.query("commit");
      return { ...result.rows[0], customerName: customer.name };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function updateServiceOrder(companyId, serviceOrderId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const currentResult = await client.query(`select id, status, optical_order_id as "opticalOrderId", custom_fields as "customFields"
        from volt_core.service_orders where company_id = $1 and id = $2 for update`, [companyId, serviceOrderId]);
      if (!currentResult.rowCount) throw Object.assign(new Error("Ordem de servico nao encontrada"), { statusCode: 404, code: "SERVICE_ORDER_NOT_FOUND" });
      const current = currentResult.rows[0];
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const workflowKey = current.opticalOrderId ? "optical_order" : "service_order";
      const nextStatus = input.status ? normalizeOperationalStatus(input.status) : current.status;
      if (input.status) assertTransition(configuration, workflowKey, current.status, nextStatus);
      const customFields = validateConfiguredCustomFields(configuration, "service_order", input.customFields || {}, { requireAll: false });
      const result = await client.query(`update volt_core.service_orders set service = coalesce($3,service), owner_name = coalesce($4,owner_name),
          due_date = coalesce($5,due_date), status = $6, notes = coalesce($7,notes), custom_fields = custom_fields || $8::jsonb, updated_at = now()
        where company_id = $1 and id = $2 returning id, number, customer_id as "customerId", service, owner_name as owner, due_date as "dueDate", status, notes, custom_fields as "customFields";`,
      [companyId, serviceOrderId, input.service || null, input.owner || null, normalizeDateInput(input.dueDate || input.due),
        nextStatus, input.notes ?? null, JSON.stringify(customFields)]);
      if (current.status !== nextStatus) {
        await insertWorkflowEventWithClient(client, companyId, workflowKey, "service_order", serviceOrderId, current.status, nextStatus, input.actorUserId, { source: "manual" });
      }
      await insertEventWithClient(client, companyId, "service_order.updated", { serviceOrderId, status: nextStatus });
      await insertAuditWithClient(client, companyId, input.actorUserId, "service_order.updated", "service_order", serviceOrderId, current, result.rows[0]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function listPrescriptions(companyId) {
  const result = await db.query(`select p.id, p.customer_id as "customerId", c.name as "customerName", p.doctor,
      p.right_eye as "rightEye", p.left_eye as "leftEye", p.valid_until as "validUntil", p.status, p.metadata,
      p.exam_date as "examDate", p.doctor_crm as "doctorCrm", p.doctor_uf as "doctorUf",
      p.prescription_type as "prescriptionType", p.right_spherical as "rightSpherical",
      p.right_cylindrical as "rightCylindrical", p.right_axis as "rightAxis", p.right_addition as "rightAddition",
      p.right_prism as "rightPrism", p.right_base as "rightBase", p.right_dnp as "rightDnp", p.right_height as "rightHeight",
      p.left_spherical as "leftSpherical", p.left_cylindrical as "leftCylindrical", p.left_axis as "leftAxis",
      p.left_addition as "leftAddition", p.left_prism as "leftPrism", p.left_base as "leftBase",
      p.left_dnp as "leftDnp", p.left_height as "leftHeight", p.pupillary_distance as "pupillaryDistance",
      p.visual_acuity_right as "visualAcuityRight", p.visual_acuity_left as "visualAcuityLeft",
      p.notes, p.attachment_url as "attachmentUrl", p.custom_fields as "customFields",
      p.created_at as "createdAt", p.updated_at as "updatedAt"
    from volt_core.optical_prescriptions p left join volt_core.customers c on c.id = p.customer_id and c.company_id = p.company_id
    where p.company_id = $1 order by p.created_at desc;`, [companyId]);
  return result.rows;
}

async function createPrescription(companyId, input = {}) {
  return db.withClient(async (client) => {
    await assertCompanyCapability(companyId, "optical.prescriptions", client);
    const customer = await findCustomerWithClient(client, companyId, input.customerId, input.customer);
    if (!customer) throw Object.assign(new Error("Cliente da receita nao encontrado"), { statusCode: 404, code: "PRESCRIPTION_CUSTOMER_REQUIRED" });
    const result = await insertPrescriptionWithClient(client, companyId, customer.id, input);
    const id = result.id;
    await insertEventWithClient(client, companyId, "prescription.created", { prescriptionId: id });
    return { ...result, customerName: customer.name };
  });
}

async function updatePrescription(companyId, prescriptionId, input = {}) {
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      await assertCompanyCapability(companyId, "optical.prescriptions", client);
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const customFields = validateConfiguredCustomFields(configuration, "optical_prescription", input.customFields || {}, { requireAll: false });
      const customerChangeRequested = Object.prototype.hasOwnProperty.call(input, "customerId")
        || Object.prototype.hasOwnProperty.call(input, "customer");
      const customer = customerChangeRequested
        ? await findCustomerWithClient(client, companyId, input.customerId, input.customer)
        : null;
      if (customerChangeRequested && !customer) {
        throw Object.assign(new Error("Cliente da receita nao encontrado"), { statusCode: 404, code: "PRESCRIPTION_CUSTOMER_REQUIRED" });
      }
      const result = await client.query(`update volt_core.optical_prescriptions set
      customer_id = coalesce($33,customer_id),
      doctor = coalesce($3,doctor), doctor_crm = coalesce($4,doctor_crm), doctor_uf = coalesce($5,doctor_uf),
      exam_date = coalesce($6,exam_date), valid_until = coalesce($7,valid_until), prescription_type = coalesce($8,prescription_type),
      right_spherical = coalesce($9,right_spherical), right_cylindrical = coalesce($10,right_cylindrical), right_axis = coalesce($11,right_axis),
      right_addition = coalesce($12,right_addition), right_prism = coalesce($13,right_prism), right_base = coalesce($14,right_base),
      right_dnp = coalesce($15,right_dnp), right_height = coalesce($16,right_height),
      left_spherical = coalesce($17,left_spherical), left_cylindrical = coalesce($18,left_cylindrical), left_axis = coalesce($19,left_axis),
      left_addition = coalesce($20,left_addition), left_prism = coalesce($21,left_prism), left_base = coalesce($22,left_base),
      left_dnp = coalesce($23,left_dnp), left_height = coalesce($24,left_height), pupillary_distance = coalesce($25,pupillary_distance),
      visual_acuity_right = coalesce($26,visual_acuity_right), visual_acuity_left = coalesce($27,visual_acuity_left),
      notes = coalesce($28,notes), attachment_url = coalesce($29,attachment_url), status = coalesce($30,status),
      metadata = metadata || $31::jsonb, custom_fields = custom_fields || $32::jsonb, updated_at = now()
    where company_id = $1 and id = $2 returning *, customer_id as "customerId", custom_fields as "customFields";`,
  [companyId, prescriptionId, input.doctor || null, input.doctorCrm || null, input.doctorUf || null,
    normalizeDateInput(input.examDate), normalizeDateInput(input.validUntil), input.prescriptionType || null,
    nullableNumber(input.rightSpherical), nullableNumber(input.rightCylindrical), nullableInteger(input.rightAxis), nullableNumber(input.rightAddition),
    nullableNumber(input.rightPrism), input.rightBase || null, nullableNumber(input.rightDnp), nullableNumber(input.rightHeight),
    nullableNumber(input.leftSpherical), nullableNumber(input.leftCylindrical), nullableInteger(input.leftAxis), nullableNumber(input.leftAddition),
    nullableNumber(input.leftPrism), input.leftBase || null, nullableNumber(input.leftDnp), nullableNumber(input.leftHeight),
    nullableNumber(input.pupillaryDistance), input.visualAcuityRight || null, input.visualAcuityLeft || null,
    input.notes || null, input.attachmentUrl || null, input.status || null, JSON.stringify(input.metadata || {}), JSON.stringify(customFields), customer?.id || null]);
      if (!result.rowCount) throw Object.assign(new Error("Receita nao encontrada"), { statusCode: 404, code: "PRESCRIPTION_NOT_FOUND" });
      await insertEventWithClient(client, companyId, "prescription.updated", { prescriptionId });
      await client.query("commit");
      return { ...result.rows[0], ...(customer ? { customerId: customer.id, customerName: customer.name } : {}) };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

function nullableNumber(value) {
  if (value === "" || value === null || value === undefined) return null;
  const normalized = typeof value === "string" ? value.trim().replace(",", ".") : value;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function nullableInteger(value) {
  const number = nullableNumber(value);
  return number === null ? null : Math.round(number);
}

async function listOpticalLaboratories(companyId) {
  const result = await db.query(`select id, name, document, contact_name as "contactName", phone, email,
      default_lead_days as "defaultLeadDays", notes, active, created_at as "createdAt", updated_at as "updatedAt"
    from volt_core.optical_laboratories where company_id = $1 order by active desc, lower(name);`, [companyId]);
  return result.rows;
}

async function saveOpticalLaboratory(companyId, input = {}) {
  await assertCompanyCapability(companyId, "optical.laboratories");
  const name = String(input.name || "").trim();
  if (!name) throw Object.assign(new Error("Nome do laboratorio e obrigatorio"), { statusCode: 400, code: "OPTICAL_LAB_NAME_REQUIRED" });
  const id = input.id || createId("lab");
  const result = await db.query(`insert into volt_core.optical_laboratories
      (id, company_id, name, document, contact_name, phone, email, default_lead_days, notes, active)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict (company_id, name) do update set document=excluded.document, contact_name=excluded.contact_name,
      phone=excluded.phone, email=excluded.email, default_lead_days=excluded.default_lead_days,
      notes=excluded.notes, active=excluded.active, updated_at=now()
    returning id, name, document, contact_name as "contactName", phone, email,
      default_lead_days as "defaultLeadDays", notes, active;`,
  [id, companyId, name, input.document || null, input.contactName || null, input.phone || null, input.email || null,
    Math.max(0, nullableInteger(input.defaultLeadDays) ?? 7), input.notes || null, input.active !== false]);
  await recordEvent(companyId, "optical_laboratory.saved", { laboratoryId: result.rows[0].id });
  return result.rows[0];
}

async function listOpticalOrders(companyId) {
  const result = await db.query(`select o.id, o.number, o.sale_id as "saleId", s.number as "saleNumber",
      o.customer_id as "customerId", c.name as "customerName", o.prescription_id as "prescriptionId",
      o.service_order_id as "serviceOrderId", so.number as "serviceOrderNumber", o.laboratory_id as "laboratoryId",
      l.name as "laboratoryName", o.frame_product_id as "frameProductId", fp.name as "frameName",
      o.lens_product_id as "lensProductId", lp.name as "lensName", o.status, o.promised_date as "promisedDate",
      o.technical_measurements as "technicalMeasurements", o.lens_details as "lensDetails", o.frame_details as "frameDetails",
      o.quality_check as "qualityCheck", o.notes, o.created_at as "createdAt", o.updated_at as "updatedAt"
    from volt_core.optical_orders o
    join volt_core.sales s on s.id=o.sale_id and s.company_id=o.company_id
    join volt_core.customers c on c.id=o.customer_id and c.company_id=o.company_id
    left join volt_core.service_orders so on so.id=o.service_order_id and so.company_id=o.company_id
    left join volt_core.optical_laboratories l on l.id=o.laboratory_id and l.company_id=o.company_id
    left join volt_core.products fp on fp.id=o.frame_product_id and fp.company_id=o.company_id
    left join volt_core.products lp on lp.id=o.lens_product_id and lp.company_id=o.company_id
    where o.company_id=$1 order by o.created_at desc limit 200;`, [companyId]);
  return result.rows;
}

async function updateOpticalOrderStatus(companyId, opticalOrderId, input = {}) {
  await assertCompanyCapability(companyId, "optical.orders");
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const currentResult = await client.query(
        "select id, status, service_order_id as \"serviceOrderId\" from volt_core.optical_orders where company_id=$1 and id=$2 for update",
        [companyId, opticalOrderId],
      );
      if (!currentResult.rowCount) throw Object.assign(new Error("Pedido optico nao encontrado"), { statusCode: 404, code: "OPTICAL_ORDER_NOT_FOUND" });
      const current = currentResult.rows[0];
      const configuration = await getCompanyConfigurationWithClient(client, companyId);
      const status = String(input.status || "").trim().toLowerCase();
      assertTransition(configuration, "optical_order", current.status, status);
      const result = await client.query(`update volt_core.optical_orders set status=$3,
          sent_to_lab_at=case when $3='sent_to_lab' then now() else sent_to_lab_at end,
          received_from_lab_at=case when $3='received_from_lab' then now() else received_from_lab_at end,
          ready_at=case when $3='ready' then now() else ready_at end,
          delivered_at=case when $3='delivered' then now() else delivered_at end,
          quality_check=quality_check || $4::jsonb, notes=coalesce($5,notes), updated_at=now()
        where company_id=$1 and id=$2 returning id, number, status, promised_date as "promisedDate", quality_check as "qualityCheck";`,
      [companyId, opticalOrderId, status, JSON.stringify(input.qualityCheck || {}), input.notes || null]);
      await client.query(`update volt_core.service_orders set status=$3, updated_at=now()
        where company_id=$1 and optical_order_id=$2`, [companyId, opticalOrderId, status]);
      if (current.status !== status) {
        await insertWorkflowEventWithClient(client, companyId, "optical_order", "optical_order", opticalOrderId, current.status, status, input.actorUserId, { notes: input.notes || null });
      }
      await insertEventWithClient(client, companyId, "optical_order.status_changed", { opticalOrderId, status });
      await insertAuditWithClient(client, companyId, input.actorUserId, "optical_order.status_changed", "optical_order", opticalOrderId, current, result.rows[0]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function markOpticalOrderReady(companyId, opticalOrderId, input = {}) {
  await assertCompanyCapability(companyId, "optical.orders");
  return db.withClient(async (client) => {
    await client.query("begin");
    try {
      const currentResult = await client.query(
        "select id, number, status, service_order_id as \"serviceOrderId\" from volt_core.optical_orders where company_id=$1 and id=$2 for update",
        [companyId, opticalOrderId],
      );
      if (!currentResult.rowCount) {
        throw Object.assign(new Error("Pedido optico nao encontrado"), { statusCode: 404, code: "OPTICAL_ORDER_NOT_FOUND" });
      }
      const current = currentResult.rows[0];
      if (current.status === "ready") {
        await client.query("commit");
        return { ...current, idempotent: true };
      }
      if (["delivered", "canceled"].includes(current.status)) {
        throw Object.assign(new Error("Este pedido nao pode mais ser marcado como pronto"), {
          statusCode: 409,
          code: "OPTICAL_ORDER_CANNOT_MARK_READY",
        });
      }
      const result = await client.query(`update volt_core.optical_orders set status='ready',
          ready_at=coalesce(ready_at,now()), notes=coalesce($3,notes), updated_at=now()
        where company_id=$1 and id=$2
        returning id, number, status, promised_date as "promisedDate", ready_at as "readyAt", quality_check as "qualityCheck";`,
      [companyId, opticalOrderId, input.notes || null]);
      await client.query(`update volt_core.service_orders set status='ready', updated_at=now()
        where company_id=$1 and optical_order_id=$2`, [companyId, opticalOrderId]);
      await insertWorkflowEventWithClient(client, companyId, "optical_order", "optical_order", opticalOrderId, current.status, "ready", input.actorUserId, {
        source: "operator_mark_ready",
        notes: input.notes || null,
      });
      await insertEventWithClient(client, companyId, "optical_order.marked_ready", { opticalOrderId, previousStatus: current.status });
      await insertAuditWithClient(client, companyId, input.actorUserId, "optical_order.marked_ready", "optical_order", opticalOrderId, current, result.rows[0]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function createOpticalOrderWithClient(client, companyId, sale, customer, items, optical = {}, actorUserId) {
  await assertCompanyCapability(companyId, "optical.orders", client);
  if (!customer) throw Object.assign(new Error("Venda optica exige cliente cadastrado"), { statusCode: 400, code: "OPTICAL_CUSTOMER_REQUIRED" });
  let prescriptionId = optical.prescriptionId || null;
  if (prescriptionId) {
    const existing = await client.query("select id from volt_core.optical_prescriptions where company_id=$1 and customer_id=$2 and id=$3", [companyId, customer.id, prescriptionId]);
    if (!existing.rowCount) throw Object.assign(new Error("Receita nao pertence ao cliente selecionado"), { statusCode: 409, code: "OPTICAL_PRESCRIPTION_MISMATCH" });
  } else if (optical.prescription) {
    prescriptionId = (await insertPrescriptionWithClient(client, companyId, customer.id, optical.prescription)).id;
  }
  const laboratoryId = optical.laboratoryId || null;
  if (laboratoryId) {
    const lab = await client.query("select id from volt_core.optical_laboratories where company_id=$1 and id=$2 and active=true", [companyId, laboratoryId]);
    if (!lab.rowCount) throw Object.assign(new Error("Laboratorio invalido ou inativo"), { statusCode: 409, code: "OPTICAL_LAB_INVALID" });
  }
  const productOpticalData = (product) => product?.extensions?.["vertical.optical"] || {};
  const frame = items.find((item) => item.product.id === optical.frameProductId || productOpticalData(item.product).opticalType === "frame");
  const lens = items.find((item) => item.product.id === optical.lensProductId || productOpticalData(item.product).opticalType === "lens");
  const opticalOrderId = createId("opt");
  const opticalNumber = await nextOperationalNumber(client, companyId, "optical_orders");
  const serviceOrderId = createId("ord");
  const serviceOrderNumber = await nextOperationalNumber(client, companyId, "service_orders");
  const promisedDate = normalizeDateInput(optical.promisedDate);
  const initialStatus = optical.prescriptionMode === "later" && !prescriptionId
    ? "awaiting_prescription"
    : optical.measurementsMode === "later"
      ? "awaiting_measurements"
      : optical.laboratoryMode === "later" && !laboratoryId
        ? "awaiting_lab"
        : "ready_for_production";
  const configuration = await getCompanyConfigurationWithClient(client, companyId);
  assertTransition(configuration, "optical_order", null, initialStatus);
  await client.query(`insert into volt_core.optical_orders
      (id,company_id,number,sale_id,customer_id,prescription_id,laboratory_id,frame_product_id,lens_product_id,status,
       promised_date,technical_measurements,lens_details,frame_details,notes,created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$16,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15);`,
  [opticalOrderId, companyId, opticalNumber, sale.id, customer.id, prescriptionId, laboratoryId,
    frame?.product.id || optical.frameProductId || null, lens?.product.id || optical.lensProductId || null, promisedDate,
    JSON.stringify(optical.measurements || {}), JSON.stringify(optical.lensDetails || {}), JSON.stringify(optical.frameDetails || {}),
    optical.notes || null, actorUserId || null, initialStatus]);
  await client.query(`insert into volt_core.service_orders
      (id,company_id,number,customer_id,service,owner_name,due_date,status,notes,sale_id,prescription_id,laboratory_id,optical_order_id)
    values ($1,$2,$3,$4,$5,$6,$7,$13,$8,$9,$10,$11,$12);`,
  [serviceOrderId, companyId, serviceOrderNumber, customer.id, "Producao de oculos", optical.owner || "Balcao", promisedDate,
    optical.notes || null, sale.id, prescriptionId, laboratoryId, opticalOrderId, initialStatus]);
  await client.query("update volt_core.optical_orders set service_order_id=$3 where company_id=$1 and id=$2", [companyId, opticalOrderId, serviceOrderId]);
  await insertWorkflowEventWithClient(client, companyId, "optical_order", "optical_order", opticalOrderId, null, initialStatus, actorUserId, { source: "sale_create", saleId: sale.id, serviceOrderId });
  await insertEventWithClient(client, companyId, "optical_order.created", { opticalOrderId, saleId: sale.id, serviceOrderId });
  return { id: opticalOrderId, number: opticalNumber, saleId: sale.id, prescriptionId, serviceOrderId, serviceOrderNumber, status: initialStatus, promisedDate };
}

async function insertPrescriptionWithClient(client, companyId, customerId, input = {}) {
  const configuration = await getCompanyConfigurationWithClient(client, companyId);
  const customFields = validateConfiguredCustomFields(configuration, "optical_prescription", input.customFields || {}, { requireAll: true });
  const id = createId("pre");
  const result = await client.query(`insert into volt_core.optical_prescriptions (
      id, company_id, customer_id, doctor, doctor_crm, doctor_uf, exam_date, valid_until, prescription_type,
      right_spherical, right_cylindrical, right_axis, right_addition, right_prism, right_base, right_dnp, right_height,
      left_spherical, left_cylindrical, left_axis, left_addition, left_prism, left_base, left_dnp, left_height,
      pupillary_distance, visual_acuity_right, visual_acuity_left, notes, attachment_url, right_eye, left_eye, metadata, custom_fields
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34::jsonb)
    returning id, customer_id as "customerId", doctor, valid_until as "validUntil", status, metadata, custom_fields as "customFields";`, [
    id, companyId, customerId, input.doctor || null, input.doctorCrm || null, input.doctorUf || null,
    normalizeDateInput(input.examDate), normalizeDateInput(input.validUntil), input.prescriptionType || "distance",
    nullableNumber(input.rightSpherical), nullableNumber(input.rightCylindrical), nullableInteger(input.rightAxis), nullableNumber(input.rightAddition),
    nullableNumber(input.rightPrism), input.rightBase || null, nullableNumber(input.rightDnp), nullableNumber(input.rightHeight),
    nullableNumber(input.leftSpherical), nullableNumber(input.leftCylindrical), nullableInteger(input.leftAxis), nullableNumber(input.leftAddition),
    nullableNumber(input.leftPrism), input.leftBase || null, nullableNumber(input.leftDnp), nullableNumber(input.leftHeight),
    nullableNumber(input.pupillaryDistance), input.visualAcuityRight || null, input.visualAcuityLeft || null,
    input.notes || null, input.attachmentUrl || null, input.od || input.rightEye || null, input.oe || input.leftEye || null,
    JSON.stringify(input.metadata || {}), JSON.stringify(customFields),
  ]);
  return result.rows[0];
}


module.exports = {
  createOpticalOrderWithClient,
  createPrescription,
  insertPrescriptionWithClient,
  listOpticalLaboratories,
  listOpticalOrders,
  listPrescriptions,
  markOpticalOrderReady,
  saveOpticalLaboratory,
  normalizeDateInput,
  updateOpticalOrderStatus,
  updatePrescription,
};
