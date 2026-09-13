"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sswTrackingService = exports.matchSswTrackingToOrder = void 0;
const axios_1 = __importDefault(require("axios"));
const orderStatus_1 = require("../types/orderStatus");
const SSW_TRACKING_BASE_URL = 'https://ssw.inf.br/app/tracking';
const SSW_REGISTER_URL = 'https://ssw.inf.br/2/Tracking';
const SSW_SELECT_URL = 'https://ssw.inf.br/2/SelecionarDocumento';
const SSW_DETAIL_URL = 'https://ssw.inf.br/2/SSWDetalhado';
const SSW_TIMEZONE_OFFSET = '-03:00';
const SSW_MIN_INTERVAL_MS = 1200;
const SSW_REQUEST_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.TRACKING_SSW_TIMEOUT_MS);
    if (!Number.isFinite(parsed)) {
        return 15_000;
    }
    return Math.min(120_000, Math.max(3_000, Math.floor(parsed)));
})();
const decodeHtmlEntities = (value) => value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
const stripHtml = (html) => decodeHtmlEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n'))
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const buildCookieHeader = (setCookieHeaders) => {
    if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) {
        return '';
    }
    return setCookieHeaders
        .map((cookie) => cookie.split(';')[0]?.trim())
        .filter(Boolean)
        .join('; ');
};
const extractHiddenInputValue = (html, inputName) => {
    const patterns = [
        new RegExp(`<input[^>]*name=["']${inputName}["'][^>]*value=["']([^"']+)["'][^>]*>`, 'i'),
        new RegExp(`<input[^>]*value=["']([^"']+)["'][^>]*name=["']${inputName}["'][^>]*>`, 'i'),
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1]) {
            return decodeHtmlEntities(match[1].trim());
        }
    }
    return null;
};
const extractSelectionCandidates = (html) => {
    const candidates = new Set();
    const normalizedHtml = String(html || '');
    const patterns = [
        /SelecionarDocumento\(['"]?([^'")\s]+)['"]?/gi,
        /selecionarDocumento\(['"]?([^'")\s]+)['"]?/gi,
        /data-id=["']([^"']+)["']/gi,
        /name=["']id["'][^>]*value=["']([^"']+)["']/gi,
        /value=["']([^"']+)["'][^>]*name=["']id["']/gi,
    ];
    for (const pattern of patterns) {
        for (const match of normalizedHtml.matchAll(pattern)) {
            if (match[1]) {
                candidates.add(decodeHtmlEntities(String(match[1]).trim()));
            }
        }
    }
    return Array.from(candidates);
};
const buildAjaxHeaders = (cookieHeader, referer) => ({
    Accept: 'text/html, */*;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Cookie: cookieHeader,
    Referer: referer,
    'User-Agent': 'Mozilla/5.0 Avantracking/1.0',
    'X-Requested-With': 'XMLHttpRequest',
});
const normalizeStatusText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const hasTrackingMarkers = (text) => {
    const normalized = normalizeStatusText(text);
    return [
        'documento de transporte emitido',
        'saida de unidade',
        'chegada em unidade',
        'mercadoria entregue',
        'previsao de entrega',
        'em transito',
        'ocorr',
        'insucesso',
        'entregue',
        'despachado',
        'saida para entrega',
        'saiu para entrega',
        'local de entrega fechado',
        'ausente',
        'fiscalizacao',
        'sem contato valido',
        'aguardando agendamento',
        'liberada do sac para rota',
    ].some((marker) => normalized.includes(marker));
};
const hasDirectTrackingTable = (html) => /Data\/Hora|Situa[cç][aã]o|class=["']titulo["']/i.test(String(html || ''));
const parseCarrierForecastFromText = (text) => {
    const match = text.match(/previs[aã]o\s+de\s+entrega\s*:?\s*(\d{2})\/(\d{2})\/(\d{2,4})/i);
    if (!match)
        return null;
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const parsedDate = new Date(`${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:59:59${SSW_TIMEZONE_OFFSET}`);
    return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
};
const parseSswDateTime = (day, month, year, hours, minutes, seconds) => {
    const iso = `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${SSW_TIMEZONE_OFFSET}`;
    const parsed = new Date(iso);
    if (!Number.isNaN(parsed.getTime())) {
        return parsed;
    }
    return new Date(year, month, day, hours, minutes, seconds, 0);
};
const parseLatestDateFromText = (text) => {
    const matches = Array.from(text.matchAll(/(\d{2})\/(\d{2})\/(\d{2,4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/g));
    if (matches.length === 0) {
        return new Date();
    }
    const latest = matches
        .map((match) => {
        const day = Number(match[1]);
        const month = Number(match[2]) - 1;
        const rawYear = Number(match[3]);
        const year = rawYear < 100 ? 2000 + rawYear : rawYear;
        const hours = Number(match[4] || 0);
        const minutes = Number(match[5] || 0);
        const seconds = Number(match[6] || 0);
        return parseSswDateTime(day, month, year, hours, minutes, seconds);
    })
        .filter((date) => !Number.isNaN(date.getTime()))
        .sort((left, right) => right.getTime() - left.getTime())[0];
    return latest || new Date();
};
const normalizeLocationToken = (value) => value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.;:,]+$/g, '')
    .trim();
const extractLocationFromText = (text) => {
    const normalizedText = normalizeLocationToken(text);
    if (!normalizedText) {
        return { city: null, state: null };
    }
    const patterns = [
        /na cidade de\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
        /cidade de\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
        /na unidade\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
        /da unidade\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
        /unidade\s+([A-ZÀ-Ú0-9' -]+?)(?:\s+em\b|[.;]|$)/i,
    ];
    for (const pattern of patterns) {
        const match = normalizedText.match(pattern);
        if (match?.[1]) {
            return {
                city: normalizeLocationToken(match[1]),
                state: null,
            };
        }
    }
    const slashMatch = normalizedText.match(/\b([A-ZÀ-Ú0-9' -]+)\s*\/\s*([A-Z]{2})\b/i);
    if (slashMatch?.[1]) {
        return {
            city: normalizeLocationToken(slashMatch[1]),
            state: normalizeLocationToken(slashMatch[2]).slice(0, 2).toUpperCase(),
        };
    }
    return { city: null, state: null };
};
const normalizeDigits = (value) => String(value || '').replace(/\D/g, '').trim();
const normalizeIdentifierDigits = (value) => {
    const normalized = normalizeDigits(value);
    if (!normalized) {
        return '';
    }
    const withoutLeadingZeros = normalized.replace(/^0+/, '');
    return withoutLeadingZeros || '0';
};
const normalizeComparableText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const NAME_STOPWORDS = new Set(['DA', 'DE', 'DO', 'DAS', 'DOS', 'E']);
const tokenizeComparableName = (value) => normalizeComparableText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token));
const compareDocuments = (leftValue, rightValue) => {
    const left = normalizeDigits(leftValue);
    const right = normalizeDigits(rightValue);
    if (!left || !right) {
        return false;
    }
    if (left === right) {
        return true;
    }
    const shortestLength = Math.min(left.length, right.length);
    if (shortestLength < 11) {
        return false;
    }
    return left.endsWith(right) || right.endsWith(left);
};
const compareCities = (leftValue, rightValue) => {
    const left = normalizeComparableText(leftValue);
    const right = normalizeComparableText(rightValue);
    if (!left || !right) {
        return false;
    }
    return left === right || left.includes(right) || right.includes(left);
};
const getNameMatchStrength = (expectedName, actualName) => {
    const expected = normalizeComparableText(expectedName);
    const actual = normalizeComparableText(actualName);
    if (!expected || !actual) {
        return 0;
    }
    if (expected === actual) {
        return 4;
    }
    if (expected.length >= 6 &&
        actual.length >= 6 &&
        (expected.includes(actual) || actual.includes(expected))) {
        return 3;
    }
    const expectedTokens = tokenizeComparableName(expectedName);
    const actualTokens = tokenizeComparableName(actualName);
    if (expectedTokens.length === 0 || actualTokens.length === 0) {
        return 0;
    }
    const actualTokenSet = new Set(actualTokens);
    const overlap = expectedTokens.filter((token) => actualTokenSet.has(token));
    const ratio = overlap.length / Math.max(expectedTokens.length, actualTokens.length);
    if (ratio >= 0.75 || overlap.length >= 3) {
        return 3;
    }
    if (ratio >= 0.5 && overlap.length >= 2) {
        return 2;
    }
    if (ratio >= 0.34 && overlap.length >= 1) {
        return 1;
    }
    return 0;
};
const findNextLineValue = (lines, labelPattern) => {
    const labelIndex = lines.findIndex((line) => labelPattern.test(line));
    if (labelIndex === -1) {
        return null;
    }
    for (let index = labelIndex + 1; index < lines.length; index += 1) {
        const candidate = String(lines[index] || '').trim();
        if (!candidate) {
            continue;
        }
        if (candidate.endsWith(':')) {
            break;
        }
        return candidate;
    }
    return null;
};
const extractInvoiceIdentifiers = (lines, queriedIdentifier) => {
    const invoiceValue = findNextLineValue(lines, /^N\s*Fiscal\b/i);
    const normalizedCandidates = new Set();
    const normalizedQueriedIdentifier = normalizeDigits(queriedIdentifier);
    if (invoiceValue) {
        const digitGroups = String(invoiceValue).match(/\d+/g) || [];
        const joinedDigits = digitGroups.join('');
        const lastDigitGroup = digitGroups[digitGroups.length - 1] || '';
        if (joinedDigits) {
            normalizedCandidates.add(joinedDigits);
        }
        if (lastDigitGroup) {
            normalizedCandidates.add(lastDigitGroup);
        }
    }
    if (normalizedQueriedIdentifier) {
        normalizedCandidates.add(normalizedQueriedIdentifier);
    }
    return Array.from(normalizedCandidates);
};
const extractTrackingMatchMetadata = (lines, text, fallbackCnpj, queriedIdentifier, events) => {
    const recipientLine = findNextLineValue(lines, /^Destinat/i);
    const recipientName = recipientLine
        ? recipientLine
            .split(/\s+-\s+/)
            .pop()
            ?.trim() || recipientLine.trim()
        : null;
    const deliveredToNameMatch = text.match(/recebido por\s+([A-ZÀ-Ú0-9 .,'-]+?)(?:,\s*parentesco|,\s*doc\b|\.|\(|$)/i);
    const deliveredToDocumentMatch = text.match(/doc\s*n\.?\s*:?\s*([0-9./\s-]+)/i);
    const destinationMatch = text.match(/destino\s*:?\s*([A-Z]{2})\/([A-ZÀ-Ú0-9' -]+)/i);
    const latestEventWithLocation = events.find((event) => event.city || event.state) || null;
    return {
        queriedCnpj: normalizeDigits(fallbackCnpj) || null,
        queriedIdentifier: normalizeDigits(queriedIdentifier) || queriedIdentifier || null,
        recipientName,
        recipientDocument: null,
        deliveredToName: deliveredToNameMatch?.[1]?.trim() || null,
        deliveredToDocument: deliveredToDocumentMatch?.[1]?.trim() || null,
        destinationCity: destinationMatch?.[2]?.trim() ||
            latestEventWithLocation?.city ||
            null,
        destinationState: destinationMatch?.[1]?.trim() ||
            latestEventWithLocation?.state ||
            null,
        invoiceIdentifiers: extractInvoiceIdentifiers(lines, queriedIdentifier),
    };
};
const matchSswTrackingToOrder = (order, result) => {
    const metadata = result.matchMetadata;
    const expectedDocument = normalizeDigits(order.cpf || order.cnpj);
    const orderIdentifierCandidates = Array.from(new Set([order.invoiceNumber, order.trackingCode]
        .map((value) => normalizeIdentifierDigits(value))
        .filter(Boolean)));
    const reasons = [];
    let score = 0;
    const documentCandidates = [metadata.deliveredToDocument, metadata.recipientDocument].filter(Boolean);
    const hasDocumentMatch = Boolean(expectedDocument) &&
        documentCandidates.some((candidate) => compareDocuments(expectedDocument, candidate));
    if (hasDocumentMatch) {
        score += 6;
        reasons.push('documento do cliente confere');
    }
    const nameCandidates = [metadata.recipientName, metadata.deliveredToName].filter(Boolean);
    const nameStrength = nameCandidates.reduce((currentBest, candidate) => {
        const nextStrength = getNameMatchStrength(order.customerName, candidate);
        return Math.max(currentBest, nextStrength);
    }, 0);
    if (nameStrength >= 4) {
        score += 4;
        reasons.push('nome do cliente confere');
    }
    else if (nameStrength >= 3) {
        score += 3;
        reasons.push('nome do cliente muito proximo');
    }
    else if (nameStrength >= 2) {
        score += 2;
        reasons.push('nome do cliente parcialmente confirmado');
    }
    const destinationCityMatch = compareCities(order.city, metadata.destinationCity);
    const destinationStateMatch = normalizeComparableText(order.state) &&
        normalizeComparableText(metadata.destinationState) &&
        normalizeComparableText(order.state) === normalizeComparableText(metadata.destinationState);
    const hasDestinationMatch = Boolean(destinationCityMatch && (destinationStateMatch || !metadata.destinationState));
    if (destinationCityMatch) {
        score += destinationStateMatch ? 2 : 1;
        reasons.push(destinationStateMatch
            ? 'destino do pedido confere'
            : 'cidade de destino confere');
    }
    let hasExactIdentifierMatch = false;
    let hasPartialIdentifierMatch = false;
    for (const candidate of orderIdentifierCandidates) {
        for (const identifier of metadata.invoiceIdentifiers) {
            const normalizedIdentifier = normalizeIdentifierDigits(identifier);
            if (!candidate || !normalizedIdentifier) {
                continue;
            }
            if (candidate === normalizedIdentifier) {
                hasExactIdentifierMatch = true;
                break;
            }
            const hasSuffixMatch = candidate.length >= 6 &&
                normalizedIdentifier.length >= 6 &&
                (candidate.endsWith(normalizedIdentifier) ||
                    normalizedIdentifier.endsWith(candidate));
            if (hasSuffixMatch) {
                hasPartialIdentifierMatch = true;
            }
        }
        if (hasExactIdentifierMatch) {
            break;
        }
    }
    if (hasExactIdentifierMatch) {
        score += 2;
        reasons.push('identificador consultado bate exatamente com o pedido');
    }
    else if (hasPartialIdentifierMatch) {
        score += 1;
        reasons.push('identificador consultado parcialmente compatível');
    }
    const hasRecipientMatch = nameStrength >= 2;
    return {
        isMatch: hasDocumentMatch ||
            hasRecipientMatch ||
            hasDestinationMatch ||
            hasExactIdentifierMatch,
        score,
        reasons,
        metadata,
    };
};
exports.matchSswTrackingToOrder = matchSswTrackingToOrder;
const mapSswStatusToEnum = (text) => {
    const normalized = normalizeStatusText(text);
    if (normalized.includes('entregue'))
        return orderStatus_1.OrderStatus.DELIVERED;
    if (normalized.includes('saiu para entrega') ||
        normalized.includes('saida para entrega')) {
        return orderStatus_1.OrderStatus.DELIVERY_ATTEMPT;
    }
    if (normalized.includes('ocorr') ||
        normalized.includes('insucesso') ||
        normalized.includes('aguardando agendamento') ||
        normalized.includes('nao entregue') ||
        normalized.includes('falha') ||
        normalized.includes('sinistr') ||
        normalized.includes('local de entrega fechado') ||
        normalized.includes('destinatario ausente') ||
        normalized.includes('ausente') ||
        normalized.includes('sem contato valido') ||
        normalized.includes('nao localizado') ||
        normalized.includes('endereco invalido')) {
        return orderStatus_1.OrderStatus.FAILURE;
    }
    if (normalized.includes('devol'))
        return orderStatus_1.OrderStatus.RETURNED;
    if (normalized.includes('cancel'))
        return orderStatus_1.OrderStatus.CANCELED;
    if (normalized.includes('em transito') ||
        normalized.includes('liberada do sac para rota') ||
        normalized.includes('despach') ||
        normalized.includes('ct-e autorizado') ||
        normalized.includes('transfer') ||
        normalized.includes('emissao do ct-e') ||
        normalized.includes('documento de transporte emitido') ||
        normalized.includes('chegada em unidade') ||
        normalized.includes('fiscalizacao') ||
        normalized.includes('liberada pela fiscalizacao')) {
        return orderStatus_1.OrderStatus.SHIPPED;
    }
    if (normalized.includes('coletad') ||
        normalized.includes('criad') ||
        normalized.includes('emitid')) {
        return orderStatus_1.OrderStatus.CREATED;
    }
    return null;
};
const extractSswEvents = (html) => {
    const rowPattern = /<tr[^>]*style=["'][^"']*background-color:[^"']*["'][^>]*>\s*<td[^>]*>\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*<\/td>\s*<td[^>]*>\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*<\/td>\s*<td[^>]*>\s*(?:<b>\s*)?<p[^>]*class=["']titulo["'][^>]*>\s*([\s\S]*?)\s*<\/p>(?:\s*<\/b>)?\s*<p[^>]*>\s*([\s\S]*?)\s*<\/p>\s*<\/td>\s*<\/tr>/gi;
    const events = [];
    for (const match of html.matchAll(rowPattern)) {
        const rawDate = stripHtml(match[1] || '').join(' ').replace(/\s+/g, ' ').trim();
        const rawUnit = stripHtml(match[2] || '').join(' ').replace(/\s+/g, ' ').trim();
        const rawTitle = stripHtml(match[3] || '').join(' ').replace(/\s+/g, ' ').trim();
        const rawDescription = stripHtml(match[4] || '').join(' ').replace(/\s+/g, ' ').trim();
        const status = mapSswStatusToEnum(`${rawTitle} ${rawDescription}`) || orderStatus_1.OrderStatus.PENDING;
        const eventDate = parseLatestDateFromText(rawDate || rawDescription);
        const unitParts = rawUnit
            .split('/')
            .map((part) => part.replace(/\bMID\b.*$/i, '').replace(/\u00a0/g, ' ').trim())
            .filter(Boolean);
        const parsedLocation = extractLocationFromText([rawTitle, rawDescription, rawUnit].filter(Boolean).join(' '));
        events.push({
            status,
            description: [rawTitle, rawDescription].filter(Boolean).join(' - '),
            city: parsedLocation.city || unitParts[0] || null,
            state: parsedLocation.state ||
                (unitParts[1] ? unitParts[1].slice(0, 2).trim() : null),
            eventDate,
        });
    }
    return events;
};
const buildResultFromHtml = (html, trackingUrl, invoiceNumber, fallbackCnpj, fallbackIdentifier) => {
    const normalizedHtml = String(html || '');
    const htmlSnippet = normalizedHtml.slice(0, 12000);
    const lines = stripHtml(normalizedHtml);
    const text = lines.join(' | ');
    if (!text ||
        text.length < 20 ||
        !hasTrackingMarkers(text) ||
        /cloudflare|forbidden|login|acesso negado|erro interno/i.test(text)) {
        return null;
    }
    const events = extractSswEvents(normalizedHtml);
    if (events.length === 0) {
        const statusLines = lines.filter((line) => mapSswStatusToEnum(line) !== null);
        const statusSource = statusLines[statusLines.length - 1] || text;
        const status = mapSswStatusToEnum(statusSource);
        if (!status) {
            return null;
        }
        events.push({
            status,
            description: lines.find((line) => /previs|entreg|tr[aãâ]nsito|ocorr|colet|despach|chegada|saida|documento/i.test(line)) || `Consulta SSW da NF ${invoiceNumber}`,
            city: null,
            state: null,
            eventDate: parseLatestDateFromText(text),
        });
    }
    const latestEvent = events
        .slice()
        .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime())[0];
    const latestKnownStatusEvent = events
        .slice()
        .sort((left, right) => right.eventDate.getTime() - left.eventDate.getTime())
        .find((event) => event.status !== orderStatus_1.OrderStatus.PENDING);
    return {
        source: 'SSW',
        status: (latestKnownStatusEvent || latestEvent).status,
        carrierEstimatedDate: parseCarrierForecastFromText(text),
        freightType: null,
        events,
        matchMetadata: extractTrackingMatchMetadata(lines, text, fallbackCnpj, fallbackIdentifier, events),
        rawPayload: {
            trackingUrl,
            htmlSnippet,
        },
    };
};
const buildRegisterPayload = (sessionHtml, normalizedCnpj, normalizedInvoiceNumber) => {
    const payload = new URLSearchParams();
    payload.set('tipo', 'tracking');
    const n = extractHiddenInputValue(sessionHtml, 'n') || normalizedInvoiceNumber;
    const c = extractHiddenInputValue(sessionHtml, 'c') || normalizedCnpj;
    const serie = extractHiddenInputValue(sessionHtml, 'serie');
    const chave = extractHiddenInputValue(sessionHtml, 'chave');
    if (n)
        payload.set('n', n);
    if (c)
        payload.set('c', c);
    if (serie)
        payload.set('serie', serie);
    if (chave)
        payload.set('chave', chave);
    return payload;
};
const looksLikeSelectionList = (html) => /selecionar|conhecimento|documento|lista|escolha|clique/i.test(stripHtml(String(html || '')).join(' | '));
class SswTrackingService {
    lastRequestAt = 0;
    async throttle() {
        const waitMs = Math.max(0, this.lastRequestAt + SSW_MIN_INTERVAL_MS - Date.now());
        if (waitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
        this.lastRequestAt = Date.now();
    }
    async fetchTrackingInternal(trackingUrl, fallbackCnpj, fallbackIdentifier, displayIdentifier) {
        try {
            await this.throttle();
            const sessionResponse = await axios_1.default.get(trackingUrl, {
                maxRedirects: 5,
                timeout: SSW_REQUEST_TIMEOUT_MS,
                responseType: 'text',
                validateStatus: () => true,
                headers: {
                    Accept: 'text/html',
                    'User-Agent': 'Mozilla/5.0 Avantracking/1.0',
                },
            });
            if (sessionResponse.status < 200 || sessionResponse.status >= 300) {
                return null;
            }
            const sessionHtml = String(sessionResponse.data || '');
            if (hasDirectTrackingTable(sessionHtml)) {
                const directResult = buildResultFromHtml(sessionHtml, trackingUrl, displayIdentifier, fallbackCnpj, fallbackIdentifier);
                if (directResult) {
                    return directResult;
                }
            }
            const cookieHeader = buildCookieHeader(sessionResponse.headers['set-cookie']);
            if (!cookieHeader) {
                return null;
            }
            const registerPayload = buildRegisterPayload(String(sessionResponse.data || ''), fallbackCnpj, fallbackIdentifier);
            const registerResponse = await axios_1.default.post(SSW_REGISTER_URL, registerPayload.toString(), {
                timeout: SSW_REQUEST_TIMEOUT_MS,
                responseType: 'text',
                validateStatus: () => true,
                headers: buildAjaxHeaders(cookieHeader, SSW_TRACKING_BASE_URL),
            });
            if (registerResponse.status >= 200 && registerResponse.status < 300) {
                const registerHtml = String(registerResponse.data || '');
                const registeredResult = buildResultFromHtml(registerHtml, SSW_REGISTER_URL, displayIdentifier, fallbackCnpj, fallbackIdentifier);
                if (registeredResult) {
                    return registeredResult;
                }
                if (looksLikeSelectionList(registerHtml)) {
                    const selectionCandidates = extractSelectionCandidates(registerHtml);
                    for (const candidate of selectionCandidates) {
                        const selectionPayloads = [
                            new URLSearchParams({ id: candidate }),
                            new URLSearchParams({ documento: candidate }),
                            new URLSearchParams({ id: candidate, documento: candidate }),
                        ];
                        for (const selectionPayload of selectionPayloads) {
                            const selectionResponse = await axios_1.default.post(SSW_SELECT_URL, selectionPayload.toString(), {
                                timeout: SSW_REQUEST_TIMEOUT_MS,
                                responseType: 'text',
                                validateStatus: () => true,
                                headers: buildAjaxHeaders(cookieHeader, SSW_TRACKING_BASE_URL),
                            });
                            if (selectionResponse.status < 200 ||
                                selectionResponse.status >= 300) {
                                continue;
                            }
                            const selectedResult = buildResultFromHtml(String(selectionResponse.data || ''), SSW_SELECT_URL, displayIdentifier, fallbackCnpj, fallbackIdentifier);
                            if (selectedResult) {
                                return selectedResult;
                            }
                        }
                    }
                }
            }
            const detailResponse = await axios_1.default.get(SSW_DETAIL_URL, {
                timeout: SSW_REQUEST_TIMEOUT_MS,
                responseType: 'text',
                validateStatus: () => true,
                headers: {
                    Accept: 'text/html',
                    Referer: SSW_TRACKING_BASE_URL,
                    Cookie: cookieHeader,
                    'User-Agent': 'Mozilla/5.0 Avantracking/1.0',
                },
            });
            if (detailResponse.status < 200 || detailResponse.status >= 300) {
                return null;
            }
            return buildResultFromHtml(String(detailResponse.data || ''), SSW_DETAIL_URL, displayIdentifier, fallbackCnpj, fallbackIdentifier);
        }
        catch (error) {
            console.error('Erro ao consultar SSW:', error);
            return null;
        }
    }
    async fetchTrackingByInvoice(cnpj, invoiceNumber) {
        const normalizedCnpj = String(cnpj || '').replace(/\D/g, '').trim();
        const normalizedInvoiceNumber = String(invoiceNumber || '').replace(/\D/g, '').trim();
        if (!normalizedCnpj || !normalizedInvoiceNumber) {
            return null;
        }
        const trackingUrl = `${SSW_TRACKING_BASE_URL}/${normalizedCnpj}/${normalizedInvoiceNumber}`;
        return this.fetchTrackingInternal(trackingUrl, normalizedCnpj, normalizedInvoiceNumber, normalizedInvoiceNumber);
    }
    async fetchTrackingByKey(trackingKey) {
        const normalizedTrackingKey = String(trackingKey || '')
            .replace(/[^A-Za-z0-9]/g, '')
            .toUpperCase()
            .trim();
        if (!normalizedTrackingKey) {
            return null;
        }
        const trackingUrl = `${SSW_TRACKING_BASE_URL}/${normalizedTrackingKey}`;
        return this.fetchTrackingInternal(trackingUrl, '', normalizedTrackingKey, normalizedTrackingKey);
    }
}
exports.sswTrackingService = new SswTrackingService();
