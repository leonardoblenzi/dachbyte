import React, { useEffect, useMemo, useState } from "react";
import { Clock3, Eye, Heart, ImageOff, Loader2 } from "lucide-react";
import { API_BASE_URL } from "../../config";
import { defaultStickerMap } from "../../data/defaultStickers";

const customStickerUrlCache = new Map();

const parseStickerReference = (message) => {
  const reference = String(message?.file_path || "");
  if (message?.sticker_key) return { key: message.sticker_key };
  if (message?.sticker_id) return { id: Number(message.sticker_id) };
  if (reference.startsWith("default:")) return { key: reference.split(":", 2)[1] };
  if (reference.startsWith("sticker:")) return { id: Number(reference.split(":", 2)[1]) };
  return {};
};

const StickerMessage = ({
  message,
  time,
  receiptStatus = "",
  favorite = false,
  favoriteLoading = false,
  onFavorite,
}) => {
  const reference = useMemo(() => parseStickerReference(message), [message]);
  const defaultSticker = reference.key ? defaultStickerMap[reference.key] : null;
  const [imageUrl, setImageUrl] = useState(defaultSticker?.image || "");
  const [loading, setLoading] = useState(Boolean(reference.id));

  useEffect(() => {
    if (defaultSticker) {
      setImageUrl(defaultSticker.image);
      setLoading(false);
      return undefined;
    }
    if (!reference.id) {
      setImageUrl("");
      setLoading(false);
      return undefined;
    }
    if (customStickerUrlCache.has(reference.id)) {
      setImageUrl(customStickerUrlCache.get(reference.id));
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    fetch(`${API_BASE_URL}/stickers/${reference.id}/image`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("token")}` },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Figurinha indisponível");
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        customStickerUrlCache.set(reference.id, url);
        setImageUrl(url);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setImageUrl("");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [defaultSticker, reference.id]);

  return (
    <div className="sticker-message">
      {loading ? (
        <span className="sticker-message__loading"><Loader2 size={24} /></span>
      ) : imageUrl ? (
        <img
          className="sticker-message__image"
          src={imageUrl}
          alt={message?.sticker_name || message?.content || "Figurinha"}
          draggable="false"
        />
      ) : (
        <span className="sticker-message__missing"><ImageOff size={30} /> Figurinha indisponível</span>
      )}
      <button
        type="button"
        className={`sticker-message__favorite ${favorite ? "sticker-message__favorite--active" : ""}`}
        title={favorite ? "Salva em Minhas figurinhas" : "Adicionar às Minhas figurinhas"}
        aria-label={favorite ? "Figurinha salva nas favoritas" : "Favoritar figurinha"}
        disabled={favoriteLoading}
        onClick={(event) => {
          event.stopPropagation();
          onFavorite?.();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {favoriteLoading ? <Loader2 className="animate-spin" size={17} /> : <Heart size={17} fill={favorite ? "currentColor" : "none"} />}
      </button>
      <span className="sticker-message__meta">
        <span className="sticker-message__time">{time}</span>
        {receiptStatus && (
          <span
            className={`chat-message__receipt chat-message__receipt--${receiptStatus}`}
            title={receiptStatus === "read" ? "Visualizada" : receiptStatus === "delivered" ? "Entregue" : "Enviando"}
            aria-label={receiptStatus === "read" ? "Mensagem visualizada" : receiptStatus === "delivered" ? "Mensagem entregue" : "Mensagem enviada, aguardando entrega"}
          >
            <span className="chat-message__receipt-glyph" aria-hidden="true">
              {receiptStatus === "read" ? <Eye size={14} /> : receiptStatus === "sent" ? <Clock3 size={12} /> : "\u2713"}
            </span>
          </span>
        )}
      </span>
    </div>
  );
};

export default StickerMessage;
