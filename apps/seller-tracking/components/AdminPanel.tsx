import React, { useState, useEffect } from "react";
import { useAuth } from "../contexts/AuthContext";
import { TrayIntegrationStatus } from "../types";
import { LOGO_URL, withBasePath } from "../constants";
import {
  Shield,
  Users,
  Database,
  Key,
  CheckCircle,
  XCircle,
  Plus,
  Trash2,
  Power,
  X,
  Edit,
  Link2,
  Lock,
  AlertTriangle,
  Mail,
  Send,
  Sparkles,
  Filter,
  Cake,
  Camera,
  UserCircle2,
  Webhook,
} from "lucide-react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../utils/authFetch";
import { showToast } from "../utils/toast";

// Types for local state
interface Company {
  id: string;
  name: string;
  cnpj?: string;
  tenantGlobalId?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  trayIntegrationEnabled?: boolean;
  anymarketIntegrationEnabled?: boolean;
  blingIntegrationEnabled?: boolean;
  magazordIntegrationEnabled?: boolean;
  sysempIntegrationEnabled?: boolean;
  jetIntegrationEnabled?: boolean;
  intelipostIntegrationEnabled?: boolean;
  sswRequireEnabled?: boolean;
  correiosIntegrationEnabled?: boolean;
  intelipostClientId?: string | null;
  intelipostApiKeyConfigured?: boolean;
  anymarketTokenConfigured?: boolean;
  magazordApiBaseUrl?: string | null;
  magazordApiUser?: string | null;
  magazordApiPasswordConfigured?: boolean;
  jetStoreId?: string | null;
  jetIntegrationKeyConfigured?: boolean;
  jetUsername?: string | null;
  jetUsernameConfigured?: boolean;
  jetPasswordConfigured?: boolean;
  jetBearerTokenConfigured?: boolean;
  sswRequireCnpjs?: string[];
  integrationCarrierExceptions?: string[];
  integrationManualStatuses?: string[];
  integrationAutoSyncStatuses?: string[];
  shippingCutoffTime?: string | null;
  createdAt: string;
}

interface UserData {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "USER";
  phone?: string | null;
  birthDate?: string | null;
  profileImageData?: string | null;
  receivePlatformEmails?: boolean;
  status?: "Active" | "Inactive"; // Backend doesn't have status yet, but UI does
  createdAt: string;
  companyId?: string;
  company?: Company;
}

interface CompanyUsageSummary {
  success: boolean;
  companyId: string;
  companyName: string;
  database: {
    configured: boolean;
    host: string | null;
  };
  totals: {
    users: number;
    orders: number;
    trackingSyncRuns: number;
    trackingSyncRunsLast30Days: number;
    trackingSyncSuccessEvents: number;
    trackingSyncFailedEvents: number;
  };
  usage: {
    totalTrackingSyncHours: number;
    trackingSyncHoursLast30Days: number;
    cpuCuHoursEstimatedLast30Days: number;
    usageScore: number;
  };
  lastTrackingSyncAt: string | null;
}

interface IntelipostWebhookLog {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

type WebhookProvider = "intelipost" | "anymarket";

const getInitialTab = (
  canManageAdminPanel: boolean,
): "users" | "companies" | "integration" | "webhooks" | "patch-notes" => {
  const params = new URLSearchParams(window.location.search);
  const requestedTab = params.get("tab");

  if (requestedTab === "integration") {
    return "integration";
  }

  if (canManageAdminPanel && requestedTab === "patch-notes") {
    return "patch-notes";
  }

  if (canManageAdminPanel && requestedTab === "companies") {
    return "companies";
  }

  if (canManageAdminPanel && requestedTab === "webhooks") {
    return "webhooks";
  }

  return canManageAdminPanel ? "users" : "integration";
};

interface PatchNotesFormData {
  version: string;
  title: string;
  summary: string;
  newFeatures: string;
  adjustments: string;
}

const CLEAR_STATUS_OPTIONS = [
  { value: "ALL", label: "Todos os status" },
  { value: "PENDING", label: "Pendente" },
  { value: "CREATED", label: "Criado" },
  { value: "SHIPPED", label: "Em transito" },
  { value: "DELIVERY_ATTEMPT", label: "Saiu para entrega" },
  { value: "DELIVERED", label: "Entregue" },
  { value: "FAILURE", label: "Falha na entrega" },
  { value: "RETURNED", label: "Devolvido" },
  { value: "CANCELED", label: "Cancelado" },
  { value: "CHANNEL_LOGISTICS", label: "Logistica do canal" },
] as const;

const CLEAR_PERIOD_OPTIONS = [
  { value: "ALL", label: "Todos" },
  { value: "7_DAYS", label: "7 dias" },
  { value: "15_DAYS", label: "15 dias" },
  { value: "30_DAYS", label: "30 dias" },
  { value: "CUSTOM", label: "Personalizado" },
] as const;

const normalizeIntegrationSearchText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const MAX_PROFILE_IMAGE_BYTES = 350 * 1024;

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Nao foi possivel ler a imagem selecionada."));
    reader.readAsDataURL(file);
  });

const loadImageFromDataUrl = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Nao foi possivel processar a imagem selecionada."));
    image.src = dataUrl;
  });

const dataUrlToByteSize = (dataUrl: string) => {
  const [, rawBase64 = ""] = String(dataUrl || "").split(",");
  if (!rawBase64) return 0;

  const padding = rawBase64.endsWith("==")
    ? 2
    : rawBase64.endsWith("=")
      ? 1
      : 0;

  return Math.floor((rawBase64.length * 3) / 4) - padding;
};

const compressImageToLimit = async (
  file: File,
  maxBytes = MAX_PROFILE_IMAGE_BYTES,
) => {
  const originalDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(originalDataUrl);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Nao foi possivel preparar o editor da imagem.");
  }

  let targetWidth = image.width;
  let targetHeight = image.height;
  const maxDimension = 920;

  if (Math.max(targetWidth, targetHeight) > maxDimension) {
    const scale = maxDimension / Math.max(targetWidth, targetHeight);
    targetWidth = Math.round(targetWidth * scale);
    targetHeight = Math.round(targetHeight * scale);
  }

  const renderImage = () => {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    context.clearRect(0, 0, targetWidth, targetHeight);
    context.drawImage(image, 0, 0, targetWidth, targetHeight);
  };

  renderImage();

  let quality = 0.92;
  let compressedDataUrl = canvas.toDataURL("image/jpeg", quality);

  while (dataUrlToByteSize(compressedDataUrl) > maxBytes && quality > 0.42) {
    quality -= 0.08;
    compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
  }

  while (
    dataUrlToByteSize(compressedDataUrl) > maxBytes &&
    targetWidth > 140 &&
    targetHeight > 140
  ) {
    targetWidth = Math.round(targetWidth * 0.88);
    targetHeight = Math.round(targetHeight * 0.88);
    renderImage();
    quality = 0.82;
    compressedDataUrl = canvas.toDataURL("image/jpeg", quality);

    while (dataUrlToByteSize(compressedDataUrl) > maxBytes && quality > 0.42) {
      quality -= 0.08;
      compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
    }
  }

  if (dataUrlToByteSize(compressedDataUrl) > maxBytes) {
    throw new Error(
      "Nao foi possivel reduzir a imagem para 350KB. Escolha uma imagem menor.",
    );
  }

  return compressedDataUrl;
};

const formatBirthDateForInput = (value: string | null | undefined) => {
  if (!value) return "";

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";

  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(
    parsed.getUTCDate(),
  ).padStart(2, "0")}`;
};

const normalizeIdentityDigits = (value: string) => value.replace(/\D/g, "");

const resolveIdentityDocumentType = (
  type: string,
  value: string,
): "CPF" | "CNPJ" | "" => {
  const normalizedType = String(type || "").trim().toUpperCase();
  if (normalizedType === "CPF" || normalizedType === "CNPJ") return normalizedType;
  const digits = normalizeIdentityDigits(value);
  if (digits.length === 11) return "CPF";
  if (digits.length === 14) return "CNPJ";
  return "";
};

const formatIdentityDocumentInput = (type: string, value: string) => {
  const digits = normalizeIdentityDigits(value);
  const resolvedType = resolveIdentityDocumentType(type, digits);
  if (!digits) return "";
  if (resolvedType === "CPF") {
    return digits
      .slice(0, 11)
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  }
  if (resolvedType === "CNPJ") {
    return digits
      .slice(0, 14)
      .replace(/(\d{2})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1.$2")
      .replace(/(\d{3})(\d)/, "$1/$2")
      .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
  }
  return digits;
};

const formatIdentityDocument = (type?: string | null, value?: string | null) => {
  const digits = normalizeIdentityDigits(String(value || ""));
  if (!digits) return "-";
  return formatIdentityDocumentInput(String(type || ""), digits);
};

const formatMetricNumber = (value: unknown) =>
  Number(value || 0).toLocaleString("pt-BR");

const formatMetricHours = (value: unknown) =>
  `${Number(value || 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} h`;

const formatMetricDateTime = (value?: string | null) => {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString("pt-BR");
};

const INTEGRATION_LOGO_CLASS =
  "mt-3 h-8 w-auto object-contain rounded-lg px-2 py-1 dark:bg-white/5 dark:ring-1 dark:ring-white/10 dark:drop-shadow-[0_0_10px_rgba(255,255,255,0.22)]";

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const splitLines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const renderParagraph = (value: string, fallback: string) =>
  escapeHtml(value.trim() || fallback).replace(/\n/g, "<br />");

const buildPatchNotesList = (items: string[], emptyLabel: string) => {
  if (items.length === 0) {
    return `<p style="margin:0;color:#64748b;font-size:14px;">${escapeHtml(emptyLabel)}</p>`;
  }

  return `
    <ul style="margin:0;padding-left:20px;color:#0f172a;font-size:14px;line-height:1.7;">
      ${items
        .map((item) => `<li style="margin-bottom:8px;">${escapeHtml(item)}</li>`)
        .join("")}
    </ul>
  `;
};

const buildPatchNotesPreviewHtml = (input: PatchNotesFormData) => {
  const newFeatures = splitLines(input.newFeatures);
  const adjustments = splitLines(input.adjustments);

  return `
    <!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${escapeHtml(input.title || "Release Notes Avantracking")}</title>
      </head>
      <body style="margin:0;padding:32px 16px;background:#e2e8f0;font-family:Arial,sans-serif;color:#0f172a;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:760px;margin:0 auto;">
          <tr>
            <td>
              <div style="border-radius:28px;overflow:hidden;background:#0f172a;box-shadow:0 24px 80px rgba(15,23,42,0.28);">
                <div style="padding:28px 32px;background:linear-gradient(135deg,#0f172a 0%,#1d4ed8 100%);text-align:center;">
                  <img src="${LOGO_URL}" alt="Avantracking" style="max-width:240px;width:100%;height:auto;display:block;margin:0 auto 20px;" />
                  <div style="display:inline-block;padding:8px 16px;border-radius:999px;background:rgba(255,255,255,0.14);color:#dbeafe;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                    Release Notes ${escapeHtml(input.version || "Nova versao")}
                  </div>
                  <h1 style="margin:18px 0 0;font-size:30px;line-height:1.2;color:#ffffff;">${escapeHtml(input.title || "Nova atualizacao da plataforma")}</h1>
                </div>
                <div style="padding:32px;background:#ffffff;">
                  <div style="padding:22px;border-radius:22px;background:#f8fafc;border:1px solid #e2e8f0;">
                    <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#2563eb;">Resumo da versao</div>
                    <p style="margin:12px 0 0;font-size:15px;line-height:1.7;color:#0f172a;">${renderParagraph(input.summary, "Descreva aqui o resumo principal da versao.")}</p>
                  </div>
                  <div style="display:grid;gap:18px;margin-top:24px;">
                    <div style="padding:22px;border-radius:22px;background:#eff6ff;border:1px solid #bfdbfe;">
                      <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#1d4ed8;">Novas funcionalidades</div>
                      <div style="margin-top:14px;">
                        ${buildPatchNotesList(newFeatures, "Nenhuma funcionalidade nova informada nesta versao.")}
                      </div>
                    </div>
                    <div style="padding:22px;border-radius:22px;background:#f8fafc;border:1px solid #e2e8f0;">
                      <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0f172a;">Ajustes e melhorias</div>
                      <div style="margin-top:14px;">
                        ${buildPatchNotesList(adjustments, "Nenhum ajuste adicional informado nesta versao.")}
                      </div>
                    </div>
                  </div>
                  <div style="margin-top:28px;padding:18px 20px;border-radius:18px;background:#0f172a;color:#cbd5e1;font-size:13px;line-height:1.7;">
                    Este comunicado foi enviado pelo time Avantracking para informar a nova versao da plataforma.
                  </div>
                </div>
              </div>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
};

const adminToast = (
  message: string,
  tone: "success" | "error" | "warning" | "info" = "info",
  title?: string,
) => {
  showToast({
    message,
    tone,
    title,
  });
};

