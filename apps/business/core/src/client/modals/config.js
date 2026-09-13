import {
  BadgeDollarSign,
  Boxes,
  Building2,
  CalendarClock,
  CircleDollarSign,
  CreditCard,
  Download,
  FileCheck2,
  FileText,
  Glasses,
  PackagePlus,
  PanelsTopLeft,
  Settings,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Store,
  UserCog,
  UsersRound,
  WalletCards,
  Wrench,
} from "lucide-react";
import { splitAccessList } from "../core/access";
import { applyExtensionModalContributions, extensionAccessAreas, fallbackPermissionsForRoleWithExtensions } from "../extensions/registry";
import { formatCurrency, formatMoneyInput, parseMoney } from "../core/formatters";
import { recordKey } from "../core/records";
import { createEmptySalePayment, saleDefaultDueDate } from "../core/sales";
import { createRequestId } from "../core/ids";

const NEW_PRODUCT_BRAND_VALUE = "__new_product_brand__";

const userAccessAreas = [
  { screen: "dashboard", label: "Dashboard", read: "dashboard:read" },
  { screen: "sales", label: "Vendas", read: "sales:read", write: "sales:write" },
  { screen: "customers", label: "Clientes", read: "customers:read", write: "customers:write" },
  { screen: "products", label: "Produtos", read: "products:read", write: "products:write" },
  { screen: "inventory", label: "Estoque", read: "inventory:read", write: "inventory:write" },
  { screen: "payments", label: "Pagamentos", read: "payments:read", write: "payments:write" },
  { screen: "receivables", label: "Recebiveis", read: "receivables:read", write: "receivables:write" },
  { screen: "cash_register", label: "Caixa", read: "cash_register:read", write: "cash_register:write" },
  { screen: "receipts", label: "Recibos", read: "receipts:read" },
  { screen: "finance", label: "Financeiro", read: "expenses:read", write: "expenses:write" },
  { screen: "service_orders", label: "Ordens de servico", read: "service_orders:read", write: "service_orders:write" },
  { screen: "services", label: "Servicos Volt", read: "services:read", write: "services:write", writeLabel: "Solicitar" },
  { screen: "reports", label: "Relatorios", read: "reports:read", write: "reports:export", writeLabel: "Exportar" },
  { screen: "settings", label: "Configuracoes", read: "settings:read", write: "settings:write" },
  { screen: "users", label: "Usuarios", read: "users:read", write: "users:write" },
];

