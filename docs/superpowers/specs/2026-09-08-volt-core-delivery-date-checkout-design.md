# Previsao de entrega no resumo do PDV

## Objetivo

Simplificar o registro de pedidos com pagamento na entrega, posicionando a previsao no ponto em que o operador escolhe essa modalidade.

## Interface

- Renomear a secao `Cliente e entrega` para `Cliente`.
- Remover completamente `Previsao de entrega` dessa secao.
- Exibir `Previsao de entrega` no resumo da venda somente quando `Pagar na entrega` estiver selecionado.
- Posicionar o campo abaixo do aviso de valor a receber e antes da situacao optica.
- Usar um campo nativo de data, sem horario, com preenchimento obrigatorio nessa modalidade.
- Ocultar o campo novamente ao retornar para `Pagar agora`, preservando o valor digitado no rascunho caso o operador alterne por engano.

## Dados e validacao

- Manter `promisedDate` no rascunho e `promisedDeliveryDate` no envio da venda.
- Manter a coluna `promised_delivery_date` como `date`; nenhuma migracao e necessaria.
- A tentativa de criar o pedido sem a data continua exibindo `Informe a previsao de entrega para criar o pedido.`
- A data continua aparecendo automaticamente na listagem de pedidos.

## Verificacao

- Testar que o campo nao aparece na secao de cliente.
- Testar que o campo aparece apenas com `Pagar na entrega`.
- Testar que permanece obrigatorio para criar o pedido.
- Executar a regressao completa e o build de producao.
