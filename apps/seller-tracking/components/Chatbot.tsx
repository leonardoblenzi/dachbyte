import React, { Fragment, useEffect, useRef, useState } from "react";
import {
  Bot,
  Loader2,
  MessageCircle,
  Send,
  Sparkles,
  User,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { fetchWithAuth } from "../utils/authFetch";
import { useAuth } from "../contexts/AuthContext";
import { CHATBOT_AVATAR_URL } from "../constants";

const BOT_NAME = "Muricoca";
const BOT_AVATAR_SRC = CHATBOT_AVATAR_URL;
const BOT_BUTTON_SIZE = 64;
const BOT_WINDOW_GAP = 16;
const BOT_MARGIN = 24;
const URL_REGEX = /(https?:\/\/[^\s]+)/g;

const getDefaultLauncherPosition = (width: number, height: number) => ({
  x: Math.max(BOT_MARGIN, width - BOT_BUTTON_SIZE - BOT_MARGIN),
  y: Math.max(BOT_MARGIN, height - BOT_BUTTON_SIZE - BOT_MARGIN),
});

const clampLauncherPosition = (
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const maxX = Math.max(BOT_MARGIN, width - BOT_BUTTON_SIZE - BOT_MARGIN);
  const maxY = Math.max(BOT_MARGIN, height - BOT_BUTTON_SIZE - BOT_MARGIN);

  return {
    x: Math.min(Math.max(BOT_MARGIN, x), maxX),
    y: Math.min(Math.max(BOT_MARGIN, y), maxY),
  };
};

interface Message {
  id: string;
  role: "user" | "model";
  text: string;
  actions?: ChatAction[];
}

interface ChatAction {
  label: string;
  value: string;
  style?: "primary" | "secondary" | "danger";
}

interface ChatResponsePayload {
  text: string;
  actions: ChatAction[];
}

interface KnowledgeItem {
  id: string;
  keywords: string[];
  responses: string[];
}

const SUPPORT_FALLBACK_MESSAGE =
  "Nao consegui identificar essa funcionalidade com seguranca.\n\nEntre em contato com o desenvolvedor da plataforma para orientacao ou correcao.";

const DEFAULT_WELCOME_MESSAGE = `Ola! Eu sou a ${BOT_NAME}.\n\nPosso te ajudar com Dashboard, Pedidos, Alertas, Falhas na Entrega, Importacao, sincronizacao, Integradora, frete recalculado, suporte, administracao e release notes.\n\nSe quiser dados reais da operacao, voce tambem pode pedir contagens e relatorios como:\n- quantos pedidos estao entregues\n- me envie um relatorio com pedidos atrasados\n- me envie um relatorio com pedidos da Jadlog`;

const getUserCallName = (name: string | null | undefined) => {
  const trimmed = String(name || "").trim();
  if (!trimmed) return null;
  return trimmed.split(/\s+/)[0] || null;
};

const normalizeKnowledgeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const hasStructuredStatusHint = (normalized: string) =>
  [
    "entregue",
    "entregues",
    "em transito",
    "transito",
    "saiu para entrega",
    "falha na entrega",
    "falhas na entrega",
    "devolvido",
    "devolvidos",
    "cancelado",
    "cancelados",
    "pendente",
    "pendentes",
    "criado",
    "criados",
  ].some((term) => normalized.includes(term));

const hasStructuredDelayHint = (normalized: string) =>
  normalized.includes("atras") ||
  normalized.includes("transportadora") ||
  normalized.includes("plataforma");

const hasStructuredNoMovementHint = (normalized: string) =>
  normalized.includes("sem movimentacao") ||
  normalized.includes("sem movimento") ||
  normalized.includes("sem atualizacao");

const hasStructuredPeriodHint = (normalized: string) =>
  normalized.includes("hoje") ||
  normalized.includes("ontem") ||
  /(?:(?:nos|das|ha)\s+)?(?:ultimos|uiltimos|ultimas)\s+\d+\s*dias?/.test(
    normalized,
  );

const hasStructuredContextHint = (normalized: string) =>
  normalized.includes("pedido") ||
  normalized.includes("pedidos") ||
  normalized.includes("nf") ||
  normalized.includes("nfs") ||
  normalized.includes("nota fiscal") ||
  normalized.includes("transportadora") ||
  normalized.includes("marketplace") ||
  normalized.includes("canal");

const hasTrackingLookupIntent = (normalized: string) =>
  [
    "rastreio",
    "rastreamento",
    "rastrear",
    "rastreie",
    "rastrei",
    "rastreia",
    "tracking",
    "acompanhar",
    "acompanhe",
    "acompanha",
  ].some((term) => normalized.includes(term)) &&
  (
    normalized.includes("abrir") ||
    normalized.includes("abre") ||
    normalized.includes("link") ||
    normalized.includes("url") ||
    normalized.includes("pedido") ||
    normalized.includes("nf") ||
    normalized.includes("nota fiscal") ||
    normalized.includes("xml") ||
    normalized.includes("chave") ||
    normalized.includes("cliente") ||
    /[a-z]{2}\d{9}[a-z]{2}/i.test(normalized) ||
    /\d{4,}/.test(normalized)
  );

const hasStructuredFilterLikeIntent = (normalized: string) =>
  (hasStructuredStatusHint(normalized) ||
    hasStructuredDelayHint(normalized) ||
    hasStructuredNoMovementHint(normalized)) &&
  (hasStructuredPeriodHint(normalized) ||
    hasStructuredContextHint(normalized) ||
    normalized.includes("pela ") ||
    normalized.includes("da ") ||
    normalized.includes("do "));

const isUncertainAiResponse = (text: string) => {
  const normalized = normalizeKnowledgeText(text);

  return [
    "nao entendi",
    "nao compreendi",
    "nao sei",
    "nao tenho certeza",
    "nao encontrei",
    "nao consigo identificar",
    "falta contexto",
  ].some((term) => normalized.includes(term));
};

const shouldUseStructuredChatRequest = (text: string) => {
  const normalized = normalizeKnowledgeText(text);

  return (
    [
    "relatorio",
    "por status",
    "status geral",
    "relatorio geral",
    "geral de pedidos",
    "atraso da plataforma",
    "atraso da transportadora",
    "me envie",
    "me envia",
    "gere",
    "gerar",
    "quantos",
    "quantidade",
    "qtd",
    "total de pedidos",
    "numero de pedidos",
    "lista de pedidos",
    "listar pedidos",
    "mostrar pedidos",
    "arquivar",
    "arquive",
    "desarquivar",
    "desarquive",
    "excluir pedidos",
    "exclua os pedidos",
    "apagar pedidos",
    "deletar pedidos",
    "remover pedidos",
    ].some((term) => normalized.includes(term)) ||
    (
      normalized.includes("status") &&
      (normalized.includes("pedido") || normalized.includes("pedidos"))
    ) ||
    hasStructuredFilterLikeIntent(normalized) ||
    hasTrackingLookupIntent(normalized)
  );
};

const getConversationalResponse = (text: string) => {
  const normalized = normalizeKnowledgeText(text);
  const compact = normalized.replace(/[?!.,;]/g, "").trim();

  const asksHowAreYou =
    normalized.includes("tudo bem") ||
    normalized.includes("como voce esta") ||
    normalized.includes("como vc esta") ||
    normalized.includes("como vai");
  const hasGreeting =
    normalized.includes("oi") ||
    normalized.includes("ola") ||
    normalized.includes("bom dia") ||
    normalized.includes("boa tarde") ||
    normalized.includes("boa noite");

  if (asksHowAreYou && hasGreeting) {
    return "Oi! Tudo bem por aqui, obrigado por perguntar. E voce, como esta?\n\nSe quiser, ja me diga no que posso te ajudar no Avantracking.";
  }

  if (asksHowAreYou) {
    return "Tudo bem por aqui, obrigado por perguntar. E voce, como esta?\n\nSe quiser, ja pode me contar sua duvida sobre a plataforma.";
  }

  if (hasGreeting) {
    return "Oi! Que bom falar com voce.\n\nComo voce esta? Se quiser, ja me diga sua duvida sobre Dashboard, Pedidos, Sync, Integradora, frete recalculado, alertas ou qualquer outra funcao do Avantracking.";
  }

  if (
    normalized.includes("obrigado") ||
    normalized.includes("obrigada") ||
    normalized.includes("valeu")
  ) {
    return "Eu que agradeco. Se quiser, posso continuar te ajudando com a plataforma.";
  }

  if (
    normalized.includes("perfeito") ||
    normalized.includes("boa") ||
    normalized.includes("show") ||
    normalized.includes("otimo")
  ) {
    return "Fico feliz em ajudar. Se quiser, seguimos no proximo ponto.";
  }

  if (
    normalized.includes("tudo certo") ||
    normalized.includes("tudo bem tambem") ||
    normalized.includes("tudo bem tambem") ||
    normalized.includes("tambem estou bem") ||
    normalized.includes("bem e voce") ||
    normalized.includes("bem e vc") ||
    normalized.includes("estou bem e voce") ||
    normalized.includes("estou bem e vc") ||
    compact === "bem" ||
    compact === "to bem" ||
    compact === "estou bem" ||
    compact === "tudo certo" ||
    compact === "tudo tranquilo" ||
    normalized.includes("to bem") ||
    normalized.includes("estou bem") ||
    normalized.includes("tudo tranquilo") ||
    normalized.includes("tudo joia")
  ) {
    return "Que bom! Qual e a sua duvida? Se quiser, pode me perguntar sobre pedidos, sincronizacao, frete, alertas, Integradora ou qualquer outra funcao da plataforma.";
  }

  return null;
};

const renderRichText = (text: string) =>
  text.split("\n").map((line, lineIndex, lines) => {
    const parts = line.split(URL_REGEX);

    return (
      <Fragment key={`${line}-${lineIndex}`}>
        {parts.map((part, index) =>
          /^https?:\/\//.test(part) ? (
            <a
              key={`${part}-${index}`}
              href={part}
              target="_blank"
              rel="noreferrer"
              className="break-all font-medium text-blue-600 underline decoration-blue-300 underline-offset-2 dark:text-cyan-300"
            >
              {part}
            </a>
          ) : (
            <Fragment key={`${part}-${index}`}>{part}</Fragment>
          ),
        )}
        {lineIndex < lines.length - 1 ? <br /> : null}
      </Fragment>
    );
  });

