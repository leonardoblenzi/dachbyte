export type ToastTone = "success" | "error" | "warning" | "info";

export interface ToastPayload {
  title?: string;
  message: string;
  tone?: ToastTone;
  durationMs?: number;
}

export const APP_TOAST_EVENT = "app:toast";

export const showToast = ({
  title,
  message,
  tone = "info",
  durationMs,
}: ToastPayload) => {
  window.dispatchEvent(
    new CustomEvent(APP_TOAST_EVENT, {
      detail: {
        title,
        message,
        tone,
        durationMs,
      } satisfies ToastPayload,
    }),
  );
};
