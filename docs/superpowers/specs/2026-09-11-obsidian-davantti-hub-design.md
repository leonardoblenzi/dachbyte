# Organização do vault Obsidian: Davantti e Hub

## Objetivo

Transformar o vault Obsidian local em uma central detalhada para documentação técnica e gestão diária dos produtos Davantti/Dachbyte e do Hub compartilhado.

## Escopo

- Criar uma estrutura de pastas e notas de índice no vault.
- Mapear os produtos e as camadas compartilhadas existentes no repositório.
- Registrar arquitetura, operações, projetos, decisões, tarefas e referências.
- Criar modelos reutilizáveis para notas recorrentes.
- Preservar a nota padrão e todo conteúdo que já exista; nada será apagado.

## Arquitetura da informação

```text
00 - Início
01 - Estratégia e produto
02 - Hub
03 - Davantti
04 - Arquitetura compartilhada
05 - Operações e infraestrutura
06 - Projetos ativos
07 - Decisões
08 - Conhecimento e referências
09 - Diário e tarefas
99 - Arquivo
Templates
```

Cada área terá uma nota de índice. Produtos terão uma página-mãe contendo propósito, situação, caminhos relevantes no repositório, integrações, decisões e projetos associados. O Hub será documentado como a base transversal de identidade, acesso e cobrança.

## Conteúdo inicial

- Davantti/Dachbyte: módulos Mercado Livre, Shopee, Seller, Volt, suporte e extensões.
- Hub: identidade, autorização, uso e cobrança compartilhados.
- Arquitetura compartilhada: gateway, branding, configuração e compatibilidade.
- Operações: VPS, Docker, Caddy, bancos, rotinas e runbooks existentes.
- Gestão: projetos ativos, decisões e quadro de tarefas por estado.

## Fluxo de uso

1. A nota `00 - Início` oferece links para sistemas, projetos, tarefas e decisões recentes.
2. Uma nota de produto aponta para suas subnotas técnicas, operações e iniciativas ativas.
3. Projetos relacionam produto, objetivo, estado, próximos passos e implementação.
4. Decisões registram contexto, decisão, impacto e notas afetadas.
5. Tarefas são classificadas em inbox, próximas, em andamento, aguardando e concluídas.

## Segurança e manutenção

- Não mover nem excluir arquivos do repositório ou notas existentes.
- Usar links internos entre notas e referências explícitas aos caminhos do código.
- Marcar como `A mapear` qualquer informação não verificável no repositório.
- Validar a resolução dos links internos ao fim da criação.
- Usar modelos para padronizar novas notas de produto, projeto, decisão e reunião.

## Critérios de aceite

- A página inicial alcança qualquer produto, projeto ou rotina com no máximo dois cliques.
- Cada produto e o Hub possuem uma página-mãe detalhada e interligada.
- A estrutura distingue documentação técnica de gestão diária sem isolá-las.
- O vault preserva a nota inicial e permite arquivamento futuro sem exclusões.
