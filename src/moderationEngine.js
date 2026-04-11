import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function senderKey(senderJid, senderNumber) {
  const jid = String(senderJid || '').trim();
  if (jid) return jid;
  return String(senderNumber || '').trim();
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function defaultState() {
  return {
    enabled: config.moderationEnabled,
    maxWarnings: config.moderationMaxWarnings,
    keywords: [],
    warningsByGroup: {},
    updatedAt: new Date().toISOString()
  };
}

export class ModerationEngine {
  constructor(filePath = config.moderationFile) {
    this.filePath = filePath;
    this.state = defaultState();
    this.ready = this.load();
    this.chain = Promise.resolve();
  }

  async load() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') return;

      const keywords = Array.isArray(parsed.keywords)
        ? Array.from(new Set(parsed.keywords.map((item) => normalizeText(item)).filter(Boolean)))
        : [];
      const warningsByGroup =
        parsed.warningsByGroup && typeof parsed.warningsByGroup === 'object' ? parsed.warningsByGroup : {};
      const maxWarnings =
        Number.isFinite(parsed.maxWarnings) && parsed.maxWarnings > 0
          ? Math.floor(parsed.maxWarnings)
          : config.moderationMaxWarnings;

      this.state = {
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : config.moderationEnabled,
        maxWarnings,
        keywords,
        warningsByGroup,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
      };
    } catch {
      this.state = defaultState();
      await this.save();
    }
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.state.updatedAt = new Date().toISOString();
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  async withLock(task) {
    this.chain = this.chain
      .catch(() => {
        // Mantem fila ativa.
      })
      .then(task);
    return this.chain;
  }

  async ensureReady() {
    await this.ready;
  }

  isEnabled() {
    return Boolean(this.state.enabled);
  }

  maxWarnings() {
    return Math.max(1, Number.parseInt(String(this.state.maxWarnings || config.moderationMaxWarnings), 10));
  }

  listKeywords() {
    return [...this.state.keywords];
  }

  snapshot(groupId = '') {
    const groupKey = String(groupId || '').trim();
    return {
      enabled: this.isEnabled(),
      maxWarnings: this.maxWarnings(),
      keywords: this.listKeywords(),
      updatedAt: this.state.updatedAt,
      groupId: groupKey || null,
      warnings: groupKey ? this.getWarnings(groupKey) : {}
    };
  }

  async addKeyword(rawKeyword) {
    await this.ensureReady();
    const keyword = normalizeText(rawKeyword);
    if (!keyword) return { added: false, reason: 'empty', keyword: '' };

    return this.withLock(async () => {
      if (this.state.keywords.includes(keyword)) {
        return { added: false, reason: 'exists', keyword };
      }
      this.state.keywords.push(keyword);
      await this.save();
      return { added: true, keyword };
    });
  }

  async removeKeyword(rawKeyword) {
    await this.ensureReady();
    const keyword = normalizeText(rawKeyword);
    if (!keyword) return { removed: false, reason: 'empty', keyword: '' };

    return this.withLock(async () => {
      const before = this.state.keywords.length;
      this.state.keywords = this.state.keywords.filter((item) => item !== keyword);
      const removed = this.state.keywords.length !== before;
      if (removed) {
        await this.save();
      }
      return { removed, keyword };
    });
  }

  async clearKeywords() {
    await this.ensureReady();
    return this.withLock(async () => {
      const count = this.state.keywords.length;
      this.state.keywords = [];
      await this.save();
      return count;
    });
  }

  async setEnabled(enabled) {
    await this.ensureReady();
    return this.withLock(async () => {
      this.state.enabled = Boolean(enabled);
      await this.save();
      return this.state.enabled;
    });
  }

  async setMaxWarnings(value) {
    await this.ensureReady();
    const parsed = Number.parseInt(String(value), 10);
    const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : config.moderationMaxWarnings;
    return this.withLock(async () => {
      this.state.maxWarnings = safe;
      await this.save();
      return this.state.maxWarnings;
    });
  }

  getWarnings(groupId) {
    const groupKey = String(groupId || '');
    const map = this.state.warningsByGroup?.[groupKey];
    if (!map || typeof map !== 'object') return {};
    return { ...map };
  }

  async resetWarnings(groupId, targetSender = '') {
    await this.ensureReady();
    const groupKey = String(groupId || '');
    return this.withLock(async () => {
      if (!groupKey) return 0;

      const map = this.state.warningsByGroup[groupKey];
      if (!map || typeof map !== 'object') return 0;

      if (!targetSender) {
        const count = Object.keys(map).length;
        this.state.warningsByGroup[groupKey] = {};
        await this.save();
        return count;
      }

      const targetKey = String(targetSender).trim();
      if (!targetKey) return 0;

      const targetDigits = normalizeDigits(targetKey.split('@')[0]);
      let removed = 0;

      for (const key of Object.keys(map)) {
        const keyDigits = normalizeDigits(String(key).split('@')[0]);
        const matches =
          key === targetKey ||
          (targetDigits && keyDigits && (keyDigits === targetDigits || keyDigits.endsWith(targetDigits) || targetDigits.endsWith(keyDigits)));
        if (matches) {
          delete map[key];
          removed += 1;
        }
      }

      if (removed) {
        await this.save();
      }

      return removed;
    });
  }

  findKeywordMatches(rawText) {
    const text = normalizeText(rawText);
    if (!text) return [];
    const matches = [];
    for (const keyword of this.state.keywords) {
      if (keyword && text.includes(keyword)) {
        matches.push(keyword);
      }
    }
    return matches;
  }

  async registerViolation({ groupId, senderJid, senderNumber, rawText }) {
    await this.ensureReady();

    if (!this.state.enabled) {
      return { matched: false, matches: [], warningCount: 0, maxWarnings: this.maxWarnings(), shouldRemove: false };
    }

    const matches = this.findKeywordMatches(rawText);
    if (!matches.length) {
      return { matched: false, matches: [], warningCount: 0, maxWarnings: this.maxWarnings(), shouldRemove: false };
    }

    const groupKey = String(groupId || '');
    const who = senderKey(senderJid, senderNumber);
    const maxWarnings = this.maxWarnings();

    if (!groupKey || !who) {
      return { matched: true, matches, warningCount: 0, maxWarnings, shouldRemove: false };
    }

    return this.withLock(async () => {
      if (!this.state.warningsByGroup[groupKey] || typeof this.state.warningsByGroup[groupKey] !== 'object') {
        this.state.warningsByGroup[groupKey] = {};
      }

      const current = Number.parseInt(String(this.state.warningsByGroup[groupKey][who] || 0), 10) || 0;
      const warningCount = current + 1;
      const shouldRemove = warningCount >= maxWarnings;

      if (shouldRemove) {
        delete this.state.warningsByGroup[groupKey][who];
      } else {
        this.state.warningsByGroup[groupKey][who] = warningCount;
      }

      await this.save();

      return {
        matched: true,
        matches,
        warningCount,
        maxWarnings,
        shouldRemove
      };
    });
  }
}
