import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Clock3,
  Download,
  Filter,
  RefreshCw,
  Ticket,
  Users,
} from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../contexts/AuthContext";
import { API_BASE_URL } from "../config";

const requestReport = async (filters) => {
  const query = new URLSearchParams();
  if (filters.dateFrom) query.set("date_from", filters.dateFrom);
  if (filters.dateTo) query.set("date_to", filters.dateTo);
  const response = await fetch(
    `${API_BASE_URL}/tickets/reports/control?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      payload.detail || "Não foi possível gerar o relatório de tickets.",
    );
  }
  return response.json();
};

const formatDateTime = (value) => {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatDuration = (minutes) => {
  if (minutes === null || minutes === undefined) return "Sem dados";
  const total = Math.max(0, Math.round(Number(minutes)));
  if (total < 60) return `${total} min`;
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const rest = total % 60;
  return [
    days ? `${days}d` : "",
    hours ? `${hours}h` : "",
    rest ? `${rest}min` : "",
  ]
    .filter(Boolean)
    .join(" ");
};

const csvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;

const TicketReports = () => {
  const { isCoordinator, isCompanyAdmin } = useAuth();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSectionKey, setActiveSectionKey] = useState("__all__");

  const loadReport = async () => {
    setLoading(true);
    try {
      const data = await requestReport({ dateFrom, dateTo });
      setReport(data);
      const firstSection = data.sections?.[0];
      setActiveSectionKey(firstSection?.department || "__all__");
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeSection = useMemo(
    () =>
      report?.sections?.find(
        (section) => (section.department || "__all__") === activeSectionKey,
      ) ||
      report?.sections?.[0] ||
      null,
    [activeSectionKey, report],
  );

  const filteredTickets = useMemo(() => {
    if (!activeSection?.tickets) return [];
    const term = String(searchQuery || "")
      .trim()
      .toLowerCase();
    if (!term) return activeSection.tickets;
    return activeSection.tickets.filter((item) => {
      const assignedUsers = (item.assigned_users || []).join(" ");
      const departments = (item.departments || []).join(" ");
      return [
        String(item.id),
        item.subject,
        item.opened_by_name,
        assignedUsers,
        departments,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [activeSection, searchQuery]);

  if (!isCoordinator()) {
    return <Navigate to="/tickets" replace />;
  }

  const exportCsv = () => {
    if (!activeSection) return;
    const headers = [
      "ID",
      "Assunto",
      "Prioridade",
      "Status",
      "Setores",
      "Aberto por",
      "Aberto em",
      "Responsáveis",
      "Primeira resposta (min)",
      "Fechado por",
      "Fechado em",
      "Motivo do fechamento",
      "Tempo total (min)",
      "Avaliação",
      "Comentário da avaliação",
    ];
    const rows = filteredTickets.map((item) => [
      item.id,
      item.subject,
      item.priority,
      item.status,
      item.departments.join(", "),
      item.opened_by_name,
      formatDateTime(item.opened_at),
      item.assigned_users.join(", "),
      item.first_response_minutes,
      item.closed_by_name,
      formatDateTime(item.closed_at),
      item.close_reason,
      item.total_progress_minutes,
      item.rating_score,
      item.rating_comment,
    ]);
    const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const sectionName = activeSection.department || "empresa";
    link.href = url;
    link.download = `relatorio-tickets-${sectionName.toLowerCase().replace(/[^a-z0-9]+/gi, "-")}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const summary = activeSection?.summary || {};
  const metrics = [
    ["Total de tickets", summary.total_tickets || 0, Ticket, "Todos"],
    ["Abertos", summary.open_tickets || 0, Clock3, "Aberto"],
    ["Fechados", summary.closed_tickets || 0, CheckCircle2, "Resolvido"],
    ["Em andamento", summary.in_progress_tickets || 0, BarChart3, "Em andamento"],
  ];

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <span className="badge">Controle operacional</span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">
              Relatório completo de tickets
            </h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Acompanhe volume, responsáveis, tempos de resposta, duração total
              e motivos de fechamento.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link className="button-secondary" to="/tickets">
              <ArrowLeft size={17} />
              Tickets
            </Link>
            <button
              className="button-secondary"
              type="button"
              onClick={loadReport}
              disabled={loading}
            >
              <RefreshCw size={17} />
              Atualizar
            </button>
            <button
              className="button-primary"
              type="button"
              onClick={exportCsv}
              disabled={!activeSection || loading}
            >
              <Download size={17} />
              Baixar CSV
            </button>
          </div>
        </div>

        <form
          className="mt-5 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            loadReport();
          }}
        >
          <label className="grid gap-1 text-xs font-extrabold text-slate-600">
            Buscar tickets
            <input
              className="input"
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="ID, assunto, usuário ou setor"
            />
          </label>
          <label className="grid gap-1 text-xs font-extrabold text-slate-600">
            Abertos a partir de
            <input
              className="input"
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-xs font-extrabold text-slate-600">
            Abertos até
            <input
              className="input"
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          <button className="button-secondary" type="submit">
            <Filter size={16} />
            Aplicar período
          </button>
          {(dateFrom || dateTo || searchQuery) && (
            <button
              className="button-secondary"
              type="button"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
                setSearchQuery("");
              }}
            >
              Limpar filtros
            </button>
          )}
        </form>
      </section>

      {report?.sections?.length > 1 && isCompanyAdmin() && (
        <section
          className="panel flex gap-2 overflow-x-auto p-3"
          aria-label="Setores do relatório"
        >
          {report.sections.map((section) => {
            const key = section.department || "__all__";
            return (
              <button
                className={`button-secondary whitespace-nowrap ${activeSectionKey === key ? "button-secondary--active" : ""}`}
                key={key}
                type="button"
                onClick={() => setActiveSectionKey(key)}
              >
                {section.department || "Geral da empresa"}
                <span className="badge">{section.summary.total_tickets}</span>
              </button>
            );
          })}
        </section>
      )}

      {loading ? (
        <section className="empty-state panel">
          <div className="spinner h-6 w-6" />
          <h2>Gerando relatório</h2>
        </section>
      ) : !activeSection ? (
        <section className="empty-state panel">
          <Ticket size={30} />
          <h2>Relatório indisponível</h2>
        </section>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {metrics.map(([label, value, Icon, ticketStatus]) => (
              <Link
                className="metric-card block cursor-pointer no-underline transition-transform hover:-translate-y-0.5"
                key={label}
                to={`/tickets?management=1&status=${encodeURIComponent(ticketStatus)}`}
                title={`Abrir ${label.toLowerCase()} na visao gerencial`}
              >
                <div className="flex items-center justify-between">
                  <p className="m-0 text-sm font-bold text-slate-500">
                    {label}
                  </p>
                  <Icon size={19} className="text-blue-600" />
                </div>
                <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">
                  {value}
                </p>
                <p className="m-0 mt-2 text-xs font-bold text-blue-600">
                  Ver tickets deste status
                </p>
              </Link>
            ))}
          </section>

          <section className="grid gap-4 md:grid-cols-2">
            <article className="metric-card">
              <p className="m-0 text-sm font-bold text-slate-500">
                Média da primeira resposta
              </p>
              <p className="m-0 mt-2 text-2xl font-extrabold text-slate-950">
                {formatDuration(summary.average_first_response_minutes)}
              </p>
            </article>
            <article className="metric-card">
              <p className="m-0 text-sm font-bold text-slate-500">
                Média total de andamento até o fechamento
              </p>
              <p className="m-0 mt-2 text-2xl font-extrabold text-slate-950">
                {formatDuration(summary.average_total_progress_minutes)}
              </p>
            </article>
          </section>

          <section className="panel overflow-hidden">
            <header className="border-b border-slate-200 p-4">
              <div className="flex items-center gap-2">
                <Users size={19} className="text-blue-600" />
                <h3 className="m-0 text-lg font-extrabold text-slate-950">
                  Desempenho por usuário
                </h3>
              </div>
              <p className="m-0 mt-1 text-sm text-slate-500">
                A média considera o intervalo até a resposta quando o autor da
                conversa muda.
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="data-table min-w-[980px]">
                <thead>
                  <tr>
                    <th>Usuário</th>
                    <th>Atribuídos</th>
                    <th>Respondidos</th>
                    <th>Mensagens</th>
                    <th>Respostas medidas</th>
                    <th>Média de resposta</th>
                    <th>Abertos por ele</th>
                    <th>Fechados por ele</th>
                  </tr>
                </thead>
                <tbody>
                  {activeSection.users.map((item) => (
                    <tr key={item.user_id}>
                      <td>
                        <strong>{item.user_name}</strong>
                      </td>
                      <td>{item.assigned_tickets}</td>
                      <td>{item.tickets_responded}</td>
                      <td>{item.messages_sent}</td>
                      <td>{item.responses_measured}</td>
                      <td>{formatDuration(item.average_response_minutes)}</td>
                      <td>{item.opened_tickets}</td>
                      <td>{item.closed_tickets}</td>
                    </tr>
                  ))}
                  {activeSection.users.length === 0 && (
                    <tr>
                      <td colSpan="8">
                        Nenhuma atividade registrada no período.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel overflow-hidden">
            <header className="border-b border-slate-200 p-4">
              <h3 className="m-0 text-lg font-extrabold text-slate-950">
                Controle detalhado dos tickets
              </h3>
              <p className="m-0 mt-1 text-sm text-slate-500">
                Quem abriu, responsáveis, datas, fechamento e motivo informado.
              </p>
            </header>
            <div className="overflow-x-auto">
              <table className="data-table min-w-[1500px]">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Assunto</th>
                    <th>Status</th>
                    <th>Setores</th>
                    <th>Aberto por</th>
                    <th>Abertura</th>
                    <th>Responsáveis</th>
                    <th>1ª resposta</th>
                    <th>Fechado por</th>
                    <th>Fechamento</th>
                    <th>Motivo</th>
                    <th>Tempo total</th>
                    <th>Avaliação</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTickets.map((item) => (
                    <tr key={item.id}>
                      <td>#{item.id}</td>
                      <td>
                        <strong>{item.subject}</strong>
                        <span
                          className="block max-w-xs truncate text-xs text-slate-500"
                          title={item.description}
                        >
                          {item.description}
                        </span>
                      </td>
                      <td>
                        <span className="badge">{item.status}</span>
                      </td>
                      <td>{item.departments.join(", ")}</td>
                      <td>{item.opened_by_name}</td>
                      <td>{formatDateTime(item.opened_at)}</td>
                      <td>
                        {item.assigned_users.join(", ") || "Não atribuído"}
                      </td>
                      <td>{formatDuration(item.first_response_minutes)}</td>
                      <td>{item.closed_by_name || "-"}</td>
                      <td>{formatDateTime(item.closed_at)}</td>
                      <td>
                        <span className="block max-w-sm whitespace-normal">
                          {item.close_reason || "-"}
                        </span>
                      </td>
                      <td>{formatDuration(item.total_progress_minutes)}</td>
                      <td>
                        {item.rating_score ? `${item.rating_score}/5` : "-"}
                      </td>
                    </tr>
                  ))}
                  {filteredTickets.length === 0 && (
                    <tr>
                      <td colSpan="13">
                        Nenhum ticket encontrado com os filtros aplicados.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default TicketReports;
