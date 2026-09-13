"use strict";

const {
  db,
  normalizePageQuery,
  normalizedFilter,
  rowsAndCount,
} = require("../../../platform/extensions/coreContracts");

async function listPrescriptionsPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const filter = normalizedFilter(query.filter);
  const customerId = String(input.customerId || "").trim().slice(0, 120);
  const params = [companyId, query.search, filter, customerId];
  const where = `p.company_id=$1
    and ($2='' or lower(concat_ws(' ',c.name,p.doctor,p.doctor_crm,p.status,p.notes,p.valid_until::text,p.right_spherical::text,p.left_spherical::text)) like '%'||lower($2)||'%')
    and ($3='' or $3='todos' or ($3='sem validade' and p.valid_until is null) or ($3='vencidas' and p.valid_until<current_date) or ($3='validas' and p.valid_until>=current_date))
    and ($4='' or p.customer_id=$4)`;
  const fields = `p.id,p.customer_id as "customerId",c.name as "customerName",p.doctor,p.right_eye as "rightEye",p.left_eye as "leftEye",p.valid_until as "validUntil",p.status,p.metadata,p.exam_date as "examDate",p.doctor_crm as "doctorCrm",p.doctor_uf as "doctorUf",p.prescription_type as "prescriptionType",p.right_spherical as "rightSpherical",p.right_cylindrical as "rightCylindrical",p.right_axis as "rightAxis",p.right_addition as "rightAddition",p.right_prism as "rightPrism",p.right_base as "rightBase",p.right_dnp as "rightDnp",p.right_height as "rightHeight",p.left_spherical as "leftSpherical",p.left_cylindrical as "leftCylindrical",p.left_axis as "leftAxis",p.left_addition as "leftAddition",p.left_prism as "leftPrism",p.left_base as "leftBase",p.left_dnp as "leftDnp",p.left_height as "leftHeight",p.pupillary_distance as "pupillaryDistance",p.visual_acuity_right as "visualAcuityRight",p.visual_acuity_left as "visualAcuityLeft",p.notes,p.attachment_url as "attachmentUrl",p.custom_fields as "customFields",p.created_at as "createdAt",p.updated_at as "updatedAt"`;
  const result = await rowsAndCount(
    `select ${fields} from volt_core.optical_prescriptions p left join volt_core.customers c on c.id=p.customer_id and c.company_id=p.company_id where ${where} order by p.created_at desc limit $5 offset $6`,
    `select count(*)::int as total from volt_core.optical_prescriptions p left join volt_core.customers c on c.id=p.customer_id and c.company_id=p.company_id where ${where}`,
    params,
    query,
  );
  return { data: { prescriptions: result.rows }, pagination: result.pagination };
}

async function listOpticalOrdersPage(companyId, input = {}) {
  const query = normalizePageQuery(input);
  const params = [companyId, query.search, normalizedFilter(query.filter)];
  const where = `o.company_id=$1
    and ($2='' or lower(concat_ws(' ',o.number::text,s.number::text,c.name,l.name,o.status,o.notes)) like '%'||lower($2)||'%')
    and (
      $3='' or $3='todos'
      or ($3='aguardando receita' and o.status='awaiting_prescription')
      or ($3='aguardando medidas' and o.status='awaiting_measurements')
      or ($3='aguardando laboratorio' and o.status='awaiting_lab')
      or ($3='pronto para producao' and o.status='ready_for_production')
      or ($3='enviado ao laboratorio' and o.status='sent_to_lab')
      or ($3='em producao' and o.status='in_production')
      or ($3='conferencia' and o.status in ('received_from_lab','quality_check'))
      or ($3='pronto' and o.status='ready')
      or ($3='entregue' and o.status='delivered')
      or ($3 in ('cancelado','cancelada') and o.status='canceled')
    )`;
  const fields = `o.id,o.number,o.sale_id as "saleId",s.number as "saleNumber",o.customer_id as "customerId",c.name as "customerName",o.prescription_id as "prescriptionId",o.service_order_id as "serviceOrderId",so.number as "serviceOrderNumber",o.laboratory_id as "laboratoryId",l.name as "laboratoryName",o.frame_product_id as "frameProductId",fp.name as "frameName",o.lens_product_id as "lensProductId",lp.name as "lensName",o.status,o.promised_date as "promisedDate",o.technical_measurements as "technicalMeasurements",o.lens_details as "lensDetails",o.frame_details as "frameDetails",o.quality_check as "qualityCheck",o.notes,o.created_at as "createdAt",o.updated_at as "updatedAt"`;
  const joins = `from volt_core.optical_orders o join volt_core.sales s on s.id=o.sale_id and s.company_id=o.company_id join volt_core.customers c on c.id=o.customer_id and c.company_id=o.company_id left join volt_core.service_orders so on so.id=o.service_order_id and so.company_id=o.company_id left join volt_core.optical_laboratories l on l.id=o.laboratory_id and l.company_id=o.company_id left join volt_core.products fp on fp.id=o.frame_product_id and fp.company_id=o.company_id left join volt_core.products lp on lp.id=o.lens_product_id and lp.company_id=o.company_id`;
  const result = await rowsAndCount(
    `select ${fields} ${joins} where ${where} order by o.number desc limit $4 offset $5`,
    `select count(*)::int as total ${joins} where ${where}`,
    params,
    query,
  );
  return { data: { opticalOrders: result.rows }, pagination: result.pagination };
}

async function listOpticalLaboratories(companyId) {
  const result = await db.query(`select id,name,document,contact_name as "contactName",phone,email,
      default_lead_days as "defaultLeadDays",notes,active,created_at as "createdAt",updated_at as "updatedAt"
    from volt_core.optical_laboratories
    where company_id=$1
    order by active desc,lower(name) asc`, [companyId]);
  return { data: { opticalLaboratories: result.rows }, pagination: null };
}

module.exports = {
  optical_laboratories: { capability: "optical.laboratories", loader: listOpticalLaboratories },
  optical_orders: { capability: "optical.orders", loader: listOpticalOrdersPage },
  prescriptions: { capability: "optical.prescriptions", loader: listPrescriptionsPage },
};
