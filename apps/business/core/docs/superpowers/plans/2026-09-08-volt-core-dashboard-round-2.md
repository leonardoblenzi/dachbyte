# Volt Core — Rodada 2: Dashboard compacto e orientado à operação

Data: 2026-09-08
Base: Rodada 1 (`stock_reservations`, fluxo de retirada/recebimento e pendências financeiras)

## Objetivo

Reorganizar o Dashboard do Volt Core como uma central de trabalho, sem transformar a página em um BI poluído. A tela deve preservar os atalhos operacionais, destacar somente exceções relevantes e manter a separação arquitetural entre Core e extensões.

## Decisões de UX

1. Manter uma faixa compacta de ações rápidas.
2. Limitar o topo a KPIs realmente úteis: vendas de hoje, recebido hoje, a receber, vencido e caixa, respeitando módulos e permissões ativos.
3. Usar um único bloco `Precisa de atenção`, com no máximo cinco exceções priorizadas.
4. Separar operação e financeiro em dois cards compactos.
5. Resumir estoque em físico, reservado, disponível e crítico; detalhamento continua na tela de Estoque.
6. Deixar gráfico de vendas abaixo da operação, com alternância de 7/30 dias.
7. Não incluir atividade recente, rankings extensos, tabelas grandes ou vários gráficos no dashboard principal.
8. Todos os atalhos do dashboard abrem a tela de destino já no contexto correto quando aplicável (aba, filtro e período).

## Arquitetura

### Core

O Core fornece:

- KPIs financeiros e comerciais gerais;
- resumo de recebíveis;
- resumo de estoque físico/reservado/disponível;
- resumo do caixa;
- tendência de vendas;
- alertas gerais de recebíveis, despesas e estoque;
- navegação contextual;
- filtragem do payload por RBAC antes da resposta ao navegador.

O Core não contém conceitos específicos de Ótica no serviço do Dashboard.

### Extensões

Extensões usam `dashboard.contribute` para fornecer widgets e alertas operacionais.

A extensão `vertical.optical` fornece:

- Em produção;
- Prontos para retirada;
- Atrasados;
- Concluídos hoje;
- alerta agregado para pedidos atrasados;
- alerta agregado para pedidos prontos aguardando retirada.

## Navegação contextual

Foi introduzido um `navigationIntent` no shell do frontend para permitir que o Dashboard abra a tela de destino com contexto, por exemplo:

- Financeiro → Pendentes → Vencidos;
- Estoque → Reservas;
- Estoque → Críticos;
- Pedidos → Em produção;
- Pedidos → Pronto para retirada;
- Pedidos → Entrega atrasada;
- Pedidos → Concluído hoje.

`OperationalList` passou a aceitar `initialFilter`, preservando o comportamento normal fora de navegações originadas no Dashboard.

## RBAC

O backend remove do payload do Dashboard qualquer métrica, alerta, widget, resumo financeiro, estoque, caixa ou tendência de vendas que o usuário não tenha permissão para consultar. O frontend também usa as telas e permissões habilitadas para não renderizar atalhos sem destino válido.

## Arquivos principais

- `src/modules/core/runtime/services/dashboardService.js`
- `src/extensions/optical/backend/entityHooks.js`
- `src/controllers/RuntimeController.js`
- `src/modules/core/runtime/services/dataQueryService.js`
- `src/client/main.jsx`
- `src/client/components/OperationalList.jsx`
- `src/client/styles.css`
- `src/modules/core/dashboardRound2.test.js`

## Validação

- Testes específicos da Rodada 2: 6/6 aprovados.
- Suíte completa: 213 testes encontrados; 212 aprovados e 1 impedido pelo binding nativo Linux do Rolldown ausente no `node_modules` fornecido no ZIP.
- Arquivos backend alterados passaram em `node -c`.
- JSX alterado foi validado com Sucrase.
- O build Vite não pôde ser executado neste ambiente pelo mesmo binding nativo do Rolldown (`@rolldown/binding-linux-x64-gnu`) ausente; o ZIP original contém dependências preparadas para outro sistema operacional.

## Fora de escopo desta rodada

- Dashboard personalizável por drag-and-drop.
- Histórico/atividade recente no Dashboard.
- Rankings extensos de produtos/clientes.
- Novos gráficos de BI.
- Mudança da arquitetura financeira da Rodada 1.
