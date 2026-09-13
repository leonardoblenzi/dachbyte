# Volt Core: Pedido com Pagamento na Entrega e PDV Óptico

## Objetivo

Permitir que o operador crie um pedido óptico com total definido e pagamento a ser informado somente na retirada. A criação reserva os itens e inicia a produção, mas não movimenta caixa nem gera recebíveis. Na entrega, o operador informa a entrada real, a forma de pagamento, as parcelas e o primeiro vencimento; então o pedido é entregue e o financeiro é lançado.

## Escopo

- Corrigir a rota pública `GET /core`, que deve servir a landing do Volt Core.
- Atualizar o PDV óptico para oferecer `Pagar agora` e `Pagar na entrega`.
- Reestruturar a receita óptica em grade clínica para longe e perto e eliminar títulos auxiliares redundantes nos blocos de cliente, receita, medidas e laboratório.
- Criar o ciclo persistente de pedido pendente de entrega, conclusão na retirada e geração posterior de caixa e recebíveis.
- Exibir andamento do pedido e situação financeira na lista atual de Pedidos.

## Fora de Escopo

- Emissão de carnê ou boleto por provedor externo.
- Cobrança automática ao cliente.
- Entregas parciais de um mesmo pedido.
- Mudança do fluxo de pagamento de vendas que usam `Pagar agora`.

## Estado e Regras de Negócio

Uma venda criada com `paymentTiming: delivery` terá o status persistido `pending_delivery`, total, itens, cliente obrigatório e previsão de entrega obrigatória. Ela cria a ordem óptica e a OS normalmente. O estoque dos produtos controlados é reservado pela mesma saída que hoje protege a disponibilidade, porém a movimentação terá descrição de reserva do pedido.

Enquanto estiver pendente, o pedido não cria movimentos de caixa, recebíveis, recibo final ou documento fiscal. A configuração que exige caixa aberto só será validada ao concluir a retirada.

A conclusão recebe pagamentos reais cuja soma deve ser igual ao total do pedido. Métodos imediatos criam movimento no caixa; `store_credit`, cheque, nota promissória e boleto criam recebíveis parcelados a partir do primeiro vencimento informado. O pedido passa para `finalized`, recebe `deliveredAt` e mantém o total original.

O cancelamento de um pedido pendente restaura a reserva de estoque e cancela OP/OS vinculadas, sem tentar estornar caixa ou recebíveis inexistentes.

## Experiência do Operador

No PDV, `Pagar na entrega` esconde as formas de pagamento e torna a previsão de entrega obrigatória. O botão e a revisão mudam de `Finalizar venda` para `Criar pedido`. A revisão explica que o total está definido, mas o pagamento será registrado na retirada.

Na lista atual de Pedidos, a coluna de status apresenta o andamento operacional derivado da OP/OS: `Em produção`, `Pronto para retirada`, `Entregue` ou `Cancelado`. A coluna Financeiro mostra, antes da retirada, `R$ X a receber` e `Pagamento definido na retirada`; depois dela, mostra a entrada recebida e o saldo parcelado. Para um pedido pronto, a ação principal é `Concluir retirada`; as ações secundárias ficam no menu contextual.

O modal de conclusão exibe pedido, cliente e total de forma fixa. O operador informa somente o que aconteceu no balcão: pagamento integral ou entrada, forma de recebimento, saldo parcelado e primeiro vencimento. A confirmação atomiza a entrega, os lançamentos financeiros e a atualização dos vínculos ópticos.

## Receita Óptica e Microcopy

A receita do PDV terá dados clínicos no topo e uma grade com as colunas Esférico, Cilíndrico, Eixo, Adição e DNP, para OD/OE em `Para longe` e `Para perto`. Os valores de longe usam os campos clínicos atuais; valores completos de perto são preservados em `metadata.near` para manter compatibilidade com a base atual.

Cada bloco terá um único título. Rótulos redundantes como `Receita do cliente`, `Medidas de montagem`, o segundo `Laboratório` e o rótulo visual duplicado de cliente serão removidos, mantendo nomes acessíveis nos controles e mensagens que comunicam regras operacionais.

## Persistência e Leitura

Uma migration adicionará `payment_timing`, `promised_delivery_date` e `delivered_at` à tabela `volt_core.sales`, com índice por empresa, status e previsão. A consulta paginada de vendas retornará esses campos e o estado óptico vinculado para que a lista não dependa de coleções carregadas no navegador.

O serviço de vendas terá limites explícitos entre criar pedido pendente, concluir entrega, editar e cancelar. A lógica de normalização de pagamentos será compartilhada para que a venda imediata e a conclusão na entrega usem as mesmas validações e o mesmo parcelamento.

## Critérios de Aceite

1. `GET /core` retorna HTML da landing do Volt Core.
2. Um pedido óptico com pagamento na entrega exige cliente e previsão, reserva estoque e não cria caixa ou recebíveis.
3. A conclusão de um pedido pendente exige pagamentos que cubram o total, cria os lançamentos corretos e é idempotente contra repetição acidental.
4. Cancelar pedido pendente restaura estoque e não tenta estornar lançamentos financeiros.
5. A lista mostra total e valor a receber antes da retirada, e entrada mais parcelas depois dela.
6. Vendas de pagamento imediato continuam com o fluxo e os lançamentos atuais.
7. A grade de receita preserva longe e perto no payload e não reintroduz textos redundantes.
