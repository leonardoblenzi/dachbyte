import React from 'react';
import { CheckCircle2, Clock3, Ticket } from 'lucide-react';
import { Link } from 'react-router-dom';

const BoltTicketSummary = ({ result, compact = false, onOpen }) => {
  const summary = result?.ticket_summary || {};
  const tickets = summary.tickets || [];
  const visibleTickets = compact ? tickets.slice(0, 5) : tickets;

  return (
    <div className={'bolt-ticket-summary ' + (compact ? 'bolt-ticket-summary--compact' : '')}>
      <div className="bolt-ticket-summary__heading">
        <span className="assistant-created__icon"><Ticket size={21} /></span>
        <div>
          <span className="badge badge--success"><CheckCircle2 size={13} /> Resumo atualizado</span>
          <h3>Seus tickets em aberto</h3>
          <p>{result.reply}</p>
        </div>
      </div>

      <div className="bolt-ticket-summary__stats">
        <div><strong>{summary.open_ticket_count || 0}</strong><span>Em aberto</span></div>
        <div className="is-waiting"><strong>{summary.awaiting_user_response_count || 0}</strong><span>Aguardando você</span></div>
        <div><strong>{summary.awaiting_other_response_count || 0}</strong><span>Aguardando outros</span></div>
      </div>

      {visibleTickets.length > 0 && (
        <div className="bolt-ticket-summary__list">
          {visibleTickets.map((ticket) => (
            <div key={ticket.id} className={ticket.awaiting_user_response ? 'is-waiting' : ''}>
              <span className="bolt-ticket-summary__ticket-id">#{ticket.id}</span>
              <span className="bolt-ticket-summary__ticket-title">{ticket.title}</span>
              <span className="bolt-ticket-summary__ticket-state">
                <Clock3 size={13} />
                {ticket.waiting_label}
              </span>
            </div>
          ))}
          {compact && tickets.length > visibleTickets.length && (
            <small>Mais {tickets.length - visibleTickets.length} ticket(s) na tela de tickets.</small>
          )}
        </div>
      )}

      <Link className="button-secondary" to="/tickets" onClick={onOpen}>
        Abrir tickets
      </Link>
    </div>
  );
};

export default BoltTicketSummary;