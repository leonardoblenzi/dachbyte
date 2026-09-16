# Roteiro de homologacao tecnica — Shopee

Este roteiro valida a integracao Shopee Open Platform V2 do VoltPrice com duas lojas da mesma empresa. Execute-o primeiro em staging; nao cole tokens, Partner Key, codigos de autorizacao ou URLs assinadas em tickets, chat ou capturas de tela.

## Escopo ja validado localmente

- OAuth com `state` opaco de uso unico e cookie `httpOnly` de callback;
- uma conexao por `shop_id`, sem escolha implicita de loja para refresh, sincronizacao, desconexao ou financeiro;
- renovacao manual e automatica com lock por conexao e nova tentativa unica apos falha de token;
- sincronizacao historica/incremental por loja, checkpoint por conexao, paginas e janelas de no maximo 15 dias;
- redacao de campos pessoais antes de persistir payloads de pedido;
- consulta de escrow pelo UUID interno do pedido e pela loja gravada no pedido;
- interface para adicionar, renovar e desconectar lojas individualmente.

Na validacao local desta entrega, `npm --prefix business run test:volt-price` concluiu com **167 testes aprovados**. Os testes Shopee cobrem OAuth, refresh concorrente, sincronizacao, financeiro, resolucao pedido-loja e contratos de interface. Isso nao substitui uma autorizacao real da Shopee.

## Pre-requisitos externos

No ambiente seguro do container `business-price` na VPS, configure os valores secretos:

```ini
VOLT_PRICE_PUBLIC_BASE_URL=https://<host-publico>
VOLT_PRICE_SHOPEE_PARTNER_ID=<id-do-partner>
VOLT_PRICE_SHOPEE_PARTNER_KEY=<partner-key>
```

No Shopee Console do mesmo app, registre exatamente:

```text
https://<host-publico>/business/price/api/integrations/shopee/callback
```

Tambem confirme no console autenticado da Shopee que o app/regiao selecionado permite autorizacao de loja, pedidos e financeiro/escrow. Os paths V2 e a base possuem defaults no `.env.example`; somente altere as variaveis opcionais quando o console do app determinar uma rota/regiao diferente.

O processo deve usar `DB_VOLTPRICE` no runtime e `DB_VOLTPRICE_DIRECT` apenas em migrations. Esta entrega nao adiciona migration Shopee; portanto, nao ha DDL novo a executar para este roteiro.

## Execucao em staging

Use uma empresa de teste com permissao de gerenciar integracoes e duas lojas Shopee diferentes: **Loja A** e **Loja B**.

| Etapa | Procedimento | Criterio de sucesso |
| --- | --- | --- |
| 1. Configuracao | Faca deploy em staging com as tres variaveis acima e `NODE_ENV=production`. | Em Integracoes, **Adicionar loja Shopee** abre o consentimento; nenhum segredo aparece no HTML, URL final, resposta ou log. |
| 2. OAuth Loja A | Autorize a Loja A e volte ao VoltPrice. | Retorno em Integracoes com uma linha `Shopee <shop_id_A>` ativa. Reabrir a mesma URL de callback nao cria conexao nem troca token outra vez. |
| 3. OAuth Loja B | Use **Adicionar loja Shopee** novamente e autorize a Loja B. | Duas linhas ativas, com `shop_id` distintos; agir em B nao modifica A. |
| 4. Refresh | Em cada linha, use **Renovar agora** uma vez. Mantenha ambas conectadas. | A acao atualiza somente a linha selecionada e permanece ativa. Em seguida, confirme nos logs do container `business-price` que a manutencao de token renova conexoes proximas do vencimento sem registrar token. |
| 5. Sync inicial | Em Pedidos, selecione Loja A e execute a sincronizacao. Repita selecionando Loja B. | Cada execucao cria/atualiza seu proprio status e checkpoint; pedidos mostram `Shopee / loja <shop_id>` correspondente. |
| 6. Sync incremental | Execute uma segunda sincronizacao para cada loja apos uma alteracao real de pedido, ou apos o intervalo operacional. | O status informa sucesso e o checkpoint avanca; a consulta incremental usa atualizacao do pedido, sem duplicar registros. |
| 7. Pedido para taxa | Para um pedido sincronizado de cada loja, consulte a taxa na tela de Pedidos/Profit. | A requisicao usa o UUID interno do pedido. O escrow vem da mesma loja ligada ao pedido; trocar loja no navegador nao direciona a consulta para outra conta. |
| 8. Desconexao | Desconecte somente a Loja B; tente sincronizar B e consulte A. | B fica desconectada, sem token utilizavel; A continua ativa e operacional. Reautorizar B volta a ativar apenas B. |

## Evidencias a registrar

Registre somente metadados seguros: data/hora, ambiente, `shop_id` mascarado se exigido pela politica, id interno da conexao, id interno do pedido, status da sincronizacao e resultado de cada etapa. Nao registre `code`, `state`, `access_token`, `refresh_token`, `sign`, Partner Key nem URL de autorizacao assinada.

## Gate multi-loja antes de producao

Durante as etapas 5 e 6, confirme que um pedido de cada loja permanece separado mesmo se os dois `order_sn` forem iguais. A chave atual de persistencia usa `tenant_id`, canal e `source_order_id`; a documentacao publica nao foi acessivel automaticamente nesta validacao para provar que `order_sn` e global entre lojas. Se o teste real ou o console indicar que `order_sn` e unico apenas por loja, **interrompa a promocao para producao** e crie uma migration que inclua o `shop_id` na chave logica de pedidos antes de prosseguir.

## Dependencias que nao podem ser validadas localmente

- credenciais Partner validas e app liberado no Shopee Console;
- callback HTTPS cadastrado para o dominio real da VPS;
- permissoes e disponibilidade dos endpoints para cada loja autorizada;
- emissao, duracao e rotacao reais dos tokens;
- retorno real de pedidos e escrow de cada conta.

Qualquer falha de autorizacao, permissao ou rota deve ser comparada com a configuracao do app no Shopee Console. Nao substitua os defaults por uma URL de loja; a Open Platform e chamada pela base/configuracao de Partner, e a loja e identificada pelo `shop_id` autorizado.
