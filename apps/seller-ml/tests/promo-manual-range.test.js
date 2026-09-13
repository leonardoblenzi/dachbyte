process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/test";
const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const {
  computeDealDiscountRange,
  isDealPercentWithinRange,
  isManualPercentApplicable,
  isEligible,
  resolveApplyMethodForItem,
  pickPromotionItemByStatus,
  evaluatePostApplySnapshot,
  evaluateAcceptedApplyResponse,
  classifyPostApplyReview,
  decidePostApplyContinuation,
  evaluatePromotionBatchFailure,
  buildPromotionResultsWorkbook,
  buildPromotionRollbackUrl,
  isPromotionReviewRow,
  resolvePendingResumeIds,
} = require("../services/promoJobsService")._test;

test("Smart considera elegivel somente oferta candidate", () => {
  const filters = { maxDesc: 23 };
  assert.equal(
    isEligible(
      { id: "MLB1", status: "candidate", original_price: 100, price: 80 },
      filters,
      "SMART",
      null,
      "min",
    ),
    true,
  );
  assert.equal(
    isEligible(
      { id: "MLB1", status: "started", original_price: 100, price: 80 },
      filters,
      "SMART",
      null,
      "min",
    ),
    false,
  );
});

test("Lightning considera elegivel somente oferta candidate", () => {
  const filters = { maxDesc: 23 };
  const base = {
    id: "MLB1",
    original_price: 100,
    min_discounted_price: 70,
    max_discounted_price: 90,
  };
  assert.equal(
    isEligible({ ...base, status: "candidate" }, filters, "LIGHTNING", null, "min"),
    true,
  );
  assert.equal(
    isEligible({ ...base, status: "started" }, filters, "LIGHTNING", null, "min"),
    false,
  );
});

test("Deal e Seller existentes usam PUT; candidatos usam POST", () => {
  assert.equal(resolveApplyMethodForItem("DEAL", { status: "started" }), "PUT");
  assert.equal(resolveApplyMethodForItem("SELLER_CAMPAIGN", { status: "pending" }), "PUT");
  assert.equal(resolveApplyMethodForItem("DEAL", { status: "candidate" }), "POST");
  assert.equal(resolveApplyMethodForItem("LIGHTNING", { status: "started" }), "POST");
});

test("DEAL aceita percentual candidato dentro da faixa", () => {
  const item = {
    status: "candidate",
    original_price: 100,
    min_discounted_price: 20,
    max_discounted_price: 95,
  };

  assert.deepEqual(computeDealDiscountRange(item), {
    minPrice: 20,
    maxPrice: 95,
    minPct: 5,
    maxPct: 80,
  });
  assert.equal(isDealPercentWithinRange(item, 18), true);
  assert.equal(isManualPercentApplicable(item, 18), true);
});

test("DEAL existente nao aceita percentual igual ou menor ao atual", () => {
  const item = {
    status: "started",
    original_price: 100,
    deal_price: 82,
    min_discounted_price: 20,
    max_discounted_price: 95,
  };

  assert.equal(isManualPercentApplicable(item, 18), false);
  assert.equal(isManualPercentApplicable(item, 19), true);
});

test("revalidacao seleciona a linha com o mesmo status validado", () => {
  const rows = [
    { id: "MLB1", status: "started" },
    { id: "MLB1", status: "candidate" },
  ];

  assert.equal(pickPromotionItemByStatus(rows, "candidate")?.status, "candidate");
  assert.equal(pickPromotionItemByStatus(rows, "started")?.status, "started");
  assert.equal(pickPromotionItemByStatus(rows, "scheduled"), null);
});


test("confirmacao pos-aplicacao aceita percentual manual dentro da tolerancia", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: { status: "started", original_price: 100, deal_price: 82 },
    item: { original_price: 100 },
    promotion_type: "DEAL",
    requested_percent: 18,
  });

  assert.equal(result.ok, true);
  assert.equal(result.actual_percent, 18);
  assert.equal(result.max_allowed_percent, 19);
});

test("confirmacao pos-aplicacao aceita normalizacao de um ponto abaixo pelo ML", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: { status: "started", original_price: 684.9, deal_price: 568.47 },
    item: { original_price: 684.9 },
    promotion_type: "DEAL",
    requested_percent: 18,
  });

  assert.equal(result.ok, true);
  assert.equal(result.actual_percent, 17);
  assert.equal(result.min_allowed_percent, 17);
});

