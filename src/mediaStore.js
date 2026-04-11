import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { config } from './config.js';
import { settingsStore } from './settingsStore.js';
import { inferMediaType, pickMessageMediaFileName } from './mediaTypeUtils.js';

function sanitizePart(value, fallback = 'na') {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  return normalized || fallback;
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function extensionFromMime(mime, fileName = '') {
  const existing = extname(String(fileName || '')).replace(/^\./, '').toLowerCase();
  if (existing) return existing;

  const normalized = String(mime || '').toLowerCase();
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('heic')) return 'heic';
  if (normalized.includes('aac')) return 'aac';
  if (normalized.includes('amr')) return 'amr';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('mpeg') || normalized.includes('mpga')) return normalized.startsWith('audio/') ? 'mp3' : 'mpeg';
  if (normalized.includes('m4a')) return 'm4a';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('pdf')) return 'pdf';
  if (normalized.includes('plain')) return 'txt';
  if (normalized.includes('zip')) return 'zip';
  return 'bin';
}

function matchesAllowedMime(mime, allowed) {
  const normalizedMime = String(mime || '').toLowerCase();
  const rules = Array.isArray(allowed) ? allowed : [];
  if (!normalizedMime) return false;

  return rules.some((item) => {
    const rule = String(item || '').trim().toLowerCase();
    if (!rule) return false;

    if (rule.endsWith('*')) {
      return normalizedMime.startsWith(rule.slice(0, -1));
    }

    if (rule.endsWith('/')) {
      return normalizedMime.startsWith(rule);
    }

    return normalizedMime === rule;
  });
}

function decodeMediaBytes(data) {
  if (!data) return Buffer.alloc(0);
  return Buffer.from(String(data), 'base64');
}

function ensureUnderRoot(rootDir, filePath) {
  const root = resolve(rootDir);
  const absPath = resolve(filePath);
  return absPath === root || absPath.startsWith(`${root}/`);
}

function extractMessageId(message) {
  if (!message) return '';
  const direct = message?.id?._serialized;
  if (direct) return String(direct);
  if (message?.id && typeof message.id === 'string') return message.id;
  return '';
}

function defaultState() {
  return {
    updatedAt: new Date().toISOString(),
    items: []
  };
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;

  return {
    id: String(entry.id || randomUUID()),
    groupId: String(entry.groupId || ''),
    senderJid: String(entry.senderJid || ''),
    senderNumber: String(entry.senderNumber || ''),
    messageId: String(entry.messageId || ''),
    mediaType: String(entry.mediaType || 'file'),
    mimeType: String(entry.mimeType || ''),
    fileName: String(entry.fileName || ''),
    sizeBytes: Number.parseInt(String(entry.sizeBytes || 0), 10) || 0,
    sha256: String(entry.sha256 || ''),
    relativePath: String(entry.relativePath || ''),
    absolutePath: String(entry.absolutePath || ''),
    protected: Boolean(entry.protected),
    protectedPasswordHash: String(entry.protectedPasswordHash || ''),
    protectedPasswordSalt: String(entry.protectedPasswordSalt || ''),
    deletedAt: entry.deletedAt ? String(entry.deletedAt) : null,
    createdAt: String(entry.createdAt || new Date().toISOString())
  };
}

function normalizePassword(value) {
  return String(value || '').trim();
}

