import { AppShell } from '@/components/layout/AppShell';
import { LocationsClient } from './LocationsClient';

export default function LocalizacoesPage() {
  return (
    <AppShell title="Localizacoes">
      <LocationsClient />
    </AppShell>
  );
}
