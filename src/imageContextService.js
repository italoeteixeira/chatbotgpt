import { mediaStore } from './mediaStore.js';

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
  return normalizeText(value).replace(/\s+/g, ' ').trim();
}

function extractMessageId(message) {
  return String(message?.id?._serialized || '').trim();
}

function parseMediaIdFromAnyText(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return '';

  const tagged = normalized.match(/MIDIA_ID\s*[:=#-]?\s*([a-f0-9-]{8,})/i);
  if (tagged) return String(tagged[1] || '').trim();

  const generic = normalized.match(/(?:id|midia|m[ií]dia)\s*[:=#-]?\s*([a-f0-9-]{8,})/i);
  if (generic) return String(generic[1] || '').trim();

  return '';
}

function toAttachment(item, source) {
  if (!item || item.deletedAt || item.mediaType !== 'image') return null;
  if (!item.absolutePath) return null;

  return {
    mediaId: String(item.id || '').trim(),
    path: String(item.absolutePath || '').trim(),
    fileName: String(item.fileName || '').trim(),
    source
  };
}

export function extractMessageText(message) {
  const candidates = [message?.body, message?.caption, message?._data?.caption];
  for (const candidate of candidates) {
    const normalized = compactSpaces(candidate);
    if (normalized) return normalized;
  }
  return '';
}

export function messageHasImageMedia(message) {
  if (!message?.hasMedia) return false;

  const messageType = String(message?.type || '')
    .trim()
    .toLowerCase();
  if (messageType === 'image') return true;

  const mimeType = String(message?._data?.mimetype || message?.mimetype || '')
    .trim()
    .toLowerCase();
  return mimeType.startsWith('image/');
}

export function textLooksLikeImageGeneration(text) {
  const folded = foldText(text);
  if (!folded) return false;
  return /(gera|gerar|cria|criar|faz|fazer).*(foto|imagem)/.test(folded);
}

export function textLooksLikeImageReference(text) {
  const folded = foldText(text);
  if (!folded) return false;

  const hasImageNoun = /\b(imagem|imagens|foto|fotos|figura|figuras|print|prints|screenshot|captura)\b/.test(folded);
  const hasReference =
    /\b(essa|esta|dessa|desta|desse|deste|ultima|ultimo|anterior|acima|abaixo|citada|citado|enviada|enviado|anexada|anexado|referencia|base)\b/.test(
      folded
    ) || /\b(o que tem|oque tem|o que esta|oque esta)\b/.test(folded);
  const hasAnalysisVerb =
    /\b(texto|ocr|ler|leia|leitura|transcrev|identific|descrev|analis|explic|extrai|resume|conteudo)\b/.test(
      folded
    );
  const hasEditVerb =
    /\b(edita|editar|altera|alterar|transforma|transformar|manipula|manipular|estiliza|estilizar|melhora|melhorar|varia|variacao|versao|refaz|recria|converte|converter|remove fundo|troca fundo|recorta|coloriza|upscale)\b/.test(
      folded
    );

  if (hasImageNoun && (hasReference || hasAnalysisVerb || hasEditVerb)) return true;
  if (hasReference && hasEditVerb) return true;
  if (/\bultima\s+(imagem|foto)\b/.test(folded)) return true;
  if (/\btexto\b.*\b(ultima|ultimo)\b.*\b(imagem|foto)\b/.test(folded)) return true;

  return false;
}

async function resolveCurrentMessageImageItem(context = {}) {
  const groupId = String(context.groupId || '').trim();
  const message = context.message;
  if (!groupId || !messageHasImageMedia(message)) return null;

  const messageId = extractMessageId(message);
  if (messageId) {
    const existing = mediaStore.findByMessageId(messageId, groupId);
    if (existing?.mediaType === 'image' && !existing.deletedAt) {
      return existing;
    }
  }

  const result = await mediaStore.ingestMessageMedia({
    message,
    groupId,
    senderJid: context.senderJid || '',
    senderNumber: context.senderNumber || ''
  });

  return result.saved && result.entry?.mediaType === 'image' ? result.entry : null;
}

async function resolveQuotedImageItem(context = {}) {
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
      if (byId?.mediaType === 'image' && !byId.deletedAt) {
        return byId;
      }
    }

    const quotedMessageId = extractMessageId(quoted);
    if (!quotedMessageId) return null;

    const byMessageId = mediaStore.findByMessageId(quotedMessageId, groupId);
    if (byMessageId?.mediaType === 'image' && !byMessageId.deletedAt) {
      return byMessageId;
    }
  } catch {
    return null;
  }

  return null;
}

function resolveRecentGroupImageItem(context = {}, excludeIds = []) {
  const groupId = String(context.groupId || '').trim();
  if (!groupId) return null;

  const blocked = new Set(excludeIds.map((item) => String(item || '').trim()).filter(Boolean));
  const page = mediaStore.list({
    groupId,
    mediaType: 'image',
    limit: 12
  });

  return (
    page.items.find((item) => {
      if (!item || item.deletedAt) return false;
      if (blocked.has(String(item.id || '').trim())) return false;
      return Boolean(item.absolutePath);
    }) || null
  );
}

export async function resolveRelevantImageAttachments({ text = '', context = {}, limit = 2, allowRecentFallback = true } = {}) {
  await mediaStore.ensureReady();

  const attachments = [];
  const pushAttachment = (attachment) => {
    if (!attachment?.path) return;
    if (attachments.some((item) => item.path === attachment.path || item.mediaId === attachment.mediaId)) return;
    attachments.push(attachment);
  };

  const currentItem = await resolveCurrentMessageImageItem(context);
  pushAttachment(toAttachment(currentItem, 'current_message'));

  const quotedItem = await resolveQuotedImageItem(context);
  pushAttachment(toAttachment(quotedItem, 'quoted_message'));

  const inlineId = parseMediaIdFromAnyText(text);
  if (inlineId) {
    const inlineItem = mediaStore.getById(inlineId);
    pushAttachment(toAttachment(inlineItem, 'inline_media_id'));
  }

  const shouldUseRecentFallback =
    allowRecentFallback &&
    attachments.length === 0 &&
    textLooksLikeImageReference(text);

  if (shouldUseRecentFallback) {
    const recentItem = resolveRecentGroupImageItem(
      context,
      attachments.map((item) => item.mediaId)
    );
    pushAttachment(toAttachment(recentItem, 'recent_group_image'));
  }

  return attachments.slice(0, Math.max(1, limit));
}