export const AdminPanel: React.FC = () => {
  const { user, setUser } = useAuth();
  const canManageAdminPanel = user?.email === "admin@avantracking.com.br";

  const [activeTab, setActiveTab] = useState<
    "users" | "companies" | "integration" | "webhooks" | "patch-notes"
  >(() => getInitialTab(canManageAdminPanel));
  const [integrationSubTab, setIntegrationSubTab] = useState<
    "erp" | "tracking" | "settings"
  >("erp");
  const [settingsSubTab, setSettingsSubTab] = useState<
    "integration" | "profile"
  >("integration");
  const [users, setUsers] = useState<UserData[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [trayStoreUrl, setTrayStoreUrl] = useState("");
  const [trayStatus, setTrayStatus] = useState<TrayIntegrationStatus>({
    authorized: false,
    status: "offline",
    storeId: null,
    storeName: null,
    updatedAt: null,
    message: "Nenhuma integracao Tray autorizada.",
  });
  const [isCheckingTrayStatus, setIsCheckingTrayStatus] = useState(false);
  const [currentCompany, setCurrentCompany] = useState<Company | null>(null);
  const [integrationSearch, setIntegrationSearch] = useState("");
  const [trayIntegrationEnabled, setTrayIntegrationEnabled] = useState(true);
  const [anymarketIntegrationEnabled, setAnymarketIntegrationEnabled] =
    useState(false);
  const [blingIntegrationEnabled, setBlingIntegrationEnabled] = useState(false);
  const [magazordIntegrationEnabled, setMagazordIntegrationEnabled] =
    useState(false);
  const [sysempIntegrationEnabled, setSysempIntegrationEnabled] = useState(false);
  const [jetIntegrationEnabled, setJetIntegrationEnabled] = useState(false);
  const [intelipostIntegrationEnabled, setIntelipostIntegrationEnabled] =
    useState(true);
  const [sswRequireEnabled, setSswRequireEnabled] = useState(true);
  const [correiosIntegrationEnabled, setCorreiosIntegrationEnabled] =
    useState(true);
  const [intelipostClientId, setIntelipostClientId] = useState("");
  const [intelipostApiKey, setIntelipostApiKey] = useState("");
  const [intelipostApiKeyConfigured, setIntelipostApiKeyConfigured] =
    useState(false);
  const [anymarketToken, setAnymarketToken] = useState("");
  const [anymarketTokenConfigured, setAnymarketTokenConfigured] =
    useState(false);
  const [magazordApiBaseUrl, setMagazordApiBaseUrl] = useState("");
  const [magazordApiUser, setMagazordApiUser] = useState("");
  const [magazordApiPassword, setMagazordApiPassword] = useState("");
  const [magazordApiPasswordConfigured, setMagazordApiPasswordConfigured] =
    useState(false);
  const [jetStoreId, setJetStoreId] = useState("");
  const [jetIntegrationKey, setJetIntegrationKey] = useState("");
  const [jetIntegrationKeyConfigured, setJetIntegrationKeyConfigured] =
    useState(false);
  const [jetUsername, setJetUsername] = useState("");
  const [jetUsernameConfigured, setJetUsernameConfigured] = useState(false);
  const [jetPassword, setJetPassword] = useState("");
  const [jetPasswordConfigured, setJetPasswordConfigured] = useState(false);
  const [jetBearerToken, setJetBearerToken] = useState("");
  const [jetBearerTokenConfigured, setJetBearerTokenConfigured] = useState(false);
  const [sswRequireCnpjs, setSswRequireCnpjs] = useState<string[]>([""]);
  const [integrationCarrierExceptions, setIntegrationCarrierExceptions] = useState<string[]>([""]);
  const [integrationManualStatuses, setIntegrationManualStatuses] = useState<string[]>([""]);
  const [integrationAutoSyncStatuses, setIntegrationAutoSyncStatuses] = useState<string[]>([""]);
  const [shippingCutoffTime, setShippingCutoffTime] = useState("23:59");
  const [isSavingIntelipost, setIsSavingIntelipost] = useState(false);
  const [isSavingAnymarket, setIsSavingAnymarket] = useState(false);
  const [isSavingMagazord, setIsSavingMagazord] = useState(false);
  const [isSavingJet, setIsSavingJet] = useState(false);
  const [isSavingSswRequire, setIsSavingSswRequire] = useState(false);
  const [isSavingCarrierExceptions, setIsSavingCarrierExceptions] = useState(false);
  const [isSavingIntegrationManualStatuses, setIsSavingIntegrationManualStatuses] = useState(false);
  const [isSavingIntegrationAutoSyncStatuses, setIsSavingIntegrationAutoSyncStatuses] = useState(false);
  const [isSavingShippingCutoffTime, setIsSavingShippingCutoffTime] = useState(false);
  const [isSavingIntegrationToggle, setIsSavingIntegrationToggle] = useState(false);
  const [webhookLogs, setWebhookLogs] = useState<IntelipostWebhookLog[]>([]);
  const [isLoadingWebhookLogs, setIsLoadingWebhookLogs] = useState(false);
  const [isClearingWebhookFailures, setIsClearingWebhookFailures] = useState(false);
  const [isReprocessingWebhookFailures, setIsReprocessingWebhookFailures] = useState(false);
  const [isClearWebhookFailuresModalOpen, setIsClearWebhookFailuresModalOpen] =
    useState(false);
  const [webhookLogFilter, setWebhookLogFilter] = useState<
    "all" | "success" | "failed"
  >("all");
  const [webhookProvider, setWebhookProvider] =
    useState<WebhookProvider>("intelipost");
  const [profileForm, setProfileForm] = useState({
    name: "",
    email: "",
    phone: "",
    birthDate: "",
    profileImageData: "",
    receivePlatformEmails: true,
  });
  const [profilePasswordForm, setProfilePasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [isLoadingProfile, setIsLoadingProfile] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [patchNotesForm, setPatchNotesForm] = useState<PatchNotesFormData>({
    version: "",
    title: "",
    summary: "",
    newFeatures: "",
    adjustments: "",
  });
  const [selectedRecipientIds, setSelectedRecipientIds] = useState<string[]>([]);
  const [recipientSearch, setRecipientSearch] = useState("");
  const [recipientCompanyFilter, setRecipientCompanyFilter] = useState("all");
  const [isSendingReleaseNotes, setIsSendingReleaseNotes] = useState(false);
  const [usersSearch, setUsersSearch] = useState("");
  const [usersCompanyFilter, setUsersCompanyFilter] = useState("all");
  const [companiesSearch, setCompaniesSearch] = useState("");
  const [selectedCompanyViewId, setSelectedCompanyViewId] = useState("");
  const [companyUsageSummary, setCompanyUsageSummary] =
    useState<CompanyUsageSummary | null>(null);
  const [isLoadingCompanyUsage, setIsLoadingCompanyUsage] = useState(false);
  const [companyUsageError, setCompanyUsageError] = useState("");

  // User Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserData | null>(null);

  // Company Modal State
  const [isCompanyModalOpen, setIsCompanyModalOpen] = useState(false);
  const [companyFormData, setCompanyFormData] = useState({
    name: "",
    cnpj: "",
    documentType: "CNPJ",
    documentNumber: "",
    tenantGlobalId: "",
  });

  // Limpeza de DB States
  const [isClearModalOpen, setIsClearModalOpen] = useState(false);
  const [clearType, setClearType] = useState<"ALL" | "DELIVERED_7_DAYS" | "FILTERED">("ALL");
  const [clearCompanyId, setClearCompanyId] = useState("");
  const [clearPassword, setClearPassword] = useState("");
  const [clearStatus, setClearStatus] = useState<"ALL" | "PENDING" | "CREATED" | "SHIPPED" | "DELIVERY_ATTEMPT" | "DELIVERED" | "FAILURE" | "RETURNED" | "CANCELED" | "CHANNEL_LOGISTICS">("ALL");
  const [clearPeriod, setClearPeriod] = useState<"ALL" | "7_DAYS" | "15_DAYS" | "30_DAYS" | "CUSTOM">("ALL");
  const [clearCustomStartDate, setClearCustomStartDate] = useState("");
  const [clearCustomEndDate, setClearCustomEndDate] = useState("");
  const [isClearing, setIsClearing] = useState(false);

  // Form State (User)
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    role: "USER" as "ADMIN" | "USER",
    companyId: "",
    password: "",
  });

  // Fetch Users & Companies
  const fetchData = async () => {
    setLoading(true);
    try {
      const [usersRes, companiesRes] = await Promise.all([
        fetchWithAuth("/api/users"),
        fetchWithAuth("/api/companies"),
      ]);

      console.log("Users response:", usersRes.status, usersRes.ok);
      console.log("Companies response:", companiesRes.status, companiesRes.ok);

      if (usersRes.ok) {
        const usersData = await usersRes.json();
        console.log("Usuários carregados:", usersData.length);
        setUsers(usersData);
      } else {
        const errorData = await usersRes.json().catch(() => ({}));
        console.error("Erro ao carregar usuários:", usersRes.status, errorData);
        setError(
          `Erro ao carregar usuários: ${errorData.error || usersRes.status}`,
        );
      }

      if (companiesRes.ok) {
        const companiesData = await companiesRes.json();
        console.log("Empresas carregadas:", companiesData.length);
        setCompanies(companiesData);
      } else {
        const errorData = await companiesRes.json().catch(() => ({}));
        console.error(
          "Erro ao carregar empresas:",
          companiesRes.status,
          errorData,
        );
      }
    } catch (err) {
      console.error("Erro geral:", err);
      setError("Erro ao carregar dados");
    } finally {
      setLoading(false);
    }
  };

  const fetchTrayStatus = async () => {
    setIsCheckingTrayStatus(true);

    try {
      const response = await fetchWithAuth("/api/tray/status");
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel consultar a integracao Tray.");
      }

      setTrayStatus({
        authorized: Boolean(data.authorized),
        status: data.status === "online" ? "online" : "offline",
        storeId: data.storeId || null,
        storeName: data.storeName || null,
        updatedAt: data.updatedAt || null,
        message:
          data.message ||
          (data.authorized
            ? "Integracao Tray online."
            : "Nenhuma integracao Tray autorizada."),
      });
    } catch (err: any) {
      setTrayStatus({
        authorized: false,
        status: "offline",
        storeId: null,
        storeName: null,
        updatedAt: null,
        message: err.message || "Nao foi possivel consultar a integracao Tray.",
      });
    } finally {
      setIsCheckingTrayStatus(false);
    }
  };

  const applyCompanyIntegrationState = (companyData: Company | null) => {
    setCurrentCompany(companyData);
    setTrayIntegrationEnabled(companyData?.trayIntegrationEnabled !== false);
    setAnymarketIntegrationEnabled(
      companyData?.anymarketIntegrationEnabled === true,
    );
    setBlingIntegrationEnabled(companyData?.blingIntegrationEnabled === true);
    setMagazordIntegrationEnabled(
      companyData?.magazordIntegrationEnabled === true,
    );
    setSysempIntegrationEnabled(companyData?.sysempIntegrationEnabled === true);
    setJetIntegrationEnabled(companyData?.jetIntegrationEnabled === true);
    setIntelipostIntegrationEnabled(
      companyData?.intelipostIntegrationEnabled !== false,
    );
    setSswRequireEnabled(companyData?.sswRequireEnabled !== false);
    setCorreiosIntegrationEnabled(
      companyData?.correiosIntegrationEnabled !== false,
    );
    setIntelipostClientId(companyData?.intelipostClientId || "");
    setIntelipostApiKey("");
    setIntelipostApiKeyConfigured(
      companyData?.intelipostApiKeyConfigured === true,
    );
    setAnymarketToken("");
    setAnymarketTokenConfigured(companyData?.anymarketTokenConfigured === true);
    setMagazordApiBaseUrl(companyData?.magazordApiBaseUrl || "");
    setMagazordApiUser(companyData?.magazordApiUser || "");
    setMagazordApiPassword("");
    setMagazordApiPasswordConfigured(
      companyData?.magazordApiPasswordConfigured === true,
    );
    setJetStoreId(companyData?.jetStoreId || "");
    setJetIntegrationKey("");
    setJetIntegrationKeyConfigured(
      companyData?.jetIntegrationKeyConfigured === true,
    );
    setJetUsername(companyData?.jetUsername || "");
    setJetUsernameConfigured(companyData?.jetUsernameConfigured === true);
    setJetPassword("");
    setJetPasswordConfigured(companyData?.jetPasswordConfigured === true);
    setJetBearerToken("");
    setJetBearerTokenConfigured(companyData?.jetBearerTokenConfigured === true);
    setSswRequireCnpjs(
      Array.isArray(companyData?.sswRequireCnpjs) &&
        companyData.sswRequireCnpjs.length > 0
        ? companyData.sswRequireCnpjs
        : [""],
    );
    setIntegrationCarrierExceptions(
      Array.isArray(companyData?.integrationCarrierExceptions) &&
        companyData.integrationCarrierExceptions.length > 0
        ? companyData.integrationCarrierExceptions
        : [""],
    );
    setIntegrationManualStatuses(
      Array.isArray(companyData?.integrationManualStatuses) &&
        companyData.integrationManualStatuses.length > 0
        ? companyData.integrationManualStatuses
        : [""],
    );
    setIntegrationAutoSyncStatuses(
      Array.isArray(companyData?.integrationAutoSyncStatuses) &&
        companyData.integrationAutoSyncStatuses.length > 0
        ? companyData.integrationAutoSyncStatuses
        : [""],
    );
    setShippingCutoffTime(companyData?.shippingCutoffTime || "23:59");
  };

  const fetchCurrentCompany = async () => {
    try {
      const response = await fetchWithAuth("/api/companies/current");
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel carregar a empresa atual.",
        );
      }

      applyCompanyIntegrationState(data);
    } catch {
      applyCompanyIntegrationState(null);
    }
  };

  const fetchCurrentUserProfile = async () => {
    if (!user?.id) return;

    setIsLoadingProfile(true);
    try {
      const response = await fetchWithAuth("/api/users/me");
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel carregar seu perfil.");
      }

      const profileUser = data.user || {};
      setProfileForm({
        name: profileUser.name || user.name || "",
        email: profileUser.email || user.email || "",
        phone: profileUser.phone || "",
        birthDate: formatBirthDateForInput(profileUser.birthDate || null),
        profileImageData: profileUser.profileImageData || "",
        receivePlatformEmails: profileUser.receivePlatformEmails !== false,
      });

      if (user) {
        setUser({
          ...user,
          name: profileUser.name || user.name,
          phone: profileUser.phone || null,
          birthDate: profileUser.birthDate || null,
          profileImageData: profileUser.profileImageData || null,
          receivePlatformEmails: profileUser.receivePlatformEmails !== false,
        });
      }
    } catch (err: any) {
      adminToast(err.message || "Erro ao carregar dados do perfil.", "error");
    } finally {
      setIsLoadingProfile(false);
    }
  };

  const handleProfileImageUpload = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const compressedDataUrl = await compressImageToLimit(
        file,
        MAX_PROFILE_IMAGE_BYTES,
      );
      setProfileForm((current) => ({
        ...current,
        profileImageData: compressedDataUrl,
      }));
      adminToast("Foto de perfil preparada com sucesso.", "success");
    } catch (error: any) {
      adminToast(
        error?.message || "Nao foi possivel processar a foto de perfil.",
        "error",
      );
    } finally {
      event.target.value = "";
    }
  };

  const handleSaveProfile = async () => {
    if (!profileForm.name.trim()) {
      adminToast("Informe seu nome para salvar o perfil.", "warning");
      return;
    }

    setIsSavingProfile(true);
    try {
      const payload = {
        name: profileForm.name.trim(),
        phone: profileForm.phone.trim() || null,
        birthDate: profileForm.birthDate || null,
        profileImageData: profileForm.profileImageData || null,
        receivePlatformEmails: profileForm.receivePlatformEmails !== false,
      };

      const response = await fetchWithAuth("/api/users/me/profile", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel salvar seu perfil.");
      }

      const updatedUser = data.user || {};
      setProfileForm((current) => ({
        ...current,
        name: updatedUser.name || current.name,
        email: updatedUser.email || current.email,
        phone: updatedUser.phone || "",
        birthDate: formatBirthDateForInput(updatedUser.birthDate || null),
        profileImageData: updatedUser.profileImageData || "",
        receivePlatformEmails: updatedUser.receivePlatformEmails !== false,
      }));

      if (user) {
        setUser({
          ...user,
          name: updatedUser.name || user.name,
          phone: updatedUser.phone || null,
          birthDate: updatedUser.birthDate || null,
          profileImageData: updatedUser.profileImageData || null,
          receivePlatformEmails: updatedUser.receivePlatformEmails !== false,
        });
      }

      adminToast(data.message || "Perfil atualizado com sucesso.", "success");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar perfil.", "error");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleChangeMyPassword = async () => {
    if (!profilePasswordForm.currentPassword.trim()) {
      adminToast("Informe sua senha atual.", "warning");
      return;
    }

    if (profilePasswordForm.newPassword.length < 8) {
      adminToast("A nova senha precisa ter no minimo 8 caracteres.", "warning");
      return;
    }

    if (profilePasswordForm.newPassword !== profilePasswordForm.confirmPassword) {
      adminToast("A confirmacao da nova senha nao confere.", "warning");
      return;
    }

    setIsSavingPassword(true);
    try {
      const response = await fetchWithAuth("/api/users/me/password", {
        method: "POST",
        body: JSON.stringify(profilePasswordForm),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel alterar sua senha.");
      }

      adminToast(
        data.message || "Senha alterada com sucesso.",
        data.emailConfirmationSent ? "success" : "warning",
      );
      setProfilePasswordForm({
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      });
    } catch (err: any) {
      adminToast(err.message || "Erro ao alterar senha.", "error");
    } finally {
      setIsSavingPassword(false);
    }
  };

  useEffect(() => {
    if (canManageAdminPanel) {
      const params = new URLSearchParams(window.location.search);
      const requestedTab = params.get("tab");

      if (
        requestedTab !== "integration" &&
        requestedTab !== "companies" &&
        requestedTab !== "webhooks" &&
        requestedTab !== "patch-notes"
      ) {
        setActiveTab((currentTab) =>
          currentTab === "integration" ? "users" : currentTab,
        );
      }

      fetchData();
      return;
    }

    setLoading(false);
    setUsers([]);
    setCompanies([]);
    setError("");
    setActiveTab("integration");
  }, [canManageAdminPanel]);

  useEffect(() => {
    if (activeTab !== "integration" && activeTab !== "webhooks") return;

    fetchCurrentCompany();
    fetchCurrentUserProfile();

    if (activeTab !== "integration") {
      return;
    }

    const refreshTrayStatus = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      fetchTrayStatus();
    };

    fetchTrayStatus();
    const interval = window.setInterval(refreshTrayStatus, 120000);
    window.addEventListener("focus", refreshTrayStatus);
    document.addEventListener("visibilitychange", refreshTrayStatus);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshTrayStatus);
      document.removeEventListener("visibilitychange", refreshTrayStatus);
    };
  }, [activeTab, user?.companyId, user?.id]);

  useEffect(() => {
    if (activeTab !== "integration" || settingsSubTab !== "profile") return;
    fetchCurrentUserProfile();
  }, [activeTab, settingsSubTab, user?.id]);

  useEffect(() => {
    if (activeTab !== "webhooks") return;
    setWebhookLogs([]);
    setWebhookLogFilter("all");
  }, [activeTab, webhookProvider]);

  useEffect(() => {
    const providerEnabled =
      webhookProvider === "intelipost"
        ? intelipostIntegrationEnabled
        : anymarketIntegrationEnabled;

    const shouldLoadWebhookLogs =
      activeTab === "webhooks" &&
      Boolean(currentCompany?.id) &&
      providerEnabled;

    if (!shouldLoadWebhookLogs) {
      return;
    }

    void fetchWebhookLogs(webhookProvider, { silent: true });
    const interval = window.setInterval(() => {
      void fetchWebhookLogs(webhookProvider, { silent: true });
    }, 30000);

    return () => {
      window.clearInterval(interval);
    };
  }, [
    activeTab,
    currentCompany?.id,
    intelipostIntegrationEnabled,
    anymarketIntegrationEnabled,
    webhookProvider,
  ]);

  useEffect(() => {
    if (!user) return;

    setProfileForm((current) => ({
      ...current,
      name: current.name || user.name || "",
      email: current.email || user.email || "",
      phone: current.phone || user.phone || "",
      birthDate: current.birthDate || formatBirthDateForInput(user.birthDate || null),
      profileImageData: current.profileImageData || user.profileImageData || "",
      receivePlatformEmails: current.receivePlatformEmails ?? (user.receivePlatformEmails !== false),
    }));
  }, [
    user?.birthDate,
    user?.email,
    user?.id,
    user?.name,
    user?.phone,
    user?.profileImageData,
    user?.receivePlatformEmails,
  ]);

  useEffect(() => {
    if (!canManageAdminPanel || users.length === 0) return;

    setSelectedRecipientIds((currentIds) => {
      if (currentIds.length === 0) {
        return users.map((userItem) => userItem.id);
      }

      return currentIds.filter((id) =>
        users.some((userItem) => userItem.id === id),
      );
    });
  }, [canManageAdminPanel, users]);

  useEffect(() => {
    if (!canManageAdminPanel) return;

    setUsersCompanyFilter((current) => {
      if (current === "all") return current;
      return companies.some((company) => company.id === current) ? current : "all";
    });

    setSelectedCompanyViewId((current) => {
      if (companies.length === 0) return "";
      if (current && companies.some((company) => company.id === current)) {
        return current;
      }
      return companies[0].id;
    });
  }, [canManageAdminPanel, companies]);

  useEffect(() => {
    if (!canManageAdminPanel || activeTab !== "companies" || !selectedCompanyViewId) {
      setCompanyUsageSummary(null);
      setCompanyUsageError("");
      return;
    }

    let cancelled = false;

    const fetchCompanyUsageSummary = async () => {
      setIsLoadingCompanyUsage(true);
      setCompanyUsageError("");

      try {
        const response = await fetchWithAuth(
          `/api/companies/${selectedCompanyViewId}/usage-summary`,
        );
        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data?.error || "Nao foi possivel carregar o resumo da empresa.",
          );
        }

        if (!cancelled) {
          setCompanyUsageSummary(data as CompanyUsageSummary);
        }
      } catch (error: any) {
        if (!cancelled) {
          setCompanyUsageSummary(null);
          setCompanyUsageError(
            error?.message || "Nao foi possivel carregar o resumo da empresa.",
          );
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCompanyUsage(false);
        }
      }
    };

    void fetchCompanyUsageSummary();

    return () => {
      cancelled = true;
    };
  }, [activeTab, canManageAdminPanel, selectedCompanyViewId]);

  // Actions
  const handleOpenModal = (userToEdit?: UserData) => {
    if (userToEdit) {
      setEditingUser(userToEdit);
      setFormData({
        name: userToEdit.name,
        email: userToEdit.email,
        role: userToEdit.role,
        companyId: userToEdit.companyId || "",
        password: "", // Don't show existing password
      });
    } else {
      setEditingUser(null);
      setFormData({
        name: "",
        email: "",
        role: "USER",
        companyId: "",
        password: "",
      });
    }
    setIsModalOpen(true);
  };

  const handleSaveCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const normalizedDocumentNumber = normalizeIdentityDigits(
        companyFormData.documentNumber || companyFormData.cnpj || "",
      );
      const resolvedDocumentType = resolveIdentityDocumentType(
        companyFormData.documentType,
        normalizedDocumentNumber,
      );
      const payload = {
        ...companyFormData,
        documentType: resolvedDocumentType || undefined,
        documentNumber: normalizedDocumentNumber || undefined,
        cnpj:
          resolvedDocumentType === "CNPJ" && normalizedDocumentNumber
            ? normalizedDocumentNumber
            : companyFormData.cnpj || undefined,
        tenantGlobalId: companyFormData.tenantGlobalId.trim() || undefined,
      };

      const response = await fetchWithAuth("/api/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        fetchData();
        setIsCompanyModalOpen(false);
        setCompanyFormData({
          name: "",
          cnpj: "",
          documentType: "CNPJ",
          documentNumber: "",
          tenantGlobalId: "",
        });
      } else {
        adminToast("Erro ao criar empresa");
      }
    } catch (err) {
      adminToast("Erro ao criar empresa");
    }
  };

  const handleDeleteCompany = async (id: string) => {
    if (!window.confirm("Tem certeza? Isso pode afetar usuários vinculados."))
      return;
    await fetchWithAuth(`/api/companies/${id}`, { method: "DELETE" });
    fetchData();
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      const url = editingUser ? `/api/users/${editingUser.id}` : "/api/users";
      const method = editingUser ? "PUT" : "POST";

      const body: any = { ...formData };
      if (!editingUser || !body.password) delete body.password;

      const response = await fetchWithAuth(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to save user");
      }

      const result = await response.json();
      setIsModalOpen(false);
      if (!editingUser && result?.message) {
        adminToast(result.message);
      }
      fetchData();
    } catch (err: any) {
      adminToast(err.message);
    }
  };

  const handleDeleteUser = async (id: string) => {
    if (!window.confirm("Tem certeza que deseja remover este usuário?")) return;

    try {
      const response = await fetchWithAuth(`/api/users/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Failed to delete user");
      fetchData();
    } catch (err) {
      console.error(err);
      adminToast("Erro ao deletar usuário");
    }
  };

  const handleConnectTray = async () => {
    const normalizedUrl = trayStoreUrl.trim();

    if (!normalizedUrl) {
      adminToast("Informe a URL da loja ou a URL /web_api da Tray.");
      return;
    }

    try {
      const params = new URLSearchParams({
        url: normalizedUrl,
      });

      const response = await fetchWithAuth(`/api/tray/connect?${params.toString()}`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel iniciar a integracao Tray.");
      }

      if (!data.authUrl) {
        throw new Error("A URL de autorizacao da Tray nao foi retornada.");
      }

      window.open(data.authUrl, "_blank");
    } catch (err: any) {
      adminToast(err.message || "Erro ao iniciar a integracao Tray.");
    }
  };

  const handleSaveIntelipost = async () => {
    const normalizedId = intelipostClientId.trim();
    const normalizedApiKey = intelipostApiKey.trim();

    if (!normalizedId) {
      adminToast("Informe o ID padrao da Intelipost para a empresa.");
      return;
    }

    setIsSavingIntelipost(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intelipostClientId: normalizedId,
          ...(normalizedApiKey ? { intelipostApiKey: normalizedApiKey } : {}),
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar o ID da Intelipost.",
        );
      }

      setCurrentCompany(data.company || null);
      setIntelipostClientId(data.company?.intelipostClientId || normalizedId);
      setIntelipostApiKey("");
      setIntelipostApiKeyConfigured(
        data.company?.intelipostApiKeyConfigured === true ||
          (normalizedApiKey ? true : intelipostApiKeyConfigured),
      );
      adminToast(data.message || "Configuracao da Intelipost atualizada com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar ID da Intelipost.");
    } finally {
      setIsSavingIntelipost(false);
    }
  };

  const handleAddSswRequireCnpj = () => {
    setSswRequireCnpjs((currentValues) => [...currentValues, ""]);
  };

  const handleChangeSswRequireCnpj = (index: number, value: string) => {
    const normalized = value.replace(/\D/g, "");
    setSswRequireCnpjs((currentValues) =>
      currentValues.map((item, itemIndex) =>
        itemIndex === index ? normalized : item,
      ),
    );
  };

  const handleRemoveSswRequireCnpj = (index: number) => {
    setSswRequireCnpjs((currentValues) => {
      const nextValues = currentValues.filter((_, itemIndex) => itemIndex !== index);
      return nextValues.length > 0 ? nextValues : [""];
    });
  };

  const handleSaveSswRequire = async () => {
    const normalizedCnpjs = Array.from(
      new Set(
        sswRequireCnpjs
          .map((value) => value.replace(/\D/g, "").trim())
          .filter(Boolean),
      ),
    );

    if (normalizedCnpjs.some((cnpj) => cnpj.length !== 14)) {
      adminToast("Todos os CNPJs do SSW devem conter 14 digitos sem pontuacao.");
      return;
    }

    setIsSavingSswRequire(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sswRequireCnpjs: normalizedCnpjs }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar os CNPJs do SSW Require.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(data.message || "CNPJs do SSW Require atualizados com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar os CNPJs do SSW Require.");
    } finally {
      setIsSavingSswRequire(false);
    }
  };

  const handleAddCarrierException = () => {
    setIntegrationCarrierExceptions((currentValues) => [...currentValues, ""]);
  };

  const handleChangeCarrierException = (index: number, value: string) => {
    setIntegrationCarrierExceptions((currentValues) =>
      currentValues.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    );
  };

  const handleRemoveCarrierException = (index: number) => {
    setIntegrationCarrierExceptions((currentValues) => {
      const nextValues = currentValues.filter((_, itemIndex) => itemIndex !== index);
      return nextValues.length > 0 ? nextValues : [""];
    });
  };

  const handleSaveCarrierExceptions = async () => {
    const normalizedExceptions = Array.from(
      new Set(
        integrationCarrierExceptions
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );

    setIsSavingCarrierExceptions(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationCarrierExceptions: normalizedExceptions,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar as excecoes de transportadora.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(data.message || "Excecoes de transportadora atualizadas com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar as excecoes de transportadora.");
    } finally {
      setIsSavingCarrierExceptions(false);
    }
  };

  const handleAddIntegrationManualStatus = () => {
    setIntegrationManualStatuses((currentValues) => [...currentValues, ""]);
  };

  const handleChangeIntegrationManualStatus = (index: number, value: string) => {
    setIntegrationManualStatuses((currentValues) =>
      currentValues.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    );
  };

  const handleRemoveIntegrationManualStatus = (index: number) => {
    setIntegrationManualStatuses((currentValues) => {
      const nextValues = currentValues.filter((_, itemIndex) => itemIndex !== index);
      return nextValues.length > 0 ? nextValues : [""];
    });
  };

  const handleSaveIntegrationManualStatuses = async () => {
    const normalizedStatuses = Array.from(
      new Set(
        integrationManualStatuses
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );

    setIsSavingIntegrationManualStatuses(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationManualStatuses: normalizedStatuses,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar os status manuais da integradora.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(
        data.message || "Status manuais da integradora atualizados com sucesso.",
      );
    } catch (err: any) {
      adminToast(
        err.message || "Erro ao salvar os status manuais da integradora.",
      );
    } finally {
      setIsSavingIntegrationManualStatuses(false);
    }
  };

  const handleAddIntegrationAutoSyncStatus = () => {
    setIntegrationAutoSyncStatuses((currentValues) => [...currentValues, ""]);
  };

  const handleChangeIntegrationAutoSyncStatus = (
    index: number,
    value: string,
  ) => {
    setIntegrationAutoSyncStatuses((currentValues) =>
      currentValues.map((item, itemIndex) =>
        itemIndex === index ? value : item,
      ),
    );
  };

  const handleRemoveIntegrationAutoSyncStatus = (index: number) => {
    setIntegrationAutoSyncStatuses((currentValues) => {
      const nextValues = currentValues.filter((_, itemIndex) => itemIndex !== index);
      return nextValues.length > 0 ? nextValues : [""];
    });
  };

  const handleSaveIntegrationAutoSyncStatuses = async () => {
    const normalizedStatuses = Array.from(
      new Set(
        integrationAutoSyncStatuses
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );

    setIsSavingIntegrationAutoSyncStatuses(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integrationAutoSyncStatuses: normalizedStatuses,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar os status do sync automatico.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(
        data.message || "Status do sync automatico atualizados com sucesso.",
      );
    } catch (err: any) {
      adminToast(
        err.message || "Erro ao salvar os status do sync automatico.",
      );
    } finally {
      setIsSavingIntegrationAutoSyncStatuses(false);
    }
  };

  const handleSaveShippingCutoffTime = async () => {
    if (!currentCompany) return;

    const normalized = shippingCutoffTime.trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(normalized)) {
      adminToast("Informe o horario de corte no formato HH:mm (00:00 a 23:59).");
      return;
    }

    setIsSavingShippingCutoffTime(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shippingCutoffTime: normalized,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar o horario de corte.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(data.message || "Horario de corte atualizado com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar o horario de corte.");
    } finally {
      setIsSavingShippingCutoffTime(false);
    }
  };

  const fetchWebhookLogs = async (
    provider: WebhookProvider,
    options?: { silent?: boolean },
  ) => {
    const silent = options?.silent === true;
    setIsLoadingWebhookLogs(true);
    try {
      const response = await fetchWithAuth(`/api/webhooks/${provider}/logs?limit=120`);
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel carregar os logs de webhook.",
        );
      }

      const logs = Array.isArray(data.logs)
        ? (data.logs as IntelipostWebhookLog[])
        : [];
      setWebhookLogs(logs);
    } catch (err: any) {
      setWebhookLogs([]);
      if (!silent) {
        adminToast(err.message || "Erro ao carregar logs de webhook.");
      }
    } finally {
      setIsLoadingWebhookLogs(false);
    }
  };

  const handleClearWebhookFailures = async () => {
    setIsClearingWebhookFailures(true);
    try {
      const response = await fetchWithAuth(`/api/webhooks/${webhookProvider}/failures`, {
        method: "DELETE",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel limpar as falhas de webhook.");
      }

      adminToast(
        data.message ||
          `Falhas de webhook limpas com sucesso (${Number(data.removed || 0)} removidas).`,
      );
      await fetchWebhookLogs(webhookProvider, { silent: true });
    } catch (err: any) {
      adminToast(err.message || "Erro ao limpar falhas de webhook.");
    } finally {
      setIsClearingWebhookFailures(false);
    }
  };

  const openClearWebhookFailuresModal = () => {
    setIsClearWebhookFailuresModalOpen(true);
  };

  const closeClearWebhookFailuresModal = () => {
    if (isClearingWebhookFailures) return;
    setIsClearWebhookFailuresModalOpen(false);
  };

  const handleReprocessWebhookFailures = async () => {
    setIsReprocessingWebhookFailures(true);
    try {
      const response = await fetchWithAuth(
        `/api/webhooks/${webhookProvider}/failures/reprocess`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 120 }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel reprocessar as falhas de webhook.");
      }

      const attempted = Number(data.attempted || 0);
      const reprocessed = Number(data.reprocessed || 0);
      const stillFailed = Number(data.stillFailed || 0);
      const skipped = Number(data.skipped || 0);
      adminToast(
        `Reprocessamento concluido. Tentativas: ${attempted}. Vinculados/processados: ${reprocessed}. Ainda com falha: ${stillFailed}. Ignorados: ${skipped}.`,
      );
      await fetchWebhookLogs(webhookProvider, { silent: true });
    } catch (err: any) {
      adminToast(err.message || "Erro ao reprocessar falhas de webhook.");
    } finally {
      setIsReprocessingWebhookFailures(false);
    }
  };

  const handleSaveIntegrationToggle = async (
    field:
      | "trayIntegrationEnabled"
      | "anymarketIntegrationEnabled"
      | "blingIntegrationEnabled"
      | "magazordIntegrationEnabled"
      | "sysempIntegrationEnabled"
      | "jetIntegrationEnabled"
      | "intelipostIntegrationEnabled"
      | "sswRequireEnabled"
      | "correiosIntegrationEnabled",
    value: boolean,
  ) => {
    if (!currentCompany) return;

    const isErpToggle =
      field === "trayIntegrationEnabled" ||
      field === "anymarketIntegrationEnabled" ||
      field === "blingIntegrationEnabled" ||
      field === "magazordIntegrationEnabled" ||
      field === "sysempIntegrationEnabled" ||
      field === "jetIntegrationEnabled";

    if (isErpToggle && value) {
      const activeErpField =
        trayIntegrationEnabled
          ? "trayIntegrationEnabled"
          : anymarketIntegrationEnabled
            ? "anymarketIntegrationEnabled"
          : blingIntegrationEnabled
            ? "blingIntegrationEnabled"
            : magazordIntegrationEnabled
              ? "magazordIntegrationEnabled"
              : sysempIntegrationEnabled
                ? "sysempIntegrationEnabled"
                : jetIntegrationEnabled
                  ? "jetIntegrationEnabled"
                : null;

      if (activeErpField && activeErpField !== field) {
        adminToast(
          "Nao e permitido ativar um segundo ERP. Desative o ERP atual antes de ativar outro.",
        );
        return;
      }
    }

    setIsSavingIntegrationToggle(true);
    try {
      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [field]: value,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel atualizar o status da integracao.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
    } catch (err: any) {
      adminToast(err.message || "Erro ao atualizar a integracao.");
      await fetchCurrentCompany();
    } finally {
      setIsSavingIntegrationToggle(false);
    }
  };

  const handleSaveAnymarket = async () => {
    if (!currentCompany) return;

    const trimmedToken = anymarketToken.trim();

    if (!trimmedToken && !anymarketTokenConfigured) {
      adminToast("Informe o gumgaToken da ANYMARKET.");
      return;
    }

    setIsSavingAnymarket(true);
    try {
      const payload: Record<string, string> = {};

      if (trimmedToken) {
        payload.anymarketToken = trimmedToken;
      }

      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar o gumgaToken da ANYMARKET.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(data.message || "gumgaToken da ANYMARKET atualizado com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar o gumgaToken da ANYMARKET.");
    } finally {
      setIsSavingAnymarket(false);
    }
  };

  const handleSaveMagazord = async () => {
    if (!currentCompany) return;

    const trimmedBaseUrl = magazordApiBaseUrl.trim();
    const trimmedUser = magazordApiUser.trim();

    setIsSavingMagazord(true);
    try {
      const payload: Record<string, string> = {
        magazordApiBaseUrl: trimmedBaseUrl,
        magazordApiUser: trimmedUser,
      };

      if (magazordApiPassword.trim()) {
        payload.magazordApiPassword = magazordApiPassword.trim();
      }

      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar as credenciais da Magazord.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(data.message || "Credenciais da Magazord atualizadas com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar as credenciais da Magazord.");
    } finally {
      setIsSavingMagazord(false);
    }
  };

  const handleSaveJet = async () => {
    if (!currentCompany) return;

    const trimmedApiKey = jetIntegrationKey.trim();
    if (jetIntegrationEnabled && !trimmedApiKey && !jetIntegrationKeyConfigured) {
      adminToast(
        "Informe a Credencial de Integracao JET (apiKey) para manter a integracao ativa.",
      );
      return;
    }

    setIsSavingJet(true);
    try {
      const payload: Record<string, string> = {
        jetStoreId: jetStoreId.trim(),
        jetUsername: jetUsername.trim(),
      };

      if (trimmedApiKey) {
        payload.jetIntegrationKey = trimmedApiKey;
      }

      if (jetPassword.trim()) {
        payload.jetPassword = jetPassword.trim();
      }

      if (jetBearerToken.trim()) {
        payload.jetBearerToken = jetBearerToken.trim();
      }

      const response = await fetchWithAuth("/api/companies/current/integration", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "Nao foi possivel salvar as credenciais da Jet.",
        );
      }

      applyCompanyIntegrationState(data.company || null);
      adminToast(data.message || "Credenciais da Jet atualizadas com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao salvar as credenciais da Jet.");
    } finally {
      setIsSavingJet(false);
    }
  };

  const handlePatchNotesFieldChange = (
    field: keyof PatchNotesFormData,
    value: string,
  ) => {
    setPatchNotesForm((currentForm) => ({
      ...currentForm,
      [field]: value,
    }));
  };

  const handleToggleRecipient = (userId: string) => {
    setSelectedRecipientIds((currentIds) =>
      currentIds.includes(userId)
        ? currentIds.filter((id) => id !== userId)
        : [...currentIds, userId],
    );
  };

  const handleSelectVisibleRecipients = (visibleUserIds: string[]) => {
    setSelectedRecipientIds((currentIds) => {
      const nextIds = new Set(currentIds);
      visibleUserIds.forEach((id) => nextIds.add(id));
      return Array.from(nextIds);
    });
  };

  const handleClearVisibleRecipients = (visibleUserIds: string[]) => {
    const visibleIds = new Set(visibleUserIds);
    setSelectedRecipientIds((currentIds) =>
      currentIds.filter((id) => !visibleIds.has(id)),
    );
  };

  const handleSendReleaseNotes = async () => {
    if (!patchNotesForm.version.trim()) {
      adminToast("Informe a versao do release notes.");
      return;
    }

    if (!patchNotesForm.title.trim()) {
      adminToast("Informe o titulo do release notes.");
      return;
    }

    if (!patchNotesForm.summary.trim()) {
      adminToast("Informe o texto principal do release notes.");
      return;
    }

    if (selectedRecipientIds.length === 0) {
      adminToast("Selecione pelo menos um destinatario.");
      return;
    }

    setIsSendingReleaseNotes(true);
    try {
      const response = await fetchWithAuth("/api/release-notes/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...patchNotesForm,
          recipientUserIds: selectedRecipientIds,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || "Nao foi possivel enviar o release notes.");
      }

      adminToast(data.message || "Release notes enviado com sucesso.");
    } catch (err: any) {
      adminToast(err.message || "Erro ao enviar release notes.");
    } finally {
      setIsSendingReleaseNotes(false);
    }
  };

  const handleClearDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (clearPassword !== "172839") {
      adminToast("Senha incorreta.");
      return;
    }

    if (!clearCompanyId) {
      adminToast("Selecione a empresa que terá os pedidos excluídos.");
      return;
    }

    setIsClearing(true);
    try {
      const response = await fetchWithAuth("/api/orders/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: clearType,
          password: clearPassword,
          companyId: clearCompanyId,
          status: clearStatus,
          period: clearPeriod,
          customStartDate: clearCustomStartDate,
          customEndDate: clearCustomEndDate,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Erro ao limpar banco de dados");
      }

      const result = await response.json();
      adminToast(result.message || "Operação realizada com sucesso!");
      resetClearDatabaseModal();
    } catch (error: any) {
      adminToast(error.message);
    } finally {
      setIsClearing(false);
    }
  };

  const resetClearDatabaseModal = () => {
    setIsClearModalOpen(false);
    setClearCompanyId("");
    setClearPassword("");
    setClearStatus("ALL");
    setClearPeriod("ALL");
    setClearCustomStartDate("");
    setClearCustomEndDate("");
  };

  const clearModalActionLabel =
    clearType === "ALL"
      ? "APAGAR TODOS OS PEDIDOS"
      : clearType === "DELIVERED_7_DAYS"
        ? "APAGAR PEDIDOS ENTREGUES HA MAIS DE 7 DIAS"
        : "APAGAR PEDIDOS FILTRADOS POR STATUS E PERIODO";

  if (loading)
    return (
      <div className="flex justify-center items-center p-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );

  const normalizedUsersSearch = usersSearch.trim().toLowerCase();
  const filteredAdminUsers = users.filter((userItem) => {
    const companyName = String(userItem.company?.name || "").toLowerCase();
    const matchesCompany =
      usersCompanyFilter === "all" || userItem.companyId === usersCompanyFilter;
    const matchesSearch =
      !normalizedUsersSearch ||
      userItem.name.toLowerCase().includes(normalizedUsersSearch) ||
      userItem.email.toLowerCase().includes(normalizedUsersSearch) ||
      companyName.includes(normalizedUsersSearch);

    return matchesCompany && matchesSearch;
  });

  const normalizedCompaniesSearch = companiesSearch.trim().toLowerCase();
  const companySelectionOptions = companies.filter((company) => {
    if (!normalizedCompaniesSearch) return true;

    const documentLabel = formatIdentityDocument(
      company.documentType,
      company.documentNumber || company.cnpj,
    ).toLowerCase();

    return (
      company.name.toLowerCase().includes(normalizedCompaniesSearch) ||
      documentLabel.includes(normalizedCompaniesSearch)
    );
  });
  const selectedCompany =
    companies.find((company) => company.id === selectedCompanyViewId) || null;

  const filteredRecipientUsers = users.filter((userItem) => {
    const normalizedSearch = recipientSearch.trim().toLowerCase();
    const matchesSearch =
      !normalizedSearch ||
      userItem.name.toLowerCase().includes(normalizedSearch) ||
      userItem.email.toLowerCase().includes(normalizedSearch);

    const matchesCompany =
      recipientCompanyFilter === "all" ||
      userItem.companyId === recipientCompanyFilter;

    return matchesSearch && matchesCompany;
  });

  const filteredRecipientIds = filteredRecipientUsers.map(
    (userItem) => userItem.id,
  );

  const normalizedIntegrationSearch = normalizeIntegrationSearchText(
    integrationSearch,
  );
  const integrationCardMatches = (...terms: string[]) => {
    if (!normalizedIntegrationSearch) {
      return true;
    }

    return terms.some((term) =>
      normalizeIntegrationSearchText(term).includes(normalizedIntegrationSearch),
    );
  };
  const hasVisibleIntegrations =
    integrationSubTab === "erp"
      ? integrationCardMatches("tray integracao principal pedidos loja autorizacao") ||
        integrationCardMatches("magazord erp pedidos basic auth usuario senha api") ||
        integrationCardMatches("jet openapi id order idpedido erp pedidos marketplace") ||
        integrationCardMatches("anymarket hub marketplace marketplaces pedidos gumga token rate limit tracking invoice nfe fulfillment") ||
        integrationCardMatches("bling erp implementacao futuro") ||
        integrationCardMatches("sysemp shopping de precos implementacao futuro")
      : integrationSubTab === "tracking"
        ? integrationCardMatches("intelipost tracking externo client id rastreio") ||
          integrationCardMatches("ssw require tracking nf cnpj rastreio") ||
          integrationCardMatches("correios api rastro codigo objeto rastreio pac sedex")
        : integrationCardMatches("configuracoes status manual integradora pedidos sync") ||
          integrationCardMatches("configuracoes status sync automatico integradora pedidos") ||
          integrationCardMatches(
            "configuracoes regras de importacao excecao de transportadora ignorar",
          );

  const isWebhookSuccessLog = (item: IntelipostWebhookLog) => {
    const type = String(item.type || "").trim().toUpperCase();
    if (!type) return false;

    return (
      type.endsWith("_WEBHOOK_PROCESSED") ||
      type.endsWith("_WEBHOOK_ORDER_RECOVERED")
    );
  };

  const isWebhookFailureLog = (item: IntelipostWebhookLog) => {
    const type = String(item.type || "").trim().toUpperCase();
    if (!type) return false;

    return (
      type.endsWith("_WEBHOOK_ORDER_NOT_FOUND") ||
      type.endsWith("_WEBHOOK_IGNORED") ||
      type.includes("FAILED") ||
      type.includes("ERROR")
    );
  };

  const webhookLogCounts = {
    all: webhookLogs.length,
    success: webhookLogs.filter(isWebhookSuccessLog).length,
    failed: webhookLogs.filter(isWebhookFailureLog).length,
  };

  const filteredWebhookLogs = webhookLogs.filter((item) => {
    if (webhookLogFilter === "success") return isWebhookSuccessLog(item);
    if (webhookLogFilter === "failed") return isWebhookFailureLog(item);
    return true;
  });

  const IntegrationToggle: React.FC<{
    enabled: boolean;
    disabled?: boolean;
    onChange?: (nextValue: boolean) => void;
  }> = ({ enabled, disabled = false, onChange }) => (
    <button
      type="button"
      onClick={() => !disabled && onChange?.(!enabled)}
      disabled={disabled}
      className={clsx(
        "relative inline-flex h-7 w-12 items-center rounded-full border transition-all",
        enabled
          ? "border-emerald-400 bg-emerald-500/90"
          : "border-slate-300 bg-slate-300 dark:border-white/10 dark:bg-white/10",
        disabled && "cursor-not-allowed opacity-60",
      )}
      aria-pressed={enabled}
    >
      <span
        className={clsx(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
          enabled ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      {/* Header Tabs */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-slate-800 dark:text-white flex items-center gap-2">
          <Shield className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          {canManageAdminPanel ? "Painel Administrativo" : "Configurações"}
        </h2>

        <div className="flex gap-2 bg-slate-100 dark:bg-white/5 p-1 rounded-lg">
          {canManageAdminPanel && (
            <>
              <button
                onClick={() => setActiveTab("users")}
                className={clsx(
                  "px-4 py-2 rounded-md text-sm font-medium transition-all",
                  activeTab === "users"
                    ? "bg-white dark:bg-slate-700 shadow text-blue-600 dark:text-white"
                    : "text-slate-500 hover:text-slate-700 dark:text-slate-400",
                )}
              >
                Usuários
              </button>
              <button
                onClick={() => setActiveTab("companies")}
                className={clsx(
                  "px-4 py-2 rounded-md text-sm font-medium transition-all",
                  activeTab === "companies"
                    ? "bg-white dark:bg-slate-700 shadow text-blue-600 dark:text-white"
                    : "text-slate-500 hover:text-slate-700 dark:text-slate-400",
                )}
              >
                Empresas
              </button>
              <button
                onClick={() => setActiveTab("patch-notes")}
                className={clsx(
                  "px-4 py-2 rounded-md text-sm font-medium transition-all",
                  activeTab === "patch-notes"
                    ? "bg-white dark:bg-slate-700 shadow text-blue-600 dark:text-white"
                    : "text-slate-500 hover:text-slate-700 dark:text-slate-400",
                )}
              >
                Patch Notes
              </button>
              <button
                onClick={() => setActiveTab("webhooks")}
                className={clsx(
                  "px-4 py-2 rounded-md text-sm font-medium transition-all",
                  activeTab === "webhooks"
                    ? "bg-white dark:bg-slate-700 shadow text-blue-600 dark:text-white"
                    : "text-slate-500 hover:text-slate-700 dark:text-slate-400",
                )}
              >
                WebHooks
              </button>
            </>
          )}
          <button
            onClick={() => setActiveTab("integration")}
            className={clsx(
              "px-4 py-2 rounded-md text-sm font-medium transition-all",
              activeTab === "integration"
                ? "bg-white dark:bg-slate-700 shadow text-blue-600 dark:text-white"
                : "text-slate-500 hover:text-slate-700 dark:text-slate-400",
            )}
          >
            Configurações
          </button>
        </div>
      </div>

      {canManageAdminPanel && activeTab === "users" && (
        <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10">
          <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5 flex justify-between items-center">
            <h3 className="font-semibold text-slate-800 dark:text-white">
              Controle de Usuários
            </h3>
            <button
              onClick={() => handleOpenModal()}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" /> Novo Usuário
            </button>
          </div>

          <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/40 dark:bg-white/[0.03]">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_260px_210px]">
              <input
                type="text"
                value={usersSearch}
                onChange={(e) => setUsersSearch(e.target.value)}
                placeholder="Buscar usuario por nome, e-mail ou empresa"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <select
                value={usersCompanyFilter}
                onChange={(e) => setUsersCompanyFilter(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
              >
                <option value="all">Todas as empresas</option>
                {companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                Exibindo {filteredAdminUsers.length} de {users.length} usuario(s)
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-500 dark:text-slate-400 uppercase bg-slate-50 dark:bg-white/5 border-b border-slate-200 dark:border-white/10">
                <tr>
                  <th className="px-6 py-3">Nome</th>
                  <th className="px-6 py-3">Email</th>
                  <th className="px-6 py-3">Função</th>
                  <th className="px-6 py-3">Empresa</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {filteredAdminUsers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-6 py-8 text-center text-slate-500 dark:text-slate-400"
                    >
                      {error ? (
                        <div>
                          <p className="text-red-500 font-medium">{error}</p>
                          <p className="text-xs mt-2">
                            Verifique o console para mais detalhes
                          </p>
                        </div>
                      ) : (
                        "Nenhum usuário encontrado"
                      )}
                    </td>
                  </tr>
                ) : (
                  filteredAdminUsers.map((u) => (
                    <tr
                      key={u.id}
                      className="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-slate-900 dark:text-white">
                        {u.name}
                      </td>
                      <td className="px-6 py-4 text-slate-500 dark:text-slate-400">
                        {u.email}
                      </td>
                      <td className="px-6 py-4">
                        <span
                          className={clsx(
                            "px-2 py-1 rounded-full text-xs font-semibold border",
                            u.role === "ADMIN"
                              ? "bg-purple-100 text-purple-700 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800"
                              : "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800",
                          )}
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-500 dark:text-slate-400">
                        {u.company?.name || (
                          <span className="text-slate-300 italic">
                            Sem empresa
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                          <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
                          Ativo
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleOpenModal(u)}
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                          >
                            <Edit className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => handleDeleteUser(u.id)}
                            className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canManageAdminPanel && activeTab === "companies" && (
        <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10">
          <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5 flex justify-between items-center">
            <h3 className="font-semibold text-slate-800 dark:text-white">
              Gerenciamento de Empresas
            </h3>
            <button
              onClick={() => setIsCompanyModalOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
            >
              <Plus className="w-4 h-4" /> Nova Empresa
            </button>
          </div>

          <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/40 dark:bg-white/[0.03]">
            <div className="grid gap-3 md:grid-cols-2">
              <input
                type="text"
                value={companiesSearch}
                onChange={(e) => setCompaniesSearch(e.target.value)}
                placeholder="Buscar empresa por nome ou documento"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <select
                value={selectedCompanyViewId}
                onChange={(e) => setSelectedCompanyViewId(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-blue-500 dark:border-white/10 dark:bg-white/5 dark:text-white"
                disabled={companySelectionOptions.length === 0}
              >
                {selectedCompany &&
                  !companySelectionOptions.some(
                    (company) => company.id === selectedCompany.id,
                  ) && (
                    <option value={selectedCompany.id}>
                      {selectedCompany.name}
                    </option>
                  )}
                {companySelectionOptions.length === 0 ? (
                  <option value="">Nenhuma empresa encontrada</option>
                ) : (
                  companySelectionOptions.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          <div className="p-4">
            {companies.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                Nenhuma empresa cadastrada.
              </div>
            ) : !selectedCompany ? (
              <div className="rounded-xl border border-dashed border-slate-200 px-6 py-10 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                Selecione uma empresa para visualizar os detalhes.
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-white/10 dark:bg-white/5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Empresa selecionada
                      </p>
                      <h4 className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                        {selectedCompany.name}
                      </h4>
                    </div>
                    <button
                      onClick={() => handleDeleteCompany(selectedCompany.id)}
                      className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-100 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Excluir empresa
                    </button>
                  </div>

                  <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Documento
                      </p>
                      <p className="mt-1 text-slate-800 dark:text-slate-200">
                        {formatIdentityDocument(
                          selectedCompany.documentType,
                          selectedCompany.documentNumber || selectedCompany.cnpj,
                        )}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Tenant Global
                      </p>
                      <p className="mt-1 text-slate-800 dark:text-slate-200">
                        {selectedCompany.tenantGlobalId || "-"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                        Criada em
                      </p>
                      <p className="mt-1 text-slate-800 dark:text-slate-200">
                        {formatMetricDateTime(selectedCompany.createdAt)}
                      </p>
                    </div>
                  </div>
                </div>

                {isLoadingCompanyUsage ? (
                  <div className="rounded-xl border border-slate-200 px-4 py-6 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                    Carregando uso da empresa...
                  </div>
                ) : companyUsageError ? (
                  <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-sm text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                    {companyUsageError}
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Total de usuarios
                        </p>
                        <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                          {formatMetricNumber(
                            companyUsageSummary?.totals.users ??
                              users.filter(
                                (userItem) =>
                                  userItem.companyId === selectedCompany.id,
                              ).length,
                          )}
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Total de pedidos
                        </p>
                        <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                          {formatMetricNumber(companyUsageSummary?.totals.orders)}
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Horas de sync (total)
                        </p>
                        <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                          {formatMetricHours(
                            companyUsageSummary?.usage.totalTrackingSyncHours,
                          )}
                        </p>
                      </div>
                      <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-white/5">
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          CU/CPU estimada (30 dias)
                        </p>
                        <p className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                          {formatMetricHours(
                            companyUsageSummary?.usage.cpuCuHoursEstimatedLast30Days,
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Banco de dados
                        </p>
                        <p className="mt-2 text-sm text-slate-800 dark:text-slate-200">
                          Configurado:{" "}
                          {companyUsageSummary?.database.configured ? "Sim" : "Nao"}
                        </p>
                        <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">
                          Host: {companyUsageSummary?.database.host || "-"}
                        </p>
                      </div>

                      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                        <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                          Sincronizacao de rastreio
                        </p>
                        <p className="mt-2 text-sm text-slate-800 dark:text-slate-200">
                          Execucoes:{" "}
                          {formatMetricNumber(
                            companyUsageSummary?.totals.trackingSyncRuns,
                          )}
                        </p>
                        <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">
                          Horas ultimos 30 dias:{" "}
                          {formatMetricHours(
                            companyUsageSummary?.usage.trackingSyncHoursLast30Days,
                          )}
                        </p>
                        <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">
                          Ultimo sync:{" "}
                          {formatMetricDateTime(
                            companyUsageSummary?.lastTrackingSyncAt,
                          )}
                        </p>
                        <p className="mt-1 text-sm text-slate-800 dark:text-slate-200">
                          Eventos sucesso/falha:{" "}
                          {formatMetricNumber(
                            companyUsageSummary?.totals.trackingSyncSuccessEvents,
                          )}{" "}
                          /{" "}
                          {formatMetricNumber(
                            companyUsageSummary?.totals.trackingSyncFailedEvents,
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="hidden overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-slate-500 dark:text-slate-400 uppercase bg-slate-50 dark:bg-white/5 border-b border-slate-200 dark:border-white/10">
                <tr>
                  <th className="px-6 py-3">Nome da Empresa</th>
                  <th className="px-6 py-3">Documento</th>
                  <th className="px-6 py-3">Tenant Global</th>
                  <th className="px-6 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {companies.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-6 py-8 text-center text-slate-400"
                    >
                      Nenhuma empresa cadastrada.
                    </td>
                  </tr>
                ) : (
                  companies.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-slate-100 dark:border-white/5 hover:bg-slate-50 dark:hover:bg-white/5 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-slate-900 dark:text-white">
                        {c.name}
                      </td>
                      <td className="px-6 py-4 text-slate-500 dark:text-slate-400">
                        {formatIdentityDocument(c.documentType, c.documentNumber || c.cnpj)}
                      </td>
                      <td className="px-6 py-4 text-slate-500 dark:text-slate-400">
                        {c.tenantGlobalId || "-"}
                      </td>
                      <td className="px-6 py-4 text-right">
                        <button
                          onClick={() => handleDeleteCompany(c.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {canManageAdminPanel && activeTab === "patch-notes" && (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5">
                <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  Release Notes
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Estruture a versao, monte o HTML e envie o comunicado de atualizacao por e-mail.
                </p>
              </div>

              <div className="p-6 space-y-5">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Versao
                    </label>
                    <input
                      type="text"
                      value={patchNotesForm.version}
                      onChange={(e) =>
                        handlePatchNotesFieldChange("version", e.target.value)
                      }
                      placeholder="v2.4.0"
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Titulo
                    </label>
                    <input
                      type="text"
                      value={patchNotesForm.title}
                      onChange={(e) =>
                        handlePatchNotesFieldChange("title", e.target.value)
                      }
                      placeholder="Nova atualizacao da plataforma"
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Texto principal
                  </label>
                  <textarea
                    rows={5}
                    value={patchNotesForm.summary}
                    onChange={(e) =>
                      handlePatchNotesFieldChange("summary", e.target.value)
                    }
                    placeholder="Descreva aqui o resumo principal da nova versao."
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none resize-y"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Novas funcionalidades
                  </label>
                  <textarea
                    rows={6}
                    value={patchNotesForm.newFeatures}
                    onChange={(e) =>
                      handlePatchNotesFieldChange("newFeatures", e.target.value)
                    }
                    placeholder={"Uma funcionalidade por linha\nNova aba de integracao\nSync automatico por empresa"}
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none resize-y"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Ajustes e melhorias
                  </label>
                  <textarea
                    rows={6}
                    value={patchNotesForm.adjustments}
                    onChange={(e) =>
                      handlePatchNotesFieldChange("adjustments", e.target.value)
                    }
                    placeholder={"Um ajuste por linha\nMelhoria no sync da Tray\nCorrecao de filtros do dashboard"}
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none resize-y"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-white">
                      Destinatarios selecionados: {selectedRecipientIds.length}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      O envio usara o sender configurado no Brevo.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleSendReleaseNotes}
                    disabled={isSendingReleaseNotes}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Send className="w-4 h-4" />
                    {isSendingReleaseNotes ? "Enviando..." : "Enviar Release Notes"}
                  </button>
                </div>
              </div>
            </div>

            <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5">
                <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
                  <Mail className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  Destinatarios
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  Selecione quais usuarios receberao o release notes.
                </p>
              </div>

              <div className="p-6 space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <input
                    type="text"
                    value={recipientSearch}
                    onChange={(e) => setRecipientSearch(e.target.value)}
                    placeholder="Buscar por nome ou e-mail"
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />

                  <select
                    value={recipientCompanyFilter}
                    onChange={(e) => setRecipientCompanyFilter(e.target.value)}
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  >
                    <option value="all">Todas as empresas</option>
                    {companies.map((company) => (
                      <option key={company.id} value={company.id}>
                        {company.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleSelectVisibleRecipients(filteredRecipientIds)
                    }
                    className="px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-300 transition-colors"
                  >
                    Selecionar visiveis
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleClearVisibleRecipients(filteredRecipientIds)
                    }
                    className="px-3 py-2 rounded-lg text-sm font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 dark:hover:text-red-300 transition-colors"
                  >
                    Limpar visiveis
                  </button>
                </div>

                <div className="max-h-[420px] overflow-y-auto space-y-2 pr-1">
                  {filteredRecipientUsers.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-200 dark:border-white/10 px-4 py-8 text-center text-sm text-slate-400">
                      Nenhum usuario encontrado com os filtros atuais.
                    </div>
                  ) : (
                    filteredRecipientUsers.map((userItem) => {
                      const isSelected = selectedRecipientIds.includes(
                        userItem.id,
                      );

                      return (
                        <label
                          key={userItem.id}
                          className={clsx(
                            "flex items-start gap-3 rounded-xl border px-4 py-3 cursor-pointer transition-colors",
                            isSelected
                              ? "border-blue-300 bg-blue-50 dark:border-blue-500/40 dark:bg-blue-500/10"
                              : "border-slate-200 bg-slate-50 dark:border-white/10 dark:bg-white/5",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => handleToggleRecipient(userItem.id)}
                            className="mt-1 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                          />
                          <div className="min-w-0">
                            <p className="font-medium text-slate-800 dark:text-white truncate">
                              {userItem.name}
                            </p>
                            <p className="text-sm text-slate-500 dark:text-slate-400 truncate">
                              {userItem.email}
                            </p>
                            <p className="text-xs text-slate-400 mt-1">
                              {userItem.company?.name || "Sem empresa"}
                            </p>
                          </div>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10">
            <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5 flex items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold text-slate-800 dark:text-white">
                  Previa do e-mail HTML
                </h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                  A previa acompanha os campos de versao, texto, funcionalidades e ajustes.
                </p>
              </div>
              <span className="inline-flex items-center rounded-full bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300 px-3 py-1 text-xs font-semibold border border-blue-200 dark:border-blue-500/20">
                Logo no topo
              </span>
            </div>

            <div className="bg-slate-200 dark:bg-slate-900 p-4">
              <iframe
                title="Previa do e-mail de patch notes"
                srcDoc={buildPatchNotesPreviewHtml(patchNotesForm)}
                className="w-full h-[820px] rounded-xl bg-white"
              />
            </div>
          </div>
        </div>
      )}

      {canManageAdminPanel && activeTab === "webhooks" && (
        <div className="space-y-6">
          <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 dark:border-white/10 dark:bg-white/5">
            <button
              type="button"
              onClick={() => setWebhookProvider("intelipost")}
              className={clsx(
                "px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                webhookProvider === "intelipost"
                  ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-white",
              )}
            >
              Intelipost
            </button>
            <button
              type="button"
              onClick={() => setWebhookProvider("anymarket")}
              className={clsx(
                "px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                webhookProvider === "anymarket"
                  ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-white",
              )}
            >
              AnyMarket
            </button>
          </div>

          <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
            <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    WebHooks
                  </p>
                  <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">
                    Controle de notificacoes de webhook
                  </h4>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    {webhookProvider === "intelipost"
                      ? "Eventos recebidos da Intelipost para atualizar rastreio dos pedidos em tempo real."
                      : "Eventos recebidos da AnyMarket para atualizacao de pedidos."}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void fetchWebhookLogs(webhookProvider)}
                    disabled={
                      isLoadingWebhookLogs ||
                      isClearingWebhookFailures ||
                      isReprocessingWebhookFailures ||
                      (webhookProvider === "intelipost"
                        ? !intelipostIntegrationEnabled
                        : !anymarketIntegrationEnabled)
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:border-slate-300 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-300"
                  >
                    {isLoadingWebhookLogs ? "Atualizando..." : "Atualizar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleReprocessWebhookFailures()}
                    disabled={
                      isLoadingWebhookLogs ||
                      isClearingWebhookFailures ||
                      isReprocessingWebhookFailures ||
                      (webhookProvider === "intelipost"
                        ? !intelipostIntegrationEnabled
                        : !anymarketIntegrationEnabled)
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:border-emerald-300 disabled:opacity-50 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {isReprocessingWebhookFailures
                      ? "Reprocessando..."
                      : "Reprocessar falhas"}
                  </button>
                  <button
                    type="button"
                    onClick={openClearWebhookFailuresModal}
                    disabled={
                      isLoadingWebhookLogs ||
                      isClearingWebhookFailures ||
                      isReprocessingWebhookFailures ||
                      (webhookProvider === "intelipost"
                        ? !intelipostIntegrationEnabled
                        : !anymarketIntegrationEnabled)
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:border-red-300 disabled:opacity-50 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Limpar falhas
                  </button>
                </div>
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setWebhookLogFilter("all")}
                  className={clsx(
                    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition-colors",
                    webhookLogFilter === "all"
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "border border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
                  )}
                >
                  <Filter className="h-3.5 w-3.5" />
                  Todos ({webhookLogCounts.all})
                </button>
                <button
                  type="button"
                  onClick={() => setWebhookLogFilter("success")}
                  className={clsx(
                    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition-colors",
                    webhookLogFilter === "success"
                      ? "bg-emerald-600 text-white"
                      : "border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300",
                  )}
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  Sucesso ({webhookLogCounts.success})
                </button>
                <button
                  type="button"
                  onClick={() => setWebhookLogFilter("failed")}
                  className={clsx(
                    "inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] transition-colors",
                    webhookLogFilter === "failed"
                      ? "bg-red-600 text-white"
                      : "border border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
                  )}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Falhas ({webhookLogCounts.failed})
                </button>
              </div>

              {(webhookProvider === "intelipost"
                ? !intelipostIntegrationEnabled
                : !anymarketIntegrationEnabled) ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
                  {webhookProvider === "intelipost"
                    ? "Ative a Intelipost para receber webhooks e visualizar os eventos."
                    : "Ative a AnyMarket para receber webhooks e visualizar os eventos."}
                </div>
              ) : filteredWebhookLogs.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-500 dark:border-white/10 dark:text-slate-400">
                  {isLoadingWebhookLogs
                    ? "Carregando logs de webhook..."
                    : "Nenhum evento encontrado para este filtro."}
                </div>
              ) : (
                <div className="space-y-2">
                  {filteredWebhookLogs.slice(0, 40).map((item) => {
                    const isSuccess = isWebhookSuccessLog(item);
                    const isFailure = isWebhookFailureLog(item);
                    const createdAtLabel = item.createdAt
                      ? new Date(item.createdAt).toLocaleString("pt-BR")
                      : "-";

                    return (
                      <div
                        key={item.id}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/5"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span
                              className={clsx(
                                "inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em]",
                                isSuccess
                                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300"
                                  : isFailure
                                    ? "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                                    : "bg-slate-200 text-slate-700 dark:bg-white/10 dark:text-slate-300",
                              )}
                            >
                              {isSuccess ? "Sucesso" : isFailure ? "Falha" : "Evento"}
                            </span>
                            <p className="text-sm font-semibold text-slate-800 dark:text-white">
                              {item.title || item.type}
                            </p>
                          </div>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {createdAtLabel}
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                          {item.message}
                        </p>
                        {(item.payload as any)?.orderNumber && (
                          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                            Pedido: #{String((item.payload as any).orderNumber)}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "integration" && (
        <div className="space-y-6">
          <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
            <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                  Configuracoes
                </p>
                <h3 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">
                  Minha area de configuracoes
                </h3>
                <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                  Escolha entre as configuracoes de integracao da empresa ou o gerenciamento do seu perfil.
                </p>
              </div>

              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 dark:border-white/10 dark:bg-white/5">
                <button
                  type="button"
                  onClick={() => setSettingsSubTab("integration")}
                  className={clsx(
                    "px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                    settingsSubTab === "integration"
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-white",
                  )}
                >
                  Integracao
                </button>
                <button
                  type="button"
                  onClick={() => setSettingsSubTab("profile")}
                  className={clsx(
                    "px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                    settingsSubTab === "profile"
                      ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                      : "text-slate-500 hover:text-slate-700 dark:text-slate-300 dark:hover:text-white",
                  )}
                >
                  Perfil
                </button>
              </div>
            </div>
          </div>

          {settingsSubTab === "integration" && (
          <>
          <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
            <div className="p-5 bg-[linear-gradient(135deg,#fff7ed_0%,#f8fafc_45%,#eff6ff_100%)] dark:bg-[linear-gradient(135deg,rgba(240,90,61,0.12),rgba(15,23,42,0.92),rgba(37,99,235,0.12))] border-b border-slate-200 dark:border-white/10">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <p className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-200">
                    Integracoes
                  </p>
                  <h3 className="mt-3 text-xl font-bold text-slate-800 dark:text-white">
                    Central de Integracao
                  </h3>
                  <p className="mt-2 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
                    Cada integracao fica no proprio card, com status, configuracoes e um toggle claro para ativar ou desativar o recurso da empresa.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-600 shadow-sm dark:border-white/10 dark:bg-white/5 dark:text-slate-300 min-w-[280px]">
                  <p className="font-semibold text-slate-700 dark:text-white">
                    Empresa atual: {currentCompany?.name || "Nao vinculada"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    As configuracoes abaixo sao compartilhadas por todos os usuarios desta empresa.
                  </p>
                  <div className="mt-3">
                    <div className="mb-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setIntegrationSubTab("erp")}
                        className={clsx(
                          "inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                          integrationSubTab === "erp"
                            ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                            : "border border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
                        )}
                      >
                        ERPs
                      </button>
                      <button
                        type="button"
                        onClick={() => setIntegrationSubTab("tracking")}
                        className={clsx(
                          "inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                          integrationSubTab === "tracking"
                            ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                            : "border border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
                        )}
                      >
                        Rastreio
                      </button>
                      <button
                        type="button"
                        onClick={() => setIntegrationSubTab("settings")}
                        className={clsx(
                          "inline-flex items-center rounded-full px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] transition-colors",
                          integrationSubTab === "settings"
                            ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                            : "border border-slate-200 bg-white text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
                        )}
                      >
                        Configuracoes
                      </button>
                    </div>
                    <label className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400 mb-2">
                      {integrationSubTab === "erp"
                        ? "Buscar ERP"
                        : integrationSubTab === "tracking"
                          ? "Buscar integracao de rastreio"
                          : "Buscar configuracao"}
                    </label>
                    <input
                      type="text"
                      value={integrationSearch}
                      onChange={(e) => setIntegrationSearch(e.target.value)}
                      placeholder={
                        integrationSubTab === "erp"
                          ? "Tray, Magazord, Jet, ANYMARKET, Bling, SYSEMP..."
                          : integrationSubTab === "tracking"
                            ? "Intelipost, SSW, Correios..."
                            : "Excecao de transportadora, importacao..."
                      }
                      className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {!hasVisibleIntegrations && (
            <div className="glass-card rounded-2xl border border-slate-200 dark:border-white/10 p-6 text-sm text-slate-500 dark:text-slate-400">
              {integrationSubTab === "erp"
                ? "Nenhum ERP encontrado para a busca informada."
                : integrationSubTab === "tracking"
                  ? "Nenhuma integracao de rastreio encontrada para a busca informada."
                  : "Nenhuma configuracao encontrada para a busca informada."}
            </div>
          )}

          {(integrationSubTab === "erp" || integrationSubTab === "tracking") && (
          <>
          <div className="columns-1 gap-6 xl:columns-2 2xl:columns-3">
            {integrationSubTab === "erp" && integrationCardMatches("tray integracao principal pedidos loja autorizacao") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Integracao principal</p>
                    <img
                      src={withBasePath("/logo-tray.png")}
                      alt="Tray"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Tray</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Autorize a loja, acompanhe o status e controle o uso da integracao de pedidos da Tray.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={trayIntegrationEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("trayIntegrationEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {trayIntegrationEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
                  Voce pode informar a URL da loja ou a URL completa com <span className="font-semibold">/web_api</span>. O sistema normaliza a URL antes de redirecionar para a Tray.
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/5">
                  <div className="flex items-center justify-between gap-3">
                    <div
                      className={clsx(
                        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide",
                        !trayIntegrationEnabled
                          ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200"
                          : trayStatus.status === "online"
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300"
                            : "border-slate-200 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
                      )}
                    >
                      <span
                        className={clsx(
                          "h-2 w-2 rounded-full",
                          !trayIntegrationEnabled
                            ? "bg-amber-500"
                            : trayStatus.status === "online"
                              ? "bg-emerald-500"
                              : "bg-slate-400",
                        )}
                      />
                      {!trayIntegrationEnabled
                        ? "Desativada"
                        : isCheckingTrayStatus
                          ? "Verificando"
                          : trayStatus.status === "online"
                            ? "Online"
                            : "Offline"}
                    </div>

                    <button
                      type="button"
                      onClick={fetchTrayStatus}
                      disabled={!trayIntegrationEnabled}
                      className="text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-50 dark:text-slate-400 dark:hover:text-white transition-colors"
                    >
                      Atualizar status
                    </button>
                  </div>

                  <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-white">
                    {trayStatus.storeName || trayStatus.storeId || "Nenhuma loja conectada"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {trayIntegrationEnabled
                      ? trayStatus.message
                      : "A integracao da Tray esta desativada para esta empresa."}
                  </p>
                  {trayStatus.updatedAt && trayIntegrationEnabled && (
                    <p className="mt-1 text-[11px] text-slate-400">
                      Ultima validacao: {new Date(String(trayStatus.updatedAt)).toLocaleString()}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">URL da loja Tray</label>
                  <input
                    type="text"
                    value={trayStoreUrl}
                    onChange={(e) => setTrayStoreUrl(e.target.value)}
                    placeholder="https://www.sualoja.com.br/web_api"
                    disabled={!trayIntegrationEnabled}
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                  />
                  <p className="text-[11px] text-slate-400 mt-2">Exemplo aceito: https://www.sualoja.com.br/web_api</p>
                </div>

                <div className="flex flex-wrap gap-3">
                  <button
                    onClick={handleConnectTray}
                    disabled={!trayIntegrationEnabled}
                    className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Link2 className="w-4 h-4" />
                    Conectar Tray
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "tracking" && integrationCardMatches("intelipost tracking externo client id rastreio") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Tracking externo</p>
                    <img
                      src={withBasePath("/intelipost.png")}
                      alt="Intelipost"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Intelipost</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Define o client ID usado nas consultas manuais e nos fluxos de rastreio que passam pela Intelipost.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={intelipostIntegrationEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("intelipostIntegrationEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {intelipostIntegrationEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Client ID Intelipost</label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      type="text"
                      value={intelipostClientId}
                      onChange={(e) => setIntelipostClientId(e.target.value)}
                      placeholder="40115"
                      disabled={!intelipostIntegrationEnabled}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={handleSaveIntelipost}
                      disabled={isSavingIntelipost || !currentCompany || !intelipostIntegrationEnabled}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                    >
                      {isSavingIntelipost ? "Salvando..." : "Salvar Intelipost"}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-2">Exemplo: a Drossi Interiores permanece com o ID padrao 40115.</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    API-KEY Intelipost
                  </label>
                  <input
                    type="password"
                    value={intelipostApiKey}
                    onChange={(e) => setIntelipostApiKey(e.target.value)}
                    placeholder={
                      intelipostApiKeyConfigured
                        ? "API-KEY configurada (digite para substituir)"
                        : "Digite a API-KEY da Intelipost"
                    }
                    disabled={!intelipostIntegrationEnabled}
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                  />
                  <p className="text-[11px] text-slate-400 mt-2">
                    caso nao tenha seu Apikey entrar em contato com a intelipost solicitando para integracao de rastreio
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                  <p className="font-semibold text-slate-700 dark:text-white">Uso atual</p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Quando desativada, a empresa deixa de usar a Intelipost para consulta de rastreio e geracao de links.
                  </p>
                </div>

                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200">
                  <div className="flex items-center gap-2 font-semibold">
                    <Webhook className="h-4 w-4" />
                    Atualizacao por webhook ativa junto do sync padrao
                  </div>
                  <p className="mt-1">
                    Ao receber webhook da Intelipost, o rastreio padrao do pedido e atualizado automaticamente.
                  </p>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "tracking" && integrationCardMatches("ssw require tracking nf cnpj rastreio") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Tracking por NF</p>
                    <img
                      src={withBasePath("/ssw.png")}
                      alt="SSW"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">SSW Require</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Mantem os CNPJs usados para montar links de rastreio no formato SSW por NF.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={sswRequireEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("sswRequireEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {sswRequireEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="font-semibold text-slate-700 dark:text-white">CNPJs permitidos</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      Inserir CNPJ sem pontuacao. O sistema tenta os CNPJs cadastrados para montar o rastreio SSW da NF.
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleAddSswRequireCnpj}
                    disabled={!sswRequireEnabled}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Adicionar CNPJ
                  </button>
                </div>

                <div className="space-y-3">
                  {sswRequireCnpjs.map((cnpj, index) => (
                    <div key={`${index}-${cnpj}`} className="flex flex-col gap-3 sm:flex-row">
                      <input
                        type="text"
                        value={cnpj}
                        onChange={(e) => handleChangeSswRequireCnpj(index, e.target.value)}
                        placeholder="12345678000199"
                        disabled={!sswRequireEnabled}
                        className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveSswRequireCnpj(index)}
                        disabled={!sswRequireEnabled || sswRequireCnpjs.length === 1}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                        Remover
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">Todos os usuarios da empresa compartilham esta configuracao.</p>

                  <button
                    type="button"
                    onClick={handleSaveSswRequire}
                    disabled={isSavingSswRequire || !currentCompany || !sswRequireEnabled}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingSswRequire ? "Salvando..." : "Salvar SSW Require"}
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "tracking" && integrationCardMatches("correios api rastro codigo objeto rastreio pac sedex") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Tracking por codigo de objeto</p>
                    <img
                      src={withBasePath("/correios.png")}
                      alt="Correios"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Correios</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Ativa o rastreio pela API Rastro dos Correios usando o codigo de objeto padronizado no campo de rastreio do pedido.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={correiosIntegrationEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("correiosIntegrationEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {correiosIntegrationEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
                  Esta integracao consulta a API dos Correios apenas quando a transportadora do pedido for <span className="font-semibold">PAC</span>, <span className="font-semibold">SEDEX</span> ou <span className="font-semibold">Correios</span>.
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                  <p className="font-semibold text-slate-700 dark:text-white">Regra de uso</p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Quando ativa, o Avantracking usa o codigo de envio recebido da plataforma como codigo de objeto dos Correios. Quando desativada, a API nao e consultada para essa empresa.
                  </p>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "erp" && integrationCardMatches("magazord erp pedidos basic auth usuario senha api") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">ERP com Basic Auth</p>
                    <img
                      src={withBasePath("/magazord.png")}
                      alt="Magazord"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Magazord</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Consulta por API com usuario e senha da integradora, sem OAuth, sem refresh token e sem fluxo de autorizacao por app.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={magazordIntegrationEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("magazordIntegrationEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {magazordIntegrationEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
                  Pela documentacao atual, a Magazord usa <span className="font-semibold">Basic Auth</span>. Basta informar a URL base da API, o usuario e a senha/codigo de acesso da conta.
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                  <p className="font-semibold text-slate-700 dark:text-white">Regra de ERP unico</p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Apenas um ERP de pedidos pode ficar ativo por empresa, incluindo a JET. Integracoes de rastreio continuam independentes.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">URL base da API</label>
                  <input
                    type="text"
                    value={magazordApiBaseUrl}
                    onChange={(e) => setMagazordApiBaseUrl(e.target.value)}
                    placeholder="Informe a URL base fornecida pela Magazord"
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Usuario da API</label>
                    <input
                      type="text"
                      value={magazordApiUser}
                      onChange={(e) => setMagazordApiUser(e.target.value)}
                      placeholder="Informe o usuario de API da sua conta"
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Senha / codigo de acesso</label>
                    <input
                      type="password"
                      value={magazordApiPassword}
                      onChange={(e) => setMagazordApiPassword(e.target.value)}
                      placeholder={
                        magazordApiPasswordConfigured
                          ? "Senha ja cadastrada"
                          : "Informe a senha/codigo de acesso da API"
                      }
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">
                    {magazordApiPasswordConfigured
                      ? "Ja existe uma senha Magazord salva para esta empresa. Preencha novamente apenas se quiser substituir."
                      : "Ainda nao existe senha Magazord cadastrada para esta empresa."}
                  </p>

                  <button
                    type="button"
                    onClick={handleSaveMagazord}
                    disabled={isSavingMagazord || !currentCompany}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingMagazord ? "Salvando..." : "Salvar Magazord"}
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "erp" && integrationCardMatches("jet openapi id order idpedido erp pedidos marketplace") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">ERP de pedidos</p>
                    <img
                      src={withBasePath("/jet.svg")}
                      alt="JET"
                      className={INTEGRATION_LOGO_CLASS}
                      onError={(event) => {
                        event.currentTarget.style.display = "none";
                      }}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">JET OpenAPI</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Integracao ERP de pedidos da Jet para importar pedidos direto pelo idOrder com OpenAPI oficial.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={jetIntegrationEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("jetIntegrationEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {jetIntegrationEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
                  Esta integracao segue a regra de ERP unico. Para ativar, informe a Credencial de Integracao JET (apiKey) da empresa.
                </div>

                <p className="text-[11px] text-slate-400">
                  Versao da OpenAPI usada por padrao: v1.
                </p>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Store ID (opcional)</label>
                    <input
                      type="text"
                      value={jetStoreId}
                      onChange={(e) => setJetStoreId(e.target.value)}
                      placeholder="Store ID da Jet"
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Credencial de Integracao JET (apiKey)</label>
                    <input
                      type="password"
                      value={jetIntegrationKey}
                      onChange={(e) => setJetIntegrationKey(e.target.value)}
                      placeholder={
                        jetIntegrationKeyConfigured
                          ? "apiKey ja cadastrada"
                          : "Informe a apiKey da JET"
                      }
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Usuario (opcional)</label>
                    <input
                      type="text"
                      value={jetUsername}
                      onChange={(e) => setJetUsername(e.target.value)}
                      placeholder="Usuario da integracao Jet"
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Senha (opcional)</label>
                    <input
                      type="password"
                      value={jetPassword}
                      onChange={(e) => setJetPassword(e.target.value)}
                      placeholder={
                        jetPasswordConfigured
                          ? "Senha ja cadastrada"
                          : "Informe a senha da integracao"
                      }
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Bearer token (opcional)</label>
                  <input
                    type="password"
                    value={jetBearerToken}
                    onChange={(e) => setJetBearerToken(e.target.value)}
                    placeholder={
                      jetBearerTokenConfigured
                        ? "Token ja cadastrado"
                        : "Informe apenas se sua credencial usa bearer token"
                    }
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">
                    {jetIntegrationKeyConfigured || jetUsernameConfigured || jetPasswordConfigured || jetBearerTokenConfigured
                      ? "Ja existem credenciais Jet salvas para esta empresa. Preencha novamente apenas para substituir."
                      : "Nenhuma credencial Jet foi salva ainda para esta empresa."}
                  </p>

                  <button
                    type="button"
                    onClick={handleSaveJet}
                    disabled={isSavingJet || !currentCompany}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingJet ? "Salvando..." : "Salvar Jet"}
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "erp" && integrationCardMatches("anymarket hub marketplace marketplaces pedidos gumga token rate limit tracking invoice nfe fulfillment") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10 align-top">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">ERP com token</p>
                    <img
                      src={withBasePath("/ANY.png")}
                      alt="ANYMARKET"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">ANYMARKET</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Configure o gumgaToken da conta e ative a integracao para importar pedidos da ANYMARKET no mesmo fluxo operacional dos outros ERPs.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle
                      enabled={anymarketIntegrationEnabled}
                      disabled={isSavingIntegrationToggle || !currentCompany}
                      onChange={(nextValue) =>
                        handleSaveIntegrationToggle("anymarketIntegrationEnabled", nextValue)
                      }
                    />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                      {anymarketIntegrationEnabled ? "Ativa" : "Desativada"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
                  O usuario precisa informar apenas o <span className="font-semibold">gumgaToken</span>. O sistema usa internamente o identificador do integrador e a URL padrao da API v2.
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    gumgaToken
                  </label>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <input
                      type="password"
                      value={anymarketToken}
                      onChange={(e) => setAnymarketToken(e.target.value)}
                      placeholder={
                        anymarketTokenConfigured
                          ? "Token ja cadastrado"
                          : "Informe o gumgaToken da ANYMARKET"
                      }
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                    <button
                      type="button"
                      onClick={handleSaveAnymarket}
                      disabled={isSavingAnymarket || !currentCompany}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                    >
                      {isSavingAnymarket ? "Salvando..." : "Salvar ANYMARKET"}
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-2">
                    {anymarketTokenConfigured
                      ? "Ja existe um gumgaToken salvo para esta empresa. Preencha novamente apenas se quiser substituir."
                      : "Salve o gumgaToken antes de ativar a integracao."}
                  </p>
                </div>

                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                      Janela de consulta
                    </p>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                      O endpoint <span className="font-semibold">GET /orders</span> aceita filtro por criacao de ate <span className="font-semibold">120 dias</span> e por atualizacao de ate <span className="font-semibold">7 dias</span>.
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                      Rate limit
                    </p>
                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
                      O backend respeita os headers <span className="font-semibold">ratelimit-limit</span>, <span className="font-semibold">ratelimit-remaining</span> e <span className="font-semibold">ratelimit-reset</span>, incluindo pausa automatica em <span className="font-semibold">429</span>.
                    </p>
                  </div>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 dark:border-amber-900/30 dark:bg-amber-900/10 dark:text-amber-200">
                  O backend ja esta preparado para importacao de pedidos com a ANYMARKET. Ative apenas depois de salvar um gumgaToken valido para a conta da empresa.
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "erp" && integrationCardMatches("bling erp implementacao futuro") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-dashed border-slate-300 dark:border-white/10 align-top">
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Em implementacao</p>
                    <img
                      src={withBasePath("/bling.png")}
                      alt="Bling ERP"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Bling ERP</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Card reservado para a futura integracao com ERP, com foco em pedidos, faturamento e operacao.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle enabled={false} disabled={true} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Em implementacao</span>
                  </div>
                </div>
              </div>
            </div>
            )}

            {integrationSubTab === "erp" && integrationCardMatches("sysemp shopping de precos implementacao futuro") && (
            <div className="glass-card mb-6 inline-block w-full break-inside-avoid rounded-2xl overflow-hidden border border-dashed border-slate-300 dark:border-white/10 align-top">
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Em implementacao</p>
                    <img
                      src={withBasePath("/sysemp.png")}
                      alt="SYSEMP"
                      className={INTEGRATION_LOGO_CLASS}
                    />
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">SYSEMP - Shopping de Precos</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Espaco preparado para a futura integracao com comparador de precos e operacao comercial.
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <IntegrationToggle enabled={false} disabled={true} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Em implementacao</span>
                  </div>
                </div>
              </div>
            </div>
            )}

          </div>
          </>
          )}

          {integrationSubTab === "settings" && (
          <div className="grid grid-cols-1 gap-6">
            {integrationCardMatches("configuracoes horario de corte prazo de envio pedidos") && (
            <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Configuracoes</p>
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Horario de corte</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Define o horario limite diario para contagem de prazo de envio em pedidos com prazo 0.
                    </p>
                  </div>
                </div>
              </div>

              <div className="p-5 space-y-5">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    Regra aplicada no sync/importacao
                  </p>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    A plataforma usa a data de criacao do pedido vinda da integradora. Se o pedido com prazo 0 for criado depois do horario de corte, o envio passa para o proximo dia.
                  </p>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="w-full sm:max-w-[220px]">
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Horario de corte (00:00 a 23:59)
                    </label>
                    <input
                      type="time"
                      value={shippingCutoffTime}
                      onChange={(e) => setShippingCutoffTime(e.target.value)}
                      className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveShippingCutoffTime}
                    disabled={isSavingShippingCutoffTime || !currentCompany}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingShippingCutoffTime ? "Salvando..." : "Salvar horario"}
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationCardMatches("configuracoes status manual integradora pedidos sync") && (
            <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Configuracoes</p>
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Status manuais da integradora</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Defina aqui os status que a empresa usa no sync manual de pedidos pela integradora.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddIntegrationManualStatus}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Adicionar
                  </button>
                </div>
              </div>

              <div className="p-5 space-y-5">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    Lista usada na tela de pedidos
                  </p>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    O sync manual da janela de pedidos usa exclusivamente esta
                    lista de status manuais configurados para a empresa.
                  </p>
                </div>

                <div className="space-y-3">
                  {integrationManualStatuses.map((statusName, index) => (
                    <div
                      key={`integration-manual-status-${index}`}
                      className="flex flex-col gap-3 sm:flex-row"
                    >
                      <input
                        type="text"
                        value={statusName}
                        onChange={(e) =>
                          handleChangeIntegrationManualStatus(index, e.target.value)
                        }
                        placeholder="Ex.: PAID_WAITING_SHIP"
                        className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveIntegrationManualStatus(index)}
                        disabled={integrationManualStatuses.length === 1}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                        Remover
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">
                    Salve apenas os status que fazem sentido para a operacao desta empresa.
                  </p>

                  <button
                    type="button"
                    onClick={handleSaveIntegrationManualStatuses}
                    disabled={isSavingIntegrationManualStatuses || !currentCompany}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingIntegrationManualStatuses ? "Salvando..." : "Salvar status"}
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationCardMatches("configuracoes status sync automatico integradora pedidos") && (
            <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Configuracoes</p>
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Status do sync automatico</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Escolha os status que o sync automatico da integradora deve buscar para esta empresa.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddIntegrationAutoSyncStatus}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Adicionar
                  </button>
                </div>
              </div>

              <div className="p-5 space-y-5">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    Lista para sync automatico
                  </p>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    Quando preenchido, o agendamento automatico da integradora vai consultar somente estes status para esta empresa.
                  </p>
                </div>

                <div className="space-y-3">
                  {integrationAutoSyncStatuses.map((statusName, index) => (
                    <div
                      key={`integration-auto-sync-status-${index}`}
                      className="flex flex-col gap-3 sm:flex-row"
                    >
                      <input
                        type="text"
                        value={statusName}
                        onChange={(e) =>
                          handleChangeIntegrationAutoSyncStatus(index, e.target.value)
                        }
                        placeholder="Ex.: enviado"
                        className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveIntegrationAutoSyncStatus(index)}
                        disabled={integrationAutoSyncStatuses.length === 1}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                        Remover
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">
                    A configuracao e salva por empresa e compartilhada entre os usuarios vinculados a ela.
                  </p>

                  <button
                    type="button"
                    onClick={handleSaveIntegrationAutoSyncStatuses}
                    disabled={isSavingIntegrationAutoSyncStatuses || !currentCompany}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingIntegrationAutoSyncStatuses ? "Salvando..." : "Salvar status automaticos"}
                  </button>
                </div>
              </div>
            </div>
            )}

            {integrationCardMatches("configuracoes regras de importacao excecao de transportadora ignorar") && (
            <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Configuracoes</p>
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Regras de importacao</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Controle fino para ignorar pedidos da plataforma por nome exato de transportadora nesta empresa.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddCarrierException}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                    Adicionar
                  </button>
                </div>
              </div>

              <div className="p-5 space-y-5">
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                    Excecao de transportadora
                  </p>
                  <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                    Adicione o nome exato da transportadora para impedir a importacao desses pedidos nesta empresa.
                  </p>
                </div>

                <div className="space-y-3">
                  {integrationCarrierExceptions.map((carrierName, index) => (
                    <div
                      key={`carrier-exception-${index}`}
                      className="flex flex-col gap-3 sm:flex-row"
                    >
                      <input
                        type="text"
                        value={carrierName}
                        onChange={(e) => handleChangeCarrierException(index, e.target.value)}
                        placeholder="Nome exato da transportadora"
                        className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveCarrierException(index)}
                        disabled={integrationCarrierExceptions.length === 1}
                        className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                        Remover
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-slate-400">A comparacao usa o texto normalizado exato recebido da plataforma.</p>

                  <button
                    type="button"
                    onClick={handleSaveCarrierExceptions}
                    disabled={isSavingCarrierExceptions || !currentCompany}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingCarrierExceptions ? "Salvando..." : "Salvar excecoes"}
                  </button>
                </div>
              </div>
            </div>
            )}
          </div>
          )}
          </>
          )}

          {settingsSubTab === "profile" && (
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Perfil</p>
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Dados do usuario</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Atualize seus dados de contato e foto de perfil. A imagem e ajustada automaticamente para ate 350KB.
                    </p>
                  </div>
                  <UserCircle2 className="w-8 h-8 text-slate-400" />
                </div>
              </div>

              <div className="p-5 space-y-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <div className="h-20 w-20 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10 flex items-center justify-center">
                    {profileForm.profileImageData ? (
                      <img
                        src={profileForm.profileImageData}
                        alt="Foto de perfil"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-xl font-bold text-slate-600 dark:text-slate-300">
                        {profileForm.name?.charAt(0)?.toUpperCase() || user?.name?.charAt(0)?.toUpperCase() || "U"}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <label
                      htmlFor="profile-photo-upload"
                      className="inline-flex cursor-pointer items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                    >
                      <Camera className="w-4 h-4" />
                      Enviar foto
                    </label>
                    <input
                      id="profile-photo-upload"
                      type="file"
                      accept="image/*"
                      onChange={handleProfileImageUpload}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setProfileForm((current) => ({
                          ...current,
                          profileImageData: "",
                        }))
                      }
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remover foto
                    </button>
                  </div>
                </div>

                <p className="text-[11px] text-slate-400">
                  Formatos aceitos: JPG, PNG e WebP. A plataforma reduz automaticamente o tamanho para no maximo 350KB.
                </p>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Nome completo
                    </label>
                    <input
                      type="text"
                      value={profileForm.name}
                      onChange={(e) =>
                        setProfileForm((current) => ({
                          ...current,
                          name: e.target.value,
                        }))
                      }
                      placeholder="Seu nome"
                      disabled={isLoadingProfile}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      E-mail
                    </label>
                    <input
                      type="email"
                      value={profileForm.email}
                      readOnly
                      className="w-full bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-500 dark:text-slate-400 cursor-not-allowed"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Telefone
                    </label>
                    <input
                      type="text"
                      value={profileForm.phone}
                      onChange={(e) =>
                        setProfileForm((current) => ({
                          ...current,
                          phone: e.target.value,
                        }))
                      }
                      placeholder="(00) 00000-0000"
                      disabled={isLoadingProfile}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Data de aniversario
                    </label>
                    <input
                      type="date"
                      value={profileForm.birthDate}
                      onChange={(e) =>
                        setProfileForm((current) => ({
                          ...current,
                          birthDate: e.target.value,
                        }))
                      }
                      disabled={isLoadingProfile}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none disabled:opacity-50"
                    />
                  </div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 dark:border-white/10 dark:bg-white/5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-800 dark:text-white">
                        Receber notificacoes por e-mail da plataforma
                      </p>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        Esta opcao vem habilitada por padrao. Ao desativar, seu e-mail deixa de receber qualquer envio automatico da plataforma.
                      </p>
                    </div>
                    <IntegrationToggle
                      enabled={profileForm.receivePlatformEmails !== false}
                      disabled={isLoadingProfile}
                      onChange={(nextValue) =>
                        setProfileForm((current) => ({
                          ...current,
                          receivePlatformEmails: nextValue,
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="pt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    disabled={isSavingProfile || isLoadingProfile || !profileForm.name.trim()}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                  >
                    {isSavingProfile ? "Salvando..." : "Salvar perfil"}
                  </button>
                </div>
              </div>
            </div>

            <div className="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-white/10">
              <div className="p-5 border-b border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-white/5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Seguranca</p>
                    <h4 className="mt-2 text-lg font-bold text-slate-800 dark:text-white">Alterar senha</h4>
                    <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                      Para sua seguranca, informe a senha atual e confirme a nova senha. Enviamos confirmacao no seu e-mail.
                    </p>
                  </div>
                  <Lock className="w-8 h-8 text-slate-400" />
                </div>
              </div>

              <div className="p-5 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Senha atual
                  </label>
                  <input
                    type="password"
                    value={profilePasswordForm.currentPassword}
                    onChange={(e) =>
                      setProfilePasswordForm((current) => ({
                        ...current,
                        currentPassword: e.target.value,
                      }))
                    }
                    placeholder="Digite sua senha atual"
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Nova senha
                  </label>
                  <input
                    type="password"
                    value={profilePasswordForm.newPassword}
                    onChange={(e) =>
                      setProfilePasswordForm((current) => ({
                        ...current,
                        newPassword: e.target.value,
                      }))
                    }
                    placeholder="Minimo de 8 caracteres"
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Confirmar nova senha
                  </label>
                  <input
                    type="password"
                    value={profilePasswordForm.confirmPassword}
                    onChange={(e) =>
                      setProfilePasswordForm((current) => ({
                        ...current,
                        confirmPassword: e.target.value,
                      }))
                    }
                    placeholder="Repita a nova senha"
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />
                </div>

                <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-500 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
                  Apos alterar a senha, voce recebe uma confirmacao no e-mail cadastrado da sua conta.
                </div>

                <button
                  type="button"
                  onClick={handleChangeMyPassword}
                  disabled={
                    isSavingPassword ||
                    !profilePasswordForm.currentPassword ||
                    !profilePasswordForm.newPassword ||
                    !profilePasswordForm.confirmPassword
                  }
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {isSavingPassword ? "Atualizando senha..." : "Alterar senha"}
                </button>

                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700 dark:border-amber-900/30 dark:bg-amber-900/10 dark:text-amber-200">
                  <div className="flex items-start gap-2">
                    <Cake className="w-4 h-4 mt-0.5" />
                    <p>
                      No seu aniversario, durante todo o dia, o icone da sua foto de perfil recebe um chapeu de festa com confetes estaticos. No primeiro login do dia, voce tambem recebe uma mensagem especial.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}
        </div>
      )}

      {activeTab === "integration" && false && (
        <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10">
          <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <h3 className="font-semibold text-slate-800 dark:text-white">
                Integração Tray
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Inicie a autorização da loja Tray em uma nova aba. Se a Tray já
                estiver logada no navegador, o id e o usuário serão reconhecidos
                automaticamente no fluxo de autorização.
              </p>
            </div>

            <div className="flex items-center gap-3 self-start">
              <div
                className={clsx(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide",
                  trayStatus.status === "online"
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-900/10 dark:text-emerald-300"
                    : "border-slate-200 bg-slate-100 text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300",
                )}
              >
                <span
                  className={clsx(
                    "h-2 w-2 rounded-full",
                    trayStatus.status === "online"
                      ? "bg-emerald-500"
                      : "bg-slate-400",
                  )}
                />
                {isCheckingTrayStatus
                  ? "Verificando"
                  : trayStatus.status === "online"
                    ? "Online"
                    : "Offline"}
              </div>

              <button
                type="button"
                onClick={fetchTrayStatus}
                className="text-xs font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-white transition-colors"
              >
                Atualizar status
              </button>
            </div>
          </div>

          <div className="p-6 space-y-5">
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
              <p className="font-semibold text-slate-700 dark:text-white">
                Empresa atual: {currentCompany?.name || "Nao vinculada"}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                O ID da Intelipost desta empresa sera usado no rastreio manual e na sincronizacao com a Intelipost.
              </p>
            </div>

            <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
              Você pode informar a URL da loja ou a URL completa com{" "}
              <span className="font-semibold">/web_api</span>. O sistema
              normaliza a URL antes de redirecionar para a Tray.
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                INTELIPOST
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  type="text"
                  value={intelipostClientId}
                  onChange={(e) => setIntelipostClientId(e.target.value)}
                  placeholder="40115"
                  className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
                <button
                  type="button"
                  onClick={handleSaveIntelipost}
                  disabled={isSavingIntelipost || !currentCompany}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {isSavingIntelipost ? "Salvando..." : "Salvar Intelipost"}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">
                Exemplo: a Drossi Interiores permanece com o ID padrao 40115.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                API-KEY Intelipost
              </label>
              <input
                type="password"
                value={intelipostApiKey}
                onChange={(e) => setIntelipostApiKey(e.target.value)}
                placeholder={
                  intelipostApiKeyConfigured
                    ? "API-KEY configurada (digite para substituir)"
                    : "Digite a API-KEY da Intelipost"
                }
                className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
              />
              <p className="text-[11px] text-slate-400 mt-2">
                caso nao tenha seu Apikey entrar em contato com a intelipost solicitando para integracao de rastreio
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                URL da loja Tray
              </label>
              <input
                type="text"
                value={trayStoreUrl}
                onChange={(e) => setTrayStoreUrl(e.target.value)}
                placeholder="https://www.sualoja.com.br/web_api"
                className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
              />
              <p className="text-[11px] text-slate-400 mt-2">
                Exemplo aceito: https://www.sualoja.com.br/web_api
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-semibold text-slate-700 dark:text-white">
                    SSW Require
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Inserir CNPJ sem pontuacao (12345678000199). O sistema usa esses CNPJs para montar o rastreio
                    {" "}`https://ssw.inf.br/app/tracking/{"{CNPJ}"}/{"{NF}"}` com a NF do pedido. Se nao localizar no primeiro,
                    tenta os demais cadastrados na mesma empresa.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleAddSswRequireCnpj}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  TEM MAIS DE UM CNPJ PARA NF?
                </button>
              </div>

              <div className="mt-4 space-y-3">
                {sswRequireCnpjs.map((cnpj, index) => (
                  <div key={`${index}-${cnpj}`} className="flex flex-col gap-3 sm:flex-row">
                    <input
                      type="text"
                      value={cnpj}
                      onChange={(e) =>
                        handleChangeSswRequireCnpj(index, e.target.value)
                      }
                      placeholder="12345678000199"
                      className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveSswRequireCnpj(index)}
                      disabled={sswRequireCnpjs.length === 1}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remover
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] text-slate-400">
                  Sempre um cadastro por empresa. Todos os usuarios da mesma empresa compartilham os mesmos CNPJs,
                  sem conflito com as demais empresas.
                </p>

                <button
                  type="button"
                  onClick={handleSaveSswRequire}
                  disabled={isSavingSswRequire || !currentCompany}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {isSavingSswRequire ? "Salvando..." : "Salvar SSW Require"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 dark:border-white/10 dark:bg-white/5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-semibold text-slate-700 dark:text-white">
                    Excecao de transportadora
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    Informe o nome exato da transportadora. Pedidos importados da plataforma com esse mesmo nome
                    serao ignorados durante a importacao desta empresa.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleAddCarrierException}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Adicionar excecao
                </button>
              </div>

              <div className="mt-4 space-y-3">
                {integrationCarrierExceptions.map((carrierName, index) => (
                  <div
                    key={`carrier-exception-${index}`}
                    className="flex flex-col gap-3 sm:flex-row"
                  >
                    <input
                      type="text"
                      value={carrierName}
                      onChange={(e) =>
                        handleChangeCarrierException(index, e.target.value)
                      }
                      placeholder="Nome exato da transportadora"
                      className="w-full bg-white dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveCarrierException(index)}
                      disabled={integrationCarrierExceptions.length === 1}
                      className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-300 hover:border-red-500 hover:text-red-600 disabled:opacity-50 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      Remover
                    </button>
                  </div>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[11px] text-slate-400">
                  A comparacao usa o texto exato normalizado da transportadora recebida da plataforma.
                </p>

                <button
                  type="button"
                  onClick={handleSaveCarrierExceptions}
                  disabled={isSavingCarrierExceptions || !currentCompany}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-slate-700 hover:bg-slate-800 disabled:opacity-50 transition-colors"
                >
                  {isSavingCarrierExceptions ? "Salvando..." : "Salvar excecoes"}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
              <p className="font-semibold text-slate-700 dark:text-white">
                {trayStatus.storeName || trayStatus.storeId || "Nenhuma loja conectada"}
              </p>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                {trayStatus.message}
              </p>
              {trayStatus.updatedAt && (
                <p className="mt-1 text-[11px] text-slate-400">
                  Última validação: {new Date(String(trayStatus.updatedAt)).toLocaleString()}
                </p>
              )}
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                onClick={handleConnectTray}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
              >
                <Link2 className="w-4 h-4" />
                Conectar Tray
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DB Management */}
      {canManageAdminPanel && (
      <div className="glass-card rounded-xl overflow-hidden border border-slate-200 dark:border-white/10 mt-6">
        <div className="p-4 border-b border-slate-200 dark:border-white/10 bg-slate-50/50 dark:bg-white/5">
          <h3 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Database className="w-5 h-5 text-red-500" />
            Manutenção de Banco de Dados
          </h3>
        </div>
        <div className="p-6 flex flex-col md:flex-row gap-4">
          <button
            onClick={() => {
              setClearType("DELIVERED_7_DAYS");
              setClearCompanyId(companies[0]?.id || "");
              setClearPassword("");
              setClearStatus("DELIVERED");
              setClearPeriod("7_DAYS");
              setClearCustomStartDate("");
              setClearCustomEndDate("");
              setIsClearModalOpen(true);
            }}
            className="flex-1 bg-yellow-500/10 text-yellow-600 border border-yellow-500/20 px-4 py-3 rounded-lg text-sm font-medium hover:bg-yellow-500/20 transition-colors flex items-center justify-center gap-2"
          >
            <AlertTriangle className="w-4 h-4" />
            Limpar pedidos com status Entregue há mais de 7 dias
          </button>

          <button
            onClick={() => {
              setClearType("ALL");
              setClearCompanyId(companies[0]?.id || "");
              setClearPassword("");
              setClearStatus("ALL");
              setClearPeriod("ALL");
              setClearCustomStartDate("");
              setClearCustomEndDate("");
              setIsClearModalOpen(true);
            }}
            className="flex-1 bg-red-500/10 text-red-600 border border-red-500/20 px-4 py-3 rounded-lg text-sm font-medium hover:bg-red-500/20 transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Limpar banco de dados de pedidos (TUDO)
          </button>

          <button
            onClick={() => {
              setClearType("FILTERED");
              setClearCompanyId(companies[0]?.id || "");
              setClearPassword("");
              setClearStatus("ALL");
              setClearPeriod("ALL");
              setClearCustomStartDate("");
              setClearCustomEndDate("");
              setIsClearModalOpen(true);
            }}
            className="flex-1 bg-orange-500/10 text-orange-600 border border-orange-500/20 px-4 py-3 rounded-lg text-sm font-medium hover:bg-orange-500/20 transition-colors flex items-center justify-center gap-2"
          >
            <Filter className="w-4 h-4" />
            Excluir pedidos específicos
          </button>
        </div>
      </div>
      )}

      {/* Add/Edit User Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-card bg-white dark:bg-dark-card w-full max-w-md rounded-xl p-6 shadow-2xl animate-in zoom-in-95">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                {editingUser ? "Editar Usuário" : "Novo Usuário"}
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-slate-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveUser} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Nome Completo
                </label>
                <input
                  type="text"
                  required
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Empresa
                </label>
                <select
                  value={formData.companyId}
                  onChange={(e) =>
                    setFormData({ ...formData, companyId: e.target.value })
                  }
                  className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                >
                  <option value="">Selecione uma empresa...</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-slate-400 mt-1">
                  Se não selecionar, o usuário não terá acesso a pedidos.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Função
                  </label>
                  <select
                    value={formData.role}
                    onChange={(e) =>
                      setFormData({ ...formData, role: e.target.value as any })
                    }
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  >
                    <option value="USER">Usuário</option>
                    <option value="ADMIN">Administrador</option>
                  </select>
                </div>

                {editingUser ? (
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Nova Senha (opcional)
                    </label>
                    <div className="relative">
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(e) =>
                          setFormData({ ...formData, password: e.target.value })
                        }
                        placeholder="Manter atual"
                        className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg pl-3 pr-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                      />
                    </div>
                  </div>
                ) : (
                  <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 dark:border-blue-900/30 dark:bg-blue-900/10 dark:text-blue-300">
                    Ao salvar, o usuario sera criado e recebera um convite por
                    e-mail para cadastrar a propria senha.
                  </div>
                )}
              </div>

              <div className="pt-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 dark:text-slate-300 dark:bg-white/5 dark:hover:bg-white/10 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                >
                  {editingUser ? "Salvar Usuario" : "Criar e Enviar Convite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Company Modal */}
      {isCompanyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-card bg-white dark:bg-dark-card w-full max-w-md rounded-xl p-6 shadow-2xl animate-in zoom-in-95">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-slate-800 dark:text-white">
                Nova Empresa
              </h3>
              <button
                onClick={() => setIsCompanyModalOpen(false)}
                className="text-slate-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveCompany} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Nome da Empresa
                </label>
                <input
                  type="text"
                  required
                  value={companyFormData.name}
                  onChange={(e) =>
                    setCompanyFormData({
                      ...companyFormData,
                      name: e.target.value,
                    })
                  }
                  className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Tipo de documento
                    </label>
                    <select
                      value={companyFormData.documentType}
                      onChange={(e) =>
                        setCompanyFormData({
                          ...companyFormData,
                          documentType: e.target.value,
                          documentNumber: formatIdentityDocumentInput(
                            e.target.value,
                            companyFormData.documentNumber,
                          ),
                        })
                      }
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    >
                      <option value="">Selecione</option>
                      <option value="CPF">CPF</option>
                      <option value="CNPJ">CNPJ</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                      Documento fiscal
                    </label>
                    <input
                      type="text"
                      value={companyFormData.documentNumber}
                      onChange={(e) => {
                        const nextValue = formatIdentityDocumentInput(
                          companyFormData.documentType,
                          e.target.value,
                        );
                        setCompanyFormData({
                          ...companyFormData,
                          documentNumber: nextValue,
                          cnpj:
                            resolveIdentityDocumentType(
                              companyFormData.documentType,
                              nextValue,
                            ) === "CNPJ"
                              ? normalizeIdentityDigits(nextValue)
                              : companyFormData.cnpj,
                        });
                      }}
                      className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                    />
                  </div>
                </div>

              <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Tenant Global (Opcional)
                  </label>
                  <input
                    type="text"
                    value={companyFormData.tenantGlobalId}
                    onChange={(e) =>
                      setCompanyFormData({
                        ...companyFormData,
                        tenantGlobalId: e.target.value,
                      })
                    }
                    className="w-full bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:border-blue-500 outline-none"
                  />
                </div>

              <div className="pt-4 flex gap-3">
                <button
                  type="button"
                  onClick={() => setIsCompanyModalOpen(false)}
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 dark:text-slate-300 dark:bg-white/5 dark:hover:bg-white/10 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors"
                >
                  Criar Empresa
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {/* DB Clear Confirmation Modal */}
      {isClearModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-card bg-white dark:bg-dark-card w-full max-w-md rounded-xl p-6 shadow-2xl animate-in zoom-in-95 border border-red-500/20">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-lg font-bold text-red-600 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                Atenção: Ação Destrutiva
              </h3>
              <button
                onClick={resetClearDatabaseModal}
                className="text-slate-500 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-4 text-sm text-slate-600 dark:text-slate-300">
              Você está prestes a{" "}
              <strong>
                {clearType === "ALL"
                  ? "APAGAR TODOS OS PEDIDOS"
                  : "APAGAR PEDIDOS ENTREGUES HÁ MAIS DE 7 DIAS"}
              </strong>{" "}
              do banco de dados. Esta ação não pode ser desfeita.
            </div>

            {clearType === "FILTERED" && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50/70 px-3 py-2 text-xs font-medium text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                Filtro atual: {clearModalActionLabel}
              </div>
            )}

            <form onSubmit={handleClearDatabase} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Empresa
                </label>
                <select
                  required
                  value={clearCompanyId}
                  onChange={(e) => setClearCompanyId(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-white/5 border border-red-200 dark:border-red-900/30 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-red-500 outline-none"
                >
                  <option value="">Selecione a empresa...</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.name}
                    </option>
                  ))}
                </select>
              </div>

              {clearType === "FILTERED" && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                        Status
                      </label>
                      <select
                        value={clearStatus}
                        onChange={(e) =>
                          setClearStatus(
                            e.target.value as
                              | "ALL"
                              | "PENDING"
                              | "CREATED"
                              | "SHIPPED"
                              | "DELIVERY_ATTEMPT"
                              | "DELIVERED"
                              | "FAILURE"
                              | "RETURNED"
                              | "CANCELED"
                              | "CHANNEL_LOGISTICS",
                          )
                        }
                        className="w-full bg-slate-50 dark:bg-white/5 border border-red-200 dark:border-red-900/30 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-red-500 outline-none"
                      >
                        {CLEAR_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                        Periodo
                      </label>
                      <select
                        value={clearPeriod}
                        onChange={(e) =>
                          setClearPeriod(
                            e.target.value as
                              | "ALL"
                              | "7_DAYS"
                              | "15_DAYS"
                              | "30_DAYS"
                              | "CUSTOM",
                          )
                        }
                        className="w-full bg-slate-50 dark:bg-white/5 border border-red-200 dark:border-red-900/30 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-red-500 outline-none"
                      >
                        {CLEAR_PERIOD_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {clearPeriod === "CUSTOM" && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                          Data inicial
                        </label>
                        <input
                          type="date"
                          required
                          value={clearCustomStartDate}
                          onChange={(e) => setClearCustomStartDate(e.target.value)}
                          className="w-full bg-slate-50 dark:bg-white/5 border border-red-200 dark:border-red-900/30 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-red-500 outline-none"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                          Data final
                        </label>
                        <input
                          type="date"
                          required
                          value={clearCustomEndDate}
                          onChange={(e) => setClearCustomEndDate(e.target.value)}
                          className="w-full bg-slate-50 dark:bg-white/5 border border-red-200 dark:border-red-900/30 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-red-500 outline-none"
                        />
                      </div>
                    </div>
                  )}

                  <div className="rounded-lg border border-orange-200 bg-orange-50/70 px-3 py-2 text-xs text-orange-700 dark:border-orange-500/20 dark:bg-orange-500/10 dark:text-orange-300">
                    O periodo considera a ultima movimentacao registrada (rastreio/envio) do pedido.
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  Digite a senha de segurança para confirmar:
                </label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="password"
                    required
                    value={clearPassword}
                    onChange={(e) => setClearPassword(e.target.value)}
                    placeholder="Senha de segurança"
                    className="w-full bg-slate-50 dark:bg-white/5 border border-red-200 dark:border-red-900/30 rounded-lg pl-9 pr-3 py-2.5 text-sm text-slate-900 dark:text-white focus:border-red-500 outline-none"
                  />
                </div>
              </div>

              <div className="pt-4 flex gap-3">
                <button
                  type="button"
                  onClick={resetClearDatabaseModal}
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 dark:text-slate-300 dark:bg-white/5 dark:hover:bg-white/10 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={isClearing || !clearPassword || !clearCompanyId}
                  className="flex-1 px-4 py-2 rounded-lg font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {isClearing ? "Apagando..." : "Confirmar Exclusão"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isClearWebhookFailuresModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="glass-card bg-white dark:bg-dark-card w-full max-w-md rounded-xl p-6 shadow-2xl animate-in zoom-in-95 border border-red-500/20">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-red-600 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5" />
                Confirmar limpeza de falhas
              </h3>
              <button
                onClick={closeClearWebhookFailuresModal}
                className="text-slate-500 hover:text-white"
                disabled={isClearingWebhookFailures}
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-slate-600 dark:text-slate-300">
              Esta acao remove os logs de falhas do webhook{" "}
              <strong>{webhookProvider === "intelipost" ? "Intelipost" : "AnyMarket"}</strong>.
              Deseja continuar?
            </p>

            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              Essa limpeza afeta apenas a fila de falhas exibida no painel.
            </div>

            <div className="pt-5 flex gap-3">
              <button
                type="button"
                onClick={closeClearWebhookFailuresModal}
                disabled={isClearingWebhookFailures}
                className="flex-1 px-4 py-2 rounded-lg font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 dark:text-slate-300 dark:bg-white/5 dark:hover:bg-white/10 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  await handleClearWebhookFailures();
                  setIsClearWebhookFailuresModalOpen(false);
                }}
                disabled={isClearingWebhookFailures}
                className="flex-1 px-4 py-2 rounded-lg font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
              >
                {isClearingWebhookFailures ? "Limpando..." : "Confirmar limpeza"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

