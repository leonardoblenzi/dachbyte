const test = require("node:test");
const assert = require("node:assert/strict");
const operations = require("./coreOperationsService");
const repository = require("./repositories/inMemoryCoreRepository");

test("runs the standard core sales flow and lowers inventory", () => {
  repository.clear();

  const companyId = "company-core";
  const customer = operations.createCustomer(companyId, {
    name: "Cliente Padrao",
    phone: "11999999999",
  });

  const product = operations.createProduct(companyId, {
    sku: "SKU-001",
    name: "Produto padrao",
    salePrice: 100,
    costPrice: 60,
    minimumStock: 2,
  });

  operations.addInventoryEntry(companyId, {
    productId: product.id,
    quantity: 10,
    unitCost: 60,
    reason: "Compra inicial",
  });

  const result = operations.createSale(companyId, {
    customerId: customer.id,
    items: [
      {
        productId: product.id,
        quantity: 3,
      },
    ],
    payments: [
      {
        method: "pix",
        amount: 300,
      },
    ],
  });

  assert.equal(result.sale.total, 300);
  assert.equal(result.receipt.label, "Recibo nao fiscal");

  const stock = operations.getStockPosition(companyId);
  assert.equal(stock.find((item) => item.productId === product.id).quantity, 7);

  const cash = operations.getCashSummary(companyId);
  assert.equal(cash.totalIn, 300);
  assert.equal(cash.balance, 300);
  assert.equal(cash.byMethod.pix.balance, 300);

  const overview = operations.getReportsOverview(companyId);
  assert.equal(overview.salesCount, 1);
  assert.equal(overview.revenue, 300);
  assert.equal(overview.grossProfit, 120);
  assert.equal(overview.receivables.openAmount, 0);
});

test("supports customer and product CRUD for daily operation", () => {
  repository.clear();

  const companyId = "company-crud";
  const customer = operations.createCustomer(companyId, {
    name: "Maria Cliente",
    phone: "11999990000",
  });
  const updatedCustomer = operations.updateCustomer(companyId, customer.id, {
    name: "Maria Atualizada",
    document: "123",
  });

  assert.equal(updatedCustomer.name, "Maria Atualizada");
  assert.equal(operations.listCustomers(companyId, { search: "123" }).length, 1);
  assert.throws(() => operations.deleteCustomer(companyId, customer.id), /Desative o cliente/);
  assert.equal(operations.setCustomerActive(companyId, customer.id, false).active, false);
  assert.equal(operations.setCustomerActive(companyId, customer.id, true).active, true);
  assert.equal(operations.setCustomerActive(companyId, customer.id, false).active, false);
  assert.equal(operations.deleteCustomer(companyId, customer.id).id, customer.id);
  assert.equal(operations.listCustomers(companyId).length, 0);

  const product = operations.createProduct(companyId, {
    sku: "BALCAO-1",
    name: "Produto Balcao",
    salePrice: 20,
  });
  const updatedProduct = operations.updateProduct(companyId, product.id, {
    salePrice: 25,
    minimumStock: 4,
  });

  assert.equal(updatedProduct.salePrice, 25);
  assert.equal(operations.searchSaleCatalog(companyId, "BALCAO").length, 1);
  assert.throws(() => operations.deleteProduct(companyId, product.id), /Desative o produto/);
  assert.equal(operations.setProductActive(companyId, product.id, false).active, false);
  assert.equal(operations.setProductActive(companyId, product.id, true).active, true);
  assert.equal(operations.setProductActive(companyId, product.id, false).active, false);
  assert.equal(operations.deleteProduct(companyId, product.id).id, product.id);
  assert.equal(operations.listProducts(companyId).length, 0);
});

