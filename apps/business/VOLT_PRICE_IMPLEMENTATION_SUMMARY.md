# VoltPrice - resumo do encaixe no DavanttiSuite

## Arquivos da business alterados

- `product-server.cjs`: executa VoltPrice no container `business-price`; Caddy publica `/business/price` e `/business/price/api`.
- `infra/compose.vps.yml` executa o produto em `business-price`; migrations ficam em jobs one-shot separados do runtime.
- `package.json`: adiciona `pg`, `bcryptjs` e `cookie-parser` usados pelo modulo.

## Novo modulo

- `volt-price/index.js`
- `volt-price/db/*`
- `volt-price/src/*`
- `volt-price/public/*`
- `volt-price/tests/*`
- `volt-price/.env.example`
- `volt-price/README.md`

## Infraestrutura atual

VoltPrice roda em container proprio (`business-price`) na VPS. Caddy publica `/business/price` e `/business/price/api`; PostgreSQL local usa banco/roles dedicados, e as migrations sao controladas por `infra/business-db-ops.sh`. O antigo modelo agregado/Render deve ser tratado somente como historico de migracao.
