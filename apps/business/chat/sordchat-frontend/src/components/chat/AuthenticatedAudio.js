import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API_BASE_URL } from '../../config';

const AuthenticatedAudio = ({ fileId, className = '' }) => {
  const [audioUrl, setAudioUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!fileId) return undefined;
    let objectUrl = '';
    setFailed(false);
    fetch(`${API_BASE_URL}/files/content/${fileId}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
    })
      .then((response) => {
        if (!response.ok) throw new Error('audio unavailable');
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setAudioUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fileId]);

  if (failed) return <span className="audio-message__error">Áudio indisponível</span>;
  if (!audioUrl) return <span className="audio-message__loading"><Loader2 className="animate-spin" size={17} /> Carregando áudio</span>;
  return <audio className={`audio-message ${className}`.trim()} controls preload="metadata" src={audioUrl}>Seu navegador não reproduz áudio.</audio>;
};

export default AuthenticatedAudio;