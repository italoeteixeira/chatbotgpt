import { readFile, stat } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { mediaStore } from './mediaStore.js';

const PDF_ANALYSIS_CACHE = new Map();
const PDF_ANALYSIS_CACHE_LIMIT = 12;
const LINE_Y_TOLERANCE = 1.6;

function normalizeText(value) {
  return String(value || '').trim();
}

function foldText(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function compactSpaces(value) {
  return normalizeText(value)
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(value, maxChars) {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function extractMessageId(message) {
  return String(message?.id?._serialized || '').trim();
}

function parseMediaIdFromAnyText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return '';

  const tagged = normalized.match(/MIDIA_ID\s*[:=#-]?\s*([a-f0-9-]{8,})/i);
  if (tagged) return String(tagged[1] || '').trim();

  const generic = normalized.match(/(?:id|midia|m[ií]dia)\s*[:=#-]?\s*([a-f0-9-]{8,})/i);
  if (generic) return String(generic[1] || '').trim();

  return '';
}

function messageHasPdfMedia(message) {
  if (!message?.hasMedia) return false;

  const mimeType = String(message?._data?.mimetype || message?.mimetype || '')
    .trim()
    .toLowerCase();
  if (mimeType.includes('pdf')) return true;

  const fileName = String(message?._data?.filename || message?.filename || '')
    .trim()
    .toLowerCase();
  return fileName.endsWith('.pdf');
}

export function messageHasTxtMedia(message) {
  if (!message?.hasMedia) return false;

  const mimeType = String(message?._data?.mimetype || message?.mimetype || '')
    .trim()
    .toLowerCase();
  if (mimeType === 'text/plain') return true;

  const fileName = String(message?._data?.filename || message?.filename || '')
    .trim()
    .toLowerCase();
  return fileName.endsWith('.txt');
}

function entryLooksLikePdf(item) {
  if (!item || item.deletedAt || item.mediaType !== 'document') return false;

  const mimeType = String(item.mimeType || '')
    .trim()
    .toLowerCase();
  if (mimeType.includes('pdf')) return true;

  const fileName = String(item.fileName || '')
    .trim()
    .toLowerCase();
  return fileName.endsWith('.pdf');
}

export function entryLooksLikeTxt(item) {
  if (!item || item.deletedAt) return false;
  if (item.mediaType !== 'text' && item.mediaType !== 'document') return false;

  const mimeType = String(item.mimeType || '').trim().toLowerCase();
  if (mimeType === 'text/plain') return true;

  const fileName = String(item.fileName || '').trim().toLowerCase();
  return fileName.endsWith('.txt');
}

export function textLooksLikeDocumentReference(text) {
  const folded = foldText(text);
  if (!folded) return false;

  const hasDocumentNoun = /\b(pdf|txt|documento|arquivo|anexo|extrato|comprovante|relatorio)\b/.test(folded);
  const hasReference =
    /\b(esse|essa|este|esta|anexado|anexada|acima|abaixo|ultimo|ultima|citado|citada|referencia|referencia)\b/.test(
      folded
    ) || /\b(meu|minha)\b/.test(folded);
  const hasAnalysisVerb =
    /\b(analis|ler|leia|resum|extrai|mostr|separ|classific|moviment|lancament|principal|recorrent|execut|configur|instalar|rodar|subi)\b/.test(folded);

  if (hasDocumentNoun && (hasReference || hasAnalysisVerb)) return true;
  if (/\bextrato\b.*\bbanc/i.test(folded)) return true;
  if (/\b(txt|arquivo)\b/.test(folded) && hasAnalysisVerb) return true;
  return /\bmovimentacoes?\b.*\brepetidas?\b/.test(folded);
}

function textLooksLikeBankStatementRequest(text) {
  const folded = foldText(text);
  if (!folded) return false;
  return /\bextrato\b/.test(folded) || /\blancament/.test(folded) || /\bmovimenta/.test(folded) || /\bbanc/.test(folded);
}

function parseBrlAmount(value) {
  const normalized = normalizeText(value).replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatBrlAmount(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL'
  }).format(Number.isFinite(value) ? value : 0);
}

function formatSignedBrlAmount(value) {
  const amount = Number.isFinite(value) ? value : 0;
  if (amount < 0) return `-${formatBrlAmount(Math.abs(amount))}`;
  return formatBrlAmount(amount);
}

function cleanTransactionLabel(label) {
  return compactSpaces(
    String(label || '')
      .replace(/([A-Za-z])\d{2}\/\d{2}\b/g, '$1')
      .replace(/\b\d{2}\/\d{2}\b/g, '')
      .replace(/\s+/g, ' ')
  );
}

function normalizeRecurringKey(label) {
  return cleanTransactionLabel(label)
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pushPdfCache(key, value) {
  if (!key) return;
  if (PDF_ANALYSIS_CACHE.has(key)) {
    PDF_ANALYSIS_CACHE.delete(key);
  }

  PDF_ANALYSIS_CACHE.set(key, value);

  while (PDF_ANALYSIS_CACHE.size > PDF_ANALYSIS_CACHE_LIMIT) {
    const oldestKey = PDF_ANALYSIS_CACHE.keys().next().value;
    if (!oldestKey) break;
    PDF_ANALYSIS_CACHE.delete(oldestKey);
  }
}

function createPdfStore(source) {
  const objects = new Map();
  const positions = [];
  const regex = /(\d+)\s+\d+\s+obj\b/g;
  let match;

  while ((match = regex.exec(source))) {
    positions.push({
      objectId: Number.parseInt(match[1], 10),
      start: match.index
    });
  }

  for (const entry of positions) {
    const end = source.indexOf('endobj', entry.start);
    if (end < 0) continue;

    objects.set(entry.objectId, {
      objectId: entry.objectId,
      start: entry.start,
      end: end + 6,
      body: source.slice(entry.start, end + 6)
    });
  }

  return {
    source,
    objects,
    cmapCache: new Map(),
    fontCache: new Map()
  };
}

function getPdfObjectBody(store, objectId) {
  return store.objects.get(objectId)?.body || '';
}

function getPdfObjectStream(store, objectId) {
  const body = getPdfObjectBody(store, objectId);
  if (!body) return Buffer.alloc(0);

  const streamIndex = body.indexOf('stream');
  if (streamIndex < 0) return Buffer.alloc(0);

  let streamBody = body.slice(streamIndex + 6);
  if (streamBody.startsWith('\r\n')) {
    streamBody = streamBody.slice(2);
  } else if (streamBody.startsWith('\n')) {
    streamBody = streamBody.slice(1);
  }

  const endStreamIndex = streamBody.indexOf('endstream');
  if (endStreamIndex < 0) return Buffer.alloc(0);

  streamBody = streamBody.slice(0, endStreamIndex);
  let streamBuffer = Buffer.from(streamBody, 'latin1');

  if (/\/FlateDecode\b/.test(body)) {
    try {
      streamBuffer = inflateSync(streamBuffer);
    } catch {
      return Buffer.alloc(0);
    }
  }

  return streamBuffer;
}

function listPdfPages(store) {
  const ordered = [...store.objects.values()].sort((left, right) => left.start - right.start);
  const pages = [];

  for (const entry of ordered) {
    const body = entry.body;
    if (!/\/Type\s*\/Page\b/.test(body) || /\/Type\s*\/Pages\b/.test(body)) {
      continue;
    }

    const contentsMatch = body.match(/\/Contents\s+(\[(?:[\s\S]*?)\]|\d+\s+\d+\s+R)/);
    if (!contentsMatch) continue;

    const contentObjectIds = [...contentsMatch[1].matchAll(/(\d+)\s+0\s+R/g)]
      .map((matchItem) => Number.parseInt(matchItem[1], 10))
      .filter(Number.isFinite);

    if (!contentObjectIds.length) continue;

    const resourceMatch = body.match(/\/Resources\s+(\d+)\s+0\s+R/);

    pages.push({
      pageNumber: pages.length + 1,
      pageObjectId: entry.objectId,
      resourceObjectId: resourceMatch ? Number.parseInt(resourceMatch[1], 10) : null,
      contentObjectIds
    });
  }

  return pages;
}

function decodeUnicodeHex(hex) {
  const normalized = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (!normalized) return '';

  const units = [];
  const chunkSize = normalized.length % 4 === 0 ? 4 : 2;

  for (let index = 0; index < normalized.length; index += chunkSize) {
    const piece = normalized.slice(index, index + chunkSize);
    if (piece.length !== chunkSize) continue;
    const codePoint = Number.parseInt(piece, 16);
    if (!Number.isFinite(codePoint)) continue;
    units.push(codePoint);
  }

  let output = '';
  for (const codePoint of units) {
    try {
      output += String.fromCodePoint(codePoint);
    } catch {
      // ignora codepoint invalido.
    }
  }
  return output;
}

function parsePdfToUnicodeMap(store, objectId) {
  if (!objectId) return new Map();
  if (store.cmapCache.has(objectId)) {
    return store.cmapCache.get(objectId);
  }

  const content = getPdfObjectStream(store, objectId).toString('latin1');
  const map = new Map();

  const rangeRegex = /beginbfrange([\s\S]*?)endbfrange/g;
  let match;
  while ((match = rangeRegex.exec(content))) {
    const lines = match[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const arrayMatch = line.match(/^<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+\[(.+)\]$/);
      if (arrayMatch) {
        const startCode = Number.parseInt(arrayMatch[1], 16);
        const hexItems = [...arrayMatch[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((item) => item[1]);

        for (let index = 0; index < hexItems.length; index += 1) {
          map.set(startCode + index, decodeUnicodeHex(hexItems[index]));
        }
        continue;
      }

      const simpleMatch = line.match(/^<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>$/);
      if (!simpleMatch) continue;

      const startCode = Number.parseInt(simpleMatch[1], 16);
      const endCode = Number.parseInt(simpleMatch[2], 16);
      let currentOutput = Number.parseInt(simpleMatch[3], 16);

      for (let code = startCode; code <= endCode; code += 1) {
        map.set(code, decodeUnicodeHex(currentOutput.toString(16).padStart(4, '0')));
        currentOutput += 1;
      }
    }
  }

  const charRegex = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((match = charRegex.exec(content))) {
    const lines = match[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const charMatch = line.match(/^<([0-9A-Fa-f]+)>\s+<([0-9A-Fa-f]+)>$/);
      if (!charMatch) continue;
      map.set(Number.parseInt(charMatch[1], 16), decodeUnicodeHex(charMatch[2]));
    }
  }

  store.cmapCache.set(objectId, map);
  return map;
}

function resolveFontRefs(store, resourceObjectId) {
  if (!resourceObjectId) return new Map();
  if (store.fontCache.has(resourceObjectId)) {
    return store.fontCache.get(resourceObjectId);
  }

  const resourceBody = getPdfObjectBody(store, resourceObjectId);
  const refs = new Map();
  if (!resourceBody) {
    store.fontCache.set(resourceObjectId, refs);
    return refs;
  }

  let fontBody = '';
  const indirectMatch = resourceBody.match(/\/Font\s+(\d+)\s+0\s+R/);
  if (indirectMatch) {
    fontBody = getPdfObjectBody(store, Number.parseInt(indirectMatch[1], 10));
  } else {
    const inlineMatch = resourceBody.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (inlineMatch) {
      fontBody = inlineMatch[1];
    }
  }

  const regex = /\/([A-Za-z0-9]+)\s+(\d+)\s+0\s+R/g;
  let match;
  while ((match = regex.exec(fontBody))) {
    refs.set(`/${match[1]}`, Number.parseInt(match[2], 10));
  }

  store.fontCache.set(resourceObjectId, refs);
  return refs;
}

function resolveFontCmap(store, fontObjectId) {
  const body = getPdfObjectBody(store, fontObjectId);
  if (!body) return new Map();

  const match = body.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
  if (!match) return new Map();
  return parsePdfToUnicodeMap(store, Number.parseInt(match[1], 10));
}

function decodeUtf16Be(bytes) {
  if (!bytes?.length || bytes.length % 2 !== 0) return '';

  let output = '';
  for (let index = 0; index < bytes.length; index += 2) {
    const codePoint = (bytes[index] << 8) | (bytes[index + 1] || 0);
    if (!codePoint) continue;
    try {
      output += String.fromCodePoint(codePoint);
    } catch {
      // ignora codepoint invalido.
    }
  }

  return output.normalize('NFC');
}

function decodePdfString(bytes, cmap) {
  if (!bytes?.length) return '';

  if (cmap?.size) {
    let output = '';
    for (let index = 0; index < bytes.length; index += 2) {
      const code = (bytes[index] << 8) | (bytes[index + 1] || 0);
      output += cmap.get(code) || '';
    }

    const normalized = compactSpaces(output.normalize('NFC'));
    if (normalized) return normalized;
  }

  const utf16 = compactSpaces(decodeUtf16Be(bytes));
  if (utf16) return utf16;

  return compactSpaces(Buffer.from(bytes).toString('latin1').replace(/[^\x20-\x7E]+/g, ' '));
}

function parseLiteralPdfString(text, startIndex) {
  let index = startIndex + 1;
  let depth = 1;
  const bytes = [];

  while (index < text.length) {
    const charCode = text.charCodeAt(index);

    if (charCode === 0x5c) {
      const nextCode = text.charCodeAt(index + 1);
      if (nextCode === 0x28 || nextCode === 0x29 || nextCode === 0x5c) {
        bytes.push(nextCode);
        index += 2;
        continue;
      }

      if (nextCode >= 0x30 && nextCode <= 0x37) {
        let octal = String.fromCharCode(nextCode);
        let cursor = index + 2;
        while (cursor < index + 4) {
          const octCode = text.charCodeAt(cursor);
          if (octCode < 0x30 || octCode > 0x37) break;
          octal += String.fromCharCode(octCode);
          cursor += 1;
        }
        bytes.push(Number.parseInt(octal, 8));
        index = cursor;
        continue;
      }

      if (nextCode === 0x6e) {
        bytes.push(0x0a);
        index += 2;
        continue;
      }
      if (nextCode === 0x72) {
        bytes.push(0x0d);
        index += 2;
        continue;
      }
      if (nextCode === 0x74) {
        bytes.push(0x09);
        index += 2;
        continue;
      }
      if (nextCode === 0x62) {
        bytes.push(0x08);
        index += 2;
        continue;
      }
      if (nextCode === 0x66) {
        bytes.push(0x0c);
        index += 2;
        continue;
      }
      if (nextCode === 0x0d && text.charCodeAt(index + 2) === 0x0a) {
        index += 3;
        continue;
      }
      if (nextCode === 0x0d || nextCode === 0x0a) {
        index += 2;
        continue;
      }

      bytes.push(nextCode);
      index += 2;
      continue;
    }

    if (charCode === 0x28) {
      depth += 1;
      bytes.push(charCode);
      index += 1;
      continue;
    }

    if (charCode === 0x29) {
      depth -= 1;
      if (depth === 0) {
        return {
          end: index + 1,
          bytes: Buffer.from(bytes)
        };
      }
      bytes.push(charCode);
      index += 1;
      continue;
    }

    bytes.push(charCode);
    index += 1;
  }

  return {
    end: index,
    bytes: Buffer.from(bytes)
  };
}

function parseHexPdfString(text, startIndex) {
  let index = startIndex + 1;
  let hex = '';

  while (index < text.length && text.charCodeAt(index) !== 0x3e) {
    const char = text.charAt(index);
    if (/^[0-9A-Fa-f]$/.test(char)) {
      hex += char;
    }
    index += 1;
  }

  if (hex.length % 2 === 1) {
    hex += '0';
  }

  return {
    end: index + 1,
    bytes: Buffer.from(hex, 'hex')
  };
}

function tokenizePdfContent(buffer) {
  const text = buffer.toString('latin1');
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const charCode = text.charCodeAt(index);

    if (charCode <= 0x20) {
      index += 1;
      continue;
    }

    if (charCode === 0x25) {
      while (index < text.length) {
        const currentCode = text.charCodeAt(index);
        if (currentCode === 0x0a || currentCode === 0x0d) break;
        index += 1;
      }
      continue;
    }

    if (charCode === 0x28) {
      const parsed = parseLiteralPdfString(text, index);
      tokens.push({ type: 'string', bytes: parsed.bytes });
      index = parsed.end;
      continue;
    }

    if (charCode === 0x3c) {
      const nextCode = text.charCodeAt(index + 1);
      if (nextCode === 0x3c) {
        tokens.push({ type: 'op', value: '<<' });
        index += 2;
        continue;
      }

      const parsed = parseHexPdfString(text, index);
      tokens.push({ type: 'string', bytes: parsed.bytes });
      index = parsed.end;
      continue;
    }

    if (charCode === 0x3e && text.charCodeAt(index + 1) === 0x3e) {
      tokens.push({ type: 'op', value: '>>' });
      index += 2;
      continue;
    }

    if (charCode === 0x5b || charCode === 0x5d) {
      tokens.push({ type: 'op', value: text.charAt(index) });
      index += 1;
      continue;
    }

    if (charCode === 0x2f) {
      let cursor = index + 1;
      while (cursor < text.length) {
        const currentCode = text.charCodeAt(cursor);
        if (currentCode <= 0x20 || '[]<>()/%'.includes(text.charAt(cursor))) {
          break;
        }
        cursor += 1;
      }

      tokens.push({
        type: 'name',
        value: text.slice(index, cursor)
      });
      index = cursor;
      continue;
    }

    let cursor = index;
    while (cursor < text.length) {
      const currentCode = text.charCodeAt(cursor);
      if (currentCode <= 0x20 || '[]<>()/%'.includes(text.charAt(cursor))) {
        break;
      }
      cursor += 1;
    }

    const raw = text.slice(index, cursor);
    if (/^[+-]?\d*\.?\d+$/.test(raw)) {
      tokens.push({
        type: 'number',
        value: Number.parseFloat(raw)
      });
    } else {
      tokens.push({
        type: 'op',
        value: raw
      });
    }

    index = cursor;
  }

  return tokens;
}

function collectArrayStringTokens(tokens, operatorIndex) {
  const strings = [];
  let depth = 0;

  for (let index = operatorIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];

    if (token.type === 'op' && token.value === ']') {
      depth += 1;
      continue;
    }

    if (token.type === 'op' && token.value === '[') {
      if (depth === 1) break;
      depth -= 1;
      continue;
    }

    if (depth >= 1 && token.type === 'string') {
      strings.push(token);
    }
  }

  return strings.reverse();
}

function estimateTextWidth(text, fontSize) {
  const size = Number.isFinite(fontSize) ? fontSize : 10;
  return Math.max(6, String(text || '').length * Math.max(3.5, size * 0.48));
}

function extractTextItemsFromTokens(tokens, fontMaps) {
  let currentFontName = '';
  let currentFontSize = 12;
  let currentX = 0;
  let currentY = 0;
  let textLeading = 0;
  const items = [];

  const pushTextItem = (bytes) => {
    const decoded = decodePdfString(bytes, fontMaps.get(currentFontName) || new Map());
    if (!decoded) return;
    items.push({
      x: currentX,
      y: currentY,
      fontSize: currentFontSize,
      text: decoded
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'op') continue;

    if (token.value === 'Tf') {
      const fontToken = tokens[index - 2];
      const sizeToken = tokens[index - 1];
      if (fontToken?.type === 'name') {
        currentFontName = fontToken.value;
      }
      if (sizeToken?.type === 'number' && Number.isFinite(sizeToken.value)) {
        currentFontSize = sizeToken.value;
      }
      continue;
    }

    if (token.value === 'TL') {
      const leadingToken = tokens[index - 1];
      if (leadingToken?.type === 'number' && Number.isFinite(leadingToken.value)) {
        textLeading = leadingToken.value;
      }
      continue;
    }

    if (token.value === 'Tm') {
      const xToken = tokens[index - 2];
      const yToken = tokens[index - 1];
      if (xToken?.type === 'number' && yToken?.type === 'number') {
        currentX = xToken.value;
        currentY = yToken.value;
      }
      continue;
    }

    if (token.value === 'Td' || token.value === 'TD') {
      const xToken = tokens[index - 2];
      const yToken = tokens[index - 1];
      if (xToken?.type === 'number' && yToken?.type === 'number') {
        currentX += xToken.value;
        currentY += yToken.value;
        if (token.value === 'TD') {
          textLeading = -yToken.value;
        }
      }
      continue;
    }

    if (token.value === 'T*') {
      currentY -= textLeading || currentFontSize * 1.2;
      continue;
    }

    if (token.value === 'Tj') {
      const stringToken = tokens[index - 1];
      if (stringToken?.type === 'string') {
        pushTextItem(stringToken.bytes);
      }
      continue;
    }

    if (token.value === 'TJ') {
      const stringTokens = collectArrayStringTokens(tokens, index);
      if (stringTokens.length) {
        pushTextItem(Buffer.concat(stringTokens.map((item) => item.bytes)));
      }
      continue;
    }

    if (token.value === "'" || token.value === '"') {
      currentY -= textLeading || currentFontSize * 1.2;
      const stringToken = tokens[index - 1];
      if (stringToken?.type === 'string') {
        pushTextItem(stringToken.bytes);
      }
    }
  }

  return items;
}

function renderPdfPageLines(items) {
  const ordered = [...items].sort((left, right) => {
    if (Math.abs(left.y - right.y) > LINE_Y_TOLERANCE) {
      return right.y - left.y;
    }
    return left.x - right.x;
  });

  const lines = [];

  for (const item of ordered) {
    let line = lines[lines.length - 1];
    if (!line || Math.abs(line.y - item.y) > LINE_Y_TOLERANCE) {
      line = {
        y: item.y,
        items: []
      };
      lines.push(line);
    }
    line.items.push(item);
  }

  return lines
    .map((line) => {
      const sortedItems = [...line.items].sort((left, right) => left.x - right.x);
      let output = '';
      let lastEndX = null;

      for (const item of sortedItems) {
        if (lastEndX !== null) {
          const gap = item.x - lastEndX;
          output += gap > Math.max(18, item.fontSize * 1.4) ? ' | ' : ' ';
        }

        output += item.text;
        lastEndX = item.x + estimateTextWidth(item.text, item.fontSize);
      }

      return output
        .replace(/\s*\|\s*/g, ' | ')
        .replace(/\s+/g, ' ')
        .trim();
    })
    .filter(Boolean);
}

function extractPdfText(source) {
  const store = createPdfStore(source);
  const pageSpecs = listPdfPages(store);
  const pages = [];

  for (const pageSpec of pageSpecs) {
    const fontRefs = resolveFontRefs(store, pageSpec.resourceObjectId);
    const fontMaps = new Map();
    for (const [fontName, fontObjectId] of fontRefs.entries()) {
      fontMaps.set(fontName, resolveFontCmap(store, fontObjectId));
    }

    const pageItems = [];
    for (const contentObjectId of pageSpec.contentObjectIds) {
      const contentStream = getPdfObjectStream(store, contentObjectId);
      if (!contentStream.length) continue;
      pageItems.push(...extractTextItemsFromTokens(tokenizePdfContent(contentStream), fontMaps));
    }

    pages.push({
      pageNumber: pageSpec.pageNumber,
      lines: renderPdfPageLines(pageItems)
    });
  }

  const allLines = pages.flatMap((page) => page.lines);

  return {
    pageCount: pages.length,
    pages,
    allLines,
    fullText: allLines.join('\n')
  };
}

function looksLikeBankStatement(extracted) {
  const folded = foldText(extracted.fullText);
  if (!folded) return false;

  if (folded.includes('extrato conta / lancamentos')) return true;
  if (folded.includes('saldo em conta') && folded.includes('lancamentos')) return true;
  if (folded.includes('periodo de visualizacao') && folded.includes('agencia:') && folded.includes('conta:')) return true;
  return false;
}

function parseBankTransactions(lines) {
  const transactions = [];
  const transactionRegex =
    /^(\d{2}\/\d{2}\/\d{4})(?:\s+\|\s+|\s+)(.+?)\s+\|\s+([+-]?\d[\d.]*,\d{2})(?:\s+\|\s+([+-]?\d[\d.]*,\d{2}))?$/;

  for (const line of lines) {
    const match = compactSpaces(line).match(transactionRegex);
    if (!match) continue;

    transactions.push({
      date: match[1],
      description: compactSpaces(match[2]),
      amountText: match[3],
      amount: parseBrlAmount(match[3]),
      balanceText: match[4] || '',
      balance: match[4] ? parseBrlAmount(match[4]) : null
    });
  }

  return transactions;
}

function buildRecurringGroups(transactions) {
  const groups = new Map();

  for (const transaction of transactions) {
    const normalizedKey = normalizeRecurringKey(transaction.description);
    if (!normalizedKey) continue;

    const kind = transaction.amount < 0 ? 'saida' : 'entrada';
    const key = `${kind}:${normalizedKey}`;

    if (!groups.has(key)) {
      groups.set(key, {
        kind,
        label: cleanTransactionLabel(transaction.description),
        count: 0,
        total: 0,
        minAmount: transaction.amount,
        maxAmount: transaction.amount,
        dates: [],
        samples: []
      });
    }

    const entry = groups.get(key);
    entry.count += 1;
    entry.total += transaction.amount;
    entry.minAmount = Math.min(entry.minAmount, transaction.amount);
    entry.maxAmount = Math.max(entry.maxAmount, transaction.amount);

    if (!entry.dates.includes(transaction.date)) {
      entry.dates.push(transaction.date);
    }
    if (entry.samples.length < 3 && !entry.samples.includes(transaction.description)) {
      entry.samples.push(transaction.description);
    }
  }

  return [...groups.values()]
    .filter((entry) => entry.count >= 2)
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return Math.abs(right.total) - Math.abs(left.total);
    });
}

function buildBankStatementSummary(extracted) {
  const folded = foldText(extracted.fullText);
  const bankName = folded.includes('itau') ? 'Itau' : 'Banco';
  const periodMatch = folded.match(/periodo de visualizacao:\s*(\d{2}\/\d{2}\/\d{4})\s+ate\s+(\d{2}\/\d{2}\/\d{4})/);
  const accountMatch = extracted.fullText.match(/ag[êe]ncia:\s*([0-9.-]+)\s+conta:\s*([0-9.-]+)/i);
  const balanceMatch = extracted.fullText.match(/saldo em conta\s+R\$\s*([0-9.]+,\d{2})/i);
  const transactions = parseBankTransactions(extracted.allLines);
  const credits = transactions.filter((item) => item.amount > 0);
  const debits = transactions.filter((item) => item.amount < 0);
  const totalCredits = credits.reduce((sum, item) => sum + item.amount, 0);
  const totalDebits = debits.reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const topCredits = [...credits].sort((left, right) => right.amount - left.amount).slice(0, 8);
  const topDebits = [...debits].sort((left, right) => Math.abs(right.amount) - Math.abs(left.amount)).slice(0, 10);
  const recurringGroups = buildRecurringGroups(transactions).slice(0, 12);

  const summaryLines = [
    `Documento identificado como extrato bancario do ${bankName}.`,
    periodMatch ? `Periodo lido: ${periodMatch[1]} ate ${periodMatch[2]}.` : '',
    accountMatch ? `Conta identificada: agencia ${accountMatch[1]}, conta ${accountMatch[2]}.` : '',
    balanceMatch ? `Saldo exibido no PDF: ${formatBrlAmount(parseBrlAmount(balanceMatch[1]))}.` : '',
    `Paginas lidas: ${extracted.pageCount}.`,
    `Lancamentos identificados: ${transactions.length}.`,
    `Entradas somadas: ${formatBrlAmount(totalCredits)} em ${credits.length} lancamento(s).`,
    `Saidas somadas: ${formatBrlAmount(totalDebits)} em ${debits.length} lancamento(s).`
  ].filter(Boolean);

  if (topCredits.length) {
    summaryLines.push('', 'Principais entradas:');
    summaryLines.push(
      ...topCredits.map(
        (item) => `- ${item.date} | ${cleanTransactionLabel(item.description)} | ${formatSignedBrlAmount(item.amount)}`
      )
    );
  }

  if (topDebits.length) {
    summaryLines.push('', 'Principais saidas:');
    summaryLines.push(
      ...topDebits.map(
        (item) => `- ${item.date} | ${cleanTransactionLabel(item.description)} | ${formatSignedBrlAmount(item.amount)}`
      )
    );
  }

  if (recurringGroups.length) {
    summaryLines.push('', 'Movimentacoes recorrentes para classificar:');
    summaryLines.push(
      ...recurringGroups.map((group) => {
        const dates = group.dates.slice(0, 6).join(', ');
        const total = formatSignedBrlAmount(group.total);
        const faixa =
          group.minAmount !== group.maxAmount
            ? ` | faixa ${formatSignedBrlAmount(group.minAmount)} ate ${formatSignedBrlAmount(group.maxAmount)}`
            : '';
        return `- ${group.kind} | ${group.label} | ${group.count}x | total ${total}${faixa}${dates ? ` | datas: ${dates}` : ''}`;
      })
    );
  }

  const excerptLines = transactions.length
    ? transactions.slice(0, 90).map((item) => {
        const balanceText = item.balanceText ? ` | saldo ${formatSignedBrlAmount(item.balance)}` : '';
        return `${item.date} | ${cleanTransactionLabel(item.description)} | ${formatSignedBrlAmount(item.amount)}${balanceText}`;
      })
    : extracted.allLines.slice(0, 80);

  return {
    kind: 'bank_statement',
    transactionCount: transactions.length,
    summary: clampText(summaryLines.join('\n'), 7000),
    excerpt: clampText(excerptLines.join('\n'), 7000)
  };
}

function buildGenericPdfSummary(extracted) {
  const previewLines = extracted.allLines.slice(0, 60);

  return {
    kind: 'pdf',
    transactionCount: 0,
    summary: clampText(
      [
        `PDF com ${extracted.pageCount} pagina(s).`,
        extracted.allLines.length
          ? `Texto extraido localmente: ${extracted.allLines.length} linha(s).`
          : 'Nao encontrei texto legivel neste PDF.',
        previewLines.length ? '' : '',
        previewLines.length ? 'Trecho inicial do documento:' : '',
        ...previewLines.slice(0, 24)
      ]
        .filter(Boolean)
        .join('\n'),
      4500
    ),
    excerpt: clampText(previewLines.join('\n'), 7000)
  };
}

export async function analyzeTxtDocument(filePath) {
  const absolutePath = normalizeText(filePath);
  if (!absolutePath) return { kind: 'txt', lineCount: 0, summary: '', excerpt: '' };

  try {
    const raw = await readFile(absolutePath, 'utf8');
    const lines = raw.split('\n');
    const lineCount = lines.length;
    const excerpt = clampText(raw, 8000);
    const summary = `Arquivo de texto com ${lineCount} linha(s).`;
    return { kind: 'txt', lineCount, summary, excerpt };
  } catch {
    return { kind: 'txt', lineCount: 0, summary: '', excerpt: '' };
  }
}

export async function analyzePdfDocument(filePath) {
  const absolutePath = normalizeText(filePath);
  if (!absolutePath) {
    return {
      kind: 'pdf',
      pageCount: 0,
      transactionCount: 0,
      summary: '',
      excerpt: ''
    };
  }

  try {
    const details = await stat(absolutePath);
    const cacheKey = `${absolutePath}:${details.size}:${details.mtimeMs}`;
    if (PDF_ANALYSIS_CACHE.has(cacheKey)) {
      return PDF_ANALYSIS_CACHE.get(cacheKey);
    }

    const source = (await readFile(absolutePath)).toString('latin1');
    const extracted = extractPdfText(source);

    const base = looksLikeBankStatement(extracted) ? buildBankStatementSummary(extracted) : buildGenericPdfSummary(extracted);
    const result = {
      kind: base.kind,
      pageCount: extracted.pageCount,
      transactionCount: base.transactionCount || 0,
      summary: base.summary || '',
      excerpt: base.excerpt || ''
    };

    pushPdfCache(cacheKey, result);
    return result;
  } catch {
    return {
      kind: 'pdf',
      pageCount: 0,
      transactionCount: 0,
      summary: '',
      excerpt: ''
    };
  }
}

function toDocumentAttachment(item, source, analysis) {
  const isTxt = entryLooksLikeTxt(item);
  const isPdf = entryLooksLikePdf(item);
  if ((!isPdf && !isTxt) || !item.absolutePath) return null;

  return {
    mediaId: String(item.id || '').trim(),
    path: String(item.absolutePath || '').trim(),
    fileName: String(item.fileName || '').trim(),
    mimeType: String(item.mimeType || '').trim(),
    source,
    kind: String(analysis?.kind || (isTxt ? 'txt' : 'pdf')).trim(),
    pageCount: Number.parseInt(String(analysis?.pageCount || 0), 10) || 0,
    lineCount: Number.parseInt(String(analysis?.lineCount || 0), 10) || 0,
    transactionCount: Number.parseInt(String(analysis?.transactionCount || 0), 10) || 0,
    summary: clampText(analysis?.summary || '', 7000),
    excerpt: clampText(analysis?.excerpt || '', 7000)
  };
}

async function resolveCurrentMessageDocumentItem(context = {}) {
  const groupId = String(context.groupId || '').trim();
  const message = context.message;
  if (!groupId || (!messageHasPdfMedia(message) && !messageHasTxtMedia(message))) return null;

  const messageId = extractMessageId(message);
  if (messageId) {
    const existing = mediaStore.findByMessageId(messageId, groupId);
    if (entryLooksLikePdf(existing) || entryLooksLikeTxt(existing)) {
      return existing;
    }
  }

  const result = await mediaStore.ingestMessageMedia({
    message,
    groupId,
    senderJid: context.senderJid || '',
    senderNumber: context.senderNumber || ''
  });

  const saved = result.saved ? result.entry : null;
  return saved && (entryLooksLikePdf(saved) || entryLooksLikeTxt(saved)) ? saved : null;
}

async function resolveQuotedDocumentItem(context = {}) {
  const groupId = String(context.groupId || '').trim();
  const currentMessage = context.message;
  if (!groupId || !currentMessage?.hasQuotedMsg || typeof currentMessage.getQuotedMessage !== 'function') {
    return null;
  }

  try {
    const quoted = await currentMessage.getQuotedMessage();
    if (!quoted) return null;

    const quotedText = `${String(quoted?.body || '').trim()} ${String(quoted?._data?.caption || '').trim()}`.trim();
    const mediaId = parseMediaIdFromAnyText(quotedText);
    if (mediaId) {
      const byId = mediaStore.getById(mediaId);
      if (entryLooksLikePdf(byId)) {
        return byId;
      }
    }

    const quotedMessageId = extractMessageId(quoted);
    if (!quotedMessageId) return null;

    const byMessageId = mediaStore.findByMessageId(quotedMessageId, groupId);
    return (entryLooksLikePdf(byMessageId) || entryLooksLikeTxt(byMessageId)) ? byMessageId : null;
  } catch {
    return null;
  }
}

function resolveRecentGroupDocumentItem(context = {}, excludeIds = []) {
  const groupId = String(context.groupId || '').trim();
  if (!groupId) return null;

  const blockedIds = new Set(excludeIds.map((item) => String(item || '').trim()).filter(Boolean));

  // Busca em document e text (para .txt)
  const candidates = [];
  for (const mType of ['document', 'text']) {
    const page = mediaStore.list({ groupId, mediaType: mType, limit: 20 });
    candidates.push(...page.items);
  }

  return (
    candidates.find((item) => {
      if (!entryLooksLikePdf(item) && !entryLooksLikeTxt(item)) return false;
      if (blockedIds.has(String(item.id || '').trim())) return false;
      return Boolean(item.absolutePath);
    }) || null
  );
}

export async function resolveRelevantDocumentAttachments({
  text = '',
  context = {},
  limit = 1,
  allowRecentFallback = true
} = {}) {
  await mediaStore.ensureReady();

  const items = [];
  const pushItem = (item, source) => {
    if (!item || (!entryLooksLikePdf(item) && !entryLooksLikeTxt(item))) return;
    if (items.some((entry) => entry.id === item.id || entry.absolutePath === item.absolutePath)) return;
    items.push({ item, source });
  };

  const currentItem = await resolveCurrentMessageDocumentItem(context);
  pushItem(currentItem, 'current_message');

  const quotedItem = await resolveQuotedDocumentItem(context);
  pushItem(quotedItem, 'quoted_message');

  const inlineId = parseMediaIdFromAnyText(text);
  if (inlineId) {
    const inlineItem = mediaStore.getById(inlineId);
    pushItem(inlineItem, 'inline_media_id');
  }

  const shouldUseRecentFallback =
    allowRecentFallback &&
    items.length === 0 &&
    (textLooksLikeDocumentReference(text) || textLooksLikeBankStatementRequest(text));

  if (shouldUseRecentFallback) {
    const recentItem = resolveRecentGroupDocumentItem(
      context,
      items.map((entry) => entry.item.id)
    );
    pushItem(recentItem, 'recent_group_document');
  }

  const selected = items.slice(0, Math.max(1, limit));
  const attachments = [];

  for (const entry of selected) {
    const analysis = entryLooksLikeTxt(entry.item)
      ? await analyzeTxtDocument(entry.item.absolutePath)
      : await analyzePdfDocument(entry.item.absolutePath);
    const attachment = toDocumentAttachment(entry.item, entry.source, analysis);
    if (attachment) {
      attachments.push(attachment);
    }
  }

  return attachments;
}
