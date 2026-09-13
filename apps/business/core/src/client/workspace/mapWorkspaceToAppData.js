import {
  formatCurrency,
  formatDateTime,
  formatShortDate,
  formatShortTime,
} from "../core/formatters";
import { productStatus } from "../core/records";
import { paymentMethodLabel } from "../core/sales";
import { applyExtensionWorkspaceMappings } from "../extensions/registry";

function dateInputValue(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function cleanDisplayValue(value) {
  const text = String(value || "").trim();
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!text || ["-", "selecione", "preencha", "null", "undefined"].includes(normalized)) return "";
  return text;
}

function saleStatusLabel(status) {
  return ({
    finalized: "Finalizada",
    canceled: "Cancelada",
    open: "Aberta",
    pending: "Pendente",
  })[String(status || "").toLowerCase()] || status || "Indefinida";
}

function receivableStatusLabel(status) {
  return ({
    awaiting_deposit: "Compensar",
    canceled: "Cancelado",
    deposited: "Depositado",
    paid: "Pago",
    partial: "Parcial",
    received: "Pago",
    returned: "Devolvido",
    open: "Aberto",
  })[String(status || "").toLowerCase()] || "Aberto";
}

function serviceOrderStatusLabel(status) {
  return ({
    canceled: "Cancelada",
    delivered: "Entregue",
    in_production: "Em producao",
    open: "Aberta",
    ready: "Pronto",
    waiting_part: "Aguardando recurso",
  })[String(status || "").toLowerCase()] || status || "Aberta";
}

function hasWorkspaceField(workspace, key) {
  return Object.prototype.hasOwnProperty.call(workspace || {}, key);
}