function hashProtectionPassword(password, salt) {
  return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function itemHasPassword(item) {
  return Boolean(item?.protectedPasswordHash && item?.protectedPasswordSalt);
}

function compareByCreatedDesc(a, b) {
  const ta = new Date(a?.createdAt || 0).getTime() || 0;
  const tb = new Date(b?.createdAt || 0).getTime() || 0;
  return tb - ta;
}

export class MediaStore {
  constructor(filePath = config.mediaIndexFile) {
    this.filePath = filePath;
    this.state = defaultState();
    this.ready = this.load();
    this.chain = Promise.resolve();
  }

  async ensureReady() {
    await this.ready;
    await settingsStore.ensureReady();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      const items = Array.isArray(parsed?.items) ? parsed.items.map((item) => sanitizeEntry(item)).filter(Boolean) : [];

      this.state = {
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        items
      };
    } catch {
      this.state = defaultState();
      await this.save();
    }
  }

  async withLock(task) {
    this.chain = this.chain
      .catch(() => {
        // mantem fila.
      })
      .then(task);
    return this.chain;
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.state.updatedAt = new Date().toISOString();
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  list(options = {}) {
    const {
      groupId = '',
      sender = '',
      mediaType = '',
      query = '',
      includeDeleted = false,
      limit = 50,
      offset = 0
    } = options;

    const normalizedGroup = String(groupId || '').trim();
    const normalizedSender = normalizeDigits(sender);
    const normalizedType = String(mediaType || '').trim().toLowerCase();
    const normalizedQuery = String(query || '').trim().toLowerCase();

    const filtered = this.state.items
      .filter((item) => {
        if (!includeDeleted && item.deletedAt) return false;
        if (normalizedGroup && item.groupId !== normalizedGroup) return false;

        if (normalizedSender) {
          const senderDigits = normalizeDigits(item.senderNumber || item.senderJid || '');
          if (!senderDigits) return false;
          if (!(senderDigits === normalizedSender || senderDigits.endsWith(normalizedSender) || normalizedSender.endsWith(senderDigits))) {
            return false;
          }
        }

        if (normalizedType && item.mediaType !== normalizedType) return false;

        if (normalizedQuery) {
          const haystack = `${item.fileName} ${item.mimeType} ${item.groupId} ${item.senderNumber}`.toLowerCase();
          if (!haystack.includes(normalizedQuery)) return false;
        }

        return true;
      })
      .sort(compareByCreatedDesc);

    const safeLimit = Math.max(1, Math.min(500, Number.parseInt(String(limit), 10) || 50));
    const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);

    return {
      total: filtered.length,
      items: filtered.slice(safeOffset, safeOffset + safeLimit)
    };
  }

  getById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return this.state.items.find((item) => item.id === key) || null;
  }

  findByMessageId(messageId, groupId = '') {
    const key = String(messageId || '').trim();
    if (!key) return null;
    const normalizedGroup = String(groupId || '').trim();
    return (
      this.state.items.find((item) => {
        if (!item?.messageId) return false;
        if (item.messageId !== key) return false;
        if (normalizedGroup && item.groupId !== normalizedGroup) return false;
        return true;
      }) || null
    );
  }

  async bindMessageId(id, messageId) {
    await this.ensureReady();
    const mediaId = String(id || '').trim();
    const msgId = String(messageId || '').trim();
    if (!mediaId || !msgId) return { ok: false, message: 'ID invalido.' };

    return this.withLock(async () => {
      const item = this.state.items.find((entry) => entry.id === mediaId);
      if (!item) return { ok: false, message: 'Arquivo nao encontrado.' };
      item.messageId = msgId;
      await this.save();
      return { ok: true, item };
    });
  }

  verifyPasswordForItem(item, password) {
    const value = normalizePassword(password);
    if (!itemHasPassword(item)) return false;
    if (!value) return false;
    const expected = hashProtectionPassword(value, item.protectedPasswordSalt);
    return expected === item.protectedPasswordHash;
  }

  async ingestMessageMedia({ message, groupId, senderJid = '', senderNumber = '' }) {
    await this.ensureReady();

    const settings = settingsStore.get();
    if (!settings.mediaIngestEnabled) {
      return { saved: false, reason: 'disabled', message: 'Ingestao de midia desativada.' };
    }

    if (!message?.hasMedia || typeof message.downloadMedia !== 'function') {
      return { saved: false, reason: 'no_media', message: 'Mensagem sem midia.' };
    }

    const messageId = extractMessageId(message);
    if (messageId) {
      const existing = this.findByMessageId(messageId, groupId);
      if (existing && !existing.deletedAt) {
        return {
          saved: true,
          deduped: true,
          entry: existing
        };
      }
    }

    const media = await message.downloadMedia();
    if (!media || !media.data) {
      return { saved: false, reason: 'empty', message: 'Falha ao baixar midia.' };
    }

    const mimeType = String(media.mimetype || '').toLowerCase();
    if (!matchesAllowedMime(mimeType, settings.mediaAllowedMimePrefixes)) {
      return {
        saved: false,
        reason: 'mime_blocked',
        message: `MIME bloqueado: ${mimeType || 'desconhecido'}`
      };
    }

    const bytes = decodeMediaBytes(media.data);
    if (!bytes.length) {
      return { saved: false, reason: 'empty', message: 'Midia vazia.' };
    }

    if (bytes.length > settings.mediaMaxBytes) {
      return {
        saved: false,
        reason: 'too_large',
        message: `Midia acima do limite (${bytes.length} > ${settings.mediaMaxBytes} bytes)`
      };
    }

    const today = new Date().toISOString().slice(0, 10);
    const mediaType = inferMediaType({
      mimeType,
      messageType: message?.type || '',
      fileName: media.filename || pickMessageMediaFileName(message)
    });
    const senderDir = sanitizePart(normalizeDigits(senderNumber) || senderJid || 'desconhecido');
    const rootDir = settings.mediaRootDir || config.mediaRootDir;
    const targetDir = join(rootDir, sanitizePart(groupId), today, mediaType, senderDir);

    await mkdir(targetDir, { recursive: true });

    const ext = extensionFromMime(mimeType, media.filename);
    const baseName = `midia-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const absolutePath = resolve(targetDir, baseName);

    if (!ensureUnderRoot(rootDir, absolutePath)) {
      return { saved: false, reason: 'path_blocked', message: 'Caminho de escrita invalido.' };
    }

    await writeFile(absolutePath, bytes);

    const digest = createHash('sha256').update(bytes).digest('hex');
    const relativePath = absolutePath.startsWith(resolve(rootDir))
      ? absolutePath.slice(resolve(rootDir).length).replace(/^\/+/, '')
      : baseName;

    const entry = sanitizeEntry({
      id: randomUUID(),
      groupId,
      senderJid,
      senderNumber,
      messageId,
      mediaType,
      mimeType,
      fileName: media.filename || baseName,
      sizeBytes: bytes.length,
      sha256: digest,
      relativePath,
      absolutePath,
      protected: false,
      createdAt: new Date().toISOString()
    });

    return this.withLock(async () => {
      this.state.items.push(entry);
      await this.save();
      return {
        saved: true,
        entry
      };
    });
  }

  async markProtected(id, value, options = {}) {
    await this.ensureReady();
    const key = String(id || '').trim();
    if (!key) return { ok: false, message: 'ID vazio.' };
    const password = normalizePassword(options.password);
    const clearPassword = Boolean(options.clearPassword);

    return this.withLock(async () => {
      const item = this.state.items.find((entry) => entry.id === key);
      if (!item) return { ok: false, message: 'Arquivo nao encontrado.' };

      const nextProtected = Boolean(value);
      item.protected = nextProtected;

      if (!nextProtected || clearPassword) {
        item.protectedPasswordHash = '';
        item.protectedPasswordSalt = '';
      }

      if (nextProtected && password) {
        const salt = randomUUID();
        item.protectedPasswordSalt = salt;
        item.protectedPasswordHash = hashProtectionPassword(password, salt);
      }

      await this.save();
      return { ok: true, item };
    });
  }

  async deleteById(id, options = {}) {
    await this.ensureReady();
    const key = String(id || '').trim();
    if (!key) return { ok: false, message: 'ID vazio.' };
    const password = normalizePassword(options.password);

    return this.withLock(async () => {
      const item = this.state.items.find((entry) => entry.id === key);
      if (!item) return { ok: false, message: 'Arquivo nao encontrado.' };
      if (item.protected) {
        if (!itemHasPassword(item)) return { ok: false, message: 'Arquivo protegido.' };
        if (!password) return { ok: false, message: 'Arquivo protegido com senha. Informe a senha.' };
        const expected = hashProtectionPassword(password, item.protectedPasswordSalt);
        if (expected !== item.protectedPasswordHash) {
          return { ok: false, message: 'Senha incorreta para apagar arquivo protegido.' };
        }
      }
      if (item.deletedAt) return { ok: true, item, deleted: false };

      try {
        if (item.absolutePath) {
          await rm(item.absolutePath, { force: true });
        }
      } catch {
        // segue para tombstone.
      }

      item.deletedAt = new Date().toISOString();
      await this.save();
      return { ok: true, item, deleted: true };
    });
  }

  async cleanup(days) {
    await this.ensureReady();
    const retention = Math.max(1, Number.parseInt(String(days), 10) || settingsStore.get().mediaRetentionDays);
    const cutoff = Date.now() - retention * 24 * 60 * 60 * 1000;

    return this.withLock(async () => {
      let removed = 0;

      for (const item of this.state.items) {
        if (item.deletedAt || item.protected) continue;
        const ts = new Date(item.createdAt).getTime();
        if (!Number.isFinite(ts) || ts >= cutoff) continue;

        try {
          if (item.absolutePath) {
            await rm(item.absolutePath, { force: true });
          }
        } catch {
          // ignora erro de remocao fisica e marca no indice.
        }

        item.deletedAt = new Date().toISOString();
        removed += 1;
      }

      if (removed) {
        await this.save();
      }

      return { ok: true, removed, retentionDays: retention };
    });
  }

  async resolveDownloadPath(id, options = {}) {
    await this.ensureReady();
    const password = normalizePassword(options.password);
    const item = this.getById(id);
    if (!item) {
      return { ok: false, message: 'Arquivo nao encontrado.' };
    }
    if (item.deletedAt) {
      return { ok: false, message: 'Arquivo removido.' };
    }
    if (item.protected) {
      if (!itemHasPassword(item)) {
        return { ok: false, message: 'Arquivo protegido. Remova protecao para baixar.' };
      }
      if (!password) {
        return { ok: false, message: 'Arquivo protegido com senha. Informe a senha.' };
      }
      const expected = hashProtectionPassword(password, item.protectedPasswordSalt);
      if (expected !== item.protectedPasswordHash) {
        return { ok: false, message: 'Senha incorreta para baixar arquivo protegido.' };
      }
    }

    const settings = settingsStore.get();
    const root = resolve(settings.mediaRootDir || config.mediaRootDir);
    const abs = resolve(item.absolutePath || join(root, item.relativePath || ''));

    if (!ensureUnderRoot(root, abs)) {
      return { ok: false, message: 'Arquivo fora da pasta autorizada.' };
    }

    try {
      await stat(abs);
      return { ok: true, filePath: abs, item };
    } catch {
      return { ok: false, message: 'Arquivo nao encontrado no disco.' };
    }
  }
}

export const mediaStore = new MediaStore();
