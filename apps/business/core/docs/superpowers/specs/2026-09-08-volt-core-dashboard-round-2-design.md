# Especificação — Dashboard Volt Core Round 2

## Ordem visual

1. Ações rápidas
2. KPIs principais
3. Precisa de atenção
4. Operação + Financeiro
5. Estoque
6. Vendas 7/30 dias

## Ações rápidas

Preservam os fluxos de uso diário e aparecem somente quando a tela correspondente está habilitada e permitida:

- Nova venda
- Novo cliente
- Receber produtos
- Receber
- Pedidos/operação da extensão, quando houver widget operacional
- Abrir caixa / Ver caixa

## KPIs

Máximo funcional de cinco indicadores, condicionado aos módulos/permissões:

- Vendas hoje
- Recebido hoje
- A receber
- Vencido
- Caixa

## Precisa de atenção

Máximo de cinco linhas, ordenadas por prioridade. Não exibe listas longas de entidades.

Prioridade atual:

1. recebíveis vencidos;
2. despesas vencidas;
3. pedidos atrasados da extensão;
4. pedidos prontos aguardando retirada;
5. estoque crítico.

## Widget óptico

O widget `Pedidos` é contribuição da extensão Ótica e não do Core. Contém quatro linhas clicáveis:

- Em produção
- Prontos para retirada
- Atrasados
- Concluídos hoje

Cada linha abre Pedidos já filtrado. `Concluídos hoje` usa a data real de entrega/conclusão e não a data original da venda.

## Financeiro

Resumo compacto:

- Vence hoje
- Próximos 7 dias
- Vencido
- Recebido hoje

A navegação usa `Pagamentos > Pendentes` quando essa tela está disponível e cai para `Recebíveis > Agenda` quando necessário.

## Estoque

Resumo compacto:

- Físico
- Reservado
- Disponível
- Críticos

A reserva é o conceito criado na Rodada 1 e não é somada como baixa física.

## Vendas

Gráfico simples no final da página, com 7 ou 30 dias. Mostra:

- faturamento;
- número de vendas;
- ticket médio.

Cada barra abre a tela de Pedidos/Vendas no dia correspondente.
