import { apiFetch } from "../../core/api";
import { formatCurrency, parseMoney } from "../../core/formatters";
import { paymentMethodLabel } from "../../core/sales";
import { productStatus, recordKey, updateByKey } from "../../core/records";
import { addAuditEvent, buildCompanyPath, makeSaleId } from "../utils";
import { buildExtensionPayloads } from "../../extensions/registry";
import { SALE_MUTATION_REFRESH_RESOURCES, STOCK_MUTATION_REFRESH_RESOURCES } from "../../runtime/runtimeListState.mjs";

function collectDynamicCustomFields(values = {}) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([key]) => key.startsWith("custom__"))
      .map(([key, value]) => [key.slice("custom__".length), value]),
  );
}

export function createCatalogSubmitHandlers(context) {
  const {
    appData,
    runtimeMode,
    selectedCompanyId,
    notify,
    refreshRuntimeWorkspace,
    setAppData,
    newProductBrandValue,
    workspace,
  } = context;

  return {
    async customer(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const customer = {
        name: values.name.trim(),
        document: values.document || "-",
        segment: values.segment || "Varejo",
        lastBuy: "Sem compras",
        balance: "R$ 0,00",
        status: "Ativo",
      };

      if (runtimeMode === "database") {
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/customers/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/customers");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: customer.name,
            document: customer.document,
            phone: values.phone,
            email: values.email,
            notes: values.notes,
            customFields: { segment: customer.segment, ...collectDynamicCustomFields(values) },
          }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Cliente atualizado." : "Cliente cadastrado.");
        return;
      }

      setAppData((current) => addAuditEvent(
        { ...current, customers: isEditing ? updateByKey(current.customers, editKey, customer) : [customer, ...current.customers] },
        isEditing ? "Cliente editado" : "Cliente cadastrado",
        `${customer.name} em ${customer.segment}`,
      ));
      notify(isEditing ? "Cliente atualizado." : "Cliente cadastrado.");
    },

    async productCategory(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const category = {
        id: values.recordId || editKey || ("cat-" + Date.now()),
        name: values.name.trim(),
        description: values.description || "",
        status: "Ativo",
        active: true,
      };

      if (runtimeMode === "database") {
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/product-categories/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/product-categories");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: category.name, description: category.description }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Categoria atualizada." : "Categoria cadastrada.");
        return;
      }

      setAppData((current) => addAuditEvent(
        {
          ...current,
          productCategories: isEditing
            ? updateByKey(current.productCategories, editKey, category)
            : [category, ...(current.productCategories || [])],
        },
        isEditing ? "Categoria editada" : "Categoria cadastrada",
        category.name,
      ));
      notify(isEditing ? "Categoria atualizada." : "Categoria cadastrada.");
    },

    async productBrand(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const brand = {
        id: values.recordId || editKey || ("brd-" + Date.now()),
        name: values.name.trim(),
        description: values.description || "",
        status: "Ativo",
        active: true,
      };

      if (runtimeMode === "database") {
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/product-brands/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/product-brands");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: brand.name, description: brand.description }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Marca atualizada." : "Marca cadastrada.");
        return;
      }

      setAppData((current) => addAuditEvent(
        {
          ...current,
          productBrands: isEditing
            ? updateByKey(current.productBrands || [], editKey, brand)
            : [brand, ...(current.productBrands || [])],
        },
        isEditing ? "Marca editada" : "Marca cadastrada",
        brand.name,
      ));
      notify(isEditing ? "Marca atualizada." : "Marca cadastrada.");
    },

    async product(values) {
      const isEditing = values.mode === "edit";
      const editKey = values.editKey;
      const isService = values.type === "Servico";
      const normalizedEan = isService ? "" : String(values.ean || "").replace(/\D/g, "");
      const selectedBrand = isService ? "" : values.brand || "";
      const newBrandName = String(values.newBrandName || "").trim();
      const brandName = selectedBrand === newProductBrandValue ? newBrandName : selectedBrand;
      const targetKey = values.recordId || editKey;
      const duplicateEan = normalizedEan
        ? appData.products.find((item) => {
          const sameRecord = recordKey(item) === targetKey || String(item.id || "") === String(targetKey || "");
          return !sameRecord && String(item.ean || "").replace(/\D/g, "") === normalizedEan;
        })
        : null;

      if (duplicateEan) {
        throw new Error("Este EAN ja esta cadastrado em outro produto desta empresa.");
      }
      if (!isService && selectedBrand === newProductBrandValue && !newBrandName) {
        throw new Error("Informe o nome da nova marca.");
      }

      const knownBrand = (appData.productBrands || []).find((brand) => brand.name.toLowerCase() === brandName.toLowerCase());
      const shouldCreateBrand = Boolean(!isService && selectedBrand === newProductBrandValue && brandName && !knownBrand);
      const extensionPayloads = await buildExtensionPayloads("product", values, workspace?.configuration || {});
      const product = {
        sku: values.sku.trim() || `SKU-${Date.now().toString().slice(-4)}`,
        ean: normalizedEan,
        name: values.name.trim(),
        category: values.category || (isService ? "Servicos" : "Produtos"),
        brand: isService ? "" : brandName,
        type: isService ? "Servico" : "Produto",
        stock: isService ? "-" : Number(values.stock || 0),
        min: isService ? "-" : Number(values.min || 0),
        cost: formatCurrency(parseMoney(values.cost)),
        price: formatCurrency(parseMoney(values.price)),
        status: isService ? "Servico" : "Ok",
        extensions: extensionPayloads || {},
        catalogType: Object.values(extensionPayloads || {}).find((payload) => payload?.catalogType)?.catalogType || "",
      };
      product.status = productStatus(product);

      if (runtimeMode === "database") {
        if (shouldCreateBrand) {
          await apiFetch(buildCompanyPath(selectedCompanyId, "/product-brands"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: brandName, description: values.newBrandDescription || "" }),
          });
        }
        const url = isEditing
          ? buildCompanyPath(selectedCompanyId, `/products/${editKey}`)
          : buildCompanyPath(selectedCompanyId, "/products");
        await apiFetch(url, {
          method: isEditing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sku: product.sku,
            ean: product.ean,
            name: product.name,
            category: product.category,
            brand: product.brand,
            type: isService ? "service" : "product",
            salePrice: parseMoney(values.price),
            costPrice: parseMoney(values.cost),
            minimumStock: isService ? 0 : Number(values.min || 0),
            trackStock: !isService,
            initialStock: isService ? 0 : Number(values.stock || 0),
            ...(extensionPayloads ? { extensions: extensionPayloads } : {}),
            customFields: collectDynamicCustomFields(values),
          }),
        });
        await refreshRuntimeWorkspace();
        notify(isEditing ? "Produto atualizado." : "Produto cadastrado.");
        return;
      }

      setAppData((current) => {
        const newBrand = shouldCreateBrand
          ? { id: "brd-" + Date.now(), name: brandName, description: values.newBrandDescription || "", status: "Ativo", active: true }
          : null;
        return addAuditEvent(
          {
            ...current,
            productBrands: newBrand ? [newBrand, ...(current.productBrands || [])] : current.productBrands,
            products: isEditing ? updateByKey(current.products, editKey, product) : [product, ...current.products],
          },
          isEditing ? "Produto editado" : "Produto cadastrado",
          `${product.sku} - ${product.name}`,
        );
      });
      notify(isEditing ? "Produto atualizado." : "Produto cadastrado.");
    },

    async movement(values) {
      const selectedStockProduct = appData.products.find((product) => (
        String(product.id || "") === String(values.productId || "")
        || product.name === values.product
        || product.sku === values.product
      ));
      const countedQuantity = Number(values.quantity || 0);
      const quantity = values.kind === "Ajuste" && selectedStockProduct
        ? countedQuantity - Number(selectedStockProduct.stock || 0)
        : countedQuantity;
      const sign = values.kind === "Saida" ? -1 : 1;
      const stockDelta = values.kind === "Ajuste" ? quantity : quantity * sign;
      const productName = values.product;
      const movement = {
        type: values.kind,
        product: productName,
        quantity: `${stockDelta >= 0 ? "+" : ""}${stockDelta}`,
        reason: values.reason || "Ajuste operacional",
        user: "Admin",
        date: "Agora",
      };

      if (runtimeMode === "database") {
        if (values.kind === "Ajuste" && Math.abs(quantity) < 0.001) {
          throw new Error("Saldo contado igual ao saldo atual. Nenhum ajuste necessario.");
        }
        const result = await apiFetch(buildCompanyPath(selectedCompanyId, "/inventory/movements"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: values.kind,
            productId: values.productId,
            product: productName,
            quantity,
            reason: values.reason,
            notes: values.notes,
          }),
        });
        await refreshRuntimeWorkspace({ resources: ["products", "inventoryMovements", "stockReservations"] });
        const registeredProduct = result?.movement?.productName || productName;
        const registeredQuantity = Number(result?.movement?.quantity ?? stockDelta);
        const quantityLabel = `${registeredQuantity >= 0 ? "+" : ""}${registeredQuantity}`;
        notify(`${values.kind} registrada: ${quantityLabel} em ${registeredProduct}.`);
        return;
      }

      setAppData((current) => ({
        ...current,
        movements: [movement, ...current.movements],
        products: current.products.map((product) => {
          if (product.name !== productName || (product.type === "Servico" || product.category === "Servico")) return product;
          const nextStock = Math.max(0, Number(product.stock || 0) + stockDelta);
          const next = { ...product, stock: nextStock };
          return { ...next, status: productStatus(next) };
        }),
      }));
      notify("Movimentacao registrada.");
    },

    async sale(values) {
      const rawItems = Array.isArray(values.items) && values.items.length
        ? values.items
        : [{ product: values.product, quantity: Number(values.quantity || 1) }];
      const saleItems = rawItems
        .map((item) => {
          const loadedProduct = appData.products.find((candidate) => candidate.id === item.productId || candidate.name === item.product);
          const quantity = Math.max(1, Number(item.quantity || 1));
          const product = loadedProduct || (item.productId ? {
            id: item.productId,
            name: item.product || "Produto",
            price: item.originalUnitPrice ?? item.unitPrice ?? 0,
            type: item.type || "Produto",
            category: item.category || "Produtos",
            sku: item.sku || "",
          } : null);
          if (!product) return null;
          const unitPrice = item.unitPrice === undefined ? parseMoney(product.price) : parseMoney(item.unitPrice);
          const originalUnitPrice = item.originalUnitPrice === undefined ? parseMoney(product.price) : parseMoney(item.originalUnitPrice);
          return {
            product,
            quantity,
            unitPrice,
            originalUnitPrice,
            priceAdjusted: Math.abs(unitPrice - originalUnitPrice) > 0.01,
            discount: Math.max(0, parseMoney(item.discount || 0)),
          };
        })
        .filter(Boolean);
      if (!saleItems.length) {
        throw new Error("Venda sem itens validos.");
      }
      const total = saleItems.reduce((sum, item) => sum + item.unitPrice * item.quantity - item.discount, 0);
      const sale = {
        id: makeSaleId(appData.sales.length),
        customer: values.customer || "Cliente avulso",
        items: saleItems.map((item) => `${item.quantity}x ${item.product.name}${item.priceAdjusted ? ` (${formatCurrency(item.unitPrice)})` : ""}`).join(", "),
        status: "Finalizada",
        total: formatCurrency(total),
        payment: (values.payments || []).map((payment) => paymentMethodLabel(payment.method)).join(" + ") || "Pix",
      };
      const saleMovements = saleItems
        .filter((item) => item.product.type !== "Servico" && item.product.category !== "Servico")
        .map((item) => ({
          type: "Saida",
          product: item.product.name,
          quantity: `-${item.quantity}`,
          reason: `Venda ${sale.id}`,
          user: "PDV",
          date: "Agora",
        }));

      if (runtimeMode === "database") {
        const saleResult = await apiFetch(buildCompanyPath(selectedCompanyId, "/sales"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: values.idempotencyKey,
            customer: values.customer,
            customerId: values.customerId || appData.customers.find((item) => item.name === values.customer)?.id,
            product: saleItems[0].product.name,
            quantity: saleItems[0].quantity,
            discountType: values.discountType || "amount",
            discountValue: values.discountValue ?? values.discount ?? "",
            items: saleItems.map((item) => ({
              productId: item.product.id,
              product: item.product.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              originalUnitPrice: item.originalUnitPrice,
              priceAdjusted: item.priceAdjusted,
              discount: item.discount,
            })),
            payments: values.payments,
            paymentTiming: values.paymentTiming || "immediate",
            promisedDeliveryDate: values.promisedDeliveryDate || null,
            soldAt: values.soldAt ? new Date(values.soldAt).toISOString() : null,
            notes: values.notes,
            customFields: collectDynamicCustomFields(values),
            ...(values.extensions && Object.keys(values.extensions).length ? { extensions: values.extensions } : {}),
          }),
        });
        const opticalSale = Boolean(values.extensions?.["vertical.optical"]);
        await refreshRuntimeWorkspace({
          resources: opticalSale ? ["serviceOrders", "opticalOrders"] : [],
        });
        notify(values.paymentTiming === "delivery"
          ? "Pedido criado. O pagamento sera informado na retirada."
          : "Venda finalizada, estoque e financeiro atualizados.");
        return {
          sale: saleResult.sale,
          receipt: saleResult.receipt || null,
          opticalOrder: saleResult.opticalOrder || null,
        };
      }

      setAppData((current) => ({
        ...current,
        sales: [sale, ...current.sales],
        movements: saleMovements.length ? [...saleMovements, ...current.movements] : current.movements,
        products: current.products.map((item) => {
          const saleItem = saleItems.find((candidate) => candidate.product.sku === item.sku);
          if (!saleItem || (item.type === "Servico" || item.category === "Servico")) return item;
          const nextStock = Math.max(0, Number(item.stock || 0) - saleItem.quantity);
          const next = { ...item, stock: nextStock };
          return { ...next, status: productStatus(next) };
        }),
      }));
      notify("Venda finalizada e estoque atualizado.");
      return { sale, receipt: null };
    },

    async saleEdit(values) {
      if (runtimeMode !== "database") {
        throw new Error("A edicao de vendas exige o banco de dados conectado.");
      }
      if (!values.saleId) throw new Error("Venda nao encontrada para edicao.");
      await apiFetch(buildCompanyPath(selectedCompanyId, `/sales/${values.saleId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: values.customerId || null,
          customer: values.customer || "Cliente avulso",
          soldAt: values.soldAt || null,
          notes: values.notes || null,
          payments: values.payments || [],
          customFields: collectDynamicCustomFields(values),
        }),
      });
      await refreshRuntimeWorkspace({ resources: SALE_MUTATION_REFRESH_RESOURCES });
      notify("Venda atualizada e recibo corrigido.");
    },

    async saleDelivery(values) {
      if (runtimeMode !== "database") {
        throw new Error("A conclusao da retirada exige o banco de dados conectado.");
      }
      if (!values.saleId) throw new Error("Pedido nao encontrado para concluir a retirada.");
      const result = await apiFetch(buildCompanyPath(selectedCompanyId, `/sales/${values.saleId}/complete-delivery`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payments: values.payments || [] }),
      });
      await refreshRuntimeWorkspace({ resources: [...SALE_MUTATION_REFRESH_RESOURCES, ...STOCK_MUTATION_REFRESH_RESOURCES] });
      notify("Retirada concluida. Financeiro, estoque e recibo atualizados.");
      return result;
    },
  };
}
