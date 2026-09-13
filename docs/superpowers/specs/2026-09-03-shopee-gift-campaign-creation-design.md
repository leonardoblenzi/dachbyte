# Criação de campanhas de brindes na Shopee — design

**Data:** 03/09/2026
**Status:** aprovado para planejamento de implementação
**Área:** Ferramentas Avançadas / Precificador Inteligente

## Objetivo

Permitir criar campanhas Shopee de **brinde grátis com gasto mínimo** a partir de uma experiência guiada. O usuário escolhe produtos principais e possíveis brindes; o sistema incorpora, na formação de preço de cada produto principal, o CMV do brinde de maior custo. O comprador poderá escolher **um** brinde entre os selecionados no checkout.

A campanha terá um valor mínimo de compra único para todos os produtos principais. O sistema sugerirá o menor preço final economicamente viável, mas o usuário manterá controle sobre preço e margem. A publicação só ocorrerá depois da revisão de preço, conflito e logística.

## Decisões confirmadas

- A campanha é do tipo “brinde com gasto mínimo” (Add-on Deal / Gift with Minimum Spend), não uma promoção com desconto comum.
- Há um único gasto mínimo para a campanha inteira.
- O cliente escolhe um único brinde entre os disponíveis.
- A provisão financeira sempre considera o **maior CMV unitário** dos brindes selecionados.
- A prévia pode ser salva como rascunho e não produz efeitos externos.
- Quando houver incompatibilidade logística, o usuário precisa escolher explicitamente se deseja ajustar brindes ou produtos principais; a tela sempre mostra todas as alternativas viáveis.
- A promoção inicia, por padrão, com o maior período permitido pela plataforma. O usuário pode reduzi-lo, mas não pode superar o limite. A validação final da Shopee prevalece.
- Produtos participantes recebem a tag **Campanha de brinde** no Precificador Inteligente enquanto a campanha estiver ativa.

## Escopo

Incluído:

- Assistente de criação, rascunho, prévia, validação, confirmação, publicação, acompanhamento e recuperação.
- Cálculo de preço por produto principal reutilizando as regras financeiras do motor atual.
- Consulta de logística ao vivo, matriz de compatibilidade e aplicação da alternativa escolhida.
- Criação da campanha e inclusão de principais e brindes por meio da API Shopee disponível à loja.
- Auditoria de todas as chamadas e vínculo visível entre produto e campanha.

Fora da primeira entrega:

- Reserva própria de estoque ou criação de estoque virtual de brindes. A disponibilidade é limitada pelo estoque real publicado na Shopee.
- Combinar esta campanha com outras promoções incompatíveis sem confirmação de política de conflito.
- Alterar automaticamente qualquer logística sem confirmação explícita do usuário.

## Jornada do usuário

### 1. Condições da campanha

O usuário informa nome interno, valor mínimo único, início, fim e margem desejada.

- “Usar período máximo permitido” vem ativado.
- Com a opção ativa, o término é preenchido com o maior limite conhecido da configuração/plataforma.
- Com a opção desativada, o calendário permite uma data menor e bloqueia o que exceder o limite.
- O resumo deixa explícito que a Shopee pode devolver um teto menor na validação final; nesse caso, o rascunho volta para ajuste sem executar mudanças externas.

### 2. Produtos principais

Lista com busca, seleção múltipla e indicadores já existentes do Precificador: preço atual, CMV, margem, campanhas em conflito, estoque e logística.

O usuário escolhe os produtos que passarão a conceder um brinde quando o pedido atingir o gasto mínimo único.

### 3. Brindes

Lista independente com busca, seleção múltipla, CMV unitário, estoque e logística. Um painel fixo mostra:

- quantidade de opções de brinde;
- brinde de maior CMV;
- CMV que será provisionado em todos os principais;
- observação clara: “o comprador escolherá 1 brinde por pedido elegível”.

### 4. Prévia financeira

Para cada principal, a tela apresenta:

