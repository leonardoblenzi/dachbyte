# DACH Ads

DACH Ads é um bounded context independente do Seller e do Business. O Hub continuará sendo a fonte de verdade para identidade, acesso e pagamento; o produto não possui login nem assinatura próprios.

## Etapas implementadas

### Etapa 2 — Google Ads read-only

- OAuth multiusuário Google Ads;
- credenciais criptografadas com AES-256-GCM;
- descoberta de contas diretas e contas abaixo de MCCs;
- seleção explícita das contas anunciantes acompanhadas;
- worker assíncrono com fila persistida no PostgreSQL;
- backfill inicial e atualização recorrente;
- campanhas, grupos, anúncios, palavras-chave, termos de pesquisa, conversões e métricas diárias normalizadas.

### Etapa 3 — Analytics Google Ads

- indicadores e comparação de períodos;
- tendência diária;
- campanhas, palavras-chave, termos de pesquisa e ações de conversão;
- período ancorado na última data realmente sincronizada.

### Etapa 4 — Meta Ads read-only

- OAuth Meta usando apenas escopos de leitura (`ads_read` + contexto de Business via `business_management`);
- descoberta de Business Portfolios e contas de anúncio;
- seleção explícita das contas sincronizadas;
- campanhas, conjuntos, anúncios, criativos e Insights diários;
- ações da Meta preservadas por `action_type`, sem somar automaticamente lead, compra, mensagem e outros eventos como se fossem uma única conversão;
- Graph API versionada por `META_GRAPH_API_VERSION`, padrão `v26.0`;
- `appsecret_proof` nas consultas server-to-server quando o App Secret está configurado.

O frontend nunca recebe access token, refresh token, App Secret ou Client Secret. Credenciais de providers só podem ser descriptografadas pelos processos API/worker no backend.

## Desenvolvimento local

Use `ADS_AUTH_MODE=development` apenas localmente. Em produção o produto continua preparado para usar exclusivamente a identidade e autorização do Hub.

### Google

- `ADS_TOKEN_ENCRYPTION_KEY`: 32 bytes em base64/hex/raw;
- `GOOGLE_ADS_CLIENT_ID`;
- `GOOGLE_ADS_CLIENT_SECRET`;
- `GOOGLE_ADS_REDIRECT_URI`;
- `GOOGLE_ADS_API_VERSION=v25`.

### Meta

- `META_APP_ID`;
- `META_APP_SECRET`;
- `META_REDIRECT_URI`;
- `META_GRAPH_API_VERSION=v26.0`;
- `META_OAUTH_SCOPES=ads_read,business_management`.

O DACH Ads não solicita `ads_management` na Etapa 4. Escrita em campanhas será tratada apenas em uma etapa futura, com autorização explícita.

## Banco

Execute migrations usando a role `dachbyte_ads_migrator`. O processo web usa `dachbyte_ads_app` e o worker `dachbyte_ads_worker`.

O worker usa `ADS_WORKER_DATABASE_URL`, separado de `DATABASE_URL`, porque precisa reclamar jobs do control-plane sem receber BYPASSRLS sobre dados de clientes.

### Etapa 5 — Multicanal + FZ Rules Engine

- comparativo Google Ads × Meta Ads ancorado na data comum mais recente;
- investimento pode ser consolidado somente quando as contas usam a mesma moeda;
- conversões de Google e Meta nunca são somadas automaticamente;
- referências do negócio: orçamento mensal, CPA alvo, ROAS alvo, ticket e margem;
- mapeamento explícito de uma action principal por conta Meta antes de calcular CPA/ROAS comparável;
- Rules Engine FZ determinístico e versionado, sem dependência de IA;
- findings persistidos com diagnóstico, evidências, ação recomendada, o que não alterar, observação e próxima decisão;
- regras iniciais para CPA, gasto sem conversão, guarda de escala, ROAS, possível fadiga Meta e revisão de termos Google sem conversão;
- Central de Diagnósticos com histórico operacional e estados `open`, `acknowledged`, `dismissed` e `resolved`.

A Etapa 5 continua 100% read-only em relação às plataformas. O Rules Engine gera recomendações, mas não pausa campanhas, muda orçamento, negativa termos nem altera anúncios.