function mapWorkspaceToAppData(workspace, fallback = {}) {
  const stockByProductId = new Map((workspace?.stock || []).map((item) => [item.productId, item]));
  const mappedProducts = hasWorkspaceField(workspace, "products")
    ? (workspace.products || []).map((product) => {
      const stock = stockByProductId.get(product.id);
      const physicalStock = Number(product.physicalStockQuantity ?? stock?.physicalQuantity ?? product.stockQuantity ?? stock?.quantity ?? 0);
      const reservedStock = Number(product.reservedStockQuantity ?? stock?.reservedQuantity ?? 0);
      const availableStock = Number(product.availableStockQuantity ?? stock?.availableQuantity ?? product.stockQuantity ?? stock?.quantity ?? (physicalStock - reservedStock));
      const normalized = {
        id: product.id,
        sku: product.sku || `PRD-${product.number}`,
        ean: product.ean || "",
        name: product.name,
        category: product.category || (product.type === "service" ? "Servicos" : "Produtos"),
        brand: product.brand || "",
        type: product.type === "service" ? "Servico" : "Produto",
        extensions: product.extensions || {},
        catalogType: product.catalogType || "",
        customFields: product.customFields || {},
        stock: product.trackStock ? availableStock : "-",
        physicalStock: product.trackStock ? physicalStock : "-",
        reservedStock: product.trackStock ? reservedStock : "-",
        availableStock: product.trackStock ? availableStock : "-",
        min: product.trackStock ? Number(product.minimumStock || 0) : "-",
        cost: formatCurrency(product.costPrice),
        price: formatCurrency(product.salePrice),
        status: product.trackStock ? "Ok" : "Servico",
        active: product.active !== false,
      };
      return { ...normalized, status: product.active === false ? "Inativo" : productStatus(normalized) };
    })
    : fallback.products || [];

  const next = { ...fallback };

  if (hasWorkspaceField(workspace, "customers")) next.customers = (workspace.customers || []).map((customer) => ({
    id: customer.id,
    name: cleanDisplayValue(customer.name) || "Cliente sem nome",
    document: cleanDisplayValue(customer.document),
    phone: cleanDisplayValue(customer.phone || customer.mobile || customer.whatsapp),
    email: cleanDisplayValue(customer.email),
    segment: customerSegmentLabel(customer, workspace),
    lastBuy: customer.lastPurchaseAt ? formatShortDate(customer.lastPurchaseAt) : customer.lastBuy || "Sem compras",
    balance: formatCurrency(customer.openBalance || customer.balance || 0),
    status: customer.active ? "Ativo" : "Inativo",
    customFields: customer.customFields || {},
  }));

  if (hasWorkspaceField(workspace, "products")) next.products = mappedProducts;

  if (hasWorkspaceField(workspace, "productCategories")) next.productCategories = (workspace.productCategories || []).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description || "",
    status: category.active ? "Ativo" : "Inativo",
    active: category.active,
  }));

  if (hasWorkspaceField(workspace, "productBrands")) next.productBrands = (workspace.productBrands || []).map((brand) => ({
    id: brand.id,
    name: brand.name,
    description: brand.description || "",
    status: brand.active ? "Ativo" : "Inativo",
    active: brand.active,
  }));

  if (hasWorkspaceField(workspace, "sales")) next.sales = (workspace.sales || []).map((sale) => {
    const saleItems = Array.isArray(sale.items) ? sale.items : [];
    const itemSummary = saleItems.length
      ? saleItems.map((item) => {
        const price = Number(item.unitPrice || 0);
        const discount = Number(item.discount || 0);
        return [
          `${Number(item.quantity || 1)}x ${item.description || "Item"}`,
          price ? formatCurrency(price) : "",
          discount ? `desc. ${formatCurrency(discount)}` : "",
        ].filter(Boolean).join(" - ");
      }).join(", ")
      : `${sale.itemCount || 1} item${Number(sale.itemCount || 1) > 1 ? "s" : ""}`;
    return {
      id: `#${sale.number}`,
      recordId: sale.id,
      customer: cleanDisplayValue(sale.customerName) || "Cliente avulso",
      customerId: sale.customerId || null,
      customerDocument: cleanDisplayValue(sale.customerDocument),
      customerPhone: cleanDisplayValue(sale.customerPhone),
      customerEmail: cleanDisplayValue(sale.customerEmail),
      createdAt: sale.createdAt || sale.soldAt || "",
      soldAt: sale.soldAt || sale.createdAt || "",
      date: formatDateTime(sale.soldAt || sale.createdAt),
      dateKey: String(sale.soldAt || sale.createdAt || "").slice(0, 10),
      items: itemSummary,
      itemRows: saleItems,
      status: saleStatusLabel(sale.status),
      statusKey: sale.status || "",
      paymentTiming: sale.paymentTiming || "immediate",
      promisedDeliveryDate: dateInputValue(sale.promisedDeliveryDate || sale.opticalPromisedDate),
      deliveredAt: sale.deliveredAt || null,
      opticalOrderId: sale.opticalOrderId || null,
      opticalOrderNumber: sale.opticalOrderNumber || null,
      opticalOrderStatus: sale.opticalOrderStatus || null,
      fulfillmentReady: sale.paymentTiming === "delivery" && !sale.opticalOrderId,
      total: formatCurrency(sale.total),
      subtotal: formatCurrency(sale.subtotal || 0),
      discount: formatCurrency(sale.discountTotal || sale.discount || 0),
      payments: sale.payments || [],
      notes: sale.notes || "",
      customFields: sale.customFields || {},
      payment: sale.paymentTiming === "delivery" && sale.status === "pending_delivery"
        ? "Pagamento definido na retirada"
        : (sale.payments || []).map((payment) => paymentMethodLabel(payment.method)).join(", ") || "Pix",
    };
  });

  if (hasWorkspaceField(workspace, "inventoryMovements")) next.movements = (workspace.inventoryMovements || []).map((movement) => ({
    id: movement.id,
    type: movement.type === "adjustment" ? "Ajuste" : Number(movement.quantity || 0) < 0 ? "Saida" : "Entrada",
    product: movement.productName,
    quantity: `${Number(movement.quantity || 0) > 0 ? "+" : ""}${Number(movement.quantity || 0)}`,
    reason: movement.reason,
    sourceType: movement.sourceType || "",
    sourceId: movement.sourceId || "",
    isSystemGenerated: ["sale", "sale_reversal"].includes(String(movement.sourceType || "")),
    user: movement.actorName || movement.actorUserName || (movement.actorUserId ? "Sistema" : "Admin"),
    date: formatShortTime(movement.operationalAt || movement.createdAt),
    operationalAt: movement.operationalAt || movement.createdAt,
  }));

  if (hasWorkspaceField(workspace, "stockReservations")) next.stockReservations = (workspace.stockReservations || []).map((reservation) => ({
    id: reservation.id,
    productId: reservation.productId,
    sku: reservation.sku || "-",
    product: reservation.productName || "Produto",
    saleId: reservation.saleId || null,
    saleNumber: reservation.saleNumber || null,
    origin: reservation.saleNumber ? `Pedido #${reservation.saleNumber}` : "Pedido",
    customerId: reservation.customerId || null,
    customer: cleanDisplayValue(reservation.customerName) || "Cliente avulso",
    quantity: Number(reservation.quantity || 0),
    statusKey: reservation.status || "active",
    status: ({ active: "Ativa", consumed: "Consumida", released: "Liberada" })[reservation.status] || reservation.status || "Ativa",
    reservedAt: reservation.reservedAt || reservation.createdAt || null,
    reservedDate: formatDateTime(reservation.reservedAt || reservation.createdAt),
    promisedDeliveryDate: dateInputValue(reservation.promisedDeliveryDate),
    promisedDelivery: reservation.promisedDeliveryDate ? formatShortDate(reservation.promisedDeliveryDate) : "-",
    releasedAt: reservation.releasedAt || null,
    releaseReason: reservation.releaseReason || "",
  }));

  if (hasWorkspaceField(workspace, "receivables")) next.receivables = (workspace.receivables || [])
    .filter((receivable) => receivable.status !== "canceled")
    .map((receivable) => {
      const amount = Number(receivable.amount || 0);
      const paidAmount = Number(receivable.paidAmount || 0);
      const balanceAmount = Number(receivable.balanceAmount ?? (amount - paidAmount));
      const dueDate = dateInputValue(receivable.dueDate);
      const today = new Date().toISOString().slice(0, 10);
      const baseStatus = receivableStatusLabel(receivable.status);
      const isOpen = !["paid", "received", "compensated", "canceled"].includes(String(receivable.status || "").toLowerCase()) && balanceAmount > 0.009;
      const isOverdue = Boolean(isOpen && dueDate && dueDate < today);
      const metadata = receivable.metadata || {};
      const installment = Number(metadata.installment || metadata.installmentNumber || 0);
      const installments = Number(metadata.installments || metadata.installmentCount || 0);
      return {
        id: receivable.id,
        customerId: receivable.customerId || null,
        saleId: receivable.saleId || null,
        saleNumber: receivable.saleNumber || null,
        customer: cleanDisplayValue(receivable.customerName) || "Cliente avulso",
        origin: receivable.saleNumber ? `Venda #${receivable.saleNumber}` : (receivable.description || (receivable.saleId ? "Venda" : "Recebivel")),
        description: receivable.description || "",
        installment: installment && installments ? `${installment}/${installments}` : "-",
        method: paymentMethodLabel(receivable.type),
        methodKey: receivable.type,
        dueDate: dateInputValue(receivable.dueDate),
        due: formatShortDate(receivable.dueDate),
        amount,
        paidAmount,
        balanceAmount,
        originalValue: formatCurrency(amount),
        paidValue: formatCurrency(paidAmount),
        balanceValue: formatCurrency(balanceAmount),
        value: formatCurrency(balanceAmount),
        baseStatus,
        isOverdue,
        status: isOverdue ? "Vencido" : baseStatus,
        metadata,
        originalDueDate: dateInputValue(receivable.metadata?.originalDueDate || receivable.metadata?.lastDueDateCorrection?.previousDueDate || receivable.dueDate),
        dueDateSource: receivable.metadata?.dueDateSource || "legacy_unknown",
        currentDueDateSource: receivable.metadata?.currentDueDateSource
          || (receivable.metadata?.lastDueDateCorrection ? "administrative_correction" : receivable.metadata?.dueDateSource)
          || "legacy_unknown",
        lastDueDateCorrection: metadata.lastDueDateCorrection || null,
        customFields: receivable.customFields || {},
      };
    });

  if (hasWorkspaceField(workspace, "cashMovements")) next.cashRows = (workspace.cashMovements || []).map((row) => ({
    id: row.id,
    sessionId: row.sessionId || null,
    label: row.description,
    type: row.type === "entry" ? "Entrada" : "Saida",
    value: formatCurrency(row.amount),
    time: formatShortTime(row.operationalAt || row.createdAt),
    operationalAt: row.operationalAt || row.createdAt,
    createdAt: row.createdAt,
    method: paymentMethodLabel(row.paymentMethod),
    operator: row.actorName || row.actorUserName || (row.actorUserId ? "Sistema" : "Admin"),
  }));

  if (hasWorkspaceField(workspace, "cashSummary")) next.cashSummary = {
    balance: Number(workspace?.cashSummary?.balance || 0),
    expectedAmount: Number(workspace?.cashSummary?.expectedAmount || 0),
    movementCount: Number(workspace?.cashSummary?.movementCount || 0),
    movementTotal: Number(workspace?.cashSummary?.movementTotal || 0),
    entryTotal: Number(workspace?.cashSummary?.entryTotal || 0),
    exitTotal: Number(workspace?.cashSummary?.exitTotal || 0),
    openingAmount: Number(workspace?.cashSummary?.openingAmount || 0),
    sessionId: workspace?.cashSummary?.sessionId || null,
    sessionNumber: workspace?.cashSummary?.sessionNumber || null,
    status: workspace?.cashSummary?.status || "closed",
    openedAt: workspace?.cashSummary?.openedAt || null,
  };

  if (hasWorkspaceField(workspace, "cashSessions")) next.cashSessions = workspace.cashSessions || [];
  if (hasWorkspaceField(workspace, "receipts")) next.receipts = (workspace.receipts || []).map((receipt) => ({
    id: `RC-${receipt.number}`,
    customerId: receipt.customerId || null,
    customer: receipt.customerName || receipt.payload?.customer || "Cliente avulso",
    sale: receipt.payload?.saleNumber ? `#${receipt.payload.saleNumber}` : "-",
    total: formatCurrency(receipt.total || receipt.payload?.total),
    status: "Emitido",
    html: receipt.html || "",
  }));

  if (hasWorkspaceField(workspace, "expenses")) next.expenses = (workspace.expenses || []).map((expense) => ({
    id: expense.id,
    name: expense.name,
    category: expense.category,
    due: formatShortDate(expense.dueDate),
    dueDate: expense.dueDate,
    value: formatCurrency(expense.remainingAmount || expense.amount),
    status: expense.status === "canceled" ? "Cancelado" : expense.status === "paid" ? "Pago" : "Aberto",
    customFields: expense.customFields || {},
  }));

  if (hasWorkspaceField(workspace, "serviceOrders")) next.serviceOrders = (workspace.serviceOrders || []).map((order) => ({
    id: `OS-${order.number}`,
    recordId: order.id,
    customerId: order.customerId || null,
    customer: order.customerName || "-",
    service: order.service || "-",
    statusKey: order.status || "open",
    status: serviceOrderStatusLabel(order.status),
    due: formatShortDate(order.dueDate),
    dueDate: order.dueDate,
    owner: order.owner || "-",
    customFields: order.customFields || {},
    notes: order.notes || "",
  }));

  if (hasWorkspaceField(workspace, "paymentMethods")) next.paymentMethods = (workspace.paymentMethods || []).map((method) => ({
    id: method.id,
    name: method.name,
    type: method.kind === "receivable" ? "Recebivel" : "Imediato",
    fee: `${Number(method.fee || 0).toFixed(2).replace(".", ",")}%`,
    settlement: Number(method.settlementDays || 0) ? `D+${method.settlementDays}` : "Na hora",
    status: method.active ? "Ativo" : "Inativo",
  }));

  if (hasWorkspaceField(workspace, "users")) next.users = (workspace.users || []).map((member) => ({
    id: member.id,
    name: member.name,
    email: member.email,
    role: member.role,
    permissions: Array.isArray(member.permissions) ? member.permissions : [],
    screens: Array.isArray(member.screens) ? member.screens : [],
    lastAccess: member.lastLoginAt ? formatShortDate(member.lastLoginAt) : "Nunca",
    status: member.status === "active" ? "Ativo" : member.status,
  }));

  if (hasWorkspaceField(workspace, "auditLogs")) next.auditEvents = (workspace.auditLogs || []).map((event) => ({
    id: event.id,
    title: event.action,
    description: `${event.entityType || "registro"} ${event.entityId || ""}`.trim(),
    actor: event.actorUserId || "Sistema",
    time: formatShortTime(event.createdAt),
    date: formatShortDate(event.createdAt),
    entityType: event.entityType || "-",
    entityId: event.entityId || "-",
    status: event.metadata?.status || event.metadata?.severity || "info",
    metadata: event.metadata || {},
  }));

  if (workspace?.configuration) {
    next.customFields = workspace.configuration.settings?.customFields || [];
    next.workflows = workspace.configuration.settings?.workflows || [];
    next.modulePlans = workspace.configuration.settings?.modulePlans || [];
    next.settings = {
      companyName: workspace.configuration.name || "",
      legalName: workspace.configuration.settings?.legalName || "",
      document: workspace.configuration.document || "",
      phone: workspace.configuration.phone || "",
      email: workspace.configuration.settings?.email || "",
      requireOpenCashSession: workspace.configuration.settings?.requireOpenCashSession === true,
      allowAnonymousCustomer: workspace.configuration.settings?.allowAnonymousCustomer !== false,
      requireInventoryAdjustmentReason: workspace.configuration.settings?.requireInventoryAdjustmentReason !== false,
    };
  }

  return applyExtensionWorkspaceMappings(workspace, next);
}

function customerSegmentLabel(customer, workspace) {
  const segment = customer.customFields?.segment || workspace?.configuration?.segmentKey || "Core";
  const normalized = String(segment)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (normalized === "optical" || normalized === "otica") return "Otica";
  if (normalized === "service" || normalized === "servico") return "Servico";
  if (normalized === "retail" || normalized === "varejo") return "Varejo";
  return segment;
}

export {
  mapWorkspaceToAppData,
};
