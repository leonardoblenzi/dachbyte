# Seller: teste gratuito por empresa e módulo — design

Date: 2026-10-20
Status: aprovado em conversa; aguardando revisão deste documento antes da implementação

## Decisões de produto

- Cada empresa pode testar cada módulo Seller uma única vez por sete dias corridos. O usuário pode testar apenas ML, apenas Shopee ou ambos; cada módulo tem seu próprio início e fim. Vincular outras contas no mesmo módulo não reinicia nem estende o prazo.
- A autorização OAuth acontece antes da coleta do e-mail. O prazo começa somente quando o usuário confirma o e-mail e ativa o acesso. O tempo gasto entre OAuth e ativação não consome o teste.
- Durante o teste, operações do módulo são ilimitadas: não há franquia, reserva nem débito de créditos. Uso e jobs continuam auditados. Créditos comprados anteriormente não são consumidos durante o teste.
- Ao vencer, o backend impede novas operações e mantém contas vinculadas, dados e relatórios. Não há cobrança automática. O usuário vê a faixa apurada e pode contratar para continuar.
- O cliente não declara o volume, escolhe a faixa ou altera o próprio plano. A faixa de cada conta vem de pedidos pagos do último mês calendário fechado. O sistema reapura antes de apresentar a contratação. Falha na apuração deixa a conta em `aguardando apuração`; não presume a menor faixa. Acima de 3.000 pedidos, a contratação automática não é oferecida.
- Os preços fixos aprovados na especificação `2026-10-20-seller-commercial-pricing-refresh-design.md` permanecem; esta entrega não muda preços por operação, pacotes de recarga ou saldos.

## Abordagem escolhida e alternativas rejeitadas

Registrar o direito de teste no Hub por `(tenant_id, module_slug)` e manter a autorização operacional por recurso. Assim o relógio é único por empresa/módulo, mas a faixa e o preço continuam por conta vinculada. Reutilizar `access_policy=temporary` e `access_ends_at` para recursos de teste, com estado de teste separado do saldo financeiro. O Seller consulta o Hub para a decisão de acesso e para dispensar créditos, sem usar flags legadas como autoridade.

Não usar `access_policy=unlimited` permanente para representar teste, pois ele não impõe vencimento. Não registrar sete dias independentes por conta, pois nova vinculação estenderia indevidamente o teste. Não criar crédito fictício de 100 c, pois o teste aprovado é de operações ilimitadas.

## Fluxo e fronteiras

1. A landing inicia OAuth público do módulo escolhido com `state` de curta duração, vinculado a uma sessão provisória segura. O callback grava credenciais criptografadas em registro provisório, sem conceder acesso e sem iniciar o relógio. O vínculo só é consumido uma vez.
2. Após OAuth, o usuário informa e confirma o e-mail. O cadastro/convite cria ou associa a empresa de forma controlada. A ativação associa as credenciais provisórias à empresa e cria idempotentemente o registro de teste do módulo com `started_at` e `ends_at = started_at + 7 dias`. Um novo vínculo no mesmo módulo usa o prazo existente; um teste já consumido não é reaberto.
3. O Seller agenda a apuração dos pedidos pagos do mês calendário fechado anterior para cada conta OAuth. ML usa o total de `/orders/search`; Shopee usa o agregado de pedidos pagos da loja após sincronização. Guardar quantidade, período, origem, instante da apuração e estado de erro por recurso. Nunca aceitar quantidade declarada pelo navegador como autoridade comercial.
4. O Hub expõe o estado do teste ao Seller e à área Contas: módulo, início/fim, contas incluídas e eventual estado de apuração. O backend das operações consulta essa autoridade. Durante teste válido, o quote indica `trial_unlimited`, o modal mostra `0 c durante o teste`, e reserve/settle não debita carteira. A trilha de auditoria registra quantidade processada e êxitos/falhas normalmente.
5. No vencimento, novas operações falham fechadas pelo backend; jobs já aceitos antes do prazo podem concluir, sem débito retroativo. Leituras de histórico e relatórios permanecem acessíveis. A página apresenta o preço calculado por conta e CTA de contratação, sem seleção manual de faixa. Um checkout iniciado após nova apuração congela faixa, quantidade, preço e matriz comercial; pagamento confirmado provisiona o acesso pago. Sem pagamento, não há extensão tácita.
6. Créditos previamente comprados permanecem em carteira. Quando houver acesso pago e `consumption_model=prepaid_credits`, o modelo normal de quote/reserva/acerto volta a valer. O teste não altera saldo nem concede créditos.

