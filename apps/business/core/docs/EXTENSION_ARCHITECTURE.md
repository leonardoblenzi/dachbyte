# Volt Extension Architecture

## Objetivo

O Volt Core deve operar sozinho. Verticais, servicos e canais entram como extensoes registradas e nao como condicionais espalhadas pelo Core.

## Invariantes

1. O Core nao importa implementacoes de uma extensao concreta.
2. Uma extensao pode consumir apenas contratos publicos da plataforma/Core.
3. Capabilities decidem o que e carregado no frontend e o que e permitido no backend.
4. Payloads opcionais usam `extensions[extensionKey]` e estruturas vazias nao sao enviadas.
5. Rotas opcionais pertencem a extensao e mantem capability + permission guard no servidor.
6. Hooks sincronos existem somente para consistencia transacional; integracoes externas usam domain event -> outbox -> worker.
7. Hooks de limpeza podem declarar `runWhenDisabled` quando precisam preservar consistencia apos suspensao comercial.
8. Dados opcionais de entidades Core usam `volt_core.entity_extension_data`; o Core nao ganha colunas por vertical nova.
9. Telas pesadas, PDVs e handlers opcionais sao carregados dinamicamente no cliente.
10. `segmentKey` pode existir para onboarding/compatibilidade, nunca para conceder acesso operacional.

## Backend

O composition root registra os built-ins em `src/app.js`. O `ExtensionRegistry` oferece:

- runtime resources;
- namespaced input payloads;
- domain hooks;
- route registrars;
- permission/role contributions;
- runtime status/metricas de hooks.

A extensao consome `src/platform/extensions/coreContracts.js` em vez de importar internals aleatorios do Core.

### Payload

Core puro:

```json
{
  "customerId": "customer-1",
  "items": [],
  "payments": []
}
```

Com extensao:

```json
{
  "customerId": "customer-1",
  "items": [],
  "payments": [],
  "extensions": {
    "vertical.optical": {
      "prescriptionId": "rx-1"
    }
  }
}
```

`extensions` e omitido quando nenhuma extensao contribui dados significativos.

## Frontend

`src/client/extensions/registry.js` compoe somente extensoes habilitadas pela configuracao da empresa. Uma extensao pode contribuir:

- recursos lazy por pagina;
- navegacao e paginas;
- slots de UI;
- campos/modais;
- handlers de submit;
- mapeadores de workspace;
- filtros;
- schema de importacao;
- permissoes default por perfil.

Componentes pesados sao carregados via `import()` somente quando o recurso e usado.

## Persistencia de dados de extensao

`volt_core.entity_extension_data` usa chave composta por tenant, tipo de entidade, entidade e extension key. A tabela possui RLS + FORCE RLS. A migration 018 faz backfill dos metadados opticos de produtos existentes e mantem colunas legadas apenas para rollback/compatibilidade durante a transicao.

## Observabilidade

O endpoint Master de observabilidade inclui o status do registry e, por extensao:

- hooks registrados;
- runtime resources;
- total de chamadas;
- erros;
- duracao media;
- ultimo hook;
- ultima execucao;
- ultimo erro.

## Regra para novas extensoes

Adicionar um novo vertical/servico/canal deve significar majoritariamente criar `src/extensions/<key>` e `src/client/extensions/<key>`, registrar o manifest no composition root/client registry e declarar suas contribuicoes. Alteracoes em servicos operacionais do Core para conhecer o nome da nova extensao sao consideradas regressao arquitetural.
