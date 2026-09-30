# Magalu: calculadora e padronização visual

## Objetivo

Levar as telas principais do Seller Magalu ao mesmo nível de clareza visual da tela de Margem de venda, preservando a identidade Magalu e os fluxos próprios do módulo. Reconstruir a Calculadora para seguir a jornada já consolidada no Seller Mercado Livre, sem importar runtime, componentes, serviços ou regras do ML.

## Escopo

### Padrão visual transversal

As rotas principais terão uma moldura consistente:

- hero de página com kicker, título, explicação e ações contextuais;
- card de filtros com labels, controles de 42px e espaçamento de 12px;
- superfícies com borda, raio, sombra e padding compatíveis com a Margem;
- responsividade e tema claro/escuro por tokens `--mg-*`;
- fluxos de escrita preservados em etapas, precedidos pelo hero comum.

O trabalho abrange Catálogo, Gestão de catálogo, Preços, Estoque, Pedidos, Conta, Integrações e Calculadora. Estruturas que já são intencionalmente operacionais, como as etapas de atualização protegida, não serão substituídas por tabelas ou formulários genéricos.

### Calculadora Magalu

A Calculadora terá dois modos explícitos:

1. **Usar SKU sincronizado**: a pessoa busca e escolhe um SKU do espelho local da conta selecionada. Preço atual e custos cadastrados são pré-preenchidos, mas continuam editáveis exclusivamente na simulação.
2. **Simulação manual**: a pessoa informa todos os valores sem depender de SKU sincronizado.

A jornada visual será:

```text
Hero seguro
  -> modo da simulação
  -> 1. SKU sincronizado ou entrada manual
  -> 2. preço, custo, taxas, frete e impostos
  -> margem alvo
  -> resultado fixo no desktop
```

O resultado exibe lucro por unidade, margem, ROI, ponto de equilíbrio, preço para a meta e detalhamento dos custos. O card de resultado fica sticky somente em desktop; em telas menores ele retorna ao fluxo normal depois do formulário.

## Dados e segurança

- A escolha de SKU usa apenas o espelho local e os dados financeiros locais da conta ativa.
- Não há publicação de preço, estoque ou alterações em SKU.
- Não há consulta adicional de escrita à API Magalu.
- Os cálculos existentes e seus campos continuam sendo a fonte de verdade; a alteração reorganiza os controles e adiciona pré-preenchimento local.
- Se preço ou custo não estiverem disponíveis, o formulário mostra o dado ausente e mantém a edição manual disponível.

## Componentes e responsabilidades

| Componente | Responsabilidade |
| --- | --- |
| `mg-page-hero` | Moldura reutilizável de contexto e ações da página. |
| `mg-filter-card` | Grid de filtros com tamanho, labels e responsividade comuns. |
| Calculadora Magalu | Orquestra modo, escolha de SKU, campos da simulação e resultado visual. |
| Catálogo/financeiro local | Fornece SKU, preço e custo da conta ativa apenas para pré-preencher. |
| Motor atual da calculadora | Mantém o cálculo de lucro, margem, ROI e preço-alvo. |

## Estados e erros

- **Sem SKU sincronizado:** o modo de SKU exibe um estado vazio direcionando para sincronização ou para a simulação manual.
- **SKU sem custo ou preço:** os campos permanecem em branco/zero de forma explícita, com aviso contextual; a pessoa pode preenchê-los.
- **Busca sem resultado:** lista vazia com texto objetivo e sem apagar valores já digitados.
- **Carregamento:** a interface preserva o último resultado válido enquanto os dados locais são consultados.
- **Tema e tela pequena:** nenhuma informação de resultado some; o painel apenas deixa de ser sticky.

## Verificação

- testes de contrato devem provar que as duas opções de modo existem, que o modo SKU usa somente leitura local e que não há endpoint de escrita;
- testes de estrutura devem garantir hero/filtro compartilhados nas rotas definidas;
- validação de sintaxe JS e da suíte do Seller Magalu;
- inspeção visual em desktop e mobile, claro e escuro;
- `git diff --check` antes de integrar.

## Fora do escopo

- criação de produto, alteração de preço ou estoque a partir da Calculadora;
- regras inventadas de comissão, tarifa ou frete Magalu;
- reutilização de código de runtime, CSS ou APIs do Seller ML;
- mudanças em OAuth, Hub, worker, fila ou migrations, salvo se uma leitura local já existente não puder atender o pré-preenchimento.