## Painel do usuário: Seleção de plataforma

`apps/seller-ml/views/selecao-plataforma.html` continua sendo o painel central do cliente, com as áreas existentes Início, Módulos, Contas, Planos e Empresa. Não criar um painel de teste separado. Na Home e em Módulos, cada cartão apresenta `Disponível para testar`, `Teste grátis` com dias restantes, `Teste encerrado` ou `Ativo pago`, conforme o estado do Hub. O botão de testar escolhe **o módulo**, nunca a faixa comercial. A Home não pode esconder um módulo em teste por filtrá-lo como não contratado.

Em Contas, cada conta mostra sua situação de acesso, pedidos apurados do mês fechado e faixa atribuída; o drawer existente detalha a origem/período da apuração, o preço mensal correspondente e eventuais erros. Durante os sete dias, o painel mostra o prazo do módulo e que as operações são ilimitadas; não apresenta saldo fictício. Em Planos e cobrança, a contratação após o teste exibe preços por conta calculados pelo Hub, sem campos editáveis de plano, faixa ou `Pedidos estimados`. O usuário fornece apenas dados de cobrança e forma de pagamento. A ação atual `Alterar plano` de autoatendimento não pode permitir que o cliente substitua a faixa apurada; uma correção de apuração ou condição negociada segue gestão administrativa. A navegação para Contas, Empresa, histórico e regularização permanece disponível depois do vencimento.

Contratação, pagamento e renovação **partem da Seleção de plataforma**. A Home, o cartão do módulo, a linha de Contas e a área Planos e cobrança podem oferecer CTAs contextuais, mas todos convergem para o fluxo de contratação/renovação deste painel. O drawer apresenta a cotação autoritativa do Hub por conta e permite completar os dados de cobrança; a criação do checkout ocorre pelo gateway/Hub. Se o Asaas exigir redirecionamento, o usuário retorna ao mesmo painel, que consulta o status real do pedido e mostra `aguardando pagamento`, `pago/ativo` ou `falhou`, sem ativar pelo retorno do navegador. Renovação individual ou em conjunto também começa no painel, reapura a faixa quando necessário e só provisiona a nova vigência após confirmação de pagamento. Nenhum módulo inicia um checkout paralelo com preço ou estado divergente.

## Segurança e falhas

- OAuth público deve usar PKCE, `state` de uso único, validade curta, cookies seguros e proteção contra associação de conta ML/Shopee a empresa errada. Tokens provisórios são criptografados e removidos se expirarem sem ativação.
- A ativação por e-mail e a criação do teste são idempotentes; nenhum replay de callback, reenvio de convite, reconexão ou segunda conta reinicia os sete dias. Uma empresa preexistente que já usou o teste do módulo não recebe novo teste ao cadastrar outro usuário.
- Se o Hub estiver indisponível ou o estado do teste não puder ser confirmado, a operação não presume gratuidade ilimitada. Se a apuração de vendas falhar, ela pode ser repetida sem alterar `started_at` ou conceder nova janela.
- O fim do teste é aplicado por hora do servidor, não por horário do navegador. Jobs admitidos até `ends_at` usam o snapshot de admissão para terminar. Jobs criados após `ends_at` são rejeitados.
- Dados e créditos comprados permanecem após expiração ou falha de pagamento. Desvinculação segue o fluxo existente de retirement, distinto do fim do teste.

## Verificação e implantação

- Testar: dois módulos na mesma empresa com relógios independentes; duas contas no mesmo módulo sem extensão; novo usuário na mesma empresa sem novo teste; replay OAuth/convite; ativação tardia; limite exato dos sete dias; falha do Hub; job aceito antes e depois do vencimento; saldo comprado intacto; apuração zero, erro e mais de 3.000 pedidos; checkout sem faixa declarada pelo cliente.
- Testar ML e Shopee separadamente, incluindo escopo OAuth e disponibilidade real dos dados de pedidos do mês fechado. Publicar Hub antes do Seller e ativar com conta de teste controlada. Não aplicar migration nem habilitar rollout em produção sem validação explícita.

## Dependência de especificação anterior

A seção `User flows` da especificação de atualização comercial que permite ao prospect declarar vendas e selecionar plano **não se aplica ao onboarding inicial**. Sua tabela de preços e regras de snapshot continuam válidas. A interface de escolha de plano preparada localmente deve ser substituída por exibição de faixa apurada pelo sistema, não publicada como está.
