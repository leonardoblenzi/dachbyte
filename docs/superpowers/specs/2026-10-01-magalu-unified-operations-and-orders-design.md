# Operações e Pedidos Magalu — desenho de consolidação

## Objetivo

Dar às operações do Seller Magalu um fluxo único e previsível, usando Gestão de catálogo como referência funcional, e tornar Pedidos útil mesmo quando a conta ainda não tem dados sincronizados ou scopes completos.

## Escopo

As três operações de escrita seguem a mesma sequência:

1. **Selecionar SKUs** — origem por catálogo, SKU único ou lista; filtros; tabela; seleção por página ou recorte permitido; resumo fixo da seleção.
2. **Configurar alteração** — ação própria do domínio apenas para os SKUs selecionados.
3. **Revisar e confirmar** — preview, confirmação explícita, fila e reconciliação já existentes.

| Rota | Configuração específica |
| --- | --- |
| `/magalu/gestao-skus` | Ativar ou desativar SKUs |
| `/magalu/precos` | Definir preço e preço de lista |
| `/magalu/estoque` → Atualizar estoque | Definir quantidade absoluta |

O limite seguro do lote permanece visível e é respeitado antes de criar um preview. A interface não oferece “todos os resultados” quando a operação de preço ou estoque não puder carregá-los no limite configurado.

## Arquitetura de interface

Será criado um kit interno de operações do Magalu, sem importar runtime, rotas, estilos ou serviços do Seller ML. Ele terá um contrato de seleção comum e adaptadores pequenos por recurso:

- seleção: `filters`, `single` e `list`;
- estado: conta ativa, filtros, SKUs resolvidos, seleção explícita, seleção por recorte e limite de lote;
- renderização: cards de origem, card de filtro, tabela de seleção, barra sticky de resumo e estados vazios/carregamento/erro;
- adaptadores: catálogo monta `activate/deactivate`; preço monta campos de preço; estoque monta campo de quantidade.

O backend e o motor seguro não mudam: preview, confirmação, validação Hub `WRITE magalu`, fila, estado `dispatching` e reconciliação continuam sendo a única via de escrita.

## Pedidos

Pedidos continua read-first e mantém recursos já implementados: sincronização, filtros, lista, detalhe, entregas, reconciliação e histórico.

O conteúdo será reorganizado em três estados claros:

- **Pronto para operar:** KPIs, filtros e tabela quando houver dados sincronizados.
- **Conexão incompleta:** explica exatamente quais scopes faltam e oferece reconexão OAuth; não mostra números zerados como indicadores de negócio.
- **Sem dados ainda:** mostra o intervalo que será importado, a última execução e um CTA de sincronização, sem tabelas técnicas vazias como conteúdo principal.

Histórico de sincronização e operações de entrega passam a ser secundários e recolhíveis. Escritas de entrega existentes permanecem protegidas e aparecem somente no detalhe elegível, com feature flag e scopes autorizados.

## Fora de escopo

- Nenhuma migration, nova fila ou novo endpoint remoto Magalu.
- Nenhuma mudança de OAuth, permissões Hub, limites, preview ou confirmação de escrita.
- Nenhuma importação de código do Seller ML.

## Testes de aceitação

- Cada operação expõe as três origens e o mesmo resumo de seleção.
- Trocar origem limpa apenas a seleção local da operação e não altera outra rota.
- Preço e estoque não permitem preview sem SKUs selecionados e alterações válidas.
- Limites de lote aparecem antes do preview.
- Pedidos distingue dados indisponíveis, ausência de pedidos e escopos ausentes.
- Fluxos reais de Pedidos continuam apontando para os endpoints atuais.
