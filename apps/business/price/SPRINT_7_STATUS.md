# Sprint 7 — Signal & Decision Engine

Status: implementada.

## Entregue

- Motor determinístico de decisão econômica por SKU, versionado como `decision-engine-v1`.
- Estados estratégicos: ruptura, lançamento, margem crítica, excesso, defesa, aceleração, recuperação e estável.
- Elasticidade preço-demanda por regressão log-log, somente quando há amostras, variação de preço e ajuste estatístico suficientes.
- Confiança decomposta por fonte: preço, custo, vendas, Profit, Market, estoque, Ads, caixa e elasticidade.
- Guardrails configuráveis de margem mínima, contribuição, variação máxima, passo de teste, confiança e qualidade da elasticidade.
- Cenários comparáveis por preço, volume, receita, contribuição e violações de guardrail.
- Risco explícito de campanha/ranking para mudanças relevantes com Ads ativos.
- Recomendações de elevar, reduzir, manter, testar ou aguardar; dados insuficientes nunca geram impacto fabricado.
- Narrativa auditável em evidência → interpretação → decisão → riscos → impacto.
- Execuções e sinais persistidos por produto, com snapshot completo das entradas usadas.
- Política global ou específica por SKU e amostras manuais idempotentes de preço × demanda.
- Aprovação/rejeição humana auditada. Aprovar não publica nem altera preço em produto ou marketplace.
- Workspace Pricing com fila de decisões, confiança, cenários, riscos, políticas e captura de evidências.
- RLS/FORCE RLS nas novas tabelas.
- Compatibilidade preservada para a simulação econômica anterior.

## Endpoints

- `GET /volt-price/api/pricing`
- `POST /volt-price/api/pricing/run`
- `POST /volt-price/api/pricing/policies`
- `POST /volt-price/api/pricing/samples`
- `PATCH /volt-price/api/pricing/decisions/:id/review`
- `POST /volt-price/api/pricing/simulate`

## Segurança e limites conscientes

- `commission_references` permanece exclusivamente informativa e não participa do contexto nem do cálculo.
- Toda recomendação grava `requires_approval=true` e `autoApply=false` no contrato do motor.
- A revisão altera apenas o estado auditável da decisão; não existe integração de escrita de preço nesta sprint.
- Sem elasticidade confiável, o motor pode sugerir apenas teste limitado e deixa impacto de demanda/contribuição como não estimado.
- A recomendação expira em sete dias e deve ser executada novamente quando o contexto econômico mudar.

## Verificação

- `node --test volt-price/tests/*.test.js`
- `node volt-price/db/verify-decision-flow.js`
- `npm run migrate:volt-price`
- `npm run build`
