import React, { useEffect } from 'react';
import { Download, FileArchive, ShieldCheck, X } from 'lucide-react';
import { DESKTOP_PACKAGE_DOWNLOAD_URL } from '../../config';

const installationSteps = [
  {
    title: 'Baixe e extraia o pacote',
    detail: 'Clique em Baixar pacote ZIP e, no Explorador de Arquivos, use Extrair tudo antes de abrir os arquivos.',
  },
  {
    title: 'Instale o certificado',
    detail: 'Clique com o botao direito em Instalar-Certificado.ps1 e escolha Executar com PowerShell. Confirme a permissao de administrador.',
  },
  {
    title: 'Opcao manual do certificado',
    detail: 'Abra o arquivo .cer, clique em Instalar Certificado, escolha Maquina Local e instale em Autoridades de Certificacao Raiz Confiaveis. Repita o processo escolhendo Editores Confiaveis.',
  },
  {
    title: 'Instale o DACHBYTE Chat',
    detail: 'Depois do certificado, execute o arquivo de instalação baixado e confirme a instalação. O README dentro do ZIP contém o passo a passo completo.',
  },
];

const DesktopInstallModal = ({ onClose }) => {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div className="desktop-install-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="desktop-install-modal__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-install-title"
      >
        <button className="desktop-install-modal__close" type="button" onClick={onClose} aria-label="Fechar">
          <X size={20} />
        </button>

        <div className="desktop-install-modal__heading">
          <span><ShieldCheck size={28} /></span>
          <div>
            <small>DACHBYTE Chat para Windows</small>
            <h2 id="desktop-install-title">Instale o aplicativo com o certificado atual</h2>
            <p>O pacote inclui o instalador, o certificado publico, um script de instalacao e um README detalhado.</p>
          </div>
        </div>

        <ol className="desktop-install-steps">
          {installationSteps.map((step, index) => (
            <li key={step.title}>
              <span>{index + 1}</span>
              <div><strong>{step.title}</strong><p>{step.detail}</p></div>
            </li>
          ))}
        </ol>

        <div className="desktop-install-modal__notice">
          <FileArchive size={20} />
          <span>Extraia o ZIP antes de executar. Confirme o certificado atual com final de impressão digital 984D65.</span>
        </div>

        <a
          className="lp-btn lp-btn--primary desktop-install-modal__download"
          href={DESKTOP_PACKAGE_DOWNLOAD_URL}
          target="_blank"
          rel="noreferrer"
        >
          <Download size={19} />
          Baixar pacote ZIP
        </a>
      </section>
    </div>
  );
};

export default DesktopInstallModal;