test("confirmacao pos-aplicacao bloqueia percentual manual mais de um ponto abaixo", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: { status: "started", original_price: 100, deal_price: 84 },
    item: { original_price: 100 },
    promotion_type: "DEAL",
    requested_percent: 18,
  });

  assert.equal(result.ok, false);
  assert.equal(result.actual_percent, 16);
});
test("confirmacao pos-aplicacao bloqueia percentual manual acima do solicitado", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: { status: "started", original_price: 100, deal_price: 70 },
    item: { original_price: 100 },
    promotion_type: "SELLER_CAMPAIGN",
    requested_percent: 18,
  });

  assert.equal(result.ok, false);
  assert.equal(result.actual_percent, 30);
});

test("confirmacao usa preco final ao comprador quando o ML aplica boost", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: {
      status: "started",
      original_price: 100,
      deal_price: 83,
      boosted_offer: true,
      total_price_for_boosted_offer: 70,
    },
    item: { original_price: 100 },
    promotion_type: "DEAL",
    requested_percent: 17,
  });

  assert.equal(result.ok, false);
  assert.equal(result.base_offer_percent, 17);
  assert.equal(result.actual_percent, 30);
  assert.equal(result.buyer_price, 70);
  assert.equal(result.boosted_offer, true);
});

test("confirmacao aceita boost que mantem o preco final dentro da tolerancia", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: {
      status: "started",
      original_price: 100,
      deal_price: 83,
      boosted_offer: true,
      total_price_for_boosted_offer: 82,
    },
    item: { original_price: 100 },
    promotion_type: "DEAL",
    requested_percent: 17,
  });

  assert.equal(result.ok, true);
  assert.equal(result.actual_percent, 18);
});

test("retomada inclui somente MLBs ainda nao processados", () => {
  const pending = resolvePendingResumeIds(
    ["MLB1", "MLB2", "MLB3", "MLB4"],
    [
      { mlb_id: "MLB1", success: true },
      { mlb_id: "MLB2", success: false, safety_circuit_breaker: true },
    ],
  );

  assert.deepEqual(pending, ["MLB3", "MLB4"]);
});

test("classifica somente percentual acima como revisao critica", () => {
  assert.deepEqual(
    classifyPostApplyReview({ actual_percent: 30, min_allowed_percent: 16, max_allowed_percent: 18 }),
    { code: "PERCENTUAL_ACIMA", severity: "critical", critical: true },
  );
  assert.deepEqual(
    classifyPostApplyReview({ actual_percent: 13, min_allowed_percent: 16, max_allowed_percent: 18 }),
    { code: "PERCENTUAL_ABAIXO", severity: "warning", critical: false },
  );
  assert.deepEqual(
    classifyPostApplyReview({ actual_percent: null }),
    { code: "CONFIRMACAO_INCONCLUSIVA", severity: "critical", critical: true },
  );
});

test("rollback direcionado inclui campanha e tipo na URL", () => {
  assert.equal(
    buildPromotionRollbackUrl({
      item_id: "MLB123",
      promotion_id: "P-MLB456",
      promotion_type: "deal",
    }),
    "https://api.mercadolibre.com/seller-promotions/items/MLB123?promotion_type=DEAL&promotion_id=P-MLB456&app_version=v2",
  );
});

test("CSV de revisoes exclui aplicacoes confirmadas", () => {
  assert.equal(isPromotionReviewRow({ status: "success", success: true }), false);
  assert.equal(isPromotionReviewRow({ status: "review", success: false }), true);
  assert.equal(isPromotionReviewRow({ status: "error", success: false }), true);
});

test("confirmacao Smart exige desconto dentro do teto", () => {
  const accepted = evaluatePostApplySnapshot({
    snapshot: {
      status: "started",
      original_price: 100,
      price: 82,
      offer_id: "OFFER-1",
    },
    item: {},
    promotion_type: "SMART",
    max_discount_percent: 18,
    expected_offer_id: "OFFER-1",
  });
  const rejected = evaluatePostApplySnapshot({
    snapshot: {
      status: "started",
      original_price: 100,
      price: 75,
      offer_id: "OFFER-2",
    },
    item: {},
    promotion_type: "SMART",
    max_discount_percent: 18,
    expected_offer_id: "OFFER-1",
  });

  assert.equal(accepted.ok, true);
  assert.equal(accepted.actual_percent, 18);
  assert.equal(rejected.ok, false);
});

