import { apiFetch } from "../../core/api";
import { parseCsvText } from "../../core/csv";
import { formatCurrency, parseMoney } from "../../core/formatters";
import { splitAccessList } from "../../core/access";
import { updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath } from "../utils";
import { buildExtensionPayloads, normalizeExtensionProductImportValues } from "../../extensions/registry";

export function createAdminSubmitHandlers(context) {
  const {
    appData,
    runtimeMode,
    selectedCompanyId,
    setSelectedCompanyId,
    isMasterUser,
    isMasterContext,
    databaseAvailable,
    notify,
    refreshRuntimeWorkspace,
    refreshMasterData,
    setAppData,
    workspace,
  } = context;

  return {
    async companyModules(values) {
      if (!isMasterUser || !selectedCompanyId) throw new Error("Somente o master pode alterar os modulos da empresa.");
      const selected = new Set(Array.isArray(values.modules) ? values.modules : []);
      for (const required of Array.isArray(values.requiredModules) ? values.requiredModules : []) selected.add(required);
      const base = new Set(Array.isArray(values.baseModules) ? values.baseModules : []);
      const enabledModules = [...selected].filter((key) => !base.has(key));
      const disabledModules = [...base].filter((key) => !selected.has(key));
      const limits = { ...(values.currentLimits || {}) };
      limits.users = values.maxUsers === "" || values.maxUsers === null || values.maxUsers === undefined
        ? null
        : Math.max(1, Math.trunc(Number(values.maxUsers)));
      await apiFetch(buildCompanyPath(selectedCompanyId, "/configuration/overrides"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledModules, disabledModules, limits }),
      });
      await refreshRuntimeWorkspace();
      notify("Modulos da empresa atualizados.");
    },

    async companyScreens(values) {
      if (!isMasterUser || !selectedCompanyId) throw new Error("Somente o master pode alterar as telas da empresa.");
      const selected = new Set(Array.isArray(values.screens) ? values.screens : []);
      const base = new Set(Array.isArray(values.baseScreens) ? values.baseScreens : []);
      const enabledScreens = [...selected].filter((key) => !base.has(key));
      const disabledScreens = [...base].filter((key) => !selected.has(key));
      await apiFetch(buildCompanyPath(selectedCompanyId, "/configuration/overrides"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabledScreens, disabledScreens }),
      });
      await refreshRuntimeWorkspace();
      notify("Telas da empresa atualizadas.");
    },

    async commercialProduct(values) {
      if (!selectedCompanyId) throw new Error("Selecione uma empresa.");
      const productKey = values.productKey;
      if (!productKey) throw new Error("Produto comercial nao informado.");
      const masterMode = isMasterUser || values.masterMode === true;
      const url = masterMode
        ? buildCompanyPath(selectedCompanyId, `/commercial/products/${encodeURIComponent(productKey)}`)
        : buildCompanyPath(selectedCompanyId, `/commercial/products/${encodeURIComponent(productKey)}/request`);
      await apiFetch(url, {
        method: masterMode ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planKey: values.planKey || null,
          ...(masterMode ? { status: values.status || "contracted" } : {}),
        }),
      });
      await refreshRuntimeWorkspace();
      notify(masterMode ? "Produto Volt atualizado." : "Solicitacao enviada para ativacao.");
    },

    async user(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const targetCompanyId = values.companyId || selectedCompanyId;
      const newUser = {
        name: values.name,
        role: values.role || "Operador",
        permissions: splitAccessList(values.permissions),
        screens: splitAccessList(values.screens),
        lastAccess: "Convite enviado",
        status: "Ativo",
      };
      if (runtimeMode === "database" || (isMasterUser && databaseAvailable)) {
        if (!targetCompanyId) throw new Error("Selecione a empresa do usuario.");
        const url = isEditing
          ? buildCompanyPath(targetCompanyId, `/users/${editKey}`)
          : buildCompanyPath(targetCompanyId, "/users");
        const userPayload = {
          ...values,
          permissions: splitAccessList(values.permissions),
          screens: splitAccessList(values.screens),
        };
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(userPayload),
        });
        if (isMasterContext) await refreshMasterData();
        else await refreshRuntimeWorkspace();
        notify(isEditing ? "Usuario atualizado." : "Usuario criado.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, users: isEditing ? updateByKey(current.users, editKey, newUser) : [newUser, ...current.users] },
        isEditing ? "Usuario editado" : "Usuario criado",
        `${newUser.name} - ${newUser.role}`,
      ));
      notify(isEditing ? "Usuario atualizado." : "Usuario criado.");
    },

    async company(values) {
      const isEditing = values.mode === "edit";
      const company = {
        name: values.name,
        segment: values.segment || "Core",
        plan: values.plan || "Starter",
        modules: values.modules || "8",
        status: isEditing ? values.status || "Ativo" : "Pendente",
      };
      if (runtimeMode === "database" || (isMasterUser && databaseAvailable)) {
        if (isEditing && values.recordId) {
          await apiFetch(buildCompanyPath(values.recordId, "/settings"), {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ companyName: values.name }),
          });
          await apiFetch(buildCompanyPath(values.recordId, "/apply-segment"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              segmentKey: values.segment === "Otica" ? "optical" : "general",
              planKey: String(values.plan || "starter").toLowerCase(),
              name: values.name,
            }),
          });
        } else {
          const payload = await apiFetch("/core/runtime/companies", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": window.crypto?.randomUUID?.() || `core-company-${Date.now()}`,
            },
            body: JSON.stringify(values),
          });
          if (!isMasterContext && payload.configuration?.companyId) setSelectedCompanyId(payload.configuration.companyId);
        }
        if (isMasterContext) await refreshMasterData();
        notify(isEditing ? "Empresa atualizada." : "Empresa criada.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, masterCompanies: isEditing ? updateByKey(current.masterCompanies, values.editKey, company) : [company, ...current.masterCompanies] },
        isEditing ? "Empresa editada" : "Empresa criada",
        `${company.name} - ${company.plan}`,
      ));
      notify(isEditing ? "Empresa atualizada." : "Empresa criada.");
    },

    async customField(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const field = {
        name: values.name,
        module: values.module || "Clientes",
        type: values.fieldType || "Texto",
        options: String(values.options || "").split(",").map((item) => item.trim()).filter(Boolean),
        required: values.required || "Nao",
        placeholder: values.placeholder || "",
        helpText: values.helpText || "",
        min: values.min === "" ? null : values.min,
        max: values.max === "" ? null : values.max,
        step: values.step === "" ? null : values.step,
        order: Number(values.order || 0),
      };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/configuration/customFields"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...field, id: isEditing ? editKey : undefined }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Campo personalizado atualizado." : "Campo personalizado salvo.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, customFields: isEditing ? updateByKey(current.customFields, editKey, field) : [field, ...current.customFields] },
        isEditing ? "Campo personalizado editado" : "Campo personalizado criado",
        `${field.module} - ${field.name}`,
      ));
      notify(isEditing ? "Campo personalizado atualizado." : "Campo personalizado salvo.");
    },

    async workflow(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      let transitions = {};
      try {
        transitions = values.transitions ? JSON.parse(values.transitions) : {};
      } catch (_error) {
        throw new Error("Transicoes devem estar em JSON valido.");
      }
      const workflow = {
        key: values.key,
        name: values.name,
        initial: values.initial,
        states: String(values.states || "").split(",").map((item) => item.trim()).filter(Boolean),
        transitions,
      };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/configuration/workflows"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...workflow, id: isEditing ? editKey : undefined }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Workflow atualizado." : "Workflow salvo.");
        return;
      }
      setAppData((current) => ({
        ...current,
        workflows: isEditing ? updateByKey(current.workflows || [], editKey, workflow) : [workflow, ...(current.workflows || [])],
      }));
      notify(isEditing ? "Workflow atualizado." : "Workflow salvo.");
    },

    async modulePlan(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const plan = {
        name: values.name,
        modules: values.modules || "8",
        price: values.price || "Sob consulta",
        status: "Ativo",
      };
      if (runtimeMode === "database") {
        await apiFetch(buildCompanyPath(selectedCompanyId, "/configuration/modulePlans"), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...plan, id: isEditing ? editKey : undefined }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Plano atualizado." : "Plano salvo.");
        return;
      }
      setAppData((current) => addAuditEvent(
        { ...current, modulePlans: isEditing ? updateByKey(current.modulePlans, editKey, plan) : [plan, ...current.modulePlans] },
        isEditing ? "Plano editado" : "Plano criado",
        `${plan.name} - ${plan.price}`,
      ));
      notify(isEditing ? "Plano atualizado." : "Plano salvo.");
    },

    async importData(values) {
      const rows = parseCsvText(values.csv);
      if (!rows.length) throw new Error("CSV sem registros validos.");
      const entity = values.entity || "customers";

      if (runtimeMode === "database") {
        for (const row of rows) {
          if (entity === "products") {
            const rowType = String(row.type || row.tipo || "").toLowerCase();
            const rowSku = row.sku || "";
            const rowEan = row.ean || row.barcode || row.codigo_barras || "";
            const existingProduct = (appData.products || []).find((product) => {
              const sameSku = rowSku && String(product.sku || "").toLowerCase() === String(rowSku).toLowerCase();
              const sameEan = rowEan && String(product.ean || "").replace(/\D/g, "") === String(rowEan).replace(/\D/g, "");
              return sameSku || sameEan;
            });
            const extensionValues = normalizeExtensionProductImportValues(row, workspace?.configuration || {});
            const extensions = await buildExtensionPayloads("product", { ...row, ...extensionValues }, workspace?.configuration || {});
            await apiFetch(existingProduct?.id ? buildCompanyPath(selectedCompanyId, `/products/${existingProduct.id}`) : buildCompanyPath(selectedCompanyId, "/products"), {
              method: existingProduct?.id ? "PATCH" : "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: row.name || row.nome,
                sku: rowSku,
                ean: rowEan,
                category: row.category || row.categoria || "Produto",
                brand: row.brand || row.marca,
                type: rowType.includes("serv") ? "service" : "product",
                salePrice: parseMoney(row.price || row.preco),
                costPrice: parseMoney(row.cost || row.custo),
                minimumStock: Number(row.min || row.estoque_minimo || row.minimumStock || 0),
                initialStock: Number(row.stock || row.estoque || 0),
                ...(extensions ? { extensions } : {}),
              }),
            });
          } else {
            const rowDocument = row.document || row.documento || "";
            const existingCustomer = (appData.customers || []).find((customer) => rowDocument && String(customer.document || "").replace(/\D/g, "") === String(rowDocument).replace(/\D/g, ""));
            await apiFetch(existingCustomer?.id ? buildCompanyPath(selectedCompanyId, `/customers/${existingCustomer.id}`) : buildCompanyPath(selectedCompanyId, "/customers"), {
              method: existingCustomer?.id ? "PATCH" : "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: row.name || row.nome,
                document: rowDocument,
                phone: row.phone || row.telefone,
                email: row.email,
                customFields: { segment: row.segment || row.segmento || "Importado" },
              }),
            });
          }
        }
        await refreshRuntimeWorkspace();
        notify(`${rows.length} registro${rows.length === 1 ? "" : "s"} importado${rows.length === 1 ? "" : "s"}.`);
        return;
      }

      setAppData((current) => addAuditEvent(
        {
          ...current,
          [entity]: mergeImportedRows(current[entity] || [], rows, entity),
        },
        "Importacao CSV",
        `${rows.length} registros em ${entity}`,
      ));
      notify(`${rows.length} registro${rows.length === 1 ? "" : "s"} importado${rows.length === 1 ? "" : "s"} no modo local.`);
    },
  };
}

