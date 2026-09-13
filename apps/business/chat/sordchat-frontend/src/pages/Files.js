import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileArchive, FileText, Image as ImageIcon, Paperclip, RefreshCw, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import { API_BASE_URL } from '../config';
import { ACCEPTED_UPLOAD_TYPES } from '../constants/uploads';
import { downloadAuthenticatedFile } from '../utils/downloads';

const formatBytes = (bytes = 0) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

const getFileIcon = (contentType = '') => {
  if (contentType.startsWith('image/')) return ImageIcon;
  if (contentType.includes('zip') || contentType.includes('compressed')) return FileArchive;
  return FileText;
};

const Files = () => {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const loadFiles = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/files/`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (!response.ok) {
        throw new Error('Nao foi possivel carregar arquivos.');
      }
      setFiles(await response.json());
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totals = useMemo(
    () => ({
      count: files.length,
      size: files.reduce((sum, item) => sum + Number(item.file_size || 0), 0),
      images: files.filter((item) => String(item.content_type || '').startsWith('image/')).length,
    }),
    [files]
  );

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch(`${API_BASE_URL}/files/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || 'Nao foi possivel enviar o arquivo.');
      }

      toast.success('Arquivo enviado.');
      await loadFiles();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleDownload = async (file) => {
    try {
      const savedPath = await downloadAuthenticatedFile(file.id, file.filename);
      toast.success(savedPath ? `Arquivo salvo em ${savedPath}` : 'Download iniciado.');
    } catch (error) {
      toast.error(error.message);
    }
  };

  return (
    <div className="work-page">
      <section className="panel p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <span className="badge">Arquivos</span>
            <h2 className="m-0 mt-3 text-2xl font-extrabold text-slate-950">Central de anexos</h2>
            <p className="m-0 mt-1 text-sm text-slate-500">
              Envie documentos, imagens e materiais de apoio usados nas conversas do time.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="button-secondary" type="button" onClick={loadFiles} disabled={loading}>
              <RefreshCw size={17} />
              Atualizar
            </button>
            <input ref={fileInputRef} accept={ACCEPTED_UPLOAD_TYPES} className="hidden" type="file" onChange={handleUpload} />
            <button className="button-primary" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? <span className="spinner h-4 w-4" /> : <Upload size={17} />}
              Enviar arquivo
            </button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <article className="metric-card">
          <p className="m-0 text-sm font-bold text-slate-500">Arquivos</p>
          <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">{totals.count}</p>
        </article>
        <article className="metric-card">
          <p className="m-0 text-sm font-bold text-slate-500">Espaco usado</p>
          <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">{formatBytes(totals.size)}</p>
        </article>
        <article className="metric-card">
          <p className="m-0 text-sm font-bold text-slate-500">Imagens</p>
          <p className="m-0 mt-2 text-3xl font-extrabold text-slate-950">{totals.images}</p>
        </article>
      </section>

      <section className="grid gap-3">
        {loading ? (
          <section className="empty-state">
            <div className="spinner h-6 w-6" />
            <h2>Carregando arquivos</h2>
          </section>
        ) : files.length === 0 ? (
          <section className="empty-state">
            <div className="empty-state__icon">
              <Paperclip size={28} />
            </div>
            <h2>Nenhum arquivo enviado</h2>
            <p>Use o botao de envio para adicionar o primeiro anexo.</p>
          </section>
        ) : (
          files.map((file) => {
            const Icon = getFileIcon(file.content_type);
            return (
              <article className="panel p-4" key={file.id}>
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-11 w-11 place-items-center rounded-lg bg-teal-50 text-teal-700">
                      <Icon size={21} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="m-0 truncate text-sm font-extrabold text-slate-950">{file.filename}</h3>
                      <p className="m-0 mt-1 text-xs font-bold text-slate-500">
                        {formatBytes(file.file_size)} - {file.content_type || 'application/octet-stream'}
                      </p>
                    </div>
                  </div>
                  <button className="button-secondary" type="button" onClick={() => handleDownload(file)}>
                    <Download size={17} />
                    Baixar
                  </button>
                </div>
              </article>
            );
          })
        )}
      </section>
    </div>
  );
};

export default Files;
