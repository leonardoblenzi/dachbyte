# Tela pública de confirmação OAuth — Design

## Objetivo

Transformar a confirmação pública de vínculo de Mercado Livre ou Shopee em uma tela reconhecível do VoltPrice, clara para quem está em outro navegador e segura para um link temporário.

## Direção visual aprovada

- Fundo claro com luz violeta sutil e card branco centralizado.
- Marca VoltPrice no topo e um motivo de conexão em violeta.
- Texto curto que identifica o canal e a empresa, seguido de uma ação única para continuar no provedor.
- Tipografia de sistema, contraste alto, espaçamentos generosos e comportamento responsivo.

## Segurança e comportamento

O token opaco continua apenas na URL e no `action` do formulário, devidamente escapado. A tela não inclui scripts externos, não altera o fluxo POST de continuação e reutiliza o mesmo layout para sucesso e indisponibilidade do link.

