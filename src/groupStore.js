import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeGroupId(value) {
  const normalized = String(value || '').trim();
  if (!normalized.endsWith('@g.us')) return '';
  return normalized;
}

function clampText(value, maxChars = 160) {
  const normalized = String(value || '').replace(/\u0000/g, '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function normalizeRole(value, fallback = 'secondary') {
  return String(value || '').trim().toLowerCase() === 'primary' ? 'primary' : fallback;
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'sim', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'nao', 'não', 'off'].includes(normalized)) return false;
  return fallback;
}

function extractInviteCode(inviteLink) {
  const match = String(inviteLink || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
  return match?.[1] || '';
}

function sanitizeGroup(input, fallback = {}) {
  const groupId = normalizeGroupId(input?.groupId || fallback.groupId || '');
  if (!groupId) return null;

  const role = normalizeRole(input?.role || fallback.role || 'secondary');
  const createdAt = clampText(input?.createdAt || fallback.createdAt || nowIso(), 40) || nowIso();
  const updatedAt = clampText(input?.updatedAt || fallback.updatedAt || nowIso(), 40) || nowIso();
  const inviteLink = clampText(input?.inviteLink || fallback.inviteLink || '', 400);
  const inviteCode = clampText(input?.inviteCode || fallback.inviteCode || extractInviteCode(inviteLink), 80);

  return {
    groupId,
    role,
    name: clampText(input?.name || fallback.name || '', 160),
    inviteLink,
    inviteCode,
    enabled: toBoolean(input?.enabled, fallback.enabled ?? true),
    inheritsPrimarySettings: role === 'primary' ? false : toBoolean(input?.inheritsPrimarySettings, fallback.inheritsPrimarySettings ?? true),
    inheritsPrimaryPermissions:
      role === 'primary' ? false : toBoolean(input?.inheritsPrimaryPermissions, fallback.inheritsPrimaryPermissions ?? true),
    source: clampText(input?.source || fallback.source || '', 80),
    createdAt,
    updatedAt,
    lastSeenAt: clampText(input?.lastSeenAt || fallback.lastSeenAt || '', 40)
  };
}

function defaultState() {
  const groups = [];
  const primaryGroupId = normalizeGroupId(config.groupJid);

  if (primaryGroupId) {
    groups.push(
      sanitizeGroup({
        groupId: primaryGroupId,
        role: 'primary',
        name: 'Grupo principal',
        inviteLink: config.groupInviteLink,
        enabled: true,
        inheritsPrimarySettings: false,
        inheritsPrimaryPermissions: false,
        source: 'env'
      })
    );
  }

  return {
    primaryGroupId,
    selectedGroupId: primaryGroupId,
    groups: groups.filter(Boolean),
    updatedAt: nowIso()
  };
}

function uniqueGroups(items) {
  const byId = new Map();

  for (const rawItem of Array.isArray(items) ? items : []) {
    const item = sanitizeGroup(rawItem);
    if (!item) continue;
    const existing = byId.get(item.groupId);
    byId.set(item.groupId, sanitizeGroup(item, existing || {}) || existing || item);
  }

  return Array.from(byId.values()).sort((left, right) => {
    if (left.role !== right.role) return left.role === 'primary' ? -1 : 1;
    return left.groupId.localeCompare(right.groupId, 'pt-BR');
  });
}

function sanitizeState(input) {
  const base = defaultState();
  const value = input && typeof input === 'object' ? input : {};
  const groups = uniqueGroups([...base.groups, ...(Array.isArray(value.groups) ? value.groups : [])]);

  let primaryGroupId = normalizeGroupId(value.primaryGroupId || base.primaryGroupId || '');
  if (!primaryGroupId) {
    primaryGroupId = groups.find((item) => item.role === 'primary')?.groupId || '';
  }

  const normalizedGroups = groups.map((group) => {
    const role = group.groupId === primaryGroupId ? 'primary' : group.role === 'primary' ? 'secondary' : group.role;
    return sanitizeGroup(
      {
        ...group,
        role,
        inheritsPrimarySettings: role === 'primary' ? false : group.inheritsPrimarySettings,
        inheritsPrimaryPermissions: role === 'primary' ? false : group.inheritsPrimaryPermissions
      },
      group
    );
  });

  let selectedGroupId = normalizeGroupId(value.selectedGroupId || base.selectedGroupId || '');
  const enabledIds = new Set(normalizedGroups.filter((item) => item.enabled).map((item) => item.groupId));
  if (!selectedGroupId || !enabledIds.has(selectedGroupId)) {
    selectedGroupId = primaryGroupId || normalizedGroups.find((item) => item.enabled)?.groupId || '';
  }

  return {
    primaryGroupId,
    selectedGroupId,
    groups: normalizedGroups.filter(Boolean),
    updatedAt: clampText(value.updatedAt || base.updatedAt || nowIso(), 40) || nowIso()
  };
}

export class GroupStore {
  constructor(filePath = config.groupConfigFile || 'data/group-config.json') {
    this.filePath = filePath;
    this.state = defaultState();
    this.ready = this.load();
    this.chain = Promise.resolve();
  }

  async ensureReady() {
    await this.ready;
  }

  async load() {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      this.state = sanitizeState(parsed);
    } catch {
      this.state = sanitizeState({});
      await this.save();
    }
  }

  async withLock(task) {
    this.chain = this.chain
      .catch(() => {
        // Mantem a fila viva.
      })
      .then(task);
    return this.chain;
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    this.state.updatedAt = nowIso();
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  getPrimaryGroupId() {
    return String(this.state.primaryGroupId || '').trim();
  }

  getSelectedGroupId() {
    return String(this.state.selectedGroupId || '').trim();
  }

  list() {
    return this.state.groups.map((item) => ({ ...item }));
  }

  listEnabledResponseGroups() {
    return this.list().filter((item) => item.enabled);
  }

  responseGroupIds() {
    return Array.from(new Set(this.listEnabledResponseGroups().map((item) => item.groupId).filter(Boolean)));
  }

  getById(groupId) {
    const normalized = normalizeGroupId(groupId);
    if (!normalized) return null;
    return this.list().find((item) => item.groupId === normalized) || null;
  }

  snapshot() {
    const groups = this.list();
    const responseGroups = groups.map((item) => ({
      ...item,
      isPrimary: item.groupId === this.getPrimaryGroupId(),
      isSelected: item.groupId === this.getSelectedGroupId()
    }));

    return {
      primaryGroupId: this.getPrimaryGroupId(),
      selectedGroupId: this.getSelectedGroupId(),
      responseGroupIds: this.responseGroupIds(),
      totalGroups: responseGroups.length,
      secondaryGroups: responseGroups.filter((item) => !item.isPrimary).length,
      groups: responseGroups,
      updatedAt: this.state.updatedAt
    };
  }

  async syncPrimary(groupId, patch = {}) {
    await this.ensureReady();
    const normalized = normalizeGroupId(groupId);
    if (!normalized) {
      return {
        ok: false,
        message: 'groupId invalido para grupo principal.'
      };
    }

    return this.withLock(async () => {
      const previousPrimary = this.getPrimaryGroupId();
      const current = this.getById(normalized);
      const groups = this.list().map((item) => {
        if (item.groupId === previousPrimary && item.groupId !== normalized) {
          return sanitizeGroup({
            ...item,
            role: 'secondary',
            inheritsPrimarySettings: true,
            inheritsPrimaryPermissions: true,
            updatedAt: nowIso()
          });
        }
        if (item.groupId === normalized) {
          return sanitizeGroup(
            {
              ...item,
              ...patch,
              groupId: normalized,
              role: 'primary',
              enabled: true,
              inheritsPrimarySettings: false,
              inheritsPrimaryPermissions: false,
              updatedAt: nowIso()
            },
            current || item
          );
        }
        return item;
      });

      if (!groups.some((item) => item?.groupId === normalized)) {
        groups.push(
          sanitizeGroup({
            groupId: normalized,
            role: 'primary',
            enabled: true,
            inheritsPrimarySettings: false,
            inheritsPrimaryPermissions: false,
            inviteLink: patch.inviteLink || '',
            name: patch.name || '',
            source: patch.source || 'runtime',
            createdAt: nowIso(),
            updatedAt: nowIso()
          })
        );
      }

      this.state = sanitizeState({
        ...this.state,
        primaryGroupId: normalized,
        selectedGroupId: this.state.selectedGroupId || normalized,
        groups
      });
      await this.save();

      return {
        ok: true,
        changed: previousPrimary !== normalized || !current,
        group: this.getById(normalized),
        snapshot: this.snapshot()
      };
    });
  }

  async addSecondary(input = {}) {
    await this.ensureReady();
    const normalized = normalizeGroupId(input.groupId);
    if (!normalized) {
      return { ok: false, message: 'groupId invalido para grupo secundario.' };
    }

    if (normalized === this.getPrimaryGroupId()) {
      const result = await this.syncPrimary(normalized, input);
      return {
        ok: true,
        added: false,
        updated: true,
        reusedPrimary: true,
        group: result.group,
        snapshot: result.snapshot
      };
    }

    return this.withLock(async () => {
      const existing = this.getById(normalized);
      const groups = this.list().filter((item) => item.groupId !== normalized);
      groups.push(
        sanitizeGroup(
          {
            ...existing,
            ...input,
            groupId: normalized,
            role: 'secondary',
            enabled: true,
            inheritsPrimarySettings: true,
            inheritsPrimaryPermissions: true,
            updatedAt: nowIso(),
            createdAt: existing?.createdAt || nowIso()
          },
          existing || {}
        )
      );

      this.state = sanitizeState({
        ...this.state,
        groups
      });
      await this.save();

      return {
        ok: true,
        added: !existing,
        updated: Boolean(existing),
        group: this.getById(normalized),
        snapshot: this.snapshot()
      };
    });
  }

  async updateGroup(groupId, patch = {}) {
    await this.ensureReady();
    const normalized = normalizeGroupId(groupId);
    if (!normalized) {
      return { ok: false, message: 'groupId invalido.' };
    }

    if (normalized === this.getPrimaryGroupId()) {
      return this.syncPrimary(normalized, patch);
    }

    return this.withLock(async () => {
      const existing = this.getById(normalized);
      if (!existing) {
        return { ok: false, message: 'Grupo nao encontrado.' };
      }

      const groups = this.list().map((item) =>
        item.groupId === normalized
          ? sanitizeGroup(
              {
                ...item,
                ...patch,
                groupId: normalized,
                role: 'secondary',
                updatedAt: nowIso()
              },
              existing
            )
          : item
      );

      this.state = sanitizeState({
        ...this.state,
        groups
      });
      await this.save();

      return {
        ok: true,
        group: this.getById(normalized),
        snapshot: this.snapshot()
      };
    });
  }

  async selectGroup(groupId) {
    await this.ensureReady();
    const normalized = normalizeGroupId(groupId || this.getPrimaryGroupId());
    if (!normalized) {
      return { ok: false, message: 'Selecione um grupo valido.' };
    }

    const target = this.getById(normalized);
    if (!target || !target.enabled) {
      return { ok: false, message: 'Grupo nao encontrado entre os grupos de resposta ativos.' };
    }

    return this.withLock(async () => {
      this.state = sanitizeState({
        ...this.state,
        selectedGroupId: normalized
      });
      await this.save();

      return {
        ok: true,
        selectedGroupId: normalized,
        snapshot: this.snapshot()
      };
    });
  }

  async removeSecondary(groupId) {
    await this.ensureReady();
    const normalized = normalizeGroupId(groupId);
    if (!normalized) {
      return { ok: false, message: 'groupId invalido.' };
    }

    if (normalized === this.getPrimaryGroupId()) {
      return { ok: false, message: 'O grupo principal nao pode ser removido do painel.' };
    }

    return this.withLock(async () => {
      const before = this.list().length;
      const groups = this.list().filter((item) => item.groupId !== normalized);
      if (groups.length === before) {
        return { ok: false, message: 'Grupo nao encontrado.' };
      }

      const nextSelected =
        this.getSelectedGroupId() === normalized ? this.getPrimaryGroupId() || groups[0]?.groupId || '' : this.getSelectedGroupId();

      this.state = sanitizeState({
        ...this.state,
        groups,
        selectedGroupId: nextSelected
      });
      await this.save();

      return {
        ok: true,
        removedGroupId: normalized,
        snapshot: this.snapshot()
      };
    });
  }
}

export const groupStore = new GroupStore();
export { extractInviteCode, normalizeGroupId };
