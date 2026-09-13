const companies = new Map();

function getCompanyStore(companyId) {
  if (!companies.has(companyId)) {
    companies.set(companyId, {
      customers: new Map(),
      products: new Map(),
      inventoryMovements: [],
      sales: new Map(),
      expenses: new Map(),
      cashMovements: [],
      cashSessions: new Map(),
      receivables: new Map(),
      receipts: new Map(),
      users: new Map(),
      auditLogs: [],
      events: [],
      counters: {
        sale: 0,
        receipt: 0,
        cashSession: 0,
        cashMovement: 0,
        inventoryMovement: 0,
        receivable: 0,
        user: 0,
        customer: 0,
        product: 0,
        expense: 0,
      },
      profile: {
        companyId,
        name: null,
        document: null,
        phone: null,
        address: null,
        timezone: "America/Sao_Paulo",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
  }

  return companies.get(companyId);
}

function clear() {
  companies.clear();
}

function nextNumber(companyId, counterKey) {
  const store = getCompanyStore(companyId);
  store.counters[counterKey] = (store.counters[counterKey] || 0) + 1;
  return store.counters[counterKey];
}

function runInTransaction(companyId, operation) {
  const current = getCompanyStore(companyId);
  const snapshot = structuredClone(current);

  try {
    return operation(current);
  } catch (err) {
    companies.set(companyId, snapshot);
    throw err;
  }
}

function listCompanyStores() {
  return Array.from(companies.entries()).map(([companyId, store]) => ({
    companyId,
    profile: store.profile,
    totals: {
      customers: store.customers.size,
      products: store.products.size,
      sales: store.sales.size,
      expenses: store.expenses.size,
      users: store.users.size,
    },
  }));
}

module.exports = {
  clear,
  getCompanyStore,
  listCompanyStores,
  nextNumber,
  runInTransaction,
};
