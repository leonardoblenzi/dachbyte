# Parser seguro para importação financeira ML

## Objetivo

Eliminar o uso de `XLSX.read()` sobre o XLSX enviado pelo cliente no endpoint
`POST /api/financeiro/costs/import`, sem alterar o formato funcional aceito pelo
importador.

## Desenho aprovado

`FinanceiroMlService.parseImportRows` continuará validando a extensão `.xlsx` e
decodificando o conteúdo base64. Em seguida, chamará `parseXlsxRows` de
`services/safeWorkbookParser`, já usado pela importação de Características.

O serviço e seu chamador passam a aguardar a leitura assíncrona. O parser
compartilhado mantém os limites configuráveis de planilhas, linhas e colunas e
ignora nós XLSX desnecessários ao fluxo de importação.

## Segurança e erros

Conteúdo XLSX de origem do cliente não será mais interpretado pelo SheetJS.
Erros de formato e limites continuam voltando pelo tratamento existente do
controlador. O fluxo de exportação do Financeiro continua usando SheetJS e não
é alterado neste escopo.

## Testes

Será incluído um teste que verifica que a importação financeira usa o parser
seguro e não carrega `xlsx`. As suítes das etapas 1–5 e o hotfix do webhook
serão executadas antes do commit e deploy.
