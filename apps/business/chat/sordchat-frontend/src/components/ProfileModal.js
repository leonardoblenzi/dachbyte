import React, { useEffect, useRef, useState } from 'react';
import { Camera, Save, UserRound, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import { formatBirthdayInput } from '../utils/birthdays';

const compressAvatar = (file) => new Promise((resolve, reject) => {
  if (!file.type.startsWith('image/')) {
    reject(new Error('Selecione uma imagem.'));
    return;
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(file);
  image.onload = () => {
    const scale = Math.min(1, 256 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    URL.revokeObjectURL(objectUrl);
    let quality = 0.76;
    let result = canvas.toDataURL('image/webp', quality);
    while (result.length > 200000 && quality > 0.36) {
      quality -= 0.1;
      result = canvas.toDataURL('image/webp', quality);
    }
    if (result.length > 220000) reject(new Error('A imagem continua muito grande apos compactacao.'));
    else resolve(result);
  };
  image.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    reject(new Error('Nao foi possivel ler a imagem.'));
  };
  image.src = objectUrl;
});

const ProfileModal = ({ open, onClose }) => {
  const { user, updateProfile } = useAuth();
  const fileRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ email: '', nickname: '', phone_extension: '', birthday: '', profile_photo: '' });
  const [themeMode, setThemeMode] = useState('light');
  const [chatFontSize, setChatFontSize] = useState('medium');

  useEffect(() => {
    if (!open) return undefined;

    if (user) {
      setForm({
        email: user.email || '',
        nickname: user.nickname || '',
        phone_extension: user.phone_extension || '',
        birthday: user.birthday || '',
        profile_photo: user.profile_photo || '',
      });
    }

    const storedTheme = localStorage.getItem('voltchat:themeMode') || 'light';
    const storedFontSize = localStorage.getItem('voltchat:chatFontSize') || 'medium';
    setThemeMode(storedTheme);
    setChatFontSize(storedFontSize);
    document.documentElement.classList.toggle('theme-dark', storedTheme === 'dark');
    const fontSizeValue =
      storedFontSize === 'small'
        ? '13px'
        : storedFontSize === 'large'
        ? '17px'
        : '15px';
    document.documentElement.style.setProperty('--chat-font-size', fontSizeValue);

    return undefined;
  }, [open, user]);

  if (!open) return null;

  const handleImage = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const profilePhoto = await compressAvatar(file);
      setForm((current) => ({ ...current, profile_photo: profilePhoto }));
    } catch (error) {
      toast.error(error.message);
    } finally {
      event.target.value = '';
    }
  };

  const handleThemeModeChange = (event) => {
    const nextMode = event.target.checked ? 'dark' : 'light';
    setThemeMode(nextMode);
    localStorage.setItem('voltchat:themeMode', nextMode);
    document.documentElement.classList.toggle('theme-dark', nextMode === 'dark');
  };

  const handleChatFontSizeChange = (event) => {
    const nextSize = event.target.value;
    setChatFontSize(nextSize);
    localStorage.setItem('voltchat:chatFontSize', nextSize);
    const fontSizeValue =
      nextSize === 'small' ? '13px' : nextSize === 'large' ? '17px' : '15px';
    document.documentElement.style.setProperty('--chat-font-size', fontSizeValue);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      await updateProfile(form);
      onClose();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="profile-modal" role="presentation" onMouseDown={onClose}>
      <section className="profile-modal__panel" role="dialog" aria-modal="true" aria-label="Configuracao do perfil" onMouseDown={(event) => event.stopPropagation()}>
        <header className="profile-modal__header">
          <div><span>Minha conta</span><h2>Configuração do perfil</h2></div>
          <button className="icon-button icon-button--light" type="button" onClick={onClose} aria-label="Fechar perfil"><X size={18} /></button>
        </header>
        <form className="profile-modal__form" onSubmit={handleSubmit}>
          <div className="profile-avatar-editor">
            <button type="button" onClick={() => fileRef.current?.click()} aria-label="Alterar foto de perfil">
              {form.profile_photo ? <img src={form.profile_photo} alt="Foto de perfil" /> : <UserRound size={34} />}
              <span><Camera size={15} /></span>
            </button>
            <div><strong>{user?.nickname || user?.full_name || user?.username}</strong><p>A imagem é reduzida para 256 px e salva em WebP.</p></div>
            <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={handleImage} />
          </div>
          <label>Email<input className="input" type="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} required /></label>
          <label>Apelido<input className="input" value={form.nickname} onChange={(event) => setForm((current) => ({ ...current, nickname: event.target.value }))} placeholder="Ex.: Rapha ou Léo" maxLength={80} /><small>Será o nome principal exibido nas conversas. Seu nome completo continuará abaixo.</small></label>
          <label>Ramal<input className="input" value={form.phone_extension} onChange={(event) => setForm((current) => ({ ...current, phone_extension: event.target.value }))} maxLength={40} /></label>
          <label>Data de nascimento (DD-MM-AA ou DD-MM-AAAA)<input className="input" value={form.birthday} onChange={(event) => setForm((current) => ({ ...current, birthday: formatBirthdayInput(event.target.value) }))} placeholder="24-09-2003" inputMode="numeric" maxLength={10} title="Aceita 24/09/03, 24-09-2003 ou 24092003" /></label>

          <div className="profile-modal__preferences">
            <h3>Preferências</h3>
            <label className="profile-modal__toggle">
              <input
                type="checkbox"
                checked={themeMode === 'dark'}
                onChange={handleThemeModeChange}
              />
              <span>Habilitar modo escuro</span>
            </label>
            <label>
              Tamanho do conteúdo das mensagens
              <select
                className="select"
                value={chatFontSize}
                onChange={handleChatFontSizeChange}
              >
                <option value="small">Pequeno</option>
                <option value="medium">Padrão</option>
                <option value="large">Grande</option>
              </select>
            </label>
          </div>

          <button className="button-primary" type="submit" disabled={saving}><Save size={17} />{saving ? 'Salvando...' : 'Salvar perfil'}</button>
        </form>
      </section>
    </div>
  );
};

export default ProfileModal;
