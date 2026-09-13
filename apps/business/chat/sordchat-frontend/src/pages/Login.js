import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Eye, EyeOff, Lock, Mail, MessageSquare, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';

const isDesktopApp = () => Boolean(window.voltChatDesktop?.customTitleBar);

const Login = () => {
  const [credentials, setCredentials] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(isDesktopApp);
  const { login } = useAuth();
  const navigate = useNavigate();
  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!credentials.username || !credentials.password) {
      toast.error('Preencha o e-mail cadastrado e a senha.');
      return;
    }

    setLoading(true);
    const result = await login(credentials, rememberMe);
    setLoading(false);

    if (result.success) {
      navigate('/dashboard');
    }
  };

  return (
    <main className="vc-login-page">
      <section className="vc-login-hero">
        <div className="vc-brand-lockup">
          <img className="vc-brand-logo" src="/brand/dachbyte/business/mark-transparent.png" alt="DACHBYTE" width={64} height={64} />
          <span className="vc-brand-wordmark">DACHBYTE <span>CHAT</span></span>
        </div>

        <div className="vc-login-copy">
          <span className="vc-badge">
            <ShieldCheck size={14} aria-hidden="true" />
            Ambiente de comunicacao
          </span>
          <h1>Converse, organize tarefas, acompanhe tickets e alinhe o time em um fluxo direto.</h1>
          <p>
            O DACHBYTE Chat centraliza comunicacao, kanban e suporte para equipes que precisam responder rapido e manter contexto em cada atendimento.
          </p>
        </div>

        <div className="vc-login-footnotes">
          <span>Chat em tempo real</span>
          <span>Tickets com SLA</span>
          <span>Kanban integrado</span>
        </div>
      </section>

      <section className="vc-login-panel-wrap">
        <div className="vc-login-panel" aria-label="Login DACHBYTE Chat">
          <div className="vc-login-panel__icon">
            <MessageSquare size={25} aria-hidden="true" />
          </div>
          <h2>Entrar</h2>
          <p>Entre com o e-mail cadastrado pela sua empresa.</p>

          <form onSubmit={handleSubmit} className="vc-login-form">
            <div className="vc-field-label">
              <label htmlFor="chat-login-username">E-mail cadastrado</label>
              <span className="vc-login-field">
                <Mail className="vc-login-field__icon" size={18} aria-hidden="true" />
                <input
                  id="chat-login-username"
                  name="username"
                  type="email"
                  className="vc-input vc-login-field__input"
                  value={credentials.username}
                  onChange={(event) => setCredentials((prev) => ({ ...prev, username: event.target.value }))}
                  autoComplete="username"
                  placeholder="seu.email@empresa.com.br"
                />
              </span>
            </div>

            <div className="vc-field-label">
              <label htmlFor="chat-login-password">Senha</label>
              <span className="vc-login-field">
                <Lock className="vc-login-field__icon" size={18} aria-hidden="true" />
                <input
                  id="chat-login-password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  className="vc-input vc-login-field__input vc-login-field__input--password"
                  value={credentials.password}
                  onChange={(event) => setCredentials((prev) => ({ ...prev, password: event.target.value }))}
                  autoComplete="current-password"
                  placeholder="sua senha"
                />
                <button
                  className="vc-login-field__visibility"
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

            <label className="vc-login-remember">
              <input type="checkbox" checked={rememberMe} onChange={(event) => setRememberMe(event.target.checked)} />
              <span>Manter conectado neste dispositivo</span>
            </label>

            <div className="vc-login-help">
              <span>Caso tenha esquecido sua senha, solicite um link seguro para o e-mail cadastrado.</span>
              <Link to="/forgot-password">Esqueci minha senha</Link>
            </div>

            <button type="submit" className="vc-button-primary" disabled={loading}>
              {loading ? <span className="spinner" /> : <ArrowRight size={18} aria-hidden="true" />}
              {loading ? 'Entrando...' : 'Entrar no DACHBYTE Chat'}
            </button>
          </form>
        </div>
      </section>
    </main>
  );
};

export default Login;
