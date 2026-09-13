# Patch final - lifecycle de jobs + PRE_NEGOTIATED
Data: 2026-08-21

Base utilizada
- Exclusivamente o ultimo `ml.zip` enviado pelo usuario.
- Este ZIP e incremental: extraia na raiz da pasta `ml/`.

Arquivos de producao alterados
- routes/promocoesRoutes.js
- views/criar-promocao.html
- services/promoJobsService.js
- public/js/criar-promocao.js
- public/js/jobs-panel.js
- public/js/promo-state.js

Principais correcoes de lifecycle/orquestracao
- Operacao promocional logica separada dos chunks internos.
- Chunks internos possuem IDs proprios e nao aparecem no painel.
- Total da operacao (`operationTotal`) permanece imutavel entre chunks.
- `operation_id` independente do ID numerico do Bull.
- Estado logico da operacao prevalece sobre o estado interno do Bull.
- Um pai interno `completed` nao e apresentado como concluido se a operacao logica ainda estiver processando.
- `/api/promocoes/jobs` deduplica o mesmo job entre buckets Bull e resolve conflito pelo estado canonico.
- O frontend faz uma segunda deduplicacao defensiva antes de mesclar jobs.
- Estado ativo/queued prevalece sobre snapshot terminal conflitante no mesmo polling.
- Remediacao pendente impede conclusao terminal indevida.
- Cancelamento considera o chunk interno ativo.
- Jobs antigos continuam com caminho de compatibilidade; a arquitetura v2 vale integralmente para novos jobs.

Suporte PRE_NEGOTIATED
- Aba propria `Pre-acordo`.
- Campo proprio de teto maximo de desconto pre-acordado.
- O teto e somente uma trava de seguranca; nenhum novo preco e calculado/enviado.
- Aplicacao unitária e em massa passa pelo motor seguro de jobs.
- Apenas candidatos sao aplicaveis.
- `offer_id` candidato e obrigatorio e revalidado imediatamente antes do POST.
- POST usa apenas promotion_id + promotion_type + offer_id.
- Resposta aceita do ML preserva o offer_id original do pre-acordo.
- A oferta ativa posterior pode possuir outro `OFFER-*`; isso nao gera falso erro de identidade.
- Preco/desconto base acima do teto continua sendo divergencia critica.
- `meli_percentage`, `seller_percentage` e boost ficam separados na auditoria.
- Boost do ML nao e somado ao teto de desconto base.
- Rollback/DELETE de PRE usa prioritariamente o offer_id original enviado no POST.
- XLSX/auditoria ganhou campos especificos de PRE.
- Remocao manual exibe aviso de que o item pode deixar de ser candidato ao remover o pre-acordo.

Validacoes executadas
- `node --check` nos cinco arquivos JavaScript alterados: OK.
- `npm run test:jobs-panel`: 29/29 testes passaram.
- Suite sem os dois arquivos dependentes de ExcelJS: 37/37 testes passaram.
- Smoke PRE_NEGOTIATED: candidato dentro do teto, oferta ativa com OFFER diferente, teto excedido e rollback: OK.
- Smoke de lifecycle: operationTotal imutavel e Bull completed nao encerra pai logico ativo: OK.
- Smoke de canonicalizacao `/jobs`: mesma ID em active+completed retorna uma unica linha processing: OK.
- Estrutura HTML sem IDs duplicados: OK.

Observacao de ambiente de teste
- O `node_modules` presente no ZIP base nao contem uma instalacao funcional de `exceljs`.
- Por isso os dois arquivos da suite que exigem ExcelJS real nao puderam ser executados integralmente neste ambiente.
- A sintaxe e os caminhos de auditoria/XLSX alterados foram validados por carregamento com stub e smokes direcionados.

Deploy
1. Extraia este ZIP na raiz da pasta `ml/`, mantendo as pastas.
2. Reinicie WEB e WORKER.
3. Nao use um job antigo como teste da nova arquitetura de chunks; crie um job novo.
4. Primeiro teste recomendado: uma SMART pequena e um PRE_NEGOTIATED pequeno.
5. Confirme no painel que o total nao muda durante revezamento de chunks e que o card so vai para Concluidos quando a operacao logica terminar.
