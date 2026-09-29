# Magalu: paridade de UX com Mercado Livre

## Objetivo

Fazer com que uma pessoa que já utiliza o DACHBYTE Mercado Livre reconheça a estrutura, as etapas e os estados de operação do Seller Magalu, sem copiar componentes, código ou regras específicas do Mercado Livre.

## Escopo

O trabalho será entregue em três incrementos independentes e publicáveis:

1. Painel Magalu com a hierarquia informacional do Painel Mercado Livre.
2. Fluxo operacional unificado para Gestão de catálogo, Preços e Estoque.
3. Precificação Magalu com a estrutura de Custos por SKU, Margem de venda e Calculadora do Mercado Livre.

O módulo mantém sua identidade visual azul/cyan Magalu. Paridade significa a mesma linguagem de navegação, densidade, sequência de decisão e feedback; não significa copiar CSS ou JavaScript do módulo Mercado Livre.

## Incremento 1: Painel Magalu

O painel passa a seguir esta ordem:

1. Cabeçalho com conta ativa, período, atualização e ação de atualizar.
2. KPIs principais: faturamento, pedidos, margem estimada e indicador comercial disponível.
3. KPIs complementares: ticket médio, estoque em risco, entregas em risco e Ads Magalu.
4. Prioridades acionáveis, derivadas apenas de dados locais sincronizados.
5. Blocos de Comercial, Resultado e Operação com links para a página que resolve cada problema.

O seletor de período usa os dados que o read model já possui. Quando não houver histórico suficiente, a interface declara a limitação em vez de mostrar comparativos artificiais.

Ads Magalu permanece um cartão de integração pendente até existir uma fonte oficial autorizada. Não haverá ROAS, investimento ou vendas estimados.

A margem exibida é uma estimativa calculada apenas para SKUs com custo cadastrado e dados necessários. O painel explicará a cobertura dos dados e oferecerá o atalho para completar custos; não tratará estimativa como conciliação financeira oficial.

Dados de OAuth, tokens, scopes, webhooks e diagnóstico saem da área principal e permanecem em Conta > Integrações.

## Incremento 2: Operações de catálogo, preço e estoque

As três páginas compartilham o mesmo modelo mental:

1. **Seleção:** filtros, SKU único ou lista colada. A lista aceita uma entrada por linha, vírgula ou ponto-e-vírgula; duplicados são removidos e inválidos aparecem no resumo.
2. **Ação:** a ação disponível para aquele recurso é escolhida após a seleção. Catálogo inicia com ativar/desativar; preço solicita preço e preço de lista; estoque solicita quantidade absoluta.
3. **Revisão:** o preview mostra elegíveis, inválidos, sem mudança, estado antes/depois e expiração.
4. **Confirmação:** uma confirmação explícita enfileira a operação.
5. **Acompanhamento:** um histórico comum mostra lote/operação, estado, erros seguros e somente a ação de reverificar quando o estado remoto é incerto.

O backend existente continua sendo a autoridade: Hub WRITE obrigatório imediatamente antes do dispatch, GET remoto antes da escrita, proteção contra estado obsoleto, `dispatching` persistido e reconciliação sem repetir escrita incerta.

Não haverá novas escritas remotas além das já suportadas. A UI deve refletir `MAGALU_SKU_WRITE_ENABLED` e os scopes reais de cada recurso.

## Incremento 3: Precificação

O grupo de navegação passa a se chamar **Precificação**, como no Mercado Livre. Ele mantém as páginas:

- Custos por SKU;
- Margem de venda;
- Calculadora.

Custos por SKU ganha filtros, busca, cobertura, estados vazios úteis e operações de edição que preservam o custo unitário já armazenado. Importação, exportação e timeline serão adicionadas somente quando houver contrato de backend e migração explicitamente definidos; não fazem parte desta mudança para não introduzir uma promessa visual sem suporte operacional.

Margem de venda ganha contexto de cobertura, filtros e estados explícitos de dado ausente. Seus cálculos continuam baseados em custos e taxas informados pelo usuário.

A Calculadora ganha uma sequência guiada: venda e produto, taxas e entrega, impostos e despesas, meta e resultado. Ela permanece um simulador local e não atualiza preços no Magalu.

Não serão inventadas comissão, subsídio de frete, imposto, taxa de plataforma ou conciliação financeira. Esses campos continuarão explícitos e preenchidos pelo operador enquanto Financial Analysis não estiver disponível.

## Navegação e consistência

O menu terá vocabulário e ordem próximos ao Meli quando houver equivalência:

- Visão geral;
- Produtos;
- Pedidos;
- Operações;
- Precificação;
- Conta.

Rotas declaradas no cliente precisam ter tela e item de navegação correspondente, ou ser removidas da tabela de rotas. Isso evita páginas em branco para Usuários, Plano e Ajuda.

O carregamento global já existente continua cobrindo requisições de tela. A implementação deve manter o contador de requisições concorrentes para que o overlay não desapareça enquanto outra consulta da página ainda estiver pendente.

## Erros, vazio e acesso

Toda tela deve diferenciar:

- nenhuma conta conectada;
- dados ainda não sincronizados;
- scope ausente;
- escrita desligada pelo ambiente;
- falha de API;
- ausência real de dados.

Mensagens devem explicar o próximo passo e apontar para Contas ou Integrações quando a causa for OAuth/scopes.

## Testes e aceite

Testes de contrato devem verificar:

- os grupos e rotas canônicos;
- o painel sem métricas de Ads inventadas;
- cards de prioridade com rota de destino válida;
- os três modos de seleção em catálogo, preço e estoque;
- preview e confirmação preservados para toda escrita;
- ausência de escrita remota na calculadora;
- ausência de rotas declaradas sem página;
- carregamento global incluído antes dos scripts de tela.

O aceite visual será feito em sessão autenticada comparando Painel, Gestão de anúncios/Gestão de catálogo, Preços/Estoque e Precificação dos dois módulos em desktop e mobile.

