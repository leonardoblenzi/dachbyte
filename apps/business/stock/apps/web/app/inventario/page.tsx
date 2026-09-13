import { ClipboardList } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ModulePanel } from '@/components/layout/ModulePanel';

export default function InventarioPage() {
  return (
    <AppShell title="Inventario">
      <ModulePanel
        title="Contagem Ciclica"
        icon={ClipboardList}
        rows={[
          { label: 'Por local', value: 'Bipar local e contar', status: 'offline futuro' },
          { label: 'Por produto', value: 'Divergencia por SKU', status: 'auditoria' },
          { label: 'Conciliacao', value: 'Ajuste controlado', status: 'aprovacao' }
        ]}
      />
    </AppShell>
  );
}