test("blocks duplicated product EAN inside the same company", () => {
  repository.clear();

  const companyId = "company-ean";
  const product = operations.createProduct(companyId, {
    sku: "EAN-1",
    ean: "789 1000",
    name: "Produto com EAN",
    salePrice: 20,
  });

  assert.equal(product.ean, "7891000");
  assert.equal(operations.listProducts(companyId, { search: "7891000" }).length, 1);
  assert.throws(
    () => operations.createProduct(companyId, {
      sku: "EAN-2",
      ean: "789.1000",
      name: "Produto duplicado",
      salePrice: 30,
    }),
    /Este EAN ja esta cadastrado/,
  );

  const otherProduct = operations.createProduct(companyId, {
    sku: "EAN-3",
    ean: "7892000",
    name: "Produto para editar",
    salePrice: 30,
  });
  assert.throws(
    () => operations.updateProduct(companyId, otherProduct.id, { ean: "7891000" }),
    /Este EAN ja esta cadastrado/,
  );

  const otherCompanyProduct = operations.createProduct("company-ean-other", {
    sku: "EAN-1",
    ean: "7891000",
    name: "Produto outra empresa",
    salePrice: 20,
  });
  assert.equal(otherCompanyProduct.ean, "7891000");
});
test("opens and closes cash sessions with expected difference", () => {
  repository.clear();

  const companyId = "company-cash";
  const session = operations.openCashSession(companyId, {
    openingAmount: 50,
    openedBy: "operator",
  });

  operations.createManualCashMovement(companyId, {
    direction: "in",
    method: "cash",
    amount: 25,
    description: "Reforco",
  });

  const closed = operations.closeCashSession(companyId, session.id, {
    closingAmount: 70,
    closedBy: "operator",
  });

  assert.equal(closed.expectedAmount, 75);
  assert.equal(closed.difference, -5);
  assert.equal(operations.getCashSummary(companyId).openSession, null);
});

test("uses operational dates for sales and cash filters without losing audit creation", () => {
  repository.clear();

  const companyId = "company-operational-dates";
  const product = operations.createProduct(companyId, {
    sku: "DATE-1",
    name: "Produto retroativo",
    salePrice: 80,
    trackStock: false,
  });

  const sale = operations.createSale(companyId, {
    soldAt: "2026-06-01T14:30:00.000Z",
    customerName: "Cliente data",
    items: [{ productId: product.id, quantity: 1 }],
    payments: [{ method: "pix", amount: 80 }],
  }).sale;

  operations.createManualCashMovement(companyId, {
    direction: "out",
    method: "cash",
    amount: 10,
    description: "Sangria retroativa",
    operationalAt: "2026-06-02T09:00:00.000Z",
  });

  assert.equal(sale.soldAt, "2026-06-01T14:30:00.000Z");
  assert.notEqual(sale.createdAt, sale.soldAt);
  assert.equal(operations.listSales(companyId, { dateFrom: "2026-06-01", dateTo: "2026-06-01" }).length, 1);
  assert.equal(operations.listSales(companyId, { dateFrom: "2026-06-02", dateTo: "2026-06-02" }).length, 0);
  assert.equal(operations.listCashMovements(companyId, { dateFrom: "2026-06-01", dateTo: "2026-06-01" }).length, 1);
  assert.equal(operations.listCashMovements(companyId, { dateFrom: "2026-06-02", dateTo: "2026-06-02" }).length, 1);
});

test("pays expenses through cash and reports finance/export data", () => {
  repository.clear();

  const companyId = "company-expenses";
  operations.openCashSession(companyId, {
    openingAmount: 500,
    openedBy: "operator",
  });
  const expense = operations.createExpense(companyId, {
    name: "Fornecedor de lentes",
    category: "Mercadoria",
    dueDate: "2026-06-25",
    amount: 300,
  });

  const partial = operations.payExpense(companyId, expense.id, {
    amount: 120,
    paymentMethod: "pix",
    paidAt: "2026-06-21T12:00:00.000Z",
  });

  assert.equal(partial.status, "partial");
  assert.equal(partial.remainingAmount, 180);
  assert.equal(operations.getCashSummary(companyId).totalOut, 120);

  const paid = operations.payExpense(companyId, expense.id, {
    amount: 180,
    paymentMethod: "pix",
  });
  assert.equal(paid.status, "paid");

  const finance = operations.getFinanceReport(companyId);
  assert.equal(finance.expenses.paidAmount, 300);
  assert.equal(finance.expenses.paidCount, 1);
  assert.equal(finance.cash.totalOut, 300);
  assert.equal(finance.byExpenseCategory.Mercadoria.total, 300);

  const csv = operations.exportReport(companyId, "finance");
  assert.equal(csv.contentType, "text/csv; charset=utf-8");
  assert.match(csv.content, /Despesa/);
  assert.match(csv.content, /Fornecedor de lentes/);
});

