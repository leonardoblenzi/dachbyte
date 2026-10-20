# Exportação e alteração de SKUs em contas grandes

## Decisão aprovada

Na tela Anúncios → Alteração de SKUs, exportar Todos, Ativos ou Inativos/Pausados sem limite global de 5.000 anúncios. Usar jobs assíncronos e o painel de jobs compartilhado. Aceitar uma única planilha com mais de 5.000 alterações, conferi-la antes do envio e aplicar em partes no worker, mantendo resultado por linha, isolamento da conta e idempotência.

## Fluxo

O web cria um job de exportação para a conta ativa. O worker percorre o scan do ML com o status selecionado, consulta itens em lotes e grava o XLSX em arquivo do volume compartilhado, usando escrita em fluxo. O status e o download são consultados pela mesma conta e usuário. O arquivo fica disponível apenas quando o job conclui.

O upload é salvo no volume compartilhado e cria uma prévia assíncrona. O worker lê o XLSX em fluxo, valida as linhas preenchidas e as compara com anúncios atuais do ML em lotes. A prévia persistida mostra contagens e linhas paginadas; somente as prontas podem ser confirmadas. A aplicação continua por anúncio, com progresso persistido e relatório final. As duas operações entram no painel de jobs existente.

## Proteções e verificação

Validar filtro no servidor, conta ativa e usuário em cada leitura/download. Limitar tamanho do arquivo para proteção de recursos sem usar 5.000 como limite de linhas. Não logar conteúdo, tokens ou caminhos privados. Preservar EAN, custo e demais atributos. Testar conta com mais de 5.000 itens/linhas, filtros, paginação, falhas intermediárias, retomada e acesso cruzado. Não publicar sem testes e verificação de migration.
