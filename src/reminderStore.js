import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

function compactSpaces(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function clampText(value, maxChars = 420) {
  const normalized = compactSpaces(String(value || '').replace(/\u0000/g, ''));
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function normalizeGroupId(value) {
  const normalized = compactSpaces(value);
  return normalized.endsWith('@g.us') ? normalized : '';
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizeIso(value) {
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function toFiniteTime(value) {
  const date = new Date(String(value || ''));
  const time = date.getTime();
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function normalizeWeekdays(value) {
  const raw = Array.isArray(value) ? value : [];
  const items = raw
    .map((item) => Number.parseInt(String(item), 10))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
  return Array.from(new Set(items)).sort((left, right) => left - right);
}

function normalizeRecurrence(value) {
  if (!value || typeof value !== 'object') return null;
  const type = compactSpaces(value.type || value.frequency).toLowerCase();
  if (type !== 'daily') return null;

  const weekdays = normalizeWeekdays(value.weekdays);
  return {
    type: 'daily',
    weekdays: weekdays.length ? weekdays : [0, 1, 2, 3, 4, 5, 6]
  };
}

function isRecurringReminder(item) {
  return Boolean(item?.recurrence && item.recurrence.type === 'daily');
}

function isPendingReminder(item) {
  if (!item || item.active === false || item.canceledAt) return false;
  if (isRecurringReminder(item)) return true;
  return !item.sentAt;
}

function latestReminderActivity(item) {
  return Math.max(toFiniteTime(item?.createdAt), toFiniteTime(item?.sentAt), toFiniteTime(item?.canceledAt));
}

function computeNextRecurringDueAt(currentDueAt, recurrence, sentAt = new Date()) {
  const current = currentDueAt instanceof Date ? currentDueAt : new Date(String(currentDueAt || ''));
  const rule = normalizeRecurrence(recurrence);
  const reference = sentAt instanceof Date ? sentAt : new Date(String(sentAt || ''));
  if (Number.isNaN(current.getTime()) || !rule) return null;

  const allowedWeekdays = new Set(rule.weekdays);
  for (let offset = 1; offset <= 14; offset += 1) {
    const candidate = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + offset,
      current.getHours(),
      current.getMinutes(),
      current.getSeconds(),
      current.getMilliseconds()
    );
    if (!allowedWeekdays.has(candidate.getDay())) continue;
    if (candidate.getTime() <= reference.getTime()) continue;
    return candidate;
  }

  return null;
}

function normalizeState(input) {
  const rows = Array.isArray(input?.items) ? input.items : [];
  const items = rows
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const groupId = normalizeGroupId(item.groupId);
      const text = clampText(item.text, 500);
      const dueAt = normalizeIso(item.dueAt);
      const recurrence = normalizeRecurrence(item.recurrence);
      if (!groupId || !text || !dueAt) return null;
      return {
        id: String(item.id || randomUUID()),
        groupId,
        senderNumber: normalizePhone(item.senderNumber || ''),
        text,
        dueAt,
        recurrence,
        active: item.active !== false,
        createdAt: normalizeIso(item.createdAt) || new Date().toISOString(),
        sentAt: normalizeIso(item.sentAt) || '',
        canceledAt: normalizeIso(item.canceledAt) || ''
      };
    })
    .filter(Boolean);

  return {
    items,
    updatedAt: normalizeIso(input?.updatedAt) || new Date().toISOString()
  };
}

export class ReminderStore {
  constructor(filePath = config.remindersFile) {
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
        // Mantem encadeamento.
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

  async addReminder({ groupId, senderNumber = '', dueAt, text, recurrence = null }) {
    await this.ensureReady();

    const normalizedGroup = normalizeGroupId(groupId);
    const normalizedDueAt = normalizeIso(dueAt);
    const normalizedText = clampText(text, 500);
    const normalizedSender = normalizePhone(senderNumber);
    const normalizedRecurrence = normalizeRecurrence(recurrence);

    if (!normalizedGroup || !normalizedDueAt || !normalizedText) {
      return { ok: false, message: 'Dados invalidos para lembrete.' };
    }

    return this.withLock(async () => {
      const created = {
        id: randomUUID(),
        groupId: normalizedGroup,
        senderNumber: normalizedSender,
        text: normalizedText,
        dueAt: normalizedDueAt,
        recurrence: normalizedRecurrence,
        active: true,
        createdAt: new Date().toISOString(),
        sentAt: '',
        canceledAt: ''
      };
      this.state.items.push(created);
      await this.save();
      return { ok: true, item: { ...created } };
    });
  }

  listPendingByGroup(groupId, limit = 12) {
    const normalizedGroup = normalizeGroupId(groupId);
    if (!normalizedGroup) return [];

    return this.state.items
      .filter((item) => item.groupId === normalizedGroup)
      .filter((item) => isPendingReminder(item))
      .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime())
      .slice(0, Math.max(1, limit))
      .map((item, index) => ({ ...item, index: index + 1 }));
  }

  findLatestPendingByGroupSender(groupId, senderNumber = '') {
    const normalizedGroup = normalizeGroupId(groupId);
    const normalizedSender = normalizePhone(senderNumber);
    if (!normalizedGroup) return null;

    return this.state.items
      .filter((item) => item.groupId === normalizedGroup)
      .filter((item) => isPendingReminder(item))
      .filter((item) => !normalizedSender || item.senderNumber === normalizedSender)
      .sort((left, right) => latestReminderActivity(right) - latestReminderActivity(left))
      .map((item) => ({ ...item }))
      .at(0) || null;
  }

  findLatestByGroupSender(groupId, senderNumber = '') {
    const normalizedGroup = normalizeGroupId(groupId);
    const normalizedSender = normalizePhone(senderNumber);
    if (!normalizedGroup) return null;

    return this.state.items
      .filter((item) => item.groupId === normalizedGroup)
      .filter((item) => !item.canceledAt)
      .filter((item) => !normalizedSender || item.senderNumber === normalizedSender)
      .sort((left, right) => latestReminderActivity(right) - latestReminderActivity(left))
      .map((item) => ({ ...item }))
      .at(0) || null;
  }

  getDueItems(now = new Date()) {
    const nowMs = now.getTime();
    const maxDelayMs = 24 * 60 * 60 * 1000;

    return this.state.items
      .filter((item) => isPendingReminder(item))
      .filter((item) => {
        const dueMs = new Date(item.dueAt).getTime();
        if (!Number.isFinite(dueMs)) return false;
        return dueMs <= nowMs && nowMs - dueMs <= maxDelayMs;
      })
      .sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime())
      .map((item) => ({ ...item }));
  }

  async markSent(id, sentAt = new Date()) {
    await this.ensureReady();
    const reminderId = String(id || '').trim();
    if (!reminderId) return { ok: false };

    return this.withLock(async () => {
      const idx = this.state.items.findIndex((item) => item.id === reminderId);
      if (idx < 0) return { ok: false };
      const current = this.state.items[idx];
      if (isRecurringReminder(current)) {
        const nextDueAt = computeNextRecurringDueAt(current.dueAt, current.recurrence, sentAt);
        this.state.items[idx] = {
          ...current,
          dueAt: nextDueAt ? nextDueAt.toISOString() : current.dueAt,
          sentAt: sentAt.toISOString(),
          active: Boolean(nextDueAt)
        };
      } else {
        this.state.items[idx] = {
          ...current,
          sentAt: sentAt.toISOString(),
          active: false
        };
      }
      await this.save();
      return { ok: true, item: { ...this.state.items[idx] } };
    });
  }

  async cancelByIndex(groupId, indexOneBased) {
    await this.ensureReady();
    const normalizedGroup = normalizeGroupId(groupId);
    const index = Number.parseInt(String(indexOneBased || ''), 10);
    if (!normalizedGroup || !Number.isFinite(index) || index <= 0) {
      return { ok: false, canceled: false };
    }

    return this.withLock(async () => {
      const pending = this.state.items
        .map((item, itemIndex) => ({ item, itemIndex }))
        .filter((entry) => entry.item.groupId === normalizedGroup)
        .filter((entry) => isPendingReminder(entry.item))
        .sort((left, right) => new Date(left.item.dueAt).getTime() - new Date(right.item.dueAt).getTime());

      const target = pending[index - 1];
      if (!target) return { ok: true, canceled: false };

      const item = this.state.items[target.itemIndex];
      this.state.items[target.itemIndex] = {
        ...item,
        active: false,
        canceledAt: new Date().toISOString()
      };
      await this.save();
      return { ok: true, canceled: true, item: { ...this.state.items[target.itemIndex] } };
    });
  }

  async cancelAllByGroup(groupId) {
    await this.ensureReady();
    const normalizedGroup = normalizeGroupId(groupId);
    if (!normalizedGroup) return { ok: false, canceled: 0 };

    return this.withLock(async () => {
      let canceled = 0;
      const nowIso = new Date().toISOString();
      this.state.items = this.state.items.map((item) => {
        if (item.groupId !== normalizedGroup || !isPendingReminder(item)) {
          return item;
        }
        canceled += 1;
        return {
          ...item,
          active: false,
          canceledAt: nowIso
        };
      });
      if (canceled > 0) await this.save();
      return { ok: true, canceled };
    });
  }
}

export const reminderStore = new ReminderStore();
