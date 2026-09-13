# Avantracking: Sessao do Admin Mestre e Saude das Integracoes

## Objetivo

Manter a empresa escolhida pelo admin mestre apos a renovacao da sessao e
detectar configuracoes ou autenticacoes de integracao que exigem acao do
cliente, com aviso no sino e por e-mail.

## Diagnostico

- A troca de empresa atualiza `User.companyId`, mas o seletor recarrega a
  pagina. A sessao criada pelo Hub reprovisiona o usuario e sobrescreve o
  `companyId` pela empresa de origem do Hub.
- A Tray renova o access token apenas quando uma sincronizacao ja precisa
  dele. Nao existe rotina preventiva nem comunicacao quando o refresh token
  deixa de ser valido.
- O resolvedor de destinatarios de notificacoes atualmente nao filtra a
  preferencia `receivePlatformEmails`.

## Decisoes

1. O admin mestre preserva a empresa atualmente selecionada quando a sessao
   vinda do Hub reprovisiona seu usuario. O seletor atualiza o contexto local
   sem recarregar a pagina.
2. Um monitor central roda na inicializacao e a cada 30 minutos apenas em
   `MOD_SITUATION=PRODUCTION`. Ele avalia credenciais de ERP e rastreio e
   tenta renovar preventivamente o token Tray 30 minutos antes do vencimento.
3. Incidentes sao persistidos por empresa, integracao e codigo. A primeira
   deteccao, uma reabertura e, no maximo, um lembrete a cada 24 horas criam
   notificacao e e-mail. Uma verificacao saudavel encerra o incidente.
4. Erros transitivos de rede da Tray nao pedem reconexao. Token ausente,
   invalido ou expirado abre o incidente de reconexao.
5. E-mails respeitam `receivePlatformEmails`; as notificacoes internas
   continuam disponiveis no feed da empresa.

## Cobertura Inicial

- Tray ativa sem autenticacao ou com refresh token invalido.
- AnyMarket, Magazord e JET ativos sem as credenciais minimas.
- Intelipost ativa sem Client ID ou API key.
- SSW ativa sem ao menos um CNPJ configurado.

## Fora de Escopo

- Testes remotos de conectividade para integracoes que nao sejam Tray.
- Alertas para conectores sem credencial por empresa implementada no modulo.
- Alteracao de configuracoes de integracao feitas pelos usuarios.