test("resposta 2xx do ML sustenta aplicacao Lightning enquanto confirmacao propaga", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {
        offer_id: "OFFER-MLB1-1",
        price: 958.57,
        original_price: 1244.9,
      },
      trace: {
        payload: {
          promotion_id: "LGH-MLB1000",
          promotion_type: "LIGHTNING",
          deal_price: 958.57,
          stock: 5,
        },
      },
    },
    item: { original_price: 1244.9 },
    promotion_type: "LIGHTNING",
    requested_percent: 23,
  });

  assert.equal(result.ok, true);
  assert.equal(result.confirmation_deferred, true);
  assert.equal(result.actual_percent, 23);
});

test("resposta 2xx do ML nao sustenta percentual manual acima do permitido", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {
        price: 700,
        original_price: 1000,
      },
    },
    item: { original_price: 1000 },
    promotion_type: "SELLER_CAMPAIGN",
    requested_percent: 13,
  });

  assert.equal(result, null);
});

test("resposta 2xx Deal sustenta aplicacao manual enquanto confirmacao propaga", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {
        price: 820,
        original_price: 1000,
      },
    },
    item: { original_price: 1000 },
    promotion_type: "DEAL",
    requested_percent: 18,
  });

  assert.equal(result.ok, true);
  assert.equal(result.confirmation_deferred, true);
  assert.equal(result.actual_percent, 18);
});

test("resposta 2xx Seller sustenta aplicacao manual enquanto confirmacao propaga", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {
        deal_price: 870,
        original_price: 1000,
      },
    },
    item: { original_price: 1000 },
    promotion_type: "SELLER_CAMPAIGN",
    requested_percent: 13,
  });

  assert.equal(result.ok, true);
  assert.equal(result.confirmation_deferred, true);
  assert.equal(result.actual_percent, 13);
});

test("resposta 2xx Smart exige teto respeitado", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {
        offer_id: "OFFER-1",
        price: 770,
        original_price: 1000,
      },
      trace: {
        payload: {
          offer_id: "OFFER-1",
        },
      },
    },
    item: { original_price: 1000 },
    promotion_type: "SMART",
    max_discount_percent: 23,
    expected_offer_id: "OFFER-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.confirmation_deferred, true);
  assert.equal(result.actual_percent, 23);
});

test("confirmacao Smart aceita offer diferente quando desconto fica dentro do teto", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: {
      status: "started",
      original_price: 1000,
      price: 775.2,
      offer_id: "OFFER-MLB1-OUTRO",
    },
    item: {},
    promotion_type: "SMART",
    max_discount_percent: 23,
    expected_offer_id: "OFFER-MLB1-ESPERADO",
  });

  assert.equal(result.ok, true);
  assert.equal(result.actual_percent, 22.48);
  assert.equal(result.offer_match_required, false);
  assert.equal(result.offer_match_confirmed, false);
});

test("confirmacao de oferta estrita continua exigindo offer selecionada", () => {
  const result = evaluatePostApplySnapshot({
    snapshot: {
      status: "started",
      original_price: 1000,
      price: 775.2,
      offer_id: "OFFER-MLB1-OUTRO",
    },
    item: {},
    promotion_type: "PRE_NEGOTIATED",
    max_discount_percent: 23,
    expected_offer_id: "OFFER-MLB1-ESPERADO",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "offer_id confirmado no ML difere da oferta selecionada");
  assert.equal(result.offer_match_required, true);
});

test("resposta 2xx Smart aceita conversao de candidate para offer do ML", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {
        offer_id: "OFFER-MLB1-2",
        price: 1062.71,
        original_price: 1352.9,
      },
      trace: {
        payload: {
          offer_id: "CANDIDATE-MLB1-1",
        },
      },
    },
    item: { original_price: 1352.9 },
    promotion_type: "SMART",
    max_discount_percent: 23,
    expected_offer_id: "CANDIDATE-MLB1-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.confirmation_deferred, true);
  assert.equal(result.actual_percent, 21.45);
});

test("falha isolada de item continua sem pausar o lote", () => {
  const decision = evaluatePromotionBatchFailure(
    { status: 409, error: "candidate not valid" },
    { signature: null, consecutive: 0 },
  );

  assert.equal(decision.action, "continue");
  assert.equal(decision.systemic, false);
  assert.equal(decision.consecutive, 0);
});

test("falha de autenticacao pausa o lote imediatamente", () => {
  const decision = evaluatePromotionBatchFailure(
    { status: 401, error: "unauthorized" },
    { signature: null, consecutive: 0 },
  );

  assert.equal(decision.action, "pause");
  assert.equal(decision.signature, "AUTH_401");
  assert.equal(decision.consecutive, 1);
});

