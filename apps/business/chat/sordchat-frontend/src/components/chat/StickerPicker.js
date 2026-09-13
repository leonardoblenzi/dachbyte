import React, { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Pencil, RotateCw, Send, Trash2, X } from "lucide-react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../../config";
import { usePlatformDialog } from "../../contexts/PlatformDialogContext";
import { defaultStickers } from "../../data/defaultStickers";

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem("token")}` });
const imageToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const renderEditedSticker = (source, zoom, rotation, removeBackground) => new Promise((resolve, reject) => {
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext("2d", { willReadFrequently: removeBackground });
    context.clearRect(0, 0, 512, 512);
    const baseScale = Math.min(460 / image.width, 460 / image.height) * zoom;
    context.save();
    context.translate(256, 256);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(
      image,
      -(image.width * baseScale) / 2,
      -(image.height * baseScale) / 2,
      image.width * baseScale,
      image.height * baseScale,
    );
    context.restore();
    if (removeBackground) {
      const pixels = context.getImageData(0, 0, 512, 512);
      const sourceCanvas = document.createElement("canvas");
      sourceCanvas.width = image.width;
      sourceCanvas.height = image.height;
      const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
      sourceContext.drawImage(image, 0, 0);
      const corner = sourceContext.getImageData(0, 0, 1, 1).data;
      for (let index = 0; index < pixels.data.length; index += 4) {
        if (pixels.data[index + 3] === 0) continue;
        const distance = Math.sqrt(
          ((pixels.data[index] - corner[0]) ** 2) +
          ((pixels.data[index + 1] - corner[1]) ** 2) +
          ((pixels.data[index + 2] - corner[2]) ** 2),
        );
        if (distance < 34) pixels.data[index + 3] = 0;
        else if (distance < 90) pixels.data[index + 3] = Math.round(((distance - 34) / 56) * pixels.data[index + 3]);
      }
      context.putImageData(pixels, 0, 0);
    }
    resolve(canvas.toDataURL("image/webp", 0.86));
  };
  image.onerror = reject;
  image.src = source;
});

const StickerPicker = ({ companyId, onSend, onClose }) => {
  const dialog = usePlatformDialog();
  const fileInputRef = useRef(null);
  const objectUrlsRef = useRef([]);
  const [tab, setTab] = useState("official");
  const [customStickers, setCustomStickers] = useState([]);
  const [customUrls, setCustomUrls] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editor, setEditor] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [removeBackground, setRemoveBackground] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(true);

  const query = companyId ? `?company_id=${encodeURIComponent(companyId)}` : "";

  const loadStickerPolicy = useCallback(async () => {
    setPolicyLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/stickers/config${query}`, { headers: authHeaders() });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Não foi possível carregar a política de figurinhas.");
      setCanCreate(Boolean(payload.can_create));
    } catch (error) {
      setCanCreate(false);
      toast.error(error.message);
    } finally {
      setPolicyLoading(false);
    }
  }, [query]);

  const loadCustomStickers = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/stickers${query}`, { headers: authHeaders() });
      const payload = await response.json().catch(() => []);
      if (!response.ok) throw new Error(payload.detail || "Não foi possível carregar suas figurinhas.");
      setCustomStickers(payload);
      const entries = await Promise.all(payload.map(async (sticker) => {
        const imageResponse = await fetch(`${API_BASE_URL}/stickers/${sticker.id}/image`, { headers: authHeaders() });
        if (!imageResponse.ok) return [sticker.id, ""];
        const url = URL.createObjectURL(await imageResponse.blob());
        objectUrlsRef.current.push(url);
        return [sticker.id, url];
      }));
      setCustomUrls(Object.fromEntries(entries));
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    const objectUrls = objectUrlsRef.current;
    const handleStickersUpdated = () => loadCustomStickers();
    loadStickerPolicy();
    loadCustomStickers();
    window.addEventListener("voltchat:stickers-updated", handleStickersUpdated);
    return () => {
      window.removeEventListener("voltchat:stickers-updated", handleStickersUpdated);
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [loadCustomStickers, loadStickerPolicy]);

  const openEditor = async (file, existing = null) => {
    if (!canCreate) {
      toast.error("A criação de figurinhas foi desabilitada pelo administrador da empresa.");
      return;
    }
    if (!file || !String(file.type || "").startsWith("image/")) {
      toast.error("Selecione uma imagem para criar a figurinha.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("A imagem original deve ter no máximo 10 MB.");
      return;
    }
    const source = await imageToDataUrl(file);
    setEditor({ id: existing?.id || null, name: existing?.name || file.name.replace(/\.[^.]+$/, ""), source });
    setZoom(1);
    setRotation(0);
    setRemoveBackground(false);
  };

  const editExisting = async (sticker) => {
    try {
      const response = await fetch(`${API_BASE_URL}/stickers/${sticker.id}/image`, { headers: authHeaders() });
      if (!response.ok) throw new Error("Não foi possível abrir a figurinha.");
      const blob = await response.blob();
      await openEditor(new File([blob], `${sticker.name}.webp`, { type: blob.type || "image/webp" }), sticker);
    } catch (error) {
      toast.error(error.message);
    }
  };

  const saveSticker = async () => {
    if (!editor || saving) return;
    setSaving(true);
    try {
      const imageData = await renderEditedSticker(editor.source, zoom, rotation, removeBackground);
      const response = await fetch(`${API_BASE_URL}/stickers${editor.id ? `/${editor.id}` : ""}`, {
        method: editor.id ? "PUT" : "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ company_id: companyId || undefined, name: editor.name, image_data: imageData }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || "Não foi possível salvar a figurinha.");
      toast.success(editor.id ? "Figurinha atualizada." : "Figurinha criada e salva.");
      setEditor(null);
      setTab("mine");
      await loadCustomStickers();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setSaving(false);
    }
  };

  const deleteSticker = async (sticker) => {
    const confirmed = await dialog.confirm({
      title: "Excluir figurinha",
      message: `Deseja remover “${sticker.name}” da sua biblioteca?`,
      detail: "Mensagens antigas continuarão exibindo a figurinha.",
      confirmLabel: "Excluir",
      danger: true,
    });
    if (!confirmed) return;
    const response = await fetch(`${API_BASE_URL}/stickers/${sticker.id}`, { method: "DELETE", headers: authHeaders() });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      toast.error(payload.detail || "Não foi possível excluir a figurinha.");
      return;
    }
    setCustomStickers((items) => items.filter((item) => item.id !== sticker.id));
    toast.success("Figurinha removida.");
  };

  return (
    <div className="sticker-picker" role="dialog" aria-label="Figurinhas">
      <header className="sticker-picker__header">
        <div><strong>Figurinhas</strong><span>Personagens oficiais e sua coleção</span></div>
        <button type="button" className="icon-button icon-button--light" onClick={onClose} aria-label="Fechar figurinhas"><X size={17} /></button>
      </header>
      <div className="sticker-picker__tabs" role="tablist">
        <button type="button" className={tab === "official" ? "active" : ""} onClick={() => setTab("official")}>Oficiais</button>
        {canCreate && <button type="button" className={tab === "mine" ? "active" : ""} onClick={() => setTab("mine")}>Minhas</button>}
        {canCreate ? (
          <button type="button" className="sticker-picker__create" onClick={() => fileInputRef.current?.click()}><ImagePlus size={15} /> Criar</button>
        ) : !policyLoading ? (
          <span className="sticker-picker__policy">Criação desabilitada pela empresa</span>
        ) : null}
      </div>
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { openEditor(event.target.files?.[0]); event.target.value = ""; }} />
      {tab === "official" ? (
        <div className="sticker-picker__grid">
          {defaultStickers.map((sticker) => (
            <button type="button" key={sticker.key} className="sticker-picker__item" title={sticker.name} onClick={() => onSend(sticker)}>
              <img src={sticker.image} alt={sticker.name} />
            </button>
          ))}
        </div>
      ) : loading ? (
        <div className="sticker-picker__empty"><Loader2 className="animate-spin" size={24} /> Carregando...</div>
      ) : customStickers.length ? (
        <div className="sticker-picker__grid">
          {customStickers.map((sticker) => (
            <article className="sticker-picker__custom" key={sticker.id}>
              <button type="button" className="sticker-picker__item" title={sticker.name} onClick={() => onSend({ ...sticker, image: customUrls[sticker.id], source: `sticker:${sticker.id}` })}>
                {customUrls[sticker.id] && <img src={customUrls[sticker.id]} alt={sticker.name} />}
              </button>
              <div><button type="button" onClick={() => editExisting(sticker)} title="Editar"><Pencil size={13} /></button><button type="button" onClick={() => deleteSticker(sticker)} title="Excluir"><Trash2 size={13} /></button></div>
            </article>
          ))}
        </div>
      ) : (
        <div className="sticker-picker__empty"><ImagePlus size={28} /><strong>Crie sua primeira figurinha</strong><span>Escolha uma imagem, ajuste o recorte e remova o fundo.</span></div>
      )}

      {editor && (
        <div className="sticker-editor">
          <div className="sticker-editor__top"><strong>{editor.id ? "Editar figurinha" : "Nova figurinha"}</strong><button type="button" onClick={() => setEditor(null)}><X size={17} /></button></div>
          <div className="sticker-editor__canvas"><img src={editor.source} alt="Prévia" style={{ transform: `scale(${zoom}) rotate(${rotation}deg)` }} /></div>
          <label>Nome<input className="input" value={editor.name} maxLength={80} onChange={(event) => setEditor((value) => ({ ...value, name: event.target.value }))} /></label>
          <label>Zoom<input type="range" min="0.65" max="2" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
          <div className="sticker-editor__tools">
            <button type="button" className="button-secondary" onClick={() => setRotation((value) => (value + 90) % 360)}><RotateCw size={15} /> Girar</button>
            <label><input type="checkbox" checked={removeBackground} onChange={(event) => setRemoveBackground(event.target.checked)} /> Remover fundo</label>
          </div>
          <button type="button" className="button-primary" disabled={saving || !editor.name.trim()} onClick={saveSticker}>{saving ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />} Salvar figurinha</button>
        </div>
      )}
    </div>
  );
};

export default StickerPicker;
