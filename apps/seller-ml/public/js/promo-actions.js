// promo-actions.js
// Fluxos de acoes em massa da central de promocoes.
(function initPromoActions(global) {
  "use strict";

  if (!global || global.PromoActions) return;

  function hasReadableAccountText(value) {
    return /[A-Za-zÀ-ÿ]/.test(String(value || "").trim());
  }

  function readShellAccountLabel() {
    const raw = String(document.getElementById("account-current")?.textContent || "").trim();
    if (!raw) return "";
    if (/carregando|indispon|nenhuma selecionada/i.test(raw)) return "";
    return raw;
  }

  function normalizeAccountContext(raw = {}) {
    const key = String(raw.key || raw.accountKey || "").trim();
    const label = String(raw.label || raw.accountLabel || "").trim();
    return {
      key,
      label: label || (hasReadableAccountText(key) ? key : ""),
    };
  }

  async function resolveCurrentAccountContext(withBase) {
    const shellLabel = readShellAccountLabel();
    const current = normalizeAccountContext(global.__ACCOUNT__ || {});
    if (current.key || current.label) {
      return {
        key: current.key,
        label: shellLabel || current.label || current.key,
      };
    }

    if (shellLabel) {
      return { key: "", label: shellLabel };
    }

    try {
      const response = await fetch(withBase("/api/account/current"), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload = await response.json().catch(() => ({}));
      const resolved = normalizeAccountContext({
        key: payload?.accountKey || payload?.key || payload?.current?.id || "",
        label: payload?.label || payload?.current?.label || "",
      });
      if (resolved.key || resolved.label) {
        global.__ACCOUNT__ = {
          ...(global.__ACCOUNT__ || {}),
          ...(resolved.key ? { key: resolved.key } : {}),
          label: resolved.label || resolved.key || shellLabel || "Conta selecionada",
        };
      }
      return normalizeAccountContext(global.__ACCOUNT__ || resolved);
    } catch {
      return { key: "", label: shellLabel || "" };
    }
  }

  function isStrictPreparedSelectionType(type) {
    const typeUp = String(type || "").toUpperCase();
    return typeUp === "PRE_NEGOTIATED" || typeUp === "UNHEALTHY_STOCK";
  }

  function getActiveListMlbs(state) {
    if (
      state?.operationMode !== "list" ||
      !state?.listMode?.selectedCampaignId
    ) {
      return [];
    }
    const source = Array.isArray(state?.listMode?.activeMlbs) && state.listMode.activeMlbs.length
      ? state.listMode.activeMlbs
      : state.listMode.mlbs;
    if (!Array.isArray(source)) return [];
    return source
      .map((id) => String(id || "").trim().toUpperCase())
      .filter(Boolean);
  }

  function calcDealPriceFromItem(it, deps) {
    const {
      state,
      toNum,
      round2,
      resolveDealFinalAndPctFront,
      resolveDealManualPrice,
    } = deps;
    const orig = toNum(it.original_price ?? it.price ?? null);
    const typeUp = (state.selectedCard?.type || "").toUpperCase();

    if ((typeUp === "DEAL" || typeUp === "DOD" || typeUp === "LIGHTNING") && typeof resolveDealManualPrice === "function") {
      const manual = resolveDealManualPrice(it, { silent: true });
      if (manual != null) return round2(manual);
    }

    if (["DEAL", "SELLER_CAMPAIGN", "PRICE_DISCOUNT", "DOD", "LIGHTNING"].includes(typeUp)) {
      const { final } = resolveDealFinalAndPctFront({
        original_price: orig,
        status: it.status,
        deal_price: it.deal_price ?? it.new_price,
        min_discounted_price: it.min_discounted_price,
        max_discounted_price: it.max_discounted_price,
        price: it.price,
      });
      if (final != null) return round2(final);
    }

    const deal = toNum(it.deal_price ?? null);
    const d = toNum(it.discount_percentage);
    if (!Number.isNaN(deal) && deal != null) return round2(deal);
    if (orig != null && d != null) return round2(orig * (1 - d / 100));
    return null;
  }

  async function coletarTodosIdsFiltrados(deps) {
    const {
      state,
      PAGE_SIZE,
      itemsPaths,
      getJSONAny,
      normalizeStatus,
      dedupeByMLB,
      filtroToStatusParam,
      itemMatchesDiscountFilter,
      sortByMLBAsc,
    } = deps;

    if (!state.selectedCard) return [];
    const listMlbs = getActiveListMlbs(state);
    const listSet = listMlbs.length ? new Set(listMlbs) : null;
    const only = (state.mlbFilter || "").trim().toUpperCase();
    if (only) return [only];

    const statusParam = filtroToStatusParam();
    let token = null;
    const out = [];
    const seen = new Set();

    for (let i = 0; i < 500; i++) {
      const qs = deps.qsBuild({
        limit: PAGE_SIZE,
        ...(statusParam ? { status: statusParam } : {}),
        ...(token ? { search_after: token } : {}),
      });

      const data = await getJSONAny(
        itemsPaths(state.selectedCard.id, state.selectedCard.type, qs),
      );

      if (data?.promotion_benefits) {
        state.promotionBenefits = data.promotion_benefits;
      }

      let items = Array.isArray(data?.results) ? data.results : [];
      items = items.map((x) => ({ ...x, status: normalizeStatus(x.status) }));
      items = dedupeByMLB(items, statusParam || "");

      if (state.maxDesc != null) {
        const benefitsGlobal = state.promotionBenefits || state.selectedCard?.benefits || null;
        items = items.filter((x) => itemMatchesDiscountFilter(x, benefitsGlobal));
      }

      for (const it of items) {
        const id = String(it?.id || "").toUpperCase();
        if (!id || seen.has(id)) continue;
        if (listSet && !listSet.has(id)) continue;
        seen.add(id);
        out.push(id);
      }

      token = data?.paging?.searchAfter || null;
      if (!token) break;
    }

    out.sort(sortByMLBAsc);
    return out;
  }

  async function removerEmMassaSelecionados(deps) {
    const {
      state,
      HUD,
      withBase,
      getSelecionados,
      atualizarFaixaSelecaoCampanha,
      coletarTodosIdsFiltrados,
    } = deps;

    if (!state.selectedCard) {
      window.notifyPromocoes("Selecione uma campanha.");
      return;
    }

    let itens = getSelecionados();
    if (!itens.length) {
      const ok = confirm(
        "Nenhum item marcado. Deseja remover TODOS os itens filtrados da campanha?",
      );
      if (!ok) return;
      itens = await coletarTodosIdsFiltrados();
    }
    if (!itens.length) {
      window.notifyPromocoes("Nenhum item para remover.");
      return;
    }

    HUD.open(itens.length, "Remoção em massa");

    try {
      const r = await fetch(withBase("/api/promocoes/jobs/remove"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: itens, delay_ms: 250 }),
      });
      const resp = await r.json().catch(() => ({}));
      if (!r.ok || !resp.ok) {
        console.error("Falha ao iniciar remoção em massa", r.status, resp);
        state.applySession.errors++;
        HUD.render();
        window.notifyPromocoes("Falha ao iniciar remoção em massa.");
        return;
      }

      state.applySession.removed += itens.length;
      state.applySession.processed += itens.length;
      HUD.render();
      window.notifyPromocoes(`Remoção em massa iniciada para ${itens.length} item(ns).`);
    } catch (e) {
      console.error("Erro removerEmMassaSelecionados:", e);
      state.applySession.errors++;
      HUD.render();
      window.notifyPromocoes("Erro ao iniciar remoção em massa.");
    } finally {
      atualizarFaixaSelecaoCampanha();
    }
  }

  async function aplicarTodosFiltrados(deps) {
    const {
      state,
      HUD,
      withBase,
      filtroToStatusParam,
      isSellerCampaignSelected,
      isDealSelected,
      getSellerManualPercent,
      getDealManualPercent,
      sellerManualPercentInput,
      dealManualPercentInput,
      JobTitleCache,
      JobsWatcher,
      coletarTodosIdsFiltrados,
      getPromoBulkState,
      atualizarFaixaSelecaoCampanha,
      isManualWizardVerifiedForCurrent,
      manualWizardListMlbs,
    } = deps;

    if (!state.selectedCard) {
      window.notifyPromocoes("Selecione uma campanha.");
      return;
    }

    if (isSellerCampaignSelected() && getSellerManualPercent() == null) {
      window.notifyPromocoes(
        "Defina a Desc. alvo (%) para a seller campaign antes de iniciar a aplicação em massa.",
      );
      sellerManualPercentInput()?.focus();
      return;
    }

    if (isDealSelected && isDealSelected() && getDealManualPercent() == null) {
      window.notifyPromocoes(
        "Defina a Desc. alvo (%) para a deal antes de iniciar a aplicação em massa.",
      );
      dealManualPercentInput?.()?.focus();
      return;
    }

    if (!isDealSelected?.() && isSellerCampaignSelected() && getSellerManualPercent() == null) {
      sellerManualPercentInput()?.focus();
    }

    const manualWizardVerified =
      typeof isManualWizardVerifiedForCurrent === "function" &&
      isManualWizardVerifiedForCurrent();
    const manualWizardMlbs =
      typeof manualWizardListMlbs === "function" ? manualWizardListMlbs() : [];
    const manualWizardListApply = manualWizardVerified && manualWizardMlbs.length > 0;
    const manualWizardSelectionIds =
      manualWizardListApply && Array.isArray(state?.manualWizard?.selectionIds)
        ? state.manualWizard.selectionIds
            .map((id) => String(id || "").trim().toUpperCase())
            .filter(Boolean)
        : [];
    const manualWizardDiagnosticIds =
      manualWizardListApply && Array.isArray(state?.manualWizard?.listDiagnostics)
        ? [
            ...new Set(
              state.manualWizard.listDiagnostics
                .filter((row) => {
                  const result = String(row?.resultado || "").toLowerCase();
                  const applicable = String(row?.aplicavel || "").toLowerCase();
                  return result === "elegivel" || applicable === "sim";
                })
                .map((row) => String(row?.mlb || row?.mlb_id || "").trim().toUpperCase())
                .filter(Boolean),
            ),
          ]
        : [];
    const manualWizardApplyIds =
      manualWizardSelectionIds.length > 0
        ? manualWizardSelectionIds
        : manualWizardDiagnosticIds;
    const activeListMlbs = manualWizardListApply
      ? manualWizardApplyIds
      : getActiveListMlbs(state);
    const listModePercent =
      state?.operationMode === "list" && Number.isFinite(Number(state?.listMode?.percent))
        ? Number(state.listMode.percent)
        : null;
    const discountMax =
      listModePercent != null
        ? listModePercent
        : state.maxDesc != null
          ? Number(state.maxDesc)
          : null;
    const filters = {
      query_mlb: state.mlbFilter || null,
      query_mlbs: activeListMlbs.length ? activeListMlbs : null,
      status: (() => {
        const s = filtroToStatusParam();
        return s || "all";
      })(),
      discount_max: discountMax,
    };

    const buildCampaignName = () => {
      const n1 = state.selectedCard?.name || "";
      const n2 = (document.getElementById("campName")?.textContent || "")
        .replace(/^Campanha:\s*["“]?/, "")
        .replace(/["”]?$/, "")
        .trim();
      const n3 =
        state.cards.find?.((c) => c.id === state.selectedCard?.id)?.name || "";
      return n1 || n2 || n3 || String(state.selectedCard?.id || "Campanha");
    };

    const campaignName = buildCampaignName();
    const account = await resolveCurrentAccountContext(withBase);
    let localJobId = null;

    try {
      localJobId =
        global.JobsPanel?.addLocalJob?.({
          title: `Aplicando ${state.selectedCard?.type || ""} • ${campaignName}`,
          accountKey: account.key || null,
          accountLabel: account.label || null,
          state: "Preparando...",
          progress: 0,
        }) || null;
      global.JobsPanel?.show?.();
    } catch {}

    let expected_total = null;
    let selectionToken = manualWizardListApply && state?.manualWizard?.selectionToken
      ? String(state.manualWizard.selectionToken)
      : state?.operationMode === "list" && state?.listMode?.selectedToken
        ? String(state.listMode.selectedToken)
        : null;
    let preparedIds = manualWizardListApply && manualWizardApplyIds.length
      ? manualWizardApplyIds
      : null;
    let usingPreparedSelection = false;
    if (
      manualWizardListApply &&
      Number.isFinite(Number(state?.manualWizard?.eligibleTotal))
    ) {
      expected_total = Number(state.manualWizard.eligibleTotal);
    }

    try {
      const bulkState =
        (typeof getPromoBulkState === "function" ? getPromoBulkState() : null) ||
        global.PromoBulk?.getState?.() ||
        null;
      const samePromotion =
        String(bulkState?.promotion_id || "") === String(state.selectedCard?.id || "") &&
        String(bulkState?.promotion_type || "").toUpperCase() ===
          String(state.selectedCard?.type || "").toUpperCase();
      const hasPreparedGlobalSelection =
        samePromotion && !!bulkState?.global?.selectedAll;

      if (!manualWizardListApply && hasPreparedGlobalSelection) {
        const total = Number(bulkState?.global?.total || 0);
        expected_total = Number.isFinite(total) && total > 0 ? total : null;
        selectionToken = bulkState?.global?.token
          ? String(bulkState.global.token)
          : null;
        preparedIds = Array.isArray(bulkState?.global?.ids)
          ? bulkState.global.ids.map((id) => String(id || "").trim()).filter(Boolean)
          : null;
        usingPreparedSelection = true;
      }
    } catch {}

    if (!usingPreparedSelection && (!manualWizardListApply || !selectionToken)) {
      try {
        const scopedMlbs =
          manualWizardListApply && Array.isArray(preparedIds) && preparedIds.length
            ? preparedIds
            : activeListMlbs.length
              ? activeListMlbs
              : null;
        if (manualWizardListApply && !scopedMlbs?.length) {
          throw new Error("A lista foi verificada, mas nenhum MLB elegivel ficou disponivel para aplicar.");
        }
        const prepBody = {
          promotion_id: state.selectedCard.id,
          promotion_type: state.selectedCard.type,
          status: filtroToStatusParam() || null,
          mlb: state.mlbFilter || null,
          mlbs: scopedMlbs,
          percent_max: discountMax,
        };
        const prepResult = await global.PromoHttp?.postSelectionPrepare?.(prepBody);
        if (!prepResult?.ok) {
          throw new Error(
            prepResult?.data?.error ||
              prepResult?.error ||
              "Nao foi possivel validar a selecao no servidor.",
          );
        }
        if (prepResult?.ok && typeof prepResult?.data?.total === "number") {
          expected_total = prepResult.data.total;
        }
        if (prepResult?.ok && prepResult?.data?.token) {
          selectionToken = String(prepResult.data.token);
          if (state?.operationMode === "list" && state?.listMode) {
            state.listMode.selectedToken = selectionToken;
          }
        }
        if (prepResult?.ok && Array.isArray(prepResult?.data?.ids)) {
          preparedIds = prepResult.data.ids
            .map((id) => String(id || "").trim().toUpperCase())
            .filter(Boolean);
        }
        if (
          manualWizardListApply &&
          Array.isArray(scopedMlbs) &&
          scopedMlbs.length &&
          Number(expected_total) > scopedMlbs.length
        ) {
          throw new Error(
            "A preparacao da lista retornou mais itens que a lista verificada. Aplicacao bloqueada para evitar aplicar fora da lista.",
          );
        }
        if (
          prepResult?.ok &&
          state?.operationMode === "list" &&
          state?.listMode &&
          Array.isArray(prepResult?.data?.ids)
        ) {
          state.listMode.activeMlbs = prepResult.data.ids
            .map((id) => String(id || "").trim().toUpperCase())
            .filter(Boolean);
        }
      } catch (err) {
        console.warn("[promo-actions] aplicacao bloqueada na preparacao segura:", err);
        if (localJobId) {
          global.JobsPanel?.updateLocalJob?.(localJobId, {
            state: "falhou ao preparar selecao",
            progress: 0,
            completed: true,
            error: err?.message || "Nao foi possivel preparar a selecao no servidor.",
          });
        }
        window.notifyPromocoes(
          err?.message ||
            "Nao foi possivel validar a selecao no servidor. Nenhum anuncio foi alterado.",
        );
        return false;
      }
    }

    if (localJobId) {
      global.JobsPanel?.updateLocalJob?.(localJobId, {
        state:
          expected_total != null ? `queued 0/${expected_total}` : "Preparando selecao...",
        progress: 0,
      });
    }

    if (manualWizardListApply && !preparedIds?.length) {
      if (localJobId) {
        global.JobsPanel?.updateLocalJob?.(localJobId, {
          state: "falhou ao preparar lista",
          progress: 100,
        });
      }
      window.notifyPromocoes("Nao foi possivel recuperar os MLBs elegiveis da lista verificada. Refaça a verificacao da lista antes de aplicar.");
      return false;
    }

    HUD.open(expected_total ?? null, "Aplicação em massa");

    try {
      const options = { dryRun: false };
      if (typeof expected_total === "number") options.expected_total = expected_total;
      if (isSellerCampaignSelected()) {
        options.seller_manual_percent = getSellerManualPercent();
      }
      if (isDealSelected && isDealSelected()) {
        options.deal_manual_percent = getDealManualPercent();
      }
      if (
        String(state.selectedCard?.type || "").toUpperCase() === "LIGHTNING"
      ) {
        options.lightning_stock = Number(state.manualWizard?.quantity);
      }

      const hasPreparedIds = Array.isArray(preparedIds) && preparedIds.length > 0;
      const useListEndpoint = manualWizardListApply || (!selectionToken && hasPreparedIds);

      if (!selectionToken && !hasPreparedIds) {
        throw new Error(
          "A selecao segura nao ficou disponivel no servidor. Nenhum anuncio foi alterado. Refaça a preparacao e tente novamente.",
        );
      }

      const endpoint = useListEndpoint
        ? withBase("/api/promocoes/jobs/apply-list")
        : withBase("/api/promocoes/jobs/apply-mass");

      const payload = useListEndpoint
        ? {
            promotion_id: state.selectedCard.id,
            promotion_type: state.selectedCard.type,
            promotion_name: campaignName,
            status: filtroToStatusParam() || null,
            percent_max: discountMax,
            selection_ids: preparedIds,
            options,
          }
        : {
            token: selectionToken,
            action: "apply",
            promotion_name: campaignName,
            values: options,
          };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !(data?.success === true || data?.ok === true || data?.job_id)) {
        throw new Error(
          data?.error ||
            data?.message ||
            `Nao foi possivel iniciar o job seguro (HTTP ${res.status}).`,
        );
      }

      const realId = data?.job_id ? String(data.job_id) : null;
      if (!realId) {
        throw new Error("O backend nao retornou o identificador do job.");
      }

      if (localJobId) {
        JobTitleCache.set(
          realId,
          `Aplicando ${state.selectedCard?.type || ""} • ${campaignName}`,
        );
        global.JobsPanel?.replaceId?.(localJobId, realId);
        global.JobsPanel?.updateLocalJob?.(realId, {
          title: `Aplicando ${state.selectedCard?.type || ""} • ${campaignName}`,
          state:
            expected_total != null ? `queued 0/${expected_total}` : "na fila",
          progress: 0,
          total: expected_total,
        });
      }

      // Um unico watcher global acompanha todos os jobs. Isso evita o polling
      // duplicado por job que sobrecarregava /api/promocoes/jobs/:id.
      JobsWatcher.start?.();
      if (data?.reused === true) {
        window.notifyPromocoes(
          data?.reused_reason === "campaign_busy"
            ? `Esta campanha ja possui uma operacao aberta no job ${realId}. O job existente foi mantido.`
            : `Esta aplicacao ja estava na fila no job ${realId}. Nenhum job duplicado foi criado.`,
        );
      } else {
        window.notifyPromocoes(
          "Aplicacao enviada para a fila com validacao no backend. Acompanhe o progresso no painel de processos.",
        );
      }
      return true;
    } catch (e) {
      console.error("Erro aplicarTodosFiltrados:", e);
      if (localJobId) {
        global.JobsPanel?.updateLocalJob?.(localJobId, {
          state: "falhou ao iniciar",
          completed: true,
          error: e?.message || "Erro ao iniciar aplicacao.",
        });
      }
      state.applySession.errors++;
      HUD.render();
      window.notifyPromocoes(
        e?.message ||
          "Nao foi possivel iniciar a aplicacao segura. Nenhum fallback local foi executado.",
      );
      return false;
    } finally {
      if (typeof atualizarFaixaSelecaoCampanha === "function") {
        if (usingPreparedSelection) {
          const manualFlow = isDealSelected() || isSellerCampaignSelected();
          const manualPercent = isDealSelected()
            ? getDealManualPercent()
            : isSellerCampaignSelected()
              ? getSellerManualPercent()
              : null;
          global.PromoBulk?.setMeta?.({
            manualPercent,
            manualFlow,
            filterLimit: state.maxDesc != null ? Number(state.maxDesc) : null,
          });
        } else {
          atualizarFaixaSelecaoCampanha();
        }
      }
    }
  }

  global.PromoActions = {
    calcDealPriceFromItem,
    coletarTodosIdsFiltrados,
    removerEmMassaSelecionados,
    aplicarTodosFiltrados,
  };
})(window);
