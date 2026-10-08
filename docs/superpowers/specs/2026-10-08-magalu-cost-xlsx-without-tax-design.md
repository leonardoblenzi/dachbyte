# XLSX de custos Magalu sem colunas de imposto

## Contexto e decisão

O modelo XLSX de Custos por SKU Magalu exporta hoje `Imposto legado %` e `Alíquota global (informativa)`. O usuário confirmou que ainda não importou custos e pediu para retirar ambas, aproximando a planilha da do Mercado Livre. A alíquota global continua configurada exclusivamente na interface da aba, fora da importação.

## Contrato da planilha

A aba `Custos por SKU` terá, nesta ordem: `SKU`, `Produto`, `Preço atual`, `Custo unitário`, `Embalagem`, `Operacional`, `Outros`, `Observações`. O SKU identifica o produto. Os campos de custo numéricos e observações continuam editáveis; produto e preço são apenas contexto. Células de custo vazias preservam o valor existente, e zero explícito grava zero. O XLSX exportado pode ser reimportado sem alteração de imposto.

O importador exigirá exatamente os novos cabeçalhos; planilhas do formato anterior deverão ser exportadas novamente. Isso é aceitável porque não houve importação de custos pelo usuário. Arquivos com cabeçalho antigo receberão erro claro de modelo desatualizado, sem gravar linhas parcialmente. O formato, limite de tamanho, validação de SKU e transação atômica existentes permanecem.

## Fronteira fiscal

A importação não lê nem escreve `tax_rate` por SKU e não lê nem escreve `finance_settings.aliquota`. A interface continua exibindo e salvando a alíquota global de forma separada. Nenhuma migração de banco é necessária.

## Verificação

Testes devem cobrir os oito cabeçalhos e sua ordem, exportação seguida de importação, ausência de `tax_rate` nas linhas importadas, preservação da taxa já armazenada no repositório e rejeição de planilha antiga com erro de modelo desatualizado. Executar a suíte Magalu completa e conferir o XLSX gerado.
