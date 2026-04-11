import { extname } from 'node:path';

const AUDIO_FILE_EXTENSIONS = new Set(['aac', 'amr', 'flac', 'm4a', 'mp3', 'mpga', 'oga', 'ogg', 'opus', 'wav', 'weba']);
const IMAGE_FILE_EXTENSIONS = new Set(['bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp']);
const VIDEO_FILE_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm']);
const TEXT_FILE_EXTENSIONS = new Set(['csv', 'json', 'md', 'rtf', 'text', 'tsv', 'txt', 'xml', 'yaml', 'yml']);

function normalizeText(value) {
  return String(value || '').trim();
}

export function foldText(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function normalizeMimeType(value) {
  return foldText(String(value || '').split(';')[0] || '');
}

export function mediaFileExtension(fileName = '') {
  return extname(normalizeText(fileName))
    .replace(/^\./, '')
    .toLowerCase();
}

export function pickMessageMediaFileName(message) {
  const candidates = [
    message?._data?.filename,
    message?.filename,
    message?._data?.fileName,
    message?.fileName
  ];

  return candidates.map((item) => normalizeText(item)).find(Boolean) || '';
}

export function looksLikeAudioMedia({ mimeType = '', messageType = '', fileName = '' } = {}) {
  const normalizedType = foldText(messageType);
  if (normalizedType === 'audio' || normalizedType === 'ptt' || normalizedType === 'voice') {
    return true;
  }

  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType.startsWith('audio/')) {
    return true;
  }

  return AUDIO_FILE_EXTENSIONS.has(mediaFileExtension(fileName));
}

export function inferMediaType({ mimeType = '', messageType = '', fileName = '' } = {}) {
  if (looksLikeAudioMedia({ mimeType, messageType, fileName })) {
    return 'audio';
  }

  const normalizedMimeType = normalizeMimeType(mimeType);
  if (normalizedMimeType.startsWith('image/')) return 'image';
  if (normalizedMimeType.startsWith('video/')) return 'video';
  if (normalizedMimeType.startsWith('text/')) return 'text';
  if (normalizedMimeType.startsWith('application/')) return 'document';

  const ext = mediaFileExtension(fileName);
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_FILE_EXTENSIONS.has(ext)) return 'video';
  if (TEXT_FILE_EXTENSIONS.has(ext)) return 'text';
  if (ext) return 'document';

  return 'file';
}
