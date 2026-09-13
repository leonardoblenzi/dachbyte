const repository = require("./repositories/inMemoryCoreRepository");
const { badRequest, createError, notFound } = require("./errors");
const { createId } = require("./id");
const { sumMoney, toMoney } = require("./money");
const {
  getPaymentMethod,
  isImmediatePayment,
  isReceivablePayment,
  listPaymentMethods,
} = require("./paymentMethods");
const generalTemplate = require("./templates/general");
const {
  assertCashSessionTransition,
  assertReceivableTransition,
  assertSaleTransition,
} = require("./stateMachines");
const {
  validateCashSessionClose,
  validateCashSessionOpen,
  validateCustomerInput,
  validatePaymentInput,
  validateProductInput,
  validateSaleInput,
} = require("./validators");
const { emitEvent, listEvents } = require("./events");

const ACTIONABLE_RECEIVABLE_STATUSES = ["open", "partial", "awaiting_deposit", "deposited", "returned"];

function normalizeEan(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function assertProductEanAvailable(companyId, ean, productId = null) {
  if (!ean) return;
  const duplicate = Array.from(repository.getCompanyStore(companyId).products.values())
    .find((product) => product.ean === ean && product.id !== productId);
  if (duplicate) {
    throw createError("Este EAN ja esta cadastrado em outro produto desta empresa.", 409, "PRODUCT_EAN_DUPLICATE");
  }
}

function upsertCompanyProfile(companyId, input = {}) {
  const store = repository.getCompanyStore(companyId);
  const now = new Date().toISOString();
  store.profile = {
    ...store.profile,
    name: input.name === undefined ? store.profile.name : input.name,
    document: input.document === undefined ? store.profile.document : input.document,
    phone: input.phone === undefined ? store.profile.phone : input.phone,
    address: input.address === undefined ? store.profile.address : input.address,
    timezone: input.timezone === undefined ? store.profile.timezone : input.timezone,
    updatedAt: now,
  };
  addAuditLog(store, "company.profile.updated", {
    entityType: "company",
    entityId: companyId,
    before: null,
    after: store.profile,
  });
  emitEvent(store, "company.profile.updated", { companyId });
  return store.profile;
}

function getCompanyProfile(companyId) {
  return repository.getCompanyStore(companyId).profile;
}

function createCustomer(companyId, input) {
  validateCustomerInput(input);

  const store = repository.getCompanyStore(companyId);
  const now = new Date().toISOString();
  const customer = {
    id: createId("cus"),
    number: repository.nextNumber(companyId, "customer"),
    name: String(input.name).trim(),
    phone: input.phone || null,
    document: input.document || null,
    email: input.email || null,
    address: input.address || null,
    notes: input.notes || null,
    active: input.active !== false,
    createdAt: now,
    updatedAt: now,
  };

  store.customers.set(customer.id, customer);
  addAuditLog(store, "customer.created", {
    entityType: "customer",
    entityId: customer.id,
    after: customer,
  });
  emitEvent(store, "customer.created", { customerId: customer.id });
  return customer;
}

function listCustomers(companyId, filters = {}) {
  return filterBySearch(
    Array.from(repository.getCompanyStore(companyId).customers.values()),
    filters.search,
    ["name", "phone", "document", "email"],
  ).filter((customer) => filters.active === undefined || String(customer.active) === String(filters.active));
}

function getCustomer(companyId, customerId) {
  const customer = repository.getCompanyStore(companyId).customers.get(customerId);
  if (!customer) throw notFound("Cliente nao encontrado", "CUSTOMER_NOT_FOUND");
  return customer;
}

function updateCustomer(companyId, customerId, input) {
  const store = repository.getCompanyStore(companyId);
  const current = getCustomer(companyId, customerId);
  const updated = {
    ...current,
    name: input.name === undefined ? current.name : String(input.name).trim(),
    phone: input.phone === undefined ? current.phone : input.phone,
    document: input.document === undefined ? current.document : input.document,
    email: input.email === undefined ? current.email : input.email,
    address: input.address === undefined ? current.address : input.address,
    notes: input.notes === undefined ? current.notes : input.notes,
    active: input.active === undefined ? current.active : input.active !== false,
    updatedAt: new Date().toISOString(),
  };

  validateCustomerInput(updated);

  store.customers.set(customerId, updated);
  addAuditLog(store, "customer.updated", {
    entityType: "customer",
    entityId: customerId,
    before: current,
    after: updated,
  });
  emitEvent(store, "customer.updated", { customerId });
  return updated;
}

function setCustomerActive(companyId, customerId, active) {
  return updateCustomer(companyId, customerId, { active });
}

function storeValues(collection) {
  if (!collection) return [];
  return collection instanceof Map ? Array.from(collection.values()) : Array.isArray(collection) ? collection : [];
}

function deleteCustomer(companyId, customerId) {
  const store = repository.getCompanyStore(companyId);
  const customer = getCustomer(companyId, customerId);
  if (customer.active) {
    throw badRequest("Desative o cliente antes de excluir.", "CUSTOMER_MUST_BE_INACTIVE");
  }
  const hasDependencies = storeValues(store.sales).some((sale) => sale.customerId === customerId)
    || storeValues(store.receivables).some((receivable) => receivable.customerId === customerId)
    || storeValues(store.serviceOrders).some((order) => order.customerId === customerId)
    || storeValues(store.prescriptions).some((prescription) => prescription.customerId === customerId)
    || storeValues(store.opticalOrders).some((order) => order.customerId === customerId);
  if (hasDependencies) {
    throw badRequest("Cliente possui historico vinculado e nao pode ser excluido.", "CUSTOMER_HAS_HISTORY");
  }
  store.customers.delete(customerId);
  addAuditLog(store, "customer.deleted", {
    entityType: "customer",
    entityId: customerId,
    before: customer,
  });
  emitEvent(store, "customer.deleted", { customerId });
  return customer;
}

function createProduct(companyId, input) {
  validateProductInput(input);

  const salePrice = toMoney(input.salePrice);
  const ean = normalizeEan(input.ean);
  assertProductEanAvailable(companyId, ean);

  const now = new Date().toISOString();
  const product = {
    id: createId("prd"),
    number: repository.nextNumber(companyId, "product"),
    sku: input.sku || null,
    ean,
    name: String(input.name).trim(),
    category: input.category || "Produtos",
    brand: input.brand || null,
    type: input.type || "product",
    salePrice,
    costPrice: toMoney(input.costPrice),
    minimumStock: Number(input.minimumStock || 0),
    trackStock: input.trackStock !== false,
    active: input.active !== false,
    createdAt: now,
    updatedAt: now,
  };

  repository.getCompanyStore(companyId).products.set(product.id, product);
  addAuditLog(repository.getCompanyStore(companyId), "product.created", {
    entityType: "product",
    entityId: product.id,
    after: product,
  });
  emitEvent(repository.getCompanyStore(companyId), "product.created", { productId: product.id });
  return product;
}

function listProducts(companyId, filters = {}) {
  return filterBySearch(
    Array.from(repository.getCompanyStore(companyId).products.values()),
    filters.search,
    ["sku", "ean", "name", "brand", "category"],
  ).filter((product) => filters.active === undefined || String(product.active) === String(filters.active));
}

function getProduct(companyId, productId) {
  const product = repository.getCompanyStore(companyId).products.get(productId);
  if (!product) throw notFound("Produto nao encontrado", "PRODUCT_NOT_FOUND");
  return product;
}

function updateProduct(companyId, productId, input) {
  const store = repository.getCompanyStore(companyId);
  const current = getProduct(companyId, productId);
  const salePrice = input.salePrice === undefined ? current.salePrice : toMoney(input.salePrice);
  const ean = input.ean === undefined ? current.ean : normalizeEan(input.ean);
  assertProductEanAvailable(companyId, ean, productId);

  const updated = {
    ...current,
    sku: input.sku === undefined ? current.sku : input.sku,
    ean,
    name: input.name === undefined ? current.name : String(input.name).trim(),
    category: input.category === undefined ? current.category : input.category,
    brand: input.brand === undefined ? current.brand : input.brand || null,
    type: input.type === undefined ? current.type : input.type,
    salePrice,
    costPrice: input.costPrice === undefined ? current.costPrice : toMoney(input.costPrice),
    minimumStock: input.minimumStock === undefined ? current.minimumStock : Number(input.minimumStock || 0),
    trackStock: input.trackStock === undefined ? current.trackStock : input.trackStock !== false,
    active: input.active === undefined ? current.active : input.active !== false,
    updatedAt: new Date().toISOString(),
  };

  validateProductInput(updated);

  store.products.set(productId, updated);
  addAuditLog(store, "product.updated", {
    entityType: "product",
    entityId: productId,
    before: current,
    after: updated,
  });
  emitEvent(store, "product.updated", { productId });
  return updated;
}

function setProductActive(companyId, productId, active) {
  return updateProduct(companyId, productId, { active });
}

function deleteProduct(companyId, productId) {
  const store = repository.getCompanyStore(companyId);
  const product = getProduct(companyId, productId);
  if (product.active) {
    throw badRequest("Desative o produto antes de excluir.", "PRODUCT_MUST_BE_INACTIVE");
  }
  const hasDependencies = storeValues(store.sales).some((sale) => sale.items.some((item) => item.productId === productId))
    || storeValues(store.inventoryMovements).some((movement) => movement.productId === productId)
    || storeValues(store.opticalOrders).some((order) => order.frameProductId === productId || order.lensProductId === productId);
  if (hasDependencies) {
    throw badRequest("Produto possui historico vinculado e nao pode ser excluido.", "PRODUCT_HAS_HISTORY");
  }
  store.products.delete(productId);
  addAuditLog(store, "product.deleted", {
    entityType: "product",
    entityId: productId,
    before: product,
  });
  emitEvent(store, "product.deleted", { productId });
  return product;
}

function searchSaleCatalog(companyId, query) {
  const products = listProducts(companyId, { search: query, active: true });
  const stock = new Map(getStockPosition(companyId).map((item) => [item.productId, item]));

  return products.map((product) => ({
    ...product,
    stock: stock.get(product.id)?.quantity || 0,
    lowStock: stock.get(product.id)?.lowStock || false,
  }));
}

function addInventoryEntry(companyId, input) {
  return createInventoryMovement(companyId, {
    ...input,
    type: "entry",
    quantity: requirePositiveQuantity(input.quantity),
  });
}

function addInventoryExit(companyId, input) {
  return createInventoryMovement(companyId, {
    ...input,
    type: "exit",
    quantity: -requirePositiveQuantity(input.quantity),
  });
}

function addInventoryAdjustment(companyId, input) {
  if (!input || input.quantity === undefined) {
    throw badRequest("Quantidade do ajuste e obrigatoria", "INVENTORY_ADJUSTMENT_QUANTITY_REQUIRED");
  }
  if (!input.reason) {
    throw badRequest("Motivo do ajuste e obrigatorio", "INVENTORY_ADJUSTMENT_REASON_REQUIRED");
  }

  return createInventoryMovement(companyId, {
    ...input,
    type: "adjustment",
    quantity: Number(input.quantity),
  });
}

function listInventoryMovements(companyId) {
  return repository.getCompanyStore(companyId).inventoryMovements;
}

function getStockPosition(companyId) {
  const store = repository.getCompanyStore(companyId);
  const balances = new Map();

  for (const product of store.products.values()) {
    balances.set(product.id, {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
      minimumStock: product.minimumStock,
      quantity: 0,
      lowStock: false,
    });
  }

  for (const movement of store.inventoryMovements) {
    if (!balances.has(movement.productId)) continue;
    balances.get(movement.productId).quantity += movement.quantity;
  }

  return Array.from(balances.values()).map((item) => ({
    ...item,
    quantity: toMoney(item.quantity),
    lowStock: item.quantity <= item.minimumStock,
  }));
}

function createSale(companyId, input) {
  return repository.runInTransaction(companyId, () => createSaleAtomic(companyId, input));
}

function createSaleAtomic(companyId, input) {
  validateSaleInput(input);

  const store = repository.getCompanyStore(companyId);
  const customer = input.customerId ? store.customers.get(input.customerId) : null;

  if (input.customerId && !customer) {
    throw notFound("Cliente nao encontrado", "CUSTOMER_NOT_FOUND");
  }

  const saleId = createId("sal");
  const now = new Date().toISOString();
  const items = input.items.map((item) => buildSaleItem(store, item));
  ensureStockAvailability(companyId, items);

  const subtotal = sumMoney(items.map((item) => item.total));
  const discount = toMoney(input.discount);
  const total = toMoney(subtotal - discount);

  if (total < 0) {
    throw badRequest("Desconto maior que o total da venda", "SALE_TOTAL_INVALID");
  }

  const payments = normalizePayments(input.payments, total);
  const sale = {
    id: saleId,
    number: repository.nextNumber(companyId, "sale"),
    customerId: customer ? customer.id : null,
    customerName: customer ? customer.name : input.customerName || null,
    status: input.status || "finalized",
    items,
    subtotal,
    discount,
    total,
    payments,
    notes: input.notes || null,
    soldAt: input.soldAt || now,
    createdAt: now,
    updatedAt: now,
  };

  store.sales.set(sale.id, sale);
  addAuditLog(store, "sale.created", {
    entityType: "sale",
    entityId: sale.id,
    after: sale,
    amount: sale.total,
  });
  emitEvent(store, "sale.created", { saleId: sale.id, total: sale.total });

  for (const item of items) {
    if (!item.trackStock) continue;
    createInventoryMovement(companyId, {
      productId: item.productId,
      type: "sale",
      quantity: -item.quantity,
      reason: `Venda ${sale.number}`,
      referenceType: "sale",
      referenceId: sale.id,
    });
  }

  createCashMovementsForSale(companyId, sale);
  const receivables = createReceivablesForSale(companyId, sale);
  const receipt = createReceiptForSale(companyId, sale);

  return {
    sale,
    receivables,
    receipt,
  };
}

function listSales(companyId, filters = {}) {
  let sales = Array.from(repository.getCompanyStore(companyId).sales.values());
  sales = filterByDateRange(sales, filters, "soldAt");

  if (filters.status) {
    sales = sales.filter((sale) => sale.status === filters.status);
  }
  if (filters.customerId) {
    sales = sales.filter((sale) => sale.customerId === filters.customerId);
  }
  if (filters.paymentMethod) {
    sales = sales.filter((sale) => sale.payments.some((payment) => payment.method === filters.paymentMethod));
  }
  if (filters.productId) {
    sales = sales.filter((sale) => sale.items.some((item) => item.productId === filters.productId));
  }

  return sales;
}

function getSale(companyId, saleId) {
  const sale = repository.getCompanyStore(companyId).sales.get(saleId);
  if (!sale) throw notFound("Venda nao encontrada", "SALE_NOT_FOUND");
  return sale;
}

function cancelSale(companyId, saleId, input = {}) {
  return repository.runInTransaction(companyId, () => cancelSaleAtomic(companyId, saleId, input));
}

function deleteCanceledSale(companyId, saleId, input = {}) {
  return repository.runInTransaction(companyId, () => {
    const store = repository.getCompanyStore(companyId);
    const sale = getSale(companyId, saleId);
    if (sale.status !== "canceled") {
      throw badRequest("Somente vendas canceladas podem ser excluidas.", "SALE_MUST_BE_CANCELED");
    }
    store.sales.delete(saleId);
    Array.from(store.receipts.entries()).forEach(([key, receipt]) => {
      if (receipt.saleId === saleId || key === saleId) store.receipts.delete(key);
    });
    Array.from(store.receivables.entries()).forEach(([key, receivable]) => {
      if (receivable.saleId === saleId && receivable.status === "canceled") store.receivables.delete(key);
    });
    addAuditLog(store, "sale.deleted", {
      entityType: "sale",
      entityId: sale.id,
      before: sale,
      after: null,
      reason: input.reason || null,
    });
    emitEvent(store, "sale.deleted", { saleId: sale.id });
    return sale;
  });
}

function cancelSaleAtomic(companyId, saleId, input = {}) {
  const store = repository.getCompanyStore(companyId);
  const sale = getSale(companyId, saleId);

  assertSaleTransition(sale.status, "canceled");
  const settledReceivables = Array.from(store.receivables.values()).filter(
    (receivable) => receivable.saleId === sale.id && ["received", "compensated"].includes(receivable.status),
  );
  if (settledReceivables.length && !input.allowSettledReversal) {
    throw badRequest("Venda com recebimento baixado exige estorno manual", "SALE_HAS_SETTLED_RECEIVABLES");
  }

  const now = new Date().toISOString();
  const canceledSale = {
    ...sale,
    status: "canceled",
    cancelReason: input.reason || null,
    canceledAt: now,
    updatedAt: now,
  };

  store.sales.set(saleId, canceledSale);

  for (const item of sale.items) {
    if (!item.trackStock) continue;
    createInventoryMovement(companyId, {
      productId: item.productId,
      type: "sale_cancel",
      quantity: item.quantity,
      reason: `Cancelamento venda ${sale.number}`,
      referenceType: "sale",
      referenceId: sale.id,
    });
  }

  for (const movement of store.cashMovements) {
    if (movement.referenceType === "sale" && movement.referenceId === sale.id) {
      createCashReversal(companyId, movement, `Cancelamento venda ${sale.number}`);
    }
  }

  for (const receivable of store.receivables.values()) {
    if (receivable.saleId === sale.id && !["received", "compensated"].includes(receivable.status)) {
      updateReceivable(companyId, receivable.id, {
        status: "canceled",
        canceledAt: now,
        notes: input.reason || receivable.notes,
      });
    }
  }

  if (settledReceivables.length && input.allowSettledReversal) {
    for (const receivable of settledReceivables) {
      for (const movement of store.cashMovements) {
        if (movement.referenceType === "receivable" && movement.referenceId === receivable.id) {
          createCashReversal(companyId, movement, `Estorno recebimento venda ${sale.number}`);
        }
      }
      store.receivables.set(receivable.id, {
        ...receivable,
        reversed: true,
        reversedAt: now,
        notes: input.reason || receivable.notes,
        updatedAt: now,
      });
    }
  }

  addAuditLog(store, "sale.canceled", {
    entityType: "sale",
    entityId: sale.id,
    before: sale,
    after: canceledSale,
    reason: input.reason || null,
  });
  emitEvent(store, "sale.canceled", { saleId: sale.id });
  return canceledSale;
}

function listReceipts(companyId) {
  return Array.from(repository.getCompanyStore(companyId).receipts.values());
}

function getReceiptBySale(companyId, saleId) {
  const receipt = repository.getCompanyStore(companyId).receipts.get(saleId);
  if (!receipt) throw notFound("Recibo nao encontrado", "RECEIPT_NOT_FOUND");
  return receipt;
}

function createExpense(companyId, input = {}) {
  if (!input.name) {
    throw badRequest("Nome da despesa e obrigatorio", "EXPENSE_NAME_REQUIRED");
  }

  const amount = toMoney(input.amount);
  if (amount <= 0) {
    throw badRequest("Valor da despesa deve ser positivo", "EXPENSE_AMOUNT_INVALID");
  }

  const store = repository.getCompanyStore(companyId);
  const now = new Date().toISOString();
  const expense = {
    id: createId("exp"),
    number: repository.nextNumber(companyId, "expense"),
    name: String(input.name).trim(),
    category: input.category || "Operacional",
    supplier: input.supplier || null,
    dueDate: formatDateOnly(input.dueDate || input.due || now, store.profile.timezone),
    amount,
    paidAmount: 0,
    remainingAmount: amount,
    status: input.status || "open",
    paymentMethod: input.paymentMethod || null,
    paidAt: null,
    canceledAt: null,
    notes: input.notes || null,
    createdAt: now,
    updatedAt: now,
  };

  store.expenses.set(expense.id, expense);
  addAuditLog(store, "expense.created", {
    entityType: "expense",
    entityId: expense.id,
    after: expense,
    amount: expense.amount,
  });
  emitEvent(store, "expense.created", { expenseId: expense.id, amount: expense.amount });
  return expense;
}

function listExpenses(companyId, filters = {}) {
  let expenses = Array.from(repository.getCompanyStore(companyId).expenses.values());
  expenses = filterByDateRange(expenses, filters, "dueDate");

  if (filters.status) {
    expenses = expenses.filter((expense) => expense.status === filters.status);
  }
  if (filters.category) {
    expenses = expenses.filter((expense) => expense.category === filters.category);
  }

  return filterBySearch(expenses, filters.search, ["name", "category", "supplier", "notes"]);
}

function getExpense(companyId, expenseId) {
  const expense = repository.getCompanyStore(companyId).expenses.get(expenseId);
  if (!expense) throw notFound("Despesa nao encontrada", "EXPENSE_NOT_FOUND");
  return expense;
}

function updateExpense(companyId, expenseId, input = {}) {
  const store = repository.getCompanyStore(companyId);
  const current = getExpense(companyId, expenseId);
  const amount = input.amount === undefined ? current.amount : toMoney(input.amount);
  if (amount <= 0) {
    throw badRequest("Valor da despesa deve ser positivo", "EXPENSE_AMOUNT_INVALID");
  }
  if (amount < current.paidAmount) {
    throw badRequest("Valor nao pode ser menor que o total ja pago", "EXPENSE_AMOUNT_BELOW_PAID");
  }

  const updated = {
    ...current,
    name: input.name === undefined ? current.name : String(input.name).trim(),
    category: input.category === undefined ? current.category : input.category,
    supplier: input.supplier === undefined ? current.supplier : input.supplier,
    dueDate: input.dueDate === undefined ? current.dueDate : formatDateOnly(input.dueDate, store.profile.timezone),
    amount,
    paidAmount: current.paidAmount,
    remainingAmount: toMoney(amount - current.paidAmount),
    status: input.status === undefined ? current.status : input.status,
    paymentMethod: input.paymentMethod === undefined ? current.paymentMethod : input.paymentMethod,
    paidAt: input.paidAt === undefined ? current.paidAt : input.paidAt,
    canceledAt: input.canceledAt === undefined ? current.canceledAt : input.canceledAt,
    notes: input.notes === undefined ? current.notes : input.notes,
    updatedAt: new Date().toISOString(),
  };

  store.expenses.set(expenseId, updated);
  addAuditLog(store, "expense.updated", {
    entityType: "expense",
    entityId: expenseId,
    before: current,
    after: updated,
  });
  emitEvent(store, "expense.updated", { expenseId, status: updated.status });
  return updated;
}

function payExpense(companyId, expenseId, input = {}) {
  return repository.runInTransaction(companyId, () => {
    const store = repository.getCompanyStore(companyId);
    const current = getExpense(companyId, expenseId);
    if (current.status === "paid") {
      throw badRequest("Despesa ja foi paga", "EXPENSE_ALREADY_PAID");
    }
    if (current.status === "canceled") {
      throw badRequest("Despesa cancelada nao pode ser paga", "EXPENSE_CANCELED");
    }

    const amount = input.amount === undefined ? current.remainingAmount : toMoney(input.amount);
    if (amount <= 0 || amount > current.remainingAmount) {
      throw badRequest("Valor de pagamento invalido", "EXPENSE_PAYMENT_AMOUNT_INVALID");
    }

    const paidAmount = toMoney(current.paidAmount + amount);
    const remainingAmount = toMoney(current.amount - paidAmount);
    const paid = {
      ...current,
      paidAmount,
      remainingAmount,
      status: remainingAmount === 0 ? "paid" : "partial",
      paymentMethod: input.paymentMethod || current.paymentMethod || "cash",
      paidAt: input.paidAt || new Date().toISOString(),
      notes: input.notes || current.notes,
      updatedAt: new Date().toISOString(),
    };

    store.expenses.set(expenseId, paid);
    store.cashMovements.push({
      id: createId("csh"),
      number: repository.nextNumber(companyId, "cashMovement"),
      type: "expense",
      direction: "out",
      method: paid.paymentMethod,
      amount,
      description: `Pagamento despesa ${paid.number} - ${paid.name}`,
      referenceType: "expense",
      referenceId: paid.id,
      cashSessionId: getOpenCashSession(companyId)?.id || null,
      createdAt: paid.paidAt,
    });

    addAuditLog(store, "expense.paid", {
      entityType: "expense",
      entityId: expenseId,
      before: current,
      after: paid,
      amount,
      reason: input.notes || null,
    });
    emitEvent(store, "expense.paid", { expenseId, amount, status: paid.status });
    return paid;
  });
}

function cancelExpense(companyId, expenseId, input = {}) {
  const expense = getExpense(companyId, expenseId);
  if (expense.status === "paid") {
    throw badRequest("Despesa paga exige estorno manual no caixa", "EXPENSE_ALREADY_PAID");
  }

  return updateExpense(companyId, expenseId, {
    status: "canceled",
    notes: input.reason || input.notes || expense.notes,
    canceledAt: input.canceledAt || new Date().toISOString(),
  });
}

function createManualCashMovement(companyId, input) {
  if (!input || !["in", "out"].includes(input.direction)) {
    throw badRequest("Direcao do movimento de caixa invalida", "CASH_DIRECTION_INVALID");
  }

  const amount = toMoney(input.amount);
  if (amount <= 0) {
    throw badRequest("Valor do movimento de caixa deve ser positivo", "CASH_AMOUNT_INVALID");
  }

  const movement = {
    id: createId("csh"),
    number: repository.nextNumber(companyId, "cashMovement"),
    type: "manual",
    direction: input.direction,
    method: input.method || "cash",
    amount,
    description: input.description || null,
    referenceType: null,
    referenceId: null,
    cashSessionId: getOpenCashSession(companyId)?.id || null,
    operationalAt: input.operationalAt || input.operational_at || new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };

  repository.getCompanyStore(companyId).cashMovements.push(movement);
  addAuditLog(repository.getCompanyStore(companyId), "cash.manual_movement.created", {
    entityType: "cash_movement",
    entityId: movement.id,
    after: movement,
    amount: movement.amount,
    reason: input.description || null,
  });
  emitEvent(repository.getCompanyStore(companyId), "cash.movement.created", { movementId: movement.id });
  return movement;
}

function listCashMovements(companyId, filters = {}) {
  let movements = repository.getCompanyStore(companyId).cashMovements;
  movements = filterByDateRange(movements, filters, "operationalAt");

  if (filters.method) {
    movements = movements.filter((movement) => movement.method === filters.method);
  }
  if (filters.type) {
    movements = movements.filter((movement) => movement.type === filters.type);
  }
  if (filters.cashSessionId) {
    movements = movements.filter((movement) => movement.cashSessionId === filters.cashSessionId);
  }

  return movements;
}

function getCashSummary(companyId) {
  const movements = listCashMovements(companyId);
  const activeMovements = movements.filter((movement) => !movement.canceled);
  const totalIn = sumMoney(activeMovements.filter((movement) => movement.direction === "in").map((movement) => movement.amount));
  const totalOut = sumMoney(activeMovements.filter((movement) => movement.direction === "out").map((movement) => movement.amount));

  return {
    totalIn,
    totalOut,
    balance: toMoney(totalIn - totalOut),
    byMethod: summarizeByMethod(activeMovements),
    openSession: getOpenCashSession(companyId),
  };
}

function openCashSession(companyId, input = {}) {
  validateCashSessionOpen(input);
  const store = repository.getCompanyStore(companyId);
  const openSession = getOpenCashSession(companyId);
  if (openSession) {
    throw badRequest("Ja existe um caixa aberto", "CASH_SESSION_ALREADY_OPEN");
  }

  const now = input.openedAt || new Date().toISOString();
  const operationalDate = input.operationalDate || formatDateOnly(now, store.profile.timezone);
  const session = {
    id: createId("csn"),
    number: repository.nextNumber(companyId, "cashSession"),
    status: "open",
    openedBy: input.openedBy || null,
    openingAmount: toMoney(input.openingAmount),
    operationalDate,
    closingAmount: null,
    expectedAmount: null,
    difference: null,
    notes: input.notes || null,
    openedAt: now,
    closedAt: null,
    createdAt: now,
    updatedAt: now,
  };

  store.cashSessions.set(session.id, session);
  if (session.openingAmount > 0) {
    store.cashMovements.push({
      id: createId("csh"),
      number: repository.nextNumber(companyId, "cashMovement"),
      type: "opening_balance",
      direction: "in",
      method: "cash",
      amount: session.openingAmount,
      description: "Saldo inicial",
      referenceType: "cash_session",
      referenceId: session.id,
      cashSessionId: session.id,
      operationalAt: now,
      createdAt: now,
    });
  }
  addAuditLog(store, "cash.session.opened", {
    entityType: "cash_session",
    entityId: session.id,
    after: session,
    amount: session.openingAmount,
  });
  emitEvent(store, "cash.opened", { cashSessionId: session.id });
  return session;
}

function closeCashSession(companyId, sessionId, input = {}) {
  validateCashSessionClose(input);
  const store = repository.getCompanyStore(companyId);
  const session = store.cashSessions.get(sessionId);
  if (!session) throw notFound("Caixa nao encontrado", "CASH_SESSION_NOT_FOUND");
  assertCashSessionTransition(session.status, "closed");

  const movements = store.cashMovements.filter((movement) => movement.cashSessionId === sessionId && !movement.canceled);
  const totalIn = sumMoney(movements.filter((movement) => movement.direction === "in").map((movement) => movement.amount));
  const totalOut = sumMoney(movements.filter((movement) => movement.direction === "out").map((movement) => movement.amount));
  const expectedAmount = toMoney(totalIn - totalOut);
  const closingAmount = toMoney(input.closingAmount);
  const closed = {
    ...session,
    status: "closed",
    closingAmount,
    expectedAmount,
    difference: toMoney(closingAmount - expectedAmount),
    closedBy: input.closedBy || null,
    notes: input.notes || session.notes,
    closedAt: input.closedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  store.cashSessions.set(sessionId, closed);
  addAuditLog(store, "cash.session.closed", {
    entityType: "cash_session",
    entityId: sessionId,
    before: session,
    after: closed,
    reason: input.notes || null,
  });
  emitEvent(store, "cash.closed", { cashSessionId: sessionId, difference: closed.difference });
  return closed;
}

function listCashSessions(companyId) {
  return Array.from(repository.getCompanyStore(companyId).cashSessions.values());
}

function getOpenCashSession(companyId) {
  return Array.from(repository.getCompanyStore(companyId).cashSessions.values()).find((session) => session.status === "open") || null;
}

function getReportsOverview(companyId, filters = {}) {
  const sales = listSales(companyId, filters);
  const stock = getStockPosition(companyId);
  const receivablesSummary = getReceivablesSummary(companyId);
  const expensesSummary = getExpensesSummary(companyId, filters);
  const revenue = sumMoney(sales.filter((sale) => sale.status === "finalized").map((sale) => sale.total));
  const grossProfit = sumMoney(sales.flatMap((sale) => sale.items.map((item) => item.grossProfit)));
  const netResult = toMoney(revenue - expensesSummary.paidAmount);

  return {
    salesCount: sales.length,
    revenue,
    grossProfit,
    netResult,
    lowStockCount: stock.filter((item) => item.lowStock).length,
    productsCount: listProducts(companyId).length,
    customersCount: listCustomers(companyId).length,
    cash: getCashSummary(companyId),
    receivables: receivablesSummary,
    expenses: expensesSummary,
    dashboardAlerts: buildDashboardAlerts(companyId, receivablesSummary, stock),
  };
}

function getDashboard(companyId) {
  const overview = getReportsOverview(companyId);
  const receivables = listReceivables(companyId);
  const stock = getStockPosition(companyId);
  const openCash = getOpenCashSession(companyId);

  return {
    cards: [
      { key: "sales", label: "Vendas", value: overview.salesCount, action: "open_sales" },
      { key: "cash", label: "Caixa", value: overview.cash.balance, action: "open_cash" },
      { key: "receivables_due_today", label: "A receber hoje", value: overview.receivables.dueTodayAmount, action: "open_receivables_due_today" },
      { key: "receivables_overdue", label: "Vencidos", value: overview.receivables.overdueAmount, action: "open_overdue_receivables" },
      { key: "checks_to_deposit", label: "Cheques para depositar", value: overview.receivables.checksAwaitingDepositCount, action: "open_checks" },
      { key: "low_stock", label: "Estoque baixo", value: overview.lowStockCount, action: "open_low_stock" },
    ],
    tasks: buildDashboardTasks(receivables, stock, openCash),
    quickActions: [
      { key: "new_sale", label: "Nova venda", target: "/sales/new" },
      { key: "receive", label: "Registrar recebimento", target: "/receivables" },
      { key: "stock_entry", label: "Entrada de estoque", target: "/inventory/entries" },
      { key: openCash ? "close_cash" : "open_cash", label: openCash ? "Fechar caixa" : "Abrir caixa", target: "/cash" },
    ],
    overview,
  };
}

function getSalesReport(companyId, filters = {}) {
  const sales = listSales(companyId, filters);
  const total = sumMoney(sales.map((sale) => sale.total));

  return {
    total,
    count: sales.length,
    averageTicket: sales.length ? toMoney(total / sales.length) : 0,
    grossProfit: sumMoney(sales.flatMap((sale) => sale.items.map((item) => item.grossProfit))),
    byPaymentMethod: summarizeSalesByPaymentMethod(sales),
    byStatus: summarizeByField(sales, "status", "total"),
    topProducts: summarizeTopProducts(sales),
    rows: sales.map((sale) => ({
      number: sale.number,
      soldAt: sale.soldAt,
      customerName: sale.customerName || "Cliente avulso",
      status: sale.status,
      subtotal: sale.subtotal,
      discount: sale.discount,
      total: sale.total,
      paymentMethods: sale.payments.map((payment) => payment.method).join(", "),
      itemCount: sale.items.length,
    })),
  };
}

function getInventoryReport(companyId, filters = {}) {
  let stock = getStockPosition(companyId);
  if (filters.category) {
    stock = stock.filter((item) => item.category === filters.category);
  }
  if (filters.lowStock !== undefined) {
    stock = stock.filter((item) => String(item.lowStock) === String(filters.lowStock));
  }
  return {
    items: stock,
    lowStock: stock.filter((item) => item.lowStock),
    totalQuantity: sumMoney(stock.map((item) => item.quantity)),
    stockValue: sumMoney(stock.map((item) => {
      const product = getProduct(companyId, item.productId);
      return product.trackStock ? product.costPrice * item.quantity : 0;
    })),
    movements: listInventoryMovements(companyId).filter((movement) => {
      if (filters.productId && movement.productId !== filters.productId) return false;
      if (filters.type && movement.type !== filters.type) return false;
      return true;
    }),
  };
}

function getFinanceReport(companyId, filters = {}) {
  const salesReport = getSalesReport(companyId, filters);
  const receivables = listReceivables(companyId, filters);
  const expenses = listExpenses(companyId, filters);
  const cashMovements = listCashMovements(companyId, filters);
  const expensesSummary = getExpensesSummary(companyId, filters);
  const receivableOpenAmount = sumMoney(
    receivables
      .filter((receivable) => ACTIONABLE_RECEIVABLE_STATUSES.includes(receivable.status))
      .map((receivable) => receivable.remainingAmount),
  );

  return {
    revenue: salesReport.total,
    grossProfit: salesReport.grossProfit,
    expenses: expensesSummary,
    projectedBalance: toMoney(salesReport.total + receivableOpenAmount - expensesSummary.openAmount),
    receivableOpenAmount,
    cash: getCashSummary(companyId),
    byExpenseCategory: summarizeByField(expenses, "category", "amount"),
    rows: {
      receivables,
      expenses,
      cashMovements,
    },
  };
}

function exportReport(companyId, reportType, filters = {}) {
  const builders = {
    sales: () => ({
      filename: "vendas.csv",
      rows: getSalesReport(companyId, filters).rows,
      columns: [
        ["number", "Venda"],
        ["soldAt", "Data"],
        ["customerName", "Cliente"],
        ["status", "Status"],
        ["subtotal", "Subtotal"],
        ["discount", "Desconto"],
        ["total", "Total"],
        ["paymentMethods", "Pagamentos"],
        ["itemCount", "Itens"],
      ],
    }),
    inventory: () => ({
      filename: "estoque.csv",
      rows: getInventoryReport(companyId, filters).items,
      columns: [
        ["sku", "SKU"],
        ["name", "Produto"],
        ["category", "Categoria"],
        ["quantity", "Quantidade"],
        ["minimumStock", "Minimo"],
        ["lowStock", "Estoque baixo"],
      ],
    }),
    finance: () => ({
      filename: "financeiro.csv",
      rows: getFinanceReport(companyId, filters).rows.expenses,
      columns: [
        ["number", "Numero"],
        ["name", "Despesa"],
        ["category", "Categoria"],
        ["dueDate", "Vencimento"],
        ["amount", "Valor"],
        ["paidAmount", "Pago"],
        ["remainingAmount", "Aberto"],
        ["status", "Status"],
      ],
    }),
    receivables: () => ({
      filename: "recebiveis.csv",
      rows: listReceivables(companyId, filters),
      columns: [
        ["number", "Numero"],
        ["customerName", "Cliente"],
        ["saleNumber", "Venda"],
        ["method", "Metodo"],
        ["dueDate", "Vencimento"],
        ["amount", "Valor"],
        ["receivedAmount", "Recebido"],
        ["remainingAmount", "Aberto"],
        ["status", "Status"],
      ],
    }),
  };
  const builder = builders[reportType];
  if (!builder) throw badRequest("Relatorio invalido", "REPORT_TYPE_INVALID");
  const report = builder();
  return {
    filename: report.filename,
    contentType: "text/csv; charset=utf-8",
    content: toCsv(report.rows, report.columns),
  };
}

function buildSaleItem(store, item) {
  const product = store.products.get(item.productId);
  if (!product) throw notFound("Produto nao encontrado", "PRODUCT_NOT_FOUND");
  if (!product.active) throw badRequest("Produto inativo nao pode ser vendido", "PRODUCT_INACTIVE");

  const quantity = requirePositiveQuantity(item.quantity);
  const originalUnitPrice = item.originalUnitPrice === undefined ? product.salePrice : toMoney(item.originalUnitPrice);
  const unitPrice = item.unitPrice === undefined ? product.salePrice : toMoney(item.unitPrice);
  const discount = toMoney(item.discount);
  const total = toMoney(quantity * unitPrice - discount);
  if (total < 0) {
    throw badRequest("Desconto do item maior que o total", "SALE_ITEM_TOTAL_INVALID");
  }
  const grossProfit = toMoney(total - product.costPrice * quantity);

  return {
    productId: product.id,
    sku: product.sku,
    name: product.name,
    quantity,
    unitPrice,
    originalUnitPrice,
    priceAdjusted: Math.abs(unitPrice - originalUnitPrice) > 0.01,
    discount,
    total,
    costPrice: product.costPrice,
    grossProfit,
    trackStock: product.trackStock,
  };
}

function ensureStockAvailability(companyId, items) {
  const stock = new Map(getStockPosition(companyId).map((item) => [item.productId, item.quantity]));

  for (const item of items) {
    if (!item.trackStock) continue;
    const available = stock.get(item.productId) || 0;
    if (available < item.quantity) {
      throw badRequest(`Estoque insuficiente para ${item.name}`, "INSUFFICIENT_STOCK");
    }
  }
}

function createInventoryMovement(companyId, input) {
  const store = repository.getCompanyStore(companyId);
  const product = store.products.get(input.productId);
  if (!product) throw notFound("Produto nao encontrado", "PRODUCT_NOT_FOUND");

  const movement = {
    id: createId("mov"),
    number: repository.nextNumber(companyId, "inventoryMovement"),
    productId: product.id,
    productName: product.name,
    type: input.type,
    quantity: toMoney(input.quantity),
    unitCost: toMoney(input.unitCost),
    reason: input.reason || null,
    referenceType: input.referenceType || null,
    referenceId: input.referenceId || null,
    createdAt: new Date().toISOString(),
  };

  store.inventoryMovements.push(movement);
  emitEvent(store, "stock.moved", {
    movementId: movement.id,
    productId: product.id,
    type: movement.type,
    quantity: movement.quantity,
  });
  return movement;
}

function normalizePayments(payments, total) {
  if (!Array.isArray(payments) || payments.length === 0) {
    return [normalizePayment({ method: "cash", amount: total })];
  }

  const normalized = payments.map((payment) => normalizePayment(payment));

  const paid = sumMoney(normalized.map((payment) => payment.amount));
  if (paid !== total) {
    throw badRequest("Total dos pagamentos precisa fechar com o total da venda", "PAYMENT_TOTAL_MISMATCH");
  }

  return normalized;
}

function normalizePayment(payment) {
  const method = validatePaymentInput(payment);

  const amount = toMoney(payment.amount);

  const normalized = {
    method: method.key,
    methodName: method.name,
    behavior: method.behavior,
    amount,
  };

  if (method.allowsInstallments) {
    normalized.installments = Number(payment.installments || 1);
  }

  if (isReceivablePayment(method.key)) {
    normalized.dueDate = payment.dueDate || payment.firstDueDate || null;
    normalized.firstDueDate = payment.firstDueDate || payment.dueDate || null;
    normalized.depositDate = payment.depositDate || payment.dueDate || null;
    normalized.expectedClearingDate = payment.expectedClearingDate || null;
    normalized.cardBrand = payment.cardBrand || null;
    normalized.authorizationCode = payment.authorizationCode || null;
    normalized.bank = payment.bank || null;
    normalized.checkNumber = payment.checkNumber || null;
    normalized.holderName = payment.holderName || null;
    normalized.holderDocument = payment.holderDocument || null;

  }

  return normalized;
}

function createCashMovementsForSale(companyId, sale) {
  const store = repository.getCompanyStore(companyId);
  const cashSessionId = getOpenCashSession(companyId)?.id || null;

  for (const payment of sale.payments) {
    if (!isImmediatePayment(payment.method)) continue;

    store.cashMovements.push({
      id: createId("csh"),
      number: repository.nextNumber(companyId, "cashMovement"),
      type: "sale",
      direction: "in",
      method: payment.method,
      amount: payment.amount,
      description: `Venda ${sale.number}`,
      referenceType: "sale",
      referenceId: sale.id,
      cashSessionId,
      operationalAt: sale.soldAt,
      createdAt: sale.createdAt,
    });
  }
}

function createCashReversal(companyId, movement, description) {
  if (movement.reversed) return null;

  const store = repository.getCompanyStore(companyId);
  const now = new Date().toISOString();
  const reversal = {
    id: createId("csh"),
    number: repository.nextNumber(companyId, "cashMovement"),
    type: "reversal",
    direction: movement.direction === "in" ? "out" : "in",
    method: movement.method,
    amount: movement.amount,
    description,
    referenceType: "cash_movement",
    referenceId: movement.id,
    cashSessionId: getOpenCashSession(companyId)?.id || null,
    operationalAt: now,
    createdAt: now,
  };

  movement.reversed = true;
  movement.updatedAt = now;
  store.cashMovements.push(reversal);
  addAuditLog(store, "cash.movement.reversed", {
    entityType: "cash_movement",
    entityId: movement.id,
    after: reversal,
    amount: movement.amount,
    reason: description,
  });
  emitEvent(store, "cash.reversed", { movementId: movement.id, reversalId: reversal.id });
  return reversal;
}

function createReceivablesForSale(companyId, sale) {
  const receivables = [];

  for (const payment of sale.payments) {
    if (!isReceivablePayment(payment.method)) continue;

    if (payment.method === "credit_card" || payment.method === "store_credit") {
      receivables.push(...createInstallmentReceivables(companyId, sale, payment));
      continue;
    }

    receivables.push(createSingleReceivable(companyId, sale, payment));
  }

  return receivables;
}

function createInstallmentReceivables(companyId, sale, payment) {
  const installments = payment.installments || 1;
  const amounts = splitAmount(payment.amount, installments);
  const baseDueDate = payment.firstDueDate || payment.dueDate || sale.soldAt;

  return amounts.map((amount, index) =>
    saveReceivable(companyId, sale, payment, {
      amount,
      dueDate: addMonths(baseDueDate, index),
      installmentNumber: index + 1,
      installments,
      status: "open",
    }),
  );
}

function createSingleReceivable(companyId, sale, payment) {
  const isCheck = payment.method === "check";

  return saveReceivable(companyId, sale, payment, {
    amount: payment.amount,
    dueDate: isCheck ? payment.depositDate || payment.dueDate : payment.dueDate,
    installmentNumber: 1,
    installments: 1,
    status: isCheck ? "awaiting_deposit" : "open",
  });
}

function saveReceivable(companyId, sale, payment, details) {
  const store = repository.getCompanyStore(companyId);
  const now = new Date().toISOString();
  const receivable = {
    id: createId("rec"),
    number: repository.nextNumber(companyId, "receivable"),
    saleId: sale.id,
    saleNumber: sale.number,
    customerId: sale.customerId,
    customerName: sale.customerName,
    method: payment.method,
    methodName: payment.methodName,
    amount: toMoney(details.amount),
    receivedAmount: 0,
    remainingAmount: toMoney(details.amount),
    dueDate: formatDateOnly(details.dueDate),
    installmentNumber: details.installmentNumber,
    installments: details.installments,
    status: details.status,
    cardBrand: payment.cardBrand || null,
    authorizationCode: payment.authorizationCode || null,
    bank: payment.bank || null,
    checkNumber: payment.checkNumber || null,
    holderName: payment.holderName || null,
    holderDocument: payment.holderDocument || null,
    expectedClearingDate: payment.expectedClearingDate ? formatDateOnly(payment.expectedClearingDate) : null,
    receivedAt: null,
    depositedAt: null,
    returnedAt: null,
    canceledAt: null,
    notes: null,
    createdAt: now,
    updatedAt: now,
  };

  store.receivables.set(receivable.id, receivable);
  addAuditLog(store, "receivable.created", {
    entityType: "receivable",
    entityId: receivable.id,
    after: receivable,
    amount: receivable.amount,
  });
  emitEvent(store, "receivable.created", { receivableId: receivable.id, amount: receivable.amount });
  return receivable;
}

function createReceiptForSale(companyId, sale) {
  const receipt = {
    id: createId("rcp"),
    number: repository.nextNumber(companyId, "receipt"),
    saleId: sale.id,
    saleNumber: sale.number,
    customerName: sale.customerName,
    items: sale.items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      originalUnitPrice: item.originalUnitPrice,
      priceAdjusted: item.priceAdjusted,
      discount: item.discount,
      total: item.total,
    })),
    subtotal: sale.subtotal,
    discount: sale.discount,
    total: sale.total,
    payments: sale.payments,
    issuedAt: new Date().toISOString(),
    fiscal: false,
    label: "Recibo nao fiscal",
  };

  repository.getCompanyStore(companyId).receipts.set(sale.id, receipt);
  return receipt;
}

