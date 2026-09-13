'use client';

import { FormEvent, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Eye, EyeOff, Lock, PackageCheck, ShieldCheck, UserRound } from 'lucide-react';
import { API_URL, BASE_PATH, ensureSession, writeSession, type StoredSession } from '@/lib/api';

const DEFAULT_TENANT_SLUG = 'volt-stock-master';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    ensureSession().then((session) => {
      if (session?.accessToken) router.replace('/dashboard');
    });
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_URL}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, tenantSlug: DEFAULT_TENANT_SLUG })
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.message ?? 'Falha no login.');
      }

      writeSession(payload as StoredSession);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha no login.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="vs-login-page">
      <section className="vs-login-hero">
        <div className="vs-brand-lockup">
          <img className="vs-brand-logo dachbyte-artwork" src="/brand/dachbyte/business/mark-transparent.png" alt="DACHBYTE Stock" width={64} height={64} />
          <span className="vs-brand-wordmark">VOLT<span>STOCK</span></span>
        </div>

        <div className="vs-login-copy">
          <span className="vs-badge">
            <ShieldCheck size={14} aria-hidden="true" />
            Ambiente de estoque
          </span>
          <h1>Controle estoque, endereços, bipagem e inventário em um fluxo direto.</h1>
          <p>
            O DACHBYTE Stock organiza a operação física com leitura rápida, rastreabilidade e visão de ocupação para equipes que precisam decidir sem perder tempo.
          </p>
        </div>

        <div className="vs-login-footnotes">
          <span>Mapa de estoque</span>
          <span>Bipagem e QR Code</span>
          <span>Auditoria operacional</span>
        </div>
      </section>

      <section className="vs-login-panel-wrap">
        <div className="vs-login-panel" aria-label="Login DACHBYTE Stock">
          <div className="vs-login-panel__icon">
            <PackageCheck size={25} aria-hidden="true" />
          </div>
          <h2>Entrar</h2>
          <p>Use suas credenciais para acessar o ambiente de estoque da empresa.</p>

          <form onSubmit={submit} className="vs-login-form">
            <div className="vs-field-label">
              <label htmlFor="stock-login-email">E-mail</label>
              <span className="vs-login-field">
                <UserRound className="vs-login-field__icon" size={18} aria-hidden="true" />
                <input
                  id="stock-login-email"
                  className="vs-input vs-login-field__input"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="seu@email.com"
                  required
                />
              </span>
            </div>

            <div className="vs-field-label">
              <label htmlFor="stock-login-password">Senha</label>
              <span className="vs-login-field">
                <Lock className="vs-login-field__icon" size={18} aria-hidden="true" />
                <input
                  id="stock-login-password"
                  className="vs-input vs-login-field__input vs-login-field__input--password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                />
                <button
                  className="vs-login-field__visibility"
                  type="button"
                  aria-label={showPassword ? 'Ocultar senha' : 'Exibir senha'}
                  title={showPassword ? 'Ocultar senha' : 'Exibir senha'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
                </button>
              </span>
            </div>

            {error ? <div className="vs-login-error">{error}</div> : null}

            <button className="vs-button-primary" type="submit" disabled={loading}>
              {loading ? <span className="spinner" /> : <ArrowRight size={18} aria-hidden="true" />}
              <span>{loading ? 'Entrando...' : 'Entrar no DACHBYTE Stock'}</span>
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
