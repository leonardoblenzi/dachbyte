# Exportação PDF dos produtos no Full

## Objetivo e escopo

Adicionar à aba **Produtos no Full** um botão **Exportar PDF** que abre uma prévia imprimível, no mesmo padrão do exportador dos planejamentos salvos. O relatório serve para consulta e compartilhamento do estado sincronizado do Full; não cria planejamento nem altera dados no Mercado Livre.

## Conjunto de dados

- Exportar exatamente as linhas presentes na tabela após o último **Aplicar filtros** ou **Atualizar Full**, preservando sua ordem. Não fazer nova consulta no momento da exportação.
- Guardar, junto com as linhas carregadas, a busca e a ordenação efetivamente aplicadas. Alterações ainda não submetidas nos controles não mudam o cabeçalho do relatório.
- Mostrar no cabeçalho a busca aplicada (ou “sem busca”), a ordenação, a data da última sincronização e a quantidade exportada.
- A API atual retorna no máximo 200 linhas. Se o total em cache exceder a quantidade exibida, avisar explicitamente que o PDF contém somente os produtos exibidos, não o cache inteiro. Não ampliar esse limite nesta entrega.
- Desabilitar o botão enquanto não houver produtos exibidos. Após uma atualização ou filtragem que deixe a lista vazia, o botão volta a ficar indisponível.

## Prévia e campos

Posicionar o botão no cabeçalho do card **Produtos no Full**. Ao clicar, abrir uma nova aba com **Imprimir / salvar PDF** e seletor de colunas, reaproveitando o estilo e o comportamento do exportador existente. As escolhas de colunas deste relatório terão chave própria no armazenamento local, separada das escolhas dos planejamentos.

Colunas disponíveis: foto, produto, SKU, MLB, estoque Full, vendas 7/15/30 dias, faturamento 30 dias, cobertura, reposição sugerida e status. A seleção inicial inclui todas. Se o usuário desmarcar todas, restaurar todas, como ocorre no exportador de planejamentos. O cabeçalho e a tabela precisam escapar dados de texto recebidos da API antes de inseri-los no HTML.

## Organização e falhas

Manter a implementação no front-end existente (`views/full.html` e `public/js/full.js`), sem rota nova ou biblioteca de PDF. Reutilizar apenas os mecanismos comuns de prévia, impressão e seleção de colunas; não reutilizar os campos específicos de carga, como “Enviar” ou M³. Se o navegador bloquear a nova aba, exibir o erro pelo mecanismo já usado na tela. A impressão usa os recursos nativos do navegador.

## Verificação

- Testar que o botão só habilita com linhas exibidas e que o PDF usa a mesma ordem e quantidade da tabela.
- Testar busca/ordenação aplicadas versus valores digitados mas não aplicados; testar aviso quando há mais itens no cache do que na tabela.
- Testar seleção de colunas independente do planejamento, texto escapado e bloqueio de pop-up.
- Rodar os testes específicos de Full, checagem de sintaxe JavaScript e revisão visual da prévia de impressão.
