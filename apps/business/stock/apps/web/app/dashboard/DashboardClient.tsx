'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, MapPin, PackageSearch, ScanLine } from 'lucide-react';
import { apiFetch } from '@/lib/api';

type DashboardData = {
  products: {
    total_skus: number;
    total_quantity: string;
    products_without_location: number;
  };
  locations: {
    available: number;
    partial: number;
    full: number;
    blocked: number;
  };
  recentMovements: Array<{ id: string; movement_type: string; quantity: string; product_name: string; created_at: string }>;
  recentScans: Array<{ scanned_value: string; resolved_type: string; scan_source: string; created_at: string }>;
};

export function DashboardClient() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch<DashboardData>('/v1/dashboard').then(setData).catch((err) => setError(err.message));
  }, []);

  const cards = useMemo(
    () => [
      { label: 'SKUs', value: data?.products.total_skus ?? 0, icon: Boxes, tone: 'blue' },
      { label: 'Quantidade', value: Number(data?.products.total_quantity ?? 0).toLocaleString('pt-BR'), icon: PackageSearch, tone: 'green' },
      { label: 'Sem local', value: data?.products.products_without_location ?? 0, icon: AlertTriangle, tone: 'amber' },
      { label: 'Bloqueadas', value: data?.locations.blocked ?? 0, icon: MapPin, tone: 'red' }
    ],
    [data]
  );

  if (error) {
    return <div className="empty-state">{error}</div>;
  }

  return (
    <div className="page-grid">
      <section className="metric-grid">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <article className={`metric-card tone-${card.tone}`} key={card.label}>
              <Icon size={22} aria-hidden="true" />
              <span>{card.label}</span>
              <strong>{card.value}</strong>
            </article>
          );
        })}
      </section>

      <section className="panel wide">
        <div className="panel-heading">
          <h2>Ocupacao de Localizacoes</h2>
          <span>{data ? 'sincronizado' : 'carregando'}</span>
        </div>
        <div className="occupancy-strip">
          <div style={{ '--size': `${data?.locations.available ?? 1}fr` } as React.CSSProperties}>
            <span>Livre</span>
            <strong>{data?.locations.available ?? 0}</strong>
          </div>
          <div style={{ '--size': `${data?.locations.partial ?? 1}fr` } as React.CSSProperties}>
            <span>Parcial</span>
            <strong>{data?.locations.partial ?? 0}</strong>
          </div>
          <div style={{ '--size': `${data?.locations.full ?? 1}fr` } as React.CSSProperties}>
            <span>Cheia</span>
            <strong>{data?.locations.full ?? 0}</strong>
          </div>
          <div style={{ '--size': `${data?.locations.blocked ?? 1}fr` } as React.CSSProperties}>
            <span>Bloqueada</span>
            <strong>{data?.locations.blocked ?? 0}</strong>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Movimentacoes</h2>
          <PackageSearch size={17} aria-hidden="true" />
        </div>
        <div className="event-list">
          {(data?.recentMovements ?? []).map((item) => (
            <div className="event-row" key={item.id}>
              <span>{item.movement_type}</span>
              <strong>{item.product_name}</strong>
              <small>{Number(item.quantity).toLocaleString('pt-BR')} un</small>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Bipagens</h2>
          <ScanLine size={17} aria-hidden="true" />
        </div>
        <div className="event-list">
          {(data?.recentScans ?? []).map((item) => (
            <div className="event-row" key={`${item.scanned_value}-${item.created_at}`}>
              <span>{item.resolved_type ?? 'unknown'}</span>
              <strong>{item.scanned_value}</strong>
              <small>{item.scan_source}</small>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
