# Custo por SKU inline na Margem de venda ML

## Objetivo

Permitir corrigir um SKU sem custo diretamente na tabela **Margem por período**,
sem obrigar o usuário a abrir a tela **Custos por SKU**, procurar o mesmo SKU e
retornar à auditoria de margem.

## Escopo

### Edição na célula de custo

Para cada linha sem custo, a coluna `Custo por SKU` exibirá um campo monetário
compacto no padrão já usado nas tabelas operacionais do produto, acompanhado
por:

- o link `Ver histórico`;
- o botão `Salvar custo`.

O campo é uma correção de dado de custo, não uma edição de preço do anúncio. O
valor precisa ser monetário e estritamente maior que zero. Erros de validação
permanecem na própria célula e não enviam nenhuma alteração.

### Fonte única e histórico

O salvamento reutiliza integralmente o caminho de gravação de **Custos por
SKU**, incluindo suas validações, escopo de conta ativa, persistência e
histórico. Não será criado um segundo cadastro de custo nem uma regra própria
para a página de Margem.

Assim, o custo gravado pertence ao SKU de referência da conta e é aplicado a
todos os anúncios vinculados a esse SKU. `Ver histórico` abre o histórico desse
mesmo SKU no contexto existente de custos.

### Atualização coordenada

Após o usuário clicar em `Salvar custo`, a interface mostrará um modal breve de
processamento com a mensagem `Salvando custo e recalculando margens…`.

O modal permanece aberto até que o salvamento seja confirmado e as linhas da
tabela atualmente visíveis sejam reconciliadas. Todas as linhas visíveis que
representam o mesmo SKU recebem, na mesma atualização:

- o novo custo;
- a margem recalculada;
- a classificação/status de margem recalculado.

A tabela não deve mostrar números intermediários, animações de troca de valor
ou uma linha atualizada isoladamente. Filtros, período, paginação e posição de
rolagem atuais são preservados.

Se o salvamento ou a atualização falhar, o modal fecha e a tela preserva os
valores anteriores. Uma mensagem de erro clara é exibida sem marcar qualquer
linha como atualizada.

## Fluxo

```text
Linha sem custo → informar custo → Salvar custo
                                     │
                                     ▼
                       modal de processamento
                                     │
                                     ▼
                 serviço central de Custos por SKU
                    │                         │
                    ▼                         ▼
              grava histórico          recalcula margem
                    │                         │
                    └──────────┬──────────────┘
                               ▼
            troca atômica das linhas visíveis do SKU
```

## Fora de escopo

- Alterar preço, promoção, atacado ou publicação de anúncios no Mercado Livre.
- Atualizar linhas que não estejam presentes na tabela atual.
- Alterar regras financeiras, cálculo de comissão, impostos ou frete.
- Trocar a tela de Margem por uma nova tela de manutenção de custos.

## Verificação

Testes devem cobrir:

- SKU sem custo renderiza campo, histórico e botão de salvar;
- entrada inválida não chama a API de custo;
- a gravação chama a mesma operação usada por Custos por SKU;
- a operação respeita a conta ativa e cria histórico;
- o modal persiste durante a gravação e atualização;
- todas as linhas visíveis do mesmo SKU refletem custo, margem e status novos;
- linhas de SKUs distintos não mudam;
- falha de gravação ou recálculo mantém os valores previamente exibidos;
- filtros e contexto da tabela são preservados.
