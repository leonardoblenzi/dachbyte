import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, Square, X } from 'lucide-react';
import toast from 'react-hot-toast';

const MAX_RECORDING_SECONDS = 5 * 60;

const chooseRecordingFormat = () => {
  const candidates = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/webm', 'webm'],
    ['audio/mp4', 'm4a'],
  ];
  return candidates.find(([mimeType]) => window.MediaRecorder?.isTypeSupported?.(mimeType))
    || ['audio/webm', 'webm'];
};

const formatSeconds = (value) => {
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const AudioRecorderButton = ({ disabled = false, uploading = false, onRecorded }) => {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const cancelledRef = useRef(false);
  const timerRef = useRef(null);

  const releaseStream = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const stopRecording = (cancel = false) => {
    cancelledRef.current = cancel;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  useEffect(() => () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    releaseStream();
  }, []);

  useEffect(() => {
    if (recording && seconds >= MAX_RECORDING_SECONDS) stopRecording(false);
  }, [recording, seconds]);

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      toast.error('Gravação de áudio não é suportada neste dispositivo.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const [mimeType, extension] = chooseRecordingFormat();
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      cancelledRef.current = false;
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => toast.error('A gravação de áudio foi interrompida.');
      recorder.onstop = async () => {
        releaseStream();
        setRecording(false);
        setSeconds(0);
        const chunks = chunksRef.current;
        chunksRef.current = [];
        if (cancelledRef.current || !chunks.length) return;
        const blob = new Blob(chunks, { type: mimeType });
        if (!blob.size) return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = new File([blob], `audio-${timestamp}.${extension}`, { type: mimeType });
        try {
          await onRecorded(file);
        } catch {
          // O componente pai exibe o erro de envio.
        }
      };
      recorder.start(250);
      setSeconds(0);
      setRecording(true);
      timerRef.current = setInterval(() => setSeconds((current) => current + 1), 1000);
    } catch (error) {
      releaseStream();
      if (error?.name === 'NotAllowedError') {
        toast.error('Permita o acesso ao microfone para gravar áudio.');
      } else if (error?.name === 'NotFoundError') {
        toast.error('Nenhum microfone foi encontrado.');
      } else {
        toast.error('Não foi possível iniciar o microfone.');
      }
    }
  };

  if (recording) {
    return (
      <div className="audio-recorder audio-recorder--active" aria-label="Gravando áudio">
        <span className="audio-recorder__pulse" />
        <strong>{formatSeconds(seconds)}</strong>
        <button className="audio-recorder__stop" type="button" onClick={() => stopRecording(false)} title="Parar e enviar" aria-label="Parar e enviar áudio"><Square size={15} /></button>
        <button className="audio-recorder__cancel" type="button" onClick={() => stopRecording(true)} title="Cancelar gravação" aria-label="Cancelar gravação"><X size={16} /></button>
      </div>
    );
  }

  return (
    <button
      className="icon-button icon-button--light"
      type="button"
      onClick={startRecording}
      disabled={disabled || uploading}
      title="Gravar áudio"
      aria-label="Gravar áudio"
    >
      {uploading ? <Loader2 className="animate-spin" size={18} /> : <Mic size={18} />}
    </button>
  );
};

export default AudioRecorderButton;