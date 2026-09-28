# Magalu: dashboard comercial e gestão unificada de catálogo

**Data:** 2026-09-28  
**Status:** aprovado para planejamento técnico

## Objetivo

Evoluir o Seller Magalu para uma experiência operacional coerente com os módulos ML e Shopee, sem copiar sua identidade visual nem reduzir as proteções existentes de OAuth, Hub, preview, escrita remota e reconciliação.

O escopo reúne quatro resultados:

1. um dashboard comercial baseado apenas em dados locais realmente sincronizados;
2. uma única gestão de catálogo, substituindo a duplicidade entre `Catálogo` e `Gestão de SKUs`;
3. seleção de itens por filtros, SKU único ou lista colada de SKUs;
4. uma navegação sem a duplicidade visível entre Sincronização e Integrações.

## Situação atual observada

- O dashboard apresenta saúde de conta, catálogo e sincronização, mas não usa as estatísticas comerciais já disponíveis em `magalu.orders`.
- `orderRepository.stats()` já expõe pedidos hoje, 7/30 dias, faturamento bruto de 30 dias e distribuição de entregas.
- `catalogRepository.stats()` já expõe contadores de catálogo, preço e estoque.
- `/magalu/catalogo` e `/magalu/gestao-skus` consultam essencialmente a mesma réplica de SKU. A segunda acrescenta seleção e operação em lote.
- A rota `/magalu/sincronizacao` já redireciona para `/magalu/integracoes`, porém os dois destinos ainda aparecem na interface e no JavaScript.
- A interface resume incorretamente os scopes como três permissões de leitura, embora a integração possua grupos adicionais de catálogo, pedidos, entregas e documentos fiscais.

## Decisões de produto

### Dashboard

O Painel passa a priorizar indicadores que o módulo consegue comprovar:

- pedidos hoje, últimos 7 dias e últimos 30 dias;
- faturamento bruto dos últimos 30 dias;
- ticket médio, calculado apenas sobre o mesmo conjunto de pedidos do faturamento;
- distribuição e atenção de entregas;
- saúde de catálogo: SKUs publicados, sem preço, estoque zerado e última sincronização;
- operações recentes e estados que requerem reconciliação.

Uma série temporal e projeção somente entram depois que o repositório devolver agregados diários suficientes. Qualquer projeção deve deixar explícito período, método e limitação; não será apresentada como previsão garantida.

Ads não receberá números fictícios. Enquanto não houver contrato oficial, scopes aprovados e réplica local de Ads Magalu, o dashboard exibirá uma integração pendente, sem simular investimento, vendas ou ROAS.

### Gestão unificada de catálogo

`/magalu/gestao-skus` torna-se a superfície principal e recebe nome de navegação **Gestão de catálogo**. O catálogo simples deixa de ser uma tela concorrente; se for mantida uma rota legada, ela redireciona para a gestão unificada.

A seleção terá três modos mutuamente exclusivos:

1. **Filtros:** busca por SKU/título e filtros suportados pela réplica local;
2. **SKU único:** um SKU exato;
3. **Lista de SKUs:** campo multilinha que aceita quebra de linha, vírgula e ponto-e-vírgula.

Ao colar uma lista, o cliente normaliza espaços, remove entradas vazias, deduplica preservando a primeira ocorrência e apresenta total informado, total único, encontrados e não encontrados. O backend permanece a autoridade: resolve os SKUs dentro da conta selecionada e não permite selecionar uma conta diferente pela interface.

Os filtros iniciais usam somente campos já normalizados no espelho local: SKU/título, estado, ativo, marca, categoria, fulfillment, faixa de preço, estoque e atualização. Campos sem coluna confiável — como EAN — não serão prometidos sem uma evolução explícita do modelo.

### Operações

Ativar/desativar SKU continua usando o atual motor massivo. Preço e estoque continuam usando seus próprios previews, leitura fresca, revalidação Hub com `force: true`, filas dedicadas e reconciliação. A unificação é de experiência e seleção, não de semântica de escrita.

Nenhuma operação será disparada diretamente da tabela. Todo write preserva:

- preview persistido e de uso único;
- confirmação explícita;
- comparação com estado remoto antes do dispatch;
- persistência `dispatching` antes da chamada remota;
- tratamento `stale`, `uncertain` e `divergent`;
- reverificação exclusivamente por GET quando aplicável.

### Navegação e compatibilidade

Navegação proposta:

```
Visão geral
Produtos
  Gestão de catálogo
Pedidos
  Pedidos e entregas
Operações
  Preços
  Estoque
  Histórico de operações
Conta
  Contas Magalu
  Integrações
```

`/magalu/catalogo` e `/magalu/sincronizacao` preservam redirecionamentos para não quebrar favoritos, notificações ou links externos. Apenas seus itens duplicados deixam de aparecer no menu.

O Master permanece administrativo e separado da experiência operacional do seller.

## Arquitetura e contrato

- O dashboard receberá um endpoint agregado do módulo, em vez de o navegador combinar dados de múltiplas telas.
- O endpoint usa a conta global selecionada e a mesma barreira Hub-first de todos os endpoints Magalu.
- O repositório de pedidos ganha agregados necessários para ticket médio e, em fase posterior, séries diárias. Nenhum PII novo será retornado.
- A listagem de catálogo aceita um modo explícito de resolução de SKUs para a lista colada. Ela devolve itens encontrados e identificadores não encontrados, sempre limitados e paginados para evitar payloads excessivos.
- A seleção por “todos filtrados” continuará carregando o filtro no preview; a seleção por SKU/lista passa SKUs explícitos ao motor existente. Ambas serão contabilizadas e auditadas do mesmo modo.
- A API nunca expõe tokens, refresh tokens, segredos de webhook ou credenciais OAuth.

## Critérios de aceite

1. A Gestão de catálogo permite filtros, SKU único e lista de SKUs, com normalização e relatório de itens inexistentes.
2. Os três modos respeitam a conta Magalu global selecionada.
3. Preview, confirmação, Hub e reconciliação das escritas existentes não sofrem regressão.
4. A rota antiga de catálogo redireciona sem erro e não há dois itens de menu para a mesma superfície.
5. Integrações é a única área visível para diagnóstico/sincronização; a rota antiga segue compatível.
6. O dashboard mostra métricas comerciais com definição clara e estados vazios honestos.
7. Ads não mostra métricas até uma integração oficial existir.
8. A contagem de permissões é derivada dos grupos reais de scopes, não de uma constante de três itens.
9. Testes cobrem parser de lista, isolamento por conta, seleção explícita, redirects legados, agregados de dashboard e regressão dos fluxos protegidos.

## Fora de escopo nesta entrega

- Integração remota de Ads Magalu.
- Previsão comercial avançada ou modelo estatístico de demanda.
- Campos de catálogo que ainda não estão normalizados.
- Alteração dos contratos remotos Magalu.
- Alteração do modelo de cobrança ou entitlements do Hub.