const ENHANCED_KNOWLEDGE_BASE: KnowledgeItem[] = [
  {
    id: "dashboard",
    keywords: [
      "dashboard",
      "grafico",
      "grafico de status",
      "kpi",
      "ranking",
      "resumo",
      "tela inicial",
      "metricas",
      "indicadores",
      "cards",
    ],
    responses: [
      "Dashboard Executivo\n\nNo Dashboard voce acompanha os indicadores principais da operacao.\n- cards com totais e visoes de status\n- graficos de distribuicao dos pedidos\n- ranking de transportadoras\n- atalhos para abrir a tela de pedidos com filtros aplicados",
      "Dashboard\n\nEssa e a visao mais resumida da operacao.\n- cards com totais e indicadores\n- graficos de distribuicao dos pedidos\n- ranking de transportadoras\n- clique nos cards para abrir a lista de pedidos ja filtrada",
    ],
  },
  {
    id: "orders",
    keywords: [
      "pedidos",
      "pedido",
      "lista",
      "filtro",
      "filtros",
      "detalhe",
      "historico",
      "rastreamento",
      "ordenar",
      "exportar",
      "abrir rastreio",
      "status atrasado",
      "tela pedidos",
    ],
    responses: [
      "Posso te ajudar melhor com Pedidos se voce me confirmar o foco.\n\nMe diga se a sua duvida e sobre:\n1. passo a passo para usar filtros\n2. ordenacao nas colunas\n3. exportacao HTML ou CSV\n4. abrir detalhes do pedido\n5. abrir rastreio\n6. entender algum status ou comportamento da lista",
      "Sobre a tela Pedidos, consigo te orientar de forma mais direta se voce me disser o foco.\n\nPode ser, por exemplo:\n1. filtros e busca\n2. exportacao\n3. ordenar colunas\n4. detalhes do pedido\n5. abrir rastreio\n6. entender os status",
    ],
  },
  {
    id: "api-search",
    keywords: [
      "buscar api",
      "api",
      "consulta externa",
      "pedido unico",
      "nf",
      "nota fiscal",
      "codigo de rastreio",
      "intelipost",
    ],
    responses: [
      "Consulta de pedido via API\n\nNa tela Pedidos voce pode buscar um pedido individual pela API.\n1. clique em Buscar API\n2. informe numero do pedido, nota fiscal ou codigo de rastreio\n3. o sistema tenta localizar o pedido e atualizar ou adicionar na lista",
      "Busca externa por API\n\nSe voce quiser localizar ou atualizar um pedido especifico:\n1. abra Pedidos\n2. clique em Buscar API\n3. informe pedido, NF ou rastreio\n4. o sistema consulta e tenta atualizar a base local",
    ],
  },
  {
    id: "no-movement",
    keywords: [
      "sem movimentacao",
      "sem atualizacao",
      "parado",
      "sem movimento",
      "dias sem movimentacao",
    ],
    responses: [
      "Pedidos sem movimentacao\n\nEssa tela destaca pedidos ativos que ficaram dias sem atualizacao.\n- pedidos finalizados ficam fora dessa lista\n- voce pode ajustar a faixa de dias para localizar casos mais criticos\n- essa visao ajuda a agir antes de virar atraso ou falha",
      "Sem Movimentacao\n\nEssa visao serve para achar pedidos que pararam de receber evento.\n- considera pedidos ativos\n- permite ajustar a faixa de dias\n- ajuda a localizar casos que merecem cobranca preventiva",
    ],
  },
  {
    id: "alerts",
    keywords: [
      "alerta",
      "alertas",
      "risco",
      "atraso",
      "monitoramento",
      "critico",
      "problema",
      "atraso plataforma",
      "atraso transportadora",
    ],
    responses: [
      "Alertas de Risco\n\nA tela de Alertas foca no que exige atencao imediata.\n- ajuda a localizar pedidos atrasados e situacoes criticas\n- facilita a priorizacao do acompanhamento\n- permite abrir detalhes para entender onde o pedido parou",
      "Alertas\n\nUse essa tela para priorizar o que ja merece acao.\n- concentra pedidos com risco e atraso\n- facilita a analise dos casos mais urgentes\n- permite abrir o detalhe do pedido para investigar a causa",
    ],
  },
  {
    id: "delivery-failures",
    keywords: [
      "falha na entrega",
      "falhas na entrega",
      "insucesso",
      "tentativa de entrega",
      "entrega falhou",
    ],
    responses: [
      "Falhas na Entrega\n\nEssa tela mostra pedidos com problema real de entrega.\n- pedidos ja entregues nao devem entrar na contagem pendente\n- fretes de retirada na agencia podem ser ignorados nessa analise\n- a visao ajuda a acompanhar novas falhas e agir com a transportadora",
      "Falhas na Entrega\n\nAqui ficam os pedidos com insucesso de entrega que ainda merecem acompanhamento.\n- entregue nao entra como pendencia\n- retirada na agencia pode ser desconsiderada dependendo da regra\n- a tela ajuda a separar falha real de ruido operacional",
    ],
  },
  {
    id: "import",
    keywords: [
      "importar",
      "csv",
      "xlsx",
      "excel",
      "planilha",
      "upload",
      "layout",
      "dados",
    ],
    responses: [
      "Importacao de Dados\n\nPara importar pedidos:\n1. acesse Importar CSV\n2. envie um arquivo CSV ou XLSX\n3. o sistema valida e processa a carga\n\nRegras importantes:\n- pedidos cancelados sao ignorados\n- o arquivo deve trazer dados do pedido, cliente, frete, datas e endereco",
      "Importacao\n\nPara subir uma planilha:\n1. abra Importar CSV\n2. envie o arquivo\n3. aguarde a validacao e o processamento\n\nO ideal e que o arquivo traga dados de pedido, cliente, frete, datas e endereco.",
    ],
  },
  {
    id: "sync",
    keywords: [
      "sync",
      "sincronizar",
      "sincronizacao",
      "sincronizacao de pedidos",
      "sync de pedidos",
      "sincronizar pedidos",
      "manual",
      "automatico",
      "relatorio de sincronizacao",
      "relatorio sync",
      "sync da tray",
      "sync de rastreio",
    ],
    responses: [
      "Sincronizacao\n\nPosso te ajudar melhor se voce me confirmar o foco.\n1. passo a passo para sincronizar manualmente\n2. como funciona o sync automatico\n3. diferenca entre sync de rastreio e sync da Integradora\n4. relatorio de sincronizacao\n5. pedido que nao sincronizou\n6. alguma funcionalidade especifica da sincronizacao",
      "Sincronizacao de pedidos\n\nConsigo te orientar melhor se voce me disser qual parte da sincronizacao quer entender.\n\nPode ser:\n1. sync manual\n2. sync automatico\n3. sync de rastreio\n4. sync da Integradora\n5. relatorio de sync\n6. erro ou comportamento inesperado",
    ],
  },
  {
    id: "tray",
    keywords: [
      "tray",
      "integracao tray",
      "sincronizar pedidos da tray",
      "oauth tray",
      "loja tray",
    ],
    responses: [
      "Integracao da Integradora\n\nA integracao com a Integradora permite:\n- autorizar a loja na tela de Integracao\n- acompanhar o status da integracao\n- sincronizar pedidos da Integradora\n- reaproveitar dados da plataforma em recursos como recotacao de frete",
      "Integradora\n\nCom a integracao da Integradora voce consegue autorizar a loja, acompanhar o status da conexao, sincronizar pedidos e usar os dados da plataforma em recursos como recotacao de frete.",
    ],
  },
  {
    id: "freight",
    keywords: [
      "frete",
      "recalculado",
      "recalculo",
      "cotacao",
      "quote",
      "frete recalculado atual",
      "diferenca frete",
    ],
    responses: [
      "Frete recalculado\n\nA plataforma suporta recotacao de frete por pedido e em lote.\n- o calculo depende de CEP valido e itens reais do pedido\n- a comparacao entre frete pago e frete recalculado ajuda a encontrar divergencias\n- a cotacao usa os dados da integracao quando eles estao disponiveis",
      "Recotacao de frete\n\nEsse recurso compara o frete pago com uma nova cotacao.\n- depende de CEP e itens reais do pedido\n- ajuda a enxergar diferenca de frete\n- usa os dados disponiveis da integracao quando necessario",
    ],
  },
  {
    id: "release-notes",
    keywords: [
      "release notes",
      "patch notes",
      "ultimas atualizacoes",
      "ultima atualizacao",
      "release",
    ],
    responses: [
      "Release Notes e Ultimas Atualizacoes\n\nA plataforma possui historico de atualizacoes publicadas.\n- administradores podem montar e enviar release notes por e-mail\n- a tela Ultimas Atualizacoes mostra o historico enviado\n- cada item exibe versao, resumo, novidades, ajustes e a previa do template",
      "Ultimas Atualizacoes\n\nAdministradores conseguem montar release notes, enviar por e-mail e acompanhar o historico na tela de atualizacoes com versao, resumo, novidades e ajustes.",
    ],
  },
  {
    id: "admin",
    keywords: [
      "admin",
      "administracao",
      "usuario",
      "usuarios",
      "empresa",
      "empresas",
      "permissao",
      "acesso",
      "senha",
    ],
    responses: [
      "Painel Administrativo\n\nNo painel administrativo ou de integracao voce pode:\n- gerenciar usuarios\n- definir perfil ADMIN ou USER\n- cadastrar e gerenciar empresas\n- configurar integracoes da empresa atual\n- enviar release notes\n\nAlgumas acoes exigem permissao de administrador.",
      "Administracao\n\nSe voce tiver permissao de ADMIN, consegue gerenciar usuarios, empresas, integracoes da empresa ativa e recursos administrativos como envio de release notes.",
    ],
  },
  {
    id: "company-switch",
    keywords: [
      "trocar empresa",
      "empresa atual",
      "alternar empresa",
      "mudar empresa",
    ],
    responses: [
      "Troca de empresa\n\nUsuarios com acesso administrativo podem alternar a empresa ativa quando houver mais de uma empresa disponivel.\n- a troca muda o contexto da operacao\n- pedidos, integracoes e configuracoes passam a refletir a empresa selecionada",
      "Empresa ativa\n\nQuando voce troca a empresa ativa, todo o contexto muda junto: pedidos, integracoes, relatorios e configuracoes passam a refletir a empresa selecionada.",
    ],
  },
  {
    id: "channel-logistics",
    keywords: [
      "logistica do canal",
      "canal",
      "shopee",
      "mercado livre",
      "coletas",
      "me2",
      "priority",
      "retirada",
      "agencia",
    ],
    responses: [
      "Logistica do Canal e fretes especiais\n\nQuando o frete e administrado pelo marketplace, o pedido pode aparecer como Logistica do Canal.\n- isso e comum em operacoes como Shopee Xpress, Mercado Envios e Coletas ME2\n- em alguns cenarios a plataforma ignora fretes de retirada na agencia em visoes especificas\n- o rastreio pode ser limitado quando a responsabilidade fica com o canal",
      "Logistica do Canal\n\nEsse status costuma aparecer quando a entrega e controlada pelo proprio marketplace.\n- Shopee Xpress e Mercado Envios sao exemplos comuns\n- o rastreio pode ficar mais limitado\n- alguns fretes especiais podem ser tratados de forma diferente em visoes especificas",
    ],
  },
  {
    id: "access",
    keywords: [
      "login",
      "esqueci a senha",
      "redefinir senha",
      "convite",
      "acesso por link",
    ],
    responses: [
      "Acesso e senha\n\nA plataforma possui fluxo de login e definicao de senha.\n- o usuario pode solicitar redefinicao de senha\n- convites podem ser concluidos por link de acesso\n- algumas rotas e configuracoes so ficam disponiveis apos autenticacao",
      "Login e senha\n\nSe a duvida for de acesso, a plataforma trabalha com autenticacao, redefinicao de senha e convite por link quando aplicavel.",
    ],
  },
  {
    id: "support",
    keywords: [
      "suporte",
      "contato",
      "ajuda rapida",
      "faq",
      "falar com o suporte",
    ],
    responses: [
      "Suporte\n\nSe voce precisar abrir um atendimento, use o botao Suporte no canto superior direito.\n- a tela preenche contexto da conta automaticamente\n- voce descreve o caso\n- a solicitacao e enviada com os dados da conta para agilizar o retorno",
      "Ajuda e suporte\n\nA tela de Suporte serve para registrar duvidas, bugs e pedidos com o contexto da conta ativa, email de login e tela em uso.",
    ],
  },
];

