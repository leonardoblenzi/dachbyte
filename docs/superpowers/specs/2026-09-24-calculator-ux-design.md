# Ajustes de interação da Calculadora ML

## Objetivo

Tornar a Calculadora uma simulação imediata e visualmente coerente com a tela
Margem de venda, sem mudar as fórmulas nem permitir qualquer escrita no ML.

## Decisões aprovadas

- No modo manual, Clássico e Premium são as únicas escolhas de comissão. Cada
  uma preenche automaticamente a comissão percentual; os campos de comissão
  ficam bloqueados e a tarifa fixa é opcional, inicialmente R$ 0.
- Ao carregar um anúncio, o tipo vindo do ML fica selecionado e bloqueado.
- Mercado Envios é a modalidade inicial de frete. Somente o campo da modalidade
  selecionada aparece e participa do cálculo.
- Alterações válidas recalculam automaticamente após um debounce curto. O botão
  de cálculo é removido e Limpar permanece.
- A página usa o mesmo `container`, tokens de cor, tipografia e superfícies da
  Margem de venda nos temas claro e escuro.

## Segurança e desempenho

O cálculo automático não altera preço ou estoque. Enquanto os dados mínimos não
estiverem preenchidos, a interface apenas mantém o estado de orientação. O
debounce evita chamadas consecutivas à API; uma nova mudança invalida a chamada
anterior antes de agendar outra.
