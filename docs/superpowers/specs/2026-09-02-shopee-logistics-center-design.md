# Central Logistica Shopee: configuracao guiada de canais

## Contexto

A Central Logistica atual separa SPX e Logistica do vendedor em tabelas extensas, usa a planilha como um fluxo paralelo e trata algumas combinacoes validas como conflito. A interface tambem nao comunica bem selecao e disponibilidade no tema claro.

O novo fluxo deve permitir que o usuario escolha a configuracao logistica desejada sem conhecer detalhes internos da Shopee, impedindo combinacoes invalidas antes do envio. A disponibilidade real retornada pela Shopee para a loja e para cada anuncio continua sendo a fonte de verdade.

## Objetivos

- Criar uma configuracao guiada e previsivel para SPX, Expresso Aereo, Entrega de Item Grande/Pesado e Logistica do vendedor.
- Criar uma aba operacional dedicada a Entrega de Item Grande/Pesado.
- Exibir disponibilidade, estado atual e motivo de bloqueio por anuncio.
- Aplicar as mesmas regras na interface, no backend e na planilha.
- Tornar selecao, foco, estado ativo e indisponibilidade legiveis nos temas claro e escuro.
- Preservar endpoints e planilhas existentes quando forem compativeis com as novas regras.

## Fora de escopo

- Solicitar habilitacao de um canal que a Shopee ainda nao liberou para a loja.
- Criar ou simular canais ausentes na resposta oficial da Shopee.
- Alterar medidas, peso ou elegibilidade fisica dos anuncios durante a aplicacao logistica.
- Alterar regras comerciais da Shopee fora das combinacoes definidas neste documento.

## Regras de compatibilidade

Os tipos internos serao `seller`, `spx`, `heavy` e `pickup`.

Estados permitidos:

- Logistica do vendedor isolada.
- SPX ou Expresso Aereo com Logistica do vendedor.
- Entrega de Item Grande/Pesado com Logistica do vendedor.
- Retire perto de voce somente quando estiver disponivel e fizer parte da configuracao selecionada.

Estados bloqueados:

- SPX ou Expresso Aereo com Entrega de Item Grande/Pesado.
- SPX, Expresso Aereo ou Grande/Pesado sem Logistica do vendedor.
- Qualquer canal ausente na configuracao oficial da loja ou do anuncio.

Expresso Aereo, `logistics_channel_id: 91006`, permanece classificado como SPX e segue as mesmas regras do Shopee Xpress. Entrega de Item Grande/Pesado sera classificada separadamente por nome normalizado e pelos identificadores oficiais que forem observados na resposta da Shopee. Nenhum ID desconhecido sera inventado.

Ao selecionar SPX ou Grande/Pesado sem selecionar Logistica do vendedor, a interface abre o modal padrao da plataforma perguntando se o usuario deseja habilitar o canal do vendedor junto. A confirmacao adiciona `seller` ao estado alvo. A recusa cancela a aplicacao. Se `seller` nao estiver disponivel para todos os anuncios selecionados, os anuncios afetados ficam bloqueados e o motivo aparece antes da confirmacao.

Selecionar SPX quando Grande/Pesado estiver marcado, ou o inverso, remove a escolha conflitante e exibe uma mensagem curta explicando a troca. O backend repete a validacao e nunca depende apenas do comportamento visual.

## Arquitetura da interface

A navegacao da Central Logistica tera quatro abas:

1. `Configurar logistica`: fluxo principal para buscar, selecionar e aplicar uma configuracao alvo.
2. `Grande/Pesado`: visao dedicada dos anuncios habilitados, disponiveis e indisponiveis para esse canal.
3. `Logistica do vendedor`: gestao direta do canal e dos anuncios que dependem dele.
4. `Planilha`: modelo, importacao, validacao e processamento em massa.

SPX e Expresso Aereo permanecem visiveis no configurador principal como uma unica familia operacional. A aba Grande/Pesado atende a necessidade de operacao especifica sem duplicar toda a tela.

### Configurador principal

O topo da tela apresenta tres seletores de canal com estado visual persistente:

- `SPX / Expresso Aereo`.
- `Grande/Pesado`.
- `Logistica do vendedor`.

Cada seletor informa `Disponivel`, `Parcialmente disponivel`, `Ativo` ou `Indisponivel`. Abaixo deles, um resumo textual mostra a configuracao que sera aplicada. Seletores usam `aria-pressed`, foco visivel e icone de confirmacao; o estado nao depende apenas de cor.

A busca aceita nome, um ID ou varios IDs separados por virgula. A tabela unica possui:

- selecao;
- ID e nome do anuncio;
- configuracao atual;
- disponibilidade dos tres grupos de canal;
- elegibilidade fisica para SPX;
- estado da alteracao proposta;
- motivo quando bloqueado.

Os filtros rapidos sao `Todos`, `Prontos para aplicar`, `Ja configurados` e `Com impedimento`. A barra de acao fixa informa quantidade selecionada, quantidade aplicavel e quantidade bloqueada. O botao `Revisar e aplicar` abre o modal padrao com a configuracao alvo e o impacto por grupo.

### Aba Grande/Pesado

A aba apresenta contadores de habilitados, disponiveis e indisponiveis. O canal so pode ser ativado quando estiver presente na resposta logistica oficial do anuncio e a Logistica do vendedor tambem estiver disponivel.

Acoes em massa:

- habilitar Grande/Pesado e Logistica do vendedor;
- desabilitar Grande/Pesado, mantendo Logistica do vendedor;
- substituir SPX por Grande/Pesado e manter Logistica do vendedor, mediante confirmacao explicita.

### Tema claro

No tema claro, seletores ativos e checkboxes terao fundo, borda e icone de confirmacao com contraste AA. Linhas selecionadas terao realce de fundo e marcador lateral. Estados desabilitados terao texto legivel e continuarao distinguiveis de estados nao selecionados. As mesmas informacoes permanecem visiveis sem depender de hover.

## Modelo de dados e classificacao

`productLogistics` passara a reconhecer `heavy` sem misturar esse canal com `intelipost`/`seller`. A analise retornara:

- `heavyChannels`;
- `heavyChannel`;
- `heavyEnabled`;
- `sellerEnabled`;
- `availableKinds`;
- `enabledKinds`.

Os objetos brutos retornados pela Shopee continuam preservados para o payload de atualizacao. A classificacao usa o ID oficial quando conhecido e nomes normalizados como `Entrega de Item Grande/Pesado`, `Item Grande/Pesado`, `Large and Bulky` e variacoes equivalentes presentes na resposta oficial.

A listagem da Central Logistica consulta os dados ao vivo como ja ocorre hoje. O resumo por produto inclui disponibilidade e estado dos grupos `spx`, `heavy`, `seller` e `pickup`. A tela nunca considera um canal aplicavel apenas porque outro produto da loja possui esse canal.

## Backend e aplicacao

Uma funcao central de politica valida e normaliza o estado alvo antes de qualquer chamada externa. Ela sera usada pelo configurador, pelos endpoints legados e pela planilha.

Novo endpoint principal:

`POST /shops/active/logistics/configure`

Payload:

```json
{
  "itemIds": ["123", "456"],
  "targetKinds": ["seller", "spx"]
}
```

O endpoint:

1. normaliza IDs e tipos;
2. carrega produtos ativos e informacoes logisticas ao vivo;
3. valida disponibilidade por anuncio;
4. rejeita SPX com Grande/Pesado;
5. exige `seller` para SPX ou Grande/Pesado;
6. preserva canais fora do conjunto gerenciado;
7. envia a configuracao oficial para a Shopee;
8. atualiza o cache local somente apos sucesso;
9. retorna resultado individual por anuncio.

Os endpoints atuais de SPX e seller permanecem disponiveis. Internamente, eles passam pela mesma politica para evitar comportamento divergente. A regra antiga que desativava ou rejeitava `SPX + seller` sera removida.

O processamento em massa continua usando a infraestrutura de fila e o painel de progresso existentes. Falhas parciais nao desfazem sucessos anteriores e aparecem no log por produto.

## Planilha

O formato atual de duas colunas permanece valido:

- `ID do anuncio`.
- `Tipo de Logistica`.

O parser passa a aceitar `Entrega de Item Grande/Pesado`, `Grande/Pesado`, `heavy` e as variacoes normalizadas documentadas. O modelo inclui apenas exemplos validos:

- `Logistica do vendedor`.
- `Shopee Xpress, Logistica do vendedor`.
- `Expresso Aereo, Logistica do vendedor`.
- `Entrega de Item Grande/Pesado, Logistica do vendedor`.

A pre-validacao no navegador bloqueia SPX com Grande/Pesado e qualquer configuracao de SPX ou Grande/Pesado sem seller. O backend repete essas regras e verifica a disponibilidade real de cada anuncio. A pre-visualizacao exibe `Valido`, `Configuracao invalida` ou `Canal indisponivel`, com a mensagem correspondente.

A exportacao operacional da Central Logistica inclui:

- estado atual de SPX/Expresso Aereo;
- estado atual de Grande/Pesado;
- estado atual de Logistica do vendedor;
- disponibilidade de cada grupo;
- medidas e pesos usados para elegibilidade SPX;
- configuracao recomendada ou impedimento.

## Erros e mensagens

Mensagens devem explicar a acao necessaria:

- `Grande/Pesado nao esta disponivel para este anuncio na Shopee.`
- `Logistica do vendedor precisa estar disponivel e selecionada para usar SPX.`
- `SPX/Expresso Aereo nao pode ser combinado com Grande/Pesado.`
- `A Shopee nao retornou canais logisticos para este anuncio. Atualize os dados e tente novamente.`

Confirmacoes usam o modal da plataforma. Nao serao usados `window.confirm` ou dialogos genericos do navegador nos novos fluxos.

## Testes e verificacao

Testes automatizados cobrem:

- classificacao de SPX 91003 e Expresso Aereo 91006;
- classificacao separada de Grande/Pesado;
- estados permitidos e bloqueados;
- exigencia e disponibilidade de seller;
- preservacao de canais nao gerenciados;
- parser e validacao da planilha;
- respostas parciais por anuncio;
- compatibilidade dos endpoints legados.

A verificacao visual usa Playwright em desktop e mobile, nos temas claro e escuro, cobrindo selecao, modal, estado indisponivel, tabela, abas, planilha e painel de progresso. Nenhum processo real sera executado durante a verificacao visual; chamadas de escrita serao interceptadas ou substituidas por respostas controladas.

## Implantacao

Nao ha migration de banco prevista. A entrega pode ser publicada como alteracao de backend e arquivos estaticos. O rollout preserva rotas antigas e adiciona a nova rota, permitindo reversao sem alterar dados persistidos.