function customFieldInputName(field) {
  return `custom__${field.id || field.key || String(field.name || "campo").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function buildDynamicFields(customFields, moduleName) {
  return (customFields || [])
    .filter((field) => String(field.module || "").toLowerCase() === String(moduleName || "").toLowerCase())
    .map((field) => {
      const type = String(field.fieldType || field.type || "Texto").toLowerCase();
      const input = {
        name: customFieldInputName(field),
        label: field.name || field.label || "Campo personalizado",
        required: field.required === true || String(field.required || "").toLowerCase() === "sim",
        customFieldKey: field.id || field.key,
      };
      if (type === "numero" || type === "número" || type === "number") {
        input.type = "number";
        if (field.min !== undefined && field.min !== null) input.min = String(field.min);
        if (field.max !== undefined && field.max !== null) input.max = String(field.max);
        input.step = field.step !== undefined && field.step !== null ? String(field.step) : "any";
      } else if (type === "data" || type === "date") input.type = "date";
      else if (type === "textarea") { input.type = "textarea"; input.wide = true; }
      else if (type === "booleano") {
        input.type = "select";
        input.options = ["Nao", "Sim"];
      } else if (type === "lista") {
        const options = Array.isArray(field.options)
          ? field.options
          : String(field.options || "").split(",").map((item) => item.trim()).filter(Boolean);
        input.type = options.length ? "select" : "text";
        if (options.length) input.options = options;
      }
      return input;
    });
}

function buildDynamicDefaults(fields, payloadCustomFields = {}) {
  return Object.fromEntries((fields || []).map((field) => [
    field.name,
    payloadCustomFields?.[field.customFieldKey || field.id || field.key] ?? "",
  ]));
}

function accessPresetForRole(role, enabledScreens = [], accessAreas = userAccessAreas, configuration = {}) {
  const permissions = fallbackPermissionsForRoleWithExtensions(role, configuration);
  const allowed = new Set(enabledScreens);
  const screens = permissions.includes("*")
    ? [...enabledScreens]
    : accessAreas
      .filter((area) => allowed.has(area.screen) && permissions.includes(area.read))
      .map((area) => area.screen);
  return { screens, permissions };
}


function humanizeWorkflowStatus(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function workflowStatusOptions(data, key, fallbackOptions) {
  const workflow = (data.workflows || []).find((item) => String(item.key || "").toLowerCase() === String(key).toLowerCase());
  if (!workflow?.states?.length) return fallbackOptions;
  return workflow.states.map((state) => ({ value: state, label: humanizeWorkflowStatus(state) }));
}

function buildModalConfig(type, data, payload, workspace) {
  const firstProduct = data.products[0]?.name || "";
  const firstProductPrice = parseMoney(data.products[0]?.price || 0);
  const customerOptions = ["Cliente avulso", ...data.customers.map((customer) => customer.name)];
  const productOptions = data.products.map((product) => product.name);
  const stockProductOptions = data.products
    .filter((product) => product.type !== "Servico" && product.status !== "Servico")
    .map((product) => ({
      value: product.id || product.sku || product.name,
      label: product.name,
      name: product.name,
      sku: product.sku || "",
      ean: product.ean || "",
      category: product.category || "",
      brand: product.brand || "",
      stock: product.stock ?? "-",
      min: product.min ?? "-",
      price: product.price || "",
    }));
  const firstStockProduct = stockProductOptions[0];
  const productCategoryOptions = (data.productCategories || [])
    .filter((category) => category.active !== false && category.status !== "Inativo")
    .map((category) => category.name);
  const fallbackProductCategories = [...new Set(data.products.map((product) => product.category).filter(Boolean))];
  const availableProductCategories = productCategoryOptions.length ? productCategoryOptions : fallbackProductCategories;
  const productBrandOptions = (data.productBrands || [])
    .filter((brand) => brand.active !== false && brand.status !== "Inativo")
    .map((brand) => brand.name);
  const fallbackProductBrands = [...new Set(data.products.map((product) => product.brand).filter(Boolean))];
  const availableProductBrands = productBrandOptions.length ? productBrandOptions : fallbackProductBrands;
  const productModalCategoryOptions = [...new Set([...availableProductCategories, "Servicos"])];
  const customerDynamicFields = buildDynamicFields(data.customFields, "Clientes");
  const productDynamicFields = buildDynamicFields(data.customFields, "Produtos");
  const saleDynamicFields = buildDynamicFields(data.customFields, "Vendas");
  const serviceOrderDynamicFields = buildDynamicFields(data.customFields, "OS");
  const financeDynamicFields = buildDynamicFields(data.customFields, "Financeiro");
  const serviceOrderStatusOptions = workflowStatusOptions(data, "service_order", [
    { value: "open", label: "Aberta" },
    { value: "in_production", label: "Em producao" },
    { value: "waiting_part", label: "Aguardando peca" },
    { value: "ready", label: "Pronto" },
    { value: "delivered", label: "Entregue" },
    { value: "canceled", label: "Cancelado" },
  ]);

  const editing = payload.mode === "edit";
  const editMeta = {
    mode: payload.mode || "create",
    editKey: payload.editKey || recordKey(payload),
    recordId: payload.recordId || payload.id || null,
  };
  const masterCompanyOptions = (payload.companies || []).map((company) => ({ value: company.id, label: company.name }));
  const companyScreensById = Object.fromEntries((payload.companies || []).map((company) => [company.id, company.screens || []]));
  const defaultUserCompanyId = payload.companyId || (payload.masterContext ? "" : masterCompanyOptions[0]?.value || "");
  const enabledCompanyScreens = workspace?.configuration?.screens?.length
    ? workspace.configuration.screens
    : companyScreensById[defaultUserCompanyId] || [];
  const defaultUserRole = payload.role || "Operador";
  const effectiveUserAccessAreas = [...userAccessAreas, ...extensionAccessAreas(workspace?.configuration)];
  const defaultUserAccess = accessPresetForRole(defaultUserRole, enabledCompanyScreens, effectiveUserAccessAreas, workspace?.configuration || {});
  const initialUserScreens = payload.screens === undefined
    ? defaultUserAccess.screens
    : splitAccessList(payload.screens);
  const initialUserPermissions = payload.permissions === undefined
    ? defaultUserAccess.permissions
    : splitAccessList(payload.permissions);
  const availableCompanyModules = workspace?.configuration?.availableModules || [];
  const availableCompanyScreens = workspace?.configuration?.availableScreens || [];
  const effectiveCompanyModules = workspace?.configuration?.modules || [];
  const effectiveCompanyScreens = workspace?.configuration?.screens || [];

  const configs = {
    customer: {
      title: editing ? "Editar cliente" : "Novo cliente",
      description: "Cadastre o minimo para vender agora; dados extras podem ser completados depois.",
      icon: UsersRound,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar cliente",
      fields: [
        { name: "name", label: "Nome do cliente", required: true },
        { name: "phone", label: "Telefone / WhatsApp" },
        { name: "document", label: "CPF/CNPJ (opcional)" },
        { name: "email", label: "E-mail (opcional)", type: "email" },
        { name: "notes", label: "Observacoes e dados avancados", type: "textarea", wide: true },
        ...customerDynamicFields,
      ],
      defaults: {
        ...editMeta,
        name: payload.name || "",
        document: payload.document || "",
        phone: payload.phone || "",
        email: payload.email || "",
        segment: payload.segment || "Varejo",
        notes: payload.notes || "",
        ...buildDynamicDefaults(customerDynamicFields, payload.customFields),
      },
    },
    productCategory: {
      title: editing ? "Editar categoria" : "Nova categoria",
      description: "Organize o catalogo com categorias pesquisaveis no cadastro de produtos.",
      icon: SlidersHorizontal,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar categoria",
      fields: [
        { name: "name", label: "Nome da categoria", required: true },
        { name: "description", label: "Descricao", type: "textarea", wide: true },
      ],
      defaults: {
        ...editMeta,
        name: payload.name || "",
        description: payload.description || "",
      },
    },
    productBrand: {
      title: editing ? "Editar marca" : "Nova marca",
      description: "Padronize marcas para filtros, relatorios e cadastro de produtos.",
      icon: Store,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar marca",
      fields: [
        { name: "name", label: "Nome da marca", required: true },
        { name: "description", label: "Descricao", type: "textarea", wide: true },
      ],
      defaults: {
        ...editMeta,
        name: payload.name || "",
        description: payload.description || "",
      },
    },
    product: {
      title: editing ? "Editar produto" : "Novo produto",
      description: editing ? "Atualize os dados comerciais e de estoque do item." : "Cadastre um produto com estoque ou um servico sem controle de estoque.",
      icon: PackagePlus,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar item",
      fields: [
        ...(editing ? [{ name: "type", label: "Natureza do item", type: "nature_summary", wide: true }] : [{ name: "type", label: "Natureza do item", type: "select", options: [{ value: "Produto", label: "Produto com estoque" }, { value: "Servico", label: "Servico sem estoque" }] }]),
        { name: "name", label: "Nome", required: true },
        { name: "sku", label: "SKU" },
        { name: "ean", label: "EAN / codigo de barras", inputMode: "numeric", visibleWhen: { name: "type", value: "Produto" } },
        { name: "brand", label: "Marca", type: "select", options: [{ value: "", label: "Sem marca" }, ...availableProductBrands, { value: NEW_PRODUCT_BRAND_VALUE, label: "+ Nova marca" }], visibleWhen: { name: "type", value: "Produto" } },
        { name: "newBrandName", label: "Nome da nova marca", required: true, visibleWhen: { name: "brand", value: NEW_PRODUCT_BRAND_VALUE } },
        { name: "newBrandDescription", label: "Descricao da marca", type: "textarea", wide: true, visibleWhen: { name: "brand", value: NEW_PRODUCT_BRAND_VALUE } },
        { name: "category", label: "Categoria", type: "select", options: productModalCategoryOptions, required: true },
        ...productDynamicFields,
        { name: "price", label: "Preco de venda", inputMode: "decimal", required: true },
        { name: "cost", label: "Custo", inputMode: "decimal" },
        ...(!editing ? [{ name: "stock", label: "Quantidade inicial", type: "number", min: "0", step: "0.001", visibleWhen: { name: "type", value: "Produto" } }] : []),
        { name: "min", label: "Estoque minimo", type: "number", min: "0", step: "0.001", visibleWhen: { name: "type", value: "Produto" } },
      ],
      defaults: {
        ...editMeta,
        type: payload.type || (payload.status === "Servico" ? "Servico" : "Produto"),
        name: payload.name || "",
        sku: payload.sku || "",
        ean: payload.ean || "",
        brand: payload.brand || "",
        newBrandName: "",
        newBrandDescription: "",
        category: payload.category || (payload.status === "Servico" ? "Servicos" : productModalCategoryOptions[0] || ""),
        price: payload.price || "",
        cost: payload.cost || "",
        stock: payload.stock === "-" ? "0" : String(payload.stock ?? "0"),
        min: payload.min === "-" ? "0" : String(payload.min ?? "0"),
        ...buildDynamicDefaults(productDynamicFields, payload.customFields),
      },
    },
    movement: {
      title: "Atualizar estoque",
      description: "Informe se recebeu mercadoria, registrou uma saida ou precisa corrigir o saldo.",
      icon: Boxes,
      submitLabel: "Registrar",
      fields: [
        { name: "kind", label: "O que aconteceu?", type: "select", options: [{ value: "Entrada", label: "Recebi produtos" }, { value: "Saida", label: "Saiu sem venda" }, { value: "Ajuste", label: "Preciso corrigir o saldo" }] },
        { name: "product", label: "Produto", type: "product_lookup", resource: "products", options: stockProductOptions, idField: "productId", required: true },
        { name: "quantity", label: payload.kind === "Ajuste" ? "Saldo contado no estoque" : "Quantidade", type: "number", min: "0", step: "0.001", required: true },
        { name: "reason", label: "Motivo", required: true },
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: {
        ...editMeta,
        kind: payload.kind || "Entrada",
        product: payload.product || firstStockProduct?.name || firstProduct,
        productId: payload.productId || data.products.find((product) => product.name === payload.product || product.sku === payload.sku)?.id || firstStockProduct?.value || "",
        quantity: payload.quantity || "1",
        reason: payload.reason || "Compra fornecedor",
        notes: payload.notes || (payload.kind === "Ajuste" ? "O sistema calcula a diferenca a partir do saldo atual." : ""),
      },
    },
    sale: {
      title: "Finalizar venda",
      description: "Busque cliente e produto e combine uma ou mais formas de pagamento.",
      icon: ShoppingCart,
      submitLabel: "Finalizar venda",
      fields: [
        { name: "customer", label: "Cliente", type: "search", options: customerOptions, wide: true },
        { name: "product", label: "Produto", type: "search", options: productOptions, required: true },
        { name: "quantity", label: "Quantidade", type: "number", min: "0", step: "0.001", required: true },
        { name: "soldAt", label: "Data/hora da venda", type: "datetime-local" },
        ...saleDynamicFields,
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: {
        ...editMeta,
        idempotencyKey: payload.idempotencyKey || createRequestId("sale"),
        customer: payload.customer || customerOptions[0],
        product: payload.product || firstProduct,
        quantity: String(payload.quantity || "1"),
        items: Array.isArray(payload.items) ? payload.items : [],
        customerId: payload.customerId || "",
        payments: Array.isArray(payload.payments) ? payload.payments : [createEmptySalePayment(Number(payload.total || 0) || firstProductPrice)],
        soldAt: payload.soldAt || "",
        ...buildDynamicDefaults(saleDynamicFields, payload.customFields),
        notes: "",
      },
    },
    saleEdit: {
      title: "Editar venda",
      description: "Corrija cliente, data, observacao ou pagamentos. Para alterar itens, cancele a venda e registre uma nova.",
      icon: ShoppingCart,
      submitLabel: "Salvar alteracoes",
      fields: [
        { name: "customer", label: "Cliente", type: "customer_lookup", resource: "customers", options: customerOptions, idField: "customerId", wide: true },
        { name: "soldAt", label: "Data/hora da venda", type: "datetime-local" },
        ...saleDynamicFields,
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: {
        saleId: payload.recordId || payload.saleId || "",
        customer: payload.customer || "Cliente avulso",
        customerId: payload.customerId || "",
        soldAt: String(payload.soldAt || "").slice(0, 16),
        total: payload.total || "0",
        payments: Array.isArray(payload.payments) ? payload.payments : [createEmptySalePayment(parseMoney(payload.total || 0))],
        ...buildDynamicDefaults(saleDynamicFields, payload.customFields),
        notes: payload.notes || "",
      },
    },
    companyModules: {
      title: "Modulos da empresa",
      description: "Ative somente as capacidades contratadas para esta empresa. Dependencias sao resolvidas automaticamente.",
      icon: PanelsTopLeft,
      submitLabel: "Salvar modulos",
      fields: [
        {
          name: "modules",
          label: "Modulos habilitados",
          type: "checkbox_group",
          wide: true,
          options: availableCompanyModules.map((module) => ({
            value: module.key,
            label: `${module.name}${module.required ? " (obrigatorio)" : module.managedByProduct ? " (gerenciado por Servicos Volt)" : ""}`,
            disabled: module.required || module.managedByProduct,
          })),
        },
        { name: "maxUsers", label: "Limite de usuarios", type: "number", min: "1", step: "1", placeholder: "Sem limite" },
      ],
      defaults: {
        modules: effectiveCompanyModules,
        baseModules: workspace?.configuration?.baseModules || effectiveCompanyModules,
        requiredModules: availableCompanyModules.filter((module) => module.required).map((module) => module.key),
        currentLimits: workspace?.configuration?.overrides?.limits || {},
        maxUsers: workspace?.configuration?.overrides?.limits?.users ?? "",
      },
    },
    commercialProduct: {
      title: payload.masterMode ? "Gerenciar produto Volt" : "Solicitar produto Volt",
      description: payload.masterMode
        ? "Defina o plano e o estado comercial. Modulos e telas vinculados sao aplicados automaticamente."
        : "Escolha o plano desejado. A ativacao final e feita pelo Master.",
      icon: BadgeDollarSign,
      submitLabel: payload.masterMode ? "Salvar produto" : "Solicitar ativacao",
      fields: [
        {
          name: "planKey",
          label: "Plano",
          type: "select",
          options: (payload.plans || []).map((plan) => ({
            value: plan.key,
            label: `${plan.name}${plan.limitLabel ? ` - ${plan.limitLabel}` : ""}${plan.priceLabel ? ` - ${plan.priceLabel}` : ""}`,
          })),
          visibleWhen: (payload.plans || []).length ? undefined : { name: "__never", value: "1" },
        },
        ...(payload.masterMode ? [{
          name: "status",
          label: "Status",
          type: "select",
          options: [
            { value: "contracted", label: "Contratado" },
            { value: "configuring", label: "Configurando" },
            { value: "active", label: "Ativo" },
            { value: "suspended", label: "Suspenso" },
          ],
        }] : []),
      ],
      defaults: {
        productKey: payload.productKey,
        productName: payload.productName,
        planKey: payload.planKey || payload.plans?.[0]?.key || "",
        status: payload.status === "available" || payload.status === "coming_soon" ? "contracted" : payload.status || "contracted",
        masterMode: Boolean(payload.masterMode),
      },
    },
    companyScreens: {
      title: "Telas da empresa",
      description: "Controle quais telas habilitadas pelos modulos aparecem para esta empresa.",
      icon: SlidersHorizontal,
      submitLabel: "Salvar telas",
      fields: [
        {
          name: "screens",
          label: "Telas visiveis",
          type: "checkbox_group",
          wide: true,
          options: availableCompanyScreens
            .filter((screen) => effectiveCompanyModules.includes(screen.moduleKey))
            .map((screen) => ({ value: screen.key, label: screen.name })),
        },
      ],
      defaults: {
        screens: effectiveCompanyScreens,
        baseScreens: workspace?.configuration?.baseScreens || effectiveCompanyScreens,
      },
    },
    operationalRules: {
      title: "Regras operacionais",
      description: "Defina as travas aplicadas pelo motor ao registrar vendas e estoque.",
      icon: ShieldCheck,
      submitLabel: "Salvar regras",
      fields: [
        { name: "requireOpenCashSession", label: "Exigir caixa aberto", type: "select", options: ["Nao", "Sim"] },
        { name: "allowAnonymousCustomer", label: "Permitir cliente avulso", type: "select", options: ["Sim", "Nao"] },
        { name: "requireInventoryAdjustmentReason", label: "Exigir motivo em ajuste", type: "select", options: ["Sim", "Nao"] },
      ],
      defaults: {
        requireOpenCashSession: payload.requireOpenCashSession ? "Sim" : "Nao",
        allowAnonymousCustomer: payload.allowAnonymousCustomer === false ? "Nao" : "Sim",
        requireInventoryAdjustmentReason: payload.requireInventoryAdjustmentReason === false ? "Nao" : "Sim",
      },
    },
    settings: {
      title: "Dados da empresa",
      description: "Atualize a identificacao que aparece no modulo e nos documentos.",
      icon: Store,
      submitLabel: "Salvar configuracoes",
      fields: [
        { name: "companyName", label: "Nome fantasia", required: true },
        { name: "legalName", label: "Razao social" },
        { name: "document", label: "CNPJ" },
        { name: "phone", label: "Telefone" },
        { name: "email", label: "E-mail", type: "email" },
      ],
      defaults: {
        ...editMeta,
        companyName: payload.companyName || workspace?.configuration?.name || "",
        legalName: payload.legalName || "",
        document: payload.document || "",
        phone: payload.phone || "",
        email: payload.email || "",
      },
    },
    cashMovement: {
      title: payload.type === "exit" ? "Registrar sangria" : "Registrar reforco",
      description: "Lance uma entrada ou saida manual no caixa da empresa.",
      icon: CircleDollarSign,
      submitLabel: "Salvar movimento",
      fields: [
        { name: "type", label: "Tipo", type: "select", options: ["entry", "exit"] },
        { name: "amount", label: "Valor", inputMode: "decimal", required: true },
        { name: "paymentMethod", label: "Forma", type: "select", options: ["cash", "pix", "debit", "credit_card", "transfer"] },
        { name: "operationalAt", label: "Data/hora operacional", type: "datetime-local" },
        { name: "description", label: "Descricao", required: true },
      ],
      defaults: {
        ...editMeta,
        sessionId: payload.sessionId || null,
        type: payload.type || "entry",
        amount: "",
        paymentMethod: "cash",
        operationalAt: "",
        description: payload.type === "exit" ? "Sangria" : "Reforco",
      },
    },
    cashSession: {
      title: payload.mode === "close" ? "Fechar caixa" : "Abrir caixa",
      description: payload.mode === "close" ? "Informe o valor contado para calcular a diferenca." : "Informe o saldo inicial da sessao.",
      icon: CircleDollarSign,
      submitLabel: payload.mode === "close" ? "Confirmar fechamento" : "Abrir caixa",
      fields: payload.mode === "close"
        ? [
            { name: "countedAmount", label: "Valor contado", inputMode: "decimal", required: true },
            { name: "notes", label: "Observacao", type: "textarea", wide: true },
          ]
        : [
            { name: "openingAmount", label: "Saldo inicial", inputMode: "decimal", required: true },
            { name: "notes", label: "Observacao", type: "textarea", wide: true },
          ],
      defaults: {
        sessionMode: payload.mode || "open",
        sessionId: payload.sessionId || null,
        openingAmount: "0,00",
        countedAmount: formatMoneyInput(payload.expected || 0) || "0,00",
        notes: "",
      },
    },
    receivable: {
      title: "Novo recebivel",
      description: "Cadastre uma conta a receber manual com cliente, vencimento e origem.",
      icon: WalletCards,
      submitLabel: "Salvar recebivel",
      fields: [
        { name: "customer", label: "Cliente", type: "search", options: data.customers.map((customer) => customer.name), required: true, wide: true },
        { name: "method", label: "Tipo", type: "select", options: [
          { value: "store_credit", label: "Crediario interno" },
          { value: "promissory_note", label: "Nota promissoria" },
          { value: "check", label: "Cheque" },
          { value: "credit_card", label: "Cartao de credito" },
          { value: "boleto", label: "Boleto" },
        ] },
        { name: "amount", label: "Valor", inputMode: "decimal", required: true },
        { name: "dueDate", label: "Vencimento", type: "date", required: true },
        { name: "description", label: "Origem/descricao", required: true },
        { name: "bank", label: "Banco" },
        { name: "checkNumber", label: "Numero do cheque" },
        { name: "holderName", label: "Titular" },
        { name: "holderDocument", label: "CPF/CNPJ do titular" },
        ...financeDynamicFields,
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: {
        ...editMeta,
        customer: payload.customer || data.customers[0]?.name || "",
        method: payload.method || "store_credit",
        amount: payload.value || "",
        dueDate: payload.dueDate ? String(payload.dueDate).slice(0, 10) : saleDefaultDueDate(),
        description: payload.origin || "Recebivel manual",
        bank: payload.bank || "",
        checkNumber: payload.checkNumber || "",
        holderName: payload.holderName || "",
        holderDocument: payload.holderDocument || "",
        ...buildDynamicDefaults(financeDynamicFields, payload.customFields),
        notes: payload.notes || "",
      },
    },
    receivableReceive: {
      title: "Receber valor",
      description: "Baixe o recebivel e registre a entrada no caixa.",
      icon: WalletCards,
      submitLabel: "Confirmar recebimento",
      fields: [
        { name: "receivableId", label: "Recebivel", type: "select", options: [payload.id || payload.receivableId || recordKey(payload)].filter(Boolean) },
        { name: "amount", label: "Valor recebido", inputMode: "decimal", required: true },
        { name: "paymentMethod", label: "Forma", type: "select", options: ["pix", "cash", "debit", "credit_card", "transfer"] },
      ],
      defaults: {
        ...editMeta,
        receivableId: payload.id || payload.receivableId || recordKey(payload),
        amount: payload.value || "",
        paymentMethod: "pix",
      },
    },
    receivableDueDate: {
      title: "Corrigir vencimento",
      description: payload.saleId
        ? "Confirme o vencimento combinado na venda antes de corrigir. A sugestao automatica de 30 dias nao substitui o acordo com o cliente."
        : "Confirme o vencimento acordado antes de corrigir. A data anterior, a nova data, o motivo e o usuario ficarao registrados na auditoria.",
      icon: CalendarClock,
      submitLabel: "Salvar correcao",
      fields: [
        { name: "receivableId", label: "Recebivel", type: "select", options: [payload.id || payload.receivableId || recordKey(payload)].filter(Boolean) },
        { name: "dueDate", label: "Novo vencimento", type: "date", required: true },
        { name: "reason", label: "Motivo da correcao", type: "textarea", required: true, wide: true, placeholder: "Explique por que o vencimento precisa ser corrigido." },
      ],
      defaults: {
        receivableId: payload.id || payload.receivableId || recordKey(payload),
        dueDate: payload.dueDate ? String(payload.dueDate).slice(0, 10) : "",
        reason: "",
      },
    },
    receivableStatus: {
      title: payload.action === "return-check" ? "Registrar cheque devolvido" : "Registrar deposito do cheque",
      description: "Atualize o status do cheque sem dar baixa no caixa antes do recebimento.",
      icon: FileText,
      submitLabel: payload.action === "return-check" ? "Registrar devolucao" : "Registrar deposito",
      fields: [
        { name: "receivableId", label: "Recebivel", type: "select", options: [payload.id || payload.receivableId || recordKey(payload)].filter(Boolean) },
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: {
        ...editMeta,
        receivableId: payload.id || payload.receivableId || recordKey(payload),
        action: payload.action || "deposit-check",
        feedback: payload.action === "return-check" ? "Cheque marcado como devolvido." : "Cheque marcado como depositado.",
        notes: "",
      },
    },
    paymentMethod: {
      title: editing ? "Editar forma de pagamento" : "Nova forma de pagamento",
      description: "Configure recebimento, taxa e prazo de compensacao.",
      icon: CreditCard,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar forma",
      fields: [
        { name: "name", label: "Nome", required: true },
        { name: "type", label: "Tipo", type: "select", options: ["Imediato", "Prazo", "Recebivel"] },
        { name: "fee", label: "Taxa" },
        { name: "settlement", label: "Prazo" },
      ],
      defaults: { ...editMeta, name: payload.name || "", type: payload.type || "Imediato", fee: payload.fee || "0,00%", settlement: payload.settlement || "Na hora" },
    },
    expense: {
      title: editing ? "Editar despesa" : "Nova despesa",
      description: "Cadastre uma conta a pagar para compor o fluxo financeiro.",
      icon: FileText,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar despesa",
      fields: [
        { name: "name", label: "Despesa", required: true },
        { name: "category", label: "Categoria", type: "select", options: ["Mercadoria", "Fixo", "Operacional", "Pessoas", "Impostos"] },
        { name: "due", label: "Vencimento", required: true },
        { name: "value", label: "Valor", inputMode: "decimal", required: true },
        ...financeDynamicFields,
      ],
      defaults: { ...editMeta, name: payload.name || "", category: payload.category || "Operacional", due: payload.due || "", value: payload.value || "", ...buildDynamicDefaults(financeDynamicFields, payload.customFields) },
    },
    serviceOrder: {
      title: editing ? "Editar ordem de servico" : "Nova ordem de servico",
      description: "Abra uma OS com responsavel, prazo e status inicial.",
      icon: Wrench,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar OS",
      fields: [
        { name: "customer", label: "Cliente", type: "select", options: customerOptions, required: true },
        { name: "service", label: "Produto/servico" },
        { name: "owner", label: "Responsavel" },
        { name: "due", label: "Previsao" },
        { name: "status", label: "Status", type: "select", options: serviceOrderStatusOptions },
        ...serviceOrderDynamicFields,
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: { ...editMeta, customer: payload.customer || customerOptions[0], service: payload.service || "", owner: payload.owner || "Balcao", due: payload.due || "Hoje", status: payload.statusKey || payload.status || "open", ...buildDynamicDefaults(serviceOrderDynamicFields, payload.customFields), notes: payload.notes || "" },
    },
    user: {
      title: editing ? "Editar usuario" : "Novo usuario",
      description: editing
        ? "Atualize as permissoes locais do usuario nesta empresa."
        : "O usuario sera vinculado a empresa no Hub e recebera um convite para criar a senha.",
      icon: UserCog,
      submitLabel: editing ? "Salvar alteracoes" : "Criar usuario",
      fields: [
        ...(payload.masterContext ? [{
          name: "companyId",
          label: "Empresa",
          type: "select",
          placeholder: "Selecione a empresa",
          options: masterCompanyOptions,
          required: true,
        }] : []),
        { name: "name", label: "Nome", required: true },
        { name: "email", label: "E-mail", type: "email" },
        { name: "role", label: "Perfil", type: "select", options: ["Owner", "Gerente", "Operador", "Estoque", "Financeiro"] },
        {
          name: "access",
          label: "Acesso por tela",
          type: "access_matrix",
          wide: true,
          enabledScreens: enabledCompanyScreens,
          companyScreens: companyScreensById,
        },
      ],
      defaults: {
        ...editMeta,
        companyId: defaultUserCompanyId,
        name: payload.name || "",
        email: payload.email || "",
        role: defaultUserRole,
        screens: initialUserScreens,
        permissions: initialUserPermissions,
      },
    },
    company: {
      title: editing ? "Editar empresa" : "Nova empresa",
      description: "A empresa e validada primeiro no Hub; depois o Volt Core cria o ambiente operacional.",
      icon: Building2,
      submitLabel: editing ? "Salvar alteracoes" : "Criar empresa",
      fields: [
        { name: "name", label: "Empresa", required: true },
        { name: "segment", label: "Segmento", type: "select", options: ["Core", "Otica"] },
        { name: "plan", label: "Plano", type: "select", options: ["Starter", "Pro", "Enterprise"] },
        { name: "modules", label: "Modulos" },
      ],
      defaults: { ...editMeta, name: payload.name || "", segment: payload.segment || "Core", plan: payload.plan || "Starter", modules: payload.modules || "8", status: payload.status || "Pendente" },
    },
    customField: {
      title: editing ? "Editar campo personalizado" : "Novo campo personalizado",
      description: "Adicione um campo por modulo para adaptar a empresa sem alterar o codigo do nicho.",
      icon: SlidersHorizontal,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar campo",
      fields: [
        { name: "name", label: "Campo", required: true },
        { name: "module", label: "Modulo", type: "select", options: ["Clientes", "Vendas", "Produtos", "OS", "Financeiro", "Receita optica"] },
        { name: "fieldType", label: "Tipo", type: "select", options: ["Texto", "Numero", "Data", "Lista", "Booleano", "Textarea"] },
        { name: "options", label: "Opcoes separadas por virgula", visibleWhen: { name: "fieldType", value: "Lista" }, wide: true },
        { name: "placeholder", label: "Placeholder" },
        { name: "helpText", label: "Texto de ajuda", wide: true },
        { name: "min", label: "Minimo", type: "number", visibleWhen: { name: "fieldType", value: "Numero" } },
        { name: "max", label: "Maximo", type: "number", visibleWhen: { name: "fieldType", value: "Numero" } },
        { name: "step", label: "Passo", type: "number", min: "0", step: "any", visibleWhen: { name: "fieldType", value: "Numero" } },
        { name: "order", label: "Ordem", type: "number", min: "0", step: "1" },
        { name: "required", label: "Obrigatorio", type: "select", options: ["Nao", "Sim"] },
      ],
      defaults: {
        ...editMeta,
        name: payload.name || "",
        module: payload.module || "Clientes",
        fieldType: payload.fieldType || payload.type || "Texto",
        options: Array.isArray(payload.options) ? payload.options.join(", ") : payload.options || "",
        placeholder: payload.placeholder || "",
        helpText: payload.helpText || "",
        min: payload.min ?? "",
        max: payload.max ?? "",
        step: payload.step ?? "",
        order: payload.order ?? "0",
        required: payload.required || "Nao",
      },
    },
    workflow: {
      title: editing ? "Editar workflow" : "Novo workflow",
      description: "Defina estados e transicoes permitidas para adaptar o processo operacional sem condicionais por nicho.",
      icon: Wrench,
      submitLabel: editing ? "Salvar workflow" : "Criar workflow",
      fields: [
        { name: "key", label: "Chave", required: true },
        { name: "name", label: "Nome", required: true },
        { name: "initial", label: "Estado inicial", required: true },
        { name: "states", label: "Estados separados por virgula", type: "textarea", wide: true, required: true },
        { name: "transitions", label: "Transicoes (JSON)", type: "textarea", wide: true, required: true },
      ],
      defaults: {
        ...editMeta,
        key: payload.key || "",
        name: payload.name || "",
        initial: payload.initial || "",
        states: Array.isArray(payload.states) ? payload.states.join(", ") : payload.states || "",
        transitions: typeof payload.transitions === "string" ? payload.transitions : JSON.stringify(payload.transitions || {}, null, 2),
      },
    },
    modulePlan: {
      title: editing ? "Editar plano de modulos" : "Novo plano de modulos",
      description: "Monte uma oferta com quantidade de modulos e preco base.",
      icon: PanelsTopLeft,
      submitLabel: editing ? "Salvar alteracoes" : "Salvar plano",
      fields: [
        { name: "name", label: "Nome do plano", required: true },
        { name: "modules", label: "Modulos" },
        { name: "price", label: "Preco" },
      ],
      defaults: { ...editMeta, name: payload.name || "", modules: payload.modules || "8", price: payload.price || "Sob consulta" },
    },
    importData: {
      title: payload.entity === "products" ? "Importar produtos" : "Importar dados",
      description: payload.entity === "products"
        ? "Use o modelo baixado na tela de produtos, preencha no Excel e cole aqui o conteudo salvo como CSV."
        : "Cole um CSV com cabecalho para importar clientes ou produtos no ambiente atual.",
      icon: Download,
      submitLabel: payload.entity === "products" ? "Importar produtos" : "Importar registros",
      fields: [
        { name: "entity", label: "Tipo", type: "select", options: [{ value: "customers", label: "Clientes" }, { value: "products", label: "Produtos" }] },
        { name: "csv", label: payload.entity === "products" ? "Conteudo da planilha em CSV" : "CSV", type: "textarea", wide: true, required: true },
      ],
      defaults: {
        ...editMeta,
        entity: payload.entity || "customers",
        csv: payload.csv || "",
      },
    },
    confirmAction: {
      title: payload.actionKind === "delete" ? "Confirmar exclusao" : "Confirmar alteracao",
      description: `Esta acao afeta ${payload.label || "o registro"} e sera registrada na auditoria.`,
      icon: ShieldCheck,
      submitLabel: payload.actionKind === "delete" ? "Excluir" : "Confirmar",
      danger: payload.actionKind === "delete",
      fields: [
        { name: "reason", label: "Motivo", type: "textarea", wide: true, required: true },
      ],
      defaults: {
        ...editMeta,
        collection: payload.collection,
        actionKind: payload.actionKind || "deactivate",
        targetKey: payload.targetKey,
        targetId: payload.targetId,
        label: payload.label,
        nextStatus: payload.nextStatus || "Inativo",
        feedback: payload.feedback || "Acao confirmada.",
        auditTitle: payload.actionKind === "delete" ? "Registro excluido" : "Status alterado",
        reason: "",
      },
    },
    genericConfig: {
      title: payload.title || "Configurar",
      description: payload.description || "Ajuste salvo para continuar o fluxo.",
      icon: payload.icon || Settings,
      submitLabel: payload.submitLabel || "Salvar",
      fields: [
        { name: "name", label: payload.label || "Nome", required: true },
        { name: "notes", label: "Observacao", type: "textarea", wide: true },
      ],
      defaults: { name: payload.defaultName || "", notes: "", feedback: payload.feedback || "Configuracao salva." },
    },
  };

  const extensionContext = {
    data,
    payload,
    editing,
    editMeta,
    customerOptions,
    buildDynamicFields,
    workflowStatusOptions,
    productModalCategoryOptions,
    buildDynamicDefaults,
  };
  const baseConfig = configs[type] || null;
  return applyExtensionModalContributions(type, baseConfig, extensionContext, workspace?.configuration)
    || baseConfig
    || configs.customer;
}

export {
  accessPresetForRole,
  buildModalConfig,
  NEW_PRODUCT_BRAND_VALUE,
  userAccessAreas,
};
