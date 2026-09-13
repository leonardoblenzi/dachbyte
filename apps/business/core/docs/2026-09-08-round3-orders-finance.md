# Rodada 3 — Pedidos simples, entrega por acao e financeiro independente

## Objetivo

Simplificar a operacao da tela de Pedidos sem perder o workflow tecnico da extensao Otica, mantendo o ciclo financeiro independente do encerramento operacional.

## Implementado

- Status comercial do pedido reduzido a `Em andamento`, `Concluido` e `Cancelado`.
- Removido o select tecnico de andamento da tabela de Pedidos.
- A coluna Entrega passa a mostrar o macroestado: `Em producao`, `Pronto para retirada`, `Entregue` ou `Venda imediata`.
- Acao `Marcar como pronto` para pedidos opticos em andamento. A acao e um comando de dominio da extensao, registra workflow, evento e auditoria e sincroniza a OS vinculada.
- Acao principal `Concluir pedido` quando o pedido esta pronto.
- O checkout de conclusao aceita combinacao de recebimento imediato e formas a prazo (ex.: entrada em PIX + boleto/crediario parcelado).
- Concluir o pedido encerra entrega/estoque, mas os recebiveis futuros permanecem abertos no Core Financeiro.
- A coluna Financeiro agora e clicavel e explicita saldo, parcelas abertas e valores vencidos.
- Modal financeiro do pedido mostra total, recebido, saldo, situacao e parcelas; parcelas em aberto podem ser baixadas pela acao `Receber`.
- Atalho `Ver em Recebiveis` abre o Contas a receber pesquisando a venda de origem.
- A lista de Recebiveis passou a aceitar busca inicial para navegacao contextual.
- Filtros server-side de Pedidos reconhecem `Em andamento`, `A receber` e `Vencidos`.

## Regra final

- Pedido responde: o trabalho/entrega terminou?
- Financeiro responde: o dinheiro terminou?

Assim, um pedido pode estar `Concluido` e simultaneamente exibir `R$ 600,00 a receber - 2 parcelas`, ou `R$ 300,00 vencidos`.

## Validacao

- `preGoLiveRegression.test.js`: 35/35 aprovados.
- Suite completa: 212/213 aprovados; a unica falha continua sendo o binding nativo Linux do Rolldown/Vite ausente no `node_modules` recebido.
- JSX alterado validado com Sucrase.
- Backend alterado validado com `node --check`.
- Build Vite nao executa neste ambiente pelo mesmo binding opcional `@rolldown/binding-linux-x64-gnu` ausente.
