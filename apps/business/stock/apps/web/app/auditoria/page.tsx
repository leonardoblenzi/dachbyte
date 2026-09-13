import { ShieldCheck } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ModulePanel } from '@/components/layout/ModulePanel';

export default function AuditoriaPage() {
  return (
    <AppShell title="Auditoria">
      <ModulePanel
        title="Trilha de Eventos"
        icon={ShieldCheck}
        rows={[
          { label: 'Auth', value: 'Login e refresh', status: 'registravel' },
          { label: 'Estoque', value: 'Movimentos e ajustes', status: 'imutavel' },
          { label: 'Integracoes', value: 'Webhooks e jobs', status: 'rastreavel' }
        ]}
      />
    </AppShell>
  );
}