function getReceiptHtmlBySale(companyId, saleId) {
  const receipt = getReceiptBySale(companyId, saleId);
  const company = getCompanyProfile(companyId);
  return renderReceiptHtml(company, receipt);
}

function listReceivables(companyId, filters = {}) {
  let receivables = Array.from(repository.getCompanyStore(companyId).receivables.values())
    .filter((receivable) => receivable.status !== "canceled");
  receivables = filterByDateRange(receivables, filters, "dueDate");

  if (filters.status) {
    receivables = receivables.filter((receivable) => receivable.status === filters.status);
  }

  if (filters.method) {
    receivables = receivables.filter((receivable) => receivable.method === filters.method);
  }

  return receivables;
}

function getReceivable(companyId, receivableId) {
  const receivable = repository.getCompanyStore(companyId).receivables.get(receivableId);
  if (!receivable) throw notFound("Conta a receber nao encontrada", "RECEIVABLE_NOT_FOUND");
  return receivable;
}

function markReceivableReceived(companyId, receivableId, input = {}) {
  return repository.runInTransaction(companyId, () => markReceivableReceivedAtomic(companyId, receivableId, input));
}

function markReceivableReceivedAtomic(companyId, receivableId, input = {}) {
  const receivable = getReceivable(companyId, receivableId);

  if (["received", "compensated"].includes(receivable.status)) {
    throw badRequest("Conta a receber ja foi baixada", "RECEIVABLE_ALREADY_SETTLED");
  }

  const amount = input.amount === undefined ? receivable.remainingAmount : toMoney(input.amount);
  if (amount <= 0 || amount > receivable.remainingAmount) {
    throw badRequest("Valor de recebimento invalido", "RECEIVABLE_PAYMENT_AMOUNT_INVALID");
  }

  const remainingAmount = toMoney(receivable.remainingAmount - amount);
  const isSettled = remainingAmount === 0;
  const status = isSettled
    ? receivable.method === "check"
      ? "compensated"
      : "received"
    : "partial";
  assertReceivableTransition(receivable.status, status);
  const updated = updateReceivable(companyId, receivableId, {
    status,
    receivedAmount: toMoney((receivable.receivedAmount || 0) + amount),
    remainingAmount,
    receivedAt: input.receivedAt || new Date().toISOString(),
    notes: input.notes || receivable.notes,
  });

  createCashMovementForReceivable(companyId, updated, { ...input, amount });
  emitEvent(repository.getCompanyStore(companyId), "receivable.received", {
    receivableId,
    amount,
    status,
  });
  return updated;
}