test("returns POS context and printable receipt html", () => {
  repository.clear();

  const companyId = "company-pos";
  operations.upsertCompanyProfile(companyId, {
    name: "Loja Teste",
    document: "00.000.000/0001-00",
  });
  const product = operations.createProduct(companyId, {
    sku: "PDV-1",
    name: "Item PDV",
    salePrice: 30,
    trackStock: false,
  });
  const context = operations.getPosContext(companyId, { search: "PDV" });
  assert.equal(context.products[0].id, product.id);
  assert.ok(context.paymentMethods.some((method) => method.key === "credit_card"));

  const result = operations.createSale(companyId, {
    customerName: "Cliente Recibo",
    items: [{ productId: product.id, quantity: 2, discount: 5 }],
    payments: [{ method: "cash", amount: 55 }],
  });
  const html = operations.getReceiptHtmlBySale(companyId, result.sale.id);

  assert.equal(result.sale.total, 55);
  assert.match(html, /Recibo nao fiscal/);
  assert.match(html, /Loja Teste/);
});

test("keeps adjusted unit price in sale and receipt history", () => {
  repository.clear();

  const companyId = "company-adjusted-sale";
  const product = operations.createProduct(companyId, {
    sku: "FRAME-1",
    name: "Armacao ajustavel",
    salePrice: 100,
    trackStock: false,
  });

  const result = operations.createSale(companyId, {
    customerName: "Cliente Ajuste",
    items: [{ productId: product.id, quantity: 1, unitPrice: 85, originalUnitPrice: 100 }],
    payments: [{ method: "pix", amount: 85 }],
  });
  const listedSale = operations.listSales(companyId)[0];
  const receipt = result.receipt;

  assert.equal(result.sale.total, 85);
  assert.equal(listedSale.items[0].unitPrice, 85);
  assert.equal(listedSale.items[0].originalUnitPrice, 100);
  assert.equal(listedSale.items[0].priceAdjusted, true);
  assert.equal(receipt.items[0].priceAdjusted, true);
});

test("accepts comma decimal amounts in sales and payments", () => {
  repository.clear();

  const companyId = "company-comma-money";
  const product = operations.createProduct(companyId, {
    name: "Produto decimal",
    salePrice: "100,50",
    trackStock: false,
  });

  const result = operations.createSale(companyId, {
    customerName: "Cliente Decimal",
    items: [{ productId: product.id, quantity: 1, unitPrice: "100,50" }],
    payments: [
      { method: "pix", amount: "40,25" },
      { method: "cash", amount: "60,25" },
    ],
  });

  assert.equal(result.sale.total, 100.5);
  assert.equal(result.sale.payments[0].amount, 40.25);
  assert.equal(result.sale.payments[1].amount, 60.25);
});

test("cancels sale, restores stock and cancels open receivables", () => {
  repository.clear();

  const companyId = "company-cancel-sale";
  const product = operations.createProduct(companyId, {
    name: "Produto cancelavel",
    salePrice: 100,
  });
  operations.addInventoryEntry(companyId, {
    productId: product.id,
    quantity: 2,
  });

  const result = operations.createSale(companyId, {
    items: [{ productId: product.id, quantity: 1 }],
    payments: [{ method: "promissory_note", amount: 100, dueDate: "2026-07-10" }],
  });

  const canceled = operations.cancelSale(companyId, result.sale.id, {
    reason: "Erro de lancamento",
  });

  assert.equal(canceled.status, "canceled");
  assert.equal(operations.getStockPosition(companyId)[0].quantity, 2);
  assert.equal(operations.listReceivables(companyId).length, 0);
});

