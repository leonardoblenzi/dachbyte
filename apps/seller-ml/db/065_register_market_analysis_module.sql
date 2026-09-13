begin;

-- Registra o novo módulo na camada de aplicação (services/companyAccessService.js)
-- e preserva o comportamento dos usuários que já tinham acesso à Análise com IA,
-- copiando essa permissão para Análise Mercado quando ainda não existe configuração.
insert into empresa_usuario_modulos (
  empresa_id,
  usuario_id,
  modulo_key,
  pode_acessar,
  pode_editar,
  criado_em,
  atualizado_em
)
select
  empresa_id,
  usuario_id,
  'ml.inteligencia.analise_mercado',
  pode_acessar,
  pode_editar,
  now(),
  now()
from empresa_usuario_modulos
where modulo_key = 'ml.inteligencia.analise_ia'
on conflict (empresa_id, usuario_id, modulo_key) do nothing;

commit;