test("falhas transitorias repetidas pausam somente no terceiro item", () => {
  const first = evaluatePromotionBatchFailure(
    { status: 503, error: "service unavailable" },
    {},
  );
  const second = evaluatePromotionBatchFailure(
    { status: 502, error: "bad gateway" },
    first,
  );
  const third = evaluatePromotionBatchFailure(
    { status: 500, error: "internal error" },
    second,
  );

  assert.equal(first.action, "continue");
  assert.equal(second.action, "continue");
  assert.equal(third.action, "pause");
  assert.equal(third.consecutive, 3);
});

test("sucesso de rollback libera continuacao para todos os tipos protegidos", () => {
  for (const promotionType of ["DEAL", "SELLER_CAMPAIGN", "SMART", "LIGHTNING"]) {
    const decision = decidePostApplyContinuation(
      { code: "PERCENTUAL_ACIMA", severity: "critical", critical: true },
      { ok: true, promotion_type: promotionType },
    );
    assert.equal(decision.action, "continue", promotionType);
    assert.equal(decision.code, "ROLLBACK_CONFIRMED_CONTINUED", promotionType);
  }
});

test("estado perigoso sem rollback confirmado pausa o lote", () => {
  const decision = decidePostApplyContinuation(
    { code: "PERCENTUAL_ACIMA", severity: "critical", critical: true },
    { ok: false, status: 409 },
  );

  assert.equal(decision.action, "pause");
  assert.equal(decision.code, "UNSAFE_STATE_REMAINS_ACTIVE");
});

test("primeira divergencia isolada entra em quarentena e o lote continua", () => {
  const decision = decidePostApplyContinuation(
    { code: "PERCENTUAL_ACIMA", severity: "critical", critical: true },
    { ok: false, status: 409 },
    { criticalOccurrence: 1, remediationQueued: true },
  );

  assert.equal(decision.action, "continue");
  assert.equal(decision.code, "QUARANTINED_FOR_REMEDIATION");
});

test("segunda divergencia critica pausa mesmo com remediacao enfileirada", () => {
  const decision = decidePostApplyContinuation(
    { code: "PERCENTUAL_ACIMA", severity: "critical", critical: true },
    { ok: false, status: 409 },
    { criticalOccurrence: 2, remediationQueued: true },
  );

  assert.equal(decision.action, "pause");
  assert.equal(decision.code, "REPEATED_CRITICAL_DIVERGENCE");
});

