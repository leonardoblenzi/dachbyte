import React, { useEffect, useRef, useState } from "react";
import { OpticalSalesPdvView } from "./OpticalSalesPdvView";
import {
  clearOpticalSaleDraft,
  opticalSaleDraftKey,
  readOpticalSaleDraft,
  writeOpticalSaleDraft,
} from "./opticalSaleDraftStorage";
import {
  addOpticalSaleItem,
  addOpticalSalePayment,
  buildOpticalSaleSubmitPayload,
  createEmptyOpticalSaleDraft,
  deriveOpticalSaleState,
  OPTICAL_SALE_CATEGORIES,
  prepareOpticalSalePayments,
  removeOpticalSaleItem,
  removeOpticalSalePayment,
  setOpticalSaleField,
  setOpticalSaleNestedField,
  updateOpticalSaleItemPrice,
  updateOpticalSaleItemQuantity,
  updateOpticalSalePayment,
  validateOpticalSale,
} from "./opticalSaleState";

export default function OpticalSalesPdv({ data, onSubmit, onAction, runtimeData }) {
  const draftScope = runtimeData?.draftScope || {};
  const storage = typeof window === "undefined" ? null : window.sessionStorage;
  const scopeKey = opticalSaleDraftKey(draftScope);
  const restoreDraft = (scope) => {
    const stored = readOpticalSaleDraft(storage, scope);
    const empty = createEmptyOpticalSaleDraft();
    if (!stored) return empty;
    return {
      ...empty,
      ...stored,
      cart: Array.isArray(stored.cart) ? stored.cart : empty.cart,
      payments: Array.isArray(stored.payments) && stored.payments.length ? stored.payments : empty.payments,
      prescription: stored.prescription && typeof stored.prescription === "object" ? stored.prescription : empty.prescription,
    };
  };
  const [draft, setDraft] = useState(() => restoreDraft(draftScope));
  const activeScopeKeyRef = useRef(scopeKey);
  const skipNextPersistRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [saleFilter, setSaleFilter] = useState("Todos");
  const [productQuery, setProductQuery] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [error, setError] = useState("");
  const loadResource = runtimeData?.loadResource;

  useEffect(() => {
    if (activeScopeKeyRef.current !== scopeKey) return;
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    writeOpticalSaleDraft(storage, draftScope, draft);
  }, [draft, draftScope.companyId, draftScope.operatorId, scopeKey, storage]);

  useEffect(() => {
    if (activeScopeKeyRef.current === scopeKey) return;
    activeScopeKeyRef.current = scopeKey;
    setDraft(restoreDraft(draftScope));
    setProductQuery("");
    setCustomerQuery("");
    setReviewing(false);
    setError("");
  }, [draftScope.companyId, draftScope.operatorId, scopeKey]);

  useEffect(() => {
    if (!loadResource) return undefined;
    const timer = window.setTimeout(() => {
      void loadResource("products", { page: 1, pageSize: 20, search: productQuery, filter: saleFilter }, { silent: true });
    }, productQuery.trim() ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [productQuery, saleFilter, loadResource]);

  useEffect(() => {
    if (!loadResource) return undefined;
    const timer = window.setTimeout(() => {
      void loadResource("customers", { page: 1, pageSize: 20, search: customerQuery }, { silent: true });
    }, customerQuery.trim() ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [customerQuery, loadResource]);

  useEffect(() => {
    if (!loadResource || !draft.customerId) return undefined;
    void loadResource("prescriptions", { page: 1, pageSize: 50, customerId: draft.customerId }, { silent: true });
    return undefined;
  }, [draft.customerId, loadResource]);

  const derived = deriveOpticalSaleState({ data, draft, productQuery, saleFilter });
  const { cartItemCount, change, customer, customers, discount, isPaymentOnDelivery, needsCustomerForOptical, optical, paymentTotal, prescriptions, remaining, selectedProduct, subtotal, total, visibleProducts } = derived;
  const setField = (name, value) => setDraft((current) => setOpticalSaleField(current, name, value));
  const setNested = (group, name, value) => setDraft((current) => setOpticalSaleNestedField(current, group, name, value));
  const addItem = () => { const product = selectedProduct || (productQuery.trim() ? visibleProducts[0] : null); if (!product) return; setDraft((current) => addOpticalSaleItem(current, product)); setProductQuery(""); };
  const selectProduct = (product) => { setField("productId", product?.id || ""); setProductQuery(product ? product.name : ""); };
  const changeProductQuery = (value) => { setProductQuery(value); setField("productId", ""); };
  const selectCustomer = (nextCustomer) => { setDraft((current) => ({ ...current, customerId: nextCustomer?.id || "", prescriptionId: "" })); setCustomerQuery(nextCustomer ? nextCustomer.name : ""); };
  const changeCustomerQuery = (value) => { setCustomerQuery(value); setDraft((current) => ({ ...current, customerId: "", prescriptionId: "" })); };
  const quantity = (id, delta) => setDraft((current) => updateOpticalSaleItemQuantity(current, id, delta));
  const changeItemPrice = (id, value) => setDraft((current) => updateOpticalSaleItemPrice(current, id, value));
  const remove = (id) => setDraft((current) => removeOpticalSaleItem(current, id));
  const addPayment = () => setDraft((current) => addOpticalSalePayment(current, remaining));
  const updatePayment = (index, name, value) => setDraft((current) => updateOpticalSalePayment(current, index, name, value));
  const removePayment = (index) => setDraft((current) => removeOpticalSalePayment(current, index));

  function resetDraft() {
    clearOpticalSaleDraft(storage, draftScope);
    skipNextPersistRef.current = true;
    setDraft(createEmptyOpticalSaleDraft());
    setProductQuery("");
    setCustomerQuery("");
    setReviewing(false);
    setError("");
  }

  function clearDraft() {
    if (!window.confirm("Limpar todos os dados desta venda?")) return;
    resetDraft();
  }

  function openReview() {
    setError("");
    const validationError = validateOpticalSale({ draft, customer, optical, paymentTotal, total, remaining, change, mode: "review" });
    if (validationError) return setError(validationError);
    setReviewing(true);
  }

  async function finish() {
    setError("");
    const validationError = validateOpticalSale({ draft, customer, optical, paymentTotal, total, remaining, change, mode: "finish" });
    if (validationError) return setError(validationError);
    const payments = prepareOpticalSalePayments(draft, change);
    setSaving(true);
    try {
      await onSubmit("sale", buildOpticalSaleSubmitPayload({ draft, customer, discount, optical, payments }));
      resetDraft();
    } catch (submitError) { setError(submitError?.message || "Nao foi possivel concluir a venda."); }
    finally { setSaving(false); }
  }

  return <OpticalSalesPdvView
    canClearDraft={Boolean(draft.customerId || draft.productId || draft.cart.length || draft.notes || draft.promisedDate)}
    cartItemCount={cartItemCount} change={change} customer={customer} customers={customers} customerQuery={customerQuery}
    data={data} draft={draft} error={error} isOptical={optical} isPaymentOnDelivery={isPaymentOnDelivery} needsCustomerForOptical={needsCustomerForOptical}
    paymentTotal={paymentTotal} productQuery={productQuery} remaining={remaining} reviewing={reviewing}
    saleCategories={OPTICAL_SALE_CATEGORIES} saleFilter={saleFilter} saving={saving} selectedProduct={selectedProduct}
    subtotal={subtotal} total={total} visibleProducts={visibleProducts} prescriptions={prescriptions} onAction={onAction}
    onAddItem={addItem} onAddPayment={addPayment} onCustomerQueryChange={changeCustomerQuery} onCustomerSelect={selectCustomer}
    onClearDraft={clearDraft} onFieldChange={setField} onFinish={finish} onNestedChange={setNested} onOpenReview={openReview} onPaymentChange={updatePayment}
    onPaymentRemove={removePayment} onProductQueryChange={changeProductQuery} onProductSelect={selectProduct} onItemPriceChange={changeItemPrice}
    onQuantityChange={quantity} onRemoveItem={remove} onReviewClose={() => setReviewing(false)}
    onSaleFilterChange={(category) => { setSaleFilter(category); setField("productId", ""); }}
  />;
}
