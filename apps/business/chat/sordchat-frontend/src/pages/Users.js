import React, { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Cake,
  Mail,
  MessageCircle,
  Pencil,
  PhoneCall,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRoundCheck,
  Users as UsersIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../config";
import { formatBirthday, isBirthdayToday } from "../utils/birthdays";
import { useAuth } from "../contexts/AuthContext";
import UserManagementModal from "../components/common/UserManagementModal";

const accessLabel = {
  master: "Administrador",
  coordenador: "Coordenador",
  usuario: "Usuario",
  company_admin: "Admin da empresa",
  coordinator: "Coordenador",
  user: "Usuario",
};

const membershipForCompany = (item, companyId) =>
  (item.companies || []).find(
    (membership) => membership.company_id === companyId,
  );

const Users = () => {
  const { user, isCompanyAdmin, isPlatformAdmin } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [departments, setDepartments] = useState([]);
  const [editingUser, setEditingUser] = useState(null);

  const loadCompanies = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/companies/available`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      });
      if (!response.ok)
        throw new Error("Nao foi possivel carregar as empresas.");
      const data = await response.json();
      setCompanies(data);
      setSelectedCompanyId(
        (current) =>
          current || (isPlatformAdmin() ? data[0]?.id : user?.company_id) || "",
      );
    } catch (error) {
      toast.error(error.message);
      setLoading(false);
    }
  };

  const loadUsers = async (companyId = selectedCompanyId) => {
    if (!companyId) return;
    setLoading(true);
    try {
      const response = await fetch(
        `${API_BASE_URL}/users/?company_id=${encodeURIComponent(companyId)}`,
        {
          headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
        },
      );
      if (!response.ok) {
        throw new Error("Nao foi possivel carregar usuarios.");
      }
      setUsers(await response.json());
      if (isCompanyAdmin()) {
        const overviewResponse = await fetch(
          API_BASE_URL + "/company-admin/overview?company_id=" + encodeURIComponent(companyId),
          { headers: { Authorization: "Bearer " + localStorage.getItem("token") } },
        );
        if (overviewResponse.ok) {
          const overview = await overviewResponse.json();
          setDepartments(overview.departments || []);
        }
      }
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCompanies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlatformAdmin, user?.company_id]);

  useEffect(() => {
    if (selectedCompanyId) loadUsers(selectedCompanyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId]);

  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return users;
    return users.filter((item) => {
      const membership = membershipForCompany(item, selectedCompanyId);
      return [
        item.full_name,
        item.username,
        item.email,
        item.access_level,
        membership?.department_name,
        membership?.company_name,
        item.role_title,
        item.phone_extension,
      ]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [query, selectedCompanyId, users]);

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="badge">Equipe</span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">
              Usuarios e permissoes
            </h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Consulte contas ativas, perfis de acesso e contatos do workspace.
            </p>
          </div>
          <button
            className="button-secondary"
            type="button"
            onClick={() => loadUsers(selectedCompanyId)}
            disabled={loading}
          >
            <RefreshCw size={17} />
            Atualizar
          </button>
        </div>
      </section>

      {isPlatformAdmin() && (
        <section
          className="company-tags"
          aria-label="Filtrar usuarios por empresa"
        >
          {companies.map((company) => (
            <button
              className={company.id === selectedCompanyId ? "active" : ""}
              key={company.id}
              type="button"
              onClick={() => setSelectedCompanyId(company.id)}
            >
              <Building2 size={15} />
              {company.name}
            </button>
          ))}
        </section>
      )}

      <section className="grid gap-4 md:grid-cols-3">
        <article className="metric-card">
          <p className="m-0 text-sm font-bold text-slate-500">Usuarios</p>
          <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">
            {users.length}
          </p>
        </article>
        <article className="metric-card">
          <p className="m-0 text-sm font-bold text-slate-500">
            Administradores
          </p>
          <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">
            {
              users.filter((item) =>
                ["company_admin", "master_admin"].includes(
                  membershipForCompany(item, selectedCompanyId)?.role,
                ),
              ).length
            }
          </p>
        </article>
        <article className="metric-card">
          <p className="m-0 text-sm font-bold text-slate-500">Ativos</p>
          <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">
            {users.filter((item) => item.is_active).length}
          </p>
        </article>
      </section>

      <section className="relative w-full max-w-md">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          size={17}
        />
        <input
          className="input pl-10"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar usuario"
        />
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {loading ? (
          <section className="empty-state md:col-span-2 xl:col-span-3">
            <div className="spinner h-6 w-6" />
            <h2>Carregando usuarios</h2>
          </section>
        ) : filteredUsers.length === 0 ? (
          <section className="empty-state md:col-span-2 xl:col-span-3">
            <div className="empty-state__icon">
              <UsersIcon size={28} />
            </div>
            <h2>Nenhum usuario encontrado</h2>
            <p>Ajuste o termo de busca.</p>
          </section>
        ) : (
          filteredUsers.map((item) => (
            <article className="panel p-4" key={item.id}>
              <div className="flex items-start gap-3">
                <div
                  className={`birthday-list-avatar ${isBirthdayToday(item.birthday) ? "birthday-list-avatar--festive" : ""}`}
                >
                  {item.profile_photo ? (
                    <img src={item.profile_photo} alt="" />
                  ) : (
                    (item.full_name || item.username || "U")
                      .charAt(0)
                      .toUpperCase()
                  )}
                  {isBirthdayToday(item.birthday) && (
                    <>
                      <span className="party-hat" />
                      <span className="avatar-confetti avatar-confetti--one" />
                      <span className="avatar-confetti avatar-confetti--two" />
                      <span className="avatar-confetti avatar-confetti--three" />
                    </>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="m-0 truncate text-base font-extrabold text-slate-950">
                    {item.full_name || item.username}
                  </h3>
                  <p className="m-0 text-sm text-slate-500">@{item.username}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span
                      className={`badge ${item.is_active ? "badge--success" : "badge--danger"}`}
                    >
                      <UserRoundCheck size={13} />
                      {item.is_active ? "Ativo" : "Inativo"}
                    </span>
                    <span className="badge">
                      <ShieldCheck size={13} />
                      {accessLabel[
                        membershipForCompany(item, selectedCompanyId)?.role
                      ] ||
                        accessLabel[item.access_level] ||
                        item.access_level}
                    </span>
                    <span className="badge">
                      <Building2 size={13} />
                      {
                        membershipForCompany(item, selectedCompanyId)
                          ?.company_name
                      }
                    </span>
                    {membershipForCompany(item, selectedCompanyId)
                      ?.department_name && (
                      <span className="badge">
                        {
                          membershipForCompany(item, selectedCompanyId)
                            .department_name
                        }
                      </span>
                    )}
                  </div>
                  <p className="m-0 mt-3 flex items-center gap-2 text-sm text-slate-500">
                    <Mail size={15} />
                    <span className="truncate">{item.email}</span>
                  </p>
                  {item.role_title && (
                    <p className="m-0 mt-2 text-sm text-slate-500">
                      {item.role_title}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.phone_extension && (
                      <span className="badge">
                        <PhoneCall size={13} />
                        Ramal {item.phone_extension}
                      </span>
                    )}
                    {item.birthday && (
                      <span className="badge">
                        <Cake size={13} />
                        {formatBirthday(item.birthday)}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {item.id !== user?.id && (
                      <button
                        className="button-secondary"
                        type="button"
                        onClick={() =>
                          navigate("/chat", { state: { startChatUser: item } })
                        }
                      >
                        <MessageCircle size={15} /> Iniciar chat
                      </button>
                    )}
                    {isCompanyAdmin() && (
                      <button
                        className="button-secondary"
                        type="button"
                        onClick={() => setEditingUser(item)}
                      >
                        <Pencil size={15} /> Editar / excluir
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </article>
          ))
        )}
      </section>

      <UserManagementModal
        companyId={selectedCompanyId}
        currentUserId={user?.id}
        departments={departments}
        isPlatformAdmin={isPlatformAdmin()}
        onChanged={() => loadUsers(selectedCompanyId)}
        onClose={() => setEditingUser(null)}
        userRecord={editingUser}
      />
    </div>
  );
};

export default Users;
