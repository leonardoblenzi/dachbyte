import { RefreshCw } from 'lucide-react';
import { AppShell } from '@/components/layout/AppShell';
import { DashboardClient } from './DashboardClient';

export default function DashboardPage() {
  return (
    <AppShell
      title="Dashboard"
      action={
        <button className="secondary-button" type="button">
          <RefreshCw size={16} aria-hidden="true" />
          <span>Atualizar</span>
        </button>
      }
    >
      <DashboardClient />
    </AppShell>
  );
}
