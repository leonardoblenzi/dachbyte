import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  Download,
  KanbanSquare,
  LockKeyhole,
  MessageSquare,
  MonitorDown,
  Sparkles,
  Ticket,
  Users,
} from 'lucide-react';
import BrandLogo from '../components/common/BrandLogo';
import { DESKTOP_DOWNLOAD_URL } from '../config';

const features = [
  ['Chat interno por setor', 'Canais para RH, financeiro, TI, estoque, comercial e operacao.', MessageSquare],
  ['Tickets rastreaveis', 'Solicitacoes com responsavel, prioridade, status e historico.', Ticket],
  ['Kanban operacional', 'Demandas organizadas entre backlog, execucao, revisao e concluido.', KanbanSquare],
  ['Assistente DACHBYTE', 'Transforma pedidos em tickets e tarefas com setor e prioridade.', Bot],
  ['Permissoes por perfil', 'Admin, coordenador e usuario com visibilidade adequada.', LockKeyhole],
  ['Equipe conectada', 'Funcionarios, setores e liderancas alinhados em tempo real.', Users],
];

const moduleCards = [
  ['CH', 'Chat interno', 'Conversas entre funcionarios e grupos por setor.'],
  ['TK', 'Tickets', 'Solicitacoes rastreaveis com responsavel.'],
  ['KB', 'Kanban', 'Fluxo visual de tarefas e execucao.'],
  ['AI', 'Assistente', 'Cria tickets e tarefas a partir de texto livre.'],
];

