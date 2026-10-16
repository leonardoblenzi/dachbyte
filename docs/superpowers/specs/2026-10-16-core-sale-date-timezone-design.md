# DACHBYTE Core: data operacional da venda

## Objetivo

Registrar a data/hora comercial de uma venda no fuso configurado para a empresa, impedir datas futuras e manter a mesma regra na criacao e na edicao.

## Comportamento

- Ao abrir uma nova venda, a interface preenche `soldAt` com a data/hora corrente no fuso da empresa.
- A pessoa pode corrigir a data para um instante passado ou para o presente; um instante futuro e recusado.
- Se um cliente sem JavaScript enviar `soldAt` vazio, o backend usa o instante atual como fallback.
- O backend e a fonte final de verdade: valida uma data explicita contra o instante atual no fuso/tempo real e devolve erro `SALE_DATE_IN_FUTURE` (HTTP 400) quando necessario.
- A regra vale para criacao e edicao. A conclusao de entrega continua sem alterar `sold_at`.

## Arquitetura

1. A configuracao carregada da empresa passa a incluir `timezone`.
2. Um helper de vendas resolve e valida `soldAt`: converte o valor informado em instante valido, aplica fallback para agora e rejeita qualquer instante posterior ao agora de referencia.
3. `createSale` e `updateSale` usam esse helper antes de gravar vendas, movimentos de caixa e recebiveis.
4. Os formularios geral e de otica recebem o valor inicial e o limite `max` calculados no fuso da empresa. A validacao visual melhora a UX, mas nao substitui o backend.
5. O dashboard converte `sold_at` e `operational_at` para o fuso da empresa antes de comparar com “hoje” e antes de formar a serie de 30 dias.
6. Os testes cobrem fallback automatico, rejeicao de data futura e aceitacao de data passada/presente, incluindo a regra no fluxo de edicao e as consultas do dashboard por fuso.

## Fora de escopo

- Alterar registros historicos, inclusive a venda de R$ 100,00 da Otica Nacional Sabáudia.
- Mudar as regras de data de entrega, vencimento ou fechamento de caixa.
- Mudar filtros e relatorios fora dos indicadores de “hoje” e da serie de vendas do dashboard.

## Critérios de aceite

- Uma venda sem data recebe data/hora atual ao ser aberta e continua protegida se for enviada sem o campo.
- Uma tentativa de criar ou editar venda para o futuro falha com mensagem clara.
- Uma venda passada ou do momento atual continua permitida.
- Nenhuma venda de entrega passa a ter seu `sold_at` alterado na retirada.
