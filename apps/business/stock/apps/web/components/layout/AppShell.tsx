'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Activity,
  Boxes,
  ClipboardList,
  Cog,
  FileSpreadsheet,
  Gauge,
  History,
  Layers3,
  LogOut,
  Map,
  PackagePlus,
  QrCode,
  ScanLine,
  ShieldCheck,
  Tags,
  Users
} from 'lucide-react';
import { BASE_PATH, ensureSession, readSession, type StoredSession } from '@/lib/api';
import { useEffect, useState } from 'react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: Gauge },
  { href: '/mapa', label: 'Mapa 3D', icon: Layers3 },
  { href: '/bipagem', label: 'Bipar e Alocar', icon: ScanLine },
  { href: '/produtos', label: 'Produtos', icon: Boxes },
  { href: '/localizacoes', label: 'Localizacoes', icon: Map },
  { href: '/movimentacoes', label: 'Movimentacoes', icon: History },
  { href: '/importar', label: 'Importar', icon: FileSpreadsheet },
  { href: '/etiquetas', label: 'Etiquetas', icon: Tags },
  { href: '/inventario', label: 'Inventario', icon: ClipboardList },
  { href: '/auditoria', label: 'Auditoria', icon: ShieldCheck },
  { href: '/usuarios', label: 'Usuarios', icon: Users },
  { href: '/configuracoes', label: 'Configuracoes', icon: Cog }
];

export function AppShell({ children, title, action }: { children: React.ReactNode; title: string; action?: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authState, setAuthState] = useState<{ session: StoredSession | null; checking: boolean }>(() => {
    const current = readSession();
    return { session: current, checking: !current };
  });

  useEffect(() => {
    ensureSession().then((nextSession) => {
      setAuthState({ session: nextSession, checking: false });
      if (!nextSession) router.replace('/login');
    });
  }, [router]);

  function logout() {
    window.localStorage.removeItem('voltstock.session');
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => {
      window.location.href = `${BASE_PATH}/login`;
    });
  }

  if (authState.checking) {
    return (
      <div className="app-shell">
        <main className="workspace">
          <div className="empty-state">Carregando acesso...</div>
        </main>
      </div>
    );
  }

  if (!authState.session) {
    return (
      <div className="app-shell">
        <main className="workspace">
          <div className="empty-state">Redirecionando para o login...</div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand-block" aria-label="DACHBYTE Stock">
          <img className="dachbyte-artwork" src="/brand/dachbyte/business/mark-transparent.png" alt="" width={42} height={42} />
          <div>
            <strong>DACHBYTE Stock</strong>
            <span>Enterprise WMS</span>
          </div>
        </Link>

        <nav className="side-nav" aria-label="Menu principal">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={active ? 'active' : ''} title={item.label}>
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">DACHBYTE Stock · Operação</p>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            {action}
            <div className="session-chip">
              <Activity size={16} aria-hidden="true" />
              <span>{authState.session?.user.role ?? 'offline'}</span>
            </div>
            <button className="icon-button" type="button" onClick={logout} title="Sair">
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        {children}
      </main>
    </div>
  );
}
