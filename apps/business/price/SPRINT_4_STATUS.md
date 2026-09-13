# Sprint 4 — Cash

## Implementado

- Contas bancárias com saldo inicial e saldo corrente calculado.
- Contas a pagar e receber com competência, previsão e realização.
- Liquidações totais e parciais, com histórico e conta bancária.
- Parcelamento com preservação exata de centavos.
- Recorrências semanais, mensais e anuais, com materialização idempotente.
- Categorias financeiras, grupos de DRE e centros de custo.
- Despesas/receitas fixas e percentuais variáveis.
- Recebíveis versionados por marketplace e pedido externo.
- Caixa atual, comprometido, livre e total a receber.
- Projeções D+7, D+15, D+30, D+60 e D+90.
- Cenários conservador, base e expansão.
- DRE por competência separada do fluxo de caixa.
- Alertas de vencidos e cancelamento protegido para lançamentos liquidados.
- UX operacional para cadastros, lançamentos, liquidações, recebíveis e projeções.

## Banco

- Migration `005_cash_management.sql` aplicada no Neon pela conexão direta.
- RLS habilitado nas seis novas tabelas financeiras.

## Pendente de homologação

- Importar datas reais de liberação e recebimento dos marketplaces conectados.
- Conciliar saldos iniciais e extratos bancários de um tenant piloto.
- Validar plano de categorias e centros de custo com a contabilidade.
- Homologar os fatores dos cenários conservador e expansão.
