import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Building2, Eye, Loader2, MessageSquareText, Search, ShieldCheck, Users } from "lucide-react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../../config";

const requestJson = async (path) => {
  const response = await fetch(`${API_BASE_URL}${path}`, { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "Nao foi possivel carregar o controle interno.");
  }
  return response.json();
};

const initials = (value) => String(value || "U").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
const Avatar = ({ item, group = false }) => (
  <span className={`internal-control-avatar ${group ? "internal-control-avatar--group" : ""}`}>
    {item?.profile_photo ? <img src={item.profile_photo} alt="" /> : group ? <Users size={20} /> : initials(item?.display_name || item?.full_name || item?.name)}
  </span>
);
const formatTime = (value) => value ? new Date(value).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";

const InternalControlPanel = ({ companyId, users = [] }) => {
  const [query, setQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);

  useEffect(() => {
    setSelectedUser(null); setConversations([]); setSelectedConversation(null); setMessages([]);
  }, [companyId]);

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    return users.filter((item) => !term || [item.display_name, item.full_name, item.nickname, item.username, item.email, item.department, item.membership?.department_name].join(" ").toLowerCase().includes(term));
  }, [query, users]);

  const openUser = async (item) => {
    setSelectedUser(item); setSelectedConversation(null); setMessages([]); setLoadingConversations(true);
    try {
      const data = await requestJson(`/company-admin/internal-control/users/${item.id}/conversations?company_id=${encodeURIComponent(companyId)}`);
      setSelectedUser(data.user); setConversations(data.conversations || []);
    } catch (error) {
      toast.error(error.message); setSelectedUser(null); setConversations([]);
    } finally { setLoadingConversations(false); }
  };

  const openConversation = async (conversation) => {
    if (!selectedUser) return;
    setSelectedConversation(conversation); setLoadingMessages(true);
    try {
      const params = new URLSearchParams({ company_id: companyId, kind: conversation.kind, limit: "200" });
      if (conversation.id !== null && conversation.id !== undefined) params.set("conversation_id", String(conversation.id));
      const data = await requestJson(`/company-admin/internal-control/users/${selectedUser.id}/messages?${params.toString()}`);
      setMessages(data.messages || []);
    } catch (error) { toast.error(error.message); setMessages([]); }
    finally { setLoadingMessages(false); }
  };

  if (!selectedUser) return (
    <section className="panel internal-control p-5">
      <header className="internal-control-heading">
        <div>
          <span className="badge"><ShieldCheck size={13} /> Acesso administrativo</span>
          <h3>Controle Interno</h3>
          <p>Selecione um usuario da empresa para visualizar seus chats em modo somente leitura.</p>
        </div>
        <label className="internal-control-search"><Search size={17} /><input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar usuario, email ou setor" /></label>
      </header>
      <div className="internal-control-users">
        {filteredUsers.map((item) => (
          <button className="internal-control-user-card" type="button" key={item.id} onClick={() => openUser(item)}>
            <Avatar item={item} />
            <span className="internal-control-user-card__identity">
              <strong>{item.display_name || item.full_name}</strong>
              {item.nickname && item.nickname !== item.full_name && <small>({item.full_name})</small>}
              <em>{item.email || `@${item.username}`}</em>
            </span>
            <span className="internal-control-user-card__department"><Building2 size={13} /> {item.membership?.department_name || item.department || "Sem setor"}</span>
            <span className="internal-control-user-card__action"><Eye size={15} /> Acessar chats</span>
          </button>
        ))}
        {!filteredUsers.length && <div className="dashboard-empty"><Users size={18} /> Nenhum usuario encontrado.</div>}
      </div>
    </section>
  );

  return (
    <section className="panel internal-control internal-control--viewer">
      <header className="internal-control-viewer-head">
        <button className="button-secondary" type="button" onClick={() => setSelectedUser(null)}><ArrowLeft size={16} /> Usuarios</button>
        <Avatar item={selectedUser} />
        <div><span>Visualizando como</span><strong>{selectedUser.display_name || selectedUser.full_name}</strong><small>Somente leitura - acao registrada na auditoria</small></div>
        <span className="badge"><Eye size={13} /> Controle Interno</span>
      </header>
      <div className="internal-control-chat-layout">
        <aside className="internal-control-conversations">
          <div className="internal-control-column-title"><MessageSquareText size={16} /><strong>Chats do usuario</strong><span>{conversations.length}</span></div>
          {loadingConversations ? <div className="dashboard-empty"><Loader2 className="animate-spin" size={18} /> Carregando chats...</div> : conversations.map((conversation) => (
            <button className={`internal-control-conversation ${selectedConversation?.key === conversation.key ? "active" : ""}`} type="button" key={conversation.key} onClick={() => openConversation(conversation)}>
              <Avatar item={{ profile_photo: conversation.profile_photo, name: conversation.name }} group={conversation.kind === "group"} />
              <span><strong>{conversation.name}</strong><small>{conversation.last_message?.content || conversation.subtitle || "Sem mensagens"}</small></span>
              <time>{formatTime(conversation.last_message?.timestamp)}</time>
            </button>
          ))}
          {!loadingConversations && !conversations.length && <div className="dashboard-empty">Nenhum chat encontrado.</div>}
        </aside>
        <main className="internal-control-thread">
          {!selectedConversation ? (
            <div className="internal-control-thread-empty"><MessageSquareText size={34} /><strong>Selecione uma conversa</strong><p>O historico sera mostrado na perspectiva deste usuario, sem opcao de enviar ou alterar mensagens.</p></div>
          ) : (<>
            <header className="internal-control-thread-head">
              <Avatar item={{ profile_photo: selectedConversation.profile_photo, name: selectedConversation.name }} group={selectedConversation.kind === "group"} />
              <div><strong>{selectedConversation.name}</strong><small>{selectedConversation.subtitle}</small></div><span className="badge">Somente leitura</span>
            </header>
            <div className="internal-control-messages">
              {loadingMessages ? <div className="dashboard-empty"><Loader2 className="animate-spin" size={18} /> Carregando mensagens...</div> : messages.map((message) => {
                const own = Number(message.sender_id) === Number(selectedUser.id);
                return <div className={`internal-control-message ${own ? "internal-control-message--own" : ""}`} key={message.id}><span>{selectedConversation.kind === "group" && <strong>{message.sender_name}</strong>}<p>{message.content || (message.message_type === "file" ? "Arquivo compartilhado" : "Mensagem")}</p><time>{formatTime(message.timestamp)}</time></span></div>;
              })}
              {!loadingMessages && !messages.length && <div className="dashboard-empty">Nenhuma mensagem nesta conversa.</div>}
            </div>
            <footer className="internal-control-readonly"><ShieldCheck size={15} /> Visualizacao administrativa: envio e edicao estao desabilitados.</footer>
          </>)}
        </main>
      </div>
    </section>
  );
};

export default InternalControlPanel;