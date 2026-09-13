# DACHBYTE — identidade aplicada

Os oito JPGs em `public/brand/dachbyte` são os originais fornecidos pelo proprietário.
Seller usa ciano/azul e laranja; Business usa ciano/azul e verde. Os arquivos não
foram redesenhados ou modificados. Após revisão do proprietário, as assinaturas
dos cabeçalhos usam texto real sem fundo, com as cores da referência (não são uma
reprodução exata da fonte do JPG). Os símbolos em uso apontam para
`seller/mark-transparent.png` e `business/mark-transparent.png`, com alpha real.
Os JPGs originais permanecem intactos como referência; não devem voltar aos menus.

Os recortes foram produzidos com a ferramenta integrada de edição de imagens
(skill imagegen), a partir dos dois desenhos planos originais. Prompt utilizado:
"Remove ONLY the white background, including the white holes inside the three
circular circuit terminals and all white negative space. Preserve the exact
geometry, strokes, navy filled shapes, gradient colors, proportions and
orientation. No redesign, no text, no added outline, no shadows, no checkerboard
painted into image. Deliver a PNG with genuine transparent alpha background,
tightly framed around the symbol with a small safe margin."
Validação: canal alpha inspecionado e comparação no navegador sobre fundos claro
e escuro em `/brand/dachbyte/preview.html`. Os favicons SVG Seller também não têm
retângulo de fundo. O CSS usa um contorno luminoso discreto para legibilidade.

## Integração

- `src/tokens.css`: tokens canônicos. O snapshot público deve ser idêntico.
- `public/brand/dachbyte/theme.css`: adaptadores dos módulos e assinatura visual.
- `screens.json`: inventário das 74 entradas HTML; inclui autenticação, landings,
  administração e páginas operacionais. As rotas React herdam a identidade da
  entrada; Stock/Next a recebe pelo layout raiz.
- `node --test tests/dachbyte-visual-contract.test.js`: verifica o inventário,
  tokens, arquivos de imagem e hooks de acessibilidade.

O tema preserva layout, IDs, eventos, rotas, permissões, cores semânticas e
alternância claro/escuro. Não substitui estilos de gráficos ou marcas dos canais.
Protótipos, HTML temporário, manuais exportados e builds gerados não são entradas
de aplicação e não devem ser editados como código-fonte.

## Execução

No ambiente integrado, `/brand` é servido pelo gateway. Os hosts independentes
Express Seller e Business também expõem os arquivos. O Core local expõe os
arquivos e seu Vite encaminha `/brand/dachbyte` ao backend local.
Outros frontends isolados precisam do gateway/reverse proxy para `/brand`.
Não é necessário alterar domínios, credenciais ou URLs de integrações.

## Verificação ainda necessária no staging

Validar telas autenticadas com dados reais, estados vazios/erro, tabelas extensas,
modais, menus recolhidos e telas móveis. Executar os builds de Stock, Chat e
Tracking no ambiente que possui suas dependências. Os testes de contrato não
substituem a revisão visual de cada fluxo. A prévia estática não testa APIs.