test("Excel do job traz resultado completo e erros com percentuais numericos", async () => {
  const buffer = await buildPromotionResultsWorkbook([
    {
      mlb_id: "MLB1",
      status: "success",
      success: true,
      requested_percent: 13,
      estimated_percent: 13,
      real_applied_percent: 13.4,
      post_apply_confirmed: true,
      batch_decision: "continue",
    },
    {
      mlb_id: "MLB2",
      status: "error",
      success: false,
      requested_percent: 18,
      estimated_percent: 18,
      real_applied_percent: null,
      batch_decision: "continue",
      error_message: "candidate not valid",
      quarantine_status: "queued",
      remediation_job_id: "promo-remediation-1-MLB2",
    },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const complete = workbook.getWorksheet("Resultado completo");
  const reviews = workbook.getWorksheet("Erros e revisoes");
  const quarantine = workbook.getWorksheet("Quarentena");
  assert.ok(complete);
  assert.ok(reviews);
  assert.ok(quarantine);
  assert.equal(complete.rowCount, 3);
  assert.equal(reviews.rowCount, 2);
  assert.equal(complete.views[0].ySplit, 1);
  assert.ok(complete.autoFilter);
  assert.equal(complete.getRow(2).getCell(1).value, "MLB1");
  assert.equal(typeof complete.getRow(2).getCell(5).value, "number");
  assert.equal(complete.getRow(2).getCell(7).value, 13.4);
  assert.equal(reviews.getRow(2).getCell(1).value, "MLB2");
  assert.equal(quarantine.rowCount, 2);
  assert.equal(quarantine.getRow(2).getCell(1).value, "MLB2");
});

test("simulacao de 1000 MLBs continua apos 20 divergencias revertidas", async () => {
  const results = [];
  let applied = 0;
  let rolledBack = 0;
  let paused = 0;

  for (let index = 1; index <= 1000; index += 1) {
    const mlb = `MLB${String(index).padStart(10, "0")}`;
    const hasHigherPercent = index % 50 === 0;
    if (!hasHigherPercent) {
      applied += 1;
      results.push({
        mlb_id: mlb,
        status: "success",
        success: true,
        requested_percent: 13,
        real_applied_percent: 13,
        post_apply_confirmed: true,
        batch_decision: "continue",
      });
      continue;
    }

    const review = classifyPostApplyReview({
      actual_percent: 20,
      min_allowed_percent: 12,
      max_allowed_percent: 14,
    });
    const decision = decidePostApplyContinuation(review, { ok: true });
    if (decision.action === "pause") paused += 1;
    rolledBack += 1;
    results.push({
      mlb_id: mlb,
      status: "review",
      success: false,
      review_status: "REVERTIDO_POR_SEGURANCA",
      review_severity: "critical",
      requested_percent: 13,
      real_applied_percent: 20,
      rollback_attempted: true,
      rollback_confirmed: true,
      batch_decision: decision.action,
      batch_decision_code: decision.code,
      batch_decision_reason: decision.reason,
    });
  }

  assert.equal(results.length, 1000);
  assert.equal(applied, 980);
  assert.equal(rolledBack, 20);
  assert.equal(paused, 0);

  const buffer = await buildPromotionResultsWorkbook(results);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  assert.equal(workbook.getWorksheet("Resultado completo").rowCount, 1001);
  assert.equal(workbook.getWorksheet("Erros e revisoes").rowCount, 21);
});

test("simulacao de 1000 MLBs continua com uma quarentena isolada", () => {
  let processed = 0;
  let quarantined = 0;

  for (let index = 1; index <= 1000; index += 1) {
    processed += 1;
    if (index !== 500) continue;
    const review = classifyPostApplyReview({
      actual_percent: 20,
      min_allowed_percent: 12,
      max_allowed_percent: 14,
    });
    const decision = decidePostApplyContinuation(
      review,
      { ok: false, error: "rollback nao confirmado" },
      { criticalOccurrence: 1, remediationQueued: true },
    );
    assert.equal(decision.action, "continue");
    quarantined += 1;
  }

  assert.equal(processed, 1000);
  assert.equal(quarantined, 1);
});

test("simulacao pausa na segunda divergencia critica do lote", () => {
  let processed = 0;
  let pausedAt = null;
  let criticalOccurrence = 0;

  for (let index = 1; index <= 1000; index += 1) {
    processed += 1;
    if (![500, 700].includes(index)) continue;
    criticalOccurrence += 1;
    const review = classifyPostApplyReview({
      actual_percent: 20,
      min_allowed_percent: 12,
      max_allowed_percent: 14,
    });
    const decision = decidePostApplyContinuation(
      review,
      { ok: false, error: "rollback nao confirmado" },
      { criticalOccurrence, remediationQueued: true },
    );
    if (decision.action === "pause") {
      pausedAt = index;
      break;
    }
  }

  assert.equal(pausedAt, 700);
  assert.equal(processed, 700);
});

test("rollback Smart inclui offer_id confirmado sem afetar outras ofertas", () => {
  assert.equal(
    buildPromotionRollbackUrl({
      item_id: "MLB123",
      promotion_id: "P-MLB456",
      promotion_type: "SMART",
      offer_id: "OFFER-MLB123-789",
    }),
    "https://api.mercadolibre.com/seller-promotions/items/MLB123?promotion_type=SMART&promotion_id=P-MLB456&app_version=v2&offer_id=OFFER-MLB123-789",
  );
});

test("resposta 2xx Smart vazia usa candidato pre-validado enquanto propaga", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {},
      trace: { payload: { offer_id: "CANDIDATE-MLB1-1" } },
    },
    item: { original_price: 1000 },
    preflightSnapshot: {
      status: "candidate",
      ref_id: "CANDIDATE-MLB1-1",
      price: 770,
      original_price: 1000,
    },
    promotion_type: "SMART",
    max_discount_percent: 23,
    expected_offer_id: "CANDIDATE-MLB1-1",
  });

  assert.equal(result.ok, true);
  assert.equal(result.confirmation_deferred, true);
  assert.equal(result.actual_percent, 23);
});

test("resposta 2xx Smart vazia nao aceita candidato acima do teto", () => {
  const result = evaluateAcceptedApplyResponse({
    applyResult: {
      ok: true,
      status: 201,
      body: {},
      trace: { payload: { offer_id: "CANDIDATE-MLB1-1" } },
    },
    item: { original_price: 1000 },
    preflightSnapshot: {
      status: "candidate",
      ref_id: "CANDIDATE-MLB1-1",
      price: 700,
      original_price: 1000,
    },
    promotion_type: "SMART",
    max_discount_percent: 23,
    expected_offer_id: "CANDIDATE-MLB1-1",
  });

  assert.equal(result, null);
});
