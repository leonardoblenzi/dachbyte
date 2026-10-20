# Alteração em lote de SELLER_SKU no Mercado Livre — desenho

## Objetivo e escopo

Criar uma página funcional em **Anúncios → Alteração de SKUs** para alterar o atributo `SELLER_SKU` de anúncios unitários e variações da conta Mercado Livre já ativa no Seller ML. O EAN/GTIN serve para conferência do de/para; não será alterado. Custos e referências financeiras por SKU serão revisados separadamente pelo usuário e não serão migrados automaticamente.

## Experiência e aparência

A página usa o shell, largura de conteúdo, tipografia, botões, painéis, tabelas, espaçamentos e estados de foco das telas atuais de Anúncios. Suporta os temas claro e escuro existentes sem introduzir uma terceira paleta. O nome da conta ativa aparece no cabeçalho, mas não há seletor de conta na página. Em telas estreitas, a tabela pode rolar horizontalmente sem esconder ações ou mensagens.

O fluxo tem quatro etapas visíveis: **Exportar**, **Preencher**, **Revisar** e **Aplicar**. A exportação gera uma planilha `.xlsx` com uma linha por anúncio unitário ou variação e colunas: conta, MLB, ID da variação, nome da variação, EAN/GTIN atual, SKU atual, SKU novo. A variação unitária mostra “Produto único” e ID vazio. O nome da variação combina seus atributos legíveis, por exemplo “Azul / P”. Apenas `SKU novo` é editável para o envio. GTIN múltiplos aparecem juntos como referência, preservados como texto para não perder zeros à esquerda.

## Prévia e confirmação

A importação aceita a planilha exportada para a conta ativa. O servidor valida cabeçalhos, formatos, limite de linhas, MLB, ID da variação e SKU novo; rejeita linhas duplicadas para o mesmo alvo. Antes da confirmação, consulta o estado atual no ML e classifica cada linha como **pronta**, **sem alteração**, **divergente**, **inválida** ou **não encontrada**. Divergência inclui conta, SKU atual ou identidade da variação diferente da exportação; EAN divergente é exibido como alerta de conferência. Somente linhas prontas são selecionáveis. A confirmação mostra quantas serão enviadas e avisa que custos por SKU não acompanham a mudança.

## Processamento

Um lote persistido é criado apenas após a confirmação. Ele pertence à conta ativa e ao usuário solicitante, registra cada alvo e o SKU anterior/novo, progresso, resposta e horário. O worker aplica uma mudança por anúncio, agrupando alterações de variações do mesmo MLB e preservando as variações não alteradas conforme o contrato vigente da API. Antes do `PUT /items/{item_id}`, relê o anúncio e bloqueia a linha se o SKU ou o ID tiver mudado desde a prévia. Envia apenas campos necessários, respeita limites de requisição e trata erros transitórios com repetição limitada; erros permanentes ficam por linha e não interrompem o restante do lote. Após o envio, relê o item para confirmar o `SELLER_SKU`. A repetição do mesmo lote não deve reenviar linhas já confirmadas.

A página acompanha o job sem depender da aba aberta e oferece relatório `.csv` de resultados por linha. Um item falho pode ser reenviado somente após nova prévia. O serviço nunca altera `seller_custom_field`, EAN/GTIN, custo interno ou registros históricos de venda. A atualização do catálogo local ocorre pela sincronização existente após a confirmação, sem reescrever custo ou referência manual.

## Segurança e permissões

Endpoints de exportação, prévia, confirmação, consulta e download exigem autenticação e escopo da conta ativa. A escrita usa o controle `ml.anuncios.cadastro` com `edit: true`, já empregado no cadastro de anúncios. A conta e os alvos são resolvidos no servidor; valores de conta enviados na planilha não autorizam acesso a outra conta. Não registrar tokens ou planilhas completas em logs. A exportação e o relatório são escapados contra fórmulas de planilha.

## Verificação

Testes cobrem anúncio unitário, variação, múltiplos GTINs, nome de variação, zeros à esquerda, duplicatas, conta divergente, SKU alterado entre prévia e aplicação, preservação das demais variações, idempotência/retry e isolamento por conta. Verificar manualmente os quatro estados de fluxo, temas claro/escuro e largura móvel. Antes de publicar, executar os testes do Seller ML e validar uma alteração controlada em conta de teste.

## Fora do escopo

Alteração de EAN/GTIN, `seller_custom_field`, migração de custo por SKU, atualização de outras contas no mesmo lote e cobrança nova de créditos.
