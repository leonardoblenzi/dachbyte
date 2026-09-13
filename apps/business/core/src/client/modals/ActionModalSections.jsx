import React from "react";
import { Plus, X } from "lucide-react";
import { formatCurrency, parseMoney } from "../core/formatters";
import {
  DUE_DATE_SALE_PAYMENTS,
  INSTALLMENT_SALE_PAYMENTS,
  SALE_PAYMENT_METHODS,
} from "../core/sales";

function optionValue(option) {
  return typeof option === "object" ? option.value : option;
}

function optionLabel(option) {
  return typeof option === "object" ? option.label : option;
}

function normalizeLookupText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function ActionModalField({ field, modalType, values, onValueChange, onAccessChange, onLookup, AccessMatrixComponent }) {
  const FieldWrapper = ["access_matrix", "checkbox_group", "segmented", "nature_summary"].includes(field.type) ? "div" : "label";
  const listId = "modal-options-" + modalType + "-" + field.name;
  const [lookupQuery, setLookupQuery] = React.useState(values[field.name] || "");
  const [lookupOpen, setLookupOpen] = React.useState(false);
  const [remoteLookupOptions, setRemoteLookupOptions] = React.useState([]);
  const [lookupLoading, setLookupLoading] = React.useState(false);
  const [lookupError, setLookupError] = React.useState("");
  const lookupRequest = React.useRef(0);
  const productLookupOptions = field.type === "product_lookup"
    ? (field.options || []).filter((option) => normalizeLookupText([
      option.name,
      option.sku,
      option.ean,
      option.category,
      option.brand,
    ].join(" ")).includes(normalizeLookupText(lookupQuery))).slice(0, 8)
    : [];
  const lookupOptions = field.type === "customer_lookup"
    ? remoteLookupOptions
    : remoteLookupOptions.length ? remoteLookupOptions : productLookupOptions;

  React.useEffect(() => {
    if (["product_lookup", "customer_lookup"].includes(field.type)) setLookupQuery(values[field.name] || "");
  }, [field.name, field.type, values]);

  React.useEffect(() => {
    if (!["product_lookup", "customer_lookup"].includes(field.type) || !onLookup) return undefined;
    const requestId = lookupRequest.current + 1;
    lookupRequest.current = requestId;
    const timer = window.setTimeout(async () => {
      setLookupLoading(true);
      setLookupError("");
      try {
        const options = await onLookup(field.resource || (field.type === "product_lookup" ? "products" : "customers"), {
          page: 1,
          pageSize: 20,
          search: lookupQuery.trim(),
        });
        if (lookupRequest.current === requestId) {
          setRemoteLookupOptions((options || []).map((option) => (
            field.type === "product_lookup"
              ? { ...option, value: option.id || option.value, min: option.min ?? "-", stock: option.stock ?? "-" }
              : option
          )));
        }
      } catch (_error) {
        if (lookupRequest.current === requestId) {
          setRemoteLookupOptions([]);
          setLookupError(`Falha ao buscar ${field.type === "product_lookup" ? "produtos" : "clientes"}. Digite novamente para tentar de novo.`);
        }
      } finally {
        if (lookupRequest.current === requestId) setLookupLoading(false);
      }
    }, lookupQuery.trim() ? 240 : 0);
    return () => window.clearTimeout(timer);
  }, [field.resource, field.type, lookupQuery, onLookup]);

  return (
    <FieldWrapper className={"field-label " + (field.wide ? "field-label--wide" : "")}>
      {field.label}
      {field.type === "nature_summary" ? (
        <div className="nature-summary">
          <div>
            <strong>{values.type === "Servico" ? "Servico sem estoque" : "Produto com estoque"}</strong>
            <small>{values.type === "Servico" ? "Pode ser vendido, mas nao gera movimentacao de estoque." : "Controla saldo, estoque minimo e baixa automatica na venda."}</small>
          </div>
          <button
            className="button-link"
            type="button"
            onClick={() => {
              const nextType = values.type === "Servico" ? "Produto" : "Servico";
              const message = nextType === "Servico"
                ? "Converter este item em servico? O controle e a baixa de estoque serao desativados."
                : "Converter este servico em produto? Sera necessario informar e controlar o estoque do item.";
              if (window.confirm(message)) onValueChange("type", nextType);
            }}
          >
            {values.type === "Servico" ? "Converter em produto" : "Converter em servico"}
          </button>
        </div>
      ) : field.type === "segmented" ? (
        <div className="segmented" role="group" aria-label={field.label}>
          {(field.options || []).map((option) => {
            const value = optionValue(option);
            const label = optionLabel(option);
            const active = values[field.name] === value;
            return (
              <button
                className={"segmented__item " + (active ? "segmented__item--active" : "")}
                type="button"
                key={value}
                onClick={() => onValueChange(field.name, value)}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : field.type === "select" ? (
        <select
          className="input"
          value={values[field.name] || ""}
          onChange={(event) => onValueChange(field.name, event.target.value)}
        >
          {field.placeholder ? <option value="" disabled>{field.placeholder}</option> : null}
          {(field.options || []).map((option) => {
            const value = optionValue(option);
            const label = optionLabel(option);
            return <option key={value} value={value}>{label}</option>;
          })}
        </select>
      ) : field.type === "search" ? (
        <>
          <input
            className="input"
            type="search"
            list={listId}
            autoComplete="off"
            value={values[field.name] || ""}
            placeholder={"Digite para buscar " + field.label.toLowerCase()}
            onChange={(event) => onValueChange(field.name, event.target.value)}
          />
          <datalist id={listId}>
            {(field.options || []).map((option) => <option key={option} value={option} />)}
          </datalist>
        </>
      ) : field.type === "product_lookup" ? (
        <div
          className="modal-lookup"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setLookupOpen(false);
          }}
        >
          <input
            className="input"
            type="search"
            autoComplete="off"
            value={lookupQuery}
            placeholder="Buscar por nome, SKU, EAN, marca ou categoria"
            aria-expanded={lookupOpen && Boolean(lookupQuery.trim())}
            onFocus={() => setLookupOpen(true)}
            onChange={(event) => {
              setLookupQuery(event.target.value);
              setLookupOpen(true);
              onValueChange(field.name, event.target.value);
              if (field.idField) onValueChange(field.idField, "");
            }}
          />
          {lookupOpen && lookupQuery.trim() ? (
            <div className="modal-lookup__results">
              {lookupOptions.map((option) => (
                <button
                  className={"modal-lookup__result " + (values[field.idField] === option.value ? "is-selected" : "")}
                  key={option.value}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setLookupQuery(option.name);
                    setLookupOpen(false);
                    onValueChange(field.name, option.name);
                    if (field.idField) onValueChange(field.idField, option.value || option.id);
                  }}
                >
                  <span>
                    <strong>{option.name}</strong>
                    <small>{[option.sku || "sem SKU", option.ean || "sem EAN", option.category || "produto"].join(" - ")}</small>
                  </span>
                  <span>
                    <strong>{option.stock}</strong>
                    <small>min. {option.min}</small>
                  </span>
                </button>
              ))}
              {lookupLoading ? <span className="modal-lookup__empty">Buscando produtos...</span> : null}
              {!lookupLoading && lookupError ? <span className="modal-lookup__empty">{lookupError}</span> : null}
              {!lookupLoading && !lookupError && !lookupOptions.length ? <span className="modal-lookup__empty">Nenhum produto encontrado.</span> : null}
            </div>
          ) : null}
        </div>
      ) : field.type === "customer_lookup" ? (
        <div
          className="modal-lookup"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setLookupOpen(false);
          }}
        >
          <input
            className="input"
            type="search"
            autoComplete="off"
            value={lookupQuery}
            placeholder="Buscar por nome, CPF/CNPJ, telefone ou e-mail"
            aria-expanded={lookupOpen}
            onFocus={() => setLookupOpen(true)}
            onChange={(event) => {
              setLookupQuery(event.target.value);
              setLookupOpen(true);
              onValueChange(field.name, event.target.value);
              if (field.idField) onValueChange(field.idField, "");
            }}
          />
          {lookupOpen ? (
            <div className="modal-lookup__results">
              {lookupOptions.map((option) => (
                <button
                  className={"modal-lookup__result " + (values[field.idField] === option.id ? "is-selected" : "")}
                  key={option.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setLookupQuery(option.name);
                    setLookupOpen(false);
                    onValueChange(field.name, option.name);
                    if (field.idField) onValueChange(field.idField, option.id);
                  }}
                >
                  <span>
                    <strong>{option.name}</strong>
                    <small>{[option.document, option.phone, option.email].filter(Boolean).join(" - ") || "Cliente sem contato informado"}</small>
                  </span>
                </button>
              ))}
              {lookupLoading ? <span className="modal-lookup__empty">Buscando clientes...</span> : null}
              {!lookupLoading && lookupError ? <span className="modal-lookup__empty">{lookupError}</span> : null}
              {!lookupLoading && !lookupError && !lookupOptions.length ? <span className="modal-lookup__empty">Nenhum cliente encontrado.</span> : null}
            </div>
          ) : null}
        </div>
      ) : field.type === "checkbox_group" ? (
        <div className="toggle-list">
          {(field.options || []).map((option) => {
            const value = optionValue(option);
            const label = optionLabel(option);
            const selected = Array.isArray(values[field.name]) ? values[field.name].includes(value) : false;
            return (
              <label className="access-check" key={value}>
                <input
                  type="checkbox"
                  checked={selected}
                  disabled={Boolean(option?.disabled)}
                  onChange={(event) => {
                    const current = new Set(Array.isArray(values[field.name]) ? values[field.name] : []);
                    if (event.target.checked) current.add(value);
                    else current.delete(value);
                    onValueChange(field.name, [...current]);
                  }}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
      ) : field.type === "access_matrix" ? (
        <AccessMatrixComponent
          enabledScreens={field.companyScreens?.[values.companyId] || field.enabledScreens}
          screens={values.screens}
          permissions={values.permissions}
          onChange={onAccessChange}
        />
      ) : field.type === "textarea" ? (
        <textarea
          className="input input--textarea"
          value={values[field.name] || ""}
          placeholder={field.label}
          onChange={(event) => onValueChange(field.name, event.target.value)}
        />
      ) : (
        <input
          className="input"
          inputMode={field.inputMode}
          min={field.min}
          max={field.max}
          step={field.step}
          type={field.type || "text"}
          value={values[field.name] ?? ""}
          placeholder={field.label}
          onInput={field.type === "date" ? (event) => onValueChange(field.name, event.currentTarget.value) : undefined}
          onChange={field.type === "date" ? undefined : (event) => onValueChange(field.name, event.target.value)}
        />
      )}
    </FieldWrapper>
  );
}

function ActionModalFields({ modalType, fields, values, saleCartItems, onValueChange, onAccessChange, onLookup, AccessMatrixComponent }) {
  return (
    <div className="form-grid">
      {fields.map((field) => {
        if (modalType === "sale" && saleCartItems.length && ["product", "quantity"].includes(field.name)) {
          return null;
        }
        return (
          <ActionModalField
            AccessMatrixComponent={AccessMatrixComponent}
            field={field}
            key={field.name}
            modalType={modalType}
            onAccessChange={onAccessChange}
            onLookup={onLookup}
            onValueChange={onValueChange}
            values={values}
          />
        );
      })}
    </div>
  );
}

function SaleCartSummary({ items }) {
  if (!items.length) return null;
  return (
    <section className="sale-cart-summary">
      <div className="sale-payments__header">
        <div>
          <strong>Itens da venda</strong>
          <span>Resumo vindo do carrinho do PDV.</span>
        </div>
      </div>
      <div className="sale-cart-summary__list">
        {items.map((item) => (
          <div className="sale-line" key={item.product.sku || item.product.name}>
            <span>
              <strong>{item.product.name}</strong>
              <small>Qtd. {String(item.quantity)}</small>
            </span>
            <em>{formatCurrency(parseMoney(item.product.price) * item.quantity)}</em>
          </div>
        ))}
      </div>
    </section>
  );
}

function SalePaymentCard({ payment, index, canRemove, onPaymentChange, onPaymentRemove }) {
  return (
    <div className="sale-payment-card">
      <div className="sale-payment-card__top">
        <strong>Pagamento {index + 1}</strong>
        {canRemove ? (
          <button className="icon-button" type="button" aria-label="Remover pagamento" onClick={() => onPaymentRemove(index)}>
            <X size={16} />
          </button>
        ) : null}
      </div>
      <div className="sale-payment-grid">
        <label className="field-label">
          Forma
          <select className="input" value={payment.method} onChange={(event) => onPaymentChange(index, "method", event.target.value)}>
            {SALE_PAYMENT_METHODS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Valor
          <input className="input" inputMode="decimal" value={payment.amount} onChange={(event) => onPaymentChange(index, "amount", event.target.value)} />
        </label>

        {INSTALLMENT_SALE_PAYMENTS.has(payment.method) ? (
          <label className="field-label">
            Parcelas
            <input className="input" type="number" min="1" max="24" value={payment.installments} onChange={(event) => onPaymentChange(index, "installments", event.target.value)} />
          </label>
        ) : null}
        {DUE_DATE_SALE_PAYMENTS.has(payment.method) ? (
          <label className="field-label">
            Primeiro vencimento
            <input className="input" type="date" value={payment.dueDate} onChange={(event) => onPaymentChange(index, "dueDate", event.target.value)} />
            <small className="field-hint">
              {payment.dueDateAuto ? "Sugestao automatica de 30 dias." : "Data informada conforme acordo com o cliente."}
            </small>
          </label>
        ) : null}

        {payment.method === "credit_card" ? (
          <>
            <label className="field-label">
              Bandeira
              <select className="input" value={payment.cardBrand} onChange={(event) => onPaymentChange(index, "cardBrand", event.target.value)}>
                <option value="">Selecione</option>
                <option value="visa">Visa</option>
                <option value="mastercard">Mastercard</option>
                <option value="elo">Elo</option>
                <option value="amex">American Express</option>
                <option value="hipercard">Hipercard</option>
                <option value="other">Outra</option>
              </select>
            </label>
            <label className="field-label">
              Autorizacao
              <input className="input" value={payment.authorizationCode} placeholder="Codigo da operadora" onChange={(event) => onPaymentChange(index, "authorizationCode", event.target.value)} />
            </label>
          </>
        ) : null}

        {payment.method === "check" ? (
          <>
            <label className="field-label">
              Banco
              <input className="input" value={payment.bank} onChange={(event) => onPaymentChange(index, "bank", event.target.value)} />
            </label>
            <label className="field-label">
              Numero do cheque
              <input className="input" value={payment.checkNumber} onChange={(event) => onPaymentChange(index, "checkNumber", event.target.value)} />
            </label>
            <label className="field-label">
              Titular
              <input className="input" value={payment.holderName} onChange={(event) => onPaymentChange(index, "holderName", event.target.value)} />
            </label>
            <label className="field-label">
              CPF/CNPJ do titular
              <input className="input" value={payment.holderDocument} onChange={(event) => onPaymentChange(index, "holderDocument", event.target.value)} />
            </label>
          </>
        ) : null}
      </div>
    </div>
  );
}

function SalePaymentsSection({ payments, onPaymentAdd, onPaymentChange, onPaymentRemove }) {
  return (
    <section className="sale-payments">
      <div className="sale-payments__header">
        <div>
          <strong>Formas de pagamento</strong>
          <span>Combine entrada, cartao, crediario ou cheque.</span>
        </div>
        <button className="button-secondary" type="button" onClick={onPaymentAdd}>
          <Plus size={17} />
          Adicionar forma
        </button>
      </div>

      <div className="sale-payment-list">
        {payments.map((payment, index) => (
          <SalePaymentCard
            canRemove={payments.length > 1}
            index={index}
            key={index}
            onPaymentChange={onPaymentChange}
            onPaymentRemove={onPaymentRemove}
            payment={payment}
          />
        ))}
      </div>
    </section>
  );
}

function SaleTotalSummary({ saleTotal, paymentTotal, paymentRemaining }) {
  if (saleTotal <= 0) return null;
  return (
    <div className="sale-total-summary">
      <div>
        <span>Total da venda</span>
        <strong>{formatCurrency(saleTotal)}</strong>
      </div>
      <div>
        <span>Total informado</span>
        <strong>{formatCurrency(paymentTotal)}</strong>
      </div>
      <div className={Math.abs(paymentRemaining) < 0.01 ? "is-balanced" : "is-pending"}>
        <span>{paymentRemaining >= 0 ? "Restante" : "Excedente"}</span>
        <strong>{formatCurrency(Math.abs(paymentRemaining))}</strong>
      </div>
    </div>
  );
}

export {
  ActionModalFields,
  SaleCartSummary,
  SalePaymentsSection,
  SaleTotalSummary,
};
