# Sprint 3 — Fees reais e Profit

## Implementado

- Fee snapshots versionados e imutáveis por pedido/canal.
- Fingerprint para não duplicar respostas financeiras idênticas.
- Apenas um snapshot financeiro corrente por pedido.
- Componentes padronizados de Mercado Livre e Shopee.
- Origem de cada componente: API, ERP, manual ou calculado.
- Comissão, taxas de serviço/transação, descontos seller/marketplace, moedas, afiliados, frete, Ads, impostos, CMV, embalagem e outros custos.
- Profit esperado e realizado, com variação entre ambos.
- Versionamento de cálculo por pedido e vínculo com o fee snapshot utilizado.
- Rateio proporcional por itens/SKU quando o pedido Tray possui itens hidratados.
- Visões agregadas por pedido, canal e SKU.
- UI de Profit com MC esperada, realizada e composição por canal/SKU.

## Banco

- `001_initial.sql`, `002_orders_sync.sql`, `003_reconciliation_backfill.sql` e `004_financial_truth.sql` aplicadas no Neon pela conexão direta.

## Pendente de validação externa

- Conectar contas oficiais Mercado Livre e Shopee.
- Validar pedidos reais, incluindo carrinho/pack, cancelamento, devolução, reembolso e ajustes posteriores.
- Confirmar os campos de escrow Shopee no console oficial do app.
- Comparar fee esperada versus realizada em uma amostra financeira homologada.
- Validar CMV por SKU contra a origem ERP escolhida.
