import { appendFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';

const SEARCH_STOP_WORDS = new Set([
  'a',
  'ao',
  'aos',
  'as',
  'com',
  'como',
  'da',
  'das',
  'de',
  'delas',
  'dele',
  'deles',
  'do',
  'dos',
  'e',
  'ela',
  'elas',
  'ele',
  'eles',
  'em',
  'esse',
  'essa',
  'essas',
  'esses',
  'esta',
  'estao',
  'está',
  'estão',
  'este',
  'estes',
  'eu',
  'foi',
  'ha',
  'isso',
  'isto',
  'ja',
  'já',
  'la',
  'lá',
  'mais',
  'media',
  'média',
  'me',
  'meu',
  'minha',
  'na',
  'nas',
  'nao',
  'não',
  'no',
  'nos',
  'o',
  'os',
  'ou',
  'pagamento',
  'pagamentos',
  'para',
  'pela',
  'pelas',
  'pelo',
  'pelos',
  'por',
  'porfavor',
  'porfavor.',
  'pra',
  'qual',
  'quais',
  'que',
  'resumo',
  'se',
  'sem',
  'seu',
  'sua',
  'suas',
  'te',
  'tem',
  'um',
  'uma',
  'voce',
  'voces',
  'você',
  'vocês'
]);

function sanitizeGroupId(groupId) {
  return String(groupId || 'grupo-desconhecido').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildConversationFilePath(groupId, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return join(config.conversationsDir, sanitizeGroupId(groupId), `${day}.jsonl`);
}

function clampText(text, maxChars = 8000) {
  const normalized = String(text || '').replace(/\u0000/g, '').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function compactSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function foldSearchText(text) {
  return compactSpaces(text)
    .toLowerCase()
    .replace(/\bpagto\b/g, 'pagamento')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function tokenizeSearchText(text) {
  const matches = foldSearchText(text).match(/[a-z0-9][a-z0-9._/-]{1,}/g) || [];
  return Array.from(
    new Set(
      matches.filter((token) => {
        if (SEARCH_STOP_WORDS.has(token)) return false;
        if (/^\d+$/.test(token)) return false;
        return true;
      })
    )
  );
}

function cleanupReferenceText(text) {
  return String(text || '')
    .replace(/^\s*Executando no servidor\s*:[^\n]*\n*/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isReferenceNoise(text) {
  const folded = foldSearchText(text);
  if (!folded) return true;

  const thinkingFolded = foldSearchText(config.thinkingMessageText || 'Pesquisando...');

  return (
    folded === thinkingFolded ||
    /^full\s*#/.test(folded) ||
    /^ainda nao ha evidencia suficiente/.test(folded) ||
    /^nao consegui concluir essa solicitacao agora/.test(folded) ||
    /^nao ha solicitacao full/.test(folded) ||
    /^servico de volta/.test(folded) ||
    /^processo online/.test(folded) ||
    /^pesquisando$/.test(folded)
  );
}

function isMediaPlaceholderText(text) {
  return /^\s*\[midia recebida\]\s+/i.test(String(text || '').trim());
}

function parseJsonl(content) {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function readConversationEntries(groupId, { limit = 10, maxFiles = 5 } = {}) {
  if (!groupId) return [];

  const groupDir = join(config.conversationsDir, sanitizeGroupId(groupId));

  let files = [];
  try {
    files = (await readdir(groupDir))
      .filter((file) => file.endsWith('.jsonl'))
      .sort();
  } catch {
    return [];
  }

  const recentFiles = files.slice(-Math.max(1, maxFiles));
  const entries = [];

  for (const file of recentFiles) {
    try {
      const content = await readFile(join(groupDir, file), 'utf8');
      entries.push(...parseJsonl(content));
    } catch {
      // Mantem resiliencia em caso de arquivo com falha.
    }
  }

  return entries.slice(-Math.max(1, limit));
}

function scoreConversationEntry(entry, queryTokens, queryFolded, index, totalEntries) {
  const rawText = cleanupReferenceText(entry?.text || '');
  const foldedText = foldSearchText(rawText);
  if (!foldedText || isReferenceNoise(rawText)) return 0;

  let score = 0;
  let overlapCount = 0;

  for (const token of queryTokens) {
    if (foldedText.includes(token)) {
      overlapCount += 1;
      score += 4;
    }
  }

  if (queryFolded && queryFolded.length >= 10 && foldedText.includes(queryFolded)) {
    score += 8;
  }

  if (queryTokens.length >= 2) {
    for (let offset = 0; offset < queryTokens.length - 1; offset += 1) {
      const pair = `${queryTokens[offset]} ${queryTokens[offset + 1]}`;
      if (pair.length >= 8 && foldedText.includes(pair)) {
        score += 2;
      }
    }
  }

  if (overlapCount > 0 && String(entry?.direction || '') === 'outbound') {
    score += 2;
  }

  if (overlapCount > 0 && /(?:r\$|\d)/i.test(rawText)) {
    score += 1;
  }

  score += (index + 1) / Math.max(1, totalEntries);
  return score;
}

function looksContextDependent(text) {
  const folded = foldSearchText(text);
  if (!folded) return false;

  return (
    /^e\b/.test(folded) ||
    /^(em resumo|resumindo|qual e|qual eh|qual seria|quanto fica|media|média)\b/.test(folded) ||
    /\b(disso|dessas|desses|desse|dessa|nisso|nela|nele|sobre isso)\b/.test(folded)
  );
}

function collectReferenceSeedIndexes(entries, queryText, options = {}) {
  const queryFolded = foldSearchText(queryText);
  const queryTokens = tokenizeSearchText(queryText);
  const senderNumber = String(options.senderNumber || '').trim();
  const currentFolded = foldSearchText(options.excludeText || queryText);
  let skippedCurrentEntry = false;
  const scored = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const entryTextFolded = foldSearchText(entry?.text || '');
    const entrySender = String(entry?.senderNumber || '').trim();

    if (
      !skippedCurrentEntry &&
      currentFolded &&
      String(entry?.direction || '') === 'inbound' &&
      entryTextFolded === currentFolded &&
      (!senderNumber || !entrySender || entrySender === senderNumber)
    ) {
      skippedCurrentEntry = true;
      continue;
    }

    const score = scoreConversationEntry(entry, queryTokens, queryFolded, index, entries.length);
    if (score <= 0) continue;

    scored.push({
      index,
      score,
      direction: String(entry?.direction || ''),
      normalizedText: cleanupReferenceText(entry?.text || '')
    });
  }

  scored.sort((left, right) => right.score - left.score || right.index - left.index);

  const selected = [];
  const seenTexts = new Set();

  for (const item of scored) {
    const dedupeKey = foldSearchText(item.normalizedText).slice(0, 240);
    if (dedupeKey && seenTexts.has(dedupeKey)) continue;

    seenTexts.add(dedupeKey);
    selected.push(item.index);

    if (selected.length >= 4) break;
  }

  if (selected.length) {
    return selected;
  }

  if (!looksContextDependent(queryText)) {
    return [];
  }

  const fallback = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const cleanedText = cleanupReferenceText(entry?.text || '');
    if (!cleanedText || isReferenceNoise(cleanedText)) continue;
    fallback.push(index);
    if (fallback.length >= 3) break;
  }

  return fallback;
}

function expandReferenceIndexes(entries, seedIndexes = []) {
  function findNeighborEntry(startIndex, direction) {
    for (let distance = 1; distance <= 2; distance += 1) {
      const candidateIndex = startIndex + distance * direction;
      const candidate = entries[candidateIndex];
      if (!candidate) continue;

      if (String(candidate.direction || '') !== (direction < 0 ? 'inbound' : 'outbound')) {
        continue;
      }

      const text = String(candidate.text || '');
      if (!text || isReferenceNoise(text) || isMediaPlaceholderText(text)) {
        continue;
      }

      return candidateIndex;
    }

    return -1;
  }

  const indexes = new Set();

  for (const index of seedIndexes) {
    const entry = entries[index];
    if (!entry) continue;

    indexes.add(index);

    if (String(entry.direction || '') === 'outbound') {
      const previousIndex = findNeighborEntry(index, -1);
      if (previousIndex >= 0) {
        indexes.add(previousIndex);
      }
    } else if (String(entry.direction || '') === 'inbound') {
      const nextIndex = findNeighborEntry(index, 1);
      if (nextIndex >= 0) {
        indexes.add(nextIndex);
      }
    }
  }

  return Array.from(indexes).sort((left, right) => left - right);
}

function formatReferenceBlock(entry, maxCharsPerEntry = 1200) {
  if (isMediaPlaceholderText(entry?.text || '')) return '';
  const side = String(entry?.direction || '') === 'outbound' ? 'bot' : 'usuario';
  const ts = String(entry?.ts || '').slice(11, 19) || '--:--:--';
  const text = clampText(cleanupReferenceText(entry?.text || ''), maxCharsPerEntry);
  if (!text) return '';
  return `[${ts}] ${side}\n${text}`;
}

export async function appendConversationEntry({
  groupId,
  direction,
  text,
  senderJid = null,
  senderNumber = null,
  mentionedIds = [],
  quotedMessageId = null,
  quotedSenderJid = null
}) {
  if (!config.saveConversations) return;

  const normalizedText = clampText(text);
  if (!groupId || !normalizedText) return;

  const filePath = buildConversationFilePath(groupId);
  await mkdir(dirname(filePath), { recursive: true });

  const payload = {
    ts: new Date().toISOString(),
    groupId: String(groupId),
    direction: direction || 'unknown',
    senderJid,
    senderNumber,
    text: normalizedText,
    mentionedIds: Array.isArray(mentionedIds) ? mentionedIds.filter(Boolean).slice(0, 20) : [],
    quotedMessageId: quotedMessageId || null,
    quotedSenderJid: quotedSenderJid || null
  };

  await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function listRecentConversationEntries(groupId, limit = 10) {
  return readConversationEntries(groupId, { limit, maxFiles: 5 });
}

export async function buildConversationReferenceText(groupId, queryText, options = {}) {
  const normalizedQuery = String(queryText || '').trim();
  if (!groupId || !normalizedQuery) return '';

  const entries = await readConversationEntries(groupId, {
    limit: Math.max(20, Math.min(Number.parseInt(String(options.searchLimit || 80), 10) || 80, 200)),
    maxFiles: Math.max(2, Math.min(Number.parseInt(String(options.maxFiles || 7), 10) || 7, 14))
  });
  if (!entries.length) return '';

  const seedIndexes = collectReferenceSeedIndexes(entries, normalizedQuery, options);
  if (!seedIndexes.length) return '';

  const maxTotalChars = Math.max(600, Math.min(Number.parseInt(String(options.maxTotalChars || 3600), 10) || 3600, 12000));
  const maxCharsPerEntry = Math.max(
    180,
    Math.min(Number.parseInt(String(options.maxCharsPerEntry || 1200), 10) || 1200, 4000)
  );
  const expandedIndexes = expandReferenceIndexes(entries, seedIndexes);
  const blocks = [];
  let totalChars = 0;

  for (const index of expandedIndexes) {
    const block = formatReferenceBlock(entries[index], maxCharsPerEntry);
    if (!block) continue;

    const projectedTotal = totalChars + block.length + (blocks.length ? 2 : 0);
    if (projectedTotal > maxTotalChars && blocks.length) {
      break;
    }

    blocks.push(block);
    totalChars = projectedTotal;
  }

  return blocks.join('\n\n');
}

export function getConversationGroupDir(groupId) {
  return join(config.conversationsDir, sanitizeGroupId(groupId));
}

export async function clearConversationGroupHistory(groupId) {
  if (!groupId) return 0;
  const groupDir = getConversationGroupDir(groupId);

  let files = [];
  try {
    files = await readdir(groupDir);
  } catch {
    return 0;
  }

  const targets = files.filter((file) => file.endsWith('.jsonl'));
  let removed = 0;

  for (const file of targets) {
    try {
      await rm(join(groupDir, file), { force: true });
      removed += 1;
    } catch {
      // ignora falhas isoladas e continua.
    }
  }

  return removed;
}