export const Chatbot: React.FC = () => {
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "0",
      role: "model",
      text: DEFAULT_WELCOME_MESSAGE,
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isAvatarOk, setIsAvatarOk] = useState(true);
  const [launcherPosition, setLauncherPosition] = useState({ x: 0, y: 0 });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const knowledgeCursorRef = useRef<Record<string, number>>({});
  const userCallName = getUserCallName(user?.name);
  const dragStateRef = useRef({
    pointerId: -1,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    moved: false,
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const personalizeGreeting = (text: string) => {
    if (!userCallName) return text;
    return `Ola ${userCallName}!\n\n${text}`;
  };

  const personalizeReply = (text: string) => {
    if (!userCallName) return text;

    const trimmed = text.trim();
    if (!trimmed) return trimmed;

    if (
      trimmed.startsWith(`${userCallName},`) ||
      trimmed.startsWith(`Ola ${userCallName}`) ||
      trimmed.startsWith(`Oi ${userCallName}`)
    ) {
      return trimmed;
    }

    return `${userCallName}, ${trimmed}`;
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [messages, isOpen]);

  useEffect(() => {
    setMessages((current) => {
      if (current.length !== 1 || current[0]?.id !== "0") {
        return current;
      }

      return [
        {
          ...current[0],
          text: personalizeGreeting(DEFAULT_WELCOME_MESSAGE),
        },
      ];
    });
  }, [userCallName]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateViewport = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      setViewportSize({ width, height });
      setLauncherPosition((current) => {
        if (current.x > 0 || current.y > 0) {
          return clampLauncherPosition(current.x, current.y, width, height);
        }

        return getDefaultLauncherPosition(width, height);
      });
    };

    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  const findKnowledgeItem = (text: string): KnowledgeItem | null => {
    const normalizedText = normalizeKnowledgeText(text);
    let bestMatch: KnowledgeItem | null = null;
    let bestScore = 0;

    for (const item of ENHANCED_KNOWLEDGE_BASE) {
      const score = item.keywords.reduce((total, keyword) => {
        const normalizedKeyword = normalizeKnowledgeText(keyword);

        if (!normalizedText.includes(normalizedKeyword)) {
          return total;
        }

        return total + Math.max(1, normalizedKeyword.split(" ").length * 2);
      }, 0);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }

    return bestMatch && bestScore > 0 ? bestMatch : null;
  };

  const getKnowledgeResponse = (item: KnowledgeItem) => {
    const currentIndex = knowledgeCursorRef.current[item.id] || 0;
    const response = item.responses[currentIndex % item.responses.length];
    knowledgeCursorRef.current[item.id] = currentIndex + 1;
    return response;
  };

  const askAI = async (
    history: Message[],
    userText: string,
  ): Promise<ChatResponsePayload> => {
    const response = await fetchWithAuth("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: userText,
        messages: history.slice(-12),
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        typeof data?.error === "string" ? data.error : `HTTP ${response.status}`;
      throw new Error(msg);
    }
    if (typeof data?.text !== "string" || !data.text.trim()) {
      throw new Error("Resposta vazia");
    }
    return {
      text: data.text,
      actions: Array.isArray(data?.actions)
        ? data.actions
            .map((action: any) => ({
              label: String(action?.label || "").trim(),
              value: String(action?.value || "").trim(),
              style:
                action?.style === "danger" ||
                action?.style === "secondary" ||
                action?.style === "primary"
                  ? action.style
                  : "primary",
            }))
            .filter(
              (action: ChatAction) => action.label.length > 0 && action.value.length > 0,
            )
        : [],
    };
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isLoading) return;

    const userText = input.trim();
    setInput("");

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      text: userText,
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    const conversationalResponse = getConversationalResponse(userText);
    if (conversationalResponse) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-smalltalk`,
          role: "model",
          text: personalizeReply(conversationalResponse),
        },
      ]);
      setIsLoading(false);
      return;
    }

    const shouldUseStructuredRequest = shouldUseStructuredChatRequest(userText);
    const knowledgeItem = shouldUseStructuredRequest
      ? null
      : findKnowledgeItem(userText);

    if (knowledgeItem) {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-knowledge`,
          role: "model",
          text: personalizeReply(getKnowledgeResponse(knowledgeItem)),
        },
      ]);
      setIsLoading(false);
      return;
    }

    try {
      const historySnapshot = [...messages, userMsg];
      const aiResponse = await askAI(historySnapshot, userText);
      const aiText = aiResponse.text;
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-ai`,
          role: "model",
          text: personalizeReply(
            isUncertainAiResponse(aiText)
              ? SUPPORT_FALLBACK_MESSAGE
              : aiText,
          ),
          actions: isUncertainAiResponse(aiText) ? [] : aiResponse.actions,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-fallback`,
          role: "model",
          text: personalizeReply(SUPPORT_FALLBACK_MESSAGE),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleActionClick = async (action: ChatAction) => {
    if (isLoading) return;

    const actionText = String(action.value || "").trim();
    if (!actionText) return;

    const userMsg: Message = {
      id: Date.now().toString(),
      role: "user",
      text: action.label,
    };

    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const historySnapshot = [...messages, userMsg];
      const aiResponse = await askAI(historySnapshot, actionText);
      const aiText = aiResponse.text;
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-ai-action`,
          role: "model",
          text: personalizeReply(
            isUncertainAiResponse(aiText)
              ? SUPPORT_FALLBACK_MESSAGE
              : aiText,
          ),
          actions: isUncertainAiResponse(aiText) ? [] : aiResponse.actions,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-fallback-action`,
          role: "model",
          text: personalizeReply(SUPPORT_FALLBACK_MESSAGE),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: launcherPosition.x,
      originY: launcherPosition.y,
      moved: false,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStateRef.current.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - dragStateRef.current.startX;
    const deltaY = event.clientY - dragStateRef.current.startY;

    if (
      !dragStateRef.current.moved &&
      Math.abs(deltaX) < 4 &&
      Math.abs(deltaY) < 4
    ) {
      return;
    }

    dragStateRef.current.moved = true;
    setLauncherPosition(
      clampLauncherPosition(
        dragStateRef.current.originX + deltaX,
        dragStateRef.current.originY + deltaY,
        viewportSize.width,
        viewportSize.height,
      ),
    );
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStateRef.current.pointerId !== event.pointerId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    const shouldToggle = !dragStateRef.current.moved;
    dragStateRef.current.pointerId = -1;
    dragStateRef.current.moved = false;

    if (shouldToggle) {
      setIsOpen((current) => !current);
    }
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStateRef.current.pointerId !== event.pointerId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    dragStateRef.current.pointerId = -1;
    dragStateRef.current.moved = false;
  };

  const shouldOpenToLeft =
    viewportSize.width > 0 && launcherPosition.x > viewportSize.width / 2;
  const shouldOpenAbove =
    viewportSize.height > 0 && launcherPosition.y > 540;

  return (
    <div
      className="fixed z-50 pointer-events-none"
      style={{
        left: launcherPosition.x,
        top: launcherPosition.y,
      }}
    >
      {isOpen && (
        <div
          className="pointer-events-auto flex h-[500px] w-[320px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl animate-in slide-in-from-bottom-10 fade-in duration-300 dark:border-white/10 dark:bg-[#151725] md:w-[380px]"
          style={{
            position: "absolute",
            [shouldOpenAbove ? "bottom" : "top"]: BOT_BUTTON_SIZE + BOT_WINDOW_GAP,
            [shouldOpenToLeft ? "right" : "left"]: 0,
          }}
        >
          <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-blue-600 to-purple-600 p-4">
            <div className="flex items-center gap-2 text-white">
              <div className="rounded-full bg-white/20 p-1.5 backdrop-blur-sm">
                <Sparkles className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold">{BOT_NAME}</h3>
                <p className="flex items-center gap-1 text-[10px] opacity-80">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-400"></span>
                  Online
                </p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="rounded-lg p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto bg-slate-50 p-4 dark:bg-[#0B0C15]">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={clsx(
                  "flex max-w-[90%] gap-3",
                  msg.role === "user" ? "ml-auto flex-row-reverse" : "",
                )}
              >
                <div
                  className={clsx(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                    msg.role === "user"
                      ? "border-slate-300 bg-slate-200 dark:border-white/5 dark:bg-white/10"
                      : "border-blue-200 bg-blue-100 dark:border-blue-900/30 dark:bg-blue-900/20",
                  )}
                >
                  {msg.role === "user" ? (
                    <User className="h-4 w-4 text-slate-600 dark:text-slate-300" />
                  ) : isAvatarOk ? (
                    <img
                      src={BOT_AVATAR_SRC}
                      alt={BOT_NAME}
                      className="h-5 w-5 object-contain"
                      onError={() => setIsAvatarOk(false)}
                    />
                  ) : (
                    <Bot className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  )}
                </div>

                <div
                  className={clsx(
                    "rounded-2xl p-3 text-sm shadow-sm",
                    msg.role === "user"
                      ? "rounded-tr-none bg-blue-600 text-white"
                      : "rounded-tl-none border border-slate-200 bg-white text-slate-700 dark:border-white/5 dark:bg-[#1A1D2D] dark:text-slate-200",
                  )}
                >
                  <div className="whitespace-pre-wrap leading-relaxed">
                    {renderRichText(msg.text)}
                  </div>
                  {msg.role === "model" &&
                    Array.isArray(msg.actions) &&
                    msg.actions.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {msg.actions.map((action) => (
                          <button
                            key={`${msg.id}-${action.value}-${action.label}`}
                            type="button"
                            onClick={() => handleActionClick(action)}
                            disabled={isLoading}
                            className={clsx(
                              "rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                              action.style === "danger"
                                ? "bg-rose-600 text-white hover:bg-rose-700"
                                : action.style === "secondary"
                                  ? "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-white/15 dark:bg-transparent dark:text-slate-200 dark:hover:bg-white/10"
                                  : "bg-blue-600 text-white hover:bg-blue-700",
                            )}
                          >
                            {action.label}
                          </button>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            ))}

            {isLoading && (
              <div className="flex max-w-[85%] gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-blue-100 dark:bg-blue-900/20">
                  {isAvatarOk ? (
                    <img
                      src={BOT_AVATAR_SRC}
                      alt={BOT_NAME}
                      className="h-5 w-5 object-contain"
                      onError={() => setIsAvatarOk(false)}
                    />
                  ) : (
                    <Bot className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                  )}
                </div>
                <div className="flex items-center gap-2 rounded-2xl rounded-tl-none border border-slate-200 bg-white p-3 dark:border-white/5 dark:bg-[#1A1D2D]">
                  <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                  <span className="text-xs text-slate-400">
                    Consultando a Muricoca...
                  </span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form
            onSubmit={handleSend}
            className="border-t border-slate-200 bg-white p-3 dark:border-white/5 dark:bg-[#151725]"
          >
            <div className="relative flex items-center gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ex: quantos pedidos estao atrasados?"
                className="w-full rounded-xl border border-slate-200 bg-slate-100 py-3 pl-4 pr-12 text-sm transition-colors focus:border-blue-500 focus:outline-none dark:border-white/10 dark:bg-black/20 dark:text-white"
              />
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="absolute right-2 rounded-lg bg-blue-600 p-1.5 text-white transition-colors hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        </div>
      )}

      <button
        className={clsx(
          "pointer-events-auto group relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-full shadow-lg transition-all duration-300 hover:scale-110 active:scale-95 touch-none",
          isOpen ? "bg-slate-800 text-white" : "border border-white bg-white",
        )}
        style={{
          cursor: dragStateRef.current.pointerId === -1 ? "grab" : "grabbing",
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {!isOpen && (
          <div className="absolute inset-0 rounded-full bg-blue-500/10 opacity-70 animate-pulse dark:bg-blue-400/10"></div>
        )}

        {!isOpen && (
          <div
            className={clsx(
              "muricoca-float absolute inset-[4px] relative z-10 overflow-hidden rounded-full bg-white transition-transform duration-300",
              "group-hover:scale-110 group-hover:rotate-2",
            )}
          >
            <img
              src={BOT_AVATAR_SRC}
              alt={BOT_NAME}
              className="pointer-events-none h-full w-full select-none object-cover"
              draggable={false}
              onDragStart={(event) => event.preventDefault()}
              onError={(event) => {
                console.error("Erro ao carregar imagem da Muricoca", event);
                setIsAvatarOk(false);
              }}
              style={{ display: isAvatarOk ? "block" : "none" }}
            />
          </div>
        )}

        {!isAvatarOk && !isOpen && (
          <MessageCircle className="relative z-10 h-7 w-7 text-blue-600 dark:text-blue-400" />
        )}

        {isOpen && (
          <div className="absolute inset-0 flex items-center justify-center">
            <X className="relative z-10 h-7 w-7" />
          </div>
        )}
      </button>
    </div>
  );
};
