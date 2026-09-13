'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, Eye, Printer, RefreshCw, Tags } from 'lucide-react';
import { apiFetch } from '@/lib/api';

type Product = {
  id: string;
  productCode: string;
  sku?: string;
  barcode?: string;
  name: string;
  category?: string;
};

type Facility = { id: string; code: string; name: string };

type LocationNode = {
  id: string;
  code: string;
  name: string;
  location_type: string;
  path: string;
  children?: LocationNode[];
};

type LocationItem = {
  id: string;
  code: string;
  name: string;
  path: string;
  locationType: string;
};

type LabelResponse = {
  fileName: string;
  mimeType: string;
  labelCount: number;
  sizeBytes: number;
  dataUrl: string;
  job?: {
    id: string;
    status: string;
    created_at: string;
  };
};

function flattenLocations(nodes: LocationNode[]): LocationItem[] {
  return nodes.flatMap((node) => [
    {
      id: node.id,
      code: node.code,
      name: node.name,
      path: node.path,
      locationType: node.location_type
    },
    ...flattenLocations(node.children ?? [])
  ]);
}

export function LabelsClient() {
  const [targetEntity, setTargetEntity] = useState<'product' | 'location'>('product');
  const [products, setProducts] = useState<Product[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [facilityId, setFacilityId] = useState('');
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [copies, setCopies] = useState(1);
  const [includeBarcode, setIncludeBarcode] = useState(true);
  const [includePath, setIncludePath] = useState(true);
  const [message, setMessage] = useState('');
  const [pdf, setPdf] = useState<LabelResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const visibleItems = useMemo(() => {
    if (targetEntity === 'product') {
      return products.map((product) => ({
        id: product.id,
        code: product.productCode,
        name: product.name,
        detail: product.sku || product.barcode || product.category || '-'
      }));
    }

    return locations.map((location) => ({
      id: location.id,
      code: location.code,
      name: location.name,
      detail: location.path
    }));
  }, [locations, products, targetEntity]);

  async function loadProducts() {
    const payload = await apiFetch<{ items: Product[] }>('/v1/products?pageSize=100');
    setProducts(payload.items);
  }

  async function loadFacilitiesAndLocations(nextFacilityId?: string) {
    const facilityPayload = await apiFetch<{ items: Facility[] }>('/v1/facilities');
    setFacilities(facilityPayload.items);

    const resolvedFacilityId = nextFacilityId || facilityId || facilityPayload.items[0]?.id || '';
    setFacilityId(resolvedFacilityId);

    if (resolvedFacilityId) {
      const treePayload = await apiFetch<{ items: LocationNode[] }>(`/v1/locations/tree?facilityId=${resolvedFacilityId}`);
      setLocations(flattenLocations(treePayload.items));
    }
  }

  async function load() {
    await Promise.all([loadProducts(), loadFacilitiesAndLocations()]);
  }

  useEffect(() => {
    load().catch((err) => setMessage(err.message));
  }, []);

  useEffect(() => {
    setSelectedIds([]);
    setPdf(null);
  }, [targetEntity]);

  function toggleSelected(id: string) {
    setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  async function generate(mode: 'preview' | 'print-job') {
    setBusy(true);
    setMessage('');

    try {
      const payload = await apiFetch<LabelResponse>(`/v1/labels/${mode}`, {
        method: 'POST',
        body: JSON.stringify({
          targetEntity,
          entityIds: selectedIds,
          copies,
          pageFormat: 'A4',
          templateName: targetEntity === 'product' ? 'Produto A4' : 'Localizacao A4',
          includeBarcode,
          includePath
        })
      });

      setPdf(payload);
      setMessage(
        mode === 'print-job'
          ? `Job ${payload.job?.id ?? ''} criado com ${payload.labelCount} etiquetas.`
          : `Preview gerado com ${payload.labelCount} etiquetas.`
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Erro ao gerar etiquetas.');
    } finally {
      setBusy(false);
    }
  }

  function printPdf() {
    if (!pdf?.dataUrl) return;
    window.open(pdf.dataUrl, '_blank', 'noopener,noreferrer');
  }

  return (
    <div className="labels-layout">
      <section className="panel labels-control-panel">
        <div className="panel-heading">
          <h2>Gerar Etiquetas</h2>
          <Tags size={18} aria-hidden="true" />
        </div>

        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            generate('preview').catch((err) => setMessage(err.message));
          }}
        >
          <label>
            <span>Tipo</span>
            <select value={targetEntity} onChange={(event) => setTargetEntity(event.target.value as 'product' | 'location')}>
              <option value="product">Produtos</option>
              <option value="location">Localizacoes</option>
            </select>
          </label>

          {targetEntity === 'location' ? (
            <label>
              <span>Facility</span>
              <select
                value={facilityId}
                onChange={(event) => {
                  loadFacilitiesAndLocations(event.target.value).catch((err) => setMessage(err.message));
                }}
              >
                {facilities.map((facility) => (
                  <option key={facility.id} value={facility.id}>
                    {facility.code} - {facility.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <label>
            <span>Copias por item</span>
            <input type="number" min="1" max="20" value={copies} onChange={(event) => setCopies(Number(event.target.value))} />
          </label>

          <label className="inline-check">
            <input type="checkbox" checked={includeBarcode} onChange={(event) => setIncludeBarcode(event.target.checked)} />
            <span>Incluir barcode externo quando existir</span>
          </label>

          <label className="inline-check">
            <input type="checkbox" checked={includePath} onChange={(event) => setIncludePath(event.target.checked)} />
            <span>Incluir caminho/local ou dados complementares</span>
          </label>

          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => load().catch((err) => setMessage(err.message))}>
              <RefreshCw size={17} aria-hidden="true" />
              <span>Atualizar</span>
            </button>
            <button className="primary-button" type="submit" disabled={busy || !selectedIds.length}>
              <Eye size={17} aria-hidden="true" />
              <span>Preview</span>
            </button>
          </div>

          <button
            className="primary-button"
            type="button"
            disabled={busy || !selectedIds.length}
            onClick={() => generate('print-job').catch((err) => setMessage(err.message))}
          >
            <Printer size={17} aria-hidden="true" />
            <span>Gerar job de impressao</span>
          </button>

          {message ? <p className="form-success">{message}</p> : null}
        </form>
      </section>

      <section className="panel table-panel labels-list-panel">
        <div className="panel-heading">
          <h2>{targetEntity === 'product' ? 'Produtos' : 'Localizacoes'}</h2>
          <small>{selectedIds.length} selecionados</small>
        </div>
        <div className="table-wrap labels-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Sel.</th>
                <th>Codigo</th>
                <th>Nome</th>
                <th>Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {visibleItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={() => toggleSelected(item.id)} aria-label={`Selecionar ${item.code}`} />
                  </td>
                  <td>{item.code}</td>
                  <td>{item.name}</td>
                  <td>{item.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel labels-preview-panel">
        <div className="panel-heading">
          <h2>Preview PDF</h2>
          {pdf ? (
            <a className="secondary-button" href={pdf.dataUrl} download={pdf.fileName}>
              <Download size={17} aria-hidden="true" />
              <span>Baixar</span>
            </a>
          ) : null}
        </div>
        {pdf ? (
          <>
            <iframe className="pdf-preview" src={pdf.dataUrl} title="Preview de etiquetas Volt Stock" />
            <button className="primary-button" type="button" onClick={printPdf}>
              <Printer size={17} aria-hidden="true" />
              <span>Abrir para imprimir</span>
            </button>
          </>
        ) : (
          <div className="empty-state">Selecione itens e gere um preview.</div>
        )}
      </section>
    </div>
  );
}
