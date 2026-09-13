import { PackagePlus } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { ProductsClient } from './ProductsClient';

export default function ProdutosPage() {
  return (
    <AppShell
      title="Produtos"
      action={
        <button className="secondary-button" type="button">
          <PackagePlus size={16} aria-hidden="true" />
          <span>Novo SKU</span>
        </button>
      }
    >
      <ProductsClient />
    </AppShell>
  );
}
