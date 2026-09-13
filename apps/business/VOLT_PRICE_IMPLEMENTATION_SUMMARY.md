# VoltPrice - resumo do encaixe no DavanttiSuite

## Arquivos da business alterados

- `app.js`: monta VoltPrice em `/volt-price` e inclui `voltprice` no health.
- `package.json`/Render: executam migrations Core e VoltPrice no pre-deploy; `start.js` apenas inicia o webservice.
- `package.json`: adiciona `pg`, `bcryptjs` e `cookie-parser` usados pelo modulo.

## Novo modulo

- `volt-price/index.js`
- `volt-price/db/*`
- `volt-price/src/*`
- `volt-price/public/*`
- `volt-price/tests/*`
- `volt-price/.env.example`
- `volt-price/README.md`

## Sem alteracoes de infraestrutura Render

Nao foi criado `render.yaml` para VoltPrice. O modulo usa o webservice `business` ja existente.
