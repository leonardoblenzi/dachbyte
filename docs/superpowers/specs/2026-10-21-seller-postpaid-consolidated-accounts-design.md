# Seller: contas adicionais e mensalidade pós-paga consolidada — design

Date: 2026-10-21
Status: aprovado pelo usuário em 2026-10-21; aguardando plano de implementação

## Escopo e relação com os desenhos anteriores

Este desenho cobre a contratação mensal fixa de contas ML e Shopee já vinculadas a uma empresa Seller, inclusive a adição de outra conta a um módulo existente. O teste gratuito de sete dias por `(empresa, módulo)`, a apuração autoritativa de pedidos por conta e as faixas/preços da matriz comercial continuam válidos. Este desenho **substitui**, para mensalidades ML/Shopee, a regra anterior de pagar antes de provisionar acesso: depois do teste ou ao adicionar uma conta a uma empresa paga, o usuário aceita a proposta e usa o período antes da cobrança. Também substitui a ideia de assinaturas financeiras independentes por recurso por uma fatura consolidada da empresa; os itens e direitos de acesso permanecem individualizados por conta.

Não altera a compra pré-paga de créditos ML, o preço das operações, saldos existentes ou o fluxo de teste gratuito. Créditos de operações não entram na mensalidade pós-paga e continuam sujeitos ao quote/reserva/acerto próprios quando o teste não estiver ativo.

## Modelo comercial aprovado

- Cada conta vinculada tem faixa e mensalidade próprias, apuradas pelo Hub a partir dos pedidos pagos do último mês calendário fechado disponível. O cliente não declara quantidade, seleciona faixa nem muda preço.
- A empresa tem uma única âncora mensal de fechamento, definida na primeira ativação paga e preservada quando adiciona outras contas ou módulos. Uma âncora no dia 29, 30 ou 31 usa o último dia dos meses mais curtos e volta ao dia original no mês seguinte.
- O primeiro período de uma conta adicionada no meio do ciclo é proporcional aos dias civis em `America/Sao_Paulo`, da data do aceite (inclusiva) à data do próximo fechamento (exclusiva), divididos pelos dias civis do ciclo completo. O Hub calcula em centavos, arredonda uma vez por item e mostra valor e datas antes do aceite. Nos ciclos seguintes cobra a mensalidade cheia, salvo mudança de faixa.
- O cliente aceita os termos e começa a usar sem pagamento imediato. No fechamento, o Hub emite uma fatura da empresa para o período encerrado, discriminando módulo, conta, faixa, período e valor de cada item. A fatura vence até 23h59 do mesmo dia, no fuso `America/Sao_Paulo`. A data de fechamento e a de vencimento são iguais para Pix e cartão.
- Cartão e Pix comum são opções. No cartão, a cobrança pode ser tentada automaticamente se houver autorização e meio válido. No Pix comum, o cliente efetua o pagamento da cobrança gerada; não se promete débito automático. Pix Automático, se adotado depois, será um fluxo separado de autorização.
- A cobrança é indivisível para fins de desbloqueio: uma fatura vencida e não confirmada suspende todos os módulos pagos que ela cobre. Pagamento parcial não libera um subconjunto. Desativação ou reconexão OAuth não apaga valores já devidos.

## Jornada de uma conta adicional

1. Em **Seleção de plataforma → Contas → Vincular conta**, um usuário autorizado da empresa inicia OAuth do ML ou Shopee. O callback associa a identidade externa imutável à empresa correta, de forma idempotente. Conta já vinculada a outra empresa exige o fluxo explícito de transferência/desvinculação; e-mail coincidente, sozinho, não autoriza a associação.
2. A conta aparece imediatamente em **Contas** como `Conectada · Validando faixa`. O usuário pode editar um apelido local; não muda o identificador do marketplace nem o histórico. Credenciais são guardadas com segurança, mas o vínculo ainda não concede operações pagas.
3. O Seller agenda a apuração em background. O Hub recebe período, quantidade, origem e estado; falha ou dado incompleto mantêm a conta em `Aguardando apuração`, com retentativa observável, nunca na menor faixa por padrão. Acima de 3.000 pedidos, o CTA automático é substituído por contato comercial.
4. Com apuração válida, o Hub apresenta proposta autoritativa: conta, período/quantidade apurados, faixa, mensalidade, primeiro período proporcional, primeira data de cobrança e termos de renovação/reapuração. O navegador não envia preço ou faixa como autoridade. O aceite é explícito e auditado com versão da matriz, cotação, usuário, instante e conta; requisições repetidas não duplicam itens.
5. Após aceite válido, o Hub ativa o direito de acesso pago daquela conta, sem esperar pagamento antecipado. A fatura do ciclo posterior registra o uso desde o aceite. Se a empresa já estiver inadimplente, não é possível ativar outra conta para contornar a suspensão; o painel orienta a quitar a dívida primeiro.

## Reapuração, aviso e desativação

