# DACHBYTE Seller — landing provisória Magalu

## Objetivo

Disponibilizar uma presença pública coerente para o futuro módulo Magalu antes da integração OAuth estar pronta. A página precisa comunicar o escopo inicial sem prometer uma conexão ativa e fornecer URLs legais estáveis para o cadastro do client no ID Magalu.

## Rotas públicas

- Landing comercial: `/seller/magalu`.
- Termos específicos da integração: `/seller/magalu/termos`.
- Privacidade específica da integração: `/seller/magalu/privacidade`.
- Callback técnico reservado: `/magalu/auth/callback`.

O callback não será uma página comercial. Na primeira entrega ele deve responder de forma controlada, sem processar OAuth até o módulo e as credenciais existirem.

## Experiência e conteúdo

A landing reutiliza o sistema visual atual de DACHBYTE Seller: cabeçalho, tipografia, superfícies, fundo e linguagem. O conteúdo será intencionalmente compacto:

1. Hero com a proposta de gestão de catálogo, preço e estoque para Magalu.
2. Três capacidades: catálogo organizado, preços acompanhados e estoque sincronizado.
3. Bloco de confiança que deixa explícito que a futura integração usa autorização oficial do seller e só acessa dados consentidos.
4. CTA de interesse sem iniciar OAuth e sem indicar que o produto já está disponível.
5. Rodapé com termos e privacidade específicos do Magalu, além dos links globais já existentes.

## Navegação Seller

O item Magalu será acrescentado ao cabeçalho de todas as landings Seller e apontará para `/seller/magalu`. Enquanto o módulo não existir, o rótulo deve indicar que está em breve e não deve ser apresentado como acesso autenticado.

## Páginas legais

As páginas Magalu complementam, e não substituem, os termos e a política gerais da DACHBYTE. Elas devem explicar o tratamento específico da integração: dados de catálogo, preço e estoque; tokens OAuth; sincronizações; webhooks; revogação pelo seller; e canal de contato. Precisam ser acessíveis sem login e sem depender do módulo Magalu em execução.

## Limites desta entrega

Não criar schema, containers, client OAuth, armazenamento de token, webhook, Hub ou card autenticado na seleção de plataforma. Estes itens pertencem à fundação do `seller-magalu` após o client ser criado.

## Verificação

- As quatro rotas respondem por trás do Gateway/Caddy.
- Todas as landings Seller exibem Magalu com URL idêntica.
- Nenhuma CTA inicia autorização OAuth.
- Termos e privacidade são acessíveis anonimamente e os links não quebram em navegação direta.
