# Configuração de domínio DACHBYTE

`domainMigration.js` é somente uma configuração de planejamento. Ele não é
importado pelos servidores, autenticação, OAuth, e-mail ou redirecionamentos.
Assim, sem domínio DACHBYTE comprado, o plano canônico permanece desativado e
os contratos atuais continuam inalterados.

## Quando houver domínio

1. Validar propriedade, DNS e TLS do novo domínio.
2. Criar um plano com `createDomainMigrationPlan({ canonicalOrigin, legacyOrigins })`.
3. Cadastrar cada callback canônico nos provedores antes de o publicar.
4. Validar callbacks novo e legado em ambiente controlado.
5. Implantar leitura dupla de cookies; somente depois escrita dupla e a
preferência pela origem canônica.
6. Só apos telemetria e janela de suporte encerrar callbacks e cookies legados.

Uma futura integração de runtime deve ser uma mudança separada, com allowlist
explícita de origens e testes de OAuth/cookies por produto. Não ler nomes de
cookie, URLs de callback ou e-mails de suporte desta configuração automaticamente.
