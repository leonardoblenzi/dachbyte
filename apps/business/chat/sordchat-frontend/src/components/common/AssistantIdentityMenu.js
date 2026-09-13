import React, { useState } from "react";
import { MoreVertical } from "lucide-react";
import toast from "react-hot-toast";
import { API_BASE_URL } from "../../config";
import { usePlatformDialog } from "../../contexts/PlatformDialogContext";

const authHeaders = () => ({
  "Content-Type": "application/json",
  Authorization: "Bearer " + localStorage.getItem("token"),
});

const AssistantIdentityMenu = () => {
  const dialog = usePlatformDialog();
  const [loading, setLoading] = useState(false);

  const configureName = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const response = await fetch(API_BASE_URL + "/assistant/preferences", {
        headers: authHeaders(),
      });
      const current = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(current.detail || "Nao foi possivel carregar sua preferencia.");
      }
      const value = await dialog.prompt({
        title: "Como posso me direcionar a voce?",
        message:
          "Defina como Volt e Mitty devem chamar voce. Deixe vazio para usar seu nome padrao.",
        inputLabel: "Nome ou forma de tratamento",
        defaultValue: current.configured ? current.address_name : "",
        confirmLabel: "Salvar preferencia",
      });
      if (value === null) return;
      const saveResponse = await fetch(API_BASE_URL + "/assistant/preferences", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({ address_name: value }),
      });
      const saved = await saveResponse.json().catch(() => ({}));
      if (!saveResponse.ok) {
        throw new Error(saved.detail || "Nao foi possivel salvar sua preferencia.");
      }
      toast.success(
        saved.configured
          ? "Volt e Mitty chamarao voce de " + saved.address_name + "."
          : "Volt e Mitty usarao seu nome padrao.",
      );
    } catch (error) {
      toast.error(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      className="icon-button icon-button--light"
      type="button"
      onClick={configureName}
      disabled={loading}
      title="Como posso me direcionar a voce?"
      aria-label="Configurar como Volt e Mitty devem chamar voce"
    >
      <MoreVertical size={18} />
    </button>
  );
};

export default AssistantIdentityMenu;