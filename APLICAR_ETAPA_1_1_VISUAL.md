# DACH Ads — Etapa 1.1: Shell visual

Aplicar este ZIP sobre a raiz do projeto DACHBYTE depois da Etapa 1.

## Objetivo

- manter o padrão visual/ergonômico do DACH Seller (Mercado Livre);
- não reutilizar classes `ml-*` nem acoplar o Ads ao código do Seller;
- dar ao Ads uma identidade própria violeta/índigo;
- manter White Mode e Dark Mode persistidos em `localStorage`;
- preparar sidebar/topbar para as páginas que entram a partir da Etapa 2.

## Arquivos

- `apps/ads/public/app.html`
- `apps/ads/public/ads-shell.css`
- `apps/ads/public/ads-shell.js`
- `apps/ads/public/ads.css`
- `public/brand/dachbyte/tokens.css`
- `public/brand/dachbyte/theme.css`
- `tests/ads-visual-contract.test.js`

## Validação

```bash
node --test tests/ads-visual-contract.test.js tests/ads-foundation.test.js
```

O shell não depende do Hub para renderizar. A identidade continua usando `/ads/api/session`, portanto a fronteira de autenticação criada na Etapa 1 não foi alterada.
