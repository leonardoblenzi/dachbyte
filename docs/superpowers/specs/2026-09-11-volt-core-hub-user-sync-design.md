# Sincronizacao de empresas e usuarios do Volt Core com o Hub

## Objetivo

Manter o Volt Core como painel operacional para cadastrar empresas e usuarios, com o Hub como fonte de verdade para identidade, tenant, empresa, status e acesso ao produto `volt_core`.

## Criacao de empresa

- O painel master do Volt Core pode criar uma empresa nova sem exigir cadastro previo no Hub.
- Ao salvar, o Volt Core cria primeiro o tenant e a empresa no Hub, instala `volt_core` e recebe os identificadores globais.
- Apenas apos essa confirmacao o Volt Core cria o ambiente local usando o tenant global retornado pelo Hub.
- A mesma operacao pode criar o primeiro usuario responsavel. Nesse caso, o Hub cria ou atualiza a identidade, associa a nova empresa, concede `volt_core` e envia o convite de senha.
- Se a criacao no Hub falhar, nao pode existir empresa local parcial. Se a gravacao local falhar depois da confirmacao do Hub, a operacao fica pendente de reconciliacao com a mesma chave de idempotencia.

## Regras de identidade

- Todo usuario operacional criado pelo Volt Core deve ter uma empresa selecionada.
- A empresa selecionada deve corresponder a um tenant ativo no Hub com o produto `volt_core` instalado. Uma empresa nova criada pelo Core recebe essa instalacao no mesmo fluxo.
- Um mesmo e-mail representa uma unica identidade global e pode possuir vinculos em mais de uma empresa.
- Somente o administrador tecnico bootstrap do Volt Core pode existir sem empresa vinculada. Ele nao e criado pelo modal operacional.
- Senhas e convites pertencem ao Hub. O Volt Core nao cria nem armazena senhas para usuarios sincronizados.

## Fluxo de criacao e edicao

1. O operador abre uma empresa no Volt Core e escolhe `Novo usuario`, ou cria uma empresa no painel master.
2. Para uma empresa existente, o formulario exibe a empresa atual como campo somente leitura. No painel master, a empresa e obrigatoria e nao possui valor padrao.
3. Para uma empresa nova, o Volt Core solicita ao Hub a criacao do tenant, empresa e instalacao de `volt_core` antes de persistir o ambiente local.
4. O Volt Core solicita ao Hub o upsert da identidade, o vinculo ao tenant e a concessao de `volt_core`.
5. O Hub registra o convite de primeiro acesso e responde com a identidade global e o estado efetivo.
6. Somente apos a confirmacao do Hub o Volt Core grava ou atualiza o vinculo local, perfil e permissoes de telas.
7. O Hub recebe atualizacoes de nome, status e vinculo iniciadas no Core. Alteracoes no Hub vencem conflitos e determinam a autorizacao de login.

## Limites de responsabilidade

- Hub: tenant, empresa, usuario global, senha, convite, status, produto contratado e permissao de produto.
- Volt Core: perfil de operacao, telas permitidas e permissoes internas por empresa.
- A remocao de `volt_core` ou a inativacao no Hub bloqueia o acesso ao Core no proximo request autenticado e invalida a sessao local.

## Confiabilidade e auditoria

- As chamadas de escrita usam chave de idempotencia por usuario, tenant e operacao.
- Se o Hub estiver indisponivel, o Volt Core nao ativa o usuario localmente; apresenta falha de sincronizacao e permite nova tentativa.
- Cada sincronizacao registra resultado, identificadores Hub/Core e ator no historico de auditoria.

## Validacao

- Criacao por empresa gera um usuario unico no Hub, com `volt_core` na empresa correta.
- Criacao de empresa pelo Core gera primeiro um tenant e uma empresa no Hub, com `volt_core` instalado, e so entao um ambiente local.
- O modal master exige empresa e nao seleciona nenhuma automaticamente.
- Um e-mail existente recebe novo vinculo sem duplicar identidade.
- Usuario inativado ou sem `volt_core` no Hub nao acessa o Core.
- Falha do Hub nao deixa usuario local sem identidade global.