| Campo | Regra |
| --- | --- |
| CMV do principal | custo atual do catálogo |
| Provisão de brinde | maior CMV unitário entre os brindes selecionados |
| Custo considerado | CMV do principal + provisão de brinde |
| Preço sugerido | resultado do motor V7 com custos, taxas e margem alvo |
| Preço aprovado | sugestão editável pelo usuário, revalidada em tempo real |
| Margem resultante | margem após todas as taxas e a provisão do brinde |

O cálculo deve utilizar a mesma fonte de taxas, margem, calibragem e proteções econômicas do motor de precificação. Não haverá soma duplicada de CMV ao reaplicar a prévia.

Conflitos de preço ou promoção existentes passam pelo mesmo conjunto de políticas do Precificador Inteligente. A tela nunca cria uma campanha de desconto adicional silenciosamente: qualquer alteração de preço segue a política confirmada e fica identificada como parte da campanha de brinde.

### 5. Compatibilidade logística

Antes de habilitar “Publicar”, o servidor obtém novamente os dados logísticos dos itens selecionados. A tela mostra uma matriz por item com:

- canais disponíveis e ativos;
- restrições físicas conhecidas;
- canais em comum entre principais e brindes;
- itens incompatíveis e motivo;
- efeito de cada possível correção.

Quando houver conflito, as alternativas são exibidas lado a lado:

1. **Preservar a logística dos principais:** alterar apenas brindes para os canais compatíveis disponíveis.
2. **Preservar a logística dos brindes:** alterar apenas principais para os canais compatíveis disponíveis.
3. **Editar seleção:** manter a logística como está e trocar/remover itens incompatíveis.

Alternativas inviáveis permanecem visíveis, mas desabilitadas com o motivo — por exemplo, canal inexistente no item ou impedimento por peso/dimensão. O usuário vê quantidade de itens afetados, canais que serão ativados/desativados e pode salvar o rascunho mesmo sem resolver o conflito. A publicação fica bloqueada até existir um plano compatível aprovado.

### 6. Revisão e publicação

A revisão final consolida condições, período, principais, opções de brinde, preço/margem, regra de conflito e plano logístico. O botão de publicação apresenta uma confirmação explícita com o impacto externo.

O processo é assíncrono e acompanhado na própria tela. Estados:

`rascunho` → `aguardando confirmação` → `validando` → `aplicando logística` → `aplicando preços` → `criando campanha` → `publicada`

Estados alternativos: `atenção necessária`, `falha parcial`, `cancelada` e `encerrada`.

## Integração com os componentes atuais

### Precificação

Reutilizar `PricingV6Service`/motor V7 para a simulação financeira, suas proteções de margem, consultas de conflito e o padrão de prévia-confirmar-aplicar. A campanha de brinde terá uma camada própria de orquestração para não confundir seu ciclo com uma campanha de desconto comum.

Uma consulta do Precificador deve correlacionar produto e campanha ativa. A resposta de produto recebe, por exemplo:

```json
{
  "giftCampaign": {
    "id": "...",
    "status": "published",
    "name": "Brinde de setembro",
    "minSpendCents": 19990,
    "giftProvisionCents": 3490,
    "startsAt": "...",
    "endsAt": "..."
  }
}
```

Na interface, isto gera a tag “Campanha de brinde”; ao clicar, abre o resumo sem exigir nova busca ampla do catálogo.

### Logística

Reutilizar `LogisticsController`, `ShopeeLogisticsService` e a política logística atual para ler o estado ao vivo, construir planos válidos e aplicar atualizações. O novo módulo não deve inferir compatibilidade por texto do anúncio nem por dados antigos em cache.

### Shopee

Criar um serviço isolado, `ShopeeAddOnDealService`, responsável pelo contrato de campanhas de brinde. Ele centraliza assinatura, normalização de respostas, limites, mensagens de erro e idempotência dos endpoints de Add-on Deal disponibilizados para a loja, incluindo criação da campanha, inserção de itens principais e inserção dos brindes.

