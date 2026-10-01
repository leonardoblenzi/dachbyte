# Editor de custo universal no Equilíbrio estimado ML

## Objetivo

Transformar a coluna `Custo` da aba **Equilíbrio estimado** em um ponto único
de consulta e manutenção do custo por SKU, sem alterar a aba **Margem por
período**.

## Escopo aprovado

Toda linha que possua SKU de referência exibirá o bloco compacto de custo já
definido visualmente:

- campo monetário;
- link `Ver histórico`;
- botão `Salvar custo`.

Quando houver custo cadastrado, o campo inicia preenchido com o valor atual.
Quando não houver, inicia vazio com o placeholder `0,00`. O campo não altera
preço de anúncio: ele salva o custo central do SKU para a conta ativa e usa a
mesma validação, auditoria e histórico da tela **Custos por SKU**.

Após salvar, o modal de processamento continua visível até a recarga atômica
das margens. Todas as linhas visíveis do mesmo SKU recebem o novo custo,
margem e situação juntas. Os bloqueios atuais contra clique/Enter duplicado,
concorrência entre linhas do mesmo SKU e respostas defasadas permanecem.

Linhas sem SKU de referência continuam mostrando `Sem SKU`, pois não há uma
chave segura para persistir custo.

## Fora de escopo

- Adicionar edição de custo à aba **Margem por período** e à sua coluna CMV.
- Alterar regras financeiras, preço, anúncios, promoções ou atacado.
- Criar endpoint, banco de dados, histórico ou validação paralelos.

## Verificação

Os testes devem provar que:

- uma linha com SKU e custo existente renderiza o campo preenchido;
- uma linha com SKU sem custo renderiza o campo vazio/placeholder;
- uma linha sem SKU não mostra controles de edição;
- o salvamento reutiliza a API central e preserva recálculo, histórico,
  bloqueios de concorrência e atualização coordenada já existentes;
- a aba Margem por período e suas 18 colunas não sofrem alteração.
