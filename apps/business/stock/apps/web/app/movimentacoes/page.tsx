import { History } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ModulePanel } from '@/components/layout/ModulePanel';

export default function MovimentacoesPage() {
  return (
    <AppShell title="Movimentacoes">
      <ModulePanel
        title="Ledger de Estoque"
        icon={History}
        rows={[
          { label: 'Entrada', value: 'Recebimento por QR', status: 'auditavel' },
          { label: 'Transferencia', value: 'Origem e destino', status: 'saldo consolidado' },
          { label: 'Ajuste', value: 'Permissao gestor/admin', status: 'com auditoria' }
        ]}
      />
    </AppShell>
  );
}
