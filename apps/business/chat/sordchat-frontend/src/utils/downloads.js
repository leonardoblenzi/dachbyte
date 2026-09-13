import { API_BASE_URL } from "../config";

const browserDownload = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const downloadAuthenticatedFile = async (
  fileId,
  filename = "arquivo",
) => {
  const token = localStorage.getItem("token");
  if (!token) {
    throw new Error(
      "Sua sessao expirou. Entre novamente para baixar arquivos.",
    );
  }

  const url = `${API_BASE_URL}/files/download/${fileId}`;
  const streamingUrl = `${API_BASE_URL}/files/content/${fileId}`;
  if (window.voltChatDesktop?.downloadFile) {
    try {
      const result = await window.voltChatDesktop.downloadFile({
        url,
        filename,
        token,
      });
      return result.savedPath;
    } catch (error) {
      console.error(
        "Desktop file download falhou, usando fallback de browser:",
        error,
      );
    }
  }

  const response = await fetch(streamingUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.detail || "Nao foi possivel baixar o arquivo.");
  }
  browserDownload(await response.blob(), filename);
  return null;
};
