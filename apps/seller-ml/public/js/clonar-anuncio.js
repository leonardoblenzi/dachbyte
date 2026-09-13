"use strict";

(() => {
  const API_BASE = window.mlUrl
    ? window.mlUrl("/api/clonar-anuncio")
    : "/api/clonar-anuncio";

  const state = {
    currentDraft: null,
    drafts: [],
    activeSubtab: "editor",
    currentStep: 1,
    cloneMode: "unitario",
    variationEditorModel: [],
    publishProgressTimer: null,
    publishProgressValue: 0,
    captureImportInFlight: false,
    processedCaptureKeys: new Set(),
  };

  const PROGRESS_STAGES = [
    {
      min: 0,
      label: "Validando estrutura do anuncio...",
      hint: "Conferindo titulo, categoria e campos obrigatorios.",
    },
    {
      min: 34,
      label: "Enviando para criacao no Mercado Livre...",
      hint: "Aguardando resposta da API de publicacao.",
    },
    {
      min: 68,
      label: "Finalizando criacao do novo MLB...",
      hint: "Persistindo retorno e consolidando status do rascunho.",
    },
  ];

  const GTIN_EMPTY_TOKEN = "EMPTY_GTIN";
  const NON_ATTRIBUTE_VALIDATION_KEYS = new Set([
    "title",
    "family_name",
    "price",
    "available_quantity",
    "listing_type_id",
    "condition",
    "attributes",
    "variations",
    "pictures",
    "description",
    "sale_terms",
    "shipping",
    "category_id",
    "currency_id",
  ]);

  const el = {
    homeSection: document.getElementById("homeSection"),
    bookmarkletLink: document.getElementById("bookmarkletLink"),
    btnCopyBookmarklet: document.getElementById("btnCopyBookmarklet"),
    btnReloadDrafts: document.getElementById("btnReloadDrafts"),
    feedback: document.getElementById("feedback"),
    subtabButtons: Array.from(document.querySelectorAll("[data-clone-subtab]")),
    reviewSection: document.getElementById("reviewSection"),
    draftStatus: document.getElementById("draftStatus"),
    draftTitle: document.getElementById("draftTitle"),
    draftFamilyName: document.getElementById("draftFamilyName"),
    draftPrice: document.getElementById("draftPrice"),
    draftQty: document.getElementById("draftQty"),
    draftCategory: document.getElementById("draftCategory"),
    draftCategoryName: document.getElementById("draftCategoryName"),
    draftCategoryPath: document.getElementById("draftCategoryPath"),
    draftListingType: document.getElementById("draftListingType"),
    draftCondition: document.getElementById("draftCondition"),
    draftShippingMode: document.getElementById("draftShippingMode"),
    draftShippingModeHint: document.getElementById("draftShippingModeHint"),
    draftShippingFree: document.getElementById("draftShippingFree"),
    draftShippingFreeHint: document.getElementById("draftShippingFreeHint"),
    variationModeWrap: document.getElementById("variationModeWrap"),
    variationModeHelp: document.getElementById("variationModeHelp"),
    cloneModeUnitario: document.getElementById("cloneModeUnitario"),
    cloneModeVariacoes: document.getElementById("cloneModeVariacoes"),
    draftDescription: document.getElementById("draftDescription"),
    draftPictures: document.getElementById("draftPictures"),
    draftAttributesMain: document.getElementById("draftAttributesMain"),
    draftAttributesSecondary: document.getElementById("draftAttributesSecondary"),
    draftAttributesUnmatchedWrap: document.getElementById("draftAttributesUnmatchedWrap"),
    draftAttributesUnmatched: document.getElementById("draftAttributesUnmatched"),
    variationSection: document.getElementById("variationSection"),
    variationCountBadge: document.getElementById("variationCountBadge"),
    variationList: document.getElementById("variationList"),
    draftAttributes: document.getElementById("draftAttributes"),
    draftAttributesExtra: document.getElementById("draftAttributesExtra"),
    draftSaleTerms: document.getElementById("draftSaleTerms"),
    draftNotes: document.getElementById("draftNotes"),
    btnSaveReview: document.getElementById("btnSaveReview"),
    btnValidateDraft: document.getElementById("btnValidateDraft"),
    btnGoToPublish: document.getElementById("btnGoToPublish"),
    btnCancelClone: document.getElementById("btnCancelClone"),
    reviewValidationSummary: document.getElementById("reviewValidationSummary"),
    validationBox: document.getElementById("validationBox"),
    publishProgress: document.getElementById("publishProgress"),
    publishProgressBar: document.getElementById("publishProgressBar"),
    publishProgressLabel: document.getElementById("publishProgressLabel"),
    publishProgressPercent: document.getElementById("publishProgressPercent"),
    publishProgressHint: document.getElementById("publishProgressHint"),
    publishResult: document.getElementById("publishResult"),
    publishResultItemId: document.getElementById("publishResultItemId"),
    publishResultPermalink: document.getElementById("publishResultPermalink"),
    publishResultPublishedAt: document.getElementById("publishResultPublishedAt"),
    draftsSection: document.getElementById("draftsSection"),
    draftChecklist: document.getElementById("draftChecklist"),
    draftNotesList: document.getElementById("draftNotesList"),
    draftSummaryImage: document.getElementById("draftSummaryImage"),
    draftSummaryImageEmpty: document.getElementById("draftSummaryImageEmpty"),
    draftSummaryTitle: document.getElementById("draftSummaryTitle"),
    draftSummaryMeta: document.getElementById("draftSummaryMeta"),
    draftSummarySourceLink: document.getElementById("draftSummarySourceLink"),
    draftImageGrid: document.getElementById("draftImageGrid"),
    draftList: document.getElementById("draftList"),
  };

  function setBusy(button, busy, labelBusy = "Processando...") {
    if (!button) return;
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.textContent = labelBusy;
    } else {
      button.disabled = false;
      if (button.dataset.originalLabel) {
        button.textContent = button.dataset.originalLabel;
      }
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));
  }

  function setFeedback(message, level = "warn") {
    if (!el.feedback) return;
    el.feedback.className = "clone-feedback";
    if (level === "ok") el.feedback.classList.add("feedback-ok");
    if (level === "error") el.feedback.classList.add("feedback-error");
    if (level === "warn") el.feedback.classList.add("feedback-warn");
    el.feedback.textContent = message || "";
  }

  function clearInlineErrors() {
    document.querySelectorAll(".field-error-inline").forEach((node) => node.remove());
    document
      .querySelectorAll(".is-invalid")
      .forEach((node) => node.classList.remove("is-invalid"));
    document
      .querySelectorAll("[aria-invalid='true']")
      .forEach((node) => node.setAttribute("aria-invalid", "false"));
  }

  function setReviewValidationSummary(errors) {
    if (!el.reviewValidationSummary) return;
    const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
    if (!list.length) {
      el.reviewValidationSummary.classList.add("hidden");
      el.reviewValidationSummary.innerHTML = "";
      return;
    }

    const items = list
      .map((entry) => `<li>${escapeHtml(String(entry.message || "Campo invalido."))}</li>`)
      .join("");
    el.reviewValidationSummary.innerHTML = `
      <strong>Corrija os campos abaixo antes de avancar:</strong>
      <ul>${items}</ul>
    `;
    el.reviewValidationSummary.classList.remove("hidden");
  }

  function addInlineError(target, message) {
    const text = toText(message) || "Campo invalido.";
    if (!target) return;
    const container =
      target.closest("label, .attr-row, .variation-card, .variation-mode, .attr-section") ||
      target.parentElement ||
      target;
    container.classList.add("is-invalid");
    target.classList.add("is-invalid");
    target.setAttribute("aria-invalid", "true");

    const existing = container.querySelector(".field-error-inline");
    if (existing) {
      existing.textContent = text;
      return;
    }

    const small = document.createElement("small");
    small.className = "field-error-inline";
    small.textContent = text;
    container.appendChild(small);
  }

  function fmtMoney(value, currency = "BRL") {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "-";
    try {
      return amount.toLocaleString("pt-BR", {
        style: "currency",
        currency: currency || "BRL",
      });
    } catch {
      return amount.toFixed(2);
    }
  }

  function fmtDateTime(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "-";
    return date.toLocaleString("pt-BR");
  }

  function toText(value) {
    return String(value == null ? "" : value).trim();
  }

  function toDisplayText(value) {
    let out = toText(value);
    if (!out) return "";

    try {
      if (/[ÃÂÐÑ]/.test(out)) {
        out = decodeURIComponent(
          escape(out), // legacy helper used only for mojibake repair attempt
        );
      }
    } catch {
      // keeps original text when conversion fails
    }

    return out.replace(/\s+/g, " ").trim();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeFieldKey(value) {
    return toText(value)
      .toLowerCase()
      .replace(/\./g, "_")
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function normalizeLabelKey(value) {
    return toText(value)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
  }

  function isGtinAttributeId(rawId) {
    const key = normalizeFieldKey(rawId);
    return key === "gtin" || key === "ean" || key === "ean13" || key === "ean_13";
  }

  function canonicalizeAttributeId(rawId) {
    if (isGtinAttributeId(rawId)) return "GTIN";
    return toText(rawId);
  }

  function listAttributeControls() {
    return Array.from(
      document.querySelectorAll(
        "#draftAttributesMain .attr-value, #draftAttributesSecondary .attr-value",
      ),
    );
  }

  function findAttributeControlByKey(rawKey) {
    const fieldKey = normalizeFieldKey(rawKey);
    if (!fieldKey) return null;
    const controls = listAttributeControls();
    for (const control of controls) {
      const byId = normalizeFieldKey(control?.dataset?.attrId);
      if (byId && (byId === fieldKey || byId.includes(fieldKey) || fieldKey.includes(byId))) {
        return control;
      }
    }
    for (const control of controls) {
      const byName = normalizeFieldKey(control?.dataset?.attrName);
      if (
        byName &&
        (byName === fieldKey || byName.includes(fieldKey) || fieldKey.includes(byName))
      ) {
        return control;
      }
    }
    return null;
  }

  function findAttributeControlByLabel(rawLabel) {
    const target = normalizeLabelKey(rawLabel);
    if (!target) return null;
    const controls = listAttributeControls();
    for (const control of controls) {
      const byName = normalizeLabelKey(control?.dataset?.attrName);
      if (!byName) continue;
      if (byName === target || byName.includes(target) || target.includes(byName)) {
        return control;
      }
    }
    return null;
  }

  function listingTypeLabel(id, fallback = null) {
    const normalized = toText(id).toLowerCase();
    if (!normalized) return fallback || "-";
    if (normalized === "gold_special") return "Classico";
    if (normalized === "gold_pro") return "Premium";
    if (normalized === "free") return "Gratis";
    return fallback || normalized;
  }

  function normalizeListingTypeOptions(options, currentId = null) {
    const source = Array.isArray(options) ? options : [];
    const byId = new Map();

    const add = (id, name = null) => {
      const normalized = toText(id).toLowerCase();
      if (!normalized) return;
      if (normalized !== "gold_special" && normalized !== "gold_pro") return;
      byId.set(normalized, {
        id: normalized,
        name: listingTypeLabel(normalized, toText(name) || null),
      });
    };

    add("gold_special", "Classico");
    add("gold_pro", "Premium");
    for (const option of source) {
      add(option?.id, option?.name);
    }
    add(currentId);

    return ["gold_special", "gold_pro"]
      .map((id) => byId.get(id))
      .filter(Boolean);
  }

  function normalizeConditionOptions(options, currentId = null) {
    const source = Array.isArray(options) ? options : [];
    const byId = new Map();

    const add = (id, name = null) => {
      const normalized = toText(id).toLowerCase();
      if (!normalized) return;
      let label = toText(name);
      if (!label) {
        if (normalized === "new") label = "Novo";
        else if (normalized === "used") label = "Usado";
        else if (normalized === "not_specified") label = "Nao especificado";
        else label = normalized;
      }
      byId.set(normalized, { id: normalized, name: label });
    };

    add("new", "Novo");
    add("used", "Usado");
    for (const option of source) {
      add(option?.id, option?.name);
    }
    add(currentId);

    return Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name, "pt-BR"),
    );
  }

  function normalizeShippingModeValue(value) {
    const mode = toText(value).toLowerCase();
    if (!mode) return null;
    if (["me1", "me2", "custom", "not_specified"].includes(mode)) return mode;
    return null;
  }

  function shippingModeLabel(mode) {
    const key = normalizeShippingModeValue(mode);
    if (key === "me2") return "Mercado Envios 2 (ME2)";
    if (key === "me1") return "Mercado Envios 1 (ME1)";
    if (key === "custom") return "Personalizado";
    if (key === "not_specified") return "Nao especificado";
    return key || "Automatico";
  }

  function normalizeShippingContext(context) {
    const raw = context && typeof context === "object" ? context : {};
    const modes = Array.isArray(raw.mode_options) ? raw.mode_options : [];
    const modeOptions = modes
      .map((entry) => {
        const id = normalizeShippingModeValue(entry?.id);
        if (!id) return null;
        return {
          id,
          label: toText(entry?.label) || shippingModeLabel(id),
          eligible:
            typeof entry?.eligible === "boolean"
              ? entry.eligible
              : entry?.eligible == null
                ? null
                : null,
          reason: toDisplayText(entry?.reason || ""),
        };
      })
      .filter(Boolean);

    const freeShipping = raw?.free_shipping && typeof raw.free_shipping === "object"
      ? raw.free_shipping
      : {};

    const recommendation = raw?.recommendation && typeof raw.recommendation === "object"
      ? raw.recommendation
      : {};

    return {
      source: toText(raw?.source),
      mode_options: modeOptions,
      free_shipping: {
        eligible:
          typeof freeShipping.eligible === "boolean"
            ? freeShipping.eligible
            : freeShipping.eligible == null
              ? null
              : null,
        reason: toDisplayText(freeShipping.reason || ""),
      },
      recommendation: {
        mode: normalizeShippingModeValue(recommendation.mode),
        free_shipping:
          recommendation.free_shipping === true
            ? true
            : recommendation.free_shipping === false
              ? false
              : null,
      },
      notes: Array.isArray(raw?.notes)
        ? raw.notes.map((note) => toDisplayText(note)).filter(Boolean)
        : [],
    };
  }

  function normalizeDraftShippingSelection(payload = {}) {
    const shipping = payload?.shipping && typeof payload.shipping === "object"
      ? payload.shipping
      : {};
    const mode = normalizeShippingModeValue(shipping.mode);
    const freeShipping =
      shipping.free_shipping === true
        ? true
        : shipping.free_shipping === false
          ? false
          : null;

    return { mode, free_shipping: freeShipping };
  }

  function renderShippingEditors(payload = {}) {
    if (!el.draftShippingMode || !el.draftShippingFree) return;

    const context = normalizeShippingContext(payload?.shipping_context);
    const selected = normalizeDraftShippingSelection(payload);
    const modeOptionsRaw = Array.isArray(context.mode_options) ? context.mode_options : [];
    const modeOptions = modeOptionsRaw.length
      ? modeOptionsRaw
      : [
          { id: "me2", label: shippingModeLabel("me2"), eligible: null, reason: "" },
          { id: "me1", label: shippingModeLabel("me1"), eligible: null, reason: "" },
        ];

    el.draftShippingMode.innerHTML = "";
    const modeAuto = document.createElement("option");
    modeAuto.value = "auto";
    modeAuto.textContent = "Automatico";
    el.draftShippingMode.appendChild(modeAuto);

    for (const option of modeOptions) {
      const domOption = document.createElement("option");
      domOption.value = option.id;
      domOption.textContent = option.label || shippingModeLabel(option.id);
      if (option.eligible === false) {
        domOption.disabled = true;
        domOption.textContent = `${domOption.textContent} (indisponivel)`;
      }
      el.draftShippingMode.appendChild(domOption);
    }

    const recommendationMode = context?.recommendation?.mode || null;
    const selectedMode = selected.mode || recommendationMode || "auto";
    el.draftShippingMode.value = selectedMode;
    if (!el.draftShippingMode.value) el.draftShippingMode.value = "auto";
    if (el.draftShippingMode.selectedOptions?.[0]?.disabled) {
      el.draftShippingMode.value = "auto";
    }

    el.draftShippingFree.innerHTML = "";
    const freeAuto = document.createElement("option");
    freeAuto.value = "auto";
    freeAuto.textContent = "Automatico";
    el.draftShippingFree.appendChild(freeAuto);

    const buyerOption = document.createElement("option");
    buyerOption.value = "buyer";
    buyerOption.textContent = "Por conta do comprador";
    el.draftShippingFree.appendChild(buyerOption);

    const freeOption = document.createElement("option");
    freeOption.value = "free";
    freeOption.textContent = "Frete gratis";
    if (context?.free_shipping?.eligible === false) {
      freeOption.disabled = true;
      freeOption.textContent = "Frete gratis (indisponivel)";
    }
    el.draftShippingFree.appendChild(freeOption);

    const recommendationFree = context?.recommendation?.free_shipping;
    const selectedFree =
      selected.free_shipping === true
        ? "free"
        : selected.free_shipping === false
          ? "buyer"
          : recommendationFree === true
            ? "free"
            : recommendationFree === false
              ? "buyer"
              : "auto";
    el.draftShippingFree.value = selectedFree;
    if (!el.draftShippingFree.value) el.draftShippingFree.value = "auto";
    if (el.draftShippingFree.selectedOptions?.[0]?.disabled) {
      el.draftShippingFree.value = "buyer";
    }

    const syncFreeShippingByMode = () => {
      const selectedMode = normalizeShippingModeValue(el.draftShippingMode?.value);
      const freeDomOption = Array.from(el.draftShippingFree?.options || []).find(
        (entry) => entry.value === "free",
      );
      if (!freeDomOption) return;

      const forcedDisableByMode = selectedMode && selectedMode !== "me2";
      const disabledByEligibility = context?.free_shipping?.eligible === false;
      freeDomOption.disabled = forcedDisableByMode || disabledByEligibility;
      if (freeDomOption.disabled && el.draftShippingFree.value === "free") {
        el.draftShippingFree.value = selectedMode === "me2" ? "auto" : "buyer";
      }
    };
    syncFreeShippingByMode();
    if (el.draftShippingMode) {
      el.draftShippingMode.onchange = () => {
        syncFreeShippingByMode();
      };
    }

    if (el.draftShippingModeHint) {
      const enabledModes = modeOptions
        .filter((entry) => entry.eligible !== false)
        .map((entry) => entry.label || shippingModeLabel(entry.id));
      const hintText = enabledModes.length
        ? `Elegivel: ${enabledModes.join(" | ")}`
        : "Nao foi possivel confirmar modos de envio para esta categoria.";
      el.draftShippingModeHint.textContent = hintText;
    }

    if (el.draftShippingFreeHint) {
      if (context?.free_shipping?.eligible === true) {
        el.draftShippingFreeHint.textContent =
          "Frete gratis elegivel para a configuracao atual.";
      } else if (context?.free_shipping?.eligible === false) {
        el.draftShippingFreeHint.textContent =
          context?.free_shipping?.reason ||
          "Frete gratis nao elegivel para esta configuracao.";
      } else {
        el.draftShippingFreeHint.textContent =
          "Nao foi possivel confirmar elegibilidade de frete gratis com os dados atuais.";
      }
    }
  }

  function collectShippingPatchFromEditors() {
    const modeRaw = toText(el.draftShippingMode?.value).toLowerCase();
    const freeRaw = toText(el.draftShippingFree?.value).toLowerCase();
    const out = {};

    if (modeRaw && modeRaw !== "auto") {
      const mode = normalizeShippingModeValue(modeRaw);
      if (mode) out.mode = mode;
    }

    if (freeRaw === "free") out.free_shipping = true;
    if (freeRaw === "buyer") out.free_shipping = false;

    return out;
  }

  function normalizeCloneMode(value, hasVariations = false) {
    const mode = toText(value).toLowerCase();
    if (mode === "variacoes" && hasVariations) return "variacoes";
    if (mode === "unitario") return "unitario";
    return hasVariations ? "variacoes" : "unitario";
  }

  function sanitizeVariationAttributes(list) {
    return Array.isArray(list)
      ? list
          .map((item) => normalizeMlAttribute(item))
          .filter(Boolean)
          .map((item) => ({
            id: item.id,
            name: item.name || item.id,
            value_id: toText(item.value_id) || null,
            value_name: toText(item.value_name) || null,
          }))
      : [];
  }

  function normalizeDraftVariation(variation, index) {
    const priceRaw = Number(variation?.price);
    const qtyRaw = Number(variation?.available_quantity);
    return {
      idx: index,
      enabled: true,
      id: toText(variation?.id) || null,
      label: `Variacao ${index + 1}`,
      price: Number.isFinite(priceRaw) ? priceRaw : null,
      available_quantity: Number.isFinite(qtyRaw) ? Math.max(0, Math.floor(qtyRaw)) : 0,
      seller_custom_field: toText(variation?.seller_custom_field) || "",
      attribute_combinations: sanitizeVariationAttributes(
        variation?.attribute_combinations,
      ),
      attributes: sanitizeVariationAttributes(variation?.attributes),
      picture_ids: Array.isArray(variation?.picture_ids)
        ? variation.picture_ids.map((value) => toText(value)).filter(Boolean)
        : [],
    };
  }

  function formatVariationComboText(combos) {
    const list = Array.isArray(combos) ? combos : [];
    const parts = [];
    for (const combo of list) {
      const name = toText(combo?.name || combo?.id);
      const value = toText(combo?.value_name || combo?.value_id);
      if (!name && !value) continue;
      if (name && value) parts.push(`${name}: ${value}`);
      else parts.push(name || value);
    }
    return parts.length ? parts.join(" | ") : "Sem combinacao definida";
  }

  function setCloneMode(mode) {
    const safeMode = normalizeCloneMode(mode, state.variationEditorModel.length > 0);
    state.cloneMode = safeMode;
    if (el.cloneModeUnitario) el.cloneModeUnitario.checked = safeMode === "unitario";
    if (el.cloneModeVariacoes) el.cloneModeVariacoes.checked = safeMode === "variacoes";

    if (el.variationSection) {
      const shouldShowVariations =
        state.variationEditorModel.length > 0 && safeMode === "variacoes";
      el.variationSection.classList.toggle("hidden", !shouldShowVariations);
    }

    if (el.draftQty) {
      const disableQty = state.variationEditorModel.length > 0 && safeMode === "variacoes";
      el.draftQty.disabled = disableQty;
      el.draftQty.title = disableQty
        ? "Quantidade por variacao ativa quando o modo de clonagem usa variacoes."
        : "";
    }
  }

  function renderVariationEditors() {
    if (!el.variationList || !el.variationCountBadge) return;
    el.variationList.innerHTML = "";
    const model = Array.isArray(state.variationEditorModel)
      ? state.variationEditorModel
      : [];

    if (!model.length) {
      el.variationCountBadge.textContent = "0 variacoes";
      el.variationList.innerHTML =
        "<div class=\"attr-editor__empty\">Este anuncio nao possui variacoes.</div>";
      return;
    }

    const enabledCount = model.filter((entry) => entry.enabled).length;
    el.variationCountBadge.textContent = `${enabledCount}/${model.length} variacoes ativas`;

    model.forEach((entry, index) => {
      const row = document.createElement("article");
      row.className = "variation-card";
      row.dataset.idx = String(index);
      if (!entry.enabled) row.classList.add("is-disabled");

      const comboText = formatVariationComboText(entry.attribute_combinations);
      row.innerHTML = `
        <div class="variation-card__head">
          <label class="variation-card__toggle">
            <input type="checkbox" class="variation-enabled" ${entry.enabled ? "checked" : ""} />
            <span>${escapeHtml(entry.label)}</span>
          </label>
          <small class="field-help">${escapeHtml(comboText)}</small>
        </div>
        <div class="variation-card__grid">
          <label>
            Preco
            <input type="number" class="variation-price" step="0.01" min="0" value="${escapeHtml(entry.price != null ? String(entry.price) : "")}" />
          </label>
          <label>
            Estoque
            <input type="number" class="variation-qty" step="1" min="0" value="${escapeHtml(entry.available_quantity != null ? String(entry.available_quantity) : "0")}" />
          </label>
          <label>
            SKU vendedor (opcional)
            <input type="text" class="variation-sku" value="${escapeHtml(entry.seller_custom_field || "")}" />
          </label>
        </div>
      `;

      const controls = row.querySelectorAll("input:not(.variation-enabled)");
      controls.forEach((control) => {
        control.disabled = !entry.enabled;
      });

      const enabledInput = row.querySelector(".variation-enabled");
      enabledInput?.addEventListener("change", () => {
        const idx = Number(row.dataset.idx || "-1");
        if (!Number.isFinite(idx) || !state.variationEditorModel[idx]) return;
        state.variationEditorModel[idx].enabled = !!enabledInput.checked;
        renderVariationEditors();
      });

      row.querySelector(".variation-price")?.addEventListener("input", (event) => {
        const idx = Number(row.dataset.idx || "-1");
        if (!Number.isFinite(idx) || !state.variationEditorModel[idx]) return;
        const value = Number(event.target.value);
        state.variationEditorModel[idx].price = Number.isFinite(value) ? value : null;
      });

      row.querySelector(".variation-qty")?.addEventListener("input", (event) => {
        const idx = Number(row.dataset.idx || "-1");
        if (!Number.isFinite(idx) || !state.variationEditorModel[idx]) return;
        const value = Math.floor(Number(event.target.value));
        state.variationEditorModel[idx].available_quantity = Number.isFinite(value)
          ? Math.max(0, value)
          : 0;
      });

      row.querySelector(".variation-sku")?.addEventListener("input", (event) => {
        const idx = Number(row.dataset.idx || "-1");
        if (!Number.isFinite(idx) || !state.variationEditorModel[idx]) return;
        state.variationEditorModel[idx].seller_custom_field = toText(event.target.value);
      });

      el.variationList.appendChild(row);
    });
  }

  function collectVariationPatch() {
    const model = Array.isArray(state.variationEditorModel)
      ? state.variationEditorModel
      : [];
    return model
      .filter((entry) => entry.enabled)
      .map((entry) => ({
        id: entry.id || null,
        price: Number.isFinite(Number(entry.price)) ? Number(entry.price) : null,
        available_quantity: Number.isFinite(Number(entry.available_quantity))
          ? Math.max(0, Math.floor(Number(entry.available_quantity)))
          : 0,
        seller_custom_field: toText(entry.seller_custom_field) || null,
        attribute_combinations: Array.isArray(entry.attribute_combinations)
          ? entry.attribute_combinations
          : [],
        attributes: Array.isArray(entry.attributes) ? entry.attributes : [],
        picture_ids: Array.isArray(entry.picture_ids) ? entry.picture_ids : [],
      }));
  }

  function parseAttributesJsonText(text) {
    const raw = String(text == null ? "" : text).trim();
    if (!raw) return [];
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Atributos adicionais com JSON invalido.");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Atributos adicionais precisam estar em formato de lista JSON.");
    }
    return parsed
      .map((item) => normalizeMlAttribute(item))
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        name: item.name || item.id,
        value_id: toText(item.value_id) || null,
        value_name: toText(item.value_name) || null,
      }))
      .filter((item) => item.value_id || item.value_name);
  }

  function mergeAttributesById(primaryList, extraList) {
    const merged = new Map();
    const append = (entry) => {
      const normalized = normalizeMlAttribute(entry);
      if (!normalized || !(normalized.value_id || normalized.value_name)) return;
      merged.set(normalized.id, {
        id: normalized.id,
        name: normalized.name || normalized.id,
        value_id: toText(normalized.value_id) || null,
        value_name: toText(normalized.value_name) || null,
      });
    };
    (Array.isArray(extraList) ? extraList : []).forEach(append);
    (Array.isArray(primaryList) ? primaryList : []).forEach(append);
    return Array.from(merged.values());
  }

  function getCurrentMaxTitleLength() {
    const payload = state.currentDraft?.draft_payload || {};
    const raw = Number(payload?.max_title_length);
    if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
    return 120;
  }

  function validateReviewBeforePublish({ markUi = true } = {}) {
    if (markUi) {
      clearInlineErrors();
      setReviewValidationSummary([]);
    }

    const errors = [];
    const addError = (target, message, key = null) => {
      errors.push({ target, message, key: key || null });
      if (markUi && target) addInlineError(target, message);
    };

    const title = toText(el.draftTitle?.value);
    const maxTitleLength = getCurrentMaxTitleLength();
    if (!title) {
      addError(el.draftTitle, "Titulo e obrigatorio.", "title");
    } else if (title.length > maxTitleLength) {
      addError(
        el.draftTitle,
        `Titulo acima do limite da categoria (${maxTitleLength} caracteres).`,
        "title",
      );
    }

    const familyName = toText(el.draftFamilyName?.value);
    if (familyName && familyName.length > maxTitleLength) {
      addError(
        el.draftFamilyName,
        `Family name acima do limite da categoria (${maxTitleLength} caracteres).`,
        "family_name",
      );
    }

    const price = Number(el.draftPrice?.value);
    if (!Number.isFinite(price) || price <= 0) {
      addError(el.draftPrice, "Preco precisa ser maior que zero.", "price");
    }

    const listingType = toText(el.draftListingType?.value);
    if (!listingType) {
      addError(el.draftListingType, "Selecione o tipo de anuncio.", "listing_type_id");
    }

    const condition = toText(el.draftCondition?.value);
    if (!condition) {
      addError(el.draftCondition, "Selecione a condicao do item.", "condition");
    }

    if (el.draftAttributesExtra) {
      try {
        parseAttributesJsonText(el.draftAttributesExtra.value);
      } catch (error) {
        addError(
          el.draftAttributesExtra,
          error?.message || "Atributos adicionais invalidos.",
          "attributes_extra",
        );
      }
    }

    const selectedCloneMode = normalizeCloneMode(
      el.cloneModeVariacoes?.checked ? "variacoes" : "unitario",
      state.variationEditorModel.length > 0,
    );
    if (selectedCloneMode === "unitario") {
      const qty = Math.floor(Number(el.draftQty?.value));
      if (!Number.isFinite(qty) || qty < 0) {
        addError(el.draftQty, "Quantidade precisa ser um numero inteiro >= 0.", "available_quantity");
      }
    } else {
      const activeVariations = collectVariationPatch();
      if (!activeVariations.length) {
        addError(
          el.variationSection || el.variationModeWrap,
          "Ative ao menos uma variacao para publicar nesse modo.",
          "variations",
        );
      } else {
        state.variationEditorModel.forEach((entry, index) => {
          if (!entry.enabled) return;
          const row = el.variationList?.querySelector(`.variation-card[data-idx='${index}']`);
          const priceInput = row?.querySelector(".variation-price");
          const qtyInput = row?.querySelector(".variation-qty");
          const rowPrice = Number(entry.price);
          const rowQty = Number(entry.available_quantity);
          if (!Number.isFinite(rowPrice) || rowPrice <= 0) {
            addError(
              priceInput || row || el.variationSection,
              `Variacao ${index + 1}: preco invalido.`,
              "variation_price",
            );
          }
          if (!Number.isFinite(rowQty) || Math.floor(rowQty) < 0) {
            addError(
              qtyInput || row || el.variationSection,
              `Variacao ${index + 1}: estoque invalido.`,
              "variation_quantity",
            );
          }
        });
      }
    }

    const requiredControls = Array.from(
      document.querySelectorAll(
        "#draftAttributesMain .attr-value[data-attr-required='1'], #draftAttributesSecondary .attr-value[data-attr-required='1']",
      ),
    );
    for (const control of requiredControls) {
      const value = toText(control?.value);
      if (!value) {
        const label = toText(control?.dataset?.attrName || control?.dataset?.attrId) || "Atributo";
        addError(control, `${label}: campo obrigatorio sem preenchimento.`, "attributes");
      }
    }

    if (markUi) {
      setReviewValidationSummary(errors);
    }

    return {
      ok: errors.length === 0,
      errors,
    };
  }

  function renderSelectOptions(selectEl, options, selectedValue) {
    if (!selectEl) return;
    const selected = toText(selectedValue).toLowerCase();
    selectEl.innerHTML = "";
    for (const option of Array.isArray(options) ? options : []) {
      const id = toText(option?.id).toLowerCase();
      if (!id) continue;
      const item = document.createElement("option");
      item.value = id;
      item.textContent = toText(option?.name) || id;
      if (id === selected) item.selected = true;
      selectEl.appendChild(item);
    }
    if (!selectEl.options.length) {
      const fallback = document.createElement("option");
      fallback.value = "";
      fallback.textContent = "-";
      fallback.selected = true;
      selectEl.appendChild(fallback);
    }
  }

  function normalizeMlAttribute(attribute = {}) {
    const id = toText(attribute?.id);
    if (!id) return null;
    const name = toDisplayText(attribute?.name || attribute?.attribute_name) || id;
    const valueId = toText(attribute?.value_id) || null;
    const valueName = toDisplayText(attribute?.value_name) || "";
    const valueType = toText(attribute?.value_type).toLowerCase() || "string";
    const groupName = toDisplayText(attribute?.attribute_group_name || attribute?.group_name);
    const required = attribute?.required === true;
    const allowedUnits = Array.isArray(attribute?.allowed_units)
      ? attribute.allowed_units
          .map((entry) => ({
            id: toText(entry?.id || entry?.name),
            name: toDisplayText(entry?.name || entry?.id),
          }))
          .filter((entry) => entry.id)
      : [];
    const values = Array.isArray(attribute?.values)
      ? attribute.values
          .map((entry) => ({
            id: toText(entry?.id) || null,
            name: toDisplayText(entry?.name) || null,
          }))
          .filter((entry) => entry.id || entry.name)
      : [];

    return {
      id,
      name,
      value_id: valueId,
      value_name: valueName,
      value_type: valueType,
      attribute_group_name: groupName || null,
      required,
      allows_not_applicable: attribute?.allows_not_applicable === true,
      allowed_units: allowedUnits,
      default_unit: toText(attribute?.default_unit) || allowedUnits[0]?.id || "",
      value_struct: attribute?.value_struct || null,
      values,
    };
  }

  async function request(path, options = {}) {
    const url = `${API_BASE}${path}`;
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body != null ? JSON.stringify(options.body) : undefined,
    });

    const text = await response.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      const errorMessage =
        json?.error ||
        json?.message ||
        text ||
        `Falha na requisicao (${response.status}).`;
      const error = new Error(errorMessage);
      error.status = response.status;
      error.payload = json;
      throw error;
    }

    return json || {};
  }

  async function requestWithRetry(
    path,
    options = {},
    {
      retries = 1,
      retryDelayMs = 850,
      shouldRetry = (error) =>
        !error?.status || Number(error.status) >= 500 || Number(error.status) === 429,
    } = {},
  ) {
    let lastError = null;
    const attempts = Math.max(1, Number(retries) + 1);

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await request(path, options);
      } catch (error) {
        lastError = error;
        const hasNext = attempt < attempts - 1;
        if (!hasNext || !shouldRetry(error)) {
          throw error;
        }
        await sleep(retryDelayMs);
      }
    }

    throw lastError || new Error("Falha ao processar requisicao.");
  }

  function getClonePageUrlForCapture() {
    const path = window.mlUrl ? window.mlUrl("/clonar-anuncio") : "/ml/clonar-anuncio";
    return `${window.location.origin}${path}#ml-browser-capture`;
  }

  function buildBookmarkletCode() {
    const targetUrl = getClonePageUrlForCapture();
    const targetOrigin = window.location.origin;
    const script = `
      (() => {
        try {
          const payload = {
            type: "DAVANTTI_ML_BROWSER_CAPTURE",
            capture_id: "ml-" + Date.now() + "-" + Math.random().toString(36).slice(2),
            url: window.location.href,
            title: document.title || "",
            html: document.documentElement ? document.documentElement.outerHTML : "",
            captured_at: new Date().toISOString()
          };
          const popup = window.open(${JSON.stringify(targetUrl)}, "davantti_clone_capture", "width=1280,height=860");
          if (!popup) {
            alert("Permita pop-ups para enviar a captura para a Davantti.");
            return;
          }
          let tries = 0;
          let timer = null;
          const send = () => {
            try {
              popup.postMessage(payload, ${JSON.stringify(targetOrigin)});
            } catch (error) {}
            tries += 1;
            if (tries >= 30 && timer) window.clearInterval(timer);
          };
          timer = window.setInterval(send, 500);
          window.setTimeout(send, 900);
        } catch (error) {
          alert("Nao foi possivel capturar este anuncio: " + (error && error.message ? error.message : error));
        }
      })();
    `;
    return `javascript:${encodeURIComponent(script).replace(/%20/g, " ")}`;
  }

  function setupBookmarklet() {
    const code = buildBookmarkletCode();
    if (el.bookmarkletLink) {
      el.bookmarkletLink.href = code;
      el.bookmarkletLink.addEventListener("click", (event) => {
        event.preventDefault();
        const message =
          "Este botao precisa ficar na barra de favoritos. Arraste-o para os favoritos; depois abra um anuncio do Mercado Livre e clique no favorito 'Clonar na Davantti'.";
        setFeedback(message, "warn");
        window.alert(message);
      });
    }
    if (el.btnCopyBookmarklet) {
      el.btnCopyBookmarklet.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(code);
          setFeedback("Codigo copiado. Crie um favorito no navegador e cole esse codigo como URL.", "ok");
        } catch {
          setFeedback("Nao foi possivel copiar automaticamente. Arraste o botao para a barra de favoritos.", "warn");
        }
      });
    }
  }

  async function importBrowserCapture(payload) {
    const html = toText(payload?.html);
    const url = toText(payload?.url);
    const captureKey = toText(payload?.capture_id) || `${url}|${payload?.captured_at || ""}|${html.length}`;
    if (state.captureImportInFlight || state.processedCaptureKeys.has(captureKey)) return;
    if (!html || !url || !/mercadolivre\.com\.br/i.test(url)) {
      setFeedback("A captura recebida nao parece ser de um anuncio do Mercado Livre.", "error");
      return;
    }

    state.captureImportInFlight = true;
    state.processedCaptureKeys.add(captureKey);
    state.activeSubtab = "editor";
    setFeedback("Recebemos a captura do navegador. Criando rascunho...", "warn");
    window.MLLoadingOverlay?.show({
      context: "Clonar anuncio",
      label: "Captura Mercado Livre",
      texts: [
        "Lendo HTML capturado no navegador...",
        "Extraindo preco, imagens e caracteristicas...",
        "Criando rascunho para revisao...",
      ],
      message: "Lendo HTML capturado no navegador...",
      initialProgress: 18,
      maxProgress: 92,
    });

    try {
      const response = await request("/browser-capture", {
        method: "POST",
        body: {
          url,
          html,
          captured_at: payload?.captured_at || null,
          title: payload?.title || "",
        },
      });
      window.MLLoadingOverlay?.update({
        message: "Rascunho criado. Abrindo revisao...",
        progress: 100,
        done: true,
      });
      if (response?.draft) {
        showDraft(response.draft);
        await loadDrafts({ quiet: true });
        state.activeSubtab = "editor";
        goToStep(2, { force: true });
      }
      setFeedback("Captura importada com sucesso. Revise os campos antes de publicar.", "ok");
    } catch (error) {
      setFeedback(error.message || "Falha ao importar captura do navegador.", "error");
      window.MLLoadingOverlay?.update({
        message: error.message || "Falha ao importar captura.",
        progress: 100,
        error: true,
      });
    } finally {
      state.captureImportInFlight = false;
      window.setTimeout(() => window.MLLoadingOverlay?.hide(), 900);
    }
  }

  function setupBrowserCaptureReceiver() {
    if (window.location.hash.includes("ml-browser-capture")) {
      setFeedback("Aguardando captura do anuncio aberta no Mercado Livre...", "warn");
      window.focus();
    }

    window.addEventListener("message", (event) => {
      const origin = String(event.origin || "");
      if (!/^https:\/\/(?:[a-z0-9-]+\.)*mercadolivre\.com\.br$/i.test(origin)) return;
      const payload = event.data || {};
      if (payload?.type !== "DAVANTTI_ML_BROWSER_CAPTURE") return;
      importBrowserCapture(payload);
    });
  }

  function prettyJson(value) {
    if (value == null) return "";
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return "";
    }
  }

  function generateRandomGtin13() {
    const body = `789${String(Math.floor(Math.random() * 1_000_000_000)).padStart(9, "0")}`;
    let sum = 0;
    for (let index = 0; index < body.length; index += 1) {
      const digit = Number(body[index]) || 0;
      sum += digit * (index % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    return `${body}${checkDigit}`;
  }

  function buildGtinAttributeControl(attr, value) {
    const wrapper = document.createElement("div");
    wrapper.className = "attr-gtin";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "attr-value attr-gtin__input";
    input.dataset.attrId = attr.id;
    input.dataset.attrName = attr.name;
    input.dataset.attrRequired = attr.required ? "1" : "0";
    input.dataset.attrGroupName = attr.attribute_group_name || "";
    input.dataset.attrValueType = "string";

    const rawInitial = toText(value?.value_name || value?.value_id || "");
    const initialIsEmptyToken = normalizeFieldKey(rawInitial) === "empty_gtin";
    input.value = initialIsEmptyToken ? GTIN_EMPTY_TOKEN : rawInitial;
    input.placeholder =
      "Digite GTIN/EAN ou marque que o produto nao possui codigo";
    if (!initialIsEmptyToken && input.value) {
      input.dataset.manualValue = input.value;
    }

    const actions = document.createElement("div");
    actions.className = "attr-gtin__actions";

    const generateBtn = document.createElement("button");
    generateBtn.type = "button";
    generateBtn.className = "btn btn-ghost";
    generateBtn.textContent = "Gerar automaticamente";

    const noCodeWrap = document.createElement("label");
    noCodeWrap.className = "attr-gtin__checkbox";
    const noCodeCheckbox = document.createElement("input");
    noCodeCheckbox.type = "checkbox";
    noCodeCheckbox.checked = initialIsEmptyToken;
    const noCodeText = document.createElement("span");
    noCodeText.textContent = "Nao possui GTIN/EAN";
    noCodeWrap.appendChild(noCodeCheckbox);
    noCodeWrap.appendChild(noCodeText);

    const syncNoCodeMode = () => {
      if (noCodeCheckbox.checked) {
        const current = toText(input.value);
        if (current && normalizeFieldKey(current) !== "empty_gtin") {
          input.dataset.manualValue = current;
        }
        input.value = GTIN_EMPTY_TOKEN;
        input.readOnly = true;
        input.classList.add("attr-gtin__input--locked");
        return;
      }

      input.readOnly = false;
      input.classList.remove("attr-gtin__input--locked");
      const cached = toText(input.dataset.manualValue);
      input.value = normalizeFieldKey(cached) === "empty_gtin" ? "" : cached;
    };

    generateBtn.addEventListener("click", () => {
      const generated = generateRandomGtin13();
      noCodeCheckbox.checked = false;
      syncNoCodeMode();
      input.value = generated;
      input.dataset.manualValue = generated;
      input.focus();
    });

    noCodeCheckbox.addEventListener("change", () => {
      syncNoCodeMode();
      input.focus();
    });

    input.addEventListener("input", () => {
      if (noCodeCheckbox.checked) return;
      const valueNow = toText(input.value);
      if (!valueNow) {
        input.dataset.manualValue = "";
        return;
      }
      if (normalizeFieldKey(valueNow) === "empty_gtin") {
        noCodeCheckbox.checked = true;
        syncNoCodeMode();
        return;
      }
      input.dataset.manualValue = valueNow;
    });

    syncNoCodeMode();

    actions.appendChild(generateBtn);
    actions.appendChild(noCodeWrap);
    wrapper.appendChild(input);
    wrapper.appendChild(actions);

    return wrapper;
  }

  function valueLabel(attribute, currentValue) {
    const valueId = currentValue?.value_id != null ? toText(currentValue.value_id) : "";
    const valueName = currentValue?.value_name != null ? toDisplayText(currentValue.value_name) : "";
    if (valueId === "-1") return "";
    if (attribute?.value_type === "number_unit" && currentValue?.value_struct?.number != null) {
      return String(currentValue.value_struct.number);
    }
    if (valueName) return valueName;
    if (valueId && Array.isArray(attribute.values)) {
      const found = attribute.values.find((value) => String(value.id) === valueId);
      return found?.name || "";
    }
    if (currentValue?.value_struct?.number != null) return String(currentValue.value_struct.number);
    return "";
  }

  function splitNumberUnitValue(attribute, currentValue) {
    if (currentValue?.value_struct?.number != null) {
      return {
        number: String(currentValue.value_struct.number),
        unit: toText(currentValue.value_struct.unit) || attribute.default_unit || "",
      };
    }

    const raw = valueLabel(attribute, currentValue);
    if (!raw) {
      return { number: "", unit: attribute.default_unit || attribute.allowed_units?.[0]?.id || "" };
    }

    const match = String(raw).trim().match(/^(-?\d+(?:[.,]\d+)?)\s*(.*)$/);
    if (!match) {
      return { number: raw, unit: attribute.default_unit || attribute.allowed_units?.[0]?.id || "" };
    }

    const detectedUnit = toText(match[2]);
    const unit =
      attribute.allowed_units?.find((entry) => (
        entry.id.toLowerCase() === detectedUnit.toLowerCase() ||
        entry.name.toLowerCase() === detectedUnit.toLowerCase()
      ))?.id ||
      detectedUnit ||
      attribute.default_unit ||
      attribute.allowed_units?.[0]?.id ||
      "";

    return {
      number: match[1].replace(",", "."),
      unit,
    };
  }

  function selectedValueId(attribute, currentValue) {
    const valueId = currentValue?.value_id != null ? toText(currentValue.value_id) : "";
    if (valueId === "-1") return "";
    return valueId;
  }

  function buildAttributeValueControl(attribute, value) {
    const attr = normalizeMlAttribute(attribute);
    if (!attr) return null;

    if (isGtinAttributeId(attr.id)) {
      return buildGtinAttributeControl(attr, value);
    }

    if (attr.value_type === "boolean") {
      const currentName = valueLabel(attr, value).toLowerCase();
      const yes = (attr.values || []).find((option) =>
        /^(sim|si|s\u00ed|yes)$/i.test(option.name || "") || option?.metadata?.value === true,
      ) || attr.values?.[0] || { id: "242085", name: "Sim" };
      const no = (attr.values || []).find((option) =>
        /^(nao|n\u00e3o|no)$/i.test(option.name || "") || option?.metadata?.value === false,
      ) || attr.values?.[1] || { id: "242084", name: "Nao" };
      const activeYes = /^(sim|si|s\u00ed|yes)$/i.test(currentName);
      const activeNo = /^(nao|n\u00e3o|no)$/i.test(currentName);
      const segmented = document.createElement("span");
      segmented.className = "segmented";
      segmented.dataset.attrId = attr.id;
      segmented.dataset.attrName = attr.name;
      segmented.dataset.attrRequired = attr.required ? "1" : "0";
      segmented.dataset.attrGroupName = attr.attribute_group_name || "";
      segmented.dataset.attrValueType = "boolean";

      for (const option of [
        { ...yes, active: activeYes },
        { ...no, active: activeNo },
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = option.active ? "active" : "";
        button.dataset.boolId = toText(option.id);
        button.dataset.boolName = toDisplayText(option.name);
        button.textContent = toDisplayText(option.name) || "-";
        segmented.appendChild(button);
      }
      return segmented;
    }

    if (attr.value_type === "number_unit") {
      const parsed = splitNumberUnitValue(attr, value);
      const wrapper = document.createElement("div");
      wrapper.className = "unit-row";

      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.className = "attr-value";
      input.dataset.attrId = attr.id;
      input.dataset.attrName = attr.name;
      input.dataset.attrRequired = attr.required ? "1" : "0";
      input.dataset.attrGroupName = attr.attribute_group_name || "";
      input.dataset.attrValueType = "number_unit";
      input.value = parsed.number || "";
      input.placeholder = attr.required ? "0" : "Opcional";

      const select = document.createElement("select");
      select.dataset.unitFor = attr.id;
      const units = attr.allowed_units?.length
        ? attr.allowed_units
        : [{ id: parsed.unit || attr.default_unit || "", name: parsed.unit || attr.default_unit || "" }].filter((entry) => entry.id);
      for (const unit of units) {
        const option = document.createElement("option");
        option.value = unit.id;
        option.textContent = unit.name || unit.id;
        if (parsed.unit && parsed.unit.toLowerCase() === unit.id.toLowerCase()) {
          option.selected = true;
        }
        select.appendChild(option);
      }

      wrapper.appendChild(input);
      wrapper.appendChild(select);
      return wrapper;
    }

    const hasFixedOptions = Array.isArray(attr.values) && attr.values.length > 0;
    if (hasFixedOptions) {
      const select = document.createElement("select");
      select.className = "attr-value";
      select.dataset.attrId = attr.id;
      select.dataset.attrName = attr.name;
      select.dataset.attrRequired = attr.required ? "1" : "0";
      select.dataset.attrGroupName = attr.attribute_group_name || "";
      select.dataset.attrValueType = attr.value_type || "list";

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Selecione...";
      select.appendChild(placeholder);

      const selectedRaw = selectedValueId(attr, value) || valueLabel(attr, value);
      for (const option of attr.values) {
        const optionId = toText(option?.id);
        const optionName = toText(option?.name) || optionId;
        if (!optionId && !optionName) continue;

        const domOption = document.createElement("option");
        domOption.value = optionId || optionName;
        domOption.textContent = optionName;
        domOption.dataset.valueId = optionId || "";
        domOption.dataset.valueName = optionName || "";

        const compareId = optionId || optionName;
        if (selectedRaw && compareId.toLowerCase() === selectedRaw.toLowerCase()) {
          domOption.selected = true;
        } else if (
          value?.value_name &&
          optionName.toLowerCase() === toText(value.value_name).toLowerCase()
        ) {
          domOption.selected = true;
        }
        select.appendChild(domOption);
      }

      if (!select.value && selectedRaw) {
        const customOption = document.createElement("option");
        customOption.value = selectedRaw;
        customOption.textContent = toText(value?.value_name || selectedRaw);
        customOption.dataset.valueId = toText(value?.value_id);
        customOption.dataset.valueName = toText(value?.value_name || selectedRaw);
        customOption.selected = true;
        select.appendChild(customOption);
      }

      return select;
    }

    const input = document.createElement("input");
    input.type = attr.value_type === "number" ? "number" : "text";
    input.className = "attr-value";
    input.dataset.attrId = attr.id;
    input.dataset.attrName = attr.name;
    input.dataset.attrRequired = attr.required ? "1" : "0";
    input.dataset.attrGroupName = attr.attribute_group_name || "";
    input.dataset.attrValueType = attr.value_type || "string";
    input.value = valueLabel(attr, value);
    input.placeholder = attr.required
      ? "Preencha o valor obrigatorio"
      : "Opcional";
    return input;
  }

  function appendAttributeRow(container, attribute) {
    if (!container) return null;
    const attr = normalizeMlAttribute(attribute);
    if (!attr) return null;

    const emptyNode = container.querySelector(".attr-editor__empty");
    if (emptyNode) emptyNode.remove();

    const row = document.createElement("div");
    row.className = "attr-row attribute-field";
    row.dataset.fieldId = attr.id;

    const left = document.createElement("div");
    left.className = "attr-row__label";
    left.textContent = attr.name;

    if (attr.required) {
      const required = document.createElement("span");
      required.className = "attr-row__required";
      required.textContent = "obrig.";
      left.appendChild(required);
    }

    if (attr.attribute_group_name) {
      const group = document.createElement("small");
      group.className = "attr-row__group";
      group.textContent = attr.attribute_group_name;
      left.appendChild(group);
    }

    const inputWrapper = document.createElement("div");
    const control = buildAttributeValueControl(attr, attr);
    if (control) inputWrapper.appendChild(control);

    if (attr.allows_not_applicable) {
      const currentIsNotApplicable = toText(attr.value_id) === "-1";
      const na = document.createElement("label");
      na.className = "na-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.naFor = attr.id;
      checkbox.checked = currentIsNotApplicable;
      na.appendChild(checkbox);
      na.appendChild(document.createTextNode(" Nao se aplica"));
      inputWrapper.appendChild(na);
    }

    row.appendChild(left);
    row.appendChild(inputWrapper);
    container.appendChild(row);

    const checkedNa = row.querySelector("[data-na-for]:checked");
    if (checkedNa) {
      checkedNa.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return row;
  }

  function renderAttributeRows(container, attributes) {
    if (!container) return;
    container.innerHTML = "";

    const list = Array.isArray(attributes)
      ? attributes.map((item) => normalizeMlAttribute(item)).filter(Boolean)
      : [];
    const hint = container.closest(".attr-section")?.querySelector(".attr-section__hint");
    if (hint) {
      const requiredCount = list.filter((item) => item.required).length;
      hint.textContent = list.length
        ? `${list.length} campo(s) da categoria${requiredCount ? ` | ${requiredCount} obrigatorio(s)` : ""}.`
        : "Nenhum campo disponivel nesta secao.";
    }

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "attr-editor__empty";
      empty.textContent = "Nenhum campo nesta secao para este anuncio.";
      container.appendChild(empty);
      return;
    }

    for (const attr of list) {
      appendAttributeRow(container, attr);
    }
  }

  function resolveFallbackAttributeMeta(rawKey) {
    const key = normalizeFieldKey(rawKey);
    if (!key || NON_ATTRIBUTE_VALIDATION_KEYS.has(key)) return null;

    const map = {
      seller_package_height: {
        id: "seller_package_height",
        name: "Altura da embalagem",
      },
      seller_package_width: {
        id: "seller_package_width",
        name: "Largura da embalagem",
      },
      seller_package_length: {
        id: "seller_package_length",
        name: "Comprimento da embalagem",
      },
      seller_package_weight: {
        id: "seller_package_weight",
        name: "Peso da embalagem",
      },
      gtin: {
        id: "GTIN",
        name: "GTIN / EAN",
      },
      ean: {
        id: "GTIN",
        name: "GTIN / EAN",
      },
      ean13: {
        id: "GTIN",
        name: "GTIN / EAN",
      },
      ean_13: {
        id: "GTIN",
        name: "GTIN / EAN",
      },
    };

    if (map[key]) return map[key];
    if (!key.includes("_")) return null;

    return {
      id: key,
      name: key.replace(/_/g, " "),
    };
  }

  function ensureDraftAttributeControl(rawKey, { required = true } = {}) {
    const existing = findAttributeControlByKey(rawKey);
    if (existing) return existing;

    const fallback = resolveFallbackAttributeMeta(rawKey);
    if (!fallback) return null;

    const container = el.draftAttributesSecondary || el.draftAttributesMain;
    if (!container) return null;

    appendAttributeRow(container, {
      id: fallback.id,
      name: fallback.name,
      value_id: null,
      value_name: "",
      required: required === true,
      value_type: "string",
      attribute_group_name: "Outros",
      values: [],
    });

    return findAttributeControlByKey(fallback.id) || findAttributeControlByKey(rawKey);
  }

  function markAttributeControlAsRequired(control) {
    if (!control) return;
    control.dataset.attrRequired = "1";
    const row = control.closest(".attr-row");
    const label = row?.querySelector(".attr-row__label");
    if (!label) return;
    const hasBadge = !!label.querySelector(".attr-row__required");
    if (hasBadge) return;

    const badge = document.createElement("span");
    badge.className = "attr-row__required";
    badge.textContent = "obrig.";
    label.appendChild(badge);
  }

  function renderUnmatchedAttributes(items) {
    if (!el.draftAttributesUnmatchedWrap || !el.draftAttributesUnmatched) return;
    el.draftAttributesUnmatched.innerHTML = "";
    const list = Array.isArray(items) ? items : [];
    if (!list.length) {
      el.draftAttributesUnmatchedWrap.classList.add("hidden");
      return;
    }

    for (const item of list) {
      const chip = document.createElement("span");
      chip.className = "attr-chip";
      const name = toDisplayText(item?.name || item?.label);
      const value = toDisplayText(item?.value_name || item?.value);
      chip.textContent = name && value ? `${name}: ${value}` : name || value || "-";
      el.draftAttributesUnmatched.appendChild(chip);
    }
    el.draftAttributesUnmatchedWrap.classList.remove("hidden");
  }

  function collectAttributesFromEditors() {
    const rows = Array.from(
      document.querySelectorAll("#draftAttributesMain .attr-row, #draftAttributesSecondary .attr-row"),
    );
    const out = [];

    for (const row of rows) {
      const control = row.querySelector(".attr-value, .segmented");
      if (!control) continue;
      const id = canonicalizeAttributeId(control?.dataset?.attrId || row.dataset.fieldId);
      if (!id) continue;

      let valueId = null;
      let valueName = "";
      const isNotApplicable = Boolean(row.querySelector("[data-na-for]")?.checked);
      const valueType = toText(control?.dataset?.attrValueType).toLowerCase();

      if (isNotApplicable) {
        valueId = "-1";
        valueName = "";
      } else if (control?.classList?.contains("segmented")) {
        const active = control.querySelector("button.active");
        valueId = toText(active?.dataset?.boolId);
        valueName = toText(active?.dataset?.boolName || active?.textContent);
      } else if (valueType === "number_unit") {
        const unit = row.querySelector(`[data-unit-for="${CSS.escape(id)}"]`);
        const rawNumber = toText(control?.value);
        const unitValue = toText(unit?.value);
        valueName = rawNumber ? (unitValue ? `${rawNumber} ${unitValue}` : rawNumber) : "";
      } else {
        const isSelect = control?.tagName === "SELECT";

        if (isSelect) {
          const selected = control.options[control.selectedIndex];
          valueId = toText(selected?.dataset?.valueId);
          valueName = toText(selected?.dataset?.valueName || selected?.textContent);
          if (!valueId && !toText(control.value)) {
            valueName = "";
          }
        } else {
          valueName = toText(control?.value);
        }
      }

      if (isGtinAttributeId(id)) {
        const normalizedInput = normalizeFieldKey(valueName || valueId);
        if (normalizedInput === "empty_gtin") {
          valueId = null;
          valueName = GTIN_EMPTY_TOKEN;
        } else {
          const digits = String(valueName || "").replace(/\D+/g, "");
          if (digits.length >= 8 && digits.length <= 14) {
            valueName = digits;
          }
        }
      }

      const required = control.dataset.attrRequired === "1";
      if (!valueId && !valueName) {
        if (required) {
          out.push({
            id,
            name: toText(control.dataset.attrName) || id,
            value_id: null,
            value_name: "",
            required: true,
            attribute_group_name: toText(control.dataset.attrGroupName) || null,
          });
        }
        continue;
      }

      out.push({
        id,
        name: toText(control.dataset.attrName) || id,
        value_id: valueId || null,
        value_name: valueName || null,
        required,
        attribute_group_name: toText(control.dataset.attrGroupName) || null,
      });
    }

    return out;
  }

  function syncAdvancedAttributesTextarea() {
    const attrs = collectAttributesFromEditors();
    if (el.draftAttributes) {
      el.draftAttributes.value = prettyJson(attrs);
    }
    return attrs;
  }

  function canOpenStep(step) {
    if (step <= 1) return true;
    if (!state.currentDraft) return false;
    return true;
  }

  function switchSubtab(nextSubtab) {
    state.activeSubtab = nextSubtab === "drafts" ? "drafts" : "editor";
    if (state.activeSubtab === "drafts") {
      loadDrafts();
    }
    renderStepState();
  }

  function renderSubtabState() {
    for (const button of el.subtabButtons) {
      const tab = button.getAttribute("data-clone-subtab") || "editor";
      const active = tab === state.activeSubtab;
      button.classList.toggle("btn-primary", active);
      button.classList.toggle("btn-ghost", !active);
    }
  }

  function renderStepState() {
    renderSubtabState();
    const showingDrafts = state.activeSubtab === "drafts";
    const hasDraftInEditor = !!state.currentDraft && !showingDrafts;

    if (el.homeSection) {
      el.homeSection.classList.toggle("hidden-step", hasDraftInEditor || showingDrafts);
    }
    if (el.reviewSection) {
      el.reviewSection.classList.toggle("hidden-step", !hasDraftInEditor);
    }
    if (el.draftsSection) {
      el.draftsSection.classList.toggle("hidden", !showingDrafts);
    }
  }

  function goToStep(step, { force = false } = {}) {
    const requestedStep = Number(step) || 1;
    const safeStep = Math.min(3, Math.max(1, requestedStep));
    if (!force && !canOpenStep(safeStep)) {
      setFeedback("Conclua a etapa atual antes de avancar.", "warn");
      return;
    }

    if (!force && safeStep > state.currentStep && safeStep >= 3) {
      const reviewValidation = validateReviewBeforePublish({ markUi: true });
      if (!reviewValidation.ok) {
        setFeedback(
          "Existem campos obrigatorios pendentes ou invalidos. Corrija para continuar.",
          "error",
        );
        return;
      }
    }

    state.currentStep = safeStep >= 2 && state.currentDraft ? 2 : 1;
    renderStepState();
  }

  function setPublishProgress(percent, label, hint) {
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    state.publishProgressValue = safePercent;
    if (el.publishProgressBar) {
      el.publishProgressBar.style.width = `${safePercent}%`;
    }
    if (el.publishProgressPercent) {
      el.publishProgressPercent.textContent = `${Math.round(safePercent)}%`;
    }
    if (label && el.publishProgressLabel) {
      el.publishProgressLabel.textContent = label;
    }
    if (hint && el.publishProgressHint) {
      el.publishProgressHint.textContent = hint;
    }
  }

  function resetPublishVisuals() {
    if (el.publishProgress) {
      el.publishProgress.classList.add("hidden");
      el.publishProgress.classList.remove("is-error");
    }
    if (el.publishResult) {
      el.publishResult.classList.add("hidden");
    }
    setPublishProgress(0, "Iniciando publicacao...", "Aguardando envio para o Mercado Livre.");
  }

  function startPublishProgress() {
    if (state.publishProgressTimer) {
      window.clearInterval(state.publishProgressTimer);
      state.publishProgressTimer = null;
    }

    if (el.publishProgress) {
      el.publishProgress.classList.remove("hidden", "is-error");
    }

    setPublishProgress(
      8,
      PROGRESS_STAGES[0].label,
      PROGRESS_STAGES[0].hint,
    );

    state.publishProgressTimer = window.setInterval(() => {
      const increment = Math.max(2, Math.min(6, Math.random() * 7));
      const next = Math.min(92, state.publishProgressValue + increment);
      let stage = PROGRESS_STAGES[0];
      for (const candidate of PROGRESS_STAGES) {
        if (next >= candidate.min) stage = candidate;
      }
      setPublishProgress(next, stage.label, stage.hint);
    }, 650);
  }

  function finishPublishProgress({ success, label, hint }) {
    if (state.publishProgressTimer) {
      window.clearInterval(state.publishProgressTimer);
      state.publishProgressTimer = null;
    }
    if (el.publishProgress) {
      el.publishProgress.classList.remove("hidden");
      el.publishProgress.classList.toggle("is-error", !success);
    }
    setPublishProgress(
      success ? 100 : Math.max(15, state.publishProgressValue),
      label,
      hint,
    );
  }

  function showPublishResult({ itemId, permalink, publishedAt }) {
    if (!el.publishResult) return;
    if (!itemId) {
      el.publishResult.classList.add("hidden");
      return;
    }

    el.publishResult.classList.remove("hidden");
    el.publishResultItemId.textContent = itemId;
    el.publishResultPublishedAt.textContent = fmtDateTime(publishedAt);

    if (permalink) {
      el.publishResultPermalink.href = permalink;
      el.publishResultPermalink.textContent = permalink;
      el.publishResultPermalink.style.display = "inline-flex";
    } else {
      el.publishResultPermalink.removeAttribute("href");
      el.publishResultPermalink.textContent = "-";
      el.publishResultPermalink.style.display = "inline-flex";
    }
  }

  function normalizePictureList(pictures) {
    return Array.isArray(pictures)
      ? pictures
          .map((entry) => {
            if (typeof entry === "string") return { source: toText(entry) };
            return {
              source: toText(entry?.source || entry?.url || entry?.secure_url || ""),
              id: toText(entry?.id || ""),
            };
          })
          .filter((entry) => entry.source)
      : [];
  }

  function renderDraftChecklist() {
    if (!el.draftChecklist) return;
    const result = validateReviewBeforePublish({ markUi: false });
    const issues = Array.isArray(result?.errors) ? result.errors : [];
    const issueLabel = (issue) => {
      const key = toText(issue?.key);
      const labels = {
        title: "Titulo",
        family_name: "Family name",
        price: "Preco",
        listing_type_id: "Tipo de anuncio",
        condition: "Condicao",
        attributes_extra: "Atributos adicionais",
        available_quantity: "Estoque",
        variations: "Variacoes",
        variation_price: "Preco das variacoes",
        variation_quantity: "Estoque das variacoes",
        attributes: "Atributos obrigatorios",
        shipping: "Envio",
      };
      return labels[key] || toText(issue?.message) || "Campo";
    };
    const tone = issues.length ? "warning" : "success";
    const title = issues.length
      ? `${issues.length} ponto(s) pedem revisao antes de publicar`
      : "Checklist basico pronto para publicacao";
    const items = issues.length
      ? issues
          .map(
            (issue) =>
              `<span class="listing-clone-pill listing-clone-pill--warning">${escapeHtml(issueLabel(issue))}</span>`,
          )
          .join("")
      : '<span class="listing-clone-pill listing-clone-pill--success">Campos principais preenchidos</span>';

    el.draftChecklist.className = `listing-clone-checklist listing-clone-checklist--${tone}`;
    el.draftChecklist.innerHTML = `
      <div class="listing-clone-checklist__title">${escapeHtml(title)}</div>
      <div class="listing-clone-checklist__items">${items}</div>
    `;
  }

  function renderDraftNotes(draft) {
    if (!el.draftNotesList) return;
    const notes = [];
    const payloadNotes = Array.isArray(draft?.draft_payload?.notes)
      ? draft.draft_payload.notes
      : [];
    for (const note of payloadNotes) {
      const text = toText(note);
      if (text) notes.push(text);
    }
    const shippingNotes = Array.isArray(draft?.draft_payload?.shipping_context?.notes)
      ? draft.draft_payload.shipping_context.notes
      : [];
    for (const note of shippingNotes) {
      const text = toText(note);
      if (text) notes.push(text);
    }
    const fallbackSource = toText(draft?.draft_payload?.fallback_source || draft?.fallback_source);
    if (fallbackSource === "html_page") {
      notes.push("Dados complementados por fallback da pagina publica. Revise campos e imagens antes de publicar.");
    }
    if (draft?.last_validation && draft.last_validation.ok === false) {
      notes.push("A ultima validacao retornou pontos para ajuste. Consulte o bloco de validacao abaixo.");
    }
    if (!notes.length) {
      el.draftNotesList.innerHTML = "";
      el.draftNotesList.classList.add("hidden");
      return;
    }
    el.draftNotesList.classList.remove("hidden");
    el.draftNotesList.innerHTML = notes
      .map((note) => `<div class="listing-clone-note">${escapeHtml(note)}</div>`)
      .join("");
  }

  function renderDraftSummary(draft) {
    const payload = draft?.draft_payload || {};
    const source = draft || {};
    const sourcePlatform = toText(
      source.source_platform || payload.source_platform || payload?.source_item_snapshot?.platform,
    ).toLowerCase();
    const pictures = normalizePictureList(payload.pictures);
    const firstImage = pictures[0]?.source || "";

    if (el.draftSummaryTitle) {
      el.draftSummaryTitle.textContent = payload.title || source.source_title || "-";
    }
    if (el.draftSummaryImage && el.draftSummaryImageEmpty) {
      if (firstImage) {
        el.draftSummaryImage.src = firstImage;
        el.draftSummaryImage.classList.remove("hidden");
        el.draftSummaryImageEmpty.classList.add("hidden");
      } else {
        el.draftSummaryImage.removeAttribute("src");
        el.draftSummaryImage.classList.add("hidden");
        el.draftSummaryImageEmpty.classList.remove("hidden");
      }
    }
    if (el.draftSummaryMeta) {
      const categoryName = toText(payload.category_name);
      const categoryId = toText(payload.category_id);
      const shippingSelection = normalizeDraftShippingSelection(payload);
      const shippingModeText = shippingSelection.mode
        ? `Envio: ${shippingModeLabel(shippingSelection.mode)}`
        : "";
      const shippingFreeText =
        shippingSelection.free_shipping === true
          ? "Frete: Gratis"
          : shippingSelection.free_shipping === false
            ? "Frete: Comprador"
            : "";
      const platformLabel =
        sourcePlatform === "shopee"
          ? "Origem: Shopee"
          : sourcePlatform === "mercadolivre"
            ? "Origem: Mercado Livre"
            : "";
      const meta = [
        platformLabel,
        source.source_item_id ? `ID origem: ${source.source_item_id}` : "",
        fmtMoney(payload.price, payload.currency_id || "BRL"),
        categoryName || categoryId ? `Categoria: ${categoryName || categoryId}` : "",
        shippingModeText,
        shippingFreeText,
        Number.isFinite(Number(payload.available_quantity))
          ? `Estoque: ${payload.available_quantity}`
          : "",
      ].filter(Boolean);
      el.draftSummaryMeta.innerHTML = meta
        .map((item) => `<span class="listing-clone-pill">${escapeHtml(item)}</span>`)
        .join("");
    }
    if (el.draftSummarySourceLink) {
      const href = toText(source.source_permalink || payload.permalink || "");
      if (href) {
        el.draftSummarySourceLink.href = href;
        el.draftSummarySourceLink.textContent = "Abrir anuncio de origem";
        el.draftSummarySourceLink.classList.remove("hidden");
      } else {
        el.draftSummarySourceLink.removeAttribute("href");
        el.draftSummarySourceLink.textContent = "";
        el.draftSummarySourceLink.classList.add("hidden");
      }
    }
  }

  function renderImageCardsFromPictures(pictures) {
    if (!el.draftImageGrid) return;
    const list = normalizePictureList(pictures);
    if (!list.length) {
      el.draftImageGrid.innerHTML =
        '<div class="muted ui-state ui-state--empty">Nenhuma imagem carregada ainda.</div>';
      return;
    }
    el.draftImageGrid.innerHTML = list
      .map(
        (image, index) => `
          <article class="listing-clone-image-card">
            <img class="listing-clone-image-card__thumb" src="${escapeHtml(image.source)}" alt="">
            <div class="listing-clone-image-card__meta">
              <strong>Imagem ${index + 1}</strong>
              <span class="muted">${escapeHtml(image.id || "URL de origem")}</span>
            </div>
          </article>
        `,
      )
      .join("");
  }

  function refreshPublishSummary(draft) {
    const payload = draft?.draft_payload || {};
    if (el.publishSummaryTitle) el.publishSummaryTitle.textContent = payload.title || "-";
    if (el.publishSummaryPrice) {
      el.publishSummaryPrice.textContent = fmtMoney(
        payload.price,
        payload.currency_id || "BRL",
      );
    }
    const categoryLabel = toText(payload.category_name);
    const categoryId = toText(payload.category_id);
    if (el.publishSummaryCategory) {
      el.publishSummaryCategory.textContent = categoryLabel
        ? categoryId
          ? `${categoryLabel} (${categoryId})`
          : categoryLabel
        : categoryId || "-";
    }

    const variations = Array.isArray(payload.variations) ? payload.variations : [];
    const cloneMode = normalizeCloneMode(payload.clone_mode, variations.length > 0);
    if (!el.publishSummaryQty) return;
    if (cloneMode === "variacoes" && variations.length) {
      const totalStock = variations.reduce((sum, item) => {
        const qty = Number(item?.available_quantity);
        return sum + (Number.isFinite(qty) ? Math.max(0, qty) : 0);
      }, 0);
      el.publishSummaryQty.textContent = `${variations.length} variacoes | estoque ${totalStock}`;
    } else {
      el.publishSummaryQty.textContent =
        Number.isFinite(Number(payload.available_quantity))
          ? String(payload.available_quantity)
          : "-";
    }
  }

  function showDraft(draft, { autoStep = true } = {}) {
    const payload = draft?.draft_payload || {};
    state.currentDraft = draft;

    el.draftStatus.textContent = String(draft.status || "em_revisao");
    el.draftTitle.value = payload.title || "";
    if (el.draftFamilyName) {
      el.draftFamilyName.value = toText(payload.family_name);
    }
    el.draftPrice.value =
      Number.isFinite(Number(payload.price)) && Number(payload.price) >= 0
        ? String(payload.price)
        : "";
    el.draftQty.value =
      Number.isFinite(Number(payload.available_quantity))
        ? String(payload.available_quantity)
        : "";
    const categoryId = toText(payload.category_id);
    const categoryName = toText(payload.category_name);
    const categoryPath = toText(payload.category_path);
    el.draftCategory.value = categoryId;
    if (el.draftCategoryName) {
      el.draftCategoryName.value = categoryName || categoryId || "";
    }
    if (el.draftCategoryPath) {
      el.draftCategoryPath.textContent = categoryPath || "";
    }

    const listingTypeOptions = normalizeListingTypeOptions(
      payload.listing_type_options,
      payload.listing_type_id,
    );
    renderSelectOptions(el.draftListingType, listingTypeOptions, payload.listing_type_id);

    const conditionOptions = normalizeConditionOptions(
      payload.condition_options,
      payload.condition,
    );
    renderSelectOptions(el.draftCondition, conditionOptions, payload.condition);
    renderShippingEditors(payload);

    el.draftDescription.value = payload.description_plain_text || "";
    el.draftPictures.value = Array.isArray(payload.pictures)
      ? payload.pictures
          .map((entry) =>
            typeof entry === "string" ? entry : String(entry?.source || "").trim(),
          )
          .filter(Boolean)
          .join("\n")
      : "";

    const mainAttributes = Array.isArray(payload.attributes_main)
      ? payload.attributes_main
      : [];
    const secondaryAttributes = Array.isArray(payload.attributes_secondary)
      ? payload.attributes_secondary
      : [];
    const fallbackAttributes = Array.isArray(payload.attributes)
      ? payload.attributes
      : [];
    renderAttributeRows(
      el.draftAttributesMain,
      mainAttributes.length || secondaryAttributes.length ? mainAttributes : fallbackAttributes,
    );
    renderAttributeRows(
      el.draftAttributesSecondary,
      mainAttributes.length || secondaryAttributes.length ? secondaryAttributes : [],
    );
    renderUnmatchedAttributes(payload.attributes_unmatched);
    syncAdvancedAttributesTextarea();
    if (el.draftAttributesExtra) {
      el.draftAttributesExtra.value = prettyJson(payload.attributes_extra || []);
    }

    const incomingVariations = Array.isArray(payload.variations) ? payload.variations : [];
    state.variationEditorModel = incomingVariations.map((variation, index) =>
      normalizeDraftVariation(variation, index),
    );
    const hasVariations = state.variationEditorModel.length > 0;
    const mode = normalizeCloneMode(payload.clone_mode, hasVariations);
    if (el.variationModeWrap) {
      el.variationModeWrap.classList.toggle("hidden", !hasVariations);
    }
    if (el.variationModeHelp) {
      el.variationModeHelp.textContent = hasVariations
        ? "Selecione se deseja publicar como anuncio com variacoes ou como item unico."
        : "Sem variacoes detectadas no anuncio de origem.";
    }
    renderVariationEditors();
    setCloneMode(mode);

    el.draftSaleTerms.value = prettyJson(payload.sale_terms || []);
    el.draftNotes.value = draft.review_notes || "";
    clearInlineErrors();
    setReviewValidationSummary([]);
    el.validationBox.classList.add("hidden");
    el.validationBox.innerHTML = "";

    renderDraftSummary(draft);
    renderImageCardsFromPictures(payload.pictures);
    refreshPublishSummary(draft);
    renderDraftChecklist();
    renderDraftNotes(draft);
    const fromDraftResult =
      draft?.published_item_id || draft?.published_permalink || draft?.published_at
        ? {
            itemId: draft.published_item_id,
            permalink: draft.published_permalink,
            publishedAt: draft.published_at,
          }
        : null;
    if (fromDraftResult) {
      showPublishResult(fromDraftResult);
    } else {
      if (el.publishResult) el.publishResult.classList.add("hidden");
    }

    renderStepState();
    if (autoStep) {
      goToStep(2, { force: true });
    }
  }

  function renderDraftList(drafts) {
    el.draftList.innerHTML = "";

    if (!Array.isArray(drafts) || drafts.length === 0) {
      el.draftList.innerHTML =
        "<div class=\"clone-help\">Nenhum rascunho encontrado para a conta atual.</div>";
      return;
    }

    el.draftList.classList.add("listing-clone-drafts-grid");
    for (const draft of drafts) {
      const item = document.createElement("article");
      item.className = "listing-clone-draft-card draft-item";

      const left = document.createElement("div");
      const title = document.createElement("div");
      title.className = "draft-item__title";
      title.textContent =
        draft?.source_title || draft?.source_item_id || `Rascunho #${draft.id}`;

      const meta = document.createElement("div");
      meta.className = "draft-item__meta";
      const platform = toText(draft?.draft_payload?.source_platform || draft?.source_platform)
        .toLowerCase();
      const platformLabel =
        platform === "shopee"
          ? "Shopee"
          : platform === "mercadolivre"
            ? "Mercado Livre"
            : "";
      const publishedPart = draft.published_item_id
        ? ` | MLB ${draft.published_item_id}`
        : "";
      meta.textContent = `${platformLabel ? `${platformLabel} | ` : ""}${draft.source_item_id} | ${draft.status}${publishedPart} | ${new Date(draft.created_at).toLocaleString("pt-BR")}`;
      left.appendChild(title);
      left.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "listing-clone-draft-card__actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-ghost";
      button.textContent = "Abrir";
      button.addEventListener("click", () => openDraft(draft.id));
      actions.appendChild(button);

      item.appendChild(left);
      item.appendChild(actions);
      el.draftList.appendChild(item);
    }
  }

  function collectDraftPatch() {
    const attributes = syncAdvancedAttributesTextarea();
    const attributesExtra = parseAttributesJsonText(el.draftAttributesExtra?.value || "[]");
    const mergedAttributes = mergeAttributesById(attributes || [], attributesExtra || []);
    const saleTermsText = String(el.draftSaleTerms.value || "").trim();
    const shippingPatch = collectShippingPatchFromEditors();
    const listingTypeId = toText(el.draftListingType?.value).toLowerCase();
    const condition = toText(el.draftCondition?.value).toLowerCase();
    const selectedCloneMode = normalizeCloneMode(
      el.cloneModeVariacoes?.checked ? "variacoes" : "unitario",
      state.variationEditorModel.length > 0,
    );
    const selectedVariations =
      selectedCloneMode === "variacoes" ? collectVariationPatch() : [];
    if (
      selectedCloneMode === "variacoes" &&
      state.variationEditorModel.length > 0 &&
      selectedVariations.length === 0
    ) {
      throw new Error(
        "Ative ao menos uma variacao para publicar no modo com variacoes.",
      );
    }

    return {
      title: el.draftTitle.value,
      family_name: el.draftFamilyName?.value || "",
      clone_mode: selectedCloneMode,
      price: el.draftPrice.value,
      available_quantity: el.draftQty.value,
      category_id: el.draftCategory.value,
      listing_type_id: listingTypeId,
      condition,
      description_plain_text: el.draftDescription.value,
      pictures: el.draftPictures.value,
      attributes: JSON.stringify(mergedAttributes || []),
      attributes_extra: JSON.stringify(attributesExtra || []),
      variations: JSON.stringify(selectedVariations),
      sale_terms: saleTermsText || "[]",
      shipping: JSON.stringify(shippingPatch),
      review_notes: el.draftNotes.value,
      status: "em_revisao",
    };
  }

  async function persistDraftPatch({
    silent = true,
    refreshList = false,
    busyButton = null,
    busyLabel = "Salvando...",
  } = {}) {
    if (!state.currentDraft?.id) {
      throw new Error("Nenhum rascunho selecionado para salvar.");
    }

    if (busyButton) setBusy(busyButton, true, busyLabel);
    try {
      const response = await request(`/drafts/${state.currentDraft.id}`, {
        method: "PUT",
        body: collectDraftPatch(),
      });
      if (response?.draft) {
        showDraft(response.draft, { autoStep: false });
        refreshPublishSummary(response.draft);
      }
      if (refreshList) {
        await loadDrafts();
      }
      if (!silent) {
        setFeedback("Revisao salva com sucesso.", "ok");
      }
      return response?.draft || null;
    } finally {
      if (busyButton) setBusy(busyButton, false);
    }
  }

  function clearCurrentCloneState() {
    state.currentDraft = null;
    state.activeSubtab = "editor";
    state.cloneMode = "unitario";
    state.variationEditorModel = [];

    if (el.reviewSection) {
      el.reviewSection.classList.add("hidden-step");
    }

    if (el.reviewValidationSummary) {
      el.reviewValidationSummary.classList.add("hidden");
      el.reviewValidationSummary.innerHTML = "";
    }
    if (el.validationBox) {
      el.validationBox.classList.add("hidden");
      el.validationBox.innerHTML = "";
    }

    resetPublishVisuals();
    clearInlineErrors();
    setReviewValidationSummary([]);
    goToStep(1, { force: true });
  }

  function showValidationResult(result) {
    const isOk = !!result?.ok;
    const data = result?.validation || {};

    const title = isOk
      ? "Validacao concluida sem erro bloqueante."
      : "Validacao retornou alertas/erros para ajuste.";

    el.validationBox.classList.remove("hidden");
    el.validationBox.innerHTML = `
      <strong>${title}</strong>
      <div>Status HTTP: ${data.http_status ?? "-"}</div>
      <pre>${prettyJson(data.response || {})}</pre>
    `;
  }

  function applyMlValidationHints(result) {
    const validation = result?.validation || result?.details?.validation || null;
    const responseBody = validation?.validation?.response || validation?.response || {};
    const responseError = toText(responseBody?.error).toLowerCase();
    const responseMessage = toText(responseBody?.message).toLowerCase();
    const causes = Array.isArray(responseBody?.cause) ? responseBody.cause : [];

    const invalidFieldKeys = new Set();
    const addField = (fieldName) => {
      const key = toText(fieldName).toLowerCase();
      if (key) invalidFieldKeys.add(key);
    };

    const isLikelyFieldToken = (rawToken) => {
      const token = toText(rawToken).toLowerCase();
      if (!token) return false;

      const normalized = token
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      const blocked = new Set([
        "ft",
        "mil",
        "um",
        "in",
        "u",
        "yd",
        "m",
        "km",
        "cm",
        "nm",
        "polegadas",
        "milhas",
        "mm",
        "maos",
        "kg",
        "g",
        "lb",
        "oz",
      ]);
      if (blocked.has(normalized)) return false;

      if (!/^[a-z0-9_.-]+$/i.test(normalized)) return false;
      if (normalized.length < 3) return false;
      if (normalized.length < 4 && normalized !== "gtin") return false;
      if (
        normalized !== "gtin" &&
        !normalized.includes("_") &&
        !normalized.includes(".")
      ) {
        return false;
      }
      return true;
    };

    const extractBracketFields = (text) => {
      const source = String(text || "");
      const fields = [];
      const regex = /\[([^\]]+)\]/g;
      let match = null;
      while ((match = regex.exec(source)) !== null) {
        const chunk = String(match?.[1] || "");
        for (const entry of chunk.split(",")) {
          const token = toText(entry).toLowerCase();
          if (!isLikelyFieldToken(token)) continue;
          fields.push(token);
        }
      }
      return Array.from(new Set(fields));
    };

    extractBracketFields(responseBody?.error).forEach(addField);
    extractBracketFields(responseBody?.message).forEach(addField);

    for (const cause of causes) {
      const code = toText(cause?.code).toLowerCase();
      const message = toText(cause?.message).toLowerCase();
      if (code.includes("title") || message.includes("title")) addField("title");
      if (code.includes("family_name") || message.includes("family_name")) {
        addField("family_name");
      }
      const refs = Array.isArray(cause?.references) ? cause.references : [];
      refs.forEach((ref) => addField(ref));
      extractBracketFields(cause?.message).forEach(addField);
    }

    if (
      !invalidFieldKeys.size &&
      responseMessage.includes("body.invalid_fields") &&
      responseError.includes("title")
    ) {
      addField("title");
    }

    if (
      !invalidFieldKeys.size &&
      responseMessage.includes("body.required_fields") &&
      responseError.includes("family_name")
    ) {
      addField("family_name");
    }

    if (!invalidFieldKeys.size && !causes.length) return;

    clearInlineErrors();
    const summaryErrors = [];
    const seenSummary = new Set();
    const pushSummary = (message) => {
      const text = toText(message);
      if (!text) return;
      if (seenSummary.has(text)) return;
      seenSummary.add(text);
      summaryErrors.push({ message: text });
    };

    const mark = (target, message) => {
      if (!target) return;
      addInlineError(target, message);
      pushSummary(message);
    };

    const extractQuotedFields = (text) => {
      const source = String(text || "");
      const matches = [];
      const regex = /["“”']([^"“”']{2,80})["“”']/g;
      let match = null;
      while ((match = regex.exec(source)) !== null) {
        const value = toText(match[1]);
        if (!value) continue;
        matches.push(value);
      }
      return matches;
    };

    if (invalidFieldKeys.has("title")) {
      mark(el.draftTitle, "Titulo invalido segundo validacao do Mercado Livre.");
    }
    if (invalidFieldKeys.has("family_name")) {
      mark(el.draftFamilyName, "Family name invalido ou ausente para esta categoria.");
    }
    if (invalidFieldKeys.has("price")) {
      mark(el.draftPrice, "Preco invalido para publicar.");
    }
    if (invalidFieldKeys.has("available_quantity")) {
      mark(el.draftQty, "Quantidade invalida.");
    }
    if (invalidFieldKeys.has("listing_type_id")) {
      mark(el.draftListingType, "Tipo de anuncio invalido.");
    }
    if (invalidFieldKeys.has("condition")) {
      mark(el.draftCondition, "Condicao invalida.");
    }
    if (invalidFieldKeys.has("attributes")) {
      mark(
        el.draftAttributesMain || el.draftAttributesSecondary,
        "Revise os atributos obrigatorios do produto.",
      );
    }
    if (invalidFieldKeys.has("variations")) {
      mark(
        el.variationSection || el.variationModeWrap,
        "Revise as variacoes e os campos de cada uma.",
      );
    }
    if (invalidFieldKeys.has("pictures")) {
      mark(el.draftPictures, "Revise as URLs de imagens enviadas.");
    }
    if (invalidFieldKeys.has("description")) {
      mark(el.draftDescription, "Descricao invalida para a categoria.");
    }
    if (invalidFieldKeys.has("sale_terms")) {
      mark(el.draftSaleTerms, "Termos de venda invalidos.");
    }
    if (invalidFieldKeys.has("shipping")) {
      mark(
        el.draftShippingMode || el.draftShippingFree || el.draftAttributesMain,
        "Configuracao de envio invalida para esta categoria/conta.",
      );
    }

    for (const key of invalidFieldKeys) {
      const normalizedKey = normalizeFieldKey(key);
      let control = findAttributeControlByKey(key);
      if (!control) {
        if (!NON_ATTRIBUTE_VALIDATION_KEYS.has(normalizedKey)) {
          control = ensureDraftAttributeControl(key, { required: true });
        }
      }
      if (control) {
        if (!NON_ATTRIBUTE_VALIDATION_KEYS.has(normalizedKey)) {
          markAttributeControlAsRequired(control);
        }
        mark(control, `Atributo obrigatorio pendente/invalido: ${key}.`);
      }
    }

    for (const cause of causes) {
      const causeMessage = toText(cause?.message);
      const causeCode = toText(cause?.code).toLowerCase();
      const refs = Array.isArray(cause?.references) ? cause.references : [];
      const refsNormalized = refs.map((entry) => toText(entry).toLowerCase());
      const quotedFields = extractQuotedFields(cause?.message);
      const bracketFields = extractBracketFields(cause?.message);

      if (causeMessage) pushSummary(causeMessage);
      if (
        causeCode.includes("item.attribute.missing") ||
        refsNormalized.some((entry) => entry.includes("item.attributes"))
      ) {
        if (el.draftAttributesMain || el.draftAttributesSecondary) {
          mark(
            el.draftAttributesMain || el.draftAttributesSecondary,
            "Existem atributos obrigatorios pendentes para publicar.",
          );
        }
      }

      for (const attrField of bracketFields) {
        const normalizedField = normalizeFieldKey(attrField);
        let control = findAttributeControlByKey(attrField);
        if (!control) {
          if (!NON_ATTRIBUTE_VALIDATION_KEYS.has(normalizedField)) {
            control = ensureDraftAttributeControl(attrField, { required: true });
          }
        }
        if (control) {
          if (!NON_ATTRIBUTE_VALIDATION_KEYS.has(normalizedField)) {
            markAttributeControlAsRequired(control);
          }
          mark(control, `Atributo obrigatorio pendente/invalido: ${attrField}.`);
        }
      }

      for (const attrLabel of quotedFields) {
        const control = findAttributeControlByLabel(attrLabel);
        if (control) {
          mark(control, `Campo obrigatorio pendente: ${attrLabel}.`);
        }
      }

      if (causeCode.includes("seller.package.dimensions")) {
        const dimensionsControls = [
          "seller_package_height",
          "seller_package_width",
          "seller_package_length",
          "seller_package_weight",
        ].map((fieldId) => ensureDraftAttributeControl(fieldId, { required: true }));
        dimensionsControls.forEach((control) => markAttributeControlAsRequired(control));
        mark(
          el.draftAttributesExtra || el.draftAttributesMain,
          "Preencha dimensoes de pacote (seller_package_height, seller_package_width, seller_package_length, seller_package_weight).",
        );
      }
    }

    if (!summaryErrors.length) {
      summaryErrors.push({
        message:
          "A validacao retornou campos invalidos. Revise titulo, family name, atributos e variacoes.",
      });
    }
    setReviewValidationSummary(summaryErrors);
  }

  async function saveReview() {
    try {
      await persistDraftPatch({
        silent: false,
        refreshList: true,
        busyButton: el.btnSaveReview,
        busyLabel: "Salvando...",
      });
    } catch (error) {
      setFeedback(error.message || "Falha ao salvar revisao.", "error");
    }
  }

  async function validateDraft() {
    if (!state.currentDraft?.id) {
      setFeedback("Nenhum rascunho selecionado para validar.", "warn");
      return;
    }

    const reviewValidation = validateReviewBeforePublish({ markUi: true });
    if (!reviewValidation.ok) {
      setFeedback(
        "Existem campos obrigatorios pendentes ou invalidos. Corrija antes de validar.",
        "error",
      );
      return;
    }

    setBusy(el.btnValidateDraft, true, "Validando...");
    try {
      await persistDraftPatch({
        silent: true,
        refreshList: false,
      });

      const response = await request(`/drafts/${state.currentDraft.id}/validate`, {
        method: "POST",
      });

      showValidationResult(response);
      applyMlValidationHints(response);
      setFeedback(
        response.ok
          ? "Validacao concluida. Voce ja pode ir para publicacao."
          : "Validacao retornou pontos para ajustar.",
        response.ok ? "ok" : "warn",
      );
      const refreshed = await request(`/drafts/${state.currentDraft.id}`);
      if (refreshed?.draft) showDraft(refreshed.draft, { autoStep: false });
      await loadDrafts();
    } catch (error) {
      if (error.status === 422 && error.payload?.validation) {
        showValidationResult(error.payload);
        applyMlValidationHints(error.payload);
        setFeedback("Validacao retornou erros de publicacao para corrigir.", "warn");
        return;
      }
      setFeedback(error.message || "Falha ao validar rascunho.", "error");
    } finally {
      setBusy(el.btnValidateDraft, false);
    }
  }

  async function publishDraft() {
    if (!state.currentDraft?.id) {
      setFeedback("Nenhum rascunho selecionado para publicar.", "warn");
      return;
    }

    const reviewValidation = validateReviewBeforePublish({ markUi: true });
    if (!reviewValidation.ok) {
      setFeedback(
        "Existem campos obrigatorios pendentes ou invalidos. Corrija antes de publicar.",
        "error",
      );
      return;
    }

    const publishButton = el.btnGoToPublish;
    setBusy(publishButton, true, "Publicando...");
    setFeedback("Publicacao iniciada. Aguarde o progresso...", "warn");
    startPublishProgress();

    try {
      await persistDraftPatch({
        silent: true,
        refreshList: false,
      });

      const response = await request(`/drafts/${state.currentDraft.id}/publish`, {
        method: "POST",
      });

      const draft = response?.draft || state.currentDraft;
      if (draft) {
        showDraft(draft, { autoStep: false });
      }
      await loadDrafts();

      const publication = response?.publication || {};
      const itemId = publication.item_id || draft?.published_item_id || null;
      const permalink = publication.permalink || draft?.published_permalink || null;
      const publishedAt = publication.published_at || draft?.published_at || null;

      finishPublishProgress({
        success: true,
        label: "Publicacao concluida com sucesso.",
        hint: itemId
          ? `Novo anuncio criado: ${itemId}`
          : "Novo anuncio criado no Mercado Livre.",
      });

      showPublishResult({ itemId, permalink, publishedAt });
      goToStep(2, { force: true });
      setFeedback(
        itemId
          ? `Anuncio publicado com sucesso. MLB gerado: ${itemId}.`
          : "Anuncio publicado com sucesso.",
        "ok",
      );
    } catch (error) {
      finishPublishProgress({
        success: false,
        label: "Falha na publicacao.",
        hint: error.message || "Revise os dados e tente novamente.",
      });

      const validation =
        error?.payload?.details?.validation ||
        error?.payload?.validation ||
        null;
      if (validation) {
        showValidationResult(validation);
        applyMlValidationHints(validation);
        goToStep(2, { force: true });
      }

      setFeedback(error.message || "Falha ao publicar rascunho.", "error");
    } finally {
      setBusy(publishButton, false);
    }
  }

  function cancelCurrentClone() {
    if (!window.confirm("Cancelar a clonagem atual e limpar a ficha em edicao?")) {
      return;
    }
    clearCurrentCloneState();
    setFeedback("Clonagem atual limpa. Voce pode iniciar um novo clone.", "warn");
  }

  async function openDraft(id) {
    try {
      const response = await request(`/drafts/${id}`);
      if (response?.draft) {
        state.activeSubtab = "editor";
        resetPublishVisuals();
        showDraft(response.draft);
        setFeedback(`Rascunho #${id} carregado.`, "ok");
      }
    } catch (error) {
      setFeedback(error.message || "Falha ao abrir rascunho.", "error");
    }
  }

  async function loadDrafts({ quiet = false } = {}) {
    try {
      const response = await request("/drafts?limit=20");
      state.drafts = Array.isArray(response?.drafts) ? response.drafts : [];
      renderDraftList(state.drafts);
    } catch (error) {
      state.drafts = [];
      renderDraftList([]);
      if (!quiet) {
        setFeedback(error.message || "Falha ao listar rascunhos.", "error");
      }
    }
  }

  function bindEvents() {
    el.btnSaveReview?.addEventListener("click", saveReview);
    el.btnValidateDraft?.addEventListener("click", validateDraft);
    el.btnGoToPublish?.addEventListener("click", publishDraft);
    el.btnCancelClone?.addEventListener("click", cancelCurrentClone);
    el.btnReloadDrafts?.addEventListener("click", () => switchSubtab("drafts"));
    for (const subtabButton of el.subtabButtons) {
      subtabButton.addEventListener("click", () => {
        switchSubtab(subtabButton.getAttribute("data-clone-subtab"));
      });
    }
    el.cloneModeUnitario?.addEventListener("change", () => {
      if (el.cloneModeUnitario.checked) setCloneMode("unitario");
    });
    el.cloneModeVariacoes?.addEventListener("change", () => {
      if (el.cloneModeVariacoes.checked) setCloneMode("variacoes");
    });

    const attributeEditors = [el.draftAttributesMain, el.draftAttributesSecondary];
    for (const editor of attributeEditors) {
      editor?.addEventListener("input", syncAdvancedAttributesTextarea);
      editor?.addEventListener("change", syncAdvancedAttributesTextarea);
    }

    document.addEventListener("click", (event) => {
      const boolButton = event.target.closest(".segmented button");
      if (!boolButton) return;
      boolButton.parentElement.querySelectorAll("button").forEach((button) => {
        button.classList.toggle("active", button === boolButton);
      });
      syncAdvancedAttributesTextarea();
    });

    document.addEventListener("change", (event) => {
      const na = event.target.closest("[data-na-for]");
      if (!na) return;
      const row = na.closest(".attr-row");
      row?.querySelectorAll(".attr-value, .segmented button, [data-unit-for]").forEach((node) => {
        node.disabled = na.checked;
      });
      syncAdvancedAttributesTextarea();
    });

    el.reviewSection?.addEventListener("input", (event) => {
      const target = event?.target;
      if (!(target instanceof HTMLElement)) return;
      target.classList.remove("is-invalid");
      target.setAttribute("aria-invalid", "false");
      const container = target.closest(
        "label, .attr-row, .variation-card, .variation-mode, .attr-section",
      );
      if (container && container.classList.contains("is-invalid")) {
        container.classList.remove("is-invalid");
        const inline = container.querySelector(".field-error-inline");
        if (inline) inline.remove();
      }
    });
  }

  bindEvents();
  setupBookmarklet();
  setupBrowserCaptureReceiver();
  renderStepState();
  setCloneMode("unitario");
  resetPublishVisuals();
  loadDrafts();
})();
