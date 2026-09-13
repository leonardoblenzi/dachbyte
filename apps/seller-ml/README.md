# ML Module - Davantti Suite

## 1) O que e este modulo

Este diretorio `apps/seller-ml/` contem o app de operacoes Mercado Livre (ML) da suite:

- App web (telas HTML + JS) para usuarios comuns e admin master.
- API interna para as funcoes das telas.
- Worker com filas Bull/Redis para jobs assincronos.
- Migracoes SQL do schema ML.

Resumo da arquitetura:

- Entrada HTTP: `apps/seller-ml/index.js` -> `apps/seller-ml/app.js`
- Rotas web/API: `apps/seller-ml/routes/*.js`
- Regras de negocio: `apps/seller-ml/services/*.js`
- Filas/jobs: `apps/seller-ml/worker.js` + `services/*Job*` e `*Queue*`
- Banco: `apps/seller-ml/db/*.sql`, `apps/seller-ml/db/migrate.js`, `apps/seller-ml/db/db.js`

---

## 2) Validacao tecnica realizada (simples e objetiva)

Validacao feita no estado atual do codigo:

1. Sintaxe JS
- Verificados `173` arquivos `.js` em `apps/seller-ml/` (excluindo `node_modules`).
- Resultado: `0` falhas de sintaxe.

2. Smoke test de boot do app
- Comando: `node apps/seller-ml/index.js`
- Resultado: app iniciou e carregou os routers principais com sucesso.
- Limite do ambiente local de teste:
  - bootstrap master falhou por timeout de conexao DB.
  - warnings de envs ML ausentes.

3. Smoke test de boot do worker
- Comando: `node apps/seller-ml/worker.js`
- Resultado: workers/filas iniciaram.
- Limite do ambiente local de teste:
  - `ECONNREFUSED 127.0.0.1:6379` sem Redis local.

Interpretacao:
- O codigo esta estruturalmente consistente.
- Para validar 100% funcional em runtime, precisa ambiente com DB e Redis acessiveis e envs completos.

---

## 3) Como rodar

Pre requisitos:

- Node.js `>=20`
- Postgres acessivel
- Redis para filas/jobs

Comandos principais em `apps/seller-ml/package.json`:

```bash
npm run dev
npm run migrate
npm run worker
npm run tokens:encrypt
```

---

## 4) Variaveis de ambiente (guia pratico)

### 4.1 Minimo para subir app

- `ML_DATABASE_URL` (ou `DATABASE_URL`)
- `ML_JWT_SECRET` (ou `JWT_SECRET`)
- `ML_TOKEN_ENCRYPTION_KEY` (ou `TOKEN_ENCRYPTION_KEY`)
- `ML_APP_ID`, `ML_CLIENT_SECRET` (ou `APP_ID`, `CLIENT_SECRET`)
- `ML_REDIRECT_URI` (ou `REDIRECT_URI`)

### 4.2 Minimo para worker

- Tudo do app (especialmente token encryption key)
- `REDIS_URL` (ou `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`)

## 5) Fluxo do usuario normal (tela por tela)

## Publico / entrada

1. `/selecao-plataforma`
- Entrada inicial da experiencia.

2. `/login`
- Login no modulo.

3. `/ativar`
- Ativacao de conta via convite.

4. `/esqueci-senha`
- Solicita reset.

5. `/redefinir-senha`
- Define nova senha com token de reset.

## Pos login (sem conta ML selecionada)

1. `/select-conta`
- Usuario escolhe qual conta ML vai operar.

2. `/vincular-conta`
- Inicia vinculacao OAuth da conta ML.

## Operacao diaria (com conta selecionada)

1. `/painel` (e `/projecao-mensal`, `/dashboard`)
- Visao macro de performance e inatividade.

2. `/criar-promocao`
- Criacao de promocoes (individual/lote).

3. `/remover-promocao`
- Remocao de promocoes em lote.

4. `/publicidade`
- Product Ads: campanhas, itens e exportacoes.

5. `/financeiro/custos-mercado-livre`
- Custos por SKU de referencia para os anuncios Mercado Livre.

6. `/financeiro/margem-venda-mercado-livre`
- Margem de venda estimada por anuncio, com custo por SKU, comissao, imposto e frete quando disponivel.

7. `/reputacao`
- Visao de reputacao operacional/comercial.

8. `/filtro-anuncios`
- Filtro avancado com jobs/export.

9. `/gestao-anuncios`
- Gestao em lote para ativar, pausar, encerrar e excluir anuncios com acompanhamento de job.

10. `/modelo-massa`
- Aplicacoes em massa com preview e cancelamento.

11. `/validar-dimensoes`
- Validacao de dimensoes por job com export.

