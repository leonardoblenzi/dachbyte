import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, HelpCircle, Info, X } from "lucide-react";

const PlatformDialogContext = createContext(null);

const normalizeOptions = (options, type) =>
  typeof options === "string" ? { type, message: options } : { type, ...(options || {}) };

export const PlatformDialogProvider = ({ children }) => {
  const [dialog, setDialog] = useState(null);
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const openDialog = useCallback((options, type) => new Promise((resolve) => {
    const normalized = normalizeOptions(options, type);
    setValue(normalized.defaultValue || "");
    setDialog({ ...normalized, resolve });
  }), []);

  const closeDialog = useCallback((result) => {
    setDialog((current) => {
      current?.resolve(result);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!dialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeDialog(dialog.type === "prompt" ? null : false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog, dialog]);

  const api = useMemo(() => ({
    alert: (options) => openDialog(options, "alert"),
    confirm: (options) => openDialog(options, "confirm"),
    prompt: (options) => openDialog(options, "prompt"),
  }), [openDialog]);

  const submit = (event) => {
    event.preventDefault();
    if (dialog.type === "prompt") {
      if (dialog.required !== false && !value.trim()) return;
      closeDialog(value);
      return;
    }
    closeDialog(true);
  };

  const Icon = dialog?.danger ? AlertTriangle : dialog?.type === "alert" ? Info : HelpCircle;

  return (
    <PlatformDialogContext.Provider value={api}>
      {children}
      {dialog && (
        <div className="platform-dialog" role="presentation">
          <form className="platform-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="platform-dialog-title" onSubmit={submit}>
            <header className="platform-dialog__header">
              <span className={`platform-dialog__icon ${dialog.danger ? "platform-dialog__icon--danger" : ""}`}><Icon size={22} /></span>
              <div>
                <small>{dialog.eyebrow || "VoltChat"}</small>
                <h2 id="platform-dialog-title">{dialog.title || (dialog.type === "alert" ? "Aviso" : "Confirmar ação")}</h2>
              </div>
              <button className="icon-button icon-button--light" type="button" onClick={() => closeDialog(dialog.type === "prompt" ? null : false)} aria-label="Fechar"><X size={18} /></button>
            </header>
            <div className="platform-dialog__body">
              {dialog.message && <p>{dialog.message}</p>}
              {dialog.detail && <small>{dialog.detail}</small>}
              {dialog.type === "prompt" && (
                <label>
                  <span>{dialog.inputLabel || "Digite para continuar"}</span>
                  <input ref={inputRef} className="input" type={dialog.inputType || "text"} value={value} onChange={(event) => setValue(event.target.value)} placeholder={dialog.placeholder || ""} autoComplete="off" />
                </label>
              )}
            </div>
            <footer className="platform-dialog__actions">
              {dialog.type !== "alert" && <button className="button-secondary" type="button" onClick={() => closeDialog(dialog.type === "prompt" ? null : false)}>{dialog.cancelLabel || "Cancelar"}</button>}
              <button className={dialog.danger ? "button-danger" : "button-primary"} type="submit">{dialog.confirmLabel || (dialog.type === "alert" ? "Entendi" : "Confirmar")}</button>
            </footer>
          </form>
        </div>
      )}
    </PlatformDialogContext.Provider>
  );
};

export const usePlatformDialog = () => {
  const context = useContext(PlatformDialogContext);
  if (!context) throw new Error("usePlatformDialog deve ser usado dentro de PlatformDialogProvider");
  return context;
};
