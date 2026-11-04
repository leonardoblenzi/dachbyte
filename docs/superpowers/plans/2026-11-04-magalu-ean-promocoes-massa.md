# Magalu: custos por EAN e promoções em massa

**Objetivo:** permitir importar custos por EAN com prévia e preparar preços promocionais por margem para exportação XLSX.

**Arquitetura:** manter a importação de custos e a precificação como entregas independentes. Usar catálogo e preços por conta já sincronizados; cálculos e validação no servidor; prévias explícitas antes de gravar custos ou exportar preços. Exportar apenas SKU e preço promocional calculado, conforme orientação do usuário.

**Tecnologia:** Node.js, Express, PostgreSQL, ExcelJS e interface Magalu existente.

## Sequência de execução e critérios de conclusão

1. **Custos por EAN (seção 1):** modelo, correspondência e prévia antes de gravar; concluir com histórico e testes de importação por SKU e EAN.
2. **Painel lateral de processos (seção 4):** disponibilizar acompanhamento dos jobs já existentes de catálogo, estoque e preços, com progresso real e recuperação após recarga.
3. **Busca e operações em massa (seção 3):** aceitar listas completas e criar lotes revisáveis de até 5.000 SKUs; apresentar operação agrupada e seus lotes no painel da etapa 2.
4. **Dados de preço para promoções (primeira parte da seção 2):** filtrar catálogo e apresentar custo, preço cheio, preço atual e atualidade dos dados; permitir atualizar os preços e sinalizar falhas ou sincronização parcial.
5. **Cálculo e revisão (seção 2):** aplicar margem e custos informados, arredondar com segurança, mostrar pendências e permitir revisar os valores por SKU.
6. **Exportação Magalu (seção 2):** produzir XLSX somente com SKU e preço promocional calculado e validar os dados exportados.
7. **Validação final:** testar a jornada completa e responsividade, revisar isolamento de contas e fazer commit/push/deploy quando solicitados.

Cada etapa deve entregar funcionalidade verificável; dependências e falhas devem ficar explícitas.

## 1. Importação de custos por EAN

Arquivos: `apps/seller-magalu/src/services/costWorkbookService.js`, `src/repositories/financialRepository.js`, `src/controllers/financialController.js`, `src/routes/financial.routes.js`, `public/js/magalu-financial.js` e `views/app.html`.

- [ ] Preservar o modelo e a importação por SKU; oferecer escolha explícita SKU ou EAN. Criar modelo por EAN com EAN e custo, com EAN formatado como texto.
- [ ] Ler EAN como texto, preservando zeros à esquerda; rejeitar valores numéricos que não possam preservar a identificação e apresentar linha e motivo. Validar custo não negativo e limites de arquivo existentes.
- [ ] Resolver EANs contra `identifiers` dos SKUs presentes pertencentes à conta selecionada. Mostrar EANs sem correspondência, várias correspondências, valores duplicados conflitantes e custo anterior por SKU. EANs repetidos com mesmo custo podem ser agrupados; conflitos bloqueiam a aplicação.
- [ ] Criar endpoint de prévia sem gravação e confirmação posterior associada à conta e ao usuário. Na confirmação, revalidar correspondências e valores atuais numa transação; se mudaram, exigir nova prévia. Não confiar nos SKUs enviados pelo navegador.
- [ ] Aplicar a cada SKU confirmado, mantendo histórico de custo existente e atomicidade; mostrar total de EANs, SKUs atualizados e não encontrados. Não presumir que variações com mesmo EAN tenham custo igual: listar todas na prévia para revisão.
- [ ] Verificar importação por SKU existente, EAN com zeros, múltiplos SKUs, conta distinta, conflitos, arquivo inválido, dados alterados após prévia e rollback.

## 2. Promoções em massa

Arquivos: `apps/seller-magalu/views/app.html`, `public/js/magalu-app.js`, novo `public/js/magalu-promocoes-massa.js`, `public/css/` de estilos da tela, `src/routes/financial.routes.js`, `src/controllers/financialController.js`, novo serviço de cálculo e `src/repositories/financialRepository.js`.

- [ ] Adicionar **Precificação → Promoções em massa**, rota própria e navegação da conta selecionada; carregar resultados somente após filtrar.
- [ ] Filtrar SKUs por publicação/atividade, SKU, EAN, família e categoria; diferenciar `active` de status de publicação e mostrar quais critérios são usados. Paginar e oferecer seleção do conjunto filtrado completo, com limite explícito.
- [ ] Retornar custo, alíquota da conta, `list_price`, `price` e data da última sincronização. Mostrar preço cheio e preço atual separadamente; sinalizar dados ausentes ou antigos. Oferecer atualização explícita dos preços e indicar progresso, falhas e alcance parcial; não prometer descoberta além do limite de paginação da API.
- [ ] Aceitar margem alvo global, comissão percentual, tarifa fixa e frete estimado opcional; permitir ajustes por SKU. Exibir origem e data dos valores e não presumir que cobranças de vendas passadas valem para novas promoções. Frete vazio deve aparecer como não informado, nunca como custo conhecido zero.
- [ ] Calcular preço mínimo como `(custo + tarifa fixa + frete informado) / (1 - imposto - comissão - margem)` quando as taxas forem percentuais sobre preço e o denominador for positivo. Arredondar para cima em centavos e recalcular margem após arredondamento; evitar erros de ponto flutuante. Identificar taxa ausente, custo/preço ausente, soma de percentuais inviável e preço sugerido sem desconto sobre preço cheio.
- [ ] Mostrar prévia paginada com identificadores, custo, preço cheio, preço atual, parâmetros, sugestão, desconto e margem estimada; permitir editar preço e recalcular margem. Impedir exportar linhas inválidas e apresentar relação dos SKUs excluídos. Persistir seleção e parâmetros por conta durante a sessão, sem vazar entre contas.
- [ ] Gerar um único XLSX contendo apenas SKU e preço promocional calculado, tratando SKUs como texto e preços com duas casas; não incluir outras colunas nem arquivo separado de conferência.
- [ ] Validar filtros, seleção de todas as páginas, grande volume, cálculo de fronteira, arredondamento, taxas faltantes, EANs repetidos, edição de preço, conta trocada, exportação parcial e leitura do XLSX gerado com ExcelJS.

