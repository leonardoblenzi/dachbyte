# VoltPrice: console de usuários por empresa para o Admin Master

## Objetivo

Permitir que o Admin Master administre, na interface do VoltPrice, os usuários
de cada empresa: visualizar acessos, provisionar uma conta com senha temporária
definida manualmente e redefinir essa senha quando necessário.

## Escopo e navegação

- A funcionalidade permanece na página existente **Admin Master**; não haverá
  uma área administrativa paralela.
- Cada linha da tabela de empresas ganha a ação **Gerenciar usuários**.
- A seleção de uma empresa revela um painel de contexto com seu nome, a lista
  de usuários ativos/inativos e ações de provisionamento.
- A ação de acesso assistido continua separada e mantém o comportamento atual.

## Fluxo de provisionamento

1. O Master seleciona uma empresa.
2. Preenche nome, e-mail, perfil e senha temporária.
3. A interface chama `POST /api/admin/tenants/:tenantId/users` com CSRF.
4. A API cria ou redefine o usuário apenas naquela empresa, invalida sessões
   anteriores e marca `mustChangePassword=true`.
5. A tela confirma que a senha temporária foi definida, limpa o formulário e o
   Master a entrega manualmente ao usuário por seu canal habitual.

O campo de senha fica vazio após sucesso, nunca é exibido em listas, respostas
de leitura, auditoria ou mensagens de erro. A redefinição usa o mesmo formulário
para o usuário selecionado, com confirmação explícita de que as sessões atuais
serão encerradas.

## API e segurança

- Acrescentar uma leitura exclusiva do Master:
  `GET /api/admin/tenants/:tenantId/users`.
- A resposta retorna somente metadados necessários à operação: id, nome, e-mail,
  perfil, status, datas relevantes e `mustChangePassword`; nunca hash, senha,
  token ou sessão.
- Todos os endpoints administrativos exigem sessão global do Master, conclusão
  da troca de senha, CSRF nas mutações e auditoria.
- Usuários comuns e administradores da empresa continuam sem poder criar,
  mover ou redefinir contas por esse console.
- A regra de exatamente uma associação ativa por usuário continua imposta no
  servidor; a tela não oferece troca de empresa.

## Interface e acessibilidade

- Preservar o visual industrial existente: cards, tabelas, toolbar e feedbacks
  do VoltPrice, sem introduzir um novo sistema visual.
- Usar um painel lateral/inline responsivo, com título da empresa selecionada,
  botão de retorno e estado vazio claro.
- Formulários terão labels explícitos, `autocomplete` adequado, erro em região
  viva e foco no primeiro campo inválido/sucesso relevante.
- A confirmação de redefinição será feita no cliente antes do POST; ela não
  substitui a validação do servidor.

## Testes

- O endpoint de listagem recusa sessão não-Master e retorna apenas campos
  seguros da empresa solicitada.
- O provisionamento por formulário envia empresa, nome, e-mail, perfil e senha
  temporária ao endpoint Master-only, sem renderizar a senha na tela depois.
- A tela não apresenta criação de usuário para usuários de empresa nem permite
  alterar o vínculo de empresa.
- Os testes de contrato existentes continuam cobrindo a obrigatoriedade de
  troca de senha no primeiro login.

## Fora de escopo

- Envio automatizado de e-mail, geração automática de senha ou recuperação de
  senha por e-mail.
- Delegar provisionamento a administradores de empresa.
- Alterar as integrações Tray, Mercado Livre ou Shopee; a conexão Tray será a
  fase seguinte, após este console.
