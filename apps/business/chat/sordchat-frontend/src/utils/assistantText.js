const MOJIBAKE_MARKERS = /(?:Ã.|Â.|â.|ð.|�)/;

const WINDOWS_1252_BYTES = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

const decodeMojibakeRun = (value) => {
  const bytes = [];
  for (const char of Array.from(value)) {
    const code = char.codePointAt(0);
    if (code <= 0xff) {
      bytes.push(code);
      continue;
    }
    const mapped = WINDOWS_1252_BYTES.get(code);
    if (mapped === undefined) return value;
    bytes.push(mapped);
  }

  try {
    return decodeURIComponent(bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""));
  } catch (_error) {
    return value;
  }
};

export const normalizeDisplayText = (value) => {
  if (value === null || value === undefined) return "";
  let text = Array.from(String(value))
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || code >= 32;
    })
    .join("")
    .normalize("NFC");

  if (MOJIBAKE_MARKERS.test(text)) {
    // Corrige UTF-8 interpretado como Windows-1252/Latin-1, inclusive emojis
    // antigos como "ðŸŽ«" (🎫) e "ðŸ’¬" (💬).
    text = text.replace(/[ÃÂâð][\u0080-\uFFFF]{1,3}/g, (cluster) => decodeMojibakeRun(cluster));
  }

  return text.replace(/\uFFFD+/g, "");
};

const normalizeAssistantPortuguese = (value) =>
  normalizeDisplayText(value)
    .replace(/\bNao\b/g, "Não")
    .replace(/\bnao\b/g, "não")
    .replace(/\bVoce\b/g, "Você")
    .replace(/\bvoce\b/g, "você")
    .replace(/\breuniao\b/gi, (match) => (match[0] === "R" ? "Reunião" : "reunião"))
    .replace(/\breunioes\b/gi, (match) => (match[0] === "R" ? "Reuniões" : "reuniões"))
    .replace(/\bconfirmacao\b/gi, (match) => (match[0] === "C" ? "Confirmação" : "confirmação"))
    .replace(/\bnotificacoes\b/gi, (match) => (match[0] === "N" ? "Notificações" : "notificações"))
    .replace(/\bacao\b/gi, (match) => (match[0] === "A" ? "Ação" : "ação"))
    .replace(/\bacoes\b/gi, (match) => (match[0] === "A" ? "Ações" : "ações"))
    .replace(/\bHorario\b/g, "Horário")
    .replace(/\bhorario\b/g, "horário")
    .replace(/\bTitulo\b/g, "Título")
    .replace(/\btitulo\b/g, "título")
    .replace(/\baté\s+(\d{2}:\d{2})/gi, "até $1")
    .replace(/\bate\s+(\d{2}:\d{2})/gi, "até $1")
    .replace(/\bas\s+(\d{1,2}:\d{2})/gi, "às $1")
    .replace(/\bagendara\b/gi, "agendará")
    .replace(/\bo reuniao\b/gi, "a reunião")
    .replace(/\bo reunião\b/gi, "a reunião")
    .replace(/\bpor video\b/gi, "por vídeo");

export const polishAssistantReply = (value) => normalizeAssistantPortuguese(value);

export const isAssistantConfirmation = (value) => {
  const normalized = normalizeDisplayText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.!?,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return /^(?:sim|confirmo|confirmado|ok|okay|certo|pode|pode confirmar|pode executar|pode criar|pode abrir|pode marcar|pode agendar|pode seguir|pode fazer)$/.test(normalized);
};

const cleanCorrectionPrefix = (value) =>
  String(value || "")
    .trim()
    .replace(/^vamos\s+(?:novamente|de\s+novo)[,:;\s-]*/i, "")
    .replace(/^(?:não|nao)[,;:]?\s*(?:é|e)\s+para\s+/i, "")
    .replace(/^(?:não|nao)[,;:]?\s*/i, "")
    .trim();

