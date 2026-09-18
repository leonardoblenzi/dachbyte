# DACH Ads — Etapa 3: Analytics Google Ads

Esta etapa usa exclusivamente os dados normalizados pela Etapa 2. Não exige nova migration.

## O que entra

- rota autenticada `GET /ads/api/analytics/google`;
- seleção de conta Google sincronizada;
- períodos de 7, 14 e 30 dias;
- comparação automática com o período imediatamente anterior de mesma duração;
- período ancorado na data mais recente realmente sincronizada, evitando apresentar dias ainda não coletados como zero;
- KPIs: investimento, conversões, CPA, ROAS, CTR e CPC;
- série diária;
- tabelas de campanhas, palavras-chave e termos de pesquisa;
- ações de conversão configuradas na conta;
- atualização dos KPIs da Home usando o mesmo serviço analítico;
- observação explícita de atribuição: conversão de plataforma não é automaticamente venda/lucro.

## Aplicação

Copie o conteúdo do ZIP sobre a raiz do projeto, preservando a estrutura de pastas.

Não há alteração de `.env` nesta etapa.

Como houve alteração no código da imagem do Ads, faça rebuild:

```bash
docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  build ads-api ads-worker

docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  up -d --force-recreate ads-api ads-worker
```

## Rotas

- `/ads/app` — Home com resumo Google quando houver dados.
- `/ads/app/google` — integração Google da Etapa 2.
- `/ads/app/analytics` — analytics Google da Etapa 3.
- `/ads/api/analytics/google?range=30&accountId=<uuid>` — API read-only.

## Observações de arquitetura

- O frontend nunca calcula totais a partir de linhas de campanha para evitar dupla contagem. O resumo usa somente métricas `entity_type = account`.
- Campanhas, palavras e termos são detalhamentos independentes do resumo.
- A análise de múltiplos canais continua fora desta etapa; não existe soma Meta + Google.
- Ações de conversão exibidas são configuração da conta. A Etapa 2 não segmenta métricas diárias por `conversion_action`, então a UI não inventa essa distribuição.
- O Hub permanece como fronteira de autenticação; não foi criado login próprio.

## Validação estática executada na entrega

- `npm run ads:test` → 14/14 aprovados.
- `npm run test:architecture` → 18/18 aprovados.
- `node --check` nos novos arquivos JS → aprovado.

Os testes de runtime com uma conta Google real ficam acumulados para a bateria final solicitada.
