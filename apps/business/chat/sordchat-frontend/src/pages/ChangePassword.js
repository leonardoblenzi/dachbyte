import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import BrandLogo from '../components/common/BrandLogo';
import { useAuth } from '../contexts/AuthContext';

const ChangePassword = () => {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  const [loading, setLoading] = useState(false);
  const { changePassword, user } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (form.newPassword.length < 6) {
      toast.error('A nova senha deve ter pelo menos 6 caracteres.');
      return;
    }
    if (form.newPassword !== form.confirmPassword) {
      toast.error('A confirmacao nao confere.');
      return;
    }

    setLoading(true);
    try {
      await changePassword(form);
      navigate('/dashboard', { replace: true });
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <BrandLogo subtitle="Seguranca da conta" textClassName="text-white" />
        </div>

        <section className="panel p-6 shadow-2xl">
          <span className="badge">
            <ShieldCheck size={14} />
            Primeiro acesso
          </span>
          <h1 className="m-0 mt-4 text-2xl font-extrabold text-slate-950">Troque sua senha</h1>
          <p className="m-0 mt-2 text-sm text-slate-500">
            {user?.full_name || user?.name}, defina uma senha propria para liberar o Volt Corp.
          </p>

          <form className="mt-6 grid gap-4" onSubmit={handleSubmit}>
            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-700">Senha atual</span>
              <div className="login-field">
                <Lock className="login-field__icon" size={18} />
                <input
                  className="input login-field__input"
                  type="password"
                  value={form.currentPassword}
                  onChange={(event) => setForm((prev) => ({ ...prev, currentPassword: event.target.value }))}
                  autoComplete="current-password"
                  placeholder="Senha primaria recebida"
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-700">Nova senha</span>
              <div className="login-field">
                <KeyRound className="login-field__icon" size={18} />
                <input
                  className="input login-field__input"
                  type="password"
                  value={form.newPassword}
                  onChange={(event) => setForm((prev) => ({ ...prev, newPassword: event.target.value }))}
                  autoComplete="new-password"
                  placeholder="Minimo 6 caracteres"
                />
              </div>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-bold text-slate-700">Confirmar senha</span>
              <input
                className="input"
                type="password"
                value={form.confirmPassword}
                onChange={(event) => setForm((prev) => ({ ...prev, confirmPassword: event.target.value }))}
                autoComplete="new-password"
                placeholder="Repita a nova senha"
              />
            </label>

            <button className="button-primary w-full" type="submit" disabled={loading}>
              {loading ? <span className="spinner h-4 w-4" /> : <ShieldCheck size={18} />}
              {loading ? 'Alterando...' : 'Alterar senha e entrar'}
            </button>
          </form>
        </section>
      </div>
    </div>
  );
};

export default ChangePassword;
