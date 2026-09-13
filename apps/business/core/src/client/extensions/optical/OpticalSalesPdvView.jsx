import React from "react";
import {
  AlertTriangle,
  Boxes,
  Building2,
  CheckCircle2,
  CreditCard,
  FileText,
  Glasses,
  Plus,
  Search,
  ShoppingCart,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import { formatCurrency, formatMoneyInput, formatShortDate, parseMoney } from "../../core/formatters";
import {
  DUE_DATE_SALE_PAYMENTS,
  INSTALLMENT_SALE_PAYMENTS,
  paymentMethodLabel,
  SALE_PAYMENT_METHODS,
} from "../../core/sales";

function ModeLabel(mode) {
  return ({ now: "preencher agora", existing: "usar cadastro anterior", later: "receber depois", na: "nao precisa" })[mode] || "pendente";
}

function hasCustomerDueDate(payment) {
  return DUE_DATE_SALE_PAYMENTS.has(payment?.method);
}

function SectionTitle({ icon: Icon, title, description }) {
  return (
    <div className="section-title">
      <span className="card-icon"><Icon size={20} /></span>
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
  );
}

function SummaryLine({ label, value }) {
  return (
    <div className="summary-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function EmptyContent({ icon: Icon, title, description }) {
  return (
    <div className="empty-state compact">
      <Icon size={26} />
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function normalizeLookup(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function opticalProductData(product = {}) {
  return product.extensions?.["vertical.optical"] || {};
}

function productLookupText(product) {
  return normalizeLookup(`${product.name} ${product.sku} ${product.ean} ${product.category} ${product.brand} ${product.type} ${opticalProductData(product).opticalType || ""}`);
}

function customerLookupText(customer) {
  return normalizeLookup(`${customer.name} ${customer.document} ${customer.phone} ${customer.email} ${customer.segment} ${customer.status}`);
}

function ProductResultMeta({ item }) {
  return (
    <small>
      {[item.sku || "sem SKU", item.ean || "sem EAN", item.category || item.type || "catalogo"].join(" - ")}
    </small>
  );
}

function formatPrescriptionSummary(item) {
  const right = [item.rightSpherical, item.rightCylindrical, item.rightAxis].filter((value) => value !== undefined && value !== null && value !== "").join("/");
  const left = [item.leftSpherical, item.leftCylindrical, item.leftAxis].filter((value) => value !== undefined && value !== null && value !== "").join("/");
  if (!right && !left) return "";
  return `OD ${right || "-"} | OE ${left || "-"}`;
}

function OptionalSaleSection({ icon: Icon, title, mode, onMode, allowExisting, children }) {
  const laterLabel = title === "Receita" ? "Receber depois" : title === "Medidas" ? "Medir depois" : "Definir depois";
  const naLabel = title === "Receita" ? "Venda sem receita" : "Nao precisa";
  return (
    <section className="panel optical-sale-section">
      <div className="optional-section-head">
        <SectionTitle icon={Icon} title={title} />
        <div className="optional-mode">
          <button type="button" className={mode === "now" ? "active" : ""} onClick={() => onMode("now")}>Preencher agora</button>
          {allowExisting ? <button type="button" className={mode === "existing" ? "active" : ""} onClick={() => onMode("existing")}>Usar receita anterior</button> : null}
          <button type="button" className={mode === "later" ? "active" : ""} onClick={() => onMode("later")}>{laterLabel}</button>
          <button type="button" className={mode === "na" ? "active" : ""} onClick={() => onMode("na")}>{naLabel}</button>
        </div>
      </div>
      {["later", "na"].includes(mode) ? (
        <div className="optional-state">
          <CheckCircle2 size={18} />
          <span>{mode === "later" ? "Sera criada uma pendencia no pedido." : "Esta etapa nao sera usada."}</span>
        </div>
      ) : children}
    </section>
  );
}

function InlinePrescription({ values, onChange }) {
  const clinicalFields = [
    ["doctor", "Medico"],
    ["doctorCrm", "CRM"],
    ["doctorUf", "UF"],
  ];
  const dateFields = [
    ["examDate", "Data do exame", "date"],
    ["validUntil", "Validade da receita", "date"],
  ];
  const prescriptionZones = [
    {
      label: "Longe",
      rows: [
        { eye: "OD", prefix: "right", dnp: "rightDnp" },
        { eye: "OE", prefix: "left", dnp: "leftDnp" },
      ],
    },
    {
      label: "Perto",
      rows: [
        { eye: "OD", prefix: "nearRight" },
        { eye: "OE", prefix: "nearLeft" },
      ],
    },
  ];
  const prescriptionColumns = [
    ["Spherical", "Esferico", "0.25"],
    ["Cylindrical", "Cilindrico", "0.25"],
    ["Axis", "Eixo", "1"],
  ];
  const addition = values.addition || values.rightAddition || values.leftAddition || "";
  return (
    <div className="optical-step-content">
      <div className="optical-fields-grid">
        {clinicalFields.map(([name, label]) => (
          <label className="field" key={name}>
            <span>{label}</span>
            <input value={values[name] || ""} onChange={(event) => onChange(name, event.target.value)} />
          </label>
        ))}
        {dateFields.map(([name, label, type]) => (
          <label className="field" key={name}>
            <span>{label}</span>
            <input type={type} value={values[name] || ""} onChange={(event) => onChange(name, event.target.value)} />
          </label>
        ))}
      </div>
      <div className="prescription-clinical-grid" role="table" aria-label="Dados da receita optica">
        <div className="prescription-clinical-grid__header" role="row">
          <span aria-hidden="true" /><span>Olho</span>
          {prescriptionColumns.map(([, label]) => <span key={label}>{label}</span>)}
          <span>D.P.</span>
        </div>
        {prescriptionZones.map((zone) => (
          <div className="prescription-clinical-grid__zone" key={zone.label}>
            <strong className="prescription-clinical-grid__zone-label">{zone.label}</strong>
            <div className="prescription-clinical-grid__zone-body">
              {zone.rows.map((row) => (
                <div className="prescription-clinical-grid__row" role="row" key={`${zone.label}-${row.eye}`}>
                  <strong>{row.eye}</strong>
                  {prescriptionColumns.map(([suffix, label, step]) => {
                    const name = `${row.prefix}${suffix}`;
                    return <input
                      aria-label={`${label} ${zone.label} ${row.eye}`}
                      key={name}
                      type="number"
                      min={suffix === "Axis" ? "0" : undefined}
                      max={suffix === "Axis" ? "180" : undefined}
                      step={step}
                      value={values[name] || ""}
                      onChange={(event) => onChange(name, event.target.value)}
                    />;
                  })}
                  {row.dnp ? <input
                    aria-label={`D.P. ${zone.label} ${row.eye}`}
                    type="number"
                    min="0"
                    step="0.5"
                    value={values[row.dnp] || ""}
                    onChange={(event) => onChange(row.dnp, event.target.value)}
                  /> : <span className="prescription-clinical-grid__empty">-</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <label className="field prescription-addition">
        <span>Adicao (ADD)</span>
        <input type="number" step="0.25" value={addition} onChange={(event) => onChange("addition", event.target.value)} />
        <small className="field-hint">Valor unico aplicado a OD e OE.</small>
      </label>
      <label className="field field-wide">
        <span>Observacoes tecnicas</span>
        <textarea className="input input--textarea" value={values.notes || ""} onChange={(event) => onChange("notes", event.target.value)} />
      </label>
    </div>
  );
}

function OpticalSaleCatalog({
  canClearDraft,
  cart,
  productQuery,
  saleCategories,
  saleFilter,
  selectedProduct,
  visibleProducts,
  onAddItem,
  onClearDraft,
  onProductQueryChange,
  onProductSelect,
  onItemPriceChange,
  onQuantityChange,
  onRemoveItem,
  onSaleFilterChange,
}) {
  const visibleResults = !selectedProduct && productQuery.trim() ? visibleProducts.slice(0, 8) : [];
  const hiddenResultCount = selectedProduct ? 0 : Math.max(0, visibleProducts.length - visibleResults.length);
  const canAddFromSearch = Boolean(selectedProduct || visibleResults.length);
  return (
    <section className="panel optical-sale-section optical-sale-section--primary">
      <div className="optical-sale-heading">
        <SectionTitle
          icon={ShoppingCart}
          title="Montar venda"
          description="Adicione itens primeiro. As etapas opticas aparecem somente quando a venda precisar."
        />
        {canClearDraft ? <button className="button-link" type="button" onClick={onClearDraft}>Limpar venda</button> : null}
      </div>
      <div className="sale-category-filter">
        {saleCategories.map((category) => (
          <button type="button" className={saleFilter === category ? "active" : ""} key={category} onClick={() => onSaleFilterChange(category)}>
            {category}
          </button>
        ))}
      </div>
      <div className="optical-product-adder optical-product-adder--search">
        <label className="lookup-field">
          <Search size={18} />
          <input
            aria-label="Buscar produto ou servico"
            value={productQuery}
            placeholder="Buscar por nome, SKU, EAN, categoria ou marca"
            onChange={(event) => onProductQueryChange(event.target.value)}
          />
        </label>
        <button className="button-primary" type="button" disabled={!canAddFromSearch} onClick={onAddItem}>
          <Plus size={17} />
          Adicionar
        </button>
      </div>
      <div className="lookup-results" aria-label="Resultados da busca de produtos">
        {selectedProduct ? (
          <div className="lookup-selected">
            <span>Item selecionado</span>
            <strong>{selectedProduct.name}</strong>
            <small>{selectedProduct.price} - {selectedProduct.sku || selectedProduct.ean || selectedProduct.category || "item do catalogo"}</small>
            <button type="button" onClick={() => onProductSelect(null)}>Trocar produto</button>
          </div>
        ) : null}
        {visibleResults.map((item) => (
          <button className="lookup-result" type="button" key={item.id} onClick={() => onProductSelect(item)}>
            <div>
              <strong>{item.name}</strong>
              <ProductResultMeta item={item} />
            </div>
            <span>{item.price}</span>
          </button>
        ))}
        {productQuery.trim() && !selectedProduct && !visibleResults.length ? (
          <div className="lookup-empty">Nenhum item encontrado. Refine a busca ou cadastre um novo item.</div>
        ) : null}
        {productQuery.trim() && !selectedProduct && visibleResults.length ? (
          <div className="lookup-hint lookup-hint--action">Clique em um resultado ou use Adicionar para inserir o primeiro item listado.</div>
        ) : null}
        {hiddenResultCount > 0 ? (
          <div className="lookup-hint">Mais {hiddenResultCount} {hiddenResultCount === 1 ? "resultado" : "resultados"}. Digite mais detalhes para refinar.</div>
        ) : null}
      </div>
      <div className="optical-cart">
        {cart.map((item) => {
          const unitPrice = parseMoney(item.unitPrice ?? item.price);
          const originalUnitPrice = parseMoney(item.originalUnitPrice ?? item.price);
          const priceAdjusted = Math.abs(unitPrice - originalUnitPrice) > 0.01;
          return (
            <div className="optical-cart__item" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <small>
                  {item.type === "Servico"
                    ? "Servico - nao mexe no estoque"
                    : opticalProductData(item).opticalType === "lens" && item.type === "Servico"
                      ? "Lente encomendada"
                      : `${item.sku} - baixa ${item.quantity} do estoque`}
                </small>
                {priceAdjusted ? <span className="cart-price-adjusted">Preco ajustado na venda</span> : null}
              </div>
              <div className="quantity-control">
                <button type="button" onClick={() => onQuantityChange(item.id, -1)}>-</button>
                <span>{item.quantity}</span>
                <button type="button" onClick={() => onQuantityChange(item.id, 1)}>+</button>
              </div>
              <label className="cart-price-field">
                <span>Preco unit.</span>
                <input
                  inputMode="decimal"
                  value={item.unitPrice ?? item.price}
                  onChange={(event) => onItemPriceChange(item.id, event.target.value)}
                />
              </label>
              <strong>{formatCurrency(unitPrice * item.quantity)}</strong>
              <button className="icon-button" type="button" aria-label="Remover item" onClick={() => onRemoveItem(item.id)}>
                <X size={16} />
              </button>
            </div>
          );
        })}
        {!cart.length ? (
          <EmptyContent icon={ShoppingCart} title="Venda vazia" description="Busque um item e clique em adicionar para iniciar." />
        ) : null}
      </div>
    </section>
  );
}

function OpticalSaleCustomer({ customer, customerQuery, customers, needsCustomerForOptical, onAction, onCustomerQueryChange, onCustomerSelect }) {
  const normalizedQuery = normalizeLookup(customerQuery);
  const visibleCustomers = !customer && normalizedQuery
    ? customers.filter((item) => customerLookupText(item).includes(normalizedQuery)).slice(0, 8)
    : [];
  const hiddenCustomerCount = customer ? 0 : Math.max(0, normalizedQuery ? customers.filter((item) => customerLookupText(item).includes(normalizedQuery)).length - visibleCustomers.length : 0);
  return (
    <section className="panel optical-sale-section">
      <SectionTitle
        icon={UsersRound}
        title="Cliente"
      />
      <div className="field">
          <div className="field-with-action">
            <label className="lookup-field">
              <Search size={18} />
              <input
                aria-label="Buscar cliente"
                value={customerQuery}
                placeholder="Buscar por nome, CPF/CNPJ, telefone ou e-mail"
                onChange={(event) => onCustomerQueryChange(event.target.value)}
              />
            </label>
            <button className="button-secondary" type="button" onClick={() => onAction("customer")}>
              <Plus size={16} />
              Novo
            </button>
          </div>
          <div className="lookup-results lookup-results--customer" aria-label="Resultados da busca de clientes">
            {customer ? (
              <div className="lookup-selected">
                <span>Cliente da venda</span>
                <strong>{customer.name}</strong>
                <small>{[customer.document, customer.phone, customer.email, customer.segment].filter(Boolean).join(" - ") || "cadastro selecionado"}</small>
                <button type="button" onClick={() => onCustomerSelect(null)}>Trocar cliente</button>
              </div>
            ) : (
              <div className="lookup-selected lookup-selected--muted">
                <span>Venda sem cliente identificado</span>
                <strong>Cliente avulso</strong>
                <small>Permitido para venda simples. Pedido optico exige cliente.</small>
              </div>
            )}
            {visibleCustomers.map((item) => (
              <button className="lookup-result" type="button" key={item.id || item.document || item.name} onClick={() => onCustomerSelect(item)}>
                <div>
                  <strong>{item.name}</strong>
                  <small>{[item.document, item.phone, item.email].filter(Boolean).join(" - ") || item.segment || "cliente"}</small>
                </div>
                <span>{item.status || "Ativo"}</span>
              </button>
            ))}
            {normalizedQuery && !customer && !visibleCustomers.length ? (
              <div className="lookup-empty">Nenhum cliente encontrado. Cadastre um novo ou continue como avulso.</div>
            ) : null}
            {hiddenCustomerCount > 0 ? (
              <div className="lookup-hint">Mais {hiddenCustomerCount} cliente(s). Digite mais detalhes para refinar.</div>
            ) : null}
          </div>
      </div>
      {needsCustomerForOptical ? (
        <div className="inline-alert inline-alert--soft">
          <AlertTriangle size={18} />
          <span>Venda optica precisa de cliente para gerar acompanhamento.</span>
        </div>
      ) : null}
    </section>
  );
}

function OpticalSalePendingSteps({ data, draft, isOptical, prescriptions, onFieldChange, onNestedChange }) {
  if (!isOptical) return null;
  return (
    <section className="optical-pending-grid" aria-label="Etapas opticas">
      <OptionalSaleSection icon={Glasses} title="Receita" mode={draft.prescriptionMode} onMode={(value) => onFieldChange("prescriptionMode", value)} allowExisting>
        {draft.prescriptionMode === "existing" ? (
          <label className="field">
            <span>Receita cadastrada</span>
            <select value={draft.prescriptionId} onChange={(event) => onFieldChange("prescriptionId", event.target.value)}>
              <option value="">Selecione</option>
              {prescriptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {[item.validUntil ? `Val. ${formatShortDate(item.validUntil)}` : "Sem validade", item.doctor || "Sem medico", formatPrescriptionSummary(item)].filter(Boolean).join(" - ")}
                </option>
              ))}
            </select>
            {!prescriptions.length ? <small className="field-hint">Este cliente ainda nao tem receita cadastrada. Use "Preencher agora" ou "Receber depois".</small> : null}
          </label>
        ) : null}
        {draft.prescriptionMode === "now" ? <InlinePrescription values={draft.prescription} onChange={(name, value) => onNestedChange("prescription", name, value)} /> : null}
      </OptionalSaleSection>
      <OptionalSaleSection icon={Building2} title="Laboratorio" mode={draft.laboratoryMode} onMode={(value) => onFieldChange("laboratoryMode", value)}>
        {draft.laboratoryMode === "now" ? (
          <label className="field" aria-label="Laboratorio">
            <select value={draft.laboratoryId} onChange={(event) => onFieldChange("laboratoryId", event.target.value)}>
              <option value="">A definir</option>
              {(data.opticalLaboratories || []).map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        ) : null}
      </OptionalSaleSection>
    </section>
  );
}

function OpticalSaleCheckout({
  cartItemCount,
  change,
  discount,
  discountType,
  discountTotal,
  draft,
  error,
  isOptical,
  isPaymentOnDelivery,
  paymentTotal,
  remaining,
  saving,
  subtotal,
  total,
  onAddPayment,
  onFieldChange,
  onOpenReview,
  onPaymentChange,
  onPaymentRemove,
}) {
  return (
    <aside className="panel optical-sale-summary">
      <div className="checkout-summary-head">
        <h3>Resumo da venda</h3>
        <span>{cartItemCount} {cartItemCount === 1 ? "item" : "itens"}</span>
      </div>
      <SummaryLine label="Subtotal" value={formatCurrency(subtotal)} />
      <div className="discount-control">
        <div className="discount-control__head">
          <span>Desconto</span>
          <div className="segmented" aria-label="Tipo de desconto">
            <button
              className={`segmented__item ${discountType !== "percent" ? "segmented__item--active" : ""}`}
              type="button"
              onClick={() => onFieldChange("discountType", "amount")}
            >
              R$
            </button>
            <button
              className={`segmented__item ${discountType === "percent" ? "segmented__item--active" : ""}`}
              type="button"
              onClick={() => onFieldChange("discountType", "percent")}
            >
              %
            </button>
          </div>
        </div>
        <input
          inputMode="decimal"
          value={discount}
          placeholder={discountType === "percent" ? "0%" : "R$ 0,00"}
          onChange={(event) => onFieldChange("discount", event.target.value)}
        />
        {discountTotal > 0 ? <small>Aplicado: {formatCurrency(discountTotal)}</small> : null}
      </div>
      <div className="checkout-total">
        <span>Total</span>
        <strong>{formatCurrency(total)}</strong>
      </div>
      <div className="summary-divider" />
      <div className="payment-timing" aria-label="Quando o pagamento sera informado">
        <button className={isPaymentOnDelivery ? "" : "active"} type="button" onClick={() => onFieldChange("paymentTiming", "immediate")}>Pagar agora</button>
        <button className={isPaymentOnDelivery ? "active" : ""} type="button" onClick={() => onFieldChange("paymentTiming", "delivery")}>Pagar na entrega</button>
      </div>
      {isPaymentOnDelivery ? (
        <>
          <div className="delivery-payment-notice">
            <strong>{formatCurrency(total)} a receber</strong>
            <span>O pagamento sera informado na retirada.</span>
          </div>
          <label className="field delivery-date-field">
            <span>Previsao de entrega *</span>
            <input
              required
              type="date"
              value={draft.promisedDate}
              onChange={(event) => onFieldChange("promisedDate", event.target.value)}
            />
          </label>
        </>
      ) : <>
      <div className="payment-heading">
        <h4>Formas de pagamento</h4>
        <button className="button-link" type="button" onClick={onAddPayment}>
          <Plus size={14} />
          Adicionar forma
        </button>
      </div>
      <div className="mixed-payments">
        {draft.payments.map((payment, index) => (
          <div className="mixed-payment" key={`${index}-${payment.method}`}>
            <div className="mixed-payment__head">
              <strong>Pagamento {index + 1}</strong>
              {draft.payments.length > 1 ? (
                <button className="icon-button" type="button" onClick={() => onPaymentRemove(index)}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
            <label className="field">
              <span>Forma</span>
              <select value={payment.method} onChange={(event) => onPaymentChange(index, "method", event.target.value)}>
                {SALE_PAYMENT_METHODS.map((item) => (
                  <option key={item.value} value={item.value}>{item.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Valor</span>
              <input inputMode="decimal" value={payment.amount} placeholder="Digite o valor" onChange={(event) => onPaymentChange(index, "amount", event.target.value)} />
              {!payment.amount && remaining > 0.01 ? <small className="field-hint">Restante sugerido: {formatMoneyInput(remaining || total)}</small> : null}
            </label>
            {INSTALLMENT_SALE_PAYMENTS.has(payment.method) ? (
              <label className="field">
                <span>Parcelas</span>
                <input type="number" min="1" value={payment.installments} onChange={(event) => onPaymentChange(index, "installments", event.target.value)} />
              </label>
            ) : null}
            {DUE_DATE_SALE_PAYMENTS.has(payment.method) ? (
              <label className="field">
                <span>Primeiro vencimento</span>
                <input type="date" value={payment.dueDate} onChange={(event) => onPaymentChange(index, "dueDate", event.target.value)} />
                <small className="field-hint">
                  {payment.dueDateAuto ? "Sugestao automatica de 30 dias." : "Data informada conforme acordo com o cliente."}
                </small>
              </label>
            ) : null}
          </div>
        ))}
      </div>
      <div className={`payment-balance ${Math.abs(remaining) < 0.01 ? "complete" : ""}`}>
        <span>Total informado</span>
        <strong>{formatCurrency(paymentTotal)}</strong>
        <span>{remaining > 0.01 ? "Falta informar" : remaining < -0.01 ? "Excedente" : "Tudo certo"}</span>
        <strong>{formatCurrency(remaining)}</strong>
        {change > 0 ? (
          <>
            <span>Troco</span>
            <strong>{formatCurrency(change)}</strong>
          </>
        ) : null}
      </div>
      </>}
      {isOptical ? (
        <div className="pending-summary">
          <strong>Situacao optica</strong>
          <span>Receita: {ModeLabel(draft.prescriptionMode)}</span>
          <span>Laboratorio: {ModeLabel(draft.laboratoryMode)}</span>
        </div>
      ) : null}
      {error ? (
        <div className="inline-alert" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
        </div>
      ) : null}
      <button className="button-primary button-full" type="button" disabled={saving || !draft.cart.length} onClick={onOpenReview}>
        <CheckCircle2 size={18} />
        Revisar e confirmar
      </button>
    </aside>
  );
}

function OpticalSaleReview({ cart, draft, error, isOptical, isPaymentOnDelivery, payments, saving, total, onClose, onFinish }) {
  const pendingOpticalSteps = [draft.prescriptionMode, draft.laboratoryMode].filter((mode) => mode === "later").length;
  return (
    <div className="sale-review-backdrop">
      <section className="sale-review">
        <header>
          <div>
            <h2>{isPaymentOnDelivery ? "Criar pedido" : "Confirmar venda"}</h2>
            <p>Confira o que o sistema fara antes de concluir.</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="sale-review__items">
          <div><ShoppingCart size={18} /><span>Registrar {cart.length} {cart.length === 1 ? "item" : "itens"} por {formatCurrency(total)}</span></div>
          {cart.filter((item) => item.type !== "Servico").map((item) => (
            <div key={item.id}><Boxes size={18} /><span>Baixar {item.quantity} unidade(s) de {item.name}</span></div>
          ))}
          {cart.filter((item) => item.type === "Servico").map((item) => (
            <div key={item.id}><Wrench size={18} /><span>Adicionar o servico {item.name}, sem mexer no estoque</span></div>
          ))}
          {isOptical ? (
            <div>
              <Glasses size={18} />
              <span>{pendingOpticalSteps ? "Criar pedido optico e OS com acompanhamento das pendencias" : "Criar pedido optico e OS sem pendencias iniciais"}</span>
            </div>
          ) : null}
          {isPaymentOnDelivery ? <div><CreditCard size={18} /><span>Pagamento sera definido na retirada.</span></div> : <><div><CreditCard size={18} /><span>Registrar pagamentos detalhados</span></div>
          {payments.map((payment, index) => (
            <div key={`${payment.method}-${index}`}>
              <CreditCard size={18} />
              <span>
                {paymentMethodLabel(payment.method)} - {formatCurrency(payment.amount || 0)}
                {payment.installments && Number(payment.installments) > 1 ? ` - ${payment.installments} parcelas` : ""}
                {hasCustomerDueDate(payment) && payment.dueDate ? ` - venc. ${payment.dueDate}` : ""}
              </span>
            </div>
          ))}</>}
        </div>
        <div className="sale-review__total"><span>Total da venda</span><strong>{formatCurrency(total)}</strong></div>
        {error ? <div className="inline-alert"><AlertTriangle size={18} /><span>{error}</span></div> : null}
        <footer>
          <button className="button-secondary" type="button" onClick={onClose}>Voltar e revisar</button>
          <button className="button-primary" type="button" disabled={saving} onClick={onFinish}>{saving ? "Salvando..." : isPaymentOnDelivery ? "Criar pedido" : "Confirmar venda"}</button>
        </footer>
      </section>
    </div>
  );
}

function OpticalSalesPdvView({
  canClearDraft,
  cartItemCount,
  change,
  customers,
  customer,
  customerQuery,
  data,
  discount,
  draft,
  error,
  isOptical,
  isPaymentOnDelivery,
  needsCustomerForOptical,
  paymentTotal,
  productQuery,
  remaining,
  reviewing,
  saleCategories,
  saleFilter,
  saving,
  selectedProduct,
  subtotal,
  total,
  visibleProducts,
  prescriptions,
  onAction,
  onAddItem,
  onAddPayment,
  onClearDraft,
  onCustomerQueryChange,
  onCustomerSelect,
  onFieldChange,
  onFinish,
  onNestedChange,
  onOpenReview,
  onPaymentChange,
  onPaymentRemove,
  onProductQueryChange,
  onProductSelect,
  onItemPriceChange,
  onQuantityChange,
  onRemoveItem,
  onReviewClose,
  onSaleFilterChange,
}) {
  return (
    <div className="optical-sale-sheet">
      <div className="optical-sale-sheet__content">
        <OpticalSaleCatalog
          canClearDraft={canClearDraft}
          cart={draft.cart}
          productQuery={productQuery}
          saleCategories={saleCategories}
          saleFilter={saleFilter}
          selectedProduct={selectedProduct}
          visibleProducts={visibleProducts}
          onAddItem={onAddItem}
          onClearDraft={onClearDraft}
          onProductQueryChange={onProductQueryChange}
          onProductSelect={onProductSelect}
          onItemPriceChange={onItemPriceChange}
          onQuantityChange={onQuantityChange}
          onRemoveItem={onRemoveItem}
          onSaleFilterChange={onSaleFilterChange}
        />

        <OpticalSaleCustomer
          customer={customer}
          customerQuery={customerQuery}
          customers={customers}
          needsCustomerForOptical={needsCustomerForOptical}
          onAction={onAction}
          onCustomerQueryChange={onCustomerQueryChange}
          onCustomerSelect={onCustomerSelect}
        />

        <OpticalSalePendingSteps
          data={data}
          draft={draft}
          isOptical={isOptical}
          prescriptions={prescriptions}
          onFieldChange={onFieldChange}
          onNestedChange={onNestedChange}
        />

        <section className="panel optical-sale-section">
          <SectionTitle icon={FileText} title="Observacoes" description="Informacoes para producao, entrega ou atendimento." />
          <label className="field field--with-hint">
            <span>Data/hora da venda</span>
            <input
              type="datetime-local"
              value={draft.soldAt}
              onInput={(event) => onFieldChange("soldAt", event.currentTarget.value)}
              onChange={(event) => onFieldChange("soldAt", event.currentTarget.value)}
            />
            <small className="field-hint">Deixe em branco para registrar como agora.</small>
          </label>
          <textarea className="input input--textarea" value={draft.notes} onChange={(event) => onFieldChange("notes", event.target.value)} />
        </section>
      </div>

      <OpticalSaleCheckout
        cartItemCount={cartItemCount}
        change={change}
        discount={draft.discount}
        discountType={draft.discountType}
        discountTotal={discount}
        draft={draft}
        error={error}
        isOptical={isOptical}
        isPaymentOnDelivery={isPaymentOnDelivery}
        paymentTotal={paymentTotal}
        remaining={remaining}
        saving={saving}
        subtotal={subtotal}
        total={total}
        onAddPayment={onAddPayment}
        onFieldChange={onFieldChange}
        onOpenReview={onOpenReview}
        onPaymentChange={onPaymentChange}
        onPaymentRemove={onPaymentRemove}
      />

      {reviewing ? (
        <OpticalSaleReview
          cart={draft.cart}
          draft={draft}
          error={error}
          isOptical={isOptical}
          isPaymentOnDelivery={isPaymentOnDelivery}
          isPaymentOnDelivery={isPaymentOnDelivery}
          payments={draft.payments}
          saving={saving}
          total={total}
          onClose={onReviewClose}
          onFinish={onFinish}
        />
      ) : null}
    </div>
  );
}

export { OpticalSalesPdvView };
