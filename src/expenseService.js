import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import archiver from 'archiver';
import { botDatabase } from './botDatabase.js';
import { askAI } from './aiBridge.js';
import { config } from './config.js';
import { listRecentConversationEntries } from './conversationStore.js';
import { resolveRelevantImageAttachments } from './imageContextService.js';
import { logger } from './logger.js';
import { mediaStore } from './mediaStore.js';

function compactSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function foldText(text) {
  return compactSpaces(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatTwoDigits(value) {
  return String(value).padStart(2, '0');
}

function formatDateTime(dateInput) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return '--/--/---- --:--';
  return (
    `${formatTwoDigits(date.getDate())}/${formatTwoDigits(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${formatTwoDigits(date.getHours())}:${formatTwoDigits(date.getMinutes())}`
  );
}

function formatCurrencyFromCents(amountCents) {
  const value = Number(amountCents || 0) / 100;
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  });
}

function normalizeExpenseTitle(value, fallback = 'Despesa avulsa') {
  let title = compactSpaces(String(value || '').replace(/\uFEFF/g, ' '));
  title = title.replace(/`+/g, ' ');
  title = title.replace(/\bse quiser\b.*$/i, ' ');
  title = title.replace(/\|\s*r\$\s*[\d.,]+.*$/i, ' ');
  title = title.replace(/[|]+.*$/g, ' ');
  title = title.replace(/[.;,:!?-]+$/g, ' ');
  title = compactSpaces(title);
  return title || fallback;
}

function normalizeExpenseObservation(value) {
  return compactSpaces(String(value || '').replace(/^obs(?:ervacao|ervação)?\s*[:=-]?\s*/i, ''));
}

function normalizeGroupFolderName(groupId) {
  return String(groupId || '').trim().replace(/@/g, '_');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EXPENSE_DELETE_ALL_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const expenseDeleteAllConfirmations = new Map();

function normalizeSenderKey(value) {
  return String(value || '').replace(/\D/g, '');
}

function resolveExpenseConfirmationSender(context = {}) {
  const senderNumber = normalizeSenderKey(context.senderNumber || '');
  if (senderNumber) return senderNumber;
  const senderJid = String(context.senderJid || '').trim();
  const senderJidDigits = normalizeSenderKey(String(senderJid).split('@')[0]);
  return senderJidDigits || senderJid;
}

function buildExpenseDeleteAllConfirmationKey(groupId, senderKey) {
  return `${String(groupId || '').trim()}::${String(senderKey || '').trim()}`;
}

function pruneExpiredExpenseDeleteAllConfirmations(now = Date.now()) {
  for (const [key, entry] of expenseDeleteAllConfirmations.entries()) {
    if (!entry || Number(entry.expiresAt || 0) <= now) {
      expenseDeleteAllConfirmations.delete(key);
    }
  }
}

function getPendingExpenseDeleteAllConfirmation(context = {}) {
  pruneExpiredExpenseDeleteAllConfirmations();
  const groupId = String(context.groupId || '').trim();
  const senderKey = resolveExpenseConfirmationSender(context);
  if (!groupId || !senderKey) return null;
  return expenseDeleteAllConfirmations.get(buildExpenseDeleteAllConfirmationKey(groupId, senderKey)) || null;
}

function setPendingExpenseDeleteAllConfirmation(context = {}, payload = {}) {
  pruneExpiredExpenseDeleteAllConfirmations();
  const groupId = String(context.groupId || '').trim();
  const senderKey = resolveExpenseConfirmationSender(context);
  if (!groupId || !senderKey) return false;
  const now = Date.now();
  expenseDeleteAllConfirmations.set(buildExpenseDeleteAllConfirmationKey(groupId, senderKey), {
    groupId,
    senderKey,
    createdAt: now,
    expiresAt: now + EXPENSE_DELETE_ALL_CONFIRMATION_TTL_MS,
    ...payload
  });
  return true;
}

function clearPendingExpenseDeleteAllConfirmation(context = {}) {
  pruneExpiredExpenseDeleteAllConfirmations();
  const groupId = String(context.groupId || '').trim();
  const senderKey = resolveExpenseConfirmationSender(context);
  if (!groupId || !senderKey) return false;
  return expenseDeleteAllConfirmations.delete(buildExpenseDeleteAllConfirmationKey(groupId, senderKey));
}

function parseMoneyToCents(value) {
  const input = compactSpaces(String(value || '').replace(/r\$\s*/gi, ''));
  if (!input) return 0;

  const normalized = input.includes(',')
    ? input.replace(/\./g, '').replace(',', '.')
    : input.replace(',', '.');
  const numeric = Number.parseFloat(normalized);
  if (!Number.isFinite(numeric)) return 0;
  return Math.round(numeric * 100);
}

function parseDateTextToIso(value) {
  const text = compactSpaces(String(value || '').replace(/\s+às\s+/i, ' '));
  if (!text) return '';

  const full = text.match(
    /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/
  );
  if (full) {
    const day = Number.parseInt(full[1], 10);
    const month = Number.parseInt(full[2], 10);
    const rawYear = Number.parseInt(full[3], 10);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const hour = Number.parseInt(full[4] || '0', 10);
    const minute = Number.parseInt(full[5] || '0', 10);
    const second = Number.parseInt(full[6] || '0', 10);
    const date = new Date(year, month - 1, day, hour, minute, second, 0);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  const short = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\b/);
  if (short) {
    const now = new Date();
    const day = Number.parseInt(short[1], 10);
    const month = Number.parseInt(short[2], 10);
    const hour = Number.parseInt(short[3] || '0', 10);
    const minute = Number.parseInt(short[4] || '0', 10);
    const second = Number.parseInt(short[5] || '0', 10);
    const date = new Date(now.getFullYear(), month - 1, day, hour, minute, second, 0);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  return '';
}

function extractObservation(text) {
  const match = String(text || '').match(/\b(?:obs|observacao|observação)\s*[:=-]\s*(.+)$/i);
  return match ? normalizeExpenseObservation(match[1]) : '';
}

function extractMoneyText(text) {
  const match = String(text || '').match(/(?:r\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}|(?:r\$\s*)?\d+(?:[.,]\d{2})/i);
  return compactSpaces(match?.[0] || '');
}

function stripCommandNoise(text) {
  return compactSpaces(
    String(text || '')
      .replace(/\b(?:mostrar|listar|ver|verificar|consultar|consulta|como esta|como está|status)\b/gi, ' ')
      .replace(
        /\b(?:adiciona|adicionar|inclui|incluir|registra|registrar|lanca|lança|lançar|cadastra|cadastrar|apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\b/gi,
        ' '
      )
      .replace(/\b(?:exportar|gerar|baixar|enviar)\b/gi, ' ')
      .replace(/\b(?:planilha de )?despesas?\b/gi, ' ')
      .replace(/\b(?:de hoje|do dia de hoje|hoje|de ontem|ontem|deste mes|deste mês|do mes|do mês|neste mes|neste mês)\b/gi, ' ')
      .replace(/[|()[\]{}]/g, ' ')
  );
}

function extractExpenseQuery(text) {
  const cleaned = stripCommandNoise(text)
    .replace(/\b(?:csv|excel|xlsx)\b/gi, ' ')
    .replace(/\b(?:no|na|do|da|de|em|para)\b/gi, ' ');
  const query = compactSpaces(
    cleaned
      .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ')
      .replace(/\b\d{1,2}\/\d{4}\b/g, ' ')
      .replace(/\b\d{1,2}\/\d{1,2}\b/g, ' ')
  );
  return query.length >= 2 ? query : '';
}

function buildDayRange(baseDate) {
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 0, 0, 0, 0);
  const end = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + 1, 0, 0, 0, 0);
  return {
    fromIso: start.toISOString(),
    toIso: end.toISOString()
  };
}

function buildMonthRange(baseDate) {
  const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 1, 0, 0, 0, 0);
  return {
    fromIso: start.toISOString(),
    toIso: end.toISOString()
  };
}

function parseExpensePeriod(text) {
  const folded = foldText(text);
  if (!folded) return { fromIso: '', toIso: '', label: 'todos os registros' };

  const now = new Date();

  if (/\bhoje\b/.test(folded)) {
    return {
      ...buildDayRange(now),
      label: 'hoje'
    };
  }

  if (/\bontem\b/.test(folded)) {
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, now.getHours(), now.getMinutes(), 0, 0);
    return {
      ...buildDayRange(yesterday),
      label: 'ontem'
    };
  }

  if (/\b(deste|do|neste)\s+mes\b|\b(deste|do|neste)\s+m[eê]s\b/.test(folded) || /\beste mes\b|\beste m[eê]s\b/.test(folded)) {
    return {
      ...buildMonthRange(now),
      label: 'este mes'
    };
  }

  const explicit = compactSpaces(text).match(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/);
  if (explicit) {
    const iso = parseDateTextToIso(explicit[1]);
    if (iso) {
      const date = new Date(iso);
      return {
        ...buildDayRange(date),
        label: explicit[1]
      };
    }
  }

  const explicitMonth = compactSpaces(text).match(/(?:^|[^\d/])(\d{1,2})\/(\d{4})(?=[^\d/]|$)/);
  if (explicitMonth) {
    const month = Number.parseInt(explicitMonth[1], 10);
    const year = Number.parseInt(explicitMonth[2], 10);
    if (month >= 1 && month <= 12 && year >= 2000 && year <= 9999) {
      const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
      return {
        ...buildMonthRange(start),
        label: `${formatTwoDigits(month)}/${year}`
      };
    }
  }

  return { fromIso: '', toIso: '', label: 'todos os registros' };
}

function buildDefaultMonthLabel(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return 'all';
  return `${date.getFullYear()}-${formatTwoDigits(date.getMonth() + 1)}`;
}

function buildDayLabel(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) return 'all';
  return (
    `${date.getFullYear()}-${formatTwoDigits(date.getMonth() + 1)}-${formatTwoDigits(date.getDate())}`
  );
}

function extractReceiptFieldsFromText(text) {
  const normalized = String(text || '');
  if (!normalized.trim()) return null;

  const normalizeCapturedField = (value) =>
    compactSpaces(String(value || '').replace(/`+/g, ' ').replace(/[|]+$/g, ' ').replace(/\.\s*$/g, ''));

  const capture = (...patterns) => {
    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        return normalizeCapturedField(match[1]);
      }
    }
    return '';
  };

  const amountText = capture(
    /valor\s*:\s*`?\s*([\s\S]+?)(?=\s*(?:data\s*:|banco origem\s*:|banco destino\s*:|nome na origem\s*:|nome no destino\s*:|pagador\s*:|recebedor\s*:|$))/i,
    /\|\s*(r\$\s*[\d.,]+)\s*\|/i
  );
  const dateText = capture(
    /data\s*:\s*`?\s*([\s\S]+?)(?=\s*(?:banco origem\s*:|banco destino\s*:|nome na origem\s*:|nome no destino\s*:|pagador\s*:|recebedor\s*:|$))/i,
    /\|\s*r\$\s*[\d.,]+\s*\|\s*([0-3]?\d\/[01]?\d\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?)/i
  );
  const originBank = capture(
    /banco origem\s*:\s*`?\s*([\s\S]+?)(?=\s*(?:banco destino\s*:|nome na origem\s*:|nome no destino\s*:|pagador\s*:|recebedor\s*:|$))/i
  );
  const destinationBank = capture(
    /banco destino\s*:\s*`?\s*([\s\S]+?)(?=\s*(?:nome na origem\s*:|nome no destino\s*:|pagador\s*:|recebedor\s*:|$))/i
  );
  const payerName = capture(
    /(?:nome na origem|pagador)\s*:\s*`?\s*([\s\S]+?)(?=\s*(?:nome no destino\s*:|recebedor\s*:|$))/i
  );
  const payeeName = capture(/(?:nome no destino|recebedor)\s*:\s*`?\s*([\s\S]+?)(?=\s*$)/i);
  const inlineTitle = capture(/despesa inclu[ií]da\s*:\s*([^|\n]+)/i);
  const amountCents = parseMoneyToCents(amountText);
  const expenseAt = parseDateTextToIso(dateText);
  const title = normalizeExpenseTitle(payeeName || inlineTitle || payerName || 'Despesa por comprovante');

  if (!amountCents && !expenseAt && !originBank && !destinationBank && !payerName && !payeeName && !inlineTitle) {
    return null;
  }

  return {
    title,
    amountCents,
    expenseAt,
    originBank,
    destinationBank,
    payerName,
    payeeName,
    observation: '',
    rawText: compactSpaces(normalized),
    source: 'ocr'
  };
}

