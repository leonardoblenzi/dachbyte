# Custos por SKU Magalu — paridade com Mercado Livre

## Objetivo

Transformar a aba **Custos por SKU** da tela de Margem Magalu em um fluxo visual e operacional equivalente ao do Mercado Livre, sem misturar dados ou permissões dos dois Sellers.

## Tela e navegação

- Manter o hero principal de Margem e as abas na ordem Resumo, Margem por período, Equilíbrio estimado, Custos por SKU.
- Na aba de custos, retirar o aviso de resultado parcial, a faixa explicativa e o segundo hero, que repetem conteúdo ou atrapalham a hierarquia.
- Reproduzir espaçamento, dimensões, cartões e ordem do Meli com as cores do Magalu: estado da base; barra de alíquota e ações; quatro indicadores de SKUs; monitor de alterações; insights e ranking; filtros; tabela completa paginada.
- A barra contém alíquota global editável e Salvar, Atualizar base sincronizada, Baixar XLSX e Importar XLSX. Atualizar base usa a sincronização Magalu existente; não promete uma operação remota que ainda não exista.
- A tabela permite custo direto por SKU com Salvar e Histórico. Componentes adicionais (embalagem, operacional, outros e notas) continuam acessíveis no editor detalhado.

## Dados e cálculo

- A alíquota global pertence à conta Magalu, é validada entre 0 e 100% e tem histórico de mudança.
- Quando a conta tiver alíquota global positiva configurada, ela prevalece sobre `magalu.sku_costs.tax_rate` em margem por período, equilíbrio, ranking, filtros de risco e calculadora. Os valores antigos por SKU permanecem armazenados e exportáveis, mas não são sobrescritos.
- Uma alíquota global igual a zero desativa a configuração, mantendo a regra legada por SKU até que haja uma taxa global positiva. A interface explicita qual fonte está em uso e pede confirmação antes de desativar uma taxa global positiva.
- Taxas de comissão, tarifa e frete Magalu não são inferidas. A interface continua qualificando qualquer margem como resultado conhecido/parcial.
- Histórico de custos registra valor anterior, novo, origem (`manual` ou `xlsx`), usuário e data. Alertas de custo crescente usam esse histórico; alertas de preço em queda só aparecem se houver histórico de preços confiável. Ausência de histórico não é tratada como estabilidade.

## Planilhas

- **Baixar XLSX** mantém todas as linhas da conta selecionada, com SKU estável, dados de referência somente leitura, custo unitário e demais custos editáveis. Inclui a alíquota global e as taxas legadas por SKU claramente identificadas, sem fazer da planilha uma forma de alterar a configuração global.
- **Importar XLSX** aceita o arquivo exportado, limita tamanho e quantidade de linhas, valida cabeçalho, SKU da conta, números não negativos, taxa no intervalo permitido e duplicidades. Nunca cria SKUs nem altera preço, imposto global ou dados vindos da API Magalu.
- Validar todas as linhas antes de gravar. Se houver erro, devolver número da linha e motivo; nenhuma alteração parcial. Em sucesso, salvar custos e histórico numa transação e apresentar contagem de SKUs atualizados. Atualizar indicadores e tabela ao concluir.
- Arquivos XLSX arbitrários ou CSV são rejeitados com orientação para baixar o modelo.

## Filtros e monitor

- Oferecer tipo de busca, busca de SKU/produto, situação do custo, status do SKU e categoria somente quando o catálogo Magalu tiver esses campos confiáveis. Não exibir filtro sem fonte real.
- Indicadores e ranking usam a base ativa sincronizada da conta. Monitor de custo crescente e margem conhecida em risco são calculados apenas com dados disponíveis, com estados vazios claros.
- Filtros são aplicados mediante **Filtrar**, preservados durante paginação e mantidos no download quando tecnicamente viável; o download completo continua disponível de modo explícito.

## Segurança, erros e testes

- Toda leitura e escrita verifica tenant, conta selecionada e política do Hub. Importação não usa endpoints de escrita Magalu; modifica somente o cadastro de custos local.
- Erros de arquivo, conta, taxa e gravação são exibidos sem deixar a tela em carregamento indefinido. Botões de mutação são desabilitados durante a requisição.
- Testes cobrem precedência da taxa global, taxa zero, preservação legada, planilha válida/inválida, isolamento entre contas, atomicidade, histórico, paginação/filtros e os estados principais da interface.

## Fora do escopo

Deploy, alterações de preços/estoque na API Magalu e estimativas de comissão/frete sem fonte confiável.
