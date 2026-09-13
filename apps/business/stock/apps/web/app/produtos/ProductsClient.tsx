'use client';

import { FormEvent, useEffect, useState } from 'react';
import { PackagePlus, Search } from 'lucide-react';
import { apiFetch } from '@/lib/api';

type Product = {
  id: string;
  productCode: string;
  sku?: string;
  barcode?: string;
  name: string;
  category?: string;
  unit: string;
  trackingMode: string;
  quantity: string;
};

type ProductList = {
  items: Product[];
  total: number;
};

export function ProductsClient() {
  const [items, setItems] = useState<Product[]>([]);
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ productCode: '', sku: '', barcode: '', name: '', category: '', unit: 'un' });
  const [message, setMessage] = useState('');

  async function load(search = q) {
    const data = await apiFetch<ProductList>(`/v1/products?q=${encodeURIComponent(search)}`);
    setItems(data.items);
  }

  useEffect(() => {
    load('').catch((err) => setMessage(err.message));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const created = await apiFetch<{ productCode: string; qrToken: string }>('/v1/products', {
      method: 'POST',
      body: JSON.stringify({
        productCode: form.productCode,
        sku: form.sku || undefined,
        barcode: form.barcode || undefined,
        name: form.name,
        category: form.category || undefined,
        unit: form.unit,
        trackingMode: 'none'
      })
    });
    setMessage(`Produto ${created.productCode} criado com QR interno`);
    setForm({ productCode: '', sku: '', barcode: '', name: '', category: '', unit: 'un' });
    await load('');
  }

  return (
    <div className="data-grid">
      <section className="panel">
        <div className="panel-heading">
          <h2>Cadastrar Produto</h2>
          <PackagePlus size={18} aria-hidden="true" />
        </div>
        <form className="stack-form" onSubmit={submit}>
          <label>
            <span>Codigo</span>
            <input value={form.productCode} onChange={(event) => setForm({ ...form, productCode: event.target.value })} required />
          </label>
          <label>
            <span>Nome</span>
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
          </label>
          <label>
            <span>SKU</span>
            <input value={form.sku} onChange={(event) => setForm({ ...form, sku: event.target.value })} />
          </label>
          <label>
            <span>Barcode externo</span>
            <input value={form.barcode} onChange={(event) => setForm({ ...form, barcode: event.target.value })} />
          </label>
          <label>
            <span>Categoria</span>
            <input value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
          </label>
          <button className="primary-button" type="submit">
            <PackagePlus size={18} aria-hidden="true" />
            <span>Salvar</span>
          </button>
          {message ? <p className="form-success">{message}</p> : null}
        </form>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading">
          <h2>Itens em Estoque</h2>
          <div className="table-search">
            <Search size={16} aria-hidden="true" />
            <input
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                load(event.target.value).catch((err) => setMessage(err.message));
              }}
              placeholder="Buscar"
            />
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Codigo</th>
                <th>Produto</th>
                <th>Categoria</th>
                <th>Qtd</th>
                <th>Tracking</th>
              </tr>
            </thead>
            <tbody>
              {items.map((product) => (
                <tr key={product.id}>
                  <td>{product.productCode}</td>
                  <td>{product.name}</td>
                  <td>{product.category ?? '-'}</td>
                  <td>{Number(product.quantity).toLocaleString('pt-BR')}</td>
                  <td>{product.trackingMode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
