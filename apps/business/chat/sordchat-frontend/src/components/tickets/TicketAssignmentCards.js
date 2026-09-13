import React from "react";
import { Building2, Check, UserRound } from "lucide-react";

const TicketAssignmentCards = ({
  users = [],
  departments = [],
  selectedUserIds = [],
  selectedDepartments = [],
  onToggleUser = () => {},
  onToggleDepartment = () => {},
}) => {
  const safeUsers = Array.isArray(users) ? users : [];
  const safeDepartments = Array.isArray(departments) ? departments : [];
  const safeSelectedUserIds = Array.isArray(selectedUserIds)
    ? selectedUserIds.map(String)
    : [];
  const safeSelectedDepartments = Array.isArray(selectedDepartments)
    ? selectedDepartments.map(String)
    : [];

  return (
    <div className="ticket-assignment-grid">
      <fieldset className="ticket-assignment-group">
        <legend><UserRound size={17} /> Pessoas com acesso ao ticket</legend>
        <div className="ticket-assignment-list">
          {safeUsers.map((user) => {
            const id = String(user.id);
            const selected = safeSelectedUserIds.includes(id);
            return (
              <button
                className={`ticket-assignment-card ${selected ? "ticket-assignment-card--selected" : ""}`}
                type="button"
                key={id}
                aria-pressed={selected}
                onClick={() => onToggleUser(id)}
              >
                <span className="ticket-assignment-card__avatar">
                  {(user.full_name || user.username || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="ticket-assignment-card__text">
                  <strong>{user.full_name || user.username || `Usuario #${id}`}</strong>
                  {user.username ? <small>@{user.username}</small> : null}
                </span>
                <span className="ticket-assignment-card__check"><Check size={15} /></span>
              </button>
            );
          })}
        </div>
        <p className="ticket-assignment-note">
          Somente as pessoas selecionadas, o solicitante e os administradores recebem acesso normal ao conteúdo do ticket.
        </p>
      </fieldset>

      <fieldset className="ticket-assignment-group">
        <legend><Building2 size={17} /> Setores / departamentos</legend>
        <div className="ticket-assignment-list">
          {safeDepartments.map((department) => {
            const name = String(department);
            const selected = safeSelectedDepartments.includes(name);
            return (
              <button
                className={`ticket-assignment-card ticket-assignment-card--department ${selected ? "ticket-assignment-card--selected" : ""}`}
                type="button"
                key={name}
                aria-pressed={selected}
                onClick={() => onToggleDepartment(name)}
              >
                <span className="ticket-assignment-card__avatar">
                  <Building2 size={16} />
                </span>
                <span className="ticket-assignment-card__text">
                  <strong>{name}</strong>
                  <small>Classificação do ticket</small>
                </span>
                <span className="ticket-assignment-card__check"><Check size={15} /></span>
              </button>
            );
          })}
        </div>
        {!safeDepartments.length ? (
          <p className="ticket-assignment-note">Nenhum setor ativo disponível.</p>
        ) : (
          <p className="ticket-assignment-note">
            Marcar um setor não libera o ticket para os usuários desse setor. A visibilidade continua restrita às pessoas selecionadas. Coordenadores usam o setor apenas na visão gerencial.
          </p>
        )}
      </fieldset>
    </div>
  );
};

export default TicketAssignmentCards;
