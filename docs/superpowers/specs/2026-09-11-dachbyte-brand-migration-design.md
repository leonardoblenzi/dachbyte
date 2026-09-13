# Migração de marca para produtos DachByte

## Objetivo

Consolidar todos os produtos públicos da suíte sob a marca DachByte, sem interromper logins, integrações, dados, URLs antigas ou o rollback para Render e Neon.

## Catálogo público aprovado

| Linha | Produto |
| --- | --- |
| Seller | Dach Seller — Mercado Livre, Shopee, Madeira, Rastreio, Leader e Log |
| Business | Dach Core, Dach Stock, Dach Price e Dach Chat |
| Plataforma | Dach Hub |

## Decisão de arquitetura

A marca pública muda primeiro. Nomes internos não são prova de marca e permanecem compatíveis durante a transição:

- Rotas antigas, como `/voltstock` e `/davanttilog`, continuam respondendo.
- Cookies, variáveis `VOLT_*` e `DAVANTTI*`, conexões de banco e integrações OAuth não são renomeados de forma destrutiva.
- Nomes novos podem ser adicionados como aliases `DACH_*` quando um módulo precisar de configuração nova.
- Cada produto continua sendo um serviço independente no Docker Compose; compartilhar uma imagem não implica compartilhar um processo.

## Fases

1. **Catálogo e marca visível** — títulos, navegação, textos, e-mails, metadados e ativos passam a usar os nomes aprovados.
2. **Rotas canônicas** — adicionar caminhos DachByte e manter os caminhos Volt/D'avantti como aliases ou redirecionamentos compatíveis.
3. **Configuração aditiva** — introduzir variáveis `DACH_*` como preferência de leitura, preservando as variáveis legadas como fallback.
4. **Domínios e provedores externos** — cadastrar URLs DachByte em Cloudflare, OAuth e webhooks; validar em staging antes do corte.
5. **Descontinuação** — somente após telemetria, validação de fluxos e janela de rollback, redirecionar ou remover aliases legados.

## Regras de segurança

- Nenhum banco existente será renomeado nesta migração de marca.
- Nenhum segredo será salvo no Git.
- Render e Neon permanecem ativos durante a validação da VPS.
- Apenas Caddy poderá expor tráfego público quando a fase de domínio for autorizada.
- Todo alias terá teste de rota e de sessão antes de ser considerado canônico.

## Critérios de aceite da primeira implementação

- A navegação e os títulos de cada produto mostram o nome DachByte aprovado.
- As rotas legadas continuam funcionando.
- Testes de arquitetura, saúde dos containers e fluxos de autenticação não apresentam regressão.
- Não há alteração de dados, credenciais, domínios ou tráfego público sem autorização específica.