## 3. Filtro com vários valores na Gestão de catálogo

Arquivos: `apps/seller-magalu/views/app.html`, `public/js/magalu-sku-management.js`, `src/controllers/skuManagementController.js` e `src/repositories/skuMassRepository.js`.

- [ ] Permitir informar numa linha vários SKUs, EANs ou famílias separados por vírgula, de acordo com o tipo de busca selecionado; também aceitar quebras de linha e ponto e vírgula. Remover espaços e duplicatas sem alterar identificadores ou zeros à esquerda. Produto continua busca textual.
- [ ] Remover o truncamento atual de 200 caracteres do filtro e não limitar silenciosamente a quantidade de valores. Para listas grandes usar requisição POST e processamento em partes no servidor, com progresso, paginação e mensagens explícitas para erros de tamanho ou interrupções; nenhum identificador pode ser descartado silenciosamente.
- [ ] Buscar cada SKU/EAN/família por correspondência exata, retornando a união dos resultados sem duplicar SKUs; no caso de família incluir todos os SKUs correspondentes. Restringir sempre à conta selecionada e combinar com filtros de status e atividade.
- [ ] Preservar a lista completa e os mesmos filtros ao selecionar todos os resultados e gerar a prévia; mostrar identificadores não encontrados. Não confundir paginação de leitura com seleção de todos os resultados.
- [ ] Manter o limite existente de segurança por lote de operação de escrita; quando a seleção exceder esse limite, dividir em lotes revisáveis e informar quantidade, progresso e falhas, sem perder resultados. Confirmar como apresentar os lotes antes de implementar a aplicação em massa.
- [ ] Verificar listas em uma linha, repetidos, EAN com zeros, múltiplas famílias, volume maior que 5.000, isolamento por conta, seleção completa e execução em lotes sem truncamento.

## 4. Painel lateral de processos nas operações Magalu

Arquivos de referência: `apps/seller-ml/public/js/jobs-panel.js` e `jobs-panel-adapters.js`. Implementar componente Magalu compartilhado em `apps/seller-magalu/public/js/` e estilos em `public/css/`; integrar em `views/app.html`, `public/js/magalu-sku-management.js` e `public/js/magalu-app.js`. Expor agregação em `src/controllers/` e `src/routes/`, usando `skuMassRepository.js` e `writeRepository.js`.

- [ ] Reproduzir estilo e comportamento do painel lateral do ML nas telas Gestão de catálogo, Estoque e Preços: abrir/minimizar, pesquisar processos, acompanhar andamento e consultar resultados após navegar ou recarregar.
- [ ] Apresentar os lotes de catálogo existentes e agregar operações de estoque e preços por confirmação/preview, com identificador estável, conta e tipo de operação. Exibir somente dados autorizados para o tenant e conta selecionada; manter painel sincronizado com o servidor.
- [ ] Para operações acima de 5.000 SKUs, exibir progresso global e de cada lote, com contagens de concluídos, falhas, pendentes e estados incertos; atualizar durante execução sem depender da aba permanecer aberta. Calcular percentual a partir dos estados reais; não marcar pendências incertas como sucesso.
- [ ] Disponibilizar detalhes de falha por SKU e reverificação para operações ambíguas usando fluxo existente. Só oferecer cancelar ou repetir quando houver suporte seguro no servidor; fechar o painel não cancela a operação. Limpar concluídos apenas da visualização, preservando histórico e auditoria.
- [ ] Validar navegação entre as três telas, reconexão, troca de conta, progresso real, falhas, operações simultâneas, separação de tenants e recuperação após recarga. Conferir aparência e responsividade comparando o painel do ML.

## Entrega e validação

- [ ] Executar testes direcionados das alterações e `npm test` em `apps/seller-magalu`.
- [ ] Conferir interface em desktop e telas menores, loading, prévia, erros e cancelamento; verificar resultado de importação e histórico com dados de teste.
- [ ] Validar as duas colunas e os valores do arquivo produzido; testar uma importação com lote pequeno quando houver oportunidade autorizada.
- [ ] Separar commits por etapa; publicar quando solicitado e verificar web/worker conforme escopo implantado.