function markCheckDeposited(companyId, receivableId, input = {}) {
  return repository.runInTransaction(companyId, () => markCheckDepositedAtomic(companyId, receivableId, input));
}

function markCheckDepositedAtomic(companyId, receivableId, input = {}) {
  const receivable = getReceivable(companyId, receivableId);

  if (receivable.method !== "check") {
    throw badRequest("Apenas cheque pode ser marcado como depositado", "RECEIVABLE_NOT_CHECK");
  }
  assertReceivableTransition(receivable.status, "deposited");

  return updateReceivable(companyId, receivableId, {
    status: "deposited",
    depositedAt: input.depositedAt || new Date().toISOString(),
    notes: input.notes || receivable.notes,
  });
}

function markCheckReturned(companyId, receivableId, input = {}) {
  return repository.runInTransaction(companyId, () => markCheckReturnedAtomic(companyId, receivableId, input));
}

function markCheckReturnedAtomic(companyId, receivableId, input = {}) {
  const receivable = getReceivable(companyId, receivableId);

  if (receivable.method !== "check") {
    throw badRequest("Apenas cheque pode ser marcado como devolvido", "RECEIVABLE_NOT_CHECK");
  }
  assertReceivableTransition(receivable.status, "returned");

  return updateReceivable(companyId, receivableId, {
    status: "returned",
    returnedAt: input.returnedAt || new Date().toISOString(),
    notes: input.notes || receivable.notes,
  });
}