test("keeps credit card immediate and creates receivables only for true customer credit", () => {
  repository.clear();

  const companyId = "company-receivables";
  const product = operations.createProduct(companyId, {
    name: "Produto parcelado",
    salePrice: 600,
    costPrice: 300,
    trackStock: false,
  });

  const result = operations.createSale(companyId, {
    customerName: "Cliente parcelado",
    items: [
      {
        productId: product.id,
        quantity: 1,
      },
    ],
    payments: [
      {
        method: "pix",
        amount: 200,
      },
      {
        method: "credit_card",
        amount: 300,
        installments: 3,
        firstDueDate: "2026-07-01",
        cardBrand: "Visa",
      },
      {
        method: "promissory_note",
        amount: 100,
        dueDate: "2026-07-15",
      },
    ],
  });

  assert.equal(result.sale.total, 600);
  assert.equal(result.receivables.length, 1);

  const cash = operations.getCashSummary(companyId);
  assert.equal(cash.totalIn, 500);
  assert.equal(cash.balance, 500);

  const receivables = operations.listReceivables(companyId);
  assert.equal(receivables.length, 1);
  assert.equal(receivables.find((receivable) => receivable.method === "promissory_note").dueDate, "2026-07-15");

  const summary = operations.getReceivablesSummary(companyId);
  assert.equal(summary.openAmount, 100);
  assert.equal(summary.openCount, 1);

  const received = operations.markReceivableReceived(companyId, receivables[0].id, {
    amount: 50,
    receiptMethod: "pix",
    receivedAt: "2026-07-01T12:00:00.000Z",
  });

  assert.equal(received.status, "partial");
  assert.equal(received.remainingAmount, 50);
  assert.equal(operations.getCashSummary(companyId).totalIn, 550);
});

test("tracks check deposit and compensation before adding money to cash", () => {
  repository.clear();

  const companyId = "company-check";
  const product = operations.createProduct(companyId, {
    name: "Produto cheque",
    salePrice: 150,
    trackStock: false,
  });

  const result = operations.createSale(companyId, {
    customerName: "Cliente cheque",
    items: [
      {
        productId: product.id,
        quantity: 1,
      },
    ],
    payments: [
      {
        method: "check",
        amount: 150,
        dueDate: "2026-06-25",
        bank: "Banco Teste",
        checkNumber: "000123",
      },
    ],
  });

  const check = result.receivables[0];
  assert.equal(check.status, "awaiting_deposit");
  assert.equal(operations.getCashSummary(companyId).totalIn, 0);

  const deposited = operations.markCheckDeposited(companyId, check.id, {
    depositedAt: "2026-06-25T10:00:00.000Z",
  });
  assert.equal(deposited.status, "deposited");
  assert.equal(operations.getCashSummary(companyId).totalIn, 0);

  const compensated = operations.markReceivableReceived(companyId, check.id, {
    receivedAt: "2026-06-27T10:00:00.000Z",
  });
  assert.equal(compensated.status, "compensated");
  assert.equal(operations.getCashSummary(companyId).totalIn, 150);
  assert.throws(
    () => operations.markCheckReturned(companyId, check.id),
    /Transicao de recebivel invalida/,
  );
});

