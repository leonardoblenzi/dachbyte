# XLSX de custos Magalu no formato simplificado do Meli

## Contexto e decisão

O modelo XLSX de Custos por SKU Magalu exporta hoje imposto e componentes de custo adicionais. O usuário confirmou que ainda não importou custos e pediu o formato simplificado do Mercado Livre: apenas identificação, contexto e custo do produto. A alíquota global continua configurada exclusivamente na interface da aba, fora da importação.

## Contrato da planilha

A aba `Custos por SKU` terá, nesta ordem: `SKU`, `Produto`, `Preço atual`, `Custo produto`. O SKU identifica o produto. Apenas `Custo produto` é editável; produto e preço são contexto. Custo vazio preserva o valor existente, e zero explícito grava zero. O XLSX exportado pode ser reimportado sem alterar outras parcelas de custo nem imposto.

O importador exigirá exatamente os novos cabeçalhos; planilhas do formato anterior deverão ser exportadas novamente. Isso é aceitável porque não houve importação de custos pelo usuário. Arquivos com cabeçalho antigo receberão erro claro de modelo desatualizado, sem gravar linhas parcialmente. O formato, limite de tamanho, validação de SKU e transação atômica existentes permanecem.

## Fronteira fiscal

A importação não lê nem escreve `tax_rate` por SKU, `finance_settings.aliquota`, embalagem, operacional, outros ou observações. Esses componentes continuam editáveis no formulário detalhado da tela. Nenhuma migração de banco é necessária.

## Verificação

Testes devem cobrir os quatro cabeçalhos e sua ordem, exportação seguida de importação, payload com somente SKU e custo, preservação dos demais campos já armazenados no repositório e rejeição de planilha antiga com erro de modelo desatualizado. Executar a suíte Magalu completa e conferir o XLSX gerado.