function cancelReceivable(companyId, receivableId, input = {}) {
  return repository.runInTransaction(companyId, () => cancelReceivableAtomic(companyId, receivableId, input));
}

function cancelReceivableAtomic(companyId, receivableId, input = {}) {
  const receivable = getReceivable(companyId, receivableId);

  if (["received", "compensated"].includes(receivable.status)) {
    throw badRequest("Conta recebida nao pode ser cancelada", "RECEIVABLE_ALREADY_SETTLED");
  }
  assertReceivableTransition(receivable.status, "canceled");

  return updateReceivable(companyId, receivableId, {
    status: "canceled",
    canceledAt: input.canceledAt || new Date().toISOString(),
    notes: input.notes || receivable.notes,
  });
}

function updateReceivable(companyId, receivableId, patch) {
  const store = repository.getCompanyStore(companyId);
  const receivable = getReceivable(companyId, receivableId);
  if (patch.status) {
    assertReceivableTransition(receivable.status, patch.status);
  }
  const updated = {
    ...receivable,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  store.receivables.set(receivableId, updated);
  addAuditLog(store, "receivable.updated", {
    entityType: "receivable",
    entityId: receivableId,
    before: receivable,
    after: updated,
    reason: patch.notes || null,
  });
  emitEvent(store, "receivable.updated", {
    receivableId,
    status: updated.status,
  });
  return updated;
}

function createCashMovementForReceivable(companyId, receivable, input) {
  repository.getCompanyStore(companyId).cashMovements.push({
    id: createId("csh"),
    number: repository.nextNumber(companyId, "cashMovement"),
    type: "receivable",
    direction: "in",
    method: input.receiptMethod || receivable.method,
    amount: toMoney(input.amount || receivable.amount),
    description: `Recebimento venda ${receivable.saleNumber}`,
    referenceType: "receivable",
    referenceId: receivable.id,
    cashSessionId: getOpenCashSession(companyId)?.id || null,
    operationalAt: input.receivedAt || new Date().toISOString(),
    createdAt: input.receivedAt || new Date().toISOString(),
  });
}

function getReceivablesSummary(companyId) {
  const receivables = listReceivables(companyId);
  const active = receivables.filter((receivable) => ACTIONABLE_RECEIVABLE_STATUSES.includes(receivable.status));
  const timezone = getCompanyProfile(companyId).timezone;
  const today = formatDateOnly(new Date(), timezone);
  const nextWeek = formatDateOnly(addDays(new Date(), 7), timezone);

  const dueToday = active.filter((receivable) => receivable.dueDate === today);
  const overdue = active.filter((receivable) => receivable.dueDate && receivable.dueDate < today);
  const nextSevenDays = active.filter((receivable) => receivable.dueDate && receivable.dueDate > today && receivable.dueDate <= nextWeek);
  const checksAwaitingDeposit = active.filter((receivable) => receivable.method === "check" && receivable.status === "awaiting_deposit");
  const checksDeposited = active.filter((receivable) => receivable.method === "check" && receivable.status === "deposited");

  return {
    openAmount: sumMoney(active.map((receivable) => receivable.remainingAmount)),
    dueTodayAmount: sumMoney(dueToday.map((receivable) => receivable.remainingAmount)),
    overdueAmount: sumMoney(overdue.map((receivable) => receivable.remainingAmount)),
    nextSevenDaysAmount: sumMoney(nextSevenDays.map((receivable) => receivable.remainingAmount)),
    checksAwaitingDepositAmount: sumMoney(checksAwaitingDeposit.map((receivable) => receivable.remainingAmount)),
    checksDepositedAmount: sumMoney(checksDeposited.map((receivable) => receivable.remainingAmount)),
    openCount: active.length,
    dueTodayCount: dueToday.length,
    overdueCount: overdue.length,
    nextSevenDaysCount: nextSevenDays.length,
    checksAwaitingDepositCount: checksAwaitingDeposit.length,
    checksDepositedCount: checksDeposited.length,
  };
}

function getReceivablesBoard(companyId) {
  const receivables = listReceivables(companyId);
  const timezone = getCompanyProfile(companyId).timezone;
  const today = formatDateOnly(new Date(), timezone);
  const nextWeek = formatDateOnly(addDays(new Date(), 7), timezone);

  return {
    overdue: receivables.filter((item) => ACTIONABLE_RECEIVABLE_STATUSES.includes(item.status) && item.dueDate < today),
    dueToday: receivables.filter((item) => ACTIONABLE_RECEIVABLE_STATUSES.includes(item.status) && item.dueDate === today),
    nextSevenDays: receivables.filter((item) => ACTIONABLE_RECEIVABLE_STATUSES.includes(item.status) && item.dueDate > today && item.dueDate <= nextWeek),
    checksAwaitingDeposit: receivables.filter((item) => item.method === "check" && item.status === "awaiting_deposit"),
    checksDeposited: receivables.filter((item) => item.method === "check" && item.status === "deposited"),
    returned: receivables.filter((item) => item.status === "returned"),
  };
}

function buildDashboardAlerts(companyId, receivablesSummary, stock) {
  return {
    receivablesDueToday: receivablesSummary.dueTodayCount,
    receivablesOverdue: receivablesSummary.overdueCount,
    checksAwaitingDeposit: receivablesSummary.checksAwaitingDepositCount,
    checksDeposited: receivablesSummary.checksDepositedCount,
    lowStock: stock.filter((item) => item.lowStock).length,
  };
}

function buildDashboardTasks(receivables, stock, openCash) {
  const today = formatDateOnly(new Date());
  const tasks = [];

  if (!openCash) {
    tasks.push({
      key: "open_cash",
      priority: "high",
      label: "Abrir caixa",
      description: "Nao ha caixa aberto para os movimentos do dia.",
      action: "open_cash",
    });
  }

  const overdue = receivables.filter((item) => ACTIONABLE_RECEIVABLE_STATUSES.includes(item.status) && item.dueDate < today);
  if (overdue.length) {
    tasks.push({
      key: "overdue_receivables",
      priority: "high",
      label: "Recebiveis vencidos",
      count: overdue.length,
      amount: sumMoney(overdue.map((item) => item.remainingAmount)),
      action: "open_overdue_receivables",
    });
  }

  const checksToDeposit = receivables.filter((item) => item.method === "check" && item.status === "awaiting_deposit" && item.dueDate <= today);
  if (checksToDeposit.length) {
    tasks.push({
      key: "checks_to_deposit",
      priority: "medium",
      label: "Cheques para depositar",
      count: checksToDeposit.length,
      amount: sumMoney(checksToDeposit.map((item) => item.remainingAmount)),
      action: "open_checks_to_deposit",
    });
  }

  const lowStock = stock.filter((item) => item.lowStock);
  if (lowStock.length) {
    tasks.push({
      key: "low_stock",
      priority: "medium",
      label: "Produtos com estoque baixo",
      count: lowStock.length,
      action: "open_low_stock",
    });
  }

  return tasks;
}

function getPosContext(companyId, filters = {}) {
  return {
    company: getCompanyProfile(companyId),
    cash: getCashSummary(companyId),
    paymentMethods: listPaymentMethods(),
    products: searchSaleCatalog(companyId, filters.search || ""),
    customers: listCustomers(companyId, { search: filters.customerSearch || "", active: true }),
    receivablesSummary: getReceivablesSummary(companyId),
  };
}

function renderReceiptHtml(company, receipt) {
  const rows = receipt.items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(item.name)}</td>
          <td>${item.quantity}</td>
          <td>${formatCurrency(item.unitPrice)}</td>
          <td>${formatCurrency(item.discount || 0)}</td>
          <td>${formatCurrency(item.total)}</td>
        </tr>`,
    )
    .join("");
  const payments = receipt.payments
    .map((payment) => `<li>${escapeHtml(payment.methodName || payment.method)}: ${formatCurrency(payment.amount)}</li>`)
    .join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Recibo ${receipt.saleNumber}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; margin: 24px; }
    .receipt { max-width: 420px; }
    h1 { font-size: 18px; margin: 0 0 8px; }
    .muted { color: #555; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 12px; }
    th, td { border-bottom: 1px solid #ddd; padding: 6px 4px; text-align: left; }
    .totals { margin-top: 16px; font-size: 14px; }
    .total { font-weight: 700; font-size: 18px; }
    .label { margin-top: 20px; padding-top: 12px; border-top: 1px dashed #777; font-weight: 700; text-align: center; }
    @media print { body { margin: 0; } button { display: none; } }
  </style>
</head>
<body>
  <main class="receipt">
    <button onclick="window.print()">Imprimir</button>
    <h1>${escapeHtml(company.name || "Volt Core")}</h1>
    <div class="muted">${escapeHtml(company.document || "")}</div>
    <div class="muted">${escapeHtml(company.phone || "")}</div>
    <p><strong>Venda:</strong> ${receipt.saleNumber}</p>
    <p><strong>Cliente:</strong> ${escapeHtml(receipt.customerName || "Cliente avulso")}</p>
    <p><strong>Emissao:</strong> ${escapeHtml(receipt.issuedAt)}</p>
    <table>
      <thead><tr><th>Item</th><th>Qtd</th><th>Unit.</th><th>Desc.</th><th>Total</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div>Subtotal: ${formatCurrency(receipt.subtotal)}</div>
      <div>Desconto: ${formatCurrency(receipt.discount)}</div>
      <div class="total">Total: ${formatCurrency(receipt.total)}</div>
    </div>
    <h2>Pagamentos</h2>
    <ul>${payments}</ul>
    <div class="label">${escapeHtml(receipt.label)}</div>
  </main>
</body>
</html>`;
}

