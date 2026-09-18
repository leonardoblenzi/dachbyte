# Etapa 6 — ordem de aplicação

1. **Hub externo**
   - copiar `dach-ads-etapa-6-hub.zip`;
   - revisar/aplicar migration `056_dach_ads_product_access.sql`;
   - testar e publicar Hub;
   - ativar `dach_ads` em uma empresa e conceder a permissão ao usuário de teste.

2. **Projeto DACH**
   - copiar `dach-ads-etapa-6-dach.zip`;
   - garantir `ADS_AUTH_MODE=hub`;
   - copiar para `infra/env/ads.env` o **mesmo** `SUITE_JWT_SECRET` usado pelo Gateway;
   - garantir `HUB_BASE_URL` e `HUB_INTERNAL_TOKEN` em `infra/env/hub.env`;
   - rebuild/recreate de `gateway`, `ads-api` e `ads-worker`.

3. **Teste final depois de todas as etapas**
   - será feito na bateria consolidada combinada ao final do projeto.
