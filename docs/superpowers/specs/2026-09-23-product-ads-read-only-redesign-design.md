# Product Ads: painel de decisão e gestão segura

## Objetivo

Reorganizar a tela de Publicidade do Seller/ML para priorizar leitura de resultado e eficiência, mantendo todos os insights e a navegação por campanha já existentes. Corrigir a edição de campanha para não disparar chamadas de escrita não suportadas pela API do Mercado Livre.

## Escopo visual

- Manter filtros, período, métrica do gráfico, insights existentes, tabela/lista e navegação por campanha.
- Organizar os indicadores em quatro níveis:
  1. Resultado executivo: receita atribuída, investimento, ROAS e ACOS.
  2. Interpretação: gráfico de receita versus investimento e gráfico de eficiência, acompanhados de TACOS e vendas por publicidade.
  3. Alcance e custo: impressões, cliques, CTR e CPC.
  4. Planejamento: orçamento diário ativo, ritmo médio e projeção mensal em bloco próprio.
- A disposição deve ser responsiva sem ocultar indicadores: quatro colunas executivas em desktop, redução progressiva em tablets e uma coluna em telas estreitas.

## Gestão de campanha

- Trocar o modal de formulário editável por modal de gestão em leitura.
- Exibir nome, orçamento, ROAS, status e contexto da campanha selecionada.
- Explicar que Product Ads não disponibiliza escrita pública para esses atributos.
- Oferecer ação externa para a área de Publicidade do Mercado Livre, em nova aba.
- Preservar abertura do modal a partir de toda navegação por campanha existente; o modal não altera estado nem dados da campanha.

## API e erros

- A rota interna `PATCH /api/publicidade/product-ads/campaigns/:id` não deve mais tentar `PATCH`/`PUT` contra o Mercado Livre.
- Ela responderá de modo determinístico com conflito de capacidade (`409`) e código explícito que informa que a edição externa não é suportada.
- Nenhum dado será salvo localmente como se estivesse aplicado no Mercado Livre.

## Testes e verificação

- Teste de serviço para confirmar que a atualização não executa chamadas externas e retorna a capacidade indisponível.
- Teste de rota/controlador para validar o `409` e o código de erro.
- Testes de marcação/contrato do modal para assegurar a ação externa e ausência de controles de gravação.
- Testes existentes de Product Ads e checagem sintática dos arquivos alterados.

## Fora de escopo

- Não remover insights, filtros, métricas, tabelas ou navegação por campanha.
- Não criar dados locais de orçamento/ROAS/status.
- Não alterar OAuth, token ou permissões do Mercado Livre.
