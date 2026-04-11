import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

function clampText(value, maxChars) {
  const normalized = String(value || '').replace(/\u0000/g, '').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'sim'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(normalized)) return false;
  return fallback;
}

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)));
  }

  if (typeof value === 'string' && value.trim()) {
    return Array.from(
      new Set(
        value
          .split(',')
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      )
    );
  }

  return Array.from(new Set(fallback.map((item) => String(item || '').trim()).filter(Boolean)));
}

function normalizeReasoningEffort(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return fallback;
}

function normalizeAiProvider(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['codex', 'copilot'].includes(normalized)) return normalized;
  return fallback || 'codex';
}

function normalizeBackupSchedulerMode(value, fallback) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['validated_github', 'data_only'].includes(normalized)) return normalized;
  return fallback || 'validated_github';
}

function defaultSettings() {
  return {
    systemPrompt: config.systemPrompt,
    requireMention: config.requireMention,
    fallbackMessage: config.fallbackMessage,
    showThinkingMessage: config.showThinkingMessage,
    thinkingMessageText: config.thinkingMessageText,
    maxInputChars: config.maxInputChars,
    maxOutputChars: config.maxOutputChars,
    codexModel: config.codexModel,
    codexReasoningEffort: config.codexReasoningEffort,
    codexFullReasoningEffort: 'high',
    codexTimeoutMs: config.codexTimeoutMs,
    codexImageTimeoutMs: config.codexImageTimeoutMs,
    codexFallbackModel: config.codexFallbackModel,
    codexFallbackTimeoutMs: config.codexFallbackTimeoutMs,
    codexFallbackOnTimeout: config.codexFallbackOnTimeout,
    aiProvider: config.aiProvider || 'codex',
    copilotModel: config.copilotModel,
    copilotReasoningEffort: config.copilotReasoningEffort,
    copilotFullReasoningEffort: 'high',
    copilotTimeoutMs: config.copilotTimeoutMs,
    copilotFallbackModel: config.copilotFallbackModel,
    copilotFallbackTimeoutMs: config.copilotFallbackTimeoutMs,
    copilotFullModel: config.copilotFullModel,
    enableTerminalExec: config.enableTerminalExec,
    terminalAllowlist: [...config.terminalAllowlist],
    mediaIngestEnabled: config.mediaIngestEnabled,
    mediaRootDir: config.mediaRootDir,
    mediaMaxBytes: config.mediaMaxBytes,
    mediaRetentionDays: config.mediaRetentionDays,
    mediaAllowedMimePrefixes: [...config.mediaAllowedMimePrefixes],
    fullAutoDevTimeoutMs: config.fullAutoDevTimeoutMs || 0,
    githubBackupEnabled: config.githubBackupEnabled,
    githubBackupRepo: config.githubBackupRepo,
    githubBackupBranches: [...config.githubBackupBranches],
    githubBackupUpdateReadme: config.githubBackupUpdateReadme,
    githubBackupRunTestSuite: config.githubBackupRunTestSuite,
    githubBackupAutoRollback: config.githubBackupAutoRollback,
    backupSchedulerMode: config.backupSchedulerMode,
    backupSchedulerIntervalHours: config.backupSchedulerIntervalHours,
    relaySenderName: '',
    silentMode: false,
    updatedAt: new Date().toISOString()
  };
}

