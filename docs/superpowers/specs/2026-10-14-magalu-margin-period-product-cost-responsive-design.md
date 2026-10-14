# Margem por período Magalu: identificação, custo ausente e layout responsivo

## Objetivo

Na aba **Margem por período**, identificar os produtos dos pedidos, oferecer o mesmo caminho do Mercado Livre para cadastrar custos ausentes e permitir o uso no zoom normal em desktop, tablet e celular. A conciliação financeira existente continua sendo a fonte dos valores; campos não disponíveis na API não serão presumidos.

## Abordagens consideradas

1. Manter as 18 colunas com rolagem horizontal interna. É a menor alteração, mas dificulta comparar pedidos e usar a tela em larguras menores.
2. **Adotar resumo compacto por pedido com detalhes expansíveis.** Preserva todos os componentes financeiros sob demanda e deixa as informações de decisão visíveis sem reduzir o zoom. Escolhida pelo usuário.
3. Criar outra tela para celular. Evita a tabela larga, mas duplica a navegação e a manutenção.

## Identificação dos produtos

O resumo de margem hoje lê SKU e nome de `magalu.order_items`; a sincronização completa persiste cada resposta da listagem de pedidos, que pode não trazer `items`. Para pedidos da página atual sem itens identificados, uma etapa de enriquecimento consulta o detalhe do pedido por código e, quando necessário e autorizado, as entregas correspondentes. As respostas são normalizadas e persistidas pelas rotinas existentes de reconciliação, com isolamento por conta Magalu. Consultar no máximo os 20 pedidos visíveis, com até 3 chamadas simultâneas; não repetir automaticamente uma falha a cada renderização. Oferecer tentativa manual para o pedido que continuar sem identificação.

A interface distingue **identificado**, **identificação em andamento** e **SKU indisponível na resposta da API**. Não usa título de outro pedido, nem infere SKU pelo valor ou pelo nome. Se a entrega fornecer itens, a associação ao pedido deve evitar duplicidade entre entrega e detalhe e não transformar itens parciais em custo completo. Uma falha de consulta não impede a leitura dos dados financeiros já conciliados.

## Custo ausente

A resposta de margem inclui, para cada pedido da página, uma lista enxuta dos itens cujo custo unitário está ausente: SKU confirmado, nome quando disponível e quantidade. A contagem atual de itens sem custo permanece, mas não gera um atalho quando o SKU não é conhecido.

- Um SKU sem custo: ação **Cadastrar custo** abre **Custos por SKU** com esse SKU filtrado e o campo de custo em foco.
- Mais de um SKU sem custo: ação **Ver itens sem custo** abre um seletor com os SKUs desse pedido; escolher um abre a mesma tela filtrada.
- Item sem SKU confirmado: exibir **SKU indisponível** e opção de tentar identificar novamente, sem permitir cadastro associado a um identificador incerto.

Após salvar um custo, recarregar os dados locais de custos, margem do período e equilíbrio estimado. Isso não dispara uma nova sincronização financeira remota. O resultado só deixa de ser “Sem custo” quando todos os itens e o relatório financeiro necessários estiverem presentes.

## Layout e navegação

No desktop, a linha compacta exibe pedido/produto, data, GMV, resultado, margem e situação do custo. Um controle **Detalhes** expande os demais componentes financeiros atuais — modo de envio, preço do produto, CMV, comissões, frete, cupons e descontos, subsídios, tarifas, base de imposto, impostos, equilíbrio por unidade e folga. Não remover valores nem alterar suas fórmulas.

Os filtros deixam de depender de uma grade fixa de onze colunas e passam a quebrar linha conforme a largura disponível do conteúdo, inclusive com a barra lateral aberta. Botões ficam inteiros e acessíveis. Em celular, cada pedido aparece como cartão com os mesmos campos principais e detalhes expansíveis. Nenhum contêiner deve provocar rolagem horizontal da página; se um componente interno excepcionalmente precisar rolar, a rolagem fica limitada a ele. Preservar o padrão visual Magalu e a ordem de navegação das abas de margem.

## Estados e testes

Cobrir pedidos com zero, um e vários SKUs sem custo; pedido sem SKU; falha/ausência de permissão no detalhe; múltiplas entregas; custo salvo que completa o pedido; relatório financeiro ausente; e separação entre contas. Verificar que o enriquecimento é limitado e idempotente, que não duplica quantidades e que não presume margem completa a partir de dados parciais. Em testes de interface, validar desktop, tablet e celular (aproximadamente 1440, 1024, 768 e 390 px): filtros utilizáveis, expansão por teclado, botões visíveis e ausência de overflow horizontal na página.

## Fora do escopo

Não alterar os cálculos ou a fonte dos lançamentos financeiros, não inventar SKU/preço/custo quando a Open API não os fornecer e não publicar ou escrever dados na Magalu. A escrita de custo continua restrita ao cadastro local já existente.
