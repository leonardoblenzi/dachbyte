import { Cog } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ModulePanel } from '@/components/layout/ModulePanel';

export default function ConfiguracoesPage() {
  return (
    <AppShell title="Configuracoes">
      <ModulePanel
        title="Tenant"
        icon={Cog}
        rows={[
          { label: 'Empresa', value: 'DACHBYTE Stock', status: 'master' },
          { label: 'Seguranca', value: 'RLS + JWT + HMAC', status: 'ativo' },
          { label: 'Ambiente', value: 'Render + Neon', status: 'planejado' }
        ]}
      />
    </AppShell>
  );
}