async function readQuotedMessageText(context = {}) {
  const message = context.message;
  if (!message?.hasQuotedMsg || typeof message.getQuotedMessage !== 'function') return '';

  try {
    const quoted = await message.getQuotedMessage();
    if (!quoted) return '';
    return compactSpaces(`${quoted.body || ''} ${quoted.caption || ''} ${quoted?._data?.caption || ''}`);
  } catch {
    return '';
  }
}

async function findRecentReceiptText(groupId) {
  if (!groupId) return '';

  try {
    const recent = await listRecentConversationEntries(groupId, 16);
    for (const entry of [...recent].reverse()) {
      const parsed = extractReceiptFieldsFromText(entry?.text || '');
      if (parsed) {
        return entry.text || '';
      }
    }
  } catch {
    // fallback silencioso
  }

  return '';
}

function extractJsonObject(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return null;

  const direct = normalized.match(/\{[\s\S]*\}/);
  if (!direct) return null;

  try {
    return JSON.parse(direct[0]);
  } catch {
    return null;
  }
}

async function extractReceiptFieldsFromImage(text, context = {}) {
  const attachments = await resolveRelevantImageAttachments({
    text,
    context,
    limit: 1,
    allowRecentFallback: true
  });

  if (!attachments.length) return null;

  const mediaMeta = attachments[0]?.mediaId ? mediaStore.getById(attachments[0].mediaId) : null;
  const prompt = [
    'Leia a imagem anexada como um comprovante de despesa ou transferencia.',
    'Responda somente com JSON valido, sem markdown.',
    'Formato exato:',
    '{"ok":true,"title":"","amountBRL":"","dateText":"","originBank":"","destinationBank":"","payerName":"","payeeName":"","observation":""}',
    'Use strings vazias quando um campo nao estiver visivel.',
    `Pedido do usuario: ${compactSpaces(text) || 'registrar despesa por comprovante'}`
  ].join('\n');

  const response = await askAI(prompt, {
    groupId: context.groupId || '',
    senderNumber: context.senderNumber || '',
    isAdminSender: false,
    isFullSender: false,
    recentContext: '',
    imageAttachments: attachments
  });

  const parsedJson = extractJsonObject(response);
  if (parsedJson && parsedJson.ok !== false) {
    const amountCents = parseMoneyToCents(parsedJson.amountBRL || '');
    const expenseAt = parseDateTextToIso(parsedJson.dateText || '');
    if (amountCents > 0 || expenseAt || parsedJson.originBank || parsedJson.destinationBank || parsedJson.payeeName) {
      return {
        title: normalizeExpenseTitle(parsedJson.title || parsedJson.payeeName || parsedJson.payerName || 'Despesa por comprovante'),
        amountCents,
        expenseAt,
        originBank: compactSpaces(parsedJson.originBank || ''),
        destinationBank: compactSpaces(parsedJson.destinationBank || ''),
        payerName: compactSpaces(parsedJson.payerName || ''),
        payeeName: compactSpaces(parsedJson.payeeName || ''),
        observation: normalizeExpenseObservation(parsedJson.observation || ''),
        rawText: compactSpaces(response),
        source: 'ocr',
        dedupeKey: mediaMeta?.sha256 ? `sha256:${mediaMeta.sha256}` : ''
      };
    }
  }

  const parsedText = extractReceiptFieldsFromText(response);
  if (!parsedText) return null;

  return {
    ...parsedText,
    dedupeKey: mediaMeta?.sha256 ? `sha256:${mediaMeta.sha256}` : ''
  };
}

