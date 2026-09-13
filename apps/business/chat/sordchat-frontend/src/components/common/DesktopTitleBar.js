import React, { useEffect, useState } from 'react';

const publicUrl = process.env.PUBLIC_URL || '';

const DesktopTitleBar = () => {
  const [version, setVersion] = useState('');

  useEffect(() => {
    let active = true;
    window.voltChatDesktop?.getAppVersion?.()
      .then((value) => { if (active) setVersion(value); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  return (
    <header className="desktop-titlebar" aria-label="Barra do aplicativo DACHBYTE Chat">
      <div className="desktop-titlebar__brand">
        <span className="desktop-titlebar__logo-wrap">
          <img src={`${publicUrl}/brand/dachbyte/business/mark.svg`} alt="" />
        </span>
        <span className="desktop-titlebar__identity">
          <strong>DACHBYTE Chat</strong>
          <small>Comunicação corporativa</small>
        </span>
      </div>
      <div className="desktop-titlebar__center" aria-hidden="true">
        <span className="desktop-titlebar__secure-dot" />
        Ambiente seguro
      </div>
      {version && <span className="desktop-titlebar__version">v{version}</span>}
    </header>
  );
};

export default DesktopTitleBar;
