# Política comercial no religamento OAuth Magalu

## Contexto

O Seller Magalu remove os tokens e marca a conta local como `revoked` quando o usuário clica em Desvincular. Ele também chama `POST /v1/internal/resources/unlink` no Hub. O Hub muda `billing_resources.access_policy` para `inactive`, mas hoje não registra a política anterior. Um novo OAuth atualiza a conta local e chama `POST /v1/internal/resources/sync`; esse endpoint não restaura a política de um recurso existente. O acesso por `resource_key` continua negado.

O Seller Magalu já tem correções locais, ainda não publicadas, para reconectar uma conta ativa com `target_account_id` e para recolocar a sincronização Hub em `pending` após um novo OAuth. Esta especificação trata a lacuna comercial do Hub. Não muda a concessão de scopes pela Magalu.

## Regra aprovada

O Hub restaura a política comercial vigente antes da desvinculação quando o mesmo recurso Magalu volta por OAuth para a mesma empresa DACH. A restauração mantém o prazo original e o modelo de consumo. Ela não cria um novo ciclo de créditos, não renova a assinatura e não altera a titularidade.

O Hub só restaura a política se o produto Magalu continuar instalado e ativo para a empresa. Uma política `paid` ou `temporary` com prazo vencido pode ser restaurada como registro histórico, mas `evaluateBillingResourceAccess` deve continuar negando acesso. Uma política `inactive` anterior ao unlink continua inativa.

## Dados e transições

No primeiro `unlink` de um recurso ativo, o Hub guarda em `billing_resources.metadata_json` um snapshot com `access_policy`, `consumption_model`, `plan_code`, `commercial_range_code` e `access_ends_at`. O snapshot inclui a chave do recurso, o tenant proprietário e a data do unlink. O Hub grava `unlinked=true` e muda `access_policy` para `inactive`. Um `unlink` repetido não substitui o snapshot por uma política já inativa.

No `sync` de um recurso existente, o Hub valida a empresa, o produto instalado, o marcador `unlinked=true` e a integridade do snapshot. Se tudo confere, restaura as cinco propriedades, grava `unlinked=false` e registra a data de religamento. Chamadas subsequentes de `sync` apenas atualizam nome e metadados operacionais; não mudam a política. Um recurso que nunca passou por `unlink` segue o fluxo atual.

O Hub deve serializar `sync` e `unlink` do mesmo `resource_key` para impedir que uma autorização OAuth concorrente reative uma conta após uma desvinculação mais recente. A implementação usa o mecanismo transacional já disponível no serviço de billing, sem criar uma segunda fonte de verdade comercial.

## Recursos desvinculados antes desta mudança

Esses registros não possuem snapshot. O Hub não deve presumir `unlimited`, usar a política de outra conta ou consumir uma política pendente destinada ao primeiro vínculo. A reconexão OAuth pode atualizar tokens, mas o acesso permanece inativo até um operador confirmar a política anterior por registro de contrato, pagamento ou trilha administrativa e aplicar essa política ao mesmo `resource_key`. Se não houver evidência, o operador precisa definir uma nova contratação. A interface deve explicar que o OAuth terminou, mas o Hub ainda não liberou o recurso.

## Erros e segurança

- O Hub rejeita `sync` quando o recurso pertence a outro tenant ou quando o produto não está instalado.
- Snapshot ausente, corrompido ou com tenant/recurso divergente não concede acesso.
- O Seller Magalu só marca `hub_sync_status=synced` quando a resposta do Hub confirma `access.allow=true`. Se o plano estiver vencido ou inativo, guarda erro diagnóstico e mantém a conta fora das operações protegidas.
- Nenhum token OAuth ou segredo entra no snapshot, nos logs de falha ou na resposta ao navegador.

## Verificação

Os testes do Hub cobrem primeira desvinculação, desvinculação repetida, religamento do mesmo recurso, idempotência, produto desinstalado, tenant divergente, snapshot ausente, prazo expirado e ausência de concessão de créditos. Os testes do Seller Magalu cobrem reconexão direcionada, organização errada no callback, conta revogada durante o consentimento e resposta Hub com `access.allow=false`.

Antes do deploy, revisar o diff contra a versão do Hub na VPS, que contém commits locais não enviados ao remoto. Publicar o Hub e o Seller Magalu somente depois de validar os testes e a política histórica da conta que o cliente vai reconectar. Não alterar as políticas comerciais dos registros legados sem evidência do contrato anterior.