12. `/prazo`
- Ajustes de prazo de producao (lote/job).

13. `/atacado`
- Operacoes de atacado por job.

14. `/analise-ia`
- Analises assistidas por IA.

15. `/ia-analytics/curva-abc`
- Curva ABC de itens.

16. `/ajuda`
- Canal de suporte/ajuda.

---

## 6) Fluxo admin master (tela por tela)

Todas as telas admin ficam em `/ml/admin/*` e exigem nivel `admin_master`.

1. `/admin/usuarios`
- CRUD de usuarios.
- Convite/reenvio de ativacao.
- Ajuste de nivel/status.

2. `/admin/empresas`
- CRUD de empresas.

3. `/admin/vinculos`
- Vinculos entre usuarios e empresas.

4. `/admin/contas-ml` (alias `/admin/meli-contas`)
- CRUD de `meli_contas`.

5. `/admin/tokens-ml` (alias `/admin/meli-tokens`)
- Visualizacao/gestao de tokens por conta.

6. `/admin/oauth-states`
- Diagnostico e limpeza de estados OAuth.

7. `/admin/migracoes`
- Status das migracoes SQL.
- Preview de arquivo SQL.
- Execucao de pendentes (`confirm: "rodar"`).

8. `/admin/auditoria`
- Eventos de auditoria e regras de retencao.
- Cleanup manual.

9. `/admin/patch-notes`
- CRUD de patch notes.
- Preview e disparo para destinatarios.

10. `/admin/jobs` (Automacoes)
- Central para configuracao de jobs/cron internos.
- Use para acompanhar futuras automacoes internas do modulo.

11. `/admin/backup`
- Exporta backup JSON.
- Importa backup JSON (restauracao).

## 7) API principal (mapa rapido)

Os grupos mais usados:

1. Auth: `/api/auth/*`
- login, register, activate, forgot/reset, me, logout.

2. Conta selecionada: `/api/account/*`
- listar contas, conta atual, selecionar/limpar.

3. ML OAuth: `/api/meli/*`
- start/callback OAuth, contas, current, webhook.

4. Painel e dashboards:
- `/api/dashboard/*`
- `/api/painel/*`

5. Operacoes de negocio:
- `/api/financeiro-ml/*`
- `/api/reputacao/*`
- `/api/publicidade/*`
- `/api/analytics/*`
- `/api/atacado/*`
- `/api/modelo-massa/*`
- `/api/validar-dimensoes/*`
- `/api/prazo-producao/*` (via routes de prazo)
- `/api/promocoes/*` e afins

6. Admin:
- `/api/admin/*` (usuarios, empresas, vinculos, contas, tokens, migracoes, auditoria, patch notes, jobs, backup)

7. Sistema:
- `GET /healthz`

---

## 8) Jobs e worker

Entrada do worker:

- `apps/seller-ml/worker.js`

Filas principais inicializadas:

- Promo jobs
- Promo bulk remove
- Exclusao lote
- Filtro anuncios
- Prazo producao
- Validar dimensoes

Para producao:

- Redis obrigatorio.
- Ajustar concorrencia por job conforme carga.

---

## 9) Banco e migracoes

Migracoes em:

- `apps/seller-ml/db/*.sql`

Rodar migracoes:

```bash
npm run migrate
```

Tabela de controle:

- `migracoes`

Migracao relevante para automacoes:

- `024_create_automation_job_settings.sql`

Tabela criada:

- `automation_job_settings`

---

## 10) Como usar a tela de Automacoes (admin/jobs)

Passo a passo:

1. Abra `/ml/admin/jobs`.
2. Selecione o job em `Automacao`, quando houver jobs cadastrados.
3. Ajuste parametros gerais.
4. Defina escopo:
- Allowlist = so estas contas.
- Denylist = contas para ignorar.
5. Clique `Salvar job`.

---

## 11) Troubleshooting rapido

1. Sidebar admin sem item "Automacoes"
- Verifique deploy no commit mais recente de `main`.
- Hard refresh no browser (`Ctrl+F5`).

2. Worker com `ECONNREFUSED 127.0.0.1:6379`
- Redis nao acessivel.
- Configure `REDIS_URL` (ou host/port/password).

3. Bootstrap master falhando por timeout
- Banco nao acessivel via `ML_DATABASE_URL`/`DATABASE_URL`.

## 12) Proxima evolucao recomendada

Para fortalecer validacao automatica:

1. Adicionar testes de integracao por grupo de rota.
2. Adicionar healthcheck de Redis e DB separados.
3. Adicionar checklist de smoke pos deploy (app + worker + admin/jobs + financeiro ML).