function createUser(companyId, input) {
  if (!input || !input.name || !input.email) {
    throw badRequest("Nome e email do usuario sao obrigatorios", "USER_REQUIRED_FIELDS");
  }
  const store = repository.getCompanyStore(companyId);
  const roleKey = input.roleKey || "seller";
  ensureRoleExists(roleKey);
  const now = new Date().toISOString();
  const user = {
    id: createId("usr"),
    name: String(input.name).trim(),
    email: String(input.email).trim().toLowerCase(),
    roleKey,
    active: input.active !== false,
    createdAt: now,
    updatedAt: now,
  };
  store.users.set(user.id, user);
  addAuditLog(store, "user.created", { userId: user.id, roleKey });
  return user;
}

function listUsers(companyId) {
  return Array.from(repository.getCompanyStore(companyId).users.values());
}

function updateUser(companyId, userId, input) {
  const store = repository.getCompanyStore(companyId);
  const current = store.users.get(userId);
  if (!current) throw notFound("Usuario nao encontrado", "USER_NOT_FOUND");
  const roleKey = input.roleKey === undefined ? current.roleKey : input.roleKey;
  ensureRoleExists(roleKey);
  const updated = {
    ...current,
    name: input.name === undefined ? current.name : String(input.name).trim(),
    email: input.email === undefined ? current.email : String(input.email).trim().toLowerCase(),
    roleKey,
    active: input.active === undefined ? current.active : input.active !== false,
    updatedAt: new Date().toISOString(),
  };
  store.users.set(userId, updated);
  addAuditLog(store, "user.updated", { userId, roleKey });
  return updated;
}

