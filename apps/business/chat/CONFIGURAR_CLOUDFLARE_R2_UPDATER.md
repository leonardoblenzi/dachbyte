# VoltChat Desktop Updater via Cloudflare R2 - R2 Only

## Arquitetura a partir da 0.1.37

O Cloudflare R2 passa a ser a unica fonte de verdade das releases desktop.

- Publicacao: PC de desenvolvimento -> Cloudflare R2.
- Controle de versao: `latest.json` armazenado no Cloudflare R2.
- Verificacao no VoltChat 0.1.37+: Electron -> `latest.json` diretamente no dominio publico do R2.
- Download: Electron -> arquivo `.exe` diretamente no dominio publico do R2.
- Validacao: SHA-256 do manifesto e do arquivo baixado.
- Neon: nenhuma gravacao, leitura ou armazenamento de releases.
- Render: nao participa da verificacao/download dos clientes 0.1.37+.

O endpoint `/downloads/desktop/latest/meta` permanece temporariamente apenas para clientes 0.1.36 ou anteriores migrarem. Ele le o `latest.json` diretamente do R2 e gera uma URL R2 pre-assinada. Ele nao consulta o Neon e nao transmite o EXE.

## 1. Habilitar acesso publico no bucket

No Cloudflare Dashboard:

1. Storage & databases > R2 > bucket `voltchat-releases`.
2. Abra Settings.
3. Em Public Development URL, habilite `r2.dev`, ou conecte um Custom Domain.
4. Copie a URL HTTPS publica.

Exemplos:

    https://pub-xxxxxxxxxxxxxxxx.r2.dev

ou, recomendado:

    https://updates.voltcorporation.com.br

O app desktop consulta essa origem pelo processo principal do Electron, portanto CORS de navegador nao e necessario para o updater.

## 2. Variaveis locais

No `.env` da raiz do VoltChat mantenha as credenciais de publicacao R2 e adicione `R2_PUBLIC_BASE_URL`:

    R2_ACCOUNT_ID=SEU_ACCOUNT_ID
    R2_ACCESS_KEY_ID=ACCESS_KEY_COM_OBJECT_READ_WRITE
    R2_SECRET_ACCESS_KEY=SECRET_KEY_COM_OBJECT_READ_WRITE
    R2_BUCKET_NAME=voltchat-releases
    R2_RELEASE_PREFIX=desktop/releases
    R2_PUBLIC_BASE_URL=https://SEU_DOMINIO_PUBLICO_R2

`DATABASE_URL` nao e usada pelo publicador de releases.

## 3. Manifesto

A cada publicacao o script cria/atualiza:

    desktop/releases/windows/latest.json

Exemplo de conteudo:

    {
      "schema_version": 1,
      "app": "VoltChat",
      "version": "0.1.37",
      "platform": "windows",
      "filename": "VoltChat-Setup-0.1.37.exe",
      "file_size": 123456789,
      "sha256": "...",
      "storage_key": "desktop/releases/windows/0.1.37/...exe",
      "download_url": "https://.../desktop/releases/windows/0.1.37/...exe",
      "published_at": "..."
    }

`latest.json` tem cache desabilitado. O arquivo `.exe`, cujo nome inclui hash, usa cache imutavel.

## 4. Build do desktop

O `build-desktop.ps1` le `R2_PUBLIC_BASE_URL` e `R2_RELEASE_PREFIX` e gera automaticamente:

    sordchat-frontend/electron/updater-config.json

Esse arquivo e empacotado dentro do Electron e informa onde fica o `latest.json`.

Se `R2_PUBLIC_BASE_URL` nao estiver configurada, o build desktop para com uma mensagem clara em vez de gerar um app apontando para o Render.

## 5. Publicar

Na pasta `sordchat-frontend`:

    npm run desktop:release

Fluxo:

1. gera o build React/Electron;
2. gera/assina `VoltChat-Setup-X.X.X.exe`;
3. calcula SHA-256;
4. envia o EXE ao R2;
5. atualiza `latest.json` no R2;
6. mantem somente os dois EXEs mais recentes no R2;
7. nao conecta no Neon.

Para publicar um EXE ja gerado:

    npm run desktop:publish

## 6. Render durante a transicao

Enquanto existir cliente 0.1.36 ou anterior, mantenha no Render:

    R2_ACCOUNT_ID
    R2_ACCESS_KEY_ID
    R2_SECRET_ACCESS_KEY
    R2_BUCKET_NAME
    R2_RELEASE_PREFIX=desktop/releases

Essas credenciais servem apenas para a ponte de compatibilidade que le o manifesto do R2 e devolve uma URL R2 pre-assinada. Nenhum binario passa pelo Render.

Depois que todos estiverem na 0.1.37+, essa ponte pode ser removida e as credenciais R2 podem sair do Render.

## 7. Neon

A migration:

    040_remove_desktop_releases_from_database.sql

remove:

    desktop_release_chunks
    desktop_releases

Assim nenhum payload ou metadado do updater permanece no banco.
