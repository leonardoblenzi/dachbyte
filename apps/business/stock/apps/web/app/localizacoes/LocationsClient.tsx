'use client';

import { FormEvent, useEffect, useState } from 'react';
import { GitBranchPlus, MapPinned } from 'lucide-react';
import { apiFetch } from '@/lib/api';

type Facility = { id: string; code: string; name: string };
type LocationNode = {
  id: string;
  code: string;
  name: string;
  location_type: string;
  status: string;
  children: LocationNode[];
};

function Tree({ nodes }: { nodes: LocationNode[] }) {
  return (
    <ul className="location-tree">
      {nodes.map((node) => (
        <li key={node.id}>
          <div>
            <span>{node.code}</span>
            <strong>{node.name}</strong>
            <small>{node.location_type}</small>
          </div>
          {node.children?.length ? <Tree nodes={node.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export function LocationsClient() {
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [tree, setTree] = useState<LocationNode[]>([]);
  const [form, setForm] = useState({ facilityId: '', rackCode: 'EST04', rackName: 'Estante 04', columns: 6, levels: 4, binsPerLevel: 2 });
  const [message, setMessage] = useState('');

  async function load() {
    const facilityPayload = await apiFetch<{ items: Facility[] }>('/v1/facilities');
    setFacilities(facilityPayload.items);
    const facilityId = form.facilityId || facilityPayload.items[0]?.id || '';
    if (facilityId) {
      setForm((current) => ({ ...current, facilityId }));
      const treePayload = await apiFetch<{ items: LocationNode[] }>(`/v1/locations/tree?facilityId=${facilityId}`);
      setTree(treePayload.items);
    }
  }

  useEffect(() => {
    load().catch((err) => setMessage(err.message));
  }, []);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload = await apiFetch<{ generatedCount: number }>('/v1/locations/bulk-generate', {
      method: 'POST',
      body: JSON.stringify({
        facilityId: form.facilityId,
        aisleCode: 'RUA-B',
        rackCode: form.rackCode,
        rackName: form.rackName,
        columns: form.columns,
        levels: form.levels,
        binsPerLevel: form.binsPerLevel,
        capacityPerBin: 300
      })
    });
    setMessage(`${payload.generatedCount} posicoes geradas`);
    await load();
  }

  return (
    <div className="data-grid">
      <section className="panel">
        <div className="panel-heading">
          <h2>Gerar Estrutura</h2>
          <GitBranchPlus size={18} aria-hidden="true" />
        </div>
        <form className="stack-form" onSubmit={generate}>
          <label>
            <span>Facility</span>
            <select value={form.facilityId} onChange={(event) => setForm({ ...form, facilityId: event.target.value })}>
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.code} - {facility.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Codigo da estante</span>
            <input value={form.rackCode} onChange={(event) => setForm({ ...form, rackCode: event.target.value })} />
          </label>
          <label>
            <span>Nome</span>
            <input value={form.rackName} onChange={(event) => setForm({ ...form, rackName: event.target.value })} />
          </label>
          <div className="triple-fields">
            <label>
              <span>Colunas</span>
              <input type="number" min="1" value={form.columns} onChange={(event) => setForm({ ...form, columns: Number(event.target.value) })} />
            </label>
            <label>
              <span>Niveis</span>
              <input type="number" min="1" value={form.levels} onChange={(event) => setForm({ ...form, levels: Number(event.target.value) })} />
            </label>
            <label>
              <span>Bins</span>
              <input type="number" min="1" value={form.binsPerLevel} onChange={(event) => setForm({ ...form, binsPerLevel: Number(event.target.value) })} />
            </label>
          </div>
          <button className="primary-button" type="submit">
            <MapPinned size={18} aria-hidden="true" />
            <span>Gerar</span>
          </button>
          {message ? <p className="form-success">{message}</p> : null}
        </form>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>Arvore Fisica</h2>
          <MapPinned size={18} aria-hidden="true" />
        </div>
        <Tree nodes={tree} />
      </section>
    </div>
  );
}