function sanitizeSettings(input) {
  const base = defaultSettings();
  const value = input && typeof input === 'object' ? input : {};

  return {
    systemPrompt: clampText(value.systemPrompt ?? base.systemPrompt, 50000) || base.systemPrompt,
    requireMention: toBoolean(value.requireMention, base.requireMention),
    fallbackMessage: clampText(value.fallbackMessage ?? base.fallbackMessage, 800) || base.fallbackMessage,
    showThinkingMessage: toBoolean(value.showThinkingMessage, base.showThinkingMessage),
    thinkingMessageText: clampText(value.thinkingMessageText ?? base.thinkingMessageText, 120) || base.thinkingMessageText,
    maxInputChars: clampInt(value.maxInputChars, base.maxInputChars, 0, 999999),
    maxOutputChars: clampInt(value.maxOutputChars, base.maxOutputChars, 0, 999999),
    codexModel: clampText(value.codexModel ?? base.codexModel, 120),
    codexReasoningEffort: normalizeReasoningEffort(value.codexReasoningEffort, base.codexReasoningEffort),
    codexFullReasoningEffort: normalizeReasoningEffort(value.codexFullReasoningEffort, base.codexFullReasoningEffort),
    codexTimeoutMs: clampInt(value.codexTimeoutMs, base.codexTimeoutMs, 4000, 3600000),
    codexImageTimeoutMs: clampInt(value.codexImageTimeoutMs, base.codexImageTimeoutMs, 4000, 3600000),
    codexFallbackModel: clampText(value.codexFallbackModel ?? base.codexFallbackModel, 120),
    codexFallbackTimeoutMs: clampInt(value.codexFallbackTimeoutMs, base.codexFallbackTimeoutMs, 4000, 3600000),
    codexFallbackOnTimeout: toBoolean(value.codexFallbackOnTimeout, base.codexFallbackOnTimeout),
    aiProvider: normalizeAiProvider(value.aiProvider, base.aiProvider),
    copilotModel: clampText(value.copilotModel ?? base.copilotModel, 120),
    copilotReasoningEffort: normalizeReasoningEffort(value.copilotReasoningEffort, base.copilotReasoningEffort),
    copilotFullReasoningEffort: normalizeReasoningEffort(value.copilotFullReasoningEffort, base.copilotFullReasoningEffort),
    copilotTimeoutMs: clampInt(value.copilotTimeoutMs, base.copilotTimeoutMs, 4000, 3600000),
    copilotFallbackModel: clampText(value.copilotFallbackModel ?? base.copilotFallbackModel, 120),
    copilotFallbackTimeoutMs: clampInt(value.copilotFallbackTimeoutMs, base.copilotFallbackTimeoutMs, 4000, 3600000),
    copilotFullModel: clampText(value.copilotFullModel ?? base.copilotFullModel, 120),
    enableTerminalExec: toBoolean(value.enableTerminalExec, base.enableTerminalExec),
    terminalAllowlist: normalizeList(value.terminalAllowlist, base.terminalAllowlist).slice(0, 500),
    mediaIngestEnabled: toBoolean(value.mediaIngestEnabled, base.mediaIngestEnabled),
    mediaRootDir: clampText(value.mediaRootDir ?? base.mediaRootDir, 260) || base.mediaRootDir,
    mediaMaxBytes: clampInt(value.mediaMaxBytes, base.mediaMaxBytes, 1024, 500 * 1024 * 1024),
    mediaRetentionDays: clampInt(value.mediaRetentionDays, base.mediaRetentionDays, 1, 3650),
    mediaAllowedMimePrefixes: normalizeList(value.mediaAllowedMimePrefixes, base.mediaAllowedMimePrefixes).slice(0, 64),
    fullAutoDevTimeoutMs: clampInt(value.fullAutoDevTimeoutMs, base.fullAutoDevTimeoutMs, 0, 1800000),
    githubBackupEnabled: toBoolean(value.githubBackupEnabled, base.githubBackupEnabled),
    githubBackupRepo: clampText(value.githubBackupRepo ?? base.githubBackupRepo, 180) || base.githubBackupRepo,
    githubBackupBranches: normalizeList(value.githubBackupBranches, base.githubBackupBranches).slice(0, 10),
    githubBackupUpdateReadme: toBoolean(value.githubBackupUpdateReadme, base.githubBackupUpdateReadme),
    githubBackupRunTestSuite: toBoolean(value.githubBackupRunTestSuite, base.githubBackupRunTestSuite),
    githubBackupAutoRollback: toBoolean(value.githubBackupAutoRollback, base.githubBackupAutoRollback),
    backupSchedulerMode: normalizeBackupSchedulerMode(value.backupSchedulerMode, base.backupSchedulerMode),
    backupSchedulerIntervalHours: clampInt(value.backupSchedulerIntervalHours, base.backupSchedulerIntervalHours, 1, 168),
    relaySenderName: clampText(value.relaySenderName ?? base.relaySenderName, 120),
    silentMode: toBoolean(value.silentMode, base.silentMode),
    updatedAt: new Date().toISOString()
  };
}

function areEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function splitJsonl(content) {
  return String(content || '')
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

export class SettingsStore {
  constructor({ filePath = config.settingsFile, auditFilePath = config.settingsAuditFile } = {}) {
    this.filePath = filePath;
    this.auditFilePath = auditFilePath;
    this.state = defaultSettings();
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
      this.state = sanitizeSettings(parsed);
    } catch {
      this.state = defaultSettings();
      await this.save();
    }
  }

  async withLock(task) {
    this.chain = this.chain
      .catch(() => {
        // mantem a fila de escrita viva.
      })
      .then(task);
    return this.chain;
  }

  get() {
    return JSON.parse(JSON.stringify(this.state));
  }

  async save() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
  }

  async appendAudit(entry) {
    await mkdir(dirname(this.auditFilePath), { recursive: true });
    await appendFile(this.auditFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async listAudit(limit = 40) {
    try {
      const content = await readFile(this.auditFilePath, 'utf8');
      const parsed = splitJsonl(content);
      return parsed.slice(-Math.max(1, Math.min(limit, 500))).reverse();
    } catch {
      return [];
    }
  }

  async update(partial, meta = {}) {
    await this.ensureReady();

    return this.withLock(async () => {
      const before = this.get();
      const candidate = sanitizeSettings({
        ...before,
        ...(partial && typeof partial === 'object' ? partial : {})
      });

      if (areEqual(before, candidate)) {
        return {
          changed: false,
          settings: before,
          auditId: null,
          changedKeys: []
        };
      }

      this.state = candidate;
      await this.save();

      const changedKeys = Object.keys(candidate).filter((key) => !areEqual(before[key], candidate[key]));
      const auditEntry = {
        id: randomUUID(),
        ts: new Date().toISOString(),
        actor: clampText(meta.actor || 'desconhecido', 120) || 'desconhecido',
        source: clampText(meta.source || 'runtime', 120) || 'runtime',
        reason: clampText(meta.reason || '', 260),
        changedKeys,
        before,
        after: this.get()
      };

      await this.appendAudit(auditEntry);

      return {
        changed: true,
        settings: this.get(),
        auditId: auditEntry.id,
        changedKeys
      };
    });
  }

  async rollback(auditId, meta = {}) {
    await this.ensureReady();
    const id = String(auditId || '').trim();
    if (!id) {
      return { ok: false, message: 'ID de auditoria vazio.' };
    }

    const items = await this.listAudit(1000);
    const target = items.find((item) => String(item?.id || '') === id);
    if (!target || !target.before || typeof target.before !== 'object') {
      return { ok: false, message: 'Entrada de auditoria nao encontrada para rollback.' };
    }

    const result = await this.update(target.before, {
      actor: meta.actor || 'desconhecido',
      source: meta.source || 'rollback',
      reason: `rollback:${id}`
    });

    return {
      ok: true,
      message: 'Rollback aplicado.',
      auditId: result.auditId,
      settings: result.settings
    };
  }
}

export const settingsStore = new SettingsStore();
