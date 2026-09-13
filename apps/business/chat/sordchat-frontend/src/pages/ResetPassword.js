import React, { useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Eye, EyeOff, KeyRound, Lock, MessageSquare } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";

const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => searchParams.get("token") || "", [searchParams]);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [completed, setCompleted] = useState(false);
  const publicUrl = process.env.PUBLIC_URL || "";

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (password.length < 6) {
      toast.error("A nova senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirmation) {
      toast.error("As senhas informadas não coincidem.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, new_password: password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível redefinir sua senha.");
      setCompleted(true);
      toast.success("Senha redefinida com sucesso.");
    } catch (error) {
      toast.error(error.message || "Não foi possível redefinir sua senha.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="vc-login-page">
      <section className="vc-login-hero">
        <div className="vc-brand-lockup">
          <img className="vc-brand-logo" src={`${publicUrl}/brand/voltchat-transparent.png`} alt="Volt Chat" width={64} height={64} />
          <span className="vc-brand-wordmark">VOLT<span>CHAT</span></span>
        </div>
        <div className="vc-login-copy">
          <span className="vc-badge"><KeyRound size={14} aria-hidden="true" /> Acesso seguro</span>
          <h1>Redefina sua senha e volte ao VoltChat.</h1>
          <p>O link enviado para o seu e-mail é pessoal, expira rapidamente e só pode ser usado uma vez.</p>
        </div>
      </section>
      <section className="vc-login-panel-wrap">
        <div className="vc-login-panel" aria-label="Redefinir senha VoltChat">
          <div className="vc-login-panel__icon"><MessageSquare size={25} aria-hidden="true" /></div>
          {completed ? (
            <div className="vc-login-form">
              <CheckCircle2 size={34} className="text-emerald-500" aria-hidden="true" />
              <h2>Senha redefinida</h2>
              <p>Use sua nova senha para entrar no VoltChat.</p>
              <button className="vc-button-primary" type="button" onClick={() => navigate("/login")}>Entrar no VoltChat</button>
            </div>
          ) : (
            <>
              <h2>Nova senha</h2>
              <p>Escolha uma senha com pelo menos 6 caracteres.</p>
              <form onSubmit={handleSubmit} className="vc-login-form">
                <div className="vc-field-label">
                  <label htmlFor="reset-password">Nova senha</label>
                  <span className="vc-login-field">
                    <Lock className="vc-login-field__icon" size={18} aria-hidden="true" />
                    <input id="reset-password" type={showPassword ? "text" : "password"} className="vc-input vc-login-field__input vc-login-field__input--password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" />
                    <button className="vc-login-field__visibility" type="button" aria-label={showPassword ? "Ocultar senha" : "Exibir senha"} onClick={() => setShowPassword((current) => !current)}>{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button>
                  </span>
                </div>
                <div className="vc-field-label">
                  <label htmlFor="reset-password-confirmation">Confirmar nova senha</label>
                  <span className="vc-login-field">
                    <Lock className="vc-login-field__icon" size={18} aria-hidden="true" />
                    <input id="reset-password-confirmation" type={showPassword ? "text" : "password"} className="vc-input vc-login-field__input" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" />
                  </span>
                </div>
                <button type="submit" className="vc-button-primary" disabled={loading || !token}>{loading ? "Redefinindo..." : "Redefinir senha"}</button>
                <Link className="vc-login-help" to="/login"><ArrowLeft size={15} aria-hidden="true" /> Voltar ao login</Link>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  );
};

export default ResetPassword;