Antes de permitir publicação, o serviço verifica se a loja/região/escopo possui acesso ao recurso. Se a Shopee não disponibilizar o tipo de campanha, a tela mantém o rascunho e explica o bloqueio, sem alterar logística ou preço.

Referências para validação de contrato durante a implementação:

- [Documentação oficial Shopee Open Platform](https://open.shopee.com/documents?module=101&type=1)
- [Visão geral de ferramentas promocionais Shopee](https://ms.shopee.com/promo-tools/)

## Modelo de persistência

Novas entidades, sempre vinculadas à loja e ao usuário criador:

- `GiftCampaign`: condições, período, estado, identificador Shopee, política de conflito, plano logístico aprovado, resumo financeiro e timestamps.
- `GiftCampaignMainItem`: item/modelo principal, preços antes/depois, CMV, provisão de brinde, margem calculada, estado e resposta remota.
- `GiftCampaignGiftItem`: item/modelo de brinde, CMV, estoque observado, posição de escolha e resposta remota.
- `GiftCampaignAction`: linha de auditoria para cada validação, mudança logística, preço e chamada de publicação, incluindo payload sanitizado, resultado, tentativa e erro.

Os valores monetários serão guardados em centavos. Cópias do estado anterior de preço e logística são armazenadas para auditoria e para preparar uma recuperação assistida.

## API interna proposta

Sob a loja autenticada:

- `GET /shops/:shopId/gift-campaigns`
- `POST /shops/:shopId/gift-campaigns/drafts`
- `GET /shops/:shopId/gift-campaigns/:campaignId`
- `PUT /shops/:shopId/gift-campaigns/:campaignId`
- `POST /shops/:shopId/gift-campaigns/:campaignId/preview`
- `POST /shops/:shopId/gift-campaigns/:campaignId/logistics-options`
- `POST /shops/:shopId/gift-campaigns/:campaignId/confirm`
- `POST /shops/:shopId/gift-campaigns/:campaignId/publish`
- `POST /shops/:shopId/gift-campaigns/:campaignId/retry`
- `POST /shops/:shopId/gift-campaigns/:campaignId/cancel`

Toda operação de escrita exige usuário autenticado com acesso à loja; IDs de produto, modelo e campanha são sempre filtrados pelo `shopId` resolvido no servidor.

## Publicação segura e recuperação

1. Revalidar sessão, permissão da loja, itens, estoque observado, preço, data e contrato Shopee.
2. Buscar novamente a logística e garantir que o plano escolhido ainda é viável.
3. Aplicar apenas as mudanças logísticas confirmadas, item a item, registrando o resultado.
4. Aplicar os preços aprovados com as mesmas regras de conflito do motor.
5. Criar a campanha na Shopee e adicionar principais e brindes.
6. Atualizar estado local, tag do Precificador e auditoria.

Cada passo é idempotente e pode ser retomado. Em falha, o job para no ponto seguro, informa quais itens foram alterados e não executa rollback automático destrutivo. Uma recuperação futura deve exigir confirmação e mostrar o estado anterior que será restaurado.

## Critérios de aceite

- Usuário consegue salvar e retomar rascunho sem chamada externa.
- Com vários brindes, a prévia usa somente o CMV do brinde mais caro e deixa explícito que o cliente escolherá um.
- Preços sugeridos e margens refletem o custo provisionado e permanecem editáveis com validação.
- Produtos em campanha aparecem identificados no Precificador e podem abrir o respectivo resumo.
- Todas as alternativas logísticas, inclusive as inviáveis, são apresentadas com impacto e motivo.
- Nenhuma alteração de logística ocorre sem escolha e confirmação explícita.
- O período inicia no máximo permitido por padrão; entradas acima do limite são bloqueadas e revalidadas no servidor.
- Falhas parciais deixam evidência suficiente para reprocessar sem duplicar campanha, preço ou mudança logística.
- O módulo respeita o escopo da loja e não expõe produtos/campanhas de outra conta.
