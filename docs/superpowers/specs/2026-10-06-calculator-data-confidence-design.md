# Calculadora ML: confiança dos dados e fluxo de frete

## Objetivo

Deixar explícito quais dados são usados na simulação, impedir valores de frete
inativos de influenciarem o resultado e orientar a pessoa quando os resultados
dependem de estimativas ou informações incompletas.

## Decisões aprovadas

- Frete é mutuamente exclusivo. Mercado Envios mostra somente a tarifa cobrada
  do vendedor; Pago pelo comprador mostra somente o valor pago pelo comprador.
  Ao trocar a modalidade, o campo ocultado é desabilitado, zerado e não segue
  no payload de cálculo.
- Custo de produto igual a zero não bloqueia a simulação. A tela mostra um
  alerta amarelo dizendo que lucro e margem podem estar superestimados; ROI
  continua indisponível enquanto não houver custo positivo.
- Anúncio carregado mostra o nome legível da categoria. O identificador da
  categoria aparece somente como informação secundária; tipo, categoria e
  tarifa oficiais ficam visualmente identificados como dados bloqueados do ML.
- A comissão, o frete e o custo exibem origem no detalhamento: Mercado Livre,
  Informado manualmente, Estimativa ou Não informado.
- Tarifa fixa igual a zero deve ser descrita como sem tarifa fixa aplicável,
  em vez de sugerir ausência acidental de informação.
- Quando houver margem desejada, o painel lateral evidencia preço atual, preço
  para atingir a meta e a diferença entre ambos.
- A tela preserva os tokens e a tipografia de Margem de venda nos temas claro e
  escuro; os novos alertas e etiquetas substituem cartões desnecessários.

## Estado e fluxo

1. A seleção de frete atualiza visibilidade, estado desabilitado e valores do
   formulário antes de agendar o recálculo.
2. O payload inclui somente o custo de frete aplicável à modalidade ativa.
3. A resposta do cálculo e os dados carregados do anúncio alimentam um modelo
   de origem por linha do detalhamento; o DOM usa texto, nunca HTML inserido.
4. Alterar dados manuais atualiza a origem correspondente e preserva a origem
   oficial quando o anúncio estiver carregado.
5. O alerta de custo aparece enquanto o custo não for positivo e some assim que
   a pessoa informar um custo válido.

## Cobertura de testes

- A modalidade de frete mantém exatamente um campo visível, habilitado e
  incluído no payload.
- Custo zero produz alerta de confiança e ROI indisponível; custo positivo
  remove o alerta e permite ROI.
- Anúncio carregado apresenta categoria legível e identifica os dados oficiais
  bloqueados.
- Detalhamento mostra origem e o texto de tarifa fixa correta nos estados de
  estimativa, manual e Mercado Livre.

## Fora de escopo

Não haverá escrita de preço no Mercado Livre, mudança de fórmulas financeiras
nem exigência de custo para executar uma simulação.
