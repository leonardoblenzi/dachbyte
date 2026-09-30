# Sistema visual canônico do Seller Magalu

## Objetivo

Consolidar todas as telas do Seller Magalu sob o padrão visual da tela **Margem de venda**. O Mercado Livre é referência de experiência e densidade operacional, mas nenhum código, endpoint, runtime ou regra de negócio do módulo ML será reutilizado.

## Escopo

Aplicar o padrão a Painel, Catálogo, Pedidos, Gestão de catálogo, Preços, Estoque, Promoções, Custos por SKU, Margem de venda, Calculadora, Contas, Usuários, Plano, Ajuda e Integrações.

Não fazem parte do escopo: mudança de schema, migrations, OAuth, permissões do Hub, workers, filas, endpoints de escrita ou contratos de integração Magalu.

## Componentes canônicos

### Hero de página

Toda rota principal terá um hero de página baseado na estrutura da Margem: kicker, título, descrição curta e ações/metadados à direita. Painel mantém sua hierarquia de visão geral, mas usa as mesmas medidas, borda, raio, fundo e espaçamentos do hero.

### Cartão de filtros

Consultas terão um único padrão `filter-card`: labels em caixa alta, controles de 42px, grade responsiva, `gap` de 12px e ações secundária/primária. A ordem de campos respeita o fluxo de cada tela; filtros inexistentes não serão inventados.

### Superfícies, KPIs e tabs

Cards, tabelas, KPIs e blocos de decisão usarão os mesmos tokens de borda, raio, sombra, padding e tipografia. Tabs internas terão a mesma aparência e comportamento da Margem. A densidade de tabelas será preservada para não reduzir informação operacional.

### Estados e diálogos

Carregamento, vazio, erro e indisponibilidade de escopo serão apresentados de forma consistente por rota. Todo modal adotará o mesmo container, backdrop, limite de altura, rolagem e botão de fechamento. O conteúdo específico de cada operação não muda.

### Responsividade e tema

O canvas continua ocupando a largura útil do shell, como no ML. Abaixo dos breakpoints atuais, grades empilham sem esconder dados essenciais. O tema segue exclusivamente a escolha do usuário no Seller; nenhuma feature dependerá de `prefers-color-scheme`.

## Estratégia de migração

1. Criar estilos-base do Magalu para hero, filtros, superfícies, tabs, estado e modal.
2. Migrar primeiro Catálogo, Conta, Integrações e Calculadora, pois ainda usam mais variações próprias.
3. Migrar Painel, Pedidos, Gestão de catálogo, Preços, Estoque e Promoções, preservando suas jornadas existentes.
4. Harmonizar Precificação sem alterar os cálculos ou a transparência sobre taxas não disponíveis.
5. Validar desktop, sidebar recolhida, mobile, tema claro/escuro e estados carregando/vazio/erro.

## Limites de segurança

Esta consolidação é somente de apresentação. Os fluxos de preço, estoque, expedição, catálogo massivo e demais writes continuam exigindo preview, confirmação, validação do Hub e reconciliação atuais. Nenhuma capacidade de Promoções será adicionada enquanto a Open API Magalu não suportar publicamente a operação.

## Critérios de aceite

- Todas as rotas principais usam o hero canônico ou sua variante documentada de Painel.
- Todas as consultas usam o `filter-card` ou justificam a ausência de filtros.
- Nenhuma tela cria shell, sidebar ou topbar paralelos.
- Todos os modais respeitam o padrão compartilhado e funcionam em viewport pequeno.
- Não há regressão em APIs, OAuth, permissão, worker, fila ou fluxo de escrita.
- A suíte do Seller Magalu passa integralmente.