async function resolveReceiptExpenseInput(text, context = {}) {
  const candidates = [
    compactSpaces(text),
    await readQuotedMessageText(context),
    await findRecentReceiptText(context.groupId || '')
  ].filter(Boolean);

  for (const candidate of candidates) {
    const parsed = extractReceiptFieldsFromText(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return extractReceiptFieldsFromImage(text, context);
}

function buildExportRows(items = []) {
  return items.map((item) => ({
    Data: formatDateTime(item.expenseAt || item.createdAt),
    Nome: item.title || '',
    Valor: formatCurrencyFromCents(item.amountCents || 0),
    Origem: item.originBank || '',
    Destino: item.destinationBank || '',
    Observacao: item.observation || '',
    'Origem do registro': item.sourceLabel || item.source || '',
    Status: item.statusLabel || item.status || '',
    Pagador: item.payerName || '',
    Recebedor: item.payeeName || '',
    ID: String(item.id || '')
  }));
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (!/[;"\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeCsvFile(filePath, rows = []) {
  await mkdir(dirname(filePath), { recursive: true });
  const columns = rows.length ? Object.keys(rows[0]) : ['Data', 'Nome', 'Valor', 'Origem', 'Destino', 'Observacao'];
  const lines = [
    columns.join(';'),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? '')).join(';'))
  ];
  await writeFile(filePath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xlsxColumnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function buildWorksheetXml(rows = []) {
  const allRows = rows.map((row) => Object.values(row));
  const lines = allRows.map((values, rowIndex) => {
    const cells = values.map((value, columnIndex) => {
      const ref = `${xlsxColumnName(columnIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    });
    return `<row r="${rowIndex + 1}">${cells.join('')}</row>`;
  });

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${lines.join('')}</sheetData>` +
    '</worksheet>'
  );
}

async function writeXlsxFile(filePath, rows = []) {
  await mkdir(dirname(filePath), { recursive: true });
  const sheetRows = rows.length
    ? [{ ...rows[0] && Object.fromEntries(Object.keys(rows[0]).map((key) => [key, key])) }, ...rows]
    : [{ Data: 'Data', Nome: 'Nome', Valor: 'Valor', Origem: 'Origem', Destino: 'Destino', Observacao: 'Observacao' }];
  const worksheetXml = buildWorksheetXml(sheetRows);

  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '</Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Despesas" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '</Relationships>',
    'xl/worksheets/sheet1.xml': worksheetXml
  };

  await new Promise((resolve, reject) => {
    const output = createWriteStream(filePath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    for (const [name, content] of Object.entries(files)) {
      archive.append(content, { name });
    }

    archive.finalize().catch(reject);
  });
}

async function refreshExpenseExports({ groupId, dateInput, fromIso = '', toIso = '' } = {}) {
  const baseDate = dateInput ? new Date(dateInput) : new Date();
  const label =
    fromIso && toIso && new Date(toIso).getTime() - new Date(fromIso).getTime() <= 24 * 60 * 60 * 1000
      ? buildDayLabel(baseDate)
      : buildDefaultMonthLabel(baseDate);
  const folder = join('data', 'despesas', normalizeGroupFolderName(groupId));
  const csvPath = join(folder, `despesas-${label}.csv`);
  const xlsxPath = join(folder, `despesas-${label}.xlsx`);

  const list = await botDatabase.listExpenses({
    groupId,
    fromIso,
    toIso,
    limit: 500
  });
  const rows = buildExportRows(list.items);

  await writeCsvFile(csvPath, rows);
  await writeXlsxFile(xlsxPath, rows);

  return {
    csvPath,
    xlsxPath,
    label
  };
}

async function refreshExpenseExportsForItems({ groupId, items = [], ranges = [] } = {}) {
  const seen = new Set();
  const tasks = [];

  for (const item of items) {
    const date = new Date(item?.expenseAt || item?.createdAt || '');
    if (Number.isNaN(date.getTime())) continue;

    const range = buildMonthRange(date);
    const key = `${range.fromIso}|${range.toIso}`;
    if (seen.has(key)) continue;
    seen.add(key);

    tasks.push(
      refreshExpenseExports({
        groupId,
        dateInput: date,
        ...range
      })
    );
  }

  for (const range of ranges) {
    const fromIso = compactSpaces(range?.fromIso);
    const toIso = compactSpaces(range?.toIso);
    if (!fromIso || !toIso) continue;

    const key = `${fromIso}|${toIso}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const dateInput = range?.dateInput ? new Date(range.dateInput) : new Date(fromIso);
    tasks.push(
      refreshExpenseExports({
        groupId,
        dateInput: Number.isNaN(dateInput.getTime()) ? new Date() : dateInput,
        fromIso,
        toIso
      })
    );
  }

  if (!tasks.length) return [];
  return Promise.all(tasks);
}

function buildExpenseLine(item, index) {
  const banks = [item.originBank, item.destinationBank].filter(Boolean).join(' -> ');
  const source = item.sourceLabel || item.source || 'manual';
  const parts = [
    `${index}. ${formatDateTime(item.expenseAt || item.createdAt)}`,
    item.title || 'Despesa',
    formatCurrencyFromCents(item.amountCents || 0),
    source
  ];
  if (banks) parts.push(banks);
  return parts.join(' | ');
}

function buildExpenseHelpLines() {
  return [
    'Comandos uteis:',
    '- @despesa 100,00 IPTV',
    '- @despesas listar',
    '- @despesas listar hoje',
    '- @despesas exportar csv',
    '- @despesas apagar id 15',
    '- @despesas apagar todas',
    '- @despesas exportar xlsx',
    '- adicionar 100,00 na despesa IPTV',
    '- mostrar despesas',
    '- mostrar despesas de hoje',
    '- exportar despesas csv',
    '- apagar despesa id 15'
  ];
}

function parseManualExpenseCommand(text) {
  const normalized = compactSpaces(text);
  const amountText = extractMoneyText(normalized);
  const amountCents = parseMoneyToCents(amountText);
  if (!amountCents) return null;

  const observation = extractObservation(normalized);
  const dateMatch = normalized.match(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*(?:às|as)?\s*\d{1,2}:\d{2}(?::\d{2})?)?\b/i);
  const expenseAt = parseDateTextToIso(dateMatch?.[0] || '') || new Date().toISOString();

  let titleCandidate = normalized;
  if (amountText) {
    titleCandidate = titleCandidate.replace(new RegExp(escapeRegExp(amountText), 'i'), ' ');
  }
  if (observation) {
    titleCandidate = titleCandidate.replace(new RegExp(`${escapeRegExp(observation)}\\s*$`, 'i'), ' ');
  }
  if (dateMatch?.[0]) {
    titleCandidate = titleCandidate.replace(dateMatch[0], ' ');
  }

  titleCandidate = titleCandidate
    .replace(/\b(?:adiciona|adicionar|inclui|incluir|registra|registrar|lanca|lança|lançar|cadastra|cadastrar)\b/gi, ' ')
    .replace(/\b(?:na|no|a|o|em|para|de|do|da)\b\s*(?:planilha de )?despesas?\b/gi, ' ')
    .replace(/\b(?:planilha de )?despesas?\b/gi, ' ');

  const title = normalizeExpenseTitle(titleCandidate, 'Despesa avulsa');

  return {
    title,
    amountCents,
    expenseAt,
    observation,
    source: 'manual'
  };
}

export function parseExpenseCommand(text, context = {}) {
  const normalized = compactSpaces(text);
  const folded = foldText(normalized);
  if (!folded) return null;

  const pendingDeleteAllConfirmation = getPendingExpenseDeleteAllConfirmation(context);

  if (/^confirmo\s+apagar\s+todas\s+as\s+despesas[.!?]*$/.test(folded)) {
    return {
      action: 'delete_all_confirmed',
      confirmationMode: 'explicit'
    };
  }

  if (
    pendingDeleteAllConfirmation &&
    (/^confirm(?:o|ar)?[.!?]*$/.test(folded) ||
      /^(?:apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\s+todas\s+as\s+despesas[.!?]*$/.test(folded) ||
      /^todas\s+as\s+despesas[.!?]*$/.test(folded))
  ) {
    return {
      action: 'delete_all_confirmed',
      confirmationMode: 'pending'
    };
  }

  const mentionsExpenses = /\bdespesas?\b/.test(folded) || /\bplanilha de despesas\b/.test(folded);
  if (!mentionsExpenses) return null;

  if (/^[@!]?\s*despesas?[.!?]*$/.test(folded)) {
    return { action: 'summary' };
  }

  // Prefixo @despesa / @ despesa / !despesa <valor> <titulo> ou @despesas <subcomando>
  if (/^[@!]\s*despesas?\b/.test(folded)) {
    const stripped = normalized.replace(/^[@!]\s*despesas?\s*/i, '').trim();
    const strippedFolded = foldText(stripped);

    if (!stripped) {
      return { action: 'summary' };
    }

    if (/^(listar|mostrar|ver|consultar|extrato|resumo|relatorio|relat[oó]rio)/.test(strippedFolded)) {
      return {
        action: 'list',
        query: extractExpenseQuery(stripped),
        ...parseExpensePeriod(stripped)
      };
    }

    if (/(exportar|gerar|baixar|enviar)/.test(strippedFolded)) {
      const format = /\bxlsx\b|\bexcel\b/.test(strippedFolded)
        ? 'xlsx'
        : /\bcsv\b/.test(strippedFolded)
          ? 'csv'
          : 'both';
      return {
        action: 'export',
        format,
        ...parseExpensePeriod(stripped)
      };
    }

    if (/^(apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\b/.test(strippedFolded)) {
      const idMatch = stripped.match(/(?:id\s*|#\s*)?(\d+)\s*$/i);
      if (idMatch) {
        return { action: 'delete_by_id', id: Number.parseInt(idMatch[1], 10) };
      }
      return { action: 'delete_all_request' };
    }

    // Tenta adicionar despesa manual: !despesa 50 almoco ou !despesa 50,00 almoco
    let manual = parseManualExpenseCommand(stripped + ' despesa');
    if (!manual) {
      // Fallback para valor inteiro sem decimal (ex: !despesa 50 almoco)
      const intMatch = stripped.match(/^(\d+)\s*(.*)/);
      if (intMatch) {
        const amountCents = Number.parseInt(intMatch[1], 10) * 100;
        if (amountCents > 0) {
          const titleRaw = compactSpaces(intMatch[2] || '');
          const title = normalizeExpenseTitle(titleRaw, 'Despesa avulsa');
          const observation = extractObservation(stripped);
          manual = {
            title,
            amountCents,
            expenseAt: new Date().toISOString(),
            observation,
            source: 'manual'
          };
        }
      }
    }
    if (manual) {
      return { action: 'add_manual', ...manual };
    }

    return { action: 'summary' };
  }

  const deleteById = normalized.match(
    /(?:apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\s+despesas?\s+(?:id\s*|#\s*)?(\d+)\b/i
  );
  if (deleteById) {
    return {
      action: 'delete_by_id',
      id: Number.parseInt(deleteById[1], 10)
    };
  }

  if (
    /^(?:apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\b/.test(folded) &&
    mentionsExpenses
  ) {
    const period = parseExpensePeriod(normalized);
    const query = extractExpenseQuery(normalized);
    const deleteAll =
      /(?:apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\s+(?:todas\s+as\s+)?despesas?[.!?]*$/i.test(
        normalized
      ) ||
      (/^(?:apagar|apaga|remover|remove|deletar|deleta|excluir|exclui)\s+despesas?[.!?]*$/i.test(normalized) &&
        !query &&
        !period.fromIso &&
        !period.toIso);

    if (deleteAll) {
      return { action: 'delete_all_request' };
    }

    if (query || period.fromIso || period.toIso) {
      return {
        action: 'delete_filtered',
        query,
        ...period
      };
    }

    return { action: 'delete_scope_missing' };
  }

  if (/(exportar|gerar|baixar|enviar).*(despesas?|planilha de despesas)/.test(folded)) {
    const format = /\bxlsx\b|\bexcel\b/.test(folded)
      ? 'xlsx'
      : /\bcsv\b/.test(folded)
        ? 'csv'
        : 'both';
    return {
      action: 'export',
      format,
      ...parseExpensePeriod(normalized)
    };
  }

  if (
    /(adiciona|adicionar|inclui|incluir|registra|registrar|lanca|lança|lançar|cadastra|cadastrar).*(despesas?|planilha de despesas)/.test(
      folded
    )
  ) {
    const looksLikeStructuredReceipt =
      /\bvalor\s*:/.test(folded) ||
      /\bbanco origem\b/.test(folded) ||
      /\bbanco destino\b/.test(folded) ||
      /\bnome na origem\b/.test(folded) ||
      /\bnome no destino\b/.test(folded) ||
      /\bpagador\b/.test(folded) ||
      /\brecebedor\b/.test(folded);
    const shouldUseReceipt =
      /\bessa despesa\b|\besse comprovante\b|\bcomprovante\b|\bna planilha de despesas\b/.test(folded) &&
      !extractMoneyText(normalized);
    if (shouldUseReceipt || looksLikeStructuredReceipt) {
      return { action: 'add_receipt' };
    }

    let manual = parseManualExpenseCommand(normalized);
    if (!manual) {
      // Fallback para valor inteiro sem decimal (ex: adicionar despesa 50 almoco)
      const strippedForInt = normalized
        .replace(/\b(?:adiciona|adicionar|inclui|incluir|registra|registrar|lanca|lança|lançar|cadastra|cadastrar)\b/gi, ' ')
        .replace(/\b(?:na|no|a|o|em|para|de|do|da)\b\s*(?:planilha de )?despesas?\b/gi, ' ')
        .replace(/\b(?:planilha de )?despesas?\b/gi, ' ');
      const intMatch = compactSpaces(strippedForInt).match(/^(\d+)\s*(.*)/);
      if (intMatch) {
        const amountCents = Number.parseInt(intMatch[1], 10) * 100;
        if (amountCents > 0) {
          const titleRaw = compactSpaces(intMatch[2] || '');
          const title = normalizeExpenseTitle(titleRaw, 'Despesa avulsa');
          const observation = extractObservation(normalized);
          manual = {
            title,
            amountCents,
            expenseAt: new Date().toISOString(),
            observation,
            source: 'manual'
          };
        }
      }
    }
    if (manual) {
      return {
        action: 'add_manual',
        ...manual
      };
    }

    return { action: 'add_receipt' };
  }

  if (
    /^(mostrar|listar|ver|verificar|consultar|consulta).*(despesas?|planilha de despesas)/.test(folded) ||
    /^(como esta|como está|status).*(despesa)/.test(folded)
  ) {
    return {
      action: 'list',
      query: extractExpenseQuery(normalized),
      ...parseExpensePeriod(normalized)
    };
  }

  if (/^despesas?\s+/.test(folded)) {
    return {
      action: 'list',
      query: extractExpenseQuery(normalized),
      ...parseExpensePeriod(normalized)
    };
  }

  return null;
}

export async function handleExpenseCommand(command, { text = '', context = {} } = {}) {
  await botDatabase.ensureReady();
  await mediaStore.ensureReady();

  const groupId = String(context.groupId || '').trim();
  if (!groupId) {
    return {
      handled: true,
      response: 'Nao consegui identificar o grupo para trabalhar com despesas.'
    };
  }

  if (!['delete_all_request', 'delete_all_confirmed'].includes(command.action)) {
    clearPendingExpenseDeleteAllConfirmation(context);
  }

  if (command.action === 'summary' || command.action === 'list') {
    const filters = {
      groupId,
      query: compactSpaces(command.query || ''),
      fromIso: command.fromIso || '',
      toIso: command.toIso || '',
      limit: command.action === 'summary' ? 5 : 10
    };
    const [summary, list] = await Promise.all([
      botDatabase.summarizeExpenses(filters),
      botDatabase.listExpenses(filters)
    ]);

    if (!summary.totalCount) {
      return {
        handled: true,
        response:
          'Ainda nao ha despesas registradas no banco para este grupo.\n' +
          buildExpenseHelpLines().join('\n')
      };
    }

    const header = [
      `Despesas no banco (${command.label || 'todos os registros'}):`,
      `- registros: ${summary.totalCount}`,
      `- total: ${formatCurrencyFromCents(summary.totalAmountCents)}`
    ];

    if (!list.items.length) {
      return {
        handled: true,
        response: header.join('\n')
      };
    }

    const lines = list.items.map((item, index) => buildExpenseLine(item, index + 1));
    const suffix = command.action === 'summary' ? [''].concat(buildExpenseHelpLines()) : [];
    return {
      handled: true,
      response: `${header.join('\n')}\n${lines.join('\n')}${suffix.length ? `\n${suffix.join('\n')}` : ''}`
    };
  }

  if (command.action === 'delete_all_request') {
    const summary = await botDatabase.summarizeExpenses({ groupId });
    if (!summary.totalCount) {
      clearPendingExpenseDeleteAllConfirmation(context);
      return {
        handled: true,
        response: 'Nao ha despesas registradas para apagar neste grupo.'
      };
    }

    setPendingExpenseDeleteAllConfirmation(context, {
      totalCount: summary.totalCount,
      totalAmountCents: summary.totalAmountCents
    });

    return {
      handled: true,
      response:
        'Isso vai apagar todas as despesas do grupo.\n' +
        `- registros: ${summary.totalCount}\n` +
        `- total: ${formatCurrencyFromCents(summary.totalAmountCents)}\n\n` +
        'Responda `confirmo` para continuar.'
    };
  }

  if (command.action === 'delete_scope_missing') {
    clearPendingExpenseDeleteAllConfirmation(context);
    return {
      handled: true,
      response:
        'Esse pedido e destrutivo e esta ambiguo.\n\n' +
        'Preciso que voce confirme o escopo antes de apagar:\n' +
        '- todas as despesas\n' +
        '- apenas uma despesa especifica\n' +
        '- despesas de um periodo\n' +
        '- despesas de um colaborador/categoria\n\n' +
        'Se quiser apagar tudo, envie:\n' +
        '`apagar todas as despesas`\n\n' +
        'Se for parcial, envie um filtro objetivo, por exemplo:\n' +
        '- `apagar despesa id 15`\n' +
        '- `apagar despesas de Fernanda`\n' +
        '- `apagar despesas de 04/2026`'
    };
  }

  if (command.action === 'delete_all_confirmed') {
    if (command.confirmationMode === 'pending' && !getPendingExpenseDeleteAllConfirmation(context)) {
      return { handled: false };
    }

    const [summary, list] = await Promise.all([
      botDatabase.summarizeExpenses({ groupId }),
      botDatabase.listExpenses({
        groupId,
        limit: 5000
      })
    ]);

    if (!list.items.length) {
      clearPendingExpenseDeleteAllConfirmation(context);
      return {
        handled: true,
        response: 'Nao ha despesas registradas para apagar neste grupo.'
      };
    }

    const deleted = await botDatabase.deleteExpenses({ groupId });
    await refreshExpenseExportsForItems({ groupId, items: deleted.items });
    clearPendingExpenseDeleteAllConfirmation(context);

    return {
      handled: true,
      response:
        'Todas as despesas do grupo foram apagadas com sucesso.\n' +
        `- registros removidos: ${deleted.deletedCount}\n` +
        `- total removido: ${formatCurrencyFromCents(summary.totalAmountCents)}`
    };
  }

  if (command.action === 'delete_by_id') {
    const current = await botDatabase.getExpenseById(command.id, groupId);
    if (!current) {
      return {
        handled: true,
        response: `Nao encontrei a despesa ID ${command.id} neste grupo.`
      };
    }

    const deleted = await botDatabase.deleteExpenseById({
      id: command.id,
      groupId
    });
    await refreshExpenseExportsForItems({ groupId, items: deleted.item ? [deleted.item] : [] });

    return {
      handled: true,
      response:
        'Despesa removida com sucesso.\n' +
        `${buildExpenseLine(current, 1)}`
    };
  }

  if (command.action === 'delete_filtered') {
    const filters = {
      groupId,
      query: compactSpaces(command.query || ''),
      fromIso: command.fromIso || '',
      toIso: command.toIso || ''
    };

    const [summary, list] = await Promise.all([
      botDatabase.summarizeExpenses(filters),
      botDatabase.listExpenses({
        ...filters,
        limit: 5000
      })
    ]);

    if (!list.items.length) {
      return {
        handled: true,
        response: 'Nao encontrei despesas para apagar com esse filtro.'
      };
    }

    const deleted = await botDatabase.deleteExpenses(filters);
    await refreshExpenseExportsForItems({
      groupId,
      items: deleted.items,
      ranges: command.fromIso || command.toIso ? [{ fromIso: command.fromIso, toIso: command.toIso }] : []
    });

    const previewLines = deleted.items.slice(0, 3).map((item, index) => buildExpenseLine(item, index + 1));
    const moreCount = Math.max(0, deleted.deletedCount - previewLines.length);
    const scopeLabel = [command.label && command.label !== 'todos os registros' ? command.label : '', filters.query]
      .filter(Boolean)
      .join(' | ');

    return {
      handled: true,
      response:
        `Despesas removidas com sucesso${scopeLabel ? ` (${scopeLabel})` : ''}.\n` +
        `- registros removidos: ${deleted.deletedCount}\n` +
        `- total removido: ${formatCurrencyFromCents(summary.totalAmountCents)}` +
        (previewLines.length ? `\n${previewLines.join('\n')}` : '') +
        (moreCount > 0 ? `\n... e mais ${moreCount} registro(s).` : '')
    };
  }

  if (command.action === 'add_manual') {
    const recentDuplicate = await botDatabase.findRecentSimilarExpense({
      groupId,
      title: command.title,
      amountCents: command.amountCents,
      observation: command.observation || '',
      senderNumber: context.senderNumber || '',
      withinMinutes: 5
    });

    if (recentDuplicate) {
      return {
        handled: true,
        response:
          'Despesa ja registrada recentemente no banco.\n' +
          `${buildExpenseLine(recentDuplicate, 1)}`
      };
    }

    const created = await botDatabase.addExpense({
      groupId,
      title: command.title,
      amountCents: command.amountCents,
      expenseAt: command.expenseAt,
      source: 'manual',
      observation: command.observation || '',
      senderNumber: context.senderNumber || '',
      status: 'persistido'
    });

    const exportResult = await refreshExpenseExports({
      groupId,
      dateInput: created.item?.expenseAt || command.expenseAt,
      ...buildMonthRange(new Date(created.item?.expenseAt || command.expenseAt || Date.now()))
    });

    return {
      handled: true,
      response:
        `${created.duplicate ? 'Despesa ja existia no banco.' : 'Despesa registrada com sucesso.'}\n` +
        `ID: ${created.item?.id || '-'}\n` +
        `Nome: ${created.item?.title || command.title}\n` +
        `Valor: ${formatCurrencyFromCents(created.item?.amountCents || command.amountCents)}\n` +
        `Data: ${formatDateTime(created.item?.expenseAt || command.expenseAt)}\n` +
        `Status: ${created.item?.statusLabel || 'persistido'}\n` +
        `Exportacao atualizada: ${exportResult.label}`
    };
  }

  if (command.action === 'add_receipt') {
    const receipt = await resolveReceiptExpenseInput(text, context);
    if (!receipt || !receipt.amountCents) {
      return {
        handled: true,
        response:
          'Nao consegui extrair a despesa do comprovante agora.\n' +
          'Envie ou cite a imagem do comprovante, ou informe manualmente: adicionar 100,00 na despesa IPTV'
      };
    }

    const created = await botDatabase.addExpense({
      groupId,
      title: receipt.title,
      amountCents: receipt.amountCents,
      expenseAt: receipt.expenseAt || new Date().toISOString(),
      source: 'ocr',
      observation: receipt.observation || '',
      senderNumber: context.senderNumber || '',
      status: 'persistido',
      payerName: receipt.payerName || '',
      payeeName: receipt.payeeName || '',
      originBank: receipt.originBank || '',
      destinationBank: receipt.destinationBank || '',
      extraJson: JSON.stringify({
        rawText: receipt.rawText || ''
      }),
      dedupeKey: receipt.dedupeKey || ''
    });

    const expenseAt = created.item?.expenseAt || receipt.expenseAt || new Date().toISOString();
    const exportResult = await refreshExpenseExports({
      groupId,
      dateInput: expenseAt,
      ...buildMonthRange(new Date(expenseAt))
    });

    const bankLine =
      created.item?.originBank || created.item?.destinationBank
        ? `\nBancos: ${[created.item?.originBank, created.item?.destinationBank].filter(Boolean).join(' -> ')}`
        : '';

    return {
      handled: true,
      response:
        `${created.duplicate ? 'Despesa ja registrada anteriormente.' : 'Despesa registrada com sucesso.'}\n` +
        `ID: ${created.item?.id || '-'}\n` +
        `Nome: ${created.item?.title || receipt.title}\n` +
        `Valor: ${formatCurrencyFromCents(created.item?.amountCents || receipt.amountCents)}\n` +
        `Data: ${formatDateTime(created.item?.expenseAt || expenseAt)}\n` +
        `Origem do registro: OCR\n` +
        `Status: ${created.item?.statusLabel || 'persistido'}` +
        bankLine +
        `\nExportacao atualizada: ${exportResult.label}`
    };
  }

  if (command.action === 'export') {
    const filters = {
      groupId,
      fromIso: command.fromIso || buildMonthRange(new Date()).fromIso,
      toIso: command.toIso || buildMonthRange(new Date()).toIso,
      limit: 500
    };
    const list = await botDatabase.listExpenses(filters);
    if (!list.items.length) {
      return {
        handled: true,
        response: 'Nao ha despesas para exportar no periodo solicitado.'
      };
    }

    let files = null;
    try {
      files = await refreshExpenseExports({
        groupId,
        dateInput: list.items[0]?.expenseAt || new Date().toISOString(),
        fromIso: filters.fromIso,
        toIso: filters.toIso
      });
    } catch (error) {
      logger.error('Falha ao exportar despesas', {
        error: error instanceof Error ? error.message : String(error),
        groupId
      });
      return {
        handled: true,
        response: `Falha ao exportar despesas: ${error instanceof Error ? error.message : String(error)}`
      };
    }

    const mediaItems = [];
    if (command.format === 'csv' || command.format === 'both') {
      mediaItems.push({
        path: files.csvPath,
        caption: `CSV de despesas (${files.label})`
      });
    }
    if (command.format === 'xlsx' || command.format === 'both') {
      mediaItems.push({
        path: files.xlsxPath,
        caption: `Excel de despesas (${files.label})`
      });
    }

    return {
      handled: true,
      response: `Exportacao pronta com ${list.items.length} despesa(s) do periodo ${
        command.label && command.label !== 'todos os registros' ? command.label : files.label
      }.`,
      mediaItems
    };
  }

  return null;
}
