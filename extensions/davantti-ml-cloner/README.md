# Davantti Extension

Extensao Chrome/Edge Manifest V3 para analisar paginas do Mercado Livre e Shopee em tempo real e criar rascunhos de clonagem na Davantti.

## Fluxos principais

### Analise em tempo real

1. Usuario abre um anuncio ou busca do Mercado Livre/Shopee.
2. A extensao injeta um botao flutuante Davantti na pagina.
3. O content script le dados visiveis e estruturados do HTML atual.
4. O painel mostra score, metricas, alertas e oportunidades.
5. Essa leitura local nao exige selecionar conta ML.

### Clonagem Mercado Livre

1. Usuario faz login na extensao com o mesmo login global da Davantti, validado pelo Hub.
2. A extensao lista as contas Mercado Livre permitidas para o usuario.
3. Usuario seleciona a conta que vai receber o rascunho.
4. Em um anuncio Mercado Livre, o usuario clica em **Clonar para minha conta** no painel ou **Clonar anuncio atual** no popup.
5. A extensao captura o HTML da aba atual e envia para `/ml/api/extension/clonar-anuncio/browser-capture`.
6. O backend cria um rascunho em `ml.anuncio_clone_drafts` na conta selecionada.

## Instalar localmente para teste

1. Abra `chrome://extensions` ou `edge://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactacao**.
4. Selecione a pasta `extensions/davantti-ml-cloner`.
5. Abra um anuncio ou busca do Mercado Livre/Shopee e confira o painel Davantti.

## Publicar

Antes de publicar, gere um ZIP contendo apenas os arquivos desta pasta:

```powershell
.\scripts\package-davantti-ml-cloner.ps1
```

Depois envie o ZIP para a Chrome Web Store ou Microsoft Edge Add-ons.

## Variaveis de ambiente do backend

Em producao, depois que a loja gerar o ID fixo da extensao, configure:

```env
ML_EXTENSION_ALLOWED_ORIGINS=chrome-extension://ID_DA_EXTENSAO
HUB_BASE_URL=https://...
HUB_INTERNAL_TOKEN=...
```

O login da extensao usa `/ml/api/extension/auth/login`, valida as credenciais no
Hub em `/v1/internal/auth/verify` e provisiona/vincula o usuario local pelo
`tenant_id` e `user_id` retornados pelo Hub.

Para testes locais com extensao carregada manualmente, o backend permite origens
`chrome-extension://...` fora de producao. Se precisar testar em producao antes
da publicacao, habilite temporariamente:

```env
ML_ALLOW_UNREGISTERED_EXTENSION_ORIGINS=true
```
