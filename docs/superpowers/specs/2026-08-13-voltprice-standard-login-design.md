# VoltPrice: login padrão por empresa

## Objetivo

Simplificar a autenticação do VoltPrice para e-mail e senha. O formulário não
solicita código TOTP nem código/slug de empresa.

## Regras de acesso

- O Admin Master autentica apenas com e-mail e senha e conserva o acesso global
  de administração e suporte às empresas.
- Um usuário comum deve possuir exatamente uma associação ativa com uma empresa
  ativa. Essa empresa é selecionada no servidor ao criar a sessão.
- O Admin Master provisiona os usuários comuns, define a empresa única de cada
  conta e entrega uma senha temporária inicial.
- No primeiro login, o usuário comum deve alterar a senha temporária antes de
  acessar os recursos da empresa.
- Uma conta comum com nenhuma associação ativa continua recebendo `no_workspace`.
- Uma conta comum com mais de uma associação ativa recebe um erro explícito de
  configuração. O login não escolherá uma empresa implicitamente.
- MFA/TOTP deixa de ser validado no login. Os dados TOTP existentes permanecem
  no banco, mas não participam da decisão de autenticação.

## Alterações

- Backend: remover a verificação MFA do fluxo de login e retirar o parâmetro
  `workspace` da decisão de sessão.
- Persistência e sessão: registrar a exigência de troca de senha inicial e
  limitar a sessão pendente à alteração de senha até sua conclusão.
- Administração: permitir que o Admin Master crie o usuário, vincule sua única
  empresa e inicie a senha temporária.
- Frontend: remover os campos de código MFA e empresa, além do seletor de
  workspace decorrente do login, e apresentar o fluxo obrigatório de nova senha
  no primeiro acesso.
- Testes: cobrir Admin Master sem OTP, usuário comum com uma empresa e conta
  comum com múltiplas empresas recusada, além do bloqueio até a troca da senha
  temporária.

## Segurança

O escopo de empresa continua obrigatório no servidor para usuários comuns. A
mudança reduz apenas fatores/campos na entrada; não concede a usuários comuns
acesso a outra empresa.
