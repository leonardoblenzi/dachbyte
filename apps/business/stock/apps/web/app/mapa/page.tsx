import { Layers3 } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { SketchEditor } from '@/components/warehouse/SketchEditor';
import { WarehouseScene } from '@/components/warehouse/WarehouseScene';

export default function MapaPage() {
  return (
    <AppShell
      title="Mapa 2D e 3D"
      action={
        <button className="secondary-button" type="button">
          <Layers3 size={16} aria-hidden="true" />
          <span>Publicar</span>
        </button>
      }
    >
      <div className="split-grid">
        <section className="panel visual-panel">
          <div className="panel-heading">
            <h2>Mapa 3D</h2>
            <span>H01-RB-EST03</span>
          </div>
          <WarehouseScene />
        </section>
        <section className="panel visual-panel">
          <div className="panel-heading">
            <h2>Editor 2D</h2>
            <span>Sketch</span>
          </div>
          <SketchEditor />
        </section>
      </div>
    </AppShell>
  );
}
