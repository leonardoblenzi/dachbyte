'use client';

import { FormEvent, useState } from 'react';
import { CheckCircle2, LocateFixed, PackageCheck, QrCode, ScanLine } from 'lucide-react';
import { apiFetch } from '@/lib/api';

type ScanResult = {
  resolved: boolean;
  type?: string;
  entityId?: string;
  displayName?: string;
  actions?: string[];
};

export function ScanConsole() {
  const [scanValue, setScanValue] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [status, setStatus] = useState('');

  async function resolve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = await apiFetch<ScanResult>('/v1/scan/resolve', {
      method: 'POST',
      body: JSON.stringify({ scannedValue: scanValue, source: 'desktop_hid' })
    });

    setResult(payload);
    if (payload.type === 'product' && payload.entityId) {
      setProductId(payload.entityId);
    }
    if (payload.type === 'location' && payload.entityId) {
      setLocationId(payload.entityId);
    }
    setScanValue('');
  }

  async function confirmAllocation() {
    const payload = await apiFetch<{ movementId: string }>('/v1/scan/allocation/confirm', {
      method: 'POST',
      body: JSON.stringify({ productId, locationId, quantity, flowType: 'product_to_location' })
    });
    setStatus(`Movimento ${payload.movementId} confirmado`);
  }

  return (
    <div className="scan-grid">
      <section className="panel scan-panel">
        <div className="panel-heading">
          <h2>Console de Bipagem</h2>
          <ScanLine size={18} aria-hidden="true" />
        </div>
        <form onSubmit={resolve} className="scan-form">
          <div className="big-input">
            <QrCode size={24} aria-hidden="true" />
            <input autoFocus value={scanValue} onChange={(event) => setScanValue(event.target.value)} placeholder="QR, SKU, barcode ou codigo legado" />
          </div>
          <button className="primary-button" type="submit">
            <ScanLine size={18} aria-hidden="true" />
            <span>Bipar</span>
          </button>
        </form>

        {result ? (
          <div className={`scan-result ${result.resolved ? 'ok' : 'warn'}`}>
            <strong>{result.resolved ? result.displayName : 'Codigo nao identificado'}</strong>
            <span>{result.type ?? 'unknown'}</span>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h2>Alocacao</h2>
          <PackageCheck size={18} aria-hidden="true" />
        </div>
        <div className="allocation-form">
          <label>
            <span>Produto</span>
            <input value={productId} onChange={(event) => setProductId(event.target.value)} placeholder="product_id" />
          </label>
          <label>
            <span>Localizacao</span>
            <input value={locationId} onChange={(event) => setLocationId(event.target.value)} placeholder="location_id" />
          </label>
          <label>
            <span>Quantidade</span>
            <input value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} type="number" min="1" />
          </label>
          <button className="primary-button" type="button" onClick={confirmAllocation} disabled={!productId || !locationId}>
            <CheckCircle2 size={18} aria-hidden="true" />
            <span>Confirmar</span>
          </button>
          {status ? (
            <p className="form-success">
              <LocateFixed size={16} aria-hidden="true" />
              {status}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
