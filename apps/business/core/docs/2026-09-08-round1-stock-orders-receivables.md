# Volt Core — Rodada 1: estoque reservado, pedidos e recebiveis

Base: `volt_core(2).zip` enviado em 08/09/2026.

## Objetivo

Completar a fundacao operacional antes do novo dashboard. A rodada preserva o pagamento na entrega ja existente no Core e adiciona a camada de reserva de estoque, andamento operacional dos pedidos opticos e uma visao mais gerencial dos recebiveis.

## 1. Reserva de estoque no Core

Foi adicionada a migration `019_stock_reservations.sql` com a tabela tenant-isolated `volt_core.stock_reservations` e RLS forcado.

Regras:

- venda imediata continua gerando baixa fisica em `inventory_movements`;
- venda com `payment_timing=delivery` nao baixa fisicamente no momento do pedido;
- a venda futura cria uma reserva ativa para cada produto que controla estoque;
- disponibilidade passa a ser `fisico - reservado`;
- venda e saida manual nao podem consumir quantidade reservada por outros pedidos;
- ao concluir a entrega, a reserva e consumida e a baixa fisica e criada exatamente uma vez;
- ao cancelar antes da entrega, a reserva e liberada sem criar estorno fisico ficticio;
- pedidos `pending_delivery` existentes sao convertidos pela migration: a baixa antecipada e neutralizada e o compromisso passa a existir como reserva.

A tela de Estoque passa a expor `Fisico`, `Reservado` e `Disponivel`, alem de uma aba `Reservas` com pedido, cliente, quantidade e previsao de entrega.

## 2. Pedidos opticos

A tabela de Pedidos mantem andamento operacional e financeiro separados.

O andamento passa a ser editavel por select somente quando a extensao fornece um workflow valido. As opcoes sao derivadas da extensao optica; o Core nao conhece os estados internos da vertical.

O pedido pronto para retirada exibe `Concluir retirada e receber`. Essa acao chama o endpoint geral do Core `sales/:saleId/complete-delivery`, registra o pagamento real, consome a reserva, cria a baixa fisica, gera o financeiro/recibo e deixa o hook da extensao concluir o pedido optico e a OS na mesma transacao.

Cancelamento e exclusao permanecem em `Mais opcoes` e nao foram misturados ao select de andamento.

## 3. Pagamentos e recebiveis

A pagina Pagamentos ganhou a aba `Pendentes`, reaproveitando o motor geral de recebiveis. A forma `store_credit` passa a aparecer como `Crediario / Carne`, separada semanticamente do timing `Pagar na entrega`, e boleto passa a permitir parcelamento no fechamento (ex.: 3x).

Indicadores adicionados:

- A receber;
- Vencido;
- Vence hoje;
- Proximos 7 dias.

A tabela mostra valor original, recebido, saldo e parcela. Pagamentos parciais continuam usando `paid_amount`; atraso continua sendo derivado do vencimento e do saldo em aberto, sem gravar um status de atraso redundante.

## Integridade e compatibilidade

- `stock_reservations` foi adicionado a validacao das tabelas com RLS forcado.
- produtos e relatorios de estoque usam disponibilidade real, nao apenas saldo fisico;
- recursos lazy do Workspace V2 carregam reservas somente nas telas que precisam delas;
- a extensao Optica apenas fornece workflow e readiness; estoque e liquidacao permanecem no Core.

## Validacao desta entrega

A suite encontrou 207 testes apos os novos testes de reserva. No ambiente de empacotamento Linux, o teste que importa Vite/Rolldown continua dependendo do binding nativo opcional que veio no ZIP apenas para Windows. Os demais testes executam normalmente. O codigo JSX foi validado separadamente com Sucrase e os arquivos CommonJS modificados com `node --check`.