function listRoles() {
  return generalTemplate.defaultRoles;
}

function listPermissions() {
  return Array.from(
    new Set(generalTemplate.defaultRoles.flatMap((role) => role.permissions)),
  ).sort();
}

function checkPermission(companyId, userId, permission) {
  const user = repository.getCompanyStore(companyId).users.get(userId);
  if (!user || !user.active) return { allowed: false };
  const role = generalTemplate.defaultRoles.find((item) => item.key === user.roleKey);
  const allowed = Boolean(role && (role.permissions.includes("*") || role.permissions.includes(permission)));
  return { allowed, userId, roleKey: user.roleKey, permission };
}

function listMasterCompanies() {
  return repository.listCompanyStores();
}

function getAuditLogs(companyId) {
  return repository.getCompanyStore(companyId).auditLogs;
}

function getEvents(companyId) {
  return listEvents(repository.getCompanyStore(companyId));
}

function addAuditLog(store, action, details = {}, context = {}) {
  store.auditLogs.push({
    id: createId("aud"),
    action,
    actorUserId: context.actorUserId || details.actorUserId || null,
    actorRole: context.actorRole || details.actorRole || null,
    entityType: details.entityType || null,
    entityId: details.entityId || null,
    before: details.before || null,
    after: details.after || null,
    amount: details.amount === undefined ? null : details.amount,
    reason: details.reason || null,
    details,
    createdAt: new Date().toISOString(),
  });
}

