"use strict";

const crypto = require("node:crypto");

const RULES_VERSION = "fz-ads-2026.09-v1";

function n(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
function fingerprint(ruleId, provider = "multichannel", discriminator = "workspace") {
  return crypto.createHash("sha256").update(`${ruleId}|${provider}|${discriminator}`).digest("hex");
}
function finding({ ruleId, ruleVersion = 1, provider = "multichannel", accountId = null, discriminator = "workspace", severity, category, title, diagnosis, evidence = {}, recommendedAction = null, doNotChange = null, observation = null, nextDecision = null, period }) {
  return {
    ruleId, ruleVersion, provider, accountId, severity, category, title, diagnosis, evidence,
    recommendedAction, doNotChange, observation, nextDecision,
    periodStart: period?.startDate || null, periodEnd: period?.endDate || null,
    fingerprint: fingerprint(ruleId, provider, discriminator),
  };
}
function conversionComparable(channel) {
  if (!channel) return false;
  if (channel.provider !== "meta_ads") return true;
  const map = channel.conversionMapping;
  return Boolean(map && map.totalAccounts > 0 && map.mappedAccounts === map.totalAccounts);
}

function evaluateFzRules(context, extras = {}) {
  if (!context?.available) return [];
  const out = [];
  const targetCpa = n(context.targets?.targetCpa);
  const targetRoas = n(context.targets?.targetRoas);
  const period = context.period;

  if (!targetCpa && !targetRoas) {
    out.push(finding({
      ruleId: "FZ-CONTEXT-001", severity: "info", category: "business_context",
      title: "Metas financeiras ainda não definidas",
      diagnosis: "Sem CPA ou ROAS alvo, o DACH consegue descrever performance, mas não deve classificar eficiência financeira como boa ou ruim.",
      evidence: { targetCpa: null, targetRoas: null },
      recommendedAction: "Cadastre ao menos o CPA máximo aceitável ou o ROAS mínimo do negócio.",
      doNotChange: "Não altere campanhas apenas para melhorar métricas de plataforma antes de definir a referência financeira.",
      observation: "Essa configuração é do workspace e pode ser atualizada quando ticket, margem ou oferta mudarem.",
      nextDecision: "Depois de definir a meta, rode novamente o diagnóstico FZ.", period,
    }));
  }

  for (const [provider, channel] of Object.entries(context.channels || {})) {
    const current = channel.summary?.current || {};
    const deltas = channel.summary?.delta || {};
    const comparable = conversionComparable(channel);
    const label = provider === "google_ads" ? "Google Ads" : "Meta Ads";
    const discriminator = channel.accounts?.map((item) => item.id).sort().join(",") || provider;

    if (provider === "meta_ads" && !comparable) {
      out.push(finding({
        ruleId: "FZ-META-CONV-001", provider, discriminator, severity: "medium", category: "tracking",
        title: "Conversão principal da Meta precisa ser definida",
        diagnosis: "O investimento da Meta está disponível, mas nem todas as contas selecionadas possuem uma action principal mapeada. Somar leads, compras, mensagens e outras actions criaria uma conversão artificial.",
        evidence: { mappedAccounts: channel.conversionMapping?.mappedAccounts || 0, totalAccounts: channel.conversionMapping?.totalAccounts || 0 },
        recommendedAction: "Escolha uma action principal por conta Meta que represente o objetivo real da campanha.",
        doNotChange: "Não compare CPA da Meta com Google enquanto o mapeamento estiver incompleto.",
        observation: "O DACH mantém todas as actions brutas; o mapeamento apenas define qual delas deve representar conversão no comparativo.",
        nextDecision: "Após mapear todas as contas, rode novamente o diagnóstico.", period,
      }));
    }

    if (targetCpa && comparable) {
      if ((current.conversions || 0) === 0 && (current.spend || 0) >= targetCpa * 1.5) {
        out.push(finding({
          ruleId: "FZ-CPA-002", provider, discriminator, severity: "high", category: "efficiency",
          title: `${label}: gasto relevante sem conversão`,
          diagnosis: `O canal consumiu pelo menos 1,5× o CPA máximo informado sem registrar conversões comparáveis no período. Isso merece investigação, mas não prova que o problema esteja na campanha.`,
          evidence: { spend: current.spend, conversions: current.conversions, targetCpa, threshold: targetCpa * 1.5 },
          recommendedAction: "Verifique tracking, intenção/público, oferta e destino antes de aumentar orçamento ou reconstruir a campanha.",
          doNotChange: "Não altere várias variáveis ao mesmo tempo e não conclua automaticamente que o canal deve ser pausado.",
          observation: `Período analisado: ${context.rangeDays} dias, ancorado em dados sincronizados.`,
          nextDecision: "Se o tracking estiver correto e o gasto continuar crescendo sem conversão, isole a principal hipótese e faça um teste por vez.", period,
        }));
      } else if (current.cpa !== null && current.cpa > targetCpa * 1.2 && current.spend >= targetCpa * 1.5) {
        out.push(finding({
          ruleId: "FZ-CPA-001", provider, discriminator, severity: "high", category: "efficiency",
          title: `${label}: CPA acima da referência do negócio`,
          diagnosis: `O CPA está mais de 20% acima da meta e já existe gasto suficiente para a diferença merecer investigação.`,
          evidence: { cpa: current.cpa, targetCpa, spend: current.spend, conversions: current.conversions, cpaDeltaVsTarget: (current.cpa / targetCpa) - 1 },
          recommendedAction: "Localize o gargalo na sequência entrega → intenção/público → anúncio/criativo → oferta → página → comercial.",
          doNotChange: "Não escale orçamento enquanto o CPA permanecer acima da referência e não faça múltiplas mudanças simultâneas.",
          observation: "Use as métricas de plataforma como evidência de diagnóstico, não como objetivo isolado.",
          nextDecision: `Reavalie quando houver novo volume relevante ou após o próximo teste controlado; a referência continua em ${targetCpa.toFixed(2)} por conversão.`, period,
        }));
      } else if (current.cpa !== null && current.cpa <= targetCpa && current.conversions > 0 && current.conversions < 5) {
        out.push(finding({
          ruleId: "FZ-SCALE-001", provider, discriminator, severity: "info", category: "scale",
          title: `${label}: eficiência positiva, volume ainda pequeno para escala`,
          diagnosis: "O CPA está dentro da meta, porém há poucas conversões no período. Poucos resultados positivos não são evidência suficiente para uma escala agressiva.",
          evidence: { cpa: current.cpa, targetCpa, conversions: current.conversions, spend: current.spend },
          recommendedAction: "Preserve a estrutura atual e busque mais consistência antes de aumentar verba.",
          doNotChange: "Não aumente orçamento de forma agressiva com base em poucas conversões.",
          observation: "Considere estabilidade, margem, histórico e capacidade operacional.",
          nextDecision: "Se a eficiência se mantiver com maior volume de conversões, avalie escala controlada.", period,
        }));
      }
    }

    if (targetRoas && comparable && current.roas !== null && current.spend > 0 && current.roas < targetRoas * 0.85) {
      out.push(finding({
        ruleId: "FZ-ROAS-001", provider, discriminator, severity: "high", category: "profitability",
        title: `${label}: ROAS abaixo da referência`,
        diagnosis: "O valor de conversão atribuído pela plataforma está abaixo da referência configurada para o negócio.",
        evidence: { roas: current.roas, targetRoas, spend: current.spend, conversionValue: current.conversionValue },
        recommendedAction: "Revise mix de conversões, oferta, preço/margem e eficiência da aquisição antes de escalar.",
        doNotChange: "Não trate ROAS como lucro e não eleve a meta de ROAS apenas para deixar o painel mais bonito.",
        observation: "Receita atribuída por plataforma pode conter diferenças de atribuição; margem e lucro exigem dados financeiros do negócio.",
        nextDecision: "Se o ROAS continuar abaixo da referência após validar tracking e oferta, reduza desperdício ou redistribua verba com evidência.", period,
      }));
    }

    if (provider === "meta_ads" && comparable && n(deltas.frequency) !== null && deltas.frequency > 0.15 && deltas.ctr < -0.20 && deltas.cpa > 0.20) {
      out.push(finding({
        ruleId: "FZ-META-FATIGUE-001", provider, discriminator, severity: "medium", category: "creative",
        title: "Meta Ads: sinais combinados de possível fadiga",
        diagnosis: "Frequência subiu enquanto CTR caiu e CPA aumentou frente ao período anterior. A combinação é compatível com fadiga, mas não deve ser concluída pela frequência isoladamente.",
        evidence: { frequency: current.frequency, frequencyDelta: deltas.frequency, ctr: current.ctr, ctrDelta: deltas.ctr, cpa: current.cpa, cpaDelta: deltas.cpa },
        recommendedAction: "Revise primeiro os criativos/conjuntos que concentram a piora e formule um teste de criativo com hipótese clara.",
        doNotChange: "Não troque público, orçamento e criativo ao mesmo tempo.",
        observation: "A regra exige três sinais simultâneos para reduzir falsos positivos.",
        nextDecision: "Se o novo criativo reduzir CPA com volume comparável, mantenha; caso contrário investigue oferta e pós-clique.", period,
      }));
    }
  }

  const zeroTerms = extras.googleZeroConversionSearchTerms || [];
  if (targetCpa && zeroTerms.length) {
    const spend = zeroTerms.reduce((sum, row) => sum + Number(row.cost_micros || 0) / 1_000_000, 0);
    if (spend >= targetCpa * 0.75) {
      out.push(finding({
        ruleId: "FZ-GOOGLE-SEARCH-001", provider: "google_ads", discriminator: "search-terms-no-conversion", severity: spend >= targetCpa * 1.5 ? "high" : "medium", category: "search_intent",
        title: "Google Ads: termos com gasto e nenhuma conversão merecem revisão",
        diagnosis: "Há gasto concentrado em termos de pesquisa sem conversões no período. Isso não significa que todos devam ser negativados; é necessário avaliar a intenção de cada busca.",
        evidence: {
          spend,
          targetCpa,
          topTerms: zeroTerms.slice(0, 10).map((row) => ({ term: row.search_term, campaign: row.campaign_name, spend: Number(row.cost_micros || 0) / 1_000_000, clicks: Number(row.clicks || 0) })),
        },
        recommendedAction: "Revise os termos individualmente e negative somente os que forem incompatíveis com a intenção comercial do negócio.",
        doNotChange: "Não aplique uma lista genérica de negativas e não negative apenas porque um termo ainda não converteu.",
        observation: "O critério usa gasto sem conversão; a classificação de intenção continua exigindo contexto do negócio.",
        nextDecision: "Após a revisão de intenção, acompanhe se o desperdício cai sem reduzir conversões qualificadas.", period,
      }));
    }
  }

  return out;
}

module.exports = { RULES_VERSION, evaluateFzRules, fingerprint, conversionComparable };
