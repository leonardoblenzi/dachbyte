# Sprint 6 — Market

Status: implementada.

## Entregue

- Fontes competitivas por API oficial, importação ou lançamento manual.
- Adaptador Mercado Livre para busca de listings ativos por seller ID ou nickname.
- Listings concorrentes normalizados com seller, preço, disponibilidade, URL, GTIN/EAN, marca e MPN.
- Histórico de observações idempotente e versionado, inclusive reversão de preço no mesmo período.
- Matching automático somente por GTIN/EAN ou marca + MPN exatos.
- Similaridade de título e ambiguidades encaminhadas para revisão humana.
- Aprovação e rejeição manual de associações com audit log.
- Mediana, quartis, extremos, posição do preço próprio e faixa competitiva por SKU.
- Sinais persistidos de novos anúncios, mudança de preço, ruptura, retorno ao estoque e posição frente ao mercado.
- Snapshot parcial nunca gera falsa ruptura; desaparecimento só é considerado OOS após paginação completa.
- Workspace Market com radar, faixas, sinais, listings e fila de associação.
- RLS/FORCE RLS e validação tenant nas novas entidades.

## Limites conscientes

- Shopee, Amazon, Magalu e demais canais entram pelo contrato comum de importação até existir uma API oficial/fornecedor escolhido e credenciado.
- Nenhum scraping foi adicionado.
- Os sinais alimentam a próxima sprint, mas ainda não executam alterações de preço.
