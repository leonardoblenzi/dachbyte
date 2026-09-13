import { FileSpreadsheet } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ModulePanel } from '@/components/layout/ModulePanel';

export default function ImportarPage() {
  return (
    <AppShell title="Importar Planilha">
      <ModulePanel
        title="Staging de Importacao"
        icon={FileSpreadsheet}
        rows={[
          { label: 'Produtos', value: 'SKU, barcode e aliases', status: 'validacao pendente' },
          { label: 'Localizacoes', value: 'Arvore fisica', status: 'rollback planejado' },
          { label: 'Saldos', value: 'Carga inicial', status: 'job assíncrono' }
        ]}
      />
    </AppShell>
  );
}
