# Encerramento de contas Seller pelo Hub

Data: 2026-10-06
Estado: desenho aprovado em conversa; aguardando revisão deste documento

## Objetivo e escopo

Permitir que um administrador encerre um recurso de conta externa dos módulos Seller Mercado Livre, Shopee ou Magalu a partir do Hub. A sequência obrigatória é **desativar, resolver pendências e saldos, excluir da operação**. A exclusão não apaga histórico financeiro nem auditoria. O fluxo não substitui o OAuth: uma vinculação futura exige autorização normal do provedor e segue a política comercial vigente.

## Decisão arquitetural

O Hub coordena o ciclo de vida. Cada Seller expõe uma operação interna autenticada e idempotente de desativação e outra de desvinculação, implementadas com suas próprias tabelas, filas e regras. O Hub nunca altera diretamente o banco de outro módulo. As rotas existentes de usuário/admin são referências, não contratos prontos para o Hub: ML, Shopee e Magalu têm semânticas diferentes de revogação e serão adaptados separadamente.

As chamadas internas identificam módulo, tenant DACH, recurso, conta externa e operação administrativa por identificadores estáveis. Exigem autenticação serviço-a-serviço, autorização administrativa no Hub e registro de ator, motivo, instante e identificador de correlação. Uma chamada repetida com o mesmo identificador deve devolver o estado atual sem repetir efeitos destrutivos.

## Estados e transições

| Estado no Hub | Significado | Acesso e trabalho novo | Ação seguinte |
| --- | --- | --- | --- |
| Ativo | Recurso operacional | Conforme política | Desativar |
| Desativação pendente | Hub já bloqueou o acesso; Seller ainda não confirmou parada | Bloqueado | Repetir/diagnosticar |
| Desativado | Seller confirmou parada de novos trabalhos | Bloqueado | Resolver saldo e operações; excluir |
| Exclusão pendente | Desvinculação local ainda não confirmada | Bloqueado | Repetir/diagnosticar |
| Excluído | Seller confirmou tokens e vínculo revogados; recurso oculto da lista operacional | Bloqueado | Consultar histórico |

**Desativar** aplica primeiro o bloqueio no Hub e em seguida pede ao Seller que impeça novos jobs, sincronizações e operações. Um job já em andamento deve alcançar estado terminal seguro ou ser interrompido sem repetir escrita externa. Falha de comunicação mantém o Hub bloqueado e sinaliza desativação pendente; nunca reativa implicitamente o recurso.

**Excluir** só é permitido após confirmação da desativação, saldo total de crédito utilizável zerado e ausência de trabalho pendente ou resultado externo incerto. O Seller remove credenciais OAuth utilizáveis e o vínculo operacional, sem apagar pedidos, sincronizações, movimentações financeiras ou auditoria. O Hub só marca Excluído após confirmação. O recurso sai da lista operacional, mas permanece no histórico administrativo. Falha parcial fica em Exclusão pendente, com erro sanitizado e retry explícito.

## Créditos e histórico

O Hub reaproveita **Ajustar saldo**, que já exige motivo e hoje altera o saldo de recarga. A UI mostra cada componente de saldo e explica por que a exclusão está bloqueada. Se houver crédito utilizável de franquia ou plano, o administrador precisa resolvê-lo por política/rotina financeira apropriada; o ajuste de recarga não deve fingir que zera esses componentes. Ajuste manual negativo não equivale a estorno financeiro; qualquer obrigação de reembolso ou conciliação continua fora deste fluxo. O ledger de créditos, a política anterior, o ator e os recibos de desativação/exclusão permanecem consultáveis. Nenhum registro financeiro é apagado para liberar a exclusão.

## Interface administrativa

Cada card de conta vinculada oferece **Desativar** quando ativo; após confirmação, mostra **Ajustar saldo** e **Excluir**. Antes da confirmação de exclusão, a tela mostra o nome da conta, módulo, saldos e eventuais operações impeditivas, exige motivo e deixa claro que o OAuth terá de ser feito novamente para voltar a operar. Estados pendentes exibem etapa, horário, erro sanitizado e ação **Tentar novamente**. Recursos excluídos não aparecem na listagem operacional padrão; ficam acessíveis em **Histórico**, sem botões de operação.

## Falhas, concorrência e segurança

- Revalidar a autorização administrativa e a identidade exata do recurso no momento de cada ação.
- Bloquear desativação/exclusão concorrentes do mesmo recurso e tratar retries de modo idempotente.
- Revalidar saldos e operações impeditivas no servidor imediatamente antes da exclusão, não confiar na UI.
- Se uma operação externa estiver em estado incerto, bloquear a exclusão até reconciliação; não repetir escrita remota para resolver a pendência.
- Não incluir access token, refresh token, segredo ou cabeçalho de autorização em respostas, logs ou recibos.
- Não tratar a exclusão do Hub como logout da sessão do provedor (Magalu/ML/Shopee); somente credenciais e vínculo armazenados pela DACHBYTE são revogados.

## Validação e entrega

Cobrir os três adaptadores Seller com testes de: recurso ativo, desativação, saldo positivo, ajuste manual auditado, trabalho em andamento/incerto, exclusão, repetição de chamadas, falha de rede, retry, histórico e nova vinculação OAuth. Testar que Hub e Seller negam acesso e novos jobs imediatamente após a desativação. Entregar em etapas: contrato e estados do Hub; adaptadores ML/Shopee/Magalu; UI administrativa; testes integrados. Não executar encerramento real de contas existentes durante a implantação.

Fora do escopo: hard delete de dados históricos, estorno financeiro automático, revogação da sessão no site do provedor e liberação comercial automática de uma nova conta.
