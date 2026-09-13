import { Users } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ModulePanel } from '@/components/layout/ModulePanel';

export default function UsuariosPage() {
  return (
    <AppShell title="Usuarios e Permissoes">
      <ModulePanel
        title="RBAC"
        icon={Users}
        rows={[
          { label: 'Admin', value: 'Acesso total tenant', status: 'ativo' },
          { label: 'Gestor', value: 'Mapa, produtos e saldo', status: 'ativo' },
          { label: 'Operador', value: 'Bipagem e inventario', status: 'ativo' }
        ]}
      />
    </AppShell>
  );
}