function mergeImportedRows(existingRows, rows, entity) {
  const imported = rows.map((row, index) => entity === "products" ? mapImportedProduct(row, index) : mapImportedCustomer(row));
  const nextRows = [...existingRows];

  imported.forEach((record) => {
    const existingIndex = nextRows.findIndex((item) => entity === "products"
      ? (record.sku && item.sku === record.sku) || (record.ean && item.ean === record.ean)
      : (record.document && record.document !== "-" && String(item.document || "").replace(/\D/g, "") === String(record.document).replace(/\D/g, "")));
    if (existingIndex >= 0) {
      nextRows[existingIndex] = { ...nextRows[existingIndex], ...record };
    } else {
      nextRows.unshift(record);
    }
  });

  return nextRows;
}

function mapImportedProduct(row, index) {
  const type = /serv/i.test(row.type || row.tipo || "") ? "Servico" : "Produto";
  return {
    sku: row.sku || `IMP-${Date.now().toString().slice(-5)}-${index + 1}`,
    name: row.name || row.nome,
    ean: row.ean || row.barcode || row.codigo_barras || "",
    category: row.category || row.categoria || "Produto",
    brand: row.brand || row.marca || "",
    type,
    stock: type === "Servico" ? "-" : Number(row.stock || row.estoque || 0),
    min: type === "Servico" ? "-" : Number(row.min || row.estoque_minimo || 0),
    cost: formatCurrency(parseMoney(row.cost || row.custo)),
    price: formatCurrency(parseMoney(row.price || row.preco)),
    status: type === "Servico" ? "Servico" : "Ok",
  };
}

function mapImportedCustomer(row) {
  return {
    name: row.name || row.nome,
    document: row.document || row.documento || "-",
    phone: row.phone || row.telefone || "",
    email: row.email || "",
    segment: row.segment || row.segmento || "Importado",
    notes: row.notes || row.observacoes || "",
    lastBuy: "Sem compras",
    balance: "R$ 0,00",
    status: row.status || "Ativo",
  };
}
