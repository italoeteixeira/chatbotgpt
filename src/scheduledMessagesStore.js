import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

function twoDigits(value) {
  return String(value).padStart(2, '0');
}

function dateKeyLocal(date = new Date()) {
  const year = date.getFullYear();
  const month = twoDigits(date.getMonth() + 1);
  const day = twoDigits(date.getDate());
  return `${year}-${month}-${day}`;
}

function clampText(value, maxChars = 400) {
  const normalized = String(value || '').replace(/\u0000/g, '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function normalizeGroupId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.endsWith('@g.us')) return normalized;
  return '';
}

function normalizeHour(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 23) return null;
  return parsed;
}

function normalizeMinute(value) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 59) return null;
  return parsed;
}

function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;

  const groupId = normalizeGroupId(item.groupId);
  const hour = normalizeHour(item.hour);
  const minute = normalizeMinute(item.minute);
  const message = clampText(item.message, 600);

  if (!groupId || hour === null || minute === null || !message) return null;

  return {
    id: String(item.id || randomUUID()),
    groupId,
    hour,
    minute,
    message,
    active: item.active !== false,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
    updatedBy: clampText(item.updatedBy || '', 120),
    lastSentAt: typeof item.lastSentAt === 'string' ? item.lastSentAt : '',
    lastSentDate: typeof item.lastSentDate === 'string' ? item.lastSentDate : ''
  };
}

function normalizeState(input) {
  const items = Array.isArray(input?.items)
    ? input.items.map((item) => normalizeItem(item)).filter(Boolean)
    : [];
  return {
    items,
    updatedAt: typeof input?.updatedAt === 'string' ? input.updatedAt : new Date().toISOString()
  };
}

export class ScheduledMessagesStore {
  constructor(filePath = config.scheduledMessagesFile) {
    this.filePath = filePath;
    this.state = normalizeState({});
    this.ready = this.load();
    this.chain = Promise.resolve();
  }

  async ensureReady() {
    await this.ready;
  }

  async withLock(task) {
    this.chain = this.chain
      .catch(() => {
        // Mantem a fila de escrita viva.
      })
      .then(task);
    return this.chain;
  }

  async load() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      this.state = normalizeState(parsed);
    } catch {
      this.state = normalizeState({});
      await this.save();
    }
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.state.updatedAt = new Date().toISOString();
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  listByGroup(groupId) {
    const normalizedGroupId = normalizeGroupId(groupId);
    if (!normalizedGroupId) return [];
    return this.state.items
      .filter((item) => item.groupId === normalizedGroupId && item.active !== false)
      .sort((left, right) => {
        const leftMinutes = left.hour * 60 + left.minute;
        const rightMinutes = right.hour * 60 + right.minute;
        return leftMinutes - rightMinutes;
      })
      .map((item) => ({ ...item }));
  }

  async upsertDailyForGroup({ groupId, hour, minute, message, actor = '' }) {
    await this.ensureReady();

    const normalizedGroupId = normalizeGroupId(groupId);
    const normalizedHour = normalizeHour(hour);
    const normalizedMinute = normalizeMinute(minute);
    const normalizedMessage = clampText(message, 600);

    if (!normalizedGroupId || normalizedHour === null || normalizedMinute === null || !normalizedMessage) {
      return { ok: false, message: 'Dados invalidos para agendamento diario.' };
    }

    return this.withLock(async () => {
      const nowIso = new Date().toISOString();
      const existingIndexes = this.state.items
        .map((item, index) => ({ item, index }))
        .filter((entry) => entry.item.groupId === normalizedGroupId)
        .map((entry) => entry.index);
      const existingIndex = existingIndexes.length ? existingIndexes[0] : -1;

      if (existingIndex >= 0) {
        const current = this.state.items[existingIndex];
        this.state.items[existingIndex] = {
          ...current,
          hour: normalizedHour,
          minute: normalizedMinute,
          message: normalizedMessage,
          active: true,
          updatedAt: nowIso,
          updatedBy: clampText(actor, 120)
        };

        for (const idx of existingIndexes) {
          if (idx === existingIndex) continue;
          this.state.items[idx] = {
            ...this.state.items[idx],
            active: false,
            updatedAt: nowIso
          };
        }

        await this.save();
        return { ok: true, created: false, item: { ...this.state.items[existingIndex] } };
      }

      const created = {
        id: randomUUID(),
        groupId: normalizedGroupId,
        hour: normalizedHour,
        minute: normalizedMinute,
        message: normalizedMessage,
        active: true,
        createdAt: nowIso,
        updatedAt: nowIso,
        updatedBy: clampText(actor, 120),
        lastSentAt: '',
        lastSentDate: ''
      };

      this.state.items.push(created);
      await this.save();
      return { ok: true, created: true, item: { ...created } };
    });
  }

  async disableDailyForGroup(groupId) {
    await this.ensureReady();
    const normalizedGroupId = normalizeGroupId(groupId);
    if (!normalizedGroupId) {
      return { ok: false, disabled: 0, message: 'Grupo invalido.' };
    }

    return this.withLock(async () => {
      let changed = 0;
      this.state.items = this.state.items.map((item) => {
        if (item.groupId !== normalizedGroupId || item.active === false) {
          return item;
        }
        changed += 1;
        return {
          ...item,
          active: false,
          updatedAt: new Date().toISOString()
        };
      });
      if (changed > 0) {
        await this.save();
      }
      return { ok: true, disabled: changed };
    });
  }

  getDueItems(now = new Date()) {
    const hour = now.getHours();
    const minute = now.getMinutes();
    const today = dateKeyLocal(now);

    return this.state.items
      .filter((item) => item.active !== false)
      .filter((item) => item.hour === hour && item.minute === minute)
      .filter((item) => String(item.lastSentDate || '') !== today)
      .map((item) => ({ ...item }));
  }

  async markSent(id, now = new Date()) {
    await this.ensureReady();
    const scheduleId = String(id || '').trim();
    if (!scheduleId) return { ok: false };

    return this.withLock(async () => {
      const index = this.state.items.findIndex((item) => item.id === scheduleId);
      if (index < 0) return { ok: false };

      this.state.items[index] = {
        ...this.state.items[index],
        lastSentAt: now.toISOString(),
        lastSentDate: dateKeyLocal(now),
        updatedAt: now.toISOString()
      };
      await this.save();
      return { ok: true, item: { ...this.state.items[index] } };
    });
  }
}

export const scheduledMessagesStore = new ScheduledMessagesStore();
