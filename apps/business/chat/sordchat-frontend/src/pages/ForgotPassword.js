import React, { useState } from "react";
import { ArrowLeft, Mail, MessageSquare, Send, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";

const ForgotPassword = () => {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const publicUrl = process.env.PUBLIC_URL || "";

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!email.trim()) {
      toast.error("Informe o e-mail cadastrado.");
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.detail || "Não foi possível solicitar a redefinição.");
      setSent(true);
    } catch (error) {
      toast.error(error.message || "Não foi possível solicitar a redefinição.");
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
          <span className="vc-badge"><ShieldCheck size={14} aria-hidden="true" /> Recuperação segura</span>
          <h1>Vamos ajudar você a acessar sua conta novamente.</h1>
          <p>Enviaremos um link de redefinição para o e-mail vinculado à sua conta.</p>
        </div>
      </section>
      <section className="vc-login-panel-wrap">
        <div className="vc-login-panel" aria-label="Recuperar senha VoltChat">
          <div className="vc-login-panel__icon"><MessageSquare size={25} aria-hidden="true" /></div>
          {sent ? (
            <div className="vc-login-form">
              <Send size={34} className="text-blue-500" aria-hidden="true" />
              <h2>Confira seu e-mail</h2>
              <p>Se houver uma conta vinculada a este endereço, enviamos o link para redefinir a senha.</p>
              <Link className="vc-button-primary" to="/login">Voltar ao login</Link>
            </div>
          ) : (
            <>
              <h2>Esqueci minha senha</h2>
              <p>Informe o e-mail cadastrado na sua empresa.</p>
              <form onSubmit={handleSubmit} className="vc-login-form">
                <div className="vc-field-label">
                  <label htmlFor="forgot-password-email">E-mail cadastrado</label>
                  <span className="vc-login-field">
                    <Mail className="vc-login-field__icon" size={18} aria-hidden="true" />
                    <input id="forgot-password-email" type="email" className="vc-input vc-login-field__input" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="seu.email@empresa.com.br" />
                  </span>
                </div>
                <button type="submit" className="vc-button-primary" disabled={loading}>{loading ? "Enviando..." : "Enviar link de redefinição"}</button>
                <Link className="vc-login-help" to="/login"><ArrowLeft size={15} aria-hidden="true" /> Voltar ao login</Link>
              </form>
            </>
          )}
        </div>
      </section>
    </main>
  );
};

export default ForgotPassword;