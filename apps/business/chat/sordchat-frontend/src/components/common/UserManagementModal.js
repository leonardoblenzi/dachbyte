import React, { useEffect, useMemo, useState } from 'react';
import { Save, Trash2, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE_URL } from '../../config';
import { formatBirthdayInput } from '../../utils/birthdays';
import { usePlatformDialog } from '../../contexts/PlatformDialogContext';

const requestJson = async (path, options = {}) => {
  const response = await fetch(API_BASE_URL + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + localStorage.getItem('token'),
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || 'Operacao nao concluida.');
  }
  return response.json();
};

const UserManagementModal = ({
  companyId,
  currentUserId,
  departments = [],
  isPlatformAdmin = false,
  onChanged,
  onClose,
  userRecord,
}) => {
  const membership = useMemo(
    () =>
      userRecord?.membership ||
      (userRecord?.companies || []).find((item) => item.company_id === companyId) ||
      {},
    [companyId, userRecord],
  );
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dialog = usePlatformDialog();

  useEffect(() => {
    if (!userRecord) return;
    setForm({
      full_name: userRecord.full_name || '',
      nickname: userRecord.nickname || '',
      username: userRecord.username || '',
      email: userRecord.email || '',
      phone: userRecord.phone || '',
      phone_extension: userRecord.phone_extension || '',
      birthday: userRecord.birthday || '',
      role_title: userRecord.role_title || '',
      department_id: membership.department_id || '',
      role: userRecord.is_platform_admin ? 'master_admin' : membership.role || 'user',
      status: membership.status || userRecord.status || 'active',
      password: '',
    });
  }, [membership, userRecord]);

  if (!userRecord) return null;

  const updateField = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const saveUser = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form, company_id: companyId };
      if (!payload.department_id) delete payload.department_id;
      if (isSelf) {
        delete payload.role;
        delete payload.status;
      }
      await requestJson('/users/' + userRecord.id, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      toast.success('Usuario atualizado.');
      await onChanged?.();
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteUser = async () => {
    const confirmation = await dialog.prompt({
      title: "Excluir usuário da empresa?",
      message: "A conta será removida desta empresa e o histórico será preservado.",
      inputLabel: "Digite o e-mail exato para confirmar",
      placeholder: userRecord.email,
      confirmLabel: "Excluir usuário",
      danger: true,
    });
    if (confirmation !== userRecord.email) {
      if (confirmation !== null) toast.error('E-mail nao confere. Exclusao cancelada.');
      return;
    }
    setDeleting(true);
    try {
      const result = await requestJson(
        '/users/' + userRecord.id + '?company_id=' + encodeURIComponent(companyId),
        { method: 'DELETE' },
      );
      toast.success(result.message || 'Usuario excluido da empresa.');
      await onChanged?.();
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setDeleting(false);
    }
  };

  const activeDepartments = departments.filter((item) => item.status !== 'inactive');
  const isSelf = Number(userRecord.id) === Number(currentUserId);

  return (
    <div className="profile-modal" role="dialog" aria-modal="true" aria-label="Editar usuario">
      <section className="profile-modal__panel user-management-modal">
        <header className="profile-modal__header">
          <div>
            <span>Administracao de usuario</span>
            <h2>{userRecord.full_name || userRecord.username}</h2>
          </div>
          <button className="icon-button icon-button--light" type="button" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </header>

        <form className="profile-modal__form" onSubmit={saveUser}>
          <div className="user-management-modal__grid">
            <label>
              Nome completo
              <input className="input" required value={form.full_name || ''} onChange={(event) => updateField('full_name', event.target.value)} />
            </label>
            <label>
              Apelido
              <input className="input" value={form.nickname || ''} onChange={(event) => updateField('nickname', event.target.value)} />
            </label>
            <label>
              Usuario
              <input className="input" required value={form.username || ''} onChange={(event) => updateField('username', event.target.value)} />
            </label>
            <label>
              E-mail
              <input className="input" required type="email" value={form.email || ''} onChange={(event) => updateField('email', event.target.value)} />
            </label>
            <label>
              Telefone
              <input className="input" value={form.phone || ''} onChange={(event) => updateField('phone', event.target.value)} />
            </label>
            <label>
              Ramal
              <input className="input" value={form.phone_extension || ''} onChange={(event) => updateField('phone_extension', event.target.value)} />
            </label>
            <label>
              Nascimento
              <input
                className="input"
                inputMode="numeric"
                maxLength={10}
                value={form.birthday || ''}
                onChange={(event) => updateField('birthday', formatBirthdayInput(event.target.value))}
                placeholder="DD-MM-AA ou DD-MM-AAAA"
              />
            </label>
            <label>
              Cargo
              <input className="input" value={form.role_title || ''} onChange={(event) => updateField('role_title', event.target.value)} />
            </label>
            <label>
              Setor
              <select className="select" required={!userRecord.is_platform_admin} value={form.department_id || ''} onChange={(event) => updateField('department_id', event.target.value)}>
                <option value="">Selecione</option>
                {activeDepartments.map((department) => (
                  <option key={department.id} value={department.id}>{department.name}</option>
                ))}
              </select>
            </label>
            <label>
              Nivel de acesso
              <select className="select" value={form.role || 'user'} onChange={(event) => updateField('role', event.target.value)} disabled={isSelf}>
                <option value="user">Usuario</option>
                <option value="coordinator">Coordenador</option>
                <option value="company_admin">Admin da empresa</option>
                {isPlatformAdmin && <option value="master_admin">Admin Master</option>}
              </select>
            </label>
            <label>
              Status
              <select className="select" value={form.status || 'active'} onChange={(event) => updateField('status', event.target.value)} disabled={isSelf}>
                <option value="active">Ativo</option>
                <option value="inactive">Inativo</option>
              </select>
            </label>
            <label>
              Nova senha
              <input
                className="input"
                minLength={6}
                type="password"
                value={form.password || ''}
                onChange={(event) => updateField('password', event.target.value)}
                placeholder="Opcional; minimo 6 caracteres"
              />
            </label>
          </div>

          <p className="user-management-modal__note">
            Alterar a senha exigira que o usuario defina uma nova senha no proximo acesso.
          </p>

          <footer className="user-management-modal__actions">
            {!isSelf && (
              <button className="button-danger" type="button" onClick={deleteUser} disabled={saving || deleting}>
                <Trash2 size={16} /> {deleting ? 'Excluindo...' : 'Excluir usuario'}
              </button>
            )}
            <span />
            <button className="button-secondary" type="button" onClick={onClose} disabled={saving || deleting}>
              Cancelar
            </button>
            <button className="button-primary" type="submit" disabled={saving || deleting}>
              {saving ? <span className="spinner h-4 w-4" /> : <Save size={16} />}
              {saving ? 'Salvando...' : 'Salvar alteracoes'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
};

export default UserManagementModal;