function ensureRoleExists(roleKey) {
  if (!generalTemplate.defaultRoles.some((role) => role.key === roleKey)) {
    throw badRequest("Perfil de usuario invalido", "ROLE_INVALID");
  }
}

function filterBySearch(items, search, fields) {
  const term = String(search || "").trim().toLowerCase();
  if (!term) return items;
  return items.filter((item) =>
    fields.some((field) => String(item[field] || "").toLowerCase().includes(term)),
  );
}

function filterByDateRange(items, filters = {}, field) {
  let filtered = items;
  if (filters.dateFrom) {
    filtered = filtered.filter((item) => formatDateOnly(item[field]) >= filters.dateFrom);
  }
  if (filters.dateTo) {
    filtered = filtered.filter((item) => formatDateOnly(item[field]) <= filters.dateTo);
  }
  return filtered;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatCurrency(value) {
  return `R$ ${toMoney(value).toFixed(2).replace(".", ",")}`;
}

function requirePositiveQuantity(value) {
  const quantity = Number(value || 0);
  if (quantity <= 0) {
    throw badRequest("Quantidade deve ser positiva", "QUANTITY_INVALID");
  }

  return quantity;
}

function summarizeByMethod(movements) {
  const summary = {};
  for (const movement of movements) {
    if (!summary[movement.method]) {
      summary[movement.method] = { in: 0, out: 0, balance: 0 };
    }
    summary[movement.method][movement.direction] = toMoney(summary[movement.method][movement.direction] + movement.amount);
    summary[movement.method].balance = toMoney(summary[movement.method].in - summary[movement.method].out);
  }

  return summary;
}

function summarizeSalesByPaymentMethod(sales) {
  const summary = {};
  for (const sale of sales) {
    for (const payment of sale.payments) {
      summary[payment.method] = toMoney((summary[payment.method] || 0) + payment.amount);
    }
  }

  return summary;
}

function getExpensesSummary(companyId, filters = {}) {
  const expenses = listExpenses(companyId, filters);
  const open = expenses.filter((expense) => ["open", "partial"].includes(expense.status));
  const paid = expenses.filter((expense) => expense.status === "paid");
  const canceled = expenses.filter((expense) => expense.status === "canceled");

  return {
    openAmount: sumMoney(open.map((expense) => expense.remainingAmount)),
    paidAmount: sumMoney(expenses.map((expense) => expense.paidAmount)),
    totalAmount: sumMoney(expenses.map((expense) => expense.amount)),
    openCount: open.length,
    paidCount: paid.length,
    canceledCount: canceled.length,
  };
}

function summarizeByField(items, field, amountField) {
  const summary = {};
  for (const item of items) {
    const key = item[field] || "sem_valor";
    if (!summary[key]) summary[key] = { count: 0, total: 0 };
    summary[key].count += 1;
    summary[key].total = toMoney(summary[key].total + toMoney(item[amountField]));
  }
  return summary;
}

function toCsv(rows, columns) {
  const header = columns.map(([, label]) => csvCell(label)).join(",");
  const body = rows.map((row) =>
    columns.map(([key]) => csvCell(row[key])).join(","),
  );
  return [header, ...body].join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const stringValue = String(value);
  if (!/[",\n;]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function splitAmount(total, parts) {
  const cents = Math.round(toMoney(total) * 100);
  const base = Math.floor(cents / parts);
  const remainder = cents % parts;
  const amounts = [];

  for (let index = 0; index < parts; index += 1) {
    amounts.push(toMoney((base + (index < remainder ? 1 : 0)) / 100));
  }

  return amounts;
}

function addMonths(value, months) {
  const date = new Date(`${formatDateOnly(value)}T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date;
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function formatDateOnly(value, timezone) {
  if (!value) return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (timezone) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value));
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${byType.year}-${byType.month}-${byType.day}`;
  }
  return new Date(value).toISOString().slice(0, 10);
}

function summarizeTopProducts(sales) {
  const summary = new Map();
  for (const sale of sales) {
    for (const item of sale.items) {
      const current = summary.get(item.productId) || {
        productId: item.productId,
        name: item.name,
        quantity: 0,
        total: 0,
      };
      current.quantity = toMoney(current.quantity + item.quantity);
      current.total = toMoney(current.total + item.total);
      summary.set(item.productId, current);
    }
  }

  return Array.from(summary.values()).sort((a, b) => b.total - a.total);
}

module.exports = {
  addInventoryAdjustment,
  addInventoryEntry,
  addInventoryExit,
  cancelExpense,
  cancelSale,
  deleteCanceledSale,
  cancelReceivable,
  checkPermission,
  closeCashSession,
  createCustomer,
  createExpense,
  createManualCashMovement,
  createProduct,
  createSale,
  createUser,
  deleteCustomer,
  deleteProduct,
  exportReport,
  getAuditLogs,
  getEvents,
  getExpense,
  getCashSummary,
  getCompanyProfile,
  getCustomer,
  getDashboard,
  getExpensesSummary,
  getFinanceReport,
  getInventoryReport,
  getMasterCompanies: listMasterCompanies,
  getPaymentMethods: listPaymentMethods,
  getPosContext,
  getProduct,
  getReceivable,
  getReceivablesBoard,
  getReceivablesSummary,
  getReceiptHtmlBySale,
  getReceiptBySale,
  getReportsOverview,
  getSale,
  getSalesReport,
  getStockPosition,
  listCashSessions,
  listCashMovements,
  listCustomers,
  listExpenses,
  listInventoryMovements,
  listPermissions,
  listProducts,
  listReceivables,
  listReceipts,
  listRoles,
  listSales,
  listUsers,
  markCheckDeposited,
  markCheckReturned,
  markReceivableReceived,
  openCashSession,
  payExpense,
  searchSaleCatalog,
  setCustomerActive,
  setProductActive,
  updateCustomer,
  updateExpense,
  updateProduct,
  updateUser,
  upsertCompanyProfile,
};
