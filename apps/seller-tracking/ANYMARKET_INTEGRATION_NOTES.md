# ANYMARKET Integration Notes

Resumo tecnico levantado a partir da documentacao entregue em `public/DOC ANY.docx` e do link oficial apontado por ela.

## Fontes

- Documentacao local: `public/DOC ANY.docx`
- Portal oficial informado no proprio arquivo: `https://developers.anymarket.com.br/api/v2/s9jktvq42tth1-orders/orders`
- Base sandbox: `https://sandbox-api.anymarket.com.br/v2`
- Base producao: `https://api.anymarket.com.br/v2`

## Autenticacao

- Header obrigatorio: `gumgaToken`
- Header adicional recomendado/obrigatorio para identificar o integrador: `platform`
- Tokens de sandbox e producao sao diferentes
- O comportamento funcional entre sandbox e producao e equivalente, mudando o host e o token

## Endpoints confirmados na documentacao recebida

### `GET /orders`

Uso principal para importacao e sincronizacao de pedidos.

Filtros documentados:

- `createdAfter`
- `createdBefore`
- `updatedAfter`
- `updatedBefore`
- `marketplace`
- `marketplaceId`
- `partnerId`
- `shippingId`
- `status`
- `sort`
- `sortDirection`
- `offset`
- `limit`

Restricoes documentadas:

- Sem filtros, o retorno fica limitado aos pedidos criados nos ultimos 120 dias
- `createdAfter` + `createdBefore`: janela maxima de 120 dias
- `updatedAfter` + `updatedBefore`: janela maxima de 7 dias
- Quando o volume sem filtro ultrapassa 30 mil registros, `totalElements` pode vir aproximado
- `limit` aceita ate 100 registros por chamada

Status de pedido documentados:

- `PENDING`
- `DELIVERY_ISSUE`
- `PAID_WAITING_SHIP`
- `INVOICED`
- `PAID_WAITING_DELIVERY`
- `CONCLUDED`
- `CANCELED`

Campos relevantes mapeados no payload de pedido:

- Identificacao: `id`, `marketPlaceId`, `marketPlaceNumber`, `partnerId`, `accountName`
- Canal: `marketPlace`, `subChannel`, `subChannelNormalized`
- Datas: `createdAt`, `paymentDate`, `cancelDate`, `updatedAt`
- Status: `status`, `marketPlaceStatus`, `marketPlaceStatusComplement`, `marketPlaceShipmentStatus`
- Financeiro: desconto, frete, custo de frete, total bruto, total do pedido
- Operacao: `fulfillment`, `quoteReconciliation`, `extraFields`, `orderTypeName`
- Nota: `invoice.accessKey`, `invoice.series`, `invoice.number`, `invoice.date`, `invoice.linkNfe`, `invoice.invoiceLink`
- Rastreio: `tracking.carrier`, `tracking.date`, `tracking.number`, `tracking.url`, `tracking.status`, `tracking.deliveredDate`, `tracking.estimateDate`
- Destinatario/retirada: `shipmentUserDocument`, `shipmentUserDocumentType`, `shipmentUserName`

### `GET /orders/{id}/nfe/type/{type}`

Observacoes:

- Marcado como `Deprecated` na documentacao entregue
- Serve para buscar XML de NF-e
- Tipos documentados incluem `sale`, `sale_return`, `sale_devolution` e outros tipos fiscais/operacionais

### `POST /freight/quotes`

Uso:

- Cotacao de frete para um conjunto de produtos e CEP

Campos documentados no corpo:

- `zipCode`
- `marketPlace`
- `additionalPercentual`
- `timeout`
- `products[]`

## Rate limit e resiliencia

A documentacao entregue nao expunha de forma legivel um numero fixo unico de requests por minuto dentro do arquivo extraido, entao a estrategia correta para a implementacao deve ser orientada pelos headers retornados pela propria API:

- `ratelimit-limit`
- `ratelimit-remaining`
- `ratelimit-reset`

Comportamento recomendado:

- Trabalhar com pagina de `limit=100` para reduzir numero de chamadas
- Sincronizar por `updatedAfter`/`updatedBefore` em janelas pequenas de ate 7 dias
- Recuar imediatamente quando `ratelimit-remaining` estiver proximo de zero
- Em `429`, aguardar pelo menos o tempo indicado em `ratelimit-reset` antes de repetir
- Evitar varrer 120 dias inteiros em uma unica rotina recorrente; preferir cursor incremental

## Mapeamento sugerido para o modelo `Order` atual

Sugestao inicial para quando a integracao for implementada no backend:

- `orderNumber`: priorizar `id` do ANYMARKET; manter `partnerId` e `marketPlaceId` dentro de `apiRawPayload`
- `invoiceNumber`: `invoice.number`
- `trackingCode`: `tracking.number`
- `customerName`: derivar do destinatario/cliente retornado no payload
- `salesChannel`: combinar `ANYMARKET - {marketPlace}` com `subChannelNormalized` quando existir
- `freightType`: usar carrier/logica de envio disponivel no pedido
- `freightValue`: valor de frete do pedido
- `shippingDate`: `tracking.date`
- `estimatedDeliveryDate`: `tracking.estimateDate`
- `recipient`: `shipmentUserName`
- `cpf`/`cnpj`: derivar de `shipmentUserDocument` e `shipmentUserDocumentType`
- `status`: mapear a partir de `status` e, quando necessario, complementar com `marketPlaceShipmentStatus`
- `apiRawPayload`: armazenar o payload integral do ANYMARKET

## Pendencias para a implementacao completa

- Criar credenciais por empresa para `gumgaToken` e identificacao `platform`
- Implementar service dedicado no backend, espelhando o padrao de `TrayApiService`
- Criar rate limiter que respeite os headers reais retornados pela API
- Definir traducao de status do ANYMARKET para `OrderStatus`
- Definir chave de idempotencia para evitar duplicacao entre `id`, `partnerId` e `marketPlaceId`