const normalizeTimeExpressions = (value) =>
  cleanCorrectionPrefix(value)
    .replace(/\b(?:as|às|a)\s+(\d{1,2})\s*(?:hrs?|horas?)\s*(?:da\s+manh[ãa])?/gi, (_match, hour) => `às ${String(Number(hour)).padStart(2, "0")}:00`)
    .replace(/\b(\d{1,2})\s*(?:hrs?|horas?)\s*(?:da\s+manh[ãa])?/gi, (_match, hour) => `${String(Number(hour)).padStart(2, "0")}:00`)
    .replace(/\b(?:as|às|a)\s+(\d{1,2})h(\d{2})?\b/gi, (_match, hour, minute) => `às ${String(Number(hour)).padStart(2, "0")}:${minute || "00"}`)
    .replace(/\b(?:as|às|a)\s+(\d{1,2}):(\d{2})\b/gi, (_match, hour, minute) => `às ${String(Number(hour)).padStart(2, "0")}:${minute}`)
    .replace(/\b(?:as|às|a)\s+(\d{2})(\d{2})\b/gi, (_match, hour, minute) => `às ${hour}:${minute}`)
    .replace(/[ \t]{2,}/g, " ")
    .trim();

const isMeetingText = (value) => /\b(?:reuni[aã]o|agenda(?:r|mento)?|marcar)\b/i.test(value || "");
const isTicketOrTaskText = (value) => /\b(?:ticket|tiket|ticekt|chamado|tarefa|task)\b/i.test(value || "");
const hasDate = (value) => /\b(?:\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|hoje|amanh[\u00e3a]|depois\s+de\s+amanh[\u00e3a]|segunda|ter[c\u00e7]a|quarta|quinta|sexta|s[\u00e1a]bado|domingo)\b/i.test(value || "");
const hasTime = (value) => /\b(?:às\s*)?\d{1,2}:\d{2}\b/i.test(normalizeTimeExpressions(value));

const latestValue = (patterns, latest, previous) => {
  for (const source of [latest, previous]) {
    for (const pattern of patterns) {
      const match = String(source || "").match(pattern);
      if (match?.[1]) return match[1].trim();
    }
  }
  return "";
};

const canonicalMeetingCommand = (previous, latest) => {
  const normalizedLatest = normalizeTimeExpressions(latest);
  const normalizedPrevious = normalizeTimeExpressions(previous);
  const date = latestValue([
    /\b(\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|hoje|amanh[\u00e3a]|depois\s+de\s+amanh[\u00e3a]|segunda|ter[c\u00e7]a|quarta|quinta|sexta|s[\u00e1a]bado|domingo)\b/i,
  ], normalizedLatest, normalizedPrevious);
  const time = latestValue([/\b(?:as\s*)?(\d{1,2}:\d{2})\b/i], normalizedLatest, normalizedPrevious);
  const subject = latestValue([
    /\breuni[a\u00e3]o\s+(?:de\s+|sobre\s+)?(.+?)(?=\s+(?:com|no\s+dia|dia|em|para|as)\b|[.,;]|$)/i,
    /\balinhamento\s+(.+?)(?=\s+(?:com|no\s+dia|dia|em|para|as)\b|[.,;]|$)/i,
  ], normalizedLatest, normalizedPrevious);
  const counterpart = latestValue([
    /\bcom\s+(.+?)(?=\s+(?:no\s+dia|dia|em|para|as)\b|[.,;]|$)/i,
  ], normalizedLatest, normalizedPrevious);

  if (!date && !time) return [normalizedPrevious, normalizedLatest].filter(Boolean).join("\n");

  const parts = ["Marcar reuniao"];
  if (subject) parts.push(`sobre ${subject}`);
  if (counterpart) parts.push(`com ${counterpart}`);
  if (date) parts.push(`no dia ${date}`);
  if (time) parts.push(`as ${time}`);
  return `${parts.join(" ")}.`;
};

export const buildAssistantFollowUpCommand = ({ pending, content }) => {
  const latest = normalizeTimeExpressions(content);
  if (!pending) return latest;

  const previous = normalizeTimeExpressions(pending.command || "");
  const latestIsCompleteMeeting = isMeetingText(latest) && hasDate(latest) && hasTime(latest);
  if (latestIsCompleteMeeting) {
    return canonicalMeetingCommand("", latest);
  }

  const pendingIsMeeting = pending.intent === "meeting" || isMeetingText(previous);
  if (pendingIsMeeting && isTicketOrTaskText(latest) && !isMeetingText(latest)) {
    return latest;
  }
  if (pendingIsMeeting && (pending.needs_input || pending.requires_confirmation)) {
    return canonicalMeetingCommand(previous, latest);
  }

  if (pending.needs_input) {
    return [previous, latest].filter(Boolean).join("\n");
  }

  if (pending.requires_confirmation) {
    return latest;
  }

  return latest;
};
