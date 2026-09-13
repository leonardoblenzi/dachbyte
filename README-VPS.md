# DACHBYTE na VPS

## Objetivo final

Executar a plataforma DACHBYTE em uma VPS própria, com cada produto em seu processo e container, banco e filas privados, backup externo e uma única entrada HTTPS. A mudança reduz a dependência de serviços com cobrança por processo sem alterar as URLs usadas por clientes, integrações ou callbacks OAuth.

## Proposta

O código executável fica em `apps/`.

```text
apps/
  gateway/              login, sessão, portal e rotas /go/*
  seller-ml/            Mercado Livre e worker de filas
  seller-shopee/
  seller-madeira/
  seller-tracking/
  seller-log/
  seller-leader/
  business/
    core/
    stock/
    chat/
    price/
```

O gateway emite a sessão no mesmo domínio público. O Caddy encaminha cada prefixo ao serviço certo na rede Docker. Por exemplo, `/ml` segue para `seller-ml-web` e `/shopee` segue para `seller-shopee`. Como o domínio permanece o mesmo, os cookies criados pelo gateway continuam disponíveis para os produtos.

```text
Internet
  -> Caddy: HTTPS, domínio e roteamento
     -> gateway
     -> produtos DACHBYTE Seller e DACHBYTE Business

seller-ml-worker -> Redis + PostgreSQL
chat-api         -> PostgreSQL
PostgreSQL       -> volume persistente + backup externo
Redis            -> volume persistente
```

Somente o Caddy expõe portas públicas. PostgreSQL e Redis ficam na rede privada do Docker.

## Estado atual da branch `dach`

- Produtos reorganizados em `apps/` com nomes DACHBYTE.
- Gateway separado dos produtos em processo.
- ML possui processo web e worker separados.
- Produtos Seller usam os prefixos públicos existentes e health checks no próprio prefixo.
- Business usa a variável `DACHBYTE_CHAT_API_URL` para falar com a API Python do Chat; ele não inicia mais Python como processo-filho.
- A stack VPS em `infra/compose.vps.yml` separa também Core, Stock, Chat e Price.
  Nela o Caddy encaminha HTTP e WebSocket de `/chat-api` diretamente ao Python.
- Dockerfiles, exemplos de ambiente por serviço, volumes e job de backup externo
  estão disponíveis. A configuração inicial expõe Caddy somente em loopback.
- O procedimento operacional está no [runbook](docs/operations/dachbyte-vps-staging-runbook.md).

Ainda não há mudança de DNS, dados de produção, callbacks OAuth ou desligamento de Render e Neon.

## Próximos passos

1. Disponibilizar a VPS Hostinger e acesso SSH; conferir capacidade e instalar Docker.
2. Preencher os ambientes, criar roles/bancos de staging e restaurar schemas sanitizados.
3. Construir as imagens e subir a stack de staging, validando login, `/go/*`, rotas, filas ML e Chat.
4. Configurar o destino do backup criptografado, sua agenda, retenção e executar restauração real.
5. Em uma etapa aprovada separadamente, restaurar uma cópia do banco na VPS, atualizar DNS e callbacks OAuth, acompanhar o tráfego e manter Render/Neon disponíveis para rollback.

## Critério para corte de produção

O corte só acontece após a stack de staging responder a todos os health checks, validar autenticação e OAuth, processar uma fila ML, restaurar um backup com sucesso e ter um caminho documentado para voltar o domínio ao ambiente atual.