const Landing = () => {
  const shellRef = useRef(null);

  useEffect(() => {
    if (!window.DachbyteLanding || !shellRef.current) return undefined;
    return window.DachbyteLanding.mount(shellRef.current, 'business', 'Chat');
  }, []);

  return (
    <main className="landing-page landing-page--neon" id="top">
      <div ref={shellRef} data-dx-shell="business" data-dx-module="Chat" />
      <div className="landing-noise" aria-hidden="true" />

      <section className="lp-hero">
        <div className="lp-container lp-hero-grid">
          <div>
            <div className="lp-eyebrow">
              <span className="lp-pulse-dot" />
              Comunicacao interna empresarial em tempo real
            </div>
            <h1>
              Organize mensagens, tickets e tarefas{' '}
              <span className="lp-gradient-text">entre funcionarios e setores.</span>
            </h1>
            <p className="lp-lead">
              O DACHBYTE Chat conecta funcionarios, departamentos e liderancas, transformando solicitacoes do dia a dia em
              tickets, tarefas e fluxos acompanhados por Kanban, status, responsaveis e prioridades.
            </p>
            <div className="lp-hero-actions">
              <Link className="lp-btn lp-btn--primary" to="/login">
                Comecar agora
                <ArrowRight size={18} />
              </Link>
              <a className="lp-btn" href="#painel">
                Ver experiencia
              </a>
              <a className="lp-btn" href={DESKTOP_DOWNLOAD_URL}>
                <MonitorDown size={18} />
                Baixar app
              </a>
            </div>
            <div className="lp-trust-row">
              <div className="lp-avatar-stack" aria-hidden="true">
                <span>TI</span>
                <span>RH</span>
                <span>FN</span>
                <span>+</span>
              </div>
              <span>Feito para RH, financeiro, TI, operacoes, comercial, estoque e liderancas.</span>
            </div>
            <div className="lp-metrics-mini">
              <div><strong>72%</strong><span>menos ruido interno</span></div>
              <div><strong>100%</strong><span>solicitacoes rastreadas</span></div>
              <div><strong>3x</strong><span>mais organizacao por setor</span></div>
            </div>
          </div>

          <div className="lp-hero-visual" aria-label="Prévia visual do DACHBYTE Chat">
            <div className="lp-radar" />
            <div className="lp-floating-card lp-floating-card--one">
              <small>Tickets internos</small>
              <strong>18 solicitacoes priorizadas</strong>
              <div className="lp-mini-bar"><i /></div>
            </div>
            <div className="lp-floating-card lp-floating-card--two">
              <small>Kanban ativo</small>
              <strong>Etapas atualizadas</strong>
              <div className="lp-mini-bar"><i /></div>
            </div>
            <div className="lp-floating-card lp-floating-card--three">
              <small>Setores online</small>
              <strong>RH - TI - Financeiro</strong>
              <div className="lp-mini-bar"><i /></div>
            </div>

            <div className="lp-chat-window">
              <div className="lp-chat-head">
                <div className="lp-agent-id">
                  <div className="lp-agent-face">
                    <Sparkles size={21} />
                  </div>
                  <div>
                    <strong>Assistente DACHBYTE</strong>
                    <small>Central interna inteligente</small>
                  </div>
                </div>
                <span className="lp-status-pill">online</span>
              </div>
              <div className="lp-chat-body">
                <div className="lp-bubble lp-bubble--bot">
                  Ola! Posso registrar sua solicitacao e encaminhar para o setor responsavel.
                </div>
                <div className="lp-bubble lp-bubble--user">Crie um ticket urgente para TI sobre notebook travando.</div>
                <div className="lp-bubble lp-bubble--bot">
                  Ticket criado, prioridade alta, setor TI e status Aberto.
                </div>
                <div className="lp-chat-input">
                  <span>Digite uma solicitacao interna...</span>
                  <div><ArrowRight size={18} /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="recursos">
        <div className="lp-container">
          <div className="lp-section-title">
            <div className="lp-eyebrow"><span className="lp-pulse-dot" /> Recursos principais</div>
            <h2>Comunicacao interna com processos visiveis e rastreaveis.</h2>
            <p>Uma experiencia para funcionarios enviarem mensagens, abrirem chamados e acompanharem prazos.</p>
          </div>
          <div className="lp-grid-3">
            {features.map(([title, description, Icon]) => (
              <article className="lp-feature-card" key={title}>
                <div className="lp-icon"><Icon size={23} /></div>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section" id="painel">
        <div className="lp-container">
          <div className="lp-section-title">
            <div className="lp-eyebrow"><span className="lp-pulse-dot" /> Painel de operacao interna</div>
            <h2>Controle conversas, tickets e Kanban em uma tela moderna.</h2>
            <p>Gestores e setores trabalham com clareza, sem conversas perdidas e sem solicitacoes esquecidas.</p>
          </div>
          <div className="lp-dashboard">
            <div className="lp-panel">
              <div className="lp-panel-top">
                <strong>Tickets internos</strong>
                <span className="lp-status-pill">tempo real</span>
              </div>
              <div className="lp-panel-content lp-conversation-list">
                {[
                  ['A', 'Joao Pereira', 'Solicitacao de notebook', 'TI'],
                  ['M', 'Mariana Costa', 'Reembolso aguardando aprovacao', 'Financeiro'],
                  ['E', 'Equipe Estoque', 'Separacao de material pendente', 'Estoque'],
                  ['RH', 'RH Interno', 'Admissao e documentos', 'RH'],
                ].map(([avatar, name, detail, tag]) => (
                  <div className="lp-conversation" key={name}>
                    <span>{avatar}</span>
                    <div><strong>{name}</strong><small>{detail}</small></div>
                    <em>{tag}</em>
                  </div>
                ))}
              </div>
            </div>
            <div className="lp-panel lp-big-screen">
              <div className="lp-panel-top">
                <strong>Kanban de tickets</strong>
                <span className="lp-status-pill">sincronizado</span>
              </div>
              <div className="lp-panel-content">
                <div className="lp-kpi-row">
                  <div><span>Prazo medio</span><strong>1d 4h</strong></div>
                  <div><span>Tickets abertos</span><strong>42</strong></div>
                  <div><span>Concluidos</span><strong>186</strong></div>
                </div>
                <div className="lp-kanban-preview">
                  <div><strong>A fazer</strong><span>Compra de materiais</span><span>Cadastro de funcionario</span></div>
                  <div className="active"><strong>Em andamento</strong><span>Notebook para equipe</span><span>Reembolso financeiro</span></div>
                  <div><strong>Concluido</strong><span>Acesso ao sistema</span><span>Documento aprovado</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section" id="assistente">
        <div className="lp-container lp-assistant-strip">
          <div>
            <div className="lp-eyebrow"><span className="lp-pulse-dot" /> Assistente DACHBYTE</div>
            <h2>Escreva o pedido. O DACHBYTE Chat entende e cria o fluxo.</h2>
            <p>
              O assistente interpreta solicitacoes como "abra um ticket para o financeiro" ou "crie uma tarefa para Ana
              ate amanha" e transforma em tickets ou tarefas com prioridade, setor e responsavel.
            </p>
          </div>
          <Link className="lp-btn lp-btn--primary" to="/login">
            Abrir assistente
            <Bot size={18} />
          </Link>
        </div>
      </section>

      <section className="lp-section" id="modulos">
        <div className="lp-container">
          <div className="lp-section-title">
            <div className="lp-eyebrow"><span className="lp-pulse-dot" /> Módulos DACHBYTE Business</div>
            <h2>Conecte comunicacao, tickets e gestao visual em um unico fluxo.</h2>
          </div>
          <div className="lp-modules">
            {moduleCards.map(([badge, title, detail]) => (
              <article className="lp-module-card" key={title}>
                <span>{badge}</span>
                <div><h3>{title}</h3><p>{detail}</p></div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section">
        <div className="lp-container lp-cta-box">
          <div>
            <div className="lp-eyebrow"><span className="lp-pulse-dot" /> Pronto para organizar sua empresa?</div>
            <h2>Transforme comunicacao interna em processo organizado.</h2>
            <p>Use web, desktop, tickets, tarefas, Kanban e assistente inteligente na mesma central.</p>
          </div>
          <div className="lp-cta-actions">
            <Link className="lp-btn lp-btn--primary" to="/login">
              Entrar no DACHBYTE Chat
              <ArrowRight size={18} />
            </Link>
            <a className="lp-btn" href={DESKTOP_DOWNLOAD_URL}>
              <Download size={18} />
              Baixar desktop
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-container">
          <BrandLogo subtitle="" />
          <span>2026 DACHBYTE Chat. Comunicação interna empresarial inteligente.</span>
          <span className="lp-footer-check"><CheckCircle2 size={15} /> Render + Neon</span>
        </div>
      </footer>
    </main>
  );
};

export default Landing;
