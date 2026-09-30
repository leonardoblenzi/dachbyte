# Promoções Magalu — descoberta atual e ativação segura de operações

**Data:** 2026-09-30
**Status:** design aprovado visualmente; implementação depende do recorte de disponibilidade da Open API.

## Decisão

Adicionar **Promoções** ao Seller Magalu como uma área visual e operacionalmente consistente com o Seller ML, mas sem importar runtime, serviços, endpoints ou regras do Mercado Livre.

O módulo não exibirá `Criar promoção`, `Promoções criadas`, nem controles de adesão, inclusão ou remoção de SKU enquanto a Open API Magalu não liberar essas operações para a aplicação e para a conta conectada. Não haverá botões desabilitados que pareçam produto pronto: funcionalidades indisponíveis simplesmente não integram a primeira entrega.

## Evidência de plataforma em 2026-09-30

A [visão geral da API Promocional da Magalu](https://developers.magalu.com/docs/apis/promotions/overview/index.html) descreve o produto completo, seus tipos (`absolute_discount`, `percentage_discount`, `coupon_discount`, `fidelity_discount`) e as origens `channel` e `self_service`. Porém, a mesma página declara que a liberação é faseada e informa como disponíveis, no momento, somente:

1. listar promoções disponíveis para o seller;
2. consultar uma promoção por ID.

Ela também descreve os escopos necessários para as capacidades futuras:

| Capacidade | Escopo |
| --- | --- |
| Ler promoções e dados relacionados | `open:promotion-promotions-seller:read` |
| Ler SKUs da promoção | `open:promotion-skus-seller:read` |
| Alterar SKUs da promoção | `open:promotion-skus-seller:write` |
| Aderir ou cancelar inscrição | `open:promotion-subscriptions-seller:write` |

O endpoint de listagem já respondeu `200` na conta de teste durante a validação anterior, com quatro promoções retornadas. Isso autoriza a experiência de descoberta, mas **não prova** a disponibilidade das escritas. Scopes solicitados ou presentes no token também não são prova suficiente: a liberação deve ser confirmada por endpoint, em conta controlada, antes de expor uma ação.

## Referência de experiência

O Portal Magalu mostra a seguinte organização, que é a referência primária do domínio:

- `Promoções disponíveis`;
- `Participando`;
- cards com tipo/benefício, investimento do seller, prazo de adesão e vigência;
- detalhe de campanha antes de operar SKUs;
- gerenciamento de SKUs como consequência da campanha escolhida.

O Seller ML é referência de ergonomia operacional, não de implementação: filtros claros, modo por catálogo/SKU/lista, seleção em lote, preview, confirmação, progresso e auditoria. A Magalu conservará seu próprio shell, `mg-*` tokens e APIs.

## Experiência disponível agora — leitura

### Rota e navegação

- Nova rota: `GET /magalu/promocoes`.
- Novo item `Promoções` na sidebar, entre `Operações` e `Precificação`, com mesmo card, ícone, expansão e comportamento responsivo já adotados no Seller Magalu.
- A rota usa a conta global escolhida na sidebar; não cria seletor duplicado no conteúdo.

### Tela

1. **Hero padrão Magalu**: título `Promoções`, subtítulo de descoberta de campanhas e estado da última sincronização.
2. **Abas**: `Disponíveis` e `Participando` apenas se a resposta oficial expuser participação; nenhuma aba `Criadas`.
3. **Filter card padrão**: busca por nome/benefício, tipo de promoção, origem, status/ciclo de vida e período. Controles de 42px e `gap: 12px`, iguais aos demais workspaces Magalu.
4. **Cards de campanha**: nome, tipo, origem, status, benefício, contribuição do seller quando o payload a trouxer, prazo de adesão, vigência e botão `Ver detalhes`.
5. **Detalhe somente leitura**: regras, elegibilidade retornada, período, histórico remoto exposto e SKUs apenas se o endpoint/read scope correspondente também estiver de fato disponível.
6. **Estados honestos**:
   - sem elegibilidade: `Nenhuma promoção disponível para esta conta`;
   - escopo ausente: `Reconecte a conta para consultar promoções`;
   - recurso ainda não liberado: não renderizar a superfície dependente;
   - `403`/`404`: explicar indisponibilidade da integração, sem apresentar uma ação falsa.

Não haverá nova migration, nova fila ou worker nessa entrega de leitura. A fonte será remota, com cache local curto e invalidável por conta para evitar atrasar atualizações comerciais.

## Experiência alvo — somente quando escritas forem habilitadas

Quando e somente quando o teste de capacidade confirmar leitura e escrita na conta controlada, a mesma tela passa a exibir o seguinte fluxo:

```text
Campanha disponível
  → detalhes, regras e investimento do seller
  → aderir à campanha (preview + confirmação)
  → gerenciar SKUs
       origem: catálogo | SKU específico | lista de SKUs
       alteração: incluir | atualizar dados permitidos | remover
  → revisar mudanças pendentes
  → aplicar alterações pendentes (confirmação separada)
```

A separação entre alterar SKUs e aplicar será preservada se o contrato remoto exigir a consolidação explícita. Nunca será acionada automaticamente após a seleção dos SKUs.

### Proteções obrigatórias da fase de escrita

- `WRITE magalu` no Hub no controller e novamente no worker imediatamente antes do envio remoto (`force: true`);
- conta, tenant DACH e usuário DACH vinculados ao preview e à operação;
- leitura do estado remoto antes da ação; mudança desde o preview resulta em `stale`;
- persistir `dispatching` antes da chamada externa;
- timeout, rede, `408` ou `5xx` após `dispatching` resultam em `uncertain`; a retomada faz somente reconciliação por GET, nunca repete uma escrita sem prova;
- lock por `conta + promoção + SKU` para não disputar mudanças pendentes;
- preview de uso único, expiração curta e hash do pedido;
- confirmação explícita para adesão, cancelamento, inclusão, atualização, remoção e aplicação final;
- auditoria sanitizada: nenhum token, secret, cookie ou `Authorization` em eventos, respostas ou interface;
- limite por conta conservador e configurável, definido após o limite oficial ser confirmado para os endpoints efetivamente liberados.

### Modelo de dados futuro

Uma migration futura, criada somente após a prova de capacidade, terá tabelas próprias em vez de reutilizar `mass_operation_items`, cujo contrato atual aceita apenas `activate`/`deactivate`:

- `magalu.promotions`: espelho da promoção e seus campos de leitura;
- `magalu.promotion_skus`: associação e estado observado de cada SKU;
- `magalu.promotion_previews`: preview imutável, escopo de identidade e expiração;
- `magalu.promotion_operations`: adesão/cancelamento/aplicação;
- `magalu.promotion_operation_items`: inclusões, alterações e remoções de SKU;
- `magalu.promotion_sync_runs`: diagnóstico de leitura e request-id.

Os estados de item devem seguir o vocabulário seguro já utilizado no módulo: `queued`, `running`, `dispatching`, `accepted`, `succeeded`, `stale`, `failed`, `divergent`, `uncertain` e `canceled`. A operação de aplicar poderá ter estado `pending_remote` enquanto a Magalu aceitar mudanças sem ainda refletir o estado final.

### Worker e webhooks futuros

- Fila dedicada: `magalu-promotion-update`, com worker próprio e concorrência/limite específicos.
- Fila de sync: usar uma fila dedicada ou extensão explícita e isolada da sincronização de catálogo; não esconder jobs de promoções dentro de `magalu-catalog-sync`.
- Webhooks a habilitar depois de confirmar a assinatura no onboarding: `promotions_promotion` e `promotions_sku`.
- O receiver existente continua responsável pela assinatura HMAC, corpo bruto, idempotência e enfileiramento. O processador apenas reconcilia a promoção ou o SKU afetado.

## Gating de disponibilidade

O backend publicará um objeto por conta, calculado server-side, por exemplo:

```json
{
  "list": true,
  "detail": true,
  "promotionSkuRead": false,
  "promotionSkuWrite": false,
  "subscriptionWrite": false,
  "apply": false
}
```

Ele combina três condições para cada capacidade:

1. scope concedido no token vigente;
2. feature flag da implantação (`false` por padrão para escrita);
3. teste remoto controlado que confirme que o endpoint é utilizável pela aplicação e pela conta.

O frontend só recebe capacidades efetivas; não recebe tokens, headers, client secret ou dados de diagnóstico sensíveis.

## Contratos de API internos propostos

Fase de leitura:

```text
GET /magalu/api/promotions/capabilities
GET /magalu/api/promotions
GET /magalu/api/promotions/:promotionId
GET /magalu/api/promotions/:promotionId/skus       (somente se capability efetiva)
```

Fase de escrita, só depois do gate:

```text
POST /magalu/api/promotions/:promotionId/subscription/preview
POST /magalu/api/promotions/:promotionId/subscription/apply
POST /magalu/api/promotions/:promotionId/skus/preview
POST /magalu/api/promotions/:promotionId/skus/apply
POST /magalu/api/promotions/:promotionId/apply/preview
POST /magalu/api/promotions/:promotionId/apply
POST /magalu/api/promotions/operations/:operationId/reverify
```

As rotas internas nunca espelham tokens nem aceitam payloads remotos brutos sem validação estrita.

## Critérios de aceite

### Leitura

- A sidebar e o canvas seguem os mesmos tokens, largura, hero e filter-card do Magalu atual.
- Nenhuma referência de runtime a `/ml`, `seller-ml`, serviços Meli ou endpoints Meli.
- Dados de campanhas vêm apenas da conta selecionada e exigem `READ magalu` no Hub.
- Uma resposta vazia `200` representa elegibilidade vazia, não erro.
- Nenhuma CTA de criação, adesão ou alteração é renderizada enquanto as capabilities efetivas forem falsas.
- Erros preservam HTTP status e `request-id` internamente/auditável, sem expor tokens.

### Escrita futura

- O primeiro teste ocorre em sandbox ou conta controlada, com uma campanha e um SKU reversível.
- Uma falha em qualquer preflight mantém todas as escritas desligadas.
- Os testes cobrem request repetido, expiração de preview, revogação Hub antes do dispatch, alteração remota desde preview, crash após dispatching, `429`, `5xx`, timeout e reconciliação.
- Nenhuma operação incerta pode ser reenviada automaticamente.

## Fora de escopo

- Criar promoções próprias, enquanto a criação não for comprovadamente disponível na Open API para a aplicação;
- `Promoções criadas`;
- alteração de preço/estoque fora dos contratos específicos da promoção;
- decisões automáticas de desconto, adesão ou remoção;
- reutilização de código de runtime do Mercado Livre.

## Próximo gate

Antes de qualquer implementação de escrita, executar e registrar uma validação em ambiente controlado contra os endpoints exatos de subscriptions, SKUs e apply. Somente um `2xx` real, mais o scope correspondente e a feature flag explicitamente ligada, autoriza adicionar a respectiva CTA ao Seller Magalu.