- Antes de cada renovação, o Seller/Hub reapura os pedidos da conta no último mês calendário fechado **disponível na data do corte da cotação**, registra o período efetivamente usado e congela a faixa/preço do próximo ciclo. Erro na apuração não reduz a faixa nem cria preço estimado; mantém a condição vigente até obter dado confiável e sinaliza revisão necessária.
- Queda de faixa reduz a mensalidade no próximo ciclo. Aumento só entra em vigor em uma renovação futura após aviso prévio de pelo menos sete dias corridos com faixa anterior/nova, valor e data de vigência. Se a apuração chegar tarde para esse prazo, o preço anterior vale por mais um ciclo. Não há reajuste retroativo. O aviso deve estar disponível no painel e ser enviado ao contato de cobrança. A data de fechamento da empresa não muda.
- Antes do aumento, o cliente pode **Desativar assinatura desta conta**. O acesso continua até o fim do ciclo em curso e a mensalidade correspondente permanece devida. Ao fim, operações daquela conta são bloqueadas, mas OAuth, apelido, histórico e dados permanecem; desativar não significa desvincular.
- Para **Reativar assinatura**, o Hub reapura a faixa e apresenta nova proposta para aceite. Não exige novo OAuth se a conexão continuar válida; credencial revogada exige reconexão. Não concede outro teste gratuito. Dívida vencida da empresa precisa ser quitada antes da reativação.

## Inadimplência e autoridade operacional

No fechamento, a fatura consolida os itens do ciclo encerrado. Se não houver confirmação de quitação até 23h59 do vencimento em `America/Sao_Paulo`, o Hub marca a empresa como inadimplente e suspende o acesso operacional a todos os módulos pagos abrangidos. O Seller não deve apenas esconder botões: rotas de operações e admissão de jobs consultam a autorização do Hub e falham fechadas. Jobs admitidos antes da suspensão podem terminar sob seu snapshot de admissão, sem débito retroativo de mensalidade.

O usuário ainda pode autenticar-se e acessar a Seleção de plataforma, faturas, alteração de forma de pagamento e suporte. O Seller preserva OAuth, dados e histórico, mas não oferece acesso operacional aos módulos suspensos. Um retorno do navegador ou comprovante enviado pelo cliente não reativa acesso; a reativação depende de evento de pagamento confirmado pelo Asaas, processado de forma idempotente e reconciliável. Falha de webhook ou divergência de estado deve aparecer como `Pagamento em confirmação` e ser reconciliada sem segunda cobrança.

## Fronteiras técnicas e migração

- **Seller:** OAuth, vínculo/alias, apuração e telas. Não calcula preço autoritativo nem decide adimplência.
- **Hub:** catálogo/faixa, cotação, aceite, âncora da empresa, ledger imutável de itens mensais, proporcionalidade, fatura, estado de inadimplência e autorização por recurso/módulo. Nenhuma alteração de faixa reescreve período fechado.
- **Asaas:** criação/cobrança e eventos financeiros. O Hub mantém mapeamentos de cliente, fatura/cobrança e método; webhooks são validados, idempotentes e reconciliados. Não assumir que uma assinatura Asaas por recurso equivale à fatura consolidada ou que assinatura Pix é Pix Automático.
- O checkout atual do Hub provisiona após pagamento e registra contratos recorrentes por recurso. Implementar este desenho requer fluxo pós-pago e agregação financeira explícitos; não basta alterar a apresentação ou somar valores de assinaturas existentes. Antes de migrar uma empresa com contratos financeiros ativos, mapear saldo, vigência, cobranças pendentes e IDs do provedor; impedir fatura nova e assinatura antiga de cobrarem o mesmo período.
- A ativação em produção deve ser faseada, com feature flag e empresa piloto. Publicar Hub antes do Seller; não criar nem alterar cobrança real, aplicar migration ou converter contrato legado sem plano de migração e validação próprios.

## Verificação

Cobrir: duas contas ML adicionadas em dias diferentes, ML + Shopee na mesma empresa, proporcionalidade nos dias 28–31 e ano bissexto, fuso de Brasília, aceite repetido, OAuth repetido, conta externa já vinculada, apuração zero/falha/acima de 3.000, vencimento pago e não pago por cartão/Pix, confirmação tardia, webhook duplicado/fora de ordem, tentativa de novo job após suspensão, job já admitido, acesso à Seleção de plataforma durante bloqueio, desativação e reativação sem novo OAuth, dívida que permanece após desativação, aumento avisado em tempo, aumento apurado tarde, redução de faixa e reconciliação sem cobrança duplicada. Comparar soma dos itens com valor da fatura e com a cobrança Asaas em centavos.

## Dependência de especificações anteriores

O teste gratuito e a medição mensal descritos em `2026-10-20-seller-seven-day-module-trial-design.md` continuam válidos. Suas passagens que exigem **pagamento confirmado antes do primeiro acesso pago** são substituídas por este desenho pós-pago. As faixas e preços de `2026-10-20-seller-commercial-pricing-refresh-design.md` continuam válidos; seu checkout pré-pago de mensalidade deve ser adaptado, enquanto recargas pré-pagas de créditos permanecem como estão. Esta especificação descreve o estado desejado, não o estado já implementado.
