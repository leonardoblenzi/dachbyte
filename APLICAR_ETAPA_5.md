# DACH Ads — Etapa 5

## Objetivo

Adicionar a camada multicanal e transformar a metodologia FZ em regras determinísticas auditáveis, sem entregar decisões de campanha a uma IA e sem executar alterações automáticas.

## O que entra

- Analytics Google × Meta no mesmo período calendário;
- referências financeiras do workspace;
- normalização explícita da conversão principal da Meta;
- Rules Engine FZ versionado;
- Central de Diagnósticos;
- findings persistidos com evidências e regra de próxima decisão.

## 1. Copiar arquivos

Copie o conteúdo do ZIP por cima da raiz do projeto atual, preservando a estrutura das pastas.

## 2. Executar migration

A nova migration é:

```text
apps/ads/db/004_multichannel_fz.sql
```

Na VPS, execute o migrator do DACH Ads conforme o padrão já usado nas etapas anteriores. Exemplo:

```bash
docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  --profile ops run --rm ads-migrate
```

A migration cria:

- `ads_business_targets`;
- `ads_conversion_mappings`;
- `ads_fz_rule_runs`;
- `ads_fz_findings`;
- RLS por tenant em todas as tabelas novas.

## 3. Rebuild do Ads API

Há código novo no backend e frontend, portanto faça rebuild do `ads-api`. O worker não ganhou um novo processor nesta etapa, mas pode ser recriado junto para manter a mesma imagem do projeto.

```bash
docker compose --env-file infra/env/compose.env \
  -f infra/compose.vps.yml \
  up -d --build --force-recreate ads-api ads-worker
```

## 4. Nenhuma variável de ambiente nova

A Etapa 5 não adiciona secrets nem novas integrações externas.

## Comportamentos importantes

### Não somar conversões entre plataformas

O DACH pode somar investimento de Google + Meta quando a moeda é a mesma. Conversões e valor de conversão permanecem separados, pois Google e Meta podem atribuir o mesmo lead/venda.

### Meta exige conversão principal

Antes de comparar CPA/ROAS da Meta, selecione uma `action_type` principal por conta sincronizada. O sistema não inventa uma conversão somando `lead`, `purchase`, `messaging` e outros eventos.

### Diagnósticos não executam alterações

Os findings da Etapa 5 são somente recomendações. Não existem endpoints para pausar campanha, mudar orçamento, negativar termo ou editar anúncio.

### Regras iniciais

- `FZ-CONTEXT-001`: metas do negócio ausentes;
- `FZ-META-CONV-001`: conversão principal Meta incompleta;
- `FZ-CPA-001`: CPA acima da referência com gasto relevante;
- `FZ-CPA-002`: gasto >= 1,5× CPA alvo sem conversão;
- `FZ-SCALE-001`: CPA dentro da meta, mas volume ainda pequeno para escala;
- `FZ-ROAS-001`: ROAS abaixo da referência;
- `FZ-META-FATIGUE-001`: frequência ↑ + CTR ↓ + CPA ↑;
- `FZ-GOOGLE-SEARCH-001`: termos com gasto e zero conversão para revisão de intenção.

A regra de termos de pesquisa não negativa automaticamente nada e deixa explícito que intenção comercial precisa ser validada.

## Validações automatizadas executadas

- `npm run ads:test`: 23/23 aprovados;
- `npm run test:architecture`: 18/18 aprovados;
- `node --check` nos novos módulos backend/frontend: aprovado.

Os testes reais de Google/Meta, OAuth, sincronização e regras com dados de produção/staging ficam para a bateria final combinada, conforme combinado.