test("blocks canceling sale with settled receivable unless explicit reversal is allowed", () => {
  repository.clear();

  const companyId = "company-settled-cancel";
  const product = operations.createProduct(companyId, {
    name: "Produto recebido",
    salePrice: 100,
    trackStock: false,
  });
  const saleResult = operations.createSale(companyId, {
    items: [{ productId: product.id, quantity: 1 }],
    payments: [{ method: "promissory_note", amount: 100, dueDate: "2026-07-01" }],
  });
  const receivable = saleResult.receivables[0];

  operations.markReceivableReceived(companyId, receivable.id, {
    receivedAt: "2026-07-01T12:00:00.000Z",
  });

  assert.throws(
    () => operations.cancelSale(companyId, saleResult.sale.id),
    /Venda com recebimento baixado/,
  );
  assert.equal(operations.getSale(companyId, saleResult.sale.id).status, "finalized");

  const canceled = operations.cancelSale(companyId, saleResult.sale.id, {
    allowSettledReversal: true,
    reason: "Estorno autorizado",
  });

  assert.equal(canceled.status, "canceled");
});

test("filters sales report and records events/audit trail", () => {
  repository.clear();

  const companyId = "company-filters";
  const product = operations.createProduct(companyId, {
    name: "Produto filtro",
    salePrice: 40,
    trackStock: false,
  });
  operations.createSale(companyId, {
    soldAt: "2026-06-01T10:00:00.000Z",
    items: [{ productId: product.id, quantity: 1 }],
    payments: [{ method: "cash", amount: 40 }],
  });
  operations.createSale(companyId, {
    soldAt: "2026-06-10T10:00:00.000Z",
    items: [{ productId: product.id, quantity: 1 }],
    payments: [{ method: "pix", amount: 40 }],
  });

  const report = operations.getSalesReport(companyId, {
    dateFrom: "2026-06-05",
    dateTo: "2026-06-30",
    paymentMethod: "pix",
  });

  assert.equal(report.count, 1);
  assert.equal(report.total, 40);
  assert.ok(operations.getEvents(companyId).some((event) => event.type === "sale.created"));
  assert.ok(operations.getAuditLogs(companyId).some((log) => log.entityType === "sale"));
});

test("builds actionable dashboard and permissions for master/client UX", () => {
  repository.clear();

  const companyId = "company-dashboard";
  operations.upsertCompanyProfile(companyId, { name: "Empresa Dashboard" });
  const product = operations.createProduct(companyId, {
    name: "Produto Alerta",
    salePrice: 10,
    minimumStock: 1,
  });
  operations.addInventoryEntry(companyId, { productId: product.id, quantity: 1 });

  const user = operations.createUser(companyId, {
    name: "Vendedor",
    email: "vendedor@teste.com",
    roleKey: "seller",
  });
  const permission = operations.checkPermission(companyId, user.id, "sales:write");

  assert.equal(permission.allowed, true);
  assert.equal(operations.listUsers(companyId).length, 1);
  assert.equal(operations.getMasterCompanies().length, 1);

  const dashboard = operations.getDashboard(companyId);
  assert.ok(dashboard.tasks.some((task) => task.key === "open_cash"));
  assert.ok(dashboard.cards.some((card) => card.key === "low_stock"));
  assert.ok(operations.getAuditLogs(companyId).length > 0);
});

test("blocks sale when tracked product has insufficient stock", () => {
  repository.clear();

  const companyId = "company-stock-block";
  const product = operations.createProduct(companyId, {
    name: "Produto sem estoque",
    salePrice: 50,
  });

  assert.throws(
    () =>
      operations.createSale(companyId, {
        items: [
          {
            productId: product.id,
            quantity: 1,
          },
        ],
      }),
    /Estoque insuficiente/,
  );
});

test("allows services without stock tracking in the same core", () => {
  repository.clear();

  const companyId = "company-service";
  const service = operations.createProduct(companyId, {
    name: "Servico simples",
    type: "service",
    trackStock: false,
    salePrice: 80,
  });

  const result = operations.createSale(companyId, {
    customerName: "Cliente avulso",
    items: [
      {
        productId: service.id,
        quantity: 2,
      },
    ],
  });

  assert.equal(result.sale.total, 160);
  assert.equal(operations.listInventoryMovements(companyId).length, 0);
});
