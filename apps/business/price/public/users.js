"use strict";

async function users(root) {
  if (state.me?.isPlatformAdmin && !state.me?.tenantId) {
    root.innerHTML = '<div class="empty">Entre em uma empresa por acesso assistido para gerenciar seus usuarios.</div>';
    return;
  }
  const data = await api("/users");
  const canManage = Boolean(state.me?.isPlatformAdmin || ["owner", "admin"].includes(state.me?.role));
  const roles = ["owner", "admin", "finance", "pricing", "marketing", "analyst", "viewer"];
  const statuses = ["active", "disabled"];

  root.innerHTML = `
    <div class="pagehead"><div><h1>Usuarios e acessos</h1><div class="sub">Perfis e status dos acessos vinculados a esta empresa</div></div><span class="chip">${data.users.length} usuario(s)</span></div>
    <section class="card section"><div class="section-title"><h2>Acessos vinculados</h2><span class="chip ${canManage ? "green" : "amber"}">${canManage ? "Gerenciamento habilitado" : "Somente leitura"}</span></div><div class="table-wrap"><table class="table">
      <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Status</th><th>Acao</th></tr></thead>
      <tbody>${data.users.map((user) => `<tr>
        <td><strong>${escapeHtml(user.full_name)}</strong></td>
        <td>${escapeHtml(user.email)}</td>
        <td><select class="filter" data-role="${user.id}" ${canManage ? "" : "disabled"}>${roles.map((role) => `<option value="${role}" ${role === user.role ? "selected" : ""}>${role}</option>`).join("")}</select></td>
        <td><select class="filter" data-status="${user.id}" ${canManage ? "" : "disabled"}>${statuses.map((status) => `<option value="${status}" ${status === user.status ? "selected" : ""}>${status}</option>`).join("")}</select></td>
        <td>${canManage ? `<button class="primary" data-save-user="${user.id}">Salvar</button>` : '<span class="chip amber">Somente leitura</span>'}</td>
      </tr>`).join("") || '<tr><td colspan="5">Nenhum usuario cadastrado.</td></tr>'}</tbody>
    </table></div></section>
  `;

  root.querySelectorAll("[data-save-user]").forEach((button) => {
    button.onclick = async () => {
      try {
        const userId = button.dataset.saveUser;
        await api(`/users/${userId}`, {
          method: "PATCH",
          body: JSON.stringify({
            role: root.querySelector(`[data-role="${userId}"]`).value,
            status: root.querySelector(`[data-status="${userId}"]`).value,
          }),
        });
        toast("Acesso atualizado.");
        users(root);
      } catch (error) {
        toast(error.message, true);
      }
    };
  });
}
