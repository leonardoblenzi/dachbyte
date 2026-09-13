# Conexões múltiplas de marketplace e links OAuth

## Objetivo

Permitir que uma empresa vincule e administre várias contas de Mercado Livre e Shopee. Cada conta recebe um nome editável e pode ser usada de forma explícita ao consultar pedidos e taxas. Usuários autorizados e o Admin Master também podem gerar links OAuth temporários para concluir a autorização em outro navegador, sem login prévio no VoltPrice.

## Escopo

O recurso cobre Mercado Livre e Shopee. Tray continua na mesma tela e segue o mesmo padrão visual de grupo, mas não ganha fluxo de seleção por pedido nesta entrega.

Cada empresa pode ter várias conexões ativas do mesmo canal. A tabela `volt_price.integration_connections` já suporta esse caso por meio da chave única `(tenant_id, channel, external_account_id)`.

## Interface

A página Integrações terá dois painéis.

O painel esquerdo mostra os grupos Tray, Mercado Livre e Shopee. Cada linha mostra o nome do canal, a quantidade de contas vinculadas e um botão com ícone `Vincular`. Clicar no grupo seleciona o canal e abre seu conteúdo no painel direito. Clicar em `Vincular` inicia uma nova autorização direta para aquele canal.

O painel direito mostra o grupo selecionado. Para Mercado Livre e Shopee, ele terá:

- título com a quantidade de contas vinculadas;
- botões `Vincular conta` e `Gerar link`;
- uma linha por conexão, com nome editável, identificador externo, status, última renovação e último erro;
- ações por conexão: editar nome, salvar, renovar e remover.

Após um OAuth bem-sucedido, o sistema cria o nome técnico inicial, como `Mercado Livre 123456`. O usuário pode substituí-lo pelo nome operacional que preferir, como `Drossi Principal`.

## Permissões

Quem tiver `integrations.manage` pode vincular, gerar link, renomear, renovar e remover conexões do próprio tenant.

O Admin Master pode gerar e administrar conexões para uma empresa escolhida. A ação precisa registrar o tenant alvo e o motivo do acesso quando ele usar uma sessão assistida. Nenhuma ação pode criar uma conexão sem tenant.

## Conexão direta e link OAuth

O botão `Vincular` mantém o OAuth no navegador atual e exige uma sessão do VoltPrice ligada a um tenant.

O botão `Gerar link` cria um convite OAuth de uso único, vinculado ao canal e ao tenant selecionado. O link não expõe tokens, IDs internos ou credenciais do aplicativo. Ele expira em 15 minutos e funciona em qualquer navegador, mesmo sem sessão do VoltPrice.

Ao abrir o link, a pessoa vê uma página pública curta com o nome da empresa, o canal e o botão `Continuar com Mercado Livre` ou `Continuar com Shopee`. Somente esse clique inicia o OAuth. O callback consome o estado PKCE, grava a conta no tenant do convite e marca o convite como concluído.

O sistema mostra páginas claras para links expirados, cancelados e já utilizados. O link não dá acesso ao VoltPrice, não permite trocar de empresa e não permite editar conexões.

## Persistência e auditoria

Uma migration cria `volt_price.integration_authorization_links` com:

- `id`, `tenant_id`, `channel`, `token_hash` e `created_by_user_id`;
- `expires_at`, `used_at`, `cancelled_at` e `connection_id`;
- metadados mínimos para origem e motivo de acesso assistido.

O banco guarda apenas o hash do token do link. O token completo aparece uma única vez na resposta de criação.

Renomear altera somente `integration_connections.display_name`. Remover uma conexão faz uma desconexão lógica: define o status como `disconnected`, limpa os tokens criptografados e preserva o registro, o histórico de sync e os logs de auditoria. Uma nova autorização da mesma conta reativa o registro existente.

O audit log registra a geração, abertura, cancelamento, expiração, conclusão de links; a criação, renomeação, renovação e remoção de conexões; e a associação manual de uma conta a um pedido.

## Pedidos e conta específica

Uma migration adiciona `marketplace_connection_id` opcional em `volt_price.orders`, referenciando `integration_connections`.

Ao importar ou enriquecer um pedido, o VoltPrice tenta localizar uma conexão ativa do mesmo canal cujo `external_account_id` corresponda ao identificador de seller ou shop recebido. Ele só associa automaticamente quando encontra uma única correspondência exata.

Quando os dados não identificarem a conta, a tela do pedido oferece um seletor com as contas ativas daquele canal. A API valida que a conexão pertence ao tenant e ao canal do pedido antes de salvar.

As chamadas de taxas, escrow, refresh e demais operações de marketplace recebem o `connectionId` explícito. O sistema não pode escolher silenciosamente a conexão mais recente do canal. Sem uma conta definida, a interface pede a seleção antes da consulta.

## API

O módulo de integrações passa a expor listagem agrupada por canal e endpoints por conexão para renomear, renovar e remover.

Os endpoints de início de OAuth aceitam tanto o fluxo autenticado quanto o convite público. O início autenticado deve retornar uma mensagem de conflito legível se a sessão não tiver tenant, em vez de propagar a violação `23502` do banco.

O módulo de pedidos aceita `connectionId` no vínculo manual de marketplace e exige esse ID para consultas financeiras quando existem várias contas do mesmo canal.

## Critérios de aceite

- Uma empresa consegue vincular três contas Mercado Livre e duas Shopee sem substituir conexões existentes.
- O usuário renomeia uma conexão e o novo nome aparece na lista após atualizar a página.
- Uma conta removida deixa de ter tokens utilizáveis e mantém seu histórico auditável.
- Um link gerado para Empresa A não consegue gravar uma conexão em Empresa B, expira em 15 minutos e falha após o primeiro uso.
- Um pedido com associação automática ou manual usa a conta correta ao consultar taxas.
- Um pedido sem conta definida nunca usa uma conta do canal por padrão.
- Um Admin Master sem tenant ativo recebe uma mensagem orientando a selecionar uma empresa; ele não recebe erro 500